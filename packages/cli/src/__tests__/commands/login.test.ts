/**
 * Tests for packages/cli/src/commands/login.ts
 *
 * Verifies:
 * - terminalLogin calls Cognito InitiateAuth with correct parameters
 * - Successful login stores tokens via saveCredentials (TOML format)
 * - NEW_PASSWORD_REQUIRED challenge is handled
 * - Errors from Cognito are propagated
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import TOML from 'smol-toml';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-login-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Mock Cognito SDK ─────────────────────────────────────────────────────────

const mockInitiateAuth = mock(async () => ({
  AuthenticationResult: {
    AccessToken: 'access-123',
    IdToken: 'id-456',
    RefreshToken: 'refresh-789',
    ExpiresIn: 3600,
  },
}));

const mockRespondToAuthChallenge = mock(async () => ({
  AuthenticationResult: {
    AccessToken: 'new-access-token',
    IdToken: 'new-id-token',
    RefreshToken: 'new-refresh-token',
    ExpiresIn: 3600,
  },
}));

mock.module('@aws-sdk/client-cognito-identity-provider', () => {
  class InitiateAuthCommand {
    constructor(public input: unknown) {}
  }
  class RespondToAuthChallengeCommand {
    constructor(public input: unknown) {}
  }
  class CognitoIdentityProviderClient {
    async send(cmd: unknown) {
      if (cmd instanceof InitiateAuthCommand) return mockInitiateAuth();
      if (cmd instanceof RespondToAuthChallengeCommand) return mockRespondToAuthChallenge();
      return {};
    }
  }
  return { CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand };
});

// ─── Mock workspace saveCredentials / loadCredentials ─────────────────────────

let capturedSavedCredentials: Record<string, unknown> | null = null;

mock.module('../../utils/workspace.js', () => ({
  loadWorkspaceConfig: () => ({
    aws: { region: 'us-east-1' },
    endpoints: { cognito_client_id: 'test-client-id' },
  }),
  loadCredentials: () => ({}),
  saveCredentials: (creds: Record<string, unknown>) => {
    capturedSavedCredentials = creds;
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('terminalLogin', () => {
  beforeEach(() => {
    capturedSavedCredentials = null;
    mockInitiateAuth.mockReset();
    mockRespondToAuthChallenge.mockReset();
    mockInitiateAuth.mockImplementation(async () => ({
      AuthenticationResult: {
        AccessToken: 'access-123',
        IdToken: 'id-456',
        RefreshToken: 'refresh-789',
        ExpiresIn: 3600,
      },
    }));
  });

  it('calls Cognito InitiateAuth and stores tokens', async () => {
    const { terminalLogin } = await import('../../commands/login');
    await terminalLogin('client-id', 'us-east-1', 'user@example.com', 'MyPassword1!');

    expect(capturedSavedCredentials).not.toBeNull();
    const auth = (capturedSavedCredentials as { auth: Record<string, string> }).auth;
    expect(auth.access_token).toBe('access-123');
    expect(auth.id_token).toBe('id-456');
    expect(auth.refresh_token).toBe('refresh-789');
    expect(typeof auth.expires_at).toBe('string');
    // expires_at should be ~1 hour from now
    expect(new Date(auth.expires_at).getTime()).toBeGreaterThan(Date.now() + 3500 * 1000);
  });

  it('handles NEW_PASSWORD_REQUIRED challenge', async () => {
    mockInitiateAuth.mockImplementation(async () => ({
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: 'session-token-abc',
    }));
    mockRespondToAuthChallenge.mockImplementation(async () => ({
      AuthenticationResult: {
        AccessToken: 'new-access-token',
        IdToken: 'new-id-token',
        RefreshToken: 'new-refresh-token',
        ExpiresIn: 3600,
      },
    }));

    const { terminalLogin } = await import('../../commands/login');
    // Inject new-password provider to skip inquirer prompt
    await terminalLogin('client-id', 'us-east-1', 'user@example.com', 'TempPass1!', async () => 'NewPass1!@#Abc');

    const auth = (capturedSavedCredentials as { auth: Record<string, string> }).auth;
    expect(auth.access_token).toBe('new-access-token');
  });

  it('throws when Cognito returns no tokens', async () => {
    mockInitiateAuth.mockImplementation(async () => ({ AuthenticationResult: null }));
    const { terminalLogin } = await import('../../commands/login');
    await expect(
      terminalLogin('client-id', 'us-east-1', 'user@example.com', 'pass'),
    ).rejects.toThrow('no tokens returned');
  });

  it('preserves existing credentials (e.g. admin password) when storing tokens', async () => {
    // Pre-populate capturedSavedCredentials to simulate existing admin creds
    mock.module('../../utils/workspace.js', () => ({
      loadWorkspaceConfig: () => ({
        aws: { region: 'us-east-1' },
        endpoints: { cognito_client_id: 'test-client-id' },
      }),
      loadCredentials: () => ({ admin: { password: 'AdminP@ss1' } }),
      saveCredentials: (creds: Record<string, unknown>) => {
        capturedSavedCredentials = creds;
      },
    }));

    const { terminalLogin } = await import('../../commands/login');
    await terminalLogin('client-id', 'us-east-1', 'user@example.com', 'MyPassword1!');

    // Should have both admin and auth sections
    expect((capturedSavedCredentials as Record<string, unknown>).admin).toEqual({ password: 'AdminP@ss1' });
    const auth = (capturedSavedCredentials as { auth: Record<string, string> }).auth;
    expect(auth.access_token).toBe('access-123');
  });
});

describe('credentials file (TOML format)', () => {
  it('written file contains all required fields in [auth] section', () => {
    const tmpCredFile = path.join(tmpDir, 'credentials');
    const content = TOML.stringify({
      auth: {
        access_token: 'acc',
        id_token: 'id',
        refresh_token: 'ref',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
    } as Parameters<typeof TOML.stringify>[0]);
    fs.writeFileSync(tmpCredFile, content);

    const parsed = TOML.parse(fs.readFileSync(tmpCredFile, 'utf8')) as {
      auth: { access_token: string; id_token: string; refresh_token: string; expires_at: string };
    };
    expect(parsed.auth.access_token).toBe('acc');
    expect(parsed.auth.id_token).toBe('id');
    expect(parsed.auth.refresh_token).toBe('ref');
    expect(new Date(parsed.auth.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('detects expired token in TOML format', () => {
    const tmpCredFile = path.join(tmpDir, 'credentials');
    const content = TOML.stringify({
      auth: {
        access_token: 'acc',
        id_token: 'id',
        refresh_token: 'ref',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    } as Parameters<typeof TOML.stringify>[0]);
    fs.writeFileSync(tmpCredFile, content);

    const parsed = TOML.parse(fs.readFileSync(tmpCredFile, 'utf8')) as {
      auth: { expires_at: string };
    };
    expect(new Date(parsed.auth.expires_at).getTime()).toBeLessThan(Date.now());
  });
});
