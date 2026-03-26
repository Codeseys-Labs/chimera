/**
 * Tests for Microsoft Teams Bot Framework webhook routes
 */

import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';

// Mock dependencies before importing the router
jest.mock('../../adapters', () => ({
  getAdapter: jest.fn().mockReturnValue({
    parseIncoming: jest.fn().mockReturnValue([{ role: 'user', content: 'Hello, bot!' }]),
    formatResponse: jest.fn().mockReturnValue({
      type: 'message',
      text: 'Hello from Chimera!',
      textFormat: 'markdown',
    }),
  }),
}));

jest.mock('@chimera/core', () => ({
  createAgent: jest.fn().mockReturnValue({
    invoke: jest.fn().mockResolvedValue({ output: 'Hello from Chimera!' }),
  }),
  createDefaultSystemPrompt: jest.fn().mockReturnValue('You are a helpful assistant.'),
}));

jest.mock('../../middleware/user-resolution', () => ({
  resolveUser: jest.fn(async (_c: any, next: any) => { await next(); }),
}));

import teamsRouter from '../../routes/teams';
import { getAdapter } from '../../adapters';
import { createAgent } from '@chimera/core';
import { resolveUser } from '../../middleware/user-resolution';
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
    jest.clearAllMocks();
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
      (getAdapter as jest.Mock).mockReturnValueOnce({
        parseIncoming: jest.fn().mockReturnValue([]),
        formatResponse: jest.fn(),
      });

      const app = createTestApp({ tenantId: 'tenant-123' });

      const response = await request(app)
        .post('/teams/messages')
        .send(makeActivity({ text: undefined }))
        .expect(200);

      expect(response.body).toEqual({ ok: true });
    });

    it('should return 200 { ok: true } when adapter.parseIncoming throws', async () => {
      (getAdapter as jest.Mock).mockReturnValueOnce({
        parseIncoming: jest.fn().mockImplementation(() => {
          throw new Error('Parse error');
        }),
        formatResponse: jest.fn(),
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
      const mockInvoke = jest.fn().mockResolvedValue({ output: 'Here is your answer.' });
      const mockFormatResponse = jest.fn().mockReturnValue({
        type: 'message',
        text: 'Here is your answer.',
        textFormat: 'markdown',
      });

      (createAgent as jest.Mock).mockReturnValueOnce({ invoke: mockInvoke });
      (getAdapter as jest.Mock).mockReturnValueOnce({
        parseIncoming: jest.fn().mockReturnValue([{ role: 'user', content: 'What is the weather?' }]),
        formatResponse: mockFormatResponse,
      });

      const app = createTestApp({ tenantId: 'tenant-abc', userId: 'user-xyz' });

      const activity = makeActivity({ text: 'What is the weather?' });
      const response = await request(app)
        .post('/teams/messages')
        .send(activity)
        .expect(200);

      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-abc',
          sessionId: `teams_${activity.conversation.id}_${activity.from.id}`,
        })
      );
      expect(mockInvoke).toHaveBeenCalledWith('What is the weather?');
      expect(response.body).toEqual({
        type: 'message',
        text: 'Here is your answer.',
        textFormat: 'markdown',
      });
    });

    it('should prefer aadObjectId over raw from.id for userId', async () => {
      const app = createTestApp({ tenantId: 'tenant-abc' });

      const activity = makeActivity({ from: { id: 'teams-raw-id', aadObjectId: 'aad-uuid' } });
      await request(app).post('/teams/messages').send(activity).expect(200);

      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'aad-uuid' })
      );
    });

    it('should fall back to from.id when aadObjectId is absent', async () => {
      const app = createTestApp({ tenantId: 'tenant-abc' });

      const activity = makeActivity({ from: { id: 'teams-raw-id' } });
      await request(app).post('/teams/messages').send(activity).expect(200);

      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'teams-raw-id' })
      );
    });

    it('should prefer resolved cognitoSub over aadObjectId when userContext is set', async () => {
      // Override resolveUser mock to inject userContext via Hono context
      (resolveUser as jest.Mock).mockImplementationOnce(async (c: any, next: any) => {
        c.set('userContext', { cognitoSub: 'cognito-sub-123' });
        await next();
      });

      const app = createTestApp({ tenantId: 'tenant-abc' });

      const activity = makeActivity({ from: { id: 'teams-raw-id', aadObjectId: 'aad-uuid' } });
      await request(app).post('/teams/messages').send(activity).expect(200);

      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'cognito-sub-123' })
      );
    });

    it('should respond 200 { ok: true } when agent.invoke throws', async () => {
      (createAgent as jest.Mock).mockReturnValueOnce({
        invoke: jest.fn().mockRejectedValue(new Error('Bedrock timeout')),
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

      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });
  });
});
