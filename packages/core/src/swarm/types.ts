/**
 * Swarm Engine Types
 *
 * Type definitions for AWS Chimera's autonomous swarm orchestration system.
 * Covers task decomposition, blocker resolution, role assignment, human-in-the-loop,
 * and progressive refinement for autonomous multi-agent problem-solving.
 */

import { ISOTimestamp } from '../orchestration/types';

// ============================================================
// Task Decomposition Types
// ============================================================

/**
 * Strategy for decomposing vague requests into concrete subtasks
 */
export type DecompositionStrategy =
  | 'tree-of-thought'      // Multiple paths, select best
  | 'plan-and-execute'     // Upfront comprehensive planning
  | 'recursive'            // Coarse-grained → refine iteratively
  | 'goal-decomposition'   // Goal hierarchy breakdown
  | 'dependency-aware';    // Explicit dependency graph construction

/**
 * Task execution status
 */
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'blocked';

/**
 * Task priority levels
 */
export type TaskPriority =
  | 'low'
  | 'normal'
  | 'high'
  | 'urgent';

/**
 * Individual subtask with dependencies and metadata
 */
export interface Subtask {
  /** Unique subtask identifier */
  id: string;

  /** Human-readable subtask description */
  description: string;

  /** IDs of subtasks that must complete before this one */
  dependencies: string[];

  /** Current execution status */
  status: TaskStatus;

  /** Assigned agent ID (if assigned) */
  assignedAgent?: string;

  /** Assigned role (if assigned) */
  assignedRole?: SwarmRole;

  /** Validation criteria for completion */
  validation?: string;

  /** Rollback steps if subtask fails */
  rollback?: string;

  /** Priority level */
  priority: TaskPriority;

  /** Estimated duration in milliseconds */
  estimatedDurationMs?: number;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Context provided for task decomposition
 */
export interface DecompositionContext {
  /** Tenant identifier for multi-tenant isolation */
  tenantId: string;

  /** Existing resources (AWS resources, code modules, etc.) */
  existingResources?: Record<string, unknown>;

  /** Constraints (budget, time, compliance requirements) */
  constraints?: string[];

  /** User preferences (coding style, testing approach, etc.) */
  preferences?: Record<string, unknown>;

  /** Previous decomposition attempts (for refinement) */
  previousAttempts?: DecompositionResult[];
}

/**
 * Result of task decomposition
 */
export interface DecompositionResult {
  /** Original goal/request */
  goal: string;

  /** Strategy used for decomposition */
  strategy: DecompositionStrategy;

  /** List of all subtasks */
  subtasks: Subtask[];

  /** Execution waves (subtasks grouped by dependency level) */
  executionWaves: string[][];

  /** Checkpoint subtask IDs requiring human approval */
  checkpoints: string[];

  /** Total estimated duration in milliseconds */
  estimatedTotalDurationMs?: number;

  /** Timestamp when decomposition occurred */
  decomposedAt: ISOTimestamp;
}

// ============================================================
// Blocker Detection & Resolution Types
// ============================================================

/**
 * Category of blocker encountered
 */
export type BlockerCategory =
  | 'missing_dependency'     // Required resource doesn't exist
  | 'permission_denied'      // IAM/authorization failure
  | 'rate_limit'             // API throttling
  | 'invalid_state'          // Precondition not met
  | 'validation_failure'     // Input/output validation failed
  | 'external_dependency';   // Third-party service unavailable

/**
 * Severity level of blocker
 */
export type BlockerSeverity =
  | 'critical'   // Blocks all progress
  | 'high'       // Blocks multiple tasks
  | 'medium'     // Blocks single task
  | 'low';       // Degraded functionality

/**
 * Detected blocker preventing task progress
 */
export interface Blocker {
  /** Unique blocker identifier */
  id: string;

  /** Blocker category */
  category: BlockerCategory;

  /** Severity level */
  severity: BlockerSeverity;

  /** Human-readable description */
  description: string;

  /** Task ID that encountered the blocker */
  taskId: string;

  /** Error signature for pattern matching */
  errorSignature: string;

  /** Full error message (if available) */
  errorMessage?: string;

  /** AWS service or component involved */
  service?: string;

  /** Timestamp when blocker was detected */
  detectedAt: ISOTimestamp;

  /** Timestamp when blocker was resolved */
  resolvedAt?: ISOTimestamp;

