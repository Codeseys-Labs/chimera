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
import { color } from '../lib/color';

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
 * A file that was excluded from the push because it was larger than the
 * CodeCommit per-commit byte limit. Reported to the caller so the user can
 * see which files were skipped.
 */
export interface SkippedLargeFile {
  path: string;
  fullPath: string;
  size: number;
  /**
   * `iac` = infrastructure-as-code file under `infra/` (almost certainly a
   *   caller bug — should never emit a 5MB CDK or config file).
   * `other` = anything else (legitimate large artifact, binary-ish blob, etc).
   */
  kind: 'iac' | 'other';
}

const IAC_SUSPECT_EXTENSIONS = new Set(['.ts', '.json', '.yaml', '.yml']);

/**
 * Module-level token bucket paces CreateCommit calls below the CodeCommit
 * account-wide write-API rate. A 67-batch deploy with zero pacing
 * synchronizes on the throttle wall and triggers "Rate exceeded" even with
 * retries. 2 tokens/sec with a 5-token burst keeps steady-state well under
 * the observed ~5-10 TPS ceiling while still allowing small bursts.
 */
const CODECOMMIT_BUCKET = {
  capacity: 5,
  tokens: 5,
  refillPerSec: 2,
  lastRefill: Date.now(),
};

async function acquireCodeCommitToken(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();
    const elapsedSec = (now - CODECOMMIT_BUCKET.lastRefill) / 1000;
    CODECOMMIT_BUCKET.tokens = Math.min(
      CODECOMMIT_BUCKET.capacity,
      CODECOMMIT_BUCKET.tokens + elapsedSec * CODECOMMIT_BUCKET.refillPerSec,
    );
    CODECOMMIT_BUCKET.lastRefill = now;
    if (CODECOMMIT_BUCKET.tokens >= 1) {
      CODECOMMIT_BUCKET.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Retry a CodeCommit send() call with exponential backoff + full jitter when
 * the service returns a throttling response. CodeCommit silently drops
 * CreateCommit calls under sustained load; without retries, `chimera sync`
 * fails the whole deploy mid-batch instead of backing off.
 *
 * Token bucket (above) paces steady-state calls. This function handles the
 * sporadic throttle spike that slips past the pacing, using AWS's recommended
 * full-jitter backoff to avoid synchronized retries across parallel deploys.
 *
 * Retriable signals (Wave-30: expanded):
 *   - name === ThrottlingException | ProvisionedThroughputExceededException |
 *     RequestLimitExceeded | LimitExceededException | TooManyRequestsException
 *   - $metadata.httpStatusCode === 429
 *   - message contains "Rate exceeded" (legacy envelope from CodeCommit's
 *     HTTP layer that doesn't populate `name` consistently)
 *
 * Backoff: exp with full jitter, base 500ms, cap 30s. Worst-case tail ~30s.
 */
async function withThrottleRetry<T>(op: () => Promise<T>): Promise<T> {
  const RETRIABLE_NAMES = new Set([
    'ThrottlingException',
    'ProvisionedThroughputExceededException',
    'RequestLimitExceeded',
    'LimitExceededException',
    'TooManyRequestsException',
  ]);
  const MAX_ATTEMPTS = 6; // initial + 5 retries
  const BASE_MS = 500;
  const CAP_MS = 30_000;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await acquireCodeCommitToken();
    try {
      return await op();
    } catch (error: any) {
      attempt += 1;
      const name = error?.name ?? '';
      const status = error?.$metadata?.httpStatusCode;
      const msg = String(error?.message ?? '');
      const retriable =
        RETRIABLE_NAMES.has(name) || status === 429 || /Rate exceeded/i.test(msg);

      if (!retriable || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
      // Full jitter: random(0, min(cap, base * 2^attempt)), with a small
      // floor so concurrent callers retrying in the same event-loop tick
      // don't synchronize at zero delay (reviewed Wave-30).
      const FLOOR_MS = 250;
      const ceilingMs = Math.min(CAP_MS, BASE_MS * Math.pow(2, attempt));
      const delayMs = Math.max(FLOOR_MS, Math.floor(Math.random() * ceilingMs));
      const tag = name || (status === 429 ? 'HTTP 429' : 'Rate exceeded');
      console.log(
        color.gray(
          `  CodeCommit ${tag} — retrying in ${Math.round(delayMs / 100) / 10}s ` +
            `(attempt ${attempt}/${MAX_ATTEMPTS - 1}, full jitter)`,
        ),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function isIacFile(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  if (parts[0] !== 'infra') return false;
  const ext = path.extname(relativePath).toLowerCase();
  return IAC_SUSPECT_EXTENSIONS.has(ext);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${n} B`;
}

/**
 * Recursively collect files from directory, excluding specific paths
 * Reads file content to detect binaries and check size limits
 *
 * Files larger than BATCH_MAX_BYTES are skipped and appended to `skipped`
 * so the caller can surface them to the user. IaC files under `infra/`
 * are logged as errors (almost certainly a caller bug) while other large
 * files are logged as warnings. Both are skipped either way.
 */
export function collectFiles(
  dirPath: string,
  repoRoot: string,
  files: Array<{ path: string; fullPath: string; content: Buffer }> = [],
  skipped: SkippedLargeFile[] = [],
): {
  files: Array<{ path: string; fullPath: string; content: Buffer }>;
  skipped: SkippedLargeFile[];
} {
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
      collectFiles(fullPath, repoRoot, files, skipped);
    } else {
      const content = fs.readFileSync(fullPath);

      if (content.length > BATCH_MAX_BYTES) {
        const iac = isIacFile(relativePath);
        const kind: SkippedLargeFile['kind'] = iac ? 'iac' : 'other';
        const sizeLabel = formatBytes(content.length);
        if (iac) {
          // IaC file > 5MB is almost certainly a bug in the caller — it
          // should never be emitting CDK/config files that large. Log loudly
          // but still skip (the CodeCommit API would reject it anyway).
          console.error(
            color.red(
              `  ERROR: skipping IaC file >5MB: ${relativePath} (${sizeLabel}) — almost certainly a caller bug`,
            ),
          );
        } else {
          console.warn(
            color.yellow(
              `  WARN:  skipping large file >5MB: ${relativePath} (${sizeLabel})`,
            ),
          );
        }
        skipped.push({ path: relativePath, fullPath, size: content.length, kind });
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

  return { files, skipped };
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
/**
 * Resume-from-batch support (chimera-98a6). When a prior push failed partway
 * through the 67-batch loop, the deploy-state file on the caller side records
 * the last successful batch and its commit id. On the next push the caller
 * passes those back in via `resumeFrom` so we skip already-committed batches
 * instead of re-running from zero.
 *
 * `onBatchComplete` is called after each successful CreateCommit so the caller
 * can update the deploy-state file per-batch and keep it fresh.
 */
export interface ResumeOptions {
  resumeFrom?: { batchIndex: number; parentCommitId: string };
  onBatchComplete?: (batchIndex: number, commitId: string) => void;
}

/**
 * Opt-in native-git push path (chimera-5000). When useGit is true and both
 * `git` and `aws` are on PATH, bypass the batched CreateCommit loop and push
 * via `git push <repoUrl>` using the AWS CLI credential helper. Falls back to
 * batched (with a yellow warning) when either binary is missing.
 */
export interface GitPushOptions {
  useGit?: boolean;
  repoUrl?: string;
  region?: string;
  profile?: string;
}

export async function pushToCodeCommit(
  client: CodeCommitClient,
  repoName: string,
  repoRoot: string,
  branchName: string = 'main',
  commitMessage?: string,
  resume?: ResumeOptions,
  gitOpts?: GitPushOptions,
): Promise<string | undefined> {
  // Opt-in native-git push (chimera-5000). When both git and aws CLI are on
  // PATH, skip the 67-batch CreateCommit loop entirely — it's ~10x faster
  // and uses git's fetch-first semantics for coalesce safety. Fall through
  // to batched with a warning if either binary is missing.
  if (gitOpts?.useGit && gitOpts.repoUrl && gitOpts.region) {
    const { detectGit, detectAwsCredentialHelper, pushViaGit } = await import('./git-push.js');
    const git = await detectGit();
    const awsOk = await detectAwsCredentialHelper();
    if (git.present && awsOk) {
      console.log(color.gray(`  Using native git push (git ${git.version ?? 'unknown'})`));
      const res = await pushViaGit({
        repoUrl: gitOpts.repoUrl,
        branch: branchName,
        profile: gitOpts.profile,
        region: gitOpts.region,
        sourceDir: repoRoot,
        onProgress: (l) => console.log(color.gray(`    ${l}`)),
      });
      return res.pushedSha || undefined;
    }
    console.warn(
      color.yellow(
        `  --use-git requested but ${!git.present ? 'git' : 'aws CLI'} not on PATH — falling back to batched CreateCommit`,
      ),
    );
  }

  console.log(color.gray('  Scanning repository files...'));
  const { files: allFiles, skipped } = collectFiles(repoRoot, repoRoot);
  console.log(color.gray(`  Found ${allFiles.length} files`));
  if (skipped.length > 0) {
    const iacCount = skipped.filter((s) => s.kind === 'iac').length;
    const otherCount = skipped.length - iacCount;
    console.log(
      color.yellow(
        `  Skipped ${skipped.length} file(s) >5MB (not pushed): ${otherCount} large file(s)` +
          (iacCount > 0 ? `, ${iacCount} IaC file(s) [see ERROR above]` : ''),
      ),
    );
    for (const s of skipped) {
      const tag = s.kind === 'iac' ? 'ERROR' : 'WARN';
      console.log(color.gray(`    - [${tag}] ${s.path} (${formatBytes(s.size)})`));
    }
  }

  const batches = batchFiles(allFiles);
  console.log(color.gray(`  Organized into ${batches.length} commit batch(es)`));

  let parentCommitId: string | undefined;
  try {
    const branchInfo = await client.send(
      new GetBranchCommand({ repositoryName: repoName, branchName }),
    );
    parentCommitId = branchInfo.branch?.commitId;
    console.log(color.gray(`  Branch '${branchName}' exists, will update from tip`));
  } catch (error: any) {
    if (error.name === 'BranchDoesNotExistException') {
      console.log(color.gray(`  Branch '${branchName}' does not exist, will create`));
    } else {
      throw error;
    }
  }

  // Apply resume state (chimera-98a6) exactly once at the start of the loop:
  // re-point parentCommitId at the last successful batch's commit id so
  // batch N+1 lands on top of it, and skip batches we've already pushed.
  const resumeSkipBelow =
    resume?.resumeFrom !== undefined ? resume.resumeFrom.batchIndex + 1 : 0;
  if (resume?.resumeFrom) {
    parentCommitId = resume.resumeFrom.parentCommitId;
    console.log(
      color.gray(
        `  Resuming from batch ${resumeSkipBelow + 1}/${batches.length} ` +
          `(parent ${parentCommitId})`,
      ),
    );
  }

  for (let i = 0; i < batches.length; i++) {
    if (i < resumeSkipBelow) continue;
    const batch = batches[i];
    const batchNum = i + 1;
    const baseMsg = commitMessage || 'Deploy Chimera to AWS';
    const batchMsg =
      batches.length === 1 ? baseMsg : `${baseMsg} (batch ${batchNum}/${batches.length})`;

    console.log(
      color.gray(`  Creating commit ${batchNum}/${batches.length} (${batch.length} files)...`),
    );

    const putFiles: PutFileEntry[] = batch.map((file) => ({
      filePath: file.path,
      fileMode: 'NORMAL',
      fileContent: file.content,
    }));

    // TOCTOU guard (chimera-a272): refresh tip before each CreateCommit.
    // A concurrent deploy may have advanced the branch since our initial
    // GetBranch or since our previous CreateCommit. Without this refresh,
    // batch i+1 is sent with a stale parentCommitId and CodeCommit rejects
    // it with ParentCommitIdRequiredException.
    try {
      const freshBranch = await withThrottleRetry(() =>
        client.send(new GetBranchCommand({ repositoryName: repoName, branchName })),
      );
      const freshTip = freshBranch.branch?.commitId;
      if (freshTip && freshTip !== parentCommitId) {
        console.log(
          color.yellow(
            `  Branch tip advanced (concurrent deploy) — re-pointing parent ${parentCommitId} → ${freshTip}`,
          ),
        );
        parentCommitId = freshTip;
      }
    } catch (error: any) {
      if (error.name !== 'BranchDoesNotExistException') throw error;
    }

    try {
      const createCommitResult = await withThrottleRetry(() =>
        client.send(
          new CreateCommitCommand({
            repositoryName: repoName,
            branchName,
            parentCommitId,
            commitMessage: batchMsg,
            authorName: 'Chimera CLI',
            email: 'deploy@chimera.aws',
            putFiles,
          }),
        ),
      );
      parentCommitId = createCommitResult.commitId;
      if (resume?.onBatchComplete && parentCommitId) {
        resume.onBatchComplete(i, parentCommitId);
      }
    } catch (error: any) {
      const isNoChangesError =
        error.message?.includes('same as') || error.message?.includes('at least one change');

      if (isNoChangesError) {
        console.log(
          color.gray(`  Batch ${batchNum}/${batches.length} skipped (no changes from parent)`),
        );
      } else {
        throw error;
      }
    }
  }

  console.log(color.gray('  All commits created successfully'));
  return parentCommitId;
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
