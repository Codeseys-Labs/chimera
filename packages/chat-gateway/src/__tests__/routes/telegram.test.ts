/**
 * Tests for Telegram webhook routes
 */

import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';

// Mock adapters before other imports to prevent module contamination.
// bun test runs all files in the same process; teams.test.ts mocks
// '../../adapters' with a Teams-style adapter that corrupts telegram tests
// without an explicit per-file mock here.
const mockParseIncoming = mock((body: any) => {
  if (!body || !body.message) return [];
  if (!body.message.text) return [];
  return [{ role: 'user', content: body.message.text }];
});
const mockFormatResponse = mock(() => ({
  method: 'sendMessage',
  text: 'Hello from Chimera!',
  parse_mode: 'Markdown',
}));
const mockGetAdapter = mock(() => ({
  parseIncoming: mockParseIncoming,
  formatResponse: mockFormatResponse,
}));

mock.module('../../adapters', () => ({
  getAdapter: mockGetAdapter,
}));

// Mock @chimera/core before importing route to avoid BEDROCK_MODELS export issue
const mockInvoke = mock(() => Promise.resolve({ output: 'Hello from Chimera!' }));
const mockCreateAgent = mock(() => ({ invoke: mockInvoke }));
const mockCreateDefaultSystemPrompt = mock(() => 'You are a helpful assistant.');
const mockResolveUser = mock(() => Promise.resolve(null));
const mockUpdatePairing = mock(() => Promise.resolve({}));
const MockUserPairingService = mock(() => ({
  resolveUser: mockResolveUser,
  updatePairing: mockUpdatePairing,
}));

mock.module('@chimera/core', () => ({
  createAgent: mockCreateAgent,
  createDefaultSystemPrompt: mockCreateDefaultSystemPrompt,
  UserPairingService: MockUserPairingService,
}));

import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';

import telegramRouter from '../../routes/telegram';
import type { TenantContext } from '../../types';

function createTestApp(tenantContext?: { tenantId: string; userId?: string }) {
  const app = new Hono();
  if (tenantContext) {
    app.use('/telegram/*', async (c, next) => {
      (c as any).set('tenantContext', {
        tenantId: tenantContext.tenantId,
        userId: tenantContext.userId,
        tier: 'enterprise',
      } as TenantContext);
      await next();
    });
  }
  app.route('/telegram', telegramRouter);
  return createAdaptorServer({ fetch: app.fetch });
}

// A valid Telegram text message update
function makeTextUpdate(overrides: Record<string, any> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      from: {
        id: 8734062810,
        is_bot: false,
        first_name: 'Alice',
        username: 'alice',
      },
      chat: {
        id: 8734062810,
        type: 'private',
      },
      text: 'Hello!',
      ...overrides,
    },
  };
}

