/**
 * Tenant schema round-trip tests.
 *
 * For each cross-boundary tenant type:
 *   1. Valid input parses successfully and round-trips to the expected shape.
 *   2. Invalid input is rejected with a Zod error whose issue path points
 *      at the broken field (so consumers get a useful diagnostic).
 */

import { describe, expect, it } from 'bun:test';
import {
  TenantTierSchema,
  TenantStatusSchema,
  TenantProfileSchema,
  TenantFeatureConfigSchema,
  TenantModelConfigSchema,
  TenantBillingSchema,
  TenantConfigSchema,
  TenantQuotaSchema,
} from '../schemas/tenant';

describe('TenantTierSchema', () => {
  it('accepts all canonical tiers plus the legacy "premium" alias', () => {
    for (const tier of ['basic', 'advanced', 'enterprise', 'dedicated', 'premium']) {
      expect(TenantTierSchema.parse(tier)).toBe(tier);
    }
  });

  it('rejects unknown tiers with a useful error', () => {
    const result = TenantTierSchema.safeParse('platinum');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('invalid_enum_value');
    }
  });
});

describe('TenantStatusSchema', () => {
  it('rejects lowercase status strings (canonical form is UPPER)', () => {
    expect(TenantStatusSchema.safeParse('active').success).toBe(false);
    expect(TenantStatusSchema.safeParse('ACTIVE').success).toBe(true);
  });
});

describe('TenantProfileSchema', () => {
  const valid = {
    PK: 'TENANT#t-123',
    SK: 'PROFILE' as const,
    tenantId: 't-123',
    name: 'Acme Corp',
    tier: 'enterprise' as const,
    status: 'ACTIVE' as const,
    adminEmail: 'admin@acme.example',
    dataRegion: 'us-east-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('parses a valid profile and preserves every field', () => {
    const parsed = TenantProfileSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it('accepts optional deploymentModel when present', () => {
    const parsed = TenantProfileSchema.parse({ ...valid, deploymentModel: 'dedicated' });
    expect(parsed.deploymentModel).toBe('dedicated');
  });

  it('rejects an invalid email', () => {
    const result = TenantProfileSchema.safeParse({ ...valid, adminEmail: 'not-an-email' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['adminEmail']);
    }
  });

  it('rejects a missing required field', () => {
    const withoutTenantId: Partial<typeof valid> = { ...valid };
    delete withoutTenantId.tenantId;
    const result = TenantProfileSchema.safeParse(withoutTenantId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes('tenantId'))).toBe(true);
    }
  });
});

describe('TenantFeatureConfigSchema', () => {
  const valid = {
    PK: 'TENANT#t-123',
    SK: 'CONFIG#features' as const,
    codeInterpreter: true,
    browser: false,
    cronJobs: true,
    selfEditingIac: false,
    maxSubagents: 5,
    allowedModelProviders: ['bedrock'],
    mcpToolsEnabled: true,
  };

  it('parses a valid feature config', () => {
    expect(TenantFeatureConfigSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a negative maxSubagents', () => {
    const result = TenantFeatureConfigSchema.safeParse({ ...valid, maxSubagents: -1 });
    expect(result.success).toBe(false);
  });
});

describe('TenantModelConfigSchema', () => {
  const valid = {
    PK: 'TENANT#t-123',
    SK: 'CONFIG#models' as const,
    allowedModels: ['claude-3-5-sonnet'],
    defaultModel: 'claude-3-5-sonnet',
    modelRouting: { 'high-priority': 'claude-3-5-sonnet' },
    fallbackChain: ['claude-3-haiku'],
    monthlyBudgetUsd: 1000,
    costAlertThreshold: 0.8,
  };

  it('parses a valid model config', () => {
    expect(TenantModelConfigSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a costAlertThreshold > 1', () => {
    const result = TenantModelConfigSchema.safeParse({ ...valid, costAlertThreshold: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe('TenantQuotaSchema', () => {
  it('accepts resetAt=null for concurrent quotas', () => {
    const parsed = TenantQuotaSchema.parse({
      PK: 'TENANT#t-123',
      SK: 'QUOTA#concurrent-sessions',
      resource: 'concurrent-sessions',
      limit: 10,
      current: 3,
      resetAt: null,
      period: 'concurrent',
    });
    expect(parsed.resetAt).toBeNull();
  });
});

describe('TenantBillingSchema', () => {
  it('rejects an unknown billingCycle', () => {
    const result = TenantBillingSchema.safeParse({
      PK: 'TENANT#t-123',
      SK: 'BILLING#current',
      monthlySpendUsd: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      lastInvoiceDate: '2026-01-01',
      billingCycle: 'weekly',
      paymentMethod: 'card',
      stripeCustomerId: 'cus_123',
    });
    expect(result.success).toBe(false);
  });
});

describe('TenantConfigSchema (composite)', () => {
  it('parses a complete tenant config with only required sub-sections', () => {
    const parsed = TenantConfigSchema.parse({
      profile: {
        PK: 'TENANT#t-1',
        SK: 'PROFILE',
        tenantId: 't-1',
        name: 'Acme',
        tier: 'basic',
        status: 'ACTIVE',
        adminEmail: 'a@b.co',
        dataRegion: 'us-east-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      features: {
        PK: 'TENANT#t-1',
        SK: 'CONFIG#features',
        codeInterpreter: false,
        browser: false,
        cronJobs: false,
        selfEditingIac: false,
        maxSubagents: 1,
        allowedModelProviders: [],
        mcpToolsEnabled: false,
      },
      models: {
        PK: 'TENANT#t-1',
        SK: 'CONFIG#models',
        allowedModels: [],
        defaultModel: 'claude-3-haiku',
        modelRouting: {},
        fallbackChain: [],
        monthlyBudgetUsd: 0,
        costAlertThreshold: 0.8,
      },
      billing: {
        PK: 'TENANT#t-1',
        SK: 'BILLING#current',
        monthlySpendUsd: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        lastInvoiceDate: '2026-01-01',
        billingCycle: 'monthly',
        paymentMethod: 'card',
        stripeCustomerId: 'cus_123',
      },
      quotas: [],
    });
    expect(parsed.profile.tenantId).toBe('t-1');
    expect(parsed.quotas).toEqual([]);
    expect(parsed.tools).toBeUndefined();
  });

  it('rejects when a nested required section fails validation', () => {
    const result = TenantConfigSchema.safeParse({
      profile: {
        PK: 'TENANT#t-1',
        SK: 'PROFILE',
        tenantId: 't-1',
        name: 'Acme',
        tier: 'mystery-tier', // invalid
        status: 'ACTIVE',
        adminEmail: 'a@b.co',
        dataRegion: 'us-east-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      features: {},
      models: {},
      billing: {},
      quotas: [],
    });
    expect(result.success).toBe(false);
  });
});
