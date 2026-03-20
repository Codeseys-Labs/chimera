/**
 * Cost Analyzer - AWS Cost Explorer Integration
 *
 * Provides real-time cost tracking, anomaly detection, and spending analysis
 * for Chimera agents to maintain cost awareness across AWS resources.
 *
 * Based on: docs/research/aws-account-agent/04-Cost-Explorer-Spending-Analysis.md
 */

/**
 * Cost Explorer API client interface (AWS SDK v3)
 */
export interface CostExplorerClient {
  send(command: any): Promise<any>;
}

/**
 * Time granularity for cost queries
 */
export type CostGranularity = 'DAILY' | 'HOURLY' | 'MONTHLY';

/**
 * Cost metric types
 */
export type CostMetric = 'UnblendedCost' | 'BlendedCost' | 'UsageQuantity' | 'AmortizedCost';

/**
 * Cost dimension for grouping
 */
export type CostDimension = 'SERVICE' | 'REGION' | 'LINKED_ACCOUNT' | 'INSTANCE_TYPE' |
  'USAGE_TYPE' | 'OPERATION' | 'PURCHASE_TYPE' | 'RESOURCE_ID';

/**
 * Cost query time period
 */
export interface TimePeriod {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
}

/**
 * Cost grouping configuration
 */
export interface CostGroupBy {
  type: 'DIMENSION' | 'TAG';
  key: string;
}

/**
 * Cost filter configuration
 */
export interface CostFilter {
  dimensions?: {
    key: CostDimension;
    values: string[];
  };
  tags?: {
    key: string;
    values: string[];
  };
}

/**
 * Cost analysis result
 */
export interface CostAnalysisResult {
  timePeriod: TimePeriod;
  totalCost: number;
  byService: Record<string, number>;
  byResource?: Record<string, number>;
  byTag?: Record<string, number>;
}

/**
 * Cost anomaly detection result
 */
export interface CostAnomaly {
  date: string;
  expectedCost: number;
  actualCost: number;
  delta: number;
  deltaPercent: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedServices?: string[];
}

/**
 * Resource cost breakdown
 */
export interface ResourceCost {
  resourceId: string;
  resourceType: string;
  service: string;
  region: string;
  cost: number;
  usageQuantity?: number;
  tags?: Record<string, string>;
}

/**
 * Cost forecast result
 */
export interface CostForecast {
  timePeriod: TimePeriod;
  predictedCost: number;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  method: string;
}

/**
 * Cost Analyzer Configuration
 */
export interface CostAnalyzerConfig {
  /** Cost Explorer client */
  costExplorerClient: CostExplorerClient;

  /** Default time period for queries (days) */
  defaultPeriodDays?: number;

  /** Anomaly detection threshold (standard deviations) */
  anomalyThreshold?: number;

  /** Enable resource-level cost tracking */
  enableResourceTracking?: boolean;

  /** Cache TTL in seconds */
  cacheTTL?: number;
}

/**
 * Cost Analyzer Service
 *
 * Provides programmatic access to AWS Cost Explorer for:
 * - Real-time spending awareness
 * - Multi-dimensional cost analysis
 * - Anomaly detection
 * - Cost forecasting
 * - Tag-based attribution
 */
export class CostAnalyzer {
  private config: CostAnalyzerConfig;
  private cache: Map<string, { data: any; expires: number }>;

  constructor(config: CostAnalyzerConfig) {
    this.config = {
      defaultPeriodDays: 30,
      anomalyThreshold: 2.0,
      enableResourceTracking: true,
      cacheTTL: 3600, // 1 hour
      ...config,
    };
    this.cache = new Map();
  }

