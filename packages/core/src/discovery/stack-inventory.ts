/**
 * CloudFormation Stack Inventory & Drift Detection
 *
 * Provides infrastructure-as-code (IaC) provenance tracking by cataloging
 * CloudFormation stacks and detecting drift from template definitions.
 *
 * CloudFormation offers:
 * - **Stack inventory**: List all IaC-managed resources
 * - **Provenance mapping**: Which resources belong to which stacks
 * - **Drift detection**: Find manual changes outside CloudFormation
 * - **Resource-to-stack mapping**: Reverse lookup from resource to stack
 * - **Stack hierarchy**: Parent/child nested stack relationships
 *
 * Complements Config/Explorer by providing IaC context that answers:
 * - "Was this resource created by CloudFormation or manually?"
 * - "Which stack owns this Lambda function?"
 * - "Has this resource been modified outside the template?"
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html
 * @see docs/research/aws-account-agent/03-CloudFormation-Stack-Inventory.md
 */

import type {
  StackSummary,
  StackResource,
  DriftDetectionResult,
  ResourceInventoryEntry,
  AWSResourceType,
  AWSRegion,
  StackStatus,
  DriftStatus,
  ResourceDriftStatus,
  ARN,
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
  /** Stack status filter (default: active stacks only) */
  readonly statuses?: StackStatus[];

  /** Filter by stack name pattern (supports wildcards) */
  readonly namePattern?: string;

  /** Filter by stack tags */
  readonly tags?: Array<{ key: string; value?: string }>;

  /** Created after timestamp */
  readonly createdAfter?: Date;

  /** Created before timestamp */
  readonly createdBefore?: Date;

  /** Drift status filter */
  readonly driftStatuses?: DriftStatus[];
}

/**
 * Stack resource query options
 */
export interface StackResourceQuery {
  /** Stack name or ID */
  readonly stackName: string;

  /** Region where stack exists */
  readonly region: AWSRegion;

  /** Filter by logical resource ID pattern */
  readonly logicalIdPattern?: string;

  /** Filter by resource type */
  readonly resourceTypes?: AWSResourceType[];
}

/**
 * Drift detection options
 */
export interface DriftDetectionOptions {
  /** Stack name or ID */
  readonly stackName: string;

  /** Region where stack exists */
  readonly region: AWSRegion;

  /** Wait for detection to complete (default: true) */
  readonly waitForCompletion?: boolean;

  /** Timeout in seconds (default: 300) */
  readonly timeoutSeconds?: number;
}

/**
 * CloudFormation Stack Inventory Service
 *
 * Tracks IaC-managed infrastructure and detects configuration drift.
 */
export class StackInventory {
  private readonly config: StackInventoryConfig;

  /**
   * Initialize stack inventory
   *
   * @param config - Inventory configuration
   */
  constructor(config: StackInventoryConfig) {
    this.config = config;
  }

  /**
   * List all CloudFormation stacks across configured regions
   *
   * @example
   * ```typescript
   * // Find all active stacks
   * const stacks = await inventory.listStacks({
   *   statuses: ['CREATE_COMPLETE', 'UPDATE_COMPLETE']
   * });
   * ```
   *
   * @param filter - Stack filter options
   * @returns Array of stack summaries
   * @throws {DiscoveryError} On service failure
   */
  async listStacks(filter?: StackFilter): Promise<StackSummary[]> {
    try {
      const allStacks: StackSummary[] = [];

      // Query each region in parallel
      const regionPromises = this.config.regions.map((region) =>
        this.listStacksInRegion(region, filter)
      );

      const regionResults = await Promise.all(regionPromises);
      regionResults.forEach((stacks) => allStacks.push(...stacks));

      return allStacks;
    } catch (error) {
      throw this.handleStackError(error, 'listStacks');
    }
  }

  /**
   * Get detailed information about a specific stack
   *
   * @param stackName - Stack name or ID
   * @param region - Region where stack exists
   * @returns Stack summary with full details
   * @throws {DiscoveryError} If stack not found
   */
  async getStack(stackName: string, region: AWSRegion): Promise<StackSummary> {
    try {
      // Implementation would use AWS SDK CloudFormationClient.describeStacks
      const stack = await this.fetchStackDetails(stackName, region);

      if (!stack) {
        throw new DiscoveryError(
          'RESOURCE_NOT_FOUND',
          `Stack ${stackName} not found in region ${region}`
        );
      }

      return stack;
    } catch (error) {
      throw this.handleStackError(error, 'getStack');
    }
  }

