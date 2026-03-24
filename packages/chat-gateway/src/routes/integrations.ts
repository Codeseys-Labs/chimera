/**
 * Chat platform integration routes
 *
 * Administrative API for managing chat platform integrations:
 * - Add Slack workspace (OAuth install flow)
 * - Add Discord server
 * - Add Microsoft Teams tenant
 * - Manage platform user → Cognito user pairing
 * - Query existing integrations
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import crypto from 'crypto';

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

/**
 * Integration configuration stored in DynamoDB
 */
interface Integration {
  tenantId: string;
  platform: 'slack' | 'discord' | 'teams';
  workspaceId: string; // Slack workspace, Discord server, or Teams tenant
  workspaceName: string;
  accessToken: string; // Encrypted OAuth token
  botUserId: string; // Bot's user ID on the platform
  installedAt: string;
  installedBy: string; // Cognito user sub
  status: 'active' | 'inactive' | 'error';
}

/**
 * Platform user → Cognito user mapping
 */
interface UserPairing {
  tenantId: string;
  platform: 'slack' | 'discord' | 'teams';
  platformUserId: string; // e.g., Slack U12345
  cognitoSub: string; // Cognito user pool sub (uuid)
  pairedAt: string;
}

/**
 * Authorization helper: Check if request is from platform admin
 */
function isPlatformAdmin(req: Request): boolean {
  const adminTenantId = process.env.PLATFORM_ADMIN_TENANT_ID || 'chimera-platform';
  return req.tenantContext?.tenantId === adminTenantId;
}

/**
 * Authorization helper: Check if user can manage integrations for tenant
 */
function canManageIntegrations(req: Request, targetTenantId: string): boolean {
  if (isPlatformAdmin(req)) {
    return true;
  }
  // In production, check if user has admin role for their tenant
  return req.tenantContext?.tenantId === targetTenantId;
}

/**
 * GET /integrations/:tenantId
 *
 * List all chat platform integrations for a tenant
 */
