/**
 * Deployment commands - AWS CodeCommit + CodePipeline orchestration
 *
 * CDK runs via `npx cdk` (spawned by Bun.$) to preserve Node.js module resolution.
 * "bunx cdk" would break CDK instanceof checks — npx always runs CDK under Node.
 */

import { Command } from 'commander';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import {
  CodeCommitClient,
  CreateRepositoryCommand,
  GetRepositoryCommand,
} from '@aws-sdk/client-codecommit';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../utils/workspace.js';
import {
  resolveSourcePath,
  cleanupSource,
  type SourceLocation,
} from '../utils/source.js';
import { pushToCodeCommit } from '../utils/codecommit.js';
import { color } from '../lib/color.js';


/**
 * Get AWS account ID from STS.
 * Command is fully app-controlled — safe to use Bun.$ template literal.
 */
async function getAccountId(): Promise<string> {
  try {
    return await Bun.$`aws sts get-caller-identity --query Account --output text`.quiet().text();
  } catch {
    throw new Error('Failed to get AWS account ID. Ensure AWS credentials are configured.');
  }
}

/**
 * Find project root by walking up directory tree looking for package.json.
 * Returns null if not found.
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
    const getRepoCommand = new GetRepositoryCommand({ repositoryName: repoName });
    const repo = await client.send(getRepoCommand);
    return repo.repositoryMetadata?.cloneUrlHttp || '';
  } catch (error: any) {
    if (error.name === 'RepositoryDoesNotExistException') {
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
 */
async function pipelineStackExists(
  client: CloudFormationClient,
  environment: string,
): Promise<boolean> {
  try {
    const stackName = `Chimera-${environment}-Pipeline`;
    const command = new DescribeStacksCommand({ StackName: stackName });
    const response = await client.send(command);
    const stack = response.Stacks?.[0];
    return !!stack && stack.StackStatus !== 'DELETE_COMPLETE';
  } catch (error: any) {
    if (error.name === 'ValidationError') {
      return false;
    }
    throw error;
  }
}


/**
 * Deploy only the Pipeline CDK stack via npx (not bunx).
 * npx spawns a separate Node.js process — CDK module resolution works correctly.
 * safeEnv is sanitized to [a-zA-Z0-9-] — safe for Bun.$ template interpolation.
 */
async function deployCdkStacks(repoRoot: string, environment: string): Promise<void> {
  const safeEnv = environment.replace(/[^a-zA-Z0-9-]/g, '');
  await Bun.$`npx cdk deploy Chimera-${safeEnv}-Pipeline --require-approval never --context environment=${safeEnv} --context repositoryName=chimera`
    .cwd(`${repoRoot}/infra`);
}

/**
 * Register all deployment-related commands
 */
