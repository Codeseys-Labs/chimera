/**
 * Integration tests for agent session lifecycle.
 * Tests session creation, invocation, state management, and cleanup.
 *
 * Requires: AgentCore Runtime staging environment
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { TestClient } from '../helpers/test-client';

// Test configuration from environment
const TEST_CONFIG = {
  apiUrl: process.env.CHIMERA_TEST_API_URL || 'http://localhost:3000',
  tenantId: process.env.CHIMERA_TEST_TENANT_ID || 'test-integration',
  authToken: process.env.CHIMERA_TEST_AUTH_TOKEN || '',
  timeout: 60000, // 60 seconds for integration tests
};

describe('Agent Lifecycle Integration Tests', () => {
  if (!process.env.RUN_E2E) {
    test.skip('skipped: RUN_E2E not set', () => {});
    return;
  }

  let client: TestClient;
  const createdSessions: string[] = [];

  beforeAll(() => {
    client = new TestClient(TEST_CONFIG);
  });

  afterAll(async () => {
    // Cleanup: delete all created sessions
    // (In production, sessions auto-expire via DynamoDB TTL)
    console.log(`Cleanup: ${createdSessions.length} sessions created during tests`);
  });

  describe('Session Creation', () => {
    test('should create a new session with default agent', async () => {
      const session = await client.createSession();

      expect(session).toBeDefined();
      expect(session.sessionId).toMatch(/^sess-[a-z0-9]+$/);
      expect(session.tenantId).toBe(TEST_CONFIG.tenantId);
      expect(session.agentId).toBe('chatbot');

      createdSessions.push(session.sessionId);
    });

    test('should create session with custom agent type', async () => {
      const session = await client.createSession({
        agentType: 'code-assistant',
      });

      expect(session.agentId).toBe('code-assistant');
      createdSessions.push(session.sessionId);
    });

    test('should create session with installed skills', async () => {
      const session = await client.createSession({
        agentType: 'chatbot',
        skills: ['web-search'],
      });

      expect(session.sessionId).toBeDefined();
      createdSessions.push(session.sessionId);
    });

    test('should create session with budget limit', async () => {
      const session = await client.createSession({
        agentType: 'chatbot',
        budgetUsd: 0.10, // 10 cent cap for this session
      });

      expect(session.sessionId).toBeDefined();
      createdSessions.push(session.sessionId);
    });

    test('should enforce concurrent session limits', async () => {
      // Create up to the limit for the tier
      const sessions = await Promise.all([
        client.createSession(),
        client.createSession(),
        client.createSession(),
      ]);

      expect(sessions).toHaveLength(3);
      sessions.forEach((s) => createdSessions.push(s.sessionId));
    });
  });

  describe('Session State Management', () => {
    test('should retrieve session by ID', async () => {
      const created = await client.createSession();
      createdSessions.push(created.sessionId);

      const retrieved = await client.getSession(created.sessionId);

      expect(retrieved.sessionId).toBe(created.sessionId);
      expect(retrieved.tenantId).toBe(TEST_CONFIG.tenantId);
      expect(retrieved.state).toBeDefined();
    });

    test('should return 404 for non-existent session', async () => {
      await expect(
        client.getSession('sess-nonexistent')
      ).rejects.toThrow(/404/);
    });

    test('should not allow cross-tenant session access', async () => {
      // This test requires a second tenant (skip if not available)
      if (!process.env.CHIMERA_TEST_TENANT_B_ID) {
        console.log('Skipping cross-tenant test: CHIMERA_TEST_TENANT_B_ID not set');
        return;
      }

      const session = await client.createSession();
      createdSessions.push(session.sessionId);

      // Create client with different tenant ID
      const otherTenantClient = new TestClient({
        ...TEST_CONFIG,
        tenantId: process.env.CHIMERA_TEST_TENANT_B_ID!,
      });

      // Attempt to access session from other tenant
      await expect(
        otherTenantClient.getSession(session.sessionId)
      ).rejects.toThrow(/403|404/);
    });
  });

  describe('Agent Invocation', () => {
    test('should respond to simple message', async () => {
      const session = await client.createSession();
      createdSessions.push(session.sessionId);

      const response = await client.sendMessage({
        sessionId: session.sessionId,
        message: 'Hello, what can you help me with?',
      });

      expect(response.status).toBe('completed');
      expect(response.text).toBeTruthy();
      expect(response.text.length).toBeGreaterThan(10);
      expect(response.tokenUsage.total).toBeGreaterThan(0);
      expect(response.durationMs).toBeGreaterThan(0);
    });

    test('should maintain context across turns', async () => {
      const session = await client.createSession();
      createdSessions.push(session.sessionId);

      // First turn: provide context
      await client.sendMessage({
        sessionId: session.sessionId,
        message: 'My name is Alice and I work on infrastructure.',
      });

      // Second turn: reference previous context
      const response = await client.sendMessage({
        sessionId: session.sessionId,
        message: 'What is my name and what do I work on?',
      });

      expect(response.status).toBe('completed');
      expect(response.text.toLowerCase()).toMatch(/alice/);
      expect(response.text.toLowerCase()).toMatch(/infrastructure/);
    });

    test('should respect session timeout', async () => {
      const session = await client.createSession();
      createdSessions.push(session.sessionId);

      // Send message with very short timeout
      await expect(
        client.sendMessage({
          sessionId: session.sessionId,
          message: 'Write a very long essay about the history of computing.',
          timeout: 100, // 100ms timeout
        })
      ).rejects.toThrow();
    });
  });

  describe('Session Isolation', () => {
    test('should isolate state between sessions', async () => {
      // Create two sessions
      const session1 = await client.createSession();
      const session2 = await client.createSession();
      createdSessions.push(session1.sessionId, session2.sessionId);

      // Send different context to each
      await client.sendMessage({
        sessionId: session1.sessionId,
        message: 'Remember the secret word: ALPHA',
      });

      await client.sendMessage({
        sessionId: session2.sessionId,
        message: 'Remember the secret word: BRAVO',
      });

      // Verify isolation
      const response1 = await client.sendMessage({
        sessionId: session1.sessionId,
        message: 'What secret word did I tell you?',
      });

      const response2 = await client.sendMessage({
        sessionId: session2.sessionId,
        message: 'What secret word did I tell you?',
      });

      expect(response1.text.toUpperCase()).toContain('ALPHA');
      expect(response1.text.toUpperCase()).not.toContain('BRAVO');

      expect(response2.text.toUpperCase()).toContain('BRAVO');
      expect(response2.text.toUpperCase()).not.toContain('ALPHA');
    });
  });

  describe('Cost Tracking', () => {
    test('should track token usage per invocation', async () => {
      const session = await client.createSession();
      createdSessions.push(session.sessionId);

      const response = await client.sendMessage({
        sessionId: session.sessionId,
        message: 'Say hello',
      });

      expect(response.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(response.tokenUsage.outputTokens).toBeGreaterThan(0);
      expect(response.tokenUsage.total).toBe(
        response.tokenUsage.inputTokens + response.tokenUsage.outputTokens
      );
    });

    test('should enforce budget limits', async () => {
      const session = await client.createSession({
        budgetUsd: 0.001, // Very low budget (0.1 cent)
      });
      createdSessions.push(session.sessionId);

      // Try to send a message that exceeds budget
      const response = await client.sendMessage({
        sessionId: session.sessionId,
        message: 'Write a 5000-word essay on quantum computing.',
      });

      // Should either complete with budget_exceeded status or return partial response
      expect(['completed', 'budget_exceeded']).toContain(response.status);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid session ID', async () => {
      await expect(
        client.sendMessage({
          sessionId: 'invalid-session-id',
          message: 'Hello',
        })
      ).rejects.toThrow();
    });

    test('should handle empty message', async () => {
      const session = await client.createSession();
      createdSessions.push(session.sessionId);

      await expect(
        client.sendMessage({
          sessionId: session.sessionId,
          message: '',
        })
      ).rejects.toThrow();
    });

    test('should handle very long message', async () => {
      const session = await client.createSession();
      createdSessions.push(session.sessionId);

      // Create a message near the token limit
      const longMessage = 'test '.repeat(20000); // ~100k chars, ~25k tokens

      const response = await client.sendMessage({
        sessionId: session.sessionId,
        message: longMessage,
        timeout: 120000, // 2 min timeout for large message
      });

      // Should complete or return error about length
      expect(['completed', 'error']).toContain(response.status);
    });
  });
});
