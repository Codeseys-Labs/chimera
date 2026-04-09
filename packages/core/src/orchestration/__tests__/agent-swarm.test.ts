/**
 * Comprehensive unit tests for AgentSwarm
 *
 * Tests swarm initialization, auto-scaling strategies, state management,
 * shutdown, presets, and the createSwarm factory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentSwarm, createSwarm, SwarmPresets, type SwarmConfig, type SwarmState } from '../swarm';
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
  let queueCounter = 0;
  return {
    createQueue: async (input) => ({
      QueueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${input.QueueName}`,
    }),
    getQueueAttributes: async () => ({
      Attributes: {
        QueueArn: `arn:aws:sqs:us-east-1:123456789012:dlq-${++queueCounter}`,
      },
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
  // Constructor & Initial state
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
  // initialize
  // =========================================================================

  describe('initialize', () => {
    it('should spawn minAgents during initialization', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 3 }));
      await swarm.initialize();

      const state = swarm.getState();
      expect(state.agentIds.length).toBe(3);
      expect(state.metrics.activeAgents).toBe(3);
    });

    it('should name agents with swarm prefix and sequential IDs', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 2, swarmId: 'alpha' }));
      await swarm.initialize();

      const state = swarm.getState();
      expect(state.agentIds).toContain('alpha-agent-1');
      expect(state.agentIds).toContain('alpha-agent-2');
    });

    it('should register agents with orchestrator', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 2 }));
      await swarm.initialize();

      const agents = orchestrator.listAgents('tenant-123');
      expect(agents.length).toBe(2);
      expect(agents[0].role).toBe('worker');
    });

    it('should pass capabilities to spawned agents', async () => {
      swarm = new AgentSwarm(
        orchestrator,
        defaultSwarmConfig({ minAgents: 1, capabilities: ['ml-training'] })
      );
      await swarm.initialize();

      const agents = orchestrator.listAgents('tenant-123');
      expect(agents[0].capabilities).toContain('ml-training');
    });

    it('should pass swarmId as metadata to spawned agents', async () => {
      swarm = new AgentSwarm(
        orchestrator,
        defaultSwarmConfig({ minAgents: 1, swarmId: 'swarm-x', metadata: { custom: 'data' } })
      );
      await swarm.initialize();

      const agents = orchestrator.listAgents('tenant-123');
      expect(agents[0].metadata).toEqual({ swarmId: 'swarm-x', custom: 'data' });
    });

    it('should handle minAgents=0 gracefully', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 0 }));
      await swarm.initialize();

      expect(swarm.getState().agentIds.length).toBe(0);
    });
  });

  // =========================================================================
  // getState
  // =========================================================================

  describe('getState', () => {
    it('should reflect config in returned state', async () => {
      const config = defaultSwarmConfig({ minAgents: 1 });
      swarm = new AgentSwarm(orchestrator, config);
      await swarm.initialize();

      const state = swarm.getState();
      expect(state.config).toEqual(config);
    });

    it('should update metrics after initialization', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 3 }));
      await swarm.initialize();

      expect(swarm.getState().metrics.activeAgents).toBe(3);
    });
  });

  // =========================================================================
  // shutdown
  // =========================================================================

  describe('shutdown', () => {
    it('should terminate all agents in the swarm', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 3 }));
      await swarm.initialize();

      expect(orchestrator.listAgents('tenant-123').length).toBe(3);

      await swarm.shutdown();

      expect(orchestrator.listAgents('tenant-123').length).toBe(0);
      expect(swarm.getState().agentIds.length).toBe(0);
      expect(swarm.getState().metrics.activeAgents).toBe(0);
    });

    it('should stop scaling monitor on shutdown', async () => {
      swarm = new AgentSwarm(
        orchestrator,
        defaultSwarmConfig({ minAgents: 1, scalingStrategy: 'queue-depth' })
      );
      await swarm.initialize();

      // Shutdown should not throw and should stop the timer
      await swarm.shutdown();

      // No lingering intervals
      expect(swarm.getState().agentIds.length).toBe(0);
    });

    it('should handle shutdown when no agents remain', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 0 }));
      await swarm.initialize();

      // Should not throw
      await swarm.shutdown();
    });
  });

  // =========================================================================
  // stopScalingMonitor
  // =========================================================================

  describe('stopScalingMonitor', () => {
    it('should be callable multiple times without error', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 1 }));
      await swarm.initialize();

      swarm.stopScalingMonitor();
      swarm.stopScalingMonitor(); // second call should be no-op
    });
  });

  // =========================================================================
  // createSwarm factory
  // =========================================================================

  describe('createSwarm', () => {
    it('should create and initialize swarm', async () => {
      swarm = await createSwarm(orchestrator, defaultSwarmConfig({ minAgents: 2 }));

      expect(swarm).toBeInstanceOf(AgentSwarm);
      expect(swarm.getState().agentIds.length).toBe(2);
    });
  });

  // =========================================================================
  // SwarmPresets
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

    it('should produce configs usable with AgentSwarm constructor', async () => {
      const config = SwarmPresets.research('tenant-123', 'swarm-test');
      swarm = new AgentSwarm(orchestrator, config);
      await swarm.initialize();

      expect(swarm.getState().agentIds.length).toBe(config.minAgents);
    });
  });

  // =========================================================================
  // Scaling strategies (structural tests — evaluateScaling is private)
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

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('should handle swarm with maxAgents equal to minAgents', async () => {
      swarm = new AgentSwarm(orchestrator, defaultSwarmConfig({ minAgents: 3, maxAgents: 3 }));
      await swarm.initialize();

      expect(swarm.getState().agentIds.length).toBe(3);
    });

    it('should track multiple swarms independently on same orchestrator', async () => {
      const swarm1 = new AgentSwarm(
        orchestrator,
        defaultSwarmConfig({ swarmId: 'swarm-A', minAgents: 1 })
      );
      const swarm2 = new AgentSwarm(
        orchestrator,
        defaultSwarmConfig({ swarmId: 'swarm-B', minAgents: 2 })
      );

      await swarm1.initialize();
      await swarm2.initialize();

      expect(swarm1.getState().agentIds.length).toBe(1);
      expect(swarm2.getState().agentIds.length).toBe(2);
      expect(orchestrator.listAgents('tenant-123').length).toBe(3);

      swarm1.stopScalingMonitor();
      swarm2.stopScalingMonitor();

      // Assign to module-level swarm so afterEach cleans up
      swarm = swarm1;
      await swarm2.shutdown();
    });
  });
});
