/**
 * Tenant Lifecycle Service
 *
 * Handles tenant tier upgrades and downgrades.
 * When tier changes, atomically updates:
 *   - Feature flags (codeInterpreter, browser, cronJobs, selfEditingIac, maxSubagents)
 *   - Model access (allowedModels, monthlyBudgetUsd, availableModelsWithCosts)
 *   - Quota limits (agent-sessions, api-requests, tokens-monthly)
 *   - Profile tier field
 */

import {
  TenantTier,
  TenantFeatureConfig,
  TenantModelConfig,
  ModelWithCost,
} from '@chimera/shared';

import type {
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';

export interface DynamoDBClient {
  get(params: GetCommandInput): Promise<GetCommandOutput>;
  put(params: PutCommandInput): Promise<PutCommandOutput>;
  update(params: UpdateCommandInput): Promise<UpdateCommandOutput>;
}

export interface TenantLifecycleServiceConfig {
  tenantsTableName: string;
  dynamodb: DynamoDBClient;
}

export interface TierChangeResult {
  tenantId: string;
  previousTier: TenantTier;
  newTier: TenantTier;
  changedAt: string;
  updatedItems: string[];
}

/** Feature flags that apply at each tier */
const TIER_FEATURES: Record<TenantTier, Omit<TenantFeatureConfig, 'PK' | 'SK' | 'allowedModelProviders' | 'mcpToolsEnabled'>> = {
  basic: {
    codeInterpreter: false,
    browser: false,
    cronJobs: false,
    selfEditingIac: false,
    maxSubagents: 1,
  },
  advanced: {
    codeInterpreter: true,
    browser: true,
    cronJobs: false,
    selfEditingIac: false,
    maxSubagents: 5,
  },
  enterprise: {
    codeInterpreter: true,
    browser: true,
    cronJobs: true,
    selfEditingIac: true,
    maxSubagents: 20,
  },
  dedicated: {
    codeInterpreter: true,
    browser: true,
    cronJobs: true,
    selfEditingIac: true,
    maxSubagents: 100,
  },
};

const MODEL_COSTS: ModelWithCost[] = [
  { modelId: 'us.amazon.nova-micro-v1:0', costPer1kTokens: 0.000088 },
  { modelId: 'us.amazon.nova-lite-v1:0', costPer1kTokens: 0.00024 },
  { modelId: 'us.anthropic.claude-sonnet-4-6-v1:0', costPer1kTokens: 0.009 },
  { modelId: 'us.anthropic.claude-opus-4-6-v1:0', costPer1kTokens: 0.045 },
];

/** Model pools and monthly budgets per tier — mirrors TenantService.createTenant */
const TIER_MODELS: Record<TenantTier, { allowedModels: string[]; monthlyBudgetUsd: number }> = {
  basic: {
    allowedModels: ['us.amazon.nova-lite-v1:0', 'us.anthropic.claude-sonnet-4-6-v1:0'],
    monthlyBudgetUsd: 100,
  },
  advanced: {
    allowedModels: [
      'us.amazon.nova-lite-v1:0',
      'us.anthropic.claude-sonnet-4-6-v1:0',
      'us.anthropic.claude-opus-4-6-v1:0',
    ],
    monthlyBudgetUsd: 1000,
  },
  enterprise: {
    allowedModels: [
      'us.amazon.nova-micro-v1:0',
      'us.amazon.nova-lite-v1:0',
      'us.anthropic.claude-sonnet-4-6-v1:0',
      'us.anthropic.claude-opus-4-6-v1:0',
    ],
    monthlyBudgetUsd: 5000,
  },
  dedicated: {
    allowedModels: [
      'us.amazon.nova-micro-v1:0',
      'us.amazon.nova-lite-v1:0',
      'us.anthropic.claude-sonnet-4-6-v1:0',
      'us.anthropic.claude-opus-4-6-v1:0',
    ],
    monthlyBudgetUsd: 5000,
  },
};

/** Quota limits per tier for known resources */
export const TIER_QUOTA_LIMITS: Record<TenantTier, Record<string, number>> = {
  basic: {
    'agent-sessions': 1,
    'api-requests': 1_000,
    'tokens-monthly': 1_000_000,
  },
  advanced: {
    'agent-sessions': 5,
    'api-requests': 10_000,
    'tokens-monthly': 10_000_000,
  },
  enterprise: {
    'agent-sessions': 20,
    'api-requests': 100_000,
    'tokens-monthly': 100_000_000,
  },
  dedicated: {
    'agent-sessions': 100,
    'api-requests': 1_000_000,
    'tokens-monthly': 1_000_000_000,
  },
};

export class TenantLifecycleService {
  private config: TenantLifecycleServiceConfig;

  constructor(config: TenantLifecycleServiceConfig) {
    this.config = config;
  }

  /**
   * Change a tenant's subscription tier.
   *
   * Sequence:
   *   1. Read current profile (validates existence and retrieves current tier)
   *   2. Set status → PROVISIONING
   *   3. Update CONFIG#features, CONFIG#models, and quota limits in parallel
   *   4. Update PROFILE with new tier and status → ACTIVE
   *
   * @param tenantId  - Target tenant
   * @param newTier   - Destination tier
   * @returns TierChangeResult describing what changed
   * @throws Error if tenant not found or already on the requested tier
   */
  async changeTier(tenantId: string, newTier: TenantTier): Promise<TierChangeResult> {
    const pk = `TENANT#${tenantId}`;

    // 1. Read current profile
    const profileResult = await this.config.dynamodb.get({
      TableName: this.config.tenantsTableName,
      Key: { PK: pk, SK: 'PROFILE' },
    });

    if (!profileResult.Item) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }

    const currentTier = profileResult.Item['tier'] as TenantTier;

    if (currentTier === newTier) {
      throw new Error(`Tenant ${tenantId} is already on tier ${newTier}`);
    }

    const changedAt = new Date().toISOString();

    // 2. Set status → PROVISIONING
    await this.config.dynamodb.update({
      TableName: this.config.tenantsTableName,
      Key: { PK: pk, SK: 'PROFILE' },
      UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':status': 'PROVISIONING', ':updatedAt': changedAt },
    });

    // 3. Update features, models, and quotas concurrently
    const featureUpdates = TIER_FEATURES[newTier];
    const modelConfig = TIER_MODELS[newTier];
    const availableModelsWithCosts = MODEL_COSTS.filter(m =>
      modelConfig.allowedModels.includes(m.modelId)
    );

    const quotaUpdates = Object.entries(TIER_QUOTA_LIMITS[newTier]).map(([resource, limit]) =>
      this.config.dynamodb.update({
        TableName: this.config.tenantsTableName,
        Key: { PK: pk, SK: `QUOTA#${resource}` },
        UpdateExpression: 'SET #limit = :limit',
        ExpressionAttributeNames: { '#limit': 'limit' },
        ExpressionAttributeValues: { ':limit': limit },
      })
    );

    await Promise.all([
      // Update CONFIG#features
      this.config.dynamodb.update({
        TableName: this.config.tenantsTableName,
        Key: { PK: pk, SK: 'CONFIG#features' },
        UpdateExpression:
          'SET codeInterpreter = :ci, browser = :br, cronJobs = :cj, selfEditingIac = :iac, maxSubagents = :ms',
        ExpressionAttributeValues: {
          ':ci': featureUpdates.codeInterpreter,
          ':br': featureUpdates.browser,
          ':cj': featureUpdates.cronJobs,
          ':iac': featureUpdates.selfEditingIac,
          ':ms': featureUpdates.maxSubagents,
        },
      }),
      // Update CONFIG#models
      this.config.dynamodb.update({
        TableName: this.config.tenantsTableName,
        Key: { PK: pk, SK: 'CONFIG#models' },
        UpdateExpression:
          'SET allowedModels = :am, monthlyBudgetUsd = :budget, availableModelsWithCosts = :amc',
        ExpressionAttributeValues: {
          ':am': modelConfig.allowedModels,
          ':budget': modelConfig.monthlyBudgetUsd,
          ':amc': availableModelsWithCosts,
        },
      }),
      // Update quota limits
      ...quotaUpdates,
    ]);

    // 4. Update PROFILE: set new tier and restore status → ACTIVE
    await this.config.dynamodb.update({
      TableName: this.config.tenantsTableName,
      Key: { PK: pk, SK: 'PROFILE' },
      UpdateExpression: 'SET #tier = :tier, #status = :status, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#tier': 'tier',
        '#status': 'status',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':tier': newTier,
        ':status': 'ACTIVE',
        ':updatedAt': changedAt,
      },
    });

    return {
      tenantId,
      previousTier: currentTier,
      newTier,
      changedAt,
      updatedItems: [
        'profile',
        'features',
        'models',
        ...Object.keys(TIER_QUOTA_LIMITS[newTier]).map(r => `quota:${r}`),
      ],
    };
  }

  /** Returns the feature flags that apply for a given tier */
  getTierFeatureConfig(tier: TenantTier): typeof TIER_FEATURES[TenantTier] {
    return TIER_FEATURES[tier];
  }

  /** Returns the model pool and budget that apply for a given tier */
  getTierModelConfig(tier: TenantTier): typeof TIER_MODELS[TenantTier] {
    return TIER_MODELS[tier];
  }

  /** Returns the quota limits that apply for a given tier */
  getTierQuotaLimits(tier: TenantTier): Record<string, number> {
    return TIER_QUOTA_LIMITS[tier];
  }
}
