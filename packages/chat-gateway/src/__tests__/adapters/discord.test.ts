/**
 * Discord adapter unit tests
 */

import { DiscordPlatformAdapter } from '../../adapters/discord';
import { TenantContext } from '../../types';

describe('DiscordPlatformAdapter', () => {
  let adapter: DiscordPlatformAdapter;
  let mockContext: TenantContext;

  beforeEach(() => {
    adapter = new DiscordPlatformAdapter();
    mockContext = {
      tenantId: 'tenant-test',
      userId: 'user-test',
      tier: 'basic',
    };
  });

  describe('platform identifier', () => {
    it('should have correct platform identifier', () => {
      expect(adapter.platform).toBe('discord');
    });
  });

  describe('parseIncoming', () => {
    describe('interaction format (slash command)', () => {
      it('should parse valid slash command interaction', () => {
        const payload = {
          type: 2, // APPLICATION_COMMAND
          data: {
            name: 'ai',
            options: [
              { name: 'message', value: 'What is 2+2?' },
            ],
          },
          member: {
            user: {
              id: '123456789',
              username: 'testuser',
            },
          },
          channel_id: '987654321',
          guild_id: '111222333',
        };

        const result = adapter.parseIncoming(payload);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          role: 'user',
          content: 'What is 2+2?',
        });
      });

      it('should parse interaction with "prompt" option name', () => {
        const payload = {
          type: 2,
          data: {
            name: 'chat',
            options: [
              { name: 'prompt', value: 'Tell me a story' },
            ],
          },
        };

        const result = adapter.parseIncoming(payload);

        expect(result[0].content).toBe('Tell me a story');
      });

      it('should trim whitespace from interaction message', () => {
        const payload = {
          type: 2,
          data: {
            options: [
              { name: 'message', value: '  hello world  ' },
            ],
          },
        };

        const result = adapter.parseIncoming(payload);

        expect(result[0].content).toBe('hello world');
      });

      it('should reject interaction with empty message', () => {
        const payload = {
          type: 2,
          data: {
            options: [
              { name: 'message', value: '   ' },
            ],
          },
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Slash command message cannot be empty'
        );
      });

      it('should reject interaction missing message option', () => {
        const payload = {
          type: 2,
          data: {
            options: [
              { name: 'other', value: 'value' },
            ],
          },
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Slash command missing message/prompt option'
        );
      });

      it('should reject non-slash-command interaction types', () => {
        const payload = {
          type: 3, // MESSAGE_COMPONENT
          data: {
            options: [
              { name: 'message', value: 'test' },
            ],
          },
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Unsupported Discord interaction type: 3'
        );
      });

      it('should reject interaction missing data field', () => {
        const payload = {
          type: 2,
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Interaction missing data field'
        );
      });
    });

    describe('message webhook format', () => {
      it('should parse message webhook', () => {
        const payload = {
          content: 'Hello from Discord',
          author: {
            id: '123456789',
            username: 'testuser',
          },
          channel_id: '987654321',
        };

        const result = adapter.parseIncoming(payload);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          role: 'user',
          content: 'Hello from Discord',
        });
      });

      it('should trim whitespace from message content', () => {
        const payload = {
          content: '  test message  ',
        };

        const result = adapter.parseIncoming(payload);

        expect(result[0].content).toBe('test message');
      });

      it('should reject message with empty content', () => {
        const payload = {
          content: '   ',
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Message content cannot be empty'
        );
      });

      it('should reject message missing content field', () => {
        const payload = {
          author: {
            id: '123',
            username: 'user',
          },
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Message missing content field'
        );
      });
    });

    describe('standard messages array format', () => {
      it('should parse messages array', () => {
        const payload = {
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' },
            { role: 'user', content: 'How are you?' },
          ],
        };

        const result = adapter.parseIncoming(payload);

        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
        expect(result[1]).toEqual({ role: 'assistant', content: 'Hi!' });
        expect(result[2]).toEqual({ role: 'user', content: 'How are you?' });
      });

      it('should reject invalid role in messages array', () => {
        const payload = {
          messages: [{ role: 'bot', content: 'test' }],
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Invalid role at message index 0'
        );
      });

      it('should reject missing content in messages array', () => {
        const payload = {
          messages: [{ role: 'user' }],
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Invalid content at message index 0'
        );
      });
    });

    describe('error handling', () => {
      it('should reject null body', () => {
        expect(() => adapter.parseIncoming(null)).toThrow('Invalid request body');
      });

      it('should reject non-object body', () => {
        expect(() => adapter.parseIncoming(42)).toThrow('Invalid request body');
      });

      it('should reject unsupported payload format', () => {
        const payload = {
          unsupported: 'format',
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Unsupported Discord payload format'
        );
      });
    });
  });

  describe('formatResponse', () => {
    it('should format short message with embed', () => {
      const content = 'This is a response from the AI agent.';

      const result = adapter.formatResponse(content, mockContext);

      expect(result).toHaveProperty('embeds');
      expect(result.embeds).toHaveLength(1);

      const embed = result.embeds![0];
      expect(embed.description).toBe(content);
      expect(embed.color).toBe(0x5865f2); // Discord Blurple
      expect(embed.timestamp).toBeDefined();
      expect(embed.footer?.text).toBe('AWS Chimera Agent');
    });

    it('should include timestamp in embed', () => {
      const result = adapter.formatResponse('Test', mockContext);

      const embed = result.embeds![0];
      expect(embed.timestamp).toBeDefined();

      // Verify it's a valid ISO timestamp
      const timestamp = new Date(embed.timestamp!);
      expect(timestamp.toString()).not.toBe('Invalid Date');
    });

    it('should use Discord brand color', () => {
      const result = adapter.formatResponse('Test', mockContext);

      expect(result.embeds![0].color).toBe(0x5865f2);
    });

    it('should chunk long messages into multiple embeds', () => {
      // Create a message longer than 2000 characters
      const paragraph = 'A'.repeat(1000);
      const content = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;

      const result = adapter.formatResponse(content, mockContext);

      expect(result.embeds!.length).toBeGreaterThan(1);

      // Each embed description should be under 2000 characters
      result.embeds!.forEach((embed, index) => {
        expect(embed.description!.length).toBeLessThanOrEqual(2000);
        expect(embed.color).toBe(0x5865f2);

        // Multi-part messages should have numbered footer
        expect(embed.footer?.text).toContain(`(${index + 1}/${result.embeds!.length})`);
      });
    });

    it('should preserve paragraph breaks when chunking', () => {
      const para1 = 'First paragraph.';
      const para2 = 'Second paragraph.';
      const content = `${para1}\n\n${para2}`;

      const result = adapter.formatResponse(content, mockContext);

      // Should be in one embed since total length is small
      expect(result.embeds).toHaveLength(1);
      expect(result.embeds![0].description).toContain('\n\n');
    });

    it('should handle very long single paragraphs', () => {
      // Create a paragraph longer than 2000 characters
      const content = 'B'.repeat(3500);

      const result = adapter.formatResponse(content, mockContext);

      expect(result.embeds!.length).toBeGreaterThan(1);

      // Each embed should be under limit
      result.embeds!.forEach((embed) => {
        expect(embed.description!.length).toBeLessThanOrEqual(2000);
      });
    });

    it('should handle empty content', () => {
      const result = adapter.formatResponse('', mockContext);

      expect(result.embeds).toHaveLength(1);
      expect(result.embeds![0].description).toBe('');
    });

    it('should set footer text for single-embed messages', () => {
      const result = adapter.formatResponse('Short message', mockContext);

      expect(result.embeds![0].footer?.text).toBe('AWS Chimera Agent');
    });

    it('should number footer text for multi-embed messages', () => {
      const content = 'A'.repeat(2500) + '\n\n' + 'B'.repeat(2500);

      const result = adapter.formatResponse(content, mockContext);

      expect(result.embeds!.length).toBeGreaterThan(1);

      result.embeds!.forEach((embed, index) => {
        expect(embed.footer?.text).toBe(
          `AWS Chimera Agent (${index + 1}/${result.embeds!.length})`
        );
      });
    });

    it('should not include content field (embeds only)', () => {
      const result = adapter.formatResponse('Test', mockContext);

      // Response should only have embeds, no plain content field
      expect(result.content).toBeUndefined();
      expect(result.embeds).toBeDefined();
    });
  });

  describe('multi-paragraph content', () => {
    it('should chunk at paragraph boundaries', () => {
      const smallPara = 'Short paragraph.\n\n';
      const largePara = 'C'.repeat(1500) + '\n\n';
      const content = smallPara + largePara + largePara;

      const result = adapter.formatResponse(content, mockContext);

      // Should split into multiple embeds
      expect(result.embeds!.length).toBeGreaterThan(1);
    });

    it('should handle mixed paragraph sizes', () => {
      const content = [
        'Short paragraph.',
        'D'.repeat(800),
        'Another short one.',
        'E'.repeat(1800),
        'Final paragraph.',
      ].join('\n\n');

      const result = adapter.formatResponse(content, mockContext);

      // Verify all embeds are valid
      result.embeds!.forEach((embed) => {
        expect(embed.description!.length).toBeLessThanOrEqual(2000);
        expect(embed.color).toBe(0x5865f2);
      });
    });

    it('should handle exactly 2000 characters', () => {
      const content = 'F'.repeat(2000);

      const result = adapter.formatResponse(content, mockContext);

      expect(result.embeds).toHaveLength(1);
      expect(result.embeds![0].description?.length).toBe(2000);
    });

    it('should split at 2001 characters', () => {
      const content = 'G'.repeat(2001);

      const result = adapter.formatResponse(content, mockContext);

      expect(result.embeds!.length).toBeGreaterThan(1);
    });
  });
});
