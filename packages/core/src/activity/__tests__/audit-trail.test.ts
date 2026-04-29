/**
 * AuditTrail tests — tier-enforced TTL invariant
 *
 * Covers security-review.md M3: audit retention MUST derive from tenant tier.
 * Every audit write must produce a TTL of:
 *   - basic    -> 90 days
 *   - advanced -> 365 days
 *   - premium  -> 7 * 365 days
 *
 * Callers must NOT be able to smuggle in a custom TTL (e.g. a basic tenant
 * writing a 7-year TTL to defeat compliance).
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  AuditTrail,
  calculateAuditTTL,
  AUDIT_TTL_DAYS_BY_TIER,
  type AuditTrailConfig,
  type LogActionParams,
  type DynamoDBClient,
} from '../audit-trail';

class MockDynamoDBClient implements DynamoDBClient {
  public puts: any[] = [];

  async get(_params: any) {
    return { Item: undefined } as any;
  }
  async put(params: any) {
    this.puts.push(params);
    return {} as any;
  }
  async update(_params: any) {
    return {} as any;
  }
  async query(_params: any) {
    return { Items: [] } as any;
  }
  async scan(_params: any) {
    return { Items: [] } as any;
  }
}

function buildParams(
  overrides: Partial<LogActionParams> = {}
): LogActionParams {
  const base: LogActionParams = {
    activityId: 'act-1',
    tenantId: 'tenant-abc',
    tenantTier: 'basic',
    agentId: 'agent-1',
    sessionId: 'sess-1',
    actionType: 'aws.dynamodb.create_table',
    actionCategory: 'create',
    actionIntent: 'Provision test table',
    awsService: 'DynamoDB',
    awsAction: 'CreateTable',
    awsRegion: 'us-east-1',
    awsRequestId: 'req-1',
    resource: {
      type: 'DynamoDB Table',
      name: 'test-table',
    },
    apiCall: {
      requestParameters: {},
      durationMs: 12,
      retryCount: 0,
    },
  };
  return { ...base, ...overrides } as LogActionParams;
}

describe('calculateAuditTTL', () => {
  it('returns 90 days for basic tier', () => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = calculateAuditTTL('basic');
    const delta = ttl - now;
    // Allow 5s of wall-clock drift between Date.now() calls
    expect(delta).toBeGreaterThanOrEqual(90 * 24 * 60 * 60 - 5);
    expect(delta).toBeLessThanOrEqual(90 * 24 * 60 * 60 + 5);
  });

  it('returns 1 year for advanced tier', () => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = calculateAuditTTL('advanced');
    const delta = ttl - now;
    expect(delta).toBeGreaterThanOrEqual(365 * 24 * 60 * 60 - 5);
    expect(delta).toBeLessThanOrEqual(365 * 24 * 60 * 60 + 5);
  });

  it('returns 7 years for premium tier (legacy alias)', () => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = calculateAuditTTL('premium');
    const delta = ttl - now;
    expect(delta).toBeGreaterThanOrEqual(7 * 365 * 24 * 60 * 60 - 5);
    expect(delta).toBeLessThanOrEqual(7 * 365 * 24 * 60 * 60 + 5);
  });

  it('returns 7 years for enterprise tier (canonical SOC2/GDPR retention)', () => {
    // Regression: pre-fix the `enterprise` tier was missing from both the
    // TenantTier union and this lookup map, causing enterprise tenants to
    // silently fall through to the 90-day basic default. See
    // docs/reviews/wave14-system-audit.md finding C2.
    const now = Math.floor(Date.now() / 1000);
    const ttl = calculateAuditTTL('enterprise');
    const delta = ttl - now;
    expect(delta).toBeGreaterThanOrEqual(7 * 365 * 24 * 60 * 60 - 5);
    expect(delta).toBeLessThanOrEqual(7 * 365 * 24 * 60 * 60 + 5);
  });

  it('returns 7 years for dedicated tier', () => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = calculateAuditTTL('dedicated');
    const delta = ttl - now;
    expect(delta).toBeGreaterThanOrEqual(7 * 365 * 24 * 60 * 60 - 5);
    expect(delta).toBeLessThanOrEqual(7 * 365 * 24 * 60 * 60 + 5);
  });

  it('exposes the tier->days mapping as a stable constant', () => {
    expect(AUDIT_TTL_DAYS_BY_TIER).toEqual({
      basic: 90,
      advanced: 365,
      enterprise: 7 * 365,
      dedicated: 7 * 365,
      premium: 7 * 365,
    });
  });

  it('treats enterprise and premium identically (premium is a legacy alias)', () => {
    expect(AUDIT_TTL_DAYS_BY_TIER.enterprise).toBe(AUDIT_TTL_DAYS_BY_TIER.premium);
  });

  it('falls back to basic retention for an unknown tier (defensive)', () => {
    // Runtime type-punning -- simulates a bad call coming from untyped JS
    const now = Math.floor(Date.now() / 1000);
    const ttl = calculateAuditTTL('bogus' as any);
    const delta = ttl - now;
    expect(delta).toBeGreaterThanOrEqual(90 * 24 * 60 * 60 - 5);
    expect(delta).toBeLessThanOrEqual(90 * 24 * 60 * 60 + 5);
  });
});

describe('AuditTrail.logAction — tier-enforced TTL', () => {
  let mock: MockDynamoDBClient;
  let trail: AuditTrail;
  const config: AuditTrailConfig = {
    activityLogsTableName: 'test-audit',
    // Deliberately set a misleading value — the new code path ignores it.
    hotStorageTTLDays: 9999,
    dynamodb: undefined as unknown as DynamoDBClient,
  };

  beforeEach(() => {
    mock = new MockDynamoDBClient();
    trail = new AuditTrail({ ...config, dynamodb: mock });
  });

  it('basic tenant -> 90-day TTL is written to DynamoDB', async () => {
    const before = Math.floor(Date.now() / 1000);
    await trail.logAction(buildParams({ tenantTier: 'basic' }));
    const after = Math.floor(Date.now() / 1000);

    expect(mock.puts.length).toBe(1);
    const item = mock.puts[0].Item;
    const expectedMin = before + 90 * 24 * 60 * 60 - 5;
    const expectedMax = after + 90 * 24 * 60 * 60 + 5;
    expect(item.ttl).toBeGreaterThanOrEqual(expectedMin);
    expect(item.ttl).toBeLessThanOrEqual(expectedMax);
  });

  it('premium tenant -> 7-year TTL is written to DynamoDB', async () => {
    const before = Math.floor(Date.now() / 1000);
    await trail.logAction(buildParams({ tenantTier: 'premium' }));
    const after = Math.floor(Date.now() / 1000);

    const item = mock.puts[0].Item;
    const expectedMin = before + 7 * 365 * 24 * 60 * 60 - 5;
    const expectedMax = after + 7 * 365 * 24 * 60 * 60 + 5;
    expect(item.ttl).toBeGreaterThanOrEqual(expectedMin);
    expect(item.ttl).toBeLessThanOrEqual(expectedMax);
  });

  it('enterprise tenant -> 7-year TTL is written to DynamoDB (C2 regression)', async () => {
    // Pre-fix: enterprise fell through to 90-day basic retention because the
    // TenantTier union was 'basic' | 'advanced' | 'premium' and the lookup
    // had no 'enterprise' key. See wave14-system-audit.md C2.
    const before = Math.floor(Date.now() / 1000);
    await trail.logAction(buildParams({ tenantTier: 'enterprise' }));
    const after = Math.floor(Date.now() / 1000);

    const item = mock.puts[0].Item;
    const expectedMin = before + 7 * 365 * 24 * 60 * 60 - 5;
    const expectedMax = after + 7 * 365 * 24 * 60 * 60 + 5;
    expect(item.ttl).toBeGreaterThanOrEqual(expectedMin);
    expect(item.ttl).toBeLessThanOrEqual(expectedMax);
  });

  it('rejects caller-supplied ttl override (compliance defeat attempt)', async () => {
    // A basic tenant trying to sneak in a 7-year TTL MUST be rejected.
    const oneYearTtl = Math.floor(Date.now() / 1000) + 7 * 365 * 24 * 60 * 60;
    // Build a params object outside the type system to simulate a malicious
    // or buggy caller that bypasses the `ttl?: never` compile-time guard.
    const params = {
      ...buildParams({ tenantTier: 'basic' }),
      ttl: oneYearTtl,
    } as unknown as LogActionParams;

    await expect(trail.logAction(params)).rejects.toThrow(
      /caller-supplied `ttl` is not permitted/
    );
    expect(mock.puts.length).toBe(0);
  });

  it('rejects missing tenantTier (no tier = no retention policy = unsafe)', async () => {
    const params = {
      ...buildParams(),
      tenantTier: undefined,
    } as unknown as LogActionParams;

    await expect(trail.logAction(params)).rejects.toThrow(
      /`tenantTier` is required/
    );
    expect(mock.puts.length).toBe(0);
  });

  it('ignores deprecated hotStorageTTLDays config (tier-based TTL wins)', async () => {
    // Config said 9999 days; advanced tier says 365 days. Tier must win.
    const before = Math.floor(Date.now() / 1000);
    await trail.logAction(buildParams({ tenantTier: 'advanced' }));
    const after = Math.floor(Date.now() / 1000);

    const item = mock.puts[0].Item;
    const expectedMin = before + 365 * 24 * 60 * 60 - 5;
    const expectedMax = after + 365 * 24 * 60 * 60 + 5;
    expect(item.ttl).toBeGreaterThanOrEqual(expectedMin);
    expect(item.ttl).toBeLessThanOrEqual(expectedMax);
    // And definitely not the misleading 9999-day value.
    expect(item.ttl).toBeLessThan(before + 9999 * 24 * 60 * 60);
  });
});

/**
 * SEC-2 — tenant isolation on queryByResource (resource-activity-index GSI).
 *
 * resource-activity-index is keyed on (resourceArn, timestamp). Two tenants
 * that share a resourceArn (account hand-off, cross-account resource
 * sharing, or global ARN collision — e.g. `arn:aws:s3:::shared-bucket`)
 * land in the same GSI partition. Without a FilterExpression on tenantId,
 * tenant A could read tenant B's audit rows.
 *
 * Fix: queryByResource now requires tenantId, pushes
 *   FilterExpression='actionLog.tenantId = :tid'
 * into the DDB Query, and applies a client-side `.filter(log => log.tenantId === tenantId)`
 * as defense-in-depth.
 */
