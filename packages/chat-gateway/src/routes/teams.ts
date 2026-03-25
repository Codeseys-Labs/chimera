/**
 * Microsoft Teams Bot Framework webhook routes
 *
 * Handles Bot Framework activity webhooks from Azure Bot Service.
 * Routes Teams messages to the chat gateway using the Teams platform adapter.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getAdapter } from '../adapters';
import { createAgent, createDefaultSystemPrompt } from '@chimera/core';
import { ErrorResponse, TenantContext } from '../types';
import { resolveUser } from '../middleware/user-resolution';

const router = new Hono();

/**
 * Bot Framework Activity format
 * @see https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-api-reference
 */
interface BotFrameworkActivity {
  type: 'message' | 'conversationUpdate' | 'contactRelationUpdate' | 'typing';
  id?: string;
  channelId: string;
  from: {
    id: string;
    name?: string;
    aadObjectId?: string;
  };
  conversation: {
    id: string;
    isGroup?: boolean;
    conversationType?: string;
    tenantId?: string;
  };
  recipient: {
    id: string;
    name?: string;
  };
  text?: string;
  textFormat?: 'plain' | 'markdown' | 'xml';
}

/**
 * Verify Teams Bot Framework bearer token
 *
 * Azure Bot Service signs all requests with a JWT bearer token in the
 * Authorization header. In production this must be configured; in development
 * verification is skipped when MICROSOFT_APP_PASSWORD is absent.
 *
 * @see https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
 */
function verifyTeamsToken(authHeader: string | undefined): boolean {
  const appPassword = process.env.MICROSOFT_APP_PASSWORD;

  // Fail hard if not configured in production
  if (!appPassword) {
    if (process.env.NODE_ENV === 'production') {
      console.error('MICROSOFT_APP_PASSWORD not set in production - rejecting request');
      return false;
    }
    console.warn('MICROSOFT_APP_PASSWORD not set - skipping token verification (development only)');
    return true;
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);
  if (!token) {
    return false;
  }

  // Basic JWT structure and claims validation.
  // Full cryptographic signature verification requires fetching Microsoft's JWKS
  // from https://login.botframework.com/v1/.well-known/openidconfiguration
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );

    // Verify issuer is Azure Bot Service or Azure AD (multi-tenant bots)
    const validIssuers = [
      'https://api.botframework.com',
      'https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/',
      'https://sts.windows.net/f8cdef31-a31e-4b4a-93e4-5f571e91255a/',
    ];
    if (!payload.iss || !validIssuers.includes(payload.iss)) {
      return false;
    }

    // Verify audience matches our registered app ID
    const appId = process.env.MICROSOFT_APP_ID;
    if (appId && payload.aud !== appId) {
      return false;
    }

    // Reject expired tokens
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now > payload.exp) {
      console.warn('Teams token has expired');
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * POST /teams/messages
 *
 * Bot Framework messaging endpoint.
 * Receives all activity types from Azure Bot Service and routes message
 * activities to the Chimera agent.
 */
router.post('/messages', resolveUser, async (c: Context) => {
  try {
    // Verify bearer token for all requests
    const authHeader = c.req.header('authorization');
    if (!verifyTeamsToken(authHeader)) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_TOKEN',
          message: 'Teams token verification failed',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 401);
    }

    const body = await c.req.json() as BotFrameworkActivity;

    // Non-message activities (conversationUpdate, typing, etc.) are acknowledged
    // but not processed — return 200 to prevent Bot Framework retries
    if (body.type !== 'message') {
      return c.json({ ok: true });
    }

    // Validate tenant context
    const tenantContext = c.get('tenantContext') as TenantContext | undefined;
    if (!tenantContext) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_TENANT_CONTEXT',
          message: 'Tenant context not found',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 500);
    }

    // Get Teams adapter
    const adapter = getAdapter('teams');

    // Parse Teams activity into ChatMessage[]
    let messages;
    try {
      messages = adapter.parseIncoming(body);
    } catch (parseError) {
      console.error('Failed to parse Teams activity:', parseError);
      return c.json({ ok: true }); // Respond 200 to avoid Bot Framework retries
    }

    if (messages.length === 0) {
      return c.json({ ok: true });
    }

    // Create agent and invoke.
    // Prefer resolved Cognito identity; fall back to Azure AD object ID, then raw Teams user ID.
    const userContext = c.get('userContext') as { cognitoSub?: string } | undefined;
    const userId =
      userContext?.cognitoSub ||
      body.from.aadObjectId ||
      body.from.id ||
      tenantContext.userId;

    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: tenantContext.tenantId,
      userId,
      sessionId: `teams_${body.conversation.id}_${body.from.id}`,
    });

    // Invoke agent (non-streaming for Teams Bot Framework)
    const result = await agent.invoke(messages[0].content);

    // Format and return Teams response
    const teamsResponse = adapter.formatResponse(result.output, tenantContext);

    return c.json(teamsResponse);
  } catch (error) {
    console.error('Teams webhook error:', error);

    // Always respond 200 to prevent Bot Framework retry storms
    return c.json({ ok: true });
  }
});

export default router;
