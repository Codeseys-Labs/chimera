/**
 * Tests for WorkflowEngine
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  WorkflowEngine,
  createWorkflowEngine,
  WorkflowPatterns,
  type WorkflowDefinition,
  type WorkflowStep
} from '../../../packages/core/src/orchestration/workflow';
import { createOrchestrator } from '../../../packages/core/src/orchestration/orchestrator';

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    const orchestrator = createOrchestrator({
      region: 'us-east-1',
      eventBusName: 'test-event-bus',
      agentTableName: 'test-agents',
      defaultQueuePrefix: 'test-queue'
    });

    engine = createWorkflowEngine(orchestrator);
  });

  describe('registerWorkflow', () => {
    it('should register workflow definition', () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'wf-001',
        name: 'Simple Workflow',
        startAt: 'step-1',
        steps: {
          'step-1': {
            stepId: 'step-1',
            type: 'task',
            agentId: 'agent-001',
            instruction: 'Process data',
            end: true
          }
        }
      };

      expect(() => {
        engine.registerWorkflow(workflow);
      }).not.toThrow();
    });

    it('should allow retrieving registered workflow by execution', async () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'wf-002',
        name: 'Test Workflow',
        startAt: 'step-1',
        steps: {
          'step-1': {
            stepId: 'step-1',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      const executionId = await engine.startExecution(
        'wf-002',
        'tenant-123',
        'user-001',
        {}
      );

      // Wait for completion
      await new Promise(resolve => setTimeout(resolve, 1500));

      const execution = engine.getExecution(executionId);
      expect(execution).toBeDefined();
      expect(execution?.workflowId).toBe('wf-002');
    });
  });

  describe('startExecution', () => {
    it('should start workflow execution', async () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'wf-003',
        name: 'Quick Workflow',
        startAt: 'step-1',
        steps: {
          'step-1': {
            stepId: 'step-1',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      const executionId = await engine.startExecution(
        'wf-003',
        'tenant-123',
        'user-001',
        { inputData: 'test' }
      );

      expect(executionId).toBeTruthy();
      expect(executionId).toMatch(/^exec-/);
    });

    it('should throw error for non-existent workflow', async () => {
      await expect(
        engine.startExecution('non-existent', 'tenant-123', 'user-001', {})
      ).rejects.toThrow('Workflow not found: non-existent');
    });

    it('should initialize execution with correct metadata', async () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'wf-004',
        name: 'Metadata Test',
        startAt: 'step-1',
        steps: {
          'step-1': {
            stepId: 'step-1',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      const executionId = await engine.startExecution(
        'wf-004',
        'tenant-123',
        'user-456',
        { key: 'value' }
      );

      const execution = engine.getExecution(executionId);
      expect(execution?.tenantId).toBe('tenant-123');
      expect(execution?.userId).toBe('user-456');
      expect(execution?.input).toEqual({ key: 'value' });
      expect(execution?.status).toBe('running');
    });
  });

  describe('workflow execution', () => {
    it('should complete single-step workflow', async () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'wf-005',
        name: 'Single Step',
        startAt: 'step-1',
        steps: {
          'step-1': {
            stepId: 'step-1',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      const executionId = await engine.startExecution(
        'wf-005',
        'tenant-123',
        'user-001',
        {}
      );

      // Wait for completion
      await new Promise(resolve => setTimeout(resolve, 1500));

      const execution = engine.getExecution(executionId);
      expect(execution?.status).toBe('succeeded');
      expect(execution?.completedAt).toBeTruthy();
    });

    it('should execute sequential steps', async () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'wf-006',
        name: 'Sequential Steps',
        startAt: 'step-1',
        steps: {
          'step-1': {
            stepId: 'step-1',
            type: 'wait',
            timeoutSeconds: 1,
            next: 'step-2'
          },
          'step-2': {
            stepId: 'step-2',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      const executionId = await engine.startExecution(
        'wf-006',
        'tenant-123',
        'user-001',
        {}
      );

      // Wait for completion (2 steps × 1 second each)
      await new Promise(resolve => setTimeout(resolve, 2500));

      const execution = engine.getExecution(executionId);
      expect(execution?.status).toBe('succeeded');
      expect(execution?.stepResults).toHaveProperty('step-1');
      expect(execution?.stepResults).toHaveProperty('step-2');
    });

    it('should store step results', async () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'wf-007',
        name: 'Step Results',
        startAt: 'step-1',
        steps: {
          'step-1': {
            stepId: 'step-1',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      const executionId = await engine.startExecution(
        'wf-007',
        'tenant-123',
        'user-001',
        {}
      );

      await new Promise(resolve => setTimeout(resolve, 1500));

      const execution = engine.getExecution(executionId);
      expect(execution?.stepResults['step-1']).toBeDefined();
      expect(execution?.stepResults['step-1']).toHaveProperty('waited');
    });
  });

  describe('getExecution', () => {
    it('should return execution by ID', async () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'wf-008',
        name: 'Get Execution Test',
        startAt: 'step-1',
        steps: {
          'step-1': {
            stepId: 'step-1',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      const executionId = await engine.startExecution(
        'wf-008',
        'tenant-123',
        'user-001',
        {}
      );

      const execution = engine.getExecution(executionId);
      expect(execution).toBeDefined();
      expect(execution?.executionId).toBe(executionId);
    });

    it('should return undefined for non-existent execution', () => {
      const execution = engine.getExecution('non-existent');
      expect(execution).toBeUndefined();
    });
  });

  describe('listExecutions', () => {
    beforeEach(async () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'wf-list-test',
        name: 'List Test',
        startAt: 'step-1',
        steps: {
          'step-1': {
            stepId: 'step-1',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      // Start multiple executions
      await engine.startExecution('wf-list-test', 'tenant-123', 'user-001', {});
      await engine.startExecution('wf-list-test', 'tenant-123', 'user-002', {});
      await engine.startExecution('wf-list-test', 'tenant-456', 'user-003', {});
    });

    it('should list all executions', () => {
      const executions = engine.listExecutions();
      expect(executions.length).toBeGreaterThanOrEqual(3);
    });

    it('should filter by tenant ID', () => {
      const executions = engine.listExecutions({ tenantId: 'tenant-123' });
      expect(executions.length).toBe(2);
      expect(executions.every(e => e.tenantId === 'tenant-123')).toBe(true);
    });

    it('should filter by workflow ID', () => {
      const executions = engine.listExecutions({ workflowId: 'wf-list-test' });
      expect(executions.length).toBeGreaterThanOrEqual(3);
      expect(executions.every(e => e.workflowId === 'wf-list-test')).toBe(true);
    });

    it('should filter by status', async () => {
      // Wait for executions to complete
      await new Promise(resolve => setTimeout(resolve, 1500));

      const executions = engine.listExecutions({ status: 'succeeded' });
      expect(executions.length).toBeGreaterThan(0);
      expect(executions.every(e => e.status === 'succeeded')).toBe(true);
    });
  });

  describe('WorkflowPatterns', () => {
    it('should create sequential workflow pattern', () => {
      const workflow = WorkflowPatterns.sequential(
        'seq-wf',
        ['agent-001', 'agent-002', 'agent-003'],
        ['Task 1', 'Task 2', 'Task 3']
      );

      expect(workflow.workflowId).toBe('seq-wf');
      expect(workflow.name).toBe('Sequential Agent Chain');
      expect(workflow.startAt).toBe('step-1');
      expect(Object.keys(workflow.steps).length).toBe(3);
      expect(workflow.steps['step-1'].next).toBe('step-2');
      expect(workflow.steps['step-2'].next).toBe('step-3');
      expect(workflow.steps['step-3'].end).toBe(true);
    });

    it('should create parallel workflow pattern', () => {
      const workflow = WorkflowPatterns.parallel(
        'par-wf',
        ['agent-001', 'agent-002', 'agent-003'],
        ['Task 1', 'Task 2', 'Task 3']
      );

      expect(workflow.workflowId).toBe('par-wf');
      expect(workflow.name).toBe('Parallel Agent Execution');
      expect(workflow.startAt).toBe('parallel-root');
      expect(workflow.steps['parallel-root'].type).toBe('parallel');
      expect(workflow.steps['parallel-root'].parallelSteps).toHaveLength(3);
      expect(workflow.steps['parallel-root'].end).toBe(true);
    });

    it('should assign agent IDs correctly in sequential pattern', () => {
      const workflow = WorkflowPatterns.sequential(
        'test',
        ['A', 'B', 'C'],
        ['T1', 'T2', 'T3']
      );

      expect(workflow.steps['step-1'].agentId).toBe('A');
      expect(workflow.steps['step-2'].agentId).toBe('B');
      expect(workflow.steps['step-3'].agentId).toBe('C');
    });

    it('should assign instructions correctly in parallel pattern', () => {
      const workflow = WorkflowPatterns.parallel(
        'test',
        ['X', 'Y', 'Z'],
        ['Inst1', 'Inst2', 'Inst3']
      );

      const parallelSteps = workflow.steps['parallel-root'].parallelSteps!;
      expect(parallelSteps[0].instruction).toBe('Inst1');
      expect(parallelSteps[1].instruction).toBe('Inst2');
      expect(parallelSteps[2].instruction).toBe('Inst3');
    });
  });

  describe('workflow step types', () => {
    it('should handle wait step', async () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'wait-test',
        name: 'Wait Test',
        startAt: 'wait-1',
        steps: {
          'wait-1': {
            stepId: 'wait-1',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      const executionId = await engine.startExecution(
        'wait-test',
        'tenant-123',
        'user-001',
        {}
      );

      await new Promise(resolve => setTimeout(resolve, 1500));

      const execution = engine.getExecution(executionId);
      expect(execution?.status).toBe('succeeded');
    });

    it('should handle task step', async () => {
      const workflow: WorkflowDefinition = {
        workflowId: 'task-test',
        name: 'Task Test',
        startAt: 'task-1',
        steps: {
          'task-1': {
            stepId: 'task-1',
            type: 'task',
            agentId: 'agent-001',
            instruction: 'Process data',
            timeoutSeconds: 10,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      const executionId = await engine.startExecution(
        'task-test',
        'tenant-123',
        'user-001',
        {}
      );

      // Wait a bit for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      const execution = engine.getExecution(executionId);
      expect(execution).toBeDefined();
    });

    it('should fail choice step because JSONPath evaluation is not implemented', async () => {
      // Wave-14 audit M2 — choice step throws `not implemented` rather
      // than silently routing every execution down the first branch.
      const workflow: WorkflowDefinition = {
        workflowId: 'choice-test',
        name: 'Choice Test',
        startAt: 'choice-1',
        steps: {
          'choice-1': {
            stepId: 'choice-1',
            type: 'choice',
            choices: [
              { condition: '$.value > 10', next: 'step-high' },
              { condition: '$.value <= 10', next: 'step-low' }
            ],
            next: 'step-low'
          },
          'step-low': {
            stepId: 'step-low',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          },
          'step-high': {
            stepId: 'step-high',
            type: 'wait',
            timeoutSeconds: 1,
            end: true
          }
        }
      };

      engine.registerWorkflow(workflow);

      const executionId = await engine.startExecution(
        'choice-test',
        'tenant-123',
        'user-001',
        { value: 5 }
      );

      await new Promise(resolve => setTimeout(resolve, 300));

      const execution = engine.getExecution(executionId);
      expect(execution?.status).toBe('failed');
      expect(execution?.error?.message).toContain('not implemented');
    });
  });
});