router.get('/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;

    // Authorization: Can only access own tenant integrations or if platform admin
    if (!canManageIntegrations(req, tenantId)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only access your own tenant integrations',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Query integrations from DynamoDB
    // In production: query clawcore-skills table with PK=TENANT#{tenantId} and SK begins_with INTEGRATION#
    const mockIntegrations: Integration[] = [
      {
        tenantId,
        platform: 'slack',
        workspaceId: 'T01234567',
        workspaceName: 'ACME Workspace',
        accessToken: '[encrypted]',
        botUserId: 'U987654321',
        installedAt: '2026-03-15T10:00:00Z',
        installedBy: 'abc-123-cognito-sub',
        status: 'active',
      },
    ];

    res.status(200).json({
      integrations: mockIntegrations.map((i) => ({
        ...i,
        accessToken: undefined, // Never expose token in list view
      })),
      count: mockIntegrations.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('List integrations error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to list integrations',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /integrations/:tenantId/slack
 *
 * Initiate Slack OAuth install flow
 *
 * Request body:
 * {
 *   "redirectUri": "https://your-app.com/admin"
 * }
 *
 * Response:
 * {
 *   "authUrl": "https://slack.com/oauth/v2/authorize?client_id=...&state=..."
 * }
 */
router.post('/:tenantId/slack', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const { redirectUri } = req.body;

    // Authorization
    if (!canManageIntegrations(req, tenantId)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only manage your own tenant integrations',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate redirect URI
    if (!redirectUri || typeof redirectUri !== 'string') {
      res.status(400).json({
        error: {
          code: 'INVALID_REDIRECT_URI',
          message: 'redirectUri is required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
      res.status(500).json({
        error: {
          code: 'CONFIGURATION_ERROR',
          message: 'Slack OAuth not configured',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Generate OAuth state parameter (CSRF protection)
    const state = crypto.randomBytes(32).toString('hex');

    // Store state in DynamoDB with 10-minute TTL
    // PK: OAUTH_STATE#{state}, SK: METADATA, tenantId, userId, createdAt, expiresAt
    // In production: mockDynamoDBClient.put(...)

    // Slack OAuth scopes
    const scopes = [
      'chat:write', // Send messages
      'channels:history', // Read channel messages
      'users:read', // Get user info
      'commands', // Slash commands
    ].join(',');

    const authUrl = new URL('https://slack.com/oauth/v2/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);

    res.status(200).json({
      authUrl: authUrl.toString(),
      state,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Slack OAuth init error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to initiate Slack OAuth',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /integrations/:tenantId/slack/callback
 *
 * Handle Slack OAuth callback
 *
 * Request body:
 * {
 *   "code": "oauth_code_from_slack",
 *   "state": "state_from_init"
 * }
 */
router.post('/:tenantId/slack/callback', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const { code, state } = req.body;

    // Authorization
    if (!canManageIntegrations(req, tenantId)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only manage your own tenant integrations',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate inputs
    if (!code || !state) {
      res.status(400).json({
        error: {
          code: 'MISSING_OAUTH_PARAMS',
          message: 'code and state are required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify state parameter against stored value
    // In production: fetch from DynamoDB and verify tenantId matches
    // const storedState = await mockDynamoDBClient.get({ TableName: '...', Key: { PK: `OAUTH_STATE#${state}` } });

    // Exchange code for access token
    // In production: POST to https://slack.com/api/oauth.v2.access
    // const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', { ... });

    // Mock response
    const mockTokenResponse = {
      ok: true,
      access_token: 'xoxb-mock-token',
      team: {
        id: 'T01234567',
        name: 'ACME Workspace',
      },
      authed_user: {
        id: 'U987654321',
      },
    };

    // Store integration in DynamoDB
    // PK: TENANT#{tenantId}, SK: INTEGRATION#slack#{workspaceId}
    const integration: Integration = {
      tenantId,
      platform: 'slack',
      workspaceId: mockTokenResponse.team.id,
      workspaceName: mockTokenResponse.team.name,
      accessToken: mockTokenResponse.access_token, // Encrypt before storing
      botUserId: mockTokenResponse.authed_user.id,
      installedAt: new Date().toISOString(),
      installedBy: req.tenantContext?.userId || 'unknown',
      status: 'active',
    };

    // In production: mockDynamoDBClient.put({ TableName: 'clawcore-skills', Item: { ... } });

    res.status(201).json({
      integration: {
        ...integration,
        accessToken: undefined, // Never expose token in response
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Slack OAuth callback error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to complete Slack OAuth',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * DELETE /integrations/:tenantId/slack/:workspaceId
 *
 * Remove Slack integration
 */
router.delete('/:tenantId/slack/:workspaceId', async (req: Request, res: Response) => {
  try {
    const { tenantId, workspaceId } = req.params;

    // Authorization
    if (!canManageIntegrations(req, tenantId)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only manage your own tenant integrations',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Delete from DynamoDB
    // In production: mockDynamoDBClient.delete({ TableName: 'clawcore-skills', Key: { PK: `TENANT#${tenantId}`, SK: `INTEGRATION#slack#${workspaceId}` } });

    res.status(200).json({
      message: 'Integration removed',
      tenantId,
      workspaceId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Delete integration error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to delete integration',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /integrations/:tenantId/users
 *
 * List platform user → Cognito user pairings
 */
router.get('/:tenantId/users', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const { platform } = req.query;

    // Authorization
    if (!canManageIntegrations(req, tenantId)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only access your own tenant user pairings',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Query user pairings from DynamoDB
    // In production: query table with PK=TENANT#{tenantId} and SK begins_with USER_PAIRING#
    // Optional filter by platform
    const mockPairings: UserPairing[] = [
      {
        tenantId,
        platform: 'slack',
        platformUserId: 'U12345',
        cognitoSub: 'abc-123-cognito-sub',
        pairedAt: '2026-03-15T11:00:00Z',
      },
    ];

    const filtered = platform
      ? mockPairings.filter((p) => p.platform === platform)
      : mockPairings;

    res.status(200).json({
      pairings: filtered,
      count: filtered.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('List user pairings error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to list user pairings',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /integrations/:tenantId/users
 *
 * Create platform user → Cognito user pairing
 *
 * Request body:
 * {
 *   "platform": "slack",
 *   "platformUserId": "U12345",
 *   "cognitoSub": "abc-123-cognito-sub"
 * }
 */
router.post('/:tenantId/users', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const { platform, platformUserId, cognitoSub } = req.body;

    // Authorization
    if (!canManageIntegrations(req, tenantId)) {
      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: 'You can only manage your own tenant user pairings',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate inputs
    if (!platform || !platformUserId || !cognitoSub) {
      res.status(400).json({
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'Required fields: platform, platformUserId, cognitoSub',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate platform
    const validPlatforms = ['slack', 'discord', 'teams'];
    if (!validPlatforms.includes(platform)) {
      res.status(400).json({
        error: {
          code: 'INVALID_PLATFORM',
          message: `Platform must be one of: ${validPlatforms.join(', ')}`,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check if pairing already exists
    // In production: query DynamoDB for existing pairing

    const pairing: UserPairing = {
      tenantId,
      platform,
      platformUserId,
      cognitoSub,
      pairedAt: new Date().toISOString(),
    };

    // Store in DynamoDB
    // PK: TENANT#{tenantId}, SK: USER_PAIRING#{platform}#{platformUserId}
    // In production: mockDynamoDBClient.put({ TableName: 'clawcore-skills', Item: { ... } });

    res.status(201).json({
      pairing,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Create user pairing error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to create user pairing',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * DELETE /integrations/:tenantId/users/:platform/:platformUserId
 *
 * Remove platform user → Cognito user pairing
 */
router.delete(
  '/:tenantId/users/:platform/:platformUserId',
  async (req: Request, res: Response) => {
    try {
      const { tenantId, platform, platformUserId } = req.params;

      // Authorization
      if (!canManageIntegrations(req, tenantId)) {
        res.status(403).json({
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: 'You can only manage your own tenant user pairings',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Delete from DynamoDB
      // In production: mockDynamoDBClient.delete({ TableName: 'clawcore-skills', Key: { PK: `TENANT#${tenantId}`, SK: `USER_PAIRING#${platform}#${platformUserId}` } });

      res.status(200).json({
        message: 'User pairing removed',
        tenantId,
        platform,
        platformUserId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Delete user pairing error:', error);
      res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to delete user pairing',
        },
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * POST /integrations/resolve-user
 *
 * Resolve platform user ID to Cognito sub
 *
 * This is used by chat webhook handlers (Slack, Discord, Teams) to map
 * incoming platform user IDs to Cognito users for permission enforcement.
 *
 * Request body:
 * {
 *   "tenantId": "acme-corp",
 *   "platform": "slack",
 *   "platformUserId": "U12345"
 * }
 *
 * Response:
 * {
 *   "cognitoSub": "abc-123-cognito-sub",
 *   "found": true
 * }
 */
router.post('/resolve-user', async (req: Request, res: Response) => {
  try {
    const { tenantId, platform, platformUserId } = req.body;

    // Validate inputs
    if (!tenantId || !platform || !platformUserId) {
      res.status(400).json({
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'Required fields: tenantId, platform, platformUserId',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Query DynamoDB for user pairing
    // In production: mockDynamoDBClient.get({ TableName: 'clawcore-skills', Key: { PK: `TENANT#${tenantId}`, SK: `USER_PAIRING#${platform}#${platformUserId}` } });

    // Mock response
    const mockPairing: UserPairing | null = {
      tenantId,
      platform,
      platformUserId,
      cognitoSub: 'abc-123-cognito-sub',
      pairedAt: '2026-03-15T11:00:00Z',
    };

    if (!mockPairing) {
      res.status(200).json({
        found: false,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({
      cognitoSub: mockPairing.cognitoSub,
      found: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Resolve user error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to resolve user',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
