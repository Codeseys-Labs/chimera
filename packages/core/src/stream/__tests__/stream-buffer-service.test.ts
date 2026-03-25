/**
 * StreamBufferService tests
 *
 * Covers the full async-completion lifecycle:
 *   startStream → appendChunk → completeStream/failStream → getBuffer → clearBuffer
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { StreamBufferService } from '../stream-buffer-service';
import type { StreamBufferServiceConfig, DynamoDBClient } from '../stream-buffer-service';
import type { StreamBufferRecord } from '@chimera/shared';

// ---------------------------------------------------------------------------
// Mock DynamoDB client
// ---------------------------------------------------------------------------

class MockDynamoDBClient implements DynamoDBClient {
  readonly store = new Map<string, any>();

  private key(pk: string, sk: string) {
    return `${pk}#${sk}`;
  }

  async get(params: any) {
    const k = this.key(params.Key.PK, params.Key.SK);
    return { Item: this.store.get(k) };
  }

  async put(params: any) {
    const k = this.key(params.Item.PK, params.Item.SK);
    this.store.set(k, { ...params.Item });
    return {};
  }

  async update(params: any) {
    const k = this.key(params.Key.PK, params.Key.SK);
    let item = this.store.get(k) ?? { PK: params.Key.PK, SK: params.Key.SK };
    item = { ...item };

    // Parse SET expressions by extracting attribute-name → value mappings
    const names: Record<string, string> = params.ExpressionAttributeNames ?? {};
    const vals: Record<string, any> = params.ExpressionAttributeValues ?? {};

    // Resolve expression attribute names (e.g. #status → status)
    const resolve = (token: string) => names[token] ?? token;

    // Very small expression parser — handles comma-separated "field = :val" pairs
    if (params.UpdateExpression?.startsWith('SET ')) {
      const assignments = params.UpdateExpression
        .slice(4)
        .split(',')
        .map((s: string) => s.trim());

      for (const assign of assignments) {
        const eqIdx = assign.indexOf('=');
        if (eqIdx === -1) continue;
        const lhs = assign.slice(0, eqIdx).trim();
        const rhs = assign.slice(eqIdx + 1).trim();
        const fieldName = resolve(lhs);
        item[fieldName] = vals[rhs];
      }
    }

    this.store.set(k, item);
    return { Attributes: item };
  }

  async delete(params: any) {
    const k = this.key(params.Key.PK, params.Key.SK);
    this.store.delete(k);
    return {};
  }

  reset() {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TABLE = 'test-sessions';
const TENANT = 'tenant-abc';
const SESSION = 'session-123';
const STREAM = 'stream-xyz';

function makeService(
  db: MockDynamoDBClient,
  overrides: Partial<StreamBufferServiceConfig> = {}
): StreamBufferService {
  return new StreamBufferService({
    sessionsTableName: TABLE,
    dynamodb: db,
    ...overrides,
  });
}

function streamKey() {
  return `TENANT#${TENANT}#STREAM#${STREAM}`;
}

function sessionKey() {
  return `TENANT#${TENANT}#SESSION#${SESSION}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamBufferService', () => {
  let db: MockDynamoDBClient;
  let svc: StreamBufferService;

  beforeEach(() => {
    db = new MockDynamoDBClient();
    svc = makeService(db);
  });

  // -------------------------------------------------------------------------
  describe('startStream', () => {
    it('creates a streaming record in DDB', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);

      const record = db.store.get(streamKey()) as StreamBufferRecord;
      expect(record).toBeDefined();
      expect(record.streamId).toBe(STREAM);
      expect(record.sessionId).toBe(SESSION);
      expect(record.status).toBe('streaming');
      expect(record.chunks).toHaveLength(0);
      expect(record.startedAt).toBeTruthy();
      expect(typeof record.ttl).toBe('number');
    });

    it('sets activeStreamId on the session record', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);

      const session = db.store.get(sessionKey());
      expect(session?.activeStreamId).toBe(STREAM);
      expect(session?.streamStatus).toBe('streaming');
    });

    it('initialises the in-memory buffer', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      expect(svc.getInMemoryChunkCount(STREAM)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('appendChunk', () => {
    it('accumulates chunks in memory without writing to DDB', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);

      svc.appendChunk(STREAM, 'text-delta', JSON.stringify({ textDelta: 'Hello' }));
      svc.appendChunk(STREAM, 'text-delta', JSON.stringify({ textDelta: ' world' }));

      expect(svc.getInMemoryChunkCount(STREAM)).toBe(2);

      // DDB stream record must still have empty chunks until completion
      const record = db.store.get(streamKey()) as StreamBufferRecord;
      expect(record.chunks).toHaveLength(0);
    });

    it('assigns sequential indices to chunks', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);

      svc.appendChunk(STREAM, 'text-delta', 'a');
      svc.appendChunk(STREAM, 'tool-call', 'b');
      svc.appendChunk(STREAM, 'tool-result', 'c');

      // Peek via completeStream then getBuffer
      await svc.completeStream(TENANT, STREAM);
      const record = await svc.getBuffer(TENANT, STREAM);

      expect(record!.chunks[0].index).toBe(0);
      expect(record!.chunks[1].index).toBe(1);
      expect(record!.chunks[2].index).toBe(2);
    });

    it('silently ignores unknown streamId', () => {
      expect(() => svc.appendChunk('unknown', 'text-delta', 'x')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('completeStream', () => {
    it('flushes in-memory chunks to DDB and sets status=completed', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      svc.appendChunk(STREAM, 'text-delta', JSON.stringify({ textDelta: 'Hi' }));
      svc.appendChunk(STREAM, 'finish', JSON.stringify({ finishReason: 'stop' }));

      await svc.completeStream(TENANT, STREAM);

      const record = db.store.get(streamKey()) as StreamBufferRecord;
      expect(record.status).toBe('completed');
      expect(record.chunks).toHaveLength(2);
      expect(record.chunks[0].type).toBe('text-delta');
      expect(record.chunks[1].type).toBe('finish');
      expect(record.completedAt).toBeTruthy();
    });

    it('sets isDisconnect=true when client disconnected', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      await svc.completeStream(TENANT, STREAM, true);

      const record = db.store.get(streamKey()) as StreamBufferRecord;
      expect(record.isDisconnect).toBe(true);
    });

    it('does not set isDisconnect when client stayed connected', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      await svc.completeStream(TENANT, STREAM, false);

      const record = db.store.get(streamKey()) as StreamBufferRecord;
      expect(record.isDisconnect).toBeUndefined();
    });

    it('updates session streamStatus to completed', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      await svc.completeStream(TENANT, STREAM);

      const session = db.store.get(sessionKey());
      expect(session?.streamStatus).toBe('completed');
    });

    it('clears the in-memory buffer after flush', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      svc.appendChunk(STREAM, 'text-delta', 'x');
      await svc.completeStream(TENANT, STREAM);

      expect(svc.getInMemoryChunkCount(STREAM)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('failStream', () => {
    it('sets status=failed with error message', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      svc.appendChunk(STREAM, 'text-delta', 'partial');
      await svc.failStream(TENANT, STREAM, 'Bedrock throttling');

      const record = db.store.get(streamKey()) as StreamBufferRecord;
      expect(record.status).toBe('failed');
      expect(record.error).toBe('Bedrock throttling');
      expect(record.completedAt).toBeTruthy();
    });

    it('preserves partially accumulated chunks in DDB', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      svc.appendChunk(STREAM, 'text-delta', 'partial response');
      await svc.failStream(TENANT, STREAM, 'timeout');

      const record = db.store.get(streamKey()) as StreamBufferRecord;
      expect(record.chunks).toHaveLength(1);
      expect(record.chunks[0].data).toBe('partial response');
    });

    it('updates session streamStatus to failed', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      await svc.failStream(TENANT, STREAM, 'err');

      const session = db.store.get(sessionKey());
      expect(session?.streamStatus).toBe('failed');
    });
  });

  // -------------------------------------------------------------------------
  describe('getBuffer', () => {
    it('returns the stream record after completion', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      svc.appendChunk(STREAM, 'text-delta', 'hello');
      await svc.completeStream(TENANT, STREAM, true);

      const record = await svc.getBuffer(TENANT, STREAM);
      expect(record).not.toBeNull();
      expect(record!.streamId).toBe(STREAM);
      expect(record!.status).toBe('completed');
      expect(record!.isDisconnect).toBe(true);
      expect(record!.chunks).toHaveLength(1);
    });

    it('returns null for unknown streamId', async () => {
      const record = await svc.getBuffer(TENANT, 'nonexistent');
      expect(record).toBeNull();
    });

    it('returns streaming record before completion', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      const record = await svc.getBuffer(TENANT, STREAM);
      expect(record!.status).toBe('streaming');
    });
  });

  // -------------------------------------------------------------------------
  describe('clearBuffer', () => {
    it('removes the stream record from DDB', async () => {
      await svc.startStream(TENANT, SESSION, STREAM);
      await svc.completeStream(TENANT, STREAM);

      await svc.clearBuffer(TENANT, STREAM);

      const record = await svc.getBuffer(TENANT, STREAM);
      expect(record).toBeNull();
    });

    it('is idempotent — does not throw if already cleared', async () => {
      await expect(svc.clearBuffer(TENANT, 'already-gone')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('TTL', () => {
    it('uses default 1-hour TTL', async () => {
      const before = Math.floor(Date.now() / 1000);
      await svc.startStream(TENANT, SESSION, STREAM);
      const after = Math.floor(Date.now() / 1000);

      const record = db.store.get(streamKey()) as StreamBufferRecord;
      expect(record.ttl).toBeGreaterThanOrEqual(before + 3600);
      expect(record.ttl).toBeLessThanOrEqual(after + 3600);
    });

    it('respects custom bufferTtlSeconds', async () => {
      db = new MockDynamoDBClient();
      svc = makeService(db, { bufferTtlSeconds: 300 });

      const before = Math.floor(Date.now() / 1000);
      await svc.startStream(TENANT, SESSION, STREAM);
      const after = Math.floor(Date.now() / 1000);

      const record = db.store.get(streamKey()) as StreamBufferRecord;
      expect(record.ttl).toBeGreaterThanOrEqual(before + 300);
      expect(record.ttl).toBeLessThanOrEqual(after + 300);
    });
  });

  // -------------------------------------------------------------------------
  describe('reconnection scenario', () => {
    it('full disconnect → reconnect flow works end-to-end', async () => {
      // 1. Stream starts
      await svc.startStream(TENANT, SESSION, STREAM);

      // 2. LLM produces tokens
      svc.appendChunk(STREAM, 'step-start', '{}');
      svc.appendChunk(STREAM, 'text-delta', JSON.stringify({ textDelta: 'The answer is 42' }));
      svc.appendChunk(STREAM, 'finish', JSON.stringify({ finishReason: 'stop' }));

      // 3. Client disconnects — onFinish fires with isDisconnect=true
      await svc.completeStream(TENANT, STREAM, true);

      // 4. Client reconnects — reads the buffer
      const record = await svc.getBuffer(TENANT, STREAM);
      expect(record).not.toBeNull();
      expect(record!.status).toBe('completed');
      expect(record!.isDisconnect).toBe(true);
      expect(record!.chunks).toHaveLength(3);
      expect(record!.chunks[1].data).toContain('42');

      // 5. After replay, clear the buffer
      await svc.clearBuffer(TENANT, STREAM);
      const cleared = await svc.getBuffer(TENANT, STREAM);
      expect(cleared).toBeNull();
    });
  });
});
