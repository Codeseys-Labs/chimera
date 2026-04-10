/**
 * Deployment commands - AWS CodeCommit + CodePipeline orchestration
 *
 * CDK runs via `npx cdk` (spawned by Bun.$) to preserve Node.js module resolution.
 * "bunx cdk" would break CDK instanceof checks — npx always runs CDK under Node.
 */

import { Command } from 'commander';
import ora from 'ora';
import {
  CodeCommitClient,
  CreateRepositoryCommand,
  GetRepositoryCommand,
} from '@aws-sdk/client-codecommit';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackEventsCommand,
} from '@aws-sdk/client-cloudformation';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  loadCredentials,
  saveCredentials,
} from '../utils/workspace.js';
import { resolveSourcePath, cleanupSource, type SourceLocation } from '../utils/source.js';
import { pushToCodeCommit } from '../utils/codecommit.js';
import { color } from '../lib/color.js';
import { findProjectRoot } from '../utils/project.js';
import { provisionAdminUser } from './setup.js';
import { terminalLogin } from './login.js';

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
 * Create or get existing CodeCommit repository
 */
async function ensureCodeCommitRepo(client: CodeCommitClient, repoName: string): Promise<string> {
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
  environment: string
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
 * Ensure CDK is bootstrapped in the target account/region.
 * Checks for CDKToolkit stack — if missing, runs `npx cdk bootstrap` automatically.
 * Returns 'already' if bootstrap exists, 'bootstrapped' if we just did it, 'skipped' on error.
 */
async function ensureCdkBootstrap(
  region: string,
  accountId: string,
  sourcePath: string | null
): Promise<'already' | 'bootstrapped' | 'skipped'> {
  const cfn = new CloudFormationClient({ region });
  try {
    const resp = await cfn.send(new DescribeStacksCommand({ StackName: 'CDKToolkit' }));
    const stack = resp.Stacks?.[0];
    if (stack && !stack.StackStatus?.includes('DELETE') && !stack.StackStatus?.includes('FAILED')) {
      return 'already';
    }
  } catch (error: any) {
    // Stack doesn't exist — need to bootstrap
    if (error.name !== 'ValidationError') {
      console.warn(`CDK bootstrap check warning: ${error.message}`);
      return 'skipped';
    }
  }

  // Bootstrap
  try {
    const cleanAccountId = accountId.trim();
    const cwd = sourcePath ? `${sourcePath}/infra` : undefined;
    const proc = Bun.$`npx cdk bootstrap aws://${cleanAccountId}/${region} --require-approval never`;
    if (cwd) proc.cwd(cwd);
    await proc.quiet();
    return 'bootstrapped';
  } catch (error: any) {
    console.warn(`CDK bootstrap failed: ${error.message?.slice(0, 200)}`);
    return 'skipped';
  }
}

/**
 * Get all outputs from a CloudFormation stack.
 * Returns an empty object if the stack doesn't exist yet (graceful skip).
 */
async function getStackOutputs(
  client: CloudFormationClient,
  stackName: string
): Promise<Record<string, string>> {
  try {
    const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs: Record<string, string> = {};
    for (const output of response.Stacks?.[0]?.Outputs ?? []) {
      if (output.OutputKey && output.OutputValue) {
        outputs[output.OutputKey] = output.OutputValue;
      }
    }
    return outputs;
  } catch (error: any) {
    if (error.name === 'ValidationError') return {};
    throw error;
  }
}

/**
 * Collect API/Cognito endpoints from deployed CloudFormation stacks and save
 * them to chimera.toml. Returns false when the stacks aren't deployed yet
 * (fresh deploy — CodePipeline hasn't finished running).
 */
async function autoCollectEndpoints(
  cfnClient: CloudFormationClient,
  region: string,
  env: string
): Promise<boolean> {
  const [apiOutputs, chatOutputs, secOutputs, frontendOutputs] = await Promise.all([
    getStackOutputs(cfnClient, `Chimera-${env}-Api`),
    getStackOutputs(cfnClient, `Chimera-${env}-Chat`),
    getStackOutputs(cfnClient, `Chimera-${env}-Security`),
    getStackOutputs(cfnClient, `Chimera-${env}-Frontend`),
  ]);

  const apiUrl = apiOutputs.ApiUrl ?? apiOutputs.RestApiUrl;
  const cognitoUserPoolId = secOutputs.UserPoolId;

  // Core stacks not yet deployed — skip silently
  if (!apiUrl || !cognitoUserPoolId) return false;

  const albDns = chatOutputs.AlbDnsName;
  const webSocketUrl = apiOutputs.WebSocketUrl ?? apiOutputs.WebSocketApiUrl;
  const cognitoClientId = secOutputs.WebClientId ?? secOutputs.UserPoolClientId;
  const cognitoDomain = secOutputs.HostedUIDomain;
  const frontendUrl = frontendOutputs.FrontendUrl;

  const current = loadWorkspaceConfig();
  saveWorkspaceConfig({
    ...current,
    aws: { ...current?.aws, region },
    endpoints: {
      api_url: apiUrl,
      ...(albDns ? { chat_url: `http://${albDns}` } : {}),
      ...(webSocketUrl ? { websocket_url: webSocketUrl } : {}),
      cognito_user_pool_id: cognitoUserPoolId,
      ...(cognitoClientId ? { cognito_client_id: cognitoClientId } : {}),
      ...(cognitoDomain ? { cognito_domain: cognitoDomain } : {}),
      ...(frontendUrl ? { frontend_url: frontendUrl } : {}),
    },
  });

  return true;
}

/**
 * Generate a cryptographically random password satisfying Cognito's default
 * policy: ≥12 chars, at least one uppercase, lowercase, digit, and symbol.
 */
function generatePassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%^&*';
  const all = upper + lower + digits + special;

  const pick = (chars: string): string => {
    const b = new Uint8Array(1);
    crypto.getRandomValues(b);
    return chars[b[0] % chars.length];
  };

  // Guarantee at least one character from each required category
  const parts = [pick(upper), pick(lower), pick(digits), pick(special)];
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  Array.from(buf).forEach((byte) => parts.push(all[byte % all.length]));

  // Fisher-Yates shuffle
  for (let i = parts.length - 1; i > 0; i--) {
    const b = new Uint8Array(1);
    crypto.getRandomValues(b);
    const j = b[0] % (i + 1);
    [parts[i], parts[j]] = [parts[j], parts[i]];
  }
  return parts.join('');
}

