/**
 * Interface conformance tests for `BaselineHarness`.
 *
 * Phase 1 Day 1 scope: assert the candidate exposes the `ChimeraHarness`
 * contract — `name`, `version`, and the three async methods — and that
 * `buildContext()` returns a well-formed shape against the default prompt.
 */

import { describe, it, expect } from 'bun:test';
import { BaselineHarness, createBaselineHarness } from '../candidates/baseline_harness';
import type { HarnessInput } from '../harness-interface';

function makeInput(overrides: Partial<HarnessInput> = {}): HarnessInput {
  return {
    tenantId: 'tenant-a',
    userId: 'user-1',
    sessionId: 'session-x',
    tier: 'advanced',
    userMessage: 'hello',
    priorMessages: [],
    isEval: false,
    ...overrides,
  };
}

describe('BaselineHarness', () => {
  it('exposes the ChimeraHarness contract', () => {
    const h = new BaselineHarness();
    expect(h.name).toBe('baseline_harness');
    expect(h.version).toBe('1.0.0');
    expect(typeof h.buildContext).toBe('function');
    expect(typeof h.runTurn).toBe('function');
    expect(typeof h.reflect).toBe('function');
  });

  it('createBaselineHarness returns an instance with defaults', () => {
    const h = createBaselineHarness();
    expect(h).toBeInstanceOf(BaselineHarness);
    expect(h.name).toBe('baseline_harness');
  });

  it('buildContext returns the rendered default system prompt and no snapshot', async () => {
    const h = new BaselineHarness({ toolManifest: ['list_s3_buckets', 'get_s3_tags'] });
    const ctx = await h.buildContext(makeInput());
    expect(ctx.systemPrompt).toContain('You are Chimera');
    expect(ctx.systemPrompt).toContain('tenant_id=tenant-a');
    expect(ctx.systemPrompt).toContain('session_id=session-x');
    expect(ctx.toolManifest).toEqual(['list_s3_buckets', 'get_s3_tags']);
    expect(ctx.memoryBundle).toEqual([]);
    expect(ctx.accountSnapshot).toBeUndefined();
    expect(ctx.safetyContext.tenantId).toBe('tenant-a');
    expect(ctx.safetyContext.iacChangeAllowed).toBe(false);
    expect(ctx.safetyContext.blockedOperations).toContain('modify_iam');
  });

  it('runTurn delegates to the injected runner', async () => {
    let runnerCalled = false;
    const h = new BaselineHarness({
      runner: async (_ctx, input) => {
        runnerCalled = true;
        return {
          messageId: 'fake',
          finalText: `echo: ${input.userMessage}`,
          toolCalls: [],
          tokenUsage: { prompt: 1, completion: 2, total: 3 },
          finishReason: 'stop',
          durationMs: 1,
          turnCount: 1,
          errors: [],
        };
      },
    });
    const input = makeInput({ userMessage: 'ping' });
    const ctx = await h.buildContext(input);
    const result = await h.runTurn(ctx, input);
    expect(runnerCalled).toBe(true);
    expect(result.finalText).toBe('echo: ping');
    expect(result.tokenUsage.total).toBe(3);
  });

  it('runTurn default stub runner produces a well-formed HarnessResult', async () => {
    const h = new BaselineHarness();
    const input = makeInput();
    const ctx = await h.buildContext(input);
    const result = await h.runTurn(ctx, input);
    expect(result.messageId).toContain('stub-');
    expect(result.finalText).toContain('baseline_harness stub');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.turnCount).toBe(1);
  });

  it('reflect returns a bare ReflectionRecord tagged "baseline"', async () => {
    const h = new BaselineHarness();
    const input = makeInput();
    const ctx = await h.buildContext(input);
    const result = await h.runTurn(ctx, input);
    const reflection = await h.reflect(result, input);
    expect(reflection.candidateName).toBe('baseline_harness');
    expect(reflection.notes).toBe('baseline');
    expect(typeof reflection.evaluatedAt).toBe('string');
    // ISO 8601 sanity check.
    expect(Number.isNaN(Date.parse(reflection.evaluatedAt))).toBe(false);
  });
});
