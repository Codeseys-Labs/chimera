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
