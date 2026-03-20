/**
 * Types for Infrastructure-as-Capability agent tools
 *
 * Enables agents to build AWS infrastructure from natural language:
 * - CodeCommit workspaces for agent-generated IaC
 * - CodePipeline deployment with approval gates
 * - Cedar policies scoping what agents can provision
 * - Drift detection for planned vs actual state
 *
 * @see docs/research/validation/03-infra-workspace-deploy.md
 */

import type { ARN, AWSRegion, ISOTimestamp } from '@chimera/shared';
import type { AWSToolContext } from '../aws-tools/types';

// Re-export for convenience
export type { ARN, AWSRegion, ISOTimestamp } from '@chimera/shared';
export type { AWSToolContext } from '../aws-tools/types';

/**
 * Infrastructure workspace status
 */
export type WorkspaceStatus =
  | 'INITIALIZING' // Repository being created
  | 'READY' // Workspace ready for commits
  | 'DEPLOYING' // Pipeline executing
  | 'DEPLOYED' // Infrastructure provisioned
  | 'DRIFT_DETECTED' // Deployed resources differ from code
  | 'ERROR' // Workspace or deployment failed
  | 'ARCHIVED'; // Workspace decommissioned

/**
 * Pipeline execution status
 */
export type PipelineStatus =
  | 'InProgress' // Pipeline executing
  | 'Stopped' // Pipeline manually stopped
  | 'Stopping' // Pipeline stopping
  | 'Succeeded' // Pipeline completed successfully
  | 'Superseded' // Newer execution started
  | 'Failed'; // Pipeline failed

/**
 * Pipeline stage status
 */
export type StageStatus =
  | 'InProgress'
  | 'Stopped'
  | 'Stopping'
  | 'Succeeded'
  | 'Failed';

/**
 * Pipeline approval status
 */
export type ApprovalStatus =
  | 'Pending' // Awaiting approval
  | 'Approved' // Approved by authorized user
  | 'Rejected' // Rejected, pipeline stopped
  | 'TimedOut'; // No response within deadline

/**
 * Infrastructure change type
 */
export type ChangeType = 'Create' | 'Update' | 'Delete' | 'Import' | 'None';

/**
 * Agent-generated IaC workspace in CodeCommit
 */
export interface InfraWorkspace {
  /** Workspace identifier (tenant-scoped) */
  readonly workspaceId: string;

  /** Tenant identifier */
  readonly tenantId: string;

  /** Agent that owns this workspace */
  readonly agentId: string;

  /** CodeCommit repository ARN */
  readonly repositoryArn: ARN;

  /** Repository name */
  readonly repositoryName: string;

  /** Default branch (typically 'main') */
  readonly defaultBranch: string;

  /** Repository clone URL (HTTPS) */
  readonly cloneUrl: string;

  /** Current workspace status */
  readonly status: WorkspaceStatus;

  /** Workspace creation timestamp */
  readonly createdAt: ISOTimestamp;

  /** Last commit timestamp */
  readonly lastCommitAt?: ISOTimestamp;

  /** Last deployment timestamp */
  readonly lastDeployedAt?: ISOTimestamp;

  /** Associated CodePipeline ARN (if deployed) */
  readonly pipelineArn?: ARN;

  /** Current drift status */
  readonly driftDetected?: boolean;

  /** Cedar policy ARN governing allowed resources */
  readonly policyArn?: ARN;
}

/**
 * CodeCommit repository configuration
 */
export interface RepositoryConfig {
  /** Repository name (must be unique within account) */
  readonly repositoryName: string;

  /** Repository description */
  readonly description?: string;

  /** Default branch name */
  readonly defaultBranch?: string;

  /** Repository tags */
  readonly tags?: Record<string, string>;

  /** KMS key ARN for encryption at rest */
  readonly kmsKeyArn?: ARN;
}

/**
 * CodeCommit commit metadata
 */
export interface CommitMetadata {
  /** Commit ID (SHA-1 hash) */
  readonly commitId: string;

  /** Commit message */
  readonly message: string;

  /** Author name */
  readonly authorName: string;

  /** Author email */
  readonly authorEmail: string;

  /** Commit timestamp */
  readonly timestamp: ISOTimestamp;

  /** Parent commit ID */
  readonly parentCommitId?: string;

  /** Tree ID */
  readonly treeId: string;
}

/**
 * File to commit to CodeCommit
 */