/**
 * Ensure admin password is in ~/.chimera/credentials. Prompts interactively
 * unless autoGenerate is true. Returns the password, or null if user skipped.
 */
async function ensureAdminCredentials(email: string, autoGenerate = false): Promise<string | null> {
  const creds = loadCredentials();
  if (creds.admin?.password) return creds.admin.password;

  if (autoGenerate) {
    const password = generatePassword();
    saveCredentials({ ...creds, admin: { password } });
    console.log(color.green(`\nGenerated admin password: ${password}`));
    console.log(color.yellow('  Save this password — it will not be shown again.'));
    return password;
  }

  const inquirer = await import('inquirer');
  const { action } = await inquirer.default.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: `Admin password for ${email} is not set. What would you like to do?`,
      choices: [
        { name: 'Enter a password now', value: 'enter' },
        { name: 'Auto-generate a password', value: 'generate' },
        { name: 'Skip — run "chimera setup" manually later', value: 'skip' },
      ],
    },
  ]);

  if (action === 'skip') return null;

  if (action === 'generate') {
    const password = generatePassword();
    saveCredentials({ ...creds, admin: { password } });
    console.log(color.green(`\nGenerated admin password: ${password}`));
    console.log(color.yellow('  Save this password — it will not be shown again.'));
    return password;
  }

  // action === 'enter'
  const { entered } = await inquirer.default.prompt<{ entered: string }>([
    {
      type: 'password',
      name: 'entered',
      message: `Admin password for ${email}:`,
      validate: (v: string) => (v.length >= 12 ? true : 'Minimum 12 characters required'),
    },
  ]);
  saveCredentials({ ...creds, admin: { password: entered } });
  return entered;
}

