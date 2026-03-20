/**
 * @chimera/core - Core agent runtime for AWS Chimera platform
 *
 * This package provides the foundational agent runtime functionality:
 * - Strands agent wrapper with multi-tenant session management
 * - AgentCore Runtime integration (serverless MicroVM execution)
 * - AgentCore Memory integration (STM + LTM with tenant-scoped namespaces)
 * - Universal skill loading (OpenClaw, MCP, Strands, Claude Code)
 * - System prompt templating
 * - Tool registry and execution
 *
 * @packageDocumentation
 */

// Agent components
export {
  ChimeraAgent,
  createAgent,
  SystemPromptTemplate,
  createSystemPrompt,
  createDefaultSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  type AgentConfig,
  type AgentContext,
  type AgentResult,
  type ToolCall,
  type StreamEvent,
  type PromptContext
} from './agent';

// Runtime components
export {
  AgentCoreRuntime,
  createRuntime,
  MEMORY_STRATEGY_TIERS,
  type RuntimeConfig,
  type RuntimeSession,
  type MemoryOperation,
  type MemoryResult
} from './runtime';

// Memory module
export * from './memory';

// Tools module
export * from './tools';
