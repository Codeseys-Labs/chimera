/**
 * Quota Manager
 *
 * Manages tenant resource quotas with atomic increment/decrement operations
 * Implements quota checking and enforcement from canonical-data-model.md
 */

import { TenantQuota, QuotaPeriod } from '@chimera/shared';

/**
 * DynamoDB client interface
 */
export interface DynamoDBClient {
  query(params: any): Promise<any>;
  put(params: any): Promise<any>;
  update(params: any): Promise<any>;
  get(params: any): Promise<any>;
}

/**
 * Quota manager configuration
 */
export interface QuotaManagerConfig {
  /** DynamoDB table name for tenants */
  tenantsTableName: string;

  /** DynamoDB client */
  dynamodb: DynamoDBClient;
}

/**
 * Quota check result
 */
export interface QuotaCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt?: string;
  period: QuotaPeriod;
}

/**
 * Quota consumption parameters
 */
export interface ConsumeQuotaParams {
  tenantId: string;
  resource: string;
  amount?: number; // Default 1
}

/**
 * Create quota parameters
 */
export interface CreateQuotaParams {
  tenantId: string;
  resource: string;
  limit: number;
  period: QuotaPeriod;
  resetAt?: string; // Required for monthly/daily, null for concurrent
}

/**
 * Quota Manager
 *
 * Manages resource quotas for tenants:
 * - API requests (monthly reset)
 * - Agent sessions (concurrent limit, no reset)
 * - Storage usage (concurrent limit)
 * - Token usage (monthly reset)
 *
 * Uses atomic DynamoDB operations to prevent race conditions
 */
export class QuotaManager {
  private config: QuotaManagerConfig;

  constructor(config: QuotaManagerConfig) {
    this.config = config;
  }

  /**
   * Get quota for a specific resource
   *
   * @param tenantId - Tenant ID
   * @param resource - Resource name (e.g., "api-requests", "agent-sessions")
   * @returns Quota details or null if not found
   */
  async getQuota(tenantId: string, resource: string): Promise<TenantQuota | null> {
    const params = {
      TableName: this.config.tenantsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `QUOTA#${resource}`,
      },
    };

