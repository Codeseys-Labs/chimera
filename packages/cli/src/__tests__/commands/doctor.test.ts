/**
 * Tests for packages/cli/src/commands/doctor.ts
 *
 * Verifies each pre-flight check produces the correct pass/fail result.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  checkAwsCredentials,
  checkChimeraAuth,
  checkApiConnectivity,
  checkCognitoConfig,
} from '../../commands/doctor';

let tmpDir: string;
let tmpCredFile: string;
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-doctor-test-'));
  tmpCredFile = path.join(tmpDir, 'credentials');
  originalEnv = {
    AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
    AWS_ROLE_ARN: process.env['AWS_ROLE_ARN'],
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: process.env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'],
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

// ─── checkAwsCredentials ─────────────────────────────────────────────────────

describe('checkAwsCredentials', () => {
  it('passes when AWS_ACCESS_KEY_ID is set', () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAIOSFODNN7EXAMPLE';
    const result = checkAwsCredentials();
    expect(result.ok).toBe(true);
    expect(result.label).toBe('AWS credentials');
  });

  it('returns a result with the expected label', () => {
    const result = checkAwsCredentials();
    expect(result.label).toBe('AWS credentials');
    expect(typeof result.ok).toBe('boolean');
  });
});

// ─── checkChimeraAuth ─────────────────────────────────────────────────────────

describe('checkChimeraAuth', () => {
  it('fails when credentials file does not exist', async () => {
    const result = await checkChimeraAuth(path.join(tmpDir, 'nonexistent'));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('chimera login');
  });

  it('fails when credentials file is malformed', async () => {
    fs.writeFileSync(tmpCredFile, 'not-json');
    const result = await checkChimeraAuth(tmpCredFile);
    expect(result.ok).toBe(false);
  });

  it('fails when token is expired', async () => {
    fs.writeFileSync(
      tmpCredFile,
      JSON.stringify({
        accessToken: 'tok',
        idToken: 'id',
        refreshToken: 'ref',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const result = await checkChimeraAuth(tmpCredFile);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('expired');
  });

  it('passes when token is valid', async () => {
    fs.writeFileSync(
      tmpCredFile,
      JSON.stringify({
        accessToken: 'tok',
        idToken: 'id',
        refreshToken: 'ref',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      }),
    );
    const result = await checkChimeraAuth(tmpCredFile);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Expires');
  });

  it('fails when credentials are missing required fields', async () => {
    fs.writeFileSync(tmpCredFile, JSON.stringify({ refreshToken: 'ref' }));
    const result = await checkChimeraAuth(tmpCredFile);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('malformed');
  });
});

// ─── checkApiConnectivity ─────────────────────────────────────────────────────

describe('checkApiConnectivity', () => {
  it('fails when baseUrl is empty', async () => {
    const result = await checkApiConnectivity('');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('api_url not set');
  });

  it('passes when health endpoint returns 200', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    try {
      const result = await checkApiConnectivity('https://api.example.com');
      expect(result.ok).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails when health endpoint returns non-200', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(new Response('error', { status: 503 }));
    try {
      const result = await checkApiConnectivity('https://api.example.com');
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('503');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails when API is unreachable', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      const result = await checkApiConnectivity('https://unreachable.example.com');
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('ECONNREFUSED');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ─── checkCognitoConfig ───────────────────────────────────────────────────────

describe('checkCognitoConfig', () => {
  it('returns a result with label "Cognito pool config"', () => {
    const result = checkCognitoConfig();
    expect(result.label).toBe('Cognito pool config');
    expect(typeof result.ok).toBe('boolean');
  });
});
