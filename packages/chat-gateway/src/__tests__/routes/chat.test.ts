/**
 * Route-level tests for chat.ts — POLISH-1 + POLISH-2 (Wave-33).
 *
 * Covers:
 *   - POST /chat/stream rejects body.tenantId that conflicts with the JWT
 *     tenantContext with HTTP 400 TENANT_MISMATCH (POLISH-1).
 *   - POST /chat/stream is unchanged when body.tenantId matches or is absent.
 *   - GET /chat/sessions/:sessionId/messages returns 404 when the session
 *     does not exist in the caller's tenant (POLISH-2). Existing empty
 *     sessions still return 200 with an empty list.
 *
 * Uses Hono's built-in `app.request()` rather than supertest +
 * @hono/node-server — the latter hangs under Bun's test runner (see
 * cross-tenant-isolation.test.ts) and these two handlers are pure
 * request→response, no long-lived SSE stream.
 */

import { mock, describe, it, expect, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// DynamoDB mocks — must be set up BEFORE importing the router
// ---------------------------------------------------------------------------

interface CapturedCommand {
  type: string;
  input: any;
}

const capturedCommands: CapturedCommand[] = [];
// Per-test overrides for DDB responses (keyed by command type).
let queryResponse: any = { Items: [] };
let getResponse: any = { Item: undefined };

const mockSend = mock(async (command: any) => {
  const type = command?._type || 'unknown';
  capturedCommands.push({ type, input: command.input });
  if (type === 'QueryCommand') return queryResponse;
  if (type === 'GetCommand') return getResponse;
  return {};
});

mock.module('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class MockDynamoDBClient {},
}));

mock.module('@aws-sdk/lib-dynamodb', () => {
  const makeCommand = (type: string) =>
    class {
      _type = type;
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    };
  return {
    DynamoDBDocumentClient: {
      from: () => ({ send: mockSend }),
    },
    QueryCommand: makeCommand('QueryCommand'),
    GetCommand: makeCommand('GetCommand'),
    PutCommand: makeCommand('PutCommand'),
    UpdateCommand: makeCommand('UpdateCommand'),
    DeleteCommand: makeCommand('DeleteCommand'),
    ScanCommand: makeCommand('ScanCommand'),
    BatchGetCommand: makeCommand('BatchGetCommand'),
    BatchWriteCommand: makeCommand('BatchWriteCommand'),
    TransactGetCommand: makeCommand('TransactGetCommand'),
    TransactWriteCommand: makeCommand('TransactWriteCommand'),
    ExecuteStatementCommand: makeCommand('ExecuteStatementCommand'),
    ExecuteTransactionCommand: makeCommand('ExecuteTransactionCommand'),
    BatchExecuteStatementCommand: makeCommand('BatchExecuteStatementCommand'),
  };
});

// ---------------------------------------------------------------------------
// @chimera/core — stub surface touched by routes/chat.ts at module load
// ---------------------------------------------------------------------------
//
// The route imports a handful of symbols; we only need them to be defined.
// The stream/agent path is not exercised by POLISH-1 (we reject before
// reaching it) or POLISH-2 (GET, no agent). These stubs can stay shallow.

mock.module('@chimera/core', () => ({
  createAgent: () => ({
    stream: () =>
      (async function* () {
        yield { type: 'message_stop', stopReason: 'end_turn' };
      })(),
    invoke: async () => ({ output: 'stub', sessionId: 'stub', stopReason: 'end_turn' }),
  }),
  createDefaultSystemPrompt: () => 'stub prompt',
  createBedrockModel: () => ({}),
  ToolRegistry: class {
    async initialize() {}
  },
  ToolLoader: class {
    async loadToolsForTenant() {
      return { tools: [] };
    }
  },
  AWSClientFactory: class {},
}));

// ---------------------------------------------------------------------------
// @chimera/sse-bridge — minimal surface needed for module load
// ---------------------------------------------------------------------------

mock.module('@chimera/sse-bridge', () => ({
  StrandsToDSPBridge: class {
    constructor(_id: string) {}
    convertStream(s: any) {
      return s;
    }
  },
  VERCEL_DSP_HEADERS: { 'Content-Type': 'text/event-stream' },
  formatSSEData: (p: any) => `data: ${JSON.stringify(p)}\n\n`,
  formatSSEDone: () => 'data: [DONE]\n\n',
  formatSSEKeepalive: () => ': keepalive\n\n',
  StreamTee: class {
    buffer: any[] = [];
    done = false;
    error: Error | undefined;
    addListener(_fn: any) {
      return () => {};
    }
    onComplete(_fn: any) {
      return () => {};
    }
    onError(_fn: any) {
      return () => {};
    }
  },
}));

// Stub stream/persistence/multi-destination wiring — never invoked by the
// two endpoints under test, but imported at module load.
mock.module('../../stream-manager', () => ({
  streamManager: {
    create: () => ({
      addListener: () => () => {},
      onComplete: () => () => {},
      onError: () => () => {},
      buffer: [],
      done: false,
      error: undefined,
    }),
    getForTenant: () => undefined,
  },
  AsyncStreamManager: class {},
}));

mock.module('../../persistence-listener', () => ({
  createPersistenceListener: () => ({
    onPart: () => {},
    onComplete: async () => {},
    onError: async () => {},
  }),
}));

mock.module('../../multi-destination', () => ({
  attachDestinations: () => {},
}));

