/**
 * Resource Index - Unified In-Memory AWS Resource Index
 *
 * Aggregates data from AWS Config, Resource Explorer, Cost Explorer,
 * and CloudFormation into a fast, queryable in-memory index.
 *
 * Based on: docs/research/aws-account-agent/06-Account-Discovery-Architecture.md
 */

import type { CostAnalyzer, ResourceCost } from './cost-analyzer';
import type { TagOrganizer, Tag, TaggedResource } from './tag-organizer';

/**
 * Resource metadata from discovery services
 */
export interface ResourceMetadata {
  /** Resource ARN (unique identifier) */
  arn: string;

  /** Resource type (e.g., AWS::Lambda::Function) */
  resourceType: string;

  /** Resource ID */
  resourceId: string;

  /** AWS region */
  region: string;

  /** AWS account ID */
  accountId: string;

  /** Resource status */
  status: 'ACTIVE' | 'DELETED' | 'UNKNOWN';

  /** Creation timestamp */
  createdAt?: string;

  /** Last updated timestamp */
  lastUpdatedAt: string;

  /** Tags */
  tags: Record<string, string>;

  /** CloudFormation stack (if managed) */
  cloudFormationStack?: string;

  /** Managed by (cloudformation, terraform, manual) */
  managedBy?: string;

  /** Weekly cost */
  weeklyCost?: number;

  /** Daily cost average */
  dailyCostAvg?: number;

  /** Compliance status */
  compliant?: boolean;

  /** Last compliance check */
  lastComplianceCheck?: string;

  /** Resource dependencies (ARNs) */
  dependencies?: string[];

  /** Resources that depend on this (ARNs) */
  dependents?: string[];

  /** Full configuration (optional, can be large) */
  configuration?: any;
}

/**
 * Resource query filters
 */
export interface ResourceQuery {
  /** Filter by resource types */
  resourceTypes?: string[];

  /** Filter by regions */
  regions?: string[];

  /** Filter by status */
  statuses?: Array<'ACTIVE' | 'DELETED' | 'UNKNOWN'>;

  /** Filter by tags (AND logic) */
  tags?: Record<string, string>;

  /** Filter by CloudFormation stack */
  cloudFormationStack?: string;

  /** Filter by cost range */
  costRange?: { min?: number; max?: number };

  /** Filter by compliance */
  compliant?: boolean;

  /** Text search in ARN or resourceId */
  search?: string;

  /** Maximum results */
  limit?: number;
}

/**
 * Resource aggregation result
 */
export interface ResourceAggregation {
  totalResources: number;
  byType: Record<string, number>;
  byRegion: Record<string, number>;
  byStatus: Record<string, number>;
  byStack: Record<string, number>;
  totalCost: number;
  avgCostPerResource: number;
  complianceRate: number;
}

/**
 * Resource Index Configuration
 */
export interface ResourceIndexConfig {
  /** Cost Analyzer instance */
  costAnalyzer?: CostAnalyzer;

  /** Tag Organizer instance */
  tagOrganizer?: TagOrganizer;

  /** Enable automatic updates from EventBridge */
  enableAutoUpdate?: boolean;

  /** Update interval (seconds) */
  updateInterval?: number;

  /** Maximum index size */
  maxIndexSize?: number;
}

/**
 * Resource Index Service
 *
 * Provides unified, fast access to AWS resource data:
 * - In-memory index of all account resources
 * - Enriched with cost, tag, and compliance data
 * - Fast queries and aggregations
 * - Real-time updates from AWS Config changes
 */
export class ResourceIndex {
  private config: ResourceIndexConfig;
  private index: Map<string, ResourceMetadata>;
  private typeIndex: Map<string, Set<string>>; // resourceType -> Set<arn>
  private regionIndex: Map<string, Set<string>>; // region -> Set<arn>
  private tagIndex: Map<string, Set<string>>; // tagKey:tagValue -> Set<arn>
  private stackIndex: Map<string, Set<string>>; // stackName -> Set<arn>
  private lastUpdate: number;

