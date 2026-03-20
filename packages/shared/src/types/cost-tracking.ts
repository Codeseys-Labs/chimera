/**
 * Cost tracking types for AWS Chimera billing and budget management
 *
 * Based on canonical-data-model.md specification (Table 5: clawcore-cost-tracking)
 */

/**
 * Token usage by model
 */
export interface ModelTokenUsage {
  input: number;
  output: number;
  cost: number; // USD
}

/**
 * Cost breakdown by service
 */
export interface CostBreakdown {
  'bedrock-inference'?: number;
  'agentcore-runtime'?: number;
  'dynamodb'?: number;
  's3-storage'?: number;
  'cloudwatch'?: number;
  [service: string]: number | undefined; // Allow additional services
}

/**
 * Monthly cost tracking record
 */
export interface MonthlyCost {
  PK: string; // TENANT#{tenantId}
  SK: string; // PERIOD#{yyyy-mm}
  period: string; // YYYY-MM
  totalCostUsd: number;
  breakdown: CostBreakdown;
  tokenUsage: Record<string, ModelTokenUsage>; // Model ID -> usage
  requestCount: number;
  lastUpdated: string; // ISO 8601
  budgetExceeded: boolean;
  ttl: number; // Unix timestamp (2 years from period end)
}

/**
 * Cost alert threshold
 */
export interface CostAlert {
  tenantId: string;
  period: string;
  currentSpend: number;
  budgetLimit: number;
  thresholdPercent: number; // 0-1
  triggeredAt: string; // ISO 8601
  notificationSent: boolean;
}

/**
 * Cost summary
 */
export interface CostSummary {
  tenantId: string;
  currentPeriod: string;
  totalCostUsd: number;
  budgetLimitUsd: number;
  percentUsed: number; // 0-100
  projectedMonthlySpend: number;
  topServices: Array<{ service: string; cost: number }>;
  topModels: Array<{ model: string; cost: number }>;
}
