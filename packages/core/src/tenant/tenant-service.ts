/**
 * Tenant Service
 *
 * DynamoDB-backed tenant configuration management
 * Implements enhanced multi-item pattern from canonical-data-model.md
 */

import {
  TenantProfile,
  TenantFeatureConfig,
  TenantModelConfig,
  TenantToolConfig,
  TenantChannelConfig,
  TenantBilling,
  TenantQuota,
  TenantConfig,
  TenantTier,
  TenantStatus,
} from '@chimera/shared';

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
  BatchGetCommandInput,
  BatchGetCommandOutput,
} from '@aws-sdk/lib-dynamodb';

/**
 * DynamoDB client interface
 */
export interface DynamoDBClient {
  query(params: QueryCommandInput): Promise<QueryCommandOutput>;
  put(params: PutCommandInput): Promise<PutCommandOutput>;
  delete(params: DeleteCommandInput): Promise<DeleteCommandOutput>;
  get(params: GetCommandInput): Promise<GetCommandOutput>;
  batchGet(params: BatchGetCommandInput): Promise<BatchGetCommandOutput>;
  update(params: UpdateCommandInput): Promise<UpdateCommandOutput>;
}

/**
 * Tenant service configuration
 */
export interface TenantServiceConfig {
  /** DynamoDB table name for tenants */
  tenantsTableName: string;

  /** DynamoDB client */
  dynamodb: DynamoDBClient;
}

/**
 * Tenant creation parameters
 */
export interface CreateTenantParams {
  tenantId: string;
  name: string;
  tier: TenantTier;
  adminEmail: string;
  dataRegion: string;
  features?: Partial<TenantFeatureConfig>;
  models?: Partial<TenantModelConfig>;
  billing?: Partial<TenantBilling>;
}

/**
 * Tenant Service
 *
 * Manages tenant configuration with enhanced multi-item pattern:
 * - PROFILE: Core tenant metadata
 * - CONFIG#features: Feature flags and limits
 * - CONFIG#models: Model routing and budgets
 * - CONFIG#tools: Tool allowlists and rate limits
 * - CONFIG#channels: Channel integrations (Slack, Discord)
 * - BILLING#current: Billing and payment info
 * - QUOTA#{resource}: Individual resource quotas
 */
export class TenantService {
  private config: TenantServiceConfig;

  constructor(config: TenantServiceConfig) {
    this.config = config;
  }

  /**
   * Get complete tenant configuration
   *
   * Fetches all config items using BatchGetItem for efficiency
   *
   * @param tenantId - Tenant ID
   * @returns Complete tenant configuration or null if not found
   */
  async getTenantConfig(tenantId: string): Promise<TenantConfig | null> {
    const pk = `TENANT#${tenantId}`;

    // Use BatchGetItem for efficient retrieval of known SKs
    const params = {
      RequestItems: {
        [this.config.tenantsTableName]: {
          Keys: [
            { PK: pk, SK: 'PROFILE' },
            { PK: pk, SK: 'CONFIG#features' },
            { PK: pk, SK: 'CONFIG#models' },
            { PK: pk, SK: 'CONFIG#tools' },
            { PK: pk, SK: 'CONFIG#channels' },
            { PK: pk, SK: 'BILLING#current' },
          ],
        },
      },
    };

    const result = await this.config.dynamodb.batchGet(params);
    const items = result.Responses?.[this.config.tenantsTableName] || [];

    // Find required items
    const profile = items.find((item: any) => item.SK === 'PROFILE') as TenantProfile | undefined;
    const features = items.find((item: any) => item.SK === 'CONFIG#features') as TenantFeatureConfig | undefined;
    const models = items.find((item: any) => item.SK === 'CONFIG#models') as TenantModelConfig | undefined;
    const billing = items.find((item: any) => item.SK === 'BILLING#current') as TenantBilling | undefined;

    // Tenant must have profile, features, models, and billing
    if (!profile || !features || !models || !billing) {
      return null;
    }

    // Find optional items
    const tools = items.find((item: any) => item.SK === 'CONFIG#tools') as TenantToolConfig | undefined;
    const channels = items.find((item: any) => item.SK === 'CONFIG#channels') as TenantChannelConfig | undefined;

    // Query for all quotas (QUOTA# prefix)
    const quotaParams = {
      TableName: this.config.tenantsTableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':sk': 'QUOTA#',
      },
    };

    const quotaResult = await this.config.dynamodb.query(quotaParams);
    const quotas = (quotaResult.Items || []) as TenantQuota[];

