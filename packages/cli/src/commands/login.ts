/**
 * chimera login — Direct terminal authentication via Cognito InitiateAuth
 *
 * Prompts for email and password in the terminal, calls Cognito InitiateAuth
 * with USER_PASSWORD_AUTH flow, and stores tokens in ~/.chimera/credentials.
 * No browser popup, no localhost redirect server.
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import { loadWorkspaceConfig, loadCredentials, saveCredentials } from '../utils/workspace.js';
import { color } from '../lib/color.js';

// ─── Core auth logic (exported for testing) ───────────────────────────────────

/**
 * Authenticate with Cognito using email + password (USER_PASSWORD_AUTH flow).
 * Handles NEW_PASSWORD_REQUIRED challenge transparently.
 *
 * @param clientId  Cognito app client ID
 * @param region    AWS region
 * @param email     User email / username
 * @param password  User password
 * @param newPasswordFn  Injectable prompt for new-password challenge (defaults to inquirer)
 */
export async function terminalLogin(
  clientId: string,
  region: string,
  email: string,
  password: string,
  newPasswordFn?: () => Promise<string>,
): Promise<void> {
  const cognitoClient = new CognitoIdentityProviderClient({ region });

  const response = await cognitoClient.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
    ClientId: clientId,
  }));

  let authResult: AuthenticationResultType | undefined = response.AuthenticationResult;

  // Admin-provisioned users are forced to change their password on first login
  if (response.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    console.log(color.yellow('\nYou must set a new password to continue.'));

    const newPassword = newPasswordFn
      ? await newPasswordFn()
      : await promptNewPassword();

    const challengeResponse = await cognitoClient.send(new RespondToAuthChallengeCommand({
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ClientId: clientId,
      Session: response.Session,
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    }));
    authResult = challengeResponse.AuthenticationResult;
  }

  if (!authResult?.AccessToken) {
    throw new Error('Authentication failed: no tokens returned from Cognito');
  }

  const expiresAt = new Date(Date.now() + (authResult.ExpiresIn ?? 3600) * 1000).toISOString();
  const existing = loadCredentials();
  saveCredentials({
    ...existing,
    auth: {
      access_token: authResult.AccessToken,
      id_token: authResult.IdToken ?? '',
      refresh_token: authResult.RefreshToken ?? '',
      expires_at: expiresAt,
    },
  });
}

async function promptNewPassword(): Promise<string> {
  const { newPassword } = await inquirer.prompt<{ newPassword: string }>([
    {
      type: 'password',
      name: 'newPassword',
      message: 'New password:',
      mask: '*',
      validate: (input: string) => {
        if (input.length < 12) return 'Password must be at least 12 characters';
        if (!/[A-Z]/.test(input)) return 'Must contain at least one uppercase letter';
        if (!/[a-z]/.test(input)) return 'Must contain at least one lowercase letter';
        if (!/[0-9]/.test(input)) return 'Must contain at least one digit';
        if (!/[^A-Za-z0-9]/.test(input)) return 'Must contain at least one symbol';
        return true;
      },
    },
  ]);
  return newPassword;
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with the Chimera platform')
    .option('--email <email>', 'Email address (skips prompt)')
    .action(async (options: { email?: string }) => {
      const config = loadWorkspaceConfig();
      const clientId = config.endpoints?.cognito_client_id;
      const region = config.aws?.region ?? 'us-east-1';

      if (!clientId) {
        console.error(color.red('✗ Missing Cognito client ID in chimera.toml'));
        console.error(color.dim('  Run `chimera endpoints` to fetch configuration'));
        process.exit(1);
      }

      console.log(color.bold('Chimera Login\n'));

      const { email, password } = await inquirer.prompt<{ email: string; password: string }>([
        {
          type: 'input',
          name: 'email',
          message: 'Email:',
          default: options.email,
          when: !options.email,
          validate: (input: string) =>
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim()) || 'Enter a valid email address',
        },
        {
          type: 'password',
          name: 'password',
          message: 'Password:',
          mask: '*',
          validate: (input: string) => input.length > 0 || 'Password is required',
        },
      ]);

      try {
        await terminalLogin(clientId, region, options.email ?? email, password);
        console.log(color.green('\n✓ Logged in successfully'));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(color.red(`\n✗ Login failed: ${msg}`));
        process.exit(1);
      }
    });
}
