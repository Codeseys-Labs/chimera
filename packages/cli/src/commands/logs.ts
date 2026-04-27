/**
 * Logs command — one-shot triage for CodePipeline failures.
 *
 * Subcommands:
 *   chimera logs                     default: latest pipeline execution, show failed stage + tail
 *   chimera logs pipeline            equivalent to default; accepts --execution-id
 *   chimera logs build <stage>       CodeBuild logs for a specific pipeline stage action
 *   chimera logs build --failed      auto-pick the currently-failing Build-phase action
 *   chimera logs ecs                 tail chat-gateway container logs (awslogs driver)
 *   chimera logs traces              query aws/spans (Transaction Search) recent spans
 *
 * UX goal: replace the 3-4 raw `aws codebuild / aws logs` calls that an
 * operator would otherwise chain together. Keeps everything in the
 * chimera CLI + workspace-config flow.
 *
 * Follows the same --region --env --json conventions as chimera monitor/status.
 */

import { Command } from 'commander';
import ora from 'ora';
import { CodePipelineClient } from '@aws-sdk/client-codepipeline';
import { CodeBuildClient } from '@aws-sdk/client-codebuild';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';
import {
  buildFailedStageReport,
  describeExecutionStages,
  getBuildLogLocation,
  tailLogStream,
  filterLogGroup,
  type FailedStageReport,
  type LogLine,
} from '../utils/pipeline-logs.js';

function formatTimestamp(ms?: number): string {
  if (!ms) return '';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function statusColor(status: string): string {
  if (status === 'Succeeded') return color.green(status);
  if (status === 'Failed') return color.red(status);
  if (status === 'InProgress') return color.yellow(status);
  return color.gray(status);
}

function printTail(tail: LogLine[] | undefined): void {
  if (!tail || tail.length === 0) {
    console.log(color.gray('  (no log events returned)'));
    return;
  }
  for (const line of tail) {
    const ts = formatTimestamp(line.timestamp);
    console.log(color.gray(`  [${ts}]`) + ' ' + line.message);
  }
}

function printReport(report: FailedStageReport, tailLines: number): void {
  console.log('');
  console.log(`  Pipeline:  ${color.cyan(report.pipelineName)}`);
  console.log(`  Execution: ${color.cyan(report.executionId)} ${statusColor(report.executionStatus)}`);
  console.log('');
  for (const s of report.stages) {
    const mark =
      s.status === 'Succeeded'
        ? color.green('✓')
        : s.status === 'Failed'
          ? color.red('✗')
          : s.status === 'InProgress'
            ? color.yellow('⋯')
            : color.gray('○');
    console.log(`  ${mark} ${(s.stageName + '/' + s.actionName).padEnd(36)} ${statusColor(s.status)}`);
    if (s.status === 'Failed' && s.errorMessage) {
      console.log('    ' + color.red(s.errorMessage));
    }
  }

  if (!report.failedAction) {
    console.log('');
    console.log(color.green('  No failed actions in this execution.'));
    return;
  }

  console.log('');
  console.log(
    color.red(
      `  ✗ ${report.failedAction.stageName}/${report.failedAction.actionName} failed`,
    ),
  );
  if (report.buildLocation?.projectName) {
    console.log(`    Build project: ${report.buildLocation.projectName}`);
    console.log(`    Build ID:      ${report.buildLocation.buildId}`);
  }
  if (report.logGroup) {
    console.log(`    Log group:     ${report.logGroup}`);
    console.log(`    Log stream:    ${report.logStream}`);
  }
  if (report.buildLocation?.phaseContext?.length) {
    console.log('');
    console.log(color.red('  Phase context:'));
    for (const ctx of report.buildLocation.phaseContext) {
      console.log('    ' + ctx);
    }
  }
  console.log('');
  console.log(color.bold(`  Last ${report.tail?.length ?? 0} log lines:`));
  printTail(report.tail);
  console.log('');
  console.log(
    color.gray(
      `  Tip: chimera logs build ${report.failedAction.actionName} --tail ${tailLines * 4}  for more context`,
    ),
  );
}

export const logsCommand = new Command('logs')
  .description('Inspect CodePipeline / CodeBuild / ECS logs without leaving the CLI')
  .option('--region <region>', 'AWS region')
  .option('--env <environment>', 'Environment name')
  .option('--pipeline <name>', 'Pipeline name (default: chimera-deploy-{env})')
  .option('--execution-id <id>', 'Specific pipeline execution (default: latest)')
  .option('--tail <n>', 'Log lines to show for failed stage', '50')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    await runPipelineLogs(opts);
  });