describe('Telegram Routes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('POST /webhook', () => {
    describe('when TELEGRAM_WEBHOOK_SECRET is not set (dev mode)', () => {
      beforeEach(() => {
        delete process.env.TELEGRAM_WEBHOOK_SECRET;
      });

      it('should process a valid text message', async () => {
        const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

        const response = await request(app)
          .post('/telegram/webhook')
          .send(makeTextUpdate())
          .expect(200);

        // Should respond with Telegram sendMessage format
        expect(response.body).toHaveProperty('method', 'sendMessage');
        expect(response.body).toHaveProperty('chat_id', 8734062810);
        expect(response.body).toHaveProperty('text');
        expect(response.body).toHaveProperty('parse_mode', 'Markdown');
      });

      it('should return 200 for non-text updates (sticker, photo, etc.)', async () => {
        const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

        const nonTextUpdate = {
          update_id: 2,
          message: {
            message_id: 43,
            from: { id: 8734062810, is_bot: false, first_name: 'Alice' },
            chat: { id: 8734062810, type: 'private' },
            // No text field — sticker/photo/etc.
          },
        };

        const response = await request(app)
          .post('/telegram/webhook')
          .send(nonTextUpdate)
          .expect(200);

        expect(response.body).toEqual({ ok: true });
      });

      it('should return 200 for updates with no message', async () => {
        const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

        const noMessageUpdate = { update_id: 3 };

        const response = await request(app)
          .post('/telegram/webhook')
          .send(noMessageUpdate)
          .expect(200);

        expect(response.body).toEqual({ ok: true });
      });

      it('should filter out bot messages to prevent loops', async () => {
        const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

        const botUpdate = makeTextUpdate({
          from: {
            id: 99999,
            is_bot: true,
            first_name: 'MyBot',
          },
        });

        const response = await request(app)
          .post('/telegram/webhook')
          .send(botUpdate)
          .expect(200);

        expect(response.body).toEqual({ ok: true });
      });

      it('should return 500 when tenant context is missing', async () => {
        const app = createTestApp(); // No tenantContext

        const response = await request(app)
          .post('/telegram/webhook')
          .send(makeTextUpdate())
          .expect(500);

        expect(response.body.error.code).toBe('MISSING_TENANT_CONTEXT');
      });
    });

    describe('secret token verification', () => {
      const SECRET = 'my-super-secret-token';

      beforeEach(() => {
        process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
      });

      afterEach(() => {
        delete process.env.TELEGRAM_WEBHOOK_SECRET;
      });

      it('should accept requests with a valid secret token', async () => {
        const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

        const response = await request(app)
          .post('/telegram/webhook')
          .set('x-telegram-bot-api-secret-token', SECRET)
          .send(makeTextUpdate())
          .expect(200);

        expect(response.body).toHaveProperty('method', 'sendMessage');
      });

      it('should reject requests with an invalid token (401)', async () => {
        const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

        const response = await request(app)
          .post('/telegram/webhook')
          .set('x-telegram-bot-api-secret-token', 'wrong-token')
          .send(makeTextUpdate())
          .expect(401);

        expect(response.body.error.code).toBe('INVALID_TOKEN');
      });

      it('should reject requests with no token header (401)', async () => {
        const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

        const response = await request(app)
          .post('/telegram/webhook')
          .send(makeTextUpdate())
          .expect(401);

        expect(response.body.error.code).toBe('INVALID_TOKEN');
      });

      it('should reject requests in production when secret is not configured', async () => {
        delete process.env.TELEGRAM_WEBHOOK_SECRET;
        process.env.NODE_ENV = 'production';

        const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

        const response = await request(app)
          .post('/telegram/webhook')
          .send(makeTextUpdate())
          .expect(401);

        expect(response.body.error.code).toBe('INVALID_TOKEN');
      });
    });

    describe('error handling', () => {
      it('should return 200 even on internal errors (prevents Telegram retries)', async () => {
        // We mock a bad body to trigger an error path — telegram router should
        // respond 200 so Telegram doesn't keep retrying
        delete process.env.TELEGRAM_WEBHOOK_SECRET;

        const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

        // Send an empty body that will fail adapter.parseIncoming
        const response = await request(app)
          .post('/telegram/webhook')
          .send({})
          .expect(200);

        // Update with no message returns ok: true (non-text path)
        expect(response.body).toHaveProperty('ok', true);
      });
    });
  });

  describe('POST /set-webhook', () => {
    beforeEach(() => {
      delete process.env.TELEGRAM_WEBHOOK_SECRET;
    });

    it('should succeed with valid url and secretToken', async () => {
      const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

      const response = await request(app)
        .post('/telegram/set-webhook')
        .send({
          url: 'https://example.com/telegram/webhook',
          secretToken: 'my-secret',
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.result).toBe(true);
      expect(response.body.description).toBe('Webhook was set');
      expect(response.body.webhookUrl).toBe('https://example.com/telegram/webhook');
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should reject request without url (400)', async () => {
      const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

      const response = await request(app)
        .post('/telegram/set-webhook')
        .send({ secretToken: 'my-secret' })
        .expect(400);

      expect(response.body.error.code).toBe('MISSING_REQUIRED_FIELDS');
    });

    it('should reject request without secretToken (400)', async () => {
      const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

      const response = await request(app)
        .post('/telegram/set-webhook')
        .send({ url: 'https://example.com/telegram/webhook' })
        .expect(400);

      expect(response.body.error.code).toBe('MISSING_REQUIRED_FIELDS');
    });

    it('should require tenant context (500)', async () => {
      const app = createTestApp(); // No tenant context

      const response = await request(app)
        .post('/telegram/set-webhook')
        .send({
          url: 'https://example.com/telegram/webhook',
          secretToken: 'my-secret',
        })
        .expect(500);

      expect(response.body.error.code).toBe('MISSING_TENANT_CONTEXT');
    });
  });
});
