/**
 * Telegram Bot API webhook routes
 *
 * Handles Telegram webhook updates with secret token verification.
 * Routes Telegram messages to the chat gateway using the Telegram platform adapter.
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
 * Telegram webhook Update payload
 * @see https://core.telegram.org/bots/api#update
 */
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: 'private' | 'group' | 'supergroup' | 'channel';
    };
    text?: string;
  };
}

/**
 * Verify Telegram secret token header using constant-time comparison.
 *
 * Telegram sends X-Telegram-Bot-Api-Secret-Token header to prove the request
 * originated from Telegram (after setWebhook was called with a secret_token).
 *
 * @see https://core.telegram.org/bots/api#setwebhook
 */
function verifyTelegramSecret(providedToken: string | undefined): boolean {
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  // In production, secret must be configured
  if (!webhookSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('TELEGRAM_WEBHOOK_SECRET not set in production - rejecting request');
      return false;
    }
    console.warn('TELEGRAM_WEBHOOK_SECRET not set - skipping token verification (development only)');
    return true;
  }

  if (!providedToken) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  try {
    const expected = Buffer.from(webhookSecret, 'utf8');
    const provided = Buffer.from(providedToken, 'utf8');

    if (expected.length !== provided.length) {
      return false;
    }

    return crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

/**
 * POST /telegram/webhook
 *
 * Main Telegram webhook handler.
 * Receives updates from Telegram and routes text messages to the agent.
 */
router.post('/webhook', resolveUser, async (c: Context) => {
  try {
    // Verify secret token
    const providedToken = c.req.header('x-telegram-bot-api-secret-token');
    if (!verifyTelegramSecret(providedToken)) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_TOKEN',
          message: 'Telegram secret token verification failed',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 401);
    }

    const update = await c.req.json() as TelegramUpdate;

    // Ignore bot messages to prevent infinite loops
    if (update.message?.from?.is_bot) {
      return c.json({ ok: true });
    }

    // Get Telegram adapter
    const adapter = getAdapter('telegram');

    // Parse incoming Telegram update
    let messages;
    try {
      messages = adapter.parseIncoming(update);
    } catch (parseError) {
      console.error('Failed to parse Telegram update:', parseError);
      return c.json({ ok: true }); // Respond 200 to avoid Telegram retries
    }

    // Non-text update (sticker, photo, etc.) — acknowledge and ignore
    if (messages.length === 0) {
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

    const fromId = update.message?.from?.id;
    const chatId = update.message?.chat.id;

    // Create agent and invoke
    // Use resolved Cognito user context if available, otherwise fall back to platform user
    const userContext = c.get('userContext') as { cognitoSub?: string } | undefined;
    const userId = userContext?.cognitoSub || String(fromId) || tenantContext.userId;
    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: tenantContext.tenantId,
      userId,
      sessionId: `telegram_${chatId}`,
    });

    const result = await agent.invoke(messages[0].content);

    // Format response for Telegram and include chat_id from incoming update
    const formatted = adapter.formatResponse(result.output, tenantContext) as Record<string, unknown>;
    const telegramResponse = {
      ...formatted,
      chat_id: chatId,
    };

    return c.json(telegramResponse);
  } catch (error) {
    console.error('Telegram webhook error:', error);
    // Always respond 200 to Telegram to prevent retries
    return c.json({ ok: true });
  }
});

/**
 * POST /telegram/set-webhook
 *
 * Admin endpoint to register or update the webhook URL with Telegram.
 * In production, this would call the Telegram Bot API setWebhook method.
 */
router.post('/set-webhook', async (c: Context) => {
  try {
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

    const body = await c.req.json() as { url?: string; secretToken?: string };

    if (!body.url) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'url is required',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    if (!body.secretToken) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'secretToken is required',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    // In production, would call: https://api.telegram.org/bot{token}/setWebhook
    // For now, return mock success
    return c.json({
      ok: true,
      result: true,
      description: 'Webhook was set',
      webhookUrl: body.url,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Set webhook error:', error);
    const errorResponse: ErrorResponse = {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to set webhook',
      },
      timestamp: new Date().toISOString(),
    };
    return c.json(errorResponse, 500);
  }
});

export default router;
