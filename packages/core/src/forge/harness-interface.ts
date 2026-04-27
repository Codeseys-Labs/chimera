/**
 * Chimera Forge — ChimeraHarness interface
 *
 * Defines the boundary between the chat runtime and the evolvable agent
 * scaffolding (system prompt, tool manifest, memory, model routing,
 * environment bootstrap). Phase 1 Day 1 scope: interface definitions +
 * baseline wrapper. See `docs/designs/chimera-forge-meta-harness.md` §4.1.
 *
 * Candidate harnesses live under `forge/candidates/<name>.ts` and are loaded
 * by convention — like Meta-Harness's Terminal-Bench 2 `AgentHarness` import
 * normalization, the runner normalizes whatever the proposer exports into a
 * single canonical `Harness` reference.
 */

import type { Message } from '../memory/types';
import type { ModelId } from '../evolution/types';

// ---------------------------------------------------------------------------
// Shared lightweight types
// ---------------------------------------------------------------------------

/**
 * Tool identifier. Kept as `string` alias so the forge is not coupled to a
 * specific tool registry shape — the chat runtime owns the authoritative list.
 */
export type ToolName = string;

/**
 * Tenant tier. Mirrors the chat-gateway's runtime tier labels rather than the
 * design-doc draft `'enterprise'` label — the live code uses `'premium'`, so
 * Forge matches to keep baseline_harness a pure wrapper.
 */
export type HarnessTier = 'basic' | 'advanced' | 'premium';

/**
 * Minimal retrieved-memory shape the harness can pass back to the runtime.
 * Kept opaque; the richer `memory/types.ts` shape is intentionally not
 * imported to avoid a directional dependency (memory layer → forge).
 */
export interface RetrievedMemory {
  memoryId: string;
  content: string;
  score?: number;
  source?: string;
}

/**
 * Safety context propagated through the harness. Cedar/AVP integration is a
 * Phase 2+ concern — for now this is a typed extension point.
 */
export interface SafetyContext {
  tenantId: string;
  blockedOperations: string[];
  iacChangeAllowed: boolean;
  requiresApprovalAboveMonthlyDelta?: number;
}

/**
 * Single tool-call record captured during a turn. Shape mirrors the agent
 * SDK's ToolUse block but is flattened for benchmark scoring.
 */
export interface ToolCallRecord {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

/**
 * AWS account snapshot — the §4.3 environment bootstrap artifact.
 * Phase 1 Day 1 only defines the shape; the populating harness ships Day 2.
 */
export interface AwsAccountSnapshot {
  tenant: {
    tenantId: string;
    tier: HarnessTier;
    budgetRemaining?: number;
    allowedServices?: string[];
  };
  awsAccount: {
    accountId?: string;
    regionsWithResources?: string[];
    activeStacks?: number;
    recentDeployments?: number;
    recentAlarms?: number;
  };
  resourceSummary?: Record<string, { count: number; [k: string]: unknown }>;
  safety: SafetyContext;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Harness I/O
// ---------------------------------------------------------------------------

/**
 * Input passed to every harness invocation. Equivalent to the chat-route
 * per-turn payload plus benchmark-mode flags.
 */
export interface HarnessInput {
  tenantId: string;
  userId: string | null;
  sessionId: string;
  tier: HarnessTier;
  userMessage: string;
  priorMessages: Message[];
  /** When true, indicates benchmark/eval mode (no live side effects). */
  isEval: boolean;
  /** Golden-task identifier when `isEval=true`. */
  goldenTaskId?: string;
}

/**
 * Context the harness assembles before running a turn. This is what Forge
 * varies across candidates — the downstream runtime is held constant.
 */
export interface HarnessContext {
  systemPrompt: string;
  toolManifest: ToolName[];
  memoryBundle: RetrievedMemory[];
  modelId: ModelId;
  /** Optional precomputed account snapshot (Day 2 feature). */
  accountSnapshot?: AwsAccountSnapshot;
  safetyContext: SafetyContext;
}

/**
 * Result of running a single turn. The bench scorer operates purely on this
 * structure — no direct runtime coupling.
 */
export interface HarnessResult {
  messageId: string;
  finalText: string;
  toolCalls: ToolCallRecord[];
  tokenUsage: { prompt: number; completion: number; total: number };
  finishReason: 'stop' | 'tool_use' | 'length' | 'error';
  durationMs: number;
  turnCount: number;
  errors: string[];
}

/**
 * Per-candidate reflection record. Persisted to the control plane so the
 * proposer can condition the next iteration on past outcomes.
 */
export interface ReflectionRecord {
  candidateName: string;
  evaluatedAt: string;
  notes: string;
  /** Optional structured deltas vs baseline. */
  deltas?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// The Harness contract
// ---------------------------------------------------------------------------

/**
 * `ChimeraHarness` is the evolvable unit of agent scaffolding.
 *
 * The runtime calls `buildContext()` once per turn (potentially cached by the
 * harness), then `runTurn()` to execute the actual model+tool loop, then
 * `reflect()` to emit a per-candidate summary for the Forge control plane.
 *
 * Implementations MUST be pure w.r.t. their inputs — two harnesses asked to
 * build context for the same `HarnessInput` may legitimately diverge, but a
 * single harness must be deterministic in the parts that affect scoring.
 */
export interface ChimeraHarness {
  /** Candidate identifier. Matches the file stem under `forge/candidates/`. */
  readonly name: string;
  /** Semantic version of this candidate's behavior. */
  readonly version: string;

  /**
   * Build the per-turn context (prompt, tools, model, snapshot, memory).
   * May cache across calls (e.g. account snapshot with TTL).
   */
  buildContext(input: HarnessInput): Promise<HarnessContext>;

  /**
   * Execute the agent turn under the assembled context. The injected runner
   * (see candidates) ultimately calls Bedrock; the harness is the shell.
   */
  runTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessResult>;

  /**
   * Reflect on the turn result — emits a lightweight structured record for
   * the proposer's next iteration and for evolution history storage.
   */
  reflect(result: HarnessResult, input: HarnessInput): Promise<ReflectionRecord>;
}
