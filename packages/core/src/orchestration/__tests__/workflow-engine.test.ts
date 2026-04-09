/**
 * Comprehensive unit tests for WorkflowEngine
 *
 * Tests workflow registration, execution lifecycle, step types (task, parallel,
 * choice, wait, map), error handling, execution listing/filtering, and patterns.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  WorkflowEngine,
  createWorkflowEngine,
  WorkflowPatterns,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowExecution,
} from '../workflow';
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
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowEngine', () => {
  let orchestrator: AgentOrchestrator;
  let engine: WorkflowEngine;

  beforeEach(() => {
    orchestrator = createTestOrchestrator();
    engine = new WorkflowEngine(orchestrator);
  });

  // =========================================================================
  // registerWorkflow
  // =========================================================================

  describe('registerWorkflow', () => {
    it('should register a workflow definition', () => {
      const wf: WorkflowDefinition = {
        workflowId: 'wf-001',
        name: 'Test Workflow',
        startAt: 'step-1',
        steps: {
          'step-1': { stepId: 'step-1', type: 'wait', timeoutSeconds: 1, end: true },
        },
      };

      expect(() => engine.registerWorkflow(wf)).not.toThrow();
    });

    it('should overwrite existing workflow with same ID', () => {
      const wf1: WorkflowDefinition = {
        workflowId: 'wf-dup',
        name: 'Version 1',
        startAt: 'step-1',
        steps: { 'step-1': { stepId: 'step-1', type: 'wait', timeoutSeconds: 1, end: true } },
      };

      const wf2: WorkflowDefinition = {
        workflowId: 'wf-dup',
        name: 'Version 2',
        startAt: 'step-1',
        steps: { 'step-1': { stepId: 'step-1', type: 'wait', timeoutSeconds: 1, end: true } },
      };

      engine.registerWorkflow(wf1);
      engine.registerWorkflow(wf2);

      // No throw — verify by starting execution (uses the last registered version)
      expect(engine.startExecution('wf-dup', 'tenant', 'user', {})).resolves.toBeTruthy();
    });
  });

  // =========================================================================
  // startExecution
  // =========================================================================

  describe('startExecution', () => {
    it('should return execution ID matching exec- prefix', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-start',
        name: 'Start Test',
        startAt: 'step-1',
        steps: { 'step-1': { stepId: 'step-1', type: 'wait', timeoutSeconds: 1, end: true } },
      });

      const execId = await engine.startExecution('wf-start', 'tenant-123', 'user-001', {});
      expect(execId).toMatch(/^exec-/);
    });

    it('should throw for non-existent workflow', async () => {
      await expect(
        engine.startExecution('nonexistent', 'tenant-123', 'user-001', {})
      ).rejects.toThrow('Workflow not found: nonexistent');
    });

    it('should initialize execution with correct metadata', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-meta',
        name: 'Meta Test',
        startAt: 'step-1',
        steps: { 'step-1': { stepId: 'step-1', type: 'wait', timeoutSeconds: 1, end: true } },
      });

      const execId = await engine.startExecution('wf-meta', 'tenant-123', 'user-789', {
        key: 'value',
      });

      const execution = engine.getExecution(execId);
      expect(execution).toBeDefined();
      expect(execution!.tenantId).toBe('tenant-123');
      expect(execution!.userId).toBe('user-789');
      expect(execution!.input).toEqual({ key: 'value' });
      expect(execution!.status).toBe('running');
      expect(execution!.startedAt).toBeTruthy();
      expect(execution!.currentStep).toBe('step-1');
    });

    it('should set currentStep to startAt value', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-current',
        name: 'Current Step',
        startAt: 'my-first-step',
        steps: {
          'my-first-step': {
            stepId: 'my-first-step',
            type: 'wait',
            timeoutSeconds: 1,
            end: true,
          },
        },
      });

      const execId = await engine.startExecution('wf-current', 't', 'u', {});
      expect(engine.getExecution(execId)!.currentStep).toBe('my-first-step');
    });
  });

  // =========================================================================
  // Workflow execution — wait steps (fast, safe to await)
  // =========================================================================

  describe('executeWorkflow — wait steps', () => {
    it('should complete single-step wait workflow', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-wait-single',
        name: 'Single Wait',
        startAt: 'step-1',
        steps: {
          'step-1': { stepId: 'step-1', type: 'wait', timeoutSeconds: 1, end: true },
        },
      });

      const execId = await engine.startExecution('wf-wait-single', 'tenant', 'user', {});
      await new Promise((r) => setTimeout(r, 1500));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('succeeded');
      expect(execution.completedAt).toBeTruthy();
      expect(execution.output).toEqual({ waited: 1 });
    });

    it('should execute sequential wait steps in order', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-seq',
        name: 'Sequential',
        startAt: 'step-1',
        steps: {
          'step-1': { stepId: 'step-1', type: 'wait', timeoutSeconds: 1, next: 'step-2' },
          'step-2': { stepId: 'step-2', type: 'wait', timeoutSeconds: 1, end: true },
        },
      });

      const execId = await engine.startExecution('wf-seq', 'tenant', 'user', {});
      await new Promise((r) => setTimeout(r, 2500));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('succeeded');
      expect(execution.stepResults['step-1']).toEqual({ waited: 1 });
      expect(execution.stepResults['step-2']).toEqual({ waited: 1 });
    });

    it('should default wait to 1 second when timeoutSeconds not set', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-default-wait',
        name: 'Default Wait',
        startAt: 'step-1',
        steps: {
          'step-1': { stepId: 'step-1', type: 'wait', end: true },
        },
      });

      const execId = await engine.startExecution('wf-default-wait', 't', 'u', {});
      await new Promise((r) => setTimeout(r, 1500));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('succeeded');
      expect(execution.stepResults['step-1']).toEqual({ waited: 1 });
    });
  });

  // =========================================================================
  // Parallel steps
  // =========================================================================

  describe('executeWorkflow — parallel steps', () => {
    it('should execute parallel sub-steps concurrently and combine results', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-par',
        name: 'Parallel Test',
        startAt: 'parallel-root',
        steps: {
          'parallel-root': {
            stepId: 'parallel-root',
            type: 'parallel',
            parallelSteps: [
              { stepId: 'par-1', type: 'wait', timeoutSeconds: 1 },
              { stepId: 'par-2', type: 'wait', timeoutSeconds: 1 },
            ],
            end: true,
          },
        },
      });

      const execId = await engine.startExecution('wf-par', 'tenant', 'user', {});
      // Parallel: both run at same time (~1s total rather than 2s)
      await new Promise((r) => setTimeout(r, 1500));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('succeeded');
      expect(execution.output).toHaveProperty('parallelResults');
      const results = execution.output!['parallelResults'] as Array<unknown>;
      expect(results).toHaveLength(2);
    });

    it('should fail if parallelSteps is empty', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-par-empty',
        name: 'Empty Parallel',
        startAt: 'parallel-root',
        steps: {
          'parallel-root': {
            stepId: 'parallel-root',
            type: 'parallel',
            parallelSteps: [],
            end: true,
          },
        },
      });

      const execId = await engine.startExecution('wf-par-empty', 'tenant', 'user', {});
      await new Promise((r) => setTimeout(r, 200));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('failed');
      expect(execution.error?.message).toContain('Parallel step requires parallelSteps');
    });

    it('should fail if parallelSteps is undefined', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-par-undef',
        name: 'Undefined Parallel',
        startAt: 'parallel-root',
        steps: {
          'parallel-root': {
            stepId: 'parallel-root',
            type: 'parallel',
            end: true,
          },
        },
      });

      const execId = await engine.startExecution('wf-par-undef', 'tenant', 'user', {});
      await new Promise((r) => setTimeout(r, 200));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('failed');
    });
  });

  // =========================================================================
  // Choice steps
  // =========================================================================

  describe('executeWorkflow — choice steps', () => {
    it('should execute choice step and follow first branch', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-choice',
        name: 'Choice Test',
        startAt: 'choice-1',
        steps: {
          'choice-1': {
            stepId: 'choice-1',
            type: 'choice',
            choices: [
              { condition: '$.value > 10', next: 'step-high' },
              { condition: '$.value <= 10', next: 'step-low' },
            ],
            next: 'step-low',
          },
          'step-low': { stepId: 'step-low', type: 'wait', timeoutSeconds: 1, end: true },
          'step-high': { stepId: 'step-high', type: 'wait', timeoutSeconds: 1, end: true },
        },
      });

      const execId = await engine.startExecution('wf-choice', 'tenant', 'user', { value: 5 });
      await new Promise((r) => setTimeout(r, 1500));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('succeeded');
      // Choice step returns first choice and then follows next step
      expect(execution.stepResults['choice-1']).toBeDefined();
    });

    it('should fail if choices array is empty', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-choice-empty',
        name: 'Empty Choice',
        startAt: 'choice-1',
        steps: {
          'choice-1': {
            stepId: 'choice-1',
            type: 'choice',
            choices: [],
            next: 'fallback',
          },
          fallback: { stepId: 'fallback', type: 'wait', timeoutSeconds: 1, end: true },
        },
      });

      const execId = await engine.startExecution('wf-choice-empty', 'tenant', 'user', {});
      await new Promise((r) => setTimeout(r, 200));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('failed');
      expect(execution.error?.message).toContain('Choice step requires choices');
    });
  });

  // =========================================================================
  // Task steps (delegates to orchestrator)
  // =========================================================================

  describe('executeWorkflow — task steps', () => {
    it('should execute task step by delegating to orchestrator', async () => {
      // First spawn the target agent so delegation works
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: [],
      });

      engine.registerWorkflow({
        workflowId: 'wf-task',
        name: 'Task Test',
        startAt: 'task-1',
        steps: {
          'task-1': {
            stepId: 'task-1',
            type: 'task',
            agentId: 'agent-001',
            instruction: 'Process data',
            timeoutSeconds: 10,
            end: true,
          },
        },
      });

      const execId = await engine.startExecution('wf-task', 'tenant-123', 'user', {});
      await new Promise((r) => setTimeout(r, 200));

      const execution = engine.getExecution(execId)!;
      // Task delegation succeeds (returns mock result)
      expect(execution.status).toBe('succeeded');
      expect(execution.stepResults['task-1']).toBeDefined();
    });

    it('should fail if task step missing agentId', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-task-noagent',
        name: 'No Agent',
        startAt: 'task-1',
        steps: {
          'task-1': {
            stepId: 'task-1',
            type: 'task',
            instruction: 'Process data',
            end: true,
          },
        },
      });

      const execId = await engine.startExecution('wf-task-noagent', 'tenant', 'user', {});
      await new Promise((r) => setTimeout(r, 200));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('failed');
      expect(execution.error?.message).toContain('agentId and instruction');
    });

    it('should fail if task step missing instruction', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-task-noinstr',
        name: 'No Instruction',
        startAt: 'task-1',
        steps: {
          'task-1': {
            stepId: 'task-1',
            type: 'task',
            agentId: 'agent-001',
            end: true,
          },
        },
      });

      const execId = await engine.startExecution('wf-task-noinstr', 'tenant', 'user', {});
      await new Promise((r) => setTimeout(r, 200));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('failed');
    });
  });

  // =========================================================================
  // Map step (not yet implemented)
  // =========================================================================

  describe('executeWorkflow — map step', () => {
    it('should fail with not-yet-implemented error', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-map',
        name: 'Map Test',
        startAt: 'map-1',
        steps: {
          'map-1': {
            stepId: 'map-1',
            type: 'map',
            end: true,
          },
        },
      });

      const execId = await engine.startExecution('wf-map', 'tenant', 'user', {});
      await new Promise((r) => setTimeout(r, 200));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('failed');
      expect(execution.error?.message).toContain('Map step not yet implemented');
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('should set execution status to failed when step throws', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-error',
        name: 'Error Test',
        startAt: 'map-1',
        steps: {
          'map-1': { stepId: 'map-1', type: 'map', end: true },
        },
      });

      const execId = await engine.startExecution('wf-error', 'tenant', 'user', {});
      await new Promise((r) => setTimeout(r, 200));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('failed');
      expect(execution.error).toBeDefined();
      expect(execution.error!.code).toBeTruthy();
      expect(execution.error!.stepId).toBe('map-1');
      expect(execution.completedAt).toBeTruthy();
    });

    it('should stop execution at the failed step (not continue to next)', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-stop-on-error',
        name: 'Stop on Error',
        startAt: 'map-step',
        steps: {
          'map-step': { stepId: 'map-step', type: 'map', next: 'never-reached' },
          'never-reached': {
            stepId: 'never-reached',
            type: 'wait',
            timeoutSeconds: 1,
            end: true,
          },
        },
      });

      const execId = await engine.startExecution('wf-stop-on-error', 'tenant', 'user', {});
      await new Promise((r) => setTimeout(r, 500));

      const execution = engine.getExecution(execId)!;
      expect(execution.status).toBe('failed');
      expect(execution.stepResults['never-reached']).toBeUndefined();
    });
  });

  // =========================================================================
  // getExecution
  // =========================================================================

  describe('getExecution', () => {
    it('should return undefined for non-existent execution', () => {
      expect(engine.getExecution('nonexistent')).toBeUndefined();
    });

    it('should return the execution by ID', async () => {
      engine.registerWorkflow({
        workflowId: 'wf-get',
        name: 'Get Test',
        startAt: 'step-1',
        steps: { 'step-1': { stepId: 'step-1', type: 'wait', timeoutSeconds: 1, end: true } },
      });

      const execId = await engine.startExecution('wf-get', 'tenant', 'user', {});
      const exec = engine.getExecution(execId);

      expect(exec).toBeDefined();
      expect(exec!.executionId).toBe(execId);
      expect(exec!.workflowId).toBe('wf-get');
    });
  });

  // =========================================================================
  // listExecutions
  // =========================================================================

  describe('listExecutions', () => {
    beforeEach(async () => {
      engine.registerWorkflow({
        workflowId: 'wf-list-a',
        name: 'List A',
        startAt: 'step-1',
        steps: { 'step-1': { stepId: 'step-1', type: 'wait', timeoutSeconds: 1, end: true } },
      });

      engine.registerWorkflow({
        workflowId: 'wf-list-b',
        name: 'List B',
        startAt: 'step-1',
        steps: { 'step-1': { stepId: 'step-1', type: 'wait', timeoutSeconds: 1, end: true } },
      });

      await engine.startExecution('wf-list-a', 'tenant-123', 'user-001', {});
      await engine.startExecution('wf-list-a', 'tenant-456', 'user-002', {});
      await engine.startExecution('wf-list-b', 'tenant-123', 'user-003', {});
    });

    it('should return all executions when no filters', () => {
      const execs = engine.listExecutions();
      expect(execs.length).toBe(3);
    });

    it('should filter by tenantId', () => {
      const execs = engine.listExecutions({ tenantId: 'tenant-123' });
      expect(execs.length).toBe(2);
      expect(execs.every((e) => e.tenantId === 'tenant-123')).toBe(true);
    });

    it('should filter by workflowId', () => {
      const execs = engine.listExecutions({ workflowId: 'wf-list-a' });
      expect(execs.length).toBe(2);
      expect(execs.every((e) => e.workflowId === 'wf-list-a')).toBe(true);
    });

    it('should filter by status', async () => {
      await new Promise((r) => setTimeout(r, 1500));

      const execs = engine.listExecutions({ status: 'succeeded' });
      expect(execs.length).toBeGreaterThan(0);
      expect(execs.every((e) => e.status === 'succeeded')).toBe(true);
    });

    it('should return empty array when no matches', () => {
      const execs = engine.listExecutions({ tenantId: 'non-existent-tenant' });
      expect(execs).toEqual([]);
    });
  });

  // =========================================================================
  // WorkflowPatterns
  // =========================================================================

  describe('WorkflowPatterns', () => {
    describe('sequential', () => {
      it('should create sequential workflow with correct chain', () => {
        const wf = WorkflowPatterns.sequential(
          'seq-wf',
          ['agent-A', 'agent-B', 'agent-C'],
          ['Task 1', 'Task 2', 'Task 3']
        );

        expect(wf.workflowId).toBe('seq-wf');
        expect(wf.name).toBe('Sequential Agent Chain');
        expect(wf.startAt).toBe('step-1');
        expect(Object.keys(wf.steps).length).toBe(3);

        expect(wf.steps['step-1'].agentId).toBe('agent-A');
        expect(wf.steps['step-1'].instruction).toBe('Task 1');
        expect(wf.steps['step-1'].next).toBe('step-2');
        expect(wf.steps['step-1'].end).toBeFalsy();

        expect(wf.steps['step-2'].agentId).toBe('agent-B');
        expect(wf.steps['step-2'].next).toBe('step-3');

        expect(wf.steps['step-3'].agentId).toBe('agent-C');
        expect(wf.steps['step-3'].end).toBe(true);
        expect(wf.steps['step-3'].next).toBeUndefined();
      });

      it('should handle single agent', () => {
        const wf = WorkflowPatterns.sequential('single', ['agent-1'], ['Task 1']);

        expect(Object.keys(wf.steps).length).toBe(1);
        expect(wf.steps['step-1'].end).toBe(true);
        expect(wf.steps['step-1'].next).toBeUndefined();
      });
    });

    describe('parallel', () => {
      it('should create parallel workflow with fan-out structure', () => {
        const wf = WorkflowPatterns.parallel(
          'par-wf',
          ['agent-X', 'agent-Y', 'agent-Z'],
          ['Inst 1', 'Inst 2', 'Inst 3']
        );

        expect(wf.workflowId).toBe('par-wf');
        expect(wf.name).toBe('Parallel Agent Execution');
        expect(wf.startAt).toBe('parallel-root');

        const root = wf.steps['parallel-root'];
        expect(root.type).toBe('parallel');
        expect(root.end).toBe(true);
        expect(root.parallelSteps!.length).toBe(3);
        expect(root.parallelSteps![0].agentId).toBe('agent-X');
        expect(root.parallelSteps![0].instruction).toBe('Inst 1');
        expect(root.parallelSteps![1].agentId).toBe('agent-Y');
        expect(root.parallelSteps![2].agentId).toBe('agent-Z');
      });
    });
  });

  // =========================================================================
  // createWorkflowEngine factory
  // =========================================================================

  describe('createWorkflowEngine', () => {
    it('should create WorkflowEngine instance', () => {
      const e = createWorkflowEngine(orchestrator);
      expect(e).toBeInstanceOf(WorkflowEngine);
    });
  });
});
