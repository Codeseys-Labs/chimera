---
title: Stream 3 — Frontend Rebuild
status: draft
references: [ADR-027, ADR-028]
priority: P1
estimated_effort: XL
---

## Objective

Replace the 11 static HTML files in `packages/chat-gateway/public/` with a proper React+Vite+shadcn/ui application in `packages/web/`. The new frontend integrates with the existing Cognito user pool for auth, calls the chat-gateway API for real-time SSE streaming, and deploys via S3+CloudFront instead of being served by the Hono process.

## Background (reference ADRs)

ADR-027 (pending) documents the decision to adopt shadcn/ui + Vite over alternatives (Next.js, plain React, Remix). ADR-028 (pending) covers the CloudFront deployment architecture and Cognito integration approach.

Key existing patterns:
- `chat-gateway-hono-route-pattern` (mulch): Route handlers use `async (c: Context)` not `(req, res)`
- `bun-default-export-fetch-auto-serve` (mulch): Bun auto-starts HTTP on default export — relevant if frontend dev server conflicts
- `alb-https-tls-conditional-pattern` (mulch): ChatStack ALB HTTPS uses optional cert prop

## Detailed Changes

### 1. Scaffold packages/web/

```bash
cd packages/web  # (create directory first)
bunx shadcn@latest init --template vite
```

This scaffolds React + Vite + TypeScript + Tailwind CSS + shadcn/ui base.

**`packages/web/package.json`** — add these after scaffolding:
```json
{
  "name": "@chimera/web",
  "private": true,
  "dependencies": {
    "@tanstack/react-router": "^1.x",
    "@tanstack/react-query": "^5.x",
    "@aws-amplify/auth": "^6.x",
    "@aws-amplify/core": "^6.x",
    "aws-amplify": "^6.x"
  }
}
```

**`package.json` (root)** — add to workspaces array:
```json
"workspaces": ["packages/*"]
```
(Verify `packages/web` is picked up — run `bun install` from root.)

**`packages/web/components.json`** (shadcn config):
```json
{
  "rsc": false,
  "tsx": true,
  "style": "default",
  "tailwind": { "baseColor": "neutral", "cssVariables": true },
  "aliases": { "components": "@/components", "utils": "@/lib/utils" }
}
```

### 2. Routing Setup

**`packages/web/src/main.tsx`**:
Configure TanStack Router with these routes:
- `/` → redirect to `/dashboard` if authenticated, else `/login`
- `/login` → `LoginPage`
- `/dashboard` → `DashboardPage` (protected)
- `/chat` → `ChatPage` (protected)
- `/admin` → `AdminPage` (protected)
- `/settings` → `SettingsPage` (protected)

All protected routes wrapped in `ProtectedRoute` component that redirects to `/login` if no active Amplify session.

### 3. Pages

**`packages/web/src/pages/login.tsx`**
- Cognito login form: email + password fields
- Social OAuth buttons (Google, if configured in existing pool)
- MFA flow (TOTP challenge screen)
- "Forgot password" flow
- Use shadcn `Card`, `Input`, `Button`, `Alert` components
- On success: navigate to `/dashboard`

**`packages/web/src/pages/dashboard.tsx`**
- Tenant overview cards: active sessions count, installed skills count, monthly cost (USD)
- Recent sessions table (last 10)
- Data from: `useQuery` hooks hitting `/tenants/{tenantId}` and `/sessions?limit=10`
- Use `Skeleton` components during loading
- Use shadcn `Card`, `Table`, `Badge`

**`packages/web/src/pages/chat.tsx`**
- Session selector (dropdown of existing sessions + "New session" option)
- Message thread: user messages right-aligned, agent messages left-aligned
- Input field + send button
- SSE streaming: agent responses stream token-by-token into the last message bubble
- Abort button visible during streaming
- Use shadcn `ScrollArea` for message thread
- Custom `ChatMessage` component with markdown rendering (`react-markdown` + `rehype-highlight`)

**`packages/web/src/pages/admin.tsx`**
- Tenant config section: tier display, feature flags (read-only unless admin role)
- User management table (if admin): list users, disable/enable
- API key management: show masked keys, rotate, revoke
- Use shadcn `Tabs`, `Table`, `Dialog` for user management

**`packages/web/src/pages/settings.tsx`**
- Account: display name, email (from Cognito)
- Security: change password, MFA setup/teardown
- Integrations: Slack workspace connection status, Discord bot invite link
- Theme selector: light/dark/system

### 4. Components

Install via shadcn CLI:
```bash
bunx shadcn@latest add button card input table dialog dropdown-menu tabs badge alert skeleton toast
```

Custom components to create in `packages/web/src/components/`:

**`chat-message.tsx`**: Renders a single chat message with role indicator, timestamp, markdown body, and streaming cursor (animated `|` when `isStreaming=true`).

**`session-list.tsx`**: Sidebar list of agent sessions with status badges and last-message preview.

**`skill-card.tsx`**: Card displaying a skill name, description, version, and install/uninstall button.

**`tenant-selector.tsx`**: Dropdown for switching between tenants (for admin users with multi-tenant access).

