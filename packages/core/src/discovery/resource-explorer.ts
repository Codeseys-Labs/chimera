/**
 * AWS Resource Explorer 2 Cross-Region Search - Strands Tools
 *
 * Provides Strands @tool decorated functions for instant, tag-based resource
 * discovery across all AWS regions without pre-configuration.
 *
 * Resource Explorer offers:
 * - **Instant search**: No setup required for partial results (as of Oct 2025)
 * - **Tag-based queries**: Search by tags, resource types, regions
 * - **Cross-region**: Single query returns results from all regions
 * - **Fast**: Sub-second response times vs Config's 5-15 min latency
 * - **Unified search**: Same API powering AWS Console's search bar
 *
 * @see https://docs.aws.amazon.com/resource-explorer/latest/userguide/getting-started.html
 * @see docs/research/aws-account-agent/02-Resource-Explorer-Cross-Region-Search.md
 */

import { tool } from '../aws-tools/strands-agents';
import { z } from 'zod';
import type {
  ExplorerResource,
  ResourceFilter,
  ResourceQueryResult,
  ResourceInventoryEntry,
  AWSRegion,
  AWSResourceType,
  ResourceTag,
} from './types';
import { DiscoveryError } from './types';

/**
 * Resource Explorer configuration
 */
export interface ResourceExplorerConfig {
  /** Primary region for queries (should have aggregator index) */
  readonly primaryRegion: AWSRegion;

  /** AWS account ID */
  readonly accountId: string;

  /** Default view ARN (optional, uses default view if not specified) */
  readonly viewArn?: string;

  /** Enable aggregator index for complete results (vs instant partial results) */
  readonly useAggregator?: boolean;
}

/**
 * Resource Explorer query string builder
 *
 * Resource Explorer uses a query string DSL:
 * - `tag:Key=value` — Search by tag
 * - `resourcetype:service:type` — Filter by resource type
 * - `region:us-east-1` — Filter by region
 * - Wildcards: `tag:Project=chimera*`
 */
export class ExplorerQueryBuilder {
  private parts: string[] = [];

  withTag(key: string, value?: string): this {
    if (value) {
      this.parts.push(`tag:${key}=${value}`);
    } else {
      this.parts.push(`tag:${key}`);
    }
    return this;
  }

  withResourceType(service: string, type: string): this {
    this.parts.push(`resourcetype:${service}:${type}`);
    return this;
  }

  withRegion(region: AWSRegion): this {
    this.parts.push(`region:${region}`);
    return this;
  }

  withSearchTerm(term: string): this {
    this.parts.push(term);
    return this;
  }

  build(): string {
    return this.parts.join(' ');
  }

  static fromFilter(filter: ResourceFilter): string {
    const builder = new ExplorerQueryBuilder();

    if (filter.tags) {
      filter.tags.forEach((tag) => builder.withTag(tag.key, tag.value));
    }

    if (filter.regions) {
      filter.regions.forEach((region) => builder.withRegion(region));
    }

    if (filter.resourceTypes) {
      filter.resourceTypes.forEach((type) => {
        const [service, resourceType] = this.parseResourceType(type);
        if (service && resourceType) {
          builder.withResourceType(service, resourceType);
        }
      });
    }

    const query = builder.build();
    return query || '*';
  }

  private static parseResourceType(awsType: string): [string | null, string | null] {
    const match = awsType.match(/^AWS::([^:]+)::(.+)$/);
    if (!match) return [null, null];

    const service = match[1].toLowerCase();
    const type = match[2]
      .replace(/([A-Z])/g, '-$1')
      .toLowerCase()
      .replace(/^-/, '');

    return [service, type];
  }
}

/**
 * Create Resource Explorer Strands tools
 *
 * Factory function that creates Strands tools for AWS Resource Explorer operations.
 * Each public method from the ResourceExplorer class becomes a standalone tool.
 *
 * @param config - Resource Explorer configuration
 * @returns Array of Strands tools for resource search operations
 */
