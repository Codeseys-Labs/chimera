/**
 * Cost Attribution Service
 *
 * Manages tenantId cost allocation tags on AWS resources and provides
 * a Cost Explorer query interface for per-tenant billing reports.
 *
 * Tag key convention: 'chimera:tenant-id' = <tenantId>
 * This tag must be activated as a cost allocation tag in AWS Billing console.
 */

/** Tag key used for tenant cost allocation */
export const TENANT_TAG_KEY = 'chimera:tenant-id';

/** AWS TagResources batch limit */
const TAG_BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// Client interfaces (injectable for testing)
// ---------------------------------------------------------------------------

export interface FailureInfo {
  StatusCode?: number;
  ErrorCode?: string;
  ErrorMessage?: string;
}

export interface TagResourcesCommandOutput {
  FailedResourcesMap?: Record<string, FailureInfo>;
}

export interface UntagResourcesCommandOutput {
  FailedResourcesMap?: Record<string, FailureInfo>;
}

export interface ResourceTagMapping {
  ResourceARN?: string;
  Tags?: Array<{ Key?: string; Value?: string }>;
}

export interface GetResourcesCommandOutput {
  ResourceTagMappingList?: ResourceTagMapping[];
  PaginationToken?: string;
}

export interface TaggingAPIClient {
  tagResources(params: {
    ResourceARNList: string[];
    Tags: Record<string, string>;
  }): Promise<TagResourcesCommandOutput>;

  untagResources(params: {
    ResourceARNList: string[];
    TagKeys: string[];
  }): Promise<UntagResourcesCommandOutput>;

  getResources(params: {
    TagFilters?: Array<{ Key: string; Values: string[] }>;
    PaginationToken?: string;
  }): Promise<GetResourcesCommandOutput>;
}

export interface MetricValue {
  Amount?: string;
  Unit?: string;
}

export interface CostGroup {
  Keys?: string[];
  Metrics?: Record<string, MetricValue>;
}

export interface CostResultByTime {
  TimePeriod?: { Start?: string; End?: string };
  Total?: Record<string, MetricValue>;
  Groups?: CostGroup[];
  Estimated?: boolean;
}

export interface GetCostAndUsageOutput {
  ResultsByTime?: CostResultByTime[];
  NextPageToken?: string;
}

export interface CostExplorerAPIClient {
  getCostAndUsage(params: {
    TimePeriod: { Start: string; End: string };
    Granularity: 'DAILY' | 'MONTHLY' | 'HOURLY';
    Filter?: object;
    GroupBy?: Array<{ Type: string; Key: string }>;
    Metrics: string[];
    NextPageToken?: string;
  }): Promise<GetCostAndUsageOutput>;
}

// ---------------------------------------------------------------------------
// Service config and result types
// ---------------------------------------------------------------------------

export interface CostAttributionConfig {
  /** Resource Groups Tagging API client */
  taggingClient: TaggingAPIClient;
  /** Cost Explorer client */
  costExplorerClient: CostExplorerAPIClient;
  /** Override the tag key (default: 'chimera:tenant-id') */
  tagKey?: string;
}

export interface TagResourcesResult {
  /** Number of resources successfully tagged */
  tagged: number;
  /** ARNs that failed to tag, with error details */
  failures: Record<string, FailureInfo>;
}

export interface UntagResourcesResult {
  /** Number of resources successfully untagged */
  untagged: number;
  /** ARNs that failed to untag, with error details */
  failures: Record<string, FailureInfo>;
}

export interface ServiceCostBreakdown {
  service: string;
  costUsd: number;
  unit: string;
}

export interface MonthlyTenantCost {
  period: string; // YYYY-MM-DD start of month
  costUsd: number;
  estimated: boolean;
}

export interface TenantCostReport {
  tenantId: string;
  startDate: string;
  endDate: string;
  totalCostUsd: number;
  byService: ServiceCostBreakdown[];
  byMonth: MonthlyTenantCost[];
}

// ---------------------------------------------------------------------------
// CostAttributionService
// ---------------------------------------------------------------------------

/**
 * CostAttributionService
 *
 * Two responsibilities:
 * 1. Tag AWS resources with the tenant's ID for cost allocation
 * 2. Query Cost Explorer for per-tenant billing reports
 */
export class CostAttributionService {
  private taggingClient: TaggingAPIClient;
  private costExplorerClient: CostExplorerAPIClient;
  private tagKey: string;

