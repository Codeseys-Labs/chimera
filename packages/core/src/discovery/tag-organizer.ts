/**
 * Tag Organizer - Resource Tagging Governance and Compliance - Strands Tools
 *
 * Provides Strands @tool decorated functions for tag validation, compliance
 * checking, and resource discovery based on AWS tagging best practices.
 *
 * Based on: docs/research/aws-account-agent/05-Tag-Organization-Strategy.md
 */

import { tool } from '../aws-tools/strands-agents';
import { z } from 'zod';

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
  key: string;
  required: boolean;
  allowedValues?: string[];
  pattern?: string;
  validator?: (value: string) => boolean;
}

/**
 * Tag policy definition
 */
export interface TagPolicy {
  name: string;
  description?: string;
  requiredTags: string[];
  rules: Record<string, TagValidationRule>;
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
  matchAll?: boolean;
}

/**
 * Tagged resource
 */
export interface TaggedResource {
  resourceArn: string;
  resourceType: string;
  tags: Tag[];
  region?: string;
}

/**
 * Tag compliance summary
 */
export interface TagComplianceSummary {
  totalResources: number;
  compliantResources: number;
  compliancePercentage: number;
  byResourceType: Record<string, { total: number; compliant: number }>;
  topViolations: Array<{ tag: string; count: number }>;
}

/**
 * Tag organizer configuration
 */
export interface TagOrganizerConfig {
  resourceGroupsTaggingClient: ResourceGroupsTaggingClient;
  configClient: ConfigClient;
  tagPolicy: TagPolicy;
  accountId: string;
}

/**
 * Chimera standard tag schema
 */
export const CHIMERA_TAG_SCHEMA = {
  TENANT_ID: 'TenantId',
  ENVIRONMENT: 'Environment',
  COST_CENTER: 'CostCenter',
  MANAGED_BY: 'ManagedBy',
  PROJECT: 'Project',
};

/**
 * Create Tag Organizer Strands tools
 */
export function createTagOrganizerTools(config: TagOrganizerConfig) {
  const findResourcesByTags = tool({
    name: 'tags_find_resources',
    description: 'Find AWS resources by tags with flexible filtering options.',
    inputSchema: z.object({
      tags: z
        .array(
          z.object({
            key: z.string(),
            values: z.array(z.string()),
            matchAll: z.boolean().optional(),
          })
        )
        .describe('Tag filters'),
      resourceTypes: z.array(z.string()).optional().describe('Filter by resource types'),
      maxResults: z.number().min(1).max(500).default(100).describe('Maximum results'),
    }),
    callback: async (input) => {
      const resources = await findResourcesByTagsImpl(config, input);
      return JSON.stringify({ resources }, null, 2);
    },
  });

  const findTenantResources = tool({
    name: 'tags_find_tenant_resources',
    description: 'Find all resources owned by a specific tenant using TenantId tag.',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant identifier'),
      resourceTypes: z.array(z.string()).optional().describe('Filter by resource types'),
      includeUntagged: z
        .boolean()
        .default(false)
        .describe('Include resources missing TenantId tag'),
    }),
    callback: async (input) => {
      const resources = await findTenantResourcesImpl(config, input.tenantId, input);
      return JSON.stringify({ tenantId: input.tenantId, resources }, null, 2);
    },
  });

  const checkCompliance = tool({
    name: 'tags_check_compliance',
    description: 'Check tag compliance for resources against tag policy.',
    inputSchema: z.object({
      resourceArns: z.array(z.string()).describe('Resource ARNs to check'),
      policy: z.string().optional().describe('Policy name (uses default if not specified)'),
    }),
    callback: async (input) => {
      const results = await checkComplianceImpl(config, input.resourceArns, input.policy);
      return JSON.stringify({ complianceResults: results }, null, 2);
    },
  });

  const getComplianceSummary = tool({
    name: 'tags_get_compliance_summary',
    description: 'Get tag compliance summary across all resources.',
    inputSchema: z.object({
      resourceTypes: z.array(z.string()).optional().describe('Filter by resource types'),
      regions: z.array(z.string()).optional().describe('Filter by regions'),
    }),
    callback: async (input) => {
      const summary = await getComplianceSummaryImpl(config, input);
      return JSON.stringify(summary, null, 2);
    },
  });

  const tagResources = tool({
    name: 'tags_add_tags',
    description: 'Add or update tags on AWS resources.',
    inputSchema: z.object({
      resourceArns: z.array(z.string()).describe('Resource ARNs to tag'),
      tags: z
        .array(
          z.object({
            key: z.string(),
            value: z.string(),
          })
        )
        .describe('Tags to add'),
    }),
    callback: async (input) => {
      await tagResourcesImpl(config, input.resourceArns, input.tags as Tag[]);
      return JSON.stringify({
        success: true,
        tagged: input.resourceArns.length,
        tags: input.tags,
      });
    },
  });

  const untagResources = tool({
    name: 'tags_remove_tags',
    description: 'Remove tags from AWS resources.',
    inputSchema: z.object({
      resourceArns: z.array(z.string()).describe('Resource ARNs to untag'),
      tagKeys: z.array(z.string()).describe('Tag keys to remove'),
    }),
    callback: async (input) => {
      await untagResourcesImpl(config, input.resourceArns, input.tagKeys);
      return JSON.stringify({
        success: true,
        untagged: input.resourceArns.length,
        removedKeys: input.tagKeys,
      });
    },
  });

  return [
    findResourcesByTags,
    findTenantResources,
    checkCompliance,
    getComplianceSummary,
    tagResources,
    untagResources,
  ];
}

