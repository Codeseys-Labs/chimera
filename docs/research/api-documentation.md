---
title: "OpenAPI Spec Generation & API Documentation"
version: 1.0.0
status: research
last_updated: 2026-03-22
task_id: chimera-3fe0
author: builder-api-docs
---

# OpenAPI Spec Generation & API Documentation

Research into auto-generating OpenAPI specs from Express routes, interactive API docs rendering, and WebSocket/AsyncAPI documentation for AWS Chimera.

## Executive Summary

**Recommendation: Use `tsoa` for REST API + `AsyncAPI` for WebSocket documentation**

- **tsoa**: TypeScript-first OpenAPI spec generation with decorators, built-in validation, and Express integration
- **AsyncAPI**: Industry standard for documenting WebSocket and event-driven APIs
- **Swagger UI + Redoc**: Dual rendering for different use cases (internal dev vs. external docs)

This approach provides:
- ✅ Type-safe API definitions from TypeScript
- ✅ Auto-generated OpenAPI 3.0 specs
- ✅ Interactive API explorer (Swagger UI)
- ✅ Beautiful static docs (Redoc)
- ✅ WebSocket protocol documentation (AsyncAPI)
- ✅ Runtime request validation
- ✅ Single source of truth (code = spec)

---

## Current State Analysis

### Existing Architecture

**Express Server**: `packages/chat-gateway/src/server.ts`
- Routes: `/chat`, `/slack`, `/tenants`, `/auth`, `/health`
- Middleware: Cognito JWT auth, rate limiting, tenant context extraction
- Streaming: Server-Sent Events (SSE) for chat streaming

**API Gateway (CDK)**: `infra/lib/api-stack.ts`
- REST API v1 with Cognito authorizer
- WebSocket API for real-time chat
- Placeholder methods (501 responses) awaiting Lambda integration
- WAF integration for security

**Route Files**:
- `routes/chat.ts` - POST /chat/stream (SSE), POST /chat/message (sync)
- `routes/slack.ts` - POST /slack/events (webhooks), POST /slack/slash (slash commands)
- `routes/tenant.ts` - Tenant provisioning API
- `routes/auth.ts` - OAuth callback, token exchange
- `routes/health.ts` - Health check endpoint

**Current Gaps**:
- ❌ No OpenAPI spec defined
- ❌ No interactive API documentation
- ❌ No formal WebSocket protocol documentation
- ❌ Manual request/response type definitions scattered across files
- ❌ No runtime schema validation on Express routes

---

## Option 1: tsoa (Recommended)

**GitHub**: https://github.com/lukeautry/tsoa
**Stars**: ~3.5k | **License**: MIT

### What is tsoa?

TypeScript-first framework that generates OpenAPI specs and Express routes from decorated TypeScript controllers. Enforces type safety at compile time and provides runtime validation.

### Key Features

✅ **Decorator-based API definitions** - Define routes, params, responses in TypeScript
✅ **Auto-generated OpenAPI 3.0 spec** - Single command generates spec.json
✅ **Runtime validation** - Validates requests against TypeScript types
✅ **Express integration** - Generates `routes.ts` that plugs into existing Express app
✅ **Authentication decorators** - `@Security('jwt')` for protected routes
✅ **Type-safe responses** - Enforces response types at compile time

### Example Implementation

```typescript
// controllers/ChatController.ts
import { Controller, Post, Body, Route, Tags, Security, Response, SuccessResponse } from 'tsoa';

interface ChatRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  sessionId?: string;
  platform?: string;
}

interface ChatResponse {
  messageId: string;
  sessionId: string;
  content: string;
  finishReason: string;
}

@Route('chat')
@Tags('Chat')
export class ChatController extends Controller {
  /**
   * Send a message and get synchronous response
   * @summary Non-streaming chat endpoint
   */
  @Post('message')
  @Security('jwt')
  @SuccessResponse(200, 'Success')
  @Response(400, 'Bad Request')
  @Response(401, 'Unauthorized')
  @Response(500, 'Internal Server Error')
  public async sendMessage(
    @Body() request: ChatRequest
  ): Promise<ChatResponse> {
    // Implementation delegates to existing route logic
    return {
      messageId: 'msg_123',
      sessionId: request.sessionId || 'session_456',
      content: 'Response from agent',
      finishReason: 'stop'
    };
  }
}
```

