/**
 * JWT authentication middleware for Cognito tokens
 *
 * Verifies Cognito JWT tokens and extracts tenant/user context.
 * Uses aws-jwt-verify for secure token validation.
 */

import { Context, Next } from 'hono';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

// Cognito configuration from environment
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// JWT verifier instance (cached for performance)
const verifier =
  USER_POOL_ID && CLIENT_ID
    ? CognitoJwtVerifier.create({
        userPoolId: USER_POOL_ID,
        tokenUse: 'id',
        clientId: CLIENT_ID,
      })
    : null;

// Auth context type (stored in Hono context)
export interface AuthContext {
  sub: string; // Cognito user ID (UUID)
  email?: string;
  tenantId: string; // From custom:tenant_id claim
  tenantTier?: string; // From custom:tenant_tier claim
  groups?: string[]; // Cognito user pool groups
}

/**
 * Extract Bearer token from Authorization header
 */
function extractToken(c: Context): string | null {
  const authHeader = c.req.header('authorization');
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  return parts[1];
}

/**
 * JWT authentication middleware
 *
 * Validates Cognito JWT tokens and populates context with auth data.
 * Fails closed: rejects requests when tokens are invalid or verification fails.
 *
 * Usage:
 *   app.use('/chat/*', authenticateJWT);
 *   app.use('/admin/*', authenticateJWT);
 */
export async function authenticateJWT(c: Context, next: Next): Promise<Response | void> {
  try {
    // Dev/test bypass: when Cognito is not configured and NODE_ENV is dev/test,
    // accept X-Tenant-Id + X-User-Id headers as auth context. This enables
    // integration tests and local development without a real Cognito user pool.
    if (!verifier) {
      const isDevOrTest =
        process.env.NODE_ENV === 'development' ||
        process.env.NODE_ENV === 'test' ||
        process.env.CHIMERA_ENV === 'dev';

      if (isDevOrTest) {
        const tenantId = c.req.header('x-tenant-id');
        const userId = c.req.header('x-user-id') || 'dev-user';
        if (tenantId) {
          c.set('auth', {
            sub: userId,
            tenantId,
            tenantTier: c.req.header('x-tenant-tier') || 'basic',
          });
          await next();
          return;
        }
        // No tenant header either — fall through to 401
      }
    }

    // Extract token
    const token = extractToken(c);
    if (!token) {
      return c.json(
        {
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid Authorization header',
          },
          timestamp: new Date().toISOString(),
        },
        401
      );
    }

    // Verify configuration
    if (!verifier) {
      console.error(
        'JWT verifier not configured: missing COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID'
      );
      return c.json(
        {
          error: {
            code: 'AUTH_NOT_CONFIGURED',
            message: 'Authentication service unavailable',
          },
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    // Verify token
    const payload = await verifier.verify(token);

    // Extract custom claims
    // Admin users created via `chimera setup` may not have custom:tenant_id set;
    // fall back to sub so they still receive a valid auth context.
    const customTenantId = payload['custom:tenant_id'];
    const tenantId =
      typeof customTenantId === 'string' && customTenantId ? customTenantId : payload.sub;

    // Populate auth context in Hono context
    c.set('auth', {
      sub: payload.sub,
      email: payload.email as string | undefined,
      tenantId: tenantId,
      tenantTier: payload['custom:tenant_tier'] as string | undefined,
      groups: payload['cognito:groups'] as string[] | undefined,
    });

    await next();
  } catch (error) {
    // Token verification failed
    console.error('JWT verification failed:', error);
    return c.json(
      {
        error: {
          code: 'INVALID_TOKEN',
          message: 'Token verification failed',
        },
        timestamp: new Date().toISOString(),
      },
      401
    );
  }
}

/**
 * Require specific Cognito group membership
 *
 * Usage:
 *   app.post('/admin/users', authenticateJWT, requireGroup('admin'));
 */
export function requireGroup(...allowedGroups: string[]) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const auth = c.get('auth') as AuthContext | undefined;

    if (!auth) {
      return c.json(
        {
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          },
          timestamp: new Date().toISOString(),
        },
        401
      );
    }

    const userGroups = auth.groups || [];
    const hasAccess = allowedGroups.some((group) => userGroups.includes(group));

    if (!hasAccess) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: `Required group: ${allowedGroups.join(' or ')}`,
          },
          timestamp: new Date().toISOString(),
        },
        403
      );
    }

    await next();
  };
}

/**
 * Optional authentication middleware
 *
 * Validates token if present, but allows requests without tokens.
 * Useful for endpoints that support both authenticated and anonymous access.
 */
export async function optionalAuth(c: Context, next: Next): Promise<void> {
  const token = extractToken(c);
  if (!token) {
    await next();
    return;
  }

  try {
    if (verifier) {
      const payload = await verifier.verify(token);
      // Fall back to sub for admin users without custom:tenant_id
      const customTenantId = payload['custom:tenant_id'];
      const tenantId =
        typeof customTenantId === 'string' && customTenantId ? customTenantId : payload.sub;

      c.set('auth', {
        sub: payload.sub,
        email: payload.email as string | undefined,
        tenantId: tenantId,
        tenantTier: payload['custom:tenant_tier'] as string | undefined,
        groups: payload['cognito:groups'] as string[] | undefined,
      });
    }
  } catch (error) {
    // Ignore verification errors for optional auth
    console.warn('Optional auth token verification failed:', error);
  }

  await next();
}
