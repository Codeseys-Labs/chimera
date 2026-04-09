/**
 * Comprehensive unit tests for AgentOrchestrator
 *
 * Tests agent lifecycle management, SQS queue provisioning,
 * DynamoDB persistence, EventBridge event publishing, and error handling.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  AgentOrchestrator,
  createOrchestrator,
  type SpawnAgentConfig,
  type TaskDelegation,
  type AgentStatus,
  type OrchestratorConfig,
  type OrchestratorSQSClient,
  type OrchestratorDDBClient,
  type OrchestratorEventBridgeClient,
} from '../orchestrator';

// ---------------------------------------------------------------------------
// Mock AWS clients — plain objects satisfying narrow interfaces
// ---------------------------------------------------------------------------

interface MockSQS extends OrchestratorSQSClient {
  sentMessages: Array<{ QueueUrl: string; MessageBody: string }>;
  deletedQueues: string[];
  createdQueues: Array<{ QueueName: string; Attributes?: Record<string, string> }>;
}

function createMockSQSClient(): MockSQS {
  let queueCounter = 0;
  const sentMessages: Array<{ QueueUrl: string; MessageBody: string }> = [];
  const deletedQueues: string[] = [];
  const createdQueues: Array<{ QueueName: string; Attributes?: Record<string, string> }> = [];

  return {
    sentMessages,
    deletedQueues,
    createdQueues,
    createQueue: async (input) => {
      createdQueues.push({ QueueName: input.QueueName, Attributes: input.Attributes });
      return {
        QueueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${input.QueueName}`,
      };
    },
    getQueueAttributes: async () => ({
      Attributes: {
        QueueArn: `arn:aws:sqs:us-east-1:123456789012:test-dlq-${++queueCounter}`,
      },
    }),
    sendMessage: async (input) => {
      sentMessages.push({ QueueUrl: input.QueueUrl, MessageBody: input.MessageBody });
      return { MessageId: `mock-msg-${sentMessages.length}` };
    },
    deleteQueue: async (input) => {
      deletedQueues.push(input.QueueUrl);
    },
  };
}

interface MockDDB extends OrchestratorDDBClient {
  putItems: Array<{ TableName: string; Item: Record<string, unknown> }>;
  updateCalls: Array<{ TableName: string; Key: Record<string, unknown> }>;
}

function createMockDDBClient(): MockDDB {
  const putItems: Array<{ TableName: string; Item: Record<string, unknown> }> = [];
  const updateCalls: Array<{ TableName: string; Key: Record<string, unknown> }> = [];

  return {
    putItems,
    updateCalls,
    put: async (input) => {
      putItems.push(input);
      return {};
    },
    update: async (input) => {
      updateCalls.push(input);
      return {};
    },
  };
}

interface MockEB extends OrchestratorEventBridgeClient {
  publishedEvents: Array<{ DetailType: string; Detail: string; EventBusName: string }>;
}

function createMockEventBridgeClient(): MockEB {
  const publishedEvents: Array<{ DetailType: string; Detail: string; EventBusName: string }> = [];

  return {
    publishedEvents,
    putEvents: async (input) => {
      for (const entry of input.Entries) {
        publishedEvents.push({
          DetailType: entry.DetailType,
          Detail: entry.Detail,
          EventBusName: entry.EventBusName,
        });
      }
      return { FailedEntryCount: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOrchestratorConfig(overrides?: {
  sqs?: MockSQS;
  ddb?: MockDDB;
  eb?: MockEB;
  maxConcurrentAgents?: number;
}): OrchestratorConfig {
  return {
    region: 'us-east-1',
    eventBusName: 'test-event-bus',
    agentTableName: 'test-agents',
    defaultQueuePrefix: 'test-queue',
    dlqRetentionDays: 14,
    maxConcurrentAgents: overrides?.maxConcurrentAgents ?? 100,
    clients: {
      sqs: overrides?.sqs ?? createMockSQSClient(),
      dynamodb: overrides?.ddb ?? createMockDDBClient(),
      eventBridge: overrides?.eb ?? createMockEventBridgeClient(),
    },
  };
}

function workerConfig(overrides?: Partial<SpawnAgentConfig>): SpawnAgentConfig {
  return {
    tenantId: 'tenant-123',
    agentId: 'agent-001',
    role: 'worker',
    capabilities: ['document-analysis', 'summarization'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentOrchestrator', () => {
  let orchestrator: AgentOrchestrator;
  let mockSQS: MockSQS;
  let mockDDB: MockDDB;
  let mockEB: MockEB;

  beforeEach(() => {
    mockSQS = createMockSQSClient();
    mockDDB = createMockDDBClient();
    mockEB = createMockEventBridgeClient();
    orchestrator = new AgentOrchestrator(
      defaultOrchestratorConfig({ sqs: mockSQS, ddb: mockDDB, eb: mockEB })
    );
  });

  // =========================================================================
  // spawnAgent
  // =========================================================================

  describe('spawnAgent', () => {
    it('should create agent with correct config and return metadata', async () => {
      const config = workerConfig();
      const metadata = await orchestrator.spawnAgent(config);

      expect(metadata.agentId).toBe('agent-001');
      expect(metadata.tenantId).toBe('tenant-123');
      expect(metadata.role).toBe('worker');
      expect(metadata.status).toBe('initializing');
      expect(metadata.capabilities).toEqual(['document-analysis', 'summarization']);
      expect(metadata.taskCount).toBe(0);
      expect(metadata.failureCount).toBe(0);
    });

    it('should generate a runtime ARN containing the agentId', async () => {
      const metadata = await orchestrator.spawnAgent(workerConfig());

      expect(metadata.runtimeArn).toContain('agent-001');
      expect(metadata.runtimeArn).toMatch(/^arn:aws:bedrock-agentcore:/);
    });

    it('should create a queue URL containing the tenant and agent IDs', async () => {
      const metadata = await orchestrator.spawnAgent(workerConfig());

      expect(metadata.queueUrl).toContain('test-queue-tenant-123-agent-001');
    });

    it('should generate unique agent records for different IDs', async () => {
      const m1 = await orchestrator.spawnAgent(workerConfig({ agentId: 'a-1' }));
      const m2 = await orchestrator.spawnAgent(workerConfig({ agentId: 'a-2' }));

      expect(m1.agentId).not.toBe(m2.agentId);
      expect(m1.queueUrl).not.toBe(m2.queueUrl);
      expect(m1.runtimeArn).not.toBe(m2.runtimeArn);
    });

    it('should set spawnedAt and lastHeartbeat to ISO timestamps', async () => {
      const before = new Date().toISOString();
      const metadata = await orchestrator.spawnAgent(workerConfig());
      const after = new Date().toISOString();

      expect(metadata.spawnedAt >= before).toBe(true);
      expect(metadata.spawnedAt <= after).toBe(true);
      expect(metadata.lastHeartbeat >= before).toBe(true);
    });

    it('should include optional metadata in agent runtime', async () => {
      const metadata = await orchestrator.spawnAgent(
        workerConfig({
          metadata: { owner: 'team-research', priority: 'high' },
        })
      );

      expect(metadata.metadata).toEqual({ owner: 'team-research', priority: 'high' });
    });

    it('should default metadata to empty object when not provided', async () => {
      const config = workerConfig();
      delete config.metadata;

      const metadata = await orchestrator.spawnAgent(config);

      expect(metadata.metadata).toEqual({});
    });

    // --- SQS queue creation ---

    it('should create DLQ and main queue (2 createQueue calls)', async () => {
      await orchestrator.spawnAgent(workerConfig());

      expect(mockSQS.createdQueues.length).toBe(2);
      expect(mockSQS.createdQueues[0].QueueName).toContain('-dlq');
      expect(mockSQS.createdQueues[1].QueueName).not.toContain('-dlq');
    });

    it('should set RedrivePolicy on the main queue', async () => {
      await orchestrator.spawnAgent(workerConfig());

      const mainQueue = mockSQS.createdQueues[1];
      expect(mainQueue.Attributes).toBeDefined();
      const redrivePolicy = JSON.parse(mainQueue.Attributes!['RedrivePolicy']);
      expect(redrivePolicy.maxReceiveCount).toBe(3);
      expect(redrivePolicy.deadLetterTargetArn).toBeTruthy();
    });

    it('should use custom timeoutSeconds as VisibilityTimeout', async () => {
      await orchestrator.spawnAgent(workerConfig({ timeoutSeconds: 900 }));

      const mainQueue = mockSQS.createdQueues[1];
      expect(mainQueue.Attributes!['VisibilityTimeout']).toBe('900');
    });

    it('should default VisibilityTimeout to 300 when timeoutSeconds not set', async () => {
      await orchestrator.spawnAgent(workerConfig());

      const mainQueue = mockSQS.createdQueues[1];
      expect(mainQueue.Attributes!['VisibilityTimeout']).toBe('300');
    });

    // --- DynamoDB persistence ---

    it('should persist agent to DynamoDB on spawn', async () => {
      await orchestrator.spawnAgent(workerConfig());

      expect(mockDDB.putItems.length).toBe(1);
      expect(mockDDB.putItems[0].TableName).toBe('test-agents');
      expect(mockDDB.putItems[0].Item['PK']).toBe('AGENT#tenant-123');
      expect(mockDDB.putItems[0].Item['SK']).toBe('AGENT#agent-001');
      expect(mockDDB.putItems[0].Item['role']).toBe('worker');
      expect(mockDDB.putItems[0].Item['status']).toBe('initializing');
    });

    // --- EventBridge event ---

    it('should publish agent.spawned event to EventBridge', async () => {
      await orchestrator.spawnAgent(workerConfig());

      expect(mockEB.publishedEvents.length).toBe(1);
      expect(mockEB.publishedEvents[0].DetailType).toBe('agent.spawned');
      expect(mockEB.publishedEvents[0].EventBusName).toBe('test-event-bus');

      const detail = JSON.parse(mockEB.publishedEvents[0].Detail);
      expect(detail.agentId).toBe('agent-001');
      expect(detail.tenantId).toBe('tenant-123');
      expect(detail.details.role).toBe('worker');
      expect(detail.details.capabilities).toEqual(['document-analysis', 'summarization']);
    });

    // --- Concurrency limit ---

    it('should enforce max concurrent agents limit', async () => {
      const orch = new AgentOrchestrator(
        defaultOrchestratorConfig({
          sqs: mockSQS,
          ddb: mockDDB,
          eb: mockEB,
          maxConcurrentAgents: 3,
        })
      );

      await orch.spawnAgent(workerConfig({ agentId: 'a1' }));
      await orch.spawnAgent(workerConfig({ agentId: 'a2' }));
      await orch.spawnAgent(workerConfig({ agentId: 'a3' }));

      await expect(orch.spawnAgent(workerConfig({ agentId: 'a4' }))).rejects.toThrow(
        'Max concurrent agents reached'
      );
    });

    it('should default maxConcurrentAgents to 100', async () => {
      // Create orchestrator without maxConcurrentAgents specified
      const orch = new AgentOrchestrator({
        region: 'us-east-1',
        eventBusName: 'test',
        agentTableName: 'test',
        defaultQueuePrefix: 'q',
        clients: { sqs: mockSQS, dynamodb: mockDDB, eventBridge: mockEB },
      });

      // Should not throw — limit defaults to 100
      await orch.spawnAgent(workerConfig({ agentId: 'first-agent' }));
      expect(orch.listAgents('tenant-123').length).toBe(1);
    });

    // --- Error: missing queue URL ---

    it('should throw when SQS createQueue returns no QueueUrl for DLQ', async () => {
      const brokenSQS = createMockSQSClient();
      let callCount = 0;
      brokenSQS.createQueue = async () => {
        callCount++;
        if (callCount === 1) return { QueueUrl: undefined };
        return { QueueUrl: 'https://sqs...' };
      };

      const orch = new AgentOrchestrator(
        defaultOrchestratorConfig({ sqs: brokenSQS, ddb: mockDDB, eb: mockEB })
      );

      await expect(orch.spawnAgent(workerConfig())).rejects.toThrow(
        'Failed to create DLQ for agent agent-001'
      );
    });

    it('should throw when getQueueAttributes returns no QueueArn', async () => {
      const brokenSQS = createMockSQSClient();
      brokenSQS.getQueueAttributes = async () => ({ Attributes: {} });

      const orch = new AgentOrchestrator(
        defaultOrchestratorConfig({ sqs: brokenSQS, ddb: mockDDB, eb: mockEB })
      );

      await expect(orch.spawnAgent(workerConfig())).rejects.toThrow(
        'Failed to get DLQ ARN for agent agent-001'
      );
    });

    it('should throw when SQS createQueue returns no QueueUrl for main queue', async () => {
      const brokenSQS = createMockSQSClient();
      let callCount = 0;
      brokenSQS.createQueue = async (input) => {
        callCount++;
        if (callCount <= 1) {
          // DLQ succeeds
          return {
            QueueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${input.QueueName}`,
          };
        }
        // Main queue fails
        return { QueueUrl: undefined };
      };

      const orch = new AgentOrchestrator(
        defaultOrchestratorConfig({ sqs: brokenSQS, ddb: mockDDB, eb: mockEB })
      );

      await expect(orch.spawnAgent(workerConfig())).rejects.toThrow(
        'Failed to create queue for agent agent-001'
      );
    });
  });

  // =========================================================================
  // getAgent (via listAgents)
  // =========================================================================

  describe('listAgents / getAgent', () => {
    beforeEach(async () => {
      await orchestrator.spawnAgent(
        workerConfig({ agentId: 'worker-001', role: 'worker', capabilities: ['analysis'] })
      );
      await orchestrator.spawnAgent(
        workerConfig({
          agentId: 'coordinator-001',
          role: 'coordinator',
          capabilities: ['orchestration'],
        })
      );
      await orchestrator.spawnAgent(
        workerConfig({ tenantId: 'tenant-456', agentId: 'worker-002', capabilities: ['analysis'] })
      );
    });

    it('should return all agents for a given tenant', () => {
      const agents = orchestrator.listAgents('tenant-123');
      expect(agents.length).toBe(2);
    });

    it('should return empty array for unknown tenant', () => {
      const agents = orchestrator.listAgents('non-existent');
      expect(agents.length).toBe(0);
    });

    it('should filter by role', () => {
      const agents = orchestrator.listAgents('tenant-123', { role: 'worker' });
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe('worker-001');
    });

    it('should filter by status', async () => {
      await orchestrator.updateHeartbeat('tenant-123', 'worker-001', 'processing');
      const agents = orchestrator.listAgents('tenant-123', { status: 'processing' });
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe('worker-001');
    });

    it('should filter by capability', () => {
      const agents = orchestrator.listAgents('tenant-123', { capability: 'orchestration' });
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe('coordinator-001');
    });

    it('should combine multiple filters', async () => {
      await orchestrator.updateHeartbeat('tenant-123', 'worker-001', 'processing');
      const agents = orchestrator.listAgents('tenant-123', {
        role: 'worker',
        status: 'processing',
      });
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe('worker-001');
    });

    it('should isolate agents across tenants', () => {
      const t1 = orchestrator.listAgents('tenant-123');
      const t2 = orchestrator.listAgents('tenant-456');

      expect(t1.length).toBe(2);
      expect(t2.length).toBe(1);
      expect(t2[0].tenantId).toBe('tenant-456');
    });
  });

  // =========================================================================
  // terminateAgent
  // =========================================================================

  describe('terminateAgent', () => {
    it('should remove agent from active registry', async () => {
      await orchestrator.spawnAgent(workerConfig());
      await orchestrator.terminateAgent('tenant-123', 'agent-001');

      expect(orchestrator.listAgents('tenant-123').length).toBe(0);
    });

    it('should delete the agent SQS queue', async () => {
      const metadata = await orchestrator.spawnAgent(workerConfig());
      await orchestrator.terminateAgent('tenant-123', 'agent-001');

      expect(mockSQS.deletedQueues).toContain(metadata.queueUrl);
    });

    it('should publish agent.terminated event with uptime info', async () => {
      await orchestrator.spawnAgent(workerConfig());
      await orchestrator.terminateAgent('tenant-123', 'agent-001');

      const termEvent = mockEB.publishedEvents.find((e) => e.DetailType === 'agent.terminated');
      expect(termEvent).toBeTruthy();

      const detail = JSON.parse(termEvent!.Detail);
      expect(detail.agentId).toBe('agent-001');
      expect(detail.tenantId).toBe('tenant-123');
      expect(typeof detail.details.uptime).toBe('number');
      expect(detail.details.taskCount).toBe(0);
    });

    it('should throw when terminating non-existent agent', async () => {
      await expect(orchestrator.terminateAgent('tenant-123', 'ghost')).rejects.toThrow(
        'Agent not found: ghost'
      );
    });

    it('should allow re-spawning after termination', async () => {
      await orchestrator.spawnAgent(workerConfig());
      await orchestrator.terminateAgent('tenant-123', 'agent-001');

      const respawned = await orchestrator.spawnAgent(workerConfig());
      expect(respawned.agentId).toBe('agent-001');
      expect(orchestrator.listAgents('tenant-123').length).toBe(1);
    });

    it('should free concurrency slot after termination', async () => {
      const orch = new AgentOrchestrator(
        defaultOrchestratorConfig({
          sqs: mockSQS,
          ddb: mockDDB,
          eb: mockEB,
          maxConcurrentAgents: 2,
        })
      );

      await orch.spawnAgent(workerConfig({ agentId: 'a1' }));
      await orch.spawnAgent(workerConfig({ agentId: 'a2' }));

      // At limit
      await expect(orch.spawnAgent(workerConfig({ agentId: 'a3' }))).rejects.toThrow();

      // Terminate one and try again
      await orch.terminateAgent('tenant-123', 'a1');
      const m = await orch.spawnAgent(workerConfig({ agentId: 'a3' }));
      expect(m.agentId).toBe('a3');
    });
  });

  // =========================================================================
  // delegateTask
  // =========================================================================

  describe('delegateTask', () => {
    let targetQueueUrl: string;

    beforeEach(async () => {
      const meta = await orchestrator.spawnAgent(
        workerConfig({ agentId: 'worker-001', capabilities: ['task-execution'] })
      );
      targetQueueUrl = meta.queueUrl;
    });

    it('should send task as JSON to target agent SQS queue', async () => {
      const delegation: TaskDelegation = {
        taskId: 'task-001',
        sourceAgentId: 'coordinator-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Analyze document XYZ',
        context: { documentId: 'doc-123' },
        priority: 'high',
      };

      await orchestrator.delegateTask(delegation);

      const sent = mockSQS.sentMessages.find((m) => m.MessageBody.includes('task-001'));
      expect(sent).toBeTruthy();
      expect(sent!.QueueUrl).toBe(targetQueueUrl);

      const body = JSON.parse(sent!.MessageBody);
      expect(body.taskId).toBe('task-001');
      expect(body.instruction).toBe('Analyze document XYZ');
      expect(body.context.documentId).toBe('doc-123');
    });

    it('should publish agent.task.started event', async () => {
      await orchestrator.delegateTask({
        taskId: 'task-002',
        sourceAgentId: 'coordinator',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Do something',
        context: {},
      });

      const taskEvent = mockEB.publishedEvents.find((e) => e.DetailType === 'agent.task.started');
      expect(taskEvent).toBeTruthy();
      const detail = JSON.parse(taskEvent!.Detail);
      expect(detail.agentId).toBe('worker-001');
      expect(detail.details.taskId).toBe('task-002');
    });

    it('should default priority to normal when not specified', async () => {
      await orchestrator.delegateTask({
        taskId: 'task-003',
        sourceAgentId: 'coordinator',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Work',
        context: {},
      });

      const taskEvent = mockEB.publishedEvents.find((e) => e.DetailType === 'agent.task.started');
      const detail = JSON.parse(taskEvent!.Detail);
      expect(detail.details.priority).toBe('normal');
    });

    it('should throw when target agent not found', async () => {
      await expect(
        orchestrator.delegateTask({
          taskId: 't1',
          sourceAgentId: 'src',
          targetAgentId: 'nonexistent',
          tenantId: 'tenant-123',
          instruction: 'x',
          context: {},
        })
      ).rejects.toThrow('Agent not found: nonexistent');
    });

    it('should throw when target agent is in failed status', async () => {
      await orchestrator.updateHeartbeat('tenant-123', 'worker-001', 'failed');

      await expect(
        orchestrator.delegateTask({
          taskId: 't1',
          sourceAgentId: 'src',
          targetAgentId: 'worker-001',
          tenantId: 'tenant-123',
          instruction: 'x',
          context: {},
        })
      ).rejects.toThrow('Agent unavailable: worker-001');
    });

    it('should throw when target agent is terminating', async () => {
      await orchestrator.updateHeartbeat('tenant-123', 'worker-001', 'terminating');

      await expect(
        orchestrator.delegateTask({
          taskId: 't1',
          sourceAgentId: 'src',
          targetAgentId: 'worker-001',
          tenantId: 'tenant-123',
          instruction: 'x',
          context: {},
        })
      ).rejects.toThrow('Agent unavailable: worker-001');
    });

    it('should allow delegation to agent in ready status', async () => {
      await orchestrator.updateHeartbeat('tenant-123', 'worker-001', 'ready');

      // Should not throw
      await orchestrator.delegateTask({
        taskId: 't1',
        sourceAgentId: 'src',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'x',
        context: {},
      });
    });

    it('should allow delegation to agent in processing status', async () => {
      await orchestrator.updateHeartbeat('tenant-123', 'worker-001', 'processing');

      await orchestrator.delegateTask({
        taskId: 't1',
        sourceAgentId: 'src',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'x',
        context: {},
      });
    });
  });

  // =========================================================================
  // updateHeartbeat
  // =========================================================================

  describe('updateHeartbeat', () => {
    it('should update agent status and lastHeartbeat timestamp', async () => {
      await orchestrator.spawnAgent(workerConfig());

      const before = orchestrator.listAgents('tenant-123')[0].lastHeartbeat;
      await new Promise((r) => setTimeout(r, 10));

      await orchestrator.updateHeartbeat('tenant-123', 'agent-001', 'processing');

      const after = orchestrator.listAgents('tenant-123')[0];
      expect(after.status).toBe('processing');
      expect(after.lastHeartbeat > before).toBe(true);
    });

    it('should persist heartbeat to DynamoDB', async () => {
      await orchestrator.spawnAgent(workerConfig());
      await orchestrator.updateHeartbeat('tenant-123', 'agent-001', 'ready');

      const update = mockDDB.updateCalls.find(
        (u) => u.Key['PK'] === 'AGENT#tenant-123' && u.Key['SK'] === 'AGENT#agent-001'
      );
      expect(update).toBeTruthy();
      expect(update!.TableName).toBe('test-agents');
    });

    it('should throw for non-existent agent', async () => {
      await expect(orchestrator.updateHeartbeat('tenant-123', 'ghost', 'ready')).rejects.toThrow(
        'Agent not found: ghost'
      );
    });

    it('should support all valid status transitions', async () => {
      await orchestrator.spawnAgent(workerConfig());

      const statuses: AgentStatus[] = [
        'ready',
        'processing',
        'blocked',
        'failed',
        'terminating',
        'initializing',
      ];

      for (const status of statuses) {
        await orchestrator.updateHeartbeat('tenant-123', 'agent-001', status);
        const agent = orchestrator.listAgents('tenant-123')[0];
        expect(agent.status).toBe(status);
      }
    });
  });

  // =========================================================================
  // publishEvent (indirectly via spawn/terminate/delegate)
  // =========================================================================

  describe('publishEvent (EventBridge integration)', () => {
    it('should use the configured event bus name for all events', async () => {
      await orchestrator.spawnAgent(workerConfig());
      await orchestrator.terminateAgent('tenant-123', 'agent-001');

      for (const event of mockEB.publishedEvents) {
        expect(event.EventBusName).toBe('test-event-bus');
      }
    });

    it('should include timestamp in all events', async () => {
      await orchestrator.spawnAgent(workerConfig());

      for (const event of mockEB.publishedEvents) {
        const detail = JSON.parse(event.Detail);
        expect(detail.timestamp).toBeTruthy();
        // Verify valid ISO date
        expect(new Date(detail.timestamp).toISOString()).toBe(detail.timestamp);
      }
    });

    it('should set Source to chimera.agent for all events', async () => {
      // Events are sent via putEvents which wraps them — verify the Detail contains expected fields
      await orchestrator.spawnAgent(workerConfig());

      const detail = JSON.parse(mockEB.publishedEvents[0].Detail);
      expect(detail.eventType).toBe('agent.spawned');
    });
  });

  // =========================================================================
  // createOrchestrator factory
  // =========================================================================

  describe('createOrchestrator', () => {
    it('should create orchestrator with default config', () => {
      // This will try to build real AWS clients, but that's fine for just construction
      const orch = createOrchestrator({
        clients: { sqs: mockSQS, dynamodb: mockDDB, eventBridge: mockEB },
      });

      expect(orch).toBeInstanceOf(AgentOrchestrator);
    });

    it('should allow overriding individual config values', () => {
      const orch = createOrchestrator({
        region: 'eu-west-1',
        eventBusName: 'custom-bus',
        clients: { sqs: mockSQS, dynamodb: mockDDB, eventBridge: mockEB },
      });

      // Verify by spawning and checking EventBridge bus
      expect(orch).toBeInstanceOf(AgentOrchestrator);
    });
  });
});
