---
title: 'ADR-027: React + Vite + shadcn/ui for Web Frontend'
status: accepted
date: 2026-03-26
decision_makers: [chimera-architecture-team]
---

# ADR-027: React + Vite + shadcn/ui for Web Frontend

## Status

**Accepted** (2026-03-26)

## Context

AWS Chimera currently has no real web frontend. The packages/chat-gateway/public/ directory contains 11 static HTML/JS files (index.html, login.html, dashboard.html, admin.html, settings.html, plus associated .js and .css) that serve as a basic prototype. These files:

- Use vanilla JavaScript with createElement + textContent (for XSS safety)
- Have no build pipeline, no TypeScript, no component library
- Cannot render complex UIs (agent session management, skill marketplace, billing dashboard)
- Are served directly by the Hono HTTP server via static file middleware

The platform needs a production frontend for:
- Agent chat interface: Real-time streaming with SSE, conversation history, tool execution visualization
- Tenant dashboard: Usage analytics, cost tracking, quota management
- Skill marketplace: Browse, install, configure skills
- Admin panel: User management, Cedar policy editor, deployment status
- Settings: API keys, notification preferences, team management

## Decision

Use **React 19 + Vite + TypeScript + shadcn/ui v4** as the web frontend stack, deployed as a new packages/web/ package.

**Stack breakdown:**

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | React 19 | Largest ecosystem, Vercel AI SDK React hooks, AWS Amplify support |
| Build tool | Vite | Sub-second HMR, native TypeScript, Bun-compatible |
| Component library | shadcn/ui v4 | Radix primitives + Tailwind, copy-paste ownership, dark mode |
| Router | TanStack Router | Type-safe routes, file-based routing, code splitting |
| Data fetching | TanStack Query | Caching, background refresh, optimistic updates |
| Deployment | S3 + CloudFront | Static SPA, CDN-distributed, no server needed |

**Scaffolding:** bunx shadcn@latest init --template vite

**Package structure:**
```
packages/web/
  src/
    components/     # shadcn/ui + custom components
    routes/         # TanStack Router file-based routes
    hooks/          # Custom hooks (useAgent, useSSE)
    lib/            # Utilities, API client
    main.tsx
  public/
  index.html
  vite.config.ts
  tailwind.config.ts
  tsconfig.json
  package.json
```

**Key design choices:**
- shadcn/ui over a pre-packaged component library: Components copied into project, full ownership
- Dark mode by default: Chimera is a developer tool
- TanStack over React Router: Type-safe route params, built-in data loading

## Alternatives Considered

### Alternative 1: Next.js
**Pros:** SSR for SEO, API routes, large ecosystem
**Cons:** SSR unnecessary for authenticated dashboard, requires Node.js server, Vercel-optimized
**Verdict:** Rejected. A SPA served from S3+CloudFront is simpler and sufficient.

### Alternative 2: Vue.js + Nuxt
**Pros:** Simpler learning curve, good SSG support
**Cons:** Smaller ecosystem, no Amplify Gen 2 support, no Vercel AI SDK React hooks
**Verdict:** Rejected. React ecosystem alignment with AWS Amplify and Vercel AI SDK.

### Alternative 3: Material UI (MUI)
**Pros:** Comprehensive (100+ components), enterprise-proven
**Cons:** ~300KB gzipped, Material Design aesthetic, dependency lock-in, runtime CSS-in-JS
**Verdict:** Rejected. shadcn/ui is lighter, more customizable, avoids lock-in.

### Alternative 4: Keep Vanilla JS
**Pros:** Zero build pipeline, already exists
**Cons:** No TypeScript, no components, no state management, no design system
**Verdict:** Rejected. Prototype-only quality, not suitable for production.

## Consequences

### Positive
- Rich UIs: Real-time agent chat with streaming, dashboards, skill marketplace
- Type safety: End-to-end TypeScript from API to UI
- Component ownership: shadcn/ui components are project-owned
- CDN deployment: S3 + CloudFront = no server, global distribution

### Negative
- New package: Adds ~5,000-10,000 LOC
- Build pipeline: CodeBuild needs a frontend build step
- Old frontend removal: packages/chat-gateway/public/ becomes dead code

### Risks
- Bundle size growth (mitigated by: Vite code splitting, TanStack Router lazy routes)
- API contract drift (mitigated by: shared types in @chimera/shared)

## Evidence

- **packages/chat-gateway/public/**: 11 static files
- **No packages/web/ directory exists**
- **docs/analysis/2026-03-26-project-snapshot.md**: "No frontend code exists"
- **Vercel AI SDK**: Already used in @chimera/sse-bridge — React hooks are natural extension

## Related Decisions

- **ADR-004** (Vercel AI SDK): React hooks for chat streaming
- **ADR-019** (Hono): Chat gateway serves frontend's API calls
- **ADR-028** (Amplify Gen 2 auth): Frontend authentication strategy

## References

1. React 19: https://react.dev/
2. Vite: https://vitejs.dev/
3. shadcn/ui: https://ui.shadcn.com/
4. TanStack Router: https://tanstack.com/router
5. TanStack Query: https://tanstack.com/query
6. Current static files: packages/chat-gateway/public/
