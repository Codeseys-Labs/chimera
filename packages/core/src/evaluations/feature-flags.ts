/**
 * Feature flags for AgentCore Evaluations integration.
 *
 * This module mirrors the "Registry" pattern used elsewhere in the codebase:
 * a small bundle of env-sourced switches with a consistency asserter that
 * the caller invokes when they actually intend to use the feature.
 *
 * Defaults are OFF so that production behavior is unchanged until the
 * operator explicitly opts in. The flag-gated branch in
 * `packages/core/src/evolution/prompt-optimizer.ts` reads these at call
 * time (via `getEvaluationsFlags()`), not at module load, so tests and
 * runtime callers can flip `process.env` without re-importing.
 *
 * @see docs/research/agentcore-rabbithole/05-observability-evaluations-deep-dive.md
 */

/**
 * Materialized feature-flag snapshot.
 *
 * Callers should treat instances as immutable value objects. Use
 * `getEvaluationsFlags()` to produce a fresh snapshot at each decision
 * point; env-var re-reads are cheap.
 */
export interface EvaluationsFeatureFlags {
  /** Master switch. When false, no AgentCore Evaluations code path executes. */
  evaluationsEnabled: boolean;

  /**
   * Bedrock model ID used as the LLM-as-judge.
   * Example: "us.anthropic.claude-sonnet-4-6-v1:0".
   *
   * May be empty string when {@link evaluationsEnabled} is false.
   */
  judgeModel: string;

  /**
   * AgentCore Evaluation resource ID (from `CreateEvaluator`).
   * May be empty string in deployments that don't require a pre-registered
   * evaluator resource (e.g., ad-hoc on-demand runs).
   */
  evaluationsId: string;

  /** AWS region hosting the evaluation resource. Falls back to AWS_REGION. */
  region: string;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function readBool(name: string): boolean {
  const raw = process.env[name];
  if (raw == null) {
    return false;
  }
  return TRUTHY.has(raw.trim().toLowerCase());
}

function readString(name: string, fallback = ''): string {
  const raw = process.env[name];
  if (raw == null) {
    return fallback;
  }
  return raw.trim();
}

/**
 * Produce a fresh flag snapshot from `process.env`.
 *
 * Reads:
 * - `EVALUATIONS_ENABLED` (master switch, default off)
 * - `EVALUATIONS_JUDGE_MODEL`
 * - `EVALUATIONS_ID`
 * - `EVALUATIONS_REGION` (fallback to `AWS_REGION`)
 */
export function getEvaluationsFlags(): EvaluationsFeatureFlags {
  return {
    evaluationsEnabled: readBool('EVALUATIONS_ENABLED'),
    judgeModel: readString('EVALUATIONS_JUDGE_MODEL'),
    evaluationsId: readString('EVALUATIONS_ID'),
    region: readString('EVALUATIONS_REGION', readString('AWS_REGION')),
  };
}

/**
 * Thrown by {@link assertEvaluationsFlagsConsistent} when the flag
 * surface is in an invalid combination (e.g., enabled but no judge model).
 */
export class EvaluationsFlagConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationsFlagConsistencyError';
  }
}

/**
 * Validate that the flag bundle is internally consistent.
 *
 * Rules:
 * - When `evaluationsEnabled` is false, no other flag is required.
 * - When `evaluationsEnabled` is true:
 *   - `judgeModel` MUST be set (the judge LLM id).
 *   - `region` MUST be set (either `EVALUATIONS_REGION` or `AWS_REGION`).
 *   - `evaluationsId` is optional; an empty string is treated as
 *     "use ad-hoc / default evaluator" rather than a hard error.
 *
 * Called from `scoreResponse()` before any network I/O and from
 * `prompt-optimizer.ts` when the flag branch is taken. This is the
 * canonical place for "misconfigured" diagnostics — callers should
 * not re-implement the rules.
 */
export function assertEvaluationsFlagsConsistent(
  flags: EvaluationsFeatureFlags = getEvaluationsFlags()
): void {
  if (!flags.evaluationsEnabled) {
    return;
  }

  const missing: string[] = [];
  if (!flags.judgeModel) {
    missing.push('EVALUATIONS_JUDGE_MODEL');
  }
  if (!flags.region) {
    missing.push('EVALUATIONS_REGION (or AWS_REGION)');
  }

  if (missing.length > 0) {
    throw new EvaluationsFlagConsistencyError(
      `EVALUATIONS_ENABLED=true but required flags are unset: ${missing.join(', ')}`
    );
  }
}
