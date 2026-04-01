/**
 * SkillProvider interface
 *
 * Unified interface for discovering, loading, and executing skills from
 * different backend sources (MCP gateway, SKILL.md registry, hybrid).
 */

import type { SkillDefinition } from '../tools/types';
import type { SkillRegistry } from './registry';
import type { MCPGatewayClient } from './mcp-gateway-client';

/**
 * Result returned by SkillProvider.executeSkill()
 */
export interface SkillExecutionResult {
  /** Skill name that was executed */
  skillName: string;

  /** Execution output or instruction text */
  content: string;

  /** Whether the execution resulted in an error */
  isError: boolean;

  /** Error details (when isError=true) */
  error?: {
    message: string;
    code?: string;
  };

  /** Execution timing */
  metadata?: {
    startTime: string;
    endTime: string;
    durationMs: number;
  };
}

/**
 * SkillProvider — common interface for all skill source backends.
 *
 * Each provider knows how to:
 * 1. **Discover** skills available from its source (gateway, registry, etc.)
 * 2. **Load** a single skill definition by name
 * 3. **Execute** a skill with a given input map
 */
export interface SkillProvider {
  /** Provider type identifier */
  readonly type: 'mcp' | 'instruction' | 'hybrid';

  /**
   * Discover all skills available from this provider's backend.
   * Returns a list of SkillDefinitions ready for use by the agent.
   */
  discoverSkills(): Promise<SkillDefinition[]>;

  /**
   * Load a single skill definition by name.
   * @throws if the skill cannot be found or loaded
   */
  loadSkill(name: string): Promise<SkillDefinition>;

  /**
   * Execute a skill with the given input.
   *
   * For MCP skills: invokes the relevant MCP tool via the gateway.
   * For instruction skills: returns the raw instruction text for prompt injection.
   * For hybrid skills: routes to the appropriate sub-provider.
   */
  executeSkill(name: string, input: Record<string, unknown>): Promise<SkillExecutionResult>;
}

/**
 * Configuration for MCPProvider
 */
export interface MCPProviderConfig {
  /** AgentCore Gateway client for MCP target queries */
  gatewayClient: MCPGatewayClient;

  /** Tenant ID for scoping gateway queries */
  tenantId: string;

  /**
   * Optional skill definition (used when this provider wraps a specific
   * installed skill for ToolProvider compatibility with SkillLoader)
   */
  skillDefinition?: SkillDefinition;
}

/**
 * Configuration for InstructionProvider
 */
export interface InstructionProviderConfig {
  /** DynamoDB-backed skill registry */
  registry: SkillRegistry;

  /** Tenant ID for scoping registry queries */
  tenantId: string;
}

/**
 * Configuration for HybridProvider
 */
export interface HybridProviderConfig {
  /** MCP provider for gateway-backed skills */
  mcpConfig: MCPProviderConfig;

  /** Instruction provider for SKILL.md-based skills */
  instructionConfig: InstructionProviderConfig;
}
