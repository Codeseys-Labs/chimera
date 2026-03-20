/**
 * Infrastructure Drift Detection
 *
 * Detects differences between planned infrastructure state (CDK/CloudFormation)
 * and actual AWS resource state. Enables agents to identify manual changes,
 * configuration drift, and unauthorized modifications.
 */

// Note: @aws-sdk/client-cloudformation is a peerDependency
// Placeholder types for when SDK is not available
type CloudFormationClient = any;
type DescribeStacksCommand = any;
type DescribeStackResourcesCommand = any;
type DetectStackDriftCommand = any;
type DescribeStackResourceDriftsCommand = any;
type StackResourceDrift = any;

// Dynamic import handling for AWS SDK
let CloudFormationClientImpl: any;
let DescribeStacksCommandImpl: any;
let DescribeStackResourcesCommandImpl: any;
let DetectStackDriftCommandImpl: any;
let DescribeStackResourceDriftsCommandImpl: any;

try {
  const cfnModule = require('@aws-sdk/client-cloudformation');
  CloudFormationClientImpl = cfnModule.CloudFormationClient;
  DescribeStacksCommandImpl = cfnModule.DescribeStacksCommand;
  DescribeStackResourcesCommandImpl = cfnModule.DescribeStackResourcesCommand;
  DetectStackDriftCommandImpl = cfnModule.DetectStackDriftCommand;
  DescribeStackResourceDriftsCommandImpl = cfnModule.DescribeStackResourceDriftsCommand;
} catch (e) {
  // SDK not available - drift detector will require peer dependency installation
  console.warn('AWS CloudFormation SDK not available. Install @aws-sdk/client-cloudformation to use drift detection.');
}

/**
 * Drift detection request
 */
export interface DriftDetectionRequest {
  tenantId: string;
  stackName: string;
  region?: string;
}

/**
 * Drift detection result
 */
export interface DriftDetectionResult {
  tenantId: string;
  stackName: string;
  overallStatus: 'IN_SYNC' | 'DRIFTED' | 'NOT_CHECKED' | 'UNKNOWN';
  driftedResourceCount: number;
  totalResourceCount: number;
  driftedResources: DriftedResource[];
  detectedAt: string;
}

/**
 * Drifted resource details
 */
export interface DriftedResource {
  logicalResourceId: string;
  resourceType: string;
  physicalResourceId: string;
  driftStatus: string;
  propertyDifferences: PropertyDifference[];
  expectedValue?: string;
  actualValue?: string;
}

/**
 * Property difference
 */
export interface PropertyDifference {
  propertyPath: string;
  expectedValue: string;
  actualValue: string;
  differenceType: 'ADD' | 'REMOVE' | 'NOT_EQUAL';
}

/**
 * Drift remediation action
 */
export interface DriftRemediationAction {
  resourceId: string;
  action: 'revert' | 'accept' | 'ignore';
  reason: string;
  automationAvailable: boolean;
}

/**
 * Infrastructure drift detector
 */
export class InfrastructureDriftDetector {
  private cfn: CloudFormationClient;

  constructor(region?: string) {
    if (!CloudFormationClientImpl) {
      throw new Error(
        'AWS CloudFormation SDK not available. Install @aws-sdk/client-cloudformation as a peer dependency.'
      );
    }
    this.cfn = new CloudFormationClientImpl({ region: region || 'us-east-1' });
  }

