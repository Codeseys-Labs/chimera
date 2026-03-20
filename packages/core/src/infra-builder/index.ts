/**
 * Infrastructure-as-Capability Agent Tools
 *
 * Enables agents to build AWS infrastructure from natural language:
 * - CodeCommit workspaces for agent-generated IaC
 * - CodePipeline deployment with approval gates
 * - Cedar policies scoping what agents can provision
 * - Drift detection for planned vs actual state
 *
 * @module @chimera/core/infra-builder
 * @see docs/research/validation/03-infra-workspace-deploy.md
 */

// Core managers
export { CodeCommitWorkspaceManager } from './codecommit-workspace';
export { CodePipelineDeployer } from './codepipeline-deployer';
export { CDKGenerator, createCDKGenerator } from './cdk-generator';
export { CedarProvisioningPolicies, createCedarProvisioningPolicies } from './cedar-provisioning';
export { InfrastructureDriftDetector, createDriftDetector } from './drift-detector';

// Type exports
export type {
  // Workspace types
  InfraWorkspace,
  WorkspaceStatus,
  RepositoryConfig,
  CommitMetadata,
  FileCommit,

  // Pipeline types
  PipelineConfig,
  PipelineExecution,
  PipelineStatus,
  StageExecution,
  StageStatus,
  ActionExecution,
  ApprovalAction,
  ApprovalStatus,

  // CloudFormation types
  ChangeSetSummary,
  ResourceChange,
  ChangeType,
  DriftDetection,

  // Policy types
  CedarInfraPolicy,

  // Common types
  InfraOperationResult,
  AWSToolContext,
  ARN,
  AWSRegion,
  ISOTimestamp,
} from './types';

// CDK Generator types
export type {
  CDKGenerationRequest,
  CDKGenerationResult,
  L3ConstructRequest,
} from './cdk-generator';

// Cedar Provisioning types
export type {
  CedarProvisioningContext,
  CedarProvisioningResult,
  TenantTierConfig,
} from './cedar-provisioning';

// Drift Detector types
export type {
  DriftDetectionRequest,
  DriftDetectionResult,
  DriftedResource,
  PropertyDifference,
  DriftRemediationAction,
} from './drift-detector';
