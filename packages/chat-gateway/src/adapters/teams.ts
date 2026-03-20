/**
 * Microsoft Teams platform adapter
 *
 * Handles Bot Framework Activity format for Teams.
 * Supports text messages and Adaptive Cards.
 */

import { PlatformAdapter } from './types';
import { ChatMessage, TenantContext } from '../types';

/**
 * Bot Framework Activity format
 * @see https://docs.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-api-reference
 */
interface BotFrameworkActivity {
  type: 'message' | 'conversationUpdate' | 'contactRelationUpdate' | 'typing';
  id?: string;
  timestamp?: string;
  channelId: string;
  from: {
    id: string;
    name?: string;
  };
  conversation: {
    id: string;
    isGroup?: boolean;
    conversationType?: string;
  };
  recipient: {
    id: string;
    name?: string;
  };
  text?: string;
  textFormat?: 'plain' | 'markdown' | 'xml';
  locale?: string;
  channelData?: unknown;
}

export class TeamsPlatformAdapter implements PlatformAdapter {
  readonly platform = 'teams';

  /**
   * Parse incoming Bot Framework Activity
   *
   * Teams Bot Framework sends activities in this format:
   * {
   *   type: "message",
   *   id: "1234567890",
   *   channelId: "msteams",
   *   from: { id: "29:1234abcd", name: "Alice" },
   *   conversation: { id: "19:meeting_xxx", conversationType: "personal" },
   *   recipient: { id: "28:bot-id", name: "ChimeraBot" },
   *   text: "Hello!",
   *   textFormat: "plain"
   * }
   */
  parseIncoming(body: unknown): ChatMessage[] {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid request body');
    }

    const activity = body as BotFrameworkActivity;

    // Only handle message activities
    if (activity.type !== 'message') {
      return [];
    }

    if (!activity.text || typeof activity.text !== 'string') {
      // Empty or non-text message
      return [];
    }

    // Strip @mentions in Teams group conversations
    // Teams adds "<at>BotName</at>" to messages with @mentions
    const cleanedText = this.stripMentions(activity.text);

    if (!cleanedText.trim()) {
      return [];
    }

    return [
      {
        role: 'user',
        content: cleanedText,
      },
    ];
  }

  /**
   * Format response for Teams
   *
   * Teams supports:
   * - Plain text
   * - Markdown
   * - Adaptive Cards (rich formatting)
   *
   * For now, return simple text response. Adaptive Cards can be
   * added via route handler for rich formatting (buttons, images, etc.).
   */
  formatResponse(content: string, _context: TenantContext): TeamsResponse {
    return {
      type: 'message',
      text: content,
      textFormat: 'markdown',
    };
  }

  /**
   * Strip @mention tags from Teams messages
   *
   * Teams wraps bot mentions in XML-like tags:
   * "<at>BotName</at> do something" -> "do something"
   */
  private stripMentions(text: string): string {
    return text.replace(/<at>.*?<\/at>\s*/g, '').trim();
  }
}

/**
 * Teams message response format
 * @see https://docs.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-send-and-receive-messages
 */
interface TeamsResponse {
  type: 'message';
  text: string;
  textFormat?: 'plain' | 'markdown' | 'xml';
  attachments?: unknown[];
}