  /**
   * List all resources managed by a specific stack
   *
   * @example
   * ```typescript
   * const resources = await inventory.listStackResources({
   *   stackName: 'ChimeraPlatformRuntimeStack',
   *   region: 'us-east-1',
   *   resourceTypes: ['AWS::Lambda::Function', 'AWS::DynamoDB::Table']
   * });
   * ```
   *
   * @param query - Stack resource query
   * @returns Array of stack resources
   * @throws {DiscoveryError} If stack not found
   */
  async listStackResources(query: StackResourceQuery): Promise<StackResource[]> {
    const { stackName, region, logicalIdPattern, resourceTypes } = query;

    try {
      // Implementation would use AWS SDK CloudFormationClient.listStackResources
      let resources = await this.fetchStackResources(stackName, region);

      // Apply filters
      if (logicalIdPattern) {
        const pattern = new RegExp(logicalIdPattern);
        resources = resources.filter((r) => pattern.test(r.logicalResourceId));
      }

      if (resourceTypes && resourceTypes.length > 0) {
        resources = resources.filter((r) => resourceTypes.includes(r.resourceType));
      }

      return resources;
    } catch (error) {
      throw this.handleStackError(error, 'listStackResources');
    }
  }

  /**
   * Find which stack owns a specific resource
   *
   * Reverse lookup: given a resource ARN or ID, find the CloudFormation
   * stack that manages it.
   *
   * @example
   * ```typescript
   * const stack = await inventory.findStackForResource(
   *   'arn:aws:lambda:us-east-1:123456789012:function:agent-runtime',
   *   'us-east-1'
   * );
   * // Returns: 'ChimeraPlatformRuntimeStack'
   * ```
   *
   * @param resourceArn - Resource ARN or physical ID
   * @param region - Region where resource exists
   * @returns Stack name or null if not managed by CloudFormation
   */
  async findStackForResource(resourceArn: string, region: AWSRegion): Promise<string | null> {
    try {
      const resourceId = this.extractResourceIdFromArn(resourceArn);

      // Query all stacks in region
      const stacks = await this.listStacksInRegion(region, {
        statuses: ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'],
      });

      // Check each stack's resources
      for (const stack of stacks) {
        const resources = await this.fetchStackResources(stack.stackName, region);

        const match = resources.find(
          (r) =>
            r.physicalResourceId === resourceId ||
            r.physicalResourceId === resourceArn ||
            r.physicalResourceId.includes(resourceId)
        );

        if (match) {
          return stack.stackName;
        }
      }

      return null;
    } catch (error) {
      throw this.handleStackError(error, 'findStackForResource');
    }
  }

  /**
   * Detect drift for a specific stack
   *
   * Initiates drift detection and returns full drift report including
   * per-resource drift details.
   *
   * @example
   * ```typescript
   * const driftResult = await inventory.detectDrift({
   *   stackName: 'ChimeraDataStack',
   *   region: 'us-east-1',
   *   waitForCompletion: true
   * });
   *
   * if (driftResult.stackDriftStatus === 'DRIFTED') {
   *   console.log(`${driftResult.driftedResourcesCount} resources drifted`);
   *   driftResult.driftedResources.forEach(r => {
   *     console.log(`  ${r.logicalResourceId}: ${r.driftStatus}`);
   *   });
   * }
   * ```
   *
   * @param options - Drift detection options
   * @returns Drift detection result
   * @throws {DiscoveryError} On detection failure or timeout
   */
  async detectDrift(options: DriftDetectionOptions): Promise<DriftDetectionResult> {
    const {
      stackName,
      region,
      waitForCompletion = true,
      timeoutSeconds = 300,
    } = options;

    try {
      // Implementation would use AWS SDK CloudFormationClient.detectStackDrift
      const detectionId = await this.initiateDriftDetection(stackName, region);

      if (waitForCompletion) {
        await this.waitForDriftDetection(detectionId, region, timeoutSeconds);
      }

      return await this.fetchDriftDetectionResult(detectionId, stackName, region);
    } catch (error) {
      throw this.handleStackError(error, 'detectDrift');
    }
  }

  /**
   * Detect drift for all stacks in all configured regions
   *
   * Runs drift detection in parallel across all stacks. Use sparingly
   * as this is an expensive operation (API rate limits apply).
   *
   * @param filter - Stack filter to limit scope
   * @returns Array of drift results
   */
  async detectDriftForAllStacks(filter?: StackFilter): Promise<DriftDetectionResult[]> {
    const stacks = await this.listStacks(filter);

    // Run drift detection in parallel (with concurrency limit)
    const results: DriftDetectionResult[] = [];
    const concurrency = 5; // Max 5 simultaneous drift detections

    for (let i = 0; i < stacks.length; i += concurrency) {
      const batch = stacks.slice(i, i + concurrency);
      const batchPromises = batch.map((stack) =>
        this.detectDrift({
          stackName: stack.stackName,
          region: this.extractRegionFromStackId(stack.stackId),
          waitForCompletion: true,
        }).catch((error) => {
          // Log error but continue with other stacks
          console.error(`Drift detection failed for ${stack.stackName}:`, error);
          return null;
        })
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter((r): r is DriftDetectionResult => r !== null));
    }

    return results;
  }

