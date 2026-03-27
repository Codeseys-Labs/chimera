/**
 * chimera login — Cognito PKCE authentication flow
 *
 * Opens browser to Cognito hosted UI, starts local redirect listener,
 * exchanges auth code for tokens, stores tokens in ~/.chimera/credentials.
 */

import { Command } from 'commander';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { execFile } from 'child_process';
import { loadWorkspaceConfig } from '../utils/workspace';
import { color } from '../lib/color';

const CREDENTIALS_DIR = path.join(os.homedir(), '.chimera');
export const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials');
const REDIRECT_PORT = 9999;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// ─── PKCE helpers ────────────────────────────────────────────────────────────

function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ─── Token exchange ───────────────────────────────────────────────────────────

export interface TokenSet {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresAt: string;
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  cognitoDomain: string,
  clientId: string,
): Promise<TokenSet> {
  const res = await fetch(`${cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    id_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return {
    accessToken: data.access_token,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt,
  };
}

// ─── Redirect listener ────────────────────────────────────────────────────────

function waitForCallback(expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rawUrl = req.url ?? '';
      const url = new URL(rawUrl, `http://localhost:${REDIRECT_PORT}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? error;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication failed</h1><p>You can close this tab.</p>');
        server.close();
        reject(new Error(`Auth error: ${desc}`));
        return;
      }

      if (url.searchParams.get('state') !== expectedState) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication failed</h1><p>State mismatch.</p>');
        server.close();
        reject(new Error('Invalid state parameter — possible CSRF attack'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>No code received</h1>');
        server.close();
        reject(new Error('No authorization code received'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authentication successful!</h1><p>You can close this tab and return to the terminal.</p>');
      server.close();
      resolve(code);
    });

    server.listen(REDIRECT_PORT);

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Login timed out after 5 minutes'));
    }, LOGIN_TIMEOUT_MS);

    server.on('close', () => clearTimeout(timer));
  });
}

function openBrowser(url: string): void {
  // execFile (not exec) to avoid shell injection — url is app-controlled
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [url], (err) => {
    if (err) {
      console.error(color.dim(`  (Could not open browser automatically: ${err.message})`));
      console.log(`  Please open this URL manually:\n  ${url}`);
    }
  });
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with the Chimera platform (Cognito PKCE)')
    .action(async () => {
      const config = loadWorkspaceConfig();
      const clientId = config.endpoints?.cognito_client_id;
      const region = config.aws?.region ?? 'us-east-1';

      // Prefer cognito_domain from [endpoints] (set by `chimera endpoints`), then [auth]
      const rawDomain = config.endpoints?.cognito_domain ?? config.auth?.cognito_domain;
      const cognitoDomain = rawDomain
        ? rawDomain.startsWith('http')
          ? rawDomain
          : `https://${rawDomain}.auth.${region}.amazoncognito.com`
        : null;

      if (!cognitoDomain || !clientId) {
        console.error(color.red('✗ Missing Cognito configuration in chimera.toml'));
        console.error(
          color.dim(
            '  Run `chimera endpoints` to fetch configuration, or set endpoints.cognito_domain and endpoints.cognito_client_id',
          ),
        );
        process.exit(1);
      }

      const { verifier, challenge } = generatePKCE();
      const state = base64URLEncode(crypto.randomBytes(16));

      const authUrl = new URL(`${cognitoDomain}/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('scope', 'openid email');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);

      console.log(color.bold('Chimera Login'));
      console.log('\nOpening browser to authenticate...');
      console.log(color.dim(`Auth URL: ${authUrl.toString()}\n`));

      openBrowser(authUrl.toString());

      console.log('Waiting for browser redirect...');
      const code = await waitForCallback(state);

      console.log('Exchanging authorization code for tokens...');
      const tokens = await exchangeCodeForTokens(code, verifier, cognitoDomain, clientId);

      if (!fs.existsSync(CREDENTIALS_DIR)) {
        fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
      }
      fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });

      const expiresAt = new Date(tokens.expiresAt);
      console.log(color.green('✓ Logged in successfully'));
      console.log(color.dim(`  Token expires: ${expiresAt.toLocaleString()}`));
    });
}
