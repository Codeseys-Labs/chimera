/**
 * ECS command — inspect chat-gateway ECS service without leaving the CLI.
 *
 * Replaces the `aws ecs describe-services / describe-tasks / describe-task-definition`
 * chain that operators otherwise have to type by hand.
 *
 * Subcommands:
 *   chimera ecs status [--service <name>]           deployment rolloutState, running/desired, task-def
 *   chimera ecs describe <service>                  image, env vars (filtered), IAM role, log group
 *   chimera ecs tasks [--service <name>]            running task ARNs + their task-def version
 *   chimera ecs task-def <service> [--revision <n>] show task definition (latest or specific revision)
 *
 * Follows the same --region / --env / --json conventions as chimera monitor.
 */

import { Command } from 'commander';
import ora from 'ora';
import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
  ListTasksCommand,
  type Service,
  type Deployment,
  type Task,
  type TaskDefinition,
} from '@aws-sdk/client-ecs';
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';

// Secrets filter: hide anything that looks like a credential when printing env vars.
// Anchored to word-boundary (^, _, -) on both sides so we redact AUTH_TOKEN,
// DB_PASSWORD, API_KEY, PRIVATE_KEY — but NOT SESSION_TOKEN_TTL,
// USE_PRIVATE_SUBNETS, CREDENTIAL_EXPIRY_SECONDS, which operators need
// to read when diagnosing misconfigurations.
const SECRET_NAME_RX =
  /(?:^|[_-])(secret|token|password|api[_-]?key|credential|private)(?:[_-]|$)/i;

interface EcsContext {
  region: string;
  env: string;
  cluster: string;
  service: string;
}

function resolveContext(opts: {
  region?: string;
  env?: string;
  cluster?: string;
  service?: string;
  json?: boolean;
}): EcsContext {
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
  const safeEnv = envName.replace(/[^a-zA-Z0-9-]/g, '');
  return {
    region,
    env: safeEnv,
    cluster: opts.cluster ?? `chimera-chat-${safeEnv}`,
    service: opts.service ?? `chimera-chat-gateway-${safeEnv}`,
  };
}

function formatRolloutState(state?: string): string {
  if (state === 'COMPLETED') return color.green(state);
  if (state === 'IN_PROGRESS') return color.yellow(state);
  if (state === 'FAILED') return color.red(state);
  return color.gray(state ?? 'UNKNOWN');
}

function taskDefVersion(taskDefArn?: string): string {
  if (!taskDefArn) return '?';
  // arn:...:task-definition/name:revision
  const m = taskDefArn.match(/:task-definition\/[^:]+:(\d+)$/);
  return m?.[1] ?? taskDefArn;
}

function filterEnv(envs: Array<{ name?: string; value?: string }> | undefined): Array<{ name: string; value: string }> {
  if (!envs) return [];
  return envs
    .filter(e => e.name)
    .map(e => ({
      name: e.name as string,
      value: SECRET_NAME_RX.test(e.name as string) ? '<redacted>' : (e.value ?? ''),
    }));
}

// ─── status ──────────────────────────────────────────────────────────────────

async function runStatus(opts: { region?: string; env?: string; cluster?: string; service?: string; json?: boolean }): Promise<void> {
  const ctx = resolveContext(opts);
  const spinner = opts.json ? null : ora(`Describing ${ctx.service}`).start();
  try {
    const client = new ECSClient({ region: ctx.region });
    const resp = await client.send(new DescribeServicesCommand({ cluster: ctx.cluster, services: [ctx.service] }));
    const svc: Service | undefined = resp.services?.[0];
    if (!svc) throw new Error(`Service ${ctx.service} not found in cluster ${ctx.cluster}`);

    const primary: Deployment | undefined = svc.deployments?.find(d => d.status === 'PRIMARY');
    const data = {
      cluster: ctx.cluster,
      service: ctx.service,
      status: svc.status,
      desiredCount: svc.desiredCount,
      runningCount: svc.runningCount,
      pendingCount: svc.pendingCount,
      taskDefinition: svc.taskDefinition,
      taskDefRevision: taskDefVersion(svc.taskDefinition),
      rolloutState: primary?.rolloutState,
      rolloutStateReason: primary?.rolloutStateReason,
      deploymentId: primary?.id,
      deploymentStatus: primary?.status,
    };
    spinner?.succeed(`Fetched ${ctx.service}`);

    if (opts.json) {
      console.log(JSON.stringify({ status: 'ok', data }));
      return;
    }
    console.log('');
    console.log(`  Cluster:      ${color.cyan(ctx.cluster)}`);
    console.log(`  Service:      ${color.cyan(ctx.service)} ${color.gray('(' + (svc.status ?? '?') + ')')}`);
    console.log(`  Task def:     ${color.cyan('rev ' + data.taskDefRevision)}`);
    console.log(`  Desired:      ${svc.desiredCount ?? 0}   Running: ${svc.runningCount ?? 0}   Pending: ${svc.pendingCount ?? 0}`);
    console.log(`  Rollout:      ${formatRolloutState(primary?.rolloutState)}`);
    if (primary?.rolloutStateReason) console.log(color.gray(`    ${primary.rolloutStateReason}`));
    console.log('');
  } catch (err: any) {
    spinner?.fail(err?.message ?? String(err));
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', error: err?.message ?? String(err), code: err?.name ?? 'ECS_STATUS_FAILED' }));
    }
    process.exit(1);
  }
}

