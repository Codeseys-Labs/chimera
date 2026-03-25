/**
 * Chat routes - streaming and non-streaming agent invocation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createAgent, createDefaultSystemPrompt, StreamEvent, createBedrockModel } from '@chimera/core';
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
import { ChatRequest, ChatResponse, ErrorResponse, TenantContext } from '../types';
import { getAdapter } from '../adapters';
import { getConfig } from '../config';
import { streamManager } from '../stream-manager';

const router = new Hono();
const config = getConfig();

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
function createTeeSSEStream(
  tee: StreamTee<VercelDSPStreamPart>
): ReadableStream<Uint8Array> {
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
      keepaliveTimer = setInterval(
        () => enqueue(formatSSEKeepalive()),
        KEEPALIVE_INTERVAL_MS
      );
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

    // Create agent instance with Bedrock model if enabled
    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: tenantContext.tenantId,
      userId: tenantContext.userId,
      sessionId: (body as ChatRequest).sessionId,
      model: config.bedrock.enabled ? createBedrockModel({
        modelId: config.bedrock.modelId,
        region: config.bedrock.region,
        maxTokens: config.bedrock.maxTokens,
        temperature: config.bedrock.temperature,
      }) : undefined,
    });

    // Build DSP part stream from agent
    const agentStream = agent.stream(lastMessage.content);
    const strandsStream = mapAgentStreamToStrands(agentStream);
    const bridge = new StrandsToDSPBridge(messageId);
    const dspStream = bridge.convertStream(strandsStream);

    // Register with StreamManager — starts consuming in background.
    // The tee continues buffering even after the HTTP connection closes.
    const tee = streamManager.create(messageId, tenantContext.tenantId, dspStream);

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

    const messageId = c.req.param('messageId');
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

    // Create agent instance with Bedrock model if enabled
    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: tenantContext.tenantId,
      userId: tenantContext.userId,
      sessionId: (body as ChatRequest).sessionId,
      model: config.bedrock.enabled ? createBedrockModel({
        modelId: config.bedrock.modelId,
        region: config.bedrock.region,
        maxTokens: config.bedrock.maxTokens,
        temperature: config.bedrock.temperature,
      }) : undefined,
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
