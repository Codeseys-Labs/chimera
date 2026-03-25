/**
 * Workspace-local configuration management via chimera.toml
 *
 * Reads workspace configuration from chimera.toml, walking up the directory
 * tree like package.json. Falls back to ~/.chimera/config.json for backward
 * compatibility when no chimera.toml is found.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import TOML from 'smol-toml';

export interface WorkspaceConfig {
  aws?: { profile?: string; region?: string };
  workspace?: { environment?: string; repository?: string };
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
  };
}

const TOML_FILENAME = 'chimera.toml';
const LEGACY_CONFIG_FILE = path.join(os.homedir(), '.chimera', 'config.json');

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
 * Load workspace configuration.
 * Priority: chimera.toml (walk up from startDir) > ~/.chimera/config.json > {}
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

  // Fall back to legacy ~/.chimera/config.json
  if (fs.existsSync(LEGACY_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(LEGACY_CONFIG_FILE, 'utf8');
      const legacy = JSON.parse(raw) as Record<string, unknown>;
      return mapLegacyConfig(legacy);
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
 * Map legacy ~/.chimera/config.json fields to WorkspaceConfig shape.
 */
function mapLegacyConfig(legacy: Record<string, unknown>): WorkspaceConfig {
  const config: WorkspaceConfig = {};

  const awsProfile = legacy['awsProfile'] as string | undefined;
  const awsRegion = legacy['awsRegion'] as string | undefined;
  if (awsProfile !== undefined || awsRegion !== undefined) {
    config.aws = {};
    if (awsProfile !== undefined) config.aws.profile = awsProfile;
    if (awsRegion !== undefined) config.aws.region = awsRegion;
  }

  const dep = legacy['deployment'] as Record<string, unknown> | undefined;
  if (dep) {
    const repoName = dep['repositoryName'] as string | undefined;
    if (repoName !== undefined) {
      config.workspace = { repository: repoName };
    }

    const accountId = dep['accountId'] as string | undefined;
    const status = dep['status'] as string | undefined;
    const lastDeployed = dep['lastDeployed'] as string | undefined;

    if (accountId !== undefined || status !== undefined || lastDeployed !== undefined) {
      config.deployment = {};
      if (accountId !== undefined) config.deployment.account_id = accountId;
      if (status !== undefined) config.deployment.status = status;
      if (lastDeployed !== undefined) config.deployment.last_deployed = lastDeployed;
    }

    const apiUrl = dep['apiUrl'] as string | undefined;
    const webSocketUrl = dep['webSocketUrl'] as string | undefined;
    const cognitoUserPoolId = dep['cognitoUserPoolId'] as string | undefined;
    const cognitoClientId = dep['cognitoClientId'] as string | undefined;

    if (
      apiUrl !== undefined ||
      webSocketUrl !== undefined ||
      cognitoUserPoolId !== undefined ||
      cognitoClientId !== undefined
    ) {
      config.endpoints = {};
      if (apiUrl !== undefined) config.endpoints.api_url = apiUrl;
      if (webSocketUrl !== undefined) config.endpoints.websocket_url = webSocketUrl;
      if (cognitoUserPoolId !== undefined) config.endpoints.cognito_user_pool_id = cognitoUserPoolId;
      if (cognitoClientId !== undefined) config.endpoints.cognito_client_id = cognitoClientId;
    }
  }

  return config;
}
