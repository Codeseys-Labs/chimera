/**
 * Agent module - Core agent functionality
 *
 * Exports:
 * - ChimeraAgent: Main agent class wrapping Strands
 * - BedrockModel: AWS Bedrock LLM adapter
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
  BedrockModel,
  createBedrockModel,
  type BedrockModelConfig
} from './bedrock-model';

export {
  SystemPromptTemplate,
  createSystemPrompt,
  createDefaultSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  type PromptContext
} from './prompt';

// Re-export evolution types needed by agent users
export type { FeedbackType, TaskCategory } from '../evolution/types';
