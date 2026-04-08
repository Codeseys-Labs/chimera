/**
 * Tests for A2A Protocol
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  A2AProtocol,
  createA2AProtocol,
  A2AMessageBuilder,
  type RoutingConfig,
} from '../../../packages/core/src/orchestration/a2a-protocol';

/**
 * Minimal mock SQS client that satisfies the SQSClient interface for testing.
 * Records all sent messages for assertion, always resolves successfully.
 */
function createMockSQSClient() {
  const sentMessages: unknown[] = [];
  return {
    send: async (command: unknown) => {
      sentMessages.push(command);
      return { MessageId: `mock-${Date.now()}` };
    },
    sentMessages,
  };
}

describe('A2AProtocol', () => {
  let protocol: A2AProtocol;
  let config: RoutingConfig;

  beforeEach(() => {
    const mockSqs = createMockSQSClient();

    config = {
      tenantId: 'tenant-123',
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
      groups: new Map([
        ['research-team', ['agent-001', 'agent-002', 'agent-003']],
        ['monitoring-team', ['monitor-001', 'monitor-002']],
      ]),
      sqsClient: mockSqs as any,
    };

    protocol = createA2AProtocol(config);
  });

  describe('sendRequest', () => {
    it('should send request and return message ID', async () => {
      const payload = A2AMessageBuilder.taskRequest('task-001', 'Analyze document', {
        documentId: 'doc-123',
      });

      const messageId = await protocol.sendRequest('source-agent', 'target-agent', payload);

      expect(messageId).toBeTruthy();
      expect(messageId).toMatch(/^a2a-req-/);
    });

    it('should track pending request', async () => {
      const payload = A2AMessageBuilder.taskRequest('task-001', 'Test task');

      await protocol.sendRequest('source-agent', 'target-agent', payload);

      const pending = protocol.getPendingRequests();
      expect(pending.length).toBe(1);
      expect(pending[0].messageId).toBeTruthy();
    });

    it('should use default priority when not specified', async () => {
      const payload = A2AMessageBuilder.taskRequest('task-001', 'Test task');

      const messageId = await protocol.sendRequest('source-agent', 'target-agent', payload);

      expect(messageId).toBeTruthy();
    });

    it('should accept custom priority', async () => {
      const payload = A2AMessageBuilder.taskRequest('task-001', 'Urgent task');

      const messageId = await protocol.sendRequest('source-agent', 'target-agent', payload, {
        priority: 'urgent',
      });

      expect(messageId).toBeTruthy();
    });

    it('should accept custom timeout', async () => {
      const payload = A2AMessageBuilder.queryRequest('query-001', 'SELECT * FROM logs', {
        limit: 100,
      });

      await protocol.sendRequest('source-agent', 'target-agent', payload, { timeoutMs: 60000 });

      const pending = protocol.getPendingRequests();
      expect(pending[0].timeoutMs).toBe(60000);
    });
  });

  describe('sendResponse', () => {
    it('should send response and clear pending request', async () => {
      // Send request first
      const requestPayload = A2AMessageBuilder.taskRequest('task-001', 'Test task');
      const messageId = await protocol.sendRequest('agent-A', 'agent-B', requestPayload);

      // Send response
      const responsePayload = A2AMessageBuilder.taskResponse('task-001', 'success', {
        result: 'completed',
      });

      await protocol.sendResponse('agent-B', 'agent-A', messageId, responsePayload);

      // Verify pending request cleared
      const pending = protocol.getPendingRequests();
      expect(pending.length).toBe(0);
    });
  });

  describe('broadcast', () => {
    it('should broadcast to all agents in group', async () => {
      const payload = A2AMessageBuilder.broadcast('alerts', 'High CPU usage detected', {
        cpuPercent: 95,
      });

      await protocol.broadcast('coordinator', 'research-team', payload);
    });

    it('should throw error for non-existent group', async () => {
      const payload = A2AMessageBuilder.broadcast('test', 'Test message');

      await expect(
        protocol.broadcast('coordinator', 'non-existent-group', payload)
      ).rejects.toThrow('Group not found or empty: non-existent-group');
    });

    it('should throw error for empty group', async () => {
      protocol.registerGroup('empty-group', []);

      const payload = A2AMessageBuilder.broadcast('test', 'Test message');

      await expect(protocol.broadcast('coordinator', 'empty-group', payload)).rejects.toThrow(
        'Group not found or empty: empty-group'
      );
    });
  });

  describe('publishEvent', () => {
    it('should publish event notification', async () => {
      const payload = A2AMessageBuilder.event('task.completed', {
        taskId: 'task-001',
        duration: 1234,
      });

      await protocol.publishEvent('worker-001', 'coordinator', payload);
    });
  });

  describe('parseMessage', () => {
    it('should parse valid A2A message', () => {
      const rawMessage = JSON.stringify({
        messageId: 'msg-001',
        type: 'request',
        sourceAgentId: 'agent-A',
        targetAgentId: 'agent-B',
        tenantId: 'tenant-123',
        priority: 'normal',
        timestamp: new Date().toISOString(),
        payload: {
          type: 'task_request',
          taskId: 'task-001',
          instruction: 'Test task',
          context: {},
        },
      });

      const message = protocol.parseMessage(rawMessage);

      expect(message.messageId).toBe('msg-001');
      expect(message.type).toBe('request');
      expect(message.sourceAgentId).toBe('agent-A');
    });

    it('should throw error for invalid JSON', () => {
      expect(() => {
        protocol.parseMessage('invalid json');
      }).toThrow('Failed to parse A2A message');
    });

    it('should throw error for missing required fields', () => {
      const invalidMessage = JSON.stringify({
        messageId: 'msg-001',
        // Missing type and sourceAgentId
        tenantId: 'tenant-123',
        priority: 'normal',
        timestamp: new Date().toISOString(),
        payload: {},
      });

      expect(() => {
        protocol.parseMessage(invalidMessage);
      }).toThrow('Invalid A2A message: missing required fields');
    });

    it('should throw error for expired message', () => {
      const expiredMessage = JSON.stringify({
        messageId: 'msg-001',
        type: 'request',
        sourceAgentId: 'agent-A',
        tenantId: 'tenant-123',
        priority: 'normal',
        timestamp: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(), // Expired 1 second ago
        payload: {},
      });

      expect(() => {
        protocol.parseMessage(expiredMessage);
      }).toThrow('Message expired: msg-001');
    });
  });

  describe('registerGroup', () => {
    it('should register new agent group', async () => {
      protocol.registerGroup('new-team', ['agent-A', 'agent-B']);

      // Verify by attempting broadcast
      const payload = A2AMessageBuilder.broadcast('test', 'Test message');

      await protocol.broadcast('coordinator', 'new-team', payload);
    });

    it('should overwrite existing group', () => {
      protocol.registerGroup('research-team', ['agent-X', 'agent-Y']);

      const payload = A2AMessageBuilder.broadcast('test', 'Test message');

      expect(protocol.broadcast('coordinator', 'research-team', payload));
    });
  });

  describe('unregisterGroup', () => {
    it('should unregister agent group', () => {
      protocol.unregisterGroup('research-team');

      const payload = A2AMessageBuilder.broadcast('test', 'Test message');

      expect(protocol.broadcast('coordinator', 'research-team', payload)).rejects.toThrow(
        'Group not found or empty'
      );
    });
  });

  describe('checkTimeouts', () => {
    it('should detect timed-out requests', async () => {
      const payload = A2AMessageBuilder.taskRequest('task-001', 'Test task');

      await protocol.sendRequest('agent-A', 'agent-B', payload, { timeoutMs: 100 });

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      const timedOut = protocol.checkTimeouts();
      expect(timedOut.length).toBe(1);
      expect(timedOut[0]).toBeTruthy();
    });

    it('should not detect requests within timeout window', async () => {
      const payload = A2AMessageBuilder.taskRequest('task-001', 'Test task');

      await protocol.sendRequest(
        'agent-A',
        'agent-B',
        payload,
        { timeoutMs: 10000 } // 10 seconds
      );

      const timedOut = protocol.checkTimeouts();
      expect(timedOut.length).toBe(0);
    });

    it('should remove timed-out requests from pending', async () => {
      const payload = A2AMessageBuilder.taskRequest('task-001', 'Test task');

      await protocol.sendRequest('agent-A', 'agent-B', payload, { timeoutMs: 50 });

      await new Promise((resolve) => setTimeout(resolve, 100));

      protocol.checkTimeouts();

      const pending = protocol.getPendingRequests();
      expect(pending.length).toBe(0);
    });
  });

  describe('A2AMessageBuilder', () => {
    it('should build task request', () => {
      const message = A2AMessageBuilder.taskRequest('task-001', 'Analyze logs', {
        logFile: 'app.log',
      });

      expect(message.type).toBe('task_request');
      expect(message.taskId).toBe('task-001');
      expect(message.instruction).toBe('Analyze logs');
      expect(message.context).toEqual({ logFile: 'app.log' });
    });

    it('should build task response', () => {
      const message = A2AMessageBuilder.taskResponse('task-001', 'success', {
        summary: 'No errors found',
      });

      expect(message.type).toBe('task_response');
      expect(message.taskId).toBe('task-001');
      expect(message.status).toBe('success');
      expect(message.result).toEqual({ summary: 'No errors found' });
    });

    it('should build task failure response', () => {
      const message = A2AMessageBuilder.taskResponse('task-001', 'failure', undefined, {
        code: 'FILE_NOT_FOUND',
        message: 'Log file not found',
      });

      expect(message.status).toBe('failure');
      expect(message.error).toEqual({
        code: 'FILE_NOT_FOUND',
        message: 'Log file not found',
      });
    });

    it('should build query request', () => {
      const message = A2AMessageBuilder.queryRequest('query-001', 'SELECT * FROM metrics', {
        timeRange: '1h',
      });

      expect(message.type).toBe('query_request');
      expect(message.queryId).toBe('query-001');
      expect(message.query).toBe('SELECT * FROM metrics');
      expect(message.parameters).toEqual({ timeRange: '1h' });
    });

    it('should build query response', () => {
      const message = A2AMessageBuilder.queryResponse('query-001', {
        rows: [{ cpu: 45 }, { cpu: 67 }],
      });

      expect(message.type).toBe('query_response');
      expect(message.queryId).toBe('query-001');
      expect(message.result.rows).toHaveLength(2);
    });

    it('should build event notification', () => {
      const message = A2AMessageBuilder.event('agent.spawned', {
        agentId: 'worker-001',
        role: 'worker',
      });

      expect(message.type).toBe('event');
      expect(message.eventType).toBe('agent.spawned');
      expect(message.eventData).toEqual({ agentId: 'worker-001', role: 'worker' });
    });

    it('should build broadcast message', () => {
      const message = A2AMessageBuilder.broadcast(
        'system-alert',
        'System maintenance in 5 minutes',
        { severity: 'warning' }
      );

      expect(message.type).toBe('broadcast');
      expect(message.topic).toBe('system-alert');
      expect(message.message).toBe('System maintenance in 5 minutes');
      expect(message.data).toEqual({ severity: 'warning' });
    });
  });
});
