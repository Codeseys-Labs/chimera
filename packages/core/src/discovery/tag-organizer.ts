/**
 * Tag Organizer - Resource Tagging Governance and Compliance
 *
 * Provides tag validation, compliance checking, and resource discovery
 * based on AWS tagging best practices.
 *
 * Based on: docs/research/aws-account-agent/05-Tag-Organization-Strategy.md
 */

/**
 * Resource Groups Tagging API client interface
 */
export interface ResourceGroupsTaggingClient {
  send(command: any): Promise<any>;
}

/**
 * AWS Config client interface
 */
export interface ConfigClient {
  send(command: any): Promise<any>;
}

/**
 * Tag key-value pair
 */
export interface Tag {
  key: string;
  value: string;
}

/**
 * Tag validation rule
 */
export interface TagValidationRule {
  /** Tag key to validate */
  key: string;

  /** Whether tag is required */
  required: boolean;

  /** Allowed values (if constrained) */
  allowedValues?: string[];

  /** Regex pattern for value validation */
  pattern?: string;

  /** Custom validation function */
  validator?: (value: string) => boolean;
}

/**
 * Tag policy definition
 */
export interface TagPolicy {
  /** Policy name */
  name: string;

  /** Policy description */
  description?: string;

  /** Required tags */
  requiredTags: string[];

  /** Validation rules by tag key */
  rules: Record<string, TagValidationRule>;

  /** Resource types this policy applies to */
  resourceTypes?: string[];
}

/**
 * Tag compliance result
 */
export interface TagComplianceResult {
  resourceArn: string;
  resourceType: string;
  compliant: boolean;
  missingTags: string[];
  invalidTags: Array<{
    key: string;
    value: string;
    reason: string;
  }>;
  tags: Tag[];
}

/**
 * Tag filter for resource queries
 */
export interface TagFilter {
  key: string;
  values: string[];
  matchAll?: boolean; // If true, resource must have all values
}

/**
 * Tagged resource
 */
export interface TaggedResource {
  resourceArn: string;
  resourceType: string;
  tags: Tag[];
  region?: string;
  complianceStatus?: 'COMPLIANT' | 'NON_COMPLIANT' | 'UNKNOWN';
}

/**
 * Tag compliance summary
 */
export interface TagComplianceSummary {
  totalResources: number;
  compliantResources: number;
  nonCompliantResources: number;
  complianceRate: number;
  byResourceType: Record<string, {
    total: number;
    compliant: number;
    nonCompliant: number;
  }>;
  commonViolations: Array<{
    tagKey: string;
    violationCount: number;
    reason: string;
  }>;
}

/**
 * Tag Organizer Configuration
 */
export interface TagOrganizerConfig {
  /** Resource Groups Tagging API client */
  taggingClient: ResourceGroupsTaggingClient;

  /** AWS Config client (for compliance rules) */
  configClient?: ConfigClient;

  /** Default tag policy */
  defaultPolicy?: TagPolicy;

  /** Enable automatic remediation */
  enableAutoRemediation?: boolean;

  /** Cache TTL in seconds */
  cacheTTL?: number;
}

/**
 * Chimera's recommended tag schema
 */
export const CHIMERA_TAG_SCHEMA: TagPolicy = {
  name: 'chimera-standard',
  description: 'Chimera platform standard tagging policy',
  requiredTags: ['TenantId', 'Environment', 'Owner', 'Project'],
  rules: {
    TenantId: {
      key: 'TenantId',
      required: true,
      pattern: '^[a-z0-9-]+$',
    },
    Environment: {
      key: 'Environment',
      required: true,
      allowedValues: ['production', 'staging', 'development', 'test'],
    },
    Owner: {
      key: 'Owner',
      required: true,
      pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$|^[a-zA-Z0-9-]+$',
    },
    Project: {
      key: 'Project',
      required: true,
      allowedValues: ['chimera', 'chimera-marketplace', 'chimera-evo', 'chimera-infra'],
    },
    CostCenter: {
      key: 'CostCenter',
      required: false,
      pattern: '^CC-\\d{4}-[A-Z]{3}$',
    },
    Team: {
      key: 'Team',
      required: false,
      allowedValues: ['platform', 'ai', 'api', 'infra', 'security'],
    },
    DataClassification: {
      key: 'DataClassification',
      required: false,
      allowedValues: ['public', 'internal', 'confidential', 'restricted'],
    },
    TemporaryResource: {
      key: 'TemporaryResource',
      required: false,
      allowedValues: ['true', 'false'],
    },
    ExpirationDate: {
      key: 'ExpirationDate',
      required: false,
      pattern: '^\\d{4}-\\d{2}-\\d{2}$', // YYYY-MM-DD
    },
  },
};

/**
 * Tag Organizer Service
 *
 * Provides tag governance, validation, and resource discovery:
 * - Tag compliance checking
 * - Resource discovery by tags
 * - Tag validation against policies
 * - Bulk tagging operations
 * - Compliance reporting
 */
export class TagOrganizer {
  private config: TagOrganizerConfig;
  private cache: Map<string, { data: any; expires: number }>;