// ─── describe ────────────────────────────────────────────────────────────────

async function runDescribe(serviceArg: string | undefined, opts: { region?: string; env?: string; cluster?: string; json?: boolean }): Promise<void> {
  const ctx = resolveContext({ ...opts, service: serviceArg });
  const spinner = opts.json ? null : ora(`Describing ${ctx.service}`).start();
  try {
    const client = new ECSClient({ region: ctx.region });
    const svcResp = await client.send(new DescribeServicesCommand({ cluster: ctx.cluster, services: [ctx.service] }));
    const svc = svcResp.services?.[0];
    if (!svc?.taskDefinition) throw new Error(`Service ${ctx.service} not found or has no task definition`);
    const tdResp = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: svc.taskDefinition }));
    const td: TaskDefinition | undefined = tdResp.taskDefinition;
    const container = td?.containerDefinitions?.[0];
    const logGroup = container?.logConfiguration?.options?.['awslogs-group'];
    const data = {
      cluster: ctx.cluster,
      service: ctx.service,
      taskDefinitionArn: td?.taskDefinitionArn,
      revision: td?.revision,
      containerName: container?.name,
      image: container?.image,
      environment: filterEnv(container?.environment),
      secrets: container?.secrets?.map(s => ({ name: s.name, valueFrom: s.valueFrom })) ?? [],
      taskRoleArn: td?.taskRoleArn,
      executionRoleArn: td?.executionRoleArn,
      logGroup,
      cpu: td?.cpu,
      memory: td?.memory,
    };
    spinner?.succeed(`Fetched ${ctx.service} (rev ${td?.revision})`);

    if (opts.json) {
      console.log(JSON.stringify({ status: 'ok', data }));
      return;
    }
    console.log('');
    console.log(`  Service:         ${color.cyan(ctx.service)}`);
    console.log(`  Task def:        ${color.cyan(td?.taskDefinitionArn ?? '?')}`);
    console.log(`  Revision:        ${td?.revision ?? '?'}`);
    console.log(`  Image:           ${container?.image ?? '?'}`);
    console.log(`  CPU / Memory:    ${td?.cpu ?? '?'} / ${td?.memory ?? '?'}`);
    console.log(`  Task role:       ${td?.taskRoleArn ?? color.gray('(none)')}`);
    console.log(`  Execution role:  ${td?.executionRoleArn ?? color.gray('(none)')}`);
    console.log(`  Log group:       ${logGroup ?? color.gray('(none)')}`);
    if (data.environment.length > 0) {
      console.log(`  Environment (${data.environment.length}):`);
      for (const e of data.environment) {
        console.log(`    ${e.name}=${e.value}`);
      }
    }
    if (data.secrets.length > 0) {
      console.log(`  Secrets (${data.secrets.length}):`);
      for (const s of data.secrets) {
        console.log(`    ${s.name} ← ${color.gray(s.valueFrom ?? '')}`);
      }
    }
    console.log('');
  } catch (err: any) {
    spinner?.fail(err?.message ?? String(err));
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', error: err?.message ?? String(err), code: err?.name ?? 'ECS_DESCRIBE_FAILED' }));
    }
    process.exit(1);
  }
}

// ─── tasks ───────────────────────────────────────────────────────────────────