  constructor(config: ResourceIndexConfig) {
    this.config = {
      enableAutoUpdate: false,
      updateInterval: 300, // 5 minutes
      maxIndexSize: 100000,
      ...config,
    };

    this.index = new Map();
    this.typeIndex = new Map();
    this.regionIndex = new Map();
    this.tagIndex = new Map();
    this.stackIndex = new Map();
    this.lastUpdate = 0;
  }

  /**
   * Add or update resource in index
   */
  async upsertResource(resource: ResourceMetadata): Promise<void> {
    const { arn } = resource;

    // Remove old indexes if updating
    const existing = this.index.get(arn);
    if (existing) {
      this.removeFromIndexes(existing);
    }

    // Store resource
    this.index.set(arn, resource);

    // Update indexes
    this.addToTypeIndex(resource);
    this.addToRegionIndex(resource);
    this.addToTagIndex(resource);
    if (resource.cloudFormationStack) {
      this.addToStackIndex(resource);
    }

    this.lastUpdate = Date.now();
  }

  /**
   * Get resource by ARN
   */
  getResource(arn: string): ResourceMetadata | undefined {
    return this.index.get(arn);
  }

  /**
   * Query resources with filters
   */
  queryResources(query: ResourceQuery): ResourceMetadata[] {
    let results: ResourceMetadata[] = [];

    // Start with full index or filtered by most selective index
    if (query.resourceTypes && query.resourceTypes.length > 0) {
      // Use type index
      const arns = new Set<string>();
      for (const type of query.resourceTypes) {
        const typeArns = this.typeIndex.get(type);
        if (typeArns) {
          typeArns.forEach(arn => arns.add(arn));
        }
      }
      results = Array.from(arns).map(arn => this.index.get(arn)!).filter(Boolean);
    } else if (query.regions && query.regions.length > 0) {
      // Use region index
      const arns = new Set<string>();
      for (const region of query.regions) {
        const regionArns = this.regionIndex.get(region);
        if (regionArns) {
          regionArns.forEach(arn => arns.add(arn));
        }
      }
      results = Array.from(arns).map(arn => this.index.get(arn)!).filter(Boolean);
    } else if (query.cloudFormationStack) {
      // Use stack index
      const stackArns = this.stackIndex.get(query.cloudFormationStack);
      results = stackArns
        ? Array.from(stackArns).map(arn => this.index.get(arn)!).filter(Boolean)
        : [];
    } else if (query.tags && Object.keys(query.tags).length > 0) {
      // Use tag index
      const tagKey = Object.keys(query.tags)[0];
      const tagValue = query.tags[tagKey];
      const tagArns = this.tagIndex.get(`${tagKey}:${tagValue}`);
      results = tagArns
        ? Array.from(tagArns).map(arn => this.index.get(arn)!).filter(Boolean)
        : [];
    } else {
      // No selective index, use full scan
      results = Array.from(this.index.values());
    }

    // Apply additional filters
    results = this.applyFilters(results, query);

    // Apply limit
    if (query.limit && query.limit > 0) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  /**
   * Get resources for a specific tenant
   */
  getTenantResources(tenantId: string, options?: {
    environment?: string;
    resourceTypes?: string[];
  }): ResourceMetadata[] {
    const query: ResourceQuery = {
      tags: { TenantId: tenantId },
      resourceTypes: options?.resourceTypes,
    };

    if (options?.environment) {
      query.tags!.Environment = options.environment;
    }

    return this.queryResources(query);
  }

  /**
   * Get aggregated statistics
   */
  getAggregation(query?: ResourceQuery): ResourceAggregation {
    const resources = query ? this.queryResources(query) : Array.from(this.index.values());

    const aggregation: ResourceAggregation = {
      totalResources: resources.length,
      byType: {},
      byRegion: {},
      byStatus: {},
      byStack: {},
      totalCost: 0,
      avgCostPerResource: 0,
      complianceRate: 0,
    };

    let complianceCount = 0;
    let costCount = 0;

    for (const resource of resources) {
      // By type
      aggregation.byType[resource.resourceType] =
        (aggregation.byType[resource.resourceType] || 0) + 1;

      // By region
      aggregation.byRegion[resource.region] =
        (aggregation.byRegion[resource.region] || 0) + 1;

      // By status
      aggregation.byStatus[resource.status] =
        (aggregation.byStatus[resource.status] || 0) + 1;

      // By stack
      if (resource.cloudFormationStack) {
        aggregation.byStack[resource.cloudFormationStack] =
          (aggregation.byStack[resource.cloudFormationStack] || 0) + 1;
      }

      // Cost
      if (resource.weeklyCost) {
        aggregation.totalCost += resource.weeklyCost;
        costCount++;
      }

      // Compliance
      if (resource.compliant !== undefined) {
        if (resource.compliant) complianceCount++;
      }
    }

    aggregation.avgCostPerResource = costCount > 0
      ? aggregation.totalCost / costCount
      : 0;

    aggregation.complianceRate = resources.length > 0
      ? (complianceCount / resources.length) * 100
      : 0;

    return aggregation;
  }

  /**
   * Search resources by text
   */
  searchResources(searchTerm: string, options?: {
    resourceTypes?: string[];
    regions?: string[];
    limit?: number;
  }): ResourceMetadata[] {
    const lowerSearch = searchTerm.toLowerCase();
    let results = Array.from(this.index.values()).filter(resource =>
      resource.arn.toLowerCase().includes(lowerSearch) ||
      resource.resourceId.toLowerCase().includes(lowerSearch) ||
      resource.resourceType.toLowerCase().includes(lowerSearch)
    );

    if (options?.resourceTypes) {
      results = results.filter(r => options.resourceTypes!.includes(r.resourceType));
    }

    if (options?.regions) {
      results = results.filter(r => options.regions!.includes(r.region));
    }

    if (options?.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /**
   * Enrich resource with cost data
   */
  async enrichWithCosts(resourceArn: string): Promise<void> {
    if (!this.config.costAnalyzer) return;

    const resource = this.index.get(resourceArn);
    if (!resource) return;

    try {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const costResult = await this.config.costAnalyzer.getCostAndUsage({
        timePeriod: {
          start: weekAgo.toISOString().split('T')[0],
          end: now.toISOString().split('T')[0],
        },
        granularity: 'DAILY',
        groupBy: [{ type: 'DIMENSION', key: 'RESOURCE_ID' }],
      });

      // Extract cost for this resource
      const weeklyCost = costResult.byResource?.[resource.resourceId] || 0;
      const dailyCostAvg = weeklyCost / 7;

      resource.weeklyCost = weeklyCost;
      resource.dailyCostAvg = dailyCostAvg;
      resource.lastUpdatedAt = new Date().toISOString();

      this.index.set(resourceArn, resource);
    } catch (error) {
      // Cost data not available, skip
    }
  }

  /**
   * Enrich resource with compliance data
   */
  async enrichWithCompliance(resourceArn: string): Promise<void> {
    if (!this.config.tagOrganizer) return;

    const resource = this.index.get(resourceArn);
    if (!resource) return;

    try {
      const results = await this.config.tagOrganizer.checkCompliance({
        resourceArns: [resourceArn],
      });

      if (results.length > 0) {
        resource.compliant = results[0].compliant;
        resource.lastComplianceCheck = new Date().toISOString();
        this.index.set(resourceArn, resource);
      }
    } catch (error) {
      // Compliance check failed, skip
    }
  }

  /**
   * Bulk enrich all resources with cost and compliance data
   */
  async enrichAll(): Promise<void> {
    const arns = Array.from(this.index.keys());

    // Process in batches to avoid overwhelming APIs
    const batchSize = 50;
    for (let i = 0; i < arns.length; i += batchSize) {
      const batch = arns.slice(i, i + batchSize);
      await Promise.all([
        ...batch.map(arn => this.enrichWithCosts(arn).catch(() => {})),
        ...batch.map(arn => this.enrichWithCompliance(arn).catch(() => {})),
      ]);
    }
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.index.clear();
    this.typeIndex.clear();
    this.regionIndex.clear();
    this.tagIndex.clear();
    this.stackIndex.clear();
    this.lastUpdate = 0;
  }

  /**
   * Get index statistics
   */
  getStats(): {
    totalResources: number;
    indexSize: number;
    lastUpdate: number;
    typeCount: number;
    regionCount: number;
    stackCount: number;
  } {
    return {
      totalResources: this.index.size,
      indexSize: this.estimateIndexSize(),
      lastUpdate: this.lastUpdate,
      typeCount: this.typeIndex.size,
      regionCount: this.regionIndex.size,
      stackCount: this.stackIndex.size,
    };
  }

  /**
   * Private: Apply filters to results
   */
  private applyFilters(resources: ResourceMetadata[], query: ResourceQuery): ResourceMetadata[] {
    let filtered = resources;

    // Filter by status
    if (query.statuses && query.statuses.length > 0) {
      filtered = filtered.filter(r => query.statuses!.includes(r.status));
    }

    // Filter by tags (AND logic)
    if (query.tags) {
      filtered = filtered.filter(resource => {
        for (const [key, value] of Object.entries(query.tags!)) {
          if (resource.tags[key] !== value) return false;
        }
        return true;
      });
    }

    // Filter by cost range
    if (query.costRange) {
      filtered = filtered.filter(r => {
        if (!r.weeklyCost) return false;
        if (query.costRange!.min && r.weeklyCost < query.costRange!.min) return false;
        if (query.costRange!.max && r.weeklyCost > query.costRange!.max) return false;
        return true;
      });
    }

    // Filter by compliance
    if (query.compliant !== undefined) {
      filtered = filtered.filter(r => r.compliant === query.compliant);
    }

    // Text search
    if (query.search) {
      const lowerSearch = query.search.toLowerCase();
      filtered = filtered.filter(r =>
        r.arn.toLowerCase().includes(lowerSearch) ||
        r.resourceId.toLowerCase().includes(lowerSearch)
      );
    }

    return filtered;
  }

  /**
   * Private: Index management
   */
  private addToTypeIndex(resource: ResourceMetadata): void {
    if (!this.typeIndex.has(resource.resourceType)) {
      this.typeIndex.set(resource.resourceType, new Set());
    }
    this.typeIndex.get(resource.resourceType)!.add(resource.arn);
  }

  private addToRegionIndex(resource: ResourceMetadata): void {
    if (!this.regionIndex.has(resource.region)) {
      this.regionIndex.set(resource.region, new Set());
    }
    this.regionIndex.get(resource.region)!.add(resource.arn);
  }

  private addToTagIndex(resource: ResourceMetadata): void {
    for (const [key, value] of Object.entries(resource.tags)) {
      const tagKey = `${key}:${value}`;
      if (!this.tagIndex.has(tagKey)) {
        this.tagIndex.set(tagKey, new Set());
      }
      this.tagIndex.get(tagKey)!.add(resource.arn);
    }
  }

  private addToStackIndex(resource: ResourceMetadata): void {
    if (!resource.cloudFormationStack) return;
    if (!this.stackIndex.has(resource.cloudFormationStack)) {
      this.stackIndex.set(resource.cloudFormationStack, new Set());
    }
    this.stackIndex.get(resource.cloudFormationStack)!.add(resource.arn);
  }

  private removeFromIndexes(resource: ResourceMetadata): void {
    // Remove from type index
    this.typeIndex.get(resource.resourceType)?.delete(resource.arn);

    // Remove from region index
    this.regionIndex.get(resource.region)?.delete(resource.arn);

    // Remove from tag index
    for (const [key, value] of Object.entries(resource.tags)) {
      const tagKey = `${key}:${value}`;
      this.tagIndex.get(tagKey)?.delete(resource.arn);
    }

    // Remove from stack index
    if (resource.cloudFormationStack) {
      this.stackIndex.get(resource.cloudFormationStack)?.delete(resource.arn);
    }
  }

  private estimateIndexSize(): number {
    // Rough estimate: each resource ~2KB in memory
    return this.index.size * 2048;
  }
}
