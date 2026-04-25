/**
 * Decomposition provider abstraction
 *
 * The `TaskDecomposer` class delegates the actual "turn a vague request into
 * subtasks" step to a pluggable provider. Two implementations ship:
 *
 *   - `HeuristicDecompositionProvider` (default) — the original fixed-template
 *     strategies. No network, no cost, deterministic. Good for tests and
 *     for callers that can't or won't invoke Bedrock.
 *   - `LlmDecompositionProvider` — invokes Bedrock Claude/Nova via the
 *     Converse API, returns LLM-generated subtasks with dependencies,
 *     validation criteria, and rollback guidance.
 *
 * The decomposer tries the injected primary provider and falls back to the
 * heuristic on failure so LLM hiccups never surface as task-execution
 * failures — they just mean the user gets a less-refined decomposition.
 *
 * Wave 24 — closes chimera-76b9.
 */

import type {
  DecompositionContext,
  DecompositionStrategy,
  Subtask,
} from './types';

/**
 * Result of a single decomposition call. `modelId` and `usage` are set only
 * for LLM providers; omit for heuristic.
 */
export interface DecompositionProviderResult {
  subtasks: Subtask[];
  modelId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface DecompositionProvider {
  readonly kind: 'heuristic' | 'llm';
  decompose(
    request: string,
    context: DecompositionContext,
    strategy: DecompositionStrategy,
  ): Promise<DecompositionProviderResult>;
}
