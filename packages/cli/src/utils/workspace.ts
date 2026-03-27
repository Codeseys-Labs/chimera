/**
 * Workspace-local configuration management via chimera.toml (ADR-030)
 *
 * Reads workspace configuration from chimera.toml, walking up the directory
 * tree like package.json. chimera.toml is the single source of truth — no
 * fallback to ~/.chimera/config.json (removed per ADR-030).
 *
 * Credentials (Docker Hub tokens, auth tokens) belong in ~/.chimera/credentials,
 * NOT in chimera.toml.
 */

import * as fs from 'fs';
import * as path from 'path';
import TOML from 'smol-toml';

export interface WorkspaceConfig {
  aws?: { profile?: string; region?: string };
  workspace?: { name?: string; environment?: string; repository?: string };
  deployment?: {
    account_id?: string;
    status?: string;
    last_deployed?: string;
    source_commit?: string;
    codecommit_commit?: string;
  };
  endpoints?: {
    api_url?: string;
    websocket_url?: string;
    cognito_user_pool_id?: string;
    cognito_client_id?: string;
    cognito_domain?: string;
  };
  tenants?: {
    default_tier?: string;
    max_tenants?: number;
  };
  auth?: {
    cognito_domain?: string;
    callback_url?: string;
    admin_email?: string;
  };
  /** Docker Hub credentials — DEPRECATED in chimera.toml; move to ~/.chimera/credentials */
  docker?: {
    username?: string;
    token?: string;
  };
}

export interface CredentialsConfig {
  docker?: {
    username?: string;
    token?: string;
  };
  auth?: {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_at?: string;
  };
  admin?: {
    password?: string;
  };
}

const TOML_FILENAME = 'chimera.toml';
const CREDENTIALS_FILE = path.join(
  process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~',
  '.chimera',
  'credentials',
);

/**
 * Walk up from startDir looking for chimera.toml.
 * Returns absolute path to chimera.toml or null if not found.
 */
export function findWorkspaceConfig(startDir?: string): string | null {
  let current = path.resolve(startDir ?? process.cwd());
  let parent = path.dirname(current);

  while (parent !== current) {
    const candidate = path.join(current, TOML_FILENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    current = parent;
    parent = path.dirname(current);
  }

  // Check the final root directory
  const rootCandidate = path.join(current, TOML_FILENAME);
  if (fs.existsSync(rootCandidate)) {
    return rootCandidate;
  }

  return null;
}

/**
 * Load workspace configuration from chimera.toml.
 * Returns {} when no chimera.toml is found (no legacy JSON fallback — ADR-030).
 */
export function loadWorkspaceConfig(startDir?: string): WorkspaceConfig {
  const tomlPath = findWorkspaceConfig(startDir);

  if (tomlPath) {
    try {
      const raw = fs.readFileSync(tomlPath, 'utf8');
      return TOML.parse(raw) as WorkspaceConfig;
    } catch {
      return {};
    }
  }

  return {};
}

/**
 * Save workspace configuration to chimera.toml.
 * Writes to: dir/chimera.toml, or existing chimera.toml location, or cwd/chimera.toml.
 */
export function saveWorkspaceConfig(config: WorkspaceConfig, dir?: string): void {
  let targetPath: string;

  if (dir) {
    targetPath = path.join(path.resolve(dir), TOML_FILENAME);
  } else {
    targetPath = findWorkspaceConfig() ?? path.join(process.cwd(), TOML_FILENAME);
  }

  fs.writeFileSync(targetPath, TOML.stringify(config as Parameters<typeof TOML.stringify>[0]), 'utf8');
}

/**
 * Load credentials from ~/.chimera/credentials (TOML format).
 * Returns {} when the file does not exist.
 */
export function loadCredentials(): CredentialsConfig {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    return TOML.parse(raw) as CredentialsConfig;
  } catch {
    return {};
  }
}

/**
 * Save credentials to ~/.chimera/credentials (TOML format, mode 0600).
 * Ensures the ~/.chimera directory exists before writing.
 */
export function saveCredentials(credentials: CredentialsConfig): void {
  const credDir = path.dirname(CREDENTIALS_FILE);
  if (!fs.existsSync(credDir)) {
    fs.mkdirSync(credDir, { recursive: true });
  }
  const content = TOML.stringify(credentials as Parameters<typeof TOML.stringify>[0]);
  fs.writeFileSync(CREDENTIALS_FILE, content, { encoding: 'utf8', mode: 0o600 });
}
