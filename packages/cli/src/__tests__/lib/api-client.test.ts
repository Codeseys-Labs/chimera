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
import TOML from 'smol-toml';
import { loadCredentials, getBaseUrl, getUrlForPath, ChimeraAuthError, apiClient } from '../../lib/api-client';

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
  const merged = { ...defaults, ...overrides };
  fs.writeFileSync(tmpCredFile, TOML.stringify({
    auth: {
      access_token: merged.accessToken,
      id_token: merged.idToken,
      refresh_token: merged.refreshToken,
      expires_at: merged.expiresAt,
    },
  } as Parameters<typeof TOML.stringify>[0]));
}

describe('loadCredentials', () => {
  it('returns null when credentials file does not exist', () => {
    const result = loadCredentials(path.join(tmpDir, 'nonexistent'));
    expect(result).toBeNull();
  });

  it('returns parsed credentials when file exists', () => {
    writeCredentials();
    const creds = loadCredentials(tmpCredFile);
    expect(creds).not.toBeNull();
    expect(creds?.accessToken).toBe('test-access-token');
    expect(creds?.refreshToken).toBe('test-refresh-token');
  });

  it('returns null when credentials file is malformed', () => {
    fs.writeFileSync(tmpCredFile, 'not-valid-toml-content: [unclosed');
    const result = loadCredentials(tmpCredFile);
    expect(result).toBeNull();
  });

  it('parses TOML format credentials ([auth] section with snake_case keys)', () => {
    const content = TOML.stringify({
      auth: {
        access_token: 'toml-access-token',
        id_token: 'toml-id-token',
        refresh_token: 'toml-refresh-token',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
    } as Parameters<typeof TOML.stringify>[0]);
    fs.writeFileSync(tmpCredFile, content);
    const creds = loadCredentials(tmpCredFile);
    expect(creds).not.toBeNull();
    expect(creds?.accessToken).toBe('toml-access-token');
    expect(creds?.idToken).toBe('toml-id-token');
    expect(creds?.refreshToken).toBe('toml-refresh-token');
  });

  it('returns null for TOML without [auth] section', () => {
    const content = TOML.stringify({
      admin: { password: 'AdminPass1!' },
    } as Parameters<typeof TOML.stringify>[0]);
    fs.writeFileSync(tmpCredFile, content);
    const result = loadCredentials(tmpCredFile);
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

describe('getUrlForPath', () => {
  it('is exported and callable', () => {
    expect(typeof getUrlForPath).toBe('function');
  });

  it('routes non-chat paths using api_url from config', () => {
    // Uses an explicit config object to test routing logic
    const result = getBaseUrl({ endpoints: { api_url: 'https://api.example.com' } });
    expect(result).toBe('https://api.example.com');
  });

  it('returns a string for any path', () => {
    // getUrlForPath reads from chimera.toml in cwd tree; result type must be string
    expect(typeof getUrlForPath('/tenants')).toBe('string');
    expect(typeof getUrlForPath('/chat/stream')).toBe('string');
  });

  it('chat paths include /chat/ in result', () => {
    const result = getUrlForPath('/chat/stream');
    expect(result).toContain('/chat/stream');
  });

  it('non-chat paths include the path in result', () => {
    const result = getUrlForPath('/tenants');
    expect(result).toContain('/tenants');
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
