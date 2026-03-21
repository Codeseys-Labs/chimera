/**
 * Tenant provisioning routes
 *
 * Administrative API for tenant management:
 * - Create tenant
 * - Update tenant configuration
 * - Suspend/activate tenant
 * - Query tenant status
 */

import { Router, Request, Response } from 'express';
import type { Router as ExpressRouter } from 'express';
import { TenantService } from '@chimera/core';
import { TenantTier, TenantStatus } from '@chimera/shared';

const router: ExpressRouter = Router();

// Local DynamoDBClient type (matches TenantService interface)
interface DynamoDBClient {
  get(params: any): Promise<any>;
  put(params: any): Promise<any>;
  delete(params: any): Promise<any>;
  batchGet(params: any): Promise<any>;
  query(params: any): Promise<any>;
  update(params: any): Promise<any>;
}

// Mock DynamoDB client for development
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

const tenantService = new TenantService({
  tenantsTableName: process.env.TENANTS_TABLE_NAME || 'chimera-tenants',
  dynamodb: mockDynamoDBClient,
});

/**
 * Authorization helper: Check if request is from platform admin
 *
 * Platform admins have special tenant ID or admin role.
 * In production, this would check JWT claims or IAM roles.
 */
function isPlatformAdmin(req: Request): boolean {
  const adminTenantId = process.env.PLATFORM_ADMIN_TENANT_ID || 'chimera-platform';
  return req.tenantContext?.tenantId === adminTenantId;
}

/**
 * Authorization helper: Check if request can access target tenant
 *
 * Users can access their own tenant or if they are platform admin.
 */
function canAccessTenant(req: Request, targetTenantId: string): boolean {
  if (isPlatformAdmin(req)) {
    return true;
  }
  return req.tenantContext?.tenantId === targetTenantId;
}

/**
 * POST /tenants
 *
 * Create a new tenant
 *
 * Request body:
 * {
 *   "tenantId": "acme-corp",
 *   "name": "ACME Corporation",
 *   "tier": "enterprise",
 *   "adminEmail": "admin@acme.com",
 *   "dataRegion": "us-east-1"
 * }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    // Authorization: Only platform admins can create tenants
    if (!isPlatformAdmin(req)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Only platform administrators can create tenants',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { tenantId, name, tier, adminEmail, dataRegion, features, models, billing } = req.body;

    // Validate required fields
    if (!tenantId || !name || !tier || !adminEmail || !dataRegion) {
      res.status(400).json({
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'Required fields: tenantId, name, tier, adminEmail, dataRegion',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate tier
    const validTiers: TenantTier[] = ['basic', 'advanced', 'enterprise', 'dedicated'];
    if (!validTiers.includes(tier)) {
      res.status(400).json({
        error: {
          code: 'INVALID_TIER',
          message: `Tier must be one of: ${validTiers.join(', ')}`,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check if tenant already exists
    const existing = await tenantService.getTenantProfile(tenantId);
    if (existing) {
      res.status(409).json({
        error: {
          code: 'TENANT_EXISTS',
          message: 'Tenant already exists',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Create tenant
    await tenantService.createTenant({
      tenantId,
      name,
      tier,
      adminEmail,
      dataRegion,
      features,
      models,
      billing,
    });

    // Fetch created tenant
    const profile = await tenantService.getTenantProfile(tenantId);

    res.status(201).json({
      tenant: profile,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Create tenant error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to create tenant',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /tenants/:tenantId
 *
 * Get tenant profile
 */
router.get('/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;

    // Authorization: Can only access own tenant or if platform admin
    if (!canAccessTenant(req, tenantId)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only access your own tenant profile',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const profile = await tenantService.getTenantProfile(tenantId);

    if (!profile) {
      res.status(404).json({
        error: {
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({
      tenant: profile,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Get tenant error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to get tenant',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * PATCH /tenants/:tenantId
 *
 * Update tenant profile
 *
 * Request body: Partial<TenantProfile>
 */
router.patch('/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;

    // Authorization: Can only update own tenant or if platform admin
    if (!canAccessTenant(req, tenantId)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only update your own tenant profile',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const updates = req.body;

    // Check if tenant exists
    const existing = await tenantService.getTenantProfile(tenantId);
    if (!existing) {
      res.status(404).json({
        error: {
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Update profile
    await tenantService.updateProfile(tenantId, updates);

    // Fetch updated tenant
    const profile = await tenantService.getTenantProfile(tenantId);

    res.status(200).json({
      tenant: profile,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Update tenant error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to update tenant',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /tenants/:tenantId/suspend
 *
 * Suspend tenant
 */
router.post('/:tenantId/suspend', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;

    // Authorization: Only platform admins can suspend tenants
    if (!isPlatformAdmin(req)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Only platform administrators can suspend tenants',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { reason } = req.body;

    // Check if tenant exists
    const existing = await tenantService.getTenantProfile(tenantId);
    if (!existing) {
      res.status(404).json({
        error: {
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Suspend tenant
    await tenantService.suspendTenant(tenantId, reason);

    res.status(200).json({
      message: 'Tenant suspended',
      tenantId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Suspend tenant error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to suspend tenant',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /tenants/:tenantId/activate
 *
 * Activate tenant (from TRIAL or SUSPENDED)
 */
router.post('/:tenantId/activate', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;

    // Authorization: Only platform admins can activate tenants
    if (!isPlatformAdmin(req)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Only platform administrators can activate tenants',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check if tenant exists
    const existing = await tenantService.getTenantProfile(tenantId);
    if (!existing) {
      res.status(404).json({
        error: {
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Activate tenant
    await tenantService.activateTenant(tenantId);

    res.status(200).json({
      message: 'Tenant activated',
      tenantId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Activate tenant error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to activate tenant',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /tenants/query/tier/:tier
 *
 * Query tenants by tier
 */
router.get('/query/tier/:tier', async (req: Request, res: Response) => {
  try {
    // Authorization: Only platform admins can query all tenants
    if (!isPlatformAdmin(req)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Only platform administrators can query tenants',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { tier } = req.params;
    const { status } = req.query;

    // Validate tier
    const validTiers: TenantTier[] = ['basic', 'advanced', 'enterprise', 'dedicated'];
    if (!validTiers.includes(tier as TenantTier)) {
      res.status(400).json({
        error: {
          code: 'INVALID_TIER',
          message: `Tier must be one of: ${validTiers.join(', ')}`,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const tenants = await tenantService.getTenantsByTier(
      tier as TenantTier,
      status as TenantStatus | undefined
    );

    res.status(200).json({
      tenants,
      count: tenants.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Query tenants error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to query tenants',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /tenants/query/status/:status
 *
 * Query tenants by status
 */
router.get('/query/status/:status', async (req: Request, res: Response) => {
  try {
    // Authorization: Only platform admins can query all tenants
    if (!isPlatformAdmin(req)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Only platform administrators can query tenants',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { status } = req.params;

    // Validate status
    const validStatuses: TenantStatus[] = ['TRIAL', 'ACTIVE', 'SUSPENDED'];
    if (!validStatuses.includes(status as TenantStatus)) {
      res.status(400).json({
        error: {
          code: 'INVALID_STATUS',
          message: `Status must be one of: ${validStatuses.join(', ')}`,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const tenants = await tenantService.getTenantsByStatus(status as TenantStatus);

    res.status(200).json({
      tenants,
      count: tenants.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Query tenants error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to query tenants',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
