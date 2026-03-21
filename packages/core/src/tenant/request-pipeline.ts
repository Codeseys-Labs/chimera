/**
 * Request Pipeline
 *
 * Orchestrates authentication, authorization, rate limiting, and quota checking
 * Implements composable middleware pattern for request processing
 */

import { TenantRouter, TenantContext, AuthenticationResult } from './tenant-router';
import {
  CedarAuthorization,
  CedarAction,
  CedarResource,
  AuthorizationResult,
  AuthorizationRequest,
} from './cedar-authorization';
import { RateLimiter, CheckRateLimitParams } from './rate-limiter';
import { QuotaManager, ConsumeQuotaParams, QuotaCheckResult } from './quota-manager';

/**
 * Pipeline stage result
 */
export interface PipelineStageResult {
  allowed: boolean;
  stage: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Complete pipeline result
 */
export interface PipelineResult {
  allowed: boolean;
  context?: TenantContext;
  stages: PipelineStageResult[];
  authorizationRequest?: AuthorizationRequest;
  authorizationResult?: AuthorizationResult;
  rateLimitResult?: { remaining: number; resetAt?: string };
  quotaResult?: QuotaCheckResult;
}

/**
 * Pipeline configuration
 */
export interface RequestPipelineConfig {
  tenantRouter: TenantRouter;
  cedarAuthorization: CedarAuthorization;
  rateLimiter: RateLimiter;
  quotaManager: QuotaManager;

  /** Skip rate limiting (for admin endpoints) */
  skipRateLimiting?: boolean;

  /** Skip quota checking (for read-only operations) */
  skipQuotaChecking?: boolean;
}

/**
 * Request metadata for pipeline processing
 */
export interface RequestMetadata {
  authHeader?: string;
  action: CedarAction;
  resource: CedarResource;
  rateLimitResource?: string; // Resource for rate limiting (e.g., "api-requests")
  rateLimitCost?: number; // Cost in tokens (default 1)
  quotaResource?: string; // Resource for quota (e.g., "agent-sessions")
  quotaAmount?: number; // Amount to consume (default 1)
}

/**
 * Request Pipeline
 *
 * Composable pipeline for multi-tenant request processing:
 *
 * Stage 1: Authentication
 *   - Extract and validate JWT
 *   - Load tenant config from DynamoDB
 *   - Build tenant context
 *
 * Stage 2: Authorization
 *   - Evaluate Cedar policies
 *   - Enforce cross-tenant isolation
 *   - Check role-based permissions
 *
 * Stage 3: Rate Limiting
 *   - Check token bucket state
 *   - Consume tokens atomically
 *   - Return retry-after on exhaustion
 *
 * Stage 4: Quota Checking
 *   - Check resource quotas
 *   - Consume quota atomically
 *   - Enforce tier-based limits
 *
 * All stages are atomic and fail-safe (deny on error)
 */
export class RequestPipeline {
  private config: RequestPipelineConfig;

  constructor(config: RequestPipelineConfig) {
    this.config = config;
  }

  /**
   * Process request through full pipeline
   *
   * Returns detailed result with stage-by-stage breakdown
   * for debugging and observability
   *
   * @param metadata - Request metadata
   * @returns Pipeline result
   */
  async process(metadata: RequestMetadata): Promise<PipelineResult> {
    const stages: PipelineStageResult[] = [];

    // Stage 1: Authentication
    const authResult = await this.authenticate(metadata.authHeader);
    stages.push({
      allowed: authResult.allowed,
      stage: 'authentication',
      error: authResult.error,
    });

    if (!authResult.allowed || !authResult.context) {
      return {
        allowed: false,
        stages,
      };
    }

    const context = authResult.context;

    // Stage 2: Authorization
    const authzResult = await this.authorize(context, metadata.action, metadata.resource);
    stages.push({
      allowed: authzResult.allowed,
      stage: 'authorization',
      error: authzResult.error,
    });

    if (!authzResult.allowed) {
      return {
        allowed: false,
        context,
        stages,
        authorizationRequest: authzResult.request,
        authorizationResult: authzResult.result,
      };
    }

    // Stage 3: Rate Limiting (optional)
    let rateLimitResult: { remaining: number; resetAt?: string } | undefined;
    if (!this.config.skipRateLimiting && metadata.rateLimitResource) {
      const rateLimitCheck = await this.checkRateLimit(
        context.tenantId,
        metadata.rateLimitResource,
        metadata.rateLimitCost
      );
      stages.push({
        allowed: rateLimitCheck.allowed,
        stage: 'rate-limiting',
        error: rateLimitCheck.error,
      });

      rateLimitResult = {
        remaining: rateLimitCheck.remaining || 0,
        resetAt: rateLimitCheck.resetAt,
      };

      if (!rateLimitCheck.allowed) {
        return {
          allowed: false,
          context,
          stages,
          rateLimitResult,
        };
      }
    }

    // Stage 4: Quota Checking (optional)
    let quotaResult: QuotaCheckResult | undefined;
    if (!this.config.skipQuotaChecking && metadata.quotaResource) {
      const quotaCheck = await this.checkAndConsumeQuota(
        context.tenantId,
        metadata.quotaResource,
        metadata.quotaAmount
      );
      stages.push({
        allowed: quotaCheck.allowed,
        stage: 'quota-checking',
        error: quotaCheck.error,
      });

      quotaResult = quotaCheck.result;

      if (!quotaCheck.allowed) {
        return {
          allowed: false,
          context,
          stages,
          quotaResult,
        };
      }
    }

    // All stages passed
    return {
      allowed: true,
      context,
      stages,
      authorizationRequest: authzResult.request,
      authorizationResult: authzResult.result,
      rateLimitResult,
      quotaResult,
    };
  }

