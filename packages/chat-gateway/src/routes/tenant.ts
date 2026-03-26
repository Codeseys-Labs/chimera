/**
 * Tenant provisioning routes
 *
 * Administrative API for tenant management:
 * - Create tenant
 * - Update tenant configuration
 * - Suspend/activate tenant
 * - Query tenant status
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { TenantService } from '@chimera/core';
import { TenantTier, TenantStatus } from '@chimera/shared';
import { TenantContext } from '../types';

const router = new Hono();

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
function isPlatformAdmin(c: Context): boolean {
  const adminTenantId = process.env.PLATFORM_ADMIN_TENANT_ID || 'chimera-platform';
  const tenantContext = c.get('tenantContext') as TenantContext | undefined;
  return tenantContext?.tenantId === adminTenantId;
}

/**
 * Authorization helper: Check if request can access target tenant
 *
 * Users can access their own tenant or if they are platform admin.
 */
function canAccessTenant(c: Context, targetTenantId: string): boolean {
  if (isPlatformAdmin(c)) {
    return true;
  }
  const tenantContext = c.get('tenantContext') as TenantContext | undefined;
  return tenantContext?.tenantId === targetTenantId;
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
 *   "tier": "premium",
 *   "adminEmail": "admin@acme.com",
 *   "dataRegion": "us-east-1"
 * }
 */
router.post('/', async (c: Context) => {
  try {
    // Authorization: Only platform admins can create tenants
    if (!isPlatformAdmin(c)) {
      return c.json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Only platform administrators can create tenants',
        },
        timestamp: new Date().toISOString(),
      }, 403);
    }

    const { tenantId, name, tier, adminEmail, dataRegion, features, models, billing } = await c.req.json();

    // Validate required fields
    if (!tenantId || !name || !tier || !adminEmail || !dataRegion) {
      return c.json({
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'Required fields: tenantId, name, tier, adminEmail, dataRegion',
        },
        timestamp: new Date().toISOString(),
      }, 400);
    }

    // Validate tier
    const validTiers: TenantTier[] = ['basic', 'advanced', 'premium'];
    if (!validTiers.includes(tier)) {
      return c.json({
        error: {
          code: 'INVALID_TIER',
          message: `Tier must be one of: ${validTiers.join(', ')}`,
        },
        timestamp: new Date().toISOString(),
      }, 400);
    }

    // Check if tenant already exists
    const existing = await tenantService.getTenantProfile(tenantId);
    if (existing) {
      return c.json({
        error: {
          code: 'TENANT_EXISTS',
          message: 'Tenant already exists',
        },
        timestamp: new Date().toISOString(),
      }, 409);
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

    return c.json({
      tenant: profile,
      timestamp: new Date().toISOString(),
    }, 201);
  } catch (error) {
    console.error('Create tenant error:', error);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to create tenant',
      },
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

/**
 * GET /tenants/:tenantId
 *
 * Get tenant profile
 */
