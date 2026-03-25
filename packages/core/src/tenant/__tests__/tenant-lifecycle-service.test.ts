/**
 * Tests for TenantLifecycleService
 *
 * Validates tier upgrade/downgrade logic:
 * - Feature flags updated for new tier
 * - Model pool and budget updated for new tier
 * - Quota limits updated for new tier
 * - Profile tier and status managed correctly
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  TenantLifecycleService,
  TIER_QUOTA_LIMITS,
  type TenantLifecycleServiceConfig,
} from '../tenant-lifecycle-service';

function makeProfile(tenantId: string, tier: string, status = 'ACTIVE') {
  return {
    PK: `TENANT#${tenantId}`,
    SK: 'PROFILE',
    tenantId,
    name: `${tenantId} Corp`,
    tier,
    status,
    adminEmail: `admin@${tenantId}.com`,
    dataRegion: 'us-east-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makeMockDdb(profileItem: any = null) {
  const calls: { op: string; params: any }[] = [];

  const ddb = {
    _calls: calls,
    get: mock(async (params: any) => ({ Item: profileItem })),
    update: mock(async (_params: any) => ({})),
    put: mock(async (_params: any) => ({})),
  };

  return ddb;
}

describe('TenantLifecycleService', () => {
  const TABLE = 'test-tenants';
  const TENANT_ID = 'acme';

  describe('changeTier', () => {
    it('upgrades basic → advanced: updates features, models, quotas, and profile', async () => {
      const profile = makeProfile(TENANT_ID, 'basic');
      const ddb = makeMockDdb(profile);
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: ddb as any });

      const result = await svc.changeTier(TENANT_ID, 'advanced');

      expect(result.previousTier).toBe('basic');
      expect(result.newTier).toBe('advanced');
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.updatedItems).toContain('profile');
      expect(result.updatedItems).toContain('features');
      expect(result.updatedItems).toContain('models');
      expect(result.updatedItems).toContain('quota:agent-sessions');
      expect(result.updatedItems).toContain('quota:api-requests');
      expect(result.updatedItems).toContain('quota:tokens-monthly');

      // Verify update was called for features, models, quotas, and profile (×2 for provisioning)
      expect(ddb.update.mock.calls.length).toBeGreaterThanOrEqual(5);
    });

    it('upgrades advanced → enterprise: grants cronJobs and selfEditingIac', async () => {
      const profile = makeProfile(TENANT_ID, 'advanced');
      const ddb = makeMockDdb(profile);
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: ddb as any });

      await svc.changeTier(TENANT_ID, 'enterprise');

      // Find the CONFIG#features update call
      const featureCall = ddb.update.mock.calls.find((call: any) =>
        call[0]?.Key?.SK === 'CONFIG#features'
      );
      expect(featureCall).toBeDefined();
      const featureValues = featureCall![0].ExpressionAttributeValues;
      expect(featureValues[':cj']).toBe(true);  // cronJobs
      expect(featureValues[':iac']).toBe(true); // selfEditingIac
      expect(featureValues[':ms']).toBe(20);    // maxSubagents
    });

    it('downgrades enterprise → basic: revokes premium features', async () => {
      const profile = makeProfile(TENANT_ID, 'enterprise');
      const ddb = makeMockDdb(profile);
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: ddb as any });

      const result = await svc.changeTier(TENANT_ID, 'basic');

      expect(result.previousTier).toBe('enterprise');
      expect(result.newTier).toBe('basic');

      const featureCall = ddb.update.mock.calls.find((call: any) =>
        call[0]?.Key?.SK === 'CONFIG#features'
      );
      const featureValues = featureCall![0].ExpressionAttributeValues;
      expect(featureValues[':ci']).toBe(false); // codeInterpreter
      expect(featureValues[':br']).toBe(false); // browser
      expect(featureValues[':cj']).toBe(false); // cronJobs
      expect(featureValues[':iac']).toBe(false); // selfEditingIac
      expect(featureValues[':ms']).toBe(1);      // maxSubagents
    });

    it('upgrades basic → advanced: expands model pool', async () => {
      const profile = makeProfile(TENANT_ID, 'basic');
      const ddb = makeMockDdb(profile);
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: ddb as any });

      await svc.changeTier(TENANT_ID, 'advanced');

      const modelCall = ddb.update.mock.calls.find((call: any) =>
        call[0]?.Key?.SK === 'CONFIG#models'
      );
      expect(modelCall).toBeDefined();
      const models: string[] = modelCall![0].ExpressionAttributeValues[':am'];
      expect(models).toContain('us.anthropic.claude-opus-4-6-v1:0');
      expect(modelCall![0].ExpressionAttributeValues[':budget']).toBe(1000);
    });

    it('sets PROVISIONING during change, then ACTIVE on completion', async () => {
      const profile = makeProfile(TENANT_ID, 'basic');
      const ddb = makeMockDdb(profile);
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: ddb as any });

      await svc.changeTier(TENANT_ID, 'advanced');

      // First PROFILE update sets PROVISIONING
      const profileUpdates = ddb.update.mock.calls.filter((call: any) =>
        call[0]?.Key?.SK === 'PROFILE'
      );
      expect(profileUpdates.length).toBe(2);
      expect(profileUpdates[0][0].ExpressionAttributeValues[':status']).toBe('PROVISIONING');
      // Final PROFILE update sets ACTIVE
      expect(profileUpdates[1][0].ExpressionAttributeValues[':status']).toBe('ACTIVE');
      expect(profileUpdates[1][0].ExpressionAttributeValues[':tier']).toBe('advanced');
    });

    it('updates quota limits for all tier resources', async () => {
      const profile = makeProfile(TENANT_ID, 'basic');
      const ddb = makeMockDdb(profile);
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: ddb as any });

      await svc.changeTier(TENANT_ID, 'enterprise');

      const enterpriseLimits = TIER_QUOTA_LIMITS['enterprise'];
      for (const [resource, limit] of Object.entries(enterpriseLimits)) {
        const quotaCall = ddb.update.mock.calls.find((call: any) =>
          call[0]?.Key?.SK === `QUOTA#${resource}`
        );
        expect(quotaCall).toBeDefined();
        expect(quotaCall![0].ExpressionAttributeValues[':limit']).toBe(limit);
      }
    });

    it('throws if tenant not found', async () => {
      const ddb = makeMockDdb(null); // no item returned
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: ddb as any });

      await expect(svc.changeTier('unknown', 'advanced')).rejects.toThrow('Tenant not found: unknown');
    });

    it('throws if tenant already on the requested tier', async () => {
      const profile = makeProfile(TENANT_ID, 'advanced');
      const ddb = makeMockDdb(profile);
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: ddb as any });

      await expect(svc.changeTier(TENANT_ID, 'advanced')).rejects.toThrow(
        `Tenant ${TENANT_ID} is already on tier advanced`
      );
    });

    it('reads tenant before making any writes', async () => {
      const ddb = makeMockDdb(null);
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: ddb as any });

      try { await svc.changeTier(TENANT_ID, 'advanced'); } catch {}

      expect(ddb.get.mock.calls.length).toBe(1);
      // No writes should happen when tenant not found
      expect(ddb.update.mock.calls.length).toBe(0);
    });
  });

  describe('getTierFeatureConfig', () => {
    it('returns basic tier with all features disabled', () => {
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: {} as any });
      const cfg = svc.getTierFeatureConfig('basic');
      expect(cfg.codeInterpreter).toBe(false);
      expect(cfg.browser).toBe(false);
      expect(cfg.cronJobs).toBe(false);
      expect(cfg.selfEditingIac).toBe(false);
      expect(cfg.maxSubagents).toBe(1);
    });

    it('returns dedicated tier with all features enabled', () => {
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: {} as any });
      const cfg = svc.getTierFeatureConfig('dedicated');
      expect(cfg.codeInterpreter).toBe(true);
      expect(cfg.browser).toBe(true);
      expect(cfg.cronJobs).toBe(true);
      expect(cfg.selfEditingIac).toBe(true);
      expect(cfg.maxSubagents).toBe(100);
    });
  });

  describe('getTierModelConfig', () => {
    it('returns basic tier with limited model pool', () => {
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: {} as any });
      const cfg = svc.getTierModelConfig('basic');
      expect(cfg.allowedModels).not.toContain('us.anthropic.claude-opus-4-6-v1:0');
      expect(cfg.monthlyBudgetUsd).toBe(100);
    });

    it('returns enterprise tier with full model pool', () => {
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: {} as any });
      const cfg = svc.getTierModelConfig('enterprise');
      expect(cfg.allowedModels).toContain('us.anthropic.claude-opus-4-6-v1:0');
      expect(cfg.allowedModels).toContain('us.amazon.nova-micro-v1:0');
      expect(cfg.monthlyBudgetUsd).toBe(5000);
    });
  });

  describe('getTierQuotaLimits', () => {
    it('basic tier has minimal agent-sessions quota', () => {
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: {} as any });
      expect(svc.getTierQuotaLimits('basic')['agent-sessions']).toBe(1);
    });

    it('dedicated tier has maximum quota limits', () => {
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: {} as any });
      const limits = svc.getTierQuotaLimits('dedicated');
      expect(limits['agent-sessions']).toBe(100);
      expect(limits['api-requests']).toBe(1_000_000);
    });

    it('quota limits increase with each tier upgrade', () => {
      const svc = new TenantLifecycleService({ tenantsTableName: TABLE, dynamodb: {} as any });
      const tiers = ['basic', 'advanced', 'enterprise', 'dedicated'] as const;
      for (let i = 1; i < tiers.length; i++) {
        const prev = svc.getTierQuotaLimits(tiers[i - 1]);
        const curr = svc.getTierQuotaLimits(tiers[i]);
        expect(curr['agent-sessions']).toBeGreaterThan(prev['agent-sessions']);
        expect(curr['api-requests']).toBeGreaterThan(prev['api-requests']);
      }
    });
  });
});
