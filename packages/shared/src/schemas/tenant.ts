/**
 * Zod schemas for tenant boundary types.
 *
 * These schemas exist so that any process parsing tenant data from an
 * external source (DynamoDB items, JWT claims, API request/response
 * payloads, S3-stored config) can validate it at the trust boundary
 * rather than trusting TypeScript types it has no way to enforce at
 * runtime.
 *
 * Schemas here MUST stay in sync with the TS types in `../types/tenant.ts`
 * — the TS types remain the source of truth for shape, these schemas
 * mirror them for runtime validation. See the unit tests in
 * `../__tests__/` for the equivalence pin.
 *
 * Only cross-boundary shapes are modeled (TenantProfile, TenantConfig,
 * etc.). Pure internal enums and helper unions are also modeled because
 * they are small, cheap to validate, and are commonly received as strings
 * from external sources.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

export const TenantTierSchema = z.enum([
  'basic',
  'advanced',
  'enterprise',
  'dedicated',
  'premium',
]);

export const TenantStatusSchema = z.enum([
  'ACTIVE',
  'SUSPENDED',
  'TRIAL',
  'CHURNED',
  'PROVISIONING',
  'DEPROVISIONED',
]);

export const ModelRoutingModeSchema = z.enum(['static', 'auto']);

export const QuotaPeriodSchema = z.enum(['monthly', 'daily', 'concurrent']);

// ---------------------------------------------------------------------------
// Profile / items
// ---------------------------------------------------------------------------

export const TenantProfileSchema = z.object({
  PK: z.string(),
  SK: z.literal('PROFILE'),
  tenantId: z.string().min(1),
  name: z.string(),
  tier: TenantTierSchema,
  deploymentModel: z.enum(['shared', 'dedicated']).optional(),
  status: TenantStatusSchema,
  adminEmail: z.string().email(),
  dataRegion: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TenantFeatureConfigSchema = z.object({
  PK: z.string(),
  SK: z.literal('CONFIG#features'),
  codeInterpreter: z.boolean(),
  browser: z.boolean(),
  cronJobs: z.boolean(),
  selfEditingIac: z.boolean(),
  maxSubagents: z.number().int().nonnegative(),
  allowedModelProviders: z.array(z.string()),
  mcpToolsEnabled: z.boolean(),
});

export const ModelRoutingConfigSchema = z.record(z.string(), z.string());

export const ModelWithCostSchema = z.object({
  modelId: z.string(),
  costPer1kTokens: z.number().nonnegative(),
});

export const TenantModelConfigSchema = z.object({
  PK: z.string(),
  SK: z.literal('CONFIG#models'),
  allowedModels: z.array(z.string()),
  defaultModel: z.string(),
  modelRouting: ModelRoutingConfigSchema,
  fallbackChain: z.array(z.string()),
  monthlyBudgetUsd: z.number().nonnegative(),
  costAlertThreshold: z.number().min(0).max(1),
  routingMode: ModelRoutingModeSchema.optional(),
  availableModelsWithCosts: z.array(ModelWithCostSchema).optional(),
});

export const ToolRateLimitConfigSchema = z.object({
  maxPerMinute: z.number().int().positive().optional(),
  maxPerHour: z.number().int().positive().optional(),
});

export const TenantToolConfigSchema = z.object({
  PK: z.string(),
  SK: z.literal('CONFIG#tools'),
  allowedTools: z.array(z.string()),
  deniedTools: z.array(z.string()),
  toolRateLimits: z.record(z.string(), ToolRateLimitConfigSchema),
});

export const SlackChannelConfigSchema = z.object({
  workspaceId: z.string(),
  botTokenArn: z.string(),
});

export const DiscordChannelConfigSchema = z.object({
  guildId: z.string(),
  botTokenArn: z.string(),
});

export const TeamsChannelConfigSchema = z.object({
  tenantId: z.string(),
  appId: z.string(),
  appPasswordArn: z.string(),
});

export const TelegramChannelConfigSchema = z.object({
  botTokenArn: z.string(),
  webhookUrl: z.string().optional(),
});

export const TenantChannelConfigSchema = z.object({
  PK: z.string(),
  SK: z.literal('CONFIG#channels'),
  enabledChannels: z.array(z.string()),
  slack: SlackChannelConfigSchema.optional(),
  discord: DiscordChannelConfigSchema.optional(),
  teams: TeamsChannelConfigSchema.optional(),
  telegram: TelegramChannelConfigSchema.optional(),
});

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const TenantBillingSchema = z.object({
  PK: z.string(),
  SK: z.literal('BILLING#current'),
  monthlySpendUsd: z.number().nonnegative(),
  tokenUsage: TokenUsageSchema,
  lastInvoiceDate: z.string(),
  billingCycle: z.enum(['monthly', 'annual']),
  paymentMethod: z.string(),
  stripeCustomerId: z.string(),
});

export const TenantQuotaSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  resource: z.string(),
  limit: z.number().nonnegative(),
  current: z.number().nonnegative(),
  resetAt: z.string().nullable(),
  period: QuotaPeriodSchema,
});

export const TenantConfigSchema = z.object({
  profile: TenantProfileSchema,
  features: TenantFeatureConfigSchema,
  models: TenantModelConfigSchema,
  tools: TenantToolConfigSchema.optional(),
  channels: TenantChannelConfigSchema.optional(),
  billing: TenantBillingSchema,
  quotas: z.array(TenantQuotaSchema),
});
