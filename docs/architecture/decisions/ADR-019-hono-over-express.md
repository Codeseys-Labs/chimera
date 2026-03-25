---
title: 'ADR-019: Hono over Express for HTTP Gateway'
status: accepted
date: 2026-03-24
decision_makers: [chimera-architecture-team]
---

# ADR-019: Hono over Express for HTTP Gateway

## Status

**Accepted** (2026-03-24)

## Context

AWS Chimera's chat gateway (`packages/chat-gateway`) requires an HTTP framework for:
- REST API endpoints (authentication, tenant management, health checks)
- WebSocket-like streaming (SSE over HTTP POST)
- Multi-tenant request routing
- JWT authentication middleware
- Integration with Vercel AI SDK for chat streaming

The gateway must support:
- **Edge runtime compatibility** - potential deployment to CloudFront Functions or Lambda@Edge
- **Minimal dependencies** - smaller Docker images for faster ECS deployments
- **TypeScript-first design** - type safety without manual @types packages
- **Streaming responses** - Server-Sent Events (SSE) for chat completions
- **High performance** - low latency for multi-tenant agent coordination

The decision is whether to use **Express.js** (industry standard, mature ecosystem) or **Hono** (modern, edge-first, TypeScript-native).

## Decision

Use **Hono v4.7+** as the HTTP framework for `packages/chat-gateway`.

**Key characteristics:**
- TypeScript-first with zero external type dependencies
- Web Standards API (Request/Response) for edge runtime portability
- Middleware composability similar to Express
- Built-in support for streaming responses
- 4x smaller bundle size than Express (~50KB vs 200KB)
- Compatible with Bun, Node.js, Deno, CloudFlare Workers, Lambda@Edge

**Implementation:**
```typescript
import { Hono } from 'hono';
import { Context } from 'hono';

const app = new Hono();

app.post('/v1/chat/completions', async (c: Context) => {
  // Hono Context provides Web Standards Response interface
  return c.streamText(async (stream) => {
    // SSE streaming via Vercel AI SDK
  });
});
```

## Alternatives Considered

### Alternative 1: Express.js
Use Express v4/v5 with `@types/express`.

**Pros:**
- Industry standard (14M weekly downloads)
- Massive ecosystem of middleware
- Team familiarity
- Proven at scale (Netflix, Uber, PayPal)

**Cons:**
- ❌ **Node.js-only** - cannot run on edge runtimes (CloudFront Functions, Lambda@Edge)
- ❌ **Callback-based middleware** - harder to use with async/await
- ❌ **Requires @types/express** - type definitions lag behind runtime
- ❌ **Large bundle size** - 200KB minified + dependencies
- ❌ **No native streaming support** - requires manual `res.write()` for SSE
- ❌ **Legacy Request/Response objects** - not Web Standards compliant

**Verdict:** Rejected due to lack of edge runtime compatibility and larger bundle size.

### Alternative 2: Fastify
Use Fastify v5 for performance-focused HTTP.

**Pros:**
- Faster than Express (2x throughput in benchmarks)
- Built-in schema validation (JSON Schema)
- Good TypeScript support
- Plugin ecosystem

**Cons:**
- ❌ **Node.js-only** - same runtime limitation as Express
- ❌ **More complex** - schema-first design adds cognitive overhead
- ❌ **Overkill for our use case** - we don't need Fastify's advanced features
- ❌ **Smaller ecosystem** than Express

**Verdict:** Rejected due to runtime portability concerns.

### Alternative 3: Hono (Selected)
Use Hono v4.7+ with Web Standards API.

**Pros:**
- ✅ **Edge runtime ready** - runs on CloudFront Functions, Lambda@Edge, CloudFlare Workers
- ✅ **Web Standards API** - uses native Request/Response (portable across runtimes)
- ✅ **TypeScript-first** - no separate @types package needed
- ✅ **Small bundle size** - 50KB minified (4x smaller than Express)
- ✅ **Streaming built-in** - native support for SSE and streaming responses
- ✅ **Middleware composability** - Express-like API with async/await
- ✅ **Bun-optimized** - 30% faster on Bun runtime than Node.js
- ✅ **Multi-runtime** - same code works on Bun, Node, Deno, edge runtimes

**Cons:**
- Smaller ecosystem than Express (but rapidly growing)
- Newer framework (2022 vs Express 2010)
- Less Stack Overflow content

**Verdict:** Selected for edge portability, TypeScript-first design, and smaller bundle size.

## Consequences

### Positive

- **Edge deployment ready**: Can migrate from ECS Fargate to Lambda@Edge or CloudFront Functions without code changes
- **Faster Docker builds**: 50KB framework vs 200KB means faster image pulls in ECS
- **Better TypeScript experience**: No type lag - Hono's types are always in sync with runtime
- **Native streaming**: SSE for chat completions works out-of-the-box with Vercel AI SDK
- **Future-proof**: Web Standards API means code is portable across any JavaScript runtime
- **Performance**: 30% faster on Bun runtime (our primary runtime) vs Express on Node
- **Smaller attack surface**: Fewer dependencies = fewer CVEs to patch

### Negative

- **Less mature ecosystem**: Fewer third-party middleware libraries than Express
- **Team ramp-up**: Engineers familiar with Express need to learn Hono's API (minimal differences)
- **Less documentation**: Hono docs are good but not as comprehensive as Express

### Risks

- **Framework longevity**: Hono is newer (2022) - could be abandoned (mitigated by TypeScript-first design making migration easier)
- **Missing middleware**: Some Express middleware doesn't have Hono equivalents (mitigated by writing custom middleware when needed)

## Evidence

- **Implementation**: `packages/chat-gateway/package.json` shows `"hono": "^4.7.8"`
- **Usage**: `packages/chat-gateway/src/routes/*.ts` all use Hono routers
- **Benchmarks**: Hono is 4x faster than Express in [Web Frameworks Benchmark](https://github.com/fastify/benchmarks)
- **Bundle size**: Express = 209KB, Hono = 51KB (measured via bundlephobia.com)
- **Mulch record mx-918de3**: "docs-npm-npx-consistency: Documentation must use 'bun install' not 'npm install'"
- **Mulch record mx-2f9c6d**: "bun-exclusive-package-manager: Project uses bun exclusively"
- **Package ecosystem**: Hono has 15+ official middleware packages covering auth, CORS, JWT, rate limiting

## Related Decisions

- **ADR-004** (Vercel AI SDK): Hono's Context provides Response-compatible interface for SSE streaming
- **ADR-015** (Bun toolchain): Hono is optimized for Bun runtime (30% faster than Node.js)
- **ADR-020** (Two-container Docker): Smaller framework = smaller Docker images
- **ADR-005** (AWS CDK): Hono's edge compatibility enables future migration to Lambda@Edge

## References

1. Hono Documentation: https://hono.dev/
2. Web Standards Request/Response: https://developer.mozilla.org/en-US/docs/Web/API/Request
3. Express vs Hono Bundle Size: https://bundlephobia.com/
4. Hono Performance Benchmarks: https://github.com/honojs/hono#benchmarks
5. Implementation: `packages/chat-gateway/src/routes/` directory
