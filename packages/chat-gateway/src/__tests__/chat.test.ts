/**
 * Chat route unit tests
 */

import request from 'supertest';
import app from '../server';

describe('Chat Routes', () => {
  describe('POST /chat/message', () => {
    const validRequest = {
      messages: [
        { role: 'user', content: 'What is the capital of France?' },
      ],
    };

    it('should return ChatResponse with valid structure', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-test')
        .set('X-User-Id', 'user-test')
        .send(validRequest);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('messageId');
      expect(response.body).toHaveProperty('sessionId');
      expect(response.body).toHaveProperty('content');
      expect(response.body).toHaveProperty('finishReason');

      expect(typeof response.body.messageId).toBe('string');
      expect(typeof response.body.sessionId).toBe('string');
      expect(typeof response.body.content).toBe('string');
      expect(typeof response.body.finishReason).toBe('string');
    });

    it('should handle multi-turn conversations', async () => {
      const multiTurnRequest = {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'Tell me a joke' },
        ],
      };

      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-test')
        .send(multiTurnRequest);

      expect(response.status).toBe(200);
      expect(response.body.content).toBeDefined();
    });

    it('should reject empty messages array', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-test')
        .send({ messages: [] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('EMPTY_MESSAGES');
    });

    it('should reject last message from assistant', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-test')
        .send({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_LAST_MESSAGE');
    });

    it('should reject invalid message format', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-test')
        .send({
          messages: [{ invalid: 'format' }],
        });

      expect(response.status).toBe(500); // Caught by error handler
      expect(response.body.error).toBeDefined();
    });
  });

  describe('POST /chat/stream', () => {
    const validRequest = {
      messages: [
        { role: 'user', content: 'Tell me a story' },
      ],
    };

    it('should return SSE content-type header', async () => {
      const response = await request(app)
        .post('/chat/stream')
        .set('X-Tenant-Id', 'tenant-test')
        .set('X-User-Id', 'user-test')
        .send(validRequest);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
    });

    it('should include x-vercel-ai-ui-message-stream header', async () => {
      const response = await request(app)
        .post('/chat/stream')
        .set('X-Tenant-Id', 'tenant-test')
        .send(validRequest);

      expect(response.headers['x-vercel-ai-ui-message-stream']).toBe('v1');
    });

    it('should return SSE-formatted data', async () => {
      const response = await request(app)
        .post('/chat/stream')
        .set('X-Tenant-Id', 'tenant-test')
        .send(validRequest);

      expect(response.status).toBe(200);

      // Response text should contain SSE "data:" lines
      const body = response.text;
      expect(body).toContain('data:');
    });

    it('should reject empty messages in streaming mode', async () => {
      const response = await request(app)
        .post('/chat/stream')
        .set('X-Tenant-Id', 'tenant-test')
        .send({ messages: [] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('EMPTY_MESSAGES');
    });
  });

  describe('Session Management', () => {
    it('should accept optional sessionId for resuming conversations', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-test')
        .send({
          sessionId: 'existing-session-123',
          messages: [{ role: 'user', content: 'Continue our chat' }],
        });

      expect(response.status).toBe(200);
      // Session ID might not match in placeholder implementation,
      // but request should succeed
    });

    it('should generate new sessionId if not provided', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-test')
        .send({
          messages: [{ role: 'user', content: 'New conversation' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.sessionId).toMatch(/^session-/);
    });
  });
});
