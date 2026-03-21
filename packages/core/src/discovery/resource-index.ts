/**
 * Resource Index - Unified In-Memory AWS Resource Index - Strands Tools
 *
 * Provides Strands @tool decorated functions for aggregating data from AWS
 * Config, Resource Explorer, Cost Explorer, and CloudFormation into a fast,
 * queryable in-memory index.
 *
 * Based on: docs/research/aws-account-agent/06-Account-Discovery-Architecture.md
 */

import { tool } from '@strands-agents/sdk';
import { z } from 'zod';

/**
 * Resource metadata from discovery services
 */
export interface ResourceMetadata {
  arn: string;
  resourceType: string;
  resourceId: string;
  region: string;
  accountId: string;
  status: 'ACTIVE' | 'DELETED' | 'UNKNOWN';
  createdAt?: string;
  lastUpdatedAt: string;
  tags: Record<string, string>;
  cloudFormationStack?: string;
  managedBy?: string;
  weeklyCost?: number;
  dailyCostAvg?: number;
  compliant?: boolean;
  lastComplianceCheck?: string;
  dependencies?: string[];
  dependents?: string[];
  configuration?: any;
}

/**
 * Resource query filters
 */
export interface ResourceQuery {
  resourceTypes?: string[];
  regions?: string[];
  statuses?: Array<'ACTIVE' | 'DELETED' | 'UNKNOWN'>;
  tags?: Record<string, string>;
  cloudFormationStack?: string;
  costRange?: { min?: number; max?: number };
  compliant?: boolean;
  search?: string;
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
  /** Enable automatic updates from EventBridge */
  enableAutoUpdate?: boolean;

  /** Update interval (seconds) */
  updateInterval?: number;

  /** Maximum index size */
  maxIndexSize?: number;
}

/**
 * Create Resource Index Strands tools
 *
 * Factory function that creates Strands tools for unified resource index operations.
 * The index aggregates data from multiple AWS services for fast queries.
 */
