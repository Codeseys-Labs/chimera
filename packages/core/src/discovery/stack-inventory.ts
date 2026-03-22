/**
 * CloudFormation Stack Inventory & Drift Detection - Strands Tools
 *
 * Provides Strands @tool decorated functions for infrastructure-as-code (IaC)
 * provenance tracking by cataloging CloudFormation stacks and detecting drift.
 *
 * Based on: docs/research/aws-account-agent/03-CloudFormation-Stack-Inventory.md
 */

import { tool } from '../aws-tools/strands-agents';
import { z } from 'zod';
import type {
  StackSummary,
  StackResource,
  DriftDetectionResult,
  AWSResourceType,
  AWSRegion,
  StackStatus,
  DriftStatus,
} from './types';
import { DiscoveryError } from './types';

/**
 * Stack inventory configuration
 */
export interface StackInventoryConfig {
  /** AWS regions to scan for stacks */
  readonly regions: AWSRegion[];

  /** AWS account ID */
  readonly accountId: string;

  /** Include deleted stacks in inventory (default: false) */
  readonly includeDeleted?: boolean;

  /** Enable automatic drift detection (default: false) */
  readonly enableDriftDetection?: boolean;
}

/**
 * Stack query filter
 */
export interface StackFilter {
  readonly statuses?: StackStatus[];
  readonly namePattern?: string;
  readonly tags?: Array<{ key: string; value?: string }>;
  readonly createdAfter?: Date;
  readonly createdBefore?: Date;
  readonly driftStatuses?: DriftStatus[];
}

/**
 * Create Stack Inventory Strands tools
 */
export function createStackInventoryTools(config: StackInventoryConfig) {
  const listStacks = tool({
    name: 'cfn_list_stacks',
    description: 'List all CloudFormation stacks across configured regions with optional filtering by status, tags, or creation date.',
    inputSchema: z.object({
      statuses: z.array(z.string()).optional().describe('Filter by stack status (e.g., ["CREATE_COMPLETE", "UPDATE_COMPLETE"])'),
      namePattern: z.string().optional().describe('Filter by stack name pattern (supports wildcards)'),
      tags: z.array(z.object({
        key: z.string(),
        value: z.string().optional(),
      })).optional().describe('Filter by stack tags'),
      createdAfter: z.string().optional().describe('Created after timestamp (ISO 8601)'),
      createdBefore: z.string().optional().describe('Created before timestamp (ISO 8601)'),
      driftStatuses: z.array(z.string()).optional().describe('Filter by drift status'),
    }),
    callback: async (input) => {
      const filter: StackFilter = {
        statuses: input.statuses as StackStatus[] | undefined,
        namePattern: input.namePattern,
        tags: input.tags,
        createdAfter: input.createdAfter ? new Date(input.createdAfter) : undefined,
        createdBefore: input.createdBefore ? new Date(input.createdBefore) : undefined,
        driftStatuses: input.driftStatuses as DriftStatus[] | undefined,
      };

      const stacks = await listStacksImpl(config, filter);
      return JSON.stringify({ stacks }, null, 2);
    },
  });

  const getStack = tool({
    name: 'cfn_get_stack',
    description: 'Get detailed information about a specific CloudFormation stack.',
    inputSchema: z.object({
      stackName: z.string().describe('Stack name or ID'),
      region: z.string().describe('AWS region (e.g., "us-east-1")'),
    }),
    callback: async (input) => {
      const stack = await getStackImpl(config, input.stackName, input.region as AWSRegion);
      return JSON.stringify(stack, null, 2);
    },
  });

  const listStackResources = tool({
    name: 'cfn_list_stack_resources',
    description: 'List all resources in a CloudFormation stack with optional filtering by resource type or logical ID.',
    inputSchema: z.object({
      stackName: z.string().describe('Stack name or ID'),
      region: z.string().describe('AWS region'),
      logicalIdPattern: z.string().optional().describe('Filter by logical resource ID pattern'),
      resourceTypes: z.array(z.string()).optional().describe('Filter by resource types'),
    }),
    callback: async (input) => {
      const resources = await listStackResourcesImpl(config, {
        stackName: input.stackName,
        region: input.region as AWSRegion,
        logicalIdPattern: input.logicalIdPattern,
        resourceTypes: input.resourceTypes as AWSResourceType[] | undefined,
      });

      return JSON.stringify({ resources }, null, 2);
    },
  });

  const findStackForResource = tool({
    name: 'cfn_find_stack_for_resource',
    description: 'Find which CloudFormation stack owns a specific resource (reverse lookup from resource ARN to stack).',
    inputSchema: z.object({
      resourceArn: z.string().describe('Resource ARN'),
      region: z.string().describe('AWS region'),
    }),
    callback: async (input) => {
      const stackName = await findStackForResourceImpl(config, input.resourceArn, input.region as AWSRegion);

      return JSON.stringify({
        resourceArn: input.resourceArn,
        stackName: stackName || null,
        managed: !!stackName,
      }, null, 2);
    },
  });

  const detectDrift = tool({
    name: 'cfn_detect_drift',
    description: 'Detect configuration drift for a CloudFormation stack. Identifies manual changes made outside CloudFormation.',
    inputSchema: z.object({
      stackName: z.string().describe('Stack name or ID'),
      region: z.string().describe('AWS region'),
      waitForCompletion: z.boolean().default(true).describe('Wait for drift detection to complete'),
      timeoutSeconds: z.number().default(300).describe('Timeout in seconds'),
    }),
    callback: async (input) => {
      const result = await detectDriftImpl(config, {
        stackName: input.stackName,
        region: input.region as AWSRegion,
        waitForCompletion: input.waitForCompletion,
        timeoutSeconds: input.timeoutSeconds,
      });

      return JSON.stringify(result, null, 2);
    },
  });

  const detectDriftForAllStacks = tool({
    name: 'cfn_detect_drift_all',
    description: 'Detect drift for all CloudFormation stacks across configured regions.',
    inputSchema: z.object({
      statuses: z.array(z.string()).optional().describe('Filter by stack status'),
      namePattern: z.string().optional().describe('Filter by stack name pattern'),
    }),
    callback: async (input) => {
      const filter: StackFilter = {
        statuses: input.statuses as StackStatus[] | undefined,
        namePattern: input.namePattern,
      };

      const results = await detectDriftForAllStacksImpl(config, filter);
      return JSON.stringify({ driftResults: results }, null, 2);
    },
  });

  const getStackHierarchy = tool({
    name: 'cfn_get_stack_hierarchy',
    description: 'Get parent/child nested stack relationships for a CloudFormation stack.',
    inputSchema: z.object({
      stackName: z.string().describe('Root stack name'),
      region: z.string().describe('AWS region'),
      includeResources: z.boolean().default(false).describe('Include resource details'),
    }),
    callback: async (input) => {
      const hierarchy = await getStackHierarchyImpl(config, input.stackName, input.region as AWSRegion, input.includeResources);
      return JSON.stringify(hierarchy, null, 2);
    },
  });

  return [
    listStacks,
    getStack,
    listStackResources,
    findStackForResource,
    detectDrift,
    detectDriftForAllStacks,
    getStackHierarchy,
  ];
}

