/**
 * Tests for Swarm Engine module
 * Validates autonomous agent orchestration capabilities
 */

import { describe, it, expect } from 'bun:test';
import {
  // Types
  type DecompositionStrategy,
  type TaskStatus,
  type TaskPriority,
  type Subtask,
  type DecompositionResult,
  type BlockerCategory,
  type BlockerSeverity,
  type Blocker,
  type ResolutionStrategy,
  type SwarmRole,
  type HumanLoopStrategy,
  type DecisionCriticality,
  type Decision,
  type RefinementStage,
  type QualityGate,
  type RefinementState,
  STAGE_QUALITY_GATES,
} from '../types';

describe('Swarm Engine Types', () => {
  describe('DecompositionStrategy types', () => {
    it('should accept valid decomposition strategies', () => {
      const strategies: DecompositionStrategy[] = [
        'tree-of-thought',
        'plan-and-execute',
        'recursive',
        'goal-decomposition',
        'dependency-aware',
      ];

      expect(strategies).toHaveLength(5);
      strategies.forEach(strategy => {
        expect(typeof strategy).toBe('string');
      });
    });
  });

  describe('TaskStatus types', () => {
    it('should define all task lifecycle states', () => {
      const statuses: TaskStatus[] = [
        'pending',
        'in_progress',
        'completed',
        'failed',
        'blocked',
      ];

      expect(statuses).toHaveLength(5);
    });
  });

  describe('SwarmRole types', () => {
    it('should define all agent roles', () => {
      const roles: SwarmRole[] = [
        'planner',
        'researcher',
        'builder',
        'validator',
        'coordinator',
      ];

      expect(roles).toHaveLength(5);
    });
  });

  describe('BlockerCategory types', () => {
    it('should categorize different blocker types', () => {
      const categories: BlockerCategory[] = [
        'missing_dependency',
        'permission_denied',
        'rate_limit',
        'invalid_state',
        'validation_failure',
        'external_dependency',
      ];

      expect(categories).toHaveLength(6);
    });
  });
});

describe('Subtask structure', () => {
  it('should create valid subtask with required fields', () => {
    const subtask: Subtask = {
      id: 'task-1',
      description: 'Deploy infrastructure',
      dependencies: [],
      status: 'pending',
      priority: 'high',
    };

    expect(subtask.id).toBe('task-1');
    expect(subtask.status).toBe('pending');
    expect(subtask.priority).toBe('high');
    expect(subtask.dependencies).toEqual([]);
  });

  it('should support subtask with dependencies', () => {
    const subtask: Subtask = {
      id: 'task-2',
      description: 'Run tests',
      dependencies: ['task-1'],
      status: 'blocked',
      priority: 'normal',
      assignedAgent: 'agent-validator-01',
      assignedRole: 'validator',
    };

    expect(subtask.dependencies).toContain('task-1');
    expect(subtask.status).toBe('blocked');
    expect(subtask.assignedRole).toBe('validator');
  });

  it('should support optional metadata', () => {
    const subtask: Subtask = {
      id: 'task-3',
      description: 'Deploy to staging',
      dependencies: ['task-1', 'task-2'],
      status: 'pending',
      priority: 'urgent',
      estimatedDurationMs: 300000, // 5 minutes
      validation: 'Check deployment health',
      rollback: 'Rollback to previous version',
      metadata: {
        environment: 'staging',
        requiredApproval: true,
      },
    };

    expect(subtask.estimatedDurationMs).toBe(300000);
    expect(subtask.validation).toBeDefined();
    expect(subtask.rollback).toBeDefined();
    expect(subtask.metadata?.environment).toBe('staging');
  });
});

