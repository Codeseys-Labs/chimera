/**
 * Shared types for AWS Account Discovery modules
 *
 * This module provides common types used across all 6 discovery services:
 * 1. config-scanner.ts — AWS Config aggregator for resource inventory
 * 2. resource-explorer.ts — Resource Explorer 2 for cross-region search
 * 3. stack-inventory.ts — CloudFormation stack catalog + drift detection
 * 4. cost-analyzer.ts — Cost Explorer spending analysis per tenant
 * 5. tag-organizer.ts — Tag taxonomy enforcement
 * 6. resource-index.ts — Unified in-memory index of account state
 *
 * @see docs/research/aws-account-agent/06-Account-Discovery-Architecture.md
 */

import type { ARN, AWSRegion, ISOTimestamp, PaginatedResponse } from '@chimera/shared';

// Re-export common types for convenience
export type { ARN, AWSRegion, ISOTimestamp, PaginatedResponse } from '@chimera/shared';

/**
 * AWS resource types tracked by the discovery system
 */
export type AWSResourceType =
  // Compute
  | 'AWS::EC2::Instance'
  | 'AWS::Lambda::Function'
  | 'AWS::ECS::Service'
  | 'AWS::ECS::Cluster'
  | 'AWS::ECS::TaskDefinition'
  // Storage
  | 'AWS::S3::Bucket'
  | 'AWS::EFS::FileSystem'
  | 'AWS::DynamoDB::Table'
  | 'AWS::RDS::DBInstance'
  | 'AWS::RDS::DBCluster'
  // Networking
  | 'AWS::EC2::VPC'
  | 'AWS::EC2::Subnet'
  | 'AWS::EC2::SecurityGroup'
  | 'AWS::EC2::InternetGateway'
  | 'AWS::EC2::NatGateway'
  | 'AWS::ElasticLoadBalancingV2::LoadBalancer'
  | 'AWS::ElasticLoadBalancingV2::TargetGroup'
  // IAM & Security
  | 'AWS::IAM::Role'
  | 'AWS::IAM::Policy'
  | 'AWS::IAM::User'
  | 'AWS::KMS::Key'
  | 'AWS::SecretsManager::Secret'
  // API & Integration
  | 'AWS::ApiGateway::RestApi'
  | 'AWS::ApiGatewayV2::Api'
  | 'AWS::EventBridge::EventBus'
  | 'AWS::EventBridge::Rule'
  | 'AWS::SNS::Topic'
  | 'AWS::SQS::Queue'
  | 'AWS::StepFunctions::StateMachine'
  // Observability
  | 'AWS::Logs::LogGroup'
  | 'AWS::CloudWatch::Alarm'
  // IaC
  | 'AWS::CloudFormation::Stack';

/**
 * Resource status as reported by AWS Config
 */
export type ResourceStatus =
  | 'OK' // Resource exists and is configured correctly
  | 'INSUFFICIENT_DATA' // Not enough data to determine status
  | 'NOT_APPLICABLE' // Status check not applicable to this resource
  | 'ResourceDeleted' // Resource has been deleted
  | 'ResourceNotRecorded'; // Resource type not recorded by Config

/**
 * CloudFormation stack status
 */
export type StackStatus =
  | 'CREATE_IN_PROGRESS'
  | 'CREATE_FAILED'
  | 'CREATE_COMPLETE'
  | 'ROLLBACK_IN_PROGRESS'
  | 'ROLLBACK_FAILED'
  | 'ROLLBACK_COMPLETE'
  | 'DELETE_IN_PROGRESS'
  | 'DELETE_FAILED'
  | 'DELETE_COMPLETE'
  | 'UPDATE_IN_PROGRESS'
  | 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS'
  | 'UPDATE_COMPLETE'
  | 'UPDATE_FAILED'
  | 'UPDATE_ROLLBACK_IN_PROGRESS'
  | 'UPDATE_ROLLBACK_FAILED'
  | 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS'
  | 'UPDATE_ROLLBACK_COMPLETE'
  | 'REVIEW_IN_PROGRESS'
  | 'IMPORT_IN_PROGRESS'
  | 'IMPORT_COMPLETE'
  | 'IMPORT_ROLLBACK_IN_PROGRESS'
  | 'IMPORT_ROLLBACK_FAILED'
  | 'IMPORT_ROLLBACK_COMPLETE';

