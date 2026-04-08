import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authFetch, apiGet, apiPost } from '../lib/api-client';

// Mock Amplify auth
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
    tokens: {
      idToken: {
        toString: () => 'mock-id-token',
        payload: {},
      },
    },
  } as Awaited<ReturnType<typeof fetchAuthSession>>);
});

describe('authFetch', () => {
  it('adds Authorization header with id token', async () => {
    const mockResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    await authFetch('/test');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.test.com/test');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer mock-id-token');
  });

  it('throws when not authenticated', async () => {
    mockFetchAuthSession.mockResolvedValue({
      tokens: undefined,
    } as Awaited<ReturnType<typeof fetchAuthSession>>);

    await expect(authFetch('/test')).rejects.toThrow('Not authenticated');
  });

  it('merges caller-provided headers', async () => {
    const mockResponse = new Response('{}', { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    await authFetch('/test', { headers: { 'X-Custom': 'value' } });

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer mock-id-token');
    expect(headers['X-Custom']).toBe('value');
  });
});

describe('apiGet', () => {
  it('returns parsed JSON on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [1, 2] }), { status: 200 })
    );
    const result = await apiGet<{ items: number[] }>('/items');
    expect(result.items).toEqual([1, 2]);
  });

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not found', { status: 404, statusText: 'Not Found' })
    );
    await expect(apiGet('/missing')).rejects.toThrow('API error 404');
  });
});

describe('apiPost', () => {
  it('sends body as JSON', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ created: true }), { status: 200 }));

    await apiPost('/items', { name: 'test' });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ name: 'test' }));
  });
});