  constructor(config: TagOrganizerConfig) {
    this.config = {
      defaultPolicy: CHIMERA_TAG_SCHEMA,
      enableAutoRemediation: false,
      cacheTTL: 300, // 5 minutes
      ...config,
    };
    this.cache = new Map();
  }

  /**
   * Find resources by tag filters
   */
  async findResourcesByTags(params: {
    tagFilters: TagFilter[];
    resourceTypeFilters?: string[];
    limit?: number;
  }): Promise<TaggedResource[]> {
    const cacheKey = this.getCacheKey('find', params);
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const { GetResourcesCommand } = await import('@aws-sdk/client-resource-groups-tagging-api');

    const command = new GetResourcesCommand({
      TagFilters: params.tagFilters.map(f => ({
        Key: f.key,
        Values: f.values,
      })),
      ResourceTypeFilters: params.resourceTypeFilters,
      ResourcesPerPage: Math.min(params.limit || 100, 100),
    });

    const response = await this.config.taggingClient.send(command);

    const resources: TaggedResource[] = (response.ResourceTagMappingList || []).map((r: any) => ({
      resourceArn: r.ResourceARN,
      resourceType: this.extractResourceType(r.ResourceARN),
      tags: (r.Tags || []).map((t: any) => ({ key: t.Key, value: t.Value })),
      region: this.extractRegion(r.ResourceARN),
    }));

    this.setCache(cacheKey, resources);
    return resources;
  }

  /**
   * Find resources for a specific tenant
   */
  async findTenantResources(tenantId: string, options?: {
    environment?: string;
    resourceTypeFilters?: string[];
  }): Promise<TaggedResource[]> {
    const tagFilters: TagFilter[] = [
      { key: 'TenantId', values: [tenantId] },
    ];

    if (options?.environment) {
      tagFilters.push({ key: 'Environment', values: [options.environment] });
    }

    return this.findResourcesByTags({
      tagFilters,
      resourceTypeFilters: options?.resourceTypeFilters,
    });
  }

  /**
   * Check tag compliance for resources
   */
  async checkCompliance(params: {
    resourceArns?: string[];
    resourceTypeFilters?: string[];
    policy?: TagPolicy;
  }): Promise<TagComplianceResult[]> {
    const policy = params.policy || this.config.defaultPolicy;
    if (!policy) {
      throw new Error('No tag policy configured');
    }

    // Get resources to check
    let resources: TaggedResource[];

    if (params.resourceArns) {
      // Get specific resources
      resources = await this.getResourceTags(params.resourceArns);
    } else {
      // Get all resources of specified types
      resources = await this.findResourcesByTags({
        tagFilters: [],
        resourceTypeFilters: params.resourceTypeFilters,
      });
    }

    // Check each resource against policy
    return resources.map(resource => this.validateResourceTags(resource, policy));
  }

  /**
   * Get compliance summary
   */
  async getComplianceSummary(params?: {
    resourceTypeFilters?: string[];
    policy?: TagPolicy;
  }): Promise<TagComplianceSummary> {
    const results = await this.checkCompliance({
      resourceTypeFilters: params?.resourceTypeFilters,
      policy: params?.policy,
    });

    const summary: TagComplianceSummary = {
      totalResources: results.length,
      compliantResources: results.filter(r => r.compliant).length,
      nonCompliantResources: results.filter(r => !r.compliant).length,
      complianceRate: 0,
      byResourceType: {},
      commonViolations: [],
    };

    summary.complianceRate = summary.totalResources > 0
      ? (summary.compliantResources / summary.totalResources) * 100
      : 0;

    // Group by resource type
    for (const result of results) {
      if (!summary.byResourceType[result.resourceType]) {
        summary.byResourceType[result.resourceType] = {
          total: 0,
          compliant: 0,
          nonCompliant: 0,
        };
      }

      const typeStats = summary.byResourceType[result.resourceType];
      typeStats.total++;
      if (result.compliant) {
        typeStats.compliant++;
      } else {
        typeStats.nonCompliant++;
      }
    }

    // Identify common violations
    const violationCounts: Record<string, number> = {};
    for (const result of results) {
      for (const missing of result.missingTags) {
        violationCounts[missing] = (violationCounts[missing] || 0) + 1;
      }
      for (const invalid of result.invalidTags) {
        const key = `${invalid.key}:${invalid.reason}`;
        violationCounts[key] = (violationCounts[key] || 0) + 1;
      }
    }

    summary.commonViolations = Object.entries(violationCounts)
      .map(([key, count]) => ({
        tagKey: key,
        violationCount: count,
        reason: key.includes(':') ? key.split(':')[1] : 'Missing required tag',
      }))
      .sort((a, b) => b.violationCount - a.violationCount)
      .slice(0, 10);

    return summary;
  }

