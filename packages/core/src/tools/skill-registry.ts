/**
 * Skill registry for tenant skill management
 *
 * Manages installed skills, tool providers, and skill lifecycle
 * with tenant isolation
 */

import {
  SkillDefinition,
  SkillRegistryConfig,
  ToolProvider,
  ToolSpec,
} from './types';
import { SkillLoader } from './skill-loader';

/**
 * Skill registry
 * Per-tenant registry of installed skills and active tool providers
 */
export class SkillRegistry {
  private config: SkillRegistryConfig;
  private skills: Map<string, SkillDefinition> = new Map();
  private providers: Map<string, ToolProvider> = new Map();
  private loader: SkillLoader;

  constructor(config: SkillRegistryConfig, loader?: SkillLoader) {
    this.config = config;
    this.loader = loader || new SkillLoader();
  }

  /**
   * Install a skill
   *
   * @param skill - Skill definition to install
   * @returns Installed skill name
   */
  async installSkill(skill: SkillDefinition): Promise<string> {
    const skillKey = `${skill.name}@${skill.version}`;

    // Check if skill already installed
    if (this.skills.has(skillKey)) {
      throw new Error(`Skill already installed: ${skillKey}`);
    }

    // Validate skill permissions
    const validation = this.loader.validateSkillPermissions(skill);
    if (!validation.valid) {
      throw new Error(
        `Skill permission validation failed:\n${validation.errors.join('\n')}`
      );
    }

    // Install skill
    this.skills.set(skillKey, skill);

    // Create and initialize tool provider (if applicable)
    if (skill.implementation.type !== 'instruction') {
      const provider = await this.loader.loadSkillProvider(skill);
      await provider.initialize();
      this.providers.set(skillKey, provider);
    }

    // Persist to storage
    await this.persistSkill(skill);

    return skillKey;
  }

  /**
   * Uninstall a skill
   *
   * @param skillName - Skill name
   * @param version - Skill version (optional, uninstalls latest if not specified)
   */
  async uninstallSkill(skillName: string, version?: string): Promise<void> {
    let skillKey: string;

    if (version) {
      skillKey = `${skillName}@${version}`;
    } else {
      // Find latest version
      const versions = Array.from(this.skills.keys())
        .filter(key => key.startsWith(`${skillName}@`))
        .sort()
        .reverse();

      if (versions.length === 0) {
        throw new Error(`Skill not found: ${skillName}`);
      }

      skillKey = versions[0];
    }

    // Cleanup tool provider
    const provider = this.providers.get(skillKey);
    if (provider) {
      await provider.cleanup();
      this.providers.delete(skillKey);
    }

    // Remove skill
    this.skills.delete(skillKey);

    // Remove from storage
    await this.removeSkill(skillKey);
  }

  /**
   * Get installed skill
   *
   * @param skillName - Skill name
   * @param version - Skill version (optional)
   * @returns Skill definition or undefined
   */
  getSkill(skillName: string, version?: string): SkillDefinition | undefined {
    if (version) {
      return this.skills.get(`${skillName}@${version}`);
    }

    // Get latest version
    const versions = Array.from(this.skills.entries())
      .filter(([key]) => key.startsWith(`${skillName}@`))
      .sort(([a], [b]) => b.localeCompare(a)); // Sort descending

    return versions[0]?.[1];
  }

  /**
   * List all installed skills
   *
   * @returns Array of skill definitions
   */
  listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * List all available tools (from all installed skills)
   *
   * @returns Array of tool specifications
   */
  async listAllTools(): Promise<ToolSpec[]> {
    const allTools: ToolSpec[] = [];

    for (const skill of this.skills.values()) {
      const tools = await this.loader.listSkillTools(skill);
      allTools.push(...tools);
    }

    return allTools;
  }

  /**
   * Get tool provider for a skill
   *
   * @param skillName - Skill name
   * @param version - Skill version (optional)
   * @returns Tool provider or undefined
   */
  getProvider(skillName: string, version?: string): ToolProvider | undefined {
    const skillKey = version ? `${skillName}@${version}` : this.findLatestSkillKey(skillName);
    if (!skillKey) return undefined;

    return this.providers.get(skillKey);
  }

  /**
   * Update skill enabled status
   *
   * @param skillName - Skill name
   * @param enabled - Whether skill is enabled
   */
  async enableSkill(skillName: string, enabled: boolean): Promise<void> {
    const skill = this.getSkill(skillName);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    // Update in-memory state
    // (Note: SkillDefinition doesn't have enabled field, would need to add to type)

    // Persist change
    await this.persistSkill(skill);
  }

  /**
   * Search skills by query
   *
   * @param query - Search query
   * @returns Matching skills
   */
  searchSkills(query: string): SkillDefinition[] {
    const lowerQuery = query.toLowerCase();

    return Array.from(this.skills.values()).filter(skill => {
      return (
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery) ||
        skill.author.toLowerCase().includes(lowerQuery)
      );
    });
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    totalSkills: number;
    activeProviders: number;
    byTrustLevel: Record<string, number>;
    byFormat: Record<string, number>;
  } {
    const stats = {
      totalSkills: this.skills.size,
      activeProviders: this.providers.size,
      byTrustLevel: {} as Record<string, number>,
      byFormat: {} as Record<string, number>,
    };

    for (const skill of this.skills.values()) {
      stats.byTrustLevel[skill.trustLevel] = (stats.byTrustLevel[skill.trustLevel] || 0) + 1;
      stats.byFormat[skill.format] = (stats.byFormat[skill.format] || 0) + 1;
    }

    return stats;
  }

  /**
   * Cleanup all providers
   * Called on shutdown
   */
  async cleanup(): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.cleanup();
    }

    this.providers.clear();
  }

  /**
   * Persist skill to storage
   * Private implementation
   */
  private async persistSkill(skill: SkillDefinition): Promise<void> {
    // TODO: Implement persistence based on storage backend
    // - DynamoDB: Write to clawcore-skills table
    // - File: Write JSON to file
    // - Memory: No-op (already in memory)
  }

  /**
   * Remove skill from storage
   * Private implementation
   */
  private async removeSkill(skillKey: string): Promise<void> {
    // TODO: Implement removal based on storage backend
  }

  /**
   * Find latest skill key for a skill name
   * Private helper
   */
  private findLatestSkillKey(skillName: string): string | undefined {
    const versions = Array.from(this.skills.keys())
      .filter(key => key.startsWith(`${skillName}@`))
      .sort()
      .reverse();

    return versions[0];
  }
}
