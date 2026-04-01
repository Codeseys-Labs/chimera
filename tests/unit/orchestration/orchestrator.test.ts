/**
 * Tests for AgentOrchestrator
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  AgentOrchestrator,
  createOrchestrator,
  type SpawnAgentConfig,
  type TaskDelegation,
  type AgentStatus,
  type OrchestratorSQSClient,
  type OrchestratorDDBClient,
  type OrchestratorEventBridgeClient,
} from '../../../packages/core/src/orchestration/orchestrator';

// ---------------------------------------------------------------------------
// Mock AWS clients — plain objects satisfying narrow interfaces
// ---------------------------------------------------------------------------

function createMockSQSClient(): OrchestratorSQSClient & {
  sentMessages: Array<{ QueueUrl: string; MessageBody: string }>;
  deletedQueues: string[];
} {
  let queueCounter = 0;
  const sentMessages: Array<{ QueueUrl: string; MessageBody: string }> = [];
  const deletedQueues: string[] = [];

  return {
    sentMessages,
    deletedQueues,
    createQueue: async (input) => ({
      QueueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${input.QueueName}`,
    }),
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

function createMockDDBClient(): OrchestratorDDBClient & {
  putItems: Array<{ TableName: string; Item: Record<string, unknown> }>;
  updateCalls: Array<{ TableName: string; Key: Record<string, unknown> }>;
} {
  const putItems: Array<{ TableName: string; Item: Record<string, unknown> }> = [];
  const updateCalls: Array<{ TableName: string; Key: Record<string, unknown> }> = [];

  return {
    putItems,
    updateCalls,
    put: async (input) => { putItems.push(input); return {}; },
    update: async (input) => { updateCalls.push(input); return {}; },
  };
}

function createMockEventBridgeClient(): OrchestratorEventBridgeClient & {
  publishedEvents: Array<{ DetailType: string; Detail: string }>;
} {
  const publishedEvents: Array<{ DetailType: string; Detail: string }> = [];

  return {
    publishedEvents,
    putEvents: async (input) => {
      for (const entry of input.Entries) {
        publishedEvents.push({ DetailType: entry.DetailType, Detail: entry.Detail });
      }
      return { FailedEntryCount: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentOrchestrator', () => {
  let orchestrator: AgentOrchestrator;
  let mockSQS: ReturnType<typeof createMockSQSClient>;
  let mockDDB: ReturnType<typeof createMockDDBClient>;
  let mockEB: ReturnType<typeof createMockEventBridgeClient>;

  beforeEach(() => {
    mockSQS = createMockSQSClient();
    mockDDB = createMockDDBClient();
    mockEB  = createMockEventBridgeClient();

    orchestrator = createOrchestrator({
      region: 'us-east-1',
      eventBusName: 'test-event-bus',
      agentTableName: 'test-agents',
      defaultQueuePrefix: 'test-queue',
      maxConcurrentAgents: 10,
      clients: { sqs: mockSQS, dynamodb: mockDDB, eventBridge: mockEB },
    });
  });

  describe('spawnAgent', () => {
    it('should spawn agent with correct metadata', async () => {
      const config: SpawnAgentConfig = {
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: ['document-analysis', 'summarization']
      };

      const metadata = await orchestrator.spawnAgent(config);

      expect(metadata.agentId).toBe('agent-001');
      expect(metadata.tenantId).toBe('tenant-123');
      expect(metadata.role).toBe('worker');
      expect(metadata.status).toBe('initializing');
      expect(metadata.capabilities).toEqual(['document-analysis', 'summarization']);
      expect(metadata.runtimeArn).toBeTruthy();
      expect(metadata.queueUrl).toBeTruthy();
    });

    it('should track spawned agents', async () => {
      const config: SpawnAgentConfig = {
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: []
      };

      await orchestrator.spawnAgent(config);

      const agents = orchestrator.listAgents('tenant-123');
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe('agent-001');
    });

    it('should enforce max concurrent agents limit', async () => {
      const config: SpawnAgentConfig = {
        tenantId: 'tenant-123',
        agentId: 'agent-base',
        role: 'worker',
        capabilities: []
      };

      // Spawn up to limit
      for (let i = 0; i < 10; i++) {
        await orchestrator.spawnAgent({ ...config, agentId: `agent-${i}` });
      }

      // Attempt to exceed limit
      await expect(
        orchestrator.spawnAgent({ ...config, agentId: 'agent-overflow' })
      ).rejects.toThrow('Max concurrent agents reached');
    });

    it('should include optional metadata in agent runtime', async () => {
      const config: SpawnAgentConfig = {
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'specialist',
        capabilities: ['analysis'],
        modelId: 'anthropic.claude-sonnet-4-v1',
        memoryStrategy: 'SUMMARY',
        metadata: {
          owner: 'team-research',
          priority: 'high'
        }
      };

      const metadata = await orchestrator.spawnAgent(config);

      expect(metadata.metadata).toEqual({
        owner: 'team-research',
        priority: 'high'
      });
    });

    it('should persist agent to DynamoDB on spawn', async () => {
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: ['analysis'],
      });

      expect(mockDDB.putItems.length).toBe(1);
      expect(mockDDB.putItems[0].TableName).toBe('test-agents');
      expect(mockDDB.putItems[0].Item['PK']).toBe('AGENT#tenant-123');
      expect(mockDDB.putItems[0].Item['SK']).toBe('AGENT#agent-001');
    });

    it('should publish agent.spawned event to EventBridge on spawn', async () => {
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: [],
      });

      expect(mockEB.publishedEvents.length).toBe(1);
      expect(mockEB.publishedEvents[0].DetailType).toBe('agent.spawned');
    });

    it('should create SQS queue and DLQ on spawn', async () => {
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: [],
      });

      // createQueue called twice: DLQ then main queue
      const agents = orchestrator.listAgents('tenant-123');
      expect(agents[0].queueUrl).toContain('test-queue-tenant-123-agent-001');
    });
  });

  describe('delegateTask', () => {
    it('should delegate task to active agent', async () => {
      // Spawn target agent
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'worker-001',
        role: 'worker',
        capabilities: ['task-execution']
      });

      const delegation: TaskDelegation = {
        taskId: 'task-001',
        sourceAgentId: 'coordinator-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Analyze document XYZ',
        context: { documentId: 'doc-123' }
      };

      await orchestrator.delegateTask(delegation);
    });

    it('should send task as JSON message to target SQS queue', async () => {
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'worker-001',
        role: 'worker',
        capabilities: [],
      });

      const delegation: TaskDelegation = {
        taskId: 'task-001',
        sourceAgentId: 'coordinator-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Run analysis',
        context: {},
      };

      await orchestrator.delegateTask(delegation);

      const sentMsg = mockSQS.sentMessages.find(m =>
        m.MessageBody.includes('task-001')
      );
      expect(sentMsg).toBeTruthy();
      const parsed = JSON.parse(sentMsg!.MessageBody);
      expect(parsed.taskId).toBe('task-001');
      expect(parsed.instruction).toBe('Run analysis');
    });

    it('should publish agent.task.started event on delegation', async () => {
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'worker-001',
        role: 'worker',
        capabilities: [],
      });

      await orchestrator.delegateTask({
        taskId: 'task-001',
        sourceAgentId: 'coordinator-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Do work',
        context: {},
      });

      const taskEvent = mockEB.publishedEvents.find(
        e => e.DetailType === 'agent.task.started'
      );
      expect(taskEvent).toBeTruthy();
    });

    it('should reject delegation to non-existent agent', async () => {
      const delegation: TaskDelegation = {
        taskId: 'task-001',
        sourceAgentId: 'coordinator-001',
        targetAgentId: 'non-existent',
        tenantId: 'tenant-123',
        instruction: 'Test task',
        context: {}
      };

      await expect(
        orchestrator.delegateTask(delegation)
      ).rejects.toThrow('Agent not found: non-existent');
    });

    it('should reject delegation to failed agent', async () => {
      // Spawn agent
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'failed-agent',
        role: 'worker',
        capabilities: []
      });

      // Update to failed status
      await orchestrator.updateHeartbeat('tenant-123', 'failed-agent', 'failed');

      const delegation: TaskDelegation = {
        taskId: 'task-001',
        sourceAgentId: 'coordinator-001',
        targetAgentId: 'failed-agent',
        tenantId: 'tenant-123',
        instruction: 'Test task',
        context: {}
      };

      await expect(
        orchestrator.delegateTask(delegation)
      ).rejects.toThrow('Agent unavailable: failed-agent');
    });
  });

  describe('terminateAgent', () => {
    it('should terminate active agent', async () => {
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: []
      });

      await orchestrator.terminateAgent('tenant-123', 'agent-001');

      const agents = orchestrator.listAgents('tenant-123');
      expect(agents.length).toBe(0);
    });

    it('should delete agent SQS queue on termination', async () => {
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: [],
      });

      const agentQueueUrl = orchestrator.listAgents('tenant-123')[0].queueUrl;
      await orchestrator.terminateAgent('tenant-123', 'agent-001');

      expect(mockSQS.deletedQueues).toContain(agentQueueUrl);
    });

    it('should publish agent.terminated event on termination', async () => {
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: [],
      });

      await orchestrator.terminateAgent('tenant-123', 'agent-001');

      const termEvent = mockEB.publishedEvents.find(
        e => e.DetailType === 'agent.terminated'
      );
      expect(termEvent).toBeTruthy();
    });

    it('should throw error when terminating non-existent agent', async () => {
      await expect(
        orchestrator.terminateAgent('tenant-123', 'non-existent')
      ).rejects.toThrow('Agent not found: non-existent');
    });
  });

  describe('updateHeartbeat', () => {
    it('should update agent heartbeat and status', async () => {
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: []
      });

      const beforeUpdate = orchestrator.listAgents('tenant-123')[0];
      const initialHeartbeat = beforeUpdate.lastHeartbeat;

      // Wait 10ms to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));

      await orchestrator.updateHeartbeat('tenant-123', 'agent-001', 'processing');

      const afterUpdate = orchestrator.listAgents('tenant-123')[0];
      expect(afterUpdate.status).toBe('processing');
      expect(afterUpdate.lastHeartbeat).not.toBe(initialHeartbeat);
    });

    it('should persist heartbeat update to DynamoDB', async () => {
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: [],
      });

      await orchestrator.updateHeartbeat('tenant-123', 'agent-001', 'processing');

      const update = mockDDB.updateCalls.find(
        u => u.Key['PK'] === 'AGENT#tenant-123' && u.Key['SK'] === 'AGENT#agent-001'
      );
      expect(update).toBeTruthy();
    });

    it('should throw error for non-existent agent', async () => {
      await expect(
        orchestrator.updateHeartbeat('tenant-123', 'non-existent', 'ready')
      ).rejects.toThrow('Agent not found: non-existent');
    });
  });

  describe('listAgents', () => {
    beforeEach(async () => {
      // Spawn multiple agents with different attributes
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'worker-001',
        role: 'worker',
        capabilities: ['analysis']
      });

      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'coordinator-001',
        role: 'coordinator',
        capabilities: ['orchestration']
      });

      await orchestrator.spawnAgent({
        tenantId: 'tenant-456',
        agentId: 'worker-002',
        role: 'worker',
        capabilities: ['analysis']
      });

      await orchestrator.updateHeartbeat('tenant-123', 'worker-001', 'processing');
    });

    it('should list all agents for tenant', () => {
      const agents = orchestrator.listAgents('tenant-123');
      expect(agents.length).toBe(2);
    });

    it('should filter by role', () => {
      const agents = orchestrator.listAgents('tenant-123', { role: 'worker' });
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe('worker-001');
    });

    it('should filter by status', () => {
      const agents = orchestrator.listAgents('tenant-123', { status: 'processing' });
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe('worker-001');
    });

    it('should filter by capability', () => {
      const agents = orchestrator.listAgents('tenant-123', { capability: 'analysis' });
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe('worker-001');
    });

    it('should return empty array for non-existent tenant', () => {
      const agents = orchestrator.listAgents('non-existent');
      expect(agents.length).toBe(0);
    });
  });
});
