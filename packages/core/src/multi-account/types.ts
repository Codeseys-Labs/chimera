/**
 * Multi-account management types for AWS Chimera
 *
 * Supports AWS Organizations integration, cross-account IAM roles,
 * and consolidated resource discovery across sub-accounts.
 *
 * Reference: docs/research/aws-account-agent/06-Multi-Region-Operations.md
 */

import type { ARN, AWSRegion, ISOTimestamp, PaginatedResponse } from '@chimera/shared';
import type { AWSToolContext, AWSToolResult } from '../aws-tools/types';

/**
 * AWS account status
 */
export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_CLOSURE';

/**
 * AWS Organizations organizational unit
 */
export interface OrganizationalUnit {
  /** OU identifier */
  id: string;

  /** OU ARN */
  arn: ARN;

  /** OU name */
  name: string;

  /** Parent OU ID (undefined for root) */
  parentId?: string;
}

/**
 * AWS account in an organization
 */
export interface AWSAccount {
  /** AWS account ID (12-digit) */
  id: string;

  /** Account ARN */
  arn: ARN;

  /** Account name */
  name: string;

  /** Account email */
  email: string;

  /** Account status */
  status: AccountStatus;

  /** Organizational unit ID */
  organizationalUnitId?: string;

  /** Account creation timestamp */
  joinedTimestamp: ISOTimestamp;

  /** Tags applied to account */
  tags?: Record<string, string>;
}

/**
 * Cross-account IAM role configuration
 */
export interface CrossAccountRole {
  /** Target account ID */
  accountId: string;

  /** IAM role name */
  roleName: string;

  /** IAM role ARN */
  roleArn: ARN;

  /** External ID for security (required for cross-account) */
  externalId: string;

  /** Session duration in seconds (default: 3600, max: 43200) */
  sessionDuration?: number;

  /** Regions this role is authorized for */
  allowedRegions?: AWSRegion[];
}

/**
 * Cross-account credentials (from STS AssumeRole)
 */
export interface CrossAccountCredentials {
  /** AWS access key ID */
  accessKeyId: string;

  /** AWS secret access key */
  secretAccessKey: string;

  /** Session token */
  sessionToken: string;

  /** Credential expiration */
  expiration: Date;

  /** Account ID these credentials are for */
  accountId: string;

  /** Role ARN that was assumed */
  roleArn: ARN;
}

/**
 * Service Control Policy (SCP)
 */
export interface ServiceControlPolicy {
  /** SCP ID */
  id: string;

  /** SCP ARN */
  arn: ARN;

  /** SCP name */
  name: string;

  /** Policy description */
  description?: string;

  /** Policy content (JSON string) */
  content: string;

  /** Whether policy is attached to root/OUs/accounts */
  awsManaged: boolean;

  /** Targets this policy is attached to */
  attachedTargets?: string[];
}

/**
 * AWS Organizations structure
 */
export interface OrganizationStructure {
  /** Organization ID */
  organizationId: string;

  /** Organization ARN */
  organizationArn: ARN;

  /** Master account ID */
  masterAccountId: string;

  /** Root organizational unit */
  root: OrganizationalUnit;

  /** All OUs in organization */
  organizationalUnits: OrganizationalUnit[];

  /** All accounts in organization */
  accounts: AWSAccount[];

  /** Enabled policy types */
  enabledPolicyTypes: string[];
}

/**
 * Context for multi-account operations
 * Extends AWSToolContext with account-specific info
 */
export interface MultiAccountContext extends AWSToolContext {
  /** Target account ID (for cross-account operations) */
  targetAccountId?: string;

  /** External ID for cross-account role assumption */
  externalId?: string;

  /** Cross-account role name */
  crossAccountRole?: string;
}

/**
 * Result of account discovery operation
 */
export interface AccountDiscoveryResult {
  /** Discovered accounts */
  accounts: AWSAccount[];

  /** Organizational structure */
  organizationStructure: OrganizationStructure;

  /** Discovery timestamp */
  timestamp: ISOTimestamp;