export function registerDeployCommands(program: Command): void {
  program
    .command('deploy')
    .description('Deploy Chimera to AWS account (creates CodeCommit repo, pushes source, triggers pipeline)')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--repo-name <name>', 'CodeCommit repository name')
    .option(
      '--source <mode>',
      'Source mode: auto (latest release), local (current directory), github (release archive), git (clone from --remote)',
      'auto',
    )
    .option('--github-owner <owner>', 'GitHub repository owner', 'your-org')
    .option('--github-repo <repo>', 'GitHub repository name', 'chimera')
    .option('--github-tag <tag>', 'GitHub release tag (or "latest")', 'latest')
    .option('--remote <url>', 'Custom git remote URL to clone (implies --source git)')
    .option('--branch <branch>', 'Branch to checkout when using --source git')
    .option('--tag <tag>', 'Tag to checkout when using --source git')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      const spinner = ora('Starting Chimera deployment').start();
      if (options.json) spinner.stop();

      let sourceLocation: SourceLocation | undefined;
      let sourcePath: string | null = null;

      try {
        const wsConfig = loadWorkspaceConfig();
        const region = options.region ?? wsConfig?.aws?.region ?? 'us-east-1';
        const env = options.env ?? wsConfig?.workspace?.environment ?? 'dev';
        const repoName = options.repoName ?? wsConfig?.workspace?.repository ?? 'chimera';
        if (wsConfig?.aws?.profile) { process.env.AWS_PROFILE = wsConfig.aws.profile; }

        if (!options.json) spinner.text = 'Verifying AWS credentials...';
        const accountId = await getAccountId();
        if (!options.json) spinner.succeed(color.green(`AWS Account: ${accountId}`));

        if (!options.json) spinner.start('Determining source location...');
        if (options.source === 'auto' && options.remote) {
          sourceLocation = {
            type: 'git-clone',
            remote: options.remote,
            branch: options.branch,
            tag: options.tag,
          };
          const ref = options.branch ?? options.tag;
          if (!options.json) spinner.succeed(color.green(`Source: git clone (${options.remote}${ref ? `@${ref}` : ''})`));
        } else if (options.source === 'auto') {
          sourceLocation = {
            type: 'github-release',
            owner: options.githubOwner,
            repo: options.githubRepo,
            tag: options.githubTag,
          };
          if (!options.json) spinner.succeed(color.green(`Source: GitHub release (${options.githubOwner}/${options.githubRepo}@${options.githubTag})`));
        } else if (options.source === 'git') {
          if (!options.remote) {
            throw new Error('--source git requires --remote <url>');
          }
          sourceLocation = {
            type: 'git-clone',
            remote: options.remote,
            branch: options.branch,
            tag: options.tag,
          };
          const ref = options.branch ?? options.tag;
          if (!options.json) spinner.succeed(color.green(`Source: git clone (${options.remote}${ref ? `@${ref}` : ''})`));
        } else if (options.source === 'local') {
          const localRoot = findProjectRoot();
          if (!localRoot) {
            throw new Error(
              'Could not find project root (no package.json found). Run from within the project directory or use --source github.',
            );
          }
          sourceLocation = { type: 'local', path: localRoot };
          if (!options.json) spinner.succeed(color.green(`Source: Local project (${localRoot})`));
        } else if (options.source === 'github') {
          sourceLocation = {
            type: 'github-release',
            owner: options.githubOwner,
            repo: options.githubRepo,
            tag: options.githubTag,
          };
          if (!options.json) spinner.succeed(color.green(`Source: GitHub release (${options.githubOwner}/${options.githubRepo}@${options.githubTag})`));
        } else {
          throw new Error(`Invalid source mode: ${options.source}. Use auto, local, github, or git.`);
        }

        if (!options.json) spinner.start('Preparing source code...');
        sourcePath = await resolveSourcePath(sourceLocation);
        if (!options.json) spinner.succeed(color.green(`Source ready: ${sourcePath}`));

        let sourceCommitSha: string | undefined;
        try {
          sourceCommitSha = await Bun.$`git rev-parse HEAD`.cwd(sourcePath!).quiet().text();
        } catch { /* not a git repo — skip */ }

        if (!options.json) spinner.start('Setting up CodeCommit repository...');
        const codecommitClient = new CodeCommitClient({ region });
        await ensureCodeCommitRepo(codecommitClient, repoName);
        if (!options.json) spinner.succeed(color.green(`CodeCommit repository ready: ${repoName}`));

        if (!options.json) spinner.start('Pushing source code to CodeCommit...');
        const codecommitCommitId = await pushToCodeCommit(codecommitClient, repoName, sourcePath, 'main');
        if (!options.json) spinner.succeed(color.green('Source code pushed to CodeCommit'));

        if (!options.json) spinner.start('Checking Pipeline stack status...');
        const cfnClient = new CloudFormationClient({ region });
        const stackExists = await pipelineStackExists(cfnClient, env);

        if (stackExists) {
          if (!options.json) {
            spinner.succeed(color.green('Pipeline stack exists - CodePipeline will handle deployment'));
            console.log(color.gray('\nCodePipeline will automatically deploy infrastructure updates from the pushed code.'));
            console.log(color.gray('Monitor deployment progress in the AWS CodePipeline console.'));
          }
        } else {
          if (!options.json) spinner.start('Deploying Pipeline stack (this will take 15-30 minutes)...');
          await deployCdkStacks(sourcePath, env);
          if (!options.json) spinner.succeed(color.green('Pipeline stack deployed - future pushes will auto-deploy'));
        }

        const updatedConfig = loadWorkspaceConfig();
        saveWorkspaceConfig({
          ...updatedConfig,
          deployment: {
            ...updatedConfig.deployment,
            account_id: accountId,
            status: 'deployed',
            last_deployed: new Date().toISOString(),
            source_commit: sourceCommitSha,
            codecommit_commit: codecommitCommitId,
          },
        });

        if (options.json) {
          console.log(JSON.stringify({
            status: 'ok',
            data: { accountId, repoName, env, region, stackExists, sourceCommitSha, codecommitCommitId },
          }));
        } else {
          console.log(color.green('\n✓ Deployment complete!'));
          console.log(color.gray('\nNext steps:'));
          console.log(color.gray('  1. Run "chimera endpoints" to save API endpoints'));
          console.log(color.gray('  2. Run "chimera status" to check deployment health'));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'DEPLOY_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Deployment failed'));
        console.error(color.red(error.message));
        process.exit(1);
      } finally {
        if (sourcePath && sourceLocation) {
          cleanupSource(sourcePath, sourceLocation);
        }
      }
    });
}
