/**
 * Configuration management utilities
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ChimeraConfig {
  currentTenant: string | null;
  tenants?: TenantConfigEntry[];
  awsRegion?: string;
  awsProfile?: string;
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
 */
export function loadConfig(): ChimeraConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { currentTenant: null };
    }

    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // Return default config on error
    return { currentTenant: null };
  }
}

/**
 * Save Chimera CLI configuration to ~/.chimera/config.json
 */
export function saveConfig(config: ChimeraConfig): void {
  try {
    // Ensure config directory exists
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    throw new Error(`Failed to save config: ${error}`);
  }
}

/**
 * Get current tenant from config
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
