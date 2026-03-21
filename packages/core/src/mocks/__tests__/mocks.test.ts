/**
 * Mocks module tests
 *
 * Tests for MockRuntime, MockMemoryClient, and MockGatewayClient
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { MockRuntime } from '../mock-runtime';
import type { MockRuntimeConfig } from '../mock-runtime';

describe('MockRuntime', () => {
  let runtime: MockRuntime;
  let config: MockRuntimeConfig;

  beforeEach(() => {
    config = {
      tenantId: 'test-tenant',
      memoryStrategy: 'SUMMARY',
      sessionTimeoutSeconds: 3600,
    };
    runtime = new MockRuntime(config);
  });

  describe('createSession', () => {
    it('should create a new session with generated ID', async () => {
      const session = await runtime.createSession();

      expect(session.sessionId).toMatch(/^mock-session-\d+-\d+$/);
      expect(session.state).toBe('ACTIVE');
      expect(session.tenantId).toBe('test-tenant');
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastActivityAt).toBeInstanceOf(Date);
    });

    it('should create session with user ID when provided', async () => {
      const session = await runtime.createSession('user-456');

      expect(session.userId).toBe('user-456');
      expect(session.memoryNamespace).toBe('tenant-test-tenant-user-user-456');
    });

    it('should create session without user ID', async () => {
      const session = await runtime.createSession();

      expect(session.userId).toBeUndefined();
      expect(session.memoryNamespace).toBe('tenant-test-tenant');
    });

    it('should generate unique session IDs', async () => {
      const session1 = await runtime.createSession();
      const session2 = await runtime.createSession();

      expect(session1.sessionId).not.toBe(session2.sessionId);
    });
  });

  describe('resumeSession', () => {
    it('should resume an active session', async () => {
      const created = await runtime.createSession();
      const resumed = await runtime.resumeSession(created.sessionId);

      expect(resumed.sessionId).toBe(created.sessionId);
      expect(resumed.state).toBe('ACTIVE');
      expect(resumed.lastActivityAt.getTime()).toBeGreaterThanOrEqual(created.lastActivityAt.getTime());
    });

    it('should throw error for non-existent session', async () => {
      await expect(runtime.resumeSession('invalid-session')).rejects.toThrow(
        'Session not found: invalid-session'
      );
    });

    it('should throw error for terminated session', async () => {
      const session = await runtime.createSession();
      await runtime.terminateSession(session.sessionId);

      await expect(runtime.resumeSession(session.sessionId)).rejects.toThrow(
        'Session already terminated'
      );
    });
  });

  describe('terminateSession', () => {
    it('should terminate an active session', async () => {
      const session = await runtime.createSession();
      await runtime.terminateSession(session.sessionId);

      const terminated = await runtime.getSession(session.sessionId);
      expect(terminated?.state).toBe('TERMINATED');
    });

    it('should not throw for non-existent session', async () => {
      // Should complete without error for non-existent session
      await runtime.terminateSession('invalid-session');
      // If we got here, no error was thrown
      expect(true).toBe(true);
    });
  });

  describe('storeMemory', () => {
    it('should store value in session memory', async () => {
      const session = await runtime.createSession();
      const result = await runtime.storeMemory(session.sessionId, 'user-name', 'Alice');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'user-name', stored: true });
    });

    it('should return error for non-existent session', async () => {
      const result = await runtime.storeMemory('invalid-session', 'key', 'value');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Session not found');
    });

    it('should overwrite existing values', async () => {
      const session = await runtime.createSession();
      await runtime.storeMemory(session.sessionId, 'counter', '1');
      await runtime.storeMemory(session.sessionId, 'counter', '2');

      const result = await runtime.retrieveMemory(session.sessionId, 'counter');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'counter', value: '2' });
    });
  });

  describe('retrieveMemory', () => {
    it('should retrieve stored value', async () => {
      const session = await runtime.createSession();
      await runtime.storeMemory(session.sessionId, 'test-key', 'test-value');

      const result = await runtime.retrieveMemory(session.sessionId, 'test-key');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'test-key', value: 'test-value' });
    });

    it('should return error for non-existent key', async () => {
      const session = await runtime.createSession();
      const result = await runtime.retrieveMemory(session.sessionId, 'missing-key');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Key not found');
    });

    it('should return error for non-existent session', async () => {
      const result = await runtime.retrieveMemory('invalid-session', 'key');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Session not found');
    });
  });

  describe('queryMemory', () => {
    it('should return matching memories for substring search', async () => {
      const session = await runtime.createSession();
      await runtime.storeMemory(session.sessionId, 'fact-1', 'User likes TypeScript');
      await runtime.storeMemory(session.sessionId, 'fact-2', 'User prefers Bun over Node.js');
      await runtime.storeMemory(session.sessionId, 'fact-3', 'Project uses AWS CDK');

      const result = await runtime.queryMemory(session.sessionId, 'user');

      expect(result.success).toBe(true);
      const results = (result.data as any).results;
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r: any) => r.value.toLowerCase().includes('user'))).toBe(true);
    });

    it('should return empty results when no matches', async () => {
      const session = await runtime.createSession();
      await runtime.storeMemory(session.sessionId, 'fact-1', 'Test data');

      const result = await runtime.queryMemory(session.sessionId, 'nonexistent');

      expect(result.success).toBe(true);
      expect((result.data as any).results).toHaveLength(0);
    });

    it('should sort results by relevance score', async () => {
      const session = await runtime.createSession();
      await runtime.storeMemory(session.sessionId, 'key-1', 'test at end');
      await runtime.storeMemory(session.sessionId, 'key-2', 'test at beginning');

      const result = await runtime.queryMemory(session.sessionId, 'test');

      expect(result.success).toBe(true);
      const results = (result.data as any).results;
      expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1]?.score || 0);
    });

    it('should return error for non-existent session', async () => {
      const result = await runtime.queryMemory('invalid-session', 'query');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Session not found');
    });
  });

  describe('getSession', () => {
    it('should retrieve session by ID', async () => {
      const created = await runtime.createSession();
      const retrieved = await runtime.getSession(created.sessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.sessionId).toBe(created.sessionId);
    });

    it('should return null for non-existent session', async () => {
      const session = await runtime.getSession('invalid-session');
      expect(session).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('should list all sessions when no filter', async () => {
      await runtime.createSession();
      await runtime.createSession();

      const sessions = await runtime.listSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by state', async () => {
      const session1 = await runtime.createSession();
      await runtime.createSession();
      await runtime.terminateSession(session1.sessionId);

      const active = await runtime.listSessions('ACTIVE');
      const terminated = await runtime.listSessions('TERMINATED');

      expect(active.every(s => s.state === 'ACTIVE')).toBe(true);
      expect(terminated.every(s => s.state === 'TERMINATED')).toBe(true);
    });
  });

  describe('getConfig', () => {
    it('should return current configuration', () => {
      const returned = runtime.getConfig();

      expect(returned.tenantId).toBe('test-tenant');
      expect(returned.memoryStrategy).toBe('SUMMARY');
      expect(returned.sessionTimeoutSeconds).toBe(3600);
    });

    it('should return a copy (not reference)', () => {
      const config1 = runtime.getConfig();
      const config2 = runtime.getConfig();

      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration fields', () => {
      runtime.updateConfig({ memoryStrategy: 'LONG_TERM' });

      const config = runtime.getConfig();
      expect(config.memoryStrategy).toBe('LONG_TERM');
      expect(config.tenantId).toBe('test-tenant'); // Unchanged
    });

    it('should partially update config', () => {
      runtime.updateConfig({ sessionTimeoutSeconds: 7200 });

      const config = runtime.getConfig();
      expect(config.sessionTimeoutSeconds).toBe(7200);
      expect(config.memoryStrategy).toBe('SUMMARY'); // Unchanged
    });
  });

  describe('reset', () => {
    it('should clear all sessions and memory', async () => {
      await runtime.createSession();
      await runtime.createSession();

      runtime.reset();

      const sessions = await runtime.listSessions();
      expect(sessions).toHaveLength(0);
    });

    it('should reset session counter', async () => {
      await runtime.createSession();
      await runtime.createSession();

      runtime.reset();

      const session = await runtime.createSession();
      expect(session.sessionId).toMatch(/^mock-session-1-\d+$/);
    });
  });
});
