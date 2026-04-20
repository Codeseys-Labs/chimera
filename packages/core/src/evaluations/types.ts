/**
 * Public types for the AgentCore Evaluations client.
 *
 * The shape mirrors what rabbithole doc 05 describes:
 * `bedrock-agentcore:Evaluate` accepts a target (prompt/response or
 * trace id) and returns `{ label, value, explanation }`. We normalize
 * that into {@link EvaluationScore} with a numeric score in [0, 1]
 * so callers (notably `prompt-optimizer.ts`) can substitute it for
 * the existing keyword-overlap scorer without changing the return
 * contract.
 *
 * @see docs/research/agentcore-rabbithole/05-observability-evaluations-deep-dive.md
 */

/**
 * Which AgentCore built-in evaluator to use.
 *
 * Chosen subset of the 14 built-ins most relevant to the prompt-optimizer
 * flywheel; `Correctness` is the default LLM-as-judge score.
 */
export type EvaluatorType =
  /** TRACE-level: does the response correctly answer the prompt. */
  | 'Correctness'
  /** TOOL_CALL-level: did the agent pick the right tool. */
  | 'ToolSelectionAccuracy'
  /** SESSION-level: did the conversation achieve its goal. */
  | 'GoalSuccessRate';

/**
 * Input to {@link AgentCoreEvaluationsClient.scoreResponse}.
 *
 * The client is stateless: every call carries its own prompt+response
 * pair. Callers that want to evaluate live production traces should
 * fall back to the raw `Evaluate` API with `evaluationTarget.traceIds`;
 * this surface is tuned for the synthetic-test-case path in
 * `prompt-optimizer.ts::runTestCase()`.
 */
export interface EvaluationRequest {
  /** The prompt shown to the agent. */
  prompt: string;
  /** The response the agent produced. */
  response: string;
  /** Which built-in evaluator to use. */
  evaluatorType: EvaluatorType;
}

/**
 * Normalized evaluator output.
 *
 * `score` is always a finite number in [0, 1]; values outside that
 * range are clamped by the client. `explanation` is the judge model's
 * rationale when available. `metadata` carries the raw SDK response
 * envelope for callers that want to record it for debugging.
 */
export interface EvaluationScore {
  /** Score in [0, 1]. Higher is better. */
  score: number;
  /** Optional free-text rationale from the judge. */
  explanation?: string;
  /** Optional raw/structured data from the SDK response. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Error classes (Registry-style: one base + typed subclasses)
// ---------------------------------------------------------------------------

/**
 * Base class for all errors raised by the evaluations client.
 * Subclasses map to specific AWS error categories.
 */
export class EvaluationsError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'EvaluationsError';
  }
}

/**
 * Raised when the AgentCore Evaluations resource referenced by
 * `EVALUATIONS_ID` (or an ad-hoc evaluator) cannot be located.
 *
 * Maps from SDK errors like `ResourceNotFoundException` and
 * `EvaluatorNotFoundException`.
 */
export class EvaluationsNotFoundError extends EvaluationsError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'EvaluationsNotFoundError';
  }
}

/**
 * Raised when the caller lacks IAM permissions to invoke
 * `bedrock-agentcore:Evaluate`, when credentials are missing, or
 * when the SDK cannot be loaded because the package is not installed.
 *
 * Maps from SDK errors like `AccessDeniedException`,
 * `UnrecognizedClientException`, and from module-resolution failures
 * (the client is dynamically imported to avoid requiring the package
 * at install time).
 */
export class EvaluationsAuthError extends EvaluationsError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'EvaluationsAuthError';
  }
}

/**
 * Raised when the service is reachable but unable to service the
 * request right now — throttling, 5xx, timeouts.
 *
 * The client does NOT auto-retry; callers (typically the
 * prompt-optimizer fallback path) decide whether to swallow this
 * and fall back to keyword overlap.
 */
export class EvaluationsUnavailableError extends EvaluationsError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'EvaluationsUnavailableError';
  }
}
