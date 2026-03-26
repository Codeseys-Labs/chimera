/**
 * Discord route tests
 */

// Mock dependencies before importing the router.
// Also prevents module contamination: bun test runs all test files in the same
// process, so teams.test.ts mocking '../../adapters' with a Teams-style adapter
// would corrupt these discord tests without explicit per-file mocks.
jest.mock('@chimera/core', () => ({
  createAgent: jest.fn().mockReturnValue({
    invoke: jest.fn().mockResolvedValue({ output: 'Hello from Chimera!' }),
  }),
  createDefaultSystemPrompt: jest.fn().mockReturnValue('You are a helpful assistant.'),
}));

jest.mock('../../adapters', () => ({
  getAdapter: jest.fn().mockReturnValue({
    parseIncoming: jest.fn().mockImplementation((body: any) => {
      // Slash command interaction (type 2)
      if (body && typeof body.type === 'number' && body.type === 2) {
        const options: Array<{ name: string; value: string }> = body.data?.options ?? [];
        const msgOpt = options.find(
          (o: { name: string; value: string }) => o.name === 'message' || o.name === 'prompt'
        );
        if (!msgOpt || !msgOpt.value) {
          throw new Error('Slash command missing message/prompt option');
        }
        return [{ role: 'user', content: msgOpt.value }];
      }
      // Webhook message (has content or author field)
      if (body && ('content' in body || 'author' in body)) {
        if (body.content === undefined || typeof body.content !== 'string') {
          throw new Error('Message missing content field');
        }
        return [{ role: 'user', content: body.content }];
      }
      throw new Error('Unsupported Discord payload format');
    }),
    formatResponse: jest.fn().mockReturnValue({
      embeds: [{ description: 'Hello from Chimera!', color: 0x5865f2 }],
    }),
  }),
}));

import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';
import crypto from 'crypto';
import discordRouter from '../../routes/discord';
import { TenantContext } from '../../types';

// Generate Ed25519 key pair once for all signature tests
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
// Strip the 12-byte DER header to get the raw 32-byte key
const TEST_PUBLIC_KEY_HEX = publicKeyDer.slice(12).toString('hex');

/**
 * Sign a Discord request body with the test private key
 */
function signRequest(body: string): { signature: string; timestamp: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + body;
  const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('hex');
  return { signature, timestamp };
}

/**
 * Create a minimal Hono test app with the discord router and optional tenant context
 */
function createTestApp(tenantContext?: Partial<TenantContext>) {
  const app = new Hono();

  app.use('/discord/*', async (c, next) => {
    if (tenantContext) {
      // Cast to any to bypass Hono's strict context variable typing in tests
      (c as any).set('tenantContext', {
        tenantId: tenantContext.tenantId ?? 'test-tenant',
        tier: tenantContext.tier ?? 'basic',
        userId: tenantContext.userId,
      } as TenantContext);
    }
    await next();
  });

  app.route('/discord', discordRouter);
  return createAdaptorServer({ fetch: app.fetch });
}

