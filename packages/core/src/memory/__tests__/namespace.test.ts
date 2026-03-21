/**
 * Tests for memory namespace isolation
 * Ensures cross-tenant data isolation at the memory layer
 */

import { describe, it, expect } from 'bun:test';
import {
  generateNamespace,
  parseNamespace,
  validateNamespace,
  generateSessionNamespace,
  extractSessionId,
  generateSwarmNamespace,
  generateAgentNamespace,
  parseScopedNamespace,
} from '../namespace';
import { InMemoryClient } from '../in-memory-client';
import { Message } from '../types';

describe('Namespace utilities', () => {
  describe('generateNamespace', () => {
    it('should generate namespace with tenant and user IDs', () => {
      const namespace = generateNamespace('acme-corp', 'alice');
      expect(namespace).toBe('tenant-acme-corp-user-alice');
    });

    it('should throw error if tenantId is missing', () => {
      expect(() => generateNamespace('', 'alice')).toThrow();
    });

    it('should throw error if userId is missing', () => {
      expect(() => generateNamespace('acme-corp', '')).toThrow();
    });

    it('should validate alphanumeric IDs with hyphens and underscores', () => {
      const namespace = generateNamespace('tenant-123', 'user_456');
      expect(namespace).toBe('tenant-tenant-123-user-user_456');
    });

    it('should reject invalid tenant ID characters', () => {
      expect(() => generateNamespace('tenant@123', 'alice')).toThrow('Invalid tenantId format');
    });

    it('should reject invalid user ID characters', () => {
      expect(() => generateNamespace('tenant123', 'alice@example.com')).toThrow('Invalid userId format');
    });
  });

  describe('parseNamespace', () => {
    it('should parse valid namespace', () => {
      const result = parseNamespace('tenant-acme-corp-user-alice');
      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe('acme-corp');
      expect(result?.userId).toBe('alice');
    });

    it('should return null for invalid namespace', () => {
      const result = parseNamespace('invalid-namespace');
      expect(result).toBeNull();
    });

    it('should parse namespace with hyphens in IDs', () => {
      const result = parseNamespace('tenant-tenant-123-user-user-456');
      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe('tenant-123');
      expect(result?.userId).toBe('user-456');
    });
  });

  describe('validateNamespace', () => {
    it('should validate correct namespace format', () => {
      expect(validateNamespace('tenant-acme-corp-user-alice')).toBe(true);
    });

    it('should reject invalid namespace format', () => {
      expect(validateNamespace('invalid')).toBe(false);
      expect(validateNamespace('tenant-only')).toBe(false);
      expect(validateNamespace('')).toBe(false);
    });
  });

  describe('generateSessionNamespace', () => {
    it('should generate session-scoped namespace', () => {
      const sessionNs = generateSessionNamespace('acme-corp', 'alice', 'session-123');
      expect(sessionNs).toBe('tenant-acme-corp-user-alice-session-session-123');
    });
  });

  describe('extractSessionId', () => {
    it('should extract session ID from session namespace', () => {
      const sessionId = extractSessionId('tenant-acme-corp-user-alice-session-session-123');
      expect(sessionId).toBe('session-123');
    });

    it('should return null for non-session namespace', () => {
      const sessionId = extractSessionId('tenant-acme-corp-user-alice');
      expect(sessionId).toBeNull();
    });
  });
});