export function createResourceExplorerTools(config: ResourceExplorerConfig) {
  const search = tool({
    name: 'explorer_search',
    description:
      'Search AWS resources using query string DSL. Supports tag-based queries, resource type filters, and region filters with wildcards.',
    inputSchema: z.object({
      queryString: z
        .string()
        .describe(
          'Query string (e.g., "tag:Environment=production resourcetype:lambda:function region:us-east-1")'
        ),
      maxResults: z.number().min(1).max(1000).default(100).describe('Maximum results to return'),
      nextToken: z.string().optional().describe('Pagination token'),
    }),
    callback: async (input) => {
      try {
        const { resources, nextToken } = await executeSearch(
          config,
          input.queryString,
          input.maxResults ?? 100,
          input.nextToken
        );

        const result: ResourceQueryResult = {
          items: resources.map((r) => explorerResourceToInventoryEntry(config, r)),
          pagination: {
            nextToken,
            hasMore: !!nextToken,
            totalCount: resources.length,
            pageSize: input.maxResults ?? 100,
          },
        };

        return JSON.stringify(result, null, 2);
      } catch (error) {
        throw handleExplorerError(error, 'search');
      }
    },
  });

  const searchWithFilter = tool({
    name: 'explorer_search_with_filter',
    description:
      'Search resources using structured filters. Converts filters to query string automatically.',
    inputSchema: z.object({
      resourceTypes: z
        .array(z.string())
        .optional()
        .describe('Filter by resource types (e.g., ["AWS::Lambda::Function"])'),
      regions: z
        .array(z.string())
        .optional()
        .describe('Filter by regions (e.g., ["us-east-1", "us-west-2"])'),
      tags: z
        .array(
          z.object({
            key: z.string(),
            value: z.string().optional(),
          })
        )
        .optional()
        .describe('Filter by tags'),
      limit: z.number().min(1).max(1000).default(100).describe('Maximum results'),
      nextToken: z.string().optional().describe('Pagination token'),
    }),
    callback: async (input) => {
      const filter: ResourceFilter = {
        resourceTypes: input.resourceTypes as AWSResourceType[] | undefined,
        regions: input.regions as AWSRegion[] | undefined,
        tags: input.tags,
      };

      const queryString = ExplorerQueryBuilder.fromFilter(filter);

      const { resources, nextToken } = await executeSearch(
        config,
        queryString,
        input.limit ?? 100,
        input.nextToken
      );

      const result: ResourceQueryResult = {
        items: resources.map((r) => explorerResourceToInventoryEntry(config, r)),
        pagination: {
          nextToken,
          hasMore: !!nextToken,
          totalCount: resources.length,
          pageSize: input.limit ?? 100,
        },
      };

      return JSON.stringify(result, null, 2);
    },
  });

  const findByTag = tool({
    name: 'explorer_find_by_tag',
    description:
      'Find resources by a single tag. Simplified interface for common tag-based searches.',
    inputSchema: z.object({
      tagKey: z.string().describe('Tag key to search for'),
      tagValue: z
        .string()
        .optional()
        .describe('Tag value (optional, supports wildcards like "prod*")'),
      maxResults: z.number().min(1).max(1000).default(100).describe('Maximum results'),
    }),
    callback: async (input) => {
      const queryString = input.tagValue
        ? `tag:${input.tagKey}=${input.tagValue}`
        : `tag:${input.tagKey}`;

      const { resources } = await executeSearch(config, queryString, input.maxResults ?? 100);
      const items = resources.map((r) => explorerResourceToInventoryEntry(config, r));

      return JSON.stringify({ resources: items }, null, 2);
    },
  });

  const findByType = tool({
    name: 'explorer_find_by_type',
    description:
      'Find resources by AWS service and type. Example: findByType("dynamodb", "table") finds all DynamoDB tables.',
    inputSchema: z.object({
      service: z.string().describe('AWS service (e.g., "lambda", "dynamodb", "ec2")'),
      type: z.string().describe('Resource type (e.g., "function", "table", "instance")'),
      maxResults: z.number().min(1).max(1000).default(100).describe('Maximum results'),
    }),
    callback: async (input) => {
      const queryString = `resourcetype:${input.service}:${input.type}`;

      const { resources } = await executeSearch(config, queryString, input.maxResults ?? 100);
      const items = resources.map((r) => explorerResourceToInventoryEntry(config, r));

      return JSON.stringify({ resources: items }, null, 2);
    },
  });

  const autocomplete = tool({
    name: 'explorer_autocomplete',
    description:
      'Autocomplete resource search. Returns up to 10 matching resources for search-as-you-type functionality.',
    inputSchema: z.object({
      searchTerm: z.string().describe('Partial search term to match'),
    }),
    callback: async (input) => {
      const { resources } = await executeSearch(config, input.searchTerm, 10);
      const items = resources.map((r) => explorerResourceToInventoryEntry(config, r));

      return JSON.stringify({ suggestions: items }, null, 2);
    },
  });

  const getIndexStatus = tool({
    name: 'explorer_get_index_status',
    description:
      'Get Resource Explorer index status. Check if aggregator index is configured and its health.',
    inputSchema: z.object({}),
    callback: async () => {
      try {
        const status = await fetchIndexStatus(config);
        return JSON.stringify(status, null, 2);
      } catch (error) {
        return JSON.stringify({
          exists: false,
          type: null,
          region: null,
          state: null,
        });
      }
    },
  });

  const createAggregatorIndex = tool({
    name: 'explorer_create_aggregator_index',
    description:
      'Create or promote aggregator index for complete historical results. Promotes a regional index to aggregator status.',
    inputSchema: z.object({
      region: z.string().optional().describe('Region to promote (default: primary region)'),
    }),
    callback: async (input) => {
      const targetRegion = (input.region as AWSRegion | undefined) ?? config.primaryRegion;

      try {
        await promoteToAggregator(config, targetRegion);
        return JSON.stringify({
          success: true,
          message: `Aggregator index created in ${targetRegion}`,
        });
      } catch (error) {
        throw handleExplorerError(error, 'createAggregatorIndex');
      }
    },
  });

  return [
    search,
    searchWithFilter,
    findByTag,
    findByType,
    autocomplete,
    getIndexStatus,
    createAggregatorIndex,
  ];
}

