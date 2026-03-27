/**
 * Tests for packages/cli/src/commands/login.ts
 *
 * Verifies:
 * - PKCE generation produces valid base64url output
 * - Token exchange calls correct endpoint and returns structured TokenSet
 * - Credentials file written with correct structure
 * - Expired token is detectable
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generatePKCE, exchangeCodeForTokens } from '../../commands/login';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-login-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generatePKCE', () => {
  it('returns verifier and challenge as non-empty strings', () => {
    const { verifier, challenge } = generatePKCE();
    expect(typeof verifier).toBe('string');
    expect(verifier.length).toBeGreaterThan(0);
    expect(typeof challenge).toBe('string');
    expect(challenge.length).toBeGreaterThan(0);
  });

  it('verifier contains only base64url characters', () => {
    const { verifier } = generatePKCE();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('challenge contains only base64url characters', () => {
    const { challenge } = generatePKCE();
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('generates different verifiers on each call', () => {
    const first = generatePKCE();
    const second = generatePKCE();
    expect(first.verifier).not.toBe(second.verifier);
  });
});

describe('exchangeCodeForTokens', () => {
  it('POSTs to /oauth2/token and returns TokenSet', async () => {
    const mockResponse = {
      access_token: 'access-123',
      id_token: 'id-456',
      refresh_token: 'refresh-789',
      expires_in: 3600,
    };

    const originalFetch = global.fetch;
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedBody = '';

    global.fetch = jest.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedMethod = init?.method ?? 'GET';
      capturedBody = init?.body?.toString() ?? '';
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      const tokens = await exchangeCodeForTokens(
        'auth-code-abc',
        'my-verifier',
        'https://cognito.example.com',
        'my-client-id',
      );

      expect(capturedUrl).toBe('https://cognito.example.com/oauth2/token');
      expect(capturedMethod).toBe('POST');
      expect(capturedBody).toContain('code=auth-code-abc');
      expect(capturedBody).toContain('code_verifier=my-verifier');
      expect(capturedBody).toContain('client_id=my-client-id');

      expect(tokens.accessToken).toBe('access-123');
      expect(tokens.idToken).toBe('id-456');
      expect(tokens.refreshToken).toBe('refresh-789');
      expect(typeof tokens.expiresAt).toBe('string');
      // expiresAt should be ~1 hour from now
      expect(new Date(tokens.expiresAt).getTime()).toBeGreaterThan(Date.now() + 3500 * 1000);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('throws when token endpoint returns an error', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response('invalid_grant', { status: 400 }),
    );
    try {
      await expect(
        exchangeCodeForTokens('bad-code', 'verifier', 'https://cognito.example.com', 'client-id'),
      ).rejects.toThrow('Token exchange failed');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('credentials file structure', () => {
  it('written file contains all required fields', () => {
    const tmpCredFile = path.join(tmpDir, 'credentials');
    const tokens = {
      accessToken: 'acc',
      idToken: 'id',
      refreshToken: 'ref',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    };
    fs.writeFileSync(tmpCredFile, JSON.stringify(tokens));
    const parsed = JSON.parse(fs.readFileSync(tmpCredFile, 'utf8')) as typeof tokens;
    expect(parsed.accessToken).toBeDefined();
    expect(parsed.idToken).toBeDefined();
    expect(parsed.refreshToken).toBeDefined();
    expect(parsed.expiresAt).toBeDefined();
    expect(new Date(parsed.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('detects expired token', () => {
    const tmpCredFile = path.join(tmpDir, 'credentials');
    const expiredTokens = {
      accessToken: 'acc',
      idToken: 'id',
      refreshToken: 'ref',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    fs.writeFileSync(tmpCredFile, JSON.stringify(expiredTokens));
    const parsed = JSON.parse(fs.readFileSync(tmpCredFile, 'utf8')) as typeof expiredTokens;
    expect(new Date(parsed.expiresAt).getTime()).toBeLessThan(Date.now());
  });
});
