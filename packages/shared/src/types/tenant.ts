/**
 * Tenant types for AWS Chimera multi-tenant platform
 *
 * Based on canonical-data-model.md specification
 */

/**
 * Tenant subscription tier
 */
export type TenantTier = 'basic' | 'advanced' | 'enterprise' | 'dedicated';

/**
 * Tenant lifecycle status
 */
export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'TRIAL' | 'CHURNED';

/**
 * Tenant profile (SK=PROFILE)
 */
export interface TenantProfile {
  PK: string; // TENANT#{tenantId}
  SK: 'PROFILE';
  tenantId: string;
  name: string;
  tier: TenantTier;
  status: TenantStatus;
  adminEmail: string;
  dataRegion: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Feature configuration (SK=CONFIG#features)
 */
export interface TenantFeatureConfig {
  PK: string; // TENANT#{tenantId}
  SK: 'CONFIG#features';
  codeInterpreter: boolean;
  browser: boolean;
  cronJobs: boolean;
  selfEditingIac: boolean;
  maxSubagents: number;
  allowedModelProviders: string[];
  mcpToolsEnabled: boolean;
}

/**
 * Model routing configuration
 */
export interface ModelRoutingConfig {
  [priority: string]: string; // e.g., "high-priority": "claude-3-7-sonnet"
}

/**
 * Model configuration (SK=CONFIG#models)
 */
export interface TenantModelConfig {
  PK: string; // TENANT#{tenantId}
  SK: 'CONFIG#models';
  allowedModels: string[];
  defaultModel: string;
  modelRouting: ModelRoutingConfig;
  fallbackChain: string[];
  monthlyBudgetUsd: number;
  costAlertThreshold: number; // 0-1 (e.g., 0.8 = 80%)
}

/**
 * Tool rate limit configuration
 */
export interface ToolRateLimitConfig {
  maxPerMinute?: number;
  maxPerHour?: number;
}

/**
 * Tool configuration (SK=CONFIG#tools)
 */
export interface TenantToolConfig {
  PK: string; // TENANT#{tenantId}
  SK: 'CONFIG#tools';
  allowedTools: string[]; // ["*"] or explicit list
  deniedTools: string[];
  toolRateLimits: Record<string, ToolRateLimitConfig>;
}

/**
 * Slack channel configuration
 */
export interface SlackChannelConfig {
  workspaceId: string;
  botTokenArn: string; // Secrets Manager ARN
}

/**
 * Discord channel configuration
 */
export interface DiscordChannelConfig {
  guildId: string;
  botTokenArn: string; // Secrets Manager ARN
}

/**
 * Microsoft Teams channel configuration
 */
export interface TeamsChannelConfig {
  tenantId: string; // Microsoft Entra (Azure AD) tenant ID
  appId: string; // Bot application ID
  appPasswordArn: string; // Secrets Manager ARN for app password
}

/**
 * Telegram channel configuration
 */
export interface TelegramChannelConfig {
  botTokenArn: string; // Secrets Manager ARN for bot token
  webhookUrl?: string; // Optional webhook URL for bot
}

/**
 * Channel configuration (SK=CONFIG#channels)
 */
export interface TenantChannelConfig {
  PK: string; // TENANT#{tenantId}
  SK: 'CONFIG#channels';
  enabledChannels: string[]; // ["web", "slack", "discord", "teams", "telegram"]
  slack?: SlackChannelConfig;
  discord?: DiscordChannelConfig;
  teams?: TeamsChannelConfig;
  telegram?: TelegramChannelConfig;
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Billing information (SK=BILLING#current)
 */
export interface TenantBilling {
  PK: string; // TENANT#{tenantId}
  SK: 'BILLING#current';
  monthlySpendUsd: number;
  tokenUsage: TokenUsage;
  lastInvoiceDate: string; // YYYY-MM-DD
  billingCycle: 'monthly' | 'annual';
  paymentMethod: string;
  stripeCustomerId: string;
}

/**
 * Resource quota period
 */
export type QuotaPeriod = 'monthly' | 'daily' | 'concurrent';

/**
 * Quota item (SK=QUOTA#{resource})
 */
export interface TenantQuota {
  PK: string; // TENANT#{tenantId}
  SK: string; // QUOTA#{resource}
  resource: string;
  limit: number;
  current: number;
  resetAt: string | null; // ISO 8601 or null for concurrent
  period: QuotaPeriod;
}

/**
 * Complete tenant configuration (all items combined)
 */
export interface TenantConfig {
  profile: TenantProfile;
  features: TenantFeatureConfig;
  models: TenantModelConfig;
  tools?: TenantToolConfig;
  channels?: TenantChannelConfig;
  billing: TenantBilling;
  quotas: TenantQuota[];
}
