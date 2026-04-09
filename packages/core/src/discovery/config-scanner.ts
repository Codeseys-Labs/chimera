/**
 * AWS Config Resource Inventory Scanner - Strands Tools
 *
 * Provides Strands @tool decorated functions for AWS Config resource discovery,
 * configuration history, and relationship tracking across all regions.
 *
 * AWS Config offers:
 * - Continuous recording of resource configurations (~5-15 min latency)
 * - SQL-based advanced queries across all resource types
 * - Resource relationship mapping (what depends on what)
 * - Configuration history (time-travel queries)
 * - Compliance rule evaluation
 *
 * @see https://docs.aws.amazon.com/config/latest/developerguide/aggregate-data.html
 * @see docs/research/aws-account-agent/01-AWS-Config-Resource-Inventory.md
 */

import { tool } from '../aws-tools/strands-agents';
import { z } from 'zod';
import type {
  ConfigurationItem,
  ResourceFilter,
  ResourceQueryResult,
  ResourceInventoryEntry,
  AWSResourceType,
  AWSRegion,
  ResourceStatus,
} from './types';
import { DiscoveryError } from './types';

/**
 * AWS Config aggregator configuration
 */
export interface ConfigAggregatorConfig {
  /** Aggregator name (e.g., 'chimera-global-aggregator') */
  readonly aggregatorName: string;

  /** Primary region where aggregator is deployed */
  readonly aggregatorRegion: AWSRegion;

  /** AWS account ID */
  readonly accountId: string;

  /** Regions included in aggregation (default: all enabled regions) */
  readonly regions?: AWSRegion[];
}

/**
 * Create Config Scanner Strands tools
 *
 * Factory function that creates Strands tools for AWS Config operations.
 * Each public method from the ConfigScanner class becomes a standalone tool.
 *
 * @param config - Config aggregator configuration
 * @returns Array of Strands tools for Config operations
 *
 * @example
 * ```typescript
 * const configTools = createConfigScannerTools({
 *   aggregatorName: 'chimera-global-aggregator',
 *   aggregatorRegion: 'us-east-1',
 *   accountId: '123456789012'
 * });
 *
 * const agent = Agent({
 *   tools: configTools,
 *   // ...
 * });
 * ```
 */
