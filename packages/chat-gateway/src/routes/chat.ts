/**
 * Chat routes - streaming and non-streaming agent invocation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createAgent,
  createDefaultSystemPrompt,
  StreamEvent,
  createBedrockModel,
  ToolRegistry,
  ToolLoader,
  AWSClientFactory,
} from '@chimera/core';
import type { StrandsTool } from '@chimera/core';
import type { TenantTier } from '@chimera/shared';
import {
  StrandsToDSPBridge,
  VERCEL_DSP_HEADERS,
  formatSSEData,
  formatSSEDone,
  formatSSEKeepalive,
} from '@chimera/sse-bridge';
import { StrandsStreamEvent } from '@chimera/sse-bridge';
import type { VercelDSPStreamPart } from '@chimera/sse-bridge';
import { StreamTee } from '@chimera/sse-bridge';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ChatRequest, ChatResponse, ErrorResponse, TenantContext } from '../types';
import { getAdapter } from '../adapters';
import { getConfig } from '../config';
import { streamManager } from '../stream-manager';
import { createPersistenceListener } from '../persistence-listener';
import { attachDestinations } from '../multi-destination';

const router = new Hono();
const config = getConfig();

// DynamoDB client for message history queries
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SESSIONS_TABLE =
  process.env.SESSIONS_TABLE_NAME || process.env.CHIMERA_SESSIONS_TABLE || 'chimera-sessions-dev';

// ---------------------------------------------------------------------------
// GatewayToolDiscovery — lazy singleton ToolLoader keyed on tenant tier
//
// Mirrors GatewayToolDiscovery in packages/agents/gateway_config.py.
// The ToolRegistry is initialized once per process; per-request tool loading
// uses the ToolLoader cache (keyed by tenantId + tier).
// ---------------------------------------------------------------------------

let _toolLoaderPromise: Promise<ToolLoader | null> | null = null;

async function _initToolLoader(): Promise<ToolLoader | null> {
  const region = config.bedrock.region;
  const accountId = process.env.AWS_ACCOUNT_ID;
  const rolePattern =
    process.env.CHIMERA_TENANT_ROLE_PATTERN || 'chimera-tenant-{tenantId}-agent-role';

  if (!accountId) {
    console.warn('[GatewayToolDiscovery] AWS_ACCOUNT_ID not set — tools disabled');
    return null;
  }

  try {
    // Dynamic imports of AWS SDK clients (available via monorepo root devDependencies).
    // Using dynamic imports so a missing package produces a runtime warning rather than
    // a module-load failure that would crash the entire server.
    const [{ CostExplorerClient }, { ResourceGroupsTaggingAPIClient }, { ConfigServiceClient }] =
      await Promise.all([
        import('@aws-sdk/client-cost-explorer'),
        import('@aws-sdk/client-resource-groups-tagging-api'),
        import('@aws-sdk/client-config-service'),
      ]);

    const clientFactory = new AWSClientFactory({
      defaultRegion: region,
      accountId,
      roleNamePattern: rolePattern,
    });

    const registry = new ToolRegistry();
    await registry.initialize({
      clientFactory,
      discoveryConfig: {
        configScanner: {
          aggregatorName: process.env.CHIMERA_CONFIG_AGGREGATOR_NAME || 'chimera-global-aggregator',
          aggregatorRegion: region,
          accountId,
        },
        costAnalyzer: {
          // Cost Explorer is global (only available in us-east-1)
          costExplorerClient: new CostExplorerClient({ region: 'us-east-1' }),
        },
        tagOrganizer: {
          resourceGroupsTaggingClient: new ResourceGroupsTaggingAPIClient({ region }),
          configClient: new ConfigServiceClient({ region }),
          tagPolicy: {
            name: 'chimera-default',
            requiredTags: ['TenantId', 'Environment'],
            rules: {},
          },
          accountId,
        },
        resourceExplorer: {
          primaryRegion: region,
          accountId,
        },
        stackInventory: {
          regions: [region],
          accountId,
        },
        resourceIndex: {
          enableAutoUpdate: false,
        },
      },
    });

    console.info('[GatewayToolDiscovery] ToolRegistry initialized');
    return new ToolLoader(registry);
  } catch (error) {
    console.warn(
      '[GatewayToolDiscovery] Initialization failed — tools disabled:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/** Return the process-level ToolLoader, initializing once on first call. */