// ============================================================================
// Private helper functions (implementation stubs)
// ============================================================================

async function listStacksImpl(config: StackInventoryConfig, filter?: StackFilter): Promise<StackSummary[]> {
  // Stub: Would call AWS SDK CloudFormationClient.describeStacks across regions
  return [];
}

async function getStackImpl(config: StackInventoryConfig, stackName: string, region: AWSRegion): Promise<StackSummary> {
  // Stub: Would call AWS SDK CloudFormationClient.describeStacks
  throw new DiscoveryError('NOT_FOUND', 'Stack not found', null);
}

async function listStackResourcesImpl(
  config: StackInventoryConfig,
  query: {
    stackName: string;
    region: AWSRegion;
    logicalIdPattern?: string;
    resourceTypes?: AWSResourceType[];
  }
): Promise<StackResource[]> {
  // Stub: Would call AWS SDK CloudFormationClient.listStackResources
  return [];
}

async function findStackForResourceImpl(
  config: StackInventoryConfig,
  resourceArn: string,
  region: AWSRegion
): Promise<string | null> {
  // Stub: Would call AWS SDK CloudFormationClient.describeStackResource
  return null;
}

async function detectDriftImpl(
  config: StackInventoryConfig,
  options: {
    stackName: string;
    region: AWSRegion;
    waitForCompletion?: boolean;
    timeoutSeconds?: number;
  }
): Promise<DriftDetectionResult> {
  // Stub: Would call AWS SDK CloudFormationClient.detectStackDrift
  return {
    stackId: '',
    stackName: options.stackName,
    driftStatus: 'NOT_CHECKED',
    driftedResourceCount: 0,
    totalResourceCount: 0,
    driftDetectionTime: new Date(),
    driftedResources: [],
  };
}

async function detectDriftForAllStacksImpl(
  config: StackInventoryConfig,
  filter?: StackFilter
): Promise<DriftDetectionResult[]> {
  // Stub: Would detect drift for all matching stacks
  return [];
}

async function getStackHierarchyImpl(
  config: StackInventoryConfig,
  stackName: string,
  region: AWSRegion,
  includeResources: boolean
): Promise<any> {
  // Stub: Would build stack hierarchy tree
  return {
    rootStack: stackName,
    nestedStacks: [],
  };
}