  constructor(config: CostAttributionConfig) {
    this.taggingClient = config.taggingClient;
    this.costExplorerClient = config.costExplorerClient;
    this.tagKey = config.tagKey ?? TENANT_TAG_KEY;
  }

  /**
   * Tag AWS resources with the tenant's cost allocation tag.
   *
   * Batches requests to stay within the AWS limit of 20 ARNs per call.
   * Partial failures are reported in the result rather than thrown.
   *
   * @param tenantId - Tenant identifier to apply as tag value
   * @param resourceArns - List of resource ARNs to tag
   */
  async tagResources(tenantId: string, resourceArns: string[]): Promise<TagResourcesResult> {
    if (resourceArns.length === 0) {
      return { tagged: 0, failures: {} };
    }

    const allFailures: Record<string, FailureInfo> = {};
    const batches = chunk(resourceArns, TAG_BATCH_SIZE);

    for (const batch of batches) {
      const output = await this.taggingClient.tagResources({
        ResourceARNList: batch,
        Tags: { [this.tagKey]: tenantId },
      });

      if (output.FailedResourcesMap) {
        Object.assign(allFailures, output.FailedResourcesMap);
      }
    }

    const failedArns = new Set(Object.keys(allFailures));
    const tagged = resourceArns.filter((arn) => !failedArns.has(arn)).length;

    return { tagged, failures: allFailures };
  }

  /**
   * Remove the tenant cost allocation tag from AWS resources.
   *
   * Batches requests to stay within the AWS limit of 20 ARNs per call.
   *
   * @param tenantId - (unused but kept for caller clarity / audit logging)
   * @param resourceArns - List of resource ARNs to untag
   */
  async untagResources(_tenantId: string, resourceArns: string[]): Promise<UntagResourcesResult> {
    if (resourceArns.length === 0) {
      return { untagged: 0, failures: {} };
    }

    const allFailures: Record<string, FailureInfo> = {};
    const batches = chunk(resourceArns, TAG_BATCH_SIZE);

    for (const batch of batches) {
      const output = await this.taggingClient.untagResources({
        ResourceARNList: batch,
        TagKeys: [this.tagKey],
      });

      if (output.FailedResourcesMap) {
        Object.assign(allFailures, output.FailedResourcesMap);
      }
    }

    const failedArns = new Set(Object.keys(allFailures));
    const untagged = resourceArns.filter((arn) => !failedArns.has(arn)).length;

    return { untagged, failures: allFailures };
  }

  /**
   * List all AWS resources currently tagged with a tenant's cost allocation tag.
   *
   * Follows pagination automatically.
   *
   * @param tenantId - Tenant identifier to look up
   * @returns List of resource tag mappings
   */
  async getTaggedResources(tenantId: string): Promise<ResourceTagMapping[]> {
    const results: ResourceTagMapping[] = [];
    let paginationToken: string | undefined;

    do {
      const output = await this.taggingClient.getResources({
        TagFilters: [{ Key: this.tagKey, Values: [tenantId] }],
        ...(paginationToken ? { PaginationToken: paginationToken } : {}),
      });

      if (output.ResourceTagMappingList) {
        results.push(...output.ResourceTagMappingList);
      }

      paginationToken = output.PaginationToken;
    } while (paginationToken);

    return results;
  }

  /**
   * Retrieve a full cost report for a tenant over a date range.
   *
   * Queries Cost Explorer with:
   * - Monthly granularity
   * - Filter: tag chimera:tenant-id = tenantId
   * - GroupBy: SERVICE
   *
   * @param tenantId - Tenant identifier
   * @param startDate - Start date in YYYY-MM-DD format (inclusive)
   * @param endDate - End date in YYYY-MM-DD format (exclusive)
   */
  async getTenantCostReport(
    tenantId: string,
    startDate: string,
    endDate: string,
  ): Promise<TenantCostReport> {
    const filter = buildTagFilter(this.tagKey, tenantId);

    const allResults: CostResultByTime[] = [];
    let nextPageToken: string | undefined;

    do {
      const output = await this.costExplorerClient.getCostAndUsage({
        TimePeriod: { Start: startDate, End: endDate },
        Granularity: 'MONTHLY',
        Filter: filter,
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        Metrics: ['UnblendedCost'],
        ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
      });

      if (output.ResultsByTime) {
        allResults.push(...output.ResultsByTime);
      }

      nextPageToken = output.NextPageToken;
    } while (nextPageToken);

    return buildCostReport(tenantId, startDate, endDate, allResults);
  }