// Own the adapters module mock explicitly. Sibling test files
// (discord/teams/telegram) mock `../../adapters` with platform-specific
// parsers that throw on the plain web shape `{role, content}` used here;
// bun's `mock.module` is process-global and persists across files, so
// without this mock those siblings poison POST /chat/stream with
// "Message missing content field" when run first.
mock.module('../../adapters', () => ({
  getAdapter: () => ({
    parseIncoming: (body: any) =>
      (body?.messages ?? []).map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
      })),
    formatResponse: (r: any) => r,
  }),
}));

// ---------------------------------------------------------------------------
// Import router AFTER mocks are in place
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { TenantContext } from '../../types';
// Dynamic import so the mock.module calls above run before routes/chat.ts
// evaluates its top-level `DynamoDBDocumentClient.from(new DynamoDBClient({}))`
// and resolves the (mocked) @aws-sdk symbols. A static `import` is hoisted
// above the `mock.module(...)` calls in Bun's evaluation order and bypasses
// the mocks, causing `command.resolveMiddleware is not a function` at runtime.
const chatRouter = (await import('../../routes/chat')).default;

function createTestApp(tenantContext: Partial<TenantContext> = { tenantId: 'tenant-A' }) {
  const app = new Hono();
  app.use('/chat/*', async (c, next) => {
    (c as any).set('tenantContext', {
      tenantId: tenantContext.tenantId ?? 'tenant-A',
      tier: (tenantContext.tier ?? 'basic') as TenantContext['tier'],
      userId: tenantContext.userId,
    } as TenantContext);
    await next();
  });
  app.route('/chat', chatRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /chat/stream — POLISH-1 body tenantId guard', () => {
  beforeEach(() => {
    capturedCommands.length = 0;
    queryResponse = { Items: [] };
    getResponse = { Item: undefined };
    mockSend.mockClear();
  });

  it('returns 400 TENANT_MISMATCH when body tenantId differs from JWT tenant', async () => {
    const app = createTestApp({ tenantId: 'tenant-A' });

    const res = await app.request('/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'tenant-B', // conflicts with JWT
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('TENANT_MISMATCH');
    expect(body.error.message).toMatch(/body tenantId conflicts/i);
  });

  it('accepts body tenantId when it matches the JWT tenant (behavior unchanged)', async () => {
    const app = createTestApp({ tenantId: 'tenant-A' });

    const res = await app.request('/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'tenant-A',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    // Not a 400/TENANT_MISMATCH. Full streaming happy path is exercised
    // elsewhere — here we only need to prove the guard does not fire.
    expect(res.status).not.toBe(400);
  });

  it('does not fire TENANT_MISMATCH when body tenantId is absent', async () => {
    // The Zod schema (`tenantId: z.string().min(1)`) rejects a body with no
    // tenantId at the schema layer with INVALID_REQUEST — which pre-dates
    // POLISH-1 and is the correct "use JWT" behavior from the caller's
    // perspective. The new guard must NOT hijack that error with a
    // misleading TENANT_MISMATCH. Assert on the error *code*, not just 200.
    const app = createTestApp({ tenantId: 'tenant-A' });

    const res = await app.request('/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    // Either the stream starts (200/non-4xx) or the schema layer rejects
    // with INVALID_REQUEST — but never TENANT_MISMATCH.
    if (res.status === 400) {
      const body = (await res.json()) as any;
      expect(body.error.code).not.toBe('TENANT_MISMATCH');
    }
  });
});

describe('GET /chat/sessions/:sessionId/messages — POLISH-2 404 on foreign session', () => {
  beforeEach(() => {
    capturedCommands.length = 0;
    queryResponse = { Items: [] };
    getResponse = { Item: undefined };
    mockSend.mockClear();
  });

  it('returns 404 SESSION_NOT_FOUND when the session does not exist in this tenant', async () => {
    const app = createTestApp({ tenantId: 'tenant-A' });

    // No messages + no session record → 404.
    queryResponse = { Items: [] };
    getResponse = { Item: undefined };

    const res = await app.request('/chat/sessions/nonexistent-id/messages', {
      method: 'GET',
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('SESSION_NOT_FOUND');

    // Probe uses the tenant-scoped session PK (critical invariant).
    const probe = capturedCommands.find((c) => c.type === 'GetCommand');
    expect(probe).toBeDefined();
    expect(probe!.input.Key.PK).toBe('TENANT#tenant-A');
    expect(probe!.input.Key.SK).toBe('SESSION#nonexistent-id');
  });

  it('returns 200 with empty list when the session exists but has no messages', async () => {
    const app = createTestApp({ tenantId: 'tenant-A' });

    queryResponse = { Items: [] };
    getResponse = {
      Item: {
        PK: 'TENANT#tenant-A',
        SK: 'SESSION#existing-empty-session',
        sessionId: 'existing-empty-session',
        status: 'active',
        messageCount: 0,
      },
    };

    const res = await app.request('/chat/sessions/existing-empty-session/messages', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sessionId).toBe('existing-empty-session');
    expect(body.messages).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('skips the session existence probe when messages are returned', async () => {
    const app = createTestApp({ tenantId: 'tenant-A' });

    // At least one message → session clearly exists, save the GetItem RTT.
    queryResponse = {
      Items: [
        {
          messageId: 'msg_1',
          role: 'user',
          content: 'hi',
          status: 'complete',
          createdAt: '2026-04-28T00:00:00Z',
        },
      ],
    };

    const res = await app.request('/chat/sessions/has-messages/messages', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const probe = capturedCommands.find((c) => c.type === 'GetCommand');
    expect(probe).toBeUndefined();
  });
});
