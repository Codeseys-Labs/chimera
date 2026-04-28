/**
 * tail-pipeline command — multiplexed CloudWatch log tail across every
 * active stage of a CodePipeline execution.
 *
 * Replaces the "open five CloudWatch tabs" habit: while the pipeline is
 * running, every InProgress stage's log group is polled via
 * FilterLogEvents and printed to stdout with a stage-prefixed,
 * color-coded label. The loop exits when the execution reaches a
 * terminal state (Succeeded / Failed / Stopped / Superseded).
 *
 * Usage:
 *   chimera tail-pipeline
 *   chimera tail-pipeline --execution <id>
 *   chimera tail-pipeline --env prod
 *   chimera tail-pipeline --interval 3
 *   chimera tail-pipeline --json
 *
 * Follows the same --region / --env / --json / SIGINT conventions as
 * `chimera monitor`. Reuses filterLogGroup() from utils/pipeline-logs.ts —
 * does NOT re-implement the CloudWatch Logs glue.
 */

import { Command } from 'commander';
import {
  CodePipelineClient,
  GetPipelineStateCommand,
  ListPipelineExecutionsCommand,
  type StageState,
} from '@aws-sdk/client-codepipeline';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';
import { filterLogGroup, type LogLine } from '../utils/pipeline-logs.js';

const PIPELINE_TERMINAL = new Set(['Succeeded', 'Failed', 'Stopped', 'Superseded']);

// Stage-to-log-group map. Matches the deterministic naming used by the
// Chimera CodePipeline: stage names we know how to tail. Other stage types
// — Source (CodeCommit), Approval (Manual), and any CDK-renamed future stage
// — don't have tailable CodeBuild/StepFn log groups. See KNOWN_UNTAILABLE
// below for ones we intentionally skip silently; anything else triggers a
// one-time "can't tail this stage" warning so operators notice drift.
const KNOWN_UNTAILABLE = new Set(['Source', 'Approval']);

function logGroupForStage(stageName: string, env: string): string | undefined {
  const map: Record<string, string> = {
    Build_Package: `/aws/codebuild/chimera-build-${env}`,
    Docker_Build: `/aws/codebuild/chimera-docker-build-${env}`,
    Cdk_Deploy: `/aws/codebuild/chimera-deploy-${env}`,
    Test: `/aws/codebuild/chimera-test-${env}`,
    Canary: `/aws/states/chimera-canary-orchestration-${env}`,
  };
  return map[stageName];
}

// Five distinct colors, cycled by stage insertion order so the same
// stage always renders in the same color within a single run.
const STAGE_COLORS: Array<(s: string) => string> = [
  color.cyan,
  color.green,
  color.yellow,
  color.blue,
  color.red,
];

interface StageStream {
  stageName: string;
  logGroup: string;
  colorFn: (s: string) => string;
  lastSeenTs: number;
}

function labelFor(stage: StageStream, pad: number): string {
  return stage.colorFn(`[${stage.stageName.padEnd(pad)}]`);
}

function printEvent(
  stage: StageStream,
  ev: LogLine,
  pad: number,
  json: boolean,
  actionName?: string,
): void {
  if (json) {
    process.stdout.write(
      JSON.stringify({
        stage: stage.stageName,
        actionName: actionName ?? null,
        timestamp: ev.timestamp ?? null,
        message: ev.message,
      }) + '\n',
    );
    return;
  }
  // Split multi-line payloads so the prefix is applied per visible line.
  for (const line of ev.message.split(/\r?\n/)) {
    if (line.length === 0) continue;
    process.stdout.write(`${labelFor(stage, pad)} ${line}\n`);
  }
}

/**
 * Resolve the execution we should tail:
 *   - explicit --execution id → use it verbatim
 *   - otherwise → the latest execution (preferring InProgress, else newest)
 */
async function resolveExecutionId(
  client: CodePipelineClient,
  pipelineName: string,
  explicitId: string | undefined,
): Promise<{ id: string; status: string } | undefined> {
  if (explicitId) {
    return { id: explicitId, status: 'Unknown' };
  }
  const resp = await client.send(
    new ListPipelineExecutionsCommand({ pipelineName, maxResults: 5 }),
  );
  const summaries = resp.pipelineExecutionSummaries ?? [];
  const inProgress = summaries.find((s) => s.status === 'InProgress');
  const chosen = inProgress ?? summaries[0];
  if (!chosen?.pipelineExecutionId) return undefined;
  return { id: chosen.pipelineExecutionId, status: chosen.status ?? 'Unknown' };
}

