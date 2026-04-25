/**
 * Tests for TaskDecomposer provider integration.
 *
 * The decomposer has three call paths:
 *   1. No provider injected → heuristic templates run (default).
 *   2. Provider injected + succeeds → provider output is used.
 *   3. Provider injected + throws → heuristic fallback runs.
 *
 * We test each path. The heuristic templates themselves are implementation
 * details (they produce hardcoded subtasks); we don't assert on their
 * specific content, only that they run and produce ≥ 1 subtask.
 *
 * Wave 24 (chimera-76b9).
 */

import { describe, it, expect, mock } from 'bun:test';
import { TaskDecomposer } from '../task-decomposer';
import type { DecompositionProvider } from '../decomposition-provider';
import type { DecompositionContext, Subtask } from '../types';

const context: DecompositionContext = {
  tenantId: 'tenant-test',
  constraints: [],
};

const llmSubtasks: Subtask[] = [
  {
    id: 'llm-1',
    description: 'LLM-generated first step',
    dependencies: [],
    status: 'pending',
    priority: 'high',
    estimatedDurationMs: 600_000,
  },
  {
    id: 'llm-2',
    description: 'LLM-generated second step',
    dependencies: ['llm-1'],
    status: 'pending',
    priority: 'normal',
    estimatedDurationMs: 900_000,
  },
];

function makeProvider(
  impl: () => Promise<{ subtasks: Subtask[]; modelId?: string }>,
): DecompositionProvider {
  return {
    kind: 'llm',
    decompose: async (_request, _context, _strategy) => impl(),
  };
}

describe('TaskDecomposer — provider integration', () => {
  it('uses heuristic when no provider is injected', async () => {
    const d = new TaskDecomposer({ tenantId: 't', defaultStrategy: 'plan-and-execute' });
    const result = await d.decompose('Refactor auth', context);
    expect(result.subtasks.length).toBeGreaterThan(0);
    // Heuristic plan-and-execute produces IDs with the 'plan-' prefix.
    expect(result.subtasks[0]?.id).toMatch(/^plan-/);
  });

  it('uses LLM provider output when provider succeeds', async () => {
    const provider = makeProvider(async () => ({
      subtasks: llmSubtasks,
      modelId: 'us.anthropic.claude-sonnet-4-6-v1:0',
    }));
    const d = new TaskDecomposer({
      tenantId: 't',
      defaultStrategy: 'plan-and-execute',
      provider,
    });
    const result = await d.decompose('Refactor auth', context);
    expect(result.subtasks.map((s) => s.id)).toEqual(['llm-1', 'llm-2']);
  });

  it('falls back to heuristic when LLM provider throws', async () => {
    const provider = makeProvider(async () => {
      throw new Error('Bedrock ThrottlingException');
    });
    const d = new TaskDecomposer({
      tenantId: 't',
      defaultStrategy: 'plan-and-execute',
      provider,
    });
    const result = await d.decompose('Refactor auth', context);
    // Heuristic output, not the LLM's — and we got SOMETHING, not a thrown error.
    expect(result.subtasks.length).toBeGreaterThan(0);
    expect(result.subtasks[0]?.id).toMatch(/^plan-/);
  });

  it('respects maxSubtasks when the LLM returns too many', async () => {
    const manySubtasks: Subtask[] = Array.from({ length: 30 }, (_, i) => ({
      id: `llm-${i}`,
      description: `step ${i}`,
      dependencies: [],
      status: 'pending',
      priority: 'normal',
      estimatedDurationMs: 60_000,
    }));
    const provider = makeProvider(async () => ({ subtasks: manySubtasks }));
    const d = new TaskDecomposer({
      tenantId: 't',
      defaultStrategy: 'plan-and-execute',
      maxSubtasks: 10,
      provider,
    });
    const result = await d.decompose('complex', context);
    expect(result.subtasks).toHaveLength(10);
  });
});