function getToolLoader(): Promise<ToolLoader | null> {
  if (!_toolLoaderPromise) {
    _toolLoaderPromise = _initToolLoader();
  }
  return _toolLoaderPromise;
}

/** Load tier-appropriate tools for a tenant. Returns [] on any failure. */
async function getToolsForTenant(tenantId: string, tier: TenantTier): Promise<StrandsTool[]> {
  const loader = await getToolLoader();
  if (!loader) return [];
  try {
    const result = await loader.loadToolsForTenant({ tenantId, subscriptionTier: tier });
    return result.tools;
  } catch (error) {
    console.warn('[GatewayToolDiscovery] Tool load failed for tenant', tenantId, error);
    return [];
  }
}

/** Keepalive ping interval (15 s) — prevents proxy/ALB idle-connection timeouts */
const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Map ChimeraAgent StreamEvent to StrandsStreamEvent
 *
 * ChimeraAgent currently uses placeholder format (snake_case).
 * SSE bridge expects Strands format (camelCase).
 * This adapter bridges the gap until ChimeraAgent integrates real Strands SDK.
 */
function mapToStrandsEvent(event: StreamEvent): StrandsStreamEvent {
  switch (event.type) {
    case 'message_start':
      return {
        type: 'messageStart',
        messageId: event.sessionId,
      };

    case 'content_block_start':
      return {
        type: 'contentBlockStart',
        contentBlock: {
          type: event.blockType === 'tool_use' ? 'tool_use' : 'text',
          id: `block_${Date.now()}`,
        },
      };

    case 'content_block_delta':
      return {
        type: 'contentBlockDelta',
        delta: {
          type: 'textDelta',
          text: event.delta.text,
        },
        contentBlockIndex: 0,
      };

    case 'content_block_stop':
      return {
        type: 'contentBlockStop',
        contentBlockIndex: 0,
      };

    case 'message_stop':
      return {
        type: 'messageStop',
        stopReason: event.stopReason as any,
      };

    case 'tool_call':
      // Tool calls not yet implemented in placeholder agent
      return {
        type: 'contentBlockStart',
        contentBlock: {
          type: 'tool_use',
          id: `tool_${Date.now()}`,
          name: event.toolCall.name,
        },
      };

    default:
      // Fallback: emit as text delta
      return {
        type: 'contentBlockDelta',
        delta: { type: 'textDelta', text: JSON.stringify(event) },
        contentBlockIndex: 0,
      };
  }
}

/**
 * Create an async generator that maps ChimeraAgent events to Strands events
 */
async function* mapAgentStreamToStrands(
  agentStream: AsyncGenerator<StreamEvent, void, unknown>
): AsyncGenerator<StrandsStreamEvent, void, unknown> {
  for await (const event of agentStream) {
    yield mapToStrandsEvent(event);
  }
}

/**
 * Build a ReadableStream<Uint8Array> that replays a StreamTee's buffer then
 * follows the live tail, emitting keepalive pings at regular intervals.
 *
 * The register-then-replay pattern is race-free in JavaScript because
 * no await occurs between addListener() and the buffer replay loop —
 * the background consumer cannot advance during that synchronous window.
 */