  /** Resolution details (if resolved) */
  resolution?: Resolution;
}

/**
 * Strategy for resolving a blocker
 */
export type ResolutionStrategy =
  | 'provision_on_demand'     // Create missing resource
  | 'permission_escalation'   // Request elevated permissions
  | 'retry_with_backoff'      // Exponential backoff retry
  | 'workaround'              // Alternative approach
  | 'decompose_further'       // Break into smaller tasks
  | 'agent_collaboration'     // Consult specialist agent
  | 'human_escalation';       // Require human intervention

/**
 * Resolution applied to a blocker
 */
export interface Resolution {
  /** Strategy used for resolution */
  strategy: ResolutionStrategy;

  /** Resolution status */
  status: 'resolved' | 'failed' | 'escalated';

  /** Human-readable description of resolution */
  description: string;

  /** Timestamp when resolution was applied */
  appliedAt: ISOTimestamp;

  /** Number of retry attempts (if applicable) */
  retryCount?: number;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Learned pattern for blocker resolution
 */
export interface BlockerPattern {
  /** Error signature for matching */
  errorSignature: string;

  /** Blocker category */
  blockerCategory: BlockerCategory;

  /** Recommended resolution strategy */
  resolutionStrategy: ResolutionStrategy;

  /** Success rate (0.0-1.0) */
  successRate: number;

  /** Number of times this pattern has been seen */
  occurrences: number;

  /** Last time this pattern was encountered */
  lastSeen: ISOTimestamp;
}

/**
 * Configuration for blocker resolver
 */
export interface BlockerResolverConfig {
  /** Maximum retry attempts */
  maxRetries: number;

  /** Base backoff duration in milliseconds */
  backoffBaseMs: number;

  /** Maximum backoff duration in milliseconds */
  backoffMaxMs: number;

  /** Threshold for escalating to human */
  escalationThreshold: number;

  /** Playbook of known blocker patterns */
  playbook: BlockerPattern[];
}

// ============================================================
// Role Assignment Types
// ============================================================

/**
 * Agent roles in the swarm
 */
export type SwarmRole =
  | 'planner'      // High-level planning and coordination
  | 'researcher'   // Information gathering and analysis
  | 'builder'      // Implementation and coding
  | 'validator'    // Testing and quality assurance
  | 'coordinator'; // Cross-team orchestration

/**
 * Capability requirements for a task
 */
export interface TaskCapabilityRequirements {
  /** Required role for this task */
  requiredRole: SwarmRole;

  /** Required capabilities (e.g., 'aws-iam', 'typescript', 'cdk') */
  requiredCapabilities: string[];

  /** Preferred model tier */
  preferredModelTier?: 'fast' | 'balanced' | 'powerful';
}

/**
 * Role assignment to an agent
 */
export interface RoleAssignment {
  /** Agent identifier */
  agentId: string;

  /** Assigned role */
  role: SwarmRole;

  /** Task IDs assigned to this agent */
  taskIds: string[];

  /** Agent capabilities */
  capabilities: string[];

  /** Timestamp when role was assigned */
  assignedAt: ISOTimestamp;

  /** Current load (number of active tasks) */
  load: number;
}

/**
 * Configuration for role assigner
 */
export interface RoleAssignerConfig {
  /** Maximum tasks per agent */
  maxTasksPerAgent: number;

  /** Load balancing strategy */
  loadBalancingStrategy: 'round-robin' | 'least-loaded' | 'capability-match';

  /** Mapping of roles to required capabilities */
  roleCapabilityMap: Record<SwarmRole, string[]>;
}

// ============================================================
// Human-in-the-Loop (HITL) Types
// ============================================================

/**
 * Strategy for human involvement
 */
export type HumanLoopStrategy =
  | 'full_autonomy'   // Never ask (within safety bounds)
  | 'ask_critical'    // Ask for critical decisions only
  | 'ask_major'       // Ask for critical + major decisions
  | 'ask_all';        // Ask for all decisions

/**
 * Criticality level of a decision
 */
export type DecisionCriticality =
  | 'critical'   // High-impact, irreversible
  | 'major'      // Significant impact
  | 'minor'      // Limited scope
  | 'trivial';   // Negligible impact

/**
 * Decision requiring potential human approval
 */
export interface Decision {
  /** Unique decision identifier */
  id: string;

  /** Human-readable decision description */
  description: string;

  /** Criticality level */
  criticality: DecisionCriticality;

  /** Whether decision is reversible */
  reversible: boolean;

