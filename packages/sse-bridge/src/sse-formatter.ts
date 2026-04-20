/**
 * SSE Formatter
 *
 * Formats Vercel DSP stream parts into Server-Sent Events (SSE) format
 * for HTTP streaming responses.
 */

import { VercelDSPStreamPart } from './types';

/**
 * Headers required for Vercel AI SDK Data Stream Protocol
 */
export const VERCEL_DSP_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
} as const;

/**
 * Format a Vercel DSP part as an SSE data line
 */
export function formatSSEData(part: VercelDSPStreamPart): string {
  const jsonData = JSON.stringify(part);
  return `data: ${jsonData}\n\n`;
}

/**
 * Format the SSE stream terminator
 */
export function formatSSEDone(): string {
  return 'data: [DONE]\n\n';
}

/**
 * Format an SSE keepalive comment.
 *
 * SSE comments (lines starting with ':') are sent to prevent proxy/load-balancer
 * timeouts on long-running streams. They are ignored by browsers and Vercel AI SDK.
 */
export function formatSSEKeepalive(): string {
  return ': keepalive\n\n';
}

/**
 * SSE Stream Writer
 *
 * Wraps a WritableStream or Node.js response object to write SSE events.
 */
export class SSEStreamWriter {
  private encoder = new TextEncoder();
  private closed = false;

  /**
   * Create a writer for a WritableStream (Web Streams API)
   */
  constructor(private writer: WritableStreamDefaultWriter<Uint8Array> | NodeJSWriteableStream) {}

  /**
   * Write a Vercel DSP part as an SSE event
   */
  public async write(part: VercelDSPStreamPart): Promise<void> {
    if (this.closed) {
      throw new Error('SSEStreamWriter is closed');
    }

    const sseData = formatSSEData(part);
    await this.writeRaw(sseData);
  }

  /**
   * Write multiple parts in sequence
   */
  public async writeAll(parts: VercelDSPStreamPart[]): Promise<void> {
    for (const part of parts) {
      await this.write(part);
    }
  }

  /**
   * Write the stream terminator and close
   */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    await this.writeRaw(formatSSEDone());
    this.closed = true;

    // Close the underlying writer if it's a WritableStreamDefaultWriter
    if ('close' in this.writer && typeof this.writer.close === 'function') {
      await this.writer.close();
    }
  }

  /**
   * Write raw string data to the stream
   */
  private async writeRaw(data: string): Promise<void> {
    // Check if it's a WritableStreamDefaultWriter
    if ('desiredSize' in this.writer && 'ready' in this.writer) {
      // Web Streams API WritableStreamDefaultWriter
      const bytes = this.encoder.encode(data);
      await (this.writer as WritableStreamDefaultWriter<Uint8Array>).write(bytes);
    } else {
      // Node.js stream - write as string or Buffer
      const stream = this.writer as NodeJSWriteableStream;
      return new Promise((resolve, reject) => {
        if (!stream.write(data)) {
          stream.once('drain', resolve);
        } else {
          resolve();
        }
        stream.once('error', reject);
      });
    }
  }

  /**
   * Check if the writer is closed
   */
  public isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Node.js stream interface for compatibility
 */
interface NodeJSWriteableStream {
  write(chunk: Buffer | string, callback?: (error: Error | null | undefined) => void): boolean;
  once(event: 'drain' | 'error', listener: (...args: any[]) => void): this;
  end(callback?: () => void): this;
}

/**
 * Create an SSE response stream for Express/Fastify/etc.
 *
 * Usage with Express:
 * ```
 * app.get('/stream', (req, res) => {
 *   const writer = createSSEResponseStream(res);
 *   // ... write parts
 *   await writer.close();
 * });
 * ```
 */
export function createSSEResponseStream(res: {
  writeHead?: (statusCode: number, headers: Record<string, string>) => void;
  setHeader?: (name: string, value: string) => void;
  write: (chunk: Buffer | string) => boolean;
  end: (callback?: () => void) => void;
  once?: (event: string, listener: (...args: any[]) => void) => any;
}): SSEStreamWriter {
  // Set headers
  if (res.writeHead) {
    res.writeHead(200, VERCEL_DSP_HEADERS);
  } else if (res.setHeader) {
    Object.entries(VERCEL_DSP_HEADERS).forEach(([key, value]) => {
      res.setHeader!(key, value);
    });
  }

  // Create writer wrapper
  const nodeStream: NodeJSWriteableStream = {
    write: (chunk: Buffer | string, callback?: (error: Error | null | undefined) => void) => {
      const result = res.write(chunk);
      if (callback) callback(null);
      return result;
    },
    once: (event: 'drain' | 'error', listener: (...args: any[]) => void) => {
      if (res.once) {
        res.once(event, listener);
      }
      return nodeStream as any;
    },
    end: (callback?: () => void) => {
      res.end(callback);
      return nodeStream as any;
    },
  };

  return new SSEStreamWriter(nodeStream);
}

