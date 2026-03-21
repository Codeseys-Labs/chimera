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
} from '@aws-sdk/client-codecommit';
import { loadConfig, saveConfig, type DeploymentConfig } from '../utils/config';

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
 * Push local repository to CodeCommit
 * Note: Uses git commands with validated paths - repo URL from AWS SDK, repoRoot from git itself
 */
function pushToCodeCommit(repoUrl: string, repoRoot: string): void {
  const execOptions = { cwd: repoRoot, stdio: 'pipe' as const };

  // Check if git repo exists
  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    execSync('git init', execOptions);
    execSync('git add .', execOptions);
    execSync('git commit -m "Initial Chimera deployment"', execOptions);
  }

  // Add CodeCommit remote (URL is from AWS SDK, safe)
  try {
    execSync(`git remote add codecommit "${repoUrl}"`, execOptions);
  } catch {
    // Remote already exists, update URL
    execSync(`git remote set-url codecommit "${repoUrl}"`, execOptions);
  }

  // Push to CodeCommit
  execSync('git push codecommit main -f', execOptions);
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
        const repoUrl = await ensureCodeCommitRepo(codecommitClient, options.repoName);
        spinner.succeed(chalk.green(`CodeCommit repository ready: ${options.repoName}`));

        // Step 3: Find repo root
        spinner.start('Locating repository root...');
        const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
        spinner.succeed(chalk.green(`Repository root: ${repoRoot}`));

        // Step 4: Push source to CodeCommit
        spinner.start('Pushing source code to CodeCommit...');
        pushToCodeCommit(repoUrl, repoRoot);
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
