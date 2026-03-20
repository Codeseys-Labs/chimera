/**
 * Billing Aggregator - Multi-Account Cost Consolidation
 *
 * Aggregates billing data across AWS Organizations member accounts for:
 * - Consolidated cost reporting across linked accounts
 * - Per-account cost allocation and chargeback
 * - Cross-account budget monitoring and alerting
 * - Tenant cost attribution in multi-account deployments
 *
 * Reference: docs/research/aws-account-agent/04-Cost-Explorer-Spending-Analysis.md
 */

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  type Granularity,
  type Metric,
} from '@aws-sdk/client-cost-explorer';
import type { AWSClientFactory } from '../aws-tools/client-factory';

/**
 * Time period for cost queries
 */
export interface BillingTimePeriod {
  readonly start: string; // YYYY-MM-DD
  readonly end: string; // YYYY-MM-DD
}

/**
 * Per-account cost breakdown
 */
export interface AccountCostBreakdown {
  readonly accountId: string;
  readonly accountName?: string;
  readonly totalCost: number;
  readonly byService: Record<string, number>;
  readonly costCurrency: string;
}

/**
 * Aggregated billing result across all accounts
 */
export interface AggregatedBillingResult {
  readonly timePeriod: BillingTimePeriod;
  readonly totalCost: number;
  readonly accountCount: number;
  readonly accounts: AccountCostBreakdown[];
  readonly topServices: Array<{ service: string; cost: number }>;
  readonly costCurrency: string;
}

/**
 * Account budget status
 */
export interface AccountBudgetStatus {
  readonly accountId: string;
  readonly budgetAmount: number;
  readonly actualCost: number;
  readonly forecastedCost: number;
  readonly utilizationPercent: number;
  readonly status: 'OK' | 'WARNING' | 'EXCEEDED';
  readonly timePeriod: BillingTimePeriod;
}

/**
 * Cross-account cost comparison
 */
export interface CostComparison {
  readonly currentPeriod: BillingTimePeriod;
  readonly previousPeriod: BillingTimePeriod;
  readonly currentTotal: number;
  readonly previousTotal: number;
  readonly delta: number;
  readonly deltaPercent: number;
  readonly accountChanges: Array<{
    accountId: string;
    currentCost: number;
    previousCost: number;
    delta: number;
    deltaPercent: number;
  }>;
}

/**
 * Billing Aggregator Configuration
 */
export interface BillingAggregatorConfig {
  /** AWS Client Factory for Cost Explorer client creation */
  clientFactory: AWSClientFactory;

  /** Tenant context for API calls */
  tenantId: string;
  agentId: string;

  /** Management account ID (for consolidated billing) */
  managementAccountId: string;

  /** List of member account IDs to aggregate */
  memberAccountIds?: string[];

  /** Default time period for queries (days) */
  defaultPeriodDays?: number;

  /** Cache TTL in seconds (default: 3600) */
  cacheTTL?: number;
}

/**
 * Billing error codes
 */
export type BillingErrorCode =
  | 'COST_EXPLORER_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'INVALID_TIME_PERIOD'
  | 'ACCOUNT_NOT_FOUND'
  | 'DATA_NOT_AVAILABLE'
  | 'RATE_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR';

/**
 * Billing Aggregator Error
 */