async function runTasks(opts: { region?: string; env?: string; cluster?: string; service?: string; json?: boolean }): Promise<void> {
  const ctx = resolveContext(opts);
  const spinner = opts.json ? null : ora(`Listing tasks for ${ctx.service}`).start();
  try {
    const client = new ECSClient({ region: ctx.region });
    const listed = await client.send(new ListTasksCommand({ cluster: ctx.cluster, serviceName: ctx.service, desiredStatus: 'RUNNING' }));
    const arns = listed.taskArns ?? [];
    const tasks: Task[] = arns.length === 0
      ? []
      : (await client.send(new DescribeTasksCommand({ cluster: ctx.cluster, tasks: arns }))).tasks ?? [];
    const data = tasks.map(t => ({
      taskArn: t.taskArn,
      taskDefinitionArn: t.taskDefinitionArn,
      revision: taskDefVersion(t.taskDefinitionArn),
      lastStatus: t.lastStatus,
      desiredStatus: t.desiredStatus,
      healthStatus: t.healthStatus,
      startedAt: t.startedAt?.toISOString(),
    }));
    spinner?.succeed(`Found ${data.length} running task(s)`);

    if (opts.json) {
      console.log(JSON.stringify({ status: 'ok', data: { cluster: ctx.cluster, service: ctx.service, tasks: data } }));
      return;
    }
    console.log('');
    console.log(`  ${color.bold(ctx.service)} — ${data.length} running task(s)`);
    console.log('');
    for (const t of data) {
      const shortArn = (t.taskArn ?? '').split('/').pop() ?? '?';
      const statusStr = t.lastStatus === 'RUNNING' ? color.green(t.lastStatus) : color.yellow(t.lastStatus ?? '?');
      console.log(`  ${shortArn}  rev ${t.revision}  ${statusStr}  ${color.gray('health=' + (t.healthStatus ?? 'UNKNOWN'))}`);
    }
    if (data.length === 0) console.log(color.gray('  (no running tasks)'));
    console.log('');
  } catch (err: any) {
    spinner?.fail(err?.message ?? String(err));
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', error: err?.message ?? String(err), code: err?.name ?? 'ECS_TASKS_FAILED' }));
    }
    process.exit(1);
  }
}

// ─── task-def ────────────────────────────────────────────────────────────────

async function runTaskDef(serviceArg: string | undefined, opts: { region?: string; env?: string; cluster?: string; revision?: string; json?: boolean }): Promise<void> {
  const ctx = resolveContext({ ...opts, service: serviceArg });
  const spinner = opts.json ? null : ora(`Fetching task definition for ${ctx.service}`).start();
  try {
    const client = new ECSClient({ region: ctx.region });

    // If --revision provided, reference td by family:revision; otherwise use the service's current td.
    let taskDefRef: string | undefined;
    if (opts.revision) {
      // Family name = service name (chimera convention) or strip cluster prefix
      taskDefRef = `${ctx.service}:${opts.revision}`;
    } else {
      const svcResp = await client.send(new DescribeServicesCommand({ cluster: ctx.cluster, services: [ctx.service] }));
      taskDefRef = svcResp.services?.[0]?.taskDefinition;
      if (!taskDefRef) throw new Error(`Service ${ctx.service} not found`);
    }

    const tdResp = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefRef }));
    const td = tdResp.taskDefinition;
    if (!td) throw new Error(`Task definition ${taskDefRef} not found`);
    spinner?.succeed(`Fetched rev ${td.revision}`);

    if (opts.json) {
      console.log(JSON.stringify({ status: 'ok', data: td }, null, 2));
      return;
    }
    // Non-JSON: pretty-print the full task def as JSON.
    console.log(JSON.stringify(td, null, 2));
  } catch (err: any) {
    spinner?.fail(err?.message ?? String(err));
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', error: err?.message ?? String(err), code: err?.name ?? 'ECS_TASKDEF_FAILED' }));
    }
    process.exit(1);
  }
}

// ─── command registration ───────────────────────────────────────────────────

export const ecsCommand = new Command('ecs')
  .description('Inspect ECS chat-gateway service (status / describe / tasks / task-def)');

ecsCommand
  .command('status')
  .description('Service deployment status (rolloutState, running/desired, task-def revision)')
  .option('--service <name>', 'Service name (default: chimera-chat-gateway-{env})')
  .option('--cluster <name>', 'Cluster name (default: chimera-chat-{env})')
  .option('--region <region>', 'AWS region')
  .option('--env <environment>', 'Environment name')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    await runStatus(opts);
  });

ecsCommand
  .command('describe [service]')
  .description('Task definition details: image, env, IAM roles, log group')
  .option('--cluster <name>', 'Cluster name (default: chimera-chat-{env})')
  .option('--region <region>', 'AWS region')
  .option('--env <environment>', 'Environment name')
  .option('--json', 'Machine-readable JSON output')
  .action(async (service: string | undefined, opts) => {
    await runDescribe(service, opts);
  });

ecsCommand
  .command('tasks')
  .description('List running tasks for a service with their task-def revision')
  .option('--service <name>', 'Service name (default: chimera-chat-gateway-{env})')
  .option('--cluster <name>', 'Cluster name (default: chimera-chat-{env})')
  .option('--region <region>', 'AWS region')
  .option('--env <environment>', 'Environment name')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    await runTasks(opts);
  });

ecsCommand
  .command('task-def [service]')
  .description('Show task definition JSON (latest or --revision N)')
  .option('--revision <n>', 'Specific revision (default: service current)')
  .option('--cluster <name>', 'Cluster name (default: chimera-chat-{env})')
  .option('--region <region>', 'AWS region')
  .option('--env <environment>', 'Environment name')
  .option('--json', 'Machine-readable JSON output')
  .action(async (service: string | undefined, opts) => {
    await runTaskDef(service, opts);
  });

// Exported for tests.
export { filterEnv, taskDefVersion, formatRolloutState, SECRET_NAME_RX };

export default ecsCommand;
