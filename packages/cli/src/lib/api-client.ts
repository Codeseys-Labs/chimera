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
  const baseUrl = getBaseUrl();
  const url = baseUrl ? `${baseUrl}${urlPath}` : urlPath;

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
  const baseUrl = getBaseUrl();
  const url = baseUrl ? `${baseUrl}${urlPath}` : urlPath;

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
