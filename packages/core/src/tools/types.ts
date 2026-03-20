/**
 * Tool types for universal skill loading
 *
 * Implements the universal adapter pattern for loading skills from:
 * - OpenClaw SKILL.md files
 * - MCP servers
 * - Strands @tool decorators
 * - Claude Code skills
 *
 * Reference: docs/research/skills/01-Platform-Skill-Formats.md
 */

import { SkillFormat, SkillTrustLevel } from '@chimera/shared';

/**
 * Tool parameter definition (JSON Schema-compatible)
 */
export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: unknown;
  enum?: string[];
  items?: ToolParameter; // For array types
  properties?: Record<string, ToolParameter>; // For object types
}

/**
 * Tool specification (platform-agnostic)
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolParameter[];
  returnType?: string;
  examples?: ToolExample[];
}

/**
 * Tool usage example
 */
export interface ToolExample {
  input: Record<string, unknown>;
  output: string;
  description?: string;
}

/**
 * Tool execution context
 */
export interface ToolContext {
  /** Tenant identifier (for isolation) */
  tenantId: string;

  /** User identifier */
  userId: string;

  /** Session identifier */
  sessionId: string;

  /** Working directory (if applicable) */
  workingDirectory?: string;

  /** Environment variables */
  env?: Record<string, string>;

  /** Additional context data */
  [key: string]: unknown;
}

/**
 * Tool execution result
 */
export interface ToolResult {
  /** Tool execution ID */
  id: string;

  /** Tool name */
  toolName: string;

  /** Result content */
  content: string;

  /** Whether execution resulted in error */
  isError: boolean;

  /** Error details (if isError=true) */
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };

  /** Execution metadata */
  metadata?: {
    startTime: string;
    endTime: string;
    durationMs: number;
  };
}

/**
 * Tool invocation request
 */
export interface ToolInvocation {
  /** Unique invocation ID */
  id: string;

  /** Tool to invoke */
  toolName: string;

  /** Input parameters */
  input: Record<string, unknown>;

  /** Execution context */
  context: ToolContext;
}

/**
 * Tool provider interface
 * Implementations: MCPToolProvider, StrandsToolProvider, InstructionToolProvider
 */
export interface ToolProvider {
  /** Provider type identifier */
  readonly type: 'mcp' | 'strands' | 'instruction' | 'hybrid';

  /** Initialize provider (connect to MCP server, load modules, etc.) */
  initialize(): Promise<void>;

  /** List available tools */
  listTools(): Promise<ToolSpec[]>;

  /** Invoke a tool */
  invoke(invocation: ToolInvocation): Promise<ToolResult>;

  /** Cleanup (disconnect, release resources) */
  cleanup(): Promise<void>;
}

/**
 * Skill source metadata
 * Tracks where a skill came from for provenance
 */
export interface SkillSource {
  /** Original platform */
  platform: 'openclaw' | 'claude-code' | 'strands' | 'mcp' | 'chimera-native';

  /** Format version */
  formatVersion: string;

  /** Source URL or path */
  sourceUrl?: string;

  /** Import timestamp */
  importedAt: string;

  /** Signature verification */
  signatures?: {
    author?: string; // Ed25519 signature
    platform?: string; // Platform co-signature
  };
}

/**
 * Skill definition (unified format)
 * All external skills are translated to this format
 */
export interface SkillDefinition {
  /** Skill metadata */
  name: string;
  version: string;
  description: string;
  author: string;
  trustLevel: SkillTrustLevel;
  format: SkillFormat;

  /** Permissions */
  permissions?: {
    filesystem?: {
      read?: string[]; // Glob patterns
      write?: string[];
    };
    network?: boolean | { allowed?: string[]; denied?: string[] };
    shell?: {
      allowed?: string[];
      denied?: string[];
    };
    memory?: {
      read?: boolean;
      write?: string[]; // Memory keys
    };
    secrets?: string[]; // Secret ARNs
  };

  /** Dependencies */
  dependencies?: {
    skills?: string[]; // Other skill names
    mcpServers?: Array<{
      name: string;
      optional: boolean;
    }>;
    packages?: {
      pip?: string[];
      npm?: string[];
    };
    binaries?: string[];
    envVars?: {
      required?: string[];
      optional?: string[];
    };
  };

  /** Implementation */
  implementation: {
    type: 'instruction' | 'mcp_server' | 'hybrid';

    /** Natural language instructions (for instruction-based skills) */
    instructions?: string;

    /** MCP server configuration (for MCP-based skills) */
    mcpServer?: {
      transport: 'stdio' | 'http' | 'sse';
      command?: string; // For stdio transport
      args?: string[];
      url?: string; // For http/sse transport
      tools: ToolSpec[];
    };
  };

  /** Source provenance */
  source: SkillSource;

  /** Testing configuration */
  testing?: {
    model?: string;
    cases?: Array<{
      name: string;
      input: string;
      expect: {
        toolCalls?: string[];
        outputContains?: string[];
      };
    }>;
  };
}

/**
 * Skill adapter interface
 * Implementations: OpenClawAdapter, MCPAdapter, StrandsAdapter, ClaudeCodeAdapter
 */
export interface SkillAdapter {
  /** Source platform identifier */
  readonly sourcePlatform: 'openclaw' | 'claude-code' | 'strands' | 'mcp';

  /** Import skill from source format to unified format */
  importSkill(source: unknown): Promise<SkillDefinition>;

  /** Export skill from unified format to source format */
  exportSkill(skill: SkillDefinition): Promise<unknown>;

  /** Validate source format */
  validate(source: unknown): Promise<boolean>;
}

/**
 * Skill registry configuration
 */
export interface SkillRegistryConfig {
  /** Tenant identifier */
  tenantId: string;

  /** Storage backend */
  storage: 'dynamodb' | 'file' | 'memory';

  /** DynamoDB table name (if storage=dynamodb) */
  tableName?: string;

  /** File storage path (if storage=file) */
  storagePath?: string;
}
