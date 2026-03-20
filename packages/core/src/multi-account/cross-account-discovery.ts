/**
 * Cross-Account Discovery Service
 *
 * Coordinates resource discovery across multiple AWS accounts in an organization.
 * Leverages AWS Config Aggregators and Resource Explorer for centralized visibility.
 *
 * Key capabilities:
 * - Query resources across all member accounts from central location
 * - Aggregate compliance status and resource inventory
 * - Cross-account tag enforcement and governance
 * - Multi-account security posture assessment
 *
 * Reference: docs/research/aws-account-agent/06-Account-Discovery-Architecture.md
 */

import {
  ConfigServiceClient,
  SelectAggregateResourceConfigCommand,
  DescribeConfigurationAggregatorsCommand,
  type ConfigurationAggregator,
} from '@aws-sdk/client-config-service';
import {
  ResourceExplorer2Client,
  SearchCommand,
  GetIndexCommand,
  type Resource,
} from '@aws-sdk/client-resource-explorer-2';
import type { AWSClientFactory } from '../aws-tools/client-factory';
import type {
  ResourceMetadata,
  AWSResourceType,
  ResourceStatus,
  ResourceTag,
} from '../discovery/types';

/**
 * Cross-account resource query filter
 */
export interface CrossAccountFilter {
  readonly accountIds?: string[];
  readonly regions?: string[];
  readonly resourceTypes?: AWSResourceType[];
  readonly tags?: Array<{ key: string; value?: string }>;
  readonly query?: string; // Resource Explorer query string
}

/**
 * Cross-account discovery result
 */
export interface CrossAccountResource extends ResourceMetadata {
  readonly sourceAccount: string;
  readonly discoveryMethod: 'CONFIG' | 'RESOURCE_EXPLORER';
  readonly aggregatorName?: string;
}

/**
 * Account discovery status
 */
export interface AccountDiscoveryStatus {
  readonly accountId: string;
  readonly accountName?: string;
  readonly configEnabled: boolean;
  readonly resourceExplorerEnabled: boolean;
  readonly lastDiscovery?: string; // ISO timestamp
  readonly resourceCount?: number;
  readonly errors?: string[];
}

/**
 * Multi-account compliance summary
 */
export interface MultiAccountComplianceSummary {
  readonly totalAccounts: number;
  readonly compliantAccounts: number;
  readonly nonCompliantAccounts: number;
  readonly accountSummaries: Array<{
    accountId: string;
    compliantResources: number;
    nonCompliantResources: number;
    complianceScore: number; // 0-100
  }>;
}

/**
 * Cross-Account Discovery Configuration
 */
export interface CrossAccountDiscoveryConfig {
  /** AWS Client Factory for service client creation */
  clientFactory: AWSClientFactory;

  /** Tenant context for API calls */
  tenantId: string;
  agentId: string;

  /** AWS Config Aggregator name (if using Config) */
  configAggregatorName?: string;

  /** Resource Explorer index ARN (if using Resource Explorer) */
  resourceExplorerIndexArn?: string;

  /** Member account IDs to discover */
  memberAccountIds?: string[];

  /** Default discovery region */
  defaultRegion?: string;

  /** Cache TTL in seconds (default: 300) */
  cacheTTL?: number;
}

/**
 * Discovery error codes
 */
export type DiscoveryErrorCode =
  | 'AGGREGATOR_NOT_FOUND'
  | 'INDEX_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'ACCOUNT_NOT_ACCESSIBLE'
  | 'QUERY_INVALID'
  | 'SERVICE_UNAVAILABLE'
  | 'RATE_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR';

/**
 * Cross-Account Discovery Error
 */
export class CrossAccountDiscoveryError extends Error {
  constructor(
    public readonly code: DiscoveryErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'CrossAccountDiscoveryError';
  }
}

/**
 * Cross-Account Discovery Service
 *
 * Provides unified resource discovery across AWS Organizations accounts:
 * - Centralized resource inventory
 * - Cross-account compliance monitoring
 * - Multi-account tag governance
 * - Security posture assessment
 */
export class CrossAccountDiscovery {
  private config: Required<CrossAccountDiscoveryConfig>;
  private configClient: ConfigServiceClient | null = null;
  private explorerClient: ResourceExplorer2Client | null = null;
  private cache = new Map<string, { data: unknown; expires: number }>();

  constructor(config: CrossAccountDiscoveryConfig) {
    this.config = {
      configAggregatorName: 'chimera-aggregator',
      resourceExplorerIndexArn: '',
      memberAccountIds: [],
      defaultRegion: 'us-east-1',
      cacheTTL: 300, // 5 minutes
      ...config,
    };
  }

  /**
   * Get AWS Config client
   */
  private async getConfigClient(): Promise<ConfigServiceClient> {
    if (this.configClient) {
      return this.configClient;
    }

    this.configClient = new ConfigServiceClient({
      region: this.config.defaultRegion,
      maxAttempts: 3,
    });

    return this.configClient;
  }

