/**
 * Composite Fitness & Pareto Dominance (chimera-606c Phase 1)
 *
 * Implements the multi-objective fitness scoring and winner selection
 * used by prompt A/B experiments. Design doc:
 * `docs/designs/chimera-606c-dgm-evolution-integration.md` §3.1, §3.4, §4.
 *
 * Pure functions with no I/O — safe to import from Lambdas, Step Function
 * tasks, and the prompt-optimizer winner-selection path.
 */

import type { CompositeFitness, FitnessWeights, ISOTimestamp } from './types';

/**
 * Raw metrics produced by the TestVariant step of `PromptEvolutionPipeline`.
 * These are the inputs to `computeCompositeFitness`.
 */
export interface RawFitnessMetrics {
  /** 0.0–1.0, from golden-dataset pass rate */
  taskSuccessRate: number;
  /** USD per 1,000 interactions */
  costPer1kInteractions: number;
  /** p95 latency in ms */
  p95LatencyMs: number;
  /**
   * User satisfaction rate (0.0–1.0).
   * Pass `-1` when no live-traffic signal exists yet — the neutral prior
   * (0.5) will be substituted. Also substituted when `sampleSize < 5`.
   */
  userSatisfactionRate?: number;
  /** Number of evaluation samples backing these metrics */
  sampleSize: number;
}

/**
 * Per-tenant baselines used to normalize "lower is better" axes into
 * [0, 1] scores. Pulled from MODEL_ROUTING or env defaults.
 */
export interface FitnessBaselines {
  /** Baseline cost per 1k interactions (USD) — e.g., current control's cost */
  cost: number;
  /** Baseline p95 latency (ms) — e.g., current control's latency */
  latencyMs: number;
}

/**
 * Sample-size threshold below which we use the neutral prior for
 * `userSatisfactionRate`. Also flagged as `insufficient_live_data` at
 * the caller level. See design doc §4.
 */
const MIN_SATISFACTION_SAMPLE_SIZE = 5;

/**
 * Cold-start sample-size threshold. Below this, winner selection requires
 * a stricter compositeScore margin (see `selectWinner`). Design doc §3.4.
 */
const COLD_START_SAMPLE_SIZE = 10;

/**
 * Required margin over control.compositeScore for a cold-start variant
 * to win (3% improvement).
 */
const COLD_START_MARGIN = 1.03;

/**
 * Neutral prior for user satisfaction when no/insufficient live data.
 */
const NEUTRAL_SATISFACTION_PRIOR = 0.5;

/**
 * Normalize a "lower is better" metric against a baseline into [0, 1].
 *
 * - `x / (baseline * 2) → 1.0` means x is 2x baseline (worst useful value)
 * - `baseline → 0.5`
 * - `0 → 0.0` (free/instant)
 *
 * We cap at 1.0 so runaway cost/latency doesn't dominate the score.
 */
function normalizeLowerIsBetter(x: number, baseline: number): number {
  if (baseline <= 0) {
    // Degenerate baseline → treat metric as at-baseline (neutral).
    return 0.5;
  }
  return Math.min(x / (baseline * 2), 1.0);
}

/**
 * Compute `CompositeFitness` from raw metrics using a normalized
 * weighted-sum formula. See design doc §4:
 *
 * ```
 * composite_score =
 *     w.taskSuccess   * taskSuccessRate
 *   + w.cost          * (1 - normalize(costPer1k, baseline_cost))
 *   + w.latency       * (1 - normalize(p95LatencyMs, baseline_latency))
 *   + w.satisfaction  * userSatisfactionRate
 * ```
 *
 * @param rawMetrics - output of the TestVariant step
 * @param weights    - tenant-configurable weights (sum ~= 1.0)
 * @param baselines  - control's cost/latency for normalization
 * @returns         `CompositeFitness` with `compositeScore` in [0, 1]
 */