function createTeeSSEStream(tee: StreamTee<VercelDSPStreamPart>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      function enqueue(text: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
          clearInterval(keepaliveTimer);
        }
      }

      function close(): void {
        if (closed) return;
        closed = true;
        clearInterval(keepaliveTimer);
        removeListener();
        removeComplete();
        removeError();
        try {
          controller.close();
        } catch {
          // ignore if already closed
        }
      }

      // Subscribe to future parts BEFORE replaying the buffer.
      // Safe: JS single-threaded event loop means the background consumer
      // cannot run between addListener() and the for-loop below.
      const removeListener = tee.addListener((part) => enqueue(formatSSEData(part)));
      const removeComplete = tee.onComplete(() => {
        enqueue(formatSSEDone());
        close();
      });
      const removeError = tee.onError((err) => {
        if (closed) return;
        closed = true;
        clearInterval(keepaliveTimer);
        removeListener();
        removeComplete();
        removeError();
        controller.error(err);
      });

      // Replay all parts already in the buffer
      for (const part of tee.buffer) {
        enqueue(formatSSEData(part));
      }

      // Handle terminal states that occurred before we subscribed
      if (tee.done) {
        enqueue(formatSSEDone());
        close();
        return;
      }

      if (tee.error) {
        closed = true;
        clearInterval(keepaliveTimer);
        removeListener();
        removeComplete();
        removeError();
        controller.error(tee.error);
        return;
      }

      // Start keepalive pings to prevent idle-connection timeouts
      keepaliveTimer = setInterval(() => enqueue(formatSSEKeepalive()), KEEPALIVE_INTERVAL_MS);
    },

    cancel() {
      // HTTP client disconnected. The background StreamTee.consume() continues
      // buffering so a reconnecting client can replay missed content.
      clearInterval(keepaliveTimer);
    },
  });
}

/**
 * POST /chat/stream
 *
 * Streaming chat endpoint using Server-Sent Events (SSE).
 * Accepts Vercel AI SDK chat requests, routes to tenant agent, streams via SSE bridge.
 *
 * Returns X-Message-Id header so the client can reconnect via GET /chat/stream/:id.
 * Agent generation continues even if the client disconnects (consumeStream pattern).
 */