  /** Cost impact level */
  costImpact: 'high' | 'medium' | 'low' | 'none';

  /** Whether there's a reasonable default choice */
  hasReasonableDefault: boolean;

  /** Default choice (if hasReasonableDefault is true) */
  defaultChoice?: string;

  /** Available options (if applicable) */
  options?: string[];

  /** Additional context */
  context: Record<string, unknown>;
}

/**
 * Request for human approval
 */
export interface HITLRequest {
  /** Unique request identifier */
  id: string;

  /** Tenant identifier */
  tenantId: string;

  /** Task ID requiring approval */
  taskId: string;

  /** Decision details */
  decision: Decision;

  /** Timestamp when request was created */
  requestedAt: ISOTimestamp;

  /** Timeout duration in milliseconds */
  timeoutMs: number;

  /** Expiration timestamp */
  expiresAt: ISOTimestamp;

  /** Request status */
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'auto_resolved';
}

/**
 * Human response to a HITL request
 */
export interface HITLResponse {
  /** Request ID being responded to */
  requestId: string;

  /** Whether request was approved */
  approved: boolean;

  /** Chosen option (if applicable) */
  choice?: string;

  /** Optional feedback from human */
  feedback?: string;

  /** Timestamp of response */
  respondedAt: ISOTimestamp;
}

/**
 * Configuration for HITL gateway
 */
export interface HITLGatewayConfig {
  /** Default human loop strategy */
  defaultStrategy: HumanLoopStrategy;

  /** Default timeout in milliseconds */
  defaultTimeoutMs: number;

  /** Cost threshold requiring approval (USD) */
  costThresholdUsd: number;

  /** Auto-approve reversible decisions */
  autoApproveReversible: boolean;

  /** Notification channel (email, Slack, etc.) */
  notificationChannel?: string;
}

// ============================================================
// Progressive Refinement Types
// ============================================================

/**
 * Refinement stages from discovery to production
 */
export type RefinementStage =
  | 'discovery'   // Problem exploration
  | 'poc'         // Proof of concept
  | 'prototype'   // Working implementation
  | 'hardened'    // Production-ready with error handling
  | 'production'; // Fully operational with monitoring

/**
 * Quality gate for stage advancement
 */
export interface QualityGate {
  /** Gate name */
  name: string;

  /** Human-readable description */
  description: string;

  /** Pass/fail criteria */
  criteria: string;

  /** Whether gate has been passed */
  passed: boolean;

  /** Timestamp when evaluated */
  evaluatedAt?: ISOTimestamp;

  /** Evidence of passing (test results, logs, etc.) */
  evidence?: string;
}

/**
 * Gap preventing stage advancement
 */
export interface Gap {
  /** Gap description */
  description: string;

  /** Severity level */
  severity: 'critical' | 'major' | 'minor';

  /** Suggested fix */
  suggestedFix?: string;

  /** Whether gap blocks advancement */
  blocksAdvancement: boolean;
}

/**
 * Current refinement state for a task
 */
export interface RefinementState {
  /** Task identifier */
  taskId: string;

  /** Tenant identifier */
  tenantId: string;

  /** Current stage */
  stage: RefinementStage;

  /** Completeness score (0.0-1.0) */
  completeness: number;

  /** Quality score (0.0-1.0) */
  quality: number;

  /** Identified gaps */
  gaps: Gap[];

  /** Quality gates for current stage */
  qualityGates: QualityGate[];

  /** Number of iterations in current stage */
  iterationCount: number;

  /** Last evaluation timestamp */
  lastEvaluatedAt: ISOTimestamp;

  /** Stage transition history */
  stageHistory: Array<{
    stage: RefinementStage;
    enteredAt: ISOTimestamp;
    exitedAt?: ISOTimestamp;
    iterationsInStage: number;
  }>;
}

/**
 * Evaluation of whether task can advance to next stage
 */
export interface StageEvaluation {
  /** Current stage */
  currentStage: RefinementStage;

  /** Whether task can advance */
  canAdvance: boolean;

  /** Completeness score */
  completeness: number;

  /** Quality score */
  quality: number;

  /** Passed gate names */
  passedGates: string[];

  /** Failed gate names */
  failedGates: string[];

  /** Identified gaps */
  gaps: Gap[];