export function computeCompositeFitness(
  rawMetrics: RawFitnessMetrics,
  weights: FitnessWeights,
  baselines: FitnessBaselines,
): CompositeFitness {
  const rawSatisfaction = rawMetrics.userSatisfactionRate ?? -1;
  const useNeutralPrior =
    rawSatisfaction === -1 || rawMetrics.sampleSize < MIN_SATISFACTION_SAMPLE_SIZE;
  const satisfaction = useNeutralPrior ? NEUTRAL_SATISFACTION_PRIOR : rawSatisfaction;

  const costNorm = normalizeLowerIsBetter(rawMetrics.costPer1kInteractions, baselines.cost);
  const latencyNorm = normalizeLowerIsBetter(rawMetrics.p95LatencyMs, baselines.latencyMs);

  const compositeScore =
    weights.taskSuccessRate * rawMetrics.taskSuccessRate +
    weights.costEfficiency * (1 - costNorm) +
    weights.latencyEfficiency * (1 - latencyNorm) +
    weights.userSatisfaction * satisfaction;

  const computedAt: ISOTimestamp = new Date().toISOString();

  return {
    taskSuccessRate: rawMetrics.taskSuccessRate,
    costPer1kInteractions: rawMetrics.costPer1kInteractions,
    p95LatencyMs: rawMetrics.p95LatencyMs,
    // Preserve the raw signal in the stored record so downstream can tell
    // "we used a prior" from "satisfaction is actually 0.5".
    userSatisfactionRate: rawSatisfaction,
    sampleSize: rawMetrics.sampleSize,
    compositeScore,
    computedAt,
  };
}

/**
 * Pareto dominance test: does `b` dominate `a`?
 *
 * B dominates A iff B is ≥ A on every objective AND strictly better on
 * at least one. Objectives:
 *   - taskSuccessRate      (higher is better)
 *   - userSatisfactionRate (higher is better)
 *   - costPer1kInteractions (lower is better)
 *   - p95LatencyMs         (lower is better)
 *
 * Used by `selectWinner` to pick A/B test winners without collapsing
 * everything into a single scalar.
 */
export function paretoDominates(a: CompositeFitness, b: CompositeFitness): boolean {
  // B must be no worse than A on every axis.
  const bIsNoWorse =
    b.taskSuccessRate >= a.taskSuccessRate &&
    b.userSatisfactionRate >= a.userSatisfactionRate &&
    b.costPer1kInteractions <= a.costPer1kInteractions &&
    b.p95LatencyMs <= a.p95LatencyMs;

  if (!bIsNoWorse) return false;

  // B must be strictly better on at least one axis.
  const bIsStrictlyBetter =
    b.taskSuccessRate > a.taskSuccessRate ||
    b.userSatisfactionRate > a.userSatisfactionRate ||
    b.costPer1kInteractions < a.costPer1kInteractions ||
    b.p95LatencyMs < a.p95LatencyMs;

  return bIsStrictlyBetter;
}

/**
 * Pareto-based winner selection for an A/B experiment (2 variants).
 *
 * Semantics:
 *   - Missing control → variant wins by default (bootstrapping case).
 *   - Missing variant → control wins by default.
 *   - Variant Pareto-dominates control → 'variant'.
 *   - Control Pareto-dominates variant → 'control'.
 *   - Otherwise (mixed wins) → fallback to scalar `compositeScore`.
 *
 * Cold-start fallback: if `variant.sampleSize < 10`, we require a
 * `compositeScore > control * 1.03` (3% margin) for the variant to win.
 * This prevents spurious promotions on thin data. Design doc §3.4.
 */
export function selectWinner(
  control: CompositeFitness | null,
  variant: CompositeFitness | null,
): 'control' | 'variant' | 'tie' {
  if (!control && !variant) return 'tie';
  if (!control && variant) return 'variant';
  if (control && !variant) return 'control';
  // Both non-null past this point — narrow with a pair of locals so TS is happy.
  const c = control as CompositeFitness;
  const v = variant as CompositeFitness;

  const isColdStart = v.sampleSize < COLD_START_SAMPLE_SIZE;

  // Strict Pareto dominance first.
  if (paretoDominates(c, v)) {
    // Variant dominates. Apply cold-start margin check.
    if (isColdStart && v.compositeScore <= c.compositeScore * COLD_START_MARGIN) {
      return 'control';
    }
    return 'variant';
  }
  if (paretoDominates(v, c)) {
    return 'control';
  }

  // Mixed/incomparable (each wins on some axes). Fall back to composite
  // scalar with the same cold-start margin.
  const margin = isColdStart ? COLD_START_MARGIN : 1.0;
  if (v.compositeScore > c.compositeScore * margin) return 'variant';
  if (c.compositeScore > v.compositeScore) return 'control';
  return 'tie';
}
