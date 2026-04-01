/**
 * Hybrid Provider
 *
 * SkillProvider implementation that combines MCP-server skills, SKILL.md
 * instruction skills, and (in future) Strands @tool-decorated skills into a
 * single unified interface.
 *
 * Aggregates results from MCPProvider and InstructionProvider:
 * - discoverSkills() — merges from both sub-providers (de-duped by name)
 * - loadSkill(name)  — tries instruction provider first, falls back to MCP
 * - executeSkill()   — routes to the appropriate sub-provider based on type
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
  SkillDefinition,
} from '../tools/types';
import type {
  SkillProvider,
  SkillExecutionResult,
  HybridProviderConfig,
} from './provider';
import { MCPProvider } from './mcp-provider';
import { InstructionProvider } from './instruction-provider';

/**
 * HybridProvider — unified skill source that aggregates MCP and instruction
 * backends.
 */
export class HybridProvider implements SkillProvider, ToolProvider {
  readonly type = 'hybrid' as const;

  private mcpProvider: MCPProvider;
  private instructionProvider: InstructionProvider;

  constructor(config: HybridProviderConfig) {
    this.mcpProvider = new MCPProvider(config.mcpConfig);
    this.instructionProvider = new InstructionProvider(config.instructionConfig);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SkillProvider interface
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Discover all skills from both MCP gateway and instruction registry.
   *
   * Skills from the instruction provider take precedence over MCP skills with
   * the same name (instruction skills have richer metadata from SKILL.md).
   */
  async discoverSkills(): Promise<SkillDefinition[]> {
    const [mcpSkills, instructionSkills] = await Promise.all([
      this.mcpProvider.discoverSkills().catch(() => [] as SkillDefinition[]),
      this.instructionProvider.discoverSkills().catch(() => [] as SkillDefinition[]),
    ]);

    // Merge with instruction skills taking precedence
    const byName = new Map<string, SkillDefinition>();
    for (const skill of mcpSkills) {
      byName.set(skill.name, skill);
    }
    for (const skill of instructionSkills) {
      byName.set(skill.name, skill);
    }

    return Array.from(byName.values());
  }

  /**
   * Load a skill by name.
   *
   * Tries the instruction provider first (SKILL.md has richer metadata),
   * then falls back to the MCP gateway.
   */
  async loadSkill(name: string): Promise<SkillDefinition> {
    try {
      return await this.instructionProvider.loadSkill(name);
    } catch {
      // Fall through to MCP
    }

    return this.mcpProvider.loadSkill(name);
  }

  /**
   * Execute a skill by routing to the appropriate sub-provider.
   *
   * Loads the skill definition to determine its type, then delegates:
   * - instruction: InstructionProvider (returns prompt text)
   * - mcp_server:  MCPProvider (invokes MCP tool via gateway)
   * - hybrid:      InstructionProvider for instructions + MCPProvider for tools
   */
  async executeSkill(
    name: string,
    input: Record<string, unknown>
  ): Promise<SkillExecutionResult> {
    let skill: SkillDefinition;
    try {
      skill = await this.loadSkill(name);
    } catch (err) {
      const now = new Date().toISOString();
      return {
        skillName: name,
        content: `Failed to load skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        error: { message: String(err), code: 'SKILL_LOAD_FAILED' },
        metadata: { startTime: now, endTime: now, durationMs: 0 },
      };
    }

    switch (skill.implementation.type) {
      case 'instruction':
        return this.instructionProvider.executeSkill(name, input);

      case 'mcp_server':
        return this.mcpProvider.executeSkill(name, input);

      case 'hybrid': {
        // Hybrid: return instruction text (caller also invokes MCP tools separately)
        const result = await this.instructionProvider.executeSkill(name, input);
        return {
          ...result,
          content: result.isError
            ? result.content
            : `[hybrid] ${result.content}`,
        };
      }

      default: {
        const now = new Date().toISOString();
        return {
          skillName: name,
          content: `Unsupported skill type: ${skill.implementation.type}`,
          isError: true,
          error: { message: `Unsupported skill type: ${skill.implementation.type}` },
          metadata: { startTime: now, endTime: now, durationMs: 0 },
        };
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ToolProvider interface — required by SkillLoader
  // ──────────────────────────────────────────────────────────────────────────

  /** Initialises both sub-providers. */
  async initialize(): Promise<void> {
    await Promise.all([
      this.mcpProvider.initialize(),
      this.instructionProvider.initialize(),
    ]);
  }

  /** Returns the MCP tool list from the skill definition (if any). */
  async listTools(): Promise<ToolSpec[]> {
    return this.mcpProvider.listTools();
  }

  /** Delegates to MCPProvider for tool invocation. */
  async invoke(invocation: ToolInvocation): Promise<ToolResult> {
    return this.mcpProvider.invoke(invocation);
  }

  /** Cleans up both sub-providers. */
  async cleanup(): Promise<void> {
    await Promise.all([
      this.mcpProvider.cleanup(),
      this.instructionProvider.cleanup(),
    ]);
  }
}
