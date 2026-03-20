/**
 * Telegram platform adapter
 *
 * Handles Telegram Bot API webhook format.
 * Supports text messages with Telegram markdown formatting.
 */

import { PlatformAdapter } from './types';
import { ChatMessage, TenantContext } from '../types';

/**
 * Telegram webhook update format
 * @see https://core.telegram.org/bots/api#update
 */
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
  };
  chat: {
    id: number;
    type: 'private' | 'group' | 'supergroup' | 'channel';
  };
  text?: string;
}

export class TelegramPlatformAdapter implements PlatformAdapter {
  readonly platform = 'telegram';

  /**
   * Parse incoming Telegram webhook payload
   *
   * Telegram Bot API sends webhooks in this format:
   * {
   *   update_id: 123456,
   *   message: {
   *     message_id: 1,
   *     from: { id: 8734062810, first_name: "Alice", username: "alice" },
   *     chat: { id: 8734062810, type: "private" },
   *     text: "Hello!"
   *   }
   * }
   */
  parseIncoming(body: unknown): ChatMessage[] {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid request body');
    }

    const update = body as TelegramUpdate;

    if (!update.message) {
      // Non-message update (edited message, callback query, etc.)
      return [];
    }

    if (!update.message.text) {
      // Non-text message (photo, sticker, etc.)
      return [];
    }

    // Return as user message in normalized format
    return [
      {
        role: 'user',
        content: update.message.text,
      },
    ];
  }

  /**
   * Format response for Telegram
   *
   * Telegram supports markdown formatting:
   * - *bold*
   * - _italic_
   * - `code`
   * - ```code block```
   *
   * For now, return plain text. Platform-specific formatting
   * (inline keyboards, etc.) can be added via route handler.
   */
  formatResponse(content: string, _context: TenantContext): TelegramResponse {
    return {
      method: 'sendMessage',
      text: content,
      parse_mode: 'Markdown',
    };
  }
}

/**
 * Telegram sendMessage response format
 * @see https://core.telegram.org/bots/api#sendmessage
 */
interface TelegramResponse {
  method: 'sendMessage';
  text: string;
  parse_mode?: 'Markdown' | 'HTML' | 'MarkdownV2';
  disable_web_page_preview?: boolean;
  reply_markup?: unknown;
}