function activeStageNames(stageStates: StageState[], executionId: string): string[] {
  const active: string[] = [];
  for (const s of stageStates) {
    const exec = s.latestExecution;
    if (!exec?.pipelineExecutionId || exec.pipelineExecutionId !== executionId) continue;
    if (exec.status === 'InProgress') active.push(s.stageName ?? '');
  }
  return active.filter(Boolean);
}

function computeExecutionStatus(
  stageStates: StageState[],
  executionId: string,
): string {
  let status = 'InProgress';
  let hasFailed = false;
  let allSucceeded = true;
  let sawExecution = false;
  for (const s of stageStates) {
    const exec = s.latestExecution;
    if (!exec?.pipelineExecutionId || exec.pipelineExecutionId !== executionId) continue;
    sawExecution = true;
    if (exec.status === 'Failed') hasFailed = true;
    if (exec.status !== 'Succeeded') allSucceeded = false;
    if (exec.status === 'InProgress') return 'InProgress';
  }
  if (!sawExecution) return 'Unknown';
  if (hasFailed) status = 'Failed';
  else if (allSucceeded) status = 'Succeeded';
  return status;
}

/**
 * The tail loop. Polls CodePipeline every `pollMs`; for each active stage
 * with a known log group, calls filterLogGroup() since the last-seen
 * timestamp and prints new events with the stage prefix.
 */