export class BillingError extends Error {
  constructor(
    public readonly code: BillingErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

/**
 * Billing Aggregator Service
 *
 * Provides consolidated billing insights across AWS Organizations accounts:
 * - Multi-account cost aggregation
 * - Per-account cost attribution
 * - Budget monitoring and forecasting
 * - Cost trend analysis
 */
export class BillingAggregator {
  private config: Required<BillingAggregatorConfig>;
  private client: CostExplorerClient | null = null;
  private cache = new Map<string, { data: unknown; expires: number }>();

  constructor(config: BillingAggregatorConfig) {
    this.config = {
      memberAccountIds: [],
      defaultPeriodDays: 30,
      cacheTTL: 3600, // 1 hour
      ...config,
    };
  }

  /**
   * Get Cost Explorer client
   */
  private async getClient(): Promise<CostExplorerClient> {
    if (this.client) {
      return this.client;
    }

    // Cost Explorer is accessible from any region but best practice is us-east-1
    this.client = new CostExplorerClient({
      region: 'us-east-1',
      maxAttempts: 3,
    });

    return this.client;
  }

  /**
   * Get aggregated costs across all member accounts
   */
  async getAggregatedCosts(params: {
    timePeriod: BillingTimePeriod;
    granularity?: 'DAILY' | 'MONTHLY' | 'HOURLY';
    accountIds?: string[];
  }): Promise<AggregatedBillingResult> {
    const cacheKey = `aggregated:${JSON.stringify(params)}`;
    const cached = this.getFromCache<AggregatedBillingResult>(cacheKey);
    if (cached) return cached;

    const client = await this.getClient();
    const accountIds = params.accountIds || this.config.memberAccountIds;

    try {
      // Query costs grouped by linked account and service
      const command = new GetCostAndUsageCommand({
        TimePeriod: {
          Start: params.timePeriod.start,
          End: params.timePeriod.end,
        },
        Granularity: (params.granularity || 'DAILY') as Granularity,
        Metrics: ['UnblendedCost'],
        GroupBy: [
          { Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' },
          { Type: 'DIMENSION', Key: 'SERVICE' },
        ],
        Filter: accountIds.length > 0 ? {
          Dimensions: {
            Key: 'LINKED_ACCOUNT',
            Values: accountIds,
          },
        } : undefined,
      });

      const response = await client.send(command);

      // Aggregate results by account
      // Use mutable temporary type for building data
      type MutableAccountCost = {
        accountId: string;
        accountName?: string;
        totalCost: number;
        byService: Record<string, number>;
        costCurrency: string;
      };
      const accountCosts = new Map<string, MutableAccountCost>();
      let totalCost = 0;
      const serviceCosts = new Map<string, number>();

      for (const result of response.ResultsByTime || []) {
        for (const group of result.Groups || []) {
          const keys = group.Keys || [];
          const accountId = keys[0] || 'unknown';
          const service = keys[1] || 'unknown';
          const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');
          const currency = group.Metrics?.UnblendedCost?.Unit || 'USD';

          totalCost += cost;

          // Update service totals
          serviceCosts.set(service, (serviceCosts.get(service) || 0) + cost);

          // Update account breakdown
          if (!accountCosts.has(accountId)) {
            accountCosts.set(accountId, {
              accountId,
              totalCost: 0,
              byService: {},
              costCurrency: currency,
            });
          }

          const accountData = accountCosts.get(accountId)!;
          accountData.totalCost += cost;
          accountData.byService[service] = (accountData.byService[service] || 0) + cost;
        }
      }

      // Sort services by cost
      const topServices = Array.from(serviceCosts.entries())
        .map(([service, cost]) => ({ service, cost }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10);

      const result: AggregatedBillingResult = {
        timePeriod: params.timePeriod,
        totalCost,
        accountCount: accountCosts.size,
        accounts: Array.from(accountCosts.values()).sort((a, b) => b.totalCost - a.totalCost),
        topServices,
        costCurrency: 'USD',
      };

      this.setCache(cacheKey, result);
      return result;
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * Get costs for a specific account
   */
  async getAccountCosts(params: {
    accountId: string;
    timePeriod: BillingTimePeriod;
    granularity?: 'DAILY' | 'MONTHLY' | 'HOURLY';
  }): Promise<AccountCostBreakdown> {
    const cacheKey = `account:${params.accountId}:${JSON.stringify(params.timePeriod)}`;
    const cached = this.getFromCache<AccountCostBreakdown>(cacheKey);
    if (cached) return cached;

    const client = await this.getClient();

    try {
      const command = new GetCostAndUsageCommand({
        TimePeriod: {
          Start: params.timePeriod.start,
          End: params.timePeriod.end,
        },
        Granularity: (params.granularity || 'DAILY') as Granularity,
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        Filter: {
          Dimensions: {
            Key: 'LINKED_ACCOUNT',
            Values: [params.accountId],
          },
        },
      });

      const response = await client.send(command);

      let totalCost = 0;
      const byService: Record<string, number> = {};

      for (const result of response.ResultsByTime || []) {
        for (const group of result.Groups || []) {
          const service = group.Keys?.[0] || 'unknown';
          const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');
          totalCost += cost;
          byService[service] = (byService[service] || 0) + cost;
        }
      }

      const breakdown: AccountCostBreakdown = {
        accountId: params.accountId,
        totalCost,
        byService,
        costCurrency: 'USD',
      };

      this.setCache(cacheKey, breakdown);
      return breakdown;
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * Get current month-to-date costs across all accounts
   */
  async getCurrentMonthCosts(accountIds?: string[]): Promise<AggregatedBillingResult> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    return this.getAggregatedCosts({
      timePeriod: {
        start: monthStart.toISOString().split('T')[0],
        end: now.toISOString().split('T')[0],
      },
      granularity: 'MONTHLY',
      accountIds,
    });
  }

  /**
   * Compare costs between two time periods
   */
  async comparePeriods(params: {
    currentPeriod: BillingTimePeriod;
    previousPeriod: BillingTimePeriod;
    accountIds?: string[];
  }): Promise<CostComparison> {
    const [current, previous] = await Promise.all([
      this.getAggregatedCosts({
        timePeriod: params.currentPeriod,
        accountIds: params.accountIds,
      }),
      this.getAggregatedCosts({
        timePeriod: params.previousPeriod,
        accountIds: params.accountIds,
      }),
    ]);

    const delta = current.totalCost - previous.totalCost;
    const deltaPercent = previous.totalCost > 0 ? (delta / previous.totalCost) * 100 : 0;

    // Calculate per-account changes
    const accountChanges = [];
    const accountMap = new Map(current.accounts.map(a => [a.accountId, a]));

    for (const prevAccount of previous.accounts) {
      const currAccount = accountMap.get(prevAccount.accountId);
      const currentCost = currAccount?.totalCost || 0;
      const previousCost = prevAccount.totalCost;
      const accountDelta = currentCost - previousCost;
      const accountDeltaPercent = previousCost > 0 ? (accountDelta / previousCost) * 100 : 0;

      accountChanges.push({
        accountId: prevAccount.accountId,
        currentCost,
        previousCost,
        delta: accountDelta,
        deltaPercent: accountDeltaPercent,
      });
    }

    // Add accounts that only exist in current period
    for (const currAccount of current.accounts) {
      if (!previous.accounts.find(a => a.accountId === currAccount.accountId)) {
        accountChanges.push({
          accountId: currAccount.accountId,
          currentCost: currAccount.totalCost,
          previousCost: 0,
          delta: currAccount.totalCost,
          deltaPercent: 100,
        });
      }
    }

    // Sort by absolute delta
    accountChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return {
      currentPeriod: params.currentPeriod,
      previousPeriod: params.previousPeriod,
      currentTotal: current.totalCost,
      previousTotal: previous.totalCost,
      delta,
      deltaPercent,
      accountChanges,
    };
  }

  /**
   * Get budget status for accounts
   */
  async getAccountBudgetStatus(params: {
    accountId: string;
    budgetAmount: number;
    timePeriod: BillingTimePeriod;
  }): Promise<AccountBudgetStatus> {
    const [costs, forecast] = await Promise.all([
      this.getAccountCosts({
        accountId: params.accountId,
        timePeriod: params.timePeriod,
      }),
      this.getForecast({
        accountId: params.accountId,
        timePeriod: params.timePeriod,
      }),
    ]);

    const utilizationPercent = (costs.totalCost / params.budgetAmount) * 100;
    const forecastUtilization = (forecast / params.budgetAmount) * 100;

    let status: 'OK' | 'WARNING' | 'EXCEEDED';
    if (costs.totalCost >= params.budgetAmount) {
      status = 'EXCEEDED';
    } else if (forecastUtilization >= 95) {
      status = 'WARNING';
    } else {
      status = 'OK';
    }

    return {
      accountId: params.accountId,
      budgetAmount: params.budgetAmount,
      actualCost: costs.totalCost,
      forecastedCost: forecast,
      utilizationPercent,
      status,
      timePeriod: params.timePeriod,
    };
  }

  /**
   * Get cost forecast for an account
   */
  private async getForecast(params: {
    accountId: string;
    timePeriod: BillingTimePeriod;
  }): Promise<number> {
    const cacheKey = `forecast:${params.accountId}:${JSON.stringify(params.timePeriod)}`;
    const cached = this.getFromCache<number>(cacheKey);
    if (cached !== null) return cached;

    const client = await this.getClient();

    try {
      const command = new GetCostForecastCommand({
        TimePeriod: {
          Start: params.timePeriod.start,
          End: params.timePeriod.end,
        },
        Metric: 'UNBLENDED_COST' as Metric,
        Granularity: 'MONTHLY' as Granularity,
        Filter: {
          Dimensions: {
            Key: 'LINKED_ACCOUNT',
            Values: [params.accountId],
          },
        },
      });

      const response = await client.send(command);
      const forecast = parseFloat(response.Total?.Amount || '0');

      this.setCache(cacheKey, forecast);
      return forecast;
    } catch (error: any) {
      // Forecasting may not be available for all time periods
      return 0;
    }
  }

  /**
   * Get top N most expensive accounts
   */
  async getTopAccounts(params: {
    timePeriod: BillingTimePeriod;
    limit?: number;
    accountIds?: string[];
  }): Promise<AccountCostBreakdown[]> {
    const result = await this.getAggregatedCosts({
      timePeriod: params.timePeriod,
      accountIds: params.accountIds,
    });

    return result.accounts.slice(0, params.limit || 10);
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Handle AWS SDK errors and convert to BillingError
   */
  private handleError(error: any): BillingError {
    const code = error.name || error.code;
    const message = error.message || 'Unknown error';

    switch (code) {
      case 'DataUnavailableException':
        return new BillingError('DATA_NOT_AVAILABLE', message, error);
      case 'InvalidNextTokenException':
      case 'RequestChangedException':
        return new BillingError('INVALID_TIME_PERIOD', message, error);
      case 'AccessDeniedException':
        return new BillingError('PERMISSION_DENIED', message, error);
      case 'ThrottlingException':
        return new BillingError('RATE_LIMIT_EXCEEDED', message, error);
      default:
        return new BillingError('INTERNAL_ERROR', message, error);
    }
  }

  /**
   * Cache management
   */
  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() > cached.expires) {
      this.cache.delete(key);
      return null;
    }
    return cached.data as T;
  }

  private setCache(key: string, data: unknown): void {
    this.cache.set(key, {
      data,
      expires: Date.now() + this.config.cacheTTL * 1000,
    });
  }
}