export function createResourceIndexTools(config: ResourceIndexConfig) {
  const index = new Map<string, ResourceMetadata>();
  const typeIndex = new Map<string, Set<string>>();
  const regionIndex = new Map<string, Set<string>>();
  const tagIndex = new Map<string, Set<string>>();
  const stackIndex = new Map<string, Set<string>>();

  const upsertResource = tool({
    name: 'index_upsert_resource',
    description: 'Add or update a resource in the unified index.',
    inputSchema: z.object({
      resource: z.object({
        arn: z.string(),
        resourceType: z.string(),
        resourceId: z.string(),
        region: z.string(),
        accountId: z.string(),
        status: z.enum(['ACTIVE', 'DELETED', 'UNKNOWN']),
        lastUpdatedAt: z.string(),
        tags: z.record(z.string()),
        cloudFormationStack: z.string().optional(),
        weeklyCost: z.number().optional(),
        dailyCostAvg: z.number().optional(),
        compliant: z.boolean().optional(),
      }).describe('Resource metadata to index'),
    }),
    callback: async (input) => {
      const resource = input.resource as ResourceMetadata;
      const existing = index.get(resource.arn);

      if (existing) {
        removeFromIndexes(existing, typeIndex, regionIndex, tagIndex, stackIndex);
      }

      index.set(resource.arn, resource);
      addToIndexes(resource, typeIndex, regionIndex, tagIndex, stackIndex);

      return JSON.stringify({ success: true, arn: resource.arn });
    },
  });

  const getResource = tool({
    name: 'index_get_resource',
    description: 'Get resource metadata by ARN from the index.',
    inputSchema: z.object({
      arn: z.string().describe('Resource ARN'),
    }),
    callback: async (input) => {
      const resource = index.get(input.arn);
      if (!resource) {
        return JSON.stringify({ error: 'Resource not found' });
      }
      return JSON.stringify(resource, null, 2);
    },
  });

  const queryResources = tool({
    name: 'index_query_resources',
    description: 'Query resources with flexible filtering options.',
    inputSchema: z.object({
      resourceTypes: z.array(z.string()).optional().describe('Filter by resource types'),
      regions: z.array(z.string()).optional().describe('Filter by regions'),
      statuses: z.array(z.enum(['ACTIVE', 'DELETED', 'UNKNOWN'])).optional().describe('Filter by status'),
      tags: z.record(z.string()).optional().describe('Filter by tags (AND logic)'),
      cloudFormationStack: z.string().optional().describe('Filter by CloudFormation stack'),
      costMin: z.number().optional().describe('Minimum weekly cost'),
      costMax: z.number().optional().describe('Maximum weekly cost'),
      compliant: z.boolean().optional().describe('Filter by compliance'),
      search: z.string().optional().describe('Text search in ARN or ID'),
      limit: z.number().default(100).describe('Maximum results'),
    }),
    callback: async (input) => {
      const query: ResourceQuery = {
        resourceTypes: input.resourceTypes,
        regions: input.regions,
        statuses: input.statuses as any,
        tags: input.tags,
        cloudFormationStack: input.cloudFormationStack,
        costRange: input.costMin || input.costMax ? { min: input.costMin, max: input.costMax } : undefined,
        compliant: input.compliant,
        search: input.search,
        limit: input.limit,
      };

      const results = queryResourcesImpl(index, query);
      return JSON.stringify({ resources: results }, null, 2);
    },
  });

  const getTenantResources = tool({
    name: 'index_get_tenant_resources',
    description: 'Get all resources owned by a specific tenant.',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant identifier'),
      resourceTypes: z.array(z.string()).optional().describe('Filter by resource types'),
      includeDeleted: z.boolean().default(false).describe('Include deleted resources'),
    }),
    callback: async (input) => {
      const query: ResourceQuery = {
        tags: { TenantId: input.tenantId },
        resourceTypes: input.resourceTypes,
        statuses: input.includeDeleted ? undefined : ['ACTIVE'],
      };

      const results = queryResourcesImpl(index, query);
      return JSON.stringify({ tenantId: input.tenantId, resources: results }, null, 2);
    },
  });

  const getAggregation = tool({
    name: 'index_get_aggregation',
    description: 'Get aggregated statistics across all resources or filtered subset.',
    inputSchema: z.object({
      resourceTypes: z.array(z.string()).optional().describe('Filter by resource types'),
      regions: z.array(z.string()).optional().describe('Filter by regions'),
      tags: z.record(z.string()).optional().describe('Filter by tags'),
    }),
    callback: async (input) => {
      const query: ResourceQuery = {
        resourceTypes: input.resourceTypes,
        regions: input.regions,
        tags: input.tags,
      };

      const aggregation = getAggregationImpl(index, query);
      return JSON.stringify(aggregation, null, 2);
    },
  });

  const searchResources = tool({
    name: 'index_search_resources',
    description: 'Search resources by text term matching ARN, resource ID, or tags.',
    inputSchema: z.object({
      searchTerm: z.string().describe('Search term'),
      resourceTypes: z.array(z.string()).optional().describe('Filter by resource types'),
      regions: z.array(z.string()).optional().describe('Filter by regions'),
      limit: z.number().default(50).describe('Maximum results'),
    }),
    callback: async (input) => {
      const query: ResourceQuery = {
        search: input.searchTerm,
        resourceTypes: input.resourceTypes,
        regions: input.regions,
        limit: input.limit,
      };

      const results = queryResourcesImpl(index, query);
      return JSON.stringify({ searchTerm: input.searchTerm, results }, null, 2);
    },
  });

  const getStats = tool({
    name: 'index_get_stats',
    description: 'Get index statistics (total resources, memory usage, last update time).',
    inputSchema: z.object({}),
    callback: async () => {
      const stats = {
        totalResources: index.size,
        totalTypes: typeIndex.size,
        totalRegions: regionIndex.size,
        totalStacks: stackIndex.size,
        memoryUsage: `${(index.size * 2 / 1024).toFixed(2)} KB`, // Rough estimate
        lastUpdate: new Date().toISOString(),
      };

      return JSON.stringify(stats, null, 2);
    },
  });

  const clear = tool({
    name: 'index_clear',
    description: 'Clear all resources from the index.',
    inputSchema: z.object({
      confirm: z.boolean().describe('Must be true to confirm clearing the index'),
    }),
    callback: async (input) => {
      if (!input.confirm) {
        return JSON.stringify({ error: 'Confirmation required to clear index' });
      }

      index.clear();
      typeIndex.clear();
      regionIndex.clear();
      tagIndex.clear();
      stackIndex.clear();

      return JSON.stringify({ success: true, message: 'Index cleared' });
    },
  });

  return [
    upsertResource,
    getResource,
    queryResources,
    getTenantResources,
    getAggregation,
    searchResources,
    getStats,
    clear,
  ];
}

// ============================================================================
// Private helper functions
// ============================================================================

