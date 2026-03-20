/**
 * Self-Expanding Swarm Pattern
 *
 * Implements dynamic agent swarms that:
 * - Scale based on workload
 * - Self-organize around tasks
 * - Share work through task pool
 * - Auto-terminate idle agents
 *
 * Pattern: Peer-to-Peer Coordination (from research)
 * - Agents discover and coordinate directly
 * - No single point of failure
 * - Dynamic scaling based on queue depth
 */

import type { AgentOrchestrator, SpawnAgentConfig, AgentRole } from './orchestrator';
import type { ISOTimestamp } from './types';

/**
 * Swarm scaling strategy
 */
export type ScalingStrategy =
  | 'fixed'        // Fixed number of agents
  | 'queue-depth'  // Scale based on SQS queue depth
  | 'latency'      // Scale based on task completion latency
  | 'adaptive';    // ML-based adaptive scaling

/**
 * Swarm configuration
 */
export interface SwarmConfig {
  tenantId: string;
  swarmId: string;
  role: AgentRole;
  capabilities: string[];
  scalingStrategy: ScalingStrategy;
  minAgents: number;
  maxAgents: number;
  scaleUpThreshold?: number;   // Queue depth or latency threshold
  scaleDownThreshold?: number;  // Idle time threshold
  agentTimeoutSeconds?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Swarm metrics for scaling decisions
 */
export interface SwarmMetrics {
  swarmId: string;
  activeAgents: number;
  queueDepth: number;
  avgLatencyMs: number;
  tasksPerMinute: number;
  timestamp: ISOTimestamp;
}

/**
 * Swarm state
 */
export interface SwarmState {
  config: SwarmConfig;
  agentIds: string[];
  metrics: SwarmMetrics;
  lastScalingAction: ISOTimestamp;
  scalingReason?: string;
}

/**
 * Self-Expanding Agent Swarm
 *
 * Manages a dynamic pool of agents that:
 * 1. Monitor shared task queue
 * 2. Spawn new agents when queue grows
 * 3. Terminate idle agents when queue shrinks
 * 4. Balance work across agent pool
 */
export class AgentSwarm {
  private orchestrator: AgentOrchestrator;
  private config: SwarmConfig;
  private state: SwarmState;
  private scalingTimer?: NodeJS.Timeout;

  constructor(orchestrator: AgentOrchestrator, config: SwarmConfig) {
    this.orchestrator = orchestrator;
    this.config = config;
    this.state = {
      config,
      agentIds: [],
      metrics: {
        swarmId: config.swarmId,
        activeAgents: 0,
        queueDepth: 0,
        avgLatencyMs: 0,
        tasksPerMinute: 0,
        timestamp: new Date().toISOString()
      },
      lastScalingAction: new Date().toISOString()
    };
  }

  /**
   * Initialize swarm with minimum agents
   */
  async initialize(): Promise<void> {
    console.log(`[Swarm] Initializing ${this.config.swarmId}`);

    // Spawn minimum required agents
    for (let i = 0; i < this.config.minAgents; i++) {
      await this.spawnAgent(`agent-${i + 1}`);
    }

    // Start auto-scaling monitor
    this.startScalingMonitor();
  }

  /**
   * Spawn a new agent in the swarm
   */
  private async spawnAgent(agentId: string): Promise<void> {
    const fullAgentId = `${this.config.swarmId}-${agentId}`;

    const spawnConfig: SpawnAgentConfig = {
      tenantId: this.config.tenantId,
      agentId: fullAgentId,
      role: this.config.role,
      capabilities: this.config.capabilities,
      timeoutSeconds: this.config.agentTimeoutSeconds,
      metadata: {
        swarmId: this.config.swarmId,
        ...this.config.metadata
      }
    };

    await this.orchestrator.spawnAgent(spawnConfig);
    this.state.agentIds.push(fullAgentId);
    this.state.metrics.activeAgents = this.state.agentIds.length;

    console.log(`[Swarm] Spawned agent: ${fullAgentId}`);
  }

