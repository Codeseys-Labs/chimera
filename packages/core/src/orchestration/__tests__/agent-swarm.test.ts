/**
 * Unit tests for AgentSwarm
 *
 * `AgentOrchestrator.spawnAgent` is gated (Wave-14 audit M1) because
 * AgentCore SDK integration has not landed. `AgentSwarm.initialize()`
 * spawns minAgents via the orchestrator and therefore propagates the
 * `not implemented` error. Tests preserve the constructor + presets
 * + `stopScalingMonitor` contract and codify the new failure mode.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentSwarm, createSwarm, SwarmPresets, type SwarmConfig } from '../swarm';
import {
  AgentOrchestrator,
  type OrchestratorSQSClient,
  type OrchestratorDDBClient,
  type OrchestratorEventBridgeClient,
} from '../orchestrator';

// ---------------------------------------------------------------------------
// Mock AWS clients
// ---------------------------------------------------------------------------

function createMockSQSClient(): OrchestratorSQSClient {
  return {
    createQueue: async (input) => ({
      QueueUrl: `https://sqs.us-east-1.amazonaws.com/TESTACCT/${input.QueueName}`,
    }),
    getQueueAttributes: async () => ({
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:TESTACCT:test-dlq' },
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

function createTestOrchestrator(): AgentOrchestrator {
  return new AgentOrchestrator({
    region: 'us-east-1',
    eventBusName: 'test-bus',
    agentTableName: 'test-agents',
    defaultQueuePrefix: 'test-q',
    maxConcurrentAgents: 100,
    clients: {
      sqs: createMockSQSClient(),
      dynamodb: createMockDDBClient(),
      eventBridge: createMockEventBridgeClient(),
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSwarmConfig(overrides?: Partial<SwarmConfig>): SwarmConfig {
  return {
    tenantId: 'tenant-123',
    swarmId: 'test-swarm',
    role: 'worker',
    capabilities: ['task-execution', 'data-processing'],
    scalingStrategy: 'fixed',
    minAgents: 2,
    maxAgents: 10,
    agentTimeoutSeconds: 300,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentSwarm', () => {
  let orchestrator: AgentOrchestrator;
  let swarm: AgentSwarm;

  beforeEach(() => {
    orchestrator = createTestOrchestrator();
  });

  afterEach(() => {
    // Stop scaling monitor to prevent leaking intervals
    swarm?.stopScalingMonitor();
  });

  // =========================================================================
  // Constructor & Initial state (pure — no AWS calls)
  // =========================================================================

  describe('constructor', () => {
    it('should initialize with correct default state', () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig());

      const state = swarm.getState();
      expect(state.config.swarmId).toBe('test-swarm');
      expect(state.agentIds).toEqual([]);
      expect(state.metrics.activeAgents).toBe(0);
      expect(state.metrics.queueDepth).toBe(0);
      expect(state.metrics.avgLatencyMs).toBe(0);
      expect(state.metrics.tasksPerMinute).toBe(0);
      expect(state.lastScalingAction).toBeTruthy();
    });

    it('should store swarmId in metrics', () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ swarmId: 'my-swarm' }));
      expect(swarm.getState().metrics.swarmId).toBe('my-swarm');
    });
  });

  // =========================================================================
  // initialize — cascades the AgentCore Runtime stub throw
  // =========================================================================

  describe('initialize', () => {
    it('should throw "not implemented" because orchestrator.spawnAgent is gated', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 3 }));
      await expect(swarm.initialize()).rejects.toThrow('not implemented');
    });

    it('should succeed when minAgents=0 (no spawn happens)', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 0 }));
      await swarm.initialize();

      expect(swarm.getState().agentIds.length).toBe(0);
    });
  });

  // =========================================================================
  // getState — pure
  // =========================================================================

  describe('getState', () => {
    it('should reflect config in returned state', () => {
      const config = defaultSwarmConfig({ minAgents: 0 });
      swarm = new AgentSwarm(orchestrator, config);
      expect(swarm.getState().config).toEqual(config);
    });
  });

  // =========================================================================
  // stopScalingMonitor (safe even without initialize)
  // =========================================================================

  describe('stopScalingMonitor', () => {
    it('should be callable multiple times without error', () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 0 }));

      swarm.stopScalingMonitor();
      swarm.stopScalingMonitor();
    });
  });

  // =========================================================================
  // createSwarm factory — propagates initialize's throw when minAgents > 0
  // =========================================================================

  describe('createSwarm', () => {
    it('should throw when minAgents > 0 (spawn is gated)', async () => {
      await expect(
        createSwarm(orchestrator, defaultSwarmConfig({ minAgents: 2 }))
      ).rejects.toThrow('not implemented');
    });

    it('should succeed when minAgents=0', async () => {
      swarm = await createSwarm(orchestrator, defaultSwarmConfig({ minAgents: 0 }));
      expect(swarm).toBeInstanceOf(AgentSwarm);
    });
  });

  // =========================================================================
  // SwarmPresets (pure data)
  // =========================================================================

  describe('SwarmPresets', () => {
    describe('research preset', () => {
      it('should configure research swarm correctly', () => {
        const config = SwarmPresets.research('tenant-abc', 'research-1');

        expect(config.tenantId).toBe('tenant-abc');
        expect(config.swarmId).toBe('research-1');
        expect(config.role).toBe('specialist');
        expect(config.capabilities).toContain('document-analysis');
        expect(config.capabilities).toContain('web-search');
        expect(config.capabilities).toContain('summarization');
        expect(config.scalingStrategy).toBe('queue-depth');
        expect(config.minAgents).toBe(2);
        expect(config.maxAgents).toBe(10);
        expect(config.scaleUpThreshold).toBe(5);
        expect(config.scaleDownThreshold).toBe(1);
      });
    });

    describe('monitoring preset', () => {
      it('should configure monitoring swarm correctly', () => {
        const config = SwarmPresets.monitoring('tenant-abc', 'monitor-1');

        expect(config.role).toBe('monitor');
        expect(config.capabilities).toContain('log-analysis');
        expect(config.capabilities).toContain('anomaly-detection');
        expect(config.scalingStrategy).toBe('latency');
        expect(config.minAgents).toBe(1);
        expect(config.maxAgents).toBe(5);
        expect(config.scaleUpThreshold).toBe(3000);
        expect(config.scaleDownThreshold).toBe(500);
      });
    });

    describe('worker preset', () => {
      it('should configure worker swarm correctly', () => {
        const config = SwarmPresets.worker('tenant-abc', 'worker-1');

        expect(config.role).toBe('worker');
        expect(config.capabilities).toContain('task-execution');
        expect(config.capabilities).toContain('data-processing');
        expect(config.scalingStrategy).toBe('queue-depth');
        expect(config.minAgents).toBe(3);
        expect(config.maxAgents).toBe(20);
      });
    });
  });

  // =========================================================================
  // Scaling strategy configuration (construction-time only)
  // =========================================================================

  describe('scaling strategy configuration', () => {
    it('should accept fixed scaling strategy', () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ scalingStrategy: 'fixed' }));
      expect(swarm.getState().config.scalingStrategy).toBe('fixed');
    });

    it('should accept queue-depth scaling strategy', () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ scalingStrategy: 'queue-depth' }));
      expect(swarm.getState().config.scalingStrategy).toBe('queue-depth');
    });

    it('should accept latency scaling strategy', () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ scalingStrategy: 'latency' }));
      expect(swarm.getState().config.scalingStrategy).toBe('latency');
    });

    it('should accept adaptive scaling strategy', () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ scalingStrategy: 'adaptive' }));
      expect(swarm.getState().config.scalingStrategy).toBe('adaptive');
    });

    it('should store scale thresholds in config', () => {
      swarm = new AgentSwarm(
        orchestrator,
        defaultSwarmConfig({ scaleUpThreshold: 15, scaleDownThreshold: 3 })
      );

      const state = swarm.getState();
      expect(state.config.scaleUpThreshold).toBe(15);
      expect(state.config.scaleDownThreshold).toBe(3);
    });
  });
});