/**
 * Drift detection status for CloudFormation stacks
 */
export type DriftStatus =
  | 'DRIFTED' // Stack has drifted from template
  | 'IN_SYNC' // Stack matches template
  | 'UNKNOWN' // Drift detection not run or failed
  | 'NOT_CHECKED'; // Drift detection not yet performed

/**
 * Resource drift status for individual resources within a stack
 */
export type ResourceDriftStatus =
  | 'IN_SYNC' // Resource matches template
  | 'MODIFIED' // Resource has been modified outside CloudFormation
  | 'DELETED' // Resource has been deleted
  | 'NOT_CHECKED'; // Drift detection not performed

/**
 * Tag key-value pair for AWS resources
 */
export interface ResourceTag {
  readonly key: string;
  readonly value: string;
}

/**
 * Resource relationship type
 */
export type RelationshipType =
  | 'Is associated with'
  | 'Is accessed by'
  | 'Is attached to'
  | 'Is contained in'
  | 'Contains'
  | 'Depends on';

/**
 * Resource relationship mapping
 */
export interface ResourceRelationship {
  readonly resourceType: AWSResourceType;
  readonly resourceId: string;
  readonly resourceArn?: ARN;
  readonly relationshipType: RelationshipType;
}

/**
 * Core resource metadata tracked across all discovery services
 */
export interface ResourceMetadata {
  readonly arn: ARN;
  readonly resourceType: AWSResourceType;
  readonly resourceId: string;
  readonly region: AWSRegion;
  readonly accountId: string;
  readonly status: ResourceStatus;
  readonly tags: ResourceTag[];
  readonly createdAt?: ISOTimestamp;
  readonly lastUpdatedAt: ISOTimestamp;
  readonly relationships?: ResourceRelationship[];
}

/**
 * AWS Config configuration item (simplified)
 */
export interface ConfigurationItem {
  readonly configurationItemCaptureTime: ISOTimestamp;
  readonly resourceType: AWSResourceType;
  readonly resourceId: string;
  readonly arn: ARN;
  readonly region: AWSRegion;
  readonly availabilityZone?: string;
  readonly configurationItemStatus: ResourceStatus;
  readonly configuration: Record<string, unknown>; // Full resource config as JSON
  readonly relationships?: ResourceRelationship[];
  readonly tags?: ResourceTag[];
  readonly configurationStateId?: string;
}

/**
 * AWS Config aggregator query result
 */
export interface ConfigQueryResult {
  readonly resourceType: AWSResourceType;
  readonly resourceId: string;
  readonly resourceName?: string;
  readonly arn: ARN;
  readonly region: AWSRegion;
  readonly configuration: Record<string, unknown>;
  readonly tags?: ResourceTag[];
}

/**
 * Resource Explorer search result
 */
export interface ExplorerResource {
  readonly arn: ARN;
  readonly resourceType: string; // May include custom resource types not in AWSResourceType
  readonly region: AWSRegion;
  readonly service: string;
  readonly lastReportedAt: ISOTimestamp;
  readonly properties?: Array<{ name: string; data: unknown }>;
  readonly owningAccountId: string;
}

/**
 * CloudFormation stack summary
 */
export interface StackSummary {
  readonly stackId: string;
  readonly stackName: string;
  readonly stackStatus: StackStatus;
  readonly creationTime: ISOTimestamp;
  readonly lastUpdatedTime?: ISOTimestamp;
  readonly deletionTime?: ISOTimestamp;
  readonly templateDescription?: string;
  readonly driftStatus?: DriftStatus;
  readonly driftLastCheckTime?: ISOTimestamp;
  readonly parentStackId?: string;
  readonly rootStackId?: string;
}

