/**
 * AgentCore Evaluations integration.
 *
 * Flag-gated LLM-as-judge scoring used by `evolution/prompt-optimizer.ts`
 * as a real-quality replacement for the keyword-overlap scorer. Default
 * behavior (flag off) is unchanged — the keyword overlap path remains
 * the guaranteed fallback.
 *
 * @packageDocumentation
 */

export {
  getEvaluationsFlags,
  assertEvaluationsFlagsConsistent,
  EvaluationsFlagConsistencyError,
  type EvaluationsFeatureFlags,
} from './feature-flags';

export {
  EvaluationsError,
  EvaluationsNotFoundError,
  EvaluationsAuthError,
  EvaluationsUnavailableError,
  type EvaluationRequest,
  type EvaluationScore,
  type EvaluatorType,
} from './types';

export {
  AgentCoreEvaluationsClient,
  createEvaluationsClient,
  type AgentCoreEvaluationsClientOptions,
  type AgentCoreSdkClient,
  type AgentCoreSdkClientFactory,
} from './agentcore-evaluations-client';
