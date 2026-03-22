/**
 * Background Task Management
 *
 * Provides start_background_task tool for agents to delegate work:
 * - Fire-and-forget task execution
 * - No blocking on task completion
 * - SQS-based task queue
 * - EventBridge notifications on completion
 *
 * Use case: Agent delegates long-running analysis while continuing chat
 */

import type { AgentOrchestrator, TaskDelegation } from './orchestrator';
import type { ISOTimestamp } from './types';

/**
 * Background task status
 */
export type BackgroundTaskStatus =
  | 'queued'      // Task submitted to queue
  | 'running'     // Agent processing task
  | 'completed'   // Task finished successfully
  | 'failed'      // Task failed
  | 'timeout';    // Task exceeded timeout

/**
 * Background task definition
 */
export interface BackgroundTask {
  taskId: string;
  tenantId: string;
  sourceAgentId: string;
  targetAgentId: string;
  instruction: string;
  context: Record<string, unknown>;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  timeoutSeconds: number;
  status: BackgroundTaskStatus;
  queuedAt: ISOTimestamp;
  startedAt?: ISOTimestamp;
  completedAt?: ISOTimestamp;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Task submission result
 */
export interface TaskSubmissionResult {
  taskId: string;
  status: 'queued';
  queuedAt: ISOTimestamp;
  estimatedStartTime?: ISOTimestamp;
}

/**
 * Background Task Manager
 *
 * Manages fire-and-forget task delegation:
 * 1. Submit task to SQS queue
 * 2. Return immediately with task ID
 * 3. Agent polls for completion (optional)
 * 4. EventBridge publishes completion events
 */
export class BackgroundTaskManager {
  private orchestrator: AgentOrchestrator;
  private tasks: Map<string, BackgroundTask>;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
    this.tasks = new Map();
  }

  /**
   * Submit background task (non-blocking)
   *
   * This implements the start_background_task agent tool.
   * Agent continues immediately while task executes in background.
   *
   * @param delegation - Task delegation details
   * @returns Task submission result
   */
  async submitTask(
    delegation: Omit<TaskDelegation, 'taskId'>
  ): Promise<TaskSubmissionResult> {
    const taskId = `bg-task-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const task: BackgroundTask = {
      taskId,
      tenantId: delegation.tenantId,
      sourceAgentId: delegation.sourceAgentId,
      targetAgentId: delegation.targetAgentId,
      instruction: delegation.instruction,
      context: delegation.context || {},
      priority: delegation.priority || 'normal',
      timeoutSeconds: delegation.timeoutSeconds || 300,
      status: 'queued',
      queuedAt: new Date().toISOString()
    };

    // Store task metadata
    this.tasks.set(taskId, task);

    // Delegate to orchestrator (SQS queue)
    await this.orchestrator.delegateTask({
      ...delegation,
      taskId
    });

    console.log(`[BackgroundTask] Submitted: ${taskId}`);

    return {
      taskId,
      status: 'queued',
      queuedAt: task.queuedAt
    };
  }

  /**
   * Get task status (for polling)
   *
   * @param taskId - Background task ID
   * @returns Task details or undefined if not found
   */
  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Update task status (called by agent when processing)
   *
   * @param taskId - Background task ID
   * @param status - New status
   * @param result - Task result (if completed)
   * @param error - Error details (if failed)
   */
  updateTaskStatus(
    taskId: string,
    status: BackgroundTaskStatus,
    result?: Record<string, unknown>,
    error?: { code: string; message: string }
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.status = status;

    if (status === 'running' && !task.startedAt) {
      task.startedAt = new Date().toISOString();
    }

    if (status === 'completed' || status === 'failed' || status === 'timeout') {
      task.completedAt = new Date().toISOString();
      task.result = result;
      task.error = error;
    }

    console.log(`[BackgroundTask] Status update: ${taskId} -> ${status}`);
  }

  /**
   * List background tasks for a tenant
   *
   * @param tenantId - Tenant ID
   * @param filters - Optional filters
   * @returns Array of tasks
   */
  listTasks(
    tenantId: string,
    filters?: {
      sourceAgentId?: string;
      targetAgentId?: string;
      status?: BackgroundTaskStatus;
    }
  ): BackgroundTask[] {
    let tasks = Array.from(this.tasks.values())
      .filter(t => t.tenantId === tenantId);

    if (filters?.sourceAgentId) {
      tasks = tasks.filter(t => t.sourceAgentId === filters.sourceAgentId);
    }

    if (filters?.targetAgentId) {
      tasks = tasks.filter(t => t.targetAgentId === filters.targetAgentId);
    }

    if (filters?.status) {
      tasks = tasks.filter(t => t.status === filters.status);
    }

    return tasks.sort((a, b) =>
      new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime()
    );
  }

  /**
   * Cancel background task (best effort)
   *
   * @param taskId - Background task ID
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status === 'completed' || task.status === 'failed') {
      throw new Error(`Cannot cancel ${task.status} task`);
    }

    // TODO: Remove from SQS queue if still queued
    // TODO: Send termination signal if running

    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    task.error = {
      code: 'CANCELLED',
      message: 'Task cancelled by user'
    };

    console.log(`[BackgroundTask] Cancelled: ${taskId}`);
  }
}

/**
 * Create background task manager
 */
export function createBackgroundTaskManager(
  orchestrator: AgentOrchestrator
): BackgroundTaskManager {
  return new BackgroundTaskManager(orchestrator);
}

/**
 * Agent tool schema for start_background_task
 *
 * This is the tool definition that gets registered with the agent.
 */
export const startBackgroundTaskTool = {
  name: 'start_background_task',
  description: 'Delegate a task to another agent in the background. Returns immediately without waiting for completion. Use this for long-running tasks that should not block the current conversation.',
  parameters: {
    type: 'object',
    properties: {
      targetAgentId: {
        type: 'string',
        description: 'ID of the agent that will execute the task'
      },
      instruction: {
        type: 'string',
        description: 'Clear instruction for the background task'
      },
      context: {
        type: 'object',
        description: 'Additional context data for the task',
        additionalProperties: true
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high', 'urgent'],
        description: 'Task priority (default: normal)'
      },
      timeoutSeconds: {
        type: 'number',
        description: 'Maximum execution time in seconds (default: 300)'
      }
    },
    required: ['targetAgentId', 'instruction']
  }
};

/**
 * Agent tool schema for check_background_task
 *
 * Allows agents to poll for background task status and results.
 */
export const checkBackgroundTaskTool = {
  name: 'check_background_task',
  description: 'Check the status of a background task. Returns current status, progress, and result (if completed). Use this to poll for task completion without blocking.',
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The background task ID returned by start_background_task'
      }
    },
    required: ['taskId']
  }
};
