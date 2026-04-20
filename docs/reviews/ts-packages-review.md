# Chimera TypeScript Packages Review

**Review Date:** 2026-04-17
**Scope:** `packages/{core, shared, sse-bridge, chat-gateway, cli, web}`
**Findings:** 3 CRITICAL / 7 HIGH / 10 MEDIUM — total 20
**Tests:** 2206 passing / 38 failing (81% pass, mostly live-AWS dependent)

## Executive Summary

The monorepo is well-structured with good workspace protocols and no circular dependencies. The biggest gaps are around **runtime validation at boundaries** (no Zod at HTTP/DDB boundaries), **SSE robustness** (no heartbeat, no backpressure), and **TypeScript strictness inconsistency** (only 2 of 6 packages enforce `strict: true`; 793 `any`/`as any`/`@ts-ignore` across src/).

**SSE Bridge complexity is justified.** AI SDK v5 provides no native Strands→DSP translation. The 760+ LOC bridge solves a real problem the framework does not solve.

## Critical Findings

### C1 — Missing Request Validation in Chat Gateway
- **File:** `packages/chat-gateway/src/routes/chat.ts`
- **Issue:** `ChatRequest` accepts the messages array with no schema validation. Malformed delta fields crash the streaming pipeline mid-stream.
- **Fix:** Zod schema validation at route entry; reject 400 before streaming starts.

### C2 — No Heartbeat / Backpressure in SSE Bridge
- **Files:** `packages/sse-bridge/src/sse-formatter.ts`, `packages/chat-gateway/src/routes/chat.ts:152`
- **Issue:** Keepalive comment exists but isn't wired. No `setInterval` in `SSEStreamWriter`; no `stream.once('drain')` hookup; no client-disconnect detection.
- **Impact:** Long streams time out at proxies; compute leaks on disconnect.
- **Fix:** Keepalive loop (30s); drain handling; abort on client disconnect.

### C3 — Missing Error Envelope in Multi-Destination Adapter
- **Files:** `packages/chat-gateway/src/adapters/`
- **Issue:** `toolResult` events lack a required `status: 'success' | 'error'` field; errors silently convert to success.
- **Impact:** Breaks error recovery in the agent loop.
- **Fix:** Enforce a toolResult schema with a required `status` field.

## High-Priority Findings

### H1 — TypeScript Strict Mode Inconsistency
- Only `chat-gateway` and `web` explicitly enable `strict: true`. Others inherit from root but it isn't documented.
- 793 instances of `any` / `as any` / `@ts-ignore` across `src/`.
- **Fix:** Explicit `strict: true` in every `tsconfig.json`; quarantine type escape hatches in a named adapter layer.

### H2 — No Runtime Validation at Shared Type Boundary
- **File:** `packages/shared/src/types/tenant.ts`
- **Issue:** Plain interfaces; malformed tenant config from DDB crashes model-routing silently.
- **Fix:** Zod schemas exported next to types; validate at load time.

### H3 — ConverseStream State Machine Edge Case
- **File:** `packages/core/src/agent/bedrock-model.ts:324-440`
- **Issue:** If `messageStop` arrives before accumulated `toolInput` flushes, the tool call is lost.
- **Fix:** Flush pending tool blocks in the `messageStop` handler before emitting finish.

### H4 — CLI Token Expiry Not Validated
- **File:** `packages/cli/src/commands/login.ts`
- **Issue:** No expiry check on subsequent commands; 1h token silently used after expiry → mysterious 401s.
- **Fix:** Refresh check in `APIClient`.

### H5 — CodeCommit 5MB Batch Silently Skips Large Files
- **File:** `packages/cli/src/utils/codecommit.ts:70-74`
- **Issue:** Files >5MB are skipped with no warning. User thinks repo fully pushed.
- **Fix:** Warn on skip; consider multi-commit strategy for IaC-sized files.

### H6 — `findProjectRoot()` Not Monorepo-Aware
- **File:** `packages/cli/src/utils/project.ts`
- **Issue:** Stops at first `package.json`. Running `chimera` from `packages/core/` resolves to that sub-package.
- **Fix:** Detect `workspaces` field to find monorepo root.

### H7 — Amplify v6 Auth Session Listener Not Cleaning Up
- **File:** `packages/web/src/hooks/use-auth.tsx:29-47`
- **Issue:** No `AbortController` on unmount; stale cached session may be reused on rapid re-auth.
- **Fix:** Abort signal; cancel pending auth calls on unmount.

## Medium-Priority Findings

| # | Area | Issue | Fix |
|---|------|-------|-----|
| M1 | chat-gateway | Default `cors()` allows all origins | Restrict to configured URLs |
| M2 | chat-gateway | Slack URL-verification bypass (signature check comes after verification) | Reorder |
| M3 | core | No retry wrapper for Bedrock 429/network | Add exponential backoff |
| M4 | chat-gateway | Middleware order undocumented | Document + test |
| M5 | runtime | `getToolsForTenant()` returns `[]` on crash without observability | Emit metric/log |
| M6 | web | Bundle size not budgeted | Add size-limit check |
| M7 | web | No React error boundaries | Wrap routes |
| M8 | sse-bridge | Stream `tee` swallows errors without logging | Log on catch |
| M9 | cli | No exit-code standard | Standardize |
| M10 | chat-gateway | AI SDK DSP version pinned as string `v1` | Lift to constant; plan for v2 |

## Package-by-Package Snapshot

| Package | Status | Top Issues |
|---------|--------|------------|
| `@chimera/shared` | Solid structure | No runtime validation |
| `@chimera/core` | Well-organized | ConverseStream edge case, no retry, strict off |
| `@chimera/sse-bridge` | Logic correct | Heartbeat, backpressure, error logging |
| `@chimera/chat-gateway` | Strong pattern | Request validation, CORS, silent tool failures |
| `@chimera/cli` | Good UX | Token expiry, large-file skip, monorepo root |
| `@chimera/web` | No XSS | Session cleanup, error boundaries, bundle size |

## Cross-Cutting Findings

- ✅ Workspace protocol: 6 `workspace:*` refs, no cycles.
- ✅ TS project references correct.
- ⚠️ TS strictness inconsistent.
- ⚠️ 38 failing tests, mostly live-AWS dependent; needs tagging & CI exclusion list already in place, but a `skip` vs `legitimately broken` breakdown is missing.

## SSE Bridge Complexity — Verdict: Justified

AI SDK v5 does NOT provide:
- Native Strands → DSP translation (event schema mapping)
- Multi-step ReAct loop state (tool_use → execution → continuation)
- Backpressure bridging between async Strands streams and HTTP SSE

760 LOC is minimal for that responsibility. Keep the bridge; harden it (C2).

## Top 5 Summary

1. **Request validation missing** → Zod at HTTP entry
2. **SSE keepalive/backpressure** → implement heartbeat + drain
3. **Tool error envelope missing** → enforce `status` field
4. **TS strictness gap** → global `strict: true` + quarantine escape hatches
5. **ConverseStream race** → flush pending tool blocks before finish
