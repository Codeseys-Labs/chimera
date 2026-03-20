/**
 * Discord platform adapter
 *
 * Handles Discord-specific message parsing and formatting using embeds.
 * Supports interaction webhooks, slash commands, and message components.
 */

import { PlatformAdapter } from './types';
import { ChatMessage, TenantContext } from '../types';

/**
 * Discord interaction payload
 */
interface DiscordInteraction {
  type?: number;
  data?: {
    name?: string;
    options?: Array<{ name: string; value: string }>;
  };
  member?: {
    user?: {
      id: string;
      username: string;
    };
  };
  user?: {
    id: string;
    username: string;
  };
  channel_id?: string;
  guild_id?: string;
}

/**
 * Discord message payload
 */
interface DiscordMessage {
  content?: string;
  author?: {
    id: string;
    username: string;
  };
  channel_id?: string;
  guild_id?: string;
}

/**
 * Discord embed format
 */
interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  footer?: {
    text: string;
  };
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
}

/**
 * Discord response message
 */
interface DiscordResponse {
  content?: string;
  embeds?: DiscordEmbed[];
}

export class DiscordPlatformAdapter implements PlatformAdapter {
  readonly platform = 'discord';

  // Discord brand color (Blurple)
  private readonly DISCORD_COLOR = 0x5865f2;

  /**
   * Parse incoming Discord request
   *
   * Handles multiple Discord payload formats:
   * - Slash commands: { type: 2, data: { name: "ai", options: [...] } }
   * - Message webhooks: { content: "...", author: { id: "...", username: "..." } }
   * - Standard messages array: { messages: [...] }
   */
  parseIncoming(body: unknown): ChatMessage[] {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid request body');
    }

    const request = body as Record<string, unknown>;

    // Handle Discord interaction (slash command or component)
    if (request.type && typeof request.type === 'number') {
      return this.parseInteraction(request as DiscordInteraction);
    }

    // Handle Discord message webhook
    // Check for message structure (content field or author field present)
    if ('content' in request || 'author' in request) {
      return this.parseMessage(request as DiscordMessage);
    }

    // Handle standard messages array format
    if (request.messages && Array.isArray(request.messages)) {
      return this.parseMessagesArray(request.messages);
    }

    throw new Error('Unsupported Discord payload format');
  }

  /**
   * Parse Discord interaction (slash command)
   *
   * Discord interaction types:
   * - 1: PING (health check)
   * - 2: APPLICATION_COMMAND (slash command)
   * - 3: MESSAGE_COMPONENT (button, select menu)
   * - 4: APPLICATION_COMMAND_AUTOCOMPLETE
   * - 5: MODAL_SUBMIT
   */
  private parseInteraction(interaction: DiscordInteraction): ChatMessage[] {
    // Type 2 = APPLICATION_COMMAND (slash command)
    if (interaction.type !== 2) {
      throw new Error(`Unsupported Discord interaction type: ${interaction.type}`);
    }

    if (!interaction.data) {
      throw new Error('Interaction missing data field');
    }

    // Extract command options
    const options = interaction.data.options || [];
    const messageOption = options.find((opt) => opt.name === 'message' || opt.name === 'prompt');

    if (!messageOption || !messageOption.value) {
      throw new Error('Slash command missing message/prompt option');
    }

    const text = messageOption.value.trim();
    if (text.length === 0) {
      throw new Error('Slash command message cannot be empty');
    }

    return [
      {
        role: 'user',
        content: text,
      },
    ];
  }

  /**
   * Parse Discord message webhook
   */
  private parseMessage(message: DiscordMessage): ChatMessage[] {
    if (message.content === undefined || typeof message.content !== 'string') {
      throw new Error('Message missing content field');
    }

    const text = message.content.trim();
    if (text.length === 0) {
      throw new Error('Message content cannot be empty');
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
   * Format response for Discord using embeds
   *
   * Discord embeds provide rich formatting with title, description, fields, and colors.
   * Messages are automatically chunked to fit Discord's 2000-character limit.
   *
   * @see https://discord.com/developers/docs/resources/channel#embed-object
   */
  formatResponse(content: string, _context: TenantContext): DiscordResponse {
    const chunks = this.chunkContent(content);

    // Single chunk: use description field
    if (chunks.length === 1) {
      return {
        embeds: [
          {
            description: chunks[0],
            color: this.DISCORD_COLOR,
            timestamp: new Date().toISOString(),
            footer: {
              text: 'AWS Chimera Agent',
            },
          },
        ],
      };
    }

    // Multiple chunks: use separate embeds
    return {
      embeds: chunks.map((chunk, index) => ({
        description: chunk,
        color: this.DISCORD_COLOR,
        footer: {
          text: `AWS Chimera Agent (${index + 1}/${chunks.length})`,
        },
      })),
    };
  }

  /**
   * Chunk content into Discord-compatible messages
   *
   * Discord has a 2000-character limit per message (or embed description).
   * Split long responses into multiple embeds.
   */
  private chunkContent(content: string): string[] {
    const MAX_EMBED_LENGTH = 2000;
    const chunks: string[] = [];

    if (content.length <= MAX_EMBED_LENGTH) {
      return [content];
    }

    // Split by paragraphs first to avoid breaking mid-paragraph
    const paragraphs = content.split('\n\n');
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      // If single paragraph exceeds limit, force split by character limit
      if (paragraph.length > MAX_EMBED_LENGTH) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // Force split long paragraph at character boundary
        for (let i = 0; i < paragraph.length; i += MAX_EMBED_LENGTH) {
          chunks.push(paragraph.slice(i, i + MAX_EMBED_LENGTH));
        }
      } else {
        // Check if adding paragraph exceeds limit
        if (currentChunk.length + paragraph.length + 2 > MAX_EMBED_LENGTH) {
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
