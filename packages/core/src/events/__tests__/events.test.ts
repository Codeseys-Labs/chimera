/**
 * Events module tests
 *
 * Tests for event types and enums
 * Note: ChimeraEventBus and pattern helpers require @aws-sdk/client-eventbridge
 * which is a peer dependency and not available in test environment
 */

import { describe, it, expect } from 'bun:test';
import { EventSource, EventDetailType, AgentStatus, TaskStatus } from '../event-types';
import type {
  AgentCreatedDetail,
  TaskCreatedDetail,
  ChimeraEvent,
} from '../event-types';

describe('Event Types and Enums', () => {
  describe('EventSource', () => {
    it('should define all event sources', () => {
      expect(EventSource.AGENTS).toBe('chimera.agents');
      expect(EventSource.TASKS).toBe('chimera.tasks');
      expect(EventSource.COORDINATION).toBe('chimera.coordination');
      expect(EventSource.CRON).toBe('chimera.cron');
      expect(EventSource.A2A).toBe('chimera.a2a');
      expect(EventSource.SYSTEM).toBe('chimera.system');
    });
  });

  describe('EventDetailType', () => {
    it('should define agent lifecycle event types', () => {
      expect(EventDetailType.AGENT_CREATED).toBe('Agent Created');
      expect(EventDetailType.AGENT_STARTED).toBe('Agent Started');
      expect(EventDetailType.AGENT_COMPLETED).toBe('Agent Completed');
      expect(EventDetailType.AGENT_FAILED).toBe('Agent Failed');
      expect(EventDetailType.AGENT_CANCELLED).toBe('Agent Cancelled');
    });

    it('should define task lifecycle event types', () => {
      expect(EventDetailType.TASK_CREATED).toBe('Task Created');
      expect(EventDetailType.TASK_ASSIGNED).toBe('Task Assigned');
      expect(EventDetailType.TASK_RUNNING).toBe('Task Running');
      expect(EventDetailType.TASK_COMPLETED).toBe('Task Completed');
      expect(EventDetailType.TASK_FAILED).toBe('Task Failed');
      expect(EventDetailType.TASK_CANCELLED).toBe('Task Cancelled');
    });

    it('should define coordination event types', () => {
      expect(EventDetailType.AGENT_DELEGATION).toBe('Agent Delegation');
      expect(EventDetailType.AGENT_ARTIFACT_EXCHANGE).toBe('Agent Artifact Exchange');
      expect(EventDetailType.SWARM_COORDINATION).toBe('Swarm Coordination');
      expect(EventDetailType.GRAPH_WORKFLOW).toBe('Graph Workflow');
    });

    it('should define cron event types', () => {
      expect(EventDetailType.CRON_SCHEDULED).toBe('Cron Scheduled');
      expect(EventDetailType.CRON_TRIGGERED).toBe('Cron Triggered');
      expect(EventDetailType.CRON_COMPLETED).toBe('Cron Completed');
    });

    it('should define A2A protocol event types', () => {
      expect(EventDetailType.A2A_TASK_CREATED).toBe('A2A Task Created');
      expect(EventDetailType.A2A_TASK_COMPLETED).toBe('A2A Task Completed');
      expect(EventDetailType.A2A_AGENT_DISCOVERED).toBe('A2A Agent Discovered');
    });

    it('should define system event types', () => {
      expect(EventDetailType.SYSTEM_ERROR).toBe('System Error');
      expect(EventDetailType.SYSTEM_MAINTENANCE).toBe('System Maintenance');
    });
  });

  describe('AgentStatus', () => {
    it('should define agent status values', () => {
      expect(AgentStatus.CREATED).toBe('created');
      expect(AgentStatus.RUNNING).toBe('running');
      expect(AgentStatus.COMPLETED).toBe('completed');
      expect(AgentStatus.FAILED).toBe('failed');
      expect(AgentStatus.CANCELLED).toBe('cancelled');
    });
  });

  describe('TaskStatus', () => {
    it('should define task status values', () => {
      expect(TaskStatus.CREATED).toBe('created');
      expect(TaskStatus.ASSIGNED).toBe('assigned');
      expect(TaskStatus.RUNNING).toBe('running');
      expect(TaskStatus.COMPLETED).toBe('completed');
      expect(TaskStatus.FAILED).toBe('failed');
      expect(TaskStatus.CANCELLED).toBe('cancelled');
    });
  });

  describe('Event Detail Interfaces', () => {
    it('should accept valid AgentCreatedDetail', () => {
      const detail: AgentCreatedDetail = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        agentName: 'TestAgent',
        agentType: 'task-executor',
        modelId: 'claude-opus-4',
        timestamp: new Date().toISOString(),
      };

      expect(detail.tenantId).toBe('tenant-123');
      expect(detail.agentId).toBe('agent-456');
      expect(detail.agentName).toBe('TestAgent');
    });

    it('should accept valid TaskCreatedDetail', () => {
      const detail: TaskCreatedDetail = {
        tenantId: 'tenant-123',
        taskId: 'task-789',
        taskName: 'ProcessData',
        taskType: 'batch-processing',
        priority: 'high',
        assignedAgentId: 'agent-456',
        timestamp: new Date().toISOString(),
      };

      expect(detail.tenantId).toBe('tenant-123');
      expect(detail.taskId).toBe('task-789');
      expect(detail.priority).toBe('high');
    });

    it('should construct valid ChimeraEvent structure', () => {
      const agentDetail: AgentCreatedDetail = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        agentName: 'TestAgent',
        agentType: 'task-executor',
        modelId: 'claude-opus-4',
        timestamp: new Date().toISOString(),
      };

      const event: ChimeraEvent<AgentCreatedDetail> = {
        source: EventSource.AGENTS,
        'detail-type': EventDetailType.AGENT_CREATED,
        detail: agentDetail,
        time: new Date().toISOString(),
        region: 'us-east-1',
        account: '123456789012',
      };

      expect(event.source).toBe(EventSource.AGENTS);
      expect(event['detail-type']).toBe(EventDetailType.AGENT_CREATED);
      expect(event.detail.tenantId).toBe('tenant-123');
    });
  });
});
