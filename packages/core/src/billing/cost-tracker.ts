/**
 * Cost Tracker
 *
 * Monthly cost accumulation and tracking for tenant billing
 * Implements cost-tracking table schema from canonical-data-model.md
 */

import { MonthlyCost, CostBreakdown, ModelTokenUsage, CostSummary } from '@chimera/shared';

import type {
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';

/**
 * DynamoDB client interface
 */
export interface DynamoDBClient {
  get(params: GetCommandInput): Promise<GetCommandOutput>;
  put(params: PutCommandInput): Promise<PutCommandOutput>;
  update(params: UpdateCommandInput): Promise<UpdateCommandOutput>;
  query(params: QueryCommandInput): Promise<QueryCommandOutput>;
}

/**
 * Cost tracker configuration
 */
export interface CostTrackerConfig {
  /** DynamoDB table name for cost tracking */
  costTrackingTableName: string;

  /** DynamoDB client */
  dynamodb: DynamoDBClient;
}

/**
 * Record cost parameters
 */
export interface RecordCostParams {
  tenantId: string;
  service: string; // e.g., "bedrock-inference", "dynamodb"
  costUsd: number;
  modelId?: string; // Optional: for bedrock-inference costs
  inputTokens?: number;
  outputTokens?: number;
  requestCount?: number;
}

/**
 * Cost Tracker
 *
 * Tracks monthly costs per tenant with breakdown by:
 * - Service (bedrock, dynamodb, s3, cloudwatch)
 * - Model (for bedrock-inference)
 * - Token usage (input/output)
 *
 * Uses atomic DynamoDB updates to accumulate costs throughout the month
 */
export class CostTracker {
  private config: CostTrackerConfig;

  constructor(config: CostTrackerConfig) {
    this.config = config;
  }

  /**
   * Get current period string (YYYY-MM)
   *
   * @param date - Reference date (default: now)
   * @returns Period string in YYYY-MM format
   */
  private getCurrentPeriod(date: Date = new Date()): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  /**
   * Calculate TTL for cost record (2 years from period end)
   *
   * @param period - Period string (YYYY-MM)
   * @returns Unix timestamp
   */
  private calculateTTL(period: string): number {
    const [year, month] = period.split('-').map(Number);

    // Last day of the period month
    const periodEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59));

    // Add 2 years
    const ttlDate = new Date(periodEnd);
    ttlDate.setUTCFullYear(ttlDate.getUTCFullYear() + 2);

    return Math.floor(ttlDate.getTime() / 1000);
  }

  /**
   * Get monthly cost record
   *
   * @param tenantId - Tenant ID
   * @param period - Period string (YYYY-MM), defaults to current month
   * @returns Monthly cost record or null
   */
  async getMonthlyCost(tenantId: string, period?: string): Promise<MonthlyCost | null> {
    const targetPeriod = period || this.getCurrentPeriod();

    const params = {
      TableName: this.config.costTrackingTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `PERIOD#${targetPeriod}`,
      },
    };

    const result = await this.config.dynamodb.get(params);
    return (result.Item as MonthlyCost) || null;
  }

  /**
   * Initialize monthly cost record
   *
   * Creates a new record with zero costs (idempotent)
   *
   * @param tenantId - Tenant ID
   * @param period - Period string (YYYY-MM)
   */
  async initializePeriod(tenantId: string, period: string): Promise<void> {
    const cost: MonthlyCost = {
      PK: `TENANT#${tenantId}`,
      SK: `PERIOD#${period}`,
      period,
      totalCostUsd: 0,
      breakdown: {},
      tokenUsage: {},
      requestCount: 0,
      lastUpdated: new Date().toISOString(),
      budgetExceeded: false,
      ttl: this.calculateTTL(period),
    };

    const params = {
      TableName: this.config.costTrackingTableName,
      Item: cost,
      ConditionExpression: 'attribute_not_exists(PK)', // Only create if doesn't exist
    };

    try {
      await this.config.dynamodb.put(params);
    } catch (error: any) {
      // Ignore if already exists
      if (error.name !== 'ConditionalCheckFailedException') {
        throw error;
      }
    }
  }

  /**
   * Record cost for a service
   *
   * Atomically increments cost totals for the current period
   *
   * @param params - Cost recording parameters
   */
  async recordCost(params: RecordCostParams): Promise<void> {
    const period = this.getCurrentPeriod();
    const { tenantId, service, costUsd, modelId, inputTokens, outputTokens, requestCount = 1 } = params;

    // Ensure period is initialized
    await this.initializePeriod(tenantId, period);

    // Build update expression dynamically
    const updateExpressions: string[] = [
      'totalCostUsd = if_not_exists(totalCostUsd, :zero) + :cost',
      'lastUpdated = :now',
      'requestCount = if_not_exists(requestCount, :zero) + :reqCount',
    ];

    const attributeValues: Record<string, any> = {
      ':zero': 0,
      ':cost': costUsd,
      ':now': new Date().toISOString(),
      ':reqCount': requestCount,
    };

    // Increment service-specific cost in breakdown
    updateExpressions.push(`breakdown.#service = if_not_exists(breakdown.#service, :zero) + :cost`);

    const attributeNames: Record<string, string> = {
      '#service': service,
    };

    // If model-specific (bedrock-inference), track token usage
    if (modelId && (inputTokens !== undefined || outputTokens !== undefined)) {
      updateExpressions.push(
        `tokenUsage.#model.#input = if_not_exists(tokenUsage.#model.#input, :zero) + :inputTokens`,
        `tokenUsage.#model.#output = if_not_exists(tokenUsage.#model.#output, :zero) + :outputTokens`,
        `tokenUsage.#model.cost = if_not_exists(tokenUsage.#model.cost, :zero) + :cost`
      );

      attributeNames['#model'] = modelId;
      attributeNames['#input'] = 'input';
      attributeNames['#output'] = 'output';

      attributeValues[':inputTokens'] = inputTokens || 0;
      attributeValues[':outputTokens'] = outputTokens || 0;
    }

    const updateParams = {
      TableName: this.config.costTrackingTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `PERIOD#${period}`,
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: attributeNames,
      ExpressionAttributeValues: attributeValues,
      ReturnValues: 'ALL_NEW' as const,
    };

    await this.config.dynamodb.update(updateParams);
  }

  /**
   * Get cost summary for tenant
   *
   * Includes current spend, budget comparison, and top cost drivers
   *
   * @param tenantId - Tenant ID
   * @param budgetLimitUsd - Monthly budget limit
   * @param period - Optional period (defaults to current month)
   * @returns Cost summary
   */
  async getCostSummary(tenantId: string, budgetLimitUsd: number, period?: string): Promise<CostSummary> {
    const targetPeriod = period || this.getCurrentPeriod();
    const cost = await this.getMonthlyCost(tenantId, targetPeriod);

    if (!cost) {
      return {
        tenantId,
        currentPeriod: targetPeriod,
        totalCostUsd: 0,
        budgetLimitUsd,
        percentUsed: 0,
        projectedMonthlySpend: 0,
        topServices: [],
        topModels: [],
      };
    }

    // Calculate percent used
    const percentUsed = (cost.totalCostUsd / budgetLimitUsd) * 100;

    // Project monthly spend based on days elapsed
    const now = new Date();
    const [year, month] = targetPeriod.split('-').map(Number);
    const periodStart = new Date(Date.UTC(year, month - 1, 1));
    const periodEnd = new Date(Date.UTC(year, month, 0)); // Last day of month
    const daysInMonth = periodEnd.getUTCDate();
    const daysElapsed = now.getUTCDate();
    const projectedMonthlySpend = daysElapsed > 0 ? (cost.totalCostUsd / daysElapsed) * daysInMonth : 0;

    // Top services by cost
    const topServices = Object.entries(cost.breakdown)
      .map(([service, costVal]) => ({ service, cost: costVal as number }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 5);

    // Top models by cost
    const topModels = Object.entries(cost.tokenUsage)
      .map(([model, usage]) => ({ model, cost: (usage as ModelTokenUsage).cost }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 5);

    return {
      tenantId,
      currentPeriod: targetPeriod,
      totalCostUsd: cost.totalCostUsd,
      budgetLimitUsd,
      percentUsed,
      projectedMonthlySpend,
      topServices,
      topModels,
    };
  }

  /**
   * Check if tenant has exceeded budget
   *
   * @param tenantId - Tenant ID
   * @param budgetLimitUsd - Monthly budget limit
   * @param period - Optional period (defaults to current month)
   * @returns True if budget exceeded
   */
  async isBudgetExceeded(tenantId: string, budgetLimitUsd: number, period?: string): Promise<boolean> {
    const cost = await this.getMonthlyCost(tenantId, period);
    return cost ? cost.totalCostUsd >= budgetLimitUsd : false;
  }

  /**
   * Mark budget as exceeded
   *
   * Sets budgetExceeded flag to true (used by budget monitor)
   *
   * @param tenantId - Tenant ID
   * @param period - Optional period (defaults to current month)
   */
  async markBudgetExceeded(tenantId: string, period?: string): Promise<void> {
    const targetPeriod = period || this.getCurrentPeriod();

    const params = {
      TableName: this.config.costTrackingTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `PERIOD#${targetPeriod}`,
      },
      UpdateExpression: 'SET budgetExceeded = :true, lastUpdated = :now',
      ExpressionAttributeValues: {
        ':true': true,
        ':now': new Date().toISOString(),
      },
    };

    await this.config.dynamodb.update(params);
  }

  /**
   * Get cost history for tenant
   *
   * @param tenantId - Tenant ID
   * @param months - Number of months to retrieve (default 12)
   * @returns Array of monthly cost records
   */
  async getCostHistory(tenantId: string, months: number = 12): Promise<MonthlyCost[]> {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setUTCMonth(now.getUTCMonth() - months);

    const startPeriod = this.getCurrentPeriod(startDate);

    const params = {
      TableName: this.config.costTrackingTableName,
      KeyConditionExpression: 'PK = :pk AND SK >= :minSK',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}`,
        ':minSK': `PERIOD#${startPeriod}`,
      },
      ScanIndexForward: false, // Most recent first
      Limit: months,
    };

    const result = await this.config.dynamodb.query(params);
    return (result.Items || []) as MonthlyCost[];
  }
}
