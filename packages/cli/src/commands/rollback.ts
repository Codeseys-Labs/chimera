/**
 * Rollback command — invoke the chimera-rollback-{env} Lambda to revert
 * the chat-gateway canary to the last stable image (or a specific commit SHA).
 *
 * The Lambda is defined in infra/lib/pipeline-stack.ts and handles the
 * ALB listener weight revert + ECS canary task-def rollback. This command
 * is a thin wrapper that:
 *   1. Confirms the destructive action (unless --yes)
 *   2. Invokes the Lambda via @aws-sdk/client-lambda
 *   3. Polls the canary ECS service until rolloutState reaches COMPLETED/FAILED
 *
 * Usage:
 *   chimera rollback                        # rollback to last stable (Lambda reads S3)
 *   chimera rollback --to <sha>             # rollback to a specific commit SHA
 *   chimera rollback --yes                  # skip confirmation
 *   chimera rollback --json                 # machine-readable envelope
 */

import { Command } from 'commander';
import ora from 'ora';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';

type RollbackOutcome = 'completed' | 'failed' | 'timeout';

interface RollbackEvent {
  reason?: string;
  fallbackImageUri?: string;
}

interface LambdaRollbackResult {
  status?: string;
  rolledBackAt?: string;
  stableImageUri?: string;
  previousDeploymentId?: string;
  trafficAllocation?: { canary: number; production: number };
  rollbackLogKey?: string;
}

function buildFallbackImageUri(sha: string, region: string, accountId: string, envName: string): string {
  const repoName = `chimera-chat-gateway-${envName}`;
  return `${accountId}.dkr.ecr.${region}.amazonaws.com/${repoName}:${sha}`;
}