// ============================================================================
// Private helper functions — real AWS SDK v3 implementations
// ============================================================================

async function executeSearch(
  config: ResourceExplorerConfig,
  queryString: string,
  maxResults: number,
  nextToken?: string
): Promise<{ resources: ExplorerResource[]; nextToken?: string }> {
  const { ResourceExplorer2Client, SearchCommand } =
    await import('@aws-sdk/client-resource-explorer-2');

  const client = new ResourceExplorer2Client({ region: config.primaryRegion });
  const commandInput: any = {
    QueryString: queryString,
    MaxResults: maxResults,
  };

  if (nextToken) {
    commandInput.NextToken = nextToken;
  }
  if (config.viewArn) {
    commandInput.ViewArn = config.viewArn;
  }

  const command = new SearchCommand(commandInput);
  const response = await client.send(command);

  const resources: ExplorerResource[] = (response.Resources ?? []).map((r) => ({
    arn: r.Arn ?? '',
    resourceType: r.ResourceType ?? '',
    region: (r.Region ?? '') as AWSRegion,
    service: r.Service ?? '',
    lastReportedAt: r.LastReportedAt?.toISOString() ?? new Date().toISOString(),
    properties: (r.Properties ?? []).map((p) => ({
      name: p.Name ?? '',
      data: p.Data,
    })),
    owningAccountId: r.OwningAccountId ?? config.accountId,
  }));

  return { resources, nextToken: response.NextToken };
}

