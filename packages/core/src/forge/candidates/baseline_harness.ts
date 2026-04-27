/**
 * baseline_harness — Chimera Forge candidate #0.
 *
 * Wraps the current `chat.ts` runtime behavior exactly so the frontier has a
 * stable anchor. Phase 1 Day 1 scope: interface conformance + stub runTurn.
 * Day 2+ will wire a Bedrock-backed runner so this candidate produces real
 * outputs; on Day 1 we only prove the shape.
 *
 * Design doc: `docs/designs/chimera-forge-meta-harness.md` §4.2 (baseline).
 */

import type {
  ChimeraHarness,
  HarnessContext,
  HarnessInput,
  HarnessResult,
  ReflectionRecord,
  ToolName,
} from '../harness-interface';
import { createDefaultSystemPrompt } from '../../agent/prompt';

/**
 * Runner function injected into the harness. Mirrors the shape the chat route
 * uses — `agent.stream(userMessage, priorMessages)` — but reduced to a pure
 * HarnessContext/HarnessInput pair so bench fixtures can substitute a fake.
 *
 * Day 1 ships only a stub runner; Day 2 wires a Bedrock-backed implementation.
 */
export type HarnessRunner = (
  context: HarnessContext,
  input: HarnessInput,
) => Promise<HarnessResult>;

export interface BaselineHarnessOptions {
  /** Tool names the chat runtime would have loaded for this tier. */
  toolManifest?: ToolName[];
  /** Model id to thread through the context. */
  modelId?: string;
  /** Optional runner override; defaults to the stub runner. */
  runner?: HarnessRunner;
}

/**
 * Stub runner for Day 1. Returns a deterministic `HarnessResult` with enough
 * structure that the bench runner can score against it. Day 2 replaces this
 * with a real Bedrock Converse call.
 */
const stubRunner: HarnessRunner = async (_context, input) => ({
  messageId: `stub-${input.sessionId}-${Date.now()}`,
  finalText:
    `[baseline_harness stub] Received user message for tenant=${input.tenantId} ` +
    `session=${input.sessionId}. Phase 1 Day 1 does not invoke the model.`,
  toolCalls: [],
  tokenUsage: { prompt: 0, completion: 0, total: 0 },
  finishReason: 'stop',
  durationMs: 0,
  turnCount: 1,
  errors: [],
});

/**
 * BaselineHarness — thin shell over the current chat runtime semantics.
 *
 * - `buildContext()` returns the default system prompt (rendered with the
 *   tenant/session operator metadata), the provided tier-based tool manifest,
 *   empty memory, and NO account snapshot (that ships in the Day 2 candidate).
 * - `runTurn()` delegates to the injected runner.
 * - `reflect()` emits a bare record.
 */
export class BaselineHarness implements ChimeraHarness {
  readonly name = 'baseline_harness';
  readonly version = '1.0.0';

  private readonly toolManifest: ToolName[];
  private readonly modelId: string;
  private readonly runner: HarnessRunner;

  constructor(opts: BaselineHarnessOptions = {}) {
    this.toolManifest = opts.toolManifest ?? [];
    this.modelId = opts.modelId ?? 'us.anthropic.claude-sonnet-4-6-v1:0';
    this.runner = opts.runner ?? stubRunner;
  }

  async buildContext(input: HarnessInput): Promise<HarnessContext> {
    const template = createDefaultSystemPrompt();
    const systemPrompt = template.render({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      // `userId` is optional in the template; PromptContext indexer accepts it.
      userId: input.userId ?? undefined,
    });

    return {
      systemPrompt,
      toolManifest: [...this.toolManifest],
      memoryBundle: [],
      modelId: this.modelId,
      // accountSnapshot intentionally omitted — baseline does no precompute.
      safetyContext: {
        tenantId: input.tenantId,
        blockedOperations: ['modify_iam', 'delete_bucket', 'modify_vpc'],
        iacChangeAllowed: false,
      },
    };
  }

  async runTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessResult> {
    return this.runner(context, input);
  }

  async reflect(_result: HarnessResult, _input: HarnessInput): Promise<ReflectionRecord> {
    return {
      candidateName: this.name,
      evaluatedAt: new Date().toISOString(),
      notes: 'baseline',
    };
  }
}

/** Convenience factory mirroring other core modules' `createX` pattern. */
export function createBaselineHarness(opts: BaselineHarnessOptions = {}): BaselineHarness {
  return new BaselineHarness(opts);
}
