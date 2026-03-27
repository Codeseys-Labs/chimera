/**
 * Tests for SSE formatting
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  formatSSEData,
  formatSSEDone,
  SSEStreamWriter,
  VERCEL_DSP_HEADERS,
} from '../sse-formatter';
import { VercelDSPStreamPart } from '../types';

describe('SSE Formatter', () => {
  describe('formatSSEData', () => {
    it('should format a DSP part as SSE data line', () => {
      const part: VercelDSPStreamPart = {
        type: 'start',
        messageId: 'msg_123',
      };

      const result = formatSSEData(part);

      expect(result).toBe('data: {"type":"start","messageId":"msg_123"}\n\n');
    });

    it('should handle complex nested data', () => {
      const part: VercelDSPStreamPart = {
        type: 'finish',
        messageId: 'msg_456',
        finishReason: 'stop',
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
      };

      const result = formatSSEData(part);

      expect(result).toContain('"type":"finish"');
      expect(result).toContain('"usage":{');
      expect(result).toContain('"promptTokens":100');
      expect(result).toMatch(/\n\n$/); // Ends with double newline
    });

    it('should escape special characters in JSON', () => {
      const part: VercelDSPStreamPart = {
        type: 'text-delta',
        id: 'text_1',
        delta: 'Hello\n"world"',
      };

      const result = formatSSEData(part);

      expect(result).toContain('Hello\\n\\"world\\"');
    });
  });

  describe('formatSSEDone', () => {
    it('should format the stream terminator', () => {
      const result = formatSSEDone();

      expect(result).toBe('data: [DONE]\n\n');
    });
  });

  describe('VERCEL_DSP_HEADERS', () => {
    it('should include required headers', () => {
      expect(VERCEL_DSP_HEADERS).toMatchObject({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'x-vercel-ai-ui-message-stream': 'v1',
      });
    });
  });

  describe('SSEStreamWriter', () => {
    let chunks: Buffer[];
    let mockWriter: any;

    beforeEach(() => {
      chunks = [];
      mockWriter = {
        write: mock((chunk: Buffer, callback?: () => void) => {
          chunks.push(chunk);
          if (callback) callback();
          return true;
        }),
        once: mock(() => undefined),
        end: mock((callback?: () => void) => {
          if (callback) callback();
        }),
      };
    });

    it('should write a single part', async () => {
      const writer = new SSEStreamWriter(mockWriter);

      const part: VercelDSPStreamPart = {
        type: 'text-delta',
        id: 'text_1',
        delta: 'Hello',
      };

      await writer.write(part);

      expect(chunks).toHaveLength(1);
      const data = chunks[0].toString();
      expect(data).toContain('"type":"text-delta"');
      expect(data).toContain('"delta":"Hello"');
    });

    it('should write multiple parts', async () => {
      const writer = new SSEStreamWriter(mockWriter);

      const parts: VercelDSPStreamPart[] = [
        { type: 'start', messageId: 'msg_1' },
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', delta: 'Test' },
        { type: 'text-end', id: 'text_1' },
      ];

      await writer.writeAll(parts);

      expect(chunks).toHaveLength(4);
      expect(chunks.map((c) => c.toString()).join('')).toContain('data: {"type":"start"');
      expect(chunks.map((c) => c.toString()).join('')).toContain('data: {"type":"text-delta"');
    });

    it('should close with [DONE]', async () => {
      const writer = new SSEStreamWriter(mockWriter);

      await writer.close();

      expect(chunks).toHaveLength(1);
      expect(chunks[0].toString()).toBe('data: [DONE]\n\n');
    });

    it('should not write after close', async () => {
      const writer = new SSEStreamWriter(mockWriter);

      await writer.close();
      expect(writer.isClosed()).toBe(true);

      await expect(
        writer.write({ type: 'start', messageId: 'msg_1' })
      ).rejects.toThrow('SSEStreamWriter is closed');
    });

    it('should handle close idempotently', async () => {
      const writer = new SSEStreamWriter(mockWriter);

      await writer.close();
      await writer.close(); // Should not throw

      expect(chunks).toHaveLength(1); // Only one [DONE]
    });
  });
});
