/**
 * Chimera Forge — barrel export.
 *
 * Public surface for Phase 1 Day 1: the `ChimeraHarness` interface, the
 * baseline candidate, and the bench v0 seed tasks + runner.
 */

export * from './harness-interface';
export { BaselineHarness, createBaselineHarness } from './candidates/baseline_harness';
export type { BaselineHarnessOptions, HarnessRunner } from './candidates/baseline_harness';
export { BENCH_V0_SEED_TASKS, buildToolsetScorer } from './bench/v0/tasks';
export type { BenchExpected, BenchScore, BenchTask } from './bench/v0/tasks';
export { runBenchTask } from './bench/v0/runner';
export type { TaskResult } from './bench/v0/runner';
