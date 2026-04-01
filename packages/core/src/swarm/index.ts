/**
 * Swarm Module - Autonomous Agent Problem-Solving
 *
 * Provides advanced autonomous capabilities for agent swarms:
 * - Task decomposition (vague → concrete subtasks)
 * - Blocker detection and resolution
 * - Role assignment (planner, researcher, builder, validator)
 * - Human-in-the-loop decision gateway (when to escalate vs. proceed)
 * - Progressive refinement (POC → Staging → Production)
 *
 * Based on research:
 * - docs/research/aws-account-agent/01-Task-Decomposition.md
 * - docs/research/aws-account-agent/02-Blocker-Detection-Resolution.md
 * - docs/research/aws-account-agent/03-Role-Assignment.md
 * - docs/research/aws-account-agent/04-HITL-Gateway.md
 * - docs/research/aws-account-agent/05-Progressive-Refinement.md
 *
 * Architecture:
 * - HITLGateway: Decision policy engine for autonomous vs. human approval
 * - ProgressiveRefiner: Iterative development with learning loops
 *
 * @packageDocumentation
 */

// ============================================================
// Canonical Types (from types.ts)
// ============================================================
// These are the authoritative type definitions used across all modules

export type {
  // Task Decomposition
  DecompositionStrategy,
  TaskStatus,
  TaskPriority,
  Subtask,
  DecompositionContext,
  DecompositionResult,

  // Blocker Resolution
  BlockerCategory,
  BlockerSeverity,
  Blocker,
  ResolutionStrategy,
  Resolution,
  BlockerPattern,
  BlockerResolverConfig,

  // Role Assignment
  SwarmRole,
  TaskCapabilityRequirements,
  RoleAssignment,
  RoleAssignerConfig,

  // Human-in-the-Loop
  HumanLoopStrategy,
  DecisionCriticality,
  Decision,
  HITLRequest,
  HITLResponse,
  HITLGatewayConfig,

  // Progressive Refinement
  RefinementStage,
  QualityGate,
  Gap,
  RefinementState,
  StageEvaluation,
  ProgressiveRefinerConfig,

  // Swarm Engine
  SwarmEngineConfig,
} from './types';

export { STAGE_QUALITY_GATES } from './types';

// ============================================================
// Task Decomposer
// ============================================================

export {
  TaskDecomposer,
  createTaskDecomposer,
  type DecomposerConfig,
} from './task-decomposer';

// ============================================================
// Blocker Resolver
// ============================================================
// Note: Blocker, ResolutionStrategy, BlockerPattern types come from types.ts
// Module-specific types exported here

export {
  BlockerResolver,
  createBlockerResolver,
  // Module-specific types (not in types.ts)
  type BlockerType,
  type ResolutionAttempt as BlockerResolutionAttempt,
  type ResolutionResult,
} from './blocker-resolver';

// ============================================================
// Role Assigner
// ============================================================
// Note: RoleAssignment type comes from types.ts
// Module-specific types exported here

export {
  RoleAssigner,
  createRoleAssigner,
  // Module-specific types (not in types.ts)
  type AgentRole,
  type TaskCharacteristics,
  type AgentCapabilities,
  type RoleAssignmentResult,
  type RolePerformance,
} from './role-assigner';

// ============================================================
// Human-in-the-Loop Gateway
// ============================================================

export {
  HITLGateway,
  createHITLGateway,
  type EscalationUrgency,
  type Environment,
  type TaskContext,
  type HITLDecision,
  type EscalationRequest,
  type ResolutionAttempt as HITLResolutionAttempt,
  type HumanResponse,
  type HITLPolicyConfig,
  type HITLDDBClient,
  type ApprovalRecord,
} from './hitl-gateway';

// ============================================================
// Progressive Refiner
// ============================================================
// Note: RefinementStage, ProgressiveRefinerConfig types come from types.ts
// Module-specific types exported here

export {
  ProgressiveRefiner,
  createProgressiveRefiner,
  type StageStatus,
  type StageLearning,
  type StageTask,
  type StageResult,
  type ProductionReadinessChecklist,
} from './progressive-refiner';
