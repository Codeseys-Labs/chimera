/**
 * Discord webhook routes
 *
 * Handles Discord interactions endpoint with Ed25519 signature verification.
 * Routes Discord slash commands and message webhooks to the chat gateway.
 *
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import crypto from 'crypto';
import { getAdapter } from '../adapters';
import { createAgent, createDefaultSystemPrompt } from '@chimera/core';
import { ErrorResponse, TenantContext } from '../types';

const router = new Hono();

// DER header for Ed25519 SubjectPublicKeyInfo (SPKI) encoding.
// Ed25519 public keys from Discord are 32-byte raw keys; Node.js crypto
// requires them wrapped in SPKI DER format for createPublicKey().
const ED25519_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify Discord request signature using Ed25519
 *
 * Discord signs all interaction requests with the app's Ed25519 key pair.
 * The signed message is: X-Signature-Timestamp header value + raw body string.
 *
 * Set DISCORD_PUBLIC_KEY to the 32-byte hex public key from the Developer Portal.
 *
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization
 */
function verifyDiscordSignature(signature: string, timestamp: string, rawBody: string): boolean {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!publicKey) {
    if (process.env.NODE_ENV === 'production') {
      console.error('DISCORD_PUBLIC_KEY not set in production - rejecting request');
      return false;
    }
    console.warn('DISCORD_PUBLIC_KEY not set - skipping signature verification (development only)');
    return true;
  }

  try {
    const rawKey = Buffer.from(publicKey, 'hex');
    const spkiKey = Buffer.concat([ED25519_DER_PREFIX, rawKey]);
    const keyObject = crypto.createPublicKey({ key: spkiKey, format: 'der', type: 'spki' });
    return crypto.verify(
      null,
      Buffer.from(timestamp + rawBody),
      keyObject,
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * POST /discord/interactions
 *
 * Discord Interactions endpoint. All interaction requests are Ed25519 verified.
 *
 * Interaction types handled:
 * - PING (type 1): Endpoint verification challenge — must respond { type: 1 }
 * - APPLICATION_COMMAND (type 2): Slash command — routes to agent, responds type 4
 *
 * Discord requires a response within 3 seconds. For long-running commands,
 * respond with type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE) and follow up.
 * This implementation responds synchronously (type 4).
 */
router.post('/interactions', async (c: Context) => {
  const signature = c.req.header('x-signature-ed25519') ?? '';
  const timestamp = c.req.header('x-signature-timestamp') ?? '';
  const rawBody = await c.req.text();

  // Both signature headers are required for Discord interactions
  if (!signature || !timestamp) {
    const error: ErrorResponse = {
      error: {
        code: 'MISSING_SIGNATURE_HEADERS',
        message: 'X-Signature-Ed25519 and X-Signature-Timestamp headers are required',
      },
      timestamp: new Date().toISOString(),
    };
    return c.json(error, 401);
  }

  if (!verifyDiscordSignature(signature, timestamp, rawBody)) {
    const error: ErrorResponse = {
      error: {
        code: 'INVALID_SIGNATURE',
        message: 'Discord signature verification failed',
      },
      timestamp: new Date().toISOString(),
    };
    return c.json(error, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    const error: ErrorResponse = {
      error: { code: 'INVALID_JSON', message: 'Invalid request body' },
      timestamp: new Date().toISOString(),
    };
    return c.json(error, 400);
  }

  // PING (type 1) — respond immediately to pass endpoint verification
  if (body.type === 1) {
    return c.json({ type: 1 });
  }

  // APPLICATION_COMMAND (type 2) — slash command invocation
  if (body.type === 2) {
    const tenantContext = c.get('tenantContext') as TenantContext | undefined;

    if (!tenantContext) {
      // Discord requires a response; use ephemeral message for auth errors
      return c.json({
        type: 4,
        data: {
          content: 'Authentication error. Please contact your administrator.',
          flags: 64, // EPHEMERAL
        },
      });
    }

    const adapter = getAdapter('discord');

    let messages;
    try {
      messages = adapter.parseIncoming(body);
    } catch {
      return c.json({
        type: 4,
        data: {
          content: 'Invalid command format. Usage: /ai message:<your question>',
          flags: 64, // EPHEMERAL
        },
      });
    }

    if (messages.length === 0 || !messages[0].content) {
      return c.json({
        type: 4,
        data: {
          content: 'Please provide a message. Usage: /ai message:<your question>',
          flags: 64, // EPHEMERAL
        },
      });
    }

    const interactionBody = body as {
      member?: { user?: { id?: string } };
      user?: { id?: string };
      channel_id?: string;
    };
    const discordUserId =
      interactionBody.member?.user?.id ?? interactionBody.user?.id;
    const userContext = c.get('userContext') as { cognitoSub?: string } | undefined;
    const userId = userContext?.cognitoSub ?? discordUserId ?? tenantContext.userId;

    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: tenantContext.tenantId,
      userId,
      sessionId: `discord_${interactionBody.channel_id}_${discordUserId}`,
    });

    const result = await agent.invoke(messages[0].content);
    const discordResponse = adapter.formatResponse(result.output, tenantContext);

    // type 4 = CHANNEL_MESSAGE_WITH_SOURCE
    return c.json({ type: 4, data: discordResponse });
  }

  // Unknown interaction type — acknowledge to avoid Discord timeout
  return c.json({ type: 1 });
});

/**
 * POST /discord/webhook
 *
 * Discord message webhook endpoint for bot gateway messages.
 * Tenant context is required. Signature verification is performed when
 * X-Signature-Ed25519 and X-Signature-Timestamp headers are present.
 */
router.post('/webhook', async (c: Context) => {
  const tenantContext = c.get('tenantContext') as TenantContext | undefined;

  if (!tenantContext) {
    const error: ErrorResponse = {
      error: {
        code: 'MISSING_TENANT_CONTEXT',
        message: 'Tenant context not found',
      },
      timestamp: new Date().toISOString(),
    };
    return c.json(error, 401);
  }

  const signature = c.req.header('x-signature-ed25519') ?? '';
  const timestamp = c.req.header('x-signature-timestamp') ?? '';
  const rawBody = await c.req.text();

  // Verify signature when headers are present
  if (signature && timestamp) {
    if (!verifyDiscordSignature(signature, timestamp, rawBody)) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Discord signature verification failed',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 401);
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: true });
  }

  const adapter = getAdapter('discord');

  let messages;
  try {
    messages = adapter.parseIncoming(body);
  } catch (err) {
    console.error('Failed to parse Discord message:', err);
    return c.json({ ok: true });
  }

  if (messages.length === 0) {
    return c.json({ ok: true });
  }

  const webhookBody = body as { author?: { id?: string }; channel_id?: string };
  const discordUserId = webhookBody.author?.id;
  const userContext = c.get('userContext') as { cognitoSub?: string } | undefined;
  const userId = userContext?.cognitoSub ?? discordUserId ?? tenantContext.userId;

  const agent = createAgent({
    systemPrompt: createDefaultSystemPrompt(),
    tenantId: tenantContext.tenantId,
    userId,
    sessionId: `discord_${webhookBody.channel_id}_${discordUserId}`,
  });

  const result = await agent.invoke(messages[0].content);
  const discordResponse = adapter.formatResponse(result.output, tenantContext);

  return c.json(discordResponse);
});

export default router;
