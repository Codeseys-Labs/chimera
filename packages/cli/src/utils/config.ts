/**
 * Configuration management utilities
 *
 * @deprecated These utilities read from ~/.chimera/config.json (legacy JSON format).
 * Migrate command callers to loadWorkspaceConfig() / saveWorkspaceConfig() in
 * workspace.ts (chimera.toml, ADR-030). Once all callers are migrated, this
 * module will be deleted.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DeploymentConfig {
  accountId: string;
  region: string;
  repositoryName: string;
  apiUrl?: string;
  webSocketUrl?: string;
  cognitoUserPoolId?: string;
  cognitoClientId?: string;
  status: 'deploying' | 'deployed' | 'failed';
  lastDeployed?: string;
}

export interface ChimeraConfig {
  currentTenant: string | null;
  tenants?: TenantConfigEntry[];
  awsRegion?: string;
  awsProfile?: string;
  deployment?: DeploymentConfig;
}

export interface TenantConfigEntry {
  tenantId: string;
  name: string;
  tier: string;
  region: string;
  status: string;
  createdAt: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.chimera');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Load Chimera CLI configuration from ~/.chimera/config.json
 * @deprecated Migrate to loadWorkspaceConfig() from workspace.ts (ADR-030)
 */
export function loadConfig(): ChimeraConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { currentTenant: null };
    }

    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { currentTenant: null };
  }
}

/**
 * Save Chimera CLI configuration to ~/.chimera/config.json
 * @deprecated Migrate to saveWorkspaceConfig() from workspace.ts (ADR-030)
 */
export function saveConfig(config: ChimeraConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    throw new Error(`Failed to save config: ${err}`);
  }
}

/**
 * Get current tenant from config
 * @deprecated Migrate callers to use loadWorkspaceConfig() (ADR-030)
 */
export function getCurrentTenant(): TenantConfigEntry | null {
  const config = loadConfig();

  if (!config.currentTenant || !config.tenants) {
    return null;
  }

  return config.tenants.find((t) => t.tenantId === config.currentTenant) || null;
}

/**
 * Clear all configuration (for testing)
 */
export function clearConfig(): void {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
  }
}
