/**
 * Shared types for AWS tool layer
 *
 * Defines common patterns for tenant-scoped AWS operations with STS AssumeRole
 *
 * Reference: docs/research/aws-account-agent/02-SDK-Integration-Patterns.md
 */

/**
 * Context for AWS tool invocations
 * All tools receive this context for tenant isolation
 */
export interface AWSToolContext {
  /** Tenant identifier for IAM role assumption */
  tenantId: string;

  /** Agent identifier for audit trail */
  agentId: string;

  /** AWS region (optional, defaults to factory config) */
  region?: string;

  /** Session name override (optional, defaults to agentId-timestamp) */
  sessionName?: string;
}

/**
 * Standard resource tags applied to all agent-created AWS resources
 * Enables cost allocation, auditing, and lifecycle management
 */
export interface AgentResourceTags {
  /** Identifies resource as agent-managed */
  ManagedBy: string; // Format: chimera-agent-${tenantId}

  /** Resource creation timestamp */
  CreatedAt: string; // ISO 8601 format

  /** Agent that created the resource */
  CreatedBy: string; // Format: ${agentId}

  /** Tenant identifier for cost allocation */
  tenantId: string;

  /** Optional billing category */
  billingCategory?: string;
}

/**
 * Temporary credentials from STS AssumeRole
 */
export interface TenantCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

/**
 * Configuration for AWS client factory
 */
export interface AWSClientFactoryConfig {
  /** Default AWS region */
  defaultRegion: string;

  /** AWS account ID */
  accountId: string;

  /** IAM role name pattern (tenant ID will be interpolated) */
  roleNamePattern: string; // e.g., 'tenant-{tenantId}-agent-role'

  /** Permission boundary policy ARN (optional) */
  permissionBoundaryArn?: string;

  /** Credential cache TTL in seconds (default: 3600) */
  credentialCacheTtl?: number;

  /** SDK retry configuration */
  retryConfig?: {
    maxAttempts: number;
    mode: 'standard' | 'adaptive';
  };

  /** Request timeout in milliseconds */
  requestTimeout?: number;
}

/**
 * Result wrapper for AWS tool operations
 */
export interface AWSToolResult<T> {
  /** Indicates success/failure */
  success: boolean;

  /** Result data (if success=true) */
  data?: T;

  /** Error details (if success=false) */
  error?: {
    message: string;
    code?: string;
    retryable: boolean;
  };

  /** Execution metadata */
  metadata: {
    requestId?: string;
    region: string;
    durationMs: number;
  };
}

/**
 * Cached client entry
 */
export interface CachedClient<T> {
  client: T;
  credentials: TenantCredentials;
  createdAt: number;
  expiresAt: number;
}