// ============================================================================
// Private helper functions — real AWS SDK v3 implementations
// ============================================================================

async function findResourcesByTagsImpl(
  config: TagOrganizerConfig,
  params: {
    tags: Array<{ key: string; values: string[]; matchAll?: boolean }>;
    resourceTypes?: string[];
    maxResults?: number;
  }
): Promise<TaggedResource[]> {
  const { GetResourcesCommand } = await import('@aws-sdk/client-resource-groups-tagging-api');

  const tagFilters = params.tags.map((t) => ({
    Key: t.key,
    Values: t.values,
  }));

  const commandInput: any = {
    TagFilters: tagFilters,
    ResourcesPerPage: params.maxResults ?? 100,
  };

  if (params.resourceTypes && params.resourceTypes.length > 0) {
    commandInput.ResourceTypeFilters = params.resourceTypes;
  }

  const allResources: TaggedResource[] = [];
  let paginationToken: string | undefined;

  do {
    if (paginationToken) {
      commandInput.PaginationToken = paginationToken;
    }

    const command = new GetResourcesCommand(commandInput);
    const response = await config.resourceGroupsTaggingClient.send(command);

    for (const mapping of response.ResourceTagMappingList ?? []) {
      allResources.push({
        resourceArn: mapping.ResourceARN ?? '',
        resourceType: extractResourceTypeFromArn(mapping.ResourceARN ?? ''),
        tags: (mapping.Tags ?? []).map((t: any) => ({ key: t.Key ?? '', value: t.Value ?? '' })),
        region: extractRegionFromArn(mapping.ResourceARN ?? ''),
      });
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken && allResources.length < (params.maxResults ?? 100));

  return allResources;
}

async function findTenantResourcesImpl(
  config: TagOrganizerConfig,
  tenantId: string,
  options: { resourceTypes?: string[]; includeUntagged?: boolean }
): Promise<TaggedResource[]> {
  return findResourcesByTagsImpl(config, {
    tags: [{ key: CHIMERA_TAG_SCHEMA.TENANT_ID, values: [tenantId] }],
    resourceTypes: options.resourceTypes,
    maxResults: 500,
  });
}

async function checkComplianceImpl(
  config: TagOrganizerConfig,
  resourceArns: string[],
  policyName?: string
): Promise<TagComplianceResult[]> {
  const { GetResourcesCommand } = await import('@aws-sdk/client-resource-groups-tagging-api');

  // Fetch current tags for all requested resources
  // The Tagging API doesn't support filtering by ARN directly,
  // so we fetch all and filter locally, OR use GetResources with no filters
  // and match. For efficiency, fetch tags for each ARN individually.
  const results: TagComplianceResult[] = [];
  const policy = config.tagPolicy;

  // Batch fetch tags — GetResources doesn't filter by ARN directly,
  // so we'll use a no-filter request and match, or just iterate.
  // For a targeted check, query all and filter:
  const command = new GetResourcesCommand({
    ResourcesPerPage: 100,
  });

  const tagMap = new Map<string, Tag[]>();
  let paginationToken: string | undefined;

  do {
    const cmdInput: any = { ResourcesPerPage: 100 };
    if (paginationToken) cmdInput.PaginationToken = paginationToken;

    const response = await config.resourceGroupsTaggingClient.send(
      new GetResourcesCommand(cmdInput)
    );

    for (const mapping of response.ResourceTagMappingList ?? []) {
      const arn = mapping.ResourceARN ?? '';
      if (resourceArns.includes(arn)) {
        tagMap.set(
          arn,
          (mapping.Tags ?? []).map((t: any) => ({ key: t.Key ?? '', value: t.Value ?? '' }))
        );
      }
    }

    paginationToken = response.PaginationToken;

    // Stop early if we found all requested ARNs
    if (tagMap.size >= resourceArns.length) break;
  } while (paginationToken);

  for (const arn of resourceArns) {
    const tags = tagMap.get(arn) ?? [];
    const tagKeySet = new Set(tags.map((t) => t.key));

    const missingTags: string[] = [];
    const invalidTags: Array<{ key: string; value: string; reason: string }> = [];

    // Check required tags
    for (const requiredKey of policy.requiredTags) {
      if (!tagKeySet.has(requiredKey)) {
        missingTags.push(requiredKey);
      }
    }

    // Validate tags against rules
    for (const tag of tags) {
      const rule = policy.rules[tag.key];
      if (!rule) continue;

      if (rule.allowedValues && !rule.allowedValues.includes(tag.value)) {
        invalidTags.push({
          key: tag.key,
          value: tag.value,
          reason: `Value '${tag.value}' not in allowed values: [${rule.allowedValues.join(', ')}]`,
        });
      }

      if (rule.pattern) {
        const regex = new RegExp(rule.pattern);
        if (!regex.test(tag.value)) {
          invalidTags.push({
            key: tag.key,
            value: tag.value,
            reason: `Value '${tag.value}' does not match pattern: ${rule.pattern}`,
          });
        }
      }

      if (rule.validator && !rule.validator(tag.value)) {
        invalidTags.push({
          key: tag.key,
          value: tag.value,
          reason: `Value '${tag.value}' failed custom validation`,
        });
      }
    }

    results.push({
      resourceArn: arn,
      resourceType: extractResourceTypeFromArn(arn),
      compliant: missingTags.length === 0 && invalidTags.length === 0,
      missingTags,
      invalidTags,
      tags,
    });
  }

  return results;
}

async function getComplianceSummaryImpl(
  config: TagOrganizerConfig,
  params: { resourceTypes?: string[]; regions?: string[] }
): Promise<TagComplianceSummary> {
  const { GetComplianceSummaryCommand } =
    await import('@aws-sdk/client-resource-groups-tagging-api');

  const commandInput: any = {
    TagKeyFilters: config.tagPolicy.requiredTags,
  };

  if (params.resourceTypes && params.resourceTypes.length > 0) {
    commandInput.ResourceTypeFilters = params.resourceTypes;
  }

  if (params.regions && params.regions.length > 0) {
    commandInput.RegionFilters = params.regions;
  }

  // Also gather per-resource-type breakdown from GetResources
  const allResources = await findResourcesByTagsImpl(config, {
    tags: [], // No filters — get all
    resourceTypes: params.resourceTypes,
    maxResults: 500,
  });

  const policy = config.tagPolicy;
  const byResourceType: Record<string, { total: number; compliant: number }> = {};
  const violationCounts: Record<string, number> = {};
  let compliantCount = 0;

  for (const resource of allResources) {
    const type = resource.resourceType;
    if (!byResourceType[type]) {
      byResourceType[type] = { total: 0, compliant: 0 };
    }
    byResourceType[type].total++;

    const tagKeySet = new Set(resource.tags.map((t) => t.key));
    let isCompliant = true;

    for (const required of policy.requiredTags) {
      if (!tagKeySet.has(required)) {
        isCompliant = false;
        violationCounts[required] = (violationCounts[required] || 0) + 1;
      }
    }

    if (isCompliant) {
      compliantCount++;
      byResourceType[type].compliant++;
    }
  }

  const topViolations = Object.entries(violationCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalResources: allResources.length,
    compliantResources: compliantCount,
    compliancePercentage:
      allResources.length > 0 ? (compliantCount / allResources.length) * 100 : 0,
    byResourceType,
    topViolations,
  };
}

async function tagResourcesImpl(
  config: TagOrganizerConfig,
  resourceArns: string[],
  tags: Tag[]
): Promise<void> {
  const { TagResourcesCommand } = await import('@aws-sdk/client-resource-groups-tagging-api');

  const tagMap: Record<string, string> = {};
  for (const tag of tags) {
    tagMap[tag.key] = tag.value;
  }

  const command = new TagResourcesCommand({
    ResourceARNList: resourceArns,
    Tags: tagMap,
  });

  const response = await config.resourceGroupsTaggingClient.send(command);

  // Check for partial failures
  const failedResources = response.FailedResourcesMap ?? {};
  const failedCount = Object.keys(failedResources).length;
  if (failedCount > 0) {
    const failureDetails = Object.entries(failedResources)
      .map(([arn, info]: [string, any]) => `${arn}: ${info.ErrorMessage ?? 'Unknown error'}`)
      .join('; ');
    throw new Error(`Failed to tag ${failedCount} resource(s): ${failureDetails}`);
  }
}

async function untagResourcesImpl(
  config: TagOrganizerConfig,
  resourceArns: string[],
  tagKeys: string[]
): Promise<void> {
  const { UntagResourcesCommand } = await import('@aws-sdk/client-resource-groups-tagging-api');

  const command = new UntagResourcesCommand({
    ResourceARNList: resourceArns,
    TagKeys: tagKeys,
  });

  const response = await config.resourceGroupsTaggingClient.send(command);

  // Check for partial failures
  const failedResources = response.FailedResourcesMap ?? {};
  const failedCount = Object.keys(failedResources).length;
  if (failedCount > 0) {
    const failureDetails = Object.entries(failedResources)
      .map(([arn, info]: [string, any]) => `${arn}: ${info.ErrorMessage ?? 'Unknown error'}`)
      .join('; ');
    throw new Error(`Failed to untag ${failedCount} resource(s): ${failureDetails}`);
  }
}

// ============================================================================
// Utility helpers
// ============================================================================

function extractResourceTypeFromArn(arn: string): string {
  // ARN format: arn:aws:service:region:account:resource-type/resource-id
  const parts = arn.split(':');
  if (parts.length < 6) return 'unknown';

  const service = parts[2];
  const resourcePart = parts[5] ?? '';
  const resourceType = resourcePart.split('/')[0];

  return `${service}::${resourceType}`;
}

function extractRegionFromArn(arn: string): string {
  const parts = arn.split(':');
  return parts[3] ?? '';
}
