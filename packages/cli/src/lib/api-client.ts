/**
 * Chimera API client
 *
 * Reads auth tokens from ~/.chimera/credentials, sets Authorization header,
 * reads base URL from chimera.toml [endpoints] api_url.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadWorkspaceConfig, type WorkspaceConfig } from '../utils/workspace';

export const DEFAULT_CREDENTIALS_FILE = path.join(os.homedir(), '.chimera', 'credentials');

export interface Credentials {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresAt: string;
}

export class ChimeraAuthError extends Error {
  constructor(message = 'Authentication required. Run `chimera login`.') {
    super(message);
    this.name = 'ChimeraAuthError';
  }
}

export async function loadCredentials(filePath = DEFAULT_CREDENTIALS_FILE): Promise<Credentials | null> {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

export function getBaseUrl(config?: WorkspaceConfig): string {
  const cfg = config ?? loadWorkspaceConfig();
  return cfg.endpoints?.api_url ?? '';
}

async function getAuthHeader(credFile?: string): Promise<string> {
  const creds = await loadCredentials(credFile);
  if (!creds) {
    throw new ChimeraAuthError();
  }
  if (new Date(creds.expiresAt) <= new Date()) {
    throw new ChimeraAuthError('Token expired. Run `chimera login` again.');
  }
  return `Bearer ${creds.accessToken}`;
}

function handleAuthError(status: number): void {
  if (status === 401) throw new ChimeraAuthError();
}

async function requireOk(res: Response): Promise<void> {
  handleAuthError(res.status);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
}

export const apiClient = {
  async get<T = unknown>(endpoint: string, credFile?: string): Promise<T> {
    const auth = await getAuthHeader(credFile);
    const res = await fetch(`${getBaseUrl()}${endpoint}`, {
      headers: { Authorization: auth },
    });
    await requireOk(res);
    return res.json() as Promise<T>;
  },

  async post<T = unknown>(endpoint: string, body: unknown, credFile?: string): Promise<T> {
    const auth = await getAuthHeader(credFile);
    const res = await fetch(`${getBaseUrl()}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await requireOk(res);
    return res.json() as Promise<T>;
  },

  async getStream(endpoint: string, credFile?: string): Promise<Response> {
    const auth = await getAuthHeader(credFile);
    const res = await fetch(`${getBaseUrl()}${endpoint}`, {
      headers: { Authorization: auth, Accept: 'text/event-stream' },
    });
    handleAuthError(res.status);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
    return res;
  },

  async postStream(endpoint: string, body: unknown, credFile?: string): Promise<Response> {
    const auth = await getAuthHeader(credFile);
    const res = await fetch(`${getBaseUrl()}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
    handleAuthError(res.status);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
    return res;
  },
};