  /**
   * Get Resource Explorer client
   */
  private async getExplorerClient(): Promise<ResourceExplorer2Client> {
    if (this.explorerClient) {
      return this.explorerClient;
    }

    this.explorerClient = new ResourceExplorer2Client({
      region: this.config.defaultRegion,
      maxAttempts: 3,
    });

    return this.explorerClient;
  }

  /**
   * Discover resources across all member accounts using Config Aggregator
   */
  async discoverWithConfig(filter?: CrossAccountFilter): Promise<CrossAccountResource[]> {
    const cacheKey = `config:${JSON.stringify(filter)}`;
    const cached = this.getFromCache<CrossAccountResource[]>(cacheKey);
    if (cached) return cached;

    const client = await this.getConfigClient();
    const resources: CrossAccountResource[] = [];

    try {
      // Verify aggregator exists
      const aggregatorCommand = new DescribeConfigurationAggregatorsCommand({
        ConfigurationAggregatorNames: [this.config.configAggregatorName],
      });
      const aggregatorResponse = await client.send(aggregatorCommand);

      if (!aggregatorResponse.ConfigurationAggregators?.length) {
        throw new CrossAccountDiscoveryError(
          'AGGREGATOR_NOT_FOUND',
          `Config aggregator '${this.config.configAggregatorName}' not found`
        );
      }

      // Build SQL query
      const sqlQuery = this.buildConfigQuery(filter);

      // Execute query
      let nextToken: string | undefined;
      do {
        const command = new SelectAggregateResourceConfigCommand({
          ConfigurationAggregatorName: this.config.configAggregatorName,
          Expression: sqlQuery,
          NextToken: nextToken,
        });

        const response = await client.send(command);

        for (const result of response.Results || []) {
          const config = JSON.parse(result);
          resources.push(this.parseConfigResult(config));
        }

        nextToken = response.NextToken;
      } while (nextToken);

      this.setCache(cacheKey, resources);
      return resources;
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * Discover resources using Resource Explorer
   */
  async discoverWithExplorer(filter?: CrossAccountFilter): Promise<CrossAccountResource[]> {
    const cacheKey = `explorer:${JSON.stringify(filter)}`;
    const cached = this.getFromCache<CrossAccountResource[]>(cacheKey);
    if (cached) return cached;

    const client = await this.getExplorerClient();
    const resources: CrossAccountResource[] = [];

    try {
      // Build query string
      const queryString = this.buildExplorerQuery(filter);

      let nextToken: string | undefined;
      do {
        const command = new SearchCommand({
          QueryString: queryString,
          NextToken: nextToken,
        });

        const response = await client.send(command);

        for (const resource of response.Resources || []) {
          resources.push(this.parseExplorerResult(resource));
        }

        nextToken = response.NextToken;
      } while (nextToken);

      this.setCache(cacheKey, resources);
      return resources;
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * Get discovery status for all member accounts
   */
  async getAccountStatuses(): Promise<AccountDiscoveryStatus[]> {
    const cacheKey = 'account-statuses';
    const cached = this.getFromCache<AccountDiscoveryStatus[]>(cacheKey);
    if (cached) return cached;

    const statuses: AccountDiscoveryStatus[] = [];

    // Check each account
    for (const accountId of this.config.memberAccountIds) {
      try {
        const resources = await this.discoverWithConfig({
          accountIds: [accountId],
        });

        statuses.push({
          accountId,
          configEnabled: true,
          resourceExplorerEnabled: false, // Would need to check separately
          lastDiscovery: new Date().toISOString(),
          resourceCount: resources.length,
        });
      } catch (error: any) {
        statuses.push({
          accountId,
          configEnabled: false,
          resourceExplorerEnabled: false,
          errors: [error.message],
        });
      }
    }

    this.setCache(cacheKey, statuses);
    return statuses;
  }

  /**
   * Get compliance summary across all accounts
   */
  async getComplianceSummary(): Promise<MultiAccountComplianceSummary> {
    const resources = await this.discoverWithConfig();

    const accountSummaries = new Map<string, {
      compliant: number;
      nonCompliant: number;
    }>();

    for (const resource of resources) {
      const accountId = resource.sourceAccount;
      if (!accountSummaries.has(accountId)) {
        accountSummaries.set(accountId, { compliant: 0, nonCompliant: 0 });
      }

      const summary = accountSummaries.get(accountId)!;
      if (resource.status === 'OK') {
        summary.compliant++;
      } else {
        summary.nonCompliant++;
      }
    }

    const summaries = Array.from(accountSummaries.entries()).map(([accountId, counts]) => ({
      accountId,
      compliantResources: counts.compliant,
      nonCompliantResources: counts.nonCompliant,
      complianceScore: counts.compliant + counts.nonCompliant > 0
        ? (counts.compliant / (counts.compliant + counts.nonCompliant)) * 100
        : 100,
    }));

    const compliantAccounts = summaries.filter(s => s.complianceScore >= 90).length;

    return {
      totalAccounts: this.config.memberAccountIds.length,
      compliantAccounts,
      nonCompliantAccounts: this.config.memberAccountIds.length - compliantAccounts,
      accountSummaries: summaries,
    };
  }

  /**
   * Find resources by tag across all accounts
   */
  async findResourcesByTag(params: {
    tagKey: string;
    tagValue?: string;
    accountIds?: string[];
  }): Promise<CrossAccountResource[]> {
    return this.discoverWithConfig({
      accountIds: params.accountIds,
      tags: [{ key: params.tagKey, value: params.tagValue }],
    });
  }

  /**
   * Get all resources of a specific type across accounts
   */
  async getResourcesByType(params: {
    resourceType: AWSResourceType;
    accountIds?: string[];
    regions?: string[];
  }): Promise<CrossAccountResource[]> {
    return this.discoverWithConfig({
      accountIds: params.accountIds,
      regions: params.regions,
      resourceTypes: [params.resourceType],
    });
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Build AWS Config SQL query from filter
   */
  private buildConfigQuery(filter?: CrossAccountFilter): string {
    let query = 'SELECT * WHERE resourceType IS NOT NULL';

    if (filter?.accountIds?.length) {
      const accounts = filter.accountIds.map(id => `'${id}'`).join(',');
      query += ` AND accountId IN (${accounts})`;
    }

    if (filter?.regions?.length) {
      const regions = filter.regions.map(r => `'${r}'`).join(',');
      query += ` AND awsRegion IN (${regions})`;
    }

    if (filter?.resourceTypes?.length) {
      const types = filter.resourceTypes.map(t => `'${t}'`).join(',');
      query += ` AND resourceType IN (${types})`;
    }

    if (filter?.tags?.length) {
      for (const tag of filter.tags) {
        if (tag.value) {
          query += ` AND tags.tag LIKE '%${tag.key}%' AND tags.tag LIKE '%${tag.value}%'`;
        } else {
          query += ` AND tags.tag LIKE '%${tag.key}%'`;
        }
      }
    }

    return query;
  }

  /**
   * Build Resource Explorer query string from filter
   */
  private buildExplorerQuery(filter?: CrossAccountFilter): string {
    const parts: string[] = [];

    if (filter?.resourceTypes?.length) {
      parts.push(`resourcetype:(${filter.resourceTypes.join(' OR ')})`);
    }

    if (filter?.regions?.length) {
      parts.push(`region:(${filter.regions.join(' OR ')})`);
    }

    if (filter?.tags?.length) {
      for (const tag of filter.tags) {
        if (tag.value) {
          parts.push(`tag.${tag.key}:${tag.value}`);
        } else {
          parts.push(`tag:${tag.key}`);
        }
      }
    }

    if (filter?.query) {
      parts.push(filter.query);
    }

    return parts.length > 0 ? parts.join(' ') : '*';
  }

  /**
   * Parse AWS Config query result
   */
  private parseConfigResult(config: any): CrossAccountResource {
    return {
      arn: config.arn,
      resourceType: config.resourceType as AWSResourceType,
      resourceId: config.resourceId,
      region: config.awsRegion,
      accountId: config.accountId,
      status: (config.configurationItemStatus || 'OK') as ResourceStatus,
      tags: config.tags?.map((t: any) => ({ key: t.key, value: t.value })) || [],
      lastUpdatedAt: config.configurationItemCaptureTime,
      sourceAccount: config.accountId,
      discoveryMethod: 'CONFIG',
    };
  }

  /**
   * Parse Resource Explorer result
   */
  private parseExplorerResult(resource: Resource): CrossAccountResource {
    const arn = resource.Arn || '';
    const arnParts = arn.split(':');

    return {
      arn,
      resourceType: (resource.ResourceType || 'Unknown') as AWSResourceType,
      resourceId: arnParts[arnParts.length - 1] || '',
      region: resource.Region || '',
      accountId: resource.OwningAccountId || '',
      status: 'OK' as ResourceStatus,
      tags: [],
      lastUpdatedAt: resource.LastReportedAt?.toISOString() || new Date().toISOString(),
      sourceAccount: resource.OwningAccountId || '',
      discoveryMethod: 'RESOURCE_EXPLORER',
    };
  }

  /**
   * Handle AWS SDK errors
   */
  private handleError(error: any): CrossAccountDiscoveryError {
    const code = error.name || error.code;
    const message = error.message || 'Unknown error';

    switch (code) {
      case 'NoSuchConfigurationAggregatorException':
        return new CrossAccountDiscoveryError('AGGREGATOR_NOT_FOUND', message, error);
      case 'ResourceNotFoundException':
        return new CrossAccountDiscoveryError('INDEX_NOT_FOUND', message, error);
      case 'AccessDeniedException':
        return new CrossAccountDiscoveryError('PERMISSION_DENIED', message, error);
      case 'InvalidExpressionException':
      case 'ValidationException':
        return new CrossAccountDiscoveryError('QUERY_INVALID', message, error);
      case 'ThrottlingException':
        return new CrossAccountDiscoveryError('RATE_LIMIT_EXCEEDED', message, error);
      default:
        return new CrossAccountDiscoveryError('INTERNAL_ERROR', message, error);
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
