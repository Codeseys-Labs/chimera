/**
 * Memory types for AgentCore Memory integration
 *
 * Implements STM (Short-Term Memory) and LTM (Long-Term Memory) patterns
 * with tenant-scoped namespaces for multi-tenant isolation.
 *
 * Reference: docs/research/agentcore-strands/05-Strands-Advanced-Memory-MultiAgent.md
 */

/**
 * Memory strategy types supported by AgentCore Memory
 */
export type MemoryStrategy = 'SUMMARY' | 'USER_PREFERENCE' | 'SEMANTIC';

/**
 * Memory tier configuration (tier-based memory strategies)
 */
export interface MemoryTierConfig {
  /** Basic tier: Summary only (~$0.50/tenant/mo) */
  basic: {
    enabled: boolean;
    strategies: ['SUMMARY'];
  };
  /** Advanced tier: Summary + User Preferences (~$2/tenant/mo) */
  advanced: {
    enabled: boolean;
    strategies: ['SUMMARY', 'USER_PREFERENCE'];
  };
  /** Professional tier: All strategies (~$8/tenant/mo) */
  professional: {
    enabled: boolean;
    strategies: ['SUMMARY', 'USER_PREFERENCE', 'SEMANTIC'];
  };
}

/**
 * Summary memory strategy configuration
 * Condenses conversation history into summaries
 */
export interface SummaryMemoryConfig {
  memoryWindow?: number; // Number of messages to consider (default: 10)
  summaryRatio?: number; // 0.0-1.0, when to trigger summary (default: 0.3)
}

/**
 * User preference memory strategy configuration
 * Extracts and stores user preferences
 */
export interface UserPreferenceMemoryConfig {
  enabled: boolean;
  maxPreferences?: number; // Max number of preferences to store (default: 50)
}

/**
 * Semantic memory strategy configuration
 * Semantic search over conversation history
 */
export interface SemanticMemoryConfig {
  embeddingModel?: string; // Default: titan-embed-text-v2
  vectorDimensions?: number; // Default: 1024
  similarityThreshold?: number; // 0.0-1.0 (default: 0.7)
  maxResults?: number; // Max retrieval results (default: 5)
}

/**
 * AgentCore Memory configuration
 */
export interface AgentCoreMemoryConfig {
  /** Memory namespace template: 'tenant-{tenantId}-user-{userId}' */
  namespace: string;

  /** Memory strategies to enable */
  strategies: {
    summary?: SummaryMemoryConfig;
    userPreference?: UserPreferenceMemoryConfig;
    semantic?: SemanticMemoryConfig;
  };

  /** AWS region for Bedrock AgentCore */
  region?: string;

  /** Message batching (performance optimization) */
  batchSize?: number; // Default: 10 messages
  batchIntervalMs?: number; // Default: 5000ms
}

/**
 * Memory entry metadata
 */
export interface MemoryMetadata {
  timestamp: string; // ISO 8601
  messageId?: string;
  sessionId?: string;
  strategy: MemoryStrategy;
}

/**
 * Memory entry
 */
export interface MemoryEntry {
  content: string;
  metadata: MemoryMetadata;
  embedding?: number[]; // For semantic memory
}

/**
 * Memory retrieval query
 */
export interface MemoryQuery {
  query?: string; // Semantic search query
  sessionId?: string; // Filter by session
  strategy?: MemoryStrategy; // Filter by strategy
  limit?: number; // Max results (default: 5)
  minScore?: number; // Minimum similarity score (default: 0.7)
}

/**
 * Memory retrieval result
 * RENAMED from MemoryResult to avoid collision with runtime module's MemoryResult
 */
export interface MemoryQueryResult {
  entries: MemoryEntry[];
  totalCount: number;
}

/**
 * Session state for STM (Short-Term Memory)
 */
export interface SessionState {
  sessionId: string;
  messages: Message[];
  context: Record<string, unknown>;
  createdAt: string;
  lastActivity: string;
}

/**
 * Message type for memory storage
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  toolCalls?: MemoryToolCall[];
  toolResults?: MessageToolResult[];
}

/**
 * Tool call in message
 * RENAMED from ToolCall to avoid collision with agent module's ToolCall
 */
export interface MemoryToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result in message (memory context)
 */
export interface MessageToolResult {
  id: string;
  content: string;
  isError: boolean;
}
