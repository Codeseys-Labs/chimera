/**
 * Chimera API client
 *
 * - Reads auth token from ~/.chimera/credentials
 * - Sets Authorization: Bearer <token> header
 * - Base URL from workspace config endpoints.api_url
 * - Throws ChimeraAuthError on 401 or missing credentials
 */

import { loadWorkspaceConfig } from '../utils/workspace.js';
import * as path from 'path';
import * as os from 'os';
import TOML from 'smol-toml';

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

export async function loadCredentials(filePath = DEFAULT_CREDENTIALS_FILE): Promise<Credentials | null> {
  try {
    const exists = await Bun.file(filePath).exists();
    if (!exists) return null;
    const raw = await Bun.file(filePath).text();

    // Try flat JSON format first (camelCase keys — written by older login.ts versions)
    try {
      const json = JSON.parse(raw) as Credentials;
      if (json.accessToken) return json;
    } catch {
      // Not JSON — fall through to TOML
    }

    // Try TOML format (written by workspace.ts saveCredentials — [auth] section, snake_case keys)
    const parsed = TOML.parse(raw) as {
      auth?: { access_token?: string; id_token?: string; refresh_token?: string; expires_at?: string };
    };
    if (parsed.auth?.access_token) {
      return {
        accessToken: parsed.auth.access_token,
        idToken: parsed.auth.id_token ?? '',
        refreshToken: parsed.auth.refresh_token ?? '',
        expiresAt: parsed.auth.expires_at ?? '',
      };
    }

    return null;
  } catch {
    return null;
  }
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
  const creds = await loadCredentials(credentialsFile);
  if (!creds) {
    throw new ChimeraAuthError();
  }
  if (new Date(creds.expiresAt) <= new Date()) {
    throw new ChimeraAuthError('Token expired. Run "chimera login" again.');
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${creds.accessToken}`,
  };
}

async function request<T>(method: string, urlPath: string, body?: unknown, credentialsFile?: string): Promise<T> {
  const url = getUrlForPath(urlPath);

  const headers = await getAuthHeaders(credentialsFile);

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

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

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

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
