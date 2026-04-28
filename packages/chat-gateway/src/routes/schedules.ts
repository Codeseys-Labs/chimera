/**
 * Schedule routes (chimera-2b2a EventBridge scheduled tasks).
 *
 * Mounted at `/tenants/:tenantId/schedules` behind authenticateJWT +
 * extractTenantContext (wired in server.ts). Every handler reconfirms
 * tenantId isolation: the URL param must match the JWT claim, otherwise
 * 403 — never trust the URL in isolation on a multi-tenant API.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { DynamoDBClient as AwsDynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
} from '@aws-sdk/client-scheduler';
import {
  ScheduleService,
  ScheduleLimitExceededError,
  InvalidScheduleExpressionError,
  ScheduleNotFoundError,
  type ScheduleDynamoDBClient,
  type EventBridgeSchedulerClient,
  type CreateScheduleParams,
  type UpdateScheduleParams,
  type ScheduleTenantTier,
} from '@chimera/core';
import type { TenantContext } from '../types';

const router = new Hono();

// Module-level singletons (ADR-020): reuse connections across requests,
// amortize SDK client init cost. `{}` picks up region + creds from the
// default chain, identical to the tenant router.
const ddb = DynamoDBDocumentClient.from(new AwsDynamoDBClient({}));
const schedulerSdk = new SchedulerClient({});

const ddbAdapter: ScheduleDynamoDBClient = {
  get: (params) => ddb.send(new GetCommand(params)),
  put: (params) => ddb.send(new PutCommand(params)),
  update: (params) => ddb.send(new UpdateCommand(params)),
  delete: (params) => ddb.send(new DeleteCommand(params)),
  query: (params) => ddb.send(new QueryCommand(params)),
};

const schedulerAdapter: EventBridgeSchedulerClient = {
  async createSchedule(params: CreateScheduleParams) {
    const resp = await schedulerSdk.send(new CreateScheduleCommand(params));
    return { ScheduleArn: resp.ScheduleArn };
  },
  async updateSchedule(params: UpdateScheduleParams) {
    await schedulerSdk.send(new UpdateScheduleCommand(params));
  },
  async deleteSchedule(params: { Name: string; GroupName?: string }) {
    await schedulerSdk.send(new DeleteScheduleCommand(params));
  },
};

function resolveEnv(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (!val) throw new Error(`${name} environment variable is required`);
  return val;
}

// Lazy service construction — env vars are read at first-request time, not
// module-load time, so tests can inject mocked values without re-importing.
let serviceSingleton: ScheduleService | null = null;
function getService(): ScheduleService {
  if (serviceSingleton) return serviceSingleton;
  serviceSingleton = new ScheduleService({
    schedulesTableName: resolveEnv('SCHEDULES_TABLE_NAME', 'chimera-schedules-dev'),
    sessionsTableName: resolveEnv('SESSIONS_TABLE_NAME', 'chimera-sessions-dev'),
    schedulerGroupName: resolveEnv('SCHEDULER_GROUP_NAME', 'chimera-agent-schedules-dev'),
    schedulerTargetArn: resolveEnv(
      'SCHEDULER_DISPATCHER_ARN',
      'arn:aws:lambda:us-east-1:000000000000:function:chimera-schedule-dispatcher-dev'
    ),
    schedulerRoleArn: resolveEnv(
      'SCHEDULER_ROLE_ARN',
      'arn:aws:iam::000000000000:role/chimera-scheduler-role-dev'
    ),
    schedulerDlqArn: process.env.SCHEDULER_DLQ_ARN,
    dynamodb: ddbAdapter,
    scheduler: schedulerAdapter,
  });
  return serviceSingleton;
}

/**
 * Test seam: inject a stubbed ScheduleService (bypasses AWS SDKs + env
 * validation). Exported as `__` to mark internal-only.
 */
export function __setScheduleServiceForTests(svc: ScheduleService | null): void {
  serviceSingleton = svc;
}

function requireTenantMatch(
  c: Context,
  urlTenantId: string
): { ok: true; context: TenantContext } | { ok: false; response: Response } {
  const tenantContext = c.get('tenantContext') as TenantContext | undefined;
  if (!tenantContext) {
    return {
      ok: false,
      response: c.json(
        {
          error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
          timestamp: new Date().toISOString(),
        },
        401
      ),
    };
  }
  if (tenantContext.tenantId !== urlTenantId) {
    return {
      ok: false,
      response: c.json(
        {
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: 'Cannot access schedules for a different tenant',
          },
          timestamp: new Date().toISOString(),
        },
        403
      ),
    };
  }
  return { ok: true, context: tenantContext };
}

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof InvalidScheduleExpressionError) {
    return c.json(
      {
        error: { code: 'INVALID_EXPRESSION', message: err.message },
        timestamp: new Date().toISOString(),
      },
      400
    );
  }
  if (err instanceof ScheduleLimitExceededError) {
    return c.json(
      {
        error: {
          code: 'SCHEDULE_LIMIT_EXCEEDED',
          message: err.message,
          details: { tier: err.tier, limit: err.limit },
        },
        timestamp: new Date().toISOString(),
      },
      403
    );
  }
  if (err instanceof ScheduleNotFoundError) {
    return c.json(
      {
        error: { code: 'SCHEDULE_NOT_FOUND', message: err.message },
        timestamp: new Date().toISOString(),
      },
      404
    );
  }
  console.error('Schedule route error:', err);
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : 'Unknown error',
      },
      timestamp: new Date().toISOString(),
    },
    500
  );
}

