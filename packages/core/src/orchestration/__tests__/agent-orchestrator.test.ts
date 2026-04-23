/**
 * Unit tests for AgentOrchestrator
 *
 * The AgentCore Runtime SDK integration is still pending (Wave-14 audit M1),
 * so `createAgentRuntime` throws `not implemented`. That error propagates
 * through `spawnAgent`, which in turn means every downstream operation
 * (`delegateTask`, `terminateAgent`, `updateHeartbeat`, `listAgents`) has
 * no registered agents to act on. Tests here codify that contract so the
 * old "silent garbage ARN" behaviour cannot silently return.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  AgentOrchestrator,
  createOrchestrator,
  type SpawnAgentConfig,
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
        QueueUrl: `https://sqs.us-east-1.amazonaws.com/TESTACCT/${input.QueueName}`,
      };
    },
    getQueueAttributes: async () => ({
      Attributes: {
        QueueArn: `arn:aws:sqs:us-east-1:TESTACCT:test-dlq-${++queueCounter}`,
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
  // spawnAgent — guarded by createAgentRuntime throwing "not implemented"
  // =========================================================================

  describe('spawnAgent', () => {
    it('should throw "not implemented" because AgentCore SDK integration is pending', async () => {
      await expect(orchestrator.spawnAgent(workerConfig())).rejects.toThrow(
        'not implemented',
      );
    });

    it('should not touch SQS / DDB / EventBridge when createAgentRuntime throws', async () => {
      await expect(orchestrator.spawnAgent(workerConfig())).rejects.toThrow();

      expect(mockSQS.createdQueues.length).toBe(0);
      expect(mockDDB.putItems.length).toBe(0);
      expect(mockEB.publishedEvents.length).toBe(0);
    });

    it('should throw "not implemented" even at the default concurrency limit', async () => {
      // The concurrency check uses `|| 100` and `this.activeAgents.size`
      // starts at 0, so the check never triggers on a fresh orchestrator —
      // the `not implemented` throw from `createAgentRuntime` fires first.
      const orch = new AgentOrchestrator(
        defaultOrchestratorConfig({
          sqs: mockSQS,
          ddb: mockDDB,
          eb: mockEB,
        })
      );

      await expect(orch.spawnAgent(workerConfig())).rejects.toThrow('not implemented');
    });
  });

  // =========================================================================
  // listAgents
  // =========================================================================

  describe('listAgents', () => {
    it('should return an empty array when no agents have been registered', () => {
      expect(orchestrator.listAgents('tenant-123')).toEqual([]);
    });

    it('should return empty array when filtering by role without any spawns', () => {
      expect(orchestrator.listAgents('tenant-123', { role: 'worker' })).toEqual([]);
    });
  });

  // =========================================================================
  // terminateAgent — requires a registered agent, which spawn cannot provide
  // =========================================================================

  describe('terminateAgent', () => {
    it('should throw "Agent not found" because no agent can be spawned', async () => {
      await expect(orchestrator.terminateAgent('tenant-123', 'agent-001')).rejects.toThrow(
        'Agent not found: agent-001'
      );
    });
  });

  // =========================================================================
  // delegateTask — requires a registered target
  // =========================================================================

  describe('delegateTask', () => {
    it('should throw when target agent is not registered (spawn is gated)', async () => {
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
  });

  // =========================================================================
  // updateHeartbeat — also requires a registered agent
  // =========================================================================

  describe('updateHeartbeat', () => {
    it('should throw "Agent not found" when no agents are registered', async () => {
      await expect(
        orchestrator.updateHeartbeat('tenant-123', 'ghost', 'ready')
      ).rejects.toThrow('Agent not found: ghost');
    });
  });

  // =========================================================================
  // createOrchestrator factory — constructor still works
  // =========================================================================

  describe('createOrchestrator', () => {
    it('should create orchestrator with default config', () => {
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

      expect(orch).toBeInstanceOf(AgentOrchestrator);
    });
  });
});
