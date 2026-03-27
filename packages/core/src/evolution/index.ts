/**
 * Evolution Engine Module
 *
 * Self-evolution capabilities for AWS Chimera:
 * - Prompt A/B testing and optimization
 * - Bayesian model routing
 * - Auto-skill generation from patterns
 * - Infrastructure self-modification (GitOps)
 * - ML experiment orchestration
 * - Safety guardrails with Cedar policies
 *
 * @packageDocumentation
 */

// Core types
export * from './types';

// Safety harness
export {
  EvolutionSafetyHarness,
  createSafetyHarness,
} from './safety-harness';

// Model routing
export {
  ModelRouter,
  createModelRouter,
} from './model-router';

// Prompt optimization
export {
  PromptOptimizer,
  createPromptOptimizer,
} from './prompt-optimizer';

// Auto-skill generation
export {
  AutoSkillGenerator,
  createAutoSkillGenerator,
} from './auto-skill-gen';

// Infrastructure modification
export {
  InfrastructureModifier,
  createInfrastructureModifier,
} from './iac-modifier';

// ML experiment runner
export {
  ExperimentRunner,
  createExperimentRunner,
  type ExperimentConfig,
  type ExperimentTrial,
  type ExperimentStatus,
} from './experiment-runner';

// Self-evolution orchestrator (full generate → commit → deploy → register flow)
export {
  SelfEvolutionOrchestrator,
  createSelfEvolutionOrchestrator,
  type EvolutionRequest,
  type EvolutionResult,
  type SelfEvolutionConfig,
} from './self-evolution-orchestrator';

// Self-reflection and health monitoring
export {
  calculateHealthScore,
  analyzeEvolutionTrends,
  generateReflectionInsights,
  shouldThrottleEvolution,
  recommendEvolutionActions,
  type TrendAnalysis,
  type ReflectionInsights,
  type ThrottleDecision,
  type EvolutionRecommendation,
} from './self-reflection';