export function createConfigScannerTools(config: ConfigAggregatorConfig) {
  /**
   * Query resources using AWS Config advanced query syntax (SQL-like)
   */
  const advancedQuery = tool({
    name: 'config_advanced_query',
    description:
      'Query AWS resources using SQL-like syntax. Supports full SQL filtering, projecting, and joining across all resource types in the account.',
    inputSchema: z.object({
      expression: z
        .string()
        .describe(
          'SQL-like query expression (e.g., "SELECT * WHERE resourceType = \'AWS::Lambda::Function\' AND configuration.memorySize > 1024")'
        ),
      limit: z
        .number()
        .min(1)
        .max(500)
        .default(100)
        .describe('Maximum results to return (default: 100, max: 500)'),
      nextToken: z.string().optional().describe('Pagination token from previous query'),
    }),
    callback: async (input) => {
      try {
        const result = await executeAdvancedQuery(config, input);
        return JSON.stringify(result, null, 2);
      } catch (error) {
        throw handleConfigError(error, 'advancedQuery');
      }
    },
  });

  /**
   * List all resources of specific types across all regions
   */
  const listResources = tool({
    name: 'config_list_resources',
    description:
      'List AWS resources by type with optional filters. Simpler interface than advanced_query for common listing operations.',
    inputSchema: z.object({
      resourceTypes: z
        .array(z.string())
        .optional()
        .describe('Filter by resource types (e.g., ["AWS::Lambda::Function", "AWS::S3::Bucket"])'),
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
        .describe('Filter by tags (e.g., [{"key": "Environment", "value": "production"}])'),
      statuses: z
        .array(z.string())
        .optional()
        .describe('Filter by config status (e.g., ["OK", "ResourceDiscovered"])'),
      limit: z.number().min(1).max(500).default(100).describe('Maximum results to return'),
      nextToken: z.string().optional().describe('Pagination token'),
      includeRelationships: z
        .boolean()
        .default(false)
        .describe('Include resource relationships in results'),
    }),
    callback: async (input) => {
      try {
        const filter: ResourceFilter = {
          resourceTypes: input.resourceTypes as AWSResourceType[] | undefined,
          regions: input.regions as AWSRegion[] | undefined,
          tags: input.tags,
          statuses: input.statuses as ResourceStatus[] | undefined,
        };

        // Build SQL query from filters
        const expression = buildQueryFromFilter(filter);

        const result = await executeAdvancedQuery(config, {
          expression,
          limit: input.limit,
          nextToken: input.nextToken,
        });

        return JSON.stringify(result, null, 2);
      } catch (error) {
        throw handleConfigError(error, 'listResources');
      }
    },
  });

  /**
   * Get configuration history for a specific resource
   */
  const getConfigurationHistory = tool({
    name: 'config_get_history',
    description:
      'Get configuration history for a specific resource. Returns all recorded configuration changes, enabling time-travel queries.',
    inputSchema: z.object({
      resourceType: z.string().describe('AWS resource type (e.g., "AWS::Lambda::Function")'),
      resourceId: z.string().describe('Resource identifier (e.g., "agent-runtime")'),
      region: z.string().describe('AWS region (e.g., "us-east-1")'),
      startTime: z.string().optional().describe('Start time for history window (ISO 8601 format)'),
      endTime: z.string().optional().describe('End time for history window (ISO 8601 format)'),
      chronologicalOrder: z
        .enum(['Forward', 'Reverse'])
        .default('Reverse')
        .describe('Sort order (Reverse = newest first)'),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(10)
        .describe('Maximum results (default: 10, max: 100)'),
      nextToken: z.string().optional().describe('Pagination token'),
    }),
    callback: async (input) => {
      try {
        const result = await fetchConfigHistory(config, {
          resourceType: input.resourceType as AWSResourceType,
          resourceId: input.resourceId,
          region: input.region as AWSRegion,
          startTime: input.startTime ? new Date(input.startTime) : undefined,
          endTime: input.endTime ? new Date(input.endTime) : undefined,
          chronologicalOrder: input.chronologicalOrder,
          limit: input.limit,
          nextToken: input.nextToken,
        });

        return JSON.stringify(result, null, 2);
      } catch (error) {
        throw handleConfigError(error, 'getConfigurationHistory');
      }
    },
  });

  /**
   * Get current configuration snapshot for a resource
   */
  const getCurrentConfiguration = tool({
    name: 'config_get_current',
    description:
      'Get the most recent configuration snapshot for a specific resource recorded by AWS Config.',
    inputSchema: z.object({
      resourceType: z.string().describe('AWS resource type (e.g., "AWS::EC2::Instance")'),
      resourceId: z.string().describe('Resource identifier (e.g., "i-1234567890abcdef0")'),
      region: z.string().describe('AWS region (e.g., "us-east-1")'),
    }),
    callback: async (input) => {
      try {
        const result = await fetchCurrentConfig(
          config,
          input.resourceType as AWSResourceType,
          input.resourceId,
          input.region as AWSRegion
        );

        if (!result) {
          return JSON.stringify({ error: 'Resource not found or not recorded by Config' });
        }

        return JSON.stringify(result, null, 2);
      } catch (error) {
        if (isResourceNotFoundError(error)) {
          return JSON.stringify({ error: 'Resource not found' });
        }
        throw handleConfigError(error, 'getCurrentConfiguration');
      }
    },
  });

  /**
   * Get all resources related to a specific resource
   */
  const getRelatedResources = tool({
    name: 'config_get_related_resources',
    description:
      'Get all resources related to a specific resource using AWS Config relationship tracking. Finds dependencies and dependents.',
    inputSchema: z.object({
      resourceType: z.string().describe('Resource type (e.g., "AWS::DynamoDB::Table")'),
      resourceId: z.string().describe('Resource ID (e.g., "chimera-sessions")'),
      region: z.string().describe('Region (e.g., "us-east-1")'),
    }),
    callback: async (input) => {
      try {
        const currentConfig = await fetchCurrentConfig(
          config,
          input.resourceType as AWSResourceType,
          input.resourceId,
          input.region as AWSRegion
        );

        if (!currentConfig?.relationships) {
          return JSON.stringify({ relatedResources: [] });
        }

        // Fetch full details for each related resource
        const relatedResources: ResourceInventoryEntry[] = [];

        for (const relationship of currentConfig.relationships) {
          const relatedConfig = await fetchCurrentConfig(
            config,
            relationship.resourceType,
            relationship.resourceId,
            input.region as AWSRegion
          );

          if (relatedConfig) {
            relatedResources.push(configItemToInventoryEntry(config, relatedConfig));
          }
        }

        return JSON.stringify({ relatedResources }, null, 2);
      } catch (error) {
        throw handleConfigError(error, 'getRelatedResources');
      }
    },
  });

  /**
   * Validate Config aggregator configuration
   */
  const validateAggregator = tool({
    name: 'config_validate_aggregator',
    description: 'Check if the AWS Config aggregator is properly configured and accessible.',
    inputSchema: z.object({}),
    callback: async () => {
      try {
        const exists = await checkAggregatorExists(config);
        return JSON.stringify({
          valid: exists,
          aggregatorName: config.aggregatorName,
          region: config.aggregatorRegion,
        });
      } catch (error) {
        return JSON.stringify({
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  return [
    advancedQuery,
    listResources,
    getConfigurationHistory,
    getCurrentConfiguration,
    getRelatedResources,
    validateAggregator,
  ];
}

// ============================================================================
// Private helper functions — real AWS SDK v3 implementations
// ============================================================================

async function executeAdvancedQuery(
  config: ConfigAggregatorConfig,
  query: { expression: string; limit?: number; nextToken?: string }
): Promise<ResourceQueryResult> {
  const { ConfigServiceClient, SelectAggregateResourceConfigCommand } =
    await import('@aws-sdk/client-config-service');

  const client = new ConfigServiceClient({ region: config.aggregatorRegion });
  const command = new SelectAggregateResourceConfigCommand({
    ConfigurationAggregatorName: config.aggregatorName,
    Expression: query.expression,
    Limit: query.limit ?? 100,
    NextToken: query.nextToken,
  });

  const response = await client.send(command);

  const items: ResourceInventoryEntry[] = (response.Results ?? []).map((jsonStr) => {
    const raw = JSON.parse(jsonStr);
    return {
      arn: raw.arn ?? raw.ARN ?? '',
      resourceType: raw.resourceType ?? raw.ResourceType ?? '',
      resourceId: raw.resourceId ?? raw.ResourceId ?? '',
      region: raw.awsRegion ?? raw.AwsRegion ?? '',
      accountId: raw.accountId ?? raw.AccountId ?? config.accountId,
      status: (raw.configurationItemStatus ?? 'OK') as ResourceStatus,
      tags: Array.isArray(raw.tags)
        ? raw.tags
        : raw.tags
          ? Object.entries(raw.tags).map(([key, value]) => ({ key, value: String(value) }))
          : [],
      lastUpdatedAt: raw.configurationItemCaptureTime ?? new Date().toISOString(),
      configuration: raw.configuration
        ? typeof raw.configuration === 'string'
          ? JSON.parse(raw.configuration)
          : raw.configuration
        : undefined,
    };
  });

  return {
    items,
    pagination: {
      nextToken: response.NextToken,
      hasMore: !!response.NextToken,
      totalCount: items.length,
      pageSize: query.limit ?? 100,
    },
  };
}

async function fetchConfigHistory(
  config: ConfigAggregatorConfig,
  query: {
    resourceType: AWSResourceType;
    resourceId: string;
    region: AWSRegion;
    startTime?: Date;
    endTime?: Date;
    chronologicalOrder?: 'Forward' | 'Reverse';
    limit?: number;
    nextToken?: string;
  }
): Promise<ConfigurationItem[]> {
  const { ConfigServiceClient, GetResourceConfigHistoryCommand } =
    await import('@aws-sdk/client-config-service');

  const client = new ConfigServiceClient({ region: query.region });
  const command = new GetResourceConfigHistoryCommand({
    resourceType: query.resourceType as any,
    resourceId: query.resourceId,
    laterTime: query.endTime,
    earlierTime: query.startTime,
    chronologicalOrder: query.chronologicalOrder ?? 'Reverse',
    limit: query.limit ?? 10,
    nextToken: query.nextToken,
  });

  const response = await client.send(command);

  return (response.configurationItems ?? []).map((item) => ({
    configurationItemCaptureTime:
      item.configurationItemCaptureTime?.toISOString() ?? new Date().toISOString(),
    resourceType: (item.resourceType ?? '') as AWSResourceType,
    resourceId: item.resourceId ?? '',
    arn: item.arn ?? '',
    region: (item.awsRegion ?? '') as AWSRegion,
    availabilityZone: item.availabilityZone,
    configurationItemStatus: (item.configurationItemStatus ?? 'OK') as ResourceStatus,
    configuration: item.configuration ? JSON.parse(item.configuration) : {},
    relationships: (item.relationships ?? []).map((rel) => ({
      resourceType: (rel.resourceType ?? '') as AWSResourceType,
      resourceId: rel.resourceId ?? '',
      resourceArn: rel.resourceName,
      relationshipType: (rel.relationshipName ?? 'Is associated with') as any,
    })),
    tags: item.tags ? Object.entries(item.tags).map(([key, value]) => ({ key, value })) : [],
    configurationStateId: item.configurationStateId,
  }));
}

async function fetchCurrentConfig(
  config: ConfigAggregatorConfig,
  resourceType: AWSResourceType,
  resourceId: string,
  region: AWSRegion
): Promise<ConfigurationItem | null> {
  const { ConfigServiceClient, BatchGetAggregateResourceConfigCommand } =
    await import('@aws-sdk/client-config-service');

  const client = new ConfigServiceClient({ region: config.aggregatorRegion });
  const command = new BatchGetAggregateResourceConfigCommand({
    ConfigurationAggregatorName: config.aggregatorName,
    ResourceIdentifiers: [
      {
        SourceAccountId: config.accountId,
        SourceRegion: region,
        ResourceId: resourceId,
        ResourceType: resourceType as any,
      },
    ],
  });

  const response = await client.send(command);
  const items = response.BaseConfigurationItems ?? [];

  if (items.length === 0) {
    return null;
  }

  const item = items[0];
  return {
    configurationItemCaptureTime:
      item.configurationItemCaptureTime?.toISOString() ?? new Date().toISOString(),
    resourceType: (item.resourceType ?? '') as AWSResourceType,
    resourceId: item.resourceId ?? '',
    arn: item.arn ?? '',
    region: (item.awsRegion ?? '') as AWSRegion,
    availabilityZone: item.availabilityZone,
    configurationItemStatus: (item.configurationItemStatus ?? 'OK') as ResourceStatus,
    configuration: item.configuration ? JSON.parse(item.configuration) : {},
    tags: item.supplementaryConfiguration
      ? Object.entries(item.supplementaryConfiguration).map(([key, value]) => ({
          key,
          value: String(value),
        }))
      : [],
  };
}

async function checkAggregatorExists(config: ConfigAggregatorConfig): Promise<boolean> {
  const { ConfigServiceClient, DescribeConfigurationAggregatorsCommand } =
    await import('@aws-sdk/client-config-service');

  const client = new ConfigServiceClient({ region: config.aggregatorRegion });
  const command = new DescribeConfigurationAggregatorsCommand({
    ConfigurationAggregatorNames: [config.aggregatorName],
  });

  try {
    const response = await client.send(command);
    return (response.ConfigurationAggregators ?? []).length > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('NoSuchConfigurationAggregator')) {
      return false;
    }
    throw error;
  }
}

function buildQueryFromFilter(filter?: ResourceFilter): string {
  if (!filter) {
    return 'SELECT * WHERE resourceType IS NOT NULL';
  }

  const conditions: string[] = [];

  if (filter.resourceTypes && filter.resourceTypes.length > 0) {
    const types = filter.resourceTypes.map((t) => `'${t}'`).join(', ');
    conditions.push(`resourceType IN (${types})`);
  }

  if (filter.regions && filter.regions.length > 0) {
    const regions = filter.regions.map((r) => `'${r}'`).join(', ');
    conditions.push(`awsRegion IN (${regions})`);
  }

  if (filter.tags && filter.tags.length > 0) {
    filter.tags.forEach((tag) => {
      if (tag.value) {
        conditions.push(`tags.tag = '${tag.key}:${tag.value}'`);
      } else {
        conditions.push(`tags.key = '${tag.key}'`);
      }
    });
  }

  if (filter.statuses && filter.statuses.length > 0) {
    const statuses = filter.statuses.map((s) => `'${s}'`).join(', ');
    conditions.push(`configurationItemStatus IN (${statuses})`);
  }

  const whereClause = conditions.length > 0 ? conditions.join(' AND ') : 'resourceType IS NOT NULL';

  return `SELECT * WHERE ${whereClause}`;
}

function configItemToInventoryEntry(
  config: ConfigAggregatorConfig,
  item: ConfigurationItem
): ResourceInventoryEntry {
  return {
    arn: item.arn,
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    region: item.region,
    accountId: config.accountId,
    status: item.configurationItemStatus,
    tags: item.tags ?? [],
    lastUpdatedAt: item.configurationItemCaptureTime,
    relationships: item.relationships,
    configuration: item.configuration,
  };
}

function handleConfigError(error: unknown, operation: string): DiscoveryError {
  if (error instanceof DiscoveryError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('AccessDenied') || message.includes('UnauthorizedOperation')) {
    return new DiscoveryError('PERMISSION_DENIED', `Config ${operation} denied: ${message}`, error);
  }

  if (message.includes('NoSuchConfigurationAggregator')) {
    return new DiscoveryError(
      'AGGREGATOR_NOT_FOUND',
      `Config aggregator not found: ${message}`,
      error
    );
  }

  if (message.includes('InvalidExpression') || message.includes('QueryException')) {
    return new DiscoveryError('INVALID_QUERY', `Config query syntax error: ${message}`, error);
  }

  if (message.includes('ThrottlingException') || message.includes('TooManyRequestsException')) {
    return new DiscoveryError('RATE_LIMIT_EXCEEDED', `Config API rate limit: ${message}`, error);
  }

  return new DiscoveryError('INTERNAL_ERROR', `Config ${operation} failed: ${message}`, error);
}

function isResourceNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('ResourceNotFoundException') ||
    message.includes('NoSuchResource') ||
    message.includes('ResourceNotDiscoveredException')
  );
}
