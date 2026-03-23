/**
 * Deployment commands - AWS CodeCommit + CodePipeline orchestration
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import {
  CodeCommitClient,
  CreateRepositoryCommand,
  GetRepositoryCommand,
  CreateCommitCommand,
  GetBranchCommand,
  PutFileEntry,
} from '@aws-sdk/client-codecommit';
import { loadConfig, saveConfig, type DeploymentConfig } from '../utils/config';

// CodeCommit batch limits
const BATCH_MAX_BYTES = 5 * 1024 * 1024; // 5MB per commit (leave 1MB buffer from 6MB limit)
const BATCH_MAX_FILES = 100; // Max files per commit
const EXCLUDED_DIRS = new Set([
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
const EXCLUDED_PATTERNS = [
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
function collectFiles(
  dirPath: string,
  repoRoot: string,
  files: Array<{ path: string; fullPath: string; content: Buffer }> = [],
): Array<{ path: string; fullPath: string; content: Buffer }> {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(repoRoot, fullPath);

    // Skip excluded directories
    const pathParts = relativePath.split(path.sep);
    if (pathParts.some((part) => EXCLUDED_DIRS.has(part))) {
      continue;
    }

    // Skip excluded patterns
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      continue;
    }

    if (entry.isDirectory()) {
      collectFiles(fullPath, repoRoot, files);
    } else {
      // Read file content for binary detection and size check
      const content = fs.readFileSync(fullPath);

      // FIX 3: Skip files larger than BATCH_MAX_BYTES individually
      if (content.length > BATCH_MAX_BYTES) {
        continue;
      }

      // FIX 2: Detect binary files by checking for null bytes in first 8KB
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
 * Note: File content is base64-encoded, so we track encoded size
 */
