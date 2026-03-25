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
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { loadConfig, saveConfig, type DeploymentConfig } from '../utils/config';
import {
  resolveSourcePath,
  cleanupSource,
  type SourceLocation,
} from '../utils/source';

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
 * Returns null if not found (caller decides whether to error or use alternative source)
 */
function findProjectRoot(): string | null {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
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
 * Check if Pipeline stack exists in CloudFormation
 * Returns true if stack exists (in any state except DELETE_COMPLETE)
 */
async function pipelineStackExists(
  client: CloudFormationClient,
  environment: string,
): Promise<boolean> {
  try {
    const stackName = `Chimera-${environment}-Pipeline`;
    const command = new DescribeStacksCommand({ StackName: stackName });
    const response = await client.send(command);

    // Stack exists if we got a response with at least one stack
    // (and status is not DELETE_COMPLETE)
    const stack = response.Stacks?.[0];
    return !!stack && stack.StackStatus !== 'DELETE_COMPLETE';
  } catch (error: any) {
    // Stack does not exist if we get ValidationError
    if (error.name === 'ValidationError') {
      return false;
    }
    // Re-throw unexpected errors
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
    `cd infra && npx cdk deploy Chimera-${safeEnv}-Pipeline --require-approval never --context environment=${safeEnv} --context repositoryName=chimera`,
    {
      cwd: repoRoot,
      stdio: 'inherit',
    }
  );
}

/**
 * Register all deployment-related commands
 */
export function registerDeployCommands(program: Command): void {
  // Main deploy command
  program
    .command('deploy')
    .description('Deploy Chimera to AWS account (creates CodeCommit repo, pushes source, triggers pipeline)')
    .option('--region <region>', 'AWS region', 'us-east-1')
    .option('--env <environment>', 'Environment name', 'dev')
    .option('--repo-name <name>', 'CodeCommit repository name', 'chimera')
    .option(
      '--source <mode>',
      'Source mode: auto (detect), local (current directory), or github (download release)',
      'auto',
    )
    .option('--github-owner <owner>', 'GitHub repository owner', 'your-org')
    .option('--github-repo <repo>', 'GitHub repository name', 'chimera')
    .option('--github-tag <tag>', 'GitHub release tag (or "latest")', 'latest')
    .action(async (options) => {
      const spinner = ora('Starting Chimera deployment').start();
      let sourceLocation: SourceLocation | undefined;
      let sourcePath: string | null = null;

      try {
        // Step 1: Get AWS account ID
        spinner.text = 'Verifying AWS credentials...';
        const accountId = await getAccountId();
        spinner.succeed(chalk.green(`AWS Account: ${accountId}`));

        // Step 2: Determine source location
        spinner.start('Determining source location...');
        if (options.source === 'auto') {
          // Auto-detect: use local if in project directory, otherwise GitHub
          const localRoot = findProjectRoot();
          if (localRoot) {
            sourceLocation = { type: 'local', path: localRoot };
            spinner.succeed(chalk.green(`Source: Local project (${localRoot})`));
          } else {
            sourceLocation = {
              type: 'github-release',
              owner: options.githubOwner,
              repo: options.githubRepo,
              tag: options.githubTag,
            };
            spinner.succeed(
              chalk.green(
                `Source: GitHub release (${options.githubOwner}/${options.githubRepo}@${options.githubTag})`,
              ),
            );
          }
        } else if (options.source === 'local') {
          const localRoot = findProjectRoot();
          if (!localRoot) {
            throw new Error(
              'Could not find project root (no package.json found). Run from within the project directory or use --source github.',
            );
          }
          sourceLocation = { type: 'local', path: localRoot };
          spinner.succeed(chalk.green(`Source: Local project (${localRoot})`));
        } else if (options.source === 'github') {
          sourceLocation = {
            type: 'github-release',
            owner: options.githubOwner,
            repo: options.githubRepo,
            tag: options.githubTag,
          };
          spinner.succeed(
            chalk.green(
              `Source: GitHub release (${options.githubOwner}/${options.githubRepo}@${options.githubTag})`,
            ),
          );
        } else {
          throw new Error(`Invalid source mode: ${options.source}. Use auto, local, or github.`);
        }

        // Step 3: Resolve source to filesystem path
        spinner.start('Preparing source code...');
        sourcePath = await resolveSourcePath(sourceLocation);
        spinner.succeed(chalk.green(`Source ready: ${sourcePath}`));

        // Step 4: Create or get CodeCommit repository
        spinner.start('Setting up CodeCommit repository...');
        const codecommitClient = new CodeCommitClient({ region: options.region });
        await ensureCodeCommitRepo(codecommitClient, options.repoName);
        spinner.succeed(chalk.green(`CodeCommit repository ready: ${options.repoName}`));

        // Step 5: Push source to CodeCommit (using batched CreateCommit API)
        spinner.start('Pushing source code to CodeCommit...');
        await pushToCodeCommit(codecommitClient, options.repoName, sourcePath, 'main');
        spinner.succeed(chalk.green('Source code pushed to CodeCommit'));

        // Step 6: Check if Pipeline stack exists
        spinner.start('Checking Pipeline stack status...');
        const cfnClient = new CloudFormationClient({ region: options.region });
        const stackExists = await pipelineStackExists(cfnClient, options.env);

        if (stackExists) {
          // Pipeline stack exists - skip local CDK, CodePipeline will handle deployment
          spinner.succeed(
            chalk.green('Pipeline stack exists - CodePipeline will handle deployment'),
          );
          console.log(
            chalk.gray(
              '\nCodePipeline will automatically deploy infrastructure updates from the pushed code.',
            ),
          );
          console.log(
            chalk.gray('Monitor deployment progress in the AWS CodePipeline console.'),
          );
        } else {
          // First-time deployment - run local CDK to bootstrap Pipeline stack
          spinner.start('Deploying Pipeline stack (this will take 15-30 minutes)...');
          deployCdkStacks(sourcePath, options.region, options.env);
          spinner.succeed(chalk.green('Pipeline stack deployed - future pushes will auto-deploy'));
        }

        // Step 7: Save deployment config
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
      } finally {
        // Clean up temporary source directories
        if (sourcePath && sourceLocation) {
          cleanupSource(sourcePath, sourceLocation);
        }
      }
    });
}
