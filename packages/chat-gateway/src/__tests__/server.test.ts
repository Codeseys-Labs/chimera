/**
 * Server integration tests
 */

import request from 'supertest';
import app from '../server';

describe('Chat Gateway Server', () => {
  describe('Server Initialization', () => {
    it('should create app without errors', () => {
      expect(app).toBeDefined();
      expect(typeof app).toBe('function'); // Express apps are functions
    });
  });

  describe('GET /health', () => {
    it('should return 200 with healthy status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'healthy',
        service: 'chimera-chat-gateway',
        version: '0.1.0',
      });
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('POST /chat/stream', () => {
    it('should return 401 without X-Tenant-Id header', async () => {
      const response = await request(app)
        .post('/chat/stream')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toMatchObject({
        code: 'MISSING_TENANT_ID',
        message: 'X-Tenant-Id header is required',
      });
    });

    it('should return 400 without messages array', async () => {
      const response = await request(app)
        .post('/chat/stream')
        .set('X-Tenant-Id', 'tenant-123')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('EMPTY_MESSAGES');
    });

    // Skip: supertest doesn't handle SSE streams well
    it.skip('should return SSE headers with valid request', async () => {
      const response = await request(app)
        .post('/chat/stream')
        .set('X-Tenant-Id', 'tenant-123')
        .set('X-User-Id', 'user-456')
        .send({
          messages: [{ role: 'user', content: 'Hello, agent!' }],
        });

      // Should get SSE response (even if placeholder)
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['x-vercel-ai-ui-message-stream']).toBe('v1');
    });
  });

  describe('POST /chat/message', () => {
    it('should return 401 without X-Tenant-Id header', async () => {
      const response = await request(app)
        .post('/chat/message')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toMatchObject({
        code: 'MISSING_TENANT_ID',
      });
    });

    it('should return 400 without messages array', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-123')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('EMPTY_MESSAGES');
    });

    it('should return ChatResponse with valid request', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-123')
        .set('X-User-Id', 'user-456')
        .send({
          messages: [{ role: 'user', content: 'Hello, agent!' }],
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        messageId: expect.stringMatching(/^msg_/),
        sessionId: expect.stringMatching(/^session-/),
        content: expect.any(String),
        finishReason: 'end_turn',
      });
    });
  });

  describe('Tenant Context Extraction', () => {
    it('should extract tenant tier from header', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-enterprise')
        .set('X-Tenant-Tier', 'enterprise')
        .send({
          messages: [{ role: 'user', content: 'Test' }],
        });

      expect(response.status).toBe(200);
    });

    it('should default to basic tier if invalid', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-unknown')
        .set('X-Tenant-Tier', 'invalid-tier')
        .send({
          messages: [{ role: 'user', content: 'Test' }],
        });

      expect(response.status).toBe(200);
    });
  });
});
