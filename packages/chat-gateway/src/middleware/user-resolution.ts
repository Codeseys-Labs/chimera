/**
 * User resolution middleware
 *
 * Resolves chat platform user IDs to Cognito user identities.
 * When a message arrives from Slack/Discord/Teams, this middleware:
 * 1. Extracts platform user ID from request
 * 2. Looks up user pairing in DynamoDB
 * 3. Attaches resolved Cognito user context to request
 * 4. Falls back to platform user ID if no pairing exists (development mode)
 */

import { Request, Response, NextFunction } from 'express';
import { UserPairingService, type ResolvedUserContext } from '@chimera/core';

// Augment Express Request to include user context
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userContext?: ResolvedUserContext;
    }
  }
}

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
function extractSlackUser(req: Request): { platform: 'slack'; platformUserId: string } | null {
  // Event callback (message events)
  if (req.body?.event?.user) {
    return {
      platform: 'slack',
      platformUserId: req.body.event.user,
    };
  }

  // Slash command
  if (req.body?.user_id) {
    return {
      platform: 'slack',
      platformUserId: req.body.user_id,
    };
  }

  return null;
}

/**
 * Extract platform and user ID from Discord request
 */
function extractDiscordUser(req: Request): { platform: 'discord'; platformUserId: string } | null {
  // Discord webhook
  if (req.body?.author?.id) {
    return {
      platform: 'discord',
      platformUserId: req.body.author.id,
    };
  }

  return null;
}

/**
 * Extract platform and user ID from Teams request
 */
function extractTeamsUser(req: Request): { platform: 'teams'; platformUserId: string } | null {
  // Teams webhook
  if (req.body?.from?.id) {
    return {
      platform: 'teams',
      platformUserId: req.body.from.id,
    };
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
 *   router.post('/slack/events', resolveUser, async (req, res) => {
 *     const userContext = req.userContext;
 *     // userContext.cognitoSub, userContext.email, etc.
 *   });
 */
export async function resolveUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Extract platform user based on request path
    let platformUser: { platform: any; platformUserId: string } | null = null;

    if (req.path.includes('/slack')) {
      platformUser = extractSlackUser(req);
    } else if (req.path.includes('/discord')) {
      platformUser = extractDiscordUser(req);
    } else if (req.path.includes('/teams')) {
      platformUser = extractTeamsUser(req);
    }

    // If we couldn't extract platform user, skip resolution
    if (!platformUser) {
      next();
      return;
    }

    // Look up user pairing
    const userContext = await userPairingService.resolveUser({
      platform: platformUser.platform,
      platformUserId: platformUser.platformUserId,
    });

    if (userContext) {
      // Pairing found - attach resolved context
      req.userContext = userContext;

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
        if (req.tenantContext) {
          req.userContext = {
            tenantId: req.tenantContext.tenantId,
            cognitoSub: `dev-${platformUser.platform}-${platformUser.platformUserId}`,
            cognitoUsername: `dev-${platformUser.platformUserId}`,
            email: `${platformUser.platformUserId}@dev.chimera.local`,
            platform: platformUser.platform,
            platformUserId: platformUser.platformUserId,
          };
        }
      } else {
        // Production: return 401 if no pairing exists
        res.status(401).json({
          error: {
            code: 'USER_NOT_PAIRED',
            message:
              'This platform user is not linked to a Chimera account. Please complete the authentication flow.',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    next();
  } catch (error) {
    console.error('User resolution error:', error);

    // Fail open in development, fail closed in production
    if (process.env.NODE_ENV === 'production') {
      res.status(500).json({
        error: {
          code: 'USER_RESOLUTION_ERROR',
          message: 'Failed to resolve user identity',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Development: continue without user context
    next();
  }
}

/**
 * Require user resolution (enforces pairing)
 *
 * Middleware that requires a resolved user context.
 * Returns 401 if no user context is available.
 *
 * Usage:
 *   router.post('/slack/events', resolveUser, requireUserContext, async (req, res) => {
 *     // req.userContext is guaranteed to exist
 *   });
 */
export function requireUserContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.userContext) {
    res.status(401).json({
      error: {
        code: 'USER_CONTEXT_REQUIRED',
        message: 'User authentication is required for this endpoint',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  next();
}
