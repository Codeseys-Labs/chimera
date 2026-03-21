/**
 * Skill Bridge - Connects SKILL.md registry to Strands agent
 *
 * Loads skills from registry and converts them into tools that can be used by ChimeraAgent.
 * Handles both instruction-based skills (prompt injection) and MCP-based skills (tool calling).
 *
 * Architecture:
 * 1. Load skill definitions from registry (by name or all installed)
 * 2. Parse SKILL.md content using parser
 * 3. Convert to Strands agent tools (loadedTools format)
 * 4. Inject into agent configuration
 */

import { parseSkillMd, validateSkill } from './parser';
import { SkillRegistry } from './registry';
import { SystemPromptTemplate } from '../agent/prompt';
import type { SkillDefinition } from '../tools/types';
import type { AgentConfig } from '../agent/agent';

/**
 * Skill loading options
 */
export interface SkillLoadOptions {
  /** Tenant ID for skill lookup */
  tenantId: string;

  /** Skill names to load (if not specified, loads all installed skills) */
  skillNames?: string[];

  /** Skip validation (not recommended) */
  skipValidation?: boolean;

  /** Skill registry instance */
  registry: SkillRegistry;
}

/**
 * Skill loading result
 */
export interface SkillLoadResult {
  /** Successfully loaded skills */
  loaded: SkillDefinition[];

  /** Failed skills with error messages */
  failed: Array<{
    skillName: string;
    error: string;
  }>;

  /** Warnings (non-fatal issues) */
  warnings: string[];
}

/**
 * Loaded tool specification for agent
 */
export interface LoadedTool {
  name: string;
  description: string;
  inputSchema: any;
  callback: (input: any) => Promise<string>;
}

/**
 * Load skills and prepare them for agent use
 *
 * @param options - Skill loading options
 * @returns Skill loading result with loaded skills
 */
