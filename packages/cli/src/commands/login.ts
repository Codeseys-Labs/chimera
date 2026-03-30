/**
 * chimera login — Direct terminal authentication via Cognito InitiateAuth
 *
 * Prompts for email and password in the terminal, calls Cognito InitiateAuth
 * with USER_PASSWORD_AUTH flow, and stores tokens in ~/.chimera/credentials.
 *
 * Supports challenge chain:
 * - NEW_PASSWORD_REQUIRED: first-login forced password change
 * - SOFTWARE_TOKEN_MFA: TOTP code from authenticator app
 * - SMS_MFA: SMS verification code
 * - MFA_SETUP: guided TOTP setup (AssociateSoftwareToken + VerifySoftwareToken)
 *
 * --browser flag opens a custom localhost login UI instead.
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import { loadWorkspaceConfig, loadCredentials, saveCredentials } from '../utils/workspace.js';
import { color } from '../lib/color.js';

// ─── Core auth logic (exported for testing) ───────────────────────────────────

/**
 * Authenticate with Cognito using email + password (USER_PASSWORD_AUTH flow).
 * Handles full challenge chain until tokens are returned.
 *
 * @param clientId       Cognito app client ID
 * @param region         AWS region
 * @param email          User email / username
 * @param password       User password
 * @param newPasswordFn  Injectable prompt for new-password challenge (defaults to inquirer)
 * @param mfaCodeFn      Injectable prompt for MFA code (defaults to inquirer)
 */
export async function terminalLogin(
  clientId: string,
  region: string,
  email: string,
  password: string,
  newPasswordFn?: () => Promise<string>,
  mfaCodeFn?: () => Promise<string>,
): Promise<void> {
  const cognitoClient = new CognitoIdentityProviderClient({ region });

  const initResponse = await cognitoClient.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
    ClientId: clientId,
  }));

  let challengeName: string | undefined = initResponse.ChallengeName;
  let session: string | undefined = initResponse.Session;
  let authResult: AuthenticationResultType | undefined = initResponse.AuthenticationResult;

  // Challenge loop: keep responding until Cognito returns tokens
  while (!authResult && challengeName) {
    if (challengeName === 'NEW_PASSWORD_REQUIRED') {
      console.log(color.yellow('\nYou must set a new password to continue.'));
      const newPassword = newPasswordFn ? await newPasswordFn() : await promptNewPassword();

      const resp = await cognitoClient.send(new RespondToAuthChallengeCommand({
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        ClientId: clientId,
        Session: session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
      }));
      challengeName = resp.ChallengeName;
      session = resp.Session;
      authResult = resp.AuthenticationResult;

    } else if (challengeName === 'SOFTWARE_TOKEN_MFA') {
      console.log(color.yellow('\nMFA required. Open your authenticator app.'));
      const code = mfaCodeFn
        ? await mfaCodeFn()
        : await promptMfaCode('Enter TOTP code from your authenticator app:');

      const resp = await cognitoClient.send(new RespondToAuthChallengeCommand({
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        ClientId: clientId,
        Session: session,
        ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: code },
      }));
      challengeName = resp.ChallengeName;
      session = resp.Session;
      authResult = resp.AuthenticationResult;

    } else if (challengeName === 'SMS_MFA') {
      console.log(color.yellow('\nMFA required. Check your SMS messages.'));
      const code = mfaCodeFn
        ? await mfaCodeFn()
        : await promptMfaCode('Enter SMS code:');

      const resp = await cognitoClient.send(new RespondToAuthChallengeCommand({
        ChallengeName: 'SMS_MFA',
        ClientId: clientId,
        Session: session,
        ChallengeResponses: { USERNAME: email, SMS_MFA_CODE: code },
      }));
      challengeName = resp.ChallengeName;
      session = resp.Session;
      authResult = resp.AuthenticationResult;

    } else if (challengeName === 'MFA_SETUP') {
      // Guide user through TOTP authenticator app setup
      const associateResp = await cognitoClient.send(new AssociateSoftwareTokenCommand({
        Session: session,
      }));
      const secretCode = associateResp.SecretCode ?? '';
      const otpauthUri = `otpauth://totp/Chimera:${email}?secret=${secretCode}&issuer=Chimera`;

      console.log(color.yellow('\nMFA setup required. Configure your authenticator app:'));
      console.log(color.gray(`\n  Secret:  ${secretCode}`));
      console.log(color.gray(`  URI:     ${otpauthUri}\n`));

      const code = mfaCodeFn
        ? await mfaCodeFn()
        : await promptMfaCode('Enter TOTP code to verify setup:');

      const verifyResp = await cognitoClient.send(new VerifySoftwareTokenCommand({
        Session: associateResp.Session,
        UserCode: code,
      }));

      const resp = await cognitoClient.send(new RespondToAuthChallengeCommand({
        ChallengeName: 'MFA_SETUP',
        ClientId: clientId,
        Session: verifyResp.Session,
        ChallengeResponses: { USERNAME: email },
      }));
      challengeName = resp.ChallengeName;
      session = resp.Session;
      authResult = resp.AuthenticationResult;

    } else {
      throw new Error(`Unhandled auth challenge: ${challengeName}`);
    }
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

