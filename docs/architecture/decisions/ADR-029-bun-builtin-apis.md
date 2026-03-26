---
title: 'ADR-029: Bun Built-in APIs — Named Exports and Node-Server Adapter'
status: accepted
date: 2026-03-26
decision_makers: [chimera-architecture-team]
---

# ADR-029: Bun Built-in APIs — Named Exports and Node-Server Adapter

## Status

**Accepted** (2026-03-26)

## Context

AWS Chimera's chat gateway (`packages/chat-gateway`) runs as a Bun process in production Docker containers. Bun is both the package manager and the runtime for all TypeScript services.

Bun exposes a set of **built-in APIs** — `Bun.serve()`, `Bun.file()`, `Bun.write()`, `Bun.hash()`, etc. — that are faster than their Node.js counterparts but are Bun-specific (not available under Node.js). It also has an **implicit HTTP server behavior** distinct from both Node.js and `Bun.serve()`:

> When a module's entry point has `export default { fetch }` (or any object with a `.fetch` method as the default export), Bun **automatically starts a built-in HTTP server** before the module's top-level code runs.

During development of the chat gateway, this implicit behavior caused a **port-collision crash** in Docker. The server startup sequence looked like this:

```typescript
// PROBLEMATIC pattern (caused by Bun auto-serve)
const app = new Hono();
// ... routes ...

export default app;   // ← Bun sees .fetch on Hono app, auto-starts server on PORT

if (require.main === module) {
  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port: Number(PORT) }, ...);
  // ↑ Second bind attempt → "address already in use" crash
}
```

The crash surface:
- Bun 1.x auto-serve fires at module load time, before `if (require.main === module)` runs
- Docker container logs show "Started development server" then immediately "Error: listen EADDRINUSE :::8080"
- ECS task enters crash-restart loop; ALB health checks fail; deployment circuit breaker fires

A second concern is **test compatibility**. Chimera's unit and integration tests run under both Bun's test runner (`bun test`) and Node.js-based tools. Bun-specific APIs (`Bun.serve`, `Bun.file`) would require mocking under Node.js.

The decision covers:
1. Whether to use Bun-native HTTP serving (`Bun.serve()` or implicit auto-serve) or Node.js-compatible adapters
2. How to structure module exports to avoid implicit Bun behaviors

## Decision

**Use `@hono/node-server` for HTTP serving and named exports for all Hono apps. Never use `export default` on a Hono app or any object with a `.fetch` method.**

**Implementation:**

```typescript
// packages/chat-gateway/src/server.ts

const app = new Hono();
// ... routes ...

// Named export for library/test use.
// NOTE: Do NOT add `export default app` here. Bun detects a default export
// with a .fetch method and auto-starts a built-in HTTP server ("Started
// development server"), which races with the explicit serve() below and causes
// "port already in use" crashes in the Docker container.
export { app };

// Start server only when this module is the entry point (not when imported by tests).
if (require.main === module) {
  (async () => {
    const { serve } = await import('@hono/node-server');
    const PORT = process.env.PORT || 8080;

    serve({
      fetch: app.fetch,
      port: Number(PORT),
    }, (info) => {
      console.log(`Chimera chat gateway listening on port ${info.port}`);
    });
  })();
}
```

**Key rules:**
1. `export { app }` (named export) — not `export default app`
2. `require.main === module` guard ensures server starts exactly once as entry point
3. `@hono/node-server` adapter used for HTTP binding — compatible with both Node.js tests and Bun production
4. Route modules use `export default router` (Hono Router objects do not have `.fetch` methods — only full Hono app instances trigger auto-serve)

## Alternatives Considered

### Alternative 1: `Bun.serve()` (Bun-Native HTTP)

Use Bun's built-in HTTP server directly:

```typescript
export default {
  fetch: app.fetch,
  port: 8080,
};
```

**Pros:**
- Fastest HTTP serving — Bun's HTTP implementation is ~2x faster than Node.js
- Zero dependencies for serving — no `@hono/node-server` package needed
- Native WebSocket support via `Bun.serve({ websocket: ... })`

**Cons:**
- ❌ **Crashes in Docker** — auto-serve fires immediately at module load, before runtime checks; explicit `serve()` call collides with it
- ❌ **Test incompatibility** — `Bun.serve()` is unavailable in Node.js test environments, requiring extensive mocking
- ❌ **Not needed for Chimera** — the 2x throughput advantage is irrelevant; bottleneck is DynamoDB and LLM latency, not HTTP parsing
- ❌ **No graceful shutdown hook** — `Bun.serve()` has different shutdown API than Node.js `server.close()`