export interface FileCommit {
  /** File path relative to repository root */
  readonly filePath: string;

  /** File content */
  readonly content: string;

  /** File mode (defaults to '100644' for regular files) */
  readonly fileMode?: '100644' | '100755' | '040000' | '160000' | '120000';
}

/**
 * CodePipeline deployment configuration
 */
export interface PipelineConfig {
  /** Pipeline name (must be unique within account) */
  readonly pipelineName: string;

  /** Source repository ARN */
  readonly repositoryArn: ARN;

  /** Source branch to monitor */
  readonly sourceBranch: string;

  /** IAM role ARN for pipeline execution */
  readonly roleArn: ARN;

  /** S3 bucket ARN for pipeline artifacts */
  readonly artifactBucketArn: ARN;

  /** Enable manual approval before deployment */
  readonly requireApproval?: boolean;

  /** SNS topic ARN for approval notifications */
  readonly approvalTopicArn?: ARN;

  /** Approval timeout in minutes */
  readonly approvalTimeoutMinutes?: number;

  /** CloudFormation stack name to create/update */
  readonly stackName: string;

  /** CloudFormation template path in repository */
  readonly templatePath: string;

  /** CloudFormation capabilities to grant */
  readonly capabilities?: Array<'CAPABILITY_IAM' | 'CAPABILITY_NAMED_IAM' | 'CAPABILITY_AUTO_EXPAND'>;

  /** CloudFormation parameters */
  readonly parameters?: Record<string, string>;

  /** Pipeline tags */
  readonly tags?: Record<string, string>;
}

/**
 * Pipeline execution summary
 */
export interface PipelineExecution {
  /** Pipeline ARN */
  readonly pipelineArn: ARN;

  /** Execution ID */
  readonly executionId: string;

  /** Pipeline name */
  readonly pipelineName: string;

  /** Execution status */
  readonly status: PipelineStatus;

  /** Pipeline version executed */
  readonly pipelineVersion?: number;

  /** Execution start time */
  readonly startTime: ISOTimestamp;

  /** Execution end time (if completed) */
  readonly endTime?: ISOTimestamp;

  /** Source commit ID */
  readonly sourceCommitId?: string;

  /** Source commit message */
  readonly sourceCommitMessage?: string;

  /** Error message (if failed) */
  readonly errorMessage?: string;
}

/**
 * Pipeline stage execution
 */
export interface StageExecution {
  /** Stage name */
  readonly stageName: string;

  /** Stage status */
  readonly status: StageStatus;

  /** Stage start time */
  readonly startTime?: ISOTimestamp;

  /** Stage end time (if completed) */
  readonly endTime?: ISOTimestamp;

  /** Actions in this stage */
  readonly actions: ActionExecution[];
}

/**
 * Pipeline action execution
 */
export interface ActionExecution {
  /** Action name */
  readonly actionName: string;

  /** Action status */
  readonly status: StageStatus;

  /** Action start time */
  readonly startTime?: ISOTimestamp;

  /** Action end time (if completed) */
  readonly endTime?: ISOTimestamp;

  /** External execution ID (e.g., CodeBuild build ID) */
  readonly externalExecutionId?: string;

  /** External execution URL */
  readonly externalExecutionUrl?: string;

  /** Error message (if failed) */
  readonly errorMessage?: string;
}

/**
 * Manual approval action
 */
export interface ApprovalAction {
  /** Approval action name */
  readonly actionName: string;

  /** Pipeline name */
  readonly pipelineName: string;

  /** Stage name containing approval */
  readonly stageName: string;

  /** Approval status */
  readonly status: ApprovalStatus;

  /** Approval token (for API calls) */
  readonly token: string;

  /** Approval summary/reason */
  readonly summary?: string;

  /** SNS topic ARN for notifications */
  readonly topicArn?: ARN;

  /** Approval deadline */
  readonly expiresAt?: ISOTimestamp;

  /** Approved/rejected by (IAM principal) */
  readonly approver?: string;

  /** Approval/rejection timestamp */
  readonly decidedAt?: ISOTimestamp;
}

/**
 * CloudFormation change set summary
 */
export interface ChangeSetSummary {
  /** Change set ID */
  readonly changeSetId: string;

  /** Change set name */
  readonly changeSetName: string;

  /** Stack name */
  readonly stackName: string;

