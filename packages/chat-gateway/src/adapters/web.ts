/**
 * Web platform adapter
 *
 * Handles both Vercel AI SDK v4 and v5 message formats:
 *   v4: { messages: [ { role: 'user', content: '...' } ] }
 *   v5: { messages: [ { role: 'user', parts: [{ type: 'text', text: '...' }] } ] }
 */

import { PlatformAdapter } from './types';
import { ChatMessage, TenantContext } from '../types';

/** AI SDK v5 UIMessage part */
interface TextPart {
  type: 'text';
  text: string;
}

export class WebPlatformAdapter implements PlatformAdapter {
  readonly platform = 'web';

  /**
   * Parse incoming request body
   *
   * Accepts both AI SDK v4 (content string) and v5 (parts array) formats.
   */
  parseIncoming(body: unknown): ChatMessage[] {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid request body');
    }

    const request = body as { messages?: unknown };

    if (!request.messages) {
      return [];
    }

    if (!Array.isArray(request.messages)) {
      throw new Error('messages field must be an array');
    }

    return request.messages.map((msg: unknown, index: number) => {
      if (!msg || typeof msg !== 'object') {
        throw new Error(`Invalid message at index ${index}`);
      }

      const message = msg as {
        role?: unknown;
        content?: unknown;
        parts?: unknown;
      };

      if (
        !message.role ||
        typeof message.role !== 'string' ||
        !['user', 'assistant', 'system'].includes(message.role)
      ) {
        throw new Error(`Invalid role at message index ${index}`);
      }

      // Extract text content: support both v4 (content string) and v5 (parts array)
      let content: string;

      if (typeof message.content === 'string' && message.content.length > 0) {
        // AI SDK v4 format: { role, content: "..." }
        content = message.content;
      } else if (Array.isArray(message.parts)) {
        // AI SDK v5 format: { role, parts: [{ type: 'text', text: '...' }] }
        const textParts = (message.parts as TextPart[])
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text);
        content = textParts.join('');
      } else {
        content = '';
      }

      if (!content) {
        throw new Error(`Empty content at message index ${index}`);
      }

      return {
        role: message.role as 'user' | 'assistant' | 'system',
        content,
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
