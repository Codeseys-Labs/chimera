/**
 * Unit tests for composite-fitness (chimera-606c Phase 1)
 *
 * Covers:
 *   1. Weighted-sum math (exact score to 1e-9)
 *   2. Pareto dominance — strict improvement on all axes
 *   3. Pareto non-dominance — regression on one axis
 *   4. Cold-start fallback (sampleSize < 10, small margin → control wins)
 *   5. Neutral prior for missing userSatisfaction
 */

import { describe, it, expect } from 'bun:test';
import {
  computeCompositeFitness,
  paretoDominates,
  selectWinner,
  type RawFitnessMetrics,
  type FitnessBaselines,
} from '../composite-fitness';
import { DEFAULT_FITNESS_WEIGHTS, type CompositeFitness } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baselines: FitnessBaselines = {
  cost: 1.0, // $1 per 1k interactions
  latencyMs: 1000, // 1s p95
};

/**
 * Build a `CompositeFitness` fixture without going through the compute
 * function — lets us target specific Pareto geometry in tests.
 */
function mkFitness(overrides: Partial<CompositeFitness> = {}): CompositeFitness {
  return {
    taskSuccessRate: 0.8,
    costPer1kInteractions: 1.0,
    p95LatencyMs: 1000,
    userSatisfactionRate: 0.8,
    sampleSize: 100,
    compositeScore: 0.7,
    computedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Weighted-sum math
// ---------------------------------------------------------------------------

describe('computeCompositeFitness — weighted sum', () => {
  it('computes compositeScore exactly per §4 formula', () => {
    // With:
    //   taskSuccessRate = 0.9, satisfaction = 0.8, sampleSize = 100
    //   cost = 0.5 (half baseline) → costNorm = 0.25 → (1 - 0.25) = 0.75
    //   latency = 1500 (1.5x baseline) → latNorm = 0.75 → (1 - 0.75) = 0.25
    //   weights = 0.40 / 0.25 / 0.20 / 0.15
    //
    //   score = 0.40 * 0.9 + 0.25 * 0.75 + 0.20 * 0.25 + 0.15 * 0.8
    //         = 0.36 + 0.1875 + 0.05 + 0.12
    //         = 0.7175
    const raw: RawFitnessMetrics = {
      taskSuccessRate: 0.9,
      costPer1kInteractions: 0.5,
      p95LatencyMs: 1500,
      userSatisfactionRate: 0.8,
      sampleSize: 100,
    };
    const result = computeCompositeFitness(raw, DEFAULT_FITNESS_WEIGHTS, baselines);
    expect(result.compositeScore).toBeCloseTo(0.7175, 9);
    expect(result.taskSuccessRate).toBe(0.9);
    expect(result.sampleSize).toBe(100);
    // userSatisfactionRate is the raw input (preserved), not the prior.
    expect(result.userSatisfactionRate).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// 2. Pareto dominance — B strictly better on all axes
// ---------------------------------------------------------------------------

describe('paretoDominates — B better everywhere', () => {
  it('returns true when B improves on every objective', () => {
    const a = mkFitness({
      taskSuccessRate: 0.70,
      costPer1kInteractions: 1.00,
      p95LatencyMs: 1000,
      userSatisfactionRate: 0.70,
      compositeScore: 0.6,
    });
    const b = mkFitness({
      taskSuccessRate: 0.85, // higher
      costPer1kInteractions: 0.60, // lower
      p95LatencyMs: 800, // lower
      userSatisfactionRate: 0.82, // higher
      compositeScore: 0.8,
    });
    expect(paretoDominates(a, b)).toBe(true);
    // And symmetric: A does not dominate B.
    expect(paretoDominates(b, a)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Pareto non-dominance — B regresses on one axis
// ---------------------------------------------------------------------------

describe('paretoDominates — B regresses on one axis', () => {
  it('returns false when B is worse on even one objective', () => {
    const a = mkFitness({
      taskSuccessRate: 0.80,
      costPer1kInteractions: 1.00,
      p95LatencyMs: 1000,
      userSatisfactionRate: 0.80,
    });
    const b = mkFitness({
      taskSuccessRate: 0.90, // better
      costPer1kInteractions: 0.80, // better
      p95LatencyMs: 1200, // WORSE (higher latency)
      userSatisfactionRate: 0.82, // better
    });
    expect(paretoDominates(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Cold-start fallback
// ---------------------------------------------------------------------------

describe('selectWinner — cold-start fallback', () => {
  it('returns control when variant has <10 samples and margin <3%', () => {
    // Variant Pareto-dominates on score but only by ~1.5%, and has only
    // 8 samples. Cold-start rule requires >3% margin → control retained.
    const control = mkFitness({
      taskSuccessRate: 0.80,
      costPer1kInteractions: 1.00,
      p95LatencyMs: 1000,
      userSatisfactionRate: 0.80,
      sampleSize: 200,
      compositeScore: 0.70,
    });
    const variant = mkFitness({
      taskSuccessRate: 0.81, // marginally better
      costPer1kInteractions: 0.99,
      p95LatencyMs: 995,
      userSatisfactionRate: 0.81,
      sampleSize: 8, // cold-start!
      compositeScore: 0.71055, // ~1.5% above control
    });
    expect(selectWinner(control, variant)).toBe('control');

    // Sanity check: with ≥10 samples, that same delta would make variant win.
    const variantWarm = { ...variant, sampleSize: 50 };
    expect(selectWinner(control, variantWarm)).toBe('variant');
  });
});

// ---------------------------------------------------------------------------
// 5. Neutral prior for missing userSatisfaction
// ---------------------------------------------------------------------------

describe('computeCompositeFitness — neutral prior', () => {
  it('substitutes 0.5 for userSatisfaction when rate is -1', () => {
    // taskSuccessRate=1.0, cost=baseline (0.5 norm), latency=baseline (0.5 norm)
    //   costContrib = 0.25 * (1 - 0.5) = 0.125
    //   latContrib  = 0.20 * (1 - 0.5) = 0.100
    //   taskContrib = 0.40 * 1.0       = 0.400
    //   satContrib  = 0.15 * 0.5       = 0.075  ← neutral prior, NOT -1
    //   total = 0.700
    const raw: RawFitnessMetrics = {
      taskSuccessRate: 1.0,
      costPer1kInteractions: 1.0,
      p95LatencyMs: 1000,
      userSatisfactionRate: -1, // no live signal
      sampleSize: 100, // large enough to not trigger sample-size prior
    };
    const result = computeCompositeFitness(raw, DEFAULT_FITNESS_WEIGHTS, baselines);
    expect(result.compositeScore).toBeCloseTo(0.7, 9);
    // Raw signal preserved on the record so callers can tell.
    expect(result.userSatisfactionRate).toBe(-1);
  });

  it('substitutes 0.5 for userSatisfaction when sampleSize < 5', () => {
    // Same as above but sampleSize=3 — prior should kick in even though
    // the reported satisfaction is a "real" 0.9.
    const raw: RawFitnessMetrics = {
      taskSuccessRate: 1.0,
      costPer1kInteractions: 1.0,
      p95LatencyMs: 1000,
      userSatisfactionRate: 0.9, // real but unreliable
      sampleSize: 3,
    };
    const result = computeCompositeFitness(raw, DEFAULT_FITNESS_WEIGHTS, baselines);
    // Should use 0.5, not 0.9 → same 0.7 score as above.
    expect(result.compositeScore).toBeCloseTo(0.7, 9);
    // Raw signal still preserved.
    expect(result.userSatisfactionRate).toBe(0.9);
  });
});
