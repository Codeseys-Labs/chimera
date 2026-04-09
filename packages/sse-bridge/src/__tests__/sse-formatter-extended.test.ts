/**
 * Extended tests for SSE formatter — covers gaps not in sse-formatter.test.ts:
 *   - formatSSEKeepalive()
 *   - createSSEResponseStream()
 *   - createSSEReadableStream()
 *   - SSEStreamWriter with Web WritableStreamDefaultWriter
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  formatSSEKeepalive,
  createSSEResponseStream,
  createSSEReadableStream,
  SSEStreamWriter,
  VERCEL_DSP_HEADERS,
  formatSSEData,
  formatSSEDone,
} from '../sse-formatter';
import type { VercelDSPStreamPart } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an async iterable from an array of parts */
async function* asyncParts(parts: VercelDSPStreamPart[]): AsyncIterable<VercelDSPStreamPart> {
  for (const p of parts) {
    yield p;
  }
}

/** Create a failing async iterable that yields some parts then throws */
async function* failingAsyncParts(
  parts: VercelDSPStreamPart[],
  error: Error
): AsyncIterable<VercelDSPStreamPart> {
  for (const p of parts) {
    yield p;
  }
  throw error;
}

/** Collect all chunks from a ReadableStream */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE Formatter (Extended)', () => {
  // -----------------------------------------------------------------------
  // formatSSEKeepalive
  // -----------------------------------------------------------------------
  describe('formatSSEKeepalive', () => {
    it('should return SSE comment keepalive line', () => {
      const result = formatSSEKeepalive();
      expect(result).toBe(': keepalive\n\n');
    });

    it('should start with colon (SSE comment marker)', () => {
      const result = formatSSEKeepalive();
      expect(result.startsWith(':')).toBe(true);
    });

    it('should end with double newline', () => {
      const result = formatSSEKeepalive();
      expect(result.endsWith('\n\n')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // createSSEResponseStream
  // -----------------------------------------------------------------------
  describe('createSSEResponseStream', () => {
    it('should set headers via writeHead when available', () => {
      const writeHeadMock = mock(() => {});
      const writeMock = mock(() => true);
      const endMock = mock(() => {});

      const res = {
        writeHead: writeHeadMock,
        write: writeMock,
        end: endMock,
      };

      createSSEResponseStream(res);

      expect(writeHeadMock).toHaveBeenCalledTimes(1);
      expect(writeHeadMock).toHaveBeenCalledWith(200, VERCEL_DSP_HEADERS);
    });

    it('should set headers via setHeader when no writeHead', () => {
      const setHeaderMock = mock(() => {});
      const writeMock = mock(() => true);
      const endMock = mock(() => {});

      const res = {
        setHeader: setHeaderMock,
        write: writeMock,
        end: endMock,
      };

      createSSEResponseStream(res);

      // Should be called once per header
      expect(setHeaderMock).toHaveBeenCalledTimes(Object.keys(VERCEL_DSP_HEADERS).length);
      expect(setHeaderMock).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform');
      expect(setHeaderMock).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(setHeaderMock).toHaveBeenCalledWith('x-vercel-ai-ui-message-stream', 'v1');
    });

    it('should return an SSEStreamWriter that writes to the response', async () => {
      const chunks: string[] = [];
      const writeMock = mock((chunk: string) => {
        chunks.push(chunk);
        return true;
      });
      const endMock = mock(() => {});

      const res = {
        writeHead: mock(() => {}),
        write: writeMock,
        end: endMock,
      };

      const writer = createSSEResponseStream(res);
      expect(writer).toBeInstanceOf(SSEStreamWriter);

      const part: VercelDSPStreamPart = { type: 'start', messageId: 'msg_1' };
      await writer.write(part);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('"type":"start"');
      expect(chunks[0]).toContain('"messageId":"msg_1"');
    });

    it('should close the stream with [DONE]', async () => {
      const chunks: string[] = [];
      const writeMock = mock((chunk: string) => {
        chunks.push(chunk);
        return true;
      });
      const endMock = mock(() => {});

      const res = {
        writeHead: mock(() => {}),
        write: writeMock,
        end: endMock,
      };

      const writer = createSSEResponseStream(res);
      await writer.write({ type: 'start', messageId: 'msg_1' });
      await writer.close();

      // Last written chunk should be [DONE]
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk).toBe('data: [DONE]\n\n');
    });

    it('should handle response without once method', async () => {
      const chunks: string[] = [];
      const res = {
        writeHead: mock(() => {}),
        write: mock((chunk: string) => {
          chunks.push(chunk);
          return true;
        }),
        end: mock(() => {}),
        // No 'once' method
      };

      const writer = createSSEResponseStream(res);
      await writer.write({ type: 'text-delta', id: 'b1', delta: 'hi' });

      expect(chunks).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // createSSEReadableStream
  // -----------------------------------------------------------------------
  describe('createSSEReadableStream', () => {
    it('should create a ReadableStream from an async iterable', async () => {
      const parts: VercelDSPStreamPart[] = [
        { type: 'start', messageId: 'msg_1' },
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', delta: 'Hello' },
        { type: 'text-end', id: 'text_1' },
      ];

      const stream = createSSEReadableStream(asyncParts(parts));
      expect(stream).toBeInstanceOf(ReadableStream);

      const output = await readAll(stream);

      // Should contain all parts as SSE data lines
      expect(output).toContain('data: {"type":"start"');
      expect(output).toContain('data: {"type":"text-start"');
      expect(output).toContain('data: {"type":"text-delta"');
      expect(output).toContain('data: {"type":"text-end"');
    });

    it('should send [DONE] after all parts', async () => {
      const parts: VercelDSPStreamPart[] = [
        { type: 'start', messageId: 'msg_1' },
        { type: 'finish', finishReason: 'stop' },
      ];

      const stream = createSSEReadableStream(asyncParts(parts));
      const output = await readAll(stream);

      // Output should end with [DONE]
      expect(output).toContain('data: [DONE]\n\n');
      // [DONE] should be after all other data
      const doneIndex = output.lastIndexOf('data: [DONE]');
      const finishIndex = output.lastIndexOf('"type":"finish"');
      expect(doneIndex).toBeGreaterThan(finishIndex);
    });

    it('should handle empty async iterable', async () => {
      const stream = createSSEReadableStream(asyncParts([]));
      const output = await readAll(stream);

      // Should only contain [DONE]
      expect(output).toBe('data: [DONE]\n\n');
    });

    it('should handle errors by erroring the stream', async () => {
      const parts: VercelDSPStreamPart[] = [{ type: 'start', messageId: 'msg_1' }];
      const testError = new Error('Stream processing failed');

      const stream = createSSEReadableStream(failingAsyncParts(parts, testError));
      const reader = stream.getReader();

      // First read should succeed (the start part)
      const first = await reader.read();
      expect(first.done).toBe(false);

      // Next read should throw the error
      try {
        await reader.read();
        // If no error thrown, that's unexpected
        expect(true).toBe(false); // Force fail
      } catch (err: any) {
        expect(err.message).toBe('Stream processing failed');
      }
    });

    it('should format each part as proper SSE data line', async () => {
      const parts: VercelDSPStreamPart[] = [
        { type: 'text-delta', id: 'b1', delta: 'Hello\nWorld' },
      ];

      const stream = createSSEReadableStream(asyncParts(parts));
      const output = await readAll(stream);

      // Should contain properly formatted SSE
      const lines = output.split('\n\n').filter(Boolean);
      expect(lines[0]).toMatch(/^data: \{.*\}$/);
    });
  });

  // -----------------------------------------------------------------------
  // SSEStreamWriter with Web WritableStreamDefaultWriter
  // -----------------------------------------------------------------------
  describe('SSEStreamWriter with Web WritableStreamDefaultWriter', () => {
    it('should write encoded bytes via Web Streams writer', async () => {
      const writtenChunks: Uint8Array[] = [];

      // Create a real WritableStream to get a proper writer
      const writableStream = new WritableStream<Uint8Array>({
        write(chunk) {
          writtenChunks.push(chunk);
        },
      });

      const webWriter = writableStream.getWriter();
      const sseWriter = new SSEStreamWriter(webWriter);

      const part: VercelDSPStreamPart = { type: 'start', messageId: 'msg_web' };
      await sseWriter.write(part);

      expect(writtenChunks).toHaveLength(1);
      const decoded = new TextDecoder().decode(writtenChunks[0]);
      expect(decoded).toContain('"type":"start"');
      expect(decoded).toContain('"messageId":"msg_web"');
    });

    it('should close the Web Streams writer', async () => {
      const writtenChunks: Uint8Array[] = [];

      const writableStream = new WritableStream<Uint8Array>({
        write(chunk) {
          writtenChunks.push(chunk);
        },
      });

      const webWriter = writableStream.getWriter();
      const sseWriter = new SSEStreamWriter(webWriter);

      await sseWriter.close();

      expect(sseWriter.isClosed()).toBe(true);
      // Should have written [DONE]
      expect(writtenChunks).toHaveLength(1);
      const decoded = new TextDecoder().decode(writtenChunks[0]);
      expect(decoded).toBe('data: [DONE]\n\n');
    });

    it('should handle multiple writes via Web Streams writer', async () => {
      const writtenChunks: Uint8Array[] = [];

      const writableStream = new WritableStream<Uint8Array>({
        write(chunk) {
          writtenChunks.push(chunk);
        },
      });

      const webWriter = writableStream.getWriter();
      const sseWriter = new SSEStreamWriter(webWriter);

      const parts: VercelDSPStreamPart[] = [
        { type: 'start', messageId: 'msg_1' },
        { type: 'text-start', id: 'b1' },
        { type: 'text-delta', id: 'b1', delta: 'hello' },
        { type: 'text-end', id: 'b1' },
      ];

      await sseWriter.writeAll(parts);

      expect(writtenChunks).toHaveLength(4);
    });

    it('should reject writes after close for Web Streams writer', async () => {
      const writableStream = new WritableStream<Uint8Array>({
        write() {},
      });

      const webWriter = writableStream.getWriter();
      const sseWriter = new SSEStreamWriter(webWriter);

      await sseWriter.close();

      await expect(sseWriter.write({ type: 'start', messageId: 'msg_1' })).rejects.toThrow(
        'SSEStreamWriter is closed'
      );
    });
  });
});