  /** Recommended next actions */
  nextActions: string[];
}

/**
 * Quality gates for each refinement stage
 */
export const STAGE_QUALITY_GATES: Record<RefinementStage, QualityGate[]> = {
  discovery: [
    {
      name: 'problem-defined',
      description: 'Problem statement is clear and scoped',
      criteria: 'Written problem statement with success criteria',
      passed: false,
    },
    {
      name: 'approaches-identified',
      description: 'Multiple solution approaches have been explored',
      criteria: 'At least 2-3 approaches documented with pros/cons',
      passed: false,
    },
    {
      name: 'constraints-documented',
      description: 'Technical and business constraints are documented',
      criteria: 'Constraints list includes budget, time, compliance',
      passed: false,
    },
  ],
  poc: [
    {
      name: 'concept-validated',
      description: 'Core concept has been validated with minimal code',
      criteria: 'Working proof-of-concept demonstrating feasibility',
      passed: false,
    },
    {
      name: 'approach-selected',
      description: 'Final approach has been selected and justified',
      criteria: 'Selected approach documented with rationale',
      passed: false,
    },
    {
      name: 'risks-identified',
      description: 'Technical risks and mitigation strategies identified',
      criteria: 'Risk register with mitigation plans',
      passed: false,
    },
  ],
  prototype: [
    {
      name: 'feature-functional',
      description: 'Core features are implemented and functional',
      criteria: 'All primary use cases work end-to-end',
      passed: false,
    },
    {
      name: 'basic-tests',
      description: 'Basic test coverage exists',
      criteria: 'Happy path tests for core features',
      passed: false,
    },
    {
      name: 'api-stable',
      description: 'API surface is defined and stable',
      criteria: 'Public interfaces documented and unlikely to change',
      passed: false,
    },
  ],
  hardened: [
    {
      name: 'error-handling',
      description: 'Comprehensive error handling implemented',
      criteria: 'All error paths handled with proper recovery',
      passed: false,
    },
    {
      name: 'test-coverage',
      description: 'High test coverage including edge cases',
      criteria: '>80% coverage including error paths',
      passed: false,
    },
    {
      name: 'documentation',
      description: 'Complete documentation for users and operators',
      criteria: 'README, API docs, runbook available',
      passed: false,
    },
    {
      name: 'security-review',
      description: 'Security review completed',
      criteria: 'OWASP top 10 addressed, no critical vulnerabilities',
      passed: false,
    },
  ],
  production: [
    {
      name: 'load-tested',
      description: 'Performance under load validated',
      criteria: 'Load tests pass at 2x expected traffic',
      passed: false,
    },
    {
      name: 'monitoring',
      description: 'Monitoring and alerting configured',
      criteria: 'CloudWatch dashboards and alarms operational',
      passed: false,
    },
    {
      name: 'rollback-plan',
      description: 'Rollback plan documented and tested',
      criteria: 'Rollback procedure documented and rehearsed',
      passed: false,
    },
    {
      name: 'runbook',
      description: 'Operational runbook complete',
      criteria: 'Troubleshooting guide and escalation paths defined',
      passed: false,
    },
  ],
};

/**
 * Configuration for progressive refiner
 */
export interface ProgressiveRefinerConfig {
  /** Maximum iterations per stage */
  maxIterationsPerStage: number;

  /** Minimum quality score to advance (0.0-1.0) */
  minQualityToAdvance: number;

  /** Minimum completeness score to advance (0.0-1.0) */
  minCompletenessToAdvance: number;

  /** Timeout per stage in milliseconds */
  stageTimeoutMs: number;

  /** Custom quality gates (optional) */
  customGates?: Record<RefinementStage, QualityGate[]>;
}

// ============================================================
// Aggregate Configuration
// ============================================================

/**
 * Complete swarm engine configuration
 */
export interface SwarmEngineConfig {
  /** Tenant identifier */
  tenantId: string;

  /** Task decomposition configuration */
  decomposition: {
    /** Default decomposition strategy */
    defaultStrategy: DecompositionStrategy;

    /** Maximum subtasks per decomposition */
    maxSubtasks: number;

    /** Maximum decomposition depth */
    maxDepth: number;
  };

  /** Blocker resolver configuration */
  blockerResolver: BlockerResolverConfig;

  /** Role assigner configuration */
  roleAssigner: RoleAssignerConfig;

  /** HITL gateway configuration */
  hitlGateway: HITLGatewayConfig;

  /** Progressive refiner configuration */
  progressiveRefiner: ProgressiveRefinerConfig;
}