describe('Discord Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /discord/interactions', () => {
    describe('PING challenge (type 1)', () => {
      it('should respond { type: 1 } to PING without DISCORD_PUBLIC_KEY set', async () => {
        // In test env (NODE_ENV=test), missing key skips verification
        const app = createTestApp();
        const body = JSON.stringify({ type: 1 });
        const { signature, timestamp } = signRequest(body);

        const response = await request(app)
          .post('/discord/interactions')
          .set('Content-Type', 'application/json')
          .set('X-Signature-Ed25519', signature)
          .set('X-Signature-Timestamp', timestamp)
          .send(body);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ type: 1 });
      });

      it('should respond { type: 1 } to PING with valid Ed25519 signature', async () => {
        const savedKey = process.env.DISCORD_PUBLIC_KEY;
        process.env.DISCORD_PUBLIC_KEY = TEST_PUBLIC_KEY_HEX;

        try {
          const app = createTestApp();
          const body = JSON.stringify({ type: 1 });
          const { signature, timestamp } = signRequest(body);

          const response = await request(app)
            .post('/discord/interactions')
            .set('Content-Type', 'application/json')
            .set('X-Signature-Ed25519', signature)
            .set('X-Signature-Timestamp', timestamp)
            .send(body);

          expect(response.status).toBe(200);
          expect(response.body).toEqual({ type: 1 });
        } finally {
          if (savedKey !== undefined) {
            process.env.DISCORD_PUBLIC_KEY = savedKey;
          } else {
            delete process.env.DISCORD_PUBLIC_KEY;
          }
        }
      });
    });

    describe('Signature verification', () => {
      it('should return 401 when signature headers are missing', async () => {
        const app = createTestApp({ tenantId: 'test-tenant' });

        const response = await request(app)
          .post('/discord/interactions')
          .send({ type: 1 });

        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('MISSING_SIGNATURE_HEADERS');
      });

      it('should return 401 when X-Signature-Timestamp is missing', async () => {
        const app = createTestApp({ tenantId: 'test-tenant' });

        const response = await request(app)
          .post('/discord/interactions')
          .set('X-Signature-Ed25519', 'abcdef1234')
          .send({ type: 1 });

        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('MISSING_SIGNATURE_HEADERS');
      });

      it('should return 401 with invalid Ed25519 signature when public key is set', async () => {
        const savedKey = process.env.DISCORD_PUBLIC_KEY;
        process.env.DISCORD_PUBLIC_KEY = TEST_PUBLIC_KEY_HEX;

        try {
          const app = createTestApp();
          // 64-byte invalid signature (128 hex chars)
          const badSig = 'deadbeef'.repeat(16);

          const response = await request(app)
            .post('/discord/interactions')
            .set('Content-Type', 'application/json')
            .set('X-Signature-Ed25519', badSig)
            .set('X-Signature-Timestamp', Math.floor(Date.now() / 1000).toString())
            .send(JSON.stringify({ type: 1 }));

          expect(response.status).toBe(401);
          expect(response.body.error.code).toBe('INVALID_SIGNATURE');
        } finally {
          if (savedKey !== undefined) {
            process.env.DISCORD_PUBLIC_KEY = savedKey;
          } else {
            delete process.env.DISCORD_PUBLIC_KEY;
          }
        }
      });
    });

    describe('APPLICATION_COMMAND (type 2) slash commands', () => {
      it('should return ephemeral error without tenant context', async () => {
        // No tenant context injected
        const app = createTestApp();
        const body = JSON.stringify({
          type: 2,
          data: {
            name: 'ai',
            options: [{ name: 'message', value: 'Hello' }],
          },
        });
        const { signature, timestamp } = signRequest(body);

        const response = await request(app)
          .post('/discord/interactions')
          .set('Content-Type', 'application/json')
          .set('X-Signature-Ed25519', signature)
          .set('X-Signature-Timestamp', timestamp)
          .send(body);

        expect(response.status).toBe(200);
        expect(response.body.type).toBe(4);
        expect(response.body.data.content).toContain('Authentication error');
        expect(response.body.data.flags).toBe(64); // EPHEMERAL
      });

      it('should process slash command and return type 4 with embeds', async () => {
        const app = createTestApp({ tenantId: 'test-tenant', tier: 'basic' });
        const body = JSON.stringify({
          type: 2,
          data: {
            name: 'ai',
            options: [{ name: 'message', value: 'What is 2+2?' }],
          },
          member: { user: { id: '123456789', username: 'testuser' } },
          channel_id: '987654321',
        });
        const { signature, timestamp } = signRequest(body);

        const response = await request(app)
          .post('/discord/interactions')
          .set('Content-Type', 'application/json')
          .set('X-Signature-Ed25519', signature)
          .set('X-Signature-Timestamp', timestamp)
          .send(body);

        expect(response.status).toBe(200);
        expect(response.body.type).toBe(4);
        expect(response.body.data).toBeDefined();
        expect(Array.isArray(response.body.data.embeds)).toBe(true);
        expect(response.body.data.embeds.length).toBeGreaterThan(0);
      });

      it('should return ephemeral error for invalid slash command format', async () => {
        const app = createTestApp({ tenantId: 'test-tenant', tier: 'basic' });
        const body = JSON.stringify({
          type: 2,
          data: {
            name: 'ai',
            options: [], // No message/prompt option
          },
        });
        const { signature, timestamp } = signRequest(body);

        const response = await request(app)
          .post('/discord/interactions')
          .set('Content-Type', 'application/json')
          .set('X-Signature-Ed25519', signature)
          .set('X-Signature-Timestamp', timestamp)
          .send(body);

        expect(response.status).toBe(200);
        expect(response.body.type).toBe(4);
        expect(response.body.data.flags).toBe(64); // EPHEMERAL
      });

      it('should return ephemeral error for unsupported interaction sub-type', async () => {
        const app = createTestApp({ tenantId: 'test-tenant', tier: 'basic' });
        // type 3 = MESSAGE_COMPONENT — not supported, adapter throws
        const body = JSON.stringify({
          type: 2,
          data: {
            name: 'ai',
            options: [{ name: 'other', value: 'test' }], // option name is not message/prompt
          },
        });
        const { signature, timestamp } = signRequest(body);

        const response = await request(app)
          .post('/discord/interactions')
          .set('Content-Type', 'application/json')
          .set('X-Signature-Ed25519', signature)
          .set('X-Signature-Timestamp', timestamp)
          .send(body);

        expect(response.status).toBe(200);
        expect(response.body.type).toBe(4);
        expect(response.body.data.flags).toBe(64); // EPHEMERAL
      });
    });

    describe('Unknown interaction types', () => {
      it('should acknowledge unknown types with { type: 1 }', async () => {
        const app = createTestApp({ tenantId: 'test-tenant' });
        const body = JSON.stringify({ type: 99 });
        const { signature, timestamp } = signRequest(body);

        const response = await request(app)
          .post('/discord/interactions')
          .set('Content-Type', 'application/json')
          .set('X-Signature-Ed25519', signature)
          .set('X-Signature-Timestamp', timestamp)
          .send(body);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ type: 1 });
      });
    });
  });

  describe('POST /discord/webhook', () => {
    it('should return 401 without tenant context', async () => {
      const app = createTestApp(); // No tenant context

      const response = await request(app)
        .post('/discord/webhook')
        .send({
          content: 'Hello from Discord',
          author: { id: '123456789', username: 'testuser' },
          channel_id: '987654321',
        });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('MISSING_TENANT_CONTEXT');
    });

    it('should process webhook message with tenant context', async () => {
      const app = createTestApp({ tenantId: 'test-tenant', tier: 'basic' });

      const response = await request(app)
        .post('/discord/webhook')
        .send({
          content: 'Hello from Discord',
          author: { id: '123456789', username: 'testuser' },
          channel_id: '987654321',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('embeds');
      expect(Array.isArray(response.body.embeds)).toBe(true);
    });

    it('should return { ok: true } for message missing content', async () => {
      const app = createTestApp({ tenantId: 'test-tenant', tier: 'basic' });

      const response = await request(app)
        .post('/discord/webhook')
        .send({
          author: { id: '123456789', username: 'testuser' },
          channel_id: '987654321',
          // No content field — adapter will throw
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    });

    it('should return 401 with invalid signature when public key is set', async () => {
      const savedKey = process.env.DISCORD_PUBLIC_KEY;
      process.env.DISCORD_PUBLIC_KEY = TEST_PUBLIC_KEY_HEX;

      try {
        const app = createTestApp({ tenantId: 'test-tenant', tier: 'basic' });
        const badSig = 'deadbeef'.repeat(16); // 64 bytes, wrong sig

        const response = await request(app)
          .post('/discord/webhook')
          .set('X-Signature-Ed25519', badSig)
          .set('X-Signature-Timestamp', Math.floor(Date.now() / 1000).toString())
          .send({ content: 'Hello', author: { id: '123' } });

        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('INVALID_SIGNATURE');
      } finally {
        if (savedKey !== undefined) {
          process.env.DISCORD_PUBLIC_KEY = savedKey;
        } else {
          delete process.env.DISCORD_PUBLIC_KEY;
        }
      }
    });

    it('should accept webhook with valid Ed25519 signature', async () => {
      const savedKey = process.env.DISCORD_PUBLIC_KEY;
      process.env.DISCORD_PUBLIC_KEY = TEST_PUBLIC_KEY_HEX;

      try {
        const app = createTestApp({ tenantId: 'test-tenant', tier: 'basic' });
        const body = JSON.stringify({
          content: 'Hello from Discord',
          author: { id: '123456789', username: 'testuser' },
          channel_id: '987654321',
        });
        const { signature, timestamp } = signRequest(body);

        const response = await request(app)
          .post('/discord/webhook')
          .set('Content-Type', 'application/json')
          .set('X-Signature-Ed25519', signature)
          .set('X-Signature-Timestamp', timestamp)
          .send(body);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('embeds');
      } finally {
        if (savedKey !== undefined) {
          process.env.DISCORD_PUBLIC_KEY = savedKey;
        } else {
          delete process.env.DISCORD_PUBLIC_KEY;
        }
      }
    });

    it('should process webhook without signature headers (no verification required)', async () => {
      const app = createTestApp({ tenantId: 'test-tenant', tier: 'basic' });

      // Webhook without any signature headers — still processes
      const response = await request(app)
        .post('/discord/webhook')
        .send({
          content: 'Hello without signature',
          author: { id: '111', username: 'user' },
          channel_id: '222',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('embeds');
    });
  });
});
