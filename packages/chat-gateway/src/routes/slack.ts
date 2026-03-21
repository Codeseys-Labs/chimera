/**
 * Slack webhook routes
 *
 * Handles Slack Events API webhooks with URL verification and signature verification.
 * Routes Slack messages to the chat gateway using the Slack platform adapter.
 */

import { Router, Request, Response } from 'express';
import type { Router as ExpressRouter } from 'express';
import crypto from 'crypto';
import { getAdapter } from '../adapters';
import { createAgent, createDefaultSystemPrompt } from '@chimera/core';
import { ErrorResponse } from '../types';
import { resolveUser } from '../middleware/user-resolution';

const router: ExpressRouter = Router();

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
function verifySlackSignature(req: Request): boolean {
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

  const slackSignature = req.headers['x-slack-signature'] as string;
  const timestamp = req.headers['x-slack-request-timestamp'] as string;

  if (!slackSignature || !timestamp) {
    return false;
  }

  // Prevent replay attacks - reject requests older than 5 minutes
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - parseInt(timestamp, 10)) > 300) {
    console.warn('Slack request timestamp too old');
    return false;
  }

  // Compute signature
  const rawBody = JSON.stringify(req.body);
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', slackSigningSecret);
  const computedSignature = `v0=${hmac.update(sigBasestring).digest('hex')}`;

  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(computedSignature, 'utf8'),
    Buffer.from(slackSignature, 'utf8')
  );
}

/**
 * POST /slack/events
 *
 * Slack Events API endpoint.
 * Handles URL verification challenge and incoming message events.
 */
router.post('/events', resolveUser, async (req: Request, res: Response) => {
  try {
    // Handle URL verification challenge
    const body = req.body as SlackChallenge | SlackEventCallback;

    if (body.type === 'url_verification') {
      const challenge = (body as SlackChallenge).challenge;
      res.status(200).json({ challenge });
      return;
    }

    // Verify signature for all non-challenge requests
    if (!verifySlackSignature(req)) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Slack signature verification failed',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(401).json(error);
      return;
    }

    // Handle event callbacks
    if (body.type === 'event_callback') {
      const eventCallback = body as SlackEventCallback;
      const event = eventCallback.event;

      // Ignore bot messages to prevent infinite loops
      if (event.type === 'message' && 'bot_id' in event) {
        res.status(200).json({ ok: true });
        return;
      }

      // Only process message events
      if (event.type !== 'message') {
        res.status(200).json({ ok: true });
        return;
      }

      // Validate tenant context
      if (!req.tenantContext) {
        const error: ErrorResponse = {
          error: {
            code: 'MISSING_TENANT_CONTEXT',
            message: 'Tenant context not found',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(500).json(error);
        return;
      }

      // Get Slack adapter
      const adapter = getAdapter('slack');

      // Parse Slack message
      let messages;
      try {
        messages = adapter.parseIncoming({ event });
      } catch (error) {
        console.error('Failed to parse Slack message:', error);
        res.status(200).json({ ok: true }); // Respond 200 to avoid retries
        return;
      }

      if (messages.length === 0) {
        res.status(200).json({ ok: true });
        return;
      }

      // Create agent and invoke
      // Use resolved Cognito user context if available, otherwise fall back to platform user
      const userId = req.userContext?.cognitoSub || event.user || req.tenantContext.userId;
      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: req.tenantContext.tenantId,
        userId,
        sessionId: `slack_${event.channel}_${event.user}`,
      });

      // Invoke agent (non-streaming for Slack)
      const result = await agent.invoke(messages[0].content);

      // Format response for Slack
      const slackResponse = adapter.formatResponse(result.output, req.tenantContext);

      // In production, you would post this to Slack's response_url or chat.postMessage API
      // For now, we acknowledge receipt
      res.status(200).json(slackResponse);
      return;
    }

    // Unknown event type
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Slack webhook error:', error);

    // Always respond 200 to Slack to prevent retries
    res.status(200).json({ ok: true });
  }
});

/**
 * POST /slack/slash
 *
 * Slack slash command endpoint (e.g., /ai <query>).
 * Slash commands require a response within 3 seconds, so we immediately acknowledge
 * and process the command asynchronously if needed.
 */
router.post('/slash', resolveUser, async (req: Request, res: Response) => {
  try {
    // Verify signature
    if (!verifySlackSignature(req)) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Slack signature verification failed',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(401).json(error);
      return;
    }

    // Validate tenant context
    if (!req.tenantContext) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: 'Authentication error. Please contact your administrator.',
      });
      return;
    }

    // Get Slack adapter
    const adapter = getAdapter('slack');

    // Parse slash command
    let messages;
    try {
      messages = adapter.parseIncoming(req.body);
    } catch {
      res.status(200).json({
        response_type: 'ephemeral',
        text: 'Invalid command format. Usage: /ai <your question>',
      });
      return;
    }

    if (messages.length === 0 || !messages[0].content) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: 'Please provide a message. Usage: /ai <your question>',
      });
      return;
    }

    // Create agent
    // Use resolved Cognito user context if available, otherwise fall back to platform user
    const slashBody = req.body as { user_id?: string; channel_id?: string };
    const userId = req.userContext?.cognitoSub || slashBody.user_id || req.tenantContext.userId;
    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: req.tenantContext.tenantId,
      userId,
      sessionId: `slack_slash_${slashBody.channel_id}_${slashBody.user_id}`,
    });

    // Invoke agent (must complete within 3 seconds)
    const result = await agent.invoke(messages[0].content);

    // Format and return response
    const slackResponse = adapter.formatResponse(result.output, req.tenantContext);
    res.status(200).json(slackResponse);
  } catch (error) {
    console.error('Slash command error:', error);
    res.status(200).json({
      response_type: 'ephemeral',
      text: 'Sorry, something went wrong processing your request.',
    });
  }
});

export default router;