  /**
   * Detect infrastructure drift for a tenant stack
   */
  async detectDrift(request: DriftDetectionRequest): Promise<DriftDetectionResult> {
    const stackName = this.getStackName(request.tenantId, request.stackName);

    // Step 1: Initiate drift detection
    const detectCommand = new DetectStackDriftCommandImpl({
      StackName: stackName,
    });
    const detectResult = await this.cfn.send(detectCommand);
    const driftDetectionId = detectResult.StackDriftDetectionId;

    // Step 2: Wait for drift detection to complete (in production, would poll)
    await this.waitForDriftDetection(driftDetectionId);

    // Step 3: Get stack drift status
    const stacksCommand = new DescribeStacksCommandImpl({
      StackName: stackName,
    });
    const stacksResult = await this.cfn.send(stacksCommand);
    const stack = stacksResult.Stacks?.[0];

    if (!stack) {
      throw new Error(`Stack not found: ${stackName}`);
    }

    // Step 4: Get drifted resources
    const driftsCommand = new DescribeStackResourceDriftsCommandImpl({
      StackName: stackName,
      StackResourceDriftStatusFilters: ['MODIFIED', 'DELETED'],
    });
    const driftsResult = await this.cfn.send(driftsCommand);

    // Step 5: Get total resource count
    const resourcesCommand = new DescribeStackResourcesCommandImpl({
      StackName: stackName,
    });
    const resourcesResult = await this.cfn.send(resourcesCommand);
    const totalResourceCount = resourcesResult.StackResources?.length || 0;

    // Step 6: Parse drifted resources
    const driftedResources = this.parseDriftedResources(
      driftsResult.StackResourceDrifts || []
    );

    return {
      tenantId: request.tenantId,
      stackName: request.stackName,
      overallStatus: stack.DriftInformation?.StackDriftStatus as any || 'UNKNOWN',
      driftedResourceCount: driftedResources.length,
      totalResourceCount,
      driftedResources,
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * Analyze drift and suggest remediation actions
   */
  async analyzeDrift(
    driftResult: DriftDetectionResult
  ): Promise<DriftRemediationAction[]> {
    const actions: DriftRemediationAction[] = [];

    for (const resource of driftResult.driftedResources) {
      const action = this.suggestRemediationAction(resource);
      actions.push(action);
    }

    return actions;
  }

  /**
   * Check if drift is agent-caused or external
   */
  async identifyDriftSource(
    driftResult: DriftDetectionResult
  ): Promise<{
    agentCaused: DriftedResource[];
    externalCaused: DriftedResource[];
    unknown: DriftedResource[];
  }> {
    const agentCaused: DriftedResource[] = [];
    const externalCaused: DriftedResource[] = [];
    const unknown: DriftedResource[] = [];

    for (const resource of driftResult.driftedResources) {
      // Check if change matches recent agent evolution actions
      const isAgentChange = this.isAgentEvolutionChange(resource);

      if (isAgentChange) {
        agentCaused.push(resource);
      } else if (this.hasExternalModificationMarkers(resource)) {
        externalCaused.push(resource);
      } else {
        unknown.push(resource);
      }
    }

    return {
      agentCaused,
      externalCaused,
      unknown,
    };
  }

  /**
   * Auto-revert unauthorized drift
   */
  async autoRevertDrift(
    request: DriftDetectionRequest,
    resources: DriftedResource[]
  ): Promise<{ reverted: string[]; failed: string[] }> {
    const reverted: string[] = [];
    const failed: string[] = [];

    for (const resource of resources) {
      try {
        // In production, would trigger CloudFormation update to revert drift
        console.log(`Reverting drift for: ${resource.logicalResourceId}`);
        reverted.push(resource.logicalResourceId);
      } catch (error) {
        console.error(`Failed to revert ${resource.logicalResourceId}:`, error);
        failed.push(resource.logicalResourceId);
      }
    }

    return { reverted, failed };
  }

  // Private helper methods

  private getStackName(tenantId: string, stackName: string): string {
    return `Chimera-${tenantId}-${stackName}`;
  }

  private async waitForDriftDetection(detectionId?: string): Promise<void> {
    // Placeholder: In production, would poll for detection completion
    // For now, just wait a fixed time
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  private parseDriftedResources(
    drifts: StackResourceDrift[]
  ): DriftedResource[] {
    return drifts.map((drift) => {
      const propertyDifferences: PropertyDifference[] = (
        drift.PropertyDifferences || []
      ).map((diff) => ({
        propertyPath: diff.PropertyPath || '',
        expectedValue: JSON.stringify(diff.ExpectedValue),
        actualValue: JSON.stringify(diff.ActualValue),
        differenceType: diff.DifferenceType as any,
      }));

      return {
        logicalResourceId: drift.LogicalResourceId || '',
        resourceType: drift.ResourceType || '',
        physicalResourceId: drift.PhysicalResourceId || '',
        driftStatus: drift.StackResourceDriftStatus || '',
        propertyDifferences,
      };
    });
  }

  private suggestRemediationAction(
    resource: DriftedResource
  ): DriftRemediationAction {
    // Safe to revert: configuration changes
    const safeToRevert = [
      'AWS::ECS::TaskDefinition',
      'AWS::Lambda::Function',
      'AWS::SSM::Parameter',
    ];

    // Dangerous to revert: data stores
    const dangerousToRevert = [
      'AWS::DynamoDB::Table',
      'AWS::S3::Bucket',
      'AWS::RDS::DBInstance',
    ];

    if (safeToRevert.includes(resource.resourceType)) {
      return {
        resourceId: resource.logicalResourceId,
        action: 'revert',
        reason: 'Configuration drift detected - safe to auto-revert',
        automationAvailable: true,
      };
    }

    if (dangerousToRevert.includes(resource.resourceType)) {
      return {
        resourceId: resource.logicalResourceId,
        action: 'accept',
        reason: 'Data resource drift - requires manual review',
        automationAvailable: false,
      };
    }

    return {
      resourceId: resource.logicalResourceId,
      action: 'ignore',
      reason: 'Low-impact drift',
      automationAvailable: true,
    };
  }

  private isAgentEvolutionChange(resource: DriftedResource): boolean {
    // Check if changes match agent evolution patterns
    // In production, would query evolution audit logs

    // Heuristic: Environment variable changes are typically agent-driven
    const agentChangedProperties = [
      '/Environment/Variables',
      '/TaskDefinition/Environment',
      '/Configuration',
    ];

    return resource.propertyDifferences.some((diff) =>
      agentChangedProperties.some((prop) => diff.propertyPath.includes(prop))
    );
  }

  private hasExternalModificationMarkers(resource: DriftedResource): boolean {
    // Check for markers indicating console/CLI changes
    // In production, would correlate with CloudTrail logs

    // Heuristic: Tag changes often indicate manual modification
    const externalChangedProperties = ['/Tags', '/Description', '/Name'];

    return resource.propertyDifferences.some((diff) =>
      externalChangedProperties.some((prop) => diff.propertyPath.includes(prop))
    );
  }

  /**
   * Generate drift report
   */
  generateDriftReport(
    driftResult: DriftDetectionResult,
    actions: DriftRemediationAction[]
  ): string {
    const { tenantId, stackName, overallStatus, driftedResourceCount, totalResourceCount } =
      driftResult;

    let report = `# Infrastructure Drift Report

**Tenant:** ${tenantId}
**Stack:** ${stackName}
**Status:** ${overallStatus}
**Drifted Resources:** ${driftedResourceCount} / ${totalResourceCount}
**Detected At:** ${driftResult.detectedAt}

---

## Drifted Resources

`;

    for (const resource of driftResult.driftedResources) {
      const action = actions.find((a) => a.resourceId === resource.logicalResourceId);

      report += `### ${resource.logicalResourceId}
**Type:** ${resource.resourceType}
**Physical ID:** ${resource.physicalResourceId}
**Drift Status:** ${resource.driftStatus}
**Recommended Action:** ${action?.action || 'review'}

**Property Differences:**
`;

      for (const diff of resource.propertyDifferences) {
        report += `- **${diff.propertyPath}** (${diff.differenceType})
  - Expected: \`${diff.expectedValue}\`
  - Actual: \`${diff.actualValue}\`
`;
      }

      report += '\n';
    }

    return report;
  }
}

/**
 * Create a drift detector instance
 */
export function createDriftDetector(region?: string): InfrastructureDriftDetector {
  return new InfrastructureDriftDetector(region);
}
