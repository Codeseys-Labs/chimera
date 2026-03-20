/**
 * Task Decomposer
 *
 * Decomposes vague user requests into concrete, executable subtasks.
 * Supports multiple decomposition strategies: tree-of-thought, plan-and-execute,
 * recursive refinement, goal decomposition, and dependency-aware planning.
 */

import type {
  DecompositionContext,
  DecompositionResult,
  DecompositionStrategy,
  Subtask,
  TaskPriority,
  TaskStatus,
} from './types';

/**
 * Configuration for task decomposer
 */
export interface DecomposerConfig {
  /** Default decomposition strategy */
  defaultStrategy: DecompositionStrategy;

  /** Maximum subtasks per decomposition */
  maxSubtasks: number;

  /** Maximum decomposition depth */
  maxDepth: number;

  /** Tenant identifier */
  tenantId: string;
}

/**
 * Task decomposer for breaking vague requests into concrete subtasks
 */
export class TaskDecomposer {
  private config: DecomposerConfig;

  constructor(config: Partial<DecomposerConfig> = {}) {
    this.config = {
      defaultStrategy: config.defaultStrategy || 'plan-and-execute',
      maxSubtasks: config.maxSubtasks || 20,
      maxDepth: config.maxDepth || 3,
      tenantId: config.tenantId || 'default',
    };

    console.log(
      `[TaskDecomposer] Initialized with strategy=${this.config.defaultStrategy}, maxSubtasks=${this.config.maxSubtasks}, maxDepth=${this.config.maxDepth}`
    );
  }

  /**
   * Decompose a vague request into concrete subtasks
   */
  async decompose(
    request: string,
    context: DecompositionContext
  ): Promise<DecompositionResult> {
    console.log(`[TaskDecomposer] Decomposing request: "${request.substring(0, 100)}..."`);
    console.log(
      `[TaskDecomposer] Context: tenantId=${context.tenantId}, constraints=${context.constraints?.length || 0}`
    );

    const strategy = this.config.defaultStrategy;
    const startTime = Date.now();

    // Select strategy-specific decomposition
    let subtasks: Subtask[];
    switch (strategy) {
      case 'tree-of-thought':
        subtasks = await this.decomposeTreeOfThought(request, context);
        break;
      case 'plan-and-execute':
        subtasks = await this.decomposePlanAndExecute(request, context);
        break;
      case 'recursive':
        subtasks = await this.decomposeRecursive(request, context, 0);
        break;
      case 'goal-decomposition':
        // Use plan-and-execute as fallback for now
        subtasks = await this.decomposePlanAndExecute(request, context);
        break;
      case 'dependency-aware':
        // Use plan-and-execute as fallback for now
        subtasks = await this.decomposePlanAndExecute(request, context);
        break;
      default:
        subtasks = await this.decomposePlanAndExecute(request, context);
    }

    // Enforce max subtasks limit
    if (subtasks.length > this.config.maxSubtasks) {
      console.warn(
        `[TaskDecomposer] Subtask count ${subtasks.length} exceeds limit ${this.config.maxSubtasks}, truncating`
      );
      subtasks = subtasks.slice(0, this.config.maxSubtasks);
    }

    // Build execution waves (topological sort)
    const executionWaves = this.buildExecutionWaves(subtasks);

    // Identify checkpoints requiring human approval
    const checkpoints = this.identifyCheckpoints(subtasks);

    // Calculate total estimated duration
    const estimatedTotalDurationMs = subtasks.reduce(
      (sum, task) => sum + (task.estimatedDurationMs || 0),
      0
    );

    const result: DecompositionResult = {
      goal: request,
      strategy,
      subtasks,
      executionWaves,
      checkpoints,
      estimatedTotalDurationMs,
      decomposedAt: new Date().toISOString(),
    };

    const elapsedMs = Date.now() - startTime;
    console.log(
      `[TaskDecomposer] Decomposition complete: ${subtasks.length} subtasks, ${executionWaves.length} waves, ${checkpoints.length} checkpoints (${elapsedMs}ms)`
    );

    return result;
  }

