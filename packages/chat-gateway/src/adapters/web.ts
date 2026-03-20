/**
 * Web platform adapter
 *
 * Simple passthrough adapter for web clients using Vercel AI SDK format.
 * No transformation needed - Vercel AI SDK already speaks the right protocol.
 */

import { PlatformAdapter } from './types';
import { ChatMessage, TenantContext } from '../types';

export class WebPlatformAdapter implements PlatformAdapter {
  readonly platform = 'web';

  /**
   * Parse incoming request body
   *
   * Web clients using Vercel AI SDK send messages in standard format:
   * { messages: [ { role: 'user', content: '...' }, ... ] }
   */
  parseIncoming(body: unknown): ChatMessage[] {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid request body');
    }

    const request = body as { messages?: unknown };

    if (!request.messages) {
      // Return empty array - let route handler check for empty messages
      return [];
    }

    if (!Array.isArray(request.messages)) {
      throw new Error('messages field must be an array');
    }

    return request.messages.map((msg: unknown, index: number) => {
      if (!msg || typeof msg !== 'object') {
        throw new Error(`Invalid message at index ${index}`);
      }

      const message = msg as { role?: unknown; content?: unknown };

      if (
        !message.role ||
        typeof message.role !== 'string' ||
        !['user', 'assistant', 'system'].includes(message.role)
      ) {
        throw new Error(`Invalid role at message index ${index}`);
      }

      if (!message.content || typeof message.content !== 'string') {
        throw new Error(`Invalid content at message index ${index}`);
      }

      return {
        role: message.role as 'user' | 'assistant' | 'system',
        content: message.content,
      };
    });
  }

  /**
   * Format response for web client
   *
   * For non-streaming responses, return content as-is.
   * Streaming responses are handled by SSE bridge directly.
   */
  formatResponse(content: string, _context: TenantContext): string {
    return content;
  }
}