/**
 * CloudFormation stack resource
 */
export interface StackResource {
  readonly logicalResourceId: string;
  readonly physicalResourceId: string;
  readonly resourceType: AWSResourceType;
  readonly resourceStatus: string;
  readonly timestamp: ISOTimestamp;
  readonly stackId: string;
  readonly stackName: string;
  readonly driftStatus?: ResourceDriftStatus;
}

/**
 * CloudFormation drift detection result
 */
export interface DriftDetectionResult {
  readonly stackId: string;
  readonly stackName: string;
  readonly stackDriftStatus: DriftStatus;
  readonly detectionTime: ISOTimestamp;
  readonly driftedResourcesCount: number;
  readonly driftedResources: Array<{
    readonly logicalResourceId: string;
    readonly physicalResourceId: string;
    readonly resourceType: AWSResourceType;
    readonly driftStatus: ResourceDriftStatus;
    readonly expectedProperties?: Record<string, unknown>;
    readonly actualProperties?: Record<string, unknown>;
    readonly propertyDifferences?: Array<{
      readonly propertyPath: string;
      readonly expectedValue: unknown;
      readonly actualValue: unknown;
      readonly differenceType: 'ADD' | 'REMOVE' | 'NOT_EQUAL';
    }>;
  }>;
}

/**
 * Query filter for resource searches
 */
export interface ResourceFilter {
  readonly resourceTypes?: AWSResourceType[];
  readonly regions?: AWSRegion[];
  readonly tags?: Array<{ key: string; value?: string }>;
  readonly statuses?: ResourceStatus[];
  readonly createdAfter?: ISOTimestamp;
  readonly createdBefore?: ISOTimestamp;
  readonly updatedAfter?: ISOTimestamp;
  readonly updatedBefore?: ISOTimestamp;
}

/**
 * Discovery service query options
 */
export interface DiscoveryQueryOptions {
  readonly filter?: ResourceFilter;
  readonly limit?: number;
  readonly nextToken?: string;
  readonly includeRelationships?: boolean;
  readonly includeConfiguration?: boolean;
}

/**
 * Unified resource inventory entry (for resource-index.ts)
 */
export interface ResourceInventoryEntry extends ResourceMetadata {
  // Provenance
  readonly cloudFormationStack?: string;
  readonly managedBy?: 'cloudformation' | 'terraform' | 'cdk' | 'console' | 'unknown';
  readonly createdBy?: string; // IAM principal ARN

  // Cost tracking (populated by cost-analyzer)
  readonly weeklyCost?: number;
  readonly dailyCostAvg?: number;
  readonly costCurrency?: string;

  // Compliance (populated by Config rules)
  readonly compliant?: boolean;
  readonly lastComplianceCheck?: ISOTimestamp;
  readonly complianceRules?: string[];

  // Full configuration (optional, can be large)
  readonly configuration?: Record<string, unknown>;
}

/**
 * Paginated resource query result
 */
export type ResourceQueryResult = PaginatedResponse<ResourceInventoryEntry>;

/**
 * Discovery service error types
 */
export type DiscoveryErrorCode =
  | 'SERVICE_UNAVAILABLE' // AWS service unavailable
  | 'PERMISSION_DENIED' // IAM permissions insufficient
  | 'RESOURCE_NOT_FOUND' // Resource does not exist
  | 'REGION_NOT_ENABLED' // Region not enabled in account
  | 'INVALID_QUERY' // Query syntax error
  | 'AGGREGATOR_NOT_FOUND' // Config aggregator not configured
  | 'INDEX_NOT_FOUND' // Resource Explorer index not found
  | 'RATE_LIMIT_EXCEEDED' // AWS API rate limit exceeded
  | 'INTERNAL_ERROR'; // Unexpected error

/**
 * Discovery service error
 */
export class DiscoveryError extends Error {
  constructor(
    public readonly code: DiscoveryErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}
