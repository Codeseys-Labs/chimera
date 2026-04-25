/**
 * Tests for LlmDecompositionProvider.
 *
 * Covers:
 *   - Happy path: Bedrock reply parses into a clean Subtask list.
 *   - Wraps output in ```json fences (common Claude drift) — parser strips.
 *   - Wraps output with prose prefix — parser extracts the JSON block.
 *   - Malformed JSON — throws typed LlmDecompositionError (caller catches).
 *   - Empty subtasks array — throws so caller falls back to heuristic.
 *   - Enforces tier ceiling (basic tenant requesting Opus gets downgraded).
 *   - Dedupes repeated subtask IDs (hallucination guard).
 *   - Dependencies that reference future IDs get dropped (topological).
 *
 * We stub BedrockRuntimeClient.send() — we're testing the provider's
 * prompt construction, reply parsing, and fallback behavior, NOT Bedrock
 * itself.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  LlmDecompositionProvider,
  LlmDecompositionError,
} from '../llm-decomposition-provider';
import type { DecompositionContext } from '../types';

type MockClient = { send: ReturnType<typeof mock> };

const baseContext: DecompositionContext = {
  tenantId: 'tenant-test',
  constraints: [],
};

function makeReply(text: string) {
  return {
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 100, outputTokens: 200 },
  };
}

function pureJsonReply() {
  return makeReply(
    JSON.stringify({
      subtasks: [
        {
          id: 'research',
          description: 'Research AWS Lambda cold-start mitigations',
          dependencies: [],
          priority: 'high',
          validation: 'Summary doc with 3 approaches',
          estimatedDurationMs: 1_800_000,
        },
        {
          id: 'prototype',
          description: 'Prototype provisioned concurrency',
          dependencies: ['research'],
          priority: 'normal',
          rollback: 'Remove PC config from Lambda',
          estimatedDurationMs: 3_600_000,
        },
      ],
    }),
  );
}

describe('LlmDecompositionProvider', () => {
  let client: MockClient;
  let provider: LlmDecompositionProvider;

  beforeEach(() => {
    client = { send: mock(() => Promise.resolve(pureJsonReply())) };
    provider = new LlmDecompositionProvider({
      client: client as any,
      tier: 'advanced',
    });
  });

  it('parses a pure-JSON Bedrock reply into Subtasks', async () => {
    const result = await provider.decompose(
      'Reduce Lambda cold-start latency',
      baseContext,
      'plan-and-execute',
    );
    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks[0]?.id).toBe('research');
    expect(result.subtasks[0]?.priority).toBe('high');
    expect(result.subtasks[1]?.dependencies).toEqual(['research']);
    expect(result.subtasks[1]?.rollback).toBe('Remove PC config from Lambda');
    expect(result.modelId).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
  });

  it('strips ```json code fences Claude sometimes emits', async () => {
    client.send = mock(() =>
      Promise.resolve(
        makeReply(
          '```json\n' +
            JSON.stringify({
              subtasks: [
                { id: 'only', description: 'single atomic task' },
              ],
            }) +
            '\n```',
        ),
      ),
    );
    const result = await provider.decompose('small request', baseContext, 'plan-and-execute');
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0]?.id).toBe('only');
  });

  it('extracts JSON when the model prepends prose', async () => {
    client.send = mock(() =>
      Promise.resolve(
        makeReply(
          'Here is your decomposition:\n' +
            JSON.stringify({
              subtasks: [{ id: 'x', description: 'do x' }],
            }),
        ),
      ),
    );
    const result = await provider.decompose('x', baseContext, 'plan-and-execute');
    expect(result.subtasks).toHaveLength(1);
  });

  it('throws LlmDecompositionError on unparseable reply', async () => {
    client.send = mock(() => Promise.resolve(makeReply('not json at all')));
    await expect(
      provider.decompose('x', baseContext, 'plan-and-execute'),
    ).rejects.toBeInstanceOf(LlmDecompositionError);
  });

  it('throws LlmDecompositionError on empty subtasks array', async () => {
    client.send = mock(() =>
      Promise.resolve(makeReply(JSON.stringify({ subtasks: [] }))),
    );
    await expect(
      provider.decompose('x', baseContext, 'plan-and-execute'),
    ).rejects.toBeInstanceOf(LlmDecompositionError);
  });

  it('throws LlmDecompositionError on Bedrock client failure', async () => {
    client.send = mock(() => Promise.reject(new Error('ThrottlingException')));
    await expect(
      provider.decompose('x', baseContext, 'plan-and-execute'),
    ).rejects.toBeInstanceOf(LlmDecompositionError);
  });

  it('enforces tier ceiling — basic tenant cannot invoke Opus', async () => {
    const basicProvider = new LlmDecompositionProvider({
      client: client as any,
      tier: 'basic',
      modelId: 'us.anthropic.claude-opus-4-7',
    });
    await basicProvider.decompose('x', baseContext, 'plan-and-execute');
    const sentCommand = client.send.mock.calls[0]?.[0];
    // enforceTierCeiling downgrades Opus → a basic-allowed model.
    expect(sentCommand?.input?.modelId).not.toBe('us.anthropic.claude-opus-4-7');
    expect(sentCommand?.input?.modelId).toMatch(/haiku|sonnet|nova-lite/i);
  });

  it('dedupes subtasks that share an id', async () => {
    client.send = mock(() =>
      Promise.resolve(
        makeReply(
          JSON.stringify({
            subtasks: [
              { id: 'a', description: 'first' },
              { id: 'a', description: 'duplicate — should be dropped' },
              { id: 'b', description: 'second' },
            ],
          }),
        ),
      ),
    );
    const result = await provider.decompose('x', baseContext, 'plan-and-execute');
    expect(result.subtasks.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('drops dependencies that reference unseen ids (forward refs)', async () => {
    client.send = mock(() =>
      Promise.resolve(
        makeReply(
          JSON.stringify({
            subtasks: [
              // "b" referenced before it's defined — must be dropped from deps
              { id: 'a', description: 'first', dependencies: ['b'] },
              { id: 'b', description: 'second', dependencies: ['a'] },
            ],
          }),
        ),
      ),
    );
    const result = await provider.decompose('x', baseContext, 'plan-and-execute');
    expect(result.subtasks[0]?.dependencies).toEqual([]);
    // backward reference survives
    expect(result.subtasks[1]?.dependencies).toEqual(['a']);
  });

  it('defaults missing priority to "normal"', async () => {
    client.send = mock(() =>
      Promise.resolve(
        makeReply(
          JSON.stringify({
            subtasks: [{ id: 'a', description: 'no priority set' }],
          }),
        ),
      ),
    );
    const result = await provider.decompose('x', baseContext, 'plan-and-execute');
    expect(result.subtasks[0]?.priority).toBe('normal');
    expect(result.subtasks[0]?.estimatedDurationMs).toBe(600_000);
  });

  it('sends a prompt containing the strategy hint and the request verbatim', async () => {
    await provider.decompose(
      'Plan a feature rollout',
      baseContext,
      'tree-of-thought',
    );
    const sentCommand = client.send.mock.calls[0]?.[0];
    const promptText = sentCommand?.input?.messages?.[0]?.content?.[0]?.text ?? '';
    // tree-of-thought hint text (matches the strategyHint() body).
    expect(promptText).toContain('distinct approaches');
    // Request echoed verbatim so the LLM has the user's exact intent.
    expect(promptText).toContain('Plan a feature rollout');
  });
});
