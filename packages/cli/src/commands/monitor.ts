/**
 * Monitor command - Watch active CodePipeline execution in real-time.
 *
 * By default, polls CodePipeline (GetPipelineState + ListPipelineExecutions) every
 * 10 seconds and streams stage/action status until the execution reaches a terminal
 * state.
 *
 * Use --stack <name> to fall back to CloudFormation event monitoring for a specific
 * stack (backward-compatible).
 *
 * Usage:
 *   chimera monitor                      # watch Chimera-{env}-Pipeline execution
 *   chimera monitor --env prod           # watch prod pipeline
 *   chimera monitor --pipeline MyPipe    # watch a named pipeline
 *   chimera monitor --interval 5         # poll every 5 seconds
 *   chimera monitor --stack MyStack      # fallback: watch a CloudFormation stack
 */

import { Command } from 'commander';
import ora from 'ora';
import {
  CodePipelineClient,
  GetPipelineStateCommand,
  ListPipelineExecutionsCommand,
  type StageState,
} from '@aws-sdk/client-codepipeline';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';
import { monitorStack } from '../utils/cf-monitor.js';

type PipelineOutcome = 'succeeded' | 'failed' | 'not_found';

const PIPELINE_TERMINAL = new Set(['Succeeded', 'Failed', 'Stopped', 'Superseded']);

function formatPipelineStatus(status: string): string {
  if (status === 'Succeeded') return color.green(status);
  if (status === 'InProgress') return color.yellow(status);
  if (status === 'Failed') return color.red(status);
  if (status === 'Stopped' || status === 'Superseded') return color.gray(status);
  return color.gray(status);
}

function stageIcon(status: string): string {
  if (status === 'Succeeded') return color.green('✓');
  if (status === 'Failed') return color.red('✗');
  if (status === 'InProgress') return color.yellow('⋯');
  return color.gray('○');
}

function printStageTable(stageStates: StageState[]): void {
  for (const stage of stageStates) {
    const stageName = (stage.stageName ?? 'Unknown').padEnd(18);
    const stageStatus = stage.latestExecution?.status ?? 'Pending';
    console.log(`  ${stageIcon(stageStatus)} ${stageName} ${formatPipelineStatus(stageStatus)}`);

    // Show action details for active or failed stages
    if (stageStatus === 'InProgress' || stageStatus === 'Failed') {
      for (const action of stage.actionStates ?? []) {
        const actionStatus = action.latestExecution?.status ?? '';
        if (actionStatus && actionStatus !== 'Abandoned') {
          const errorSummary = action.latestExecution?.errorDetails?.message
            ? ` — ${action.latestExecution.errorDetails.message}`
            : '';
          console.log(`       ${stageIcon(actionStatus)} ${action.actionName ?? ''}${color.gray(errorSummary)}`);
        }
      }
    }
  }
}

/**
 * Poll CodePipeline until the latest execution reaches a terminal state.
 * Prints stage transitions as they occur.
 */
async function monitorPipeline(
  client: CodePipelineClient,
  pipelineName: string,
  pollMs: number,
): Promise<PipelineOutcome> {
  console.log(color.gray(`\nWatching pipeline: ${pipelineName}`));
  console.log(color.gray('(Ctrl+C stops monitoring — pipeline continues in background)\n'));

  let lastStateSnapshot = '';
  let lastExecutionId: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const [stateResp, execResp] = await Promise.all([
        client.send(new GetPipelineStateCommand({ name: pipelineName })),
        client.send(new ListPipelineExecutionsCommand({ pipelineName, maxResults: 1 })),
      ]);

      const latestExec = execResp.pipelineExecutionSummaries?.[0];
      const currentExecutionId = latestExec?.pipelineExecutionId;
      const executionStatus = latestExec?.status ?? 'Unknown';
      const stageStates = stateResp.stageStates ?? [];

      // Print header when execution ID changes
      if (currentExecutionId && currentExecutionId !== lastExecutionId) {
        lastExecutionId = currentExecutionId;
        const shortId = currentExecutionId.slice(0, 8);
        console.log(`${color.bold('Execution:')} ${shortId}...  ${formatPipelineStatus(executionStatus)}\n`);
      }

      // Only reprint when state changes
      const snapshot = stageStates.map(s =>
        `${s.stageName}:${s.latestExecution?.status ?? 'Pending'}:` +
        (s.actionStates ?? []).map(a => `${a.actionName}=${a.latestExecution?.status ?? ''}`).join(','),
      ).join('|');

      if (snapshot !== lastStateSnapshot) {
        lastStateSnapshot = snapshot;
        const ts = new Date().toLocaleTimeString();
        console.log(`[${color.gray(ts)}]`);
        printStageTable(stageStates);
        console.log('');
      }

      // Terminal state reached
      if (latestExec && PIPELINE_TERMINAL.has(executionStatus)) {
        return executionStatus === 'Succeeded' ? 'succeeded' : 'failed';
      }

      if (!latestExec) {
        console.log(color.gray('No pipeline executions found yet. Waiting...'));
      }
    } catch (error: any) {
      if (error.name === 'PipelineNotFoundException') return 'not_found';
      throw error;
    }

    await new Promise<void>(resolve => setTimeout(resolve, pollMs));
  }
}