**Generated OpenAPI spec** (automatic):
```yaml
openapi: 3.0.0
paths:
  /chat/message:
    post:
      tags:
        - Chat
      summary: Non-streaming chat endpoint
      security:
        - jwt: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ChatRequest'
      responses:
        '200':
          description: Success
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ChatResponse'
```

### Integration Steps

1. **Install dependencies**
   ```bash
   bun add tsoa
   bun add -d @types/node
   ```

2. **Configure tsoa** (`tsoa.json`)
   ```json
   {
     "entryFile": "packages/chat-gateway/src/server.ts",
     "noImplicitAdditionalProperties": "throw-on-extras",
     "controllerPathGlobs": ["packages/chat-gateway/src/controllers/**/*Controller.ts"],
     "spec": {
       "outputDirectory": "packages/chat-gateway/public",
       "specVersion": 3,
       "securityDefinitions": {
         "jwt": {
           "type": "http",
           "scheme": "bearer",
           "bearerFormat": "JWT"
         }
       }
     },
     "routes": {
       "routesDir": "packages/chat-gateway/src/generated",
       "middleware": "express"
     }
   }
   ```

3. **Refactor existing routes to controllers**
   - Move route logic from `routes/chat.ts` → `controllers/ChatController.ts`
   - Add tsoa decorators (`@Route`, `@Post`, `@Security`, etc.)
   - Keep existing middleware (tenant extraction, rate limiting)

4. **Generate spec + routes**
   ```bash
   bun run tsoa spec-and-routes
   ```
   This creates:
   - `packages/chat-gateway/public/swagger.json` - OpenAPI spec
   - `packages/chat-gateway/src/generated/routes.ts` - Express routes

5. **Update Express app**
   ```typescript
   import { RegisterRoutes } from './generated/routes';

   const app = express();

   // Apply middleware
   app.use(cors());
   app.use(express.json());
   app.use(extractTenantContext);

   // Register tsoa-generated routes
   RegisterRoutes(app);

   // Serve OpenAPI spec
   app.use('/api-docs', express.static('public'));
   ```

### Pros
- ✅ Type-safe API definitions (TypeScript as source of truth)
- ✅ Runtime validation (rejects invalid requests automatically)
- ✅ Single source of truth (code = spec)
- ✅ Express-friendly (minimal refactoring required)
- ✅ Active maintenance (last commit: 2 weeks ago)
- ✅ Supports authentication decorators

### Cons
- ⚠️ Requires refactoring routes to controller classes
- ⚠️ Learning curve for decorator syntax
- ⚠️ Generated routes.ts must be committed (checked into git)
- ⚠️ Streaming endpoints (SSE) not well-supported (need custom docs)

### Fit for Chimera
**Score: 9/10**

Excellent fit. TypeScript-first approach aligns with Chimera's tech stack. The refactoring cost is moderate (move route logic to controllers), and the benefits (type safety + validation + docs) are significant.

---

## Option 2: swagger-jsdoc

**GitHub**: https://github.com/Surnet/swagger-jsdoc
**Stars**: ~5.3k | **License**: MIT

### What is swagger-jsdoc?

Generates OpenAPI specs from JSDoc comments in existing route files. Minimal refactoring required.

### Example Implementation

```typescript
// routes/chat.ts
/**
 * @swagger
 * /chat/message:
 *   post:
 *     summary: Non-streaming chat endpoint
 *     tags:
 *       - Chat
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - messages
 *             properties:
 *               messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant]
 *                     content:
 *                       type: string
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatResponse'
 */
router.post('/message', async (req: Request, res: Response) => {
  // Existing implementation unchanged
});
```

### Pros
- ✅ Minimal refactoring (add JSDoc comments to existing routes)
- ✅ No decorator syntax required
- ✅ Works with existing Express app structure
- ✅ Flexible (can document anything, including streaming)