async function runPipelineLogs(opts: {
  region?: string;
  env?: string;
  pipeline?: string;
  executionId?: string;
  tail?: string;
  json?: boolean;
}): Promise<void> {
  const ws = loadWorkspaceConfig();
  const region = opts.region ?? ws?.aws?.region;
  const envName = opts.env ?? ws?.workspace?.environment ?? 'dev';
  if (!region) {
    const msg = 'No AWS region configured. Run "chimera init" to set up your workspace.';
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_REGION' }));
    } else {
      console.log(color.red(msg));
    }
    process.exit(1);
  }
  if (ws?.aws?.profile) process.env.AWS_PROFILE = ws.aws.profile;
  const pipelineName = opts.pipeline ?? `chimera-deploy-${envName}`;
  const tailLines = Math.max(1, parseInt(opts.tail ?? '50', 10) || 50);

  const spinner = opts.json ? null : ora('Fetching pipeline execution').start();
  try {
    const cp = new CodePipelineClient({ region });
    const cb = new CodeBuildClient({ region });
    const cwl = new CloudWatchLogsClient({ region });
    const report = await buildFailedStageReport(
      cp,
      cb,
      cwl,
      pipelineName,
      opts.executionId,
      tailLines,
    );
    spinner?.succeed('Fetched pipeline execution');

    if (opts.json) {
      console.log(JSON.stringify({ status: 'ok', data: report }));
      return;
    }
    printReport(report, tailLines);
  } catch (err: any) {
    spinner?.fail(err?.message ?? String(err));
    if (opts.json) {
      console.log(
        JSON.stringify({
          status: 'error',
          error: err?.message ?? String(err),
          code: err?.name ?? 'LOGS_FAILED',
        }),
      );
    }
    process.exit(1);
  }
}

// `chimera logs build <stage>` subcommand
logsCommand
  .command('build [stage]')
  .description('Fetch CodeBuild logs for a named pipeline stage action')
  .option('--failed', 'Auto-pick the currently-failing Build-phase action')
  .option('--tail <n>', 'Log lines to show', '200')
  .option('--region <region>', 'AWS region')
  .option('--env <environment>', 'Environment name')
  .option('--pipeline <name>', 'Pipeline name (default: chimera-deploy-{env})')
  .option('--execution-id <id>', 'Specific pipeline execution (default: latest)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (stageArg: string | undefined, opts) => {
    await runBuildLogs(stageArg, opts);
  });

async function runBuildLogs(
  stageArg: string | undefined,
  opts: {
    failed?: boolean;
    tail?: string;
    region?: string;
    env?: string;
    pipeline?: string;
    executionId?: string;
    json?: boolean;
  },
): Promise<void> {
  if (!stageArg && !opts.failed) {
    console.log(
      color.red(
        'Specify a stage/action name (e.g. Build_Package) or pass --failed to auto-pick the failing one.',
      ),
    );
    process.exit(1);
  }

  const ws = loadWorkspaceConfig();
  const region = opts.region ?? ws?.aws?.region;
  const envName = opts.env ?? ws?.workspace?.environment ?? 'dev';
  if (!region) {
    const msg = 'No AWS region configured. Run "chimera init" to set up your workspace.';
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_REGION' }));
    } else {
      console.log(color.red(msg));
    }
    process.exit(1);
  }
  if (ws?.aws?.profile) process.env.AWS_PROFILE = ws.aws.profile;
  const pipelineName = opts.pipeline ?? `chimera-deploy-${envName}`;
  const tailLines = Math.max(1, parseInt(opts.tail ?? '200', 10) || 200);
  const spinner = opts.json ? null : ora('Resolving build location').start();

  try {
    const cp = new CodePipelineClient({ region });
    const cb = new CodeBuildClient({ region });
    const cwl = new CloudWatchLogsClient({ region });

    let executionId = opts.executionId;
    if (!executionId) {
      const latest = (
        await cp.send(
          new (
            await import('@aws-sdk/client-codepipeline')
          ).ListPipelineExecutionsCommand({ pipelineName, maxResults: 1 }),
        )
      ).pipelineExecutionSummaries?.[0];
      executionId = latest?.pipelineExecutionId;
    }
    if (!executionId) throw new Error('No pipeline executions found');

    const { stages, failedAction } = await describeExecutionStages(
      cp,
      pipelineName,
      executionId,
    );
    const target = opts.failed
      ? failedAction
      : stages.find((s) => s.actionName === stageArg || s.stageName === stageArg);
    if (!target) {
      throw new Error(
        opts.failed
          ? 'No failed action in this execution'
          : `No action matches "${stageArg}" in pipeline ${pipelineName}`,
      );
    }
    if (!target.externalExecutionId) {
      throw new Error(`Action ${target.actionName} has no CodeBuild build id`);
    }
    const loc = await getBuildLogLocation(cb, target.externalExecutionId);
    if (!loc.logGroupName || !loc.logStreamName) {
      throw new Error(`Build ${loc.buildId} has no CloudWatch Logs location`);
    }
    const tail = await tailLogStream(cwl, loc.logGroupName, loc.logStreamName, tailLines);
    spinner?.succeed(`Fetched ${tail.length} log lines`);

    if (opts.json) {
      console.log(
        JSON.stringify({
          status: 'ok',
          data: { stage: target.stageName, action: target.actionName, build: loc, tail },
        }),
      );
      return;
    }
    console.log('');
    console.log(`  ${color.bold(target.stageName + '/' + target.actionName)} — ${loc.buildId}`);
    console.log(`  ${color.gray(loc.logGroupName + ':' + loc.logStreamName)}`);
    console.log('');
    printTail(tail);
  } catch (err: any) {
    spinner?.fail(err?.message ?? String(err));
    if (opts.json) {
      console.log(
        JSON.stringify({
          status: 'error',
          error: err?.message ?? String(err),
          code: err?.name ?? 'LOGS_BUILD_FAILED',
        }),
      );
    }
    process.exit(1);
  }
}