**Verdict:** Rejected due to crash behavior and test incompatibility.

### Alternative 2: `export default app` with Bun Auto-Serve (Selected-then-Rejected)

Let Bun manage server startup implicitly:

```typescript
export default app;  // Bun starts HTTP server automatically
```

**Pros:**
- Zero boilerplate for server startup
- Bun handles port from `process.env.PORT` automatically

**Cons:**
- ❌ **Double-bind crash** — any `serve()` call after module load collides with Bun's auto-server
- ❌ **Non-deterministic behavior** — auto-serve port selection differs between `bun server.ts` (respects `PORT` env) and `bun run start` (may use default 3000)
- ❌ **Hidden behavior** — the server starting is not visible in the source code; confusing for developers unfamiliar with Bun's behavior
- ❌ **Incompatible with test imports** — any test that imports `server.ts` would trigger a server start

**Verdict:** Rejected. This was the original bug that prompted this ADR.

### Alternative 3: `@hono/node-server` with Named Export (Selected)

Use Node.js-compatible adapter with explicit named export:

```typescript
export { app };  // Named export, no .fetch trigger

if (require.main === module) {
  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port: Number(PORT) });
}
```

**Pros:**
- ✅ **No auto-serve collision** — named export doesn't trigger Bun's HTTP auto-start
- ✅ **Test-safe imports** — tests import `app` without starting a server
- ✅ **Node.js compatible** — `@hono/node-server` runs identically under Node.js and Bun
- ✅ **Explicit control** — server start is visible and guarded by `require.main` check
- ✅ **Graceful shutdown** — Node.js server lifecycle APIs available

**Cons:**
- Slight startup overhead vs native `Bun.serve()` (~5ms, negligible)
- One additional npm dependency (`@hono/node-server`)

**Verdict:** Selected. Correctness and test compatibility outweigh the marginal performance difference.

## Consequences

### Positive

- **No Docker port crashes**: Named export + `require.main` guard eliminates the double-bind race condition
- **Test isolation**: Tests import `app` without side effects; no mock infrastructure needed for `Bun.serve`
- **Portable**: Server code runs under both Bun (production) and Node.js (tests, local dev without Bun)
- **Explicit startup**: Server initialization is visible in source, not hidden in Bun's module loading behavior
- **Predictable port binding**: Port controlled entirely by `process.env.PORT`, no Bun auto-detect

### Negative

- **Bun-native speed not used**: `@hono/node-server` is ~5% slower than `Bun.serve()` for raw HTTP throughput (not meaningful for Chimera's latency profile)
- **Gotcha for new developers**: Chimera forbids `export default app` for Hono apps — must be documented and enforced in code review

### Risks

- **New packages forgetting the rule**: Future packages adding Hono servers may accidentally use `export default app` (mitigated by: this ADR, CLAUDE.md documentation, and the existing code serving as a template)
- **Bun version changes**: Future Bun versions may change auto-serve trigger conditions (mitigated by: named exports are always safe regardless)

## Evidence

- **Bug reproduction**: `packages/chat-gateway/src/server.ts` comment at line 84 documents the exact failure mode
- **Fix implementation**: `export { app }` at line 88, `require.main === module` guard at line 94
- **Mulch record mx-21d28a**: "bun-default-export-fetch-auto-serve: Bun auto-starts an HTTP server when a module has `export default` with a `.fetch` method"
- **Failure**: ECS task crash-restart loop, ALB health checks failing, deployment circuit breaker firing after Docker build during Phase 7

**Why `require.main === module` works under Bun:**

In Node.js CJS, `require.main !== module` when a file is imported (not run directly). Bun's CJS compatibility layer follows the same convention: for the bundle entry file (`bun server.js`), Bun sets `require.main === module`. For imported modules (test imports), it does not. This makes the guard reliable across both runtimes.

## Related Decisions

- **ADR-015** (Bun toolchain): Bun is the runtime for all TypeScript services; this ADR documents a Bun-specific behavior to avoid
- **ADR-019** (Hono over Express): Hono's fetch-based handler is what triggers Bun's auto-serve detection
- **ADR-020** (Two-stage Docker): The Docker container startup sequence is where the auto-serve crash manifests

## References

1. Bun HTTP server documentation: https://bun.sh/docs/api/http
2. Bun auto-serve behavior: https://bun.sh/docs/runtime/web-apis#fetch
3. `@hono/node-server` adapter: https://hono.dev/docs/getting-started/nodejs
4. Implementation: `packages/chat-gateway/src/server.ts`
5. Mulch record mx-21d28a: bun-default-export-fetch-auto-serve
