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
import { DynamoDBClient as AwsDynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  BatchGetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { TenantContext } from '../types';

const router = new Hono();

// DynamoDB client matching TenantService's DynamoDBClient interface.
//
// Wave-22: this route previously used a no-op mock that returned {Item: null}
// for every query, which made /tenants/:id always 404 in production against
// a real DDB table. Replaced with a thin DynamoDBDocumentClient adapter so
// the PROFILE items seeded by TenantOnboardingStack are actually visible.
const docClient = DynamoDBDocumentClient.from(new AwsDynamoDBClient({}));

interface DynamoDBClient {
  get(params: any): Promise<any>;
  put(params: any): Promise<any>;
  delete(params: any): Promise<any>;
  batchGet(params: any): Promise<any>;
  query(params: any): Promise<any>;
  update(params: any): Promise<any>;
}

const ddbAdapter: DynamoDBClient = {
  get: (params) => docClient.send(new GetCommand(params)),
  put: (params) => docClient.send(new PutCommand(params)),
  delete: (params) => docClient.send(new DeleteCommand(params)),
  batchGet: (params) => docClient.send(new BatchGetCommand(params)),
  query: (params) => docClient.send(new QueryCommand(params)),
  update: (params) => docClient.send(new UpdateCommand(params)),
};

const tenantService = new TenantService({
  // Must default to the env-scoped table; the previous 'chimera-tenants'
  // default pointed at a non-existent table and compounded the mock-client
  // silent-failure above.
  tenantsTableName:
    process.env.TENANTS_TABLE_NAME ||
    process.env.CHIMERA_TENANTS_TABLE ||
    'chimera-tenants-dev',
  dynamodb: ddbAdapter,
});

// Cognito client for the tenant-scoped user listing below. Uses the same
// task IAM role as the rest of the gateway — production prod already
// grants `cognito-idp:ListUsers` via ChatStack (see infra/lib/chat-stack.ts
// taskRole). Region defaults to $AWS_REGION like every other AWS client
// in this file.
const cognitoClient = new CognitoIdentityProviderClient({});
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;

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

/**
 * GET /tenants/:tenantId/users
 *
 * List Cognito users whose `custom:tenant_id` matches the given tenant.
 * Backs the Admin page's Users tab. Cognito's `ListUsersCommand.Filter`
 * supports equality on a single attribute; tenant_id is the natural
 * scope. Callers outside their own tenant get 403.
 *
 * Wave-25 (chimera-c881): the Admin SPA previously called this path and
 * hit a blanket 404 because the route didn't exist in the gateway. The
 * nearest existing implementation was `/integrations/:id/users` — which
 * returns PLATFORM pairings (Slack/Discord user → Cognito mapping),
 * semantically different from "Cognito users in this tenant."
 */
router.get('/:tenantId/users', async (c: Context) => {
  try {
    const tenantId = c.req.param('tenantId')!;

    if (!canAccessTenant(c, tenantId)) {
      return c.json(
        {
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: 'You can only access your own tenant',
          },
          timestamp: new Date().toISOString(),
        },
        403
      );
    }

    if (!COGNITO_USER_POOL_ID) {
      return c.json(
        {
          error: {
            code: 'AUTH_NOT_CONFIGURED',
            message: 'COGNITO_USER_POOL_ID is not set',
          },
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    // Cognito filter syntax:
    //   "custom:tenant_id = \"acme\""
    // Whitespace matters; quotes must be literal inside the single string.
    const filter = `"custom:tenant_id" = "${tenantId.replace(/"/g, '\\"')}"`;
    const response = await cognitoClient.send(
      new ListUsersCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Filter: filter,
        Limit: 60,
      })
    );

    const users = (response.Users ?? []).map((u) => {
      const attr = (name: string) =>
        u.Attributes?.find((a) => a.Name === name)?.Value;
      return {
        sub: attr('sub') ?? u.Username ?? '',
        email: attr('email') ?? '',
        name: attr('name') ?? attr('given_name') ?? '',
        status: u.UserStatus ?? 'UNKNOWN',
        // Cognito doesn't return group membership on ListUsers — callers
        // who need it must call AdminListGroupsForUser per user. The UI
        // currently just displays the string, so an empty list is fine.
        groups: [] as string[],
      };
    });

    return c.json({
      users,
      count: users.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Get tenant users error:', error);
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to list users',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * GET /tenants/:tenantId/api-keys
 *
 * List API keys issued for a tenant. No persisted key store exists yet
 * (tracked separately — admin UI is meant as a placeholder pre-GA), so
 * this route returns an empty list with HTTP 200 rather than 404. The
 * Admin page's `EmptyState` component renders the "No API keys" UI when
 * the list is empty.
 *
 * Wave-25 (chimera-c881): fixing this to 200+empty unblocks the Admin
 * page from surfacing a browser console error on every load. When the
 * backing store lands, this handler swaps the empty-list for a real
 * query without UI changes.
 */
router.get('/:tenantId/api-keys', async (c: Context) => {
  const tenantId = c.req.param('tenantId')!;

  if (!canAccessTenant(c, tenantId)) {
    return c.json(
      {
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only access your own tenant',
        },
        timestamp: new Date().toISOString(),
      },
      403
    );
  }

  return c.json({
    keys: [] as Array<{ id: string; maskedKey: string; name: string; createdAt: string }>,
    count: 0,
    // `note` is an opt-in explanation for the Admin UI — the SPA ignores
    // unknown fields, so this is safe to add.
    note:
      'API key issuance is not yet implemented. This endpoint will return actual keys once the per-tenant key store ships.',
    timestamp: new Date().toISOString(),
  });
});

export default router;
