# Express → Hono Migration Status

## ✅ Completed

### Dependencies
- ✅ Removed: `express`, `@types/express`, `cors`, `@types/cors`, `supertest`, `@types/supertest`
- ✅ Added: `hono@^4.7.8`, `@hono/node-server@^1.14.0`
- ✅ Updated package.json description and keywords

### Core Infrastructure
- ✅ **server.ts**: Full Hono app initialization, middleware chain, error handling
  - Converted to `app = new Hono()`
  - Middleware uses `app.use()` and `app.route()`
  - Error handling via `app.onError()`
  - Server startup wrapped in async IIFE (to avoid top-level await)

### Middleware (Fully Converted)
- ✅ **tenant.ts**: `extractTenantContext()` and `extractTenantContextWithValidation()`
  - Changed from `(req, res, next) => void` to `async (c, next) => Promise<Response | void>`
  - `req.headers['x-tenant-id']` → `c.req.header('x-tenant-id')`
  - `req.tenantContext` → `c.set('tenantContext', {...})`
  - `res.status(401).json({})` → `c.json({}, 401)`

- ✅ **auth.ts**: `authenticateJWT()`, `requireGroup()`, `optionalAuth()`
  - JWT verification using `aws-jwt-verify`
  - `req.auth` → `c.set('auth', {...})`
  - `extractToken(req)` → `extractToken(c)` using `c.req.header('authorization')`

- ✅ **rate-limit.ts**: `rateLimitMiddleware()` and `recordMetricsMiddleware()`
  - `req.tenantContext` → `c.get('tenantContext')`
  - `res.setHeader()` → `c.header()`
  - Async body parsing changes applied

### Routes
- ✅ **health.ts**: Fully converted
  - `router.get('/health', (_req: Request, res: Response) => {...})`
  - → `router.get('/health', (c: Context) => c.json({}, 200))`

- ✅ **chat.ts**: Partially converted (2 endpoints done)
  - `/stream` endpoint: Converted to Hono Context API
  - `/message` endpoint: Converted to Hono Context API
  - `req.body` → `await c.req.json()`
  - `req.tenantContext` → `c.get('tenantContext')`
  - **NOTE**: SSE streaming (`streamStrandsToDSP`) may need adapter for Hono Response

- ✅ **auth.ts**: Partially converted (2 endpoints done)
  - `/config` endpoint: Fully converted
  - `/exchange` endpoint: Fully converted
  - **Remaining**: 11 routes (`/user`, `/refresh`, `/register`, `/confirm-signup`, `/resend-code`, 6 admin routes)

## ⚠️ Partially Complete

### Middleware
- ⚠️ **user-resolution.ts**: Imports converted, logic needs refactoring
  - Helper functions `extractSlackUser()`, `extractDiscordUser()`, `extractTeamsUser()` still access `req.body` synchronously
  - **Blocker**: These need to be async since `c.req.json()` is async in Hono
  - `resolveUser()` middleware needs full rewrite for async body parsing
  - `requireUserContext()` needs conversion

### Routes
- ⚠️ **slack.ts**: Imports converted, route handlers need conversion
  - Router instantiated: `const router = new Hono()`
  - **Remaining**: All webhook handlers (URL verification, event handling)

- ⚠️ **tenant.ts**: Imports converted, route handlers need conversion
  - Router instantiated: `const router = new Hono()`
  - **Remaining**: CRUD endpoints for tenant management

- ⚠️ **integrations.ts**: Imports converted, route handlers need conversion
  - Router instantiated: `const router = new Hono()`
  - **Remaining**: Platform integration management endpoints

## 🔴 Not Started

### Route Handlers (Systematic Conversion Needed)

**Pattern to follow:**
```typescript
// Express
router.post('/endpoint', async (req: Request, res: Response) => {
  const body = req.body;
  const tenantContext = req.tenantContext;
  res.status(200).json({ data });
});

// Hono
router.post('/endpoint', async (c: Context) => {
  const body = await c.req.json();
  const tenantContext = c.get('tenantContext') as TenantContext | undefined;
  return c.json({ data }, 200);
});
```

**auth.ts** (11 routes remaining):
- `GET /user` - requires `authenticateJWT` middleware, accesses `req.auth`
- `POST /refresh` - token refresh logic
- `POST /register` - Cognito SignUp
- `POST /confirm-signup` - email confirmation
- `POST /resend-code` - resend confirmation code
- `GET /admin/users` - list users (requires `authenticateJWT` + admin check)
- `POST /admin/users/:username/disable` - disable user
- `POST /admin/users/:username/enable` - enable user
- `PATCH /admin/users/:username/tenant` - update user tenant
- Plus 2-3 more admin routes

**slack.ts** (all routes):
- URL verification handler (already partially handled in server.ts)
- Event callback handler (processes Slack events)
- Message action handler
- Slash command handler

**tenant.ts** (all routes):
- `POST /` - Create tenant
- `GET /:tenantId` - Get tenant
- `PATCH /:tenantId` - Update tenant
- `POST /:tenantId/suspend` - Suspend tenant
- `POST /:tenantId/activate` - Activate tenant

