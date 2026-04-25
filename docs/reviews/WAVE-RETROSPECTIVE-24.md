---
title: "Wave 24 Retrospective — LLM task decomposer ships; backlog at 4 FUTURE items"
status: retrospective
date: 2026-04-25
wave: 24
previous: WAVE-RETROSPECTIVE-23.md
---

# Wave 24 Retrospective

**Dates:** 2026-04-25
**Outcome:** Shipped chimera-76b9 (LLM-backed task decomposition via
Bedrock Converse). Backlog reached 4 open items — all multi-day
strategic work (webhook delivery, EventBridge cron, DGM evolution,
strands-SDK migration). Zero tactical/hardening work remains.

## Issue closed (1)

| Seeds ID | Title | Resolution |
|----------|-------|------------|
| `chimera-76b9` | P2: LLM-based task decomposer | ✅ Pluggable `DecompositionProvider` + `LlmDecompositionProvider` wrapping Bedrock Converse |

## What shipped

### LLM-backed decomposer architecture

Three files, ~500 lines of production code, 15 tests:

- `packages/core/src/swarm/decomposition-provider.ts` — abstraction
- `packages/core/src/swarm/llm-decomposition-provider.ts` — Bedrock-backed impl
- `packages/core/src/swarm/task-decomposer.ts` — dispatcher with fallback

Heuristic templates remain as the deterministic default. Callers opt in
via `new TaskDecomposer({ provider: new LlmDecompositionProvider(...) })`.
On any LLM error, dispatcher logs and falls back to heuristic — LLM
hiccups (throttle, timeout, schema drift) never bubble up as task
failures.

### Design decisions

1. **Dependency injection over direct SDK coupling.** `TaskDecomposer`
   doesn't import `@aws-sdk/client-bedrock-runtime`. The provider does.
   Unit tests use the heuristic provider (no network); integration tests
   stub `BedrockRuntimeClient.send()` at the SDK boundary.

2. **Rigid JSON prompt.** Claude handles structured output well.
   Deterministic parser protects callers from hallucinated schema drift.
   Strips ```json``` fences and leading prose so parser survives
   common "Sure! Here's your JSON:" drift.

3. **Tier-aware model routing.** Basic → Nova Lite (cheap). Advanced+ →
   Claude Sonnet 4.6. Passes through `enforceTierCeiling()` so a
   mis-pinned Opus request on a basic tenant gets downgraded before
   Bedrock is called — hits the same alarm-backed path as regular agent
   invocations.

4. **Failure-tolerant.** Any Bedrock error or unparseable reply becomes
   a typed `LlmDecompositionError`. The dispatcher catches that specific
   class and falls back. Users never see an LLM hiccup as a task failure.

### Latent bug fixed

`DecomposerConfig` constructor hard-listed fields instead of spreading
the partial config. Adding `provider` to the interface wouldn't have
worked without the explicit `provider: config.provider` line. Also
added provider-kind logging so CloudWatch traces show at a glance
whether a decomposition ran heuristic or LLM. Common pattern to sweep
in a future simplification pass.

## Cross-cutting observations

### Pipeline coalescing wastes throughput

Across Waves 22, 23, and 24, I ran `chimera deploy --source local` 5
times in rapid succession. CodePipeline supersedes in-flight executions
with newer ones, so many of those earlier runs got `Cancelled` instead
of cycling ECS. The Wave-23 SHA-threading fix exists in the repo but
ECS is still on task def :23 because no deploy ran end-to-end.

Two lessons:
- **Wait for a prior run to reach Deploy stage before pushing again.**
  Otherwise supersession eats the earlier Deploy without ever reaching
  ECS.
- **Consider `chimera monitor --stage Deploy` as a gating hook** in a
  future UX improvement. The current `chimera deploy` returns as soon
  as CodeCommit accepts — operators have to poll `codepipeline
  get-pipeline-state` separately.

### The LLM decomposer is a good fit for the codebase

Hooking into `TaskDecomposer`'s existing interface meant:
- Zero breaking changes (existing callers work unchanged)
- Fallback path already exists as the default behavior
- `enforceTierCeiling` + EMF metric emission come for free

This is the payoff from Wave-15's "three-layer tool architecture" groundwork.
Tier enforcement being a single function call made this integration
~10 lines instead of ~200.

### Tests caught a real bug before commit

The `maxSubtasks: 10` test failed because the constructor silently
dropped the `provider` field. Without the test I would've
commit-+-pushed, the pipeline would've deployed, and the feature
would've quietly not worked (heuristic running whether a provider was
configured or not). Good argument for "write one integration test per
config field you add."

## Commits this wave (1)

- `27db8d3` feat(swarm): LLM-backed task decomposition via Bedrock Converse

## Backlog delta

| Category | Wave 23 end | Wave 24 end | Δ |
|----------|-------------|-------------|-----|
| Seeds open | 5 | 4 | -1 (76b9) |
| P0/High | 0 | 0 | 0 |
| Medium/Low tactical | 0 | 0 | 0 |
| FUTURE multi-day | 4 | 4 | 0 |

## Remaining backlog (4)

All require multi-day investment; none are tactical hardening:

| ID | Title | Size |
|----|-------|------|
| `chimera-b7af` | Migrate shim → `@strands-agents/sdk` | 1-2 days, wait for 1.0.0 GA |
| `chimera-2b2a` | EventBridge scheduled agent tasks | 2 days |
| `chimera-59ee` | Webhook delivery for task lifecycle events | 1-2 days |
| `chimera-606c` | DGM evolution integration (composite fitness, lineage) | 3-5 days |

## Deploy state as of end of wave

- Wave-22/23/24 commits pushed to CodeCommit
- Pipeline state: Source Succeeded, Build + Deploy cancelled twice (coalescing), Test Failed once
- ECS: still task def :23 (pre-Wave-19) — waiting for a complete Deploy cycle
- Frontend: 200 OK, SPA serving
- 14/14 stacks live

## Wave 25 candidates

1. **Verify pipeline actually lands on ECS.** Run `chimera monitor` (or
   wait) for a clean pipeline run, confirm ECS task def bump, browser
   re-validate chat.
2. **Pick one strategic item.** Of the 4 remaining:
   - **`chimera-2b2a` (EventBridge)** is the fastest — existing
     OrchestrationStack has the event bus; just needs Lambda+EventBridge
     wiring.
   - **`chimera-59ee` (webhooks)** pairs well with 2b2a — same Step
     Functions patterns.
   - **`chimera-606c` (DGM)** is the biggest; best done solo once
     post-deploy validation is green.
   - **`chimera-b7af`** waits on external SDK 1.0.0 GA; no action now.

**Recommendation:** Wave 25 should do (1) first — verify the live
deploy works — then start (2) with 2b2a. Don't attempt multiple
FUTURE items in one wave.

## References

- `docs/reviews/WAVE-RETROSPECTIVE-23.md` — prior
- `packages/core/src/swarm/llm-decomposition-provider.ts` — implementation
- Seeds chimera-76b9 (closed 2026-04-25)
