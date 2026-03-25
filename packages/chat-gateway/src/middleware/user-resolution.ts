/**
 * User resolution middleware
 *
 * Resolves chat platform user IDs to Cognito user identities.
 * When a message arrives from Slack/Discord/Teams, this middleware:
 * 1. Extracts platform user ID from request
 * 2. Looks up user pairing in DynamoDB
 * 3. Attaches resolved Cognito user context to Hono context
 * 4. Falls back to platform user ID if no pairing exists (development mode)
 */

import { Context, Next } from 'hono';
import { UserPairingService } from '@chimera/core';
import { TenantContext } from '../types';

// Mock DynamoDB client for development
interface DynamoDBClient {
  get(params: any): Promise<any>;
  put(params: any): Promise<any>;
  update(params: any): Promise<any>;
  delete(params: any): Promise<any>;
  query(params: any): Promise<any>;
}

const mockDynamoDBClient: DynamoDBClient = {
  async get() {
    return { Item: null };
  },
  async put() {
    return {};
  },
  async update() {
    return {};
  },
  async delete() {
    return {};
  },
  async query() {
    return { Items: [] };
  },
};

// Initialize user pairing service (should be injected via DI in production)
const userPairingService = new UserPairingService({
  pairingsTableName: process.env.USER_PAIRINGS_TABLE_NAME || 'chimera-user-pairings',
  dynamodb: mockDynamoDBClient,
});

/**
 * Extract platform and user ID from Slack request
 */
async function extractSlackUser(
  c: Context
): Promise<{ platform: 'slack'; platformUserId: string } | null> {
  try {
    const body = await c.req.json();
    if (body?.event?.user) {
      return { platform: 'slack', platformUserId: body.event.user };
    }
    if (body?.user_id) {
      return { platform: 'slack', platformUserId: body.user_id };
    }
  } catch {
    // Body may not be JSON (e.g. form-urlencoded slash commands)
  }
  return null;
}

/**
 * Extract platform and user ID from Discord request
 */
async function extractDiscordUser(
  c: Context
): Promise<{ platform: 'discord'; platformUserId: string } | null> {
  try {
    const body = await c.req.json();
    if (body?.author?.id) {
      return { platform: 'discord', platformUserId: body.author.id };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Extract platform and user ID from Teams request
 */
async function extractTeamsUser(
  c: Context
): Promise<{ platform: 'teams'; platformUserId: string } | null> {
  try {
    const body = await c.req.json();
    if (body?.from?.id) {
      return { platform: 'teams', platformUserId: body.from.id };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Resolve platform user to Cognito user
 *
 * Middleware that looks up user pairings and attaches resolved context.
 * If no pairing exists, falls back to platform user ID (for development).
 *
 * Usage:
 *   router.post('/slack/events', resolveUser, async (c: Context) => {
 *     const userContext = c.get('userContext');
 *     // userContext.cognitoSub, userContext.email, etc.
 *   });
 */
export async function resolveUser(c: Context, next: Next): Promise<void | Response> {
  try {
    // Extract platform user based on request path
    let platformUser: { platform: any; platformUserId: string } | null = null;

    const path = c.req.path;
    if (path.includes('/slack')) {
      platformUser = await extractSlackUser(c);
    } else if (path.includes('/discord')) {
      platformUser = await extractDiscordUser(c);
    } else if (path.includes('/teams')) {
      platformUser = await extractTeamsUser(c);
    }

    // If we couldn't extract platform user, skip resolution
    if (!platformUser) {
      await next();
      return;
    }

    // Look up user pairing
    const userContext = await userPairingService.resolveUser({
      platform: platformUser.platform,
      platformUserId: platformUser.platformUserId,
    });

    if (userContext) {
      // Pairing found - attach resolved context
      c.set('userContext', userContext);

      // Update last activity timestamp (fire and forget)
      userPairingService.updatePairing({
        platform: platformUser.platform,
        platformUserId: platformUser.platformUserId,
        lastActivityAt: new Date().toISOString(),
      }).catch(err => {
        console.error('Failed to update last activity:', err);
      });
    } else {
      // No pairing found - in development mode, create a placeholder context
      // In production, this should return 401 or trigger auto-pairing flow
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `No user pairing found for ${platformUser.platform} user ${platformUser.platformUserId} - using fallback context`
        );

        // Fallback context (requires tenantContext to be set by previous middleware)
        const tenantContext = c.get('tenantContext') as TenantContext | undefined;
        if (tenantContext) {
          c.set('userContext', {
            tenantId: tenantContext.tenantId,
            cognitoSub: `dev-${platformUser.platform}-${platformUser.platformUserId}`,
            cognitoUsername: `dev-${platformUser.platformUserId}`,
            email: `${platformUser.platformUserId}@dev.chimera.local`,
            platform: platformUser.platform,
            platformUserId: platformUser.platformUserId,
          });
        }
      } else {
        // Production: return 401 if no pairing exists
        return c.json({
          error: {
            code: 'USER_NOT_PAIRED',
            message:
              'This platform user is not linked to a Chimera account. Please complete the authentication flow.',
          },
          timestamp: new Date().toISOString(),
        }, 401);
      }
    }

    await next();
  } catch (error) {
    console.error('User resolution error:', error);

    // Fail open in development, fail closed in production
    if (process.env.NODE_ENV === 'production') {
      return c.json({
        error: {
          code: 'USER_RESOLUTION_ERROR',
          message: 'Failed to resolve user identity',
        },
        timestamp: new Date().toISOString(),
      }, 500);
    }

    // Development: continue without user context
    await next();
  }
}

/**
 * Require user resolution (enforces pairing)
 *
 * Middleware that requires a resolved user context.
 * Returns 401 if no user context is available.
 *
 * Usage:
 *   router.post('/slack/events', resolveUser, requireUserContext, async (c: Context) => {
 *     // c.get('userContext') is guaranteed to exist
 *   });
 */
export async function requireUserContext(c: Context, next: Next): Promise<void | Response> {
  if (!c.get('userContext')) {
    return c.json({
      error: {
        code: 'USER_CONTEXT_REQUIRED',
        message: 'User authentication is required for this endpoint',
      },
      timestamp: new Date().toISOString(),
    }, 401);
  }

  await next();
}