**`cost-chart.tsx`**: Monthly cost bar chart using `recharts` (add to dependencies). Shows cost breakdown by model.

**`theme-provider.tsx`**: Wraps app with `next-themes` (or a simple context) for dark/light/system switching.

### 5. Auth Integration

**`packages/web/src/lib/amplify-config.ts`** (new):
```typescript
import { Amplify } from 'aws-amplify'

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
      loginWith: { email: true, oauth: { ... } }
    }
  }
})
```

**`packages/web/.env.example`** (committed):
```
VITE_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
VITE_COGNITO_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_API_BASE_URL=https://api.example.com
```

**`packages/web/.env.local`** (gitignored): Real values for local dev.

**`packages/web/src/components/protected-route.tsx`**:
```typescript
// Checks Amplify.Auth.getCurrentUser() — redirects to /login if throws
```

Token management: Amplify handles access token refresh automatically. No manual token storage.

### 6. API Client

**`packages/web/src/lib/api-client.ts`**:
```typescript
async function authFetch(path: string, init?: RequestInit) {
  const session = await fetchAuthSession()
  const token = session.tokens?.idToken?.toString()
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers }
  })
}
```

**TanStack Query hooks** in `packages/web/src/hooks/`:
- `use-chat.ts`: `useMutation` for sending messages, manual SSE hook for streaming
- `use-sessions.ts`: `useQuery` for session list, `useInfiniteQuery` for pagination
- `use-skills.ts`: `useQuery` for skill catalog
- `use-tenant.ts`: `useQuery` for tenant profile/config

**SSE streaming** in `packages/web/src/lib/sse-client.ts`:
```typescript
// Uses EventSource or fetch with ReadableStream
// Appends tokens to message state as they arrive
// Calls onComplete callback when stream ends
```

### 7. Build Pipeline

**`packages/web/package.json`** scripts:
```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "lint": "eslint src --ext ts,tsx",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  }
}
```

**CDK: `infra/lib/frontend-stack.ts`** (new):
```typescript
// S3 bucket (use ChimeraBucket from Stream 2 constructs)
// CloudFront distribution with OAI
// Custom domain support (optional certificate prop, following alb-https-tls-conditional-pattern)
// CachePolicy: cache HTML for 0s, assets for 1yr
// Origin: S3 bucket via OAI
// DefaultRootObject: 'index.html'
// ErrorResponses: 403/404 → /index.html (SPA routing)
```

Add `FrontendStack` to `infra/bin/chimera.ts`.

**CodeBuild / CI**: Add `bun run build` step for `packages/web/` in the build pipeline. Copy `dist/` to S3, invalidate CloudFront.

### 8. Delete Old Frontend

**`packages/chat-gateway/src/server.ts`**:
- Remove `serveStatic` import and any middleware calling it
- Remove reference to `public/` directory

**`packages/chat-gateway/public/`**: Delete all 11 static files.

**CDK `infra/lib/chat-stack.ts`**: Remove any `ASSET_PATH` or volume mount referencing `public/`. Update task definition if it copies or serves static files.

## Acceptance Criteria

- [ ] `bun run build` in `packages/web/` completes without errors (Vite produces `dist/`)
- [ ] `bun run typecheck` in `packages/web/` passes
- [ ] Login page authenticates against existing Cognito pool (manual test)
- [ ] Dashboard displays tenant data fetched from chat-gateway API
- [ ] Chat page: messages send, responses stream token-by-token via SSE
- [ ] Dark mode toggle works and persists across page refresh
- [ ] `packages/chat-gateway/public/` directory is deleted
- [ ] `dist/` is in `.gitignore` (no build artifacts committed)
- [ ] FrontendStack synthesizes via `npx cdk synth` without errors

## Test Requirements

**Unit tests** in `packages/web/src/__tests__/`:
- `api-client.test.ts`: Mock `fetchAuthSession`, verify auth header is set correctly
- `sse-client.test.ts`: Verify token accumulation and stream completion callback
- `use-sessions.test.ts`: Mock API, verify query hook returns session list

**Component tests** (Vitest + Testing Library):
- `chat-message.test.tsx`: Render with various props, verify markdown renders, verify streaming cursor shown when `isStreaming=true`
- `protected-route.test.tsx`: Verify redirect to `/login` when unauthenticated

## Dependencies on Other Streams

- **None** — fully independent. Can start immediately.
- Note: FrontendStack CDK construct benefits from `ChimeraBucket` (Stream 2) but can use raw `s3.Bucket` if Stream 2 is not complete.

## Risk Assessment

- **Medium**: Amplify v6 auth configuration is verbose — use `amplify_outputs.json` format if v6 supports it, otherwise manual `Amplify.configure()`
- **Medium**: SSE streaming in browser requires careful ReadableStream handling across browsers — test in Chrome, Firefox, Safari
- **Low**: Static HTML deletion — verify no CDK construct references `public/` before deleting
- **Low**: The old frontend is not production-critical (it's a dev UI); breakage during transition has low blast radius
- **Mitigation**: Keep the static files in place until the new frontend passes acceptance criteria, then delete in the same commit
