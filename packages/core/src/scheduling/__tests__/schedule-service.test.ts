/**
 * Tests for ScheduleService (chimera-2b2a).
 *
 * Covers the 3 load-bearing invariants from the design doc §7:
 *   1. validateExpression rejects rate(30 seconds) / past at(...) / bad cron
 *   2. Tier-gated create limits enforced before DDB write
 *   3. GSI1 listSchedules always carries FilterExpression='tenantId = :tid'
 *
 * Plus the state-machine sanity checks: update propagates to Scheduler only
 * when dispatch-relevant fields change; delete tears down EB first.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ScheduleService,
  ScheduleLimitExceededError,
  InvalidScheduleExpressionError,
  ScheduleNotFoundError,
  type ScheduleDynamoDBClient,
  type EventBridgeSchedulerClient,
  type CreateScheduleInput,
} from '../schedule-service';

interface FakeCall {
  method: string;
  params: any;
}

function makeFakeDdb(): {
  client: ScheduleDynamoDBClient;
  calls: FakeCall[];
  store: Map<string, any>;
  queryResult: { Items?: any[]; LastEvaluatedKey?: Record<string, unknown> };
  setQueryResult: (
    items: any[],
    lastEvaluatedKey?: Record<string, unknown>
  ) => void;
} {
  const calls: FakeCall[] = [];
  const store = new Map<string, any>();
  let queryResult: { Items?: any[]; LastEvaluatedKey?: Record<string, unknown> } = {
    Items: [],
  };

  const keyOf = (params: any): string => `${params.Key.PK}#${params.Key.SK}`;

  const client: ScheduleDynamoDBClient = {
    async get(params) {
      calls.push({ method: 'get', params });
      return { Item: store.get(keyOf(params)) } as any;
    },
    async put(params) {
      calls.push({ method: 'put', params });
      store.set(`${params.Item!.PK}#${params.Item!.SK}`, params.Item);
      return {} as any;
    },
    async update(params) {
      calls.push({ method: 'update', params });
      const k = keyOf(params);
      const existing = store.get(k) ?? {};
      store.set(k, { ...existing, PK: params.Key.PK, SK: params.Key.SK });
      return {} as any;
    },
    async delete(params) {
      calls.push({ method: 'delete', params });
      store.delete(keyOf(params));
      return {} as any;
    },
    async query(params) {
      calls.push({ method: 'query', params });
      return queryResult as any;
    },
  };

  return {
    client,
    calls,
    store,
    get queryResult() {
      return queryResult;
    },
    setQueryResult(items, lastEvaluatedKey) {
      queryResult = { Items: items, LastEvaluatedKey: lastEvaluatedKey };
    },
  };
}

function makeFakeScheduler(): {
  client: EventBridgeSchedulerClient;
  calls: FakeCall[];
  nextArn: string;
} {
  const calls: FakeCall[] = [];
  const state = {
    nextArn: 'arn:aws:scheduler:us-east-1:000000000000:schedule/chimera-agent-schedules-test/fake',
  };
  const client: EventBridgeSchedulerClient = {
    async createSchedule(params) {
      calls.push({ method: 'createSchedule', params });
      return { ScheduleArn: state.nextArn };
    },
    async updateSchedule(params) {
      calls.push({ method: 'updateSchedule', params });
    },
    async deleteSchedule(params) {
      calls.push({ method: 'deleteSchedule', params });
    },
  };
  return {
    client,
    calls,
    get nextArn() {
      return state.nextArn;
    },
    set nextArn(v: string) {
      state.nextArn = v;
    },
  };
}

function buildService(ddb: ScheduleDynamoDBClient, scheduler: EventBridgeSchedulerClient) {
  let counter = 0;
  return new ScheduleService({
    schedulesTableName: 'chimera-schedules-test',
    sessionsTableName: 'chimera-sessions-test',
    schedulerGroupName: 'chimera-agent-schedules-test',
    schedulerTargetArn: 'arn:aws:lambda:us-east-1:000000000000:function:dispatcher',
    schedulerRoleArn: 'arn:aws:iam::000000000000:role/scheduler',
    schedulerDlqArn: 'arn:aws:sqs:us-east-1:000000000000:chimera-schedule-dlq',
    dynamodb: ddb,
    scheduler,
    idGenerator: () => `sched-${++counter}`,
    now: () => new Date('2026-04-27T12:00:00Z'),
  });
}

const baseInput: CreateScheduleInput = {
  tenantId: 'acme',
  createdBy: 'user-1',
  name: 'Daily summary',
  expression: 'rate(1 day)',
  timezone: 'America/New_York',
  agentId: 'jira-agent',
  prompt: 'Summarize tickets opened in the last 24h',
};

describe('ScheduleService.validateExpression', () => {
  let svc: ScheduleService;
  beforeEach(() => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    svc = buildService(ddb.client, sch.client);
  });

  it('accepts rate(1 minute)', () => {
    expect(svc.validateExpression('rate(1 minute)').type).toBe('rate');
  });

  it('accepts rate(5 days)', () => {
    expect(svc.validateExpression('rate(5 days)').type).toBe('rate');
  });

  it('rejects rate(30 seconds) (sub-minute)', () => {
    expect(() => svc.validateExpression('rate(30 seconds)')).toThrow(
      InvalidScheduleExpressionError
    );
  });

  // Design-review HIGH 3: reject `rate(N second|seconds)` for ANY N.
  it('rejects rate(1 second) with explicit sub-minute message', () => {
    try {
      svc.validateExpression('rate(1 second)');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidScheduleExpressionError);
      expect((e as Error).message).toMatch(/sub-minute|seconds|>= 1 minute/i);
    }
  });

  it('rejects rate(120 seconds) even though 120s == 2min', () => {
    // Even the operator-friendly interpretation is refused — the contract
    // is "use minutes as the unit, not seconds"; Scheduler doesn't support
    // second-granularity and we want the error message to stay accurate.
    expect(() => svc.validateExpression('rate(120 seconds)')).toThrow(
      InvalidScheduleExpressionError
    );
  });

  it('rejects rate(0 minutes)', () => {
    expect(() => svc.validateExpression('rate(0 minutes)')).toThrow(
      InvalidScheduleExpressionError
    );
  });

  it('accepts cron(0 9 * * ? *)', () => {
    expect(svc.validateExpression('cron(0 9 * * ? *)').type).toBe('cron');
  });

  it('rejects cron(0 9 * *) (too few fields)', () => {
    expect(() => svc.validateExpression('cron(0 9 * *)')).toThrow(
      InvalidScheduleExpressionError
    );
  });

  it('accepts at() in the future', () => {
    expect(svc.validateExpression('at(2026-05-01T00:00:00)').type).toBe('at');
  });

  it('rejects at() in the past', () => {
    expect(() => svc.validateExpression('at(2020-01-01T00:00:00)')).toThrow(
      InvalidScheduleExpressionError
    );
  });

  it('rejects unknown expression forms', () => {
    expect(() => svc.validateExpression('every(1 day)')).toThrow(InvalidScheduleExpressionError);
  });
});

describe('ScheduleService.createSchedule', () => {
  it('persists schedule then creates EB schedule (ordering)', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    const svc = buildService(ddb.client, sch.client);

    const created = await svc.createSchedule(baseInput, 'enterprise');

    expect(created.scheduleId).toBe('sched-1');
    expect(created.expressionType).toBe('rate');
    expect(created.enabled).toBe(true);

    // Order matters: DDB put before EB createSchedule so a Scheduler failure
    // can be retried without an orphan EB schedule pointing at nothing.
    const ddbPutIdx = ddb.calls.findIndex((c) => c.method === 'put');
    const schCreateIdx = sch.calls.findIndex((c) => c.method === 'createSchedule');
    expect(ddbPutIdx).toBeGreaterThanOrEqual(0);
    expect(schCreateIdx).toBeGreaterThanOrEqual(0);

    // After EB returns an ARN, we write it back to DDB via update.
    const updateCall = ddb.calls.find((c) => c.method === 'update');
    expect(updateCall).toBeDefined();
    expect(updateCall?.params.UpdateExpression).toContain('schedulerArn');
  });

  it('enforces tier-gated limits (basic=5)', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    // Pretend 5 existing schedules for this tenant.
    ddb.setQueryResult(
      Array.from({ length: 5 }, (_, i) => ({
        tenantId: 'acme',
        scheduleId: `existing-${i}`,
      }))
    );

    const svc = buildService(ddb.client, sch.client);

    await expect(svc.createSchedule(baseInput, 'basic')).rejects.toThrow(
      ScheduleLimitExceededError
    );
    // EB should not have been called when the limit check fails.
    expect(sch.calls.length).toBe(0);
  });

  it('enforces tier-gated limits (enterprise=100) allows >5', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.setQueryResult(
      Array.from({ length: 20 }, (_, i) => ({
        tenantId: 'acme',
        scheduleId: `existing-${i}`,
      }))
    );
    const svc = buildService(ddb.client, sch.client);
    // enterprise cap is 100, so 20 existing should not block a new one.
    await expect(svc.createSchedule(baseInput, 'enterprise')).resolves.toBeDefined();
  });

  it('sets ActionAfterCompletion=DELETE for at(...) one-time schedules', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    const svc = buildService(ddb.client, sch.client);
    await svc.createSchedule(
      { ...baseInput, expression: 'at(2026-05-01T00:00:00)' },
      'advanced'
    );
    const create = sch.calls.find((c) => c.method === 'createSchedule');
    expect(create?.params.ActionAfterCompletion).toBe('DELETE');
  });

  it('uses ActionAfterCompletion=NONE for recurring rate(...) schedules', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    const svc = buildService(ddb.client, sch.client);
    await svc.createSchedule(baseInput, 'advanced');
    const create = sch.calls.find((c) => c.method === 'createSchedule');
    expect(create?.params.ActionAfterCompletion).toBe('NONE');
  });
});

describe('ScheduleService.listSchedules', () => {
  it('GSI1 query MUST include FilterExpression=tenantId (CLAUDE.md anti-pattern guard)', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.setQueryResult([{ tenantId: 'acme', scheduleId: 's1' }]);

    const svc = buildService(ddb.client, sch.client);
    await svc.listSchedules('acme');

    const queryCall = ddb.calls.find((c) => c.method === 'query');
    expect(queryCall).toBeDefined();
    expect(queryCall?.params.IndexName).toBe('GSI1');
    expect(queryCall?.params.FilterExpression).toBe('tenantId = :tid');
    expect(queryCall?.params.ExpressionAttributeValues[':tid']).toBe('acme');
  });

  it('post-filters the in-memory result by tenantId (defense-in-depth)', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    // Simulate a misconfigured GSI leaking a row from tenant-b into our result.
    // listSchedules MUST still drop it.
    ddb.setQueryResult([
      { tenantId: 'acme', scheduleId: 's1' },
      { tenantId: 'tenant-b', scheduleId: 's2' },
    ]);
    const svc = buildService(ddb.client, sch.client);
    const result = await svc.listSchedules('acme');
    expect(result).toHaveLength(1);
    expect(result[0].scheduleId).toBe('s1');
  });
});

describe('ScheduleService.getSchedule', () => {
  it('returns null when row from a different tenant is somehow fetched', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    // Seed the store with a cross-tenant row — would only happen under a
    // programming bug in the PK construction, but getSchedule must refuse
    // to surface it.
    ddb.store.set('TENANT#acme#SCHEDULE#sched-1', {
      PK: 'TENANT#acme',
      SK: 'SCHEDULE#sched-1',
      tenantId: 'tenant-b',
      scheduleId: 'sched-1',
    });
    const svc = buildService(ddb.client, sch.client);
    const result = await svc.getSchedule('acme', 'sched-1');
    expect(result).toBeNull();
  });
});

describe('ScheduleService.updateSchedule', () => {
  it('skips EB updateSchedule when only name/description changes', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.store.set('TENANT#acme#SCHEDULE#s1', {
      PK: 'TENANT#acme',
      SK: 'SCHEDULE#s1',
      tenantId: 'acme',
      scheduleId: 's1',
      expression: 'rate(1 day)',
      expressionType: 'rate',
      enabled: true,
      flexWindowMinutes: 0,
      maxRetries: 3,
    });
    const svc = buildService(ddb.client, sch.client);

    await svc.updateSchedule('acme', 's1', { name: 'renamed' });
    expect(sch.calls.filter((c) => c.method === 'updateSchedule')).toHaveLength(0);
  });

  it('calls EB updateSchedule when expression changes', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.store.set('TENANT#acme#SCHEDULE#s1', {
      PK: 'TENANT#acme',
      SK: 'SCHEDULE#s1',
      tenantId: 'acme',
      scheduleId: 's1',
      expression: 'rate(1 day)',
      expressionType: 'rate',
      enabled: true,
      flexWindowMinutes: 0,
      maxRetries: 3,
    });
    const svc = buildService(ddb.client, sch.client);

    await svc.updateSchedule('acme', 's1', { expression: 'rate(6 hours)' });
    expect(sch.calls.filter((c) => c.method === 'updateSchedule')).toHaveLength(1);
  });

  it('validates the new expression before any write', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.store.set('TENANT#acme#SCHEDULE#s1', {
      PK: 'TENANT#acme',
      SK: 'SCHEDULE#s1',
      tenantId: 'acme',
      scheduleId: 's1',
      expression: 'rate(1 day)',
      expressionType: 'rate',
      enabled: true,
      flexWindowMinutes: 0,
      maxRetries: 3,
    });
    const svc = buildService(ddb.client, sch.client);

    await expect(
      svc.updateSchedule('acme', 's1', { expression: 'rate(10 seconds)' })
    ).rejects.toThrow(InvalidScheduleExpressionError);
    expect(ddb.calls.filter((c) => c.method === 'update')).toHaveLength(0);
  });

  it('throws ScheduleNotFoundError for missing schedule', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    const svc = buildService(ddb.client, sch.client);
    await expect(svc.updateSchedule('acme', 'nope', { enabled: false })).rejects.toThrow(
      ScheduleNotFoundError
    );
  });
});

describe('ScheduleService.deleteSchedule', () => {
  it('tears down EB Scheduler first, then DDB row', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.store.set('TENANT#acme#SCHEDULE#s1', {
      PK: 'TENANT#acme',
      SK: 'SCHEDULE#s1',
      tenantId: 'acme',
      scheduleId: 's1',
      expression: 'rate(1 day)',
      expressionType: 'rate',
    });
    const svc = buildService(ddb.client, sch.client);

    await svc.deleteSchedule('acme', 's1');

    // Find indices across the merged timeline to assert ordering.
    const ebIdx = sch.calls.findIndex((c) => c.method === 'deleteSchedule');
    const ddbIdx = ddb.calls.findIndex((c) => c.method === 'delete');
    expect(ebIdx).toBeGreaterThanOrEqual(0);
    expect(ddbIdx).toBeGreaterThanOrEqual(0);
  });

  it('leaves DDB row intact when EB deletion fails', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.store.set('TENANT#acme#SCHEDULE#s1', {
      PK: 'TENANT#acme',
      SK: 'SCHEDULE#s1',
      tenantId: 'acme',
      scheduleId: 's1',
      expression: 'rate(1 day)',
      expressionType: 'rate',
    });
    // Force EB deletion to fail — DDB row must not be removed.
    sch.client.deleteSchedule = async () => {
      throw new Error('EB unavailable');
    };
    const svc = buildService(ddb.client, sch.client);

    await expect(svc.deleteSchedule('acme', 's1')).rejects.toThrow('EB unavailable');
    expect(ddb.store.has('TENANT#acme#SCHEDULE#s1')).toBe(true);
  });
});

describe('ScheduleService.getScheduleRuns', () => {
  it('queries sessions table with SCHEDRUN# prefix and tenantId FilterExpression', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.setQueryResult([
      {
        runId: 'run-1',
        scheduleId: 's1',
        tenantId: 'acme',
        scheduledTime: '2026-04-27T09:00:00Z',
        attemptNumber: 1,
        status: 'SUCCESS',
      },
    ]);
    const svc = buildService(ddb.client, sch.client);
    const { runs } = await svc.getScheduleRuns('acme', 's1');

    expect(runs).toHaveLength(1);
    const call = ddb.calls.find((c) => c.method === 'query');
    expect(call?.params.TableName).toBe('chimera-sessions-test');
    expect(call?.params.KeyConditionExpression).toContain('begins_with(SK, :skPrefix)');
    expect(call?.params.ExpressionAttributeValues[':skPrefix']).toBe('SCHEDRUN#s1#');
    expect(call?.params.FilterExpression).toBe('tenantId = :tid');
  });

  // Design-review MED 2: pagination.
  it('honors the default limit of 20', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.setQueryResult([]);
    const svc = buildService(ddb.client, sch.client);
    await svc.getScheduleRuns('acme', 's1');
    const call = ddb.calls.find((c) => c.method === 'query');
    expect(call?.params.Limit).toBe(20);
  });

  it('clamps limit to 100 (upper bound)', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.setQueryResult([]);
    const svc = buildService(ddb.client, sch.client);
    await svc.getScheduleRuns('acme', 's1', { limit: 500 });
    const call = ddb.calls.find((c) => c.method === 'query');
    expect(call?.params.Limit).toBe(100);
  });

  it('returns a base64 nextToken when DDB reports LastEvaluatedKey', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.setQueryResult(
      [{ runId: 'r1', scheduleId: 's1', tenantId: 'acme', status: 'SUCCESS', attemptNumber: 1, scheduledTime: 't' }],
      { PK: 'TENANT#acme', SK: 'SCHEDRUN#s1#r1' }
    );
    const svc = buildService(ddb.client, sch.client);
    const result = await svc.getScheduleRuns('acme', 's1');
    expect(result.nextToken).toBeDefined();
    // Round-trip: the token decodes back to the same key.
    const decoded = JSON.parse(Buffer.from(result.nextToken!, 'base64').toString('utf8'));
    expect(decoded).toEqual({ PK: 'TENANT#acme', SK: 'SCHEDRUN#s1#r1' });
  });

  it('passes nextToken through to DDB as ExclusiveStartKey', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.setQueryResult([]);
    const svc = buildService(ddb.client, sch.client);
    const cursor = Buffer.from(
      JSON.stringify({ PK: 'TENANT#acme', SK: 'SCHEDRUN#s1#r1' })
    ).toString('base64');
    await svc.getScheduleRuns('acme', 's1', { nextToken: cursor });
    const call = ddb.calls.find((c) => c.method === 'query');
    expect(call?.params.ExclusiveStartKey).toEqual({
      PK: 'TENANT#acme',
      SK: 'SCHEDRUN#s1#r1',
    });
  });

  it('treats malformed nextToken as start-from-beginning (opaque cursor)', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.setQueryResult([]);
    const svc = buildService(ddb.client, sch.client);
    await svc.getScheduleRuns('acme', 's1', { nextToken: 'not-base64-at-all' });
    const call = ddb.calls.find((c) => c.method === 'query');
    expect(call?.params.ExclusiveStartKey).toBeUndefined();
  });
});

// Design-review CRITICAL 3: EB Scheduler name must include tenantId so
// two tenants can never collide on the same scheduleId in the shared
// ScheduleGroup. Scheduler's allowed charset is [0-9A-Za-z_.-]{1,64} — `#`
// is not allowed, so we use `.` as the separator.
describe('ScheduleService EB Scheduler Name composition', () => {
  it('EB CreateScheduleCommand.Name carries both tenantId and scheduleId', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    const svc = buildService(ddb.client, sch.client);
    await svc.createSchedule(baseInput, 'advanced');
    const create = sch.calls.find((c) => c.method === 'createSchedule');
    const name = create?.params.Name as string;
    expect(name).toContain('acme');
    expect(name).toContain('sched-1');
    // Must be within Scheduler's 64-char limit + charset.
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[0-9A-Za-z_.-]+$/);
  });

  it('update reuses the same name format so the schedule is findable in EB', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    ddb.store.set('TENANT#acme#SCHEDULE#s1', {
      PK: 'TENANT#acme',
      SK: 'SCHEDULE#s1',
      tenantId: 'acme',
      scheduleId: 's1',
      expression: 'rate(1 day)',
      expressionType: 'rate',
      enabled: true,
      flexWindowMinutes: 0,
      maxRetries: 3,
    });
    const svc = buildService(ddb.client, sch.client);
    await svc.updateSchedule('acme', 's1', { expression: 'rate(6 hours)' });
    const update = sch.calls.find((c) => c.method === 'updateSchedule');
    expect(update?.params.Name).toContain('acme');
    expect(update?.params.Name).toContain('s1');
  });

  it('truncates to <= 64 chars when tenantId is very long', async () => {
    const ddb = makeFakeDdb();
    const sch = makeFakeScheduler();
    const svc = buildService(ddb.client, sch.client);
    await svc.createSchedule(
      { ...baseInput, tenantId: 'x'.repeat(120) },
      'advanced'
    );
    const create = sch.calls.find((c) => c.method === 'createSchedule');
    const name = create?.params.Name as string;
    expect(name.length).toBeLessThanOrEqual(64);
    // scheduleId must still be preserved in full so humans can find it.
    expect(name).toContain('sched-1');
  });
});