async function tailLoop(
  pipelineClient: CodePipelineClient,
  logsClient: CloudWatchLogsClient,
  pipelineName: string,
  executionId: string,
  env: string,
  pollMs: number,
  json: boolean,
): Promise<'succeeded' | 'failed' | 'stopped'> {
  const streams = new Map<string, StageStream>();
  const unmappedWarned = new Set<string>(); // one warning per unknown stage
  const startMs = Date.now() - 60_000; // back-fill 60s of context on first poll
  let colorIdx = 0;

  while (true) {
    const stateResp = await pipelineClient.send(
      new GetPipelineStateCommand({ name: pipelineName }),
    );
    const stageStates = stateResp.stageStates ?? [];
    const execStatus = computeExecutionStatus(stageStates, executionId);

    const active = activeStageNames(stageStates, executionId);
    for (const name of active) {
      if (streams.has(name)) continue;
      const group = logGroupForStage(name, env);
      if (!group) {
        // Warn once per unexpected stage so operators notice CDK stage-naming
        // drift (but stay quiet for intentionally-untailable stages like Source).
        if (!KNOWN_UNTAILABLE.has(name) && !unmappedWarned.has(name)) {
          unmappedWarned.add(name);
          if (!json) {
            process.stdout.write(
              color.yellow(
                `[tail] stage "${name}" is InProgress but has no mapped log group — ` +
                  `may indicate CDK drift. Skipping tail for this stage.\n`,
              ),
            );
          }
        }
        continue;
      }
      streams.set(name, {
        stageName: name,
        logGroup: group,
        colorFn: STAGE_COLORS[colorIdx % STAGE_COLORS.length]!,
        lastSeenTs: startMs,
      });
      colorIdx++;
      if (!json) {
        process.stdout.write(
          color.gray(`[tail] attached to stage "${name}" → ${group}\n`),
        );
      }
    }

    const pad = Math.max(
      14,
      ...Array.from(streams.values()).map((s) => s.stageName.length),
    );

    // Poll each attached stream in parallel.
    await Promise.all(
      Array.from(streams.values()).map(async (stream) => {
        const sinceMs = Math.max(1, Date.now() - stream.lastSeenTs);
        try {
          const events = await filterLogGroup(logsClient, stream.logGroup, sinceMs, 500);
          for (const ev of events) {
            if (ev.timestamp && ev.timestamp <= stream.lastSeenTs) continue;
            printEvent(stream, ev, pad, json);
            if (ev.timestamp && ev.timestamp > stream.lastSeenTs) {
              stream.lastSeenTs = ev.timestamp;
            }
          }
        } catch (err: any) {
          // A log group may not exist until the stage first runs. Suppress
          // ResourceNotFoundException so we don't spam stderr until the
          // stage actually starts writing.
          const name = err?.name ?? '';
          if (name !== 'ResourceNotFoundException' && !json) {
            process.stderr.write(
              color.gray(
                `[tail] ${stream.stageName}: ${name || 'error'}: ${err?.message ?? err}\n`,
              ),
            );
          }
        }
      }),
    );

    if (PIPELINE_TERMINAL.has(execStatus)) {
      if (execStatus === 'Succeeded') return 'succeeded';
      if (execStatus === 'Failed') return 'failed';
      return 'stopped';
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

export function registerTailPipelineCommand(program: Command): void {
  program
    .command('tail-pipeline')
    .description('Multiplex-tail CloudWatch logs for every active CodePipeline stage')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--pipeline <name>', 'Pipeline name (default: chimera-deploy-{env})')
    .option('--execution <id>', 'Tail a specific pipeline execution (default: latest)')
    .option('--interval <seconds>', 'Polling interval in seconds (default: 5)', '5')
    .option('--json', 'Emit newline-delimited JSON events')
    .addHelpText(
      'after',
      `
Examples:
  $ chimera tail-pipeline
  $ chimera tail-pipeline --env prod
  $ chimera tail-pipeline --execution 1234abcd-5678-...
  $ chimera tail-pipeline --interval 3
  $ chimera tail-pipeline --json | jq`,
    )
    .action(async (options) => {
      process.on('SIGINT', () => {
        if (!options.json) process.stdout.write(color.gray('\n[tail] interrupted\n'));
        process.exit(0);
      });

      try {
        const wsConfig = loadWorkspaceConfig();
        const region = options.region ?? wsConfig?.aws?.region;
        if (!region) {
          const msg = 'No AWS region configured. Run "chimera init" to set up your workspace.';
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_REGION' }));
          } else {
            console.error(color.red(msg));
          }
          process.exit(1);
        }
        const env = options.env ?? wsConfig?.workspace?.environment ?? 'dev';
        if (wsConfig?.aws?.profile) process.env.AWS_PROFILE = wsConfig.aws.profile;

        const safeEnv = env.replace(/[^a-zA-Z0-9-]/g, '');
        const pipelineName = (options.pipeline as string | undefined) ?? `chimera-deploy-${safeEnv}`;
        const pollMs = Math.max(1_000, parseInt(options.interval, 10) * 1_000);

        const pipelineClient = new CodePipelineClient({ region });
        const logsClient = new CloudWatchLogsClient({ region });

        const exec = await resolveExecutionId(
          pipelineClient,
          pipelineName,
          options.execution as string | undefined,
        );
        if (!exec) {
          const msg = `No pipeline executions found for "${pipelineName}".`;
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_EXECUTION' }));
          } else {
            console.error(color.yellow(msg));
          }
          process.exit(1);
        }

        if (!options.json) {
          process.stdout.write(
            color.gray(
              `[tail] pipeline=${pipelineName} execution=${exec.id.slice(0, 8)}... env=${safeEnv}\n`,
            ),
          );
          process.stdout.write(color.gray('[tail] Ctrl+C to stop (pipeline continues)\n\n'));
        }

        const outcome = await tailLoop(
          pipelineClient,
          logsClient,
          pipelineName,
          exec.id,
          safeEnv,
          pollMs,
          !!options.json,
        );

        if (options.json) {
          console.log(
            JSON.stringify({
              status: 'ok',
              data: { pipeline: pipelineName, execution: exec.id, outcome, env: safeEnv, region },
            }),
          );
        } else if (outcome === 'succeeded') {
          process.stdout.write(color.green('\n[tail] pipeline execution succeeded\n'));
        } else if (outcome === 'failed') {
          process.stdout.write(color.red('\n[tail] pipeline execution failed\n'));
          process.exit(1);
        } else {
          process.stdout.write(color.gray('\n[tail] pipeline execution stopped\n'));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(
            JSON.stringify({ status: 'error', error: error?.message ?? String(error), code: 'TAIL_FAILED' }),
          );
        } else {
          console.error(color.red('tail-pipeline failed:'), error?.message ?? error);
        }
        process.exit(1);
      }
    });
}

// Exported for unit tests — lets tests assert parse behavior without spawning aws SDK.
export const __testing = {
  logGroupForStage,
  computeExecutionStatus,
  activeStageNames,
};