    const result = await this.config.dynamodb.get(params);
    return (result.Item as TenantQuota) || null;
  }

  /**
   * Get all quotas for a tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of quota items
   */
  async getAllQuotas(tenantId: string): Promise<TenantQuota[]> {
    const params = {
      TableName: this.config.tenantsTableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}`,
        ':sk': 'QUOTA#',
      },
    };

    const result = await this.config.dynamodb.query(params);
    return (result.Items || []) as TenantQuota[];
  }

  /**
   * Check if tenant has available quota
   *
   * @param tenantId - Tenant ID
   * @param resource - Resource name
   * @param amount - Amount to check (default 1)
   * @returns Quota check result
   */
  async checkQuota(tenantId: string, resource: string, amount: number = 1): Promise<QuotaCheckResult> {
    const quota = await this.getQuota(tenantId, resource);

    if (!quota) {
      // No quota configured = unlimited
      return {
        allowed: true,
        remaining: Infinity,
        limit: Infinity,
        period: 'concurrent',
      };
    }

    // Check if quota needs reset (for monthly/daily periods)
    if (quota.resetAt && new Date(quota.resetAt) < new Date()) {
      // Quota period expired, reset to zero
      await this.resetQuota(tenantId, resource);
      return {
        allowed: amount <= quota.limit,
        remaining: quota.limit - amount,
        limit: quota.limit,
        resetAt: quota.resetAt,
        period: quota.period,
      };
    }

    const remaining = quota.limit - quota.current;
    const allowed = remaining >= amount;

    return {
      allowed,
      remaining,
      limit: quota.limit,
      resetAt: quota.resetAt || undefined,
      period: quota.period,
    };
  }

  /**
   * Consume quota (increment current usage)
   *
   * Uses atomic UpdateItem with ConditionExpression to prevent over-consumption
   *
   * @param params - Consumption parameters
   * @returns True if quota consumed, false if insufficient
   * @throws Error if quota would be exceeded
   */
  async consumeQuota(params: ConsumeQuotaParams): Promise<boolean> {
    const { tenantId, resource, amount = 1 } = params;

    try {
      const updateParams = {
        TableName: this.config.tenantsTableName,
        Key: {
          PK: `TENANT#${tenantId}`,
          SK: `QUOTA#${resource}`,
        },
        UpdateExpression: 'SET #current = #current + :amount',
        ConditionExpression: '#current + :amount <= #limit',
        ExpressionAttributeNames: {
          '#current': 'current',
          '#limit': 'limit',
        },
        ExpressionAttributeValues: {
          ':amount': amount,
        },
        ReturnValues: 'ALL_NEW',
      };

      await this.config.dynamodb.update(updateParams);
      return true;
    } catch (error: any) {
      // ConditionalCheckFailedException = quota exceeded
      if (error.name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Release quota (decrement current usage)
   *
   * Used when concurrent resources are freed (e.g., agent session ends)
   *
   * @param params - Release parameters
   */
  async releaseQuota(params: ConsumeQuotaParams): Promise<void> {
    const { tenantId, resource, amount = 1 } = params;

    const updateParams = {
      TableName: this.config.tenantsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `QUOTA#${resource}`,
      },
      UpdateExpression: 'SET #current = if_not_exists(#current, :zero) - :amount',
      ConditionExpression: '#current >= :amount', // Prevent negative values
      ExpressionAttributeNames: {
        '#current': 'current',
      },
      ExpressionAttributeValues: {
        ':amount': amount,
        ':zero': 0,
      },
    };

    try {
      await this.config.dynamodb.update(updateParams);
    } catch (error: any) {
      // Ignore if quota is already zero
      if (error.name !== 'ConditionalCheckFailedException') {
        throw error;
      }
    }
  }

  /**
   * Reset quota to zero (used when period expires)
   *
   * @param tenantId - Tenant ID
   * @param resource - Resource name
   * @param newResetAt - Optional new reset timestamp (for monthly/daily periods)
   */
  async resetQuota(tenantId: string, resource: string, newResetAt?: string): Promise<void> {
    const updateExpressions = ['#current = :zero'];
    const attributeValues: any = { ':zero': 0 };

    if (newResetAt) {
      updateExpressions.push('#resetAt = :resetAt');
      attributeValues[':resetAt'] = newResetAt;
    }

    const params = {
      TableName: this.config.tenantsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `QUOTA#${resource}`,
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: {
        '#current': 'current',
        ...(newResetAt ? { '#resetAt': 'resetAt' } : {}),
      },
      ExpressionAttributeValues: attributeValues,
    };

    await this.config.dynamodb.update(params);
  }

  /**
   * Create or update quota
   *
   * @param params - Quota parameters
   */
  async setQuota(params: CreateQuotaParams): Promise<void> {
    const quota: TenantQuota = {
      PK: `TENANT#${params.tenantId}`,
      SK: `QUOTA#${params.resource}`,
      resource: params.resource,
      limit: params.limit,
      current: 0,
      resetAt: params.resetAt || null,
      period: params.period,
    };

    const putParams = {
      TableName: this.config.tenantsTableName,
      Item: quota,
    };

    await this.config.dynamodb.put(putParams);
  }

  /**
   * Update quota limit (without resetting current usage)
   *
   * @param tenantId - Tenant ID
   * @param resource - Resource name
   * @param newLimit - New limit value
   */
  async updateQuotaLimit(tenantId: string, resource: string, newLimit: number): Promise<void> {
    const params = {
      TableName: this.config.tenantsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `QUOTA#${resource}`,
      },
      UpdateExpression: 'SET #limit = :limit',
      ExpressionAttributeNames: {
        '#limit': 'limit',
      },
      ExpressionAttributeValues: {
        ':limit': newLimit,
      },
    };

    await this.config.dynamodb.update(params);
  }

  /**
   * Check quota and consume atomically
   *
   * Convenience method that checks and consumes in one operation
   *
   * @param params - Consumption parameters
   * @returns Quota check result (with allowed=true if consumed, false if denied)
   */
  async checkAndConsume(params: ConsumeQuotaParams): Promise<QuotaCheckResult> {
    const check = await this.checkQuota(params.tenantId, params.resource, params.amount);

    if (!check.allowed) {
      return check;
    }

    const consumed = await this.consumeQuota(params);

    return {
      ...check,
      allowed: consumed,
    };
  }

  /**
   * Calculate next reset date for monthly quota
   *
   * @param referenceDate - Reference date (default: now)
   * @returns ISO 8601 timestamp for first day of next month at midnight UTC
   */
  calculateMonthlyReset(referenceDate: Date = new Date()): string {
    const nextMonth = new Date(referenceDate);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    nextMonth.setUTCDate(1);
    nextMonth.setUTCHours(0, 0, 0, 0);
    return nextMonth.toISOString();
  }

  /**
   * Calculate next reset date for daily quota
   *
   * @param referenceDate - Reference date (default: now)
   * @returns ISO 8601 timestamp for next day at midnight UTC
   */
  calculateDailyReset(referenceDate: Date = new Date()): string {
    const nextDay = new Date(referenceDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    nextDay.setUTCHours(0, 0, 0, 0);
    return nextDay.toISOString();
  }
}