// `chimera logs ecs` subcommand
logsCommand
  .command('ecs')
  .description('Tail the chat-gateway ECS container logs')
  .option('--since <minutes>', 'Lookback window in minutes', '10')
  .option('--limit <n>', 'Max log lines', '200')
  .option('--log-group <name>', 'Log group (default: /chimera/{env}/ecs/chat-gateway)')
  .option('--region <region>', 'AWS region')
  .option('--env <environment>', 'Environment name')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    const ws = loadWorkspaceConfig();
    const region = opts.region ?? ws?.aws?.region;
    const envName = opts.env ?? ws?.workspace?.environment ?? 'dev';
    if (!region) {
      const msg = 'No AWS region configured.';
      if (opts.json) {
        console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_REGION' }));
      } else {
        console.log(color.red(msg));
      }
      process.exit(1);
    }
    if (ws?.aws?.profile) process.env.AWS_PROFILE = ws.aws.profile;
    const since = Math.max(1, parseInt(opts.since ?? '10', 10) || 10) * 60 * 1000;
    const limit = Math.max(1, parseInt(opts.limit ?? '200', 10) || 200);
    const logGroup = opts.logGroup ?? `/chimera/${envName}/ecs/chat-gateway`;
    const spinner = opts.json ? null : ora(`Tailing ${logGroup}`).start();
    try {
      const cwl = new CloudWatchLogsClient({ region });
      const events = await filterLogGroup(cwl, logGroup, since, limit);
      spinner?.succeed(`Fetched ${events.length} events`);
      if (opts.json) {
        console.log(JSON.stringify({ status: 'ok', data: { logGroup, events } }));
        return;
      }
      console.log('');
      console.log(`  ${color.bold(logGroup)} (last ${Math.round(since / 60000)} min)`);
      console.log('');
      printTail(events);
    } catch (err: any) {
      spinner?.fail(err?.message ?? String(err));
      if (opts.json) {
        console.log(
          JSON.stringify({
            status: 'error',
            error: err?.message ?? String(err),
            code: err?.name ?? 'LOGS_ECS_FAILED',
          }),
        );
      }
      process.exit(1);
    }
  });

// `chimera logs traces` subcommand — Transaction Search (aws/spans)
logsCommand
  .command('traces')
  .description('Query CloudWatch Transaction Search (aws/spans) for recent spans')
  .option('--service <name>', 'Filter by service.name (e.g. chimera-chat-gateway)')
  .option('--since <minutes>', 'Lookback window in minutes', '15')
  .option('--limit <n>', 'Max events', '50')
  .option('--region <region>', 'AWS region')
  .option('--env <environment>', 'Environment name')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    const ws = loadWorkspaceConfig();
    const region = opts.region ?? ws?.aws?.region;
    if (!region) {
      const msg = 'No AWS region configured.';
      if (opts.json) {
        console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_REGION' }));
      } else {
        console.log(color.red(msg));
      }
      process.exit(1);
    }
    if (ws?.aws?.profile) process.env.AWS_PROFILE = ws.aws.profile;
    const since = Math.max(1, parseInt(opts.since ?? '15', 10) || 15) * 60 * 1000;
    const limit = Math.max(1, parseInt(opts.limit ?? '50', 10) || 50);
    const spinner = opts.json ? null : ora('Querying aws/spans').start();
    try {
      const cwl = new CloudWatchLogsClient({ region });
      const all = await filterLogGroup(cwl, 'aws/spans', since, limit);
      const filtered = opts.service
        ? all.filter((e) => e.message.includes(`"service.name":"${opts.service}"`))
        : all;
      spinner?.succeed(`Fetched ${filtered.length} spans`);
      if (opts.json) {
        console.log(JSON.stringify({ status: 'ok', data: { logGroup: 'aws/spans', events: filtered } }));
        return;
      }
      console.log('');
      console.log(
        `  ${color.bold('aws/spans')} (last ${Math.round(since / 60000)} min${opts.service ? ', service=' + opts.service : ''})`,
      );
      console.log('');
      printTail(filtered);
    } catch (err: any) {
      spinner?.fail(err?.message ?? String(err));
      if (opts.json) {
        console.log(
          JSON.stringify({
            status: 'error',
            error: err?.message ?? String(err),
            code: err?.name ?? 'LOGS_TRACES_FAILED',
          }),
        );
      }
      process.exit(1);
    }
  });

export default logsCommand;
