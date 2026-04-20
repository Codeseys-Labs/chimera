/**
 * Chimera API client
 *
 * - Reads auth token from ~/.chimera/credentials
 * - Sets Authorization: Bearer <token> header
 * - Base URL from workspace config endpoints.api_url
 * - Throws ChimeraAuthError on 401 or missing credentials
 */

import { loadWorkspaceConfig, loadCredentials as wsLoadCredentials } from '../utils/workspace.js';
import { isOfflineError } from '../utils/aws-errors.js';
import * as path from 'path';
import * as os from 'os';

export const DEFAULT_CREDENTIALS_FILE = path.join(os.homedir(), '.chimera', 'credentials');

export class ChimeraAuthError extends Error {
  constructor(message = 'Authentication required. Run "chimera login" to authenticate.') {
    super(message);
    this.name = 'ChimeraAuthError';
  }
}

export interface Credentials {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresAt: string;
}

/**
 * Decode a JWT's `exp` claim without verifying the signature. Returns the
 * expiration as milliseconds since the epoch, or `null` if the token does
 * not look like a JWT or has no `exp` claim.
 *
 * Note: this is NOT a signature-validating parse. The CLI doesn't have the
 * signing key; we only use `exp` to fail fast before making a request that
 * would return 401. The server still validates the signature.
 */
export function decodeJwtExp(token: string): number | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    // base64url → base64
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const claims = JSON.parse(json) as { exp?: number };
    if (typeof claims.exp !== 'number') return null;
    return claims.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Returns true if the access token's JWT `exp` claim is in the past.
 * Returns false if the token is not a decodable JWT (fail-open so we don't
 * break non-JWT tokens or malformed payloads — the existing `expiresAt`
 * check still guards that path).
 */
export function isJwtExpired(token: string, now: number = Date.now()): boolean {
  const expMs = decodeJwtExp(token);
  if (expMs === null) return false;
  return expMs <= now;
}

export function loadCredentials(filePath = DEFAULT_CREDENTIALS_FILE): Credentials | null {
  const creds = wsLoadCredentials(filePath);
  if (!creds.auth?.access_token) {
    if (process.env.CHIMERA_DEBUG) {
      const authKeys = creds.auth ? Object.keys(creds.auth).join(',') || 'none' : 'section missing';
      process.stderr.write(`[chimera debug] loadCredentials: access_token absent (file=${filePath} auth=${authKeys})\n`);
    }
    return null;
  }
  return {
    accessToken: creds.auth.access_token,
    idToken: creds.auth.id_token ?? '',
    refreshToken: creds.auth.refresh_token ?? '',
    expiresAt: creds.auth.expires_at ?? '',
  };
}

export function getBaseUrl(config?: Record<string, unknown>): string {
  if (config !== undefined) {
    const endpoints = config.endpoints as { api_url?: string } | undefined;
    return endpoints?.api_url ?? '';
  }
  // WorkspaceConfig doesn't declare endpoints yet — read it via index access
  const wsConfig = loadWorkspaceConfig() as Record<string, unknown>;
  const endpoints = wsConfig.endpoints as { api_url?: string } | undefined;
  return endpoints?.api_url ?? '';
}

/**
 * Returns the base URL to use for a given path.
 * /chat/* routes go to chat_url (ECS ALB) if configured; falls back to api_url with a warning.
 */
export function getUrlForPath(urlPath: string): string {
  const wsConfig = loadWorkspaceConfig() as Record<string, unknown>;
  const endpoints = wsConfig.endpoints as { api_url?: string; chat_url?: string } | undefined;

  if (urlPath.startsWith('/chat/')) {
    if (endpoints?.chat_url) {
      return `${endpoints.chat_url}${urlPath}`;
    }
    // Fallback: warn and use api_url (will likely 403 but degrades gracefully)
    if (endpoints?.api_url) {
      process.stderr.write(
        'Warning: chat_url not configured. Run "chimera endpoints" to set the Chat ALB URL. Falling back to api_url.\n',
      );
      return `${endpoints.api_url}${urlPath}`;
    }
    return urlPath;
  }

  const baseUrl = endpoints?.api_url ?? '';
  return baseUrl ? `${baseUrl}${urlPath}` : urlPath;
}

