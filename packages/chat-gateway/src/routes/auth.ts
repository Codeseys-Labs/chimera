/**
 * Authentication routes for Cognito OAuth flow
 *
 * Implements OAuth2 PKCE authorization code flow with Cognito.
 */

import { Router, Request, Response } from 'express';
import { authenticateJWT, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Cognito OAuth configuration
const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN; // e.g., chimera-dev-123456789.auth.us-east-1.amazoncognito.com
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const COGNITO_REGION = process.env.AWS_REGION || 'us-east-1';
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost:8080/auth/callback';

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

export default router;
