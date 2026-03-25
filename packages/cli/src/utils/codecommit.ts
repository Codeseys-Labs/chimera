/**
 * Shared CodeCommit SDK utilities
 * Pure AWS SDK approach - no git remote, credential helper, or pip dependencies
 * Works with any AWS credential type: IAM roles, assumed roles, SSO, etc.
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  CodeCommitClient,
  CreateCommitCommand,
  GetBranchCommand,
  GetFolderCommand,
  GetFileCommand,
  PutFileEntry,
} from '@aws-sdk/client-codecommit';
import chalk from 'chalk';

// CodeCommit batch limits
export const BATCH_MAX_BYTES = 5 * 1024 * 1024; // 5MB per commit (leave 1MB buffer from 6MB limit)
export const BATCH_MAX_FILES = 100;
export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.overstory',
  '.seeds',
  '.mulch',
  '.canopy',
  'dist',
  'build',
  'coverage',
  '.turbo',
]);
export const EXCLUDED_PATTERNS = [
  /\.DS_Store$/,
  /\.log$/,
  /\.env$/,
  /\.env\.local$/,
  /^\..*\.swp$/,
  /~$/,
];

/**
 * Recursively collect files from directory, excluding specific paths
 * Reads file content to detect binaries and check size limits
 */
export function collectFiles(
  dirPath: string,
  repoRoot: string,
  files: Array<{ path: string; fullPath: string; content: Buffer }> = [],
): Array<{ path: string; fullPath: string; content: Buffer }> {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(repoRoot, fullPath);

    const pathParts = relativePath.split(path.sep);
    if (pathParts.some((part) => EXCLUDED_DIRS.has(part))) {
      continue;
    }

    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      continue;
    }

    if (entry.isDirectory()) {
      collectFiles(fullPath, repoRoot, files);
    } else {
      const content = fs.readFileSync(fullPath);

      if (content.length > BATCH_MAX_BYTES) {
        continue;
      }

      // Detect binary files by checking for null bytes in first 8KB
      const checkLen = Math.min(content.length, 8192);
      let isBinary = false;
      for (let i = 0; i < checkLen; i++) {
        if (content[i] === 0) {
          isBinary = true;
          break;
        }
      }
      if (isBinary) {
        continue;
      }

      files.push({ path: relativePath, fullPath, content });
    }
  }

  return files;
}

/**
 * Batch files into groups under BATCH_MAX_BYTES and BATCH_MAX_FILES limits
 * Note: File content is base64-encoded by AWS SDK, so we track encoded size
 */
export function batchFiles(
  files: Array<{ path: string; fullPath: string; content: Buffer }>,
): Array<Array<{ path: string; content: Buffer }>> {
  const batches: Array<Array<{ path: string; content: Buffer }>> = [];
  let currentBatch: Array<{ path: string; content: Buffer }> = [];
  let currentBatchSize = 0;

  for (const file of files) {
    const encodedSize = Math.ceil((file.content.length * 4) / 3);

    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= BATCH_MAX_FILES ||
        currentBatchSize + encodedSize > BATCH_MAX_BYTES)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchSize = 0;
    }

    currentBatch.push({ path: file.path, content: file.content });
    currentBatchSize += encodedSize;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Push local repository to CodeCommit using batched CreateCommit API calls
 * Handles large repos (>6MB) by splitting into multiple commits under 5MB each
 * Pure AWS SDK approach - no git remote, credential helper, or pip dependencies
 */
export async function pushToCodeCommit(
  client: CodeCommitClient,
  repoName: string,
  repoRoot: string,
  branchName: string = 'main',
  commitMessage?: string,
): Promise<void> {
  console.log(chalk.gray('  Scanning repository files...'));
  const allFiles = collectFiles(repoRoot, repoRoot);
  console.log(chalk.gray(`  Found ${allFiles.length} files`));

  const batches = batchFiles(allFiles);
  console.log(chalk.gray(`  Organized into ${batches.length} commit batch(es)`));

  let parentCommitId: string | undefined;
  try {
    const branchInfo = await client.send(
      new GetBranchCommand({ repositoryName: repoName, branchName }),
    );
    parentCommitId = branchInfo.branch?.commitId;
    console.log(chalk.gray(`  Branch '${branchName}' exists, will update from tip`));
  } catch (error: any) {
    if (error.name === 'BranchDoesNotExistException') {
      console.log(chalk.gray(`  Branch '${branchName}' does not exist, will create`));
    } else {
      throw error;
    }
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchNum = i + 1;
    const baseMsg = commitMessage || 'Deploy Chimera to AWS';
    const batchMsg =
      batches.length === 1 ? baseMsg : `${baseMsg} (batch ${batchNum}/${batches.length})`;

    console.log(
      chalk.gray(`  Creating commit ${batchNum}/${batches.length} (${batch.length} files)...`),
    );

    const putFiles: PutFileEntry[] = batch.map((file) => ({
      filePath: file.path,
      fileMode: 'NORMAL',
      fileContent: file.content,
    }));

    try {
      const createCommitResult = await client.send(
        new CreateCommitCommand({
          repositoryName: repoName,
          branchName,
          parentCommitId,
          commitMessage: batchMsg,
          authorName: 'Chimera CLI',
          email: 'deploy@chimera.aws',
          putFiles,
        }),
      );
      parentCommitId = createCommitResult.commitId;
    } catch (error: any) {
      const isNoChangesError =
        error.message?.includes('same as') || error.message?.includes('at least one change');

      if (isNoChangesError) {
        console.log(
          chalk.gray(`  Batch ${batchNum}/${batches.length} skipped (no changes from parent)`),
        );
      } else {
        throw error;
      }
    }
  }

  console.log(chalk.gray('  All commits created successfully'));
}

export interface CodeCommitFile {
  path: string;
  content: Buffer;
}

/**
 * Recursively list all file absolute paths within a CodeCommit folder
 */
async function listFilesInFolder(
  client: CodeCommitClient,
  repoName: string,
  commitSpecifier: string,
  folderPath: string,
  allFiles: string[] = [],
): Promise<string[]> {
  const response = await client.send(
    new GetFolderCommand({
      repositoryName: repoName,
      commitSpecifier,
      folderPath,
    }),
  );

  for (const file of response.files || []) {
    if (file.absolutePath) {
      allFiles.push(file.absolutePath);
    }
  }

  for (const subFolder of response.subFolders || []) {
    if (subFolder.absolutePath) {
      await listFilesInFolder(
        client,
        repoName,
        commitSpecifier,
        subFolder.absolutePath,
        allFiles,
      );
    }
  }

  return allFiles;
}

/**
 * Fetch all files from a CodeCommit branch via API (no git remote needed)
 * Uses GetFolder (recursive) + GetFile per file
 */
export async function getFilesFromCodeCommit(
  client: CodeCommitClient,
  repoName: string,
  branchName: string,
): Promise<CodeCommitFile[]> {
  const filePaths = await listFilesInFolder(client, repoName, branchName, '/');

  const files = await Promise.all(
    filePaths.map(async (filePath) => {
      const response = await client.send(
        new GetFileCommand({
          repositoryName: repoName,
          commitSpecifier: branchName,
          filePath,
        }),
      );
      // Strip leading slash so path is relative (consistent with collectFiles output)
      const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
      return {
        path: normalizedPath,
        content: Buffer.from(response.fileContent || new Uint8Array()),
      };
    }),
  );

  return files;
}
