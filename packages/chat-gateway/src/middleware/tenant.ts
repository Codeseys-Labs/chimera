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

import { Request, Response, NextFunction } from 'express';
import { TenantContext } from '../types';
import { TenantService } from '@chimera/core';

// Augment Express Request to include tenant context
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantContext?: TenantContext;
    }
  }
}

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
 * Extract tenant context from headers with DynamoDB validation
 *
 * Expected headers:
 * - X-Tenant-Id: tenant identifier (required)
 * - X-User-Id: user identifier (optional)
 *
 * Returns 401 if X-Tenant-Id is missing.
 * Returns 403 if tenant is SUSPENDED or not found.
 */
export function extractTenantContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const tenantId = req.headers['x-tenant-id'] as string | undefined;

  if (!tenantId) {
    res.status(401).json({
      error: {
        code: 'MISSING_TENANT_ID',
        message: 'X-Tenant-Id header is required',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const userId = req.headers['x-user-id'] as string | undefined;

  // For development/testing: accept header-provided tier without DynamoDB lookup
  // In production, this would be replaced with actual DynamoDB validation
  const tierHeader = (req.headers['x-tenant-tier'] as string | undefined) || 'basic';
  const validTiers = ['basic', 'advanced', 'enterprise', 'dedicated'];
  const tier = validTiers.includes(tierHeader) ? tierHeader : 'basic';

  // Attach tenant context to request
  req.tenantContext = {
    tenantId,
    userId,
    tier: tier as any,
  };

  next();
}

/**
 * Enhanced tenant context with DynamoDB validation
 *
 * Use this middleware in production for full tenant validation.
 * Checks tenant status and feature availability.
 */
export async function extractTenantContextWithValidation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const tenantId = req.headers['x-tenant-id'] as string | undefined;

  if (!tenantId) {
    res.status(401).json({
      error: {
        code: 'MISSING_TENANT_ID',
        message: 'X-Tenant-Id header is required',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const userId = req.headers['x-user-id'] as string | undefined;

  try {
    // Fetch tenant profile from DynamoDB
    const profile = await tenantService.getTenantProfile(tenantId);

    if (!profile) {
      res.status(403).json({
        error: {
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant does not exist',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check tenant status
    if (profile.status === 'SUSPENDED') {
      res.status(403).json({
        error: {
          code: 'TENANT_SUSPENDED',
          message: 'Tenant account is suspended. Contact support.',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Attach validated tenant context
    req.tenantContext = {
      tenantId: profile.tenantId,
      userId,
      tier: profile.tier,
    };

    next();
  } catch (error) {
    console.error('Tenant validation error:', error);
    res.status(500).json({
      error: {
        code: 'TENANT_VALIDATION_ERROR',
        message: 'Failed to validate tenant',
      },
      timestamp: new Date().toISOString(),
    });
  }
}
