import { describe, it, expect, vi, beforeEach } from 'vitest';
import { streamChatResponse } from '../lib/sse-client';

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn(),
}));

// Set env for API base URL (bun:test compat — vi.stubEnv is Vitest-only)
process.env.VITE_API_BASE_URL = 'https://api.test.com';

import { fetchAuthSession } from 'aws-amplify/auth';

const mockFetchAuthSession = fetchAuthSession as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  mockFetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => 'tok', payload: {} } },
  } as Awaited<ReturnType<typeof fetchAuthSession>>);
});

function makeStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'));
      }
      controller.close();
    },
  });
}

describe('streamChatResponse', () => {
  it('accumulates tokens and calls onComplete with full content', async () => {
    const sseLines = ['data: text:"Hello"', 'data: text:", World"', 'data: message_stop:null'];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(makeStream(sseLines), { status: 200 })
    );

    const tokens: string[] = [];
    let completed = '';

    await new Promise<void>((resolve) => {
      streamChatResponse([{ role: 'user', content: 'hi' }], 'tenant-1', null, {
        onToken: (t) => tokens.push(t),
        onComplete: (full) => {
          completed = full;
          resolve();
        },
        onError: (e) => {
          throw e;
        },
      });
    });

    expect(tokens).toEqual(['Hello', ', World']);
    expect(completed).toBe('Hello, World');
  });

  it('calls onSessionId when message_start event fires', async () => {
    const sseLines = ['data: message_start:{"sessionId":"sess-123"}', 'data: text:"hi"'];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(makeStream(sseLines), { status: 200 })
    );

    let capturedSessionId = '';

    await new Promise<void>((resolve) => {
      streamChatResponse([{ role: 'user', content: 'hey' }], 'tenant-1', null, {
        onToken: () => {},
        onComplete: () => resolve(),
        onError: (e) => {
          throw e;
        },
        onSessionId: (id) => {
          capturedSessionId = id;
        },
      });
    });

    expect(capturedSessionId).toBe('sess-123');
  });

  it('calls onError on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Error', { status: 500, statusText: 'Internal Server Error' })
    );

    await new Promise<void>((resolve) => {
      streamChatResponse([{ role: 'user', content: 'test' }], 'tenant-1', null, {
        onToken: () => {},
        onComplete: () => {},
        onError: (err) => {
          expect(err.message).toContain('500');
          resolve();
        },
      });
    });
  });

  it('returns AbortController that cancels the stream', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    const controller = streamChatResponse([{ role: 'user', content: 'test' }], 'tenant-1', null, {
      onToken: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    expect(controller).toBeInstanceOf(AbortController);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});