class CapturingDynamoDBClient implements DynamoDBClient {
  public lastQuery: any = null;
  public queryResult: { Items: any[] } = { Items: [] };

  async get(_params: any) {
    return { Item: undefined } as any;
  }
  async put(_params: any) {
    return {} as any;
  }
  async update(_params: any) {
    return {} as any;
  }
  async query(params: any) {
    this.lastQuery = params;
    return this.queryResult as any;
  }
  async scan(_params: any) {
    return { Items: [] } as any;
  }
}

function buildActionLogItem(
  tenantId: string,
  resourceArn: string,
  actionId: string
): any {
  const timestamp = new Date().toISOString();
  return {
    PK: `TENANT#${tenantId}`,
    SK: `ACTION#${timestamp}#${actionId}`,
    actionId,
    activityId: 'act-1',
    actionType: 'aws.s3.put_object',
    actionCategory: 'update',
    timestamp,
    resourceArn,
    resourceName: 'shared-bucket',
    awsService: 'S3',
    awsAction: 'PutObject',
    estimatedMonthlyCost: 0,
    ttl: 0,
    actionLog: {
      actionId,
      activityId: 'act-1',
      tenantId,
      agentId: 'agent-1',
      sessionId: 'sess-1',
      timestamp,
      actionType: 'aws.s3.put_object',
      actionCategory: 'update',
      actionIntent: '',
      awsService: 'S3',
      awsAction: 'PutObject',
      awsRegion: 'us-east-1',
      awsRequestId: 'req-1',
      awsEventTime: timestamp,
      resource: {
        type: 'S3 Bucket',
        name: 'shared-bucket',
        arn: resourceArn,
      },
      apiCall: { requestParameters: {}, durationMs: 1, retryCount: 0 },
      cost: {
        immediate: 0,
        estimatedMonthly: 0,
        estimatedAnnual: 0,
        confidence: 'low',
        source: 'estimate',
      },
      executionContext: { traceId: 't-1' },
      tags: {},
      result: 'success',
    },
  };
}