  /**
   * Build execution waves using topological sort
   * Subtasks in the same wave have no dependencies on each other and can run in parallel
   */
  private buildExecutionWaves(subtasks: Subtask[]): string[][] {
    console.log(`[TaskDecomposer] Building execution waves for ${subtasks.length} subtasks`);

    const waves: string[][] = [];
    const taskMap = new Map<string, Subtask>();
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, Set<string>>();

    // Initialize data structures
    for (const task of subtasks) {
      taskMap.set(task.id, task);
      inDegree.set(task.id, 0);
      adjList.set(task.id, new Set());
    }

    // Build adjacency list and calculate in-degrees
    for (const task of subtasks) {
      for (const depId of task.dependencies) {
        if (taskMap.has(depId)) {
          adjList.get(depId)!.add(task.id);
          inDegree.set(task.id, inDegree.get(task.id)! + 1);
        } else {
          console.warn(
            `[TaskDecomposer] Task ${task.id} has non-existent dependency ${depId}, ignoring`
          );
        }
      }
    }

    // Kahn's algorithm for topological sort
    const queue: string[] = [];
    const processed = new Set<string>();

    // Find all tasks with no dependencies (in-degree = 0)
    Array.from(inDegree.entries()).forEach(([taskId, degree]) => {
      if (degree === 0) {
        queue.push(taskId);
      }
    });

    // Process waves
    while (queue.length > 0) {
      const currentWave = [...queue];
      waves.push(currentWave);
      queue.length = 0;

      for (const taskId of currentWave) {
        processed.add(taskId);

        // Reduce in-degree for dependent tasks
        const dependents = Array.from(adjList.get(taskId)!);
        for (const dependentId of dependents) {
          const newInDegree = inDegree.get(dependentId)! - 1;
          inDegree.set(dependentId, newInDegree);

          if (newInDegree === 0) {
            queue.push(dependentId);
          }
        }
      }
    }

    // Detect circular dependencies
    if (processed.size < subtasks.length) {
      const unprocessed = subtasks.filter((t) => !processed.has(t.id)).map((t) => t.id);
      throw new Error(
        `Circular dependency detected among subtasks: ${unprocessed.join(', ')}`
      );
    }

    console.log(
      `[TaskDecomposer] Built ${waves.length} execution waves: ${waves.map((w) => w.length).join(', ')}`
    );

    return waves;
  }

  /**
   * Identify subtasks requiring human approval before execution
   */
  private identifyCheckpoints(subtasks: Subtask[]): string[] {
    const checkpoints: string[] = [];

    for (const task of subtasks) {
      const needsCheckpoint =
        // High-cost operations (based on description keywords)
        /\b(delete|drop|destroy|terminate|remove|purge)\b/i.test(task.description) ||
        // Production environment operations
        /\bproduction\b/i.test(task.description) ||
        // Database schema changes
        /\b(migrate|schema|alter table)\b/i.test(task.description) ||
        // IAM/security changes
        /\b(iam|policy|permissions|security group)\b/i.test(task.description) ||
        // Long-running operations (> 30 minutes)
        (task.estimatedDurationMs && task.estimatedDurationMs > 30 * 60 * 1000) ||
        // Urgent priority tasks (to confirm criticality)
        task.priority === 'urgent';

      if (needsCheckpoint) {
        checkpoints.push(task.id);
      }
    }

    console.log(
      `[TaskDecomposer] Identified ${checkpoints.length} checkpoints: ${checkpoints.join(', ')}`
    );

    return checkpoints;
  }

  /**
   * Decompose using tree-of-thought strategy
   * Generates multiple decomposition paths, evaluates each, selects best
   */
  private async decomposeTreeOfThought(
    request: string,
    context: DecompositionContext
  ): Promise<Subtask[]> {
    console.log('[TaskDecomposer] Using tree-of-thought decomposition');

    // TODO: In production, use LLM to generate multiple decomposition paths
    // For each path:
    //   1. Generate subtasks with different approaches
    //   2. Evaluate feasibility, completeness, and risk
    //   3. Score each path
    // Select the path with the highest score

    // Placeholder: Generate a single path
    const subtasks: Subtask[] = [
      {
        id: 'treeofthought-1',
        description: `Research approaches for: ${request}`,
        dependencies: [],
        status: 'pending' as TaskStatus,
        priority: 'high' as TaskPriority,
        estimatedDurationMs: 600000, // 10 minutes
      },
      {
        id: 'treeofthought-2',
        description: 'Evaluate multiple solution paths',
        dependencies: ['treeofthought-1'],
        status: 'pending' as TaskStatus,
        priority: 'high' as TaskPriority,
        estimatedDurationMs: 900000, // 15 minutes
      },
      {
        id: 'treeofthought-3',
        description: 'Select optimal path and implement',
        dependencies: ['treeofthought-2'],
        status: 'pending' as TaskStatus,
        priority: 'normal' as TaskPriority,
        estimatedDurationMs: 1800000, // 30 minutes
      },
    ];

    console.log(`[TaskDecomposer] Generated ${subtasks.length} subtasks (tree-of-thought)`);
    return subtasks;
  }

