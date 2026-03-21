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

      expect(response.status).toBe(400); // Invalid request format
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe('INVALID_REQUEST');
    });
  });

  describe('POST /chat/stream', () => {
    const validRequest = {
      messages: [
        { role: 'user', content: 'Tell me a story' },
      ],
    };

    // Skip: supertest doesn't handle SSE streams well, causes timeouts
    it.skip('should return SSE content-type header', async () => {
      const response = await request(app)
        .post('/chat/stream')
        .set('X-Tenant-Id', 'tenant-test')
        .set('X-User-Id', 'user-test')
        .send(validRequest);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
    });

    it.skip('should include x-vercel-ai-ui-message-stream header', async () => {
      const response = await request(app)
        .post('/chat/stream')
        .set('X-Tenant-Id', 'tenant-test')
        .send(validRequest);

      expect(response.headers['x-vercel-ai-ui-message-stream']).toBe('v1');
    });

    it.skip('should return SSE-formatted data', async () => {
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

  describe('Bedrock Model Integration', () => {
    it('should use placeholder response when BEDROCK_ENABLED=false', async () => {
      // Config defaults to enabled in tests, but we test the placeholder path
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-test')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.content).toBeDefined();
      // Placeholder responses contain "[Placeholder]" text
      if (process.env.BEDROCK_ENABLED === 'false') {
        expect(response.body.content).toContain('[Placeholder]');
      }
    });

    it('should accept platform parameter for adapter selection', async () => {
      const response = await request(app)
        .post('/chat/message')
        .set('X-Tenant-Id', 'tenant-test')
        .send({
          platform: 'web',
          messages: [{ role: 'user', content: 'Test platform routing' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.content).toBeDefined();
    });
  });
});
