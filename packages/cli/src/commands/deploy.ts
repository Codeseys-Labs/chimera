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
 */
function collectFiles(
  dirPath: string,
  repoRoot: string,
  files: Array<{ path: string; fullPath: string }> = [],
): Array<{ path: string; fullPath: string }> {
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
      files.push({ path: relativePath, fullPath });
    }
  }

  return files;
}

/**
 * Batch files into groups under BATCH_MAX_BYTES and BATCH_MAX_FILES limits
 * Note: File content is base64-encoded, so we track encoded size
 */
function batchFiles(
  files: Array<{ path: string; fullPath: string }>,
): Array<Array<{ path: string; content: Buffer }>> {
  const batches: Array<Array<{ path: string; content: Buffer }>> = [];
  let currentBatch: Array<{ path: string; content: Buffer }> = [];
  let currentBatchSize = 0;

  for (const file of files) {
    const content = fs.readFileSync(file.fullPath);
    // Base64 encoding increases size by ~33%
    const encodedSize = Math.ceil((content.length * 4) / 3);

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

    currentBatch.push({ path: file.path, content });
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

  // Step 3: Check if branch exists, get parent commit ID if it does
  let parentCommitId: string | undefined;
  try {
    const getBranchResult = await client.send(
      new GetBranchCommand({
        repositoryName: repoName,
        branchName,
      }),
    );
    parentCommitId = getBranchResult.branch?.commitId;
    console.log(chalk.gray(`  Branch '${branchName}' exists, will update`));
  } catch (error: any) {
    if (error.name === 'BranchDoesNotExistException') {
      console.log(chalk.gray(`  Branch '${branchName}' does not exist, will create`));
    } else {
      throw error;
    }
  }

  // Step 4: Create commits in sequence, chaining parentCommitId
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

    // Create commit
    const createCommitResult = await client.send(
      new CreateCommitCommand({
        repositoryName: repoName,
        branchName,
        parentCommitId, // undefined for first commit on new branch
        commitMessage,
        authorName: 'Chimera CLI',
        email: 'deploy@chimera.aws',
        putFiles,
      }),
    );

    // Update parent for next commit
    parentCommitId = createCommitResult.commitId;
  }

  console.log(chalk.gray(`  All commits created successfully`));
}

/**
 * Deploy CDK stacks via bootstrap script
 * Note: Validates bootstrap script exists, passes validated args
 */
function deployCdkStacks(repoRoot: string, region: string, environment: string): void {
  const bootstrapScript = path.join(repoRoot, 'scripts', 'bootstrap.sh');

  if (!fs.existsSync(bootstrapScript)) {
    throw new Error('Bootstrap script not found at scripts/bootstrap.sh');
  }

  // Validate inputs to prevent injection
  const safeEnv = environment.replace(/[^a-zA-Z0-9-]/g, '');
  const safeRegion = region.replace(/[^a-z0-9-]/g, '');

  execSync(`bash "${bootstrapScript}" "${safeEnv}" "${safeRegion}"`, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
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

        // Step 3: Find repo root
        spinner.start('Locating repository root...');
        const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
        spinner.succeed(chalk.green(`Repository root: ${repoRoot}`));

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