describe('AuditTrail.queryByResource — tenant isolation (SEC-2)', () => {
  let ddb: CapturingDynamoDBClient;
  let trail: AuditTrail;

  beforeEach(() => {
    ddb = new CapturingDynamoDBClient();
    trail = new AuditTrail({
      activityLogsTableName: 'test-audit',
      hotStorageTTLDays: 90,
      dynamodb: ddb,
    });
  });

  it('pushes FilterExpression=actionLog.tenantId and :tid ExpressionAttributeValue into the DDB Query', async () => {
    await trail.queryByResource({
      tenantId: 'tenant-A',
      resourceArn: 'arn:aws:s3:::shared-bucket',
    });

    expect(ddb.lastQuery).not.toBeNull();
    expect(ddb.lastQuery.IndexName).toBe('resource-activity-index');
    expect(ddb.lastQuery.FilterExpression).toBe('actionLog.tenantId = :tid');
    expect(ddb.lastQuery.ExpressionAttributeValues[':tid']).toBe('tenant-A');
    expect(ddb.lastQuery.ExpressionAttributeValues[':arn']).toBe(
      'arn:aws:s3:::shared-bucket'
    );
  });

  it('does not return rows whose tenantId does not match the caller (two tenants on the same resourceArn)', async () => {
    // Simulate two tenants sharing a resourceArn in the same GSI partition.
    // If the FilterExpression leaked, the client-side filter is the last
    // line of defense — assert that even if DDB returned both rows, only
    // tenant-A sees tenant-A's.
    ddb.queryResult = {
      Items: [
        buildActionLogItem('tenant-A', 'arn:aws:s3:::shared-bucket', 'act-A'),
        buildActionLogItem('tenant-B', 'arn:aws:s3:::shared-bucket', 'act-B'),
      ],
    };

    const results = await trail.queryByResource({
      tenantId: 'tenant-A',
      resourceArn: 'arn:aws:s3:::shared-bucket',
    });

    expect(results).toHaveLength(1);
    expect(results[0].tenantId).toBe('tenant-A');
    expect(results[0].actionId).toBe('act-A');
    // Symmetric: tenant-B querying the same ARN must not see tenant-A.
    const resultsB = await trail.queryByResource({
      tenantId: 'tenant-B',
      resourceArn: 'arn:aws:s3:::shared-bucket',
    });
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].tenantId).toBe('tenant-B');
    expect(resultsB[0].actionId).toBe('act-B');
  });

  it('rejects empty tenantId with a clear error (no accidental unfiltered GSI read)', async () => {
    await expect(
      trail.queryByResource({
        tenantId: '',
        resourceArn: 'arn:aws:s3:::shared-bucket',
      })
    ).rejects.toThrow(/tenantId is required/);

    // And the DDB query must not have fired.
    expect(ddb.lastQuery).toBeNull();
  });

  it('getResourceLifecycle forwards tenantId to queryByResource (no silent tenant fallthrough)', async () => {
    await trail.getResourceLifecycle(
      'tenant-A',
      'arn:aws:s3:::shared-bucket'
    );

    expect(ddb.lastQuery.FilterExpression).toBe('actionLog.tenantId = :tid');
    expect(ddb.lastQuery.ExpressionAttributeValues[':tid']).toBe('tenant-A');
  });
});
