/**
 * pipeline-logs.ts — AWS SDK glue for the `chimera logs` command.
 *
 * Chains the three AWS APIs the operator previously stitched together by hand:
 *
 *   1. CodePipeline  ListActionExecutions  — locate the failing stage/action
 *                                             and harvest its externalExecutionId
 *                                             (which is the CodeBuild build ID).
 *   2. CodeBuild     BatchGetBuilds        — resolve the build ID into
 *                                             { logGroupName, logStreamName }.
 *   3. CloudWatchLogs GetLogEvents         — fetch the actual log tail.
 *
 * Kept as pure async functions (no commander, no stdout) so they're trivial
 * to unit-test and to reuse from other commands.
 */
import {
  CodePipelineClient,
  ListActionExecutionsCommand,
  ListPipelineExecutionsCommand,
  type ActionExecutionDetail,
} from '@aws-sdk/client-codepipeline';
import {
  CodeBuildClient,
  BatchGetBuildsCommand,
} from '@aws-sdk/client-codebuild';
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  FilterLogEventsCommand,
  type OutputLogEvent,
  type FilteredLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';

export interface StageSummary {
  stageName: string;
  actionName: string;
  status: string;
  externalExecutionId?: string;
  errorMessage?: string;
  startTime?: string;
  lastUpdateTime?: string;
}

export interface BuildLogLocation {
  buildId: string;
  projectName?: string;
  logGroupName?: string;
  logStreamName?: string;
  buildStatus?: string;
  phaseContext?: string[];
}

export interface LogLine {
  timestamp?: number;
  message: string;
}

export interface FailedStageReport {
  pipelineName: string;
  executionId: string;
  executionStatus: string;
  stages: StageSummary[];
  /** First failed action in pipeline order, if any. */
  failedAction?: StageSummary;
  buildLocation?: BuildLogLocation;
  tail?: LogLine[];
  logGroup?: string;
  logStream?: string;
}

/**
 * Look up the most recent pipeline execution (regardless of outcome).
 * Returns undefined when the pipeline exists but has never run.
 */
export async function getLatestExecutionId(
  client: CodePipelineClient,
  pipelineName: string,
): Promise<{ id: string; status: string } | undefined> {
  const resp = await client.send(
    new ListPipelineExecutionsCommand({ pipelineName, maxResults: 1 }),
  );
  const summary = resp.pipelineExecutionSummaries?.[0];
  if (!summary?.pipelineExecutionId) return undefined;
  return { id: summary.pipelineExecutionId, status: summary.status ?? 'Unknown' };
}

/**
 * Collapse the list-action-executions response into one record per action,
 * keeping only the newest attempt per (stage, action) pair. Sorted in
 * pipeline order when possible (startTime ascending).
 */
function collapseActions(details: ActionExecutionDetail[]): StageSummary[] {
  // Group by stage+action, keep newest by lastUpdateTime.
  const byKey = new Map<string, ActionExecutionDetail>();
  for (const d of details) {
    const key = `${d.stageName ?? ''}::${d.actionName ?? ''}`;
    const prev = byKey.get(key);
    const cur = d.lastUpdateTime?.getTime() ?? 0;
    const prevT = prev?.lastUpdateTime?.getTime() ?? -1;
    if (cur >= prevT) byKey.set(key, d);
  }
  const rows: StageSummary[] = [];
  for (const d of Array.from(byKey.values())) {
    rows.push({
      stageName: d.stageName ?? '',
      actionName: d.actionName ?? '',
      status: d.status ?? 'Unknown',
      externalExecutionId: d.output?.executionResult?.externalExecutionId,
      errorMessage: d.output?.executionResult?.externalExecutionSummary,
      startTime: d.startTime?.toISOString(),
      lastUpdateTime: d.lastUpdateTime?.toISOString(),
    });
  }
  // Sort by startTime ascending; undefined goes last.
  rows.sort((a, b) => {
    const at = a.startTime ? Date.parse(a.startTime) : Number.MAX_SAFE_INTEGER;
    const bt = b.startTime ? Date.parse(b.startTime) : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });
  return rows;
}

/**
 * Fetch per-stage status for a specific pipeline execution and identify
 * the first failed action (if any).
 */
export async function describeExecutionStages(
  client: CodePipelineClient,
  pipelineName: string,
  executionId: string,
): Promise<{ stages: StageSummary[]; failedAction?: StageSummary }> {
  const resp = await client.send(
    new ListActionExecutionsCommand({
      pipelineName,
      filter: { pipelineExecutionId: executionId },
    }),
  );
  const stages = collapseActions(resp.actionExecutionDetails ?? []);
  const failedAction = stages.find((s) => s.status === 'Failed');
  return { stages, failedAction };
}

