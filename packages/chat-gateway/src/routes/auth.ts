/**
 * Authentication routes for Cognito OAuth flow
 *
 * Implements OAuth2 PKCE authorization code flow with Cognito.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { authenticateJWT } from '../middleware/auth';
import type { AuthContext } from '../middleware/auth';
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  ListUsersCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const router = new Hono();

// Module-level singleton Cognito client (reused across all requests)
const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

// Cognito OAuth configuration
const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN; // e.g., chimera-dev-123456789.auth.us-east-1.amazoncognito.com
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_REGION = process.env.AWS_REGION || 'us-east-1';
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost:8080/auth/callback';

/**
 * GET /auth/config
 *
 * Returns OAuth configuration for the frontend.
 * Public endpoint (no auth required).
 */
router.get('/config', (c: Context) => {
  if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
    return c.json(
      {
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'OAuth not configured',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }

  const oauthUrl = `https://${COGNITO_DOMAIN}.auth.${COGNITO_REGION}.amazoncognito.com`;

  return c.json({
    domain: COGNITO_DOMAIN,
    region: COGNITO_REGION,
    clientId: COGNITO_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    oauthUrl: oauthUrl,
    authorizationEndpoint: `${oauthUrl}/oauth2/authorize`,
    tokenEndpoint: `${oauthUrl}/oauth2/token`,
    userInfoEndpoint: `${oauthUrl}/oauth2/userInfo`,
    logoutEndpoint: `${oauthUrl}/logout`,
  });
});

/**
 * POST /auth/exchange
 *
 * Exchanges authorization code for tokens.
 * Called by frontend after OAuth callback.
 *
 * Body: { code: string, codeVerifier: string }
 * Returns: { access_token, id_token, refresh_token, expires_in }
 */
router.post('/exchange', async (c: Context) => {
  try {
    const body = await c.req.json();
    const { code, codeVerifier } = body as { code?: string; codeVerifier?: string };

    if (!code || !codeVerifier) {
      return c.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing code or codeVerifier',
          },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
      return c.json(
        {
          error: {
            code: 'AUTH_NOT_CONFIGURED',
            message: 'OAuth not configured',
          },
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    // Exchange authorization code for tokens
    const tokenUrl = `https://${COGNITO_DOMAIN}.auth.${COGNITO_REGION}.amazoncognito.com/oauth2/token`;

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: COGNITO_CLIENT_ID,
      code: code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!tokenResponse.ok) {
      const errorData = (await tokenResponse.json().catch(() => ({}))) as {
        error_description?: string;
      };
      console.error('Token exchange failed:', errorData);
      return c.json(
        {
          error: {
            code: 'TOKEN_EXCHANGE_FAILED',
            message: errorData.error_description || 'Failed to exchange authorization code',
            details: errorData,
          },
          timestamp: new Date().toISOString(),
        },
        tokenResponse.status as any
      );
    }

    const tokens = await tokenResponse.json();
    return c.json(tokens);
  } catch (error) {
    console.error('Token exchange error:', error);
    return c.json(
      {
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Token exchange failed',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * GET /auth/user
 *
 * Returns authenticated user info from JWT claims.
 * Requires valid access token.
 */
router.get('/user', authenticateJWT, (c: Context) => {
  const auth = c.get('auth') as AuthContext;

  return c.json({
    sub: auth.sub,
    email: auth.email,
    tenantId: auth.tenantId,
    tenantTier: auth.tenantTier,
    groups: auth.groups || [],
  });
});

/**
 * POST /auth/refresh
 *
 * Refreshes access token using refresh token.
 *
 * Body: { refreshToken: string }
 * Returns: { access_token, id_token, expires_in }
 */
router.post('/refresh', async (c: Context) => {
  try {
    const body = await c.req.json();
    const { refreshToken } = body as { refreshToken?: string };

    if (!refreshToken) {
      return c.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing refreshToken',
          },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
      return c.json(
        {
          error: {
            code: 'AUTH_NOT_CONFIGURED',
            message: 'OAuth not configured',
          },
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    const tokenUrl = `https://${COGNITO_DOMAIN}.auth.${COGNITO_REGION}.amazoncognito.com/oauth2/token`;

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: COGNITO_CLIENT_ID,
      refresh_token: refreshToken,
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!tokenResponse.ok) {
      const errorData = (await tokenResponse.json().catch(() => ({}))) as {
        error_description?: string;
      };
      console.error('Token refresh failed:', errorData);
      return c.json(
        {
          error: {
            code: 'TOKEN_REFRESH_FAILED',
            message: errorData.error_description || 'Failed to refresh token',
            details: errorData,
          },
          timestamp: new Date().toISOString(),
        },
        tokenResponse.status as any
      );
    }

    const tokens = await tokenResponse.json();
    return c.json(tokens);
  } catch (error) {
    console.error('Token refresh error:', error);
    return c.json(
      {
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Token refresh failed',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * POST /auth/register
 *
 * Self-registration is disabled. The Cognito user pool has self-signup turned off,
 * so the SignUp API will always reject requests. Return a clear error directing
 * callers to contact their administrator for account provisioning.
 */
router.post('/register', (c: Context) => {
  return c.json(
    {
      error: {
        code: 'REGISTRATION_DISABLED',
        message: 'Self-registration is disabled. Contact your administrator.',
      },
      timestamp: new Date().toISOString(),
    },
    403
  );
});

/**
 * POST /auth/confirm-signup
 *
 * Confirm user email with code sent during registration.
 *
 * Body: { email: string, code: string }
 * Returns: { success: true }
 */
router.post('/confirm-signup', async (c: Context) => {
  try {
    const body = await c.req.json();
    const { email, code } = body as { email?: string; code?: string };

    if (!email || !code) {
      return c.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing email or code',
          },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    if (!COGNITO_CLIENT_ID) {
      return c.json(
        {
          error: {
            code: 'AUTH_NOT_CONFIGURED',
            message: 'Cognito not configured',
          },
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    const command = new ConfirmSignUpCommand({
      ClientId: COGNITO_CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
    });

    await cognitoClient.send(command);

    return c.json({
      success: true,
      message: 'Email confirmed successfully. You can now log in.',
    });
  } catch (error: any) {
    console.error('Confirmation error:', error);

    if (error.name === 'CodeMismatchException') {
      return c.json(
        {
          error: {
            code: 'INVALID_CODE',
            message: 'Invalid confirmation code',
          },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    if (error.name === 'ExpiredCodeException') {
      return c.json(
        {
          error: {
            code: 'EXPIRED_CODE',
            message: 'Confirmation code has expired. Request a new code.',
          },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    if (error.name === 'UserNotFoundException') {
      return c.json(
        {
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found',
          },
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    return c.json(
      {
        error: {
          code: 'CONFIRMATION_FAILED',
          message: 'Confirmation failed',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * POST /auth/resend-code
 *
 * Resend confirmation code if user didn't receive it or code expired.
 *
 * Body: { email: string }
 * Returns: { codeDeliveryDetails: {...} }
 */
router.post('/resend-code', async (c: Context) => {
  try {
    const body = await c.req.json();
    const { email } = body as { email?: string };

    if (!email) {
      return c.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing email',
          },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    if (!COGNITO_CLIENT_ID) {
      return c.json(
        {
          error: {
            code: 'AUTH_NOT_CONFIGURED',
            message: 'Cognito not configured',
          },
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    const command = new ResendConfirmationCodeCommand({
      ClientId: COGNITO_CLIENT_ID,
      Username: email,
    });

    const response = await cognitoClient.send(command);

    return c.json({
      codeDeliveryDetails: response.CodeDeliveryDetails,
      message: 'Confirmation code resent successfully.',
    });
  } catch (error: any) {
    console.error('Resend code error:', error);

    if (error.name === 'UserNotFoundException') {
      return c.json(
        {
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found',
          },
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    if (error.name === 'InvalidParameterException') {
      return c.json(
        {
          error: {
            code: 'INVALID_PARAMETER',
            message: 'User is already confirmed',
          },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    return c.json(
      {
        error: {
          code: 'RESEND_FAILED',
          message: 'Failed to resend confirmation code',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * GET /auth/admin/users
 *
 * List all users in the Cognito user pool.
 * Requires admin authentication.
 */
router.get('/admin/users', authenticateJWT, async (c: Context) => {
  try {
    const auth = c.get('auth') as AuthContext;

    // Check if user is admin
    if (!auth?.groups?.includes('admin')) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Admin access required',
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
            message: 'Cognito not configured',
          },
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    const command = new ListUsersCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Limit: 60,
    });

    const response = await cognitoClient.send(command);

    return c.json({
      users:
        response.Users?.map((user: any) => ({
          username: user.Username,
          email: user.Attributes?.find((attr: any) => attr.Name === 'email')?.Value,
          name: user.Attributes?.find((attr: any) => attr.Name === 'name')?.Value,
          tenantId: user.Attributes?.find((attr: any) => attr.Name === 'custom:tenant_id')?.Value,
          tenantTier: user.Attributes?.find((attr: any) => attr.Name === 'custom:tenant_tier')
            ?.Value,
          enabled: user.Enabled,
          status: user.UserStatus,
          created: user.UserCreateDate,
          modified: user.UserLastModifiedDate,
        })) || [],
      paginationToken: response.PaginationToken,
    });
  } catch (error: any) {
    console.error('List users error:', error);
    return c.json(
      {
        error: {
          code: 'LIST_USERS_FAILED',
          message: 'Failed to list users',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * POST /auth/admin/users/:username/disable
 *
 * Disable a user account.
 * Requires admin authentication.
 */
router.post('/admin/users/:username/disable', authenticateJWT, async (c: Context) => {
  try {
    const auth = c.get('auth') as AuthContext;
    const username = c.req.param('username');

    // Check if user is admin
    if (!auth?.groups?.includes('admin')) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Admin access required',
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
            message: 'Cognito not configured',
          },
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    const command = new AdminDisableUserCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: username,
    });

    await cognitoClient.send(command);

    return c.json({
      success: true,
      message: `User ${username} has been disabled`,
    });
  } catch (error: any) {
    console.error('Disable user error:', error);

    if (error.name === 'UserNotFoundException') {
      return c.json(
        {
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found',
          },
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    return c.json(
      {
        error: {
          code: 'DISABLE_USER_FAILED',
          message: 'Failed to disable user',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * POST /auth/admin/users/:username/enable
 *
 * Enable a previously disabled user account.
 * Requires admin authentication.
 */
router.post('/admin/users/:username/enable', authenticateJWT, async (c: Context) => {
  try {
    const auth = c.get('auth') as AuthContext;
    const username = c.req.param('username');

    // Check if user is admin
    if (!auth?.groups?.includes('admin')) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Admin access required',
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
            message: 'Cognito not configured',
          },
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    const command = new AdminEnableUserCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: username,
    });

    await cognitoClient.send(command);

    return c.json({
      success: true,
      message: `User ${username} has been enabled`,
    });
  } catch (error: any) {
    console.error('Enable user error:', error);

    if (error.name === 'UserNotFoundException') {
      return c.json(
        {
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found',
          },
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    return c.json(
      {
        error: {
          code: 'ENABLE_USER_FAILED',
          message: 'Failed to enable user',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

/**
 * PATCH /auth/admin/users/:username/tenant
 *
 * Update user's tenant assignment.
 * Requires admin authentication.
 *
 * Body: { tenantId: string, tenantTier?: string }
 */
router.patch('/admin/users/:username/tenant', authenticateJWT, async (c: Context) => {
  try {
    const auth = c.get('auth') as AuthContext;
    const username = c.req.param('username');
    const body = await c.req.json();
    const { tenantId, tenantTier } = body as { tenantId?: string; tenantTier?: string };

    // Check if user is admin
    if (!auth?.groups?.includes('admin')) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Admin access required',
          },
          timestamp: new Date().toISOString(),
        },
        403
      );
    }

    if (!tenantId) {
      return c.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing tenantId',
          },
          timestamp: new Date().toISOString(),
        },
        400
      );
    }

    if (!COGNITO_USER_POOL_ID) {
      return c.json(
        {
          error: {
            code: 'AUTH_NOT_CONFIGURED',
            message: 'Cognito not configured',
          },
          timestamp: new Date().toISOString(),
        },
        500
      );
    }

    const attributes = [{ Name: 'custom:tenant_id', Value: tenantId }];

    if (tenantTier) {
      attributes.push({ Name: 'custom:tenant_tier', Value: tenantTier });
    }

    const command = new AdminUpdateUserAttributesCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: username,
      UserAttributes: attributes,
    });

    await cognitoClient.send(command);

    return c.json({
      success: true,
      message: `User ${username} tenant updated`,
      tenantId,
      tenantTier,
    });
  } catch (error: any) {
    console.error('Update tenant error:', error);

    if (error.name === 'UserNotFoundException') {
      return c.json(
        {
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found',
          },
          timestamp: new Date().toISOString(),
        },
        404
      );
    }

    return c.json(
      {
        error: {
          code: 'UPDATE_TENANT_FAILED',
          message: 'Failed to update user tenant',
        },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
});

export default router;
