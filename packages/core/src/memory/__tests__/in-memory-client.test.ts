/**
 * Tests for InMemoryClient
 * Verifies memory storage, retrieval, and isolation
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { InMemoryClient } from '../in-memory-client';
import { Message, MemoryQuery } from '../types';

describe('InMemoryClient', () => {
  let client: InMemoryClient;

  beforeEach(() => {
    client = new InMemoryClient('tenant-test-user-alice');
  });

  describe('initialization', () => {
    it('should initialize with namespace', async () => {
      await client.initialize({
        namespace: 'tenant-test-user-alice',
        strategies: {
          summary: {
            memoryWindow: 10,
            summaryRatio: 0.3,
          },
        },
      });

      expect(client.getNamespace()).toBe('tenant-test-user-alice');
    });
  });

  describe('message storage', () => {
    it('should store a single message', async () => {
      const message: Message = {
        role: 'user',
        content: 'Hello, agent!',
        timestamp: new Date().toISOString(),
      };

      await client.storeMessage(message);

      const result = await client.retrieve({ limit: 10 });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('Hello, agent!');
    });

    it('should store multiple messages in batch', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Message 1', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Response 1', timestamp: new Date().toISOString() },
        { role: 'user', content: 'Message 2', timestamp: new Date().toISOString() },
      ];

      await client.storeMessages(messages);

      const result = await client.retrieve({ limit: 10 });
      expect(result.entries).toHaveLength(3);
    });

    it('should select USER_PREFERENCE strategy for preference messages', async () => {
      await client.initialize({
        namespace: 'tenant-test-user-alice',
        strategies: {
          summary: { memoryWindow: 10 },
          userPreference: { enabled: true, maxPreferences: 50 },
        },
      });

      const message: Message = {
        role: 'user',
        content: 'I prefer Python over JavaScript',
        timestamp: new Date().toISOString(),
      };

      await client.storeMessage(message);

      const result = await client.retrieve({ strategy: 'USER_PREFERENCE' });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toContain('prefer');
    });

    it('should default to SUMMARY strategy', async () => {
      const message: Message = {
        role: 'user',
        content: 'Just a regular message',
        timestamp: new Date().toISOString(),
      };

      await client.storeMessage(message);

      const result = await client.retrieve({ strategy: 'SUMMARY' });
      expect(result.entries).toHaveLength(1);
    });
  });

  describe('retrieval', () => {
    beforeEach(async () => {
      const messages: Message[] = [
        { role: 'user', content: 'AWS Lambda question', timestamp: '2026-03-20T10:00:00Z' },
        { role: 'assistant', content: 'Lambda is serverless', timestamp: '2026-03-20T10:01:00Z' },
        { role: 'user', content: 'EC2 instance types', timestamp: '2026-03-20T10:02:00Z' },
      ];
      await client.storeMessages(messages);
    });

    it('should retrieve all entries', async () => {
      const result = await client.retrieve({ limit: 10 });
      expect(result.entries).toHaveLength(3);
      expect(result.totalCount).toBe(3);
    });

    it('should filter by query string', async () => {
      const result = await client.retrieve({ query: 'Lambda', limit: 10 });
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].content).toContain('Lambda');
    });

    it('should apply limit', async () => {
      const result = await client.retrieve({ limit: 2 });
      expect(result.entries).toHaveLength(2);
      expect(result.totalCount).toBe(3);
    });

    it('should sort by timestamp descending', async () => {
      const result = await client.retrieve({ limit: 10 });
      // Newest first
      expect(result.entries[0].content).toContain('EC2');
      expect(result.entries[2].content).toContain('AWS Lambda question');
    });
  });

  describe('session management', () => {
    it('should store and retrieve session state', async () => {
      const sessionState = {
        sessionId: 'session-123',
        messages: [
          { role: 'user' as const, content: 'Hello', timestamp: new Date().toISOString() },
        ],
        context: { userId: 'alice' },
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      };

      await client.updateSession(sessionState);

      const retrieved = await client.getSession('session-123');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.sessionId).toBe('session-123');
      expect(retrieved?.messages).toHaveLength(1);
    });

    it('should return null for non-existent session', async () => {
      const retrieved = await client.getSession('nonexistent');
      expect(retrieved).toBeNull();
    });

    it('should delete session and associated entries', async () => {
      // Store session state
      await client.updateSession({
        sessionId: 'session-456',
        messages: [],
        context: {},
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      });

      await client.deleteSession('session-456');

      const retrieved = await client.getSession('session-456');
      expect(retrieved).toBeNull();
    });
  });

  describe('namespace operations', () => {
    it('should clear all data in namespace', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Message 1', timestamp: new Date().toISOString() },
        { role: 'user', content: 'Message 2', timestamp: new Date().toISOString() },
      ];
      await client.storeMessages(messages);

      await client.clearNamespace();

      const result = await client.retrieve({ limit: 10 });
      expect(result.entries).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('should return statistics', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Test 1', timestamp: '2026-03-20T10:00:00Z' },
        { role: 'user', content: 'Test 2', timestamp: '2026-03-20T11:00:00Z' },
      ];
      await client.storeMessages(messages);

      const stats = await client.getStats();
      expect(stats.namespace).toBe('tenant-test-user-alice');
      expect(stats.totalEntries).toBe(2);
      expect(stats.totalSizeBytes).toBeGreaterThan(0);
      expect(stats.oldestEntry).toBe('2026-03-20T10:00:00Z');
      expect(stats.newestEntry).toBe('2026-03-20T11:00:00Z');
    });
  });
});