async function fetchIndexStatus(config: ResourceExplorerConfig): Promise<{
  exists: boolean;
  type: 'AGGREGATOR' | 'LOCAL' | null;
  region: AWSRegion | null;
  state: 'ACTIVE' | 'CREATING' | 'DELETING' | 'UPDATING' | null;
}> {
  const { ResourceExplorer2Client, GetIndexCommand } =
    await import('@aws-sdk/client-resource-explorer-2');

  const client = new ResourceExplorer2Client({ region: config.primaryRegion });
  const command = new GetIndexCommand({});

  try {
    const response = await client.send(command);
    return {
      exists: true,
      type: (response.Type as 'AGGREGATOR' | 'LOCAL') ?? null,
      region: (response.Arn?.split(':')[3] ?? null) as AWSRegion | null,
      state: (response.State as 'ACTIVE' | 'CREATING' | 'DELETING' | 'UPDATING') ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ResourceNotFoundException') || message.includes('IndexNotFound')) {
      return { exists: false, type: null, region: null, state: null };
    }
    throw error;
  }
}

async function promoteToAggregator(
  config: ResourceExplorerConfig,
  region: AWSRegion
): Promise<void> {
  const { ResourceExplorer2Client, UpdateIndexTypeCommand } =
    await import('@aws-sdk/client-resource-explorer-2');

  const client = new ResourceExplorer2Client({ region });
  const command = new UpdateIndexTypeCommand({
    Arn: `arn:aws:resource-explorer-2:${region}:${config.accountId}:index/default`,
    Type: 'AGGREGATOR',
  });

  await client.send(command);
}

function explorerResourceToInventoryEntry(
  config: ResourceExplorerConfig,
  resource: ExplorerResource
): ResourceInventoryEntry {
  const tags: ResourceTag[] = [];
  if (resource.properties) {
    resource.properties.forEach((prop) => {
      if (prop.name === 'tags' && Array.isArray(prop.data)) {
        (prop.data as Array<{ key: string; value: string }>).forEach((tag) => {
          tags.push({ key: tag.key, value: tag.value });
        });
      }
    });
  }

  return {
    arn: resource.arn,
    resourceType: resource.resourceType as any,
    resourceId: extractResourceIdFromArn(resource.arn),
    region: resource.region,
    accountId: resource.owningAccountId,
    status: 'OK',
    tags,
    lastUpdatedAt: resource.lastReportedAt,
  };
}

function extractResourceIdFromArn(arn: string): string {
  const parts = arn.split(':');
  const resourcePart = parts[parts.length - 1];
  return resourcePart.split('/').pop() ?? resourcePart;
}

function handleExplorerError(error: unknown, operation: string): DiscoveryError {
  if (error instanceof DiscoveryError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('AccessDenied') || message.includes('UnauthorizedOperation')) {
    return new DiscoveryError(
      'PERMISSION_DENIED',
      `Explorer ${operation} denied: ${message}`,
      error
    );
  }

  if (message.includes('IndexNotFoundException')) {
    return new DiscoveryError(
      'INDEX_NOT_FOUND',
      `Resource Explorer index not found: ${message}`,
      error
    );
  }

  if (message.includes('ValidationException')) {
    return new DiscoveryError('INVALID_QUERY', `Explorer query syntax error: ${message}`, error);
  }

  if (message.includes('ThrottlingException') || message.includes('TooManyRequestsException')) {
    return new DiscoveryError('RATE_LIMIT_EXCEEDED', `Explorer API rate limit: ${message}`, error);
  }

  if (message.includes('ServiceUnavailableException')) {
    return new DiscoveryError(
      'SERVICE_UNAVAILABLE',
      `Explorer service unavailable: ${message}`,
      error
    );
  }

  return new DiscoveryError('INTERNAL_ERROR', `Explorer ${operation} failed: ${message}`, error);
}
