/**
 * Tests for chimera setup command
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { provisionAdminUser } from '../src/commands/setup';

// Store mock functions as named variables before mock.module() (bun:test convention)
const mockAdminCreateUser = mock(async () => ({}));
const mockAdminSetUserPassword = mock(async () => ({}));
const mockAdminAddUserToGroup = mock(async () => ({}));

// Track which command class was instantiated
let lastCreatedCommand: string | null = null;

mock.module('@aws-sdk/client-cognito-identity-provider', () => {
  class UsernameExistsException extends Error {
    constructor(opts: { message: string }) {
      super(opts.message);
      this.name = 'UsernameExistsException';
    }
  }

  class AdminCreateUserCommand {
    constructor(public input: unknown) { lastCreatedCommand = 'AdminCreateUserCommand'; }
  }
  class AdminSetUserPasswordCommand {
    constructor(public input: unknown) { lastCreatedCommand = 'AdminSetUserPasswordCommand'; }
  }
  class AdminAddUserToGroupCommand {
    constructor(public input: unknown) { lastCreatedCommand = 'AdminAddUserToGroupCommand'; }
  }

  class CognitoIdentityProviderClient {
    async send(cmd: unknown) {
      if (cmd instanceof AdminCreateUserCommand) return mockAdminCreateUser();
      if (cmd instanceof AdminSetUserPasswordCommand) return mockAdminSetUserPassword();
      if (cmd instanceof AdminAddUserToGroupCommand) return mockAdminAddUserToGroup();
      return {};
    }
  }

  return {
    CognitoIdentityProviderClient,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
    AdminAddUserToGroupCommand,
    UsernameExistsException,
  };
});

describe('provisionAdminUser', () => {
  beforeEach(() => {
    mockAdminCreateUser.mockReset();
    mockAdminSetUserPassword.mockReset();
    mockAdminAddUserToGroup.mockReset();
    mockAdminCreateUser.mockImplementation(async () => ({}));
    mockAdminSetUserPassword.mockImplementation(async () => ({}));
    mockAdminAddUserToGroup.mockImplementation(async () => ({}));
  });

  it('returns true when user is newly created', async () => {
    const { CognitoIdentityProviderClient } = await import('@aws-sdk/client-cognito-identity-provider');
    const client = new CognitoIdentityProviderClient({});
    const result = await provisionAdminUser(client as never, 'us-east-1_TEST', 'admin@example.com', 'Passw0rd!@#123');
    expect(result).toBe(true);
  });

  it('returns false when user already exists', async () => {
    const { CognitoIdentityProviderClient, UsernameExistsException } = await import('@aws-sdk/client-cognito-identity-provider');
    mockAdminCreateUser.mockImplementation(async () => {
      throw new UsernameExistsException({ message: 'User already exists' });
    });
    const client = new CognitoIdentityProviderClient({});
    const result = await provisionAdminUser(client as never, 'us-east-1_TEST', 'admin@example.com', 'Passw0rd!@#123');
    expect(result).toBe(false);
  });

  it('still sets permanent password and adds to group when user already exists', async () => {
    const { CognitoIdentityProviderClient, UsernameExistsException } = await import('@aws-sdk/client-cognito-identity-provider');
    mockAdminCreateUser.mockImplementation(async () => {
      throw new UsernameExistsException({ message: 'User already exists' });
    });
    const client = new CognitoIdentityProviderClient({});
    await provisionAdminUser(client as never, 'us-east-1_TEST', 'admin@example.com', 'Passw0rd!@#123');
    expect(mockAdminSetUserPassword).toHaveBeenCalledTimes(1);
    expect(mockAdminAddUserToGroup).toHaveBeenCalledTimes(1);
  });

  it('re-throws unexpected errors from AdminCreateUser', async () => {
    const { CognitoIdentityProviderClient } = await import('@aws-sdk/client-cognito-identity-provider');
    mockAdminCreateUser.mockImplementation(async () => {
      throw new Error('InvalidParameterException');
    });
    const client = new CognitoIdentityProviderClient({});
    await expect(
      provisionAdminUser(client as never, 'us-east-1_TEST', 'admin@example.com', 'Passw0rd!@#123')
    ).rejects.toThrow('InvalidParameterException');
  });

  it('calls AdminSetUserPassword with Permanent=true', async () => {
    let capturedInput: unknown = null;
    const { CognitoIdentityProviderClient, AdminSetUserPasswordCommand } = await import('@aws-sdk/client-cognito-identity-provider');
    mockAdminSetUserPassword.mockImplementation(async () => ({}));

    // Override send to capture the input
    class TestClient extends CognitoIdentityProviderClient {
      async send(cmd: unknown) {
        if (cmd instanceof AdminSetUserPasswordCommand) {
          capturedInput = (cmd as { input: unknown }).input;
        }
        return super.send(cmd);
      }
    }
    const client = new TestClient({});
    await provisionAdminUser(client as never, 'us-east-1_TEST', 'admin@example.com', 'Passw0rd!@#123');
    expect(capturedInput).toMatchObject({ Permanent: true, Password: 'Passw0rd!@#123' });
  });
});