**integrations.ts** (all routes):
- OAuth callback handlers for Slack/Discord/Teams
- User pairing endpoints
- Integration listing/management

## Key Conversion Patterns

### 1. Request Body Parsing
```typescript
// Express (synchronous)
const { code, codeVerifier } = req.body;

// Hono (async)
const body = await c.req.json();
const { code, codeVerifier } = body as { code?: string; codeVerifier?: string };
```

### 2. Response Headers
```typescript
// Express
res.setHeader('X-Custom-Header', 'value');
res.status(200).json({ data });

// Hono
c.header('X-Custom-Header', 'value');
return c.json({ data }, 200);
```

### 3. Context Access
```typescript
// Express (augmented request)
req.tenantContext
req.auth
req.userContext

// Hono (context.set/get)
c.get('tenantContext') as TenantContext | undefined
c.get('auth') as AuthContext | undefined
c.get('userContext') as ResolvedUserContext | undefined
```

### 4. Route Parameters
```typescript
// Express
req.params.username
req.params.tenantId

// Hono
c.req.param('username')
c.req.param('tenantId')
```

### 5. Query Parameters
```typescript
// Express
req.query.limit

// Hono
c.req.query('limit')
```

### 6. Middleware Chaining
```typescript
// Express
router.get('/admin/users', authenticateJWT, requireGroup('admin'), handler);

// Hono
router.get('/admin/users', authenticateJWT, requireGroup('admin'), handler);
// (same syntax, but middleware functions have different signatures)
```

## Known Issues

### 1. SSE Streaming (chat.ts `/stream` endpoint)
The SSE bridge (`streamStrandsToDSP`) expects Express Response object. Hono provides a different Response API. Options:
- Create Hono-specific SSE streaming adapter
- Use Hono's streaming API (`c.stream()` or `c.streamText()`)
- Bridge Hono Response to Express-compatible interface

### 2. Async Body Parsing in Middleware
Middleware that needs to inspect request body must be async and call `await c.req.json()`. This affects:
- `user-resolution.ts` helper functions
- Any middleware that conditionally parses body (like Slack URL verification)

### 3. Type Safety
Hono Context's `get()` method returns `unknown`, requiring type assertions:
```typescript
const tenantContext = c.get('tenantContext') as TenantContext | undefined;
```

Consider creating a typed Hono app with environment types:
```typescript
type AppEnv = {
  Variables: {
    tenantContext?: TenantContext;
    auth?: AuthContext;
    userContext?: ResolvedUserContext;
  };
};

const app = new Hono<AppEnv>();
```

## Testing Strategy

### 1. Unit Tests
- Update test imports: `import request from 'supertest'` → Hono test utilities
- Hono provides `testClient()` for testing
- Alternatively, keep `supertest` and adapt for Hono

### 2. Integration Tests
- Test middleware chain (tenant → auth → rate-limit → routes)
- Verify SSE streaming still works
- Test error handling paths

### 3. Manual Testing
- Health check: `curl http://localhost:8080/health`
- Chat endpoint: `POST http://localhost:8080/chat/message`
- OAuth flow: Test Cognito integration

## Performance Considerations

Hono is designed for performance:
- Faster routing (regex-free trie-based router)
- Smaller bundle size (~12KB vs Express ~200KB)
- Better TypeScript support
- Native Web Standards (Request/Response API)

Benchmark after full migration to quantify improvements.

## Deployment Notes

### Dockerfile
Current Dockerfile uses Bun for runtime. Hono works well with Bun:
```dockerfile
FROM oven/bun:1 AS runtime
COPY --from=builder /app /app
WORKDIR /app/packages/chat-gateway
CMD ["bun", "run", "src/server.ts"]
```

No changes needed to Dockerfile.

### Environment Variables
All environment variables remain the same:
- `PORT`, `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`, etc.
- Hono reads these via `process.env` just like Express

## Next Steps

### Priority 1: Complete Core Routes
1. Finish auth.ts route handlers (11 remaining)
2. Convert user-resolution.ts for async body parsing
3. Test OAuth flow end-to-end

### Priority 2: Platform Routes
1. slack.ts - Slack webhook handlers
2. tenant.ts - Tenant CRUD operations
3. integrations.ts - Platform integration management

### Priority 3: Polish
1. Add typed Hono environment (`AppEnv`)
2. Update tests (switch from supertest to Hono test client)
3. Update documentation (API docs, README)
4. Performance benchmarking

## Estimated Effort

- **Core routes** (auth.ts): 2-3 hours
- **Platform routes** (slack/tenant/integrations): 3-4 hours
- **Middleware completion** (user-resolution): 1 hour
- **SSE streaming adapter**: 1-2 hours
- **Testing & polish**: 2-3 hours

**Total**: ~10-15 hours of focused development time

## References

- [Hono Documentation](https://hono.dev/)
- [Hono Migration Guide](https://hono.dev/docs/guides/migrating-to-hono)
- [Hono Context API](https://hono.dev/docs/api/context)
- [Hono Middleware](https://hono.dev/docs/guides/middleware)
- [Express vs Hono Patterns](https://hono.dev/docs/concepts/express-comparison)
