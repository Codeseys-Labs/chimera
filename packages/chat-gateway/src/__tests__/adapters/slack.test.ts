/**
 * Slack adapter unit tests
 */

import { SlackPlatformAdapter } from '../../adapters/slack';
import { TenantContext } from '../../types';

describe('SlackPlatformAdapter', () => {
  let adapter: SlackPlatformAdapter;
  let mockContext: TenantContext;

  beforeEach(() => {
    adapter = new SlackPlatformAdapter();
    mockContext = {
      tenantId: 'tenant-test',
      userId: 'user-test',
      tier: 'basic',
    };
  });

  describe('platform identifier', () => {
    it('should have correct platform identifier', () => {
      expect(adapter.platform).toBe('slack');
    });
  });

  describe('parseIncoming', () => {
    describe('slash command format', () => {
      it('should parse valid slash command', () => {
        const payload = {
          command: '/ai',
          text: 'What is the weather today?',
          user_id: 'U123456',
          channel_id: 'C789012',
          team_id: 'T345678',
        };

        const result = adapter.parseIncoming(payload);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          role: 'user',
          content: 'What is the weather today?',
        });
      });

      it('should trim whitespace from slash command text', () => {
        const payload = {
          command: '/ai',
          text: '  hello world  ',
          user_id: 'U123456',
        };

        const result = adapter.parseIncoming(payload);

        expect(result[0].content).toBe('hello world');
      });

      it('should reject slash command with empty text', () => {
        const payload = {
          command: '/ai',
          text: '   ',
          user_id: 'U123456',
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Slash command text cannot be empty'
        );
      });

      it('should reject slash command missing text field', () => {
        const payload = {
          command: '/ai',
          user_id: 'U123456',
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Slash command missing text field'
        );
      });
    });

    describe('Events API format', () => {
      it('should parse message event', () => {
        const payload = {
          event: {
            type: 'message',
            text: 'Hello AI assistant',
            user: 'U123456',
            channel: 'C789012',
            ts: '1234567890.123456',
          },
        };

        const result = adapter.parseIncoming(payload);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          role: 'user',
          content: 'Hello AI assistant',
        });
      });

      it('should trim whitespace from event text', () => {
        const payload = {
          event: {
            type: 'message',
            text: '  test message  ',
            user: 'U123456',
          },
        };

        const result = adapter.parseIncoming(payload);

        expect(result[0].content).toBe('test message');
      });

      it('should reject non-message event types', () => {
        const payload = {
          event: {
            type: 'app_mention',
            text: 'Hello',
            user: 'U123456',
          },
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Unsupported Slack event type: app_mention'
        );
      });

      it('should reject event with empty text', () => {
        const payload = {
          event: {
            type: 'message',
            text: '',
            user: 'U123456',
          },
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Event text cannot be empty'
        );
      });

      it('should reject event missing text field', () => {
        const payload = {
          event: {
            type: 'message',
            user: 'U123456',
          },
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Event missing text field'
        );
      });
    });

    describe('direct message format', () => {
      it('should parse direct text message', () => {
        const payload = {
          text: 'Simple message',
        };

        const result = adapter.parseIncoming(payload);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          role: 'user',
          content: 'Simple message',
        });
      });
    });

    describe('standard messages array format', () => {
      it('should parse messages array', () => {
        const payload = {
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
            { role: 'user', content: 'How are you?' },
          ],
        };

        const result = adapter.parseIncoming(payload);

        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
        expect(result[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
        expect(result[2]).toEqual({ role: 'user', content: 'How are you?' });
      });

      it('should reject invalid role in messages array', () => {
        const payload = {
          messages: [{ role: 'invalid', content: 'test' }],
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
        expect(() => adapter.parseIncoming('string')).toThrow('Invalid request body');
      });

      it('should reject unsupported payload format', () => {
        const payload = {
          unsupported: 'format',
        };

        expect(() => adapter.parseIncoming(payload)).toThrow(
          'Unsupported Slack payload format'
        );
      });
    });
  });

  describe('formatResponse', () => {
    it('should format short message with Block Kit', () => {
      const content = 'This is a short response from the AI agent.';

      const result = adapter.formatResponse(content, mockContext);

      expect(result).toHaveProperty('blocks');
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0]).toEqual({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: content,
        },
      });
      expect(result.response_type).toBe('in_channel');
    });

    it('should support markdown formatting', () => {
      const content = '*Bold text* and _italic text_ with `code`';

      const result = adapter.formatResponse(content, mockContext);

      expect(result.blocks[0].text?.text).toBe(content);
      expect(result.blocks[0].text?.type).toBe('mrkdwn');
    });

    it('should chunk long messages into multiple blocks', () => {
      // Create a message longer than 3000 characters
      const paragraph = 'A'.repeat(1500);
      const content = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;

      const result = adapter.formatResponse(content, mockContext);

      expect(result.blocks.length).toBeGreaterThan(1);

      // Each block should be a section with mrkdwn text
      result.blocks.forEach((block) => {
        expect(block.type).toBe('section');
        expect(block.text?.type).toBe('mrkdwn');
        expect(block.text?.text.length).toBeLessThanOrEqual(3000);
      });
    });

    it('should preserve paragraph breaks when chunking', () => {
      const para1 = 'First paragraph with some content.';
      const para2 = 'Second paragraph with more content.';
      const content = `${para1}\n\n${para2}`;

      const result = adapter.formatResponse(content, mockContext);

      // Should be in one block since total length is small
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].text?.text).toContain('\n\n');
    });

    it('should handle very long single paragraphs', () => {
      // Create a paragraph longer than 3000 characters without breaks
      const content = 'A'.repeat(5000);

      const result = adapter.formatResponse(content, mockContext);

      expect(result.blocks.length).toBeGreaterThan(1);

      // Each block should be under limit
      result.blocks.forEach((block) => {
        expect(block.text?.text.length).toBeLessThanOrEqual(3000);
      });
    });

    it('should handle empty content', () => {
      const result = adapter.formatResponse('', mockContext);

      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].text?.text).toBe('');
    });

    it('should set response_type to in_channel', () => {
      const result = adapter.formatResponse('Test', mockContext);

      expect(result.response_type).toBe('in_channel');
    });
  });

  describe('multi-paragraph content', () => {
    it('should chunk at paragraph boundaries', () => {
      // Create content with multiple paragraphs that exceed 3000 chars
      const smallPara = 'Short paragraph.\n\n';
      const largePara = 'A'.repeat(2000) + '\n\n';
      const content = smallPara + largePara + largePara;

      const result = adapter.formatResponse(content, mockContext);

      // Should split into multiple blocks
      expect(result.blocks.length).toBeGreaterThan(1);
    });

    it('should handle mixed paragraph sizes', () => {
      const content = [
        'Short paragraph.',
        'A'.repeat(1000),
        'Another short one.',
        'B'.repeat(2500),
        'Final paragraph.',
      ].join('\n\n');

      const result = adapter.formatResponse(content, mockContext);

      // Verify all blocks are valid
      result.blocks.forEach((block) => {
        expect(block.text?.text.length).toBeLessThanOrEqual(3000);
        expect(block.type).toBe('section');
      });
    });
  });
});