  /** Discovery duration in milliseconds */
  durationMs: number;
}

/**
 * Parameters for listing accounts
 */
export interface ListAccountsParams {
  /** Filter by organizational unit ID */
  organizationalUnitId?: string;

  /** Filter by account status */
  status?: AccountStatus;

  /** Maximum results per page */
  limit?: number;

  /** Pagination token */
  nextToken?: string;
}

/**
 * Parameters for creating a new account
 */
export interface CreateAccountParams {
  /** Account name */
  accountName: string;

  /** Account email (must be unique) */
  email: string;

  /** IAM user name for account root (optional) */
  iamUserAccessToBilling?: 'ALLOW' | 'DENY';

  /** IAM role name to create in new account (optional) */
  roleName?: string;

  /** Target organizational unit ID (optional) */
  organizationalUnitId?: string;

  /** Tags to apply to account */
  tags?: Record<string, string>;
}

/**
 * Status of account creation request
 */
export type CreateAccountStatus =
  | 'IN_PROGRESS'
  | 'SUCCEEDED'
  | 'FAILED';

/**
 * Account creation request status
 */
export interface CreateAccountRequest {
  /** Request ID */
  id: string;

  /** Request state */
  state: CreateAccountStatus;

  /** Created account ID (if succeeded) */
  accountId?: string;

  /** Account name from request */
  accountName: string;

  /** Request timestamp */
  requestedTimestamp: ISOTimestamp;

  /** Completion timestamp (if finished) */
  completedTimestamp?: ISOTimestamp;

  /** Failure reason (if failed) */
  failureReason?: string;
}

/**
 * Cost allocation by account
 */
export interface AccountCostAllocation {
  /** Account ID */
  accountId: string;

  /** Account name */
  accountName: string;

  /** Total cost in USD */
  totalCost: number;

  /** Cost breakdown by service */
  costByService: Record<string, number>;

  /** Time period */
  startDate: string;
  endDate: string;
}

/**
 * Parameters for querying multi-account costs
 */
export interface MultiAccountCostParams {
  /** Start date (YYYY-MM-DD) */
  startDate: string;

  /** End date (YYYY-MM-DD) */
  endDate: string;

  /** Filter by specific account IDs */
  accountIds?: string[];

  /** Granularity (DAILY, MONTHLY) */
  granularity?: 'DAILY' | 'MONTHLY';

  /** Group by dimension */
  groupBy?: 'ACCOUNT' | 'SERVICE' | 'REGION';
}

/**
 * Multi-account resource summary
 */
export interface MultiAccountResourceSummary {
  /** Total resources across all accounts */
  totalResources: number;

  /** Resources by account */
  resourcesByAccount: Record<string, number>;

  /** Resources by type */
  resourcesByType: Record<string, number>;

  /** Summary timestamp */
  timestamp: ISOTimestamp;
}

/**
 * Parameters for cross-account resource discovery
 */
export interface CrossAccountDiscoveryParams {
  /** Account IDs to discover resources in */
  accountIds: string[];

  /** AWS regions to scan */
  regions: AWSRegion[];

  /** Resource types to discover (optional, defaults to all) */
  resourceTypes?: string[];

  /** Whether to include compliance status */
  includeCompliance?: boolean;
}

/**
 * Export tool result types for multi-account operations
 */
export type ListAccountsResult = AWSToolResult<PaginatedResponse<AWSAccount>>;
export type GetAccountResult = AWSToolResult<AWSAccount>;
export type CreateAccountResult = AWSToolResult<CreateAccountRequest>;
export type GetOrganizationResult = AWSToolResult<OrganizationStructure>;
export type ListOrganizationalUnitsResult = AWSToolResult<PaginatedResponse<OrganizationalUnit>>;
export type AssumeRoleResult = AWSToolResult<CrossAccountCredentials>;
export type GetAccountCostsResult = AWSToolResult<AccountCostAllocation[]>;
export type DiscoverResourcesResult = AWSToolResult<MultiAccountResourceSummary>;
