/**
 * Chat routes - streaming and non-streaming agent invocation
 */

import { Router, Request, Response } from 'express';
import type { Router as ExpressRouter } from 'express';
import { createAgent, createDefaultSystemPrompt, StreamEvent } from '@chimera/core';
import { streamStrandsToDSP } from '@chimera/sse-bridge';
import { StrandsStreamEvent } from '@chimera/sse-bridge';
import { ChatRequest, ChatResponse, ErrorResponse } from '../types';
import { getAdapter } from '../adapters';

const router: ExpressRouter = Router();

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
router.post('/stream', async (req: Request, res: Response) => {
  try {
    // Validate tenant context (populated by middleware)
    if (!req.tenantContext) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_TENANT_CONTEXT',
          message: 'Tenant context not found. Ensure tenant middleware is active.',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(error);
      return;
    }

    // Determine platform from request (default to 'web')
    const platform = (req.body as { platform?: string }).platform || 'web';

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
      res.status(400).json(error);
      return;
    }

    // Parse request body
    let messages;
    try {
      messages = adapter.parseIncoming(req.body);
    } catch (parseError) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_REQUEST',
          message: parseError instanceof Error ? parseError.message : 'Invalid request format',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(400).json(error);
      return;
    }

    if (messages.length === 0) {
      const error: ErrorResponse = {
        error: {
          code: 'EMPTY_MESSAGES',
          message: 'messages array cannot be empty',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(400).json(error);
      return;
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
      res.status(400).json(error);
      return;
    }

    // Create agent instance
    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: req.tenantContext.tenantId,
      userId: req.tenantContext.userId,
      sessionId: (req.body as ChatRequest).sessionId,
    });

    // Stream agent response through SSE bridge
    const agentStream = agent.stream(lastMessage.content);
    const strandsStream = mapAgentStreamToStrands(agentStream);

    await streamStrandsToDSP(strandsStream, res);
  } catch (error) {
    // If headers already sent (streaming started), we can't send JSON error
    if (res.headersSent) {
      console.error('Error during streaming:', error);
      return;
    }

    const errorResponse: ErrorResponse = {
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error,
      },
      timestamp: new Date().toISOString(),
    };
    res.status(500).json(errorResponse);
  }
});

/**
 * POST /chat/message
 *
 * Non-streaming chat endpoint.
 * Returns complete response as JSON.
 */
router.post('/message', async (req: Request, res: Response) => {
  try {
    // Validate tenant context
    if (!req.tenantContext) {
      const error: ErrorResponse = {
        error: {
          code: 'MISSING_TENANT_CONTEXT',
          message: 'Tenant context not found',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(error);
      return;
    }

    // Determine platform from request (default to 'web')
    const platform = (req.body as { platform?: string }).platform || 'web';

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
      res.status(400).json(error);
      return;
    }

    // Parse request body
    let messages;
    try {
      messages = adapter.parseIncoming(req.body);
    } catch (parseError) {
      const error: ErrorResponse = {
        error: {
          code: 'INVALID_REQUEST',
          message: parseError instanceof Error ? parseError.message : 'Invalid request format',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(400).json(error);
      return;
    }

    if (messages.length === 0) {
      const error: ErrorResponse = {
        error: {
          code: 'EMPTY_MESSAGES',
          message: 'messages array cannot be empty',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(400).json(error);
      return;
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
      res.status(400).json(error);
      return;
    }

    // Create agent instance
    const agent = createAgent({
      systemPrompt: createDefaultSystemPrompt(),
      tenantId: req.tenantContext.tenantId,
      userId: req.tenantContext.userId,
      sessionId: (req.body as ChatRequest).sessionId,
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

    res.status(200).json(response);
  } catch (error) {
    const errorResponse: ErrorResponse = {
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error,
      },
      timestamp: new Date().toISOString(),
    };
    res.status(500).json(errorResponse);
  }
});

export default router;
