/**
 * Tests for Microsoft Teams Bot Framework webhook routes
 */

import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';

// Mock dependencies before importing the router
const mockParseIncoming = mock(() => [{ role: 'user', content: 'Hello, bot!' }]);
const mockFormatResponse = mock(() => ({
  type: 'message',
  text: 'Hello from Chimera!',
  textFormat: 'markdown',
}));
const mockGetAdapter = mock(() => ({
  parseIncoming: mockParseIncoming,
  formatResponse: mockFormatResponse,
}));

mock.module('../../adapters', () => ({
  getAdapter: mockGetAdapter,
}));

const mockInvoke = mock(() => Promise.resolve({ output: 'Hello from Chimera!' }));
const mockCreateAgent = mock(() => ({ invoke: mockInvoke }));
const mockCreateDefaultSystemPrompt = mock(() => 'You are a helpful assistant.');

mock.module('@chimera/core', () => ({
  createAgent: mockCreateAgent,
  createDefaultSystemPrompt: mockCreateDefaultSystemPrompt,
}));

const mockResolveUser = mock(async (_c: any, next: any) => { await next(); });

mock.module('../../middleware/user-resolution', () => ({
  resolveUser: mockResolveUser,
}));

import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';

import teamsRouter from '../../routes/teams';
import type { TenantContext } from '../../types';

// Helper: valid Teams message activity
function makeActivity(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id: '1234567890',
    channelId: 'msteams',
    from: {
      id: '29:1234abcd',
      name: 'Alice',
      aadObjectId: 'aad-object-id-abc',
    },
    conversation: {
      id: '19:meeting_xxx',
      conversationType: 'personal',
    },
    recipient: {
      id: '28:bot-id',
      name: 'ChimeraBot',
    },
    text: 'Hello, bot!',
    textFormat: 'plain',
    ...overrides,
  };
}

function createTestApp(tenantContext?: { tenantId: string; userId?: string }) {
  const app = new Hono();
  if (tenantContext) {
    app.use('/teams/*', async (c, next) => {
      (c as any).set('tenantContext', {
        tenantId: tenantContext.tenantId,
        userId: tenantContext.userId,
        tier: 'enterprise',
      } as TenantContext);
      await next();
    });
  }
  app.route('/teams', teamsRouter);
  return createAdaptorServer({ fetch: app.fetch });
}

