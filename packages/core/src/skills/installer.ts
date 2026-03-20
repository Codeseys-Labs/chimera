/**
 * Skill Installer Service
 *
 * Handles skill installation, updates, and uninstallation
 * Integrates with registry, validator, and MCP Gateway
 */

import {
  InstallSkillRequest,
  InstallSkillResponse,
  UninstallSkillRequest,
  SkillInstall,
  Skill,
} from '@chimera/shared';
import { SkillRegistry } from './registry';
import { SkillValidator } from './validator';
import { MCPGatewayClient } from './mcp-gateway-client';

/**
 * S3 client interface (placeholder for AWS SDK)
 */
export interface S3Client {
  getObject(params: any): Promise<{ Body: Buffer }>;
  putObject(params: any): Promise<any>;
  deleteObject(params: any): Promise<any>;
}

/**
 * Installer configuration
 */
export interface InstallerConfig {
  /** Skill registry */
  registry: SkillRegistry;

  /** Skill validator */
  validator: SkillValidator;

  /** MCP Gateway client */
  mcpGateway: MCPGatewayClient;

  /** S3 client */
  s3: S3Client;

  /** S3 bucket for skill bundles */
  bundleBucket: string;
}

/**
 * Skill Installer Service
 */
export class SkillInstaller {
  private config: InstallerConfig;

  constructor(config: InstallerConfig) {
    this.config = config;
  }

  /**
   * Install a skill for a tenant
   *
   * Workflow:
   * 1. Check if already installed
   * 2. Get skill metadata from registry
   * 3. Validate skill permissions
   * 4. Download skill bundle from S3
   * 5. Register with MCP Gateway (if skill provides tools)
   * 6. Record installation in registry
   *
   * @param request - Install request
   * @returns Install response
   */
  async install(request: InstallSkillRequest): Promise<InstallSkillResponse> {
    const { tenant_id, skill_name, version, installed_by } = request;

    try {
      // Check if already installed
      const existing = await this.config.registry.getSkillInstall(
        tenant_id,
        skill_name
      );

      if (existing) {
        return {
          skill_name,
          version: existing.version,
          installed_at: existing.installed_at,
          status: 'error',
          message: `Skill ${skill_name} is already installed (version ${existing.version})`,
        };
      }

      // Get skill metadata
      const skill = await this.config.registry.getSkill(skill_name, version);

      if (!skill) {
        return {
          skill_name,
          version: version || 'latest',
          installed_at: new Date().toISOString(),
          status: 'error',
          message: `Skill ${skill_name} not found in marketplace`,
        };
      }

      // Validate skill security and permissions
      const validation = await this.config.validator.validateSkill(skill);

      if (!validation.valid) {
        return {
          skill_name,
          version: skill.version,
          installed_at: new Date().toISOString(),
          status: 'error',
          message: `Skill validation failed: ${validation.errors.join(', ')}`,
        };
      }

      // Download skill bundle (placeholder - would verify signature here)
      await this.downloadBundle(skill);

      // Register with MCP Gateway if skill provides tools
      // TODO: Parse SKILL.md from bundle to get mcp_server config
      // For now, assume it's stored in skill metadata
      // await this.registerWithGateway(tenant_id, skill);

      // Record installation
      const install: SkillInstall = {
        PK: `TENANT#${tenant_id}`,
        SK: `SKILL#${skill_name}`,
        tenant_id,
        skill_name,
        version: skill.version,
        pinned: request.pinned || false,
        installed_at: new Date().toISOString(),
        installed_by,
        auto_update: request.auto_update || false,
        use_count: 0,
      };

      await this.config.registry.recordInstall(install);

      return {
        skill_name,
        version: skill.version,
        installed_at: install.installed_at,
        status: 'success',
        message: `Skill ${skill_name}@${skill.version} installed successfully`,
      };
    } catch (error: any) {
      return {
        skill_name,
        version: version || 'latest',
        installed_at: new Date().toISOString(),
        status: 'error',
        message: `Installation failed: ${error.message}`,
      };
    }
  }