async function pollEcsRollout(
  client: ECSClient,
  cluster: string,
  service: string,
  timeoutMs: number,
  spinner: ReturnType<typeof ora> | null,
): Promise<{ outcome: RollbackOutcome; rolloutState?: string; reason?: string }> {
  const start = Date.now();
  const pollMs = 5_000;
  // Count consecutive polls where ECS has no PRIMARY deployment (or rolloutState).
  // Happens briefly during rapid successive deploys; if it persists, surface the
  // anomaly instead of silently waiting 10 minutes for the outer timeout.
  let unknownStreak = 0;
  const UNKNOWN_STREAK_WARN = 3;
  while (Date.now() - start < timeoutMs) {
    const resp = await client.send(new DescribeServicesCommand({ cluster, services: [service] }));
    const svc = resp.services?.[0];
    const primary = svc?.deployments?.find((d) => d.status === 'PRIMARY');
    const rolloutState = primary?.rolloutState;
    if (spinner) spinner.text = `ECS rollout: ${rolloutState ?? 'UNKNOWN'}`;
    if (rolloutState === 'COMPLETED') {
      return { outcome: 'completed', rolloutState, reason: primary?.rolloutStateReason };
    }
    if (rolloutState === 'FAILED') {
      return { outcome: 'failed', rolloutState, reason: primary?.rolloutStateReason };
    }
    if (!rolloutState) {
      unknownStreak += 1;
      if (unknownStreak === UNKNOWN_STREAK_WARN && spinner) {
        spinner.text =
          `ECS: no PRIMARY deployment visible for ${unknownStreak * pollMs / 1000}s — ` +
          `service may be between deployments. Will continue until timeout.`;
      }
    } else {
      unknownStreak = 0;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { outcome: 'timeout' };
}

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback')
    .description('Rollback chat-gateway canary to last stable (or specific commit SHA)')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--to <sha>', 'Rollback to specific commit SHA (image tag). Default: last stable from S3')
    .option('--account-id <id>', 'AWS account ID (required with --to; read from workspace by default)')
    .option('--reason <text>', 'Rollback reason (recorded in S3 log)', 'Manual rollback via CLI')
    .option('--yes', 'Skip confirmation prompt')
    .option('--timeout <seconds>', 'ECS polling timeout in seconds (default: 600)', '600')
    .option('--json', 'Output result as JSON')
    .addHelpText('after', `
Examples:
  $ chimera rollback
  $ chimera rollback --to a1b2c3d
  $ chimera rollback --yes --json
  $ chimera rollback --env prod --to abc1234`)
    .action(async (options) => {
      const spinner = options.json ? null : ora('Preparing rollback').start();
      try {
        const wsConfig = loadWorkspaceConfig();
        const region = options.region ?? wsConfig?.aws?.region;
        if (!region) {
          const msg = 'No AWS region configured. Run "chimera init" to set up your workspace.';
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_REGION' }));
          } else {
            spinner?.fail(color.red(msg));
          }
          process.exit(1);
        }
        const envName = (options.env ?? wsConfig?.workspace?.environment ?? 'dev').replace(/[^a-zA-Z0-9-]/g, '');
        if (wsConfig?.aws?.profile) process.env.AWS_PROFILE = wsConfig.aws.profile;

        const lambdaName = `chimera-rollback-${envName}`;
        const cluster = `chimera-chat-${envName}`;
        const service = `chimera-chat-gateway-${envName}`;
        const timeoutMs = Math.max(30_000, parseInt(options.timeout, 10) * 1_000);

        // Build event payload
        const event: RollbackEvent = { reason: options.reason };
        let target = 'last stable (from S3 snapshot)';
        if (options.to) {
          const sha = String(options.to).trim();
          if (!/^[a-f0-9]{7,40}$/i.test(sha)) {
            const msg = `Invalid commit SHA: ${sha}`;
            if (options.json) {
              console.log(JSON.stringify({ status: 'error', error: msg, code: 'INVALID_SHA' }));
            } else {
              spinner?.fail(color.red(msg));
            }
            process.exit(1);
          }
          const accountId = options.accountId ?? wsConfig?.deployment?.account_id;
          if (!accountId) {
            const msg = '--to requires --account-id (or deployment.account_id in chimera.toml)';
            if (options.json) {
              console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_ACCOUNT_ID' }));
            } else {
              spinner?.fail(color.red(msg));
            }
            process.exit(1);
          }
          event.fallbackImageUri = buildFallbackImageUri(sha, region, accountId, envName);
          target = `commit ${sha.slice(0, 7)} (${event.fallbackImageUri})`;
        }

        // Confirmation
        if (!options.yes && !options.json) {
          spinner?.stop();
          const inquirer = await import('inquirer');
          const answers = await inquirer.default.prompt([
            {
              type: 'confirm',
              name: 'confirmed',
              message: color.yellow(`Rollback ${envName} chat-gateway to ${target}?`),
              default: false,
            },
          ]);
          if (!answers.confirmed) {
            console.log(color.gray('Rollback cancelled'));
            return;
          }
          spinner?.start(`Invoking ${lambdaName}`);
        } else if (spinner) {
          spinner.text = `Invoking ${lambdaName}`;
        }

        // Invoke Lambda
        const lambdaClient = new LambdaClient({ region });
        const invokeResp = await lambdaClient.send(
          new InvokeCommand({
            FunctionName: lambdaName,
            InvocationType: 'RequestResponse',
            Payload: Buffer.from(JSON.stringify(event), 'utf8'),
          }),
        );

        if (invokeResp.FunctionError) {
          const payloadText = invokeResp.Payload ? Buffer.from(invokeResp.Payload).toString('utf8') : '';
          const msg = `Lambda ${lambdaName} returned ${invokeResp.FunctionError}: ${payloadText}`;
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'LAMBDA_ERROR' }));
          } else {
            spinner?.fail(color.red(msg));
          }
          process.exit(1);
        }

        const payloadText = invokeResp.Payload ? Buffer.from(invokeResp.Payload).toString('utf8') : '{}';
        // Lambda runtime crashes can return non-JSON strings as Payload (e.g.
        // "Task timed out after 300.00 seconds") even without FunctionError set.
        // Without this guard, JSON.parse throws SyntaxError which bubbles to the
        // generic catch and emits code:SyntaxError instead of code:LAMBDA_ERROR,
        // hiding the actual rollback Lambda failure.
        let lambdaResult: LambdaRollbackResult = {};
        try {
          lambdaResult = JSON.parse(payloadText) as LambdaRollbackResult;
        } catch {
          const msg = `Lambda ${lambdaName} returned non-JSON payload: ${payloadText.slice(0, 200)}`;
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'LAMBDA_ERROR' }));
          } else {
            spinner?.fail(color.red(msg));
          }
          process.exit(1);
        }

        if (spinner) spinner.text = 'Polling ECS rollout';
        const ecsClient = new ECSClient({ region });
        const rollout = await pollEcsRollout(ecsClient, cluster, service, timeoutMs, spinner);

        const data = {
          env: envName,
          region,
          lambdaName,
          target,
          lambda: lambdaResult,
          ecs: { cluster, service, ...rollout },
        };

        if (options.json) {
          const ok = rollout.outcome === 'completed';
          console.log(JSON.stringify({ status: ok ? 'ok' : 'error', data, code: ok ? undefined : 'ROLLOUT_' + rollout.outcome.toUpperCase() }));
          if (!ok) process.exit(1);
          return;
        }

        if (rollout.outcome === 'completed') {
          spinner?.succeed(color.green(`Rollback complete — stable: ${lambdaResult.stableImageUri ?? 'unknown'}`));
        } else if (rollout.outcome === 'failed') {
          spinner?.fail(color.red(`Rollback failed — ECS rolloutState=FAILED${rollout.reason ? ': ' + rollout.reason : ''}`));
          process.exit(1);
        } else {
          spinner?.fail(color.red(`Rollback timed out waiting for ECS rollout after ${timeoutMs / 1000}s`));
          process.exit(1);
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: error.name ?? 'ROLLBACK_FAILED' }));
        } else {
          spinner?.fail(color.red('Rollback failed'));
          console.error(color.red(error.message));
        }
        process.exit(1);
      }
    });
}