  /**
   * Terminate an idle agent
   */
  private async terminateAgent(agentId: string): Promise<void> {
    await this.orchestrator.terminateAgent(this.config.tenantId, agentId);

    this.state.agentIds = this.state.agentIds.filter(id => id !== agentId);
    this.state.metrics.activeAgents = this.state.agentIds.length;

    console.log(`[Swarm] Terminated agent: ${agentId}`);
  }

  /**
   * Start auto-scaling monitor
   */
  private startScalingMonitor(): void {
    // Check scaling conditions every 30 seconds
    this.scalingTimer = setInterval(async () => {
      await this.evaluateScaling();
    }, 30000);
  }

  /**
   * Stop auto-scaling monitor
   */
  stopScalingMonitor(): void {
    if (this.scalingTimer) {
      clearInterval(this.scalingTimer);
      this.scalingTimer = undefined;
    }
  }

  /**
   * Evaluate if swarm should scale up or down
   */
  private async evaluateScaling(): Promise<void> {
    // Update metrics
    await this.updateMetrics();

    const { metrics } = this.state;

    // Check if we've scaled recently (cooldown period: 2 minutes)
    const cooldownMs = 120000;
    const timeSinceLastScaling =
      Date.now() - new Date(this.state.lastScalingAction).getTime();

    if (timeSinceLastScaling < cooldownMs) {
      return; // Still in cooldown
    }

    // Apply scaling strategy
    switch (this.config.scalingStrategy) {
      case 'queue-depth':
        await this.scaleByQueueDepth();
        break;
      case 'latency':
        await this.scaleByLatency();
        break;
      case 'adaptive':
        await this.scaleAdaptive();
        break;
      case 'fixed':
        // No auto-scaling
        break;
    }
  }

  /**
   * Scale based on queue depth
   */
  private async scaleByQueueDepth(): Promise<void> {
    const { queueDepth, activeAgents } = this.state.metrics;
    const scaleUpThreshold = this.config.scaleUpThreshold || 10; // Messages per agent
    const scaleDownThreshold = this.config.scaleDownThreshold || 2;

    const messagesPerAgent = queueDepth / activeAgents;

    if (messagesPerAgent > scaleUpThreshold && activeAgents < this.config.maxAgents) {
      // Scale up
      const agentsToAdd = Math.min(
        Math.ceil(messagesPerAgent / scaleUpThreshold),
        this.config.maxAgents - activeAgents
      );

      for (let i = 0; i < agentsToAdd; i++) {
        await this.spawnAgent(`auto-${Date.now()}-${i}`);
      }

      this.state.lastScalingAction = new Date().toISOString();
      this.state.scalingReason = `Queue depth: ${queueDepth} (scaled up by ${agentsToAdd})`;

      console.log(`[Swarm] Scaled up: +${agentsToAdd} agents`);
    } else if (
      messagesPerAgent < scaleDownThreshold &&
      activeAgents > this.config.minAgents
    ) {
      // Scale down
      const agentsToRemove = Math.min(
        Math.floor((this.config.minAgents - activeAgents) / 2),
        activeAgents - this.config.minAgents
      );

      // Terminate most recently spawned agents
      const agentsToTerminate = this.state.agentIds
        .filter(id => id.includes('auto-'))
        .slice(-agentsToRemove);

      for (const agentId of agentsToTerminate) {
        await this.terminateAgent(agentId);
      }

      this.state.lastScalingAction = new Date().toISOString();
      this.state.scalingReason = `Queue depth: ${queueDepth} (scaled down by ${agentsToRemove})`;

      console.log(`[Swarm] Scaled down: -${agentsToRemove} agents`);
    }
  }