export async function loadSkills(
  options: SkillLoadOptions
): Promise<SkillLoadResult> {
  const { tenantId, skillNames, skipValidation, registry } = options;
  const loaded: SkillDefinition[] = [];
  const failed: Array<{ skillName: string; error: string }> = [];
  const warnings: string[] = [];

  // Get skill names to load
  const installedSkills = skillNames
    ? skillNames
    : (await registry.getInstalledSkills(tenantId)).map(install => install.skill_name);

  // Load each skill
  for (const skillName of installedSkills) {
    try {
      // Get skill from registry
      const skill = await registry.getSkill(skillName);

      if (!skill) {
        failed.push({
          skillName,
          error: 'Skill not found in registry',
        });
        continue;
      }

      // Get skill bundle content (SKILL.md file)
      // TODO: Implement S3 content fetching in SkillRegistry
      // For now, we assume the skill bundle contains the raw SKILL.md content
      const content = `---
name: ${skill.name}
version: ${skill.version}
description: ${skill.description}
author: ${skill.author}
---

# ${skill.name}
Placeholder skill content. Actual content should be fetched from S3: ${skill.bundle.s3_key}
`;

      if (!content) {
        failed.push({
          skillName,
          error: 'Skill content not found',
        });
        continue;
      }

      // Parse SKILL.md
      const parseResult = await parseSkillMd(content, skill.bundle.s3_key);
      warnings.push(...parseResult.warnings);

      // Validate skill (unless skipped)
      if (!skipValidation) {
        const validation = validateSkill(parseResult.skill);
        if (!validation.valid) {
          failed.push({
            skillName,
            error: `Validation failed: ${validation.errors.join(', ')}`,
          });
          continue;
        }
        warnings.push(...validation.warnings);
      }

      loaded.push(parseResult.skill);
    } catch (error) {
      failed.push({
        skillName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { loaded, failed, warnings };
}

/**
 * Convert loaded skills into agent tools
 *
 * Instruction-based skills inject their content into system prompt.
 * MCP-based skills are converted to callable tools.
 *
 * @param skills - Loaded skill definitions
 * @returns Array of tools for agent + system prompt additions
 */
export function skillsToAgentTools(skills: SkillDefinition[]): {
  tools: LoadedTool[];
  promptAdditions: string;
} {
  const tools: LoadedTool[] = [];
  const promptParts: string[] = [];

  for (const skill of skills) {
    // Add instruction-based skills to prompt
    if (skill.implementation.type === 'instruction' || skill.implementation.type === 'hybrid') {
      if (skill.implementation.instructions) {
        promptParts.push(`\n## ${skill.name} Skill\n${skill.implementation.instructions}\n`);
      }
    }

    // Add MCP-based tools
    if (skill.implementation.type === 'mcp_server' || skill.implementation.type === 'hybrid') {
      if (skill.implementation.mcpServer?.tools) {
        for (const toolSpec of skill.implementation.mcpServer.tools) {
          tools.push({
            name: toolSpec.name,
            description: toolSpec.description,
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
            },
            callback: async (input: any) => {
              // TODO: Implement MCP tool invocation via MCPGatewayClient
              // For now, return placeholder
              return `[MCP Tool] ${toolSpec.name} called with input: ${JSON.stringify(input)}`;
            },
          });
        }
      }
    }
  }

  const promptAdditions = promptParts.length > 0
    ? `\n# Available Skills\n${promptParts.join('\n')}`
    : '';

  return { tools, promptAdditions };
}

/**
 * Inject skills into agent configuration
 *
 * Modifies agent config to include skill tools and prompt additions.
 *
 * @param config - Agent configuration
 * @param skills - Loaded skill definitions
 * @returns Modified agent configuration
 */
export function injectSkillsIntoAgent(
  config: AgentConfig,
  skills: SkillDefinition[]
): AgentConfig {
  const { tools, promptAdditions } = skillsToAgentTools(skills);

  // Modify system prompt to include skill instructions
  const originalPrompt = config.systemPrompt;
  const baseTemplate = originalPrompt.getRawTemplate();
  const enhancedTemplate = baseTemplate + promptAdditions;
  const enhancedPrompt = new SystemPromptTemplate(enhancedTemplate);

  // Add skill-based tools to loadedTools
  const existingTools = config.loadedTools || [];
  const allTools = [...existingTools, ...tools];

  return {
    ...config,
    systemPrompt: enhancedPrompt,
    loadedTools: allTools,
  };
}

/**
 * Load skills for agent by name
 *
 * Convenience function that combines loading and injection.
 *
 * @param tenantId - Tenant identifier
 * @param skillNames - Skill names to load
 * @param registry - Skill registry instance
 * @param agentConfig - Agent configuration to enhance
 * @returns Enhanced agent configuration + loading result
 */
export async function loadSkillsForAgent(
  tenantId: string,
  skillNames: string[],
  registry: SkillRegistry,
  agentConfig: AgentConfig
): Promise<{
  config: AgentConfig;
  result: SkillLoadResult;
}> {
  // Load skills from registry
  const result = await loadSkills({
    tenantId,
    skillNames,
    registry,
  });

  // Inject into agent config
  const enhancedConfig = injectSkillsIntoAgent(agentConfig, result.loaded);

  return { config: enhancedConfig, result };
}

/**
 * Build skill catalog for agent discovery
 *
 * Creates a formatted catalog of available skills for agent awareness.
 *
 * @param skills - Loaded skill definitions
 * @returns Formatted skill catalog text
 */
export function buildSkillCatalog(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return '# Skill Catalog\n\nNo skills are currently installed.\n';
  }

  const lines: string[] = [
    '# Skill Catalog',
    '',
    `${skills.length} skill(s) available:`,
    '',
  ];

  for (const skill of skills) {
    lines.push(`## ${skill.name} (v${skill.version})`);
    lines.push(`${skill.description}`);
    lines.push('');

    // Show permissions
    if (skill.permissions) {
      lines.push('**Permissions:**');
      if (skill.permissions.filesystem) {
        const { read, write } = skill.permissions.filesystem;
        if (read) lines.push(`- Filesystem read: ${read.join(', ')}`);
        if (write) lines.push(`- Filesystem write: ${write.join(', ')}`);
      }
      if (skill.permissions.network) {
        lines.push('- Network access: enabled');
      }
      if (skill.permissions.shell) {
        lines.push('- Shell access: enabled');
      }
      lines.push('');
    }

    // Show dependencies
    if (skill.dependencies?.skills && skill.dependencies.skills.length > 0) {
      lines.push(`**Dependencies:** ${skill.dependencies.skills.join(', ')}`);
      lines.push('');
    }

    // Show tools (for MCP skills)
    if (skill.implementation.mcpServer?.tools) {
      lines.push('**Tools:**');
      for (const tool of skill.implementation.mcpServer.tools) {
        lines.push(`- \`${tool.name}\`: ${tool.description}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