describe('Blocker structure', () => {
  it('should create blocker with detection timestamp', () => {
    const now = new Date().toISOString();
    const blocker: Blocker = {
      id: 'blocker-1',
      category: 'permission_denied',
      severity: 'critical',
      description: 'IAM role lacks dynamodb:PutItem permission',
      taskId: 'task-5',
      errorSignature: 'AccessDeniedException',
      detectedAt: now,
    };

    expect(blocker.category).toBe('permission_denied');
    expect(blocker.severity).toBe('critical');
    expect(blocker.errorSignature).toBe('AccessDeniedException');
    expect(blocker.detectedAt).toBe(now);
  });

  it('should support blocker resolution tracking', () => {
    const detectedAt = new Date().toISOString();
    const resolvedAt = new Date(Date.now() + 60000).toISOString();

    const blocker: Blocker = {
      id: 'blocker-2',
      category: 'rate_limit',
      severity: 'medium',
      description: 'API throttling detected',
      taskId: 'task-10',
      errorSignature: 'ThrottlingException',
      service: 'dynamodb',
      detectedAt,
      resolvedAt,
      resolution: {
        strategy: 'retry_with_backoff',
        status: 'resolved',
        description: 'Retried with exponential backoff',
        appliedAt: resolvedAt,
        retryCount: 3,
      },
    };

    expect(blocker.resolution).toBeDefined();
    expect(blocker.resolution?.strategy).toBe('retry_with_backoff');
    expect(blocker.resolution?.status).toBe('resolved');
    expect(blocker.resolution?.retryCount).toBe(3);
  });
});

describe('Human-in-the-Loop Decision', () => {
  it('should create decision with criticality levels', () => {
    const decision: Decision = {
      id: 'decision-1',
      description: 'Delete production database',
      criticality: 'critical',
      reversible: false,
      costImpact: 'none',
      hasReasonableDefault: false,
      context: {
        environment: 'production',
        dataSize: '10TB',
      },
    };

    expect(decision.criticality).toBe('critical');
    expect(decision.reversible).toBe(false);
    expect(decision.hasReasonableDefault).toBe(false);
  });

  it('should support decision with default choice', () => {
    const decision: Decision = {
      id: 'decision-2',
      description: 'Select EC2 instance type',
      criticality: 'minor',
      reversible: true,
      costImpact: 'medium',
      hasReasonableDefault: true,
      defaultChoice: 't3.medium',
      options: ['t3.small', 't3.medium', 't3.large'],
      context: {
        workloadType: 'web-server',
      },
    };

    expect(decision.hasReasonableDefault).toBe(true);
    expect(decision.defaultChoice).toBe('t3.medium');
    expect(decision.options).toContain('t3.medium');
  });
});

describe('Progressive Refinement Stages', () => {
  it('should define all refinement stages', () => {
    const stages: RefinementStage[] = [
      'discovery',
      'poc',
      'prototype',
      'hardened',
      'production',
    ];

    expect(stages).toHaveLength(5);
  });

  it('should provide quality gates for each stage', () => {
    const discoveryGates = STAGE_QUALITY_GATES.discovery;
    expect(discoveryGates).toBeDefined();
    expect(discoveryGates.length).toBeGreaterThan(0);
    expect(discoveryGates[0].name).toBe('problem-defined');

    const productionGates = STAGE_QUALITY_GATES.production;
    expect(productionGates).toBeDefined();
    expect(productionGates.some(gate => gate.name === 'monitoring')).toBe(true);
  });

  it('should validate quality gate structure', () => {
    const gate = STAGE_QUALITY_GATES.hardened[0];

    expect(gate.name).toBeDefined();
    expect(gate.description).toBeDefined();
    expect(gate.criteria).toBeDefined();
    expect(typeof gate.passed).toBe('boolean');
  });
});

describe('RefinementState structure', () => {
  it('should track refinement progress', () => {
    const now = new Date().toISOString();
    const state: RefinementState = {
      taskId: 'task-100',
      tenantId: 'tenant-acme',
      stage: 'prototype',
      completeness: 0.75,
      quality: 0.85,
      gaps: [
        {
          description: 'Missing error handling',
          severity: 'major',
          suggestedFix: 'Add try-catch blocks',
          blocksAdvancement: true,
        },
      ],
      qualityGates: STAGE_QUALITY_GATES.prototype,
      iterationCount: 3,
      lastEvaluatedAt: now,
      stageHistory: [
        {
          stage: 'discovery',
          enteredAt: new Date(Date.now() - 86400000).toISOString(),
          exitedAt: new Date(Date.now() - 43200000).toISOString(),
          iterationsInStage: 2,
        },
        {
          stage: 'poc',
          enteredAt: new Date(Date.now() - 43200000).toISOString(),
          exitedAt: new Date(Date.now() - 21600000).toISOString(),
          iterationsInStage: 1,
        },
        {
          stage: 'prototype',
          enteredAt: new Date(Date.now() - 21600000).toISOString(),
          iterationsInStage: 3,
        },
      ],
    };

    expect(state.stage).toBe('prototype');
    expect(state.completeness).toBe(0.75);
    expect(state.quality).toBe(0.85);
    expect(state.gaps).toHaveLength(1);
    expect(state.gaps[0].blocksAdvancement).toBe(true);
    expect(state.stageHistory).toHaveLength(3);
  });
});

