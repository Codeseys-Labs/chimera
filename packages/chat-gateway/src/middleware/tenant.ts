/**
 * Tenant context extraction middleware
 *
 * Extracts tenant metadata from request headers for multi-tenant isolation.
 * In production, API Gateway + Cognito JWT authorizer populates these headers.
 */

import { Request, Response, NextFunction } from 'express';
import { TenantContext } from '../types';
import { TenantTier } from '@chimera/shared';

// Augment Express Request to include tenant context
declare global {
  namespace Express {
    interface Request {
      tenantContext?: TenantContext;
    }
  }
}

/**
 * Extract tenant context from headers
 *
 * Expected headers:
 * - X-Tenant-Id: tenant identifier (required)
 * - X-User-Id: user identifier (optional)
 * - X-Tenant-Tier: subscription tier (optional, default: 'basic')
 *
 * Returns 401 if X-Tenant-Id is missing.
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
  const tierHeader = (req.headers['x-tenant-tier'] as string | undefined) || 'basic';

  // Validate tier
  const validTiers: TenantTier[] = ['basic', 'advanced', 'enterprise', 'dedicated'];
  const tier: TenantTier = validTiers.includes(tierHeader as TenantTier)
    ? (tierHeader as TenantTier)
    : 'basic';

  // Attach tenant context to request
  req.tenantContext = {
    tenantId,
    userId,
    tier,
  };

  next();
}
