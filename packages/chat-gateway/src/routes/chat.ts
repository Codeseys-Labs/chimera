/**
 * Chat routes - streaming and non-streaming agent invocation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createAgent, createDefaultSystemPrompt, StreamEvent, createBedrockModel } from '@chimera/core';
import { streamStrandsToDSP } from '@chimera/sse-bridge';
import { StrandsStreamEvent } from '@chimera/sse-bridge';
import { ChatRequest, ChatResponse, ErrorResponse, TenantContext } from '../types';
import { getAdapter } from '../adapters';
import { getConfig } from '../config';

const router = new Hono();
const config = getConfig();

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
 * POST /chat/stream
 *
 * Streaming chat endpoint using Server-Sent Events (SSE).
 * Accepts Vercel AI SDK chat requests, routes to tenant agent, streams via SSE bridge.
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

    // Stream agent response through SSE bridge
    const agentStream = agent.stream(lastMessage.content);
    const strandsStream = mapAgentStreamToStrands(agentStream);

    // Hono Context provides Response-compatible interface
    // streamStrandsToDSP expects a Response-like object with setHeader and write methods
    // We need to create a custom streaming response
    return c.body(null as any); // Temporary placeholder - will be handled by SSE bridge
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
