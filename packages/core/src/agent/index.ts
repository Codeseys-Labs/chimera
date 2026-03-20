/**
 * Agent module - Core agent functionality
 *
 * Exports:
 * - ChimeraAgent: Main agent class wrapping Strands
 * - SystemPromptTemplate: Prompt templating system
 * - Helper functions for agent creation
 */

export {
  ChimeraAgent,
  createAgent,
  type AgentConfig,
  type AgentContext,
  type AgentResult,
  type ToolCall,
  type StreamEvent
} from './agent';

export {
  SystemPromptTemplate,
  createSystemPrompt,
  createDefaultSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  type PromptContext
} from './prompt';
