/**
 * Slack webhook routes
 *
 * Handles Slack Events API webhooks with URL verification and signature verification.
 * Routes Slack messages to the chat gateway using the Slack platform adapter.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import crypto from 'crypto';
import { getAdapter } from '../adapters';
import { createAgent, createDefaultSystemPrompt } from '@chimera/core';
import { ErrorResponse, TenantContext } from '../types';
import { resolveUser } from '../middleware/user-resolution';

const router = new Hono();

/**
 * Slack URL verification challenge
 *
 * When registering webhook URLs, Slack sends a challenge parameter
 * that must be echoed back within 3 seconds.
 *
 * @see https://api.slack.com/events/url_verification
 */
interface SlackChallenge {
  type: 'url_verification';
  challenge: string;
  token: string;
}

/**
 * Slack event callback payload
 */
interface SlackEventCallback {
  type: 'event_callback';
  team_id: string;
  event: {
    type: string;
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
  };
}

/**
 * Verify Slack request signature using HMAC-SHA256
 *
 * Slack signs all requests with a secret token. We must verify the signature
 * to prevent unauthorized requests.
 *
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
function verifySlackSignature(
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string
): boolean {
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;

  // Fail hard if secret not configured in production
  if (!slackSigningSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('SLACK_SIGNING_SECRET not set in production - rejecting request');
      return false;
    }
    console.warn('SLACK_SIGNING_SECRET not set - skipping signature verification (development only)');
    return true;
  }

  if (!signature || !timestamp) {
    return false;
  }

  // Prevent replay attacks - reject requests older than 5 minutes
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - parseInt(timestamp, 10)) > 300) {
    console.warn('Slack request timestamp too old');
    return false;
  }

  // Compute signature
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', slackSigningSecret);
  const computedSignature = `v0=${hmac.update(sigBasestring).digest('hex')}`;

  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(computedSignature, 'utf8'),
    Buffer.from(signature, 'utf8')
  );
}

/**
 * POST /slack/events
 *
 * Slack Events API endpoint.
 * Handles URL verification challenge and incoming message events.
 */
router.post('/events', resolveUser, async (c: Context) => {
  try {
    const rawBody = await c.req.text();

    let body: SlackChallenge | SlackEventCallback;
    try {
      body = JSON.parse(rawBody) as SlackChallenge | SlackEventCallback;
    } catch {
      return c.json({ ok: true });
    }

    // Handle URL verification challenge
    if (body.type === 'url_verification') {
      return c.json({ challenge: (body as SlackChallenge).challenge });
    }

    // Verify signature for all non-challenge requests
    const signature = c.req.header('x-slack-signature');
    const timestamp = c.req.header('x-slack-request-timestamp');
    if (!verifySlackSignature(signature, timestamp, rawBody)) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Slack signature verification failed',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 401);
    }

    // Handle event callbacks
    if (body.type === 'event_callback') {
      const eventCallback = body as SlackEventCallback;
      const event = eventCallback.event;

      // Ignore bot messages to prevent infinite loops
      if (event.type === 'message' && 'bot_id' in event) {
        return c.json({ ok: true });
      }

      // Only process message events
      if (event.type !== 'message') {
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

      // Get Slack adapter
      const adapter = getAdapter('slack');

      // Parse Slack message
      let messages;
      try {
        messages = adapter.parseIncoming({ event });
      } catch (parseError) {
        console.error('Failed to parse Slack message:', parseError);
        return c.json({ ok: true }); // Respond 200 to avoid retries
      }

      if (messages.length === 0) {
        return c.json({ ok: true });
      }

      // Create agent and invoke
      // Use resolved Cognito user context if available, otherwise fall back to platform user
      const userContext = c.get('userContext') as { cognitoSub?: string } | undefined;
      const userId = userContext?.cognitoSub || event.user || tenantContext.userId;
      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: tenantContext.tenantId,
        userId,
        sessionId: `slack_${event.channel}_${event.user}`,
      });

      // Invoke agent (non-streaming for Slack)
      const result = await agent.invoke(messages[0].content);

      // Format response for Slack
      const slackResponse = adapter.formatResponse(result.output, tenantContext);

      // In production, you would post this to Slack's response_url or chat.postMessage API
      // For now, we acknowledge receipt
      return c.json(slackResponse);
    }

    // Unknown event type
    return c.json({ ok: true });
  } catch (error) {
    console.error('Slack webhook error:', error);

    // Always respond 200 to Slack to prevent retries
    return c.json({ ok: true });
  }
});

/**
 * POST /slack/slash
 *
 * Slack slash command endpoint (e.g., /ai <query>).
 * Slash commands require a response within 3 seconds, so we immediately acknowledge
 * and process the command asynchronously if needed.
 */
router.post('/slash', resolveUser, async (c: Context) => {
  try {
    const rawBody = await c.req.text();
    const signature = c.req.header('x-slack-signature');
    const timestamp = c.req.header('x-slack-request-timestamp');

    // Verify signature
    if (!verifySlackSignature(signature, timestamp, rawBody)) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Slack signature verification failed',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 401);
    }

    // Validate tenant context
    const tenantContext = c.get('tenantContext') as TenantContext | undefined;
    if (!tenantContext) {
      return c.json({
        response_type: 'ephemeral',
        text: 'Authentication error. Please contact your administrator.',
      });
    }

    // Get Slack adapter
    const adapter = getAdapter('slack');

    // Parse slash command body (URL-encoded form data)
    let slashBody: Record<string, string>;
    try {
      // Slack slash commands send application/x-www-form-urlencoded
      const formData = await c.req.parseBody();
      slashBody = formData as Record<string, string>;
    } catch {
      return c.json({
        response_type: 'ephemeral',
        text: 'Invalid command format. Usage: /ai <your question>',
      });
    }

    // Parse slash command
    let messages;
    try {
      messages = adapter.parseIncoming(slashBody);
    } catch {
      return c.json({
        response_type: 'ephemeral',
        text: 'Invalid command format. Usage: /ai <your question>',
      });
    }

    if (messages.length === 0 || !messages[0].content) {
      return c.json({
        response_type: 'ephemeral',
        text: 'Please provide a message. Usage: /ai <your question>',
      });
    }

    // Create agent
    // Use resolved Cognito user context if available, otherwise fall back to platform user
    const userContext = c.get('userContext') as { cognitoSub?: string } | undefined;
    const userId = userContext?.cognitoSub || slashBody.user_id || tenantContext.userId;
    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: tenantContext.tenantId,
      userId,
      sessionId: `slack_slash_${slashBody.channel_id}_${slashBody.user_id}`,
    });

    // Invoke agent (must complete within 3 seconds)
    const result = await agent.invoke(messages[0].content);

    // Format and return response
    const slackResponse = adapter.formatResponse(result.output, tenantContext);
    return c.json(slackResponse);
  } catch (error) {
    console.error('Slash command error:', error);
    return c.json({
      response_type: 'ephemeral',
      text: 'Sorry, something went wrong processing your request.',
    });
  }
});

export default router;