router.get('/:tenantId', async (c: Context) => {
  try {
    const tenantId = c.req.param('tenantId')!;

    // Authorization: Can only access own tenant or if platform admin
    if (!canAccessTenant(c, tenantId)) {
      return c.json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only access your own tenant profile',
        },
        timestamp: new Date().toISOString(),
      }, 403);
    }

    const profile = await tenantService.getTenantProfile(tenantId);

    if (!profile) {
      return c.json({
        error: {
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant not found',
        },
        timestamp: new Date().toISOString(),
      }, 404);
    }

    return c.json({
      tenant: profile,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Get tenant error:', error);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to get tenant',
      },
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

/**
 * PATCH /tenants/:tenantId
 *
 * Update tenant profile
 *
 * Request body: Partial<TenantProfile>
 */
router.patch('/:tenantId', async (c: Context) => {
  try {
    const tenantId = c.req.param('tenantId')!;

    // Authorization: Can only update own tenant or if platform admin
    if (!canAccessTenant(c, tenantId)) {
      return c.json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only update your own tenant profile',
        },
        timestamp: new Date().toISOString(),
      }, 403);
    }

    const updates = await c.req.json();

    // Check if tenant exists
    const existing = await tenantService.getTenantProfile(tenantId);
    if (!existing) {
      return c.json({
        error: {
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant not found',
        },
        timestamp: new Date().toISOString(),
      }, 404);
    }

    // Update profile
    await tenantService.updateProfile(tenantId, updates);

    // Fetch updated tenant
    const profile = await tenantService.getTenantProfile(tenantId);

    return c.json({
      tenant: profile,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Update tenant error:', error);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to update tenant',
      },
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

/**
 * POST /tenants/:tenantId/suspend
 *
 * Suspend tenant
 */
router.post('/:tenantId/suspend', async (c: Context) => {
  try {
    const tenantId = c.req.param('tenantId')!;

    // Authorization: Only platform admins can suspend tenants
    if (!isPlatformAdmin(c)) {
      return c.json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Only platform administrators can suspend tenants',
        },
        timestamp: new Date().toISOString(),
      }, 403);
    }

    const { reason } = await c.req.json();

    // Check if tenant exists
    const existing = await tenantService.getTenantProfile(tenantId);
    if (!existing) {
      return c.json({
        error: {
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant not found',
        },
        timestamp: new Date().toISOString(),
      }, 404);
    }

    // Suspend tenant
    await tenantService.suspendTenant(tenantId, reason);

    return c.json({
      message: 'Tenant suspended',
      tenantId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Suspend tenant error:', error);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to suspend tenant',
      },
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

/**
 * POST /tenants/:tenantId/activate
 *
 * Activate tenant (from TRIAL or SUSPENDED)
 */
router.post('/:tenantId/activate', async (c: Context) => {
  try {
    const tenantId = c.req.param('tenantId')!;

    // Authorization: Only platform admins can activate tenants
    if (!isPlatformAdmin(c)) {
      return c.json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Only platform administrators can activate tenants',
        },
        timestamp: new Date().toISOString(),
      }, 403);
    }

    // Check if tenant exists
    const existing = await tenantService.getTenantProfile(tenantId);
    if (!existing) {
      return c.json({
        error: {
          code: 'TENANT_NOT_FOUND',
          message: 'Tenant not found',
        },
        timestamp: new Date().toISOString(),
      }, 404);
    }

    // Activate tenant
    await tenantService.activateTenant(tenantId);

    return c.json({
      message: 'Tenant activated',
      tenantId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Activate tenant error:', error);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to activate tenant',
      },
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

/**
 * GET /tenants/query/tier/:tier
 *
 * Query tenants by tier
 */
router.get('/query/tier/:tier', async (c: Context) => {
  try {
    // Authorization: Only platform admins can query all tenants
    if (!isPlatformAdmin(c)) {
      return c.json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Only platform administrators can query tenants',
        },
        timestamp: new Date().toISOString(),
      }, 403);
    }

    const tier = c.req.param('tier')!;
    const status = c.req.query('status');

    // Validate tier
    const validTiers: TenantTier[] = ['basic', 'advanced', 'premium'];
    if (!validTiers.includes(tier as TenantTier)) {
      return c.json({
        error: {
          code: 'INVALID_TIER',
          message: `Tier must be one of: ${validTiers.join(', ')}`,
        },
        timestamp: new Date().toISOString(),
      }, 400);
    }

    const tenants = await tenantService.getTenantsByTier(
      tier as TenantTier,
      status as TenantStatus | undefined
    );

    return c.json({
      tenants,
      count: tenants.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Query tenants error:', error);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to query tenants',
      },
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

/**
 * GET /tenants/query/status/:status
 *
 * Query tenants by status
 */
router.get('/query/status/:status', async (c: Context) => {
  try {
    // Authorization: Only platform admins can query all tenants
    if (!isPlatformAdmin(c)) {
      return c.json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'Only platform administrators can query tenants',
        },
        timestamp: new Date().toISOString(),
      }, 403);
    }

    const status = c.req.param('status')!;

    // Validate status
    const validStatuses: TenantStatus[] = ['TRIAL', 'ACTIVE', 'SUSPENDED'];
    if (!validStatuses.includes(status as TenantStatus)) {
      return c.json({
        error: {
          code: 'INVALID_STATUS',
          message: `Status must be one of: ${validStatuses.join(', ')}`,
        },
        timestamp: new Date().toISOString(),
      }, 400);
    }

    const tenants = await tenantService.getTenantsByStatus(status as TenantStatus);

    return c.json({
      tenants,
      count: tenants.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Query tenants error:', error);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to query tenants',
      },
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

export default router;
