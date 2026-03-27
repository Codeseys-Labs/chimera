/**
 * Tests for packages/cli/src/lib/api-client.ts
 *
 * Verifies:
 * - Auth header is set from credentials file
 * - Base URL is read from workspace config
 * - 401 response triggers ChimeraAuthError
 * - Expired token triggers ChimeraAuthError
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadCredentials, getBaseUrl, ChimeraAuthError, apiClient } from '../../lib/api-client';

let tmpDir: string;
let tmpCredFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-api-test-'));
  tmpCredFile = path.join(tmpDir, 'credentials');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCredentials(overrides: Partial<{
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresAt: string;
}> = {}): void {
  const defaults = {
    accessToken: 'test-access-token',
    idToken: 'test-id-token',
    refreshToken: 'test-refresh-token',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  };
  fs.writeFileSync(tmpCredFile, JSON.stringify({ ...defaults, ...overrides }));
}

describe('loadCredentials', () => {
  it('returns null when credentials file does not exist', async () => {
    const result = await loadCredentials(path.join(tmpDir, 'nonexistent'));
    expect(result).toBeNull();
  });

  it('returns parsed credentials when file exists', async () => {
    writeCredentials();
    const creds = await loadCredentials(tmpCredFile);
    expect(creds).not.toBeNull();
    expect(creds?.accessToken).toBe('test-access-token');
    expect(creds?.refreshToken).toBe('test-refresh-token');
  });

  it('returns null when credentials file is malformed JSON', async () => {
    fs.writeFileSync(tmpCredFile, 'not-valid-json');
    const result = await loadCredentials(tmpCredFile);
    expect(result).toBeNull();
  });
});

describe('getBaseUrl', () => {
  it('returns empty string when no config present', () => {
    const url = getBaseUrl({});
    expect(url).toBe('');
  });

  it('returns api_url from endpoints config', () => {
    const url = getBaseUrl({ endpoints: { api_url: 'https://api.example.com' } });
    expect(url).toBe('https://api.example.com');
  });
});

describe('ChimeraAuthError', () => {
  it('has correct name and default message', () => {
    const err = new ChimeraAuthError();
    expect(err.name).toBe('ChimeraAuthError');
    expect(err.message).toContain('chimera login');
  });

  it('accepts custom message', () => {
    const err = new ChimeraAuthError('Token expired');
    expect(err.message).toBe('Token expired');
  });
});

describe('apiClient', () => {
  it('throws ChimeraAuthError when credentials file does not exist', async () => {
    await expect(
      apiClient.get('/test', path.join(tmpDir, 'nonexistent')),
    ).rejects.toBeInstanceOf(ChimeraAuthError);
  });

  it('throws ChimeraAuthError when token is expired', async () => {
    writeCredentials({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(apiClient.get('/test', tmpCredFile)).rejects.toBeInstanceOf(ChimeraAuthError);
  });

  it('throws ChimeraAuthError on 401 response', async () => {
    writeCredentials();
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    try {
      await expect(apiClient.get('/test', tmpCredFile)).rejects.toBeInstanceOf(ChimeraAuthError);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('sends Authorization header with Bearer token', async () => {
    writeCredentials({ accessToken: 'my-token-123' });
    let capturedAuth = '';
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    try {
      await apiClient.get('/test', tmpCredFile);
      expect(capturedAuth).toBe('Bearer my-token-123');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('throws error on non-401 non-ok response', async () => {
    writeCredentials();
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(new Response('Server Error', { status: 500 }));
    try {
      await expect(apiClient.get('/test', tmpCredFile)).rejects.toThrow('API error 500');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
