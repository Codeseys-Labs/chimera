/**
 * Stream Buffer Service
 *
 * DynamoDB-backed buffer for async message completion.
 *
 * Implements the async completion pattern:
 * - consumeStream() decouples LLM generation from the HTTP response lifetime
 * - Agent finishes even when the client disconnects mid-stream
 * - Completed stream is stored in DynamoDB for client reconnection
 *
 * Hybrid approach:
 *   1. Chunks accumulate in an in-memory buffer (fast, no DDB writes per token)
 *   2. On stream completion the entire buffer is flushed to DDB atomically
 *   3. Reconnecting clients read the persisted buffer from DDB
 */

import type {
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
  DeleteCommandInput,
  DeleteCommandOutput,
} from '@aws-sdk/lib-dynamodb';

import type { StreamChunk, StreamBufferRecord, StreamStatus } from '@chimera/shared';

// Re-export for consumers of this module
export type { StreamChunk, StreamBufferRecord, StreamStatus };

/**
 * Minimal DynamoDB client interface for stream buffer operations
 */
export interface DynamoDBClient {
  get(params: GetCommandInput): Promise<GetCommandOutput>;
  put(params: PutCommandInput): Promise<PutCommandOutput>;
  update(params: UpdateCommandInput): Promise<UpdateCommandOutput>;
  delete(params: DeleteCommandInput): Promise<DeleteCommandOutput>;
}

/**
 * Stream buffer service configuration
 */
export interface StreamBufferServiceConfig {
  /** DynamoDB table name (chimera-sessions table) */
  sessionsTableName: string;

  /** DynamoDB client */
  dynamodb: DynamoDBClient;

  /**
   * TTL in seconds applied after stream completion.
   * Defaults to 3600 (1 hour) — long enough for reconnection, short enough to save storage.
   */
  bufferTtlSeconds?: number;
}

/**
 * Internal in-memory state for an active stream
 */
interface ActiveStreamState {
  tenantId: string;
  sessionId: string;
  chunks: StreamChunk[];
  nextIndex: number;
}

/**
 * Stream Buffer Service
 *
 * Usage:
 * ```ts
 * const svc = new StreamBufferService({ sessionsTableName, dynamodb });
 *
 * // When a chat request starts:
 * await svc.startStream(tenantId, sessionId, streamId);
 *
 * // For each LLM token/event (synchronous — no await needed):
 * svc.appendChunk(streamId, 'text-delta', JSON.stringify({ textDelta: token }));
 *
 * // When generation finishes (onFinish callback):
 * await svc.completeStream(tenantId, streamId, isDisconnect);
 *
 * // On client reconnect (GET /api/chat/:id/stream):
 * const record = await svc.getBuffer(tenantId, streamId);
 * // … replay record.chunks to the new HTTP response …
 * await svc.clearBuffer(tenantId, streamId);
 * ```
 */
export class StreamBufferService {
  private config: StreamBufferServiceConfig;
  private readonly ttlSeconds: number;

  /** In-memory buffers keyed by streamId */
  private readonly activeStreams = new Map<string, ActiveStreamState>();

  constructor(config: StreamBufferServiceConfig) {
    this.config = config;
    this.ttlSeconds = config.bufferTtlSeconds ?? 3600;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Initialise a new stream buffer.
   *
   * Creates a DynamoDB record with status=streaming so that the existence of
   * a stream can be checked before the LLM finishes.  Also allocates the
   * in-memory buffer for chunk accumulation.
   */
  async startStream(tenantId: string, sessionId: string, streamId: string): Promise<void> {
    const now = new Date().toISOString();

    // Allocate in-memory buffer
    this.activeStreams.set(streamId, {
      tenantId,
      sessionId,
      chunks: [],
      nextIndex: 0,
    });

    const record: StreamBufferRecord = {
      PK: `TENANT#${tenantId}`,
      SK: `STREAM#${streamId}`,
      streamId,
      sessionId,
      status: 'streaming',
      chunks: [],
      startedAt: now,
      ttl: this.computeTtl(),
    };

    await this.config.dynamodb.put({
      TableName: this.config.sessionsTableName,
      Item: record,
    });

    // Update session's activeStreamId
    await this.config.dynamodb.update({
      TableName: this.config.sessionsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `SESSION#${sessionId}`,
      },
      UpdateExpression: 'SET activeStreamId = :sid, streamStatus = :status',
      ExpressionAttributeValues: {
        ':sid': streamId,
        ':status': 'streaming' as StreamStatus,
      },
    });
  }

