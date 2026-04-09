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
    description:
      'List all CloudFormation stacks across configured regions with optional filtering by status, tags, or creation date.',
    inputSchema: z.object({
      statuses: z
        .array(z.string())
        .optional()
        .describe('Filter by stack status (e.g., ["CREATE_COMPLETE", "UPDATE_COMPLETE"])'),
      namePattern: z
        .string()
        .optional()
        .describe('Filter by stack name pattern (supports wildcards)'),
      tags: z
        .array(
          z.object({
            key: z.string(),
            value: z.string().optional(),
          })
        )
        .optional()
        .describe('Filter by stack tags'),
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
    description:
      'List all resources in a CloudFormation stack with optional filtering by resource type or logical ID.',
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
    description:
      'Find which CloudFormation stack owns a specific resource (reverse lookup from resource ARN to stack).',
    inputSchema: z.object({
      resourceArn: z.string().describe('Resource ARN'),
      region: z.string().describe('AWS region'),
    }),
    callback: async (input) => {
      const stackName = await findStackForResourceImpl(
        config,
        input.resourceArn,
        input.region as AWSRegion
      );

      return JSON.stringify(
        {
          resourceArn: input.resourceArn,
          stackName: stackName || null,
          managed: !!stackName,
        },
        null,
        2
      );
    },
  });

  const detectDrift = tool({
    name: 'cfn_detect_drift',
    description:
      'Detect configuration drift for a CloudFormation stack. Identifies manual changes made outside CloudFormation.',
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
      const hierarchy = await getStackHierarchyImpl(
        config,
        input.stackName,
        input.region as AWSRegion,
        input.includeResources ?? false
      );
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
// Private helper functions — real AWS SDK v3 implementations
// ============================================================================

async function listStacksImpl(
  config: StackInventoryConfig,
  filter?: StackFilter
): Promise<StackSummary[]> {
  const { CloudFormationClient, ListStacksCommand } =
    await import('@aws-sdk/client-cloudformation');

  const defaultStatuses: StackStatus[] = [
    'CREATE_COMPLETE',
    'UPDATE_COMPLETE',
    'UPDATE_ROLLBACK_COMPLETE',
    'ROLLBACK_COMPLETE',
    'IMPORT_COMPLETE',
  ];

  if (config.includeDeleted) {
    defaultStatuses.push('DELETE_COMPLETE');
  }

  const statusFilter = filter?.statuses ?? defaultStatuses;
  const allStacks: StackSummary[] = [];

  for (const region of config.regions) {
    const client = new CloudFormationClient({ region });

    let nextToken: string | undefined;
    do {
      const command = new ListStacksCommand({
        StackStatusFilter: statusFilter,
        NextToken: nextToken,
      });

      const response = await client.send(command);

      for (const summary of response.StackSummaries ?? []) {
        const stack: StackSummary = {
          stackId: summary.StackId ?? '',
          stackName: summary.StackName ?? '',
          stackStatus: (summary.StackStatus ?? 'CREATE_COMPLETE') as StackStatus,
          creationTime: summary.CreationTime?.toISOString() ?? new Date().toISOString(),
          lastUpdatedTime: summary.LastUpdatedTime?.toISOString(),
          deletionTime: summary.DeletionTime?.toISOString(),
          templateDescription: summary.TemplateDescription,
          driftStatus: summary.DriftInformation?.StackDriftStatus as DriftStatus | undefined,
          driftLastCheckTime: summary.DriftInformation?.LastCheckTimestamp?.toISOString(),
          parentStackId: summary.ParentId,
          rootStackId: summary.RootId,
        };

        // Apply client-side filters
        if (filter?.namePattern) {
          const regex = new RegExp(filter.namePattern.replace(/\*/g, '.*'), 'i');
          if (!regex.test(stack.stackName)) continue;
        }

        if (filter?.createdAfter && new Date(stack.creationTime) < filter.createdAfter) continue;
        if (filter?.createdBefore && new Date(stack.creationTime) > filter.createdBefore) continue;

        if (
          filter?.driftStatuses &&
          stack.driftStatus &&
          !filter.driftStatuses.includes(stack.driftStatus)
        )
          continue;

        allStacks.push(stack);
      }

      nextToken = response.NextToken;
    } while (nextToken);
  }

  return allStacks;
}

async function getStackImpl(
  config: StackInventoryConfig,
  stackName: string,
  region: AWSRegion
): Promise<StackSummary> {
  const { CloudFormationClient, DescribeStacksCommand } =
    await import('@aws-sdk/client-cloudformation');

  const client = new CloudFormationClient({ region });
  const command = new DescribeStacksCommand({ StackName: stackName });

  const response = await client.send(command);
  const stacks = response.Stacks ?? [];

  if (stacks.length === 0) {
    throw new DiscoveryError(
      'RESOURCE_NOT_FOUND',
      `Stack '${stackName}' not found in ${region}`,
      null
    );
  }

  const s = stacks[0];
  return {
    stackId: s.StackId ?? '',
    stackName: s.StackName ?? '',
    stackStatus: (s.StackStatus ?? 'CREATE_COMPLETE') as StackStatus,
    creationTime: s.CreationTime?.toISOString() ?? new Date().toISOString(),
    lastUpdatedTime: s.LastUpdatedTime?.toISOString(),
    templateDescription: s.Description,
    driftStatus: s.DriftInformation?.StackDriftStatus as DriftStatus | undefined,
    driftLastCheckTime: s.DriftInformation?.LastCheckTimestamp?.toISOString(),
    parentStackId: s.ParentId,
    rootStackId: s.RootId,
  };
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
  const { CloudFormationClient, ListStackResourcesCommand } =
    await import('@aws-sdk/client-cloudformation');

  const client = new CloudFormationClient({ region: query.region });
  const allResources: StackResource[] = [];

  let nextToken: string | undefined;
  do {
    const command = new ListStackResourcesCommand({
      StackName: query.stackName,
      NextToken: nextToken,
    });

    const response = await client.send(command);

    for (const summary of response.StackResourceSummaries ?? []) {
      const resource: StackResource = {
        logicalResourceId: summary.LogicalResourceId ?? '',
        physicalResourceId: summary.PhysicalResourceId ?? '',
        resourceType: (summary.ResourceType ?? '') as AWSResourceType,
        resourceStatus: summary.ResourceStatus ?? '',
        timestamp: summary.LastUpdatedTimestamp?.toISOString() ?? new Date().toISOString(),
        stackId: '', // populated by caller if needed
        stackName: query.stackName,
        driftStatus: summary.DriftInformation?.StackResourceDriftStatus as any,
      };

      // Apply client-side filters
      if (query.logicalIdPattern) {
        const regex = new RegExp(query.logicalIdPattern.replace(/\*/g, '.*'), 'i');
        if (!regex.test(resource.logicalResourceId)) continue;
      }

      if (query.resourceTypes && !query.resourceTypes.includes(resource.resourceType)) continue;

      allResources.push(resource);
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return allResources;
}

async function findStackForResourceImpl(
  config: StackInventoryConfig,
  resourceArn: string,
  region: AWSRegion
): Promise<string | null> {
  // Extract physical resource ID from ARN for lookup
  const physicalId = resourceArn.split(':').pop()?.split('/').pop() ?? resourceArn;

  // List stacks in the region and search their resources
  const stacks = await listStacksImpl(config, {
    statuses: ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'],
  });

  const regionStacks = stacks.filter((s) => {
    // StackId ARN contains the region
    const stackRegion = s.stackId.split(':')[3];
    return stackRegion === region;
  });

  for (const stack of regionStacks) {
    try {
      const resources = await listStackResourcesImpl(config, {
        stackName: stack.stackName,
        region,
      });

      const found = resources.find(
        (r) => r.physicalResourceId === physicalId || r.physicalResourceId === resourceArn
      );

      if (found) {
        return stack.stackName;
      }
    } catch {
      // Stack may have been deleted between list and describe; skip
      continue;
    }
  }

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
  const {
    CloudFormationClient,
    DetectStackDriftCommand,
    DescribeStackDriftDetectionStatusCommand,
    DescribeStackResourceDriftsCommand,
  } = await import('@aws-sdk/client-cloudformation');

  const client = new CloudFormationClient({ region: options.region });

  // Initiate drift detection
  const detectCommand = new DetectStackDriftCommand({ StackName: options.stackName });
  const detectResponse = await client.send(detectCommand);
  const detectionId = detectResponse.StackDriftDetectionId ?? '';

  if (!options.waitForCompletion) {
    return {
      stackId: '',
      stackName: options.stackName,
      stackDriftStatus: 'NOT_CHECKED',
      detectionTime: new Date().toISOString(),
      driftedResourcesCount: 0,
      driftedResources: [],
    };
  }

  // Poll for completion
  const timeout = (options.timeoutSeconds ?? 300) * 1000;
  const startTime = Date.now();
  let status: string = 'DETECTION_IN_PROGRESS';

  while (status === 'DETECTION_IN_PROGRESS' && Date.now() - startTime < timeout) {
    await sleep(5000);

    const statusCommand = new DescribeStackDriftDetectionStatusCommand({
      StackDriftDetectionId: detectionId,
    });
    const statusResponse = await client.send(statusCommand);
    status = statusResponse.DetectionStatus ?? 'DETECTION_FAILED';

    if (status === 'DETECTION_COMPLETE') {
      // Fetch drifted resource details
      const driftsCommand = new DescribeStackResourceDriftsCommand({
        StackName: options.stackName,
        StackResourceDriftStatusFilters: ['MODIFIED', 'DELETED'],
      });
      const driftsResponse = await client.send(driftsCommand);

      const driftedResources = (driftsResponse.StackResourceDrifts ?? []).map((d) => ({
        logicalResourceId: d.LogicalResourceId ?? '',
        physicalResourceId: d.PhysicalResourceId ?? '',
        resourceType: (d.ResourceType ?? '') as AWSResourceType,
        driftStatus: (d.StackResourceDriftStatus ?? 'NOT_CHECKED') as any,
        expectedProperties: d.ExpectedProperties ? JSON.parse(d.ExpectedProperties) : undefined,
        actualProperties: d.ActualProperties ? JSON.parse(d.ActualProperties) : undefined,
        propertyDifferences: (d.PropertyDifferences ?? []).map((pd) => ({
          propertyPath: pd.PropertyPath ?? '',
          expectedValue: pd.ExpectedValue,
          actualValue: pd.ActualValue,
          differenceType: (pd.DifferenceType ?? 'NOT_EQUAL') as 'ADD' | 'REMOVE' | 'NOT_EQUAL',
        })),
      }));

      return {
        stackId: statusResponse.StackId ?? '',
        stackName: options.stackName,
        stackDriftStatus: (statusResponse.StackDriftStatus ?? 'UNKNOWN') as DriftStatus,
        detectionTime: statusResponse.Timestamp?.toISOString() ?? new Date().toISOString(),
        driftedResourcesCount: statusResponse.DriftedStackResourceCount ?? 0,
        driftedResources,
      };
    }

    if (status === 'DETECTION_FAILED') {
      throw new DiscoveryError(
        'INTERNAL_ERROR',
        `Drift detection failed for stack '${options.stackName}': ${statusResponse.DetectionStatusReason ?? 'Unknown reason'}`,
        null
      );
    }
  }

  throw new DiscoveryError(
    'INTERNAL_ERROR',
    `Drift detection timed out for stack '${options.stackName}' after ${options.timeoutSeconds}s`,
    null
  );
}

async function detectDriftForAllStacksImpl(
  config: StackInventoryConfig,
  filter?: StackFilter
): Promise<DriftDetectionResult[]> {
  const stacks = await listStacksImpl(config, {
    statuses: filter?.statuses ?? ['CREATE_COMPLETE', 'UPDATE_COMPLETE'],
    namePattern: filter?.namePattern,
  });

  const results: DriftDetectionResult[] = [];

  for (const stack of stacks) {
    const region = (stack.stackId.split(':')[3] ?? config.regions[0]) as AWSRegion;
    try {
      const result = await detectDriftImpl(config, {
        stackName: stack.stackName,
        region,
        waitForCompletion: true,
        timeoutSeconds: 120,
      });
      results.push(result);
    } catch (error) {
      // Record failure but continue with other stacks
      results.push({
        stackId: stack.stackId,
        stackName: stack.stackName,
        stackDriftStatus: 'UNKNOWN',
        detectionTime: new Date().toISOString(),
        driftedResourcesCount: 0,
        driftedResources: [],
      });
    }
  }

  return results;
}

async function getStackHierarchyImpl(
  config: StackInventoryConfig,
  stackName: string,
  region: AWSRegion,
  includeResources: boolean
): Promise<any> {
  const stack = await getStackImpl(config, stackName, region);

  const resources = includeResources
    ? await listStackResourcesImpl(config, { stackName, region })
    : [];

  // Find nested stacks (resources of type AWS::CloudFormation::Stack)
  const nestedStackResources = resources.filter(
    (r) => r.resourceType === 'AWS::CloudFormation::Stack'
  );

  const nestedStacks: any[] = [];
  for (const nested of nestedStackResources) {
    try {
      const child = await getStackHierarchyImpl(
        config,
        nested.physicalResourceId,
        region,
        includeResources
      );
      nestedStacks.push(child);
    } catch {
      // Nested stack may not be accessible; skip
      nestedStacks.push({
        rootStack: nested.physicalResourceId,
        status: 'INACCESSIBLE',
        nestedStacks: [],
      });
    }
  }

  return {
    rootStack: stack.stackName,
    stackId: stack.stackId,
    status: stack.stackStatus,
    creationTime: stack.creationTime,
    lastUpdatedTime: stack.lastUpdatedTime,
    driftStatus: stack.driftStatus,
    ...(includeResources && { resources }),
    nestedStacks,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