/**
 * Provision the admin Cognito user. Resolves user pool ID from chimera.toml
 * endpoints or CloudFormation. Throws if the Security stack isn't deployed yet.
 * Returns true if the user was created, false if they already existed.
 */
async function runAutoSetup(
  region: string,
  env: string,
  email: string,
  password: string
): Promise<boolean> {
  const wsConfig = loadWorkspaceConfig();
  let userPoolId = wsConfig?.endpoints?.cognito_user_pool_id;

  if (!userPoolId) {
    const cfnClient = new CloudFormationClient({ region });
    const secOutputs = await getStackOutputs(cfnClient, `Chimera-${env}-Security`);
    userPoolId = secOutputs.UserPoolId;
  }

  if (!userPoolId) {
    throw new Error(
      'Cognito user pool not found. Security stack may not be deployed yet. ' +
        'Run "chimera setup" after the pipeline finishes.'
    );
  }

  const cognitoClient = new CognitoIdentityProviderClient({ region });
  return provisionAdminUser(cognitoClient, userPoolId, email, password);
}

/**
 * Poll CloudFormation stack events until the stack reaches a terminal state.
 * Prints each new event as it arrives. Polls every 10 seconds.
 */
async function monitorStackEvents(client: CloudFormationClient, stackName: string): Promise<void> {
  const terminalStatuses = new Set([
    'CREATE_COMPLETE',
    'CREATE_FAILED',
    'ROLLBACK_COMPLETE',
    'ROLLBACK_FAILED',
    'UPDATE_COMPLETE',
    'UPDATE_ROLLBACK_COMPLETE',
    'UPDATE_ROLLBACK_FAILED',
    'DELETE_COMPLETE',
    'DELETE_FAILED',
  ]);

  console.log(color.gray(`\nMonitoring stack: ${stackName}`));
  console.log(color.gray('(Ctrl+C stops monitoring — deployment continues in background)\n'));

  const seenIds = new Set<string>();
  let currentStatus = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const stackResp = await client.send(new DescribeStacksCommand({ StackName: stackName }));
      currentStatus = stackResp.Stacks?.[0]?.StackStatus ?? '';

      const eventsResp = await client.send(
        new DescribeStackEventsCommand({ StackName: stackName })
      );
      // Reverse so events display oldest-first
      const events = (eventsResp.StackEvents ?? []).slice().reverse();
      for (const event of events) {
        if (!event.EventId || seenIds.has(event.EventId)) continue;
        seenIds.add(event.EventId);

        const ts = event.Timestamp?.toISOString().slice(11, 19) ?? '';
        const resource = (event.LogicalResourceId ?? '').padEnd(40);
        const status = event.ResourceStatus ?? '';
        const reason = event.ResourceStatusReason ? ` — ${event.ResourceStatusReason}` : '';
        const statusStr = status.includes('FAILED')
          ? color.red(status)
          : status.includes('COMPLETE')
            ? color.green(status)
            : color.gray(status);

        console.log(`${color.gray(ts)} ${resource} ${statusStr}${color.gray(reason)}`);
      }

      if (terminalStatuses.has(currentStatus)) break;
    } catch (error: any) {
      if (error.name === 'ValidationError') {
        console.log(color.gray(`Stack ${stackName} not yet available — waiting...`));
      } else {
        throw error;
      }
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  }

  if (currentStatus.includes('FAILED') || currentStatus.includes('ROLLBACK')) {
    console.log(color.red(`\n✗ Stack reached ${currentStatus}`));
  } else {
    console.log(color.green(`\n✓ Stack reached ${currentStatus}`));
  }
}

