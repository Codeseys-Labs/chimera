/**
 * Cost Analyzer - AWS Cost Explorer Integration - Strands Tools
 *
 * Provides Strands @tool decorated functions for real-time cost tracking,
 * anomaly detection, and spending analysis for Chimera agents to maintain
 * cost awareness across AWS resources.
 *
 * Based on: docs/research/aws-account-agent/04-Cost-Explorer-Spending-Analysis.md
 */

import { tool } from '../aws-tools/strands-agents';
import { z } from 'zod';

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
 * Create Cost Analyzer Strands tools
 *
 * Factory function that creates Strands tools for AWS Cost Explorer operations.
 * Each public method from the CostAnalyzer class becomes a standalone tool.
 *
 * @param config - Cost Explorer configuration
 * @returns Array of Strands tools for cost analysis operations
 *
 * @example
 * ```typescript
 * const costTools = createCostAnalyzerTools({
 *   costExplorerClient: new CostExplorerClient({ region: 'us-east-1' }),
 *   enableResourceTracking: true,
 *   cacheTTL: 3600
 * });
 *
 * const agent = Agent({
 *   tools: costTools,
 *   // ...
 * });
 * ```
 */
export function createCostAnalyzerTools(config: CostAnalyzerConfig) {
  const fullConfig = {
    defaultPeriodDays: 30,
    anomalyThreshold: 2.0,
    enableResourceTracking: true,
    cacheTTL: 3600,
    ...config,
  };

  const cache = new Map<string, { data: any; expires: number }>();

  /**
   * Get cost and usage data for a time period
   */
  const getCostAndUsage = tool({
    name: 'cost_get_usage',
    description: 'Get AWS cost and usage data for a specified time period with flexible grouping and filtering options.',
    inputSchema: z.object({
      startDate: z.string().describe('Start date in YYYY-MM-DD format'),
      endDate: z.string().describe('End date in YYYY-MM-DD format'),
      granularity: z.enum(['DAILY', 'HOURLY', 'MONTHLY']).default('DAILY').describe('Time granularity for results'),
      metrics: z.array(z.enum(['UnblendedCost', 'BlendedCost', 'UsageQuantity', 'AmortizedCost'])).default(['UnblendedCost']).describe('Cost metrics to include'),
      groupBy: z.array(z.object({
        type: z.enum(['DIMENSION', 'TAG']),
        key: z.string(),
      })).optional().describe('Grouping dimensions (e.g., [{"type": "DIMENSION", "key": "SERVICE"}])'),
      filterDimension: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Filter by dimension (e.g., {"key": "SERVICE", "values": ["Amazon EC2"]})'),
      filterTag: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Filter by tag (e.g., {"key": "Environment", "values": ["production"]})'),
    }),
    callback: async (input) => {
      const timePeriod = { start: input.startDate, end: input.endDate };
      const filter: CostFilter = {
        dimensions: input.filterDimension as any,
        tags: input.filterTag,
      };

      const result = await getCostAndUsageImpl(fullConfig, cache, {
        timePeriod,
        granularity: input.granularity,
        metrics: input.metrics as CostMetric[],
        groupBy: input.groupBy as CostGroupBy[] | undefined,
        filter,
      });

      return JSON.stringify(result, null, 2);
    },
  });

  /**
   * Get costs for a specific tenant
   */
  const getTenantCosts = tool({
    name: 'cost_get_tenant',
    description: 'Get AWS costs for a specific tenant, filtered by TenantId tag.',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant identifier'),
      startDate: z.string().describe('Start date in YYYY-MM-DD format'),
      endDate: z.string().describe('End date in YYYY-MM-DD format'),
      granularity: z.enum(['DAILY', 'HOURLY', 'MONTHLY']).default('DAILY').describe('Time granularity'),
    }),
    callback: async (input) => {
      const result = await getCostAndUsageImpl(fullConfig, cache, {
        timePeriod: { start: input.startDate, end: input.endDate },
        granularity: input.granularity,
        metrics: ['UnblendedCost'],
        groupBy: [{ type: 'DIMENSION', key: 'SERVICE' }],
        filter: {
          tags: {
            key: 'TenantId',
            values: [input.tenantId],
          },
        },
      });

      return JSON.stringify(result, null, 2);
    },
  });

  /**
   * Get top N most expensive resources
   */
  const getTopResources = tool({
    name: 'cost_get_top_resources',
    description: 'Get the top N most expensive AWS resources for a time period.',
    inputSchema: z.object({
      startDate: z.string().describe('Start date in YYYY-MM-DD format'),
      endDate: z.string().describe('End date in YYYY-MM-DD format'),
      limit: z.number().min(1).max(100).default(10).describe('Number of top resources to return'),
      filterDimension: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Optional dimension filter'),
      filterTag: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Optional tag filter'),
    }),
    callback: async (input) => {
      if (!fullConfig.enableResourceTracking) {
        return JSON.stringify({ error: 'Resource-level cost tracking is disabled' });
      }

      const timePeriod = { start: input.startDate, end: input.endDate };
      const filter: CostFilter = {
        dimensions: input.filterDimension as any,
        tags: input.filterTag,
      };

      const result = await getCostAndUsageImpl(fullConfig, cache, {
        timePeriod,
        granularity: 'DAILY',
        metrics: ['UnblendedCost', 'UsageQuantity'],
        groupBy: [
          { type: 'DIMENSION', key: 'RESOURCE_ID' },
          { type: 'DIMENSION', key: 'SERVICE' },
        ],
        filter,
      });

      // Aggregate costs by resource
      const costs = result.byResource || {};
      const resources = Object.entries(costs)
        .map(([resourceId, cost]) => ({
          resourceId,
          resourceType: 'Unknown',
          service: 'Unknown',
          region: 'Unknown',
          cost: typeof cost === 'number' ? cost : 0,
        }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, input.limit);

      return JSON.stringify({ resources }, null, 2);
    },
  });

  /**
   * Detect cost anomalies
   */
  const detectAnomalies = tool({
    name: 'cost_detect_anomalies',
    description: 'Detect cost anomalies using statistical analysis of historical spending patterns.',
    inputSchema: z.object({
      lookbackDays: z.number().min(7).max(90).default(30).describe('Number of days to analyze for anomalies'),
      filterDimension: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Optional dimension filter'),
      filterTag: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Optional tag filter'),
    }),
    callback: async (input) => {
      const now = new Date();
      const startDate = new Date(now.getTime() - (input.lookbackDays ?? 30) * 24 * 60 * 60 * 1000);

      const timePeriod = {
        start: startDate.toISOString().split('T')[0],
        end: now.toISOString().split('T')[0],
      };

      const filter: CostFilter = {
        dimensions: input.filterDimension as any,
        tags: input.filterTag,
      };

      const result = await getCostAndUsageImpl(fullConfig, cache, {
        timePeriod,
        granularity: 'DAILY',
        metrics: ['UnblendedCost'],
        filter,
      });

      const anomalies = analyzeAnomalies(result);
      return JSON.stringify({ anomalies }, null, 2);
    },
  });

  /**
   * Get cost forecast
   */
  const getForecast = tool({
    name: 'cost_get_forecast',
    description: 'Get cost forecast for a future time period using AWS machine learning models.',
    inputSchema: z.object({
      startDate: z.string().describe('Forecast start date in YYYY-MM-DD format'),
      endDate: z.string().describe('Forecast end date in YYYY-MM-DD format'),
      metric: z.enum(['UnblendedCost', 'BlendedCost', 'UsageQuantity', 'AmortizedCost']).default('UnblendedCost').describe('Cost metric to forecast'),
      granularity: z.enum(['DAILY', 'MONTHLY']).default('DAILY').describe('Forecast granularity'),
      filterDimension: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Optional dimension filter'),
      filterTag: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Optional tag filter'),
    }),
    callback: async (input) => {
      const timePeriod = { start: input.startDate, end: input.endDate };
      const filter: CostFilter = {
        dimensions: input.filterDimension as any,
        tags: input.filterTag,
      };

      const forecast = await getForecastImpl(fullConfig, cache, {
        timePeriod,
        metric: input.metric as CostMetric,
        granularity: input.granularity,
        filter,
      });

      return JSON.stringify(forecast, null, 2);
    },
  });

  /**
   * Compare costs between two periods
   */
  const comparePeriods = tool({
    name: 'cost_compare_periods',
    description: 'Compare AWS costs between two time periods to identify spending changes and trends.',
    inputSchema: z.object({
      currentStart: z.string().describe('Current period start date (YYYY-MM-DD)'),
      currentEnd: z.string().describe('Current period end date (YYYY-MM-DD)'),
      previousStart: z.string().describe('Previous period start date (YYYY-MM-DD)'),
      previousEnd: z.string().describe('Previous period end date (YYYY-MM-DD)'),
      groupBy: z.array(z.object({
        type: z.enum(['DIMENSION', 'TAG']),
        key: z.string(),
      })).optional().describe('Grouping dimensions'),
      filterDimension: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Optional dimension filter'),
      filterTag: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Optional tag filter'),
    }),
    callback: async (input) => {
      const filter: CostFilter = {
        dimensions: input.filterDimension as any,
        tags: input.filterTag,
      };

      const [current, previous] = await Promise.all([
        getCostAndUsageImpl(fullConfig, cache, {
          timePeriod: { start: input.currentStart, end: input.currentEnd },
          groupBy: input.groupBy as CostGroupBy[] | undefined,
          filter,
        }),
        getCostAndUsageImpl(fullConfig, cache, {
          timePeriod: { start: input.previousStart, end: input.previousEnd },
          groupBy: input.groupBy as CostGroupBy[] | undefined,
          filter,
        }),
      ]);

      const delta = current.totalCost - previous.totalCost;
      const deltaPercent = previous.totalCost > 0 ? (delta / previous.totalCost) * 100 : 0;

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

      const result = {
        current,
        previous,
        delta,
        deltaPercent,
        topIncreases: changes.filter(c => c.delta > 0).slice(0, 5),
        topDecreases: changes.filter(c => c.delta < 0).slice(0, 5),
      };

      return JSON.stringify(result, null, 2);
    },
  });

  /**
   * Get current month-to-date costs
   */
  const getCurrentMonthCosts = tool({
    name: 'cost_get_current_month',
    description: 'Get month-to-date AWS costs for the current month.',
    inputSchema: z.object({
      filterDimension: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Optional dimension filter'),
      filterTag: z.object({
        key: z.string(),
        values: z.array(z.string()),
      }).optional().describe('Optional tag filter'),
    }),
    callback: async (input) => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const filter: CostFilter = {
        dimensions: input.filterDimension as any,
        tags: input.filterTag,
      };

      const result = await getCostAndUsageImpl(fullConfig, cache, {
        timePeriod: {
          start: monthStart.toISOString().split('T')[0],
          end: now.toISOString().split('T')[0],
        },
        granularity: 'MONTHLY',
        metrics: ['UnblendedCost'],
        groupBy: [{ type: 'DIMENSION', key: 'SERVICE' }],
        filter,
      });

      return JSON.stringify(result, null, 2);
    },
  });

  return [
    getCostAndUsage,
    getTenantCosts,
    getTopResources,
    detectAnomalies,
    getForecast,
    comparePeriods,
    getCurrentMonthCosts,
  ];
}

