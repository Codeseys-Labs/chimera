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
import { pushToCodeCommit } from '../utils/codecommit';


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
