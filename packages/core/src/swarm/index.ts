/**
 * Swarm Module - Autonomous Agent Problem-Solving
 *
 * Provides advanced autonomous capabilities for agent swarms:
 * - Human-in-the-loop decision gateway (when to escalate vs. proceed)
 * - Progressive refinement (POC → Staging → Production)
 *
 * Based on research:
 * - docs/research/aws-account-agent/01-Task-Decomposition.md
 * - docs/research/aws-account-agent/02-Blocker-Detection-Resolution.md
 *
 * Architecture:
 * - HITLGateway: Decision policy engine for autonomous vs. human approval
 * - ProgressiveRefiner: Iterative development with learning loops
 *
 * @packageDocumentation
 */

// Human-in-the-Loop Gateway
export {
  HITLGateway,
  createHITLGateway,
  type EscalationUrgency,
  type Environment,
  type TaskContext,
  type HITLDecision,
  type EscalationRequest,
  type ResolutionAttempt,
  type HumanResponse,
  type HITLPolicyConfig
} from './hitl-gateway';

// Progressive Refiner
export {
  ProgressiveRefiner,
  createProgressiveRefiner,
  type RefinementStage,
  type StageStatus,
  type StageLearning,
  type StageTask,
  type StageResult,
  type ProductionReadinessChecklist,
  type ProgressiveRefinerConfig
} from './progressive-refiner';