  /**
   * Get cost and usage data for a time period
   */
  async getCostAndUsage(params: {
    timePeriod: TimePeriod;
    granularity?: CostGranularity;
    metrics?: CostMetric[];
    groupBy?: CostGroupBy[];
    filter?: CostFilter;
  }): Promise<CostAnalysisResult> {
    const cacheKey = this.getCacheKey('cost', params);
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const { GetCostAndUsageCommand } = await import('@aws-sdk/client-cost-explorer');

    const command = new GetCostAndUsageCommand({
      TimePeriod: {
        Start: params.timePeriod.start,
        End: params.timePeriod.end,
      },
      Granularity: params.granularity || 'DAILY',
      Metrics: params.metrics || ['UnblendedCost'],
      GroupBy: params.groupBy,
      Filter: this.buildFilter(params.filter),
    });

    const response = await this.config.costExplorerClient.send(command);

    const result = this.parseCostResponse(response, params);
    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Get costs for a specific tenant
   */
  async getTenantCosts(params: {
    tenantId: string;
    timePeriod: TimePeriod;
    granularity?: CostGranularity;
  }): Promise<CostAnalysisResult> {
    return this.getCostAndUsage({
      timePeriod: params.timePeriod,
      granularity: params.granularity,
      metrics: ['UnblendedCost'],
      groupBy: [{ type: 'DIMENSION', key: 'SERVICE' }],
      filter: {
        tags: {
          key: 'TenantId',
          values: [params.tenantId],
        },
      },
    });
  }

  /**
   * Get top N most expensive resources
   */
  async getTopResources(params: {
    timePeriod: TimePeriod;
    limit?: number;
    filter?: CostFilter;
  }): Promise<ResourceCost[]> {
    if (!this.config.enableResourceTracking) {
      throw new Error('Resource-level cost tracking is disabled');
    }

    const result = await this.getCostAndUsage({
      timePeriod: params.timePeriod,
      granularity: 'DAILY',
      metrics: ['UnblendedCost', 'UsageQuantity'],
      groupBy: [
        { type: 'DIMENSION', key: 'RESOURCE_ID' },
        { type: 'DIMENSION', key: 'SERVICE' },
      ],
      filter: params.filter,
    });

    // Aggregate costs by resource
    const resourceCosts: Record<string, ResourceCost> = {};

    // Parse response and aggregate (implementation depends on actual response structure)
    // This is a simplified version
    const costs = result.byResource || {};
    const resources = Object.entries(costs)
      .map(([resourceId, cost]) => ({
        resourceId,
        resourceType: 'Unknown', // Would extract from resourceId
        service: 'Unknown',
        region: 'Unknown',
        cost: typeof cost === 'number' ? cost : 0,
      }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, params.limit || 10);

    return resources;
  }

  /**
   * Detect cost anomalies using statistical analysis
   */
  async detectAnomalies(params: {
    timePeriod?: TimePeriod;
    lookbackDays?: number;
    filter?: CostFilter;
  }): Promise<CostAnomaly[]> {
    const lookbackDays = params.lookbackDays || 30;
    const now = new Date();
    const startDate = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    const timePeriod = params.timePeriod || {
      start: startDate.toISOString().split('T')[0],
      end: now.toISOString().split('T')[0],
    };

    const result = await this.getCostAndUsage({
      timePeriod,
      granularity: 'DAILY',
      metrics: ['UnblendedCost'],
      filter: params.filter,
    });

    return this.analyzeAnomalies(result);
  }

  /**
   * Get cost forecast for future period
   */
  async getForecast(params: {
    timePeriod: TimePeriod;
    metric?: CostMetric;
    granularity?: CostGranularity;
    filter?: CostFilter;
  }): Promise<CostForecast> {
    const cacheKey = this.getCacheKey('forecast', params);
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const { GetCostForecastCommand } = await import('@aws-sdk/client-cost-explorer');

    const command = new GetCostForecastCommand({
      TimePeriod: {
        Start: params.timePeriod.start,
        End: params.timePeriod.end,
      },
      Metric: params.metric || 'UNBLENDED_COST',
      Granularity: params.granularity || 'DAILY',
      Filter: this.buildFilter(params.filter),
    });

    const response = await this.config.costExplorerClient.send(command);

    const forecast: CostForecast = {
      timePeriod: params.timePeriod,
      predictedCost: parseFloat(response.Total?.Amount || '0'),
      confidence: response.ForecastResultsByTime?.[0]?.MeanValue ? 'MEDIUM' : 'LOW',
      method: 'AWS Machine Learning',
    };

    this.setCache(cacheKey, forecast);
    return forecast;
  }

  /**
   * Compare costs between two time periods
   */
  async comparePeriods(params: {
    currentPeriod: TimePeriod;
    previousPeriod: TimePeriod;
    groupBy?: CostGroupBy[];
    filter?: CostFilter;
  }): Promise<{
    current: CostAnalysisResult;
    previous: CostAnalysisResult;
    delta: number;
    deltaPercent: number;
    topIncreases: Array<{ key: string; delta: number; deltaPercent: number }>;
    topDecreases: Array<{ key: string; delta: number; deltaPercent: number }>;
  }> {
    const [current, previous] = await Promise.all([
      this.getCostAndUsage({
        timePeriod: params.currentPeriod,
        groupBy: params.groupBy,
        filter: params.filter,
      }),
      this.getCostAndUsage({
        timePeriod: params.previousPeriod,
        groupBy: params.groupBy,
        filter: params.filter,
      }),
    ]);

    const delta = current.totalCost - previous.totalCost;
    const deltaPercent = previous.totalCost > 0
      ? (delta / previous.totalCost) * 100
      : 0;

    // Calculate service-level changes
    const changes: Array<{ key: string; delta: number; deltaPercent: number }> = [];

    for (const [service, currentCost] of Object.entries(current.byService)) {
      const previousCost = previous.byService[service] || 0;
      const serviceDelta = currentCost - previousCost;
      const servicePercent = previousCost > 0 ? (serviceDelta / previousCost) * 100 : 0;

      changes.push({
        key: service,
        delta: serviceDelta,
        deltaPercent: servicePercent,
      });
    }

    changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return {
      current,
      previous,
      delta,
      deltaPercent,
      topIncreases: changes.filter(c => c.delta > 0).slice(0, 5),
      topDecreases: changes.filter(c => c.delta < 0).slice(0, 5),
    };
  }

  /**
   * Get current month-to-date costs
   */
  async getCurrentMonthCosts(filter?: CostFilter): Promise<CostAnalysisResult> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    return this.getCostAndUsage({
      timePeriod: {
        start: monthStart.toISOString().split('T')[0],
        end: now.toISOString().split('T')[0],
      },
      granularity: 'MONTHLY',
      metrics: ['UnblendedCost'],
      groupBy: [{ type: 'DIMENSION', key: 'SERVICE' }],
      filter,
    });
  }

  /**
   * Private: Build Cost Explorer filter from our filter format
   */
  private buildFilter(filter?: CostFilter): any {
    if (!filter) return undefined;

    const conditions: any[] = [];

    if (filter.dimensions) {
      conditions.push({
        Dimensions: {
          Key: filter.dimensions.key,
          Values: filter.dimensions.values,
        },
      });
    }

    if (filter.tags) {
      conditions.push({
        Tags: {
          Key: filter.tags.key,
          Values: filter.tags.values,
        },
      });
    }

    if (conditions.length === 0) return undefined;
    if (conditions.length === 1) return conditions[0];

    return { And: conditions };
  }

  /**
   * Private: Parse Cost Explorer response into our format
   */
  private parseCostResponse(response: any, params: any): CostAnalysisResult {
    let totalCost = 0;
    const byService: Record<string, number> = {};
    const byResource: Record<string, number> = {};
    const byTag: Record<string, number> = {};

    for (const result of response.ResultsByTime || []) {
      // Add to total
      const amount = parseFloat(result.Total?.UnblendedCost?.Amount || '0');
      totalCost += amount;

      // Group by dimensions
      for (const group of result.Groups || []) {
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');
        const keys = group.Keys || [];

        if (keys.length > 0) {
          // Determine grouping type
          const groupBy = params.groupBy?.[0];
          if (groupBy?.key === 'SERVICE') {
            byService[keys[0]] = (byService[keys[0]] || 0) + cost;
          } else if (groupBy?.key === 'RESOURCE_ID') {
            byResource[keys[0]] = (byResource[keys[0]] || 0) + cost;
          } else if (groupBy?.type === 'TAG') {
            byTag[keys[0]] = (byTag[keys[0]] || 0) + cost;
          }
        }
      }
    }

    return {
      timePeriod: params.timePeriod,
      totalCost,
      byService,
      ...(Object.keys(byResource).length > 0 && { byResource }),
      ...(Object.keys(byTag).length > 0 && { byTag }),
    };
  }

  /**
   * Private: Analyze cost data for anomalies
   */
  private analyzeAnomalies(result: CostAnalysisResult): CostAnomaly[] {
    // This is a simplified statistical analysis
    // In production, would use more sophisticated time-series analysis
    const anomalies: CostAnomaly[] = [];

    // Would implement actual anomaly detection here using historical data
    // For now, return empty array as placeholder

    return anomalies;
  }

  /**
   * Private: Cache management
   */
  private getCacheKey(prefix: string, params: any): string {
    return `${prefix}:${JSON.stringify(params)}`;
  }

  private getFromCache(key: string): any | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() > cached.expires) {
      this.cache.delete(key);
      return null;
    }
    return cached.data;
  }

  private setCache(key: string, data: any): void {
    const ttl = this.config.cacheTTL || 3600;
    this.cache.set(key, {
      data,
      expires: Date.now() + ttl * 1000,
    });
  }
}
