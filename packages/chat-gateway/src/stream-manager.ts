/**
 * AsyncStreamManager
 *
 * In-memory registry of active SSE streams. Each stream is a StreamTee that
 * buffers Vercel DSP parts so reconnecting clients can replay missed content.
 *
 * The background consumer runs independently of HTTP connections — agent
 * generation continues even if the original client disconnects.
 */

import { StreamTee } from '@chimera/sse-bridge';
import type { VercelDSPStreamPart } from '@chimera/sse-bridge';

/** Entry stored per active stream */
export interface StreamRecord {
  tee: StreamTee<VercelDSPStreamPart>;
  createdAt: number;
  tenantId: string;
}

/** How long to retain a completed stream for reconnection (5 minutes) */
const STREAM_TTL_MS = 5 * 60 * 1000;

export class AsyncStreamManager {
  private streams = new Map<string, StreamRecord>();

  /**
   * Create a new stream entry, start consuming the source in the background,
   * and return the tee for immediate use by the HTTP response.
   */
  create(
    messageId: string,
    tenantId: string,
    source: AsyncIterable<VercelDSPStreamPart>
  ): StreamTee<VercelDSPStreamPart> {
    const tee = new StreamTee<VercelDSPStreamPart>();
    this.streams.set(messageId, { tee, createdAt: Date.now(), tenantId });

    // Consume runs in the background. HTTP client may disconnect at any point;
    // consume() continues regardless since it holds no reference to the response.
    tee.consume(source).then(() => {
      setTimeout(() => this.streams.delete(messageId), STREAM_TTL_MS);
    }).catch(() => {
      setTimeout(() => this.streams.delete(messageId), STREAM_TTL_MS);
    });

    return tee;
  }

  /**
   * Retrieve a stream by messageId, scoped to the requesting tenant.
   * Returns undefined if not found or if tenantId does not match.
   */
  getForTenant(messageId: string, tenantId: string): StreamRecord | undefined {
    const record = this.streams.get(messageId);
    if (!record || record.tenantId !== tenantId) return undefined;
    return record;
  }

  /** Number of active (or recently completed) streams */
  get size(): number {
    return this.streams.size;
  }
}

/** Module-level singleton — one manager per process */
export const streamManager = new AsyncStreamManager();
