/**
 * Schedule Service
 *
 * CRUD wrapper over the `chimera-schedules-{env}` DynamoDB table + EventBridge
 * Scheduler SDK. Drives the chimera-2b2a recurring-task feature: tenant admins
 * POST a rate/cron/at expression, we persist the metadata and call
 * scheduler.CreateSchedule with a target of the dispatcher Lambda.
 *
 * Tenant isolation is load-bearing here. Every cross-partition read (GSI1 list,
 * SCHEDRUN# query) MUST include `FilterExpression='tenantId = :tid'` per the
 * CLAUDE.md GSI anti-pattern guard — the GSI partition key alone is not
 * sufficient on a shared table.
 */

import type {
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
  DeleteCommandInput,
  DeleteCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';

/**
 * Minimal DynamoDB document-client surface used by ScheduleService.
 *
 * Kept deliberately local (rather than re-exporting the TenantService client)
 * so tests can stub it without dragging lib-dynamodb runtime imports into
 * the unit-test harness.
 */
export interface ScheduleDynamoDBClient {
  get(params: GetCommandInput): Promise<GetCommandOutput>;
  put(params: PutCommandInput): Promise<PutCommandOutput>;
  update(params: UpdateCommandInput): Promise<UpdateCommandOutput>;
  delete(params: DeleteCommandInput): Promise<DeleteCommandOutput>;
  query(params: QueryCommandInput): Promise<QueryCommandOutput>;
}

/**
 * Minimal EventBridge Scheduler SDK surface.
 *
 * Matches `@aws-sdk/client-scheduler` v3 Command.send shape without importing
 * the runtime — callers pass a real client, tests pass a stub.
 */
export interface EventBridgeSchedulerClient {
  createSchedule(params: CreateScheduleParams): Promise<{ ScheduleArn?: string }>;
  updateSchedule(params: UpdateScheduleParams): Promise<void>;
  deleteSchedule(params: { Name: string; GroupName?: string }): Promise<void>;
}

export interface CreateScheduleParams {
  Name: string;
  GroupName: string;
  ScheduleExpression: string;
  ScheduleExpressionTimezone?: string;
  State?: 'ENABLED' | 'DISABLED';
  FlexibleTimeWindow: { Mode: 'OFF' | 'FLEXIBLE'; MaximumWindowInMinutes?: number };
  Target: {
    Arn: string;
    RoleArn: string;
    Input?: string;
    RetryPolicy?: { MaximumEventAgeInSeconds?: number; MaximumRetryAttempts?: number };
    DeadLetterConfig?: { Arn: string };
  };
  ActionAfterCompletion?: 'NONE' | 'DELETE';
}

export type UpdateScheduleParams = CreateScheduleParams;

/**
 * Tenant tier type — kept as a string literal to avoid a circular import
 * against @chimera/shared in tests. Values must stay in sync with
 * `TenantTier` in packages/shared/src/types/tenant.ts.
 */
export type ScheduleTenantTier = 'basic' | 'advanced' | 'enterprise' | 'dedicated' | 'premium';

/**
 * Per-tier schedule quotas (design doc §9 Q3).
 *
 * Legacy `premium` tier is an alias for `enterprise` — both get the top limit.
 * `dedicated` customers run on isolated infra and inherit the enterprise cap.
 */
export const SCHEDULE_LIMITS_BY_TIER: Record<ScheduleTenantTier, number> = {
  basic: 5,
  advanced: 25,
  enterprise: 100,
  dedicated: 100,
  premium: 100,
};

/**
 * Run status for SCHEDRUN# items in the sessions table. Mirrored in the
 * dispatcher Lambda (see design §3).
 */
export type ScheduleRunStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';

export interface ScheduleItem {
  tenantId: string;
  scheduleId: string;
  name: string;
  description?: string;
  expression: string;
  expressionType: 'rate' | 'cron' | 'at';
  timezone?: string;
  enabled: boolean;
  agentId: string;
  prompt: string;
  sessionId: string | null;
  flexWindowMinutes: number;
  maxRetries: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: ScheduleRunStatus;
  /**
   * Design-review HIGH 4 (stuck-RUNNING recovery): dispatcher Lambda
   * writes this when a run transitions to RUNNING and clears it on the
   * terminal transition (SUCCESS|FAILED|SKIPPED). A janitor job uses
   * `lastRunStatus == 'RUNNING' AND lastRunStartedAt < now - 15min` to
   * force-clear abandoned runs. ScheduleService never writes this field
   * — it is purely Lambda-owned state, exposed here so DDB-to-interface
   * deserialization round-trips cleanly.
   */
  lastRunStartedAt?: string;
  schedulerArn?: string;
}

export interface ScheduleRun {
  runId: string;
  scheduleId: string;
  tenantId: string;
  scheduledTime: string;
  startedAt?: string;
  completedAt?: string;
  attemptNumber: number;
  status: ScheduleRunStatus;
  errorMessage?: string;
  sessionId?: string;
}

export interface CreateScheduleInput {
  tenantId: string;
  createdBy: string;
  name: string;
  description?: string;
  expression: string;
  timezone?: string;
  enabled?: boolean;
  agentId: string;
  prompt: string;
  sessionId?: string | null;
  flexWindowMinutes?: number;
  maxRetries?: number;
}

export interface UpdateScheduleInput {
  name?: string;
  description?: string;
  expression?: string;
  timezone?: string;
  enabled?: boolean;
  prompt?: string;
  flexWindowMinutes?: number;
  maxRetries?: number;
}

export interface ScheduleServiceConfig {
  schedulesTableName: string;
  sessionsTableName: string;
  schedulerGroupName: string;
  schedulerTargetArn: string;
  schedulerRoleArn: string;
  schedulerDlqArn?: string;
  dynamodb: ScheduleDynamoDBClient;
  scheduler: EventBridgeSchedulerClient;
  /**
   * Override the id generator in tests. Defaults to `crypto.randomUUID()`.
   */
  idGenerator?: () => string;
  /**
   * Override the clock in tests so `now()` is deterministic.
   */
  now?: () => Date;
}

export class ScheduleLimitExceededError extends Error {
  constructor(public readonly tier: ScheduleTenantTier, public readonly limit: number) {
    super(`Schedule limit exceeded for tier ${tier}: max ${limit} schedules`);
    this.name = 'ScheduleLimitExceededError';
  }
}

export class InvalidScheduleExpressionError extends Error {
  constructor(reason: string) {
    super(`Invalid schedule expression: ${reason}`);
    this.name = 'InvalidScheduleExpressionError';
  }
}

export class ScheduleNotFoundError extends Error {
  constructor(tenantId: string, scheduleId: string) {
    super(`Schedule ${scheduleId} not found for tenant ${tenantId}`);
    this.name = 'ScheduleNotFoundError';
  }
}

export class ScheduleService {
  private readonly config: ScheduleServiceConfig;
  private readonly idGen: () => string;
  private readonly clock: () => Date;

  constructor(config: ScheduleServiceConfig) {
    this.config = config;
    this.idGen = config.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.clock = config.now ?? (() => new Date());
  }

  /**
   * Validate + classify an EventBridge Scheduler expression.
   *
   * Supports the three public forms:
   *   rate(<N> <unit>)           — N >= 1, unit in minutes|hours|days
   *   cron(<m> <h> <dom> <mo> <dow> <year?>)  — 6-7 fields
   *   at(yyyy-mm-ddThh:mm:ss)    — must be in the future
   *
   * The 1-minute minimum is enforced server-side (design §9 Q1). Scheduler
   * itself allows down to `rate(1 minute)` so this matches the lower bound
   * exactly — rate(30 seconds) is rejected here and by Scheduler.
   */
  validateExpression(
    expression: string,
    nowMs: number = this.clock().getTime()
  ): { type: 'rate' | 'cron' | 'at' } {
    const trimmed = expression.trim();

    // Design-review HIGH 3: sub-minute rate() precision is not guaranteed by
    // EventBridge Scheduler, so reject `rate(N second|seconds)` for ANY N
    // explicitly before the accept-regex runs. A lenient generic rejection
    // would still fire below, but this branch pins the error message to the
    // exact root cause the operator hit — "you used seconds".
    if (/^rate\(\s*\d+\s+seconds?\s*\)$/i.test(trimmed)) {
      throw new InvalidScheduleExpressionError(
        'rate(...) must be >= 1 minute — sub-minute precision is not guaranteed by EventBridge Scheduler'
      );
    }

    const rateMatch = trimmed.match(/^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/i);
    if (rateMatch) {
      const n = parseInt(rateMatch[1], 10);
      if (n < 1) throw new InvalidScheduleExpressionError('rate value must be >= 1');
      return { type: 'rate' };
    }

    if (/^rate\(/.test(trimmed)) {
      throw new InvalidScheduleExpressionError(
        'rate must be of form "rate(<N> minute[s]|hour[s]|day[s]>)"'
      );
    }

    const cronMatch = trimmed.match(/^cron\((.+)\)$/);
    if (cronMatch) {
      const fields = cronMatch[1].trim().split(/\s+/);
      if (fields.length < 6 || fields.length > 7) {
        throw new InvalidScheduleExpressionError('cron must have 6 or 7 fields');
      }
      return { type: 'cron' };
    }

    const atMatch = trimmed.match(/^at\((.+)\)$/);
    if (atMatch) {
      const isoish = atMatch[1].trim();
      const parsed = Date.parse(isoish);
      if (Number.isNaN(parsed)) {
        throw new InvalidScheduleExpressionError('at(...) must contain a parseable ISO-8601 timestamp');
      }
      if (parsed <= nowMs) {
        throw new InvalidScheduleExpressionError('at(...) must be in the future');
      }
      return { type: 'at' };
    }

    throw new InvalidScheduleExpressionError('must be one of rate(...), cron(...), or at(...)');
  }

  async createSchedule(input: CreateScheduleInput, tier: ScheduleTenantTier): Promise<ScheduleItem> {
    const { type: expressionType } = this.validateExpression(input.expression);

    // Tier-gated limit enforcement (design §9 Q3). List before insert; this
    // races under high concurrency but the design treats schedule creation as
    // a low-QPS admin operation — DDB conditional expressions would be the
    // strict-correctness fix and can be added later if it matters.
    const existing = await this.listSchedules(input.tenantId);
    const limit = SCHEDULE_LIMITS_BY_TIER[tier];
    if (existing.length >= limit) {
      throw new ScheduleLimitExceededError(tier, limit);
    }

    const scheduleId = this.idGen();
    const now = this.clock().toISOString();

    const item: ScheduleItem = {
      tenantId: input.tenantId,
      scheduleId,
      name: input.name,
      description: input.description,
      expression: input.expression,
      expressionType,
      timezone: input.timezone,
      enabled: input.enabled ?? true,
      agentId: input.agentId,
      prompt: input.prompt,
      sessionId: input.sessionId ?? null,
      flexWindowMinutes: input.flexWindowMinutes ?? 0,
      maxRetries: input.maxRetries ?? 3,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    await this.config.dynamodb.put({
      TableName: this.config.schedulesTableName,
      Item: {
        PK: `TENANT#${item.tenantId}`,
        SK: `SCHEDULE#${scheduleId}`,
        GSI1PK: item.tenantId,
        GSI1SK: now,
        GSI2PK: `${item.tenantId}#${expressionType}`,
        GSI2SK: scheduleId,
        ...item,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    });

    // Call EB Scheduler after DDB so a duplicate scheduleId (should be
    // impossible with UUIDv4, but the ConditionExpression guards against it)
    // never results in an orphaned EB schedule.
    const scheduleName = this.schedulerName(item.tenantId, scheduleId);
    const createResp = await this.config.scheduler.createSchedule({
      Name: scheduleName,
      GroupName: this.config.schedulerGroupName,
      ScheduleExpression: input.expression,
      ScheduleExpressionTimezone: input.timezone,
      State: item.enabled ? 'ENABLED' : 'DISABLED',
      FlexibleTimeWindow: item.flexWindowMinutes
        ? { Mode: 'FLEXIBLE', MaximumWindowInMinutes: item.flexWindowMinutes }
        : { Mode: 'OFF' },
      Target: {
        Arn: this.config.schedulerTargetArn,
        RoleArn: this.config.schedulerRoleArn,
        Input: JSON.stringify({ tenantId: item.tenantId, scheduleId }),
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: item.maxRetries },
        DeadLetterConfig: this.config.schedulerDlqArn
          ? { Arn: this.config.schedulerDlqArn }
          : undefined,
      },
      // Design §9 Q5: one-time `at(...)` schedules auto-delete after firing
      // so they don't burn the 10M/account quota forever.
      ActionAfterCompletion: expressionType === 'at' ? 'DELETE' : 'NONE',
    });

    const schedulerArn = createResp.ScheduleArn;
    if (schedulerArn) {
      item.schedulerArn = schedulerArn;
      await this.config.dynamodb.update({
        TableName: this.config.schedulesTableName,
        Key: { PK: `TENANT#${item.tenantId}`, SK: `SCHEDULE#${scheduleId}` },
        UpdateExpression: 'SET schedulerArn = :arn',
        ExpressionAttributeValues: { ':arn': schedulerArn },
      });
    }

    return item;
  }

  async updateSchedule(
    tenantId: string,
    scheduleId: string,
    updates: UpdateScheduleInput
  ): Promise<ScheduleItem> {
    const existing = await this.getSchedule(tenantId, scheduleId);
    if (!existing) throw new ScheduleNotFoundError(tenantId, scheduleId);

    let expressionType = existing.expressionType;
    if (updates.expression && updates.expression !== existing.expression) {
      expressionType = this.validateExpression(updates.expression).type;
    }

    const now = this.clock().toISOString();
    const merged: ScheduleItem = {
      ...existing,
      ...updates,
      expressionType,
      updatedAt: now,
    };

    const setClauses: string[] = ['updatedAt = :updatedAt'];
    const attrValues: Record<string, unknown> = { ':updatedAt': now };
    if (updates.name !== undefined) {
      setClauses.push('#n = :name');
      attrValues[':name'] = merged.name;
    }
    if (updates.description !== undefined) {
      setClauses.push('description = :description');
      attrValues[':description'] = merged.description ?? null;
    }
    if (updates.expression !== undefined) {
      setClauses.push('expression = :expression', 'expressionType = :expressionType');
      attrValues[':expression'] = merged.expression;
      attrValues[':expressionType'] = merged.expressionType;
    }
    if (updates.timezone !== undefined) {
      setClauses.push('#tz = :timezone');
      attrValues[':timezone'] = merged.timezone ?? null;
    }
    if (updates.enabled !== undefined) {
      setClauses.push('enabled = :enabled');
      attrValues[':enabled'] = merged.enabled;
    }
    if (updates.prompt !== undefined) {
      setClauses.push('prompt = :prompt');
      attrValues[':prompt'] = merged.prompt;
    }
    if (updates.flexWindowMinutes !== undefined) {
      setClauses.push('flexWindowMinutes = :flex');
      attrValues[':flex'] = merged.flexWindowMinutes;
    }
    if (updates.maxRetries !== undefined) {
      setClauses.push('maxRetries = :retries');
      attrValues[':retries'] = merged.maxRetries;
    }

    const expressionAttributeNames: Record<string, string> = {};
    if (updates.name !== undefined) expressionAttributeNames['#n'] = 'name';
    if (updates.timezone !== undefined) expressionAttributeNames['#tz'] = 'timezone';

    await this.config.dynamodb.update({
      TableName: this.config.schedulesTableName,
      Key: { PK: `TENANT#${tenantId}`, SK: `SCHEDULE#${scheduleId}` },
      UpdateExpression: `SET ${setClauses.join(', ')}`,
      ExpressionAttributeValues: attrValues,
      ExpressionAttributeNames: Object.keys(expressionAttributeNames).length
        ? expressionAttributeNames
        : undefined,
      ConditionExpression: 'attribute_exists(PK)',
    });

    // Re-apply the EB schedule only when fields that affect dispatch change.
    // `name`, `description`, and `prompt` live purely in DDB.
    const needsSchedulerSync =
      updates.expression !== undefined ||
      updates.timezone !== undefined ||
      updates.enabled !== undefined ||
      updates.flexWindowMinutes !== undefined ||
      updates.maxRetries !== undefined;

    if (needsSchedulerSync) {
      await this.config.scheduler.updateSchedule({
        Name: this.schedulerName(tenantId, scheduleId),
        GroupName: this.config.schedulerGroupName,
        ScheduleExpression: merged.expression,
        ScheduleExpressionTimezone: merged.timezone,
        State: merged.enabled ? 'ENABLED' : 'DISABLED',
        FlexibleTimeWindow: merged.flexWindowMinutes
          ? { Mode: 'FLEXIBLE', MaximumWindowInMinutes: merged.flexWindowMinutes }
          : { Mode: 'OFF' },
        Target: {
          Arn: this.config.schedulerTargetArn,
          RoleArn: this.config.schedulerRoleArn,
          Input: JSON.stringify({ tenantId, scheduleId }),
          RetryPolicy: {
            MaximumEventAgeInSeconds: 3600,
            MaximumRetryAttempts: merged.maxRetries,
          },
          DeadLetterConfig: this.config.schedulerDlqArn
            ? { Arn: this.config.schedulerDlqArn }
            : undefined,
        },
        ActionAfterCompletion: merged.expressionType === 'at' ? 'DELETE' : 'NONE',
      });
    }

    return merged;
  }

  /**
   * Delete a schedule. EB Scheduler is torn down first; only if that succeeds
   * do we remove the DDB row. If the scheduler call fails, the DDB row stays
   * — the operator can retry and we don't end up with an invisible schedule
   * still firing against a deleted target (design §6).
   */
  async deleteSchedule(tenantId: string, scheduleId: string): Promise<void> {
    const existing = await this.getSchedule(tenantId, scheduleId);
    if (!existing) throw new ScheduleNotFoundError(tenantId, scheduleId);

    await this.config.scheduler.deleteSchedule({
      Name: this.schedulerName(tenantId, scheduleId),
      GroupName: this.config.schedulerGroupName,
    });

    await this.config.dynamodb.delete({
      TableName: this.config.schedulesTableName,
      Key: { PK: `TENANT#${tenantId}`, SK: `SCHEDULE#${scheduleId}` },
    });
  }

  async getSchedule(tenantId: string, scheduleId: string): Promise<ScheduleItem | null> {
    const resp = await this.config.dynamodb.get({
      TableName: this.config.schedulesTableName,
      Key: { PK: `TENANT#${tenantId}`, SK: `SCHEDULE#${scheduleId}` },
    });
    const item = resp.Item as (ScheduleItem & { PK?: string; SK?: string }) | undefined;
    if (!item) return null;
    // Defense-in-depth: never return a row whose stored tenantId doesn't
    // match the requested tenantId, even if the PK lookup somehow crossed
    // partitions (shouldn't happen, but CLAUDE.md's GSI anti-pattern guard
    // treats this as mandatory on every read).
    if (item.tenantId !== tenantId) return null;
    const { PK: _pk, SK: _sk, ...rest } = item;
    void _pk;
    void _sk;
    return rest as ScheduleItem;
  }

  async listSchedules(tenantId: string): Promise<ScheduleItem[]> {
    const resp = await this.config.dynamodb.query({
      TableName: this.config.schedulesTableName,
      // Must match the index name declared on the CDK table in
      // infra/lib/orchestration-stack.ts (SchedulesTable). The bare `GSI1`
      // alias caused a live 500 against dev; DDB raises
      // "The table does not have the specified index: GSI1".
      IndexName: 'GSI1-tenant-created',
      KeyConditionExpression: 'GSI1PK = :tid',
      // MANDATORY per CLAUDE.md — GSI keys don't enforce partition isolation
      // on their own on a shared multi-tenant table.
      FilterExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': tenantId },
    });
    return ((resp.Items ?? []) as ScheduleItem[]).filter((i) => i.tenantId === tenantId);
  }

  /**
   * Fetch run history for a schedule.
   *
   * Design-review MED 2: supports pagination.
   *   - `limit`: 1..100 (default 20)
   *   - `nextToken`: opaque base64 of DDB LastEvaluatedKey from a prior page.
   *     Callers treat it as an opaque cursor. Invalid tokens yield an empty
   *     page rather than throwing — an attacker can't learn anything from
   *     feeding garbage back.
   *
   * Returns `{ runs, nextToken }` where `nextToken` is undefined on the
   * final page.
   */
  async getScheduleRuns(
    tenantId: string,
    scheduleId: string,
    options: { limit?: number; nextToken?: string } = {}
  ): Promise<{ runs: ScheduleRun[]; nextToken?: string }> {
    const rawLimit = options.limit ?? 20;
    const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));

    let exclusiveStartKey: Record<string, unknown> | undefined;
    if (options.nextToken) {
      try {
        const decoded = Buffer.from(options.nextToken, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object') {
          exclusiveStartKey = parsed as Record<string, unknown>;
        }
      } catch {
        // Opaque: garbage in → start from the beginning.
        exclusiveStartKey = undefined;
      }
    }

    const resp = await this.config.dynamodb.query({
      TableName: this.config.sessionsTableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'tenantId = :tid',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}`,
        ':skPrefix': `SCHEDRUN#${scheduleId}#`,
        ':tid': tenantId,
      },
      Limit: limit,
      ScanIndexForward: false,
      ExclusiveStartKey: exclusiveStartKey as any,
    });

    const runs = ((resp.Items ?? []) as ScheduleRun[]).filter(
      (r) => r.tenantId === tenantId
    );
    const nextToken = resp.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(resp.LastEvaluatedKey)).toString('base64')
      : undefined;

    return { runs, nextToken };
  }

  /**
   * Compose the EB Scheduler schedule Name (design-review CRITICAL 3).
   *
   * Schedule names are globally unique per ScheduleGroup, so the tenantId
   * MUST be in the name — otherwise two tenants that happened to pick the
   * same UUID (impossibly, but the design-review gate insists on a
   * collision-free construction) would clash.
   *
   * Conceptual form: `${tenantId}#${scheduleId}`. The `#` character is not
   * in the Scheduler name charset ([0-9A-Za-z_.-]{1,64}), so we use `.` as
   * the separator instead — semantically equivalent, Scheduler-legal.
   *
   * Length cap: names are truncated to 64 chars. With a UUIDv4 scheduleId
   * (36 chars) + separator + `t.` prefix that leaves 25 chars for tenantId.
   * Longer tenantIds are truncated; the scheduleId is preserved in full
   * because it's the only side of the pair a humans recognize.
   */
  private schedulerName(tenantId: string, scheduleId: string): string {
    const safe = (s: string) => s.replace(/[^0-9A-Za-z_.-]/g, '_');
    const safeTenant = safe(tenantId);
    const safeId = safe(scheduleId);
    const prefix = 't.';
    const sep = '.';
    // Budget: 64 - prefix - sep - scheduleId length
    const tenantBudget = Math.max(1, 64 - prefix.length - sep.length - safeId.length);
    const tenantPart = safeTenant.slice(0, tenantBudget);
    return `${prefix}${tenantPart}${sep}${safeId}`.slice(0, 64);
  }
}
