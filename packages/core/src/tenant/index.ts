/**
 * Tenant module
 *
 * Multi-tenant configuration and resource management:
 * - TenantService: CRUD operations for tenant configuration
 * - TenantLifecycleService: Tier upgrades/downgrades (features, models, quotas)
 * - QuotaManager: Resource quota tracking and enforcement
 * - RateLimiter: Token bucket rate limiting
 * - TenantRouter: JWT authentication and tenant context extraction
 * - CedarAuthorization: Fine-grained access control with Cedar policies
 * - RequestPipeline: Orchestrated request processing pipeline
 */

export {
  TenantService,
  type TenantServiceConfig,
  type CreateTenantParams,
} from './tenant-service';

export {
  TenantLifecycleService,
  TIER_QUOTA_LIMITS,
  type TenantLifecycleServiceConfig,
  type TierChangeResult,
} from './tenant-lifecycle-service';

export {
  QuotaManager,
  type QuotaManagerConfig,
  type QuotaCheckResult,
  type ConsumeQuotaParams,
  type CreateQuotaParams,
} from './quota-manager';

export {
  RateLimiter,
  type RateLimiterConfig,
  type CheckRateLimitParams,
} from './rate-limiter';

export {
  TenantRouter,
  type TenantRouterConfig,
  type TenantContext,
  type CognitoJWTClaims,
  type AuthenticationResult,
} from './tenant-router';

export {
  CedarAuthorization,
  type CedarPolicy,
  type CedarAction,
  type CedarResource,
  type AuthorizationRequest,
  type AuthorizationResult,
  type AuthorizationDecision,
  DEFAULT_POLICIES,
} from './cedar-authorization';

export {
  RequestPipeline,
  type RequestPipelineConfig,
  type RequestMetadata,
  type PipelineResult,
  type PipelineStageResult,
} from './request-pipeline';

export type { DynamoDBClient } from './tenant-service';
