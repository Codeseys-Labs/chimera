/**
 * AWS Resource Explorer 2 Cross-Region Search
 *
 * Provides instant, tag-based resource discovery across all AWS regions
 * without pre-configuration. Resource Explorer offers:
 *
 * - **Instant search**: No setup required for partial results (as of Oct 2025)
 * - **Tag-based queries**: Search by tags, resource types, regions
 * - **Cross-region**: Single query returns results from all regions
 * - **Fast**: Sub-second response times vs Config's 5-15 min latency
 * - **Unified search**: Same API powering AWS Console's search bar
 *
 * Complements AWS Config by providing instant discovery while Config provides
 * historical data, configuration details, and relationship tracking.
 *
 * @see https://docs.aws.amazon.com/resource-explorer/latest/userguide/getting-started.html
 * @see docs/research/aws-account-agent/02-Resource-Explorer-Cross-Region-Search.md
 */

import type {
  ExplorerResource,
  ResourceFilter,
  DiscoveryQueryOptions,
  ResourceQueryResult,
  ResourceInventoryEntry,
  AWSRegion,
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
 *
 * @example
 * ```typescript
 * const query = new ExplorerQueryBuilder()
 *   .withTag('Environment', 'production')
 *   .withResourceType('lambda', 'function')
 *   .withRegion('us-east-1')
 *   .build();
 * // Result: "tag:Environment=production resourcetype:lambda:function region:us-east-1"
 * ```
 */
export class ExplorerQueryBuilder {
  private parts: string[] = [];

  /**
   * Add tag filter
   *
   * @param key - Tag key
   * @param value - Tag value (optional, wildcards supported)
   */
  withTag(key: string, value?: string): this {
    if (value) {
      this.parts.push(`tag:${key}=${value}`);
    } else {
      this.parts.push(`tag:${key}`);
    }
    return this;
  }

  /**
   * Add resource type filter
   *
   * @param service - AWS service (e.g., 'lambda', 'rds', 'dynamodb')
   * @param type - Resource type (e.g., 'function', 'db', 'table')
   */
  withResourceType(service: string, type: string): this {
    this.parts.push(`resourcetype:${service}:${type}`);
    return this;
  }

  /**
   * Add region filter
   *
   * @param region - AWS region
   */
  withRegion(region: AWSRegion): this {
    this.parts.push(`region:${region}`);
    return this;
  }

  /**
   * Add free-text search term
   *
   * @param term - Search term (matches resource IDs, names, ARNs)
   */
  withSearchTerm(term: string): this {
    this.parts.push(term);
    return this;
  }

  /**
   * Build query string
   */
  build(): string {
    return this.parts.join(' ');
  }

  /**
   * Build query from ResourceFilter
   */
  static fromFilter(filter: ResourceFilter): string {
    const builder = new ExplorerQueryBuilder();

    if (filter.tags) {
      filter.tags.forEach((tag) => builder.withTag(tag.key, tag.value));
    }

    if (filter.regions) {
      filter.regions.forEach((region) => builder.withRegion(region));
    }

    // Convert AWSResourceType to Resource Explorer format
    if (filter.resourceTypes) {
      filter.resourceTypes.forEach((type) => {
        const [service, resourceType] = this.parseResourceType(type);
        if (service && resourceType) {
          builder.withResourceType(service, resourceType);
        }
      });
    }

    const query = builder.build();
    return query || '*'; // Fallback to wildcard if no filters
  }

  /**
   * Parse AWS::Service::Type format to service:type
   */
  private static parseResourceType(awsType: string): [string | null, string | null] {
    // AWS::Lambda::Function → lambda:function
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
 * Resource Explorer Service
 *
 * Provides instant cross-region resource search with tag-based queries.
 */
export class ResourceExplorer {
  private readonly config: ResourceExplorerConfig;

  /**
   * Initialize Resource Explorer
   *
   * @param config - Explorer configuration
   */
  constructor(config: ResourceExplorerConfig) {
    this.config = config;
  }

  /**
   * Search resources using query string DSL
   *
   * @example
   * ```typescript
   * // Find all production Lambda functions
   * const results = await explorer.search({
   *   queryString: 'tag:Environment=production resourcetype:lambda:function',
   *   maxResults: 50
   * });
   * ```
   *
   * @param options - Search options
   * @returns Paginated search results
   * @throws {DiscoveryError} On query syntax error or service failure
   */
  async search(options: {
    queryString: string;
    maxResults?: number;
    nextToken?: string;
  }): Promise<ResourceQueryResult> {
    const { queryString, maxResults = 100, nextToken } = options;

    try {
      // Implementation would use AWS SDK ResourceExplorer2Client.search
      const resources = await this.executeSearch(queryString, maxResults, nextToken);

      return {
        items: resources.map((r) => this.explorerResourceToInventoryEntry(r)),
        pagination: {
          nextToken: undefined,
          hasMore: false,
          totalCount: resources.length,
          pageSize: maxResults,
        },
      };
    } catch (error) {
      throw this.handleExplorerError(error, 'search');
    }
  }

  /**
   * Search resources using structured filter
   *
   * Convenience method that converts ResourceFilter to query string.
   *
   * @param options - Discovery query options
   * @returns Paginated resource results
   */
  async searchWithFilter(options: DiscoveryQueryOptions): Promise<ResourceQueryResult> {
    const queryString = options.filter
      ? ExplorerQueryBuilder.fromFilter(options.filter)
      : '*';

    return await this.search({
      queryString,
      maxResults: options.limit,
      nextToken: options.nextToken,
    });
  }

  /**
   * Find resources by tag
   *
   * Simplified interface for common use case of searching by single tag.
   *
   * @example
   * ```typescript
   * // Find all resources owned by platform team
   * const resources = await explorer.findByTag('Team', 'platform');
   * ```
   *
   * @param key - Tag key
   * @param value - Tag value (optional, supports wildcards)
   * @param maxResults - Maximum results
   * @returns Array of resources
   */
  async findByTag(key: string, value?: string, maxResults = 100): Promise<ResourceInventoryEntry[]> {
    const queryString = value ? `tag:${key}=${value}` : `tag:${key}`;

    const result = await this.search({ queryString, maxResults });
    return result.items;
  }

  /**
   * Find resources by type
   *
   * @example
   * ```typescript
   * // Find all DynamoDB tables
   * const tables = await explorer.findByType('dynamodb', 'table');
   * ```
   *
   * @param service - AWS service
   * @param type - Resource type
   * @param maxResults - Maximum results
   * @returns Array of resources
   */
  async findByType(service: string, type: string, maxResults = 100): Promise<ResourceInventoryEntry[]> {
    const queryString = `resourcetype:${service}:${type}`;

    const result = await this.search({ queryString, maxResults });
    return result.items;
  }

  /**
   * Autocomplete resource search
   *
   * Provides search-as-you-type functionality, returning up to 10 matching
   * resources for display in autocomplete UI.
   *
   * @param searchTerm - Partial search term
   * @returns Array of matching resources (max 10)
   */
  async autocomplete(searchTerm: string): Promise<ResourceInventoryEntry[]> {
    const result = await this.search({
      queryString: searchTerm,
      maxResults: 10,
    });

    return result.items;
  }

  /**
   * Get Resource Explorer index status
   *
   * Checks if aggregator index is configured and returns index health.
   *
   * @returns Index status information
   */
  async getIndexStatus(): Promise<{
    exists: boolean;
    type: 'AGGREGATOR' | 'LOCAL' | null;
    region: AWSRegion | null;
    state: 'ACTIVE' | 'CREATING' | 'DELETING' | 'UPDATING' | null;
  }> {
    try {
      // Implementation would use AWS SDK ResourceExplorer2Client.getIndex
      return await this.fetchIndexStatus();
    } catch (error) {
      return {
        exists: false,
        type: null,
        region: null,
        state: null,
      };
    }
  }

  /**
   * Create aggregator index for complete results
   *
   * Promotes a regional index to aggregator status, enabling complete
   * historical results instead of instant partial results.
   *
   * @param region - Region to promote (default: config.primaryRegion)
   * @throws {DiscoveryError} If index doesn't exist or promotion fails
   */
  async createAggregatorIndex(region?: AWSRegion): Promise<void> {
    const targetRegion = region ?? this.config.primaryRegion;

    try {
      // Implementation would use AWS SDK ResourceExplorer2Client.updateIndexType
      await this.promoteToAggregator(targetRegion);
    } catch (error) {
      throw this.handleExplorerError(error, 'createAggregatorIndex');
    }
  }

  // ========================================================================
  // Private helper methods (implementation stubs for type safety)
  // ========================================================================

  private async executeSearch(
    queryString: string,
    maxResults: number,
    nextToken?: string
  ): Promise<ExplorerResource[]> {
    // Stub: Would call AWS SDK ResourceExplorer2Client.search
    return [];
  }

  private async fetchIndexStatus(): Promise<{
    exists: boolean;
    type: 'AGGREGATOR' | 'LOCAL' | null;
    region: AWSRegion | null;
    state: 'ACTIVE' | 'CREATING' | 'DELETING' | 'UPDATING' | null;
  }> {
    // Stub: Would call AWS SDK ResourceExplorer2Client.getIndex
    return {
      exists: false,
      type: null,
      region: null,
      state: null,
    };
  }

  private async promoteToAggregator(region: AWSRegion): Promise<void> {
    // Stub: Would call AWS SDK ResourceExplorer2Client.updateIndexType
  }

  private explorerResourceToInventoryEntry(resource: ExplorerResource): ResourceInventoryEntry {
    // Parse tags from properties if available
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
      resourceType: resource.resourceType as any, // May not match AWSResourceType enum
      resourceId: this.extractResourceIdFromArn(resource.arn),
      region: resource.region,
      accountId: resource.owningAccountId,
      status: 'OK', // Resource Explorer doesn't provide status
      tags,
      lastUpdatedAt: resource.lastReportedAt,
    };
  }

  private extractResourceIdFromArn(arn: string): string {
    // ARN format: arn:aws:service:region:account:resource-type/resource-id
    const parts = arn.split(':');
    const resourcePart = parts[parts.length - 1];
    return resourcePart.split('/').pop() ?? resourcePart;
  }

  private handleExplorerError(error: unknown, operation: string): DiscoveryError {
    if (error instanceof DiscoveryError) {
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('AccessDenied') || message.includes('UnauthorizedOperation')) {
      return new DiscoveryError('PERMISSION_DENIED', `Explorer ${operation} denied: ${message}`, error);
    }

    if (message.includes('IndexNotFoundException')) {
      return new DiscoveryError('INDEX_NOT_FOUND', `Resource Explorer index not found: ${message}`, error);
    }

    if (message.includes('ValidationException')) {
      return new DiscoveryError('INVALID_QUERY', `Explorer query syntax error: ${message}`, error);
    }

    if (message.includes('ThrottlingException') || message.includes('TooManyRequestsException')) {
      return new DiscoveryError('RATE_LIMIT_EXCEEDED', `Explorer API rate limit: ${message}`, error);
    }

    if (message.includes('ServiceUnavailableException')) {
      return new DiscoveryError('SERVICE_UNAVAILABLE', `Explorer service unavailable: ${message}`, error);
    }

    return new DiscoveryError('INTERNAL_ERROR', `Explorer ${operation} failed: ${message}`, error);
  }
}

/**
 * Create ResourceExplorer instance with default configuration
 *
 * @param accountId - AWS account ID
 * @param primaryRegion - Primary region with aggregator index (default: 'us-east-1')
 * @param useAggregator - Enable aggregator for complete results (default: true)
 * @returns Configured ResourceExplorer instance
 */
export function createResourceExplorer(
  accountId: string,
  primaryRegion: AWSRegion = 'us-east-1',
  useAggregator = true
): ResourceExplorer {
  return new ResourceExplorer({
    accountId,
    primaryRegion,
    useAggregator,
  });
}
