/**
 * Tests for AgentOrchestrator
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  AgentOrchestrator,
  createOrchestrator,
  type SpawnAgentConfig,
  type TaskDelegation,
  type AgentStatus
} from '../../../packages/core/src/orchestration/orchestrator';

describe('AgentOrchestrator', () => {
  let orchestrator: AgentOrchestrator;

  beforeEach(() => {
    orchestrator = createOrchestrator({
      region: 'us-east-1',
      eventBusName: 'test-event-bus',
      agentTableName: 'test-agents',
      defaultQueuePrefix: 'test-queue',
      maxConcurrentAgents: 10
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