  /**
   * Uninstall a skill for a tenant
   *
   * Workflow:
   * 1. Check if skill is installed
   * 2. Unregister from MCP Gateway
   * 3. Remove installation record
   * 4. Clean up local artifacts
   *
   * @param request - Uninstall request
   */
  async uninstall(request: UninstallSkillRequest): Promise<void> {
    const { tenant_id, skill_name } = request;

    // Check if installed
    const install = await this.config.registry.getSkillInstall(
      tenant_id,
      skill_name
    );

    if (!install) {
      throw new Error(`Skill ${skill_name} is not installed`);
    }

    // Unregister from MCP Gateway
    await this.config.mcpGateway.unregister(tenant_id, skill_name);

    // Remove installation record
    await this.config.registry.removeInstall(tenant_id, skill_name);
  }

  /**
   * Update a skill to latest version (if auto_update enabled)
   *
   * @param tenantId - Tenant identifier
   * @param skillName - Skill name
   */
  async update(tenantId: string, skillName: string): Promise<void> {
    const install = await this.config.registry.getSkillInstall(
      tenantId,
      skillName
    );

    if (!install) {
      throw new Error(`Skill ${skillName} is not installed`);
    }

    if (install.pinned) {
      throw new Error(`Skill ${skillName} is pinned to version ${install.version}`);
    }

    // Get latest version
    const versions = await this.config.registry.listVersions(skillName);
    if (versions.length === 0) {
      throw new Error(`No versions found for skill ${skillName}`);
    }

    // Sort by version (descending)
    const latest = versions.sort((a, b) => b.version.localeCompare(a.version))[0];

    if (latest.version === install.version) {
      // Already on latest
      return;
    }

    // Uninstall current version
    await this.uninstall({ tenant_id: tenantId, skill_name: skillName });

    // Install latest version
    await this.install({
      tenant_id: tenantId,
      skill_name: skillName,
      version: latest.version,
      installed_by: install.installed_by,
      pinned: false,
      auto_update: install.auto_update,
    });
  }

  /**
   * Check for available updates
   *
   * @param tenantId - Tenant identifier
   * @returns Array of skills with available updates
   */
  async checkUpdates(
    tenantId: string
  ): Promise<Array<{ skill_name: string; current: string; latest: string }>> {
    const installs = await this.config.registry.getInstalledSkills(tenantId);
    const updates: Array<{ skill_name: string; current: string; latest: string }> = [];

    for (const install of installs) {
      if (install.pinned) {
        continue;
      }

      const versions = await this.config.registry.listVersions(install.skill_name);
      if (versions.length === 0) {
        continue;
      }

      const latest = versions.sort((a, b) => b.version.localeCompare(a.version))[0];

      if (latest.version !== install.version) {
        updates.push({
          skill_name: install.skill_name,
          current: install.version,
          latest: latest.version,
        });
      }
    }

    return updates;
  }

  /**
   * Download skill bundle from S3 (private helper)
   */
  private async downloadBundle(skill: Skill): Promise<Buffer> {
    const params = {
      Bucket: this.config.bundleBucket,
      Key: skill.bundle.s3_key,
    };

    const result = await this.config.s3.getObject(params);
    return result.Body;
  }

  /**
   * Register skill with MCP Gateway (private helper)
   */
  private async registerWithGateway(tenantId: string, skill: Skill): Promise<void> {
    // TODO: Extract mcp_server config from SKILL.md
    // For now, this is a placeholder
    // await this.config.mcpGateway.register({
    //   tenant_id: tenantId,
    //   skill_name: skill.name,
    //   mcp_config: skill.mcp_server,
    //   permissions: skill.permissions,
    //   trust_level: skill.trust_level,
    // });
  }
}
