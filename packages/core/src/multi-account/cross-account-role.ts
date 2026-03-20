/**
 * Cross-account IAM role assumption with external ID validation
 *
 * Provides secure credential chaining for multi-account operations:
 * - Tenant credentials (from main account) → Cross-account role (in sub-account)
 * - External ID validation prevents confused deputy attacks
 * - Credential caching with automatic refresh
 *
 * Reference: docs/research/aws-account-agent/05-IAM-Scoping-Least-Privilege.md
 */

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type {
  CrossAccountRole,
  CrossAccountCredentials,
  AssumeRoleResult,
  MultiAccountContext,
} from './types';
import type { TenantCredentials } from '../aws-tools/types';

/**
 * Configuration for cross-account role assumption
 */
export interface CrossAccountRoleManagerConfig {
  /** Default region for STS calls */
  defaultRegion?: string;

  /** Credential cache TTL in seconds (default: 3600) */
  credentialCacheTtl?: number;

  /** Max retry attempts */
  maxAttempts?: number;

  /** Request timeout in milliseconds */
  requestTimeout?: number;
}

/**
 * Cached cross-account credentials entry
 */
interface CachedCrossAccountCredentials {
  credentials: CrossAccountCredentials;
  expiresAt: number;
}

/**
 * Manager for cross-account IAM role assumptions
 * Implements credential chaining with external ID validation
 */
export class CrossAccountRoleManager {
  private config: Required<CrossAccountRoleManagerConfig>;
  private credentialCache = new Map<string, CachedCrossAccountCredentials>();

  constructor(config: CrossAccountRoleManagerConfig = {}) {
    this.config = {
      defaultRegion: config.defaultRegion ?? 'us-east-1',
      credentialCacheTtl: config.credentialCacheTtl ?? 3600,
      maxAttempts: config.maxAttempts ?? 3,
      requestTimeout: config.requestTimeout ?? 30000,
    };
  }

  /**
   * Assume a cross-account role using tenant credentials
   *
   * @param tenantCredentials Base credentials from tenant IAM role
   * @param role Cross-account role configuration
   * @param context Multi-account context with tenant/agent info
   * @returns Cross-account credentials with metadata
   */
  async assumeCrossAccountRole(
    tenantCredentials: TenantCredentials,
    role: CrossAccountRole,
    context: MultiAccountContext
  ): Promise<AssumeRoleResult> {
    const startTime = Date.now();

    try {
      // Check cache first
      const cacheKey = this.buildCacheKey(role, context);
      const cached = this.credentialCache.get(cacheKey);

      if (cached && cached.expiresAt > Date.now()) {
        return {
          success: true,
          data: cached.credentials,
          metadata: {
            region: this.config.defaultRegion,
            durationMs: Date.now() - startTime,
          },
        };
      }

      // Validate external ID is present (required for cross-account security)
      if (!role.externalId) {
        throw new Error(
          `External ID is required for cross-account role assumption (account: ${role.accountId})`
        );
      }

      // Validate allowed regions if specified
      if (role.allowedRegions && context.region) {
        if (!role.allowedRegions.includes(context.region)) {
          throw new Error(
            `Region ${context.region} not allowed for role ${role.roleName} in account ${role.accountId}`
          );
        }
      }

      // Create STS client with tenant credentials
      const stsClient = new STSClient({
        region: context.region ?? this.config.defaultRegion,
        credentials: {
          accessKeyId: tenantCredentials.accessKeyId,
          secretAccessKey: tenantCredentials.secretAccessKey,
          sessionToken: tenantCredentials.sessionToken,
        },
        maxAttempts: this.config.maxAttempts,
        requestHandler: {
          requestTimeout: this.config.requestTimeout,
        },
      });

      // Build session name with tenant/agent context
      const sessionName = this.buildSessionName(context);

      // Session duration (min: 900s, max: 43200s, default: 3600s)
      const durationSeconds = this.validateSessionDuration(role.sessionDuration);

      // Assume cross-account role with external ID
      const command = new AssumeRoleCommand({
        RoleArn: role.roleArn,
        RoleSessionName: sessionName,
        ExternalId: role.externalId,
        DurationSeconds: durationSeconds,
        Tags: [
          { Key: 'tenantId', Value: context.tenantId },
          { Key: 'agentId', Value: context.agentId },
          { Key: 'targetAccountId', Value: role.accountId },
          { Key: 'assumedAt', Value: new Date().toISOString() },
        ],
      });

      const response = await stsClient.send(command);

      if (!response.Credentials) {
        throw new Error(
          `Failed to assume cross-account role: no credentials returned (role: ${role.roleArn})`
        );
      }

      // Transform to CrossAccountCredentials
      const credentials: CrossAccountCredentials = {
        accessKeyId: response.Credentials.AccessKeyId!,
        secretAccessKey: response.Credentials.SecretAccessKey!,
        sessionToken: response.Credentials.SessionToken!,
        expiration: response.Credentials.Expiration!,
        accountId: role.accountId,
        roleArn: role.roleArn,
      };

      // Cache credentials
      this.cacheCredentials(cacheKey, credentials);

      return {
        success: true,
        data: credentials,
        metadata: {
          region: context.region ?? this.config.defaultRegion,
          durationMs: Date.now() - startTime,
          requestId: response.$metadata.requestId,
        },
      };
    } catch (error) {
      return this.handleError(error, startTime, context);
    }
  }