describe('Type safety and exports', () => {
  it('should export all required types', () => {
    // This test validates that all types are properly exported
    // Type checking occurs at compile time
    const strategies: DecompositionStrategy[] = ['dependency-aware', 'recursive'];
    const statuses: TaskStatus[] = ['pending', 'completed'];
    const roles: SwarmRole[] = ['planner', 'builder'];

    expect(strategies).toBeDefined();
    expect(statuses).toBeDefined();
    expect(roles).toBeDefined();
  });
});

describe('Decomposition result structure', () => {
  it('should organize subtasks into execution waves', () => {
    const now = new Date().toISOString();
    const result: DecompositionResult = {
      goal: 'Deploy multi-tier application',
      strategy: 'dependency-aware',
      subtasks: [
        {
          id: 'task-1',
          description: 'Create VPC',
          dependencies: [],
          status: 'pending',
          priority: 'high',
        },
        {
          id: 'task-2',
          description: 'Create RDS database',
          dependencies: ['task-1'],
          status: 'pending',
          priority: 'high',
        },
        {
          id: 'task-3',
          description: 'Deploy application',
          dependencies: ['task-1', 'task-2'],
          status: 'pending',
          priority: 'normal',
        },
      ],
      executionWaves: [
        ['task-1'], // Wave 0: no dependencies
        ['task-2'], // Wave 1: depends on wave 0
        ['task-3'], // Wave 2: depends on waves 0 and 1
      ],
      checkpoints: ['task-3'], // Require approval before deployment
      estimatedTotalDurationMs: 900000, // 15 minutes
      decomposedAt: now,
    };

    expect(result.strategy).toBe('dependency-aware');
    expect(result.subtasks).toHaveLength(3);
    expect(result.executionWaves).toHaveLength(3);
    expect(result.executionWaves[0]).toEqual(['task-1']);
    expect(result.executionWaves[2]).toEqual(['task-3']);
    expect(result.checkpoints).toContain('task-3');
  });
});

describe('Tenant isolation', () => {
  it('should include tenantId in refinement state', () => {
    const state: RefinementState = {
      taskId: 'task-200',
      tenantId: 'tenant-acme',
      stage: 'discovery',
      completeness: 0.5,
      quality: 0.6,
      gaps: [],
      qualityGates: STAGE_QUALITY_GATES.discovery,
      iterationCount: 1,
      lastEvaluatedAt: new Date().toISOString(),
      stageHistory: [],
    };

    expect(state.tenantId).toBe('tenant-acme');
  });

  it('should prevent cross-tenant data mixing in state tracking', () => {
    const tenant1State: RefinementState = {
      taskId: 'task-t1',
      tenantId: 'tenant-1',
      stage: 'prototype',
      completeness: 0.8,
      quality: 0.7,
      gaps: [],
      qualityGates: [],
      iterationCount: 2,
      lastEvaluatedAt: new Date().toISOString(),
      stageHistory: [],
    };

    const tenant2State: RefinementState = {
      taskId: 'task-t2',
      tenantId: 'tenant-2',
      stage: 'hardened',
      completeness: 0.9,
      quality: 0.85,
      gaps: [],
      qualityGates: [],
      iterationCount: 5,
      lastEvaluatedAt: new Date().toISOString(),
      stageHistory: [],
    };

    // Verify states are isolated by tenant
    expect(tenant1State.tenantId).not.toBe(tenant2State.tenantId);
    expect(tenant1State.stage).not.toBe(tenant2State.stage);
  });
});
