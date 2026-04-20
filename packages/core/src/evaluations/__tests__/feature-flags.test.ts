/**
 * Unit tests for evaluations/feature-flags.ts
 *
 * Covers:
 * - Default (all env unset) → master switch is OFF.
 * - Truthy parsing of EVALUATIONS_ENABLED.
 * - Consistency rules: enabled without judge/region → throw;
 *   enabled with both → pass; empty evaluationsId is allowed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  assertEvaluationsFlagsConsistent,
  EvaluationsFlagConsistencyError,
  getEvaluationsFlags,
} from '../feature-flags';

const KEYS = [
  'EVALUATIONS_ENABLED',
  'EVALUATIONS_JUDGE_MODEL',
  'EVALUATIONS_ID',
  'EVALUATIONS_REGION',
  'AWS_REGION',
] as const;

const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) snapshot[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe('getEvaluationsFlags (default off)', () => {
  it('returns evaluationsEnabled=false when env is empty', () => {
    const f = getEvaluationsFlags();
    expect(f.evaluationsEnabled).toBe(false);
    expect(f.judgeModel).toBe('');
    expect(f.evaluationsId).toBe('');
    expect(f.region).toBe('');
  });

  it('treats non-truthy values as false', () => {
    process.env.EVALUATIONS_ENABLED = 'false';
    expect(getEvaluationsFlags().evaluationsEnabled).toBe(false);
    process.env.EVALUATIONS_ENABLED = '0';
    expect(getEvaluationsFlags().evaluationsEnabled).toBe(false);
    process.env.EVALUATIONS_ENABLED = 'No';
    expect(getEvaluationsFlags().evaluationsEnabled).toBe(false);
    process.env.EVALUATIONS_ENABLED = '';
    expect(getEvaluationsFlags().evaluationsEnabled).toBe(false);
  });

  it('accepts multiple truthy spellings', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.EVALUATIONS_ENABLED = v;
      expect(getEvaluationsFlags().evaluationsEnabled).toBe(true);
    }
  });

  it('falls back to AWS_REGION when EVALUATIONS_REGION is unset', () => {
    process.env.AWS_REGION = 'us-west-2';
    expect(getEvaluationsFlags().region).toBe('us-west-2');
  });

  it('prefers EVALUATIONS_REGION over AWS_REGION', () => {
    process.env.AWS_REGION = 'us-west-2';
    process.env.EVALUATIONS_REGION = 'us-east-1';
    expect(getEvaluationsFlags().region).toBe('us-east-1');
  });
});

describe('assertEvaluationsFlagsConsistent', () => {
  it('is a no-op when the master switch is off', () => {
    expect(() => assertEvaluationsFlagsConsistent()).not.toThrow();
  });

  it('throws when enabled but judge model is missing', () => {
    process.env.EVALUATIONS_ENABLED = 'true';
    process.env.AWS_REGION = 'us-east-1';
    expect(() => assertEvaluationsFlagsConsistent()).toThrow(
      EvaluationsFlagConsistencyError
    );
  });

  it('throws when enabled but region is missing', () => {
    process.env.EVALUATIONS_ENABLED = 'true';
    process.env.EVALUATIONS_JUDGE_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    expect(() => assertEvaluationsFlagsConsistent()).toThrow(
      EvaluationsFlagConsistencyError
    );
  });

  it('passes when enabled with both judge model and region', () => {
    process.env.EVALUATIONS_ENABLED = 'true';
    process.env.EVALUATIONS_JUDGE_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    process.env.EVALUATIONS_REGION = 'us-east-1';
    expect(() => assertEvaluationsFlagsConsistent()).not.toThrow();
  });

  it('treats missing EVALUATIONS_ID as allowed (ad-hoc mode)', () => {
    process.env.EVALUATIONS_ENABLED = 'true';
    process.env.EVALUATIONS_JUDGE_MODEL = 'm';
    process.env.AWS_REGION = 'us-east-1';
    expect(() => assertEvaluationsFlagsConsistent()).not.toThrow();
  });

  it('accepts an explicit flag object without reading env', () => {
    expect(() =>
      assertEvaluationsFlagsConsistent({
        evaluationsEnabled: true,
        judgeModel: 'm',
        evaluationsId: '',
        region: 'us-east-1',
      })
    ).not.toThrow();
  });

  it('lists all missing flags in the error message', () => {
    process.env.EVALUATIONS_ENABLED = 'true';
    let caught: unknown;
    try {
      assertEvaluationsFlagsConsistent();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EvaluationsFlagConsistencyError);
    const msg = (caught as Error).message;
    expect(msg).toContain('EVALUATIONS_JUDGE_MODEL');
    expect(msg).toContain('EVALUATIONS_REGION');
  });
});