async function promptMfaCode(message: string): Promise<string> {
  const { code } = await inquirer.prompt<{ code: string }>([
    {
      type: 'input',
      name: 'code',
      message,
      validate: (input: string) => /^\d{6}$/.test(input.trim()) || 'Enter a 6-digit code',
    },
  ]);
  return code.trim();
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with the Chimera platform')
    .option('--email <email>', 'Email address (skips prompt)')
    .option('--browser', 'Use custom browser login UI at localhost:9999')
    .option('--terminal', 'Use terminal email/password login (skips mode prompt)')
    .option('--no-prompt', 'Non-interactive: default to terminal mode without prompting')
    .option('--region <region>', 'AWS region override (default: read from chimera.toml)')
    .option('--json', 'Output result as JSON (status + expires_at)')
    .addHelpText('after', `
Examples:
  $ chimera login                     # interactive mode selection
  $ chimera login --terminal          # terminal credentials prompt
  $ chimera login --browser           # browser-based login
  $ chimera login --email me@co.com   # skip email prompt
  $ chimera login --no-prompt         # non-interactive terminal login
  $ chimera login --json              # output JSON result after login`)
    .action(async (options: { email?: string; browser?: boolean; terminal?: boolean; prompt?: boolean; region?: string; json?: boolean }) => {
      const config = loadWorkspaceConfig();
      const clientId = config.endpoints?.cognito_client_id;
      const region = options.region ?? config.aws?.region;

      if (!region) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: 'No AWS region configured', code: 'NO_REGION' }));
          process.exit(1);
        }
        console.error(color.red('✗ No AWS region configured'));
        console.error(color.gray('  Run "chimera init" to set up your workspace'));
        process.exit(1);
      }

      if (!clientId) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: 'Missing Cognito client ID in chimera.toml', code: 'NO_CLIENT_ID' }));
          process.exit(1);
        }
        console.error(color.red('✗ Missing Cognito client ID in chimera.toml'));
        console.error(color.gray('  Run `chimera endpoints` to fetch configuration'));
        process.exit(1);
      }

      if (!options.json) console.log(color.bold('Chimera Login\n'));

      // Determine auth mode: explicit flags take precedence, then prompt if interactive
      let useBrowser = options.browser === true;

      if (!useBrowser && !options.terminal) {
        // Only prompt when stdin is a TTY and --no-prompt was not passed
        const isInteractive = process.stdin.isTTY && options.prompt !== false;
        if (isInteractive) {
          const { mode } = await inquirer.prompt<{ mode: 'terminal' | 'browser' }>([{
            type: 'list',
            name: 'mode',
            message: 'How would you like to sign in?',
            choices: [
              { name: 'Terminal  — enter credentials here', value: 'terminal' },
              { name: 'Browser   — open login page in browser', value: 'browser' },
            ],
          }]);
          useBrowser = mode === 'browser';
        }
        // Non-interactive (piped stdin or --no-prompt): default to terminal silently
      }

      if (useBrowser) {
        try {
          // Dynamic import keeps browser-server out of terminal-only test paths
          const { startBrowserLogin } = await import('../auth/browser-server.js');
          await startBrowserLogin(clientId, region);
          if (options.json) {
            const creds = loadCredentials();
            console.log(JSON.stringify({ status: 'ok', data: { loggedIn: true, expires_at: creds?.auth?.expires_at } }));
          } else {
            console.log(color.green('\n✓ Logged in successfully'));
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'LOGIN_FAILED' }));
          } else {
            console.error(color.red(`\n✗ Login failed: ${msg}`));
          }
          process.exit(1);
        }
        return;
      }

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
        if (options.json) {
          const creds = loadCredentials();
          console.log(JSON.stringify({ status: 'ok', data: { loggedIn: true, expires_at: creds?.auth?.expires_at } }));
        } else {
          console.log(color.green('\n✓ Logged in successfully'));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: msg, code: 'LOGIN_FAILED' }));
        } else {
          console.error(color.red(`\n✗ Login failed: ${msg}`));
        }
        process.exit(1);
      }
    });
}
