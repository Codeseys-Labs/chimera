/**
 * Universal skill loader
 *
 * Implements the adapter pattern for loading skills from multiple sources:
 * - OpenClaw SKILL.md files
 * - MCP servers
 * - Strands @tool decorators
 * - Claude Code skills
 *
 * All skills are normalized to the unified SkillDefinition format
 */

import {
  SkillDefinition,
  SkillAdapter,
  ToolProvider,
  ToolSpec,
} from './types';

/**
 * Skill loader class
 * Coordinates skill adapters and tool providers
 */
export class SkillLoader {
  private adapters: Map<string, SkillAdapter> = new Map();
  private providers: Map<string, ToolProvider> = new Map();

  constructor() {
    // Adapters will be registered here
    // this.registerAdapter(new OpenClawAdapter());
    // this.registerAdapter(new MCPAdapter());
    // this.registerAdapter(new StrandsAdapter());
    // this.registerAdapter(new ClaudeCodeAdapter());
  }

  /**
   * Register a skill adapter
   */
  registerAdapter(adapter: SkillAdapter): void {
    this.adapters.set(adapter.sourcePlatform, adapter);
  }

  /**
   * Register a tool provider
   */
  registerProvider(name: string, provider: ToolProvider): void {
    this.providers.set(name, provider);
  }

  /**
   * Import skill from source format
   *
   * @param source - Skill source (file path, server config, etc.)
   * @param platform - Source platform identifier
   * @returns Normalized skill definition
   */
  async importSkill(
    source: unknown,
    platform: 'openclaw' | 'claude-code' | 'strands' | 'mcp'
  ): Promise<SkillDefinition> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new Error(`No adapter registered for platform: ${platform}`);
    }

    // Validate source format
    const isValid = await adapter.validate(source);
    if (!isValid) {
      throw new Error(`Invalid skill format for platform: ${platform}`);
    }

    // Import skill
    const skill = await adapter.importSkill(source);

    return skill;
  }

  /**
   * Export skill to target format
   *
   * @param skill - Unified skill definition
   * @param targetPlatform - Target platform identifier
   * @returns Exported skill in target format
   */
  async exportSkill(
    skill: SkillDefinition,
    targetPlatform: 'openclaw' | 'claude-code' | 'strands' | 'mcp'
  ): Promise<unknown> {
    const adapter = this.adapters.get(targetPlatform);
    if (!adapter) {
      throw new Error(`No adapter registered for platform: ${targetPlatform}`);
    }

    return adapter.exportSkill(skill);
  }

  /**
   * Load skill and create tool provider
   *
   * @param skill - Skill definition
   * @returns Tool provider for the skill
   */
  async loadSkillProvider(skill: SkillDefinition): Promise<ToolProvider> {
    // Determine provider type based on implementation
    if (skill.implementation.type === 'mcp_server' && skill.implementation.mcpServer) {
      // Create MCP tool provider
      return this.createMCPProvider(skill);
    } else if (skill.implementation.type === 'instruction') {
      // Create instruction-based provider
      return this.createInstructionProvider(skill);
    } else if (skill.implementation.type === 'hybrid') {
      // Create hybrid provider (instructions + MCP)
      return this.createHybridProvider(skill);
    }

    throw new Error(`Unsupported implementation type: ${skill.implementation.type}`);
  }

  /**
   * Create MCP tool provider
   * Private implementation
   */
  private async createMCPProvider(skill: SkillDefinition): Promise<ToolProvider> {
    // TODO: Implement MCP provider creation
    // Will connect to MCP server via stdio/http/sse
    throw new Error('MCP provider creation not yet implemented');
  }

  /**
   * Create instruction-based provider
   * Private implementation
   */
  private async createInstructionProvider(skill: SkillDefinition): Promise<ToolProvider> {
    // TODO: Implement instruction provider
    // Will inject instructions into system prompt
    throw new Error('Instruction provider creation not yet implemented');
  }

  /**
   * Create hybrid provider (instructions + MCP tools)
   * Private implementation
   */
  private async createHybridProvider(skill: SkillDefinition): Promise<ToolProvider> {
    // TODO: Implement hybrid provider
    // Combines instructions with MCP tools
    throw new Error('Hybrid provider creation not yet implemented');
  }

  /**
   * List all tools from a skill
   *
   * @param skill - Skill definition
   * @returns Array of tool specifications
   */
  async listSkillTools(skill: SkillDefinition): Promise<ToolSpec[]> {
    if (skill.implementation.type === 'instruction') {
      // Instruction-only skills don't expose programmatic tools
      return [];
    }

    if (skill.implementation.mcpServer) {
      return skill.implementation.mcpServer.tools;
    }

    return [];
  }

  /**
   * Validate skill permissions
   * Checks if declared permissions are valid
   *
   * @param skill - Skill definition
   * @returns Validation result
   */
  validateSkillPermissions(skill: SkillDefinition): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!skill.permissions) {
      // No permissions declared - warning but not error
      return { valid: true, errors: [] };
    }

    // Validate filesystem permissions
    if (skill.permissions.filesystem) {
      const { read, write } = skill.permissions.filesystem;

      // Check for dangerous patterns
      if (read && read.some(pattern => pattern === '**' || pattern === '**/*')) {
        errors.push('Filesystem read permission: wildcards too broad (use specific patterns)');
      }

      if (write && write.some(pattern => pattern === '/' || pattern === '/*')) {
        errors.push('Filesystem write permission: root write not allowed');
      }
    }

    // Validate shell permissions
    if (skill.permissions.shell) {
      const { allowed, denied } = skill.permissions.shell;

      // Check for dangerous commands
      const dangerousCommands = ['rm -rf', 'dd', 'mkfs', 'format'];
      if (allowed) {
        const dangerous = allowed.filter(cmd =>
          dangerousCommands.some(d => cmd.includes(d))
        );
        if (dangerous.length > 0) {
          errors.push(`Shell permission: dangerous commands detected: ${dangerous.join(', ')}`);
        }
      }
    }

    // Validate secrets permissions
    if (skill.permissions.secrets && skill.permissions.secrets.length > 0) {
      // Secrets must be ARN format
      const arnPattern = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;
      const invalidArns = skill.permissions.secrets.filter(arn => !arnPattern.test(arn));
      if (invalidArns.length > 0) {
        errors.push(`Secrets permission: invalid ARN format: ${invalidArns.join(', ')}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get all registered adapters
   */
  getAdapters(): SkillAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Get all registered providers
   */
  getProviders(): ToolProvider[] {
    return Array.from(this.providers.values());
  }
}

/**
 * Global skill loader instance
 */
export const skillLoader = new SkillLoader();