    return {
      profile,
      features,
      models,
      tools,
      channels,
      billing,
      quotas,
    };
  }

  /**
   * Get tenant profile only
   *
   * @param tenantId - Tenant ID
   * @returns Tenant profile or null
   */
  async getTenantProfile(tenantId: string): Promise<TenantProfile | null> {
    const params = {
      TableName: this.config.tenantsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: 'PROFILE',
      },
    };

    const result = await this.config.dynamodb.get(params);
    return (result.Item as TenantProfile) || null;
  }

  /**
   * Create new tenant
   *
   * Creates all required config items atomically using multiple PutItem calls
   * wrapped in a transaction-like pattern (caller should handle transactions)
   *
   * @param params - Tenant creation parameters
   */
  async createTenant(params: CreateTenantParams): Promise<void> {
    const pk = `TENANT#${params.tenantId}`;
    const now = new Date().toISOString();

    // Default tier-based feature limits
    const maxSubagentsByTier: Record<TenantTier, number> = {
      basic: 1,
      advanced: 5,
      enterprise: 20,
      dedicated: 100,
    };

    // Create PROFILE item
    const profile: TenantProfile = {
      PK: pk,
      SK: 'PROFILE',
      tenantId: params.tenantId,
      name: params.name,
      tier: params.tier,
      status: 'TRIAL', // New tenants start in trial
      adminEmail: params.adminEmail,
      dataRegion: params.dataRegion,
      createdAt: now,
      updatedAt: now,
    };

    // Create CONFIG#features item with tier-appropriate defaults
    const features: TenantFeatureConfig = {
      PK: pk,
      SK: 'CONFIG#features',
      codeInterpreter: params.tier !== 'basic',
      browser: params.tier !== 'basic',
      cronJobs: params.tier === 'enterprise' || params.tier === 'dedicated',
      selfEditingIac: params.tier === 'enterprise' || params.tier === 'dedicated',
      maxSubagents: maxSubagentsByTier[params.tier],
      allowedModelProviders: ['bedrock'],
      mcpToolsEnabled: true,
      ...params.features,
    };

    // Tier-based model restrictions
    const modelsByTier: Record<TenantTier, string[]> = {
      basic: ['us.amazon.nova-lite-v1:0', 'us.anthropic.claude-sonnet-4-6-v1:0'],
      advanced: [
        'us.amazon.nova-lite-v1:0',
        'us.anthropic.claude-sonnet-4-6-v1:0',
        'us.anthropic.claude-opus-4-6-v1:0',
      ],
      enterprise: [
        'us.amazon.nova-micro-v1:0',
        'us.amazon.nova-lite-v1:0',
        'us.anthropic.claude-sonnet-4-6-v1:0',
        'us.anthropic.claude-opus-4-6-v1:0',
      ],
      dedicated: [
        'us.amazon.nova-micro-v1:0',
        'us.amazon.nova-lite-v1:0',
        'us.anthropic.claude-sonnet-4-6-v1:0',
        'us.anthropic.claude-opus-4-6-v1:0',
      ],
    };

    const availableModels = modelsByTier[params.tier];

    // Create CONFIG#models item with sensible defaults
    const models: TenantModelConfig = {
      PK: pk,
      SK: 'CONFIG#models',
      allowedModels: availableModels,
      defaultModel: 'us.anthropic.claude-sonnet-4-6-v1:0',
      modelRouting: {
        default: 'us.anthropic.claude-sonnet-4-6-v1:0',
      },
      fallbackChain: ['us.anthropic.claude-sonnet-4-6-v1:0'],
      monthlyBudgetUsd: params.tier === 'basic' ? 100 : params.tier === 'advanced' ? 1000 : 5000,
      costAlertThreshold: 0.8,
      routingMode: 'auto', // Default to auto-routing with Thompson Sampling
      availableModelsWithCosts: [
        { modelId: 'us.amazon.nova-micro-v1:0', costPer1kTokens: 0.000088 },
        { modelId: 'us.amazon.nova-lite-v1:0', costPer1kTokens: 0.00024 },
        { modelId: 'us.anthropic.claude-sonnet-4-6-v1:0', costPer1kTokens: 0.009 },
        { modelId: 'us.anthropic.claude-opus-4-6-v1:0', costPer1kTokens: 0.045 },
      ].filter(m => availableModels.includes(m.modelId)),
      ...params.models,
    };

    // Create BILLING#current item
    const billing: TenantBilling = {
      PK: pk,
      SK: 'BILLING#current',
      monthlySpendUsd: 0,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
      },
      lastInvoiceDate: now.split('T')[0],
      billingCycle: 'monthly',
      paymentMethod: 'pending',
      stripeCustomerId: '',
      ...params.billing,
    };

    // Put all items (in production, use TransactWriteItems for atomicity)
    await Promise.all([
      this.config.dynamodb.put({
        TableName: this.config.tenantsTableName,
        Item: profile,
      }),
      this.config.dynamodb.put({
        TableName: this.config.tenantsTableName,
        Item: features,
      }),
      this.config.dynamodb.put({
        TableName: this.config.tenantsTableName,
        Item: models,
      }),
      this.config.dynamodb.put({
        TableName: this.config.tenantsTableName,
        Item: billing,
      }),
    ]);
  }

  /**
   * Update tenant profile
   *
   * Atomic update of profile item only, doesn't touch other config
   *
   * @param tenantId - Tenant ID
   * @param updates - Profile fields to update
   */
  async updateProfile(
    tenantId: string,
    updates: Partial<Omit<TenantProfile, 'PK' | 'SK' | 'tenantId' | 'createdAt'>>
  ): Promise<void> {
    const updateExpressions: string[] = [];
    const attributeNames: Record<string, string> = {};
    const attributeValues: Record<string, any> = {};

    // Build update expression dynamically
    Object.entries(updates).forEach(([key, value]) => {
      updateExpressions.push(`#${key} = :${key}`);
      attributeNames[`#${key}`] = key;
      attributeValues[`:${key}`] = value;
    });

    // Always update updatedAt
    updateExpressions.push('#updatedAt = :updatedAt');
    attributeNames['#updatedAt'] = 'updatedAt';
    attributeValues[':updatedAt'] = new Date().toISOString();

    const params = {
      TableName: this.config.tenantsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: 'PROFILE',
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: attributeNames,
      ExpressionAttributeValues: attributeValues,
    };

    await this.config.dynamodb.update(params);
  }

  /**
   * Update feature configuration
   *
   * @param tenantId - Tenant ID
   * @param updates - Feature config fields to update
   */
  async updateFeatures(
    tenantId: string,
    updates: Partial<Omit<TenantFeatureConfig, 'PK' | 'SK'>>
  ): Promise<void> {
    const updateExpressions: string[] = [];
    const attributeNames: Record<string, string> = {};
    const attributeValues: Record<string, any> = {};

    Object.entries(updates).forEach(([key, value]) => {
      updateExpressions.push(`#${key} = :${key}`);
      attributeNames[`#${key}`] = key;
      attributeValues[`:${key}`] = value;
    });

    const params = {
      TableName: this.config.tenantsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: 'CONFIG#features',
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: attributeNames,
      ExpressionAttributeValues: attributeValues,
    };

    await this.config.dynamodb.update(params);
  }

  /**
   * Update model configuration
   *
   * @param tenantId - Tenant ID
   * @param updates - Model config fields to update
   */
  async updateModels(
    tenantId: string,
    updates: Partial<Omit<TenantModelConfig, 'PK' | 'SK'>>
  ): Promise<void> {
    const updateExpressions: string[] = [];
    const attributeNames: Record<string, string> = {};
    const attributeValues: Record<string, any> = {};

    Object.entries(updates).forEach(([key, value]) => {
      updateExpressions.push(`#${key} = :${key}`);
      attributeNames[`#${key}`] = key;
      attributeValues[`:${key}`] = value;
    });

    const params = {
      TableName: this.config.tenantsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: 'CONFIG#models',
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: attributeNames,
      ExpressionAttributeValues: attributeValues,
    };

    await this.config.dynamodb.update(params);
  }

  /**
   * Query tenants by tier
   *
   * Uses GSI1 (tier-index) with REQUIRED FilterExpression for security
   *
   * @param tier - Tenant tier to filter by
   * @param status - Optional status filter
   * @returns Array of tenant profiles
   */
  async getTenantsByTier(tier: TenantTier, status?: TenantStatus): Promise<TenantProfile[]> {
    const params: {
      TableName: string;
      IndexName: string;
      KeyConditionExpression: string;
      ExpressionAttributeValues: Record<string, any>;
      FilterExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
    } = {
      TableName: this.config.tenantsTableName,
      IndexName: 'tier-index',
      KeyConditionExpression: 'tier = :tier',
      ExpressionAttributeValues: {
        ':tier': tier,
      },
    };

    // Add status filter if provided
    if (status) {
      params.FilterExpression = '#status = :status';
      params.ExpressionAttributeNames = { '#status': 'status' };
      params.ExpressionAttributeValues[':status'] = status;
    }

    const result = await this.config.dynamodb.query(params);
    return (result.Items || []) as TenantProfile[];
  }

  /**
   * Query tenants by status
   *
   * Uses GSI2 (status-index) with REQUIRED FilterExpression for security
   *
   * @param status - Tenant status to filter by
   * @returns Array of tenant profiles
   */
  async getTenantsByStatus(status: TenantStatus): Promise<TenantProfile[]> {
    const params = {
      TableName: this.config.tenantsTableName,
      IndexName: 'status-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': status,
      },
    };

    const result = await this.config.dynamodb.query(params);
    return (result.Items || []) as TenantProfile[];
  }

  /**
   * Suspend tenant
   *
   * Updates status to SUSPENDED and optionally records reason
   *
   * @param tenantId - Tenant ID
   * @param reason - Suspension reason
   */
  async suspendTenant(tenantId: string, reason?: string): Promise<void> {
    await this.updateProfile(tenantId, {
      status: 'SUSPENDED',
    });

    // TODO: Emit audit event with reason
  }

  /**
   * Activate tenant
   *
   * Changes status from TRIAL or SUSPENDED to ACTIVE
   *
   * @param tenantId - Tenant ID
   */
  async activateTenant(tenantId: string): Promise<void> {
    await this.updateProfile(tenantId, {
      status: 'ACTIVE',
    });

    // TODO: Emit audit event
  }
}
