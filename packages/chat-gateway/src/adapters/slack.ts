/**
 * Slack platform adapter
 *
 * Handles Slack-specific message parsing and formatting using Block Kit.
 * Supports slash commands, Events API, and interactive components.
 */

import { PlatformAdapter } from './types';
import { ChatMessage, TenantContext } from '../types';

/**
 * Slack message event payload structure
 */
interface SlackMessageEvent {
  type?: string;
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
}

/**
 * Slack slash command payload
 */
interface SlackSlashCommand {
  command?: string;
  text?: string;
  user_id?: string;
  channel_id?: string;
  team_id?: string;
}

/**
 * Slack Block Kit message format
 */
interface SlackBlockMessage {
  blocks: Array<{
    type: string;
    text?: {
      type: string;
      text: string;
    };
  }>;
  response_type?: 'in_channel' | 'ephemeral';
}

export class SlackPlatformAdapter implements PlatformAdapter {
  readonly platform = 'slack';

  /**
   * Parse incoming Slack request
   *
   * Handles multiple Slack payload formats:
   * - Slash commands: { command: "/ai", text: "...", user_id: "..." }
   * - Events API: { event: { type: "message", text: "...", user: "..." } }
   * - Interactive components: { payload: { message: { text: "..." } } }
   */
  parseIncoming(body: unknown): ChatMessage[] {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid request body');
    }

    const request = body as Record<string, unknown>;

    // Handle slash command format
    if (request.command && typeof request.command === 'string') {
      return this.parseSlashCommand(request as SlackSlashCommand);
    }

    // Handle Events API format
    if (request.event && typeof request.event === 'object') {
      return this.parseEventAPI(request.event as SlackMessageEvent);
    }

    // Handle direct message format (for testing or simple integrations)
    if (request.text && typeof request.text === 'string') {
      return [
        {
          role: 'user',
          content: request.text,
        },
      ];
    }

    // Handle messages array (unified format)
    if (request.messages && Array.isArray(request.messages)) {
      return this.parseMessagesArray(request.messages);
    }

    throw new Error('Unsupported Slack payload format');
  }

  /**
   * Parse Slack slash command
   */
  private parseSlashCommand(command: SlackSlashCommand): ChatMessage[] {
    if (!command.text || typeof command.text !== 'string') {
      throw new Error('Slash command missing text field');
    }

    const text = command.text.trim();
    if (text.length === 0) {
      throw new Error('Slash command text cannot be empty');
    }

    return [
      {
        role: 'user',
        content: text,
      },
    ];
  }

  /**
   * Parse Slack Events API message event
   */
  private parseEventAPI(event: SlackMessageEvent): ChatMessage[] {
    if (event.type !== 'message') {
      throw new Error(`Unsupported Slack event type: ${event.type}`);
    }

    if (event.text === undefined || typeof event.text !== 'string') {
      throw new Error('Event missing text field');
    }

    const text = event.text.trim();
    if (text.length === 0) {
      throw new Error('Event text cannot be empty');
    }

    return [
      {
        role: 'user',
        content: text,
      },
    ];
  }

  /**
   * Parse standard messages array format
   */
  private parseMessagesArray(messages: unknown[]): ChatMessage[] {
    return messages.map((msg: unknown, index: number) => {
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
   * Format response for Slack using Block Kit
   *
   * Slack Block Kit provides rich formatting with markdown support.
   * Long messages are automatically chunked to fit Slack's 3000-character limit per block.
   *
   * @see https://api.slack.com/block-kit
   */
  formatResponse(content: string, _context: TenantContext): SlackBlockMessage {
    const blocks = this.chunkContent(content);

    return {
      blocks: blocks.map((chunk) => ({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: chunk,
        },
      })),
      response_type: 'in_channel', // Visible to everyone in channel
    };
  }

  /**
   * Chunk content into Slack-compatible blocks
   *
   * Slack has a 3000-character limit per text block.
   * Split long responses into multiple blocks.
   */
  private chunkContent(content: string): string[] {
    const MAX_BLOCK_LENGTH = 3000;
    const chunks: string[] = [];

    if (content.length <= MAX_BLOCK_LENGTH) {
      return [content];
    }

    // Split by paragraphs first to avoid breaking mid-paragraph
    const paragraphs = content.split('\n\n');
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      // If single paragraph exceeds limit, force split by character limit
      if (paragraph.length > MAX_BLOCK_LENGTH) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // Force split long paragraph at character boundary
        for (let i = 0; i < paragraph.length; i += MAX_BLOCK_LENGTH) {
          chunks.push(paragraph.slice(i, i + MAX_BLOCK_LENGTH));
        }
      } else {
        // Check if adding paragraph exceeds limit
        if (currentChunk.length + paragraph.length + 2 > MAX_BLOCK_LENGTH) {
          chunks.push(currentChunk.trim());
          currentChunk = paragraph + '\n\n';
        } else {
          currentChunk += paragraph + '\n\n';
        }
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }
}
