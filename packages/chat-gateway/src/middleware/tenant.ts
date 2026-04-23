/**
 * Tenant context extraction middleware
 *
 * Extracts tenant metadata from request headers and validates against DynamoDB.
 * In production, API Gateway + Cognito JWT authorizer populates these headers.
 *
 * Phase 4 enhancements:
 * - DynamoDB tenant lookup for validation
 * - Status checks (SUSPENDED tenants rejected)
 * - Tier-based feature availability
 */

import { Context, Next } from 'hono';
import { TenantContext } from '../types';
import { TenantService } from '@chimera/core';
import { AuthContext } from './auth';

// Local DynamoDBClient type (matches TenantService interface)
interface DynamoDBClient {
  get(params: any): Promise<any>;
  put(params: any): Promise<any>;
  delete(params: any): Promise<any>;
  batchGet(params: any): Promise<any>;
  query(params: any): Promise<any>;
  update(params: any): Promise<any>;
}

// Mock DynamoDB client for development (replaced by real AWS SDK in production)
const mockDynamoDBClient: DynamoDBClient = {
  async get() {
    return { Item: null };
  },
  async put() {
    return {};
  },
  async delete() {
    return {};
  },
  async batchGet() {
    return { Responses: {} };
  },
  async query() {
    return { Items: [] };
  },
  async update() {
    return {};
  },
};

// Initialize tenant service (should be injected via dependency injection in production)
const tenantService = new TenantService({
  tenantsTableName: process.env.TENANTS_TABLE_NAME || 'chimera-tenants',
  dynamodb: mockDynamoDBClient,
});

/**
 * Extract tenant context — JWT claims are the source of truth.
 *
 * Resolution order:
 * 1. JWT `custom:tenant_id` claim (set by authenticateJWT / optionalAuth)
 * 2. X-Tenant-Id header — ONLY allowed in development mode
 *
 * In production the header is ignored entirely to prevent tenant spoofing.
 *
 * Returns 401 if no tenant ID can be resolved.
 */
export async function extractTenantContext(c: Context, next: Next): Promise<Response | void> {
  const isDev = process.env.NODE_ENV === 'development' || process.env.CHIMERA_ENV === 'dev';

  // Primary: extract from verified JWT claims (AuthContext populated by authenticateJWT)
  const auth = c.get('auth') as AuthContext | undefined;
  let tenantId: string | undefined;
  let userId: string | undefined;
  let tenantTier: string | undefined;

  if (auth) {
    tenantId = auth.tenantId;
    userId = auth.sub;
    tenantTier = auth.tenantTier;
  }

  // Fallback: X-Tenant-Id header — development only, never trust in production
  if (!tenantId && isDev) {
    tenantId = c.req.header('x-tenant-id');
    userId = userId || c.req.header('x-user-id');
  }

  if (!tenantId) {
    return c.json(
      {
        error: {
          code: 'MISSING_TENANT_ID',
          message: 'Tenant ID must be present in JWT claims (custom:tenant_id)',
        },
        timestamp: new Date().toISOString(),
      },
      401
    );
  }

  // Tier from JWT claims; fall back to header only in dev, default to 'basic'.
  // Must stay in sync with TenantTier in packages/shared/src/types/tenant.ts.
  // `premium` is a legacy alias for `enterprise` — both resolve to the same
  // behavior (see AUDIT_TTL_DAYS_BY_TIER at audit-trail.ts and TIER_FEATURES
  // at tenant-lifecycle-service.ts).
  const validTiers = ['basic', 'advanced', 'enterprise', 'dedicated', 'premium'];
  let tier = tenantTier;
  if (!tier && isDev) {
    tier = c.req.header('x-tenant-tier') || undefined;
  }
  tier = tier && validTiers.includes(tier) ? tier : 'basic';

  // Attach tenant context to Hono context
  c.set('tenantContext', {
    tenantId,
    userId,
    tier: tier as any,
  });

  await next();
}

/**
 * Enhanced tenant context with DynamoDB validation
 *
 * Use this middleware in production for full tenant validation.
 * Resolves tenantId from JWT claims (never from headers in production).
 * Checks tenant status and feature availability.
 */
export async function extractTenantContextWithValidation(
  c: Context,
  next: Next
): Promise<Response | void> {
  const auth = c.get('auth') as AuthContext | undefined;
  const tenantId = auth?.tenantId;

  if (!tenantId) {
    return c.json(
      {
        error: {
          code: 'MISSING_TENANT_ID',
          message: 'Tenant ID must be present in JWT claims (custom:tenant_id)',
        },
        timestamp: new Date().toISOString(),
      },
      401
    );
  }

  const userId = auth?.sub;

  try {
    // Fetch tenant profile from DynamoDB
    const profile = await tenantService.getTenantProfile(tenantId);

    if (!profile) {
      return c.json(
        {
          error: {
            code: 'TENANT_NOT_FOUND',
            message: 'Tenant does not exist',
          },
          timestamp: new Date().toISOString(),
        },
        403
      );
    }

    // Check tenant status
    if (profile.status === 'SUSPENDED') {
      return c.json(
        {
          error: {
            code: 'TENANT_SUSPENDED',
            message: 'Tenant account is suspended. Contact support.',
          },
          timestamp: new Date().toISOString(),
        },
        403
      );
    }

    // Attach validated tenant context
    c.set('tenantContext', {
      tenantId: profile.tenantId,
      userId,
      tier: profile.tier,
    });

    await next();
  } catch (error) {
    console.error('Tenant validation error:', error);
    return c.json(
      {
        error: {
          code: 'TENANT_VALIDATION_ERROR',
          message: 'Failed to validate tenant',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
}
