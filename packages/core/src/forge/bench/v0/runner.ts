/**
 * ChimeraBench v0 runner — executes a single `BenchTask` against a harness.
 *
 * Phase 1 Day 1 scope: `runBenchTask(harness, task, input)` that calls
 * `buildContext` + `runTurn` and returns a `TaskResult` whose pass/fail is
 * decided by the task's `scoreFn`. Day 2+ will extend this to batch-run all
 * tasks and aggregate into a frontier DDB item.
 */

import type {
  ChimeraHarness,
  HarnessInput,
  HarnessResult,
} from '../../harness-interface';
import type { BenchTask } from './tasks';
import { BEDROCK_MODELS } from '../../../evolution/types';

/**
 * Structured per-task result. Shape matches the metrics listed in §4.6 of
 * the design doc (`taskSuccessRate`, `toolCorrectness`, `policyCompliance`,
 * `avgTokens`, `avgCost`, `avgDurationMs`, `avgTurnCount`) but at a single
 * trial granularity — aggregation happens one layer up.
 */
export interface TaskResult {
  taskId: string;
  pass: boolean;
  toolsCorrect: boolean;
  policyCompliant: boolean;
  unsafeAttempts: number;
  tokens: { prompt: number; completion: number; total: number };
  /** Estimated USD cost based on token usage × model price table. */
  cost: number;
  durationMs: number;
  turnCount: number;
  /** Optional scorer notes — preserved for debugging. */
  notes?: string;
  /** Optional error capture if the harness threw. */
  error?: string;
}

/** Look up the per-1k-token price for a model id; 0 if unknown. */
function pricePer1k(modelId: string): number {
  return BEDROCK_MODELS[modelId] ?? 0;
}

/**
 * Run a single bench task against a candidate harness.
 *
 * @param harness  The candidate to evaluate.
 * @param task     The bench task (holds expected shape + scoreFn).
 * @param input    Optional override for the harness input. Defaults to the
 *                 task's embedded `input` so callers can stay terse.
 */
export async function runBenchTask(
  harness: ChimeraHarness,
  task: BenchTask,
  input: HarnessInput = task.input,
): Promise<TaskResult> {
  const start = Date.now();
  let result: HarnessResult;

  try {
    const context = await harness.buildContext(input);
    result = await harness.runTurn(context, input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      taskId: task.id,
      pass: false,
      toolsCorrect: false,
      policyCompliant: false,
      unsafeAttempts: 0,
      tokens: { prompt: 0, completion: 0, total: 0 },
      cost: 0,
      durationMs: Date.now() - start,
      turnCount: 0,
      error: message,
    };
  }

  const score = task.scoreFn(result, task.expected);

  // Cost estimate: treat total tokens as priced uniformly per 1k — good
  // enough for Phase 1 ranking; Day 2+ splits input/output pricing.
  const modelContext = await harness.buildContext(input);
  const cost = (result.tokenUsage.total / 1000) * pricePer1k(modelContext.modelId);

  return {
    taskId: task.id,
    pass: score.pass,
    toolsCorrect: score.toolsCorrect,
    policyCompliant: score.policyCompliant,
    unsafeAttempts: score.unsafeAttempts,
    tokens: result.tokenUsage,
    cost,
    durationMs: result.durationMs || Date.now() - start,
    turnCount: result.turnCount,
    notes: score.notes,
  };
}