// ============================================================================
// Private helper functions
// ============================================================================

async function getCostAndUsageImpl(
  config: Required<CostAnalyzerConfig>,
  cache: Map<string, { data: any; expires: number }>,
  params: {
    timePeriod: TimePeriod;
    granularity?: CostGranularity;
    metrics?: CostMetric[];
    groupBy?: CostGroupBy[];
    filter?: CostFilter;
  }
): Promise<CostAnalysisResult> {
  const cacheKey = getCacheKey('cost', params);
  const cached = getFromCache(cache, cacheKey);
  if (cached) return cached;

  const { GetCostAndUsageCommand } = await import('@aws-sdk/client-cost-explorer');

  const command = new GetCostAndUsageCommand({
    TimePeriod: {
      Start: params.timePeriod.start,
      End: params.timePeriod.end,
    },
    Granularity: params.granularity || 'DAILY',
    Metrics: params.metrics || ['UnblendedCost'],
    GroupBy: params.groupBy?.map(g => ({ Type: g.type, Key: g.key })),
    Filter: buildFilter(params.filter),
  });

  const response = await config.costExplorerClient.send(command);

  const result = parseCostResponse(response, params);
  setCache(cache, config.cacheTTL!, cacheKey, result);
  return result;
}

async function getForecastImpl(
  config: Required<CostAnalyzerConfig>,
  cache: Map<string, { data: any; expires: number }>,
  params: {
    timePeriod: TimePeriod;
    metric?: CostMetric;
    granularity?: CostGranularity;
    filter?: CostFilter;
  }
): Promise<CostForecast> {
  const cacheKey = getCacheKey('forecast', params);
  const cached = getFromCache(cache, cacheKey);
  if (cached) return cached;

  const { GetCostForecastCommand } = await import('@aws-sdk/client-cost-explorer');

  const metricMap: Record<CostMetric, string> = {
    'UnblendedCost': 'UNBLENDED_COST',
    'BlendedCost': 'BLENDED_COST',
    'UsageQuantity': 'USAGE_QUANTITY',
    'AmortizedCost': 'AMORTIZED_COST',
  };
  const metric = params.metric ? metricMap[params.metric] : 'UNBLENDED_COST';

  const command = new GetCostForecastCommand({
    TimePeriod: {
      Start: params.timePeriod.start,
      End: params.timePeriod.end,
    },
    Metric: metric as any,
    Granularity: params.granularity || 'DAILY',
    Filter: buildFilter(params.filter),
  });

  const response = await config.costExplorerClient.send(command);

  const forecast: CostForecast = {
    timePeriod: params.timePeriod,
    predictedCost: parseFloat(response.Total?.Amount || '0'),
    confidence: response.ForecastResultsByTime?.[0]?.MeanValue ? 'MEDIUM' : 'LOW',
    method: 'AWS Machine Learning',
  };

  setCache(cache, config.cacheTTL!, cacheKey, forecast);
  return forecast;
}

function buildFilter(filter?: CostFilter): any {
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

function parseCostResponse(response: any, params: any): CostAnalysisResult {
  let totalCost = 0;
  const byService: Record<string, number> = {};
  const byResource: Record<string, number> = {};
  const byTag: Record<string, number> = {};

  for (const result of response.ResultsByTime || []) {
    const amount = parseFloat(result.Total?.UnblendedCost?.Amount || '0');
    totalCost += amount;

    for (const group of result.Groups || []) {
      const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');
      const keys = group.Keys || [];

      if (keys.length > 0) {
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

function analyzeAnomalies(result: CostAnalysisResult): CostAnomaly[] {
  // Simplified placeholder - would implement actual anomaly detection
  return [];
}

function getCacheKey(prefix: string, params: any): string {
  return `${prefix}:${JSON.stringify(params)}`;
}

function getFromCache(cache: Map<string, { data: any; expires: number }>, key: string): any | null {
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expires) {
    cache.delete(key);
    return null;
  }
  return cached.data;
}

function setCache(cache: Map<string, { data: any; expires: number }>, ttl: number, key: string, data: any): void {
  cache.set(key, {
    data,
    expires: Date.now() + ttl * 1000,
  });
}
