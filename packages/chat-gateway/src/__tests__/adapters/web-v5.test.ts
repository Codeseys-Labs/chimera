/**
 * Tests for WebPlatformAdapter — v4 and v5 format support
 */

import { describe, it, expect } from 'bun:test';
import { WebPlatformAdapter } from '../../adapters/web';

describe('WebPlatformAdapter', () => {
  const adapter = new WebPlatformAdapter();

  describe('platform', () => {
    it('should have platform set to web', () => {
      expect(adapter.platform).toBe('web');
    });
  });

  describe('parseIncoming — v4 format', () => {
    it('should accept v4 format with content string', () => {
      const body = {
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = adapter.parseIncoming(body);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: 'user', content: 'hello' });
    });

    it('should handle multiple v4 messages', () => {
      const body = {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' },
        ],
      };

      const result = adapter.parseIncoming(body);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ role: 'user', content: 'hello' });
      expect(result[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
      expect(result[2]).toEqual({ role: 'user', content: 'How are you?' });
    });

    it('should handle system messages in v4 format', () => {
      const body = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'hello' },
        ],
      };

      const result = adapter.parseIncoming(body);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    });
  });

  describe('parseIncoming — v5 format', () => {
    it('should accept v5 format with parts array', () => {
      const body = {
        messages: [
          {
            role: 'user',
            parts: [{ type: 'text', text: 'hello' }],
          },
        ],
      };

      const result = adapter.parseIncoming(body);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: 'user', content: 'hello' });
    });

    it('should join multiple text parts from v5 format', () => {
      const body = {
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'world' },
              { type: 'text', text: '!' },
            ],
          },
        ],
      };

      const result = adapter.parseIncoming(body);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Hello world!');
    });

    it('should filter non-text parts in v5 format', () => {
      const body = {
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'hello' },
              { type: 'image', url: 'http://example.com/img.png' },
              { type: 'text', text: ' world' },
            ],
          },
        ],
      };

      const result = adapter.parseIncoming(body);

      expect(result[0].content).toBe('hello world');
    });

    it('should reject empty parts array (no text content)', () => {
      const body = {
        messages: [
          {
            role: 'user',
            parts: [],
          },
        ],
      };

      expect(() => adapter.parseIncoming(body)).toThrow('Empty content at message index 0');
    });

    it('should reject parts with only non-text types', () => {
      const body = {
        messages: [
          {
            role: 'user',
            parts: [{ type: 'image', url: 'http://example.com/img.png' }],
          },
        ],
      };

      expect(() => adapter.parseIncoming(body)).toThrow('Empty content at message index 0');
    });

    it('should handle assistant messages in v5 format', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            parts: [{ type: 'text', text: 'I can help with that.' }],
          },
        ],
      };

      const result = adapter.parseIncoming(body);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: 'assistant', content: 'I can help with that.' });
    });
  });

  describe('parseIncoming — content vs parts priority', () => {
    it('should prioritize content over parts when both present', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: 'from content field',
            parts: [{ type: 'text', text: 'from parts field' }],
          },
        ],
      };

      const result = adapter.parseIncoming(body);

      // content string takes priority (checked first in the code)
      expect(result[0].content).toBe('from content field');
    });
  });

  describe('parseIncoming — validation', () => {
    it('should reject messages with invalid role', () => {
      const body = {
        messages: [{ role: 'admin', content: 'hello' }],
      };

      expect(() => adapter.parseIncoming(body)).toThrow('Invalid role at message index 0');
    });

    it('should reject messages with missing role', () => {
      const body = {
        messages: [{ content: 'hello' }],
      };

      expect(() => adapter.parseIncoming(body)).toThrow('Invalid role at message index 0');
    });

    it('should reject messages with numeric role', () => {
      const body = {
        messages: [{ role: 42, content: 'hello' }],
      };

      expect(() => adapter.parseIncoming(body)).toThrow('Invalid role at message index 0');
    });

    it('should return empty array when messages field is missing', () => {
      const body = { something: 'else' };

      const result = adapter.parseIncoming(body);

      expect(result).toEqual([]);
    });

    it('should return empty array for empty body object', () => {
      const result = adapter.parseIncoming({});

      expect(result).toEqual([]);
    });

    it('should throw for null body', () => {
      expect(() => adapter.parseIncoming(null)).toThrow('Invalid request body');
    });

    it('should throw for non-object body', () => {
      expect(() => adapter.parseIncoming('string body')).toThrow('Invalid request body');
    });

    it('should throw when messages is not an array', () => {
      const body = { messages: 'not an array' };

      expect(() => adapter.parseIncoming(body)).toThrow('messages field must be an array');
    });

    it('should throw for null message in array', () => {
      const body = { messages: [null] };

      expect(() => adapter.parseIncoming(body)).toThrow('Invalid message at index 0');
    });

    it('should reject message with empty content string', () => {
      const body = {
        messages: [{ role: 'user', content: '' }],
      };

      expect(() => adapter.parseIncoming(body)).toThrow('Empty content at message index 0');
    });

    it('should report correct index for invalid message', () => {
      const body = {
        messages: [
          { role: 'user', content: 'valid' },
          { role: 'invalid', content: 'bad' },
        ],
      };

      expect(() => adapter.parseIncoming(body)).toThrow('Invalid role at message index 1');
    });
  });

  describe('formatResponse', () => {
    it('should return content as-is', () => {
      const result = adapter.formatResponse('Hello world', {
        tenantId: 'tenant-1',
        tier: 'basic',
      });

      expect(result).toBe('Hello world');
    });
  });
});