/**
 * Resolve a CodeBuild build ID (as stored in externalExecutionId) into a
 * CloudWatch Logs location.
 */
export async function getBuildLogLocation(
  client: CodeBuildClient,
  buildId: string,
): Promise<BuildLogLocation> {
  const resp = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
  const build = resp.builds?.[0];
  return {
    buildId,
    projectName: build?.projectName,
    logGroupName: build?.logs?.groupName,
    logStreamName: build?.logs?.streamName,
    buildStatus: build?.buildStatus,
    phaseContext: (build?.phases ?? [])
      .flatMap((p) => (p.contexts ?? []).map((c) => c.message).filter(Boolean) as string[]),
  };
}

/**
 * Tail the last N events from a CloudWatch log stream. `limit` is capped by
 * GetLogEvents to ~10k lines / 1MB response, whichever is smaller.
 */
export async function tailLogStream(
  client: CloudWatchLogsClient,
  logGroupName: string,
  logStreamName: string,
  limit = 50,
): Promise<LogLine[]> {
  const resp = await client.send(
    new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      limit,
      startFromHead: false,
    }),
  );
  return (resp.events ?? []).map((e: OutputLogEvent) => ({
    timestamp: e.timestamp,
    message: (e.message ?? '').replace(/\r?\n$/, ''),
  }));
}

/**
 * Filter a log group across streams within a time window — used for ECS task
 * logs (awslogs driver writes one stream per task, so scanning the group is
 * cheaper than enumerating streams).
 */
export async function filterLogGroup(
  client: CloudWatchLogsClient,
  logGroupName: string,
  sinceMs: number,
  limit = 200,
): Promise<LogLine[]> {
  const startTime = Date.now() - sinceMs;
  const resp = await client.send(
    new FilterLogEventsCommand({
      logGroupName,
      startTime,
      limit,
    }),
  );
  return (resp.events ?? []).map((e: FilteredLogEvent) => ({
    timestamp: e.timestamp,
    message: (e.message ?? '').replace(/\r?\n$/, ''),
  }));
}

/**
 * High-level orchestrator: given a pipeline name (and optionally a specific
 * executionId), return a full failure report — stages, the failing action,
 * resolved build location, and a log tail.
 *
 * When the execution did not fail, `failedAction` / `buildLocation` / `tail`
 * are left undefined and the caller prints "no recent failures".
 */
export async function buildFailedStageReport(
  codepipeline: CodePipelineClient,
  codebuild: CodeBuildClient,
  logs: CloudWatchLogsClient,
  pipelineName: string,
  executionId?: string,
  tailLines = 50,
): Promise<FailedStageReport> {
  let execId = executionId;
  let execStatus = 'Unknown';
  if (!execId) {
    const latest = await getLatestExecutionId(codepipeline, pipelineName);
    if (!latest) {
      return {
        pipelineName,
        executionId: '',
        executionStatus: 'NoExecutions',
        stages: [],
      };
    }
    execId = latest.id;
    execStatus = latest.status;
  }

  const { stages, failedAction } = await describeExecutionStages(
    codepipeline,
    pipelineName,
    execId,
  );

  // If caller passed an explicit executionId we didn't get its status above.
  // Derive a status from the stages if we still don't have one.
  if (execStatus === 'Unknown') {
    if (stages.some((s) => s.status === 'Failed')) execStatus = 'Failed';
    else if (stages.every((s) => s.status === 'Succeeded')) execStatus = 'Succeeded';
    else if (stages.some((s) => s.status === 'InProgress')) execStatus = 'InProgress';
  }

  const report: FailedStageReport = {
    pipelineName,
    executionId: execId,
    executionStatus: execStatus,
    stages,
    failedAction,
  };

  if (!failedAction?.externalExecutionId) return report;

  try {
    const buildLoc = await getBuildLogLocation(codebuild, failedAction.externalExecutionId);
    report.buildLocation = buildLoc;
    report.logGroup = buildLoc.logGroupName;
    report.logStream = buildLoc.logStreamName;
    if (buildLoc.logGroupName && buildLoc.logStreamName) {
      report.tail = await tailLogStream(
        logs,
        buildLoc.logGroupName,
        buildLoc.logStreamName,
        tailLines,
      );
    }
  } catch {
    // Best-effort: if BatchGetBuilds / GetLogEvents fail (e.g. the action
    // provider isn't CodeBuild), we still return the stage report so the
    // caller can print what it has.
  }

  return report;
}
