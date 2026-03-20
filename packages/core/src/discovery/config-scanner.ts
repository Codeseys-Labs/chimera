/**
 * AWS Config Resource Inventory Scanner
 *
 * Provides a high-level wrapper around AWS Config for resource discovery,
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

import type {
  ConfigurationItem,
  ConfigQueryResult,
  ResourceFilter,
  DiscoveryQueryOptions,
  ResourceQueryResult,
  ResourceInventoryEntry,
  AWSResourceType,
  AWSRegion,
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
 * AWS Config advanced query parameters
 *
 * Supports SQL-like queries using AWS Config Query Language.
 *
 * @example
 * ```typescript
 * // Find all unencrypted RDS instances in production
 * const query = `
 *   SELECT resourceId, configuration.dBInstanceIdentifier, awsRegion, tags
 *   WHERE resourceType = 'AWS::RDS::DBInstance'
 *     AND configuration.storageEncrypted = false
 *     AND tags.tag = 'Environment:production'
 * `;
 * ```
 */
export interface ConfigAdvancedQuery {
  /** SQL-like query expression */
  readonly expression: string;

  /** Maximum results to return (default: 100, max: 500) */
  readonly limit?: number;

  /** Pagination token from previous query */
  readonly nextToken?: string;
}

/**
 * Configuration history query parameters
 */
export interface ConfigHistoryQuery {
  /** Resource type to query */
  readonly resourceType: AWSResourceType;

  /** Resource ID */
  readonly resourceId: string;

  /** Region where resource exists */
  readonly region: AWSRegion;

  /** Start time for history window */
  readonly startTime?: Date;

  /** End time for history window */
  readonly endTime?: Date;

  /** Chronological order of results */
  readonly chronologicalOrder?: 'Forward' | 'Reverse';

  /** Maximum results (default: 10, max: 100) */
  readonly limit?: number;

  /** Pagination token */
  readonly nextToken?: string;
}

/**
 * AWS Config Scanner Service
 *
 * Provides methods to query AWS Config aggregator for resource inventory,
 * configuration history, and relationship data.
 */
export class ConfigScanner {
  private readonly config: ConfigAggregatorConfig;

  /**
   * Initialize Config scanner with aggregator configuration
   *
   * @param config - Aggregator configuration
   * @throws {DiscoveryError} If aggregator does not exist
   */
  constructor(config: ConfigAggregatorConfig) {
    this.config = config;
  }

  /**
   * Query resources using AWS Config advanced query syntax (SQL-like)
   *
   * Supports full SQL syntax for filtering, projecting, and joining resources.
   *
   * @example
   * ```typescript
   * // Find all Lambda functions with memory > 1GB
   * const results = await scanner.advancedQuery({
   *   expression: `
   *     SELECT resourceId, configuration.functionName, configuration.memorySize, awsRegion
   *     WHERE resourceType = 'AWS::Lambda::Function'
   *       AND configuration.memorySize > 1024
   *   `
   * });
   * ```
   *
   * @param query - Advanced query parameters
   * @returns Paginated query results
   * @throws {DiscoveryError} On query syntax error or service failure
   */
  async advancedQuery(query: ConfigAdvancedQuery): Promise<ResourceQueryResult> {
    try {
      // Implementation would use AWS SDK ConfigServiceClient.selectAggregateResourceConfig
      // For now, return type-safe structure
      return {
        items: await this.executeAdvancedQuery(query),
        pagination: {
          nextToken: undefined,
          hasMore: false,
          totalCount: 0,
          pageSize: query.limit ?? 100,
        },
      };
    } catch (error) {
      throw this.handleConfigError(error, 'advancedQuery');
    }
  }

  /**
   * List all resources of specific types across all regions
   *
   * Simpler interface than advancedQuery for common use case of listing
   * resources by type with optional tag/region filters.
   *
   * @param options - Query filters and pagination
   * @returns Paginated resource inventory
   * @throws {DiscoveryError} On service failure
   */
  async listResources(options: DiscoveryQueryOptions): Promise<ResourceQueryResult> {
    const { filter, limit = 100, nextToken, includeRelationships = false } = options;

    try {
      // Build SQL query from filters
      const query = this.buildQueryFromFilter(filter);

      return await this.advancedQuery({
        expression: query,
        limit,
        nextToken,
      });
    } catch (error) {
      throw this.handleConfigError(error, 'listResources');
    }
  }

  /**
   * Get configuration history for a specific resource
   *
   * Returns all recorded configuration changes for a resource, enabling
   * time-travel queries like "what was the Lambda memory size yesterday?"
   *
   * @example
   * ```typescript
   * const history = await scanner.getConfigurationHistory({
   *   resourceType: 'AWS::Lambda::Function',
   *   resourceId: 'agent-runtime',
   *   region: 'us-east-1',
   *   startTime: new Date('2026-03-01'),
   *   chronologicalOrder: 'Reverse' // Newest first
   * });
   * ```
   *
   * @param query - History query parameters
   * @returns Array of configuration items over time
   * @throws {DiscoveryError} If resource not found or not recorded
   */
  async getConfigurationHistory(query: ConfigHistoryQuery): Promise<ConfigurationItem[]> {
    try {
      // Implementation would use AWS SDK ConfigServiceClient.getResourceConfigHistory
      return await this.fetchConfigHistory(query);
    } catch (error) {
      throw this.handleConfigError(error, 'getConfigurationHistory');
    }
  }