  /**
   * Apply tags to resources
   */
  async tagResources(params: {
    resourceArns: string[];
    tags: Tag[];
  }): Promise<{ success: boolean; failedResources?: string[] }> {
    const { TagResourcesCommand } = await import('@aws-sdk/client-resource-groups-tagging-api');

    const command = new TagResourcesCommand({
      ResourceARNList: params.resourceArns,
      Tags: params.tags.reduce((acc, tag) => {
        acc[tag.key] = tag.value;
        return acc;
      }, {} as Record<string, string>),
    });

    try {
      const response = await this.config.taggingClient.send(command);
      return {
        success: (response.FailedResourcesMap?.size || 0) === 0,
        failedResources: response.FailedResourcesMap
          ? Array.from(response.FailedResourcesMap.keys())
          : undefined,
      };
    } catch (error) {
      return {
        success: false,
        failedResources: params.resourceArns,
      };
    }
  }

  /**
   * Remove tags from resources
   */
  async untagResources(params: {
    resourceArns: string[];
    tagKeys: string[];
  }): Promise<{ success: boolean; failedResources?: string[] }> {
    const { UntagResourcesCommand } = await import('@aws-sdk/client-resource-groups-tagging-api');

    const command = new UntagResourcesCommand({
      ResourceARNList: params.resourceArns,
      TagKeys: params.tagKeys,
    });

    try {
      const response = await this.config.taggingClient.send(command);
      return {
        success: (response.FailedResourcesMap?.size || 0) === 0,
        failedResources: response.FailedResourcesMap
          ? Array.from(response.FailedResourcesMap.keys())
          : undefined,
      };
    } catch (error) {
      return {
        success: false,
        failedResources: params.resourceArns,
      };
    }
  }

  /**
   * Validate tags against policy
   */
  validateTags(tags: Tag[], policy?: TagPolicy): {
    valid: boolean;
    missingTags: string[];
    invalidTags: Array<{ key: string; value: string; reason: string }>;
  } {
    const tagPolicy = policy || this.config.defaultPolicy;
    if (!tagPolicy) {
      return { valid: true, missingTags: [], invalidTags: [] };
    }

    const tagMap = new Map(tags.map(t => [t.key, t.value]));
    const missingTags: string[] = [];
    const invalidTags: Array<{ key: string; value: string; reason: string }> = [];

    // Check required tags
    for (const requiredTag of tagPolicy.requiredTags) {
      if (!tagMap.has(requiredTag)) {
        missingTags.push(requiredTag);
      }
    }

    // Validate tag values
    for (const [key, value] of tagMap) {
      const rule = tagPolicy.rules[key];
      if (!rule) continue;

      // Check allowed values
      if (rule.allowedValues && !rule.allowedValues.includes(value)) {
        invalidTags.push({
          key,
          value,
          reason: `Value must be one of: ${rule.allowedValues.join(', ')}`,
        });
      }

      // Check pattern
      if (rule.pattern) {
        const regex = new RegExp(rule.pattern);
        if (!regex.test(value)) {
          invalidTags.push({
            key,
            value,
            reason: `Value does not match required pattern: ${rule.pattern}`,
          });
        }
      }

      // Custom validator
      if (rule.validator && !rule.validator(value)) {
        invalidTags.push({
          key,
          value,
          reason: 'Value failed custom validation',
        });
      }
    }

    return {
      valid: missingTags.length === 0 && invalidTags.length === 0,
      missingTags,
      invalidTags,
    };
  }

  /**
   * Private: Get tags for specific resources
   */
  private async getResourceTags(resourceArns: string[]): Promise<TaggedResource[]> {
    const { GetResourcesCommand } = await import('@aws-sdk/client-resource-groups-tagging-api');

    const command = new GetResourcesCommand({
      ResourceARNList: resourceArns,
    });

    const response = await this.config.taggingClient.send(command);

    return (response.ResourceTagMappingList || []).map((r: any) => ({
      resourceArn: r.ResourceARN,
      resourceType: this.extractResourceType(r.ResourceARN),
      tags: (r.Tags || []).map((t: any) => ({ key: t.Key, value: t.Value })),
      region: this.extractRegion(r.ResourceARN),
    }));
  }

  /**
   * Private: Validate resource tags against policy
   */
  private validateResourceTags(resource: TaggedResource, policy: TagPolicy): TagComplianceResult {
    const validation = this.validateTags(resource.tags, policy);

    return {
      resourceArn: resource.resourceArn,
      resourceType: resource.resourceType,
      compliant: validation.valid,
      missingTags: validation.missingTags,
      invalidTags: validation.invalidTags,
      tags: resource.tags,
    };
  }

  /**
   * Private: Extract resource type from ARN
   */
  private extractResourceType(arn: string): string {
    // ARN format: arn:partition:service:region:account-id:resource-type/resource-id
    const parts = arn.split(':');
    if (parts.length >= 6) {
      const service = parts[2];
      const resourcePart = parts.slice(5).join(':');
      const resourceType = resourcePart.split('/')[0];
      return `${service}:${resourceType}`;
    }
    return 'unknown';
  }

  /**
   * Private: Extract region from ARN
   */
  private extractRegion(arn: string): string {
    const parts = arn.split(':');
    return parts.length >= 4 ? parts[3] : 'unknown';
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
    const ttl = this.config.cacheTTL || 300;
    this.cache.set(key, {
      data,
      expires: Date.now() + ttl * 1000,
    });
  }
}