  /**
   * Stage 1: Authenticate request
   *
   * @param authHeader - Authorization header
   * @returns Authentication result with context
   */
  private async authenticate(authHeader: string | undefined): Promise<{
    allowed: boolean;
    context?: TenantContext;
    error?: { code: string; message: string };
  }> {
    const authResult = await this.config.tenantRouter.authenticate(authHeader);
    return {
      allowed: authResult.authenticated,
      context: authResult.context,
      error: authResult.error,
    };
  }

  /**
   * Stage 2: Authorize action on resource
   *
   * @param context - Tenant context
   * @param action - Action to authorize
   * @param resource - Resource to access
   * @returns Authorization result
   */
  private async authorize(
    context: TenantContext,
    action: CedarAction,
    resource: CedarResource
  ): Promise<{
    allowed: boolean;
    error?: { code: string; message: string };
    request?: AuthorizationRequest;
    result?: AuthorizationResult;
  }> {
    // Build authorization request
    const request = CedarAuthorization.buildRequest(context, action, resource);

    // Add tenant ID to resource attributes for policy evaluation
    request.resource.attributes = {
      ...request.resource.attributes,
      tenantId: context.tenantId,
      tenantStatus: context.tenantConfig.profile.status,
      tier: context.tenantConfig.profile.tier,
    };

    // Evaluate policies
    const result = this.config.cedarAuthorization.authorize(request);

    if (result.decision === 'Deny') {
      return {
        allowed: false,
        error: {
          code: 'AUTHORIZATION_DENIED',
          message: `Access denied: ${result.reasons.join(', ')}`,
        },
        request,
        result,
      };
    }

    return {
      allowed: true,
      request,
      result,
    };
  }

  /**
   * Stage 3: Check rate limit
   *
   * @param tenantId - Tenant ID
   * @param resource - Resource name for rate limiting
   * @param cost - Token cost (default 1)
   * @returns Rate limit result
   */
  private async checkRateLimit(
    tenantId: string,
    resource: string,
    cost: number = 1
  ): Promise<{
    allowed: boolean;
    remaining?: number;
    resetAt?: string;
    error?: { code: string; message: string };
  }> {
    try {
      const params: CheckRateLimitParams = {
        tenantId,
        resource,
        cost,
      };

      const result = await this.config.rateLimiter.checkRateLimit(params);

      if (!result.allowed) {
        return {
          allowed: false,
          remaining: result.remainingTokens,
          resetAt: result.resetAt,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Rate limit exceeded. Retry after ${result.retryAfter} seconds`,
          },
        };
      }

      return {
        allowed: true,
        remaining: result.remainingTokens,
      };
    } catch (error: any) {
      // Fail closed on rate limiter errors (deny and alert)
      console.error('Rate limiter error:', error);
      return {
        allowed: false,
        error: {
          code: 'RATE_LIMITER_ERROR',
          message: 'Rate limiter unavailable, denying request',
        },
      };
    }
  }

  /**
   * Stage 4: Check and consume quota
   *
   * @param tenantId - Tenant ID
   * @param resource - Resource name
   * @param amount - Amount to consume (default 1)
   * @returns Quota check result
   */
  private async checkAndConsumeQuota(
    tenantId: string,
    resource: string,
    amount: number = 1
  ): Promise<{
    allowed: boolean;
    result?: QuotaCheckResult;
    error?: { code: string; message: string };
  }> {
    try {
      const params: ConsumeQuotaParams = {
        tenantId,
        resource,
        amount,
      };

      const result = await this.config.quotaManager.checkAndConsume(params);

      if (!result.allowed) {
        return {
          allowed: false,
          result,
          error: {
            code: 'QUOTA_EXCEEDED',
            message: `Quota exceeded for ${resource}. Limit: ${result.limit}, Remaining: ${result.remaining}`,
          },
        };
      }

      return {
        allowed: true,
        result,
      };
    } catch (error: any) {
      // Fail closed on quota errors (deny and alert)
      console.error('Quota manager error:', error);
      return {
        allowed: false,
        error: {
          code: 'QUOTA_MANAGER_ERROR',
          message: 'Quota manager unavailable, denying request',
        },
      };
    }
  }

  /**
   * Create a lightweight pipeline for read-only operations
   *
   * Skips rate limiting and quota checking
   *
   * @param config - Base pipeline config
   * @returns Pipeline configured for read-only operations
   */
  static forReadOnlyOperations(config: Omit<RequestPipelineConfig, 'skipRateLimiting' | 'skipQuotaChecking'>): RequestPipeline {
    return new RequestPipeline({
      ...config,
      skipRateLimiting: true,
      skipQuotaChecking: true,
    });
  }

  /**
   * Create a pipeline for admin operations
   *
   * Skips rate limiting but enforces authorization and quotas
   *
   * @param config - Base pipeline config
   * @returns Pipeline configured for admin operations
   */
  static forAdminOperations(config: Omit<RequestPipelineConfig, 'skipRateLimiting'>): RequestPipeline {
    return new RequestPipeline({
      ...config,
      skipRateLimiting: true,
    });
  }
}
