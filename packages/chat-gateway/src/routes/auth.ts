/**
 * Authentication routes for Cognito OAuth flow
 *
 * Implements OAuth2 PKCE authorization code flow with Cognito.
 */

import { Router, Request, Response } from 'express';
import { authenticateJWT, AuthenticatedRequest } from '../middleware/auth';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  ListUsersCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const router = Router();

// Initialize Cognito client
const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

// Cognito OAuth configuration
const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN; // e.g., chimera-dev-123456789.auth.us-east-1.amazoncognito.com
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_REGION = process.env.AWS_REGION || 'us-east-1';
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost:8080/auth/callback';
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'default';

/**
 * GET /auth/config
 *
 * Returns OAuth configuration for the frontend.
 * Public endpoint (no auth required).
 */
router.get('/config', (req: Request, res: Response) => {
  if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
    res.status(500).json({
      error: {
        code: 'AUTH_NOT_CONFIGURED',
        message: 'OAuth not configured',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const oauthUrl = `https://${COGNITO_DOMAIN}.auth.${COGNITO_REGION}.amazoncognito.com`;

  res.json({
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
router.post('/exchange', async (req: Request, res: Response) => {
  try {
    const { code, codeVerifier } = req.body;

    if (!code || !codeVerifier) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing code or codeVerifier',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
      res.status(500).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'OAuth not configured',
        },
        timestamp: new Date().toISOString(),
      });
      return;
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
      const errorData = await tokenResponse.json().catch(() => ({})) as { error_description?: string };
      console.error('Token exchange failed:', errorData);
      res.status(tokenResponse.status).json({
        error: {
          code: 'TOKEN_EXCHANGE_FAILED',
          message: errorData.error_description || 'Failed to exchange authorization code',
          details: errorData,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const tokens = await tokenResponse.json();
    res.json(tokens);
  } catch (error) {
    console.error('Token exchange error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Token exchange failed',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /auth/user
 *
 * Returns authenticated user info from JWT claims.
 * Requires valid access token.
 */
router.get('/user', authenticateJWT, (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;

  res.json({
    sub: authReq.auth!.sub,
    email: authReq.auth!.email,
    tenantId: authReq.auth!.tenantId,
    tenantTier: authReq.auth!.tenantTier,
    groups: authReq.auth!.groups || [],
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
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing refreshToken',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
      res.status(500).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'OAuth not configured',
        },
        timestamp: new Date().toISOString(),
      });
      return;
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
      const errorData = await tokenResponse.json().catch(() => ({})) as { error_description?: string };
      console.error('Token refresh failed:', errorData);
      res.status(tokenResponse.status).json({
        error: {
          code: 'TOKEN_REFRESH_FAILED',
          message: errorData.error_description || 'Failed to refresh token',
          details: errorData,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const tokens = await tokenResponse.json();
    res.json(tokens);
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Token refresh failed',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /auth/register
 *
 * Register a new user via Cognito SignUp.
 * User receives email confirmation code.
 *
 * Body: { name: string, email: string, password: string }
 * Returns: { userSub: string, codeDeliveryDetails: {...} }
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required fields: name, email, password',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!COGNITO_CLIENT_ID) {
      res.status(500).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Cognito not configured',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Register user with Cognito
    // Assign default tenant - new users get assigned to DEFAULT_TENANT_ID
    // Admin can reassign tenants later via AdminUpdateUserAttributes
    const command = new SignUpCommand({
      ClientId: COGNITO_CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'name', Value: name },
        { Name: 'custom:tenant_id', Value: DEFAULT_TENANT_ID },
        { Name: 'custom:tenant_tier', Value: 'free' },
      ],
    });

    const response = await cognitoClient.send(command);

    res.status(201).json({
      userSub: response.UserSub,
      userConfirmed: response.UserConfirmed,
      codeDeliveryDetails: response.CodeDeliveryDetails,
      message: 'Registration successful. Please check your email for confirmation code.',
    });
  } catch (error: any) {
    console.error('Registration error:', error);

    // Handle Cognito-specific errors
    if (error.name === 'UsernameExistsException') {
      res.status(409).json({
        error: {
          code: 'USER_EXISTS',
          message: 'User with this email already exists',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (error.name === 'InvalidPasswordException') {
      res.status(400).json({
        error: {
          code: 'INVALID_PASSWORD',
          message: error.message || 'Password does not meet requirements',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (error.name === 'InvalidParameterException') {
      res.status(400).json({
        error: {
          code: 'INVALID_PARAMETER',
          message: error.message || 'Invalid registration parameters',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'REGISTRATION_FAILED',
        message: 'Registration failed',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /auth/confirm-signup
 *
 * Confirm user email with code sent during registration.
 *
 * Body: { email: string, code: string }
 * Returns: { success: true }
 */
router.post('/confirm-signup', async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing email or code',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!COGNITO_CLIENT_ID) {
      res.status(500).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Cognito not configured',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const command = new ConfirmSignUpCommand({
      ClientId: COGNITO_CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
    });

    await cognitoClient.send(command);

    res.json({
      success: true,
      message: 'Email confirmed successfully. You can now log in.',
    });
  } catch (error: any) {
    console.error('Confirmation error:', error);

    if (error.name === 'CodeMismatchException') {
      res.status(400).json({
        error: {
          code: 'INVALID_CODE',
          message: 'Invalid confirmation code',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (error.name === 'ExpiredCodeException') {
      res.status(400).json({
        error: {
          code: 'EXPIRED_CODE',
          message: 'Confirmation code has expired. Request a new code.',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (error.name === 'UserNotFoundException') {
      res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'CONFIRMATION_FAILED',
        message: 'Confirmation failed',
      },
      timestamp: new Date().toISOString(),
    });
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
router.post('/resend-code', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing email',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!COGNITO_CLIENT_ID) {
      res.status(500).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Cognito not configured',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const command = new ResendConfirmationCodeCommand({
      ClientId: COGNITO_CLIENT_ID,
      Username: email,
    });

    const response = await cognitoClient.send(command);

    res.json({
      codeDeliveryDetails: response.CodeDeliveryDetails,
      message: 'Confirmation code resent successfully.',
    });
  } catch (error: any) {
    console.error('Resend code error:', error);

    if (error.name === 'UserNotFoundException') {
      res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (error.name === 'InvalidParameterException') {
      res.status(400).json({
        error: {
          code: 'INVALID_PARAMETER',
          message: 'User is already confirmed',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'RESEND_FAILED',
        message: 'Failed to resend confirmation code',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /auth/admin/users
 *
 * List all users in the Cognito user pool.
 * Requires admin authentication.
 */
router.get('/admin/users', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;

    // Check if user is admin
    if (!authReq.auth?.groups?.includes('admin')) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Admin access required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!COGNITO_USER_POOL_ID) {
      res.status(500).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Cognito not configured',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const command = new ListUsersCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Limit: 60,
    });

    const response = await cognitoClient.send(command);

    res.json({
      users: response.Users?.map((user: any) => ({
        username: user.Username,
        email: user.Attributes?.find((attr: any) => attr.Name === 'email')?.Value,
        name: user.Attributes?.find((attr: any) => attr.Name === 'name')?.Value,
        tenantId: user.Attributes?.find((attr: any) => attr.Name === 'custom:tenant_id')?.Value,
        tenantTier: user.Attributes?.find((attr: any) => attr.Name === 'custom:tenant_tier')?.Value,
        enabled: user.Enabled,
        status: user.UserStatus,
        created: user.UserCreateDate,
        modified: user.UserLastModifiedDate,
      })) || [],
      paginationToken: response.PaginationToken,
    });
  } catch (error: any) {
    console.error('List users error:', error);
    res.status(500).json({
      error: {
        code: 'LIST_USERS_FAILED',
        message: 'Failed to list users',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /auth/admin/users/:username/disable
 *
 * Disable a user account.
 * Requires admin authentication.
 */
router.post('/admin/users/:username/disable', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { username } = req.params;

    // Check if user is admin
    if (!authReq.auth?.groups?.includes('admin')) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Admin access required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!COGNITO_USER_POOL_ID) {
      res.status(500).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Cognito not configured',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const command = new AdminDisableUserCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: username,
    });

    await cognitoClient.send(command);

    res.json({
      success: true,
      message: `User ${username} has been disabled`,
    });
  } catch (error: any) {
    console.error('Disable user error:', error);

    if (error.name === 'UserNotFoundException') {
      res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'DISABLE_USER_FAILED',
        message: 'Failed to disable user',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /auth/admin/users/:username/enable
 *
 * Enable a previously disabled user account.
 * Requires admin authentication.
 */
router.post('/admin/users/:username/enable', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { username } = req.params;

    // Check if user is admin
    if (!authReq.auth?.groups?.includes('admin')) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Admin access required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!COGNITO_USER_POOL_ID) {
      res.status(500).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Cognito not configured',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const command = new AdminEnableUserCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: username,
    });

    await cognitoClient.send(command);

    res.json({
      success: true,
      message: `User ${username} has been enabled`,
    });
  } catch (error: any) {
    console.error('Enable user error:', error);

    if (error.name === 'UserNotFoundException') {
      res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'ENABLE_USER_FAILED',
        message: 'Failed to enable user',
      },
      timestamp: new Date().toISOString(),
    });
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
router.patch('/admin/users/:username/tenant', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { username } = req.params;
    const { tenantId, tenantTier } = req.body;

    // Check if user is admin
    if (!authReq.auth?.groups?.includes('admin')) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Admin access required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!tenantId) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing tenantId',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!COGNITO_USER_POOL_ID) {
      res.status(500).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Cognito not configured',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const attributes = [
      { Name: 'custom:tenant_id', Value: tenantId },
    ];

    if (tenantTier) {
      attributes.push({ Name: 'custom:tenant_tier', Value: tenantTier });
    }

    const command = new AdminUpdateUserAttributesCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: username,
      UserAttributes: attributes,
    });

    await cognitoClient.send(command);

    res.json({
      success: true,
      message: `User ${username} tenant updated`,
      tenantId,
      tenantTier,
    });
  } catch (error: any) {
    console.error('Update tenant error:', error);

    if (error.name === 'UserNotFoundException') {
      res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'UPDATE_TENANT_FAILED',
        message: 'Failed to update user tenant',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