  /** Change set type */
  readonly changeSetType: 'CREATE' | 'UPDATE' | 'IMPORT';

  /** Execution status */
  readonly executionStatus: 'AVAILABLE' | 'EXECUTE_IN_PROGRESS' | 'EXECUTE_COMPLETE' | 'EXECUTE_FAILED' | 'OBSOLETE';

  /** Change set status */
  readonly status: 'CREATE_PENDING' | 'CREATE_IN_PROGRESS' | 'CREATE_COMPLETE' | 'DELETE_PENDING' | 'DELETE_IN_PROGRESS' | 'DELETE_COMPLETE' | 'DELETE_FAILED' | 'FAILED';

  /** Status reason (if failed) */
  readonly statusReason?: string;

  /** Creation timestamp */
  readonly createdAt: ISOTimestamp;

  /** Changes to be applied */
  readonly changes: ResourceChange[];
}

/**
 * CloudFormation resource change
 */
export interface ResourceChange {
  /** Change action */
  readonly action: ChangeType;

  /** Logical resource ID */
  readonly logicalResourceId: string;

  /** Physical resource ID (if exists) */
  readonly physicalResourceId?: string;

  /** Resource type (e.g., 'AWS::S3::Bucket') */
  readonly resourceType: string;

  /** Replacement behavior */
  readonly replacement?: 'True' | 'False' | 'Conditional';

  /** Scope of change */
  readonly scope?: Array<'Properties' | 'Metadata' | 'CreationPolicy' | 'UpdatePolicy' | 'DeletionPolicy' | 'Tags'>;

  /** Property changes */
  readonly details?: Array<{
    readonly target: {
      readonly attribute: string;
      readonly name?: string;
      readonly requiresRecreation?: 'Never' | 'Conditionally' | 'Always';
    };
    readonly evaluation: 'Static' | 'Dynamic';
    readonly changeSource: 'ResourceReference' | 'ParameterReference' | 'ResourceAttribute' | 'DirectModification';
  }>;
}

/**
 * Drift detection result
 */
export interface DriftDetection {
  /** Stack ID */
  readonly stackId: string;

  /** Stack name */
  readonly stackName: string;

  /** Drift status */
  readonly driftStatus: 'DRIFTED' | 'IN_SYNC' | 'UNKNOWN' | 'NOT_CHECKED';

  /** Detection timestamp */
  readonly detectionTime: ISOTimestamp;

  /** Number of drifted resources */
  readonly driftedResourceCount: number;

  /** Drifted resources */
  readonly driftedResources: Array<{
    readonly logicalResourceId: string;
    readonly physicalResourceId: string;
    readonly resourceType: string;
    readonly driftStatus: 'IN_SYNC' | 'MODIFIED' | 'DELETED' | 'NOT_CHECKED';
    readonly propertyDifferences?: Array<{
      readonly propertyPath: string;
      readonly expectedValue: unknown;
      readonly actualValue: unknown;
      readonly differenceType: 'ADD' | 'REMOVE' | 'NOT_EQUAL';
    }>;
  }>;
}

/**
 * Cedar policy configuration for infrastructure provisioning
 */
export interface CedarInfraPolicy {
  /** Policy ID */
  readonly policyId: string;

  /** Tenant ID */
  readonly tenantId: string;

  /** Allowed AWS resource types */
  readonly allowedResourceTypes: string[];

  /** Forbidden resource types (overrides allowed) */
  readonly forbiddenResourceTypes?: string[];

  /** Allowed AWS regions */
  readonly allowedRegions: AWSRegion[];

  /** Maximum resource count limits */
  readonly resourceLimits?: {
    readonly maxInstances?: number;
    readonly maxVolumeSizeGb?: number;
    readonly maxBuckets?: number;
    readonly maxDatabases?: number;
  };

  /** Monthly budget limit (USD) */
  readonly budgetLimit?: number;

  /** Policy version */
  readonly version: number;

  /** Policy effective date */
  readonly effectiveAt: ISOTimestamp;
}

/**
 * Result of infrastructure operation
 */
export interface InfraOperationResult<T = unknown> {
  /** Operation succeeded */
  readonly success: boolean;

  /** Result data */
  readonly data?: T;

  /** Error details */
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };

  /** Operation metadata */
  readonly metadata: {
    readonly requestId?: string;
    readonly region: AWSRegion;
    readonly durationMs: number;
    readonly costEstimate?: number; // USD
  };
}
