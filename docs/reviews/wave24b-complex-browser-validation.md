---
title: "Wave 24b — Complex browser validation: SSE v5 bridge fix + 3 new behavioral bugs"
date: 2026-04-26
wave: 24b
scope: tool-invoking prompts, multi-turn conversations, admin page, settings page
---

# Wave 24b — Complex Browser Validation

Follow-up to Wave 24's initial browser test ("Reply with exactly one word: success").
Deeper validation surfaced three pre-existing bugs that simple prompts missed.

## Commits this session (1)

- `dcfce70` fix(sse-bridge): AI SDK v5 tool event wire shape

## What the Wave-24b fix does

The live SSE stream previously emitted legacy tool event shapes that AI SDK
v5's client-side Zod validator rejects — causing every tool-invoking prompt
to throw `AI_TypeValidationError` mid-stream. Three wire-shape changes:

| Event | Before | After |
|-------|--------|-------|
| `tool-input-start`     | `{id, toolName}`           | `{toolCallId, toolName}` |
| `tool-input-delta`     | `{id, delta}`              | `{toolCallId, inputTextDelta}` |
| `tool-result` (unified) | `{id, result, status}`     | `tool-output-available {toolCallId, output}` OR `tool-output-error {toolCallId, errorText}` |

Updated 6 files: types, converter, unit tests, persistence listener, its
test, and a stray S3 mock that was triggering Wave-19's Bun-mock-pollution
pattern again.

## What validated in the browser

- ✅ SSE stream no longer aborts on tool events — prompt flows through
      to the agent loop even when tool metadata is emitted
- ✅ Multi-turn conversation works — turn 2 sees turn 1's context
      (session persistence intact)
- ✅ Dashboard renders cleanly (Wave-24 dashboard.tsx guard worked)
- ✅ Admin + Settings pages load without crashes (tabs render, forms load)
- ✅ `bun run test:smoke` passes end-to-end (9-phase E2E)

## 3 new bugs filed

### chimera-5d66 (Medium) — Agent doesn't invoke tools

Prompt: "List the first 3 S3 buckets in my AWS account with their
creation dates. Use your tools."

Agent streams text 10 times in a row: "I'll query your S3 buckets
right away using the Resource Explorer..." — never emits a `tool_use`
content block. Stream completes cleanly with `finishReason: 'stop'`.

This is a **separate pre-existing issue**, surfaced now that the SSE
path no longer hides it. Root cause is likely:
- The Bedrock Converse API call in the agent loop isn't receiving
  the `toolConfig` parameter, OR
- Strands agent isn't feeding tool descriptions to the model, OR
- Tool loading succeeds but the model isn't prompted correctly.

Basic-tier tenant DOES have access to `s3` (tier 1) + `resource-explorer`
(discovery tier) per `packages/core/src/gateway/tier-config.ts`.

### chimera-cd16 (Medium) — System prompt leak

Prompt sequence:
- Turn 1: "My name is Baladita. Remember it for later. Now just say 'Got it.'"
- Agent: "Got it." ✅
- Turn 2: "What's my name? Reply with just the name, nothing else."
- Agent: **"test-tenant-wave21"** ← tenant ID, not "Baladita"

The agent's system-prompt / memory assembly is leaking tenant-scoping
variables into the conversational output. Not a cross-tenant leak
(only within-tenant confusion), but a confidentiality UX concern — the
tenant ID shouldn't surface in free-text user-visible replies.

### chimera-c881 (Low) — Admin page tenant endpoints 404

Admin page calls:
- `GET /tenants/:tenantId/users` → 404
- `GET /tenants/:tenantId/api-keys` → 404

The nearest existing implementation is `GET /integrations/:tenantId/users`
in `chat-gateway/src/routes/integrations.ts:389`. Routing gap — fix
options: add aliases, move endpoints, or update SPA call sites.

Admin page doesn't crash (ErrorBoundary doesn't trigger), just shows
empty user/key lists.

## Patterns captured

### "Boundary leaks" are the dominant bug class in this project

Every bug found in Waves 22-24b is a mismatch between what unit tests
assume and what the network boundary actually sees:
- Wave-22: v4 `content` vs v5 `parts`
- Wave-22: mock DDB vs real DDB
- Wave-24: Zod `.optional()` vs `null`
- Wave-24: `tenant` truthy vs `tenant.monthlyCostUsd` typed number
- Wave-24b: legacy `tool-result` vs v5 `tool-output-available`
- Wave-24b: incomplete S3 `mock.module` vs full code import surface

Unit-test coverage doesn't catch these because TypeScript's type
system doesn't enforce wire-level constraints. Live browser testing
found all 6 in ~2 hours.

### `bun run test:smoke` is now a critical pre-flight check

The 9-phase E2E script (Wave-23) has caught pipeline-vs-ECS sync
issues and confirmed SSE v5 fix before burning time in the browser.
Pattern: after any chat-gateway change, run `test:smoke` before
opening Playwright.

### CloudFront invalidation is NOT automatic

The Frontend_Deploy pipeline action invalidates CloudFront, but the
invalidation takes 1-2 minutes to propagate. If the browser still
shows the old bundle after pipeline completes, force a re-invalidation
or wait. This bit us twice in Wave-24 before I caught it.

## Backlog state

7 open items. Four pre-existing FUTURE strategic items, three new
Wave-24b bugs:

| ID | Title | Priority | Size |
|----|-------|----------|------|
| chimera-cd16 | System prompt leak (tenant ID) | Medium | 1-2h |
| chimera-5d66 | Agent doesn't invoke tools | Medium | 4-8h |
| chimera-c881 | Admin page 404s | Low | 1-2h |
| chimera-2b2a | FUTURE: EventBridge scheduled tasks | Low | 2d |
| chimera-59ee | FUTURE: Webhook delivery | Low | 1-2d |
| chimera-606c | FUTURE: DGM evolution | Backlog | 3-5d |
| chimera-b7af | P1: strands-agents migration | Medium | wait for 1.0.0 GA |

## Deploy state

- 14/14 stacks live in baladita+Bedrock-Admin / us-west-2
- ECS task def `:29` serving Wave-22/23/24/24b fixes
- Frontend CloudFront serving index-BKJVxrzQ.js (Wave-24 dashboard guard)
- 1664 tests pass, 0 fail, 9 skip (across 88 files)

## References

- `docs/reviews/WAVE-RETROSPECTIVE-24.md` — prior
- `docs/reviews/wave21-live-validation.md` — initial E2E recipe
- Wave-24b screenshot: `wave24b-tool-events-streaming.png` (local)
- Seeds: chimera-5d66, chimera-cd16, chimera-c881 (new)
