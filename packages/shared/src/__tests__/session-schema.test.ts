/**
 * Session schema round-trip tests.
 */

import { describe, expect, it } from 'bun:test';
import {
  SessionStatusSchema,
  StreamStatusSchema,
  StreamChunkSchema,
  StreamBufferRecordSchema,
  AgentSessionSchema,
  CreateSessionRequestSchema,
  SessionContextSchema,
} from '../schemas/session';

describe('SessionStatusSchema', () => {
  it('accepts the three canonical statuses', () => {
    for (const s of ['active', 'idle', 'terminated']) {
      expect(SessionStatusSchema.parse(s)).toBe(s);
    }
  });
});

describe('StreamStatusSchema', () => {
  it('rejects unknown stream statuses', () => {
    expect(StreamStatusSchema.safeParse('paused').success).toBe(false);
  });
});

describe('StreamChunkSchema', () => {
  const valid = {
    index: 0,
    type: 'text-delta' as const,
    data: '{"type":"text","text":"hi"}',
    timestamp: '2026-01-01T00:00:00Z',
  };

  it('parses a valid chunk', () => {
    expect(StreamChunkSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a negative index', () => {
    const result = StreamChunkSchema.safeParse({ ...valid, index: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown chunk type', () => {
    const result = StreamChunkSchema.safeParse({ ...valid, type: 'reasoning-delta' });
    expect(result.success).toBe(false);
  });
});

describe('StreamBufferRecordSchema', () => {
  it('parses a minimal valid buffer record', () => {
    const parsed = StreamBufferRecordSchema.parse({
      PK: 'TENANT#t-1',
      SK: 'STREAM#s-1',
      streamId: 's-1',
      sessionId: 'sess-1',
      status: 'completed',
      chunks: [
        {
          index: 0,
          type: 'finish',
          data: '{}',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
      startedAt: '2026-01-01T00:00:00Z',
      ttl: 1767225600,
    });
    expect(parsed.chunks).toHaveLength(1);
  });

  it('rejects a record with a non-array chunks field', () => {
    const result = StreamBufferRecordSchema.safeParse({
      PK: 'TENANT#t-1',
      SK: 'STREAM#s-1',
      streamId: 's-1',
      sessionId: 'sess-1',
      status: 'completed',
      chunks: 'oops',
      startedAt: '2026-01-01T00:00:00Z',
      ttl: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentSessionSchema', () => {
  const valid = {
    PK: 'TENANT#t-1',
    SK: 'SESSION#sess-1',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    userId: 'user-1',
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00Z',
    lastActivity: '2026-01-01T00:00:00Z',
    messageCount: 0,
    tokenUsage: { input: 0, output: 0 },
    context: {},
    ttl: 1767225600,
  };

  it('parses a valid session', () => {
    const parsed = AgentSessionSchema.parse(valid);
    expect(parsed.sessionId).toBe('sess-1');
  });

  it('rejects a session with a negative messageCount', () => {
    const result = AgentSessionSchema.safeParse({ ...valid, messageCount: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects when sessionId is empty', () => {
    const result = AgentSessionSchema.safeParse({ ...valid, sessionId: '' });
    expect(result.success).toBe(false);
  });
});

describe('SessionContextSchema', () => {
  it('passes through unknown context keys (open shape)', () => {
    const parsed = SessionContextSchema.parse({
      workingDirectory: '/tmp',
      someCustomField: 'value',
    });
    // passthrough preserves the extra key
    expect((parsed as Record<string, unknown>).someCustomField).toBe('value');
  });
});

describe('CreateSessionRequestSchema', () => {
  it('rejects an empty tenantId', () => {
    const result = CreateSessionRequestSchema.safeParse({
      tenantId: '',
      agentId: 'a',
      userId: 'u',
    });
    expect(result.success).toBe(false);
  });
});