router.post('/stream', async (c: Context) => {
  try {
    // Validate tenant context (populated by middleware)
    const tenantContext = c.get('tenantContext') as TenantContext | undefined;
    if (!tenantContext) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_TENANT_CONTEXT',
          message: 'Tenant context not found. Ensure tenant middleware is active.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 500);
    }

    // Parse request body
    const body = await c.req.json();

    // Determine platform from request (default to 'web')
    const platform = (body as { platform?: string }).platform || 'web';

    // Get platform-specific adapter
    let adapter;
    try {
      adapter = getAdapter(platform);
    } catch (adapterError) {
      const error: ErrorResponse = {
        error: {
          code: 'UNSUPPORTED_PLATFORM',
          message: adapterError instanceof Error ? adapterError.message : 'Unsupported platform',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    // Parse messages
    let messages;
    try {
      messages = adapter.parseIncoming(body);
    } catch (parseError) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_REQUEST',
          message: parseError instanceof Error ? parseError.message : 'Invalid request format',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    if (messages.length === 0) {
      const error: ErrorResponse = {
        error: {
          code: 'EMPTY_MESSAGES',
          message: 'messages array cannot be empty',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    // Extract last user message
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_LAST_MESSAGE',
          message: 'Last message must be from user',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    // Generate a stable message ID used for the SSE stream and reconnection
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Load tier-appropriate tools for this tenant
    const loadedTools = await getToolsForTenant(tenantContext.tenantId, tenantContext.tier);

    // Create agent instance with Bedrock model and tenant-tier tools
    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: tenantContext.tenantId,
      userId: tenantContext.userId,
      sessionId: (body as ChatRequest).sessionId,
      tier: tenantContext.tier as 'basic' | 'advanced' | 'premium',
      loadedTools: loadedTools.length > 0 ? loadedTools : undefined,
      model: config.bedrock.enabled
        ? createBedrockModel({
            modelId: config.bedrock.modelId,
            region: config.bedrock.region,
            maxTokens: config.bedrock.maxTokens,
            temperature: config.bedrock.temperature,
          })
        : undefined,
    });

    // Build DSP part stream from agent
    const agentStream = agent.stream(lastMessage.content);
    const strandsStream = mapAgentStreamToStrands(agentStream);
    const bridge = new StrandsToDSPBridge(messageId);
    const dspStream = bridge.convertStream(strandsStream);

    // Register with StreamManager — starts consuming in background.
    // The tee continues buffering even after the HTTP connection closes.
    const tee = streamManager.create(messageId, tenantContext.tenantId, dspStream);

    // Attach DynamoDB persistence listener — writes messages as the stream progresses.
    // The persistence listener accumulates text in-memory and writes the final message
    // on completion. Agent generation continues even if the HTTP client disconnects.
    const sessionId = (body as ChatRequest).sessionId || `session_${Date.now()}`;
    const persistenceListener = createPersistenceListener({
      messageId,
      sessionId,
      tenantId: tenantContext.tenantId,
      userId: tenantContext.userId || 'unknown',
      userContent: lastMessage.content,
    });

    // Wire persistence (and future destinations) via multi-destination broadcaster.
    // StreamTee.onComplete/onError fire synchronous callbacks; the persistence
    // listener's async onComplete/onError are wrapped to avoid blocking.
    attachDestinations(tee.addListener.bind(tee), tee.onComplete.bind(tee), tee.onError.bind(tee), [
      {
        name: 'dynamodb-persistence',
        onPart: persistenceListener.onPart,
        onComplete: persistenceListener.onComplete,
        onError: persistenceListener.onError,
      },
    ]);

    // Return SSE response: replays any immediately-buffered parts + follows live tail
    const responseBody = createTeeSSEStream(tee);

    return new Response(responseBody, {
      status: 200,
      headers: {
        ...VERCEL_DSP_HEADERS,
        'X-Message-Id': messageId,
      },
    });
  } catch (error) {
    const errorResponse: ErrorResponse = {
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error,
      },
      timestamp: new Date().toISOString(),
    };
    return c.json(errorResponse, 500);
  }
});

/**
 * GET /chat/stream/:messageId
 *
 * Reconnection endpoint for interrupted SSE streams.
 * Replays all buffered DSP parts from the named stream, then follows the live tail
 * if the agent is still generating. Returns 404 if the stream has expired or belongs
 * to a different tenant.
 *
 * The Vercel AI SDK useChat hook can reconnect automatically with resume: true.
 */
router.get('/stream/:messageId', async (c: Context) => {
  try {
    const tenantContext = c.get('tenantContext') as TenantContext | undefined;
    if (!tenantContext) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_TENANT_CONTEXT',
          message: 'Tenant context not found. Ensure tenant middleware is active.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 500);
    }

    const messageId = c.req.param('messageId') ?? '';
    const record = streamManager.getForTenant(messageId, tenantContext.tenantId);

    if (!record) {
      const error: ErrorResponse = {
        error: {
          code: 'STREAM_NOT_FOUND',
          message: `No active stream found for messageId: ${messageId}`,
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 404);
    }

    // Replay buffered content + follow live tail using the same helper as POST
    const responseBody = createTeeSSEStream(record.tee);

    return new Response(responseBody, {
      status: 200,
      headers: {
        ...VERCEL_DSP_HEADERS,
        'X-Message-Id': messageId,
      },
    });
  } catch (error) {
    const errorResponse: ErrorResponse = {
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error,
      },
      timestamp: new Date().toISOString(),
    };
    return c.json(errorResponse, 500);
  }
});

/**
 * GET /chat/sessions/:sessionId/messages
 *
 * Load persisted messages for a session from DynamoDB.
 * Returns messages sorted chronologically (by SK).
 *
 * Tenant isolation: the PK includes the tenantId from the JWT, so a tenant
 * can only query their own sessions. No cross-tenant access is possible.
 *
 * Query params:
 *   ?limit=50  — max messages to return (default 50, max 200)
 *   ?cursor=   — SK value to start after (for pagination)
 */
router.get('/sessions/:sessionId/messages', async (c: Context) => {
  try {
    const tenantContext = c.get('tenantContext') as TenantContext | undefined;
    if (!tenantContext) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_TENANT_CONTEXT',
          message: 'Tenant context not found. Ensure tenant middleware is active.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 500);
    }

    const sessionId = c.req.param('sessionId') ?? '';
    if (!sessionId) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_SESSION_ID',
          message: 'sessionId parameter is required',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    const limitParam = parseInt(c.req.query('limit') || '50', 10);
    const limit = Math.min(Math.max(1, limitParam), 200);
    const cursor = c.req.query('cursor');

    const pk = `TENANT#${tenantContext.tenantId}#SESSION#${sessionId}`;

    const queryInput: any = {
      TableName: SESSIONS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':prefix': 'MSG#',
      },
      Limit: limit,
      ScanIndexForward: true, // chronological order
    };

    if (cursor) {
      queryInput.ExclusiveStartKey = { PK: pk, SK: cursor };
    }

    const result = await ddbClient.send(new QueryCommand(queryInput));

    const messages = (result.Items || []).map((item: any) => ({
      messageId: item.messageId,
      role: item.role,
      content: item.content,
      status: item.status,
      finishReason: item.finishReason,
      toolCalls: item.toolCalls,
      errorMessage: item.errorMessage,
      createdAt: item.createdAt,
      completedAt: item.completedAt,
    }));

    const response: any = {
      sessionId,
      messages,
      count: messages.length,
    };

    // Include pagination cursor if there are more results
    if (result.LastEvaluatedKey) {
      response.nextCursor = result.LastEvaluatedKey.SK;
    }

    return c.json(response, 200);
  } catch (error) {
    const errorResponse: ErrorResponse = {
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error,
      },
      timestamp: new Date().toISOString(),
    };
    return c.json(errorResponse, 500);
  }
});