async function getAuthHeaders(credentialsFile?: string): Promise<Record<string, string>> {
  const file = credentialsFile ?? DEFAULT_CREDENTIALS_FILE;
  const creds = loadCredentials(file);
  if (!creds) {
    if (process.env.CHIMERA_DEBUG) {
      process.stderr.write(`[chimera debug] getAuthHeaders: no valid credentials at ${file}\n`);
    }
    throw new ChimeraAuthError();
  }
  if (creds.expiresAt && new Date(creds.expiresAt) <= new Date()) {
    if (process.env.CHIMERA_DEBUG) {
      process.stderr.write(`[chimera debug] getAuthHeaders: token expired at ${creds.expiresAt}\n`);
    }
    throw new ChimeraAuthError('Session expired. Run: chimera login');
  }
  // Fallback: the stored expiresAt may be missing or stale. Decode the JWT's
  // own `exp` claim to catch clock-drift / dropped-expiresAt cases before
  // firing a request that will 401.
  if (isJwtExpired(creds.accessToken)) {
    if (process.env.CHIMERA_DEBUG) {
      process.stderr.write(`[chimera debug] getAuthHeaders: JWT exp claim in past\n`);
    }
    throw new ChimeraAuthError('Session expired. Run: chimera login');
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${creds.accessToken}`,
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ChimeraTimeoutError extends Error {
  constructor() {
    super('Connection timed out. Check that your API server is reachable.');
    this.name = 'ChimeraTimeoutError';
  }
}

/**
 * Pre-flight credential check. Call before API operations to fail fast with a
 * clean error instead of surfacing a stack trace from a deeper auth failure.
 */
export function guardAuth(credentialsFile?: string): void {
  const file = credentialsFile ?? DEFAULT_CREDENTIALS_FILE;
  const creds = loadCredentials(file);
  if (!creds) {
    throw new ChimeraAuthError();
  }
  if (creds.expiresAt && new Date(creds.expiresAt) <= new Date()) {
    throw new ChimeraAuthError('Session expired. Run: chimera login');
  }
  if (isJwtExpired(creds.accessToken)) {
    throw new ChimeraAuthError('Session expired. Run: chimera login');
  }
}

async function request<T>(method: string, urlPath: string, body?: unknown, credentialsFile?: string): Promise<T> {
  const url = getUrlForPath(urlPath);

  const headers = await getAuthHeaders(credentialsFile);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err.name === 'AbortError') throw new ChimeraTimeoutError();
    if (isOfflineError(err)) throw new Error('Cannot reach API server. Check your network connection or VPN and try again.');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 401) {
    throw new ChimeraAuthError();
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

async function requestStream(method: string, urlPath: string, body?: unknown, credentialsFile?: string): Promise<Response> {
  const url = getUrlForPath(urlPath);

  const headers = await getAuthHeaders(credentialsFile);
  headers['Accept'] = 'text/event-stream';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err.name === 'AbortError') throw new ChimeraTimeoutError();
    if (isOfflineError(err)) throw new Error('Cannot reach API server. Check your network connection or VPN and try again.');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 401) {
    throw new ChimeraAuthError();
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response;
}

export const apiClient = {
  get<T = unknown>(urlPath: string, credentialsFile?: string): Promise<T> {
    return request<T>('GET', urlPath, undefined, credentialsFile);
  },
  post<T = unknown>(urlPath: string, body?: unknown, credentialsFile?: string): Promise<T> {
    return request<T>('POST', urlPath, body, credentialsFile);
  },
  delete<T = unknown>(urlPath: string, credentialsFile?: string): Promise<T> {
    return request<T>('DELETE', urlPath, undefined, credentialsFile);
  },
  getStream(urlPath: string, credentialsFile?: string): Promise<Response> {
    return requestStream('GET', urlPath, undefined, credentialsFile);
  },
  postStream(urlPath: string, body?: unknown, credentialsFile?: string): Promise<Response> {
    return requestStream('POST', urlPath, body, credentialsFile);
  },
};