describe('Memory namespace isolation', () => {
  it('should isolate memory between different tenants', async () => {
    // Create clients for two different tenants
    const tenant1Client = new InMemoryClient(generateNamespace('tenant-1', 'alice'));
    const tenant2Client = new InMemoryClient(generateNamespace('tenant-2', 'bob'));

    // Store message in tenant-1
    await tenant1Client.storeMessage({
      role: 'user',
      content: 'Tenant 1 secret data',
      timestamp: new Date().toISOString(),
    });

    // Store message in tenant-2
    await tenant2Client.storeMessage({
      role: 'user',
      content: 'Tenant 2 secret data',
      timestamp: new Date().toISOString(),
    });

    // Verify tenant-1 only sees their data
    const tenant1Results = await tenant1Client.retrieve({ limit: 10 });
    expect(tenant1Results.entries).toHaveLength(1);
    expect(tenant1Results.entries[0].content).toBe('Tenant 1 secret data');

    // Verify tenant-2 only sees their data
    const tenant2Results = await tenant2Client.retrieve({ limit: 10 });
    expect(tenant2Results.entries).toHaveLength(1);
    expect(tenant2Results.entries[0].content).toBe('Tenant 2 secret data');
  });

  it('should isolate memory between different users in same tenant', async () => {
    // Create clients for two users in the same tenant
    const aliceClient = new InMemoryClient(generateNamespace('tenant-acme', 'alice'));
    const bobClient = new InMemoryClient(generateNamespace('tenant-acme', 'bob'));

    // Store message for alice
    await aliceClient.storeMessage({
      role: 'user',
      content: 'Alice private message',
      timestamp: new Date().toISOString(),
    });

    // Store message for bob
    await bobClient.storeMessage({
      role: 'user',
      content: 'Bob private message',
      timestamp: new Date().toISOString(),
    });

    // Verify alice only sees her data
    const aliceResults = await aliceClient.retrieve({ limit: 10 });
    expect(aliceResults.entries).toHaveLength(1);
    expect(aliceResults.entries[0].content).toBe('Alice private message');

    // Verify bob only sees his data
    const bobResults = await bobClient.retrieve({ limit: 10 });
    expect(bobResults.entries).toHaveLength(1);
    expect(bobResults.entries[0].content).toBe('Bob private message');
  });

  it('should prevent cross-tenant data leakage in batch operations', async () => {
    const tenant1Client = new InMemoryClient(generateNamespace('tenant-1', 'user-1'));
    const tenant2Client = new InMemoryClient(generateNamespace('tenant-2', 'user-2'));

    // Store multiple messages for tenant-1
    const tenant1Messages: Message[] = [
      { role: 'user', content: 'T1 Message 1', timestamp: new Date().toISOString() },
      { role: 'user', content: 'T1 Message 2', timestamp: new Date().toISOString() },
      { role: 'user', content: 'T1 Message 3', timestamp: new Date().toISOString() },
    ];
    await tenant1Client.storeMessages(tenant1Messages);

    // Store messages for tenant-2
    const tenant2Messages: Message[] = [
      { role: 'user', content: 'T2 Message 1', timestamp: new Date().toISOString() },
      { role: 'user', content: 'T2 Message 2', timestamp: new Date().toISOString() },
    ];
    await tenant2Client.storeMessages(tenant2Messages);

    // Verify isolation
    const tenant1Results = await tenant1Client.retrieve({ limit: 10 });
    expect(tenant1Results.entries).toHaveLength(3);
    expect(tenant1Results.entries.every(e => e.content.startsWith('T1'))).toBe(true);

    const tenant2Results = await tenant2Client.retrieve({ limit: 10 });
    expect(tenant2Results.entries).toHaveLength(2);
    expect(tenant2Results.entries.every(e => e.content.startsWith('T2'))).toBe(true);
  });

  it('should maintain isolation when clearing namespaces', async () => {
    const tenant1Client = new InMemoryClient(generateNamespace('tenant-1', 'user-1'));
    const tenant2Client = new InMemoryClient(generateNamespace('tenant-2', 'user-2'));

    // Store data in both tenants
    await tenant1Client.storeMessage({
      role: 'user',
      content: 'Tenant 1 data',
      timestamp: new Date().toISOString(),
    });
    await tenant2Client.storeMessage({
      role: 'user',
      content: 'Tenant 2 data',
      timestamp: new Date().toISOString(),
    });

    // Clear tenant-1 namespace
    await tenant1Client.clearNamespace();

    // Verify tenant-1 is cleared
    const tenant1Results = await tenant1Client.retrieve({ limit: 10 });
    expect(tenant1Results.entries).toHaveLength(0);

    // Verify tenant-2 is unaffected
    const tenant2Results = await tenant2Client.retrieve({ limit: 10 });
    expect(tenant2Results.entries).toHaveLength(1);
    expect(tenant2Results.entries[0].content).toBe('Tenant 2 data');
  });

  it('should generate unique namespaces for different contexts', () => {
    const ns1 = generateNamespace('tenant-1', 'alice');
    const ns2 = generateNamespace('tenant-1', 'bob');
    const ns3 = generateNamespace('tenant-2', 'alice');

    // All should be different
    expect(ns1).not.toBe(ns2);
    expect(ns1).not.toBe(ns3);
    expect(ns2).not.toBe(ns3);

    // But should follow template
    expect(ns1).toBe('tenant-tenant-1-user-alice');
    expect(ns2).toBe('tenant-tenant-1-user-bob');
    expect(ns3).toBe('tenant-tenant-2-user-alice');
  });
});

