/**
 * Tests for Microsoft Teams platform adapter
 */

import { TeamsPlatformAdapter } from '../../adapters/teams';
import { TenantTier } from '@chimera/shared';

describe('TeamsPlatformAdapter', () => {
  let adapter: TeamsPlatformAdapter;

  beforeEach(() => {
    adapter = new TeamsPlatformAdapter();
  });

  describe('parseIncoming', () => {
    it('should parse valid Teams message activity', () => {
      const activity = {
        type: 'message',
        id: '1234567890',
        channelId: 'msteams',
        from: {
          id: '29:1234abcd',
          name: 'Alice',
        },
        conversation: {
          id: '19:meeting_xxx',
          conversationType: 'personal',
        },
        recipient: {
          id: '28:bot-id',
          name: 'ChimeraBot',
        },
        text: 'Hello, bot!',
        textFormat: 'plain',
      };

      const messages = adapter.parseIncoming(activity);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        role: 'user',
        content: 'Hello, bot!',
      });
    });

    it('should strip @mentions from Teams messages', () => {
      const activity = {
        type: 'message',
        channelId: 'msteams',
        from: { id: '29:user123', name: 'Bob' },
        conversation: { id: '19:channel123', isGroup: true },
        recipient: { id: '28:bot-id' },
        text: '<at>ChimeraBot</at> what is the weather?',
        textFormat: 'plain',
      };

      const messages = adapter.parseIncoming(activity);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('what is the weather?');
    });

    it('should handle multiple @mentions', () => {
      const activity = {
        type: 'message',
        channelId: 'msteams',
        from: { id: '29:user123' },
        conversation: { id: '19:channel123' },
        recipient: { id: '28:bot-id' },
        text: '<at>Bot1</at> <at>Bot2</at> process this',
      };

      const messages = adapter.parseIncoming(activity);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('process this');
    });

    it('should return empty array for non-message activities', () => {
      const activity = {
        type: 'conversationUpdate',
        channelId: 'msteams',
        from: { id: '29:user123' },
        conversation: { id: '19:meeting_xxx' },
        recipient: { id: '28:bot-id' },
      };

      const messages = adapter.parseIncoming(activity);

      expect(messages).toHaveLength(0);
    });

    it('should return empty array for activities without text', () => {
      const activity = {
        type: 'message',
        channelId: 'msteams',
        from: { id: '29:user123' },
        conversation: { id: '19:meeting_xxx' },
        recipient: { id: '28:bot-id' },
        // No text field
      };

      const messages = adapter.parseIncoming(activity);

      expect(messages).toHaveLength(0);
    });

    it('should return empty array when text becomes empty after stripping mentions', () => {
      const activity = {
        type: 'message',
        channelId: 'msteams',
        from: { id: '29:user123' },
        conversation: { id: '19:channel123' },
        recipient: { id: '28:bot-id' },
        text: '<at>ChimeraBot</at>   ',
      };

      const messages = adapter.parseIncoming(activity);

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

    it('should handle typing activity', () => {
      const activity = {
        type: 'typing',
        channelId: 'msteams',
        from: { id: '29:user123' },
        conversation: { id: '19:meeting_xxx' },
        recipient: { id: '28:bot-id' },
      };

      const messages = adapter.parseIncoming(activity);

      expect(messages).toHaveLength(0);
    });

    it('should parse message from group conversation', () => {
      const activity = {
        type: 'message',
        channelId: 'msteams',
        from: { id: '29:user123', name: 'Carol' },
        conversation: {
          id: '19:channel123',
          isGroup: true,
          conversationType: 'channel',
        },
        recipient: { id: '28:bot-id' },
        text: 'Team message here',
      };

      const messages = adapter.parseIncoming(activity);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Team message here');
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
        type: 'message',
        text: 'Hello, user!',
        textFormat: 'markdown',
      });
    });

    it('should preserve markdown formatting', () => {
      const content = '**bold** *italic* `code`';
      const response = adapter.formatResponse(content, mockContext);

      expect(response.text).toBe(content);
      expect(response.textFormat).toBe('markdown');
    });

    it('should handle multi-line responses', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const response = adapter.formatResponse(content, mockContext);

      expect(response.text).toBe(content);
      expect(response.type).toBe('message');
    });

    it('should handle empty content', () => {
      const response = adapter.formatResponse('', mockContext);

      expect(response.text).toBe('');
      expect(response.type).toBe('message');
    });

    it('should format content with special characters', () => {
      const content = 'Special: <>&"\'';
      const response = adapter.formatResponse(content, mockContext);

      expect(response.text).toBe(content);
    });
  });

  describe('platform identifier', () => {
    it('should have correct platform identifier', () => {
      expect(adapter.platform).toBe('teams');
    });
  });
});
