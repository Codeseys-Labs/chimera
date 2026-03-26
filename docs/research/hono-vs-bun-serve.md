---
title: "Hono vs Bun.serve(): Framework Trade-off Analysis"
status: canonical
version: 1.0.0
last_updated: 2026-03-26
references: [ADR-029]
---

# Hono vs Bun.serve(): Framework Trade-off Analysis

> **Context:** AWS Chimera's `packages/chat-gateway` runs Hono on Bun in production ECS containers. This document analyzes whether to keep Hono or migrate to raw `Bun.serve()`.
> **Recommendation up front: Keep Hono.** See justification below.

---

## Feature Comparison

| Feature | Hono | Bun.serve() |
|---|---|---|
| **Routing** | Built-in, declarative (`app.get('/path', handler)`) | Manual (`URL.pathname` switch or regex) |
| **Middleware** | Middleware chain (`.use()`) — composable and ordered | Manual composition, no standard pattern |
| **Request validation** | `@hono/zod-validator` — request body + query validated declaratively | Manual `zod.parse()` in each handler |
| **WebSocket** | `hono/ws` adapter (extra overhead) | Native `Bun.serve({ websocket: {...} })` — best-in-class |
| **Testing** | `createAdaptorServer` + supertest; or `app.request()` | Direct `fetch(server.url, ...)` — no adapter needed |
| **Bundle size** | ~13 kB minified (negligible in server context) | 0 (built-in) |
| **TypeScript** | First-class types — `Context`, typed middleware | No dedicated types; `Request`/`Response` only |
| **Portability** | Works on Node, Bun, Cloudflare Workers, Deno | Bun only |
| **SSE** | `streamSSE` helper | Manual `ReadableStream` + `TransformStream` |
| **OpenAPI / docs** | `@hono/swagger-ui`, `@hono/zod-openapi` | Manual |
| **Error handling** | `app.onError()` global handler | Manual try/catch per handler |
| **Response helpers** | `c.json()`, `c.text()`, `c.html()`, `c.stream()` | `new Response(JSON.stringify(body), { headers })` |
| **JWT / auth** | `@hono/jwt` middleware | Manual `jwt.verify()` in each handler |
| **Rate limiting** | `@hono/rate-limiter` | Manual |

---

## Performance

Hono on Bun adds negligible overhead for typical API workloads. Hono's own benchmarks show it as one of the fastest Node/Bun frameworks; its routing layer uses a radix trie and avoids per-request allocations.

For Chimera's use cases (chat messages, SSE streams, webhook callbacks from Slack/Discord/Teams/Telegram), the bottleneck is always the downstream DynamoDB call or SSE flush — not the router overhead. The difference between Hono and raw `Bun.serve()` is sub-millisecond per request.

**WebSocket exception:** If Chimera ever adds a high-volume WebSocket endpoint (e.g., real-time agent coordination), `Bun.serve()`'s native WebSocket handler is meaningfully faster than Hono's WS adapter because it avoids the message-level adapter overhead. This is a concrete future reason to migrate that endpoint, but not the rest of the gateway.

---

## Code Comparison

### Route Handler: Hono vs Bun.serve()

**Hono:**
```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const app = new Hono();

const messageSchema = z.object({
  tenantId: z.string(),
  content: z.string(),
});

app.post('/message',
  zValidator('json', messageSchema),
  async (c) => {
    const { tenantId, content } = c.req.valid('json');
    // tenantId and content are typed correctly here
    const result = await processMessage(tenantId, content);
    return c.json({ id: result.id });
  }
);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});
```

**Bun.serve():**
```typescript
import { z } from 'zod';

const messageSchema = z.object({
  tenantId: z.string(),
  content: z.string(),
});

Bun.serve({
  port: 8080,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/message') {
      try {
        const body = await req.json();
        const { tenantId, content } = messageSchema.parse(body);
        const result = await processMessage(tenantId, content);
        return Response.json({ id: result.id });
      } catch (err) {
        if (err instanceof z.ZodError) {
          return Response.json({ error: err.message }, { status: 400 });
        }
        console.error(err);
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
});
```

The Bun.serve() version requires manual routing, manual error classification, manual JSON response construction, and cannot share validation/error patterns across routes without additional abstractions — which is exactly what Hono provides.

### Middleware: Hono vs Bun.serve()

**Hono (auth + rate-limit middleware):**
```typescript
app.use('*', verifyJwt);
app.use('/message', rateLimitMiddleware);
```

**Bun.serve() equivalent:**
```typescript
async fetch(req) {
  // Must manually call middleware for every route
  const authResult = await verifyJwt(req);
  if (!authResult.ok) return authResult.response;

  const url = new URL(req.url);
  if (url.pathname === '/message') {
    const rateResult = await checkRateLimit(req);
    if (!rateResult.ok) return rateResult.response;
    // ... handler
  }
  // ...
}
```

This pattern does not scale. With 8+ route groups (chat, SSE, Slack, Discord, Teams, Telegram, health, internal), the manual composition becomes brittle.

---

## Current Chimera Architecture Fit

Hono is already the correct choice for Chimera's gateway given:

1. **Multi-adapter pattern** — 4+ platform adapters (Slack, Discord, Teams, Telegram) each with their own auth and signature verification middleware. Hono's `.use()` per-route or per-group middleware is essential.

2. **ADR-029 nuance** — The existing ADR-029 documents the `export default app` vs named export issue. The solution (named export + explicit `@hono/node-server` serve call) works precisely because Hono decouples the app definition from transport binding. `Bun.serve()` would merge these and require different test infrastructure.

3. **Test compatibility** — `app.request()` (Hono's built-in test method) allows testing routes without any HTTP overhead. `Bun.serve()` requires starting a real server and calling it with `fetch`.

4. **Portability** — Chimera's test suite runs under both Bun (CI) and potentially Node (developer machines). Hono works on both; `Bun.serve()` does not.

---

## Recommendation

**Keep Hono.**

The middleware ecosystem, TypeScript ergonomics, and portability outweigh the negligible performance advantage of raw `Bun.serve()` for Chimera's API workloads.

**Future exception — WebSocket-heavy features:** If a dedicated real-time WebSocket endpoint is ever added (e.g., for agent-to-agent streaming), use `Bun.serve({ websocket: {...} })` for that specific server, separate from the Hono gateway. Do not migrate the entire gateway.

**Decision record:** See ADR-029 for the formal rationale on named exports and adapter usage.

---

## Migration Cost Estimate (for reference only)

If a future team ever decided to migrate away from Hono:

| Component | Effort | Notes |
|---|---|---|
| Route migration (8 route groups) | M | Manual routing switch, ~800 lines |
| Middleware migration (auth, rate-limit, logging) | M | Rewrite as plain functions |
| Test migration | S | Replace createAdaptorServer with fetch calls |
| OpenAPI / Swagger removal | XS | Delete @hono/swagger-ui |
| SSE streaming | S | Replace streamSSE with manual ReadableStream |
| **Total** | **L** | ~2 days, high risk of regression |

Given this cost and Chimera's current stable Hono integration, migration is not recommended.
