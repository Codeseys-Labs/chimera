/**
 * Tests for AgentOrchestrator
 *
 * AgentCore SDK integration is pending (Wave-14 audit M1), so
 * `AgentOrchestrator.createAgentRuntime` throws `not implemented`.
 * That throw propagates through `spawnAgent`, which gates every
 * downstream operation. These tests lock the new contract in place.
 *
 * The authoritative unit-test location is
 * `packages/core/src/orchestration/__tests__/agent-orchestrator.test.ts`;
 * this file exists as a top-level smoke test.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  AgentOrchestrator,
  createOrchestrator,
  type OrchestratorSQSClient,
  type OrchestratorDDBClient,
  type OrchestratorEventBridgeClient,
} from '../../../packages/core/src/orchestration/orchestrator';

function createMockSQSClient(): OrchestratorSQSClient {
  return {
    createQueue: async (input) => ({
      QueueUrl: `https://sqs.us-east-1.amazonaws.com/TESTACCT/${input.QueueName}`,
    }),
    getQueueAttributes: async () => ({
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:TESTACCT:dlq' },
    }),
    sendMessage: async () => ({ MessageId: `msg-${Date.now()}` }),
    deleteQueue: async () => {},
  };
}

function createMockDDBClient(): OrchestratorDDBClient {
  return {
    put: async () => ({}),
    update: async () => ({}),
  };
}

function createMockEventBridgeClient(): OrchestratorEventBridgeClient {
  return {
    putEvents: async () => ({ FailedEntryCount: 0 }),
  };
}

describe('AgentOrchestrator (top-level smoke)', () => {
  let orchestrator: AgentOrchestrator;

  beforeEach(() => {
    orchestrator = createOrchestrator({
      region: 'us-east-1',
      eventBusName: 'test-event-bus',
      agentTableName: 'test-agents',
      defaultQueuePrefix: 'test-queue',
      maxConcurrentAgents: 10,
      clients: {
        sqs: createMockSQSClient(),
        dynamodb: createMockDDBClient(),
        eventBridge: createMockEventBridgeClient(),
      },
    });
  });

  describe('construction', () => {
    it('should build via createOrchestrator', () => {
      expect(orchestrator).toBeInstanceOf(AgentOrchestrator);
    });

    it('should return empty agent list on a fresh orchestrator', () => {
      expect(orchestrator.listAgents('tenant-123')).toEqual([]);
    });
  });

  describe('spawnAgent — gated until AgentCore SDK lands', () => {
    it('should throw "not implemented"', async () => {
      await expect(
        orchestrator.spawnAgent({
          tenantId: 'tenant-123',
          agentId: 'agent-001',
          role: 'worker',
          capabilities: [],
        })
      ).rejects.toThrow('not implemented');
    });
  });

  describe('delegateTask — target must exist (spawn is gated)', () => {
    it('should throw "Agent not found" when no agent has been spawned', async () => {
      await expect(
        orchestrator.delegateTask({
          taskId: 'task-001',
          sourceAgentId: 'src',
          targetAgentId: 'ghost',
          tenantId: 'tenant-123',
          instruction: 'do work',
          context: {},
        })
      ).rejects.toThrow('Agent not found: ghost');
    });
  });

  describe('terminateAgent — target must exist', () => {
    it('should throw "Agent not found"', async () => {
      await expect(
        orchestrator.terminateAgent('tenant-123', 'ghost')
      ).rejects.toThrow('Agent not found: ghost');
    });
  });

  describe('updateHeartbeat — target must exist', () => {
    it('should throw "Agent not found"', async () => {
      await expect(
        orchestrator.updateHeartbeat('tenant-123', 'ghost', 'ready')
      ).rejects.toThrow('Agent not found: ghost');
    });
  });
});