export function registerMonitorCommand(program: Command): void {
  program
    .command('monitor')
    .description('Watch CodePipeline execution stages in real-time (use --stack for CloudFormation)')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--pipeline <name>', 'Pipeline name to monitor (default: Chimera-{env}-Pipeline)')
    .option('--stack <stack>', 'Monitor a specific CloudFormation stack instead of the pipeline')
    .option('--interval <seconds>', 'Polling interval in seconds (default: 10)', '10')
    .option('--history', 'Show all historical events (--stack mode only)')
    .option('--json', 'Output result as JSON')
    .addHelpText('after', `
Examples:
  $ chimera monitor
  $ chimera monitor --env prod
  $ chimera monitor --pipeline Chimera-prod-Pipeline
  $ chimera monitor --interval 5
  $ chimera monitor --stack Chimera-dev-Api    # CloudFormation fallback
  $ chimera monitor --json`)
    .action(async (options) => {
      const spinner = ora('Initializing monitor').start();
      if (options.json) spinner.stop();

      // Stop spinner cleanly on Ctrl+C
      process.on('SIGINT', () => {
        if (!options.json) console.log(color.gray('\n\nMonitoring stopped'));
        process.exit(0);
      });

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
        if (wsConfig?.aws?.profile) { process.env.AWS_PROFILE = wsConfig.aws.profile; }

        const pollMs = Math.max(1_000, parseInt(options.interval, 10) * 1_000);

        // --stack: CloudFormation monitoring fallback
        if (options.stack) {
          const cfnClient = new CloudFormationClient({ region });
          if (!options.json) spinner.succeed(color.green(`Monitoring CloudFormation stack: ${options.stack}`));
          if (!options.json) console.log(color.gray(`\nStreaming events every ${pollMs / 1_000}s (Ctrl+C to stop)...\n`));

          const outcome = await monitorStack(cfnClient, options.stack as string, pollMs, options.history ?? false);
          const icon = outcome === 'complete' ? color.green('✓') : outcome === 'not_found' ? color.yellow('?') : color.red('✗');

          if (options.json) {
            console.log(JSON.stringify({ status: 'ok', data: { stack: options.stack, outcome, region } }));
          } else {
            console.log(`\n${icon} Stack ${options.stack}: ${outcome}`);
            if (outcome === 'failed') process.exit(1);
          }
          return;
        }

        // Default: CodePipeline monitoring
        const safeEnv = env.replace(/[^a-zA-Z0-9-]/g, '');
        const pipelineName = (options.pipeline as string | undefined) ?? `Chimera-${safeEnv}-Pipeline`;

        if (!options.json) spinner.succeed(color.green(`Monitoring pipeline: ${pipelineName}`));

        const pipelineClient = new CodePipelineClient({ region });

        const outcome = await monitorPipeline(pipelineClient, pipelineName, pollMs);

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { pipeline: pipelineName, outcome, env, region } }));
        } else {
          if (outcome === 'not_found') {
            console.log(color.yellow(`Pipeline "${pipelineName}" not found.`));
            console.log(color.gray('Run "chimera deploy" first, or use --pipeline to specify a pipeline name.'));
          } else if (outcome === 'succeeded') {
            console.log(color.green(`\n✓ Pipeline execution succeeded`));
          } else {
            console.log(color.red(`\n✗ Pipeline execution failed`));
            console.log(color.gray('Run "chimera status" for stack-level details.'));
            process.exit(1);
          }
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'MONITOR_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Monitor failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });
}