/**
 * Options for {@link createSSEReadableStream}.
 */
export interface SSEReadableStreamOptions {
  /**
   * Interval in milliseconds at which to emit SSE keepalive comments.
   * Prevents idle-connection timeouts at proxies/load-balancers.
   * Omit or set to 0 to disable heartbeats.
   */
  heartbeatIntervalMs?: number;
  /**
   * Abort signal from the HTTP request. When fired, the stream is cancelled,
   * the heartbeat is cleared, and no further writes occur. The source iterable
   * is NOT explicitly cancelled here — callers that want to cancel upstream
   * work should handle that in their own abort listener.
   */
  signal?: AbortSignal;
  /**
   * Maximum time (ms) to wait for the stream to drain before treating the
   * consumer as dead and aborting. Defaults to 5000.
   */
  drainTimeoutMs?: number;
}

/**
 * Create a ReadableStream for Web Streams API
 *
 * Usage with Fetch API / Next.js:
 * ```
 * return new Response(createSSEReadableStream(strandsEvents), {
 *   headers: VERCEL_DSP_HEADERS
 * });
 * ```
 *
 * With heartbeat + abort:
 * ```
 * return new Response(createSSEReadableStream(events, {
 *   heartbeatIntervalMs: 15_000,
 *   signal: req.signal,
 * }), { headers: VERCEL_DSP_HEADERS });
 * ```
 */
export function createSSEReadableStream(
  source: AsyncIterable<VercelDSPStreamPart> | Iterable<VercelDSPStreamPart>,
  options: SSEReadableStreamOptions = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { heartbeatIntervalMs, signal, drainTimeoutMs = 5000 } = options;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let aborted = false;

  return new ReadableStream({
    async start(controller) {
      const enqueue = (text: string): boolean => {
        if (aborted) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          // Controller is already closed/errored
          aborted = true;
          return false;
        }
      };

      const cleanup = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };

      // Wire abort signal — on client disconnect, stop writing and cleanup.
      if (signal) {
        if (signal.aborted) {
          aborted = true;
          cleanup();
          try {
            controller.close();
          } catch {
            // ignore
          }
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            cleanup();
            try {
              controller.close();
            } catch {
              // ignore — already closed
            }
          },
          { once: true }
        );
      }

      // Start heartbeat pings (SSE comments are ignored by browsers but keep
      // proxies from timing out idle connections).
      if (heartbeatIntervalMs && heartbeatIntervalMs > 0) {
        heartbeatTimer = setInterval(() => {
          enqueue(formatSSEKeepalive());
        }, heartbeatIntervalMs);
      }

      try {
        for await (const part of source) {
          if (aborted) break;
          const sseData = formatSSEData(part);
          if (!enqueue(sseData)) break;

          // Backpressure: if consumer isn't keeping up, wait for buffer to drain.
          // If drain takes longer than drainTimeoutMs, abort the stream.
          if ((controller.desiredSize ?? 1) <= 0) {
            const drained = await waitForDrain(controller, drainTimeoutMs);
            if (!drained) {
              aborted = true;
              break;
            }
            if (aborted) break;
          }
        }

        if (!aborted) {
          enqueue(formatSSEDone());
        }
        cleanup();
        try {
          controller.close();
        } catch {
          // ignore
        }
      } catch (error) {
        cleanup();
        try {
          controller.error(error);
        } catch {
          // ignore
        }
      }
    },
    cancel() {
      aborted = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    },
  });
}

/**
 * Wait for a ReadableStream controller's buffer to drain below its high
 * watermark. Polls `desiredSize` at 25ms intervals up to `timeoutMs`.
 * Returns true if drained, false if timed out.
 */
async function waitForDrain(
  controller: ReadableStreamDefaultController<Uint8Array>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if ((controller.desiredSize ?? 1) > 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}
