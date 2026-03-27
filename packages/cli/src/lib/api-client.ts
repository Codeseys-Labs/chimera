/**
 * Chimera API client
 *
 * - Reads auth token from ~/.chimera/credentials
 * - Sets Authorization: Bearer <token> header
 * - Base URL from chimera.toml [api] section
 * - Throws ChimeraAuthError on 401 (triggers re-auth prompt)
 */

import { loadWorkspaceConfig } from '../utils/workspace.js';
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

export async function loadCredentials(filePath = DEFAULT_CREDENTIALS_FILE): Promise<Credentials | null> {
  try {
    const exists = await Bun.file(filePath).exists();
    if (!exists) return null;
    return await Bun.file(filePath).json() as Credentials;
  } catch {
    return null;
  }
}

function getBaseUrl(): string {
  // WorkspaceConfig doesn't declare [api] yet — read it via index access
  const config = loadWorkspaceConfig() as Record<string, unknown>;
  const api = config.api as { base_url?: string } | undefined;
  return api?.base_url ?? '';
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const creds = await loadCredentials();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (creds) {
    if (new Date(creds.expiresAt) <= new Date()) {
      throw new ChimeraAuthError('Token expired. Run "chimera login" again.');
    }
    headers['Authorization'] = `Bearer ${creds.accessToken}`;
  }
  return headers;
}

async function request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new Error(
      'API base URL not configured. Run "chimera connect" to set endpoints, then add [api] base_url to chimera.toml.',
    );
  }

  const headers = await getAuthHeaders();

  const response = await fetch(`${baseUrl}${urlPath}`, {
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

async function requestStream(method: string, urlPath: string, body?: unknown): Promise<Response> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new Error(
      'API base URL not configured. Run "chimera connect" to set endpoints, then add [api] base_url to chimera.toml.',
    );
  }

  const headers = await getAuthHeaders();
  headers['Accept'] = 'text/event-stream';

  const response = await fetch(`${baseUrl}${urlPath}`, {
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
  get<T = unknown>(urlPath: string): Promise<T> {
    return request<T>('GET', urlPath);
  },
  post<T = unknown>(urlPath: string, body?: unknown): Promise<T> {
    return request<T>('POST', urlPath, body);
  },
  delete<T = unknown>(urlPath: string): Promise<T> {
    return request<T>('DELETE', urlPath);
  },
  getStream(urlPath: string): Promise<Response> {
    return requestStream('GET', urlPath);
  },
  postStream(urlPath: string, body?: unknown): Promise<Response> {
    return requestStream('POST', urlPath, body);
  },
};
