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
      tags: z.array(z.object({
        key: z.string(),
        values: z.array(z.string()),
        matchAll: z.boolean().optional(),
      })).describe('Tag filters'),
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
      includeUntagged: z.boolean().default(false).describe('Include resources missing TenantId tag'),
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
      tags: z.array(z.object({
        key: z.string(),
        value: z.string(),
      })).describe('Tags to add'),
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
// Private helper functions (implementation stubs)
// ============================================================================

async function findResourcesByTagsImpl(config: TagOrganizerConfig, params: any): Promise<TaggedResource[]> {
  // Stub: Would call AWS SDK ResourceGroupsTaggingAPIClient.getResources
  return [];
}

async function findTenantResourcesImpl(
  config: TagOrganizerConfig,
  tenantId: string,
  options: any
): Promise<TaggedResource[]> {
  // Stub: Would filter resources by TenantId tag
  return [];
}

async function checkComplianceImpl(
  config: TagOrganizerConfig,
  resourceArns: string[],
  policyName?: string
): Promise<TagComplianceResult[]> {
  // Stub: Would validate resources against tag policy
  return [];
}

async function getComplianceSummaryImpl(config: TagOrganizerConfig, params: any): Promise<TagComplianceSummary> {
  // Stub: Would aggregate compliance metrics
  return {
    totalResources: 0,
    compliantResources: 0,
    compliancePercentage: 0,
    byResourceType: {},
    topViolations: [],
  };
}

async function tagResourcesImpl(config: TagOrganizerConfig, resourceArns: string[], tags: Tag[]): Promise<void> {
  // Stub: Would call AWS SDK ResourceGroupsTaggingAPIClient.tagResources
}

async function untagResourcesImpl(config: TagOrganizerConfig, resourceArns: string[], tagKeys: string[]): Promise<void> {
  // Stub: Would call AWS SDK ResourceGroupsTaggingAPIClient.untagResources
}
