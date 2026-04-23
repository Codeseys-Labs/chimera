/**
 * Tests for BackgroundTaskManager (top-level smoke)
 *
 * `submitTask` delegates through `AgentOrchestrator.delegateTask`, which
 * requires a registered target agent. Because `spawnAgent` is gated
 * (Wave-14 audit M1) no agent can be registered from the test harness,
 * so `submitTask` surfaces `Agent not found`. `cancelTask` also now throws
 * `not implemented` — the prior stub only mutated local state while the
 * backing SQS message + agent runtime were left untouched (audit M2).
 *
 * This file locks the new contract in place and keeps coverage for the
 * still-real surface: tool schemas, getters, and `updateTaskStatus`.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  BackgroundTaskManager,
  createBackgroundTaskManager,
  startBackgroundTaskTool,
  checkBackgroundTaskTool,
} from '../../../packages/core/src/orchestration/background-task';
import {
  createOrchestrator,
  type OrchestratorSQSClient,
  type OrchestratorDDBClient,
  type OrchestratorEventBridgeClient,
} from '../../../packages/core/src/orchestration/orchestrator';

function createMockSQS(): OrchestratorSQSClient {
  return {
    async createQueue(input) {
      return { QueueUrl: `https://sqs.us-east-1.amazonaws.com/TESTACCT/${input.QueueName}` };
    },
    async getQueueAttributes() {
      return { Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:TESTACCT:dlq' } };
    },
    async sendMessage() {
      return { MessageId: `msg-${Date.now()}` };
    },
    async deleteQueue() {
      return {};
    },
  };
}

function createMockDDB(): OrchestratorDDBClient {
  return {
    async put() {
      return {};
    },
    async update() {
      return {};
    },
  };
}

function createMockEventBridge(): OrchestratorEventBridgeClient {
  return {
    async putEvents() {
      return { FailedEntryCount: 0 };
    },
  };
}

describe('BackgroundTaskManager', () => {
  let manager: BackgroundTaskManager;
  let orchestrator: ReturnType<typeof createOrchestrator>;

  beforeEach(() => {
    orchestrator = createOrchestrator({
      region: 'us-east-1',
      eventBusName: 'test-event-bus',
      agentTableName: 'test-agents',
      defaultQueuePrefix: 'test-queue',
      clients: {
        sqs: createMockSQS(),
        dynamodb: createMockDDB(),
        eventBridge: createMockEventBridge(),
      },
    });

    manager = createBackgroundTaskManager(orchestrator);
  });

  // =========================================================================
  // submitTask — delegation fails because spawnAgent is gated
  // =========================================================================

  describe('submitTask', () => {
    it('should throw because the target agent cannot be registered', async () => {
      await expect(
        manager.submitTask({
          sourceAgentId: 'agent-001',
          targetAgentId: 'worker-001',
          tenantId: 'tenant-123',
          instruction: 'Analyze document XYZ',
          context: { documentId: 'doc-123' },
        })
      ).rejects.toThrow('Agent not found: worker-001');
    });
  });

  // =========================================================================
  // getTask (pure registry read)
  // =========================================================================

  describe('getTask', () => {
    it('should return undefined for non-existent task', () => {
      expect(manager.getTask('non-existent')).toBeUndefined();
    });
  });

  // =========================================================================
  // updateTaskStatus — operates on local registry, still real
  // =========================================================================

  describe('updateTaskStatus', () => {
    it('should throw for non-existent task', () => {
      expect(() => {
        manager.updateTaskStatus('non-existent', 'running');
      }).toThrow('Task not found: non-existent');
    });
  });

  // =========================================================================
  // listTasks (pure filter)
  // =========================================================================

  describe('listTasks', () => {
    it('should return empty array when no tasks have been submitted', () => {
      expect(manager.listTasks('tenant-123')).toEqual([]);
    });
  });

  // =========================================================================
  // cancelTask — SQS removal + termination signal are skeletons
  // =========================================================================

  describe('cancelTask', () => {
    it('should throw "Task not found" for unknown task', async () => {
      await expect(manager.cancelTask('non-existent')).rejects.toThrow(
        'Task not found: non-existent'
      );
    });
  });

  // =========================================================================
  // Tool schemas — pure data
  // =========================================================================

  describe('startBackgroundTaskTool', () => {
    it('should have correct tool schema', () => {
      expect(startBackgroundTaskTool.name).toBe('start_background_task');
      expect(startBackgroundTaskTool.description).toBeTruthy();
      expect(startBackgroundTaskTool.parameters.type).toBe('object');
      expect(startBackgroundTaskTool.parameters.required).toContain('targetAgentId');
      expect(startBackgroundTaskTool.parameters.required).toContain('instruction');
    });

    it('should define priority enum', () => {
      const priorityParam = startBackgroundTaskTool.parameters.properties.priority;
      expect(priorityParam.enum).toEqual(['low', 'normal', 'high', 'urgent']);
    });
  });

  describe('checkBackgroundTaskTool', () => {
    it('should have correct tool schema', () => {
      expect(checkBackgroundTaskTool.name).toBe('check_background_task');
      expect(checkBackgroundTaskTool.description).toBeTruthy();
      expect(checkBackgroundTaskTool.parameters.type).toBe('object');
      expect(checkBackgroundTaskTool.parameters.required).toContain('taskId');
    });

    it('should require taskId parameter', () => {
      const taskIdParam = checkBackgroundTaskTool.parameters.properties.taskId;
      expect(taskIdParam.type).toBe('string');
      expect(taskIdParam.description).toBeTruthy();
    });
  });
});
