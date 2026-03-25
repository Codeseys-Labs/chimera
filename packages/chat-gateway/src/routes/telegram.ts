/**
 * Telegram Bot API webhook routes
 *
 * Handles Telegram webhook updates with secret token verification.
 * Routes Telegram messages to the chat gateway using the Telegram platform adapter.
 */

import { Router } from 'express';
import crypto from 'crypto';
import { getAdapter } from '../adapters';
import { createAgent, createDefaultSystemPrompt } from '@chimera/core';
import { ErrorResponse } from '../types';
import { resolveUser } from '../middleware/user-resolution';

const router = Router();

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
function verifyTelegramSecret(req: Request): boolean {
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

  const providedToken = (req.headers as any)['x-telegram-bot-api-secret-token'] as string | undefined;

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
router.post('/webhook', resolveUser, async (req: Request, res: Response) => {
  try {
    // Verify secret token
    if (!verifyTelegramSecret(req)) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_TOKEN',
          message: 'Telegram secret token verification failed',
        },
        timestamp: new Date().toISOString(),
      };
      (res as any).status(401).json(error);
      return;
    }

    const update = (req as any).body as TelegramUpdate;

    // Ignore bot messages to prevent infinite loops
    if (update.message?.from?.is_bot) {
      (res as any).status(200).json({ ok: true });
      return;
    }

    // Get Telegram adapter
    const adapter = getAdapter('telegram');

    // Parse incoming Telegram update
    let messages;
    try {
      messages = adapter.parseIncoming(update);
    } catch (parseError) {
      console.error('Failed to parse Telegram update:', parseError);
      (res as any).status(200).json({ ok: true }); // Respond 200 to avoid Telegram retries
      return;
    }

    // Non-text update (sticker, photo, etc.) — acknowledge and ignore
    if (messages.length === 0) {
      (res as any).status(200).json({ ok: true });
      return;
    }

    // Validate tenant context
    if (!(req as any).tenantContext) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_TENANT_CONTEXT',
          message: 'Tenant context not found',
        },
        timestamp: new Date().toISOString(),
      };
      (res as any).status(500).json(error);
      return;
    }

    const tenantContext = (req as any).tenantContext;
    const fromId = update.message?.from?.id;
    const chatId = update.message?.chat.id;

    // Create agent and invoke
    // Use resolved Cognito user context if available, otherwise fall back to platform user
    const userId = (req as any).userContext?.cognitoSub || String(fromId) || tenantContext.userId;
    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: tenantContext.tenantId,
      userId,
      sessionId: `telegram_${chatId}`,
    });

    const result = await agent.invoke(messages[0].content);

    // Format response for Telegram and include chat_id from incoming update
    const formatted = adapter.formatResponse(result.output, tenantContext);
    const telegramResponse = {
      ...formatted,
      chat_id: chatId,
    };

    (res as any).status(200).json(telegramResponse);
  } catch (error) {
    console.error('Telegram webhook error:', error);
    // Always respond 200 to Telegram to prevent retries
    (res as any).status(200).json({ ok: true });
  }
});

/**
 * POST /telegram/set-webhook
 *
 * Admin endpoint to register or update the webhook URL with Telegram.
 * In production, this would call the Telegram Bot API setWebhook method.
 */
router.post('/set-webhook', async (req: Request, res: Response) => {
  try {
    // Validate tenant context
    if (!(req as any).tenantContext) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_TENANT_CONTEXT',
          message: 'Tenant context not found',
        },
        timestamp: new Date().toISOString(),
      };
      (res as any).status(500).json(error);
      return;
    }

    const body = (req as any).body as { url?: string; secretToken?: string };

    if (!body.url) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'url is required',
        },
        timestamp: new Date().toISOString(),
      };
      (res as any).status(400).json(error);
      return;
    }

    if (!body.secretToken) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'secretToken is required',
        },
        timestamp: new Date().toISOString(),
      };
      (res as any).status(400).json(error);
      return;
    }

    // In production, would call: https://api.telegram.org/bot{token}/setWebhook
    // For now, return mock success
    (res as any).status(200).json({
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
    (res as any).status(500).json(errorResponse);
  }
});

export default router;