  /**
   * Get current configuration snapshot for a resource
   *
   * Returns the most recent configuration item recorded by AWS Config.
   *
   * @param resourceType - AWS resource type
   * @param resourceId - Resource identifier
   * @param region - AWS region
   * @returns Current configuration item
   * @throws {DiscoveryError} If resource not found
   */
  async getCurrentConfiguration(
    resourceType: AWSResourceType,
    resourceId: string,
    region: AWSRegion
  ): Promise<ConfigurationItem | null> {
    try {
      // Implementation would use AWS SDK ConfigServiceClient.batchGetAggregateResourceConfig
      return await this.fetchCurrentConfig(resourceType, resourceId, region);
    } catch (error) {
      if (this.isResourceNotFoundError(error)) {
        return null;
      }
      throw this.handleConfigError(error, 'getCurrentConfiguration');
    }
  }

  /**
   * Get all resources related to a specific resource
   *
   * Uses AWS Config's relationship tracking to find dependencies and dependents.
   *
   * @example
   * ```typescript
   * // Find all resources that depend on a DynamoDB table
   * const dependents = await scanner.getRelatedResources(
   *   'AWS::DynamoDB::Table',
   *   'chimera-sessions',
   *   'us-east-1'
   * );
   * // Returns: Lambda functions, API Gateway endpoints, etc.
   * ```
   *
   * @param resourceType - Resource type
   * @param resourceId - Resource ID
   * @param region - Region
   * @returns Array of related resources
   * @throws {DiscoveryError} On service failure
   */
  async getRelatedResources(
    resourceType: AWSResourceType,
    resourceId: string,
    region: AWSRegion
  ): Promise<ResourceInventoryEntry[]> {
    try {
      const config = await this.getCurrentConfiguration(resourceType, resourceId, region);

      if (!config?.relationships) {
        return [];
      }

      // Fetch full details for each related resource
      const relatedResources: ResourceInventoryEntry[] = [];

      for (const relationship of config.relationships) {
        const relatedConfig = await this.getCurrentConfiguration(
          relationship.resourceType,
          relationship.resourceId,
          region
        );

        if (relatedConfig) {
          relatedResources.push(this.configItemToInventoryEntry(relatedConfig));
        }
      }

      return relatedResources;
    } catch (error) {
      throw this.handleConfigError(error, 'getRelatedResources');
    }
  }

  /**
   * Check if Config aggregator is properly configured and accessible
   *
   * @returns True if aggregator exists and is authorized
   */
  async validateAggregator(): Promise<boolean> {
    try {
      // Implementation would use AWS SDK ConfigServiceClient.describeConfigurationAggregators
      return await this.checkAggregatorExists();
    } catch (error) {
      return false;
    }
  }

  // ========================================================================
  // Private helper methods (implementation stubs for type safety)
  // ========================================================================

  private async executeAdvancedQuery(query: ConfigAdvancedQuery): Promise<ResourceInventoryEntry[]> {
    // Stub: Would call AWS SDK ConfigServiceClient.selectAggregateResourceConfig
    // Parse JSON results and convert to ResourceInventoryEntry[]
    return [];
  }

  private async fetchConfigHistory(query: ConfigHistoryQuery): Promise<ConfigurationItem[]> {
    // Stub: Would call AWS SDK ConfigServiceClient.getResourceConfigHistory
    return [];
  }

  private async fetchCurrentConfig(
    resourceType: AWSResourceType,
    resourceId: string,
    region: AWSRegion
  ): Promise<ConfigurationItem | null> {
    // Stub: Would call AWS SDK ConfigServiceClient.batchGetAggregateResourceConfig
    return null;
  }

  private async checkAggregatorExists(): Promise<boolean> {
    // Stub: Would call AWS SDK ConfigServiceClient.describeConfigurationAggregators
    return false;
  }

  private buildQueryFromFilter(filter?: ResourceFilter): string {
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

  private configItemToInventoryEntry(item: ConfigurationItem): ResourceInventoryEntry {
    return {
      arn: item.arn,
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      region: item.region,
      accountId: this.config.accountId,
      status: item.configurationItemStatus,
      tags: item.tags ?? [],
      lastUpdatedAt: item.configurationItemCaptureTime,
      relationships: item.relationships,
      configuration: item.configuration,
    };
  }

  private handleConfigError(error: unknown, operation: string): DiscoveryError {
    if (error instanceof DiscoveryError) {
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('AccessDenied') || message.includes('UnauthorizedOperation')) {
      return new DiscoveryError('PERMISSION_DENIED', `Config ${operation} denied: ${message}`, error);
    }

    if (message.includes('NoSuchConfigurationAggregator')) {
      return new DiscoveryError('AGGREGATOR_NOT_FOUND', `Config aggregator not found: ${message}`, error);
    }

    if (message.includes('InvalidExpression') || message.includes('QueryException')) {
      return new DiscoveryError('INVALID_QUERY', `Config query syntax error: ${message}`, error);
    }

    if (message.includes('ThrottlingException') || message.includes('TooManyRequestsException')) {
      return new DiscoveryError('RATE_LIMIT_EXCEEDED', `Config API rate limit: ${message}`, error);
    }

    return new DiscoveryError('INTERNAL_ERROR', `Config ${operation} failed: ${message}`, error);
  }

  private isResourceNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('ResourceNotFoundException') ||
      message.includes('NoSuchResource') ||
      message.includes('ResourceNotDiscoveredException')
    );
  }
}

/**
 * Create ConfigScanner instance with default configuration
 *
 * @param accountId - AWS account ID
 * @param aggregatorName - Config aggregator name (default: 'chimera-global-aggregator')
 * @param aggregatorRegion - Aggregator region (default: 'us-east-1')
 * @returns Configured ConfigScanner instance
 */
export function createConfigScanner(
  accountId: string,
  aggregatorName = 'chimera-global-aggregator',
  aggregatorRegion: AWSRegion = 'us-east-1'
): ConfigScanner {
  return new ConfigScanner({
    aggregatorName,
    aggregatorRegion,
    accountId,
  });
}