function queryResourcesImpl(index: Map<string, ResourceMetadata>, query: ResourceQuery): ResourceMetadata[] {
  let results = Array.from(index.values());

  if (query.resourceTypes) {
    results = results.filter(r => query.resourceTypes!.includes(r.resourceType));
  }

  if (query.regions) {
    results = results.filter(r => query.regions!.includes(r.region));
  }

  if (query.statuses) {
    results = results.filter(r => query.statuses!.includes(r.status));
  }

  if (query.tags) {
    results = results.filter(r => {
      return Object.entries(query.tags!).every(([key, value]) => r.tags[key] === value);
    });
  }

  if (query.cloudFormationStack) {
    results = results.filter(r => r.cloudFormationStack === query.cloudFormationStack);
  }

  if (query.costRange) {
    results = results.filter(r => {
      if (!r.weeklyCost) return false;
      const { min, max } = query.costRange!;
      if (min !== undefined && r.weeklyCost < min) return false;
      if (max !== undefined && r.weeklyCost > max) return false;
      return true;
    });
  }

  if (query.compliant !== undefined) {
    results = results.filter(r => r.compliant === query.compliant);
  }

  if (query.search) {
    const searchLower = query.search.toLowerCase();
    results = results.filter(r =>
      r.arn.toLowerCase().includes(searchLower) ||
      r.resourceId.toLowerCase().includes(searchLower)
    );
  }

  if (query.limit) {
    results = results.slice(0, query.limit);
  }

  return results;
}

function getAggregationImpl(index: Map<string, ResourceMetadata>, query?: ResourceQuery): ResourceAggregation {
  const resources = query ? queryResourcesImpl(index, query) : Array.from(index.values());

  const byType: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byStack: Record<string, number> = {};
  let totalCost = 0;
  let compliantCount = 0;

  for (const resource of resources) {
    byType[resource.resourceType] = (byType[resource.resourceType] || 0) + 1;
    byRegion[resource.region] = (byRegion[resource.region] || 0) + 1;
    byStatus[resource.status] = (byStatus[resource.status] || 0) + 1;

    if (resource.cloudFormationStack) {
      byStack[resource.cloudFormationStack] = (byStack[resource.cloudFormationStack] || 0) + 1;
    }

    if (resource.weeklyCost) {
      totalCost += resource.weeklyCost;
    }

    if (resource.compliant) {
      compliantCount++;
    }
  }

  return {
    totalResources: resources.length,
    byType,
    byRegion,
    byStatus,
    byStack,
    totalCost,
    avgCostPerResource: resources.length > 0 ? totalCost / resources.length : 0,
    complianceRate: resources.length > 0 ? (compliantCount / resources.length) * 100 : 0,
  };
}

function addToIndexes(
  resource: ResourceMetadata,
  typeIndex: Map<string, Set<string>>,
  regionIndex: Map<string, Set<string>>,
  tagIndex: Map<string, Set<string>>,
  stackIndex: Map<string, Set<string>>
): void {
  if (!typeIndex.has(resource.resourceType)) {
    typeIndex.set(resource.resourceType, new Set());
  }
  typeIndex.get(resource.resourceType)!.add(resource.arn);

  if (!regionIndex.has(resource.region)) {
    regionIndex.set(resource.region, new Set());
  }
  regionIndex.get(resource.region)!.add(resource.arn);

  for (const [key, value] of Object.entries(resource.tags)) {
    const tagKey = `${key}:${value}`;
    if (!tagIndex.has(tagKey)) {
      tagIndex.set(tagKey, new Set());
    }
    tagIndex.get(tagKey)!.add(resource.arn);
  }

  if (resource.cloudFormationStack) {
    if (!stackIndex.has(resource.cloudFormationStack)) {
      stackIndex.set(resource.cloudFormationStack, new Set());
    }
    stackIndex.get(resource.cloudFormationStack)!.add(resource.arn);
  }
}

function removeFromIndexes(
  resource: ResourceMetadata,
  typeIndex: Map<string, Set<string>>,
  regionIndex: Map<string, Set<string>>,
  tagIndex: Map<string, Set<string>>,
  stackIndex: Map<string, Set<string>>
): void {
  typeIndex.get(resource.resourceType)?.delete(resource.arn);
  regionIndex.get(resource.region)?.delete(resource.arn);

  for (const [key, value] of Object.entries(resource.tags)) {
    const tagKey = `${key}:${value}`;
    tagIndex.get(tagKey)?.delete(resource.arn);
  }

  if (resource.cloudFormationStack) {
    stackIndex.get(resource.cloudFormationStack)?.delete(resource.arn);
  }
}