  /**
   * Get stack hierarchy (nested stacks)
   *
   * Returns parent and child stacks for a given stack.
   *
   * @param stackName - Stack name
   * @param region - Region
   * @returns Stack hierarchy information
   */
  async getStackHierarchy(
    stackName: string,
    region: AWSRegion
  ): Promise<{
    stack: StackSummary;
    parent: StackSummary | null;
    children: StackSummary[];
  }> {
    try {
      const stack = await this.getStack(stackName, region);

      // Fetch parent stack if exists
      let parent: StackSummary | null = null;
      if (stack.parentStackId) {
        const parentName = this.extractStackNameFromId(stack.parentStackId);
        parent = await this.getStack(parentName, region);
      }

      // Find child stacks (nested stacks)
      const resources = await this.fetchStackResources(stackName, region);
      const nestedStackResources = resources.filter(
        (r) => r.resourceType === 'AWS::CloudFormation::Stack'
      );

      const children: StackSummary[] = [];
      for (const nestedResource of nestedStackResources) {
        const childName = this.extractStackNameFromId(nestedResource.physicalResourceId);
        const child = await this.getStack(childName, region);
        children.push(child);
      }

      return { stack, parent, children };
    } catch (error) {
      throw this.handleStackError(error, 'getStackHierarchy');
    }
  }

  // ========================================================================
  // Private helper methods (implementation stubs for type safety)
  // ========================================================================

  private async listStacksInRegion(
    region: AWSRegion,
    filter?: StackFilter
  ): Promise<StackSummary[]> {
    // Stub: Would call AWS SDK CloudFormationClient.listStacks
    return [];
  }

  private async fetchStackDetails(stackName: string, region: AWSRegion): Promise<StackSummary | null> {
    // Stub: Would call AWS SDK CloudFormationClient.describeStacks
    return null;
  }

  private async fetchStackResources(stackName: string, region: AWSRegion): Promise<StackResource[]> {
    // Stub: Would call AWS SDK CloudFormationClient.listStackResources
    return [];
  }

  private async initiateDriftDetection(stackName: string, region: AWSRegion): Promise<string> {
    // Stub: Would call AWS SDK CloudFormationClient.detectStackDrift
    return 'drift-detection-id';
  }

  private async waitForDriftDetection(
    detectionId: string,
    region: AWSRegion,
    timeoutSeconds: number
  ): Promise<void> {
    // Stub: Would poll AWS SDK CloudFormationClient.describeStackDriftDetectionStatus
  }

  private async fetchDriftDetectionResult(
    detectionId: string,
    stackName: string,
    region: AWSRegion
  ): Promise<DriftDetectionResult> {
    // Stub: Would call AWS SDK CloudFormationClient.describeStackResourceDrifts
    return {
      stackId: `arn:aws:cloudformation:${region}:${this.config.accountId}:stack/${stackName}/id`,
      stackName,
      stackDriftStatus: 'UNKNOWN',
      detectionTime: new Date().toISOString(),
      driftedResourcesCount: 0,
      driftedResources: [],
    };
  }

  private extractResourceIdFromArn(arn: string): string {
    const parts = arn.split(':');
    const resourcePart = parts[parts.length - 1];
    return resourcePart.split('/').pop() ?? resourcePart;
  }

  private extractRegionFromStackId(stackId: string): AWSRegion {
    // Stack ID format: arn:aws:cloudformation:region:account:stack/name/id
    const parts = stackId.split(':');
    return parts[3] as AWSRegion;
  }

  private extractStackNameFromId(stackId: string): string {
    // Stack ID format: arn:aws:cloudformation:region:account:stack/name/id
    const parts = stackId.split('/');
    return parts[1];
  }

  private handleStackError(error: unknown, operation: string): DiscoveryError {
    if (error instanceof DiscoveryError) {
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('AccessDenied') || message.includes('UnauthorizedOperation')) {
      return new DiscoveryError('PERMISSION_DENIED', `CloudFormation ${operation} denied: ${message}`, error);
    }

    if (message.includes('StackNotFoundException') || message.includes('Stack with id') && message.includes('does not exist')) {
      return new DiscoveryError('RESOURCE_NOT_FOUND', `Stack not found: ${message}`, error);
    }

    if (message.includes('ValidationError')) {
      return new DiscoveryError('INVALID_QUERY', `CloudFormation validation error: ${message}`, error);
    }

    if (message.includes('Throttling') || message.includes('Rate exceeded')) {
      return new DiscoveryError('RATE_LIMIT_EXCEEDED', `CloudFormation API rate limit: ${message}`, error);
    }

    return new DiscoveryError('INTERNAL_ERROR', `CloudFormation ${operation} failed: ${message}`, error);
  }
}

/**
 * Create StackInventory instance with default configuration
 *
 * @param accountId - AWS account ID
 * @param regions - Regions to scan (default: ['us-east-1'])
 * @param enableDriftDetection - Enable automatic drift detection (default: false)
 * @returns Configured StackInventory instance
 */
export function createStackInventory(
  accountId: string,
  regions: AWSRegion[] = ['us-east-1'],
  enableDriftDetection = false
): StackInventory {
  return new StackInventory({
    accountId,
    regions,
    enableDriftDetection,
  });
}