/**
 * POST /tenants/:tenantId/schedules
 */
router.post('/', async (c: Context) => {
  const tenantId = c.req.param('tenantId')!;
  const guard = requireTenantMatch(c, tenantId);
  if (!guard.ok) return guard.response;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  const { name, description, expression, timezone, prompt, agentId, sessionId, flexWindowMinutes, maxRetries, enabled } = body ?? {};

  if (!name || !expression || !prompt || !agentId) {
    return c.json(
      {
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'Required fields: name, expression, prompt, agentId',
        },
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  try {
    const schedule = await getService().createSchedule(
      {
        tenantId,
        createdBy: guard.context.userId ?? 'unknown',
        name,
        description,
        expression,
        timezone,
        enabled,
        agentId,
        prompt,
        sessionId,
        flexWindowMinutes,
        maxRetries,
      },
      guard.context.tier as ScheduleTenantTier
    );
    return c.json({ schedule, timestamp: new Date().toISOString() }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * GET /tenants/:tenantId/schedules
 */
router.get('/', async (c: Context) => {
  const tenantId = c.req.param('tenantId')!;
  const guard = requireTenantMatch(c, tenantId);
  if (!guard.ok) return guard.response;

  try {
    const schedules = await getService().listSchedules(tenantId);
    return c.json({
      schedules,
      count: schedules.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * GET /tenants/:tenantId/schedules/:id
 */
router.get('/:id', async (c: Context) => {
  const tenantId = c.req.param('tenantId')!;
  const scheduleId = c.req.param('id')!;
  const guard = requireTenantMatch(c, tenantId);
  if (!guard.ok) return guard.response;

  try {
    const schedule = await getService().getSchedule(tenantId, scheduleId);
    if (!schedule) {
      return c.json(
        {
          error: { code: 'SCHEDULE_NOT_FOUND', message: 'Schedule not found' },
          timestamp: new Date().toISOString(),
        },
        404
      );
    }
    return c.json({ schedule, timestamp: new Date().toISOString() });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * PATCH /tenants/:tenantId/schedules/:id
 */
router.patch('/:id', async (c: Context) => {
  const tenantId = c.req.param('tenantId')!;
  const scheduleId = c.req.param('id')!;
  const guard = requireTenantMatch(c, tenantId);
  if (!guard.ok) return guard.response;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  try {
    const schedule = await getService().updateSchedule(tenantId, scheduleId, body ?? {});
    return c.json({ schedule, timestamp: new Date().toISOString() });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * DELETE /tenants/:tenantId/schedules/:id
 */
router.delete('/:id', async (c: Context) => {
  const tenantId = c.req.param('tenantId')!;
  const scheduleId = c.req.param('id')!;
  const guard = requireTenantMatch(c, tenantId);
  if (!guard.ok) return guard.response;

  try {
    await getService().deleteSchedule(tenantId, scheduleId);
    return c.json({
      message: 'Schedule deleted',
      scheduleId,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * GET /tenants/:tenantId/schedules/:id/runs
 *
 * Run history for a schedule. Pulled from the sessions table
 * (SK prefix SCHEDRUN#{scheduleId}#{runId}), FilterExpression on tenantId
 * per the CLAUDE.md GSI anti-pattern guard — even though this query uses
 * the PK, keeping the filter is cheap defense-in-depth.
 *
 * Design-review MED 2: pagination.
 *   ?limit=<1..100, default 20>
 *   ?nextToken=<opaque base64 cursor from the previous page>
 */
router.get('/:id/runs', async (c: Context) => {
  const tenantId = c.req.param('tenantId')!;
  const scheduleId = c.req.param('id')!;
  const guard = requireTenantMatch(c, tenantId);
  if (!guard.ok) return guard.response;

  const limitParam = c.req.query('limit');
  const nextTokenParam = c.req.query('nextToken');
  const parsedLimit = limitParam ? parseInt(limitParam, 10) : undefined;
  const limit = parsedLimit && Number.isFinite(parsedLimit) ? parsedLimit : 20;

  try {
    const { runs, nextToken } = await getService().getScheduleRuns(tenantId, scheduleId, {
      limit,
      nextToken: nextTokenParam,
    });
    return c.json({
      runs,
      count: runs.length,
      nextToken,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

export default router;