  /**
   * Append a chunk to the in-memory buffer.
   *
   * Synchronous — no I/O.  Call this for every event emitted by the LLM
   * (text deltas, tool calls, etc.).  The buffer is persisted to DDB only
   * when `completeStream` or `failStream` is called.
   */
  appendChunk(streamId: string, type: StreamChunk['type'], data: string): void {
    const state = this.activeStreams.get(streamId);
    if (!state) {
      return; // Stream was never started or already cleaned up — safe to ignore
    }

    state.chunks.push({
      index: state.nextIndex++,
      type,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Mark a stream as successfully completed and flush the buffer to DynamoDB.
   *
   * Call this from the `onFinish` callback of `consumeStream`.
   * The `isDisconnect` flag comes directly from the Vercel AI SDK callback.
   */
  async completeStream(tenantId: string, streamId: string, isDisconnect = false): Promise<void> {
    const state = this.activeStreams.get(streamId);
    const now = new Date().toISOString();
    const ttl = this.computeTtl();

    const updateExpr = isDisconnect
      ? 'SET #status = :status, chunks = :chunks, completedAt = :now, isDisconnect = :disc, #ttl = :ttl'
      : 'SET #status = :status, chunks = :chunks, completedAt = :now, #ttl = :ttl';

    const expressionValues: Record<string, unknown> = {
      ':status': 'completed' as StreamStatus,
      ':chunks': state?.chunks ?? [],
      ':now': now,
      ':ttl': ttl,
    };

    if (isDisconnect) {
      expressionValues[':disc'] = true;
    }

    await this.config.dynamodb.update({
      TableName: this.config.sessionsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `STREAM#${streamId}`,
      },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: {
        '#status': 'status',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: expressionValues as Record<string, any>,
    });

    // Update session streamStatus
    if (state) {
      await this.config.dynamodb.update({
        TableName: this.config.sessionsTableName,
        Key: {
          PK: `TENANT#${state.tenantId}`,
          SK: `SESSION#${state.sessionId}`,
        },
        UpdateExpression: 'SET streamStatus = :status',
        ExpressionAttributeValues: {
          ':status': 'completed' as StreamStatus,
        },
      });
    }

    this.activeStreams.delete(streamId);
  }

  /**
   * Mark a stream as failed and record the error in DynamoDB.
   */
  async failStream(tenantId: string, streamId: string, error: string): Promise<void> {
    const state = this.activeStreams.get(streamId);
    const now = new Date().toISOString();
    const ttl = this.computeTtl();

    await this.config.dynamodb.update({
      TableName: this.config.sessionsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `STREAM#${streamId}`,
      },
      UpdateExpression:
        'SET #status = :status, chunks = :chunks, completedAt = :now, #error = :error, #ttl = :ttl',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#error': 'error',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':status': 'failed' as StreamStatus,
        ':chunks': state?.chunks ?? [],
        ':now': now,
        ':error': error,
        ':ttl': ttl,
      },
    });

    // Update session streamStatus
    if (state) {
      await this.config.dynamodb.update({
        TableName: this.config.sessionsTableName,
        Key: {
          PK: `TENANT#${state.tenantId}`,
          SK: `SESSION#${state.sessionId}`,
        },
        UpdateExpression: 'SET streamStatus = :status',
        ExpressionAttributeValues: {
          ':status': 'failed' as StreamStatus,
        },
      });
    }

    this.activeStreams.delete(streamId);
  }

  /**
   * Retrieve a completed stream buffer from DynamoDB.
   *
   * Returns null if the stream has not been started, or if it has already
   * been cleared after a successful reconnection.
   */
  async getBuffer(tenantId: string, streamId: string): Promise<StreamBufferRecord | null> {
    const result = await this.config.dynamodb.get({
      TableName: this.config.sessionsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `STREAM#${streamId}`,
      },
    });

    return (result.Item as StreamBufferRecord) ?? null;
  }

  /**
   * Delete the stream buffer record after a successful reconnection replay.
   *
   * The client has consumed all buffered chunks, so storage can be reclaimed
   * immediately rather than waiting for the TTL to expire.
   */
  async clearBuffer(tenantId: string, streamId: string): Promise<void> {
    await this.config.dynamodb.delete({
      TableName: this.config.sessionsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `STREAM#${streamId}`,
      },
    });
  }

  /**
   * Number of chunks currently held in the in-memory buffer for a stream.
   * Useful for health checks and tests.
   */
  getInMemoryChunkCount(streamId: string): number {
    return this.activeStreams.get(streamId)?.chunks.length ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private computeTtl(): number {
    return Math.floor(Date.now() / 1000) + this.ttlSeconds;
  }
}