  /**
   * Get monthly cost totals for a tenant over recent months.
   *
   * @param tenantId - Tenant identifier
   * @param numMonths - Number of months to look back (default: 3)
   */
  async getMonthlyTenantCosts(tenantId: string, numMonths: number = 3): Promise<MonthlyTenantCost[]> {
    const { start, end } = buildMonthRange(numMonths);
    const filter = buildTagFilter(this.tagKey, tenantId);

    const output = await this.costExplorerClient.getCostAndUsage({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Filter: filter,
      Metrics: ['UnblendedCost'],
    });

    return (output.ResultsByTime ?? []).map((result) => ({
      period: result.TimePeriod?.Start ?? '',
      costUsd: parseFloat(result.Total?.['UnblendedCost']?.Amount ?? '0'),
      estimated: result.Estimated ?? false,
    }));
  }

  /**
   * Get cost breakdown by AWS service for a tenant in a given billing period.
   *
   * @param tenantId - Tenant identifier
   * @param period - Period start date in YYYY-MM-DD format
   */
  async getServiceBreakdown(tenantId: string, period: string): Promise<ServiceCostBreakdown[]> {
    const start = period;
    const end = addOneMonth(period);
    const filter = buildTagFilter(this.tagKey, tenantId);

    const output = await this.costExplorerClient.getCostAndUsage({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Filter: filter,
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      Metrics: ['UnblendedCost'],
    });

    const breakdown: ServiceCostBreakdown[] = [];

    for (const result of output.ResultsByTime ?? []) {
      for (const group of result.Groups ?? []) {
        const service = group.Keys?.[0] ?? 'Unknown';
        const metric = group.Metrics?.['UnblendedCost'];
        breakdown.push({
          service,
          costUsd: parseFloat(metric?.Amount ?? '0'),
          unit: metric?.Unit ?? 'USD',
        });
      }
    }

    // Sort descending by cost
    return breakdown.sort((a, b) => b.costUsd - a.costUsd);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Split an array into chunks of at most `size` */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Build a Cost Explorer tag filter expression */
function buildTagFilter(tagKey: string, tagValue: string): object {
  return {
    Tags: {
      Key: tagKey,
      Values: [tagValue],
    },
  };
}

/**
 * Compute start/end dates for the last N complete months plus the current month.
 * Start is the first day of (numMonths) ago, end is today.
 */
function buildMonthRange(numMonths: number): { start: string; end: string } {
  const now = new Date();
  const end = toISODate(now);

  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - numMonths + 1);
  startDate.setDate(1);
  const start = toISODate(startDate);

  return { start, end };
}

/** Add one calendar month to a YYYY-MM-DD date string */
function addOneMonth(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  return toISODate(d);
}

/** Format a Date as YYYY-MM-DD */
function toISODate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Build a TenantCostReport from raw Cost Explorer results */
function buildCostReport(
  tenantId: string,
  startDate: string,
  endDate: string,
  results: CostResultByTime[],
): TenantCostReport {
  const serviceMap: Record<string, ServiceCostBreakdown> = {};
  const byMonth: MonthlyTenantCost[] = [];
  let totalCostUsd = 0;

  for (const result of results) {
    let periodTotal = 0;

    for (const group of result.Groups ?? []) {
      const service = group.Keys?.[0] ?? 'Unknown';
      const metric = group.Metrics?.['UnblendedCost'];
      const cost = parseFloat(metric?.Amount ?? '0');
      const unit = metric?.Unit ?? 'USD';

      if (!serviceMap[service]) {
        serviceMap[service] = { service, costUsd: 0, unit };
      }
      serviceMap[service].costUsd += cost;
      periodTotal += cost;
    }

    // Fall back to Total if no Groups
    if ((result.Groups ?? []).length === 0) {
      periodTotal = parseFloat(result.Total?.['UnblendedCost']?.Amount ?? '0');
    }

    totalCostUsd += periodTotal;

    byMonth.push({
      period: result.TimePeriod?.Start ?? '',
      costUsd: periodTotal,
      estimated: result.Estimated ?? false,
    });
  }

  const byService = Object.values(serviceMap).sort((a, b) => b.costUsd - a.costUsd);

  return { tenantId, startDate, endDate, totalCostUsd, byService, byMonth };
}
