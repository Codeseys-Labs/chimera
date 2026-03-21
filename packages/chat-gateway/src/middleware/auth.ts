/**
 * JWT authentication middleware for Cognito tokens
 *
 * Verifies Cognito JWT tokens and extracts tenant/user context.
 * Uses aws-jwt-verify for secure token validation.
 */

import { Request, Response, NextFunction } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

// Cognito configuration from environment
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// JWT verifier instance (cached for performance)
const verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: 'access',
      clientId: CLIENT_ID,
    })
  : null;

// Extend Express Request to include auth context
export interface AuthenticatedRequest extends Request {
  auth?: {
    sub: string; // Cognito user ID (UUID)
    email?: string;
    tenantId: string; // From custom:tenant_id claim
    tenantTier?: string; // From custom:tenant_tier claim
    groups?: string[]; // Cognito user pool groups
  };
}

/**
 * Extract Bearer token from Authorization header
 */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  return parts[1];
}

/**
 * JWT authentication middleware
 *
 * Validates Cognito JWT tokens and populates req.auth with user context.
 * Fails closed: rejects requests when tokens are invalid or verification fails.
 *
 * Usage:
 *   app.use('/chat', authenticateJWT);
 *   app.use('/admin', authenticateJWT, requireGroup('admin'));
 */
export async function authenticateJWT(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Extract token
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or invalid Authorization header',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify configuration
    if (!verifier) {
      console.error('JWT verifier not configured: missing COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID');
      res.status(500).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Authentication service unavailable',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify token
    const payload = await verifier.verify(token);

    // Extract custom claims
    const tenantId = payload['custom:tenant_id'];
    if (!tenantId || typeof tenantId !== 'string') {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Token missing required tenant_id claim',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Populate auth context
    const authReq = req as AuthenticatedRequest;
    authReq.auth = {
      sub: payload.sub,
      email: payload.email as string | undefined,
      tenantId: tenantId,
      tenantTier: payload['custom:tenant_tier'] as string | undefined,
      groups: payload['cognito:groups'] as string[] | undefined,
    };

    next();
  } catch (error) {
    // Token verification failed
    console.error('JWT verification failed:', error);
    res.status(401).json({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Token verification failed',
      },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Require specific Cognito group membership
 *
 * Usage:
 *   app.post('/admin/users', authenticateJWT, requireGroup('admin'), handler);
 */
export function requireGroup(...allowedGroups: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;

    if (!authReq.auth) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const userGroups = authReq.auth.groups || [];
    const hasAccess = allowedGroups.some((group) => userGroups.includes(group));

    if (!hasAccess) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `Required group: ${allowedGroups.join(' or ')}`,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}

/**
 * Optional authentication middleware
 *
 * Validates token if present, but allows requests without tokens.
 * Useful for endpoints that support both authenticated and anonymous access.
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    if (verifier) {
      const payload = await verifier.verify(token);
      const tenantId = payload['custom:tenant_id'];

      if (tenantId && typeof tenantId === 'string') {
        const authReq = req as AuthenticatedRequest;
        authReq.auth = {
          sub: payload.sub,
          email: payload.email as string | undefined,
          tenantId: tenantId,
          tenantTier: payload['custom:tenant_tier'] as string | undefined,
          groups: payload['cognito:groups'] as string[] | undefined,
        };
      }
    }
  } catch (error) {
    // Ignore verification errors for optional auth
    console.warn('Optional auth token verification failed:', error);
  }

  next();
}
