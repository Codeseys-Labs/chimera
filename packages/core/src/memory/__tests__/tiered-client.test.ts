/**
 * Tests for TieredMemoryClient
 *
 * Validates SESSION, SWARM, and AGENT scope memory management
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  TieredMemoryClient,
  TieredMemoryClientFactory,
  TieredMemoryConfig,
  Message,
} from '../index';

describe('TieredMemoryClient', () => {
  let config: TieredMemoryConfig;
  let client: TieredMemoryClient;

  beforeEach(() => {
    config = {
      tenantId: 'test-tenant',
      userId: 'test-user',
      sessionId: 'session-123',
      swarmId: 'chimera-39d5',
      agentId: 'builder-memory-tiers',
      memoryConfig: {
        namespace: 'test',
        strategies: {
          summary: {
            memoryWindow: 10,
            summaryRatio: 0.3,
          },
        },
      },
      region: 'us-east-1',
    };

    client = TieredMemoryClientFactory.createInMemoryClient(config);
  });

  describe('Scope Availability', () => {
    it('should have SESSION scope available by default', () => {
      expect(client.hasScopeAvailable('SESSION')).toBe(true);
    });

    it('should have SWARM scope when swarmId provided', () => {
      expect(client.hasScopeAvailable('SWARM')).toBe(true);
    });

    it('should have AGENT scope when agentId provided', () => {
      expect(client.hasScopeAvailable('AGENT')).toBe(true);
    });

    it('should report all available scopes', () => {
      const scopes = client.getAvailableScopes();
      expect(scopes).toContain('SESSION');
      expect(scopes).toContain('SWARM');
      expect(scopes).toContain('AGENT');
      expect(scopes).toHaveLength(3);
    });

    it('should only have SESSION scope when no swarmId/agentId', () => {
      const minimalConfig: TieredMemoryConfig = {
        tenantId: 'test-tenant',
        userId: 'test-user',
        sessionId: 'session-123',
        memoryConfig: {
          namespace: 'test',
          strategies: {},
        },
      };

      const minimalClient = TieredMemoryClientFactory.createInMemoryClient(minimalConfig);
      const scopes = minimalClient.getAvailableScopes();

      expect(scopes).toEqual(['SESSION']);
      expect(minimalClient.hasScopeAvailable('SWARM')).toBe(false);
      expect(minimalClient.hasScopeAvailable('AGENT')).toBe(false);
    });
  });

  describe('Message Storage', () => {
    const testMessage: Message = {
      role: 'user',
      content: 'Test message content',
      timestamp: new Date().toISOString(),
    };

    it('should store message to SESSION scope', async () => {
      await client.initialize();
      await client.storeMessage(testMessage, 'SESSION');

      const results = await client.retrieve({ limit: 10 }, 'SESSION');
      expect(results.entries).toHaveLength(1);
      expect(results.entries[0].content).toBe('Test message content');
    });

    it('should store message to SWARM scope', async () => {
      await client.initialize();
      await client.storeMessage(testMessage, 'SWARM');

      const results = await client.retrieve({ limit: 10 }, 'SWARM');
      expect(results.entries).toHaveLength(1);
      expect(results.entries[0].content).toBe('Test message content');
    });

    it('should store message to AGENT scope', async () => {
      await client.initialize();
      await client.storeMessage(testMessage, 'AGENT');

      const results = await client.retrieve({ limit: 10 }, 'AGENT');
      expect(results.entries).toHaveLength(1);
      expect(results.entries[0].content).toBe('Test message content');
    });

    it('should store message to multiple scopes simultaneously', async () => {
      await client.initialize();
      await client.storeToScopes(testMessage, ['SESSION', 'SWARM', 'AGENT']);

      const sessionResults = await client.retrieve({ limit: 10 }, 'SESSION');
      const swarmResults = await client.retrieve({ limit: 10 }, 'SWARM');
      const agentResults = await client.retrieve({ limit: 10 }, 'AGENT');

      expect(sessionResults.entries).toHaveLength(1);
      expect(swarmResults.entries).toHaveLength(1);
      expect(agentResults.entries).toHaveLength(1);
    });

    it('should throw error when storing to unavailable scope', async () => {
      const minimalConfig: TieredMemoryConfig = {
        tenantId: 'test-tenant',
        userId: 'test-user',
        sessionId: 'session-123',
        memoryConfig: {
          namespace: 'test',
          strategies: {},
        },
      };

      const minimalClient = TieredMemoryClientFactory.createInMemoryClient(minimalConfig);
      await minimalClient.initialize();

      await expect(
        minimalClient.storeMessage(testMessage, 'SWARM')
      ).rejects.toThrow('No client configured for scope: SWARM');
    });
  });

  describe('Memory Retrieval', () => {
    beforeEach(async () => {
      await client.initialize();
    });

    it('should retrieve from SESSION scope independently', async () => {
      const msg1: Message = {
        role: 'user',
        content: 'Session message',
        timestamp: new Date().toISOString(),
      };

      const msg2: Message = {
        role: 'user',
        content: 'Swarm message',
        timestamp: new Date().toISOString(),
      };

      await client.storeMessage(msg1, 'SESSION');
      await client.storeMessage(msg2, 'SWARM');

      const sessionResults = await client.retrieve({ limit: 10 }, 'SESSION');
      expect(sessionResults.entries).toHaveLength(1);
      expect(sessionResults.entries[0].content).toBe('Session message');
    });

    it('should retrieve from SWARM scope independently', async () => {
      const msg1: Message = {
        role: 'user',
        content: 'Session message',
        timestamp: new Date().toISOString(),
      };

      const msg2: Message = {
        role: 'user',
        content: 'Swarm message',
        timestamp: new Date().toISOString(),
      };

      await client.storeMessage(msg1, 'SESSION');
      await client.storeMessage(msg2, 'SWARM');

      const swarmResults = await client.retrieve({ limit: 10 }, 'SWARM');
      expect(swarmResults.entries).toHaveLength(1);
      expect(swarmResults.entries[0].content).toBe('Swarm message');
    });

    it('should retrieve from multiple scopes and merge results', async () => {
      const msg1: Message = {
        role: 'user',
        content: 'Session message',
        timestamp: new Date().toISOString(),
      };

      const msg2: Message = {
        role: 'user',
        content: 'Swarm message',
        timestamp: new Date().toISOString(),
      };

      const msg3: Message = {
        role: 'user',
        content: 'Agent message',
        timestamp: new Date().toISOString(),
      };

      await client.storeMessage(msg1, 'SESSION');
      await client.storeMessage(msg2, 'SWARM');
      await client.storeMessage(msg3, 'AGENT');

      const results = await client.retrieveFromScopes(
        { limit: 10 },
        ['SESSION', 'SWARM', 'AGENT']
      );

      expect(results.entries).toHaveLength(3);
      expect(results.entries.map(e => e.content)).toContain('Session message');
      expect(results.entries.map(e => e.content)).toContain('Swarm message');
      expect(results.entries.map(e => e.content)).toContain('Agent message');
    });

    it('should apply limit when merging from multiple scopes', async () => {
      await client.storeMessage(
        { role: 'user', content: 'Session 1', timestamp: new Date().toISOString() },
        'SESSION'
      );
      await client.storeMessage(
        { role: 'user', content: 'Session 2', timestamp: new Date().toISOString() },
        'SESSION'
      );
      await client.storeMessage(
        { role: 'user', content: 'Swarm 1', timestamp: new Date().toISOString() },
        'SWARM'
      );
      await client.storeMessage(
        { role: 'user', content: 'Swarm 2', timestamp: new Date().toISOString() },
        'SWARM'
      );

      const results = await client.retrieveFromScopes(
        { limit: 2 },
        ['SESSION', 'SWARM']
      );

      expect(results.entries).toHaveLength(2);
      expect(results.totalCount).toBe(4);
    });
  });

  describe('Scope Isolation', () => {
    beforeEach(async () => {
      await client.initialize();
    });

    it('should isolate SESSION scope from SWARM scope', async () => {
      const msg1: Message = {
        role: 'user',
        content: 'Private session data',
        timestamp: new Date().toISOString(),
      };

      await client.storeMessage(msg1, 'SESSION');

      const swarmResults = await client.retrieve({ limit: 10 }, 'SWARM');
      expect(swarmResults.entries).toHaveLength(0);
    });

    it('should isolate SWARM scope from AGENT scope', async () => {
      const msg1: Message = {
        role: 'user',
        content: 'Swarm collaboration data',
        timestamp: new Date().toISOString(),
      };

      await client.storeMessage(msg1, 'SWARM');

      const agentResults = await client.retrieve({ limit: 10 }, 'AGENT');
      expect(agentResults.entries).toHaveLength(0);
    });

    it('should isolate AGENT scope from SESSION scope', async () => {
      const msg1: Message = {
        role: 'user',
        content: 'Agent persistent knowledge',
        timestamp: new Date().toISOString(),
      };

      await client.storeMessage(msg1, 'AGENT');

      const sessionResults = await client.retrieve({ limit: 10 }, 'SESSION');
      expect(sessionResults.entries).toHaveLength(0);
    });
  });

  describe('Scope Cleanup', () => {
    beforeEach(async () => {
      await client.initialize();

      // Populate all scopes
      await client.storeToScopes(
        { role: 'user', content: 'Test data', timestamp: new Date().toISOString() },
        ['SESSION', 'SWARM', 'AGENT']
      );
    });

    it('should clear SESSION scope without affecting others', async () => {
      await client.clearScope('SESSION');

      const sessionResults = await client.retrieve({ limit: 10 }, 'SESSION');
      const swarmResults = await client.retrieve({ limit: 10 }, 'SWARM');
      const agentResults = await client.retrieve({ limit: 10 }, 'AGENT');

      expect(sessionResults.entries).toHaveLength(0);
      expect(swarmResults.entries).toHaveLength(1);
      expect(agentResults.entries).toHaveLength(1);
    });

    it('should clear SWARM scope without affecting others', async () => {
      await client.clearScope('SWARM');

      const sessionResults = await client.retrieve({ limit: 10 }, 'SESSION');
      const swarmResults = await client.retrieve({ limit: 10 }, 'SWARM');
      const agentResults = await client.retrieve({ limit: 10 }, 'AGENT');

      expect(sessionResults.entries).toHaveLength(1);
      expect(swarmResults.entries).toHaveLength(0);
      expect(agentResults.entries).toHaveLength(1);
    });

    it('should clear AGENT scope without affecting others', async () => {
      await client.clearScope('AGENT');

      const sessionResults = await client.retrieve({ limit: 10 }, 'SESSION');
      const swarmResults = await client.retrieve({ limit: 10 }, 'SWARM');
      const agentResults = await client.retrieve({ limit: 10 }, 'AGENT');

      expect(sessionResults.entries).toHaveLength(1);
      expect(swarmResults.entries).toHaveLength(1);
      expect(agentResults.entries).toHaveLength(0);
    });
  });

  describe('Statistics', () => {
    beforeEach(async () => {
      await client.initialize();
    });

    it('should track stats per scope independently', async () => {
      // Add different amounts to each scope
      await client.storeMessage(
        { role: 'user', content: 'Session 1', timestamp: new Date().toISOString() },
        'SESSION'
      );
      await client.storeMessage(
        { role: 'user', content: 'Session 2', timestamp: new Date().toISOString() },
        'SESSION'
      );

      await client.storeMessage(
        { role: 'user', content: 'Swarm 1', timestamp: new Date().toISOString() },
        'SWARM'
      );

      await client.storeMessage(
        { role: 'user', content: 'Agent 1', timestamp: new Date().toISOString() },
        'AGENT'
      );
      await client.storeMessage(
        { role: 'user', content: 'Agent 2', timestamp: new Date().toISOString() },
        'AGENT'
      );
      await client.storeMessage(
        { role: 'user', content: 'Agent 3', timestamp: new Date().toISOString() },
        'AGENT'
      );

      const sessionStats = await client.getStats('SESSION');
      const swarmStats = await client.getStats('SWARM');
      const agentStats = await client.getStats('AGENT');

      expect(sessionStats.totalEntries).toBe(2);
      expect(swarmStats.totalEntries).toBe(1);
      expect(agentStats.totalEntries).toBe(3);
    });
  });
});