/**
 * POST /chat/message
 *
 * Non-streaming chat endpoint.
 * Returns complete response as JSON.
 */
router.post('/message', async (c: Context) => {
  try {
    // Validate tenant context
    const tenantContext = c.get('tenantContext') as TenantContext | undefined;
    if (!tenantContext) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_TENANT_CONTEXT',
          message: 'Tenant context not found',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 500);
    }

    // Parse request body
    const body = await c.req.json();

    // Determine platform from request (default to 'web')
    const platform = (body as { platform?: string }).platform || 'web';

    // Get platform-specific adapter
    let adapter;
    try {
      adapter = getAdapter(platform);
    } catch (adapterError) {
      const error: ErrorResponse = {
        error: {
          code: 'UNSUPPORTED_PLATFORM',
          message: adapterError instanceof Error ? adapterError.message : 'Unsupported platform',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    // Parse request body
    let messages;
    try {
      messages = adapter.parseIncoming(body);
    } catch (parseError) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_REQUEST',
          message: parseError instanceof Error ? parseError.message : 'Invalid request format',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    if (messages.length === 0) {
      const error: ErrorResponse = {
        error: {
          code: 'EMPTY_MESSAGES',
          message: 'messages array cannot be empty',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    // Extract last user message
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_LAST_MESSAGE',
          message: 'Last message must be from user',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(error, 400);
    }

    // Load tier-appropriate tools for this tenant
    const loadedTools = await getToolsForTenant(tenantContext.tenantId, tenantContext.tier);

    // Create agent instance with Bedrock model and tenant-tier tools
    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: tenantContext.tenantId,
      userId: tenantContext.userId,
      sessionId: (body as ChatRequest).sessionId,
      tier: tenantContext.tier as 'basic' | 'advanced' | 'premium',
      loadedTools: loadedTools.length > 0 ? loadedTools : undefined,
      model: config.bedrock.enabled
        ? createBedrockModel({
            modelId: config.bedrock.modelId,
            region: config.bedrock.region,
            maxTokens: config.bedrock.maxTokens,
            temperature: config.bedrock.temperature,
          })
        : undefined,
    });

    // Invoke agent (non-streaming)
    const result = await agent.invoke(lastMessage.content);

    // Build response
    const response: ChatResponse = {
      messageId: `msg_${Date.now()}`,
      sessionId: result.sessionId,
      content: result.output,
      finishReason: result.stopReason,
      usage: undefined, // TODO: Add usage tracking when Strands SDK integrated
    };

    return c.json(response, 200);
  } catch (error) {
    const errorResponse: ErrorResponse = {
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error,
      },
      timestamp: new Date().toISOString(),
    };
    return c.json(errorResponse, 500);
  }
});

export default router;
