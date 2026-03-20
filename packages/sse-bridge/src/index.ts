/**
 * @chimera/sse-bridge
 *
 * SSE bridge translating Strands/AgentCore streaming events
 * to Vercel AI SDK Data Stream Protocol (DSP).
 *
 * @example
 * ```typescript
 * import { StrandsToDSPBridge, createSSEResponseStream } from '@chimera/sse-bridge';
 *
 * app.post('/api/chat', async (req, res) => {
 *   const bridge = new StrandsToDSPBridge();
 *   const writer = createSSEResponseStream(res);
 *
 *   for await (const event of strandsAgent.stream(prompt)) {
 *     const parts = bridge.convert(event);
 *     await writer.writeAll(parts);
 *   }
 *
 *   await writer.close();
 * });
 * ```
 */

export * from './types';
export * from './strands-to-dsp';
export * from './sse-formatter';

import { StrandsToDSPConverter } from './strands-to-dsp';
import {
  SSEStreamWriter,
  createSSEResponseStream,
  createSSEReadableStream,
  VERCEL_DSP_HEADERS,
} from './sse-formatter';
import { StrandsStreamEvent, VercelDSPStreamPart } from './types';

/**
 * Complete SSE Bridge
 *
 * High-level interface combining conversion and streaming.
 */
export class StrandsToDSPBridge {
  private converter: StrandsToDSPConverter;

  constructor(messageId?: string) {
    this.converter = new StrandsToDSPConverter(messageId);
  }

  /**
   * Convert a Strands event to Vercel DSP parts
   */
  public convert(event: StrandsStreamEvent): VercelDSPStreamPart[] {
    return this.converter.convert(event);
  }

  /**
   * Stream Strands events to an SSE writer
   */
  public async stream(
    events: AsyncIterable<StrandsStreamEvent> | Iterable<StrandsStreamEvent>,
    writer: SSEStreamWriter
  ): Promise<void> {
    try {
      for await (const event of events) {
        const parts = this.convert(event);
        await writer.writeAll(parts);
      }
      await writer.close();
    } catch (error) {
      if (!writer.isClosed()) {
        await writer.close();
      }
      throw error;
    }
  }

  /**
   * Convert an async iterable of Strands events to a ReadableStream of DSP parts
   */
  public async *convertStream(
    events: AsyncIterable<StrandsStreamEvent> | Iterable<StrandsStreamEvent>
  ): AsyncIterableIterator<VercelDSPStreamPart> {
    for await (const event of events) {
      const parts = this.convert(event);
      for (const part of parts) {
        yield part;
      }
    }
  }

  /**
   * Create a ReadableStream for Web Streams API
   */
  public createReadableStream(
    events: AsyncIterable<StrandsStreamEvent> | Iterable<StrandsStreamEvent>
  ): ReadableStream<Uint8Array> {
    return createSSEReadableStream(this.convertStream(events));
  }

  /**
   * Reset the bridge for a new conversation
   */
  public reset(messageId?: string): void {
    this.converter.reset(messageId);
  }

  /**
   * Get the current message ID
   */
  public getMessageId(): string {
    return this.converter.getMessageId();
  }
}

/**
 * Convenience function for Express-like frameworks
 */
export async function streamStrandsToDSP(
  events: AsyncIterable<StrandsStreamEvent> | Iterable<StrandsStreamEvent>,
  res: {
    writeHead?: (statusCode: number, headers: Record<string, string>) => void;
    setHeader?: (name: string, value: string) => void;
    write: (chunk: Buffer | string) => boolean;
    end: (callback?: () => void) => void;
    once?: (event: string, listener: (...args: any[]) => void) => any;
  },
  messageId?: string
): Promise<void> {
  const bridge = new StrandsToDSPBridge(messageId);
  const writer = createSSEResponseStream(res);
  await bridge.stream(events, writer);
}

// Re-export key components for convenience
export { SSEStreamWriter, createSSEResponseStream, createSSEReadableStream, VERCEL_DSP_HEADERS };