function batchFiles(
  files: Array<{ path: string; fullPath: string; content: Buffer }>,
): Array<Array<{ path: string; content: Buffer }>> {
  const batches: Array<Array<{ path: string; content: Buffer }>> = [];
  let currentBatch: Array<{ path: string; content: Buffer }> = [];
  let currentBatchSize = 0;

  for (const file of files) {
    // Content already read in collectFiles
    // Base64 encoding increases size by ~33%
    const encodedSize = Math.ceil((file.content.length * 4) / 3);

    // Start new batch if current would exceed limits
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

  // Add final batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Get AWS account ID from STS
 */
async function getAccountId(): Promise<string> {
  try {
    const output = execSync('aws sts get-caller-identity --query Account --output text', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim();
  } catch {
    throw new Error('Failed to get AWS account ID. Ensure AWS credentials are configured.');
  }
}

/**
 * Find project root by walking up directory tree looking for package.json
 * Pure Node.js approach - no git binary required
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not find project root (no package.json found). Run from within the project directory.');
}

/**
 * Create or get existing CodeCommit repository
 */
async function ensureCodeCommitRepo(
  client: CodeCommitClient,
  repoName: string,
): Promise<string> {
  try {
    // Check if repo exists
    const getRepoCommand = new GetRepositoryCommand({ repositoryName: repoName });
    const repo = await client.send(getRepoCommand);
    return repo.repositoryMetadata?.cloneUrlHttp || '';
  } catch (error: any) {
    if (error.name === 'RepositoryDoesNotExistException') {
      // Create new repo
      const createCommand = new CreateRepositoryCommand({
        repositoryName: repoName,
        repositoryDescription: 'AWS Chimera multi-tenant agent platform source repository',
      });
      const result = await client.send(createCommand);
      return result.repositoryMetadata?.cloneUrlHttp || '';
    }
    throw error;
  }
}

/**
 * Push local repository to CodeCommit using batched CreateCommit API calls
 * Handles large repos (>6MB) by splitting into multiple commits under 5MB each
 * Pure AWS SDK approach - no git remote, credential helper, or pip dependencies
 * Works with any AWS credential type: IAM roles, assumed roles, SSO, etc.
 */
async function pushToCodeCommit(
  client: CodeCommitClient,
  repoName: string,
  repoRoot: string,
  branchName: string = 'main',
): Promise<void> {
  // Step 1: Collect all files from repo root
  console.log(chalk.gray('  Scanning repository files...'));
  const allFiles = collectFiles(repoRoot, repoRoot);
  console.log(chalk.gray(`  Found ${allFiles.length} files`));

  // Step 2: Batch files into groups under size/count limits
  const batches = batchFiles(allFiles);
  console.log(chalk.gray(`  Organized into ${batches.length} commit batch(es)`));

  // Step 3: Get current branch tip (if exists) to use as parent for first commit
  // Cannot delete default branch in CodeCommit, so we chain from existing tip
  let parentCommitId: string | undefined;
  try {
    const branchInfo = await client.send(
      new GetBranchCommand({
        repositoryName: repoName,
        branchName,
      }),
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

  // Step 4: Create commits in sequence, chaining parentCommitId
  // If batch has no changes, skip it and keep chaining from current tip
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchNum = i + 1;
    const commitMessage =
      batches.length === 1
        ? 'Deploy Chimera to AWS'
        : `Deploy Chimera to AWS (batch ${batchNum}/${batches.length})`;

    console.log(
      chalk.gray(`  Creating commit ${batchNum}/${batches.length} (${batch.length} files)...`),
    );

    // Build putFiles array from batch
    const putFiles: PutFileEntry[] = batch.map((file) => ({
      filePath: file.path,
      fileMode: 'NORMAL',
      fileContent: file.content,
    }));

    // Create commit, catching "no changes" errors per batch
    try {
      const createCommitResult = await client.send(
        new CreateCommitCommand({
          repositoryName: repoName,
          branchName,
          parentCommitId, // chains from previous commit or branch tip
          commitMessage,
          authorName: 'Chimera CLI',
          email: 'deploy@chimera.aws',
          putFiles,
        }),
      );

      // Update parent for next commit in batch sequence
      parentCommitId = createCommitResult.commitId;
    } catch (error: any) {
      // If batch has no changes (files same as parent), skip it
      // Error message contains "same as" or "requires at least one change"
      const isNoChangesError =
        error.message?.includes('same as') || error.message?.includes('at least one change');

      if (isNoChangesError) {
        console.log(
          chalk.gray(`  Batch ${batchNum}/${batches.length} skipped (no changes from parent)`),
        );
        // Keep parentCommitId as-is for next batch to chain from current branch tip
      } else {
        // Unexpected error, re-throw
        throw error;
      }
    }
  }

  console.log(chalk.gray(`  All commits created successfully`));
}

/**
 * Deploy only the Pipeline CDK stack — CodePipeline buildspec deploys the rest
 * Note: CLI deploys Pipeline stack, which watches CodeCommit and auto-deploys all other stacks
 */
function deployCdkStacks(repoRoot: string, region: string, environment: string): void {
  // Validate inputs to prevent injection
  const safeEnv = environment.replace(/[^a-zA-Z0-9-]/g, '');
  const safeRegion = region.replace(/[^a-z0-9-]/g, '');

  // Deploy only the Pipeline stack — CodePipeline buildspec deploys the rest
  // Pass correct context key 'environment' (not 'envName') to match chimera.ts
  execSync(
    `cd infra && bunx cdk deploy Chimera-${safeEnv}-Pipeline --require-approval never --context environment=${safeEnv} --context repositoryName=chimera`,
    {
      cwd: repoRoot,
      stdio: 'inherit',
    }
  );
}

export function registerDeployCommands(program: Command): void {
  program
    .command('deploy')
    .description('Deploy Chimera to AWS account (creates CodeCommit repo, pushes source, triggers pipeline)')
    .option('--region <region>', 'AWS region', 'us-east-1')
    .option('--env <environment>', 'Environment name', 'dev')
    .option('--repo-name <name>', 'CodeCommit repository name', 'chimera')
    .action(async (options) => {
      const spinner = ora('Starting Chimera deployment').start();

      try {
        // Step 1: Get AWS account ID
        spinner.text = 'Verifying AWS credentials...';
        const accountId = await getAccountId();
        spinner.succeed(chalk.green(`AWS Account: ${accountId}`));

        // Step 2: Create or get CodeCommit repository
        spinner.start('Setting up CodeCommit repository...');
        const codecommitClient = new CodeCommitClient({ region: options.region });
        await ensureCodeCommitRepo(codecommitClient, options.repoName);
        spinner.succeed(chalk.green(`CodeCommit repository ready: ${options.repoName}`));

        // Step 3: Find project root
        spinner.start('Locating project root...');
        const repoRoot = findProjectRoot();
        spinner.succeed(chalk.green(`Project root: ${repoRoot}`));

        // Step 4: Push source to CodeCommit (using batched CreateCommit API)
        spinner.start('Pushing source code to CodeCommit...');
        await pushToCodeCommit(codecommitClient, options.repoName, repoRoot, 'main');
        spinner.succeed(chalk.green('Source code pushed to CodeCommit'));

        // Step 5: Deploy CDK stacks
        spinner.start('Deploying CDK stacks (this will take 15-30 minutes)...');
        deployCdkStacks(repoRoot, options.region, options.env);
        spinner.succeed(chalk.green('All CDK stacks deployed'));

        // Step 6: Save deployment config
        const config = loadConfig();
        const deployment: DeploymentConfig = {
          accountId,
          region: options.region,
          repositoryName: options.repoName,
          status: 'deployed',
          lastDeployed: new Date().toISOString(),
        };
        config.deployment = deployment;
        saveConfig(config);

        console.log(chalk.green('\n✓ Deployment complete!'));
        console.log(chalk.gray('\nNext steps:'));
        console.log(chalk.gray('  1. Run "chimera connect" to save API endpoints'));
        console.log(chalk.gray('  2. Run "chimera status" to check deployment health'));
      } catch (error: any) {
        spinner.fail(chalk.red('Deployment failed'));
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}