/**
 * Deploy only the Pipeline CDK stack via npx (not bunx).
 * npx spawns a separate Node.js process — CDK module resolution works correctly.
 * safeEnv is sanitized to [a-zA-Z0-9-] — safe for Bun.$ template interpolation.
 * quiet=true suppresses CDK CloudFormation event noise; pass false only when --monitor is set.
 */
async function deployCdkStacks(repoRoot: string, environment: string, quiet = true): Promise<void> {
  const safeEnv = environment.replace(/[^a-zA-Z0-9-]/g, '');
  const proc =
    Bun.$`npx cdk deploy Chimera-${safeEnv}-Pipeline --require-approval never --context environment=${safeEnv} --context repositoryName=chimera`.cwd(
      `${repoRoot}/infra`
    );
  await (quiet ? proc.quiet() : proc);
}

/**
 * Register all deployment-related commands
 */
export function registerDeployCommands(program: Command): void {
  program
    .command('deploy')
    .description(
      'Deploy Chimera to AWS account (creates CodeCommit repo, pushes source, triggers pipeline)'
    )
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--repo-name <name>', 'CodeCommit repository name')
    .option(
      '--source <mode>',
      'Source mode: auto (latest release), local (current directory), github (release archive), git (clone from --remote)',
      'auto'
    )
    .option('--github-owner <owner>', 'GitHub repository owner', 'your-org')
    .option('--github-repo <repo>', 'GitHub repository name', 'chimera')
    .option('--github-tag <tag>', 'GitHub release tag (or "latest")', 'latest')
    .option('--remote <url>', 'Custom git remote URL to clone (implies --source git)')
    .option('--branch <branch>', 'Branch to checkout when using --source git')
    .option('--tag <tag>', 'Tag to checkout when using --source git')
    .option('--no-setup', 'Skip admin user provisioning after deploy')
    .option('--skip-setup-prompt', 'Auto-generate admin password without prompting')
    .option('--monitor', 'Watch CloudFormation stack events in real-time (10s polling)')
    .option('--json', 'Output result as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ chimera deploy
  $ chimera deploy --region us-west-2 --env prod
  $ chimera deploy --source local
  $ chimera deploy --source git --remote https://github.com/org/chimera
  $ chimera deploy --monitor --json`
    )
    .action(async (options) => {
      const spinner = ora('Starting Chimera deployment').start();
      if (options.json) spinner.stop();

      let sourceLocation: SourceLocation | undefined;
      let sourcePath: string | null = null;

      try {
        const wsConfig = loadWorkspaceConfig();
        const region = options.region ?? wsConfig?.aws?.region;
        if (!region) {
          const msg = 'No AWS region configured. Run "chimera init" to set up your workspace.';
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_REGION' }));
            process.exit(1);
          }
          spinner.fail(color.red(msg));
          process.exit(1);
        }
        const env = options.env ?? wsConfig?.workspace?.environment ?? 'dev';
        const repoName = options.repoName ?? wsConfig?.workspace?.repository ?? 'chimera';
        if (wsConfig?.aws?.profile) {
          process.env.AWS_PROFILE = wsConfig.aws.profile;
        }

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
          if (!options.json)
            spinner.succeed(
              color.green(`Source: git clone (${options.remote}${ref ? `@${ref}` : ''})`)
            );
        } else if (options.source === 'auto') {
          sourceLocation = {
            type: 'github-release',
            owner: options.githubOwner,
            repo: options.githubRepo,
            tag: options.githubTag,
          };
          if (!options.json)
            spinner.succeed(
              color.green(
                `Source: GitHub release (${options.githubOwner}/${options.githubRepo}@${options.githubTag})`
              )
            );
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
          if (!options.json)
            spinner.succeed(
              color.green(`Source: git clone (${options.remote}${ref ? `@${ref}` : ''})`)
            );
        } else if (options.source === 'local') {
          const localRoot = findProjectRoot();
          sourceLocation = { type: 'local', path: localRoot };
          if (!options.json) spinner.succeed(color.green(`Source: Local project (${localRoot})`));
        } else if (options.source === 'github') {
          sourceLocation = {
            type: 'github-release',
            owner: options.githubOwner,
            repo: options.githubRepo,
            tag: options.githubTag,
          };
          if (!options.json)
            spinner.succeed(
              color.green(
                `Source: GitHub release (${options.githubOwner}/${options.githubRepo}@${options.githubTag})`
              )
            );
        } else {
          throw new Error(
            `Invalid source mode: ${options.source}. Use auto, local, github, or git.`
          );
        }

        if (!options.json) spinner.start('Preparing source code...');
        sourcePath = await resolveSourcePath(sourceLocation);
        if (!options.json) spinner.succeed(color.green(`Source ready: ${sourcePath}`));

        // Install dependencies if deploying from a non-local source (git/github/auto).
        // Local source already has node_modules from the developer's workspace.
        if (options.source !== 'local') {
          if (!options.json) spinner.start('Installing dependencies...');
          await Bun.$`bun install --frozen-lockfile`.cwd(sourcePath).quiet();
          if (!options.json) spinner.succeed(color.green('Dependencies installed'));
        }

        let sourceCommitSha: string | undefined;
        try {
          sourceCommitSha = await Bun.$`git rev-parse HEAD`.cwd(sourcePath!).quiet().text();
        } catch {
          /* not a git repo — skip */
        }

        // Ensure CDK is bootstrapped in the target account/region
        if (!options.json) spinner.start('Checking CDK bootstrap status...');
        const bootstrapped = await ensureCdkBootstrap(region, accountId, sourcePath);
        if (bootstrapped === 'already') {
          if (!options.json) spinner.succeed(color.green('CDK bootstrap: already configured'));
        } else if (bootstrapped === 'bootstrapped') {
          if (!options.json)
            spinner.succeed(color.green('CDK bootstrap: environment bootstrapped successfully'));
        } else {
          if (!options.json)
            spinner.warn(
              color.yellow('CDK bootstrap check skipped — deploy may fail if not bootstrapped')
            );
        }

        if (!options.json) spinner.start('Setting up CodeCommit repository...');
        const codecommitClient = new CodeCommitClient({ region });
        await ensureCodeCommitRepo(codecommitClient, repoName);
        if (!options.json) spinner.succeed(color.green(`CodeCommit repository ready: ${repoName}`));

        if (!options.json) spinner.start('Pushing source code to CodeCommit...');
        const codecommitCommitId = await pushToCodeCommit(
          codecommitClient,
          repoName,
          sourcePath,
          'main'
        );
        if (!options.json) spinner.succeed(color.green('Source code pushed to CodeCommit'));

        if (!options.json) spinner.start('Checking Pipeline stack status...');
        const cfnClient = new CloudFormationClient({ region });
        const stackExists = await pipelineStackExists(cfnClient, env);

        if (stackExists) {
          if (!options.json) {
            spinner.succeed(
              color.green('Pipeline stack exists - CodePipeline will handle deployment')
            );
            console.log(
              color.gray(
                '\nCodePipeline will automatically deploy infrastructure updates from the pushed code.'
              )
            );
          }
        } else {
          if (!options.json)
            spinner.start('Deploying Pipeline stack (this will take 15-30 minutes)...');
          await deployCdkStacks(sourcePath, env, !options.monitor);
          if (!options.json)
            spinner.succeed(
              color.green('Pipeline stack deployed - future pushes will auto-deploy')
            );
        }

        // --monitor: watch Pipeline stack events in real-time
        if (options.monitor && !options.json) {
          await monitorStackEvents(cfnClient, `Chimera-${env}-Pipeline`);
        } else if (!options.monitor && !options.json && !stackExists) {
          console.log(
            color.gray('\nRun "chimera monitor" to watch deployment progress in real-time.')
          );
        }

        // Auto-collect endpoints (succeeds only if full infra is already deployed)
        let endpointsCollected = false;
        if (!options.json) {
          spinner.start('Collecting API endpoints...');
          try {
            endpointsCollected = await autoCollectEndpoints(cfnClient, region, env);
            if (endpointsCollected) {
              spinner.succeed(color.green('API endpoints saved to chimera.toml'));
            } else {
              spinner.warn(
                color.yellow(
                  'Endpoints not available yet — run "chimera endpoints" after the pipeline finishes'
                )
              );
            }
          } catch (err: any) {
            spinner.warn(color.yellow(`Endpoint collection skipped: ${err.message}`));
          }
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

        // Auto-setup: prompt for admin password and provision Cognito user
        const adminEmail = loadWorkspaceConfig()?.auth?.admin_email;
        let setupDone = false;
        let adminPassword: string | null = null;

        if (!options.json && options.setup && adminEmail) {
          console.log('');
          adminPassword = await ensureAdminCredentials(adminEmail, options.skipSetupPrompt);
          if (adminPassword) {
            spinner.start(`Provisioning admin user ${adminEmail}...`);
            try {
              const created = await runAutoSetup(region, env, adminEmail, adminPassword);
              spinner.succeed(
                color.green(
                  created
                    ? `Admin user created: ${adminEmail}`
                    : `Admin user updated: ${adminEmail}`
                )
              );
              setupDone = true;
            } catch (err: any) {
              spinner.warn(color.yellow(`Admin setup deferred: ${err.message}`));
              console.log(
                color.gray('Password saved. Run "chimera setup" after the pipeline finishes.')
              );
            }
          } else {
            console.log(color.gray('Password not set. Run "chimera setup" when ready.'));
          }
        }

        // Auto-login: authenticate with stored credentials after successful setup
        if (!options.json && setupDone && adminEmail && adminPassword) {
          const freshConfig = loadWorkspaceConfig();
          const clientId = freshConfig.endpoints?.cognito_client_id;
          if (clientId) {
            spinner.start('Logging in as admin...');
            try {
              await terminalLogin(clientId, region, adminEmail, adminPassword);
              spinner.succeed(color.green('Logged in as admin'));
            } catch (err: any) {
              spinner.warn(color.yellow(`Auto-login failed: ${err.message}`));
              console.log(color.gray('Run "chimera login" to authenticate manually.'));
            }
          }
        }

        if (options.json) {
          console.log(
            JSON.stringify({
              status: 'ok',
              data: {
                accountId,
                repoName,
                env,
                region,
                stackExists,
                sourceCommitSha,
                codecommitCommitId,
                endpointsCollected,
                setupDone,
              },
            })
          );
        } else {
          console.log(color.green('\n✓ Deployment complete!'));
          const remaining: string[] = [];
          if (!endpointsCollected) {
            remaining.push(
              'Run "chimera endpoints" after the pipeline finishes to save API endpoints'
            );
          }
          if (!setupDone && adminEmail) {
            remaining.push('Run "chimera setup" to provision the admin user');
          }
          if (remaining.length > 0) {
            console.log(color.gray('\nNext steps:'));
            remaining.forEach((step, i) => console.log(color.gray(`  ${i + 1}. ${step}`)));
          }
          if (!setupDone || !endpointsCollected) {
            console.log(color.gray('  Run "chimera login" to authenticate when ready'));
          }
        }
      } catch (error: any) {
        if (options.json) {
          console.log(
            JSON.stringify({ status: 'error', error: error.message, code: 'DEPLOY_FAILED' })
          );
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