  /**
   * Validate and enforce external ID presence
   * Prevents confused deputy attacks in cross-account scenarios
   */
  validateExternalId(role: CrossAccountRole): void {
    if (!role.externalId || role.externalId.length < 16) {
      throw new Error(
        `External ID must be at least 16 characters for security (account: ${role.accountId})`
      );
    }

    // External ID should be unique per account+role combination
    // In production, this would be stored in DynamoDB with the account configuration
  }

  /**
   * Generate a secure external ID for a new cross-account role
   * Format: chimera-{tenantId}-{accountId}-{random}
   */
  generateExternalId(tenantId: string, accountId: string): string {
    const randomPart = this.generateRandomString(16);
    return `chimera-${tenantId}-${accountId}-${randomPart}`;
  }

  /**
   * Build cache key for credentials
   */
  private buildCacheKey(role: CrossAccountRole, context: MultiAccountContext): string {
    return `${context.tenantId}:${context.agentId}:${role.accountId}:${role.roleName}`;
  }

  /**
   * Build session name with tenant/agent context
   * Format: tenant-{tenantId}-agent-{agentId}-{timestamp}
   */
  private buildSessionName(context: MultiAccountContext): string {
    const timestamp = Date.now();
    const tenantShort = context.tenantId.slice(0, 8);
    const agentShort = context.agentId.slice(0, 8);
    return `tenant-${tenantShort}-agent-${agentShort}-${timestamp}`;
  }

  /**
   * Validate session duration (900-43200 seconds)
   */
  private validateSessionDuration(duration?: number): number {
    const defaultDuration = this.config.credentialCacheTtl;
    const requestedDuration = duration ?? defaultDuration;

    if (requestedDuration < 900) {
      console.warn(
        `Session duration ${requestedDuration}s too short, using minimum 900s`
      );
      return 900;
    }

    if (requestedDuration > 43200) {
      console.warn(
        `Session duration ${requestedDuration}s too long, using maximum 43200s`
      );
      return 43200;
    }

    return requestedDuration;
  }

  /**
   * Cache credentials with expiration
   */
  private cacheCredentials(
    cacheKey: string,
    credentials: CrossAccountCredentials
  ): void {
    const expiresAt = credentials.expiration.getTime();
    this.credentialCache.set(cacheKey, {
      credentials,
      expiresAt,
    });
  }

  /**
   * Clear expired credentials from cache
   */
  clearExpiredCache(): number {
    const now = Date.now();
    let cleared = 0;

    Array.from(this.credentialCache.entries()).forEach(([key, value]) => {
      if (value.expiresAt <= now) {
        this.credentialCache.delete(key);
        cleared++;
      }
    });

    return cleared;
  }

  /**
   * Clear all cached credentials
   */
  clearCache(): void {
    this.credentialCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    total: number;
    active: number;
    expired: number;
  } {
    const now = Date.now();
    let active = 0;
    let expired = 0;

    Array.from(this.credentialCache.values()).forEach((value) => {
      if (value.expiresAt > now) {
        active++;
      } else {
        expired++;
      }
    });

    return {
      total: this.credentialCache.size,
      active,
      expired,
    };
  }

  /**
   * Generate cryptographically secure random string
   */
  private generateRandomString(length: number): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const randomBytes =
      typeof crypto !== 'undefined' && crypto.getRandomValues
        ? crypto.getRandomValues(new Uint8Array(length))
        : Buffer.from(
            Array.from({ length }, () =>
              Math.floor(Math.random() * charset.length)
            )
          );

    return Array.from(randomBytes)
      .map((byte) => charset[byte % charset.length])
      .join('');
  }

  /**
   * Handle errors and transform to AWSToolResult format
   */
  private handleError(
    error: unknown,
    startTime: number,
    context: MultiAccountContext
  ): AssumeRoleResult {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode =
      error && typeof error === 'object' && 'name' in error
        ? (error as any).name
        : 'UnknownError';

    // Determine if error is retryable
    const retryableErrors = [
      'ThrottlingException',
      'TooManyRequestsException',
      'ServiceUnavailableException',
      'InternalErrorException',
    ];
    const isRetryable = retryableErrors.includes(errorCode);

    // Security-specific errors should not be retried
    const securityErrors = [
      'AccessDeniedException',
      'InvalidClientTokenId',
      'InvalidExternalId',
      'PackedPolicyTooLargeException',
    ];
    if (securityErrors.includes(errorCode)) {
      console.error(
        `Cross-account role assumption security error for tenant ${context.tenantId}:`,
        errorMessage
      );
    }

    return {
      success: false,
      error: {
        message: errorMessage,
        code: errorCode,
        retryable: isRetryable,
      },
      metadata: {
        region: context.region ?? this.config.defaultRegion,
        durationMs: Date.now() - startTime,
      },
    };
  }
}

/**
 * Helper function to create a cross-account role configuration
 */
export function createCrossAccountRole(
  accountId: string,
  roleName: string,
  externalId: string,
  options: {
    sessionDuration?: number;
    allowedRegions?: string[];
  } = {}
): CrossAccountRole {
  return {
    accountId,
    roleName,
    roleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
    externalId,
    sessionDuration: options.sessionDuration,
    allowedRegions: options.allowedRegions,
  };
}