describe('Scoped namespace utilities', () => {
  describe('generateSwarmNamespace', () => {
    it('should generate SWARM scope namespace', () => {
      const namespace = generateSwarmNamespace('acme-corp', 'chimera-39d5');
      expect(namespace).toBe('tenant-acme-corp-swarm-chimera-39d5');
    });

    it('should throw error if tenantId is missing', () => {
      expect(() => generateSwarmNamespace('', 'chimera-39d5')).toThrow();
    });

    it('should throw error if swarmId is missing', () => {
      expect(() => generateSwarmNamespace('acme-corp', '')).toThrow();
    });

    it('should handle hyphenated IDs', () => {
      const namespace = generateSwarmNamespace('tenant-123', 'task-abc-def');
      expect(namespace).toBe('tenant-tenant-123-swarm-task-abc-def');
    });
  });

  describe('generateAgentNamespace', () => {
    it('should generate AGENT scope namespace', () => {
      const namespace = generateAgentNamespace('acme-corp', 'builder-memory-tiers');
      expect(namespace).toBe('tenant-acme-corp-agent-builder-memory-tiers');
    });

    it('should throw error if tenantId is missing', () => {
      expect(() => generateAgentNamespace('', 'builder-memory-tiers')).toThrow();
    });

    it('should throw error if agentId is missing', () => {
      expect(() => generateAgentNamespace('acme-corp', '')).toThrow();
    });

    it('should handle hyphenated IDs', () => {
      const namespace = generateAgentNamespace('tenant-123', 'agent-abc-def');
      expect(namespace).toBe('tenant-tenant-123-agent-agent-abc-def');
    });
  });

  describe('parseScopedNamespace', () => {
    it('should parse SWARM scope namespace', () => {
      const result = parseScopedNamespace('tenant-acme-corp-swarm-chimera-39d5');
      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe('acme-corp');
      expect(result?.scope).toBe('SWARM');
      expect(result?.scopeId).toBe('chimera-39d5');
    });

    it('should parse AGENT scope namespace', () => {
      const result = parseScopedNamespace('tenant-acme-corp-agent-builder-memory-tiers');
      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe('acme-corp');
      expect(result?.scope).toBe('AGENT');
      expect(result?.scopeId).toBe('builder-memory-tiers');
    });

    it('should parse SESSION scope namespace with explicit sessionId', () => {
      const result = parseScopedNamespace('tenant-acme-corp-user-alice-session-session-123');
      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe('acme-corp');
      expect(result?.scope).toBe('SESSION');
      expect(result?.scopeId).toBe('session-123');
      expect(result?.userId).toBe('alice');
    });

    it('should parse legacy SESSION scope namespace (no explicit sessionId)', () => {
      const result = parseScopedNamespace('tenant-acme-corp-user-alice');
      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe('acme-corp');
      expect(result?.scope).toBe('SESSION');
      expect(result?.scopeId).toBe('default');
      expect(result?.userId).toBe('alice');
    });

    it('should handle hyphenated IDs in SWARM namespace', () => {
      const result = parseScopedNamespace('tenant-tenant-123-swarm-task-abc-def');
      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe('tenant-123');
      expect(result?.scope).toBe('SWARM');
      expect(result?.scopeId).toBe('task-abc-def');
    });

    it('should handle hyphenated IDs in AGENT namespace', () => {
      const result = parseScopedNamespace('tenant-tenant-123-agent-agent-abc-def');
      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe('tenant-123');
      expect(result?.scope).toBe('AGENT');
      expect(result?.scopeId).toBe('agent-abc-def');
    });

    it('should return null for invalid namespace', () => {
      const result = parseScopedNamespace('invalid-namespace');
      expect(result).toBeNull();
    });
  });

  describe('Scope isolation', () => {
    it('should generate distinct namespaces for different scopes', () => {
      const sessionNs = generateSessionNamespace('acme-corp', 'alice', 'session-123');
      const swarmNs = generateSwarmNamespace('acme-corp', 'chimera-39d5');
      const agentNs = generateAgentNamespace('acme-corp', 'builder-memory-tiers');

      // All should be different
      expect(sessionNs).not.toBe(swarmNs);
      expect(sessionNs).not.toBe(agentNs);
      expect(swarmNs).not.toBe(agentNs);

      // Verify patterns
      expect(sessionNs).toBe('tenant-acme-corp-user-alice-session-session-123');
      expect(swarmNs).toBe('tenant-acme-corp-swarm-chimera-39d5');
      expect(agentNs).toBe('tenant-acme-corp-agent-builder-memory-tiers');
    });

    it('should correctly identify scope from namespace', () => {
      const sessionResult = parseScopedNamespace('tenant-acme-corp-user-alice-session-session-123');
      const swarmResult = parseScopedNamespace('tenant-acme-corp-swarm-chimera-39d5');
      const agentResult = parseScopedNamespace('tenant-acme-corp-agent-builder-memory-tiers');

      expect(sessionResult?.scope).toBe('SESSION');
      expect(swarmResult?.scope).toBe('SWARM');
      expect(agentResult?.scope).toBe('AGENT');
    });
  });
});
