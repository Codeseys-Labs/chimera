/**
 * Tests for Telegram platform adapter
 */

import { TelegramPlatformAdapter } from '../../adapters/telegram';
import { TenantTier } from '@chimera/shared';

describe('TelegramPlatformAdapter', () => {
  let adapter: TelegramPlatformAdapter;

  beforeEach(() => {
    adapter = new TelegramPlatformAdapter();
  });

  describe('parseIncoming', () => {
    it('should parse valid Telegram text message', () => {
      const update = {
        update_id: 123456,
        message: {
          message_id: 1,
          from: {
            id: 8734062810,
            is_bot: false,
            first_name: 'Alice',
            username: 'alice',
          },
          chat: {
            id: 8734062810,
            type: 'private' as const,
          },
          text: 'Hello, bot!',
        },
      };

      const messages = adapter.parseIncoming(update);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        role: 'user',
        content: 'Hello, bot!',
      });
    });

    it('should parse message from group chat', () => {
      const update = {
        update_id: 123457,
        message: {
          message_id: 42,
          from: {
            id: 8734062810,
            is_bot: false,
            first_name: 'Bob',
          },
          chat: {
            id: -1001234567890,
            type: 'supergroup' as const,
          },
          text: 'Group message',
        },
      };

      const messages = adapter.parseIncoming(update);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Group message');
    });

    it('should return empty array for non-message updates', () => {
      const update = {
        update_id: 123458,
        // No message field
      };

      const messages = adapter.parseIncoming(update);

      expect(messages).toHaveLength(0);
    });

    it('should return empty array for non-text messages', () => {
      const update = {
        update_id: 123459,
        message: {
          message_id: 2,
          from: {
            id: 8734062810,
            is_bot: false,
            first_name: 'Alice',
          },
          chat: {
            id: 8734062810,
            type: 'private' as const,
          },
          // No text field - could be a photo, sticker, etc.
        },
      };

      const messages = adapter.parseIncoming(update);

      expect(messages).toHaveLength(0);
    });

    it('should throw error for invalid request body', () => {
      expect(() => adapter.parseIncoming(null)).toThrow('Invalid request body');
      expect(() => adapter.parseIncoming(undefined)).toThrow(
        'Invalid request body'
      );
      expect(() => adapter.parseIncoming('string')).toThrow(
        'Invalid request body'
      );
    });

    it('should handle edited messages (no message field)', () => {
      const update = {
        update_id: 123460,
        edited_message: {
          message_id: 1,
          text: 'Edited text',
        },
      };

      const messages = adapter.parseIncoming(update);

      expect(messages).toHaveLength(0);
    });
  });

  describe('formatResponse', () => {
    const mockContext = {
      tenantId: 'tenant-123',
      tier: 'basic' as TenantTier,
    };

    it('should format simple text response', () => {
      const response = adapter.formatResponse('Hello, user!', mockContext);

      expect(response).toEqual({
        method: 'sendMessage',
        text: 'Hello, user!',
        parse_mode: 'Markdown',
      });
    });

    it('should preserve markdown formatting', () => {
      const content = '*bold* _italic_ `code`';
      const response = adapter.formatResponse(content, mockContext);

      expect(response.text).toBe(content);
      expect(response.parse_mode).toBe('Markdown');
    });

    it('should handle multi-line responses', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const response = adapter.formatResponse(content, mockContext);

      expect(response.text).toBe(content);
      expect(response.method).toBe('sendMessage');
    });

    it('should handle empty content', () => {
      const response = adapter.formatResponse('', mockContext);

      expect(response.text).toBe('');
      expect(response.method).toBe('sendMessage');
    });
  });

  describe('platform identifier', () => {
    it('should have correct platform identifier', () => {
      expect(adapter.platform).toBe('telegram');
    });
  });
});
