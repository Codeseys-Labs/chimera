/**
 * Instruction Provider
 *
 * SkillProvider implementation for SKILL.md-based skills.
 * Discovers skills from the Chimera skill registry and parses their SKILL.md
 * content (YAML frontmatter + markdown body) into unified SkillDefinitions.
 *
 * Instruction skills operate by injecting natural-language guidance into the
 * agent's system prompt — they have no callable MCP tools.
 *
 * Implements:
 * - SkillProvider (discoverSkills, loadSkill, executeSkill)
 * - ToolProvider  (initialize, listTools, invoke, cleanup) — for SkillLoader compatibility
 */

import type {
  ToolProvider,
  ToolSpec,
  ToolInvocation,
  ToolResult,
} from '../tools/types';
import type { SkillDefinition, SkillSource } from '../tools/types';
import type { SkillProvider, SkillExecutionResult, InstructionProviderConfig } from './provider';
import { parseSkillMd } from './parser';

/**
 * InstructionProvider — discovers and loads skills from SKILL.md files via
 * the Chimera skill registry.
 */
export class InstructionProvider implements SkillProvider, ToolProvider {
  readonly type = 'instruction' as const;

  private config: InstructionProviderConfig;

  constructor(config: InstructionProviderConfig) {
    this.config = config;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SkillProvider interface
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Discover instruction-based skills installed for the tenant.
   *
   * Queries the registry for all installed skills and returns those whose
   * implementation type is 'instruction'.
   */
  async discoverSkills(): Promise<SkillDefinition[]> {
    const { registry, tenantId } = this.config;
    const installs = await registry.getInstalledSkills(tenantId);

    const definitions: SkillDefinition[] = [];
    for (const install of installs) {
      try {
        const skill = await this.loadSkill(install.skill_name);
        if (skill.implementation.type === 'instruction') {
          definitions.push(skill);
        }
      } catch {
        // Skip skills that fail to load
      }
    }
    return definitions;
  }

  /**
   * Load a skill definition by name.
   *
   * Fetches skill metadata from the registry, builds a synthetic SKILL.md
   * stub (full content would be fetched from S3 in production), and parses
   * it into a unified SkillDefinition.
   */
  async loadSkill(name: string): Promise<SkillDefinition> {
    const { registry } = this.config;
    const skill = await registry.getSkill(name);
    if (!skill) {
      throw new Error(`Skill not found: ${name}`);
    }

    // Stub SKILL.md content from registry metadata.
    // Production: fetch the actual SKILL.md from S3 using skill.bundle.s3_key
    const content = `---
name: ${skill.name}
version: ${skill.version}
description: ${skill.description}
author: ${skill.author}
trust_level: ${skill.trust_level}
---

${skill.description}
`;

    const source: SkillSource = {
      platform: 'openclaw',
      formatVersion: 'v2',
      sourceUrl: skill.bundle?.s3_key,
      importedAt: new Date().toISOString(),
    };

    const { skill: definition } = await parseSkillMd(content, skill.bundle?.s3_key);
    return { ...definition, source };
  }

  /**
   * Execute an instruction skill.
   *
   * Instruction skills deliver value via system-prompt injection, not direct
   * invocation.  This method returns the raw instruction text so callers can
   * inject it via skill-bridge.
   */
  async executeSkill(
    name: string,
    _input: Record<string, unknown>
  ): Promise<SkillExecutionResult> {
    const startTime = new Date().toISOString();

    let skill: SkillDefinition;
    try {
      skill = await this.loadSkill(name);
    } catch (err) {
      const endTime = new Date().toISOString();
      return {
        skillName: name,
        content: `Failed to load skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        error: { message: String(err), code: 'SKILL_LOAD_FAILED' },
        metadata: { startTime, endTime, durationMs: 0 },
      };
    }

    const endTime = new Date().toISOString();
    return {
      skillName: name,
      content: skill.implementation.instructions ?? '',
      isError: false,
      metadata: { startTime, endTime, durationMs: 0 },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ToolProvider interface — required by SkillLoader
  // ──────────────────────────────────────────────────────────────────────────

  /** No-op — instruction providers require no external resources. */
  async initialize(): Promise<void> {}

  /** Returns [] — instruction skills have no callable tools. */
  async listTools(): Promise<ToolSpec[]> {
    return [];
  }

  /**
   * Not invocable as a tool — callers should use executeSkill() or
   * skill-bridge to inject instructions into the agent system prompt.
   */
  async invoke(invocation: ToolInvocation): Promise<ToolResult> {
    const now = new Date().toISOString();
    return {
      id: invocation.id,
      toolName: invocation.toolName,
      content: `Skill "${invocation.toolName}" is instruction-based and cannot be invoked as a tool. Use executeSkill() or skill-bridge.`,
      isError: true,
      error: {
        message: 'Instruction-based skills are not invocable as tools',
        code: 'INSTRUCTION_SKILL_NOT_INVOCABLE',
      },
      metadata: { startTime: now, endTime: now, durationMs: 0 },
    };
  }

  /** No-op — nothing to release. */
  async cleanup(): Promise<void> {}
}