  /**
   * Scale based on task latency
   */
  private async scaleByLatency(): Promise<void> {
    const { avgLatencyMs, activeAgents } = this.state.metrics;
    const maxLatencyMs = this.config.scaleUpThreshold || 5000; // 5 seconds
    const minLatencyMs = this.config.scaleDownThreshold || 1000; // 1 second

    if (avgLatencyMs > maxLatencyMs && activeAgents < this.config.maxAgents) {
      // Scale up
      await this.spawnAgent(`auto-${Date.now()}`);
      this.state.lastScalingAction = new Date().toISOString();
      this.state.scalingReason = `High latency: ${avgLatencyMs}ms`;

      console.log('[Swarm] Scaled up: latency-based');
    } else if (
      avgLatencyMs < minLatencyMs &&
      activeAgents > this.config.minAgents
    ) {
      // Scale down
      const agentToRemove = this.state.agentIds.find(id => id.includes('auto-'));
      if (agentToRemove) {
        await this.terminateAgent(agentToRemove);
        this.state.lastScalingAction = new Date().toISOString();
        this.state.scalingReason = `Low latency: ${avgLatencyMs}ms`;

        console.log('[Swarm] Scaled down: latency-based');
      }
    }
  }

  /**
   * Adaptive scaling using ML predictions
   * (Placeholder for future ML-based scaling)
   */
  private async scaleAdaptive(): Promise<void> {
    // TODO: Implement ML-based scaling
    // - Predict future workload based on historical patterns
    // - Proactively scale before load spikes
    // - Use reinforcement learning to optimize scaling decisions

    console.log('[Swarm] Adaptive scaling not yet implemented');
  }

  /**
   * Update swarm metrics
   * (Placeholder - will query SQS and DynamoDB)
   */
  private async updateMetrics(): Promise<void> {
    // TODO: Query SQS for queue depth
    // TODO: Query DynamoDB for task latency stats
    // TODO: Calculate tasks per minute

    // Mock metrics for now
    this.state.metrics = {
      swarmId: this.config.swarmId,
      activeAgents: this.state.agentIds.length,
      queueDepth: Math.floor(Math.random() * 50), // Mock
      avgLatencyMs: Math.floor(Math.random() * 3000), // Mock
      tasksPerMinute: Math.floor(Math.random() * 100), // Mock
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get current swarm state
   */
  getState(): SwarmState {
    return this.state;
  }

  /**
   * Shutdown swarm (terminate all agents)
   */
  async shutdown(): Promise<void> {
    console.log(`[Swarm] Shutting down ${this.config.swarmId}`);

    this.stopScalingMonitor();

    // Terminate all agents
    for (const agentId of this.state.agentIds) {
      await this.terminateAgent(agentId);
    }

    console.log('[Swarm] Shutdown complete');
  }
}

/**
 * Create and initialize a swarm
 */
export async function createSwarm(
  orchestrator: AgentOrchestrator,
  config: SwarmConfig
): Promise<AgentSwarm> {
  const swarm = new AgentSwarm(orchestrator, config);
  await swarm.initialize();
  return swarm;
}

/**
 * Swarm presets for common use cases
 */
export const SwarmPresets = {
  /**
   * Research swarm for document analysis
   */
  research: (tenantId: string, swarmId: string): SwarmConfig => ({
    tenantId,
    swarmId,
    role: 'specialist',
    capabilities: ['document-analysis', 'web-search', 'summarization'],
    scalingStrategy: 'queue-depth',
    minAgents: 2,
    maxAgents: 10,
    scaleUpThreshold: 5,
    scaleDownThreshold: 1
  }),

  /**
   * Monitoring swarm for log analysis
   */
  monitoring: (tenantId: string, swarmId: string): SwarmConfig => ({
    tenantId,
    swarmId,
    role: 'monitor',
    capabilities: ['log-analysis', 'metric-collection', 'anomaly-detection'],
    scalingStrategy: 'latency',
    minAgents: 1,
    maxAgents: 5,
    scaleUpThreshold: 3000, // 3s latency threshold
    scaleDownThreshold: 500 // 0.5s latency threshold
  }),

  /**
   * Worker swarm for task processing
   */
  worker: (tenantId: string, swarmId: string): SwarmConfig => ({
    tenantId,
    swarmId,
    role: 'worker',
    capabilities: ['task-execution', 'data-processing'],
    scalingStrategy: 'queue-depth',
    minAgents: 3,
    maxAgents: 20,
    scaleUpThreshold: 10,
    scaleDownThreshold: 2
  })
};
