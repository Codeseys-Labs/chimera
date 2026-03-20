/**
 * Tenant module
 *
 * Multi-tenant configuration and resource management:
 * - TenantService: CRUD operations for tenant configuration
 * - QuotaManager: Resource quota tracking and enforcement
 * - RateLimiter: Token bucket rate limiting
 */

export {
  TenantService,
  type TenantServiceConfig,
  type CreateTenantParams,
} from './tenant-service';

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

export type { DynamoDBClient } from './tenant-service';