  /**
   * Decompose using plan-and-execute strategy
   * Generates comprehensive plan upfront with validation and rollback steps
   */
  private async decomposePlanAndExecute(
    request: string,
    context: DecompositionContext
  ): Promise<Subtask[]> {
    console.log('[TaskDecomposer] Using plan-and-execute decomposition');

    // TODO: In production, use LLM to generate comprehensive plan:
    //   1. Understand goal and constraints
    //   2. Break into phases (discovery, design, implementation, validation)
    //   3. Add validation criteria and rollback steps for each subtask
    //   4. Ensure dependencies are explicit

    // Placeholder: Generate a structured plan
    const subtasks: Subtask[] = [
      {
        id: 'plan-1',
        description: `Analyze requirements: ${request}`,
        dependencies: [],
        status: 'pending' as TaskStatus,
        priority: 'high' as TaskPriority,
        validation: 'Requirements document created',
        estimatedDurationMs: 300000, // 5 minutes
      },
      {
        id: 'plan-2',
        description: 'Design solution architecture',
        dependencies: ['plan-1'],
        status: 'pending' as TaskStatus,
        priority: 'high' as TaskPriority,
        validation: 'Architecture diagram and component list available',
        estimatedDurationMs: 600000, // 10 minutes
      },
      {
        id: 'plan-3',
        description: 'Implement core functionality',
        dependencies: ['plan-2'],
        status: 'pending' as TaskStatus,
        priority: 'normal' as TaskPriority,
        validation: 'Tests pass for core features',
        rollback: 'Revert to previous commit',
        estimatedDurationMs: 1800000, // 30 minutes
      },
      {
        id: 'plan-4',
        description: 'Add error handling and edge cases',
        dependencies: ['plan-3'],
        status: 'pending' as TaskStatus,
        priority: 'normal' as TaskPriority,
        validation: 'Error scenarios covered by tests',
        estimatedDurationMs: 900000, // 15 minutes
      },
      {
        id: 'plan-5',
        description: 'Integration testing and validation',
        dependencies: ['plan-4'],
        status: 'pending' as TaskStatus,
        priority: 'high' as TaskPriority,
        validation: 'All integration tests pass',
        estimatedDurationMs: 600000, // 10 minutes
      },
    ];

    console.log(`[TaskDecomposer] Generated ${subtasks.length} subtasks (plan-and-execute)`);
    return subtasks;
  }

  /**
   * Decompose using recursive strategy
   * Starts coarse-grained, refines based on feedback
   */
  private async decomposeRecursive(
    request: string,
    context: DecompositionContext,
    depth: number
  ): Promise<Subtask[]> {
    console.log(`[TaskDecomposer] Using recursive decomposition (depth=${depth})`);

    // Check depth limit
    if (depth >= this.config.maxDepth) {
      console.warn(
        `[TaskDecomposer] Reached max depth ${this.config.maxDepth}, returning atomic task`
      );
      return [
        {
          id: `recursive-atomic-${depth}`,
          description: request,
          dependencies: [],
          status: 'pending' as TaskStatus,
          priority: 'normal' as TaskPriority,
          estimatedDurationMs: 600000, // 10 minutes
        },
      ];
    }

    // TODO: In production, use LLM to:
    //   1. Check if request is atomic (can't be decomposed further)
    //   2. If not atomic, break into 2-4 coarse-grained subtasks
    //   3. Recursively decompose each subtask
    //   4. Stop when subtasks are atomic or depth limit reached

    // Placeholder: Generate coarse-grained decomposition
    const subtasks: Subtask[] = [];

    if (depth === 0) {
      // First level: break into phases
      subtasks.push(
        {
          id: `recursive-${depth}-1`,
          description: `Phase 1: Research and planning for ${request}`,
          dependencies: [],
          status: 'pending' as TaskStatus,
          priority: 'high' as TaskPriority,
          estimatedDurationMs: 900000, // 15 minutes
        },
        {
          id: `recursive-${depth}-2`,
          description: `Phase 2: Implementation for ${request}`,
          dependencies: [`recursive-${depth}-1`],
          status: 'pending' as TaskStatus,
          priority: 'normal' as TaskPriority,
          estimatedDurationMs: 1800000, // 30 minutes
        },
        {
          id: `recursive-${depth}-3`,
          description: `Phase 3: Validation and refinement for ${request}`,
          dependencies: [`recursive-${depth}-2`],
          status: 'pending' as TaskStatus,
          priority: 'normal' as TaskPriority,
          estimatedDurationMs: 600000, // 10 minutes
        }
      );
    } else {
      // Deeper levels: atomic tasks
      subtasks.push({
        id: `recursive-${depth}-atomic`,
        description: `Complete: ${request}`,
        dependencies: [],
        status: 'pending' as TaskStatus,
        priority: 'normal' as TaskPriority,
        estimatedDurationMs: 600000, // 10 minutes
      });
    }

    console.log(
      `[TaskDecomposer] Generated ${subtasks.length} subtasks at depth ${depth} (recursive)`
    );
    return subtasks;
  }
}

/**
 * Create a task decomposer instance
 */
export function createTaskDecomposer(
  config: Partial<DecomposerConfig> = {}
): TaskDecomposer {
  return new TaskDecomposer(config);
}