### Cons
- ❌ No type safety (YAML-in-comments doesn't check TypeScript types)
- ❌ No runtime validation (need separate library like `express-validator`)
- ❌ Verbose (duplicate type definitions in JSDoc)
- ❌ Easy to drift (comments vs. actual implementation)
- ❌ No compile-time checks

### Fit for Chimera
**Score: 5/10**

Low friction to add, but loses the primary benefit of TypeScript (type safety). The lack of runtime validation means we'd need to add `express-validator` or `zod` separately. JSDoc comments become maintenance burden as API evolves.

---

## Option 3: express-openapi

**GitHub**: https://github.com/kogosoftwarellc/open-api
**Stars**: ~1.2k | **License**: MIT

### What is express-openapi?

Middleware that generates OpenAPI spec from route files with embedded schemas. Uses a directory-based routing convention.

### Example Structure

```
api/
  paths/
    chat/
      message.ts  # POST /chat/message
      stream.ts   # POST /chat/stream
  schemas/
    ChatRequest.ts
    ChatResponse.ts
```

### Pros
- ✅ Convention-based routing
- ✅ Separate schema files (reusable)
- ✅ Middleware-based (fits Express pattern)

### Cons
- ❌ Requires complete restructure of route files
- ❌ Less popular (lower community support)
- ❌ No TypeScript-first design
- ❌ Learning curve for conventions

### Fit for Chimera
**Score: 4/10**

Too invasive. Would require restructuring the entire `routes/` directory to match express-openapi conventions. Not worth the disruption.

---

## Option 4: Manual OpenAPI Spec

Write `openapi.yaml` by hand and use `swagger-ui-express` to serve it.

### Pros
- ✅ Full control over spec
- ✅ No code changes required

### Cons
- ❌ Manual maintenance (spec drifts from code)
- ❌ No type safety
- ❌ No runtime validation
- ❌ High maintenance burden

### Fit for Chimera
**Score: 3/10**

Only viable if the API is stable and rarely changes. Given Chimera is in active development, manual specs will become stale quickly.

---

## WebSocket Documentation: AsyncAPI

**Website**: https://www.asyncapi.com/
**Spec Version**: 3.0 | **License**: Apache 2.0

### What is AsyncAPI?

OpenAPI for asynchronous/event-driven APIs. Designed for WebSocket, MQTT, AMQP, Kafka, etc.

### Example AsyncAPI Spec

```yaml
asyncapi: 3.0.0
info:
  title: Chimera WebSocket API
  version: 1.0.0
  description: Real-time bidirectional streaming chat via WebSocket

servers:
  production:
    url: wss://ws.chimera.aws
    protocol: wss
    description: Production WebSocket server

channels:
  chatStream:
    address: /chat/stream
    messages:
      sendMessage:
        $ref: '#/components/messages/SendMessage'
      messageChunk:
        $ref: '#/components/messages/MessageChunk'
      messageComplete:
        $ref: '#/components/messages/MessageComplete'

operations:
  sendChatMessage:
    action: send
    channel:
      $ref: '#/channels/chatStream'
    messages:
      - $ref: '#/channels/chatStream/messages/sendMessage'

  receiveChatStream:
    action: receive
    channel:
      $ref: '#/channels/chatStream'
    messages:
      - $ref: '#/channels/chatStream/messages/messageChunk'
      - $ref: '#/channels/chatStream/messages/messageComplete'

components:
  messages:
    SendMessage:
      name: sendMessage
      title: Send Chat Message
      payload:
        type: object
        required:
          - action
          - message
        properties:
          action:
            type: string
            enum: [sendmessage]
          message:
            type: string
          sessionId:
            type: string

    MessageChunk:
      name: messageChunk
      title: Streamed Message Chunk
      payload:
        type: object
        properties:
          type:
            type: string
            enum: [content_block_delta]
          delta:
            type: object
            properties:
              text:
                type: string

    MessageComplete:
      name: messageComplete
      title: Message Stream Complete
      payload:
        type: object
        properties:
          type:
            type: string
            enum: [message_stop]
          stopReason:
            type: string
```

### AsyncAPI Tooling

- **asyncapi/generator**: CLI tool to generate HTML docs from spec
- **asyncapi/studio**: Interactive editor (like Swagger Editor)
- **asyncapi/react-component**: React component for rendering docs in web apps

### Integration

```bash
# Install AsyncAPI CLI
bun add -D @asyncapi/cli

# Generate HTML docs
asyncapi generate fromTemplate asyncapi.yaml @asyncapi/html-template -o docs/asyncapi

# Serve docs
asyncapi start studio asyncapi.yaml
```

---

## Interactive Documentation Tools

### Swagger UI

**Purpose**: Interactive API explorer for REST APIs

- **Try it out** feature (test API endpoints from browser)
- OAuth2/JWT authentication support
- Example requests/responses
- Best for: Internal developer docs, API testing

**Integration**:
```typescript
import swaggerUi from 'swagger-ui-express';
import swaggerDocument from '../public/swagger.json';

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Chimera API Documentation'
}));
```

### Redoc

**Purpose**: Beautiful static API documentation

- Mobile-responsive design
- Three-panel layout (nav, content, code samples)
- Better for: External customer docs, marketing site
- No "try it out" feature (read-only)

**Integration**:
```typescript
import { redoc } from 'redoc-express';

app.use('/docs', redoc({
  title: 'Chimera API Documentation',
  specUrl: '/api-docs/swagger.json',
  theme: {
    colors: {
      primary: {
        main: '#FF6900'
      }
    }
  }
}));
```

### Recommendation: Serve Both

- `/api-docs` → Swagger UI (internal devs, testing)
- `/docs` → Redoc (external customers, clean read-only docs)

---

## Recommended Implementation Plan

### Phase 1: REST API Documentation (tsoa)

**Time estimate**: 1 sprint (2 weeks)

1. **Setup tsoa** (1 day)
   - Install dependencies
   - Configure `tsoa.json`
   - Add npm scripts: `"tsoa": "tsoa spec-and-routes"`

2. **Refactor chat routes** (2 days)
   - Create `controllers/ChatController.ts`
   - Move logic from `routes/chat.ts`
   - Add decorators (`@Route`, `@Post`, `@Security`)
   - Test parity with existing endpoints

3. **Refactor remaining routes** (3 days)
   - `SlackController.ts` (webhook + slash commands)
   - `TenantController.ts` (provisioning API)
   - `AuthController.ts` (OAuth callback)
   - `HealthController.ts` (health check)

4. **Generate spec + integrate Swagger UI** (1 day)
   - Run `bun run tsoa spec-and-routes`
   - Serve Swagger UI at `/api-docs`
   - Serve Redoc at `/docs`

5. **Document authentication** (1 day)
   - Add Cognito JWT security definition
   - Document tenant context extraction
   - Add examples for Authorization header

6. **Testing + validation** (2 days)
   - Test all endpoints via Swagger UI
   - Verify runtime validation (send invalid requests)
   - Update tests to use generated routes

### Phase 2: WebSocket Documentation (AsyncAPI)

**Time estimate**: 3 days

1. **Write AsyncAPI spec** (1 day)
   - Document WebSocket connection flow
   - Define message schemas (sendMessage, messageChunk, etc.)
   - Add authentication section (JWT in query param)

2. **Generate AsyncAPI docs** (1 day)
   - Install `@asyncapi/cli`
   - Generate HTML docs
   - Serve at `/ws-docs`

3. **Integration with Redoc** (1 day)
   - Add link from REST API docs to WebSocket docs
   - Document streaming vs. WebSocket vs. sync endpoints
   - Add usage examples

### Phase 3: Webhook Documentation

**Time estimate**: 2 days

1. **Document Slack webhook contract**
   - URL verification challenge
   - Event callback payload
   - Signature verification
   - Response formats

2. **Add to OpenAPI spec**
   - Mark as unauthenticated (custom signature verification)
   - Document required headers (X-Slack-Signature, X-Slack-Request-Timestamp)
   - Add event examples

### Total Timeline: 3 weeks

---

## Alternative: Gradual Migration Path

If full refactoring is too risky, use a hybrid approach:

1. **Start with swagger-jsdoc** (low friction)
   - Add JSDoc comments to existing routes
   - Generate basic OpenAPI spec
   - Serve Swagger UI immediately

2. **Refactor high-value routes to tsoa** (incremental)
   - Start with `/chat` routes (most used)
   - Gain type safety + validation for critical paths
   - Migrate remaining routes over 2-3 sprints

3. **Deprecate swagger-jsdoc once migration complete**

This provides immediate documentation while gradually moving to the recommended long-term solution (tsoa).

---

## Security Considerations

### Cognito JWT Documentation

Document authentication flow in OpenAPI:

```yaml
components:
  securitySchemes:
    CognitoJWT:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: |
        Cognito JWT access token. Obtain via OAuth2 flow or Cognito SDK.
        Token must include custom:tenantId claim for multi-tenant isolation.
```

### Rate Limiting Documentation

Add `X-RateLimit-*` headers to response examples:

```yaml
responses:
  '200':
    description: Success
    headers:
      X-RateLimit-Limit:
        schema:
          type: integer
        description: Request limit per minute
      X-RateLimit-Remaining:
        schema:
          type: integer
        description: Remaining requests
```

### Sensitive Data Redaction

Ensure OpenAPI examples don't include:
- Real API keys
- Real tenant IDs
- Real user emails
- Production URLs

Use placeholders: `sk-test-xxxx`, `tenant_123`, `user@example.com`

---

## Cost Considerations

### Open Source Options (Free)

- tsoa: MIT license, free
- AsyncAPI: Apache 2.0, free
- Swagger UI: Apache 2.0, free
- Redoc: MIT license, free

### Hosted Options (Paid)

If we want externally hosted docs with analytics:

- **ReadMe.com**: $99/month (hosted docs, analytics, API playground)
- **Stoplight**: $179/month (collaborative API design, mocking)
- **Postman**: Free tier + $12/user/month (API testing + docs)

**Recommendation**: Self-host (free) for MVP. Consider hosted solution if we need:
- Usage analytics (which endpoints are most used)
- Collaborative API design (non-engineers editing specs)
- API versioning + changelogs

---

## Testing Strategy

### Contract Testing

Once OpenAPI spec is generated, use it for contract tests:

```typescript
import { validateRequest, validateResponse } from 'openapi-validator-middleware';
import spec from '../public/swagger.json';

describe('Chat API Contract Tests', () => {
  it('POST /chat/message validates against OpenAPI spec', async () => {
    const request = {
      body: {
        messages: [{ role: 'user', content: 'Hello' }]
      }
    };

    const validation = validateRequest(request, spec, '/chat/message', 'post');
    expect(validation.errors).toHaveLength(0);
  });
});
```

### Mock Server

Use OpenAPI spec to generate mock server for frontend development:

```bash
# Install Prism (OpenAPI mock server)
bun add -D @stoplight/prism-cli

# Start mock server
prism mock public/swagger.json --port 4010
```

Frontend can develop against mock server while backend implements real endpoints.

---

## Conclusion

### Final Recommendation

**Adopt tsoa for REST API documentation + AsyncAPI for WebSocket documentation**

This provides:
- ✅ Type-safe API definitions (TypeScript source of truth)
- ✅ Auto-generated OpenAPI 3.0 spec
- ✅ Runtime request validation
- ✅ Interactive docs (Swagger UI) + beautiful static docs (Redoc)
- ✅ WebSocket protocol documentation (AsyncAPI)
- ✅ Contract testing support
- ✅ Mock server generation

### Next Steps

1. **Proof of concept** (1 day)
   - Refactor `/chat/message` endpoint to tsoa
   - Generate OpenAPI spec
   - Serve Swagger UI
   - Demo to team

2. **Decision gate** (1 day)
   - Review PoC with lead-research-api
   - Confirm approach or pivot to alternative
   - Approve timeline for full migration

3. **Implementation** (3 weeks)
   - Follow phased rollout plan above
   - Monitor for breaking changes
   - Update tests to use generated routes

### Questions for Lead Agent

1. Is 3-week timeline acceptable for full REST + WebSocket docs?
2. Should we prioritize certain routes first (e.g., `/chat` before `/slack`)?
3. Do we need hosted documentation (ReadMe.com) or self-hosted sufficient?
4. Should AsyncAPI docs live in same UI as REST docs, or separate?

---

## References

- [tsoa GitHub](https://github.com/lukeautry/tsoa)
- [AsyncAPI Specification](https://www.asyncapi.com/docs/reference/specification/latest)
- [OpenAPI 3.0 Specification](https://spec.openapis.org/oas/v3.0.0)
- [Swagger UI](https://swagger.io/tools/swagger-ui/)
- [Redoc](https://github.com/Redocly/redoc)
- [Express TypeScript Best Practices](https://github.com/goldbergyoni/nodebestpractices)
