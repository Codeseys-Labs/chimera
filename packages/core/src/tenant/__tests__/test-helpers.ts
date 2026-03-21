/**
 * Test helpers for tenant module tests
 */

import { TenantConfig } from '@chimera/shared';

/**
 * Create mock tenant config for testing
 */
export function createMockTenantConfig(
  tenantId: string,
  tier: 'basic' | 'advanced' | 'enterprise' | 'dedicated' = 'advanced'
): TenantConfig {
  return {
    profile: {
      PK: `TENANT#${tenantId}`,
      SK: 'PROFILE',
      tenantId,
      name: `${tenantId} Corp`,
      tier,
      status: 'ACTIVE',
      adminEmail: `admin@${tenantId}.com`,
      dataRegion: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    features: {
      PK: `TENANT#${tenantId}`,
      SK: 'CONFIG#features',
      codeInterpreter: true,
      browser: true,
      cronJobs: tier === 'enterprise' || tier === 'dedicated',
      selfEditingIac: tier === 'enterprise' || tier === 'dedicated',
      maxSubagents: tier === 'basic' ? 1 : tier === 'advanced' ? 5 : tier === 'enterprise' ? 20 : 100,
      allowedModelProviders: ['bedrock'],
      mcpToolsEnabled: true,
    },
    models: {
      PK: `TENANT#${tenantId}`,
      SK: 'CONFIG#models',
      allowedModels: ['anthropic.claude-3-5-sonnet-20241022-v2:0'],
      defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      modelRouting: { default: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
      fallbackChain: ['anthropic.claude-3-5-sonnet-20241022-v2:0'],
      monthlyBudgetUsd: tier === 'basic' ? 100 : tier === 'advanced' ? 1000 : 5000,
      costAlertThreshold: 0.8,
    },
    billing: {
      PK: `TENANT#${tenantId}`,
      SK: 'BILLING#current',
      monthlySpendUsd: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      lastInvoiceDate: '2026-01-01',
      billingCycle: 'monthly',
      paymentMethod: 'stripe',
      stripeCustomerId: `cus_${tenantId}`,
    },
    quotas: [],
  };
}

/**
 * Create mock DynamoDB client for testing
 */
export function createMockDynamoDBClient() {
  return {
    query: async () => ({ Items: [] }),
    put: async () => ({}),
    delete: async () => ({}),
    get: async () => ({ Item: null }),
    batchGet: async () => ({ Responses: {} }),
    update: async () => ({}),
  };
}

/**
 * Create mock JWT token for testing
 */
export function createMockJWT(claims: any): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = 'mock-signature';
  return `${headerB64}.${payloadB64}.${signature}`;
}
