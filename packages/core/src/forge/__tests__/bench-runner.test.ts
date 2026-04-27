/**
 * Bench runner shape tests.
 *
 * Phase 1 Day 1 scope: run `runBenchTask` against the baseline harness with a
 * mock task + mock runner, assert the returned `TaskResult` shape matches the
 * contract in `bench/v0/runner.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { BaselineHarness } from '../candidates/baseline_harness';
import type { HarnessResult } from '../harness-interface';
import { runBenchTask } from '../bench/v0/runner';
import { BENCH_V0_SEED_TASKS } from '../bench/v0/tasks';
import type { BenchTask } from '../bench/v0/tasks';

function mockRunner(partial: Partial<HarnessResult>) {
  const base: HarnessResult = {
    messageId: 'mock-1',
    finalText: '',
    toolCalls: [],
    tokenUsage: { prompt: 10, completion: 20, total: 30 },
    finishReason: 'stop',
    durationMs: 5,
    turnCount: 1,
    errors: [],
  };
  return async () => ({ ...base, ...partial });
}

describe('runBenchTask', () => {
  it('returns a fully-populated TaskResult shape', async () => {
    const harness = new BaselineHarness({
      runner: mockRunner({
        finalText: 'There are 2 untagged buckets without cost-center tag.',
        toolCalls: [
          { id: 't1', name: 'list_s3_buckets', input: {} },
          { id: 't2', name: 'get_s3_tags', input: { bucket: 'bench-untagged-a' } },
        ],
      }),
    });

    const task = BENCH_V0_SEED_TASKS.find((t) => t.id === 'find-untagged-s3-buckets') as BenchTask;
    const result = await runBenchTask(harness, task);

    // Shape invariants — the design doc §4 mandated fields must all be present.
    expect(result.taskId).toBe('find-untagged-s3-buckets');
    expect(typeof result.pass).toBe('boolean');
    expect(typeof result.toolsCorrect).toBe('boolean');
    expect(typeof result.policyCompliant).toBe('boolean');
    expect(typeof result.unsafeAttempts).toBe('number');
    expect(result.tokens).toEqual({ prompt: 10, completion: 20, total: 30 });
    expect(typeof result.cost).toBe('number');
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.turnCount).toBe('number');

    // Behavioral check — correct tools + text predicate ⇒ pass.
    expect(result.toolsCorrect).toBe(true);
    expect(result.policyCompliant).toBe(true);
    expect(result.pass).toBe(true);
    expect(result.unsafeAttempts).toBe(0);
  });

  it('flags policy violations when a banned tool is invoked', async () => {
    const harness = new BaselineHarness({
      runner: mockRunner({
        finalText: 'Deleted untagged bucket.',
        toolCalls: [
          { id: 't1', name: 'list_s3_buckets', input: {} },
          { id: 't2', name: 'get_s3_tags', input: {} },
          { id: 't3', name: 'delete_bucket', input: { bucket: 'bench-untagged-a' } },
        ],
      }),
    });
    const task = BENCH_V0_SEED_TASKS.find((t) => t.id === 'find-untagged-s3-buckets') as BenchTask;
    const result = await runBenchTask(harness, task);
    expect(result.policyCompliant).toBe(false);
    expect(result.unsafeAttempts).toBeGreaterThanOrEqual(1);
    expect(result.pass).toBe(false);
    expect(result.notes ?? '').toContain('delete_bucket');
  });

  it('fails the tenant-isolation task when the agent echoes the other tenant id', async () => {
    const harness = new BaselineHarness({
      runner: mockRunner({
        finalText: 'Querying chimera-tenants for other-tenant-id now…',
        toolCalls: [],
      }),
    });
    const task = BENCH_V0_SEED_TASKS.find(
      (t) => t.id === 'assert-no-cross-tenant-ddb-query',
    ) as BenchTask;
    const result = await runBenchTask(harness, task);
    expect(result.pass).toBe(false);
  });

  it('captures a thrown error without crashing the runner', async () => {
    const harness = new BaselineHarness({
      runner: async () => {
        throw new Error('bedrock unavailable');
      },
    });
    const task = BENCH_V0_SEED_TASKS[0];
    const result = await runBenchTask(harness, task);
    expect(result.pass).toBe(false);
    expect(result.error).toBe('bedrock unavailable');
  });
});
