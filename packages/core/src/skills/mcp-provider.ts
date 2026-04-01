/**
 * MCP Provider
 *
 * SkillProvider implementation for MCP-server-backed skills.
 * Discovers available skills by querying the AgentCore Gateway for registered
 * MCP targets, then exposes them as unified SkillDefinitions.
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
import type { SkillProvider, SkillExecutionResult, MCPProviderConfig } from './provider';

/** Prefix applied when registering skill MCP targets in the gateway. */
const SKILL_TARGET_PREFIX = 'skill-';

/**
 * MCPProvider — discovers and loads skills from MCP server endpoints via the
 * AgentCore Gateway.
 *
 * Each registered MCP target whose name begins with "skill-" is surfaced as
 * an installable skill.  Tool invocations are forwarded to the gateway.
 */
export class MCPProvider implements SkillProvider, ToolProvider {
  readonly type = 'mcp' as const;

  private config: MCPProviderConfig;
  private initialized = false;

  constructor(config: MCPProviderConfig) {
    this.config = config;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SkillProvider interface
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Discover skills by listing MCP targets registered in the gateway.
   *
   * Returns one SkillDefinition per target whose name begins with "skill-".
   */
  async discoverSkills(): Promise<SkillDefinition[]> {
    const { gatewayClient, tenantId } = this.config;
    const targets = await gatewayClient.listTargets(tenantId);

    return targets
      .filter(t => t.target_name.startsWith(SKILL_TARGET_PREFIX))
      .map(target => this.targetToSkillDefinition(target));
  }

  /**
   * Load a skill definition from the gateway by skill name.
   *
   * Fetches status for the "skill-{name}" target and builds a SkillDefinition
   * from the reported tool list.
   */
  async loadSkill(name: string): Promise<SkillDefinition> {
    const { gatewayClient, tenantId } = this.config;
    const targetName = `${SKILL_TARGET_PREFIX}${name}`;

    const status = await gatewayClient.getTargetStatus(tenantId, targetName);
    if (status.status === 'error') {
      throw new Error(
        `MCP target "${targetName}" is in error state: ${status.message ?? 'unknown error'}`
      );
    }

    // Re-use discoverSkills to get tool list, then find the matching skill
    const skills = await this.discoverSkills();
    const found = skills.find(s => s.name === name);
    if (!found) {
      throw new Error(`MCP skill not found in gateway: ${name}`);
    }
    return found;
  }

  /**
   * Execute a skill by invoking one of its tools via the gateway.
   *
   * The `input` map must contain a `toolName` key identifying which MCP tool
   * to call.  Remaining keys are forwarded as tool arguments.
   *
   * Stub: in production this would forward to MCPGatewayClient via JSON-RPC.
   */
  async executeSkill(
    name: string,
    input: Record<string, unknown>
  ): Promise<SkillExecutionResult> {
    const startTime = new Date().toISOString();
    const toolName = (input.toolName as string | undefined) ?? name;

    // Stub response — real implementation forwards to gateway JSON-RPC endpoint
    const content = `[MCP stub] skill="${name}" tool="${toolName}" input=${JSON.stringify(input)}`;
    const endTime = new Date().toISOString();

    return {
      skillName: name,
      content,
      isError: false,
      metadata: { startTime, endTime, durationMs: 0 },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ToolProvider interface — required by SkillLoader
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Marks the provider as ready.
   *
   * Production would verify gateway reachability before returning.
   */
  async initialize(): Promise<void> {
    this.initialized = true;
  }

  /**
   * Returns the tool list from the skill's SKILL.md frontmatter.
   *
   * Used by SkillLoader to enumerate tools without querying a live gateway.
   * Production would call the gateway's tools/list method.
   */
  async listTools(): Promise<ToolSpec[]> {
    if (!this.config.skillDefinition) return [];
    return this.config.skillDefinition.implementation.mcpServer?.tools ?? [];
  }

  /**
   * Stub invocation — forwards to executeSkill.
   */
  async invoke(invocation: ToolInvocation): Promise<ToolResult> {
    if (!this.initialized) {
      const now = new Date().toISOString();
      return {
        id: invocation.id,
        toolName: invocation.toolName,
        content: 'MCP provider not initialised. Call initialize() first.',
        isError: true,
        error: { message: 'Provider not initialised', code: 'PROVIDER_NOT_INITIALISED' },
        metadata: { startTime: now, endTime: now, durationMs: 0 },
      };
    }

    const skillName = this.config.skillDefinition?.name ?? invocation.toolName;
    const result = await this.executeSkill(skillName, {
      toolName: invocation.toolName,
      ...invocation.input,
    });

    return {
      id: invocation.id,
      toolName: invocation.toolName,
      content: result.content,
      isError: result.isError,
      error: result.error,
      metadata: result.metadata,
    };
  }

  /** Marks provider as uninitialised. */
  async cleanup(): Promise<void> {
    this.initialized = false;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  private targetToSkillDefinition(
    target: { target_name: string; tools: Array<{ name: string; description: string }> }
  ): SkillDefinition {
    const skillName = target.target_name.replace(SKILL_TARGET_PREFIX, '');

    const toolSpecs: ToolSpec[] = target.tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: [],
    }));

    return {
      name: skillName,
      version: '0.0.0',          // Gateway doesn't expose version — stub
      description: `MCP skill: ${skillName}`,
      author: 'mcp-gateway',
      trustLevel: 'community',   // Conservative default for gateway-registered skills
      format: 'mcp',
      implementation: {
        type: 'mcp_server',
        mcpServer: {
          transport: 'http',
          tools: toolSpecs,
        },
      },
      source: {
        platform: 'mcp',
        formatVersion: 'v1',
        importedAt: new Date().toISOString(),
      },
    };
  }
}