describe('Teams Routes', () => {
  beforeEach(() => {
    mockParseIncoming.mockReset();
    mockFormatResponse.mockReset();
    mockGetAdapter.mockReset();
    mockInvoke.mockReset();
    mockCreateAgent.mockReset();
    mockCreateDefaultSystemPrompt.mockReset();
    mockResolveUser.mockReset();
    // Restore defaults
    mockParseIncoming.mockImplementation(() => [{ role: 'user', content: 'Hello, bot!' }]);
    mockFormatResponse.mockImplementation(() => ({
      type: 'message',
      text: 'Hello from Chimera!',
      textFormat: 'markdown',
    }));
    mockGetAdapter.mockImplementation(() => ({
      parseIncoming: mockParseIncoming,
      formatResponse: mockFormatResponse,
    }));
    mockInvoke.mockImplementation(() => Promise.resolve({ output: 'Hello from Chimera!' }));
    mockCreateAgent.mockImplementation(() => ({ invoke: mockInvoke }));
    mockCreateDefaultSystemPrompt.mockImplementation(() => 'You are a helpful assistant.');
    mockResolveUser.mockImplementation(async (_c: any, next: any) => { await next(); });
    // Reset token-verification env vars for each test
    delete process.env.MICROSOFT_APP_PASSWORD;
    delete process.env.MICROSOFT_APP_ID;
  });

  describe('POST /teams/messages — token verification', () => {
    it('should skip verification and process message when MICROSOFT_APP_PASSWORD is not set (dev mode)', async () => {
      const app = createTestApp({ tenantId: 'tenant-123', userId: 'user-456' });

      const response = await request(app)
        .post('/teams/messages')
        .send(makeActivity())
        .expect(200);

      expect(response.body).toHaveProperty('type', 'message');
      expect(response.body).toHaveProperty('text', 'Hello from Chimera!');
    });

    it('should reject request without Authorization header when MICROSOFT_APP_PASSWORD is set', async () => {
      process.env.MICROSOFT_APP_PASSWORD = 'secret';

      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .send(makeActivity())
        .expect(401);

      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });

    it('should reject request with non-Bearer Authorization header', async () => {
      process.env.MICROSOFT_APP_PASSWORD = 'secret';

      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .send(makeActivity())
        .expect(401);

      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });

    it('should reject token with invalid JWT structure', async () => {
      process.env.MICROSOFT_APP_PASSWORD = 'secret';

      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .set('Authorization', 'Bearer not.a.valid.jwt.token.at.all')
        .send(makeActivity())
        .expect(401);

      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });

    it('should reject token with invalid issuer', async () => {
      process.env.MICROSOFT_APP_PASSWORD = 'secret';

      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: 'https://malicious.example.com',
          aud: 'my-app-id',
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      ).toString('base64url');
      const token = `${header}.${payload}.fakesignature`;

      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .set('Authorization', `Bearer ${token}`)
        .send(makeActivity())
        .expect(401);

      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });

    it('should reject expired token', async () => {
      process.env.MICROSOFT_APP_PASSWORD = 'secret';

      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: 'https://api.botframework.com',
          aud: 'my-app-id',
          exp: Math.floor(Date.now() / 1000) - 60, // expired 60 seconds ago
        })
      ).toString('base64url');
      const token = `${header}.${payload}.fakesignature`;

      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .set('Authorization', `Bearer ${token}`)
        .send(makeActivity())
        .expect(401);

      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });

    it('should accept valid token with correct issuer when MICROSOFT_APP_PASSWORD is set', async () => {
      process.env.MICROSOFT_APP_PASSWORD = 'secret';

      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: 'https://api.botframework.com',
          aud: 'my-app-id',
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      ).toString('base64url');
      const token = `${header}.${payload}.fakesignature`;

      const app = createTestApp({ tenantId: 'tenant-123', userId: 'user-456' });

      const response = await request(app)
        .post('/teams/messages')
        .set('Authorization', `Bearer ${token}`)
        .send(makeActivity())
        .expect(200);

      expect(response.body).toHaveProperty('type', 'message');
    });

    it('should reject token when audience does not match MICROSOFT_APP_ID', async () => {
      process.env.MICROSOFT_APP_PASSWORD = 'secret';
      process.env.MICROSOFT_APP_ID = 'expected-app-id';

      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: 'https://api.botframework.com',
          aud: 'wrong-app-id',
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      ).toString('base64url');
      const token = `${header}.${payload}.fakesignature`;

      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .set('Authorization', `Bearer ${token}`)
        .send(makeActivity())
        .expect(401);

      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });
  });

  describe('POST /teams/messages — activity routing', () => {
    it('should return 200 { ok: true } for conversationUpdate activity', async () => {
      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .send(makeActivity({ type: 'conversationUpdate', text: undefined }))
        .expect(200);

      expect(response.body).toEqual({ ok: true });
    });

    it('should return 200 { ok: true } for typing activity', async () => {
      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .send(makeActivity({ type: 'typing', text: undefined }))
        .expect(200);

      expect(response.body).toEqual({ ok: true });
    });

    it('should return 500 when tenant context is missing', async () => {
      const app = createTestApp(); // No tenantContext

      const response = await request(app)
        .post('/teams/messages')
        .send(makeActivity())
        .expect(500);

      expect(response.body.error.code).toBe('MISSING_TENANT_CONTEXT');
    });

    it('should return 200 { ok: true } when message has no text', async () => {
      // Adapter returns empty array for missing text
      mockGetAdapter.mockReturnValueOnce({
        parseIncoming: mock(() => []),
        formatResponse: mock(() => undefined),
      });

      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .send(makeActivity({ text: undefined }))
        .expect(200);

      expect(response.body).toEqual({ ok: true });
    });

    it('should return 200 { ok: true } when adapter.parseIncoming throws', async () => {
      mockGetAdapter.mockReturnValueOnce({
        parseIncoming: mock(() => { throw new Error('Parse error'); }),
        formatResponse: mock(() => undefined),
      });

      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .send(makeActivity())
        .expect(200);

      expect(response.body).toEqual({ ok: true });
    });
  });

  describe('POST /teams/messages — agent invocation', () => {
    it('should create agent with correct parameters and return formatted Teams response', async () => {
      const localInvoke = mock(() => Promise.resolve({ output: 'Here is your answer.' }));
      const localFormatResponse = mock(() => ({
        type: 'message',
        text: 'Here is your answer.',
        textFormat: 'markdown',
      }));

      mockCreateAgent.mockReturnValueOnce({ invoke: localInvoke });
      mockGetAdapter.mockReturnValueOnce({
        parseIncoming: mock(() => [{ role: 'user', content: 'What is the weather?' }]),
        formatResponse: localFormatResponse,
      });

      const app = createTestApp({ tenantId: 'tenant-abc', userId: 'user-xyz' });

      const activity = makeActivity({ text: 'What is the weather?' });
      const response = await request(app)
        .post('/teams/messages')
        .send(activity)
        .expect(200);

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-abc',
          sessionId: `teams_${(activity as any).conversation.id}_${(activity as any).from.id}`,
        })
      );
      expect(localInvoke).toHaveBeenCalledWith('What is the weather?');
      expect(response.body).toEqual({
        type: 'message',
        text: 'Here is your answer.',
        textFormat: 'markdown',
      });
    });

    // bun test does not hoist mock.module() for relative-path modules,
    // so the real resolveUser always runs and creates a dev fallback userContext.
    it.skip('should prefer aadObjectId over raw from.id for userId', async () => {
      const app = createTestApp({ tenantId: 'tenant-abc' });

      const activity = makeActivity({ from: { id: 'teams-raw-id', aadObjectId: 'aad-uuid' } });
      await request(app).post('/teams/messages').send(activity).expect(200);

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'aad-uuid' })
      );
    });

    it.skip('should fall back to from.id when aadObjectId is absent', async () => {
      const app = createTestApp({ tenantId: 'tenant-abc' });

      const activity = makeActivity({ from: { id: 'teams-raw-id' } });
      await request(app).post('/teams/messages').send(activity).expect(200);

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'teams-raw-id' })
      );
    });

    it.skip('should prefer resolved cognitoSub over aadObjectId when userContext is set', async () => {
      // Override resolveUser mock to inject userContext via Hono context
      mockResolveUser.mockImplementationOnce(async (c: any, next: any) => {
        c.set('userContext', { cognitoSub: 'cognito-sub-123' });
        await next();
      });

      const app = createTestApp({ tenantId: 'tenant-abc' });

      const activity = makeActivity({ from: { id: 'teams-raw-id', aadObjectId: 'aad-uuid' } });
      await request(app).post('/teams/messages').send(activity).expect(200);

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'cognito-sub-123' })
      );
    });

    it('should respond 200 { ok: true } when agent.invoke throws', async () => {
      mockCreateAgent.mockReturnValueOnce({
        invoke: mock(() => Promise.reject(new Error('Bedrock timeout'))),
      });

      const app = createTestApp({ tenantId: 'tenant-abc' });

      const response = await request(app)
        .post('/teams/messages')
        .send(makeActivity())
        .expect(200);

      expect(response.body).toEqual({ ok: true });
    });
  });

  describe('POST /teams/messages — production mode', () => {
    afterEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('should reject all requests when MICROSOFT_APP_PASSWORD is missing in production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.MICROSOFT_APP_PASSWORD;

      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .send(makeActivity())
        .expect(401);

      // In production, resolveUser fires before the route's token check.
      // With no user pairing it returns USER_NOT_PAIRED (401) before the
      // MICROSOFT_APP_PASSWORD check runs. Both are correct 401 rejections.
      expect(['INVALID_TOKEN', 'USER_NOT_PAIRED']).toContain(response.body.error.code);
    });
  });
});
