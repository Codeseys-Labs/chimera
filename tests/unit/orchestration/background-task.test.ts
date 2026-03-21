/**
 * Tests for BackgroundTaskManager
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  BackgroundTaskManager,
  createBackgroundTaskManager,
  startBackgroundTaskTool
} from '../../../packages/core/src/orchestration/background-task';
import { createOrchestrator } from '../../../packages/core/src/orchestration/orchestrator';

describe('BackgroundTaskManager', () => {
  let manager: BackgroundTaskManager;
  let orchestrator: ReturnType<typeof createOrchestrator>;

  beforeEach(async () => {
    orchestrator = createOrchestrator({
      region: 'us-east-1',
      eventBusName: 'test-event-bus',
      agentTableName: 'test-agents',
      defaultQueuePrefix: 'test-queue'
    });

    // Spawn test agents
    await orchestrator.spawnAgent({
      tenantId: 'tenant-123',
      agentId: 'worker-001',
      role: 'worker',
      capabilities: []
    });

    await orchestrator.spawnAgent({
      tenantId: 'tenant-123',
      agentId: 'worker-002',
      role: 'worker',
      capabilities: []
    });

    await orchestrator.spawnAgent({
      tenantId: 'tenant-456',
      agentId: 'worker-001',
      role: 'worker',
      capabilities: []
    });

    manager = createBackgroundTaskManager(orchestrator);
  });

  describe('submitTask', () => {
    it('should submit background task and return task ID', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Analyze document XYZ',
        context: { documentId: 'doc-123' }
      });

      expect(result.taskId).toBeTruthy();
      expect(result.taskId).toMatch(/^bg-task-/);
      expect(result.status).toBe('queued');
      expect(result.queuedAt).toBeTruthy();
    });

    it('should store task metadata', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Test task',
        context: {}
      });

      const task = manager.getTask(result.taskId);
      expect(task).toBeDefined();
      expect(task?.status).toBe('queued');
      expect(task?.sourceAgentId).toBe('agent-001');
      expect(task?.targetAgentId).toBe('worker-001');
    });

    it('should use default priority when not specified', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Test task',
        context: {}
      });

      const task = manager.getTask(result.taskId);
      expect(task?.priority).toBe('normal');
    });

    it('should accept custom priority', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Urgent task',
        context: {},
        priority: 'urgent'
      });

      const task = manager.getTask(result.taskId);
      expect(task?.priority).toBe('urgent');
    });

    it('should accept custom timeout', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Long task',
        context: {},
        timeoutSeconds: 600
      });

      const task = manager.getTask(result.taskId);
      expect(task?.timeoutSeconds).toBe(600);
    });
  });

  describe('getTask', () => {
    it('should return task by ID', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Test task',
        context: {}
      });

      const task = manager.getTask(result.taskId);
      expect(task).toBeDefined();
      expect(task?.taskId).toBe(result.taskId);
    });

    it('should return undefined for non-existent task', () => {
      const task = manager.getTask('non-existent');
      expect(task).toBeUndefined();
    });
  });

  describe('updateTaskStatus', () => {
    it('should update task status to running', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Test task',
        context: {}
      });

      manager.updateTaskStatus(result.taskId, 'running');

      const task = manager.getTask(result.taskId);
      expect(task?.status).toBe('running');
      expect(task?.startedAt).toBeTruthy();
    });

    it('should update task status to completed with result', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Test task',
        context: {}
      });

      const taskResult = { success: true, data: 'result' };
      manager.updateTaskStatus(result.taskId, 'completed', taskResult);

      const task = manager.getTask(result.taskId);
      expect(task?.status).toBe('completed');
      expect(task?.completedAt).toBeTruthy();
      expect(task?.result).toEqual(taskResult);
    });

    it('should update task status to failed with error', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Test task',
        context: {}
      });

      const error = { code: 'TASK_ERROR', message: 'Task failed' };
      manager.updateTaskStatus(result.taskId, 'failed', undefined, error);

      const task = manager.getTask(result.taskId);
      expect(task?.status).toBe('failed');
      expect(task?.completedAt).toBeTruthy();
      expect(task?.error).toEqual(error);
    });

    it('should throw error for non-existent task', () => {
      expect(() => {
        manager.updateTaskStatus('non-existent', 'running');
      }).toThrow('Task not found: non-existent');
    });
  });

  describe('listTasks', () => {
    beforeEach(async () => {
      // Submit multiple tasks
      await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Task 1',
        context: {}
      });

      await manager.submitTask({
        sourceAgentId: 'agent-002',
        targetAgentId: 'worker-002',
        tenantId: 'tenant-123',
        instruction: 'Task 2',
        context: {}
      });

      const result3 = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-456',
        instruction: 'Task 3',
        context: {}
      });

      // Update one task to completed
      manager.updateTaskStatus(result3.taskId, 'completed', { success: true });
    });

    it('should list all tasks for tenant', () => {
      const tasks = manager.listTasks('tenant-123');
      expect(tasks.length).toBe(2);
    });

    it('should filter by source agent', () => {
      const tasks = manager.listTasks('tenant-123', { sourceAgentId: 'agent-001' });
      expect(tasks.length).toBe(1);
      expect(tasks[0].sourceAgentId).toBe('agent-001');
    });

    it('should filter by target agent', () => {
      const tasks = manager.listTasks('tenant-123', { targetAgentId: 'worker-002' });
      expect(tasks.length).toBe(1);
      expect(tasks[0].targetAgentId).toBe('worker-002');
    });

    it('should filter by status', () => {
      const tasks = manager.listTasks('tenant-456', { status: 'completed' });
      expect(tasks.length).toBe(1);
      expect(tasks[0].status).toBe('completed');
    });

    it('should sort tasks by queued time (newest first)', () => {
      const tasks = manager.listTasks('tenant-123');
      const timestamps = tasks.map(t => new Date(t.queuedAt).getTime());

      // Check descending order
      for (let i = 0; i < timestamps.length - 1; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1]);
      }
    });
  });

  describe('cancelTask', () => {
    it('should cancel queued task', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Test task',
        context: {}
      });

      await manager.cancelTask(result.taskId);

      const task = manager.getTask(result.taskId);
      expect(task?.status).toBe('failed');
      expect(task?.error?.code).toBe('CANCELLED');
    });

    it('should throw error when cancelling completed task', async () => {
      const result = await manager.submitTask({
        sourceAgentId: 'agent-001',
        targetAgentId: 'worker-001',
        tenantId: 'tenant-123',
        instruction: 'Test task',
        context: {}
      });

      manager.updateTaskStatus(result.taskId, 'completed', { success: true });

      await expect(
        manager.cancelTask(result.taskId)
      ).rejects.toThrow('Cannot cancel completed task');
    });

    it('should throw error for non-existent task', async () => {
      await expect(
        manager.cancelTask('non-existent')
      ).rejects.toThrow('Task not found: non-existent');
    });
  });

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
});
