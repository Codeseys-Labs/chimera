/**
 * Chimera Agent - Strands agent wrapper with AgentCore Runtime integration
 *
 * Implements the core agent abstraction following Strands' model-driven approach:
 * Agent = Model + Tools + Prompt
 *
 * This wrapper adds:
 * - Multi-tenant session management
 * - AgentCore Memory integration (STM + LTM)
 * - Skill loading and management
 * - Cedar policy enforcement hooks
 */

import { SystemPromptTemplate, PromptContext } from './prompt';
import { MemoryClient, MemoryClientFactory, generateNamespace } from '../memory';

/**
 * Agent configuration options
 */
export interface AgentConfig {
  /** System prompt template */
  systemPrompt: SystemPromptTemplate;

  /** Tenant identifier for multi-tenant isolation */
  tenantId: string;

  /** Optional session identifier for resuming conversations */
  sessionId?: string;

  /** Optional user identifier */
  userId?: string;

  /** AgentCore Memory namespace (defaults to tenant-{tenantId}-user-{userId}) */
  memoryNamespace?: string;

  /** Tools available to the agent (tool names or specifications) */
  tools?: string[];

  /** Skills to load (skill names from tenant's installed skills) */
  skills?: string[];

  /** Agent name/identifier */
  name?: string;

  /** Additional configuration */
  config?: Record<string, unknown>;

  /** Memory client (optional, defaults to in-memory for testing) */
  memoryClient?: MemoryClient;

  /** Tenant tier for memory strategy selection (basic, advanced, premium) */
  tier?: 'basic' | 'advanced' | 'premium';
}

/**
 * Agent execution context
 */
export interface AgentContext {
  tenantId: string;
  userId?: string;
  sessionId: string;
  memoryNamespace: string;
  config: AgentConfig;
}

/**
 * Agent invocation result
 */
export interface AgentResult {
  /** Response text */
  output: string;

  /** Session ID for conversation continuity */
  sessionId: string;

  /** Stop reason (end_turn, tool_use, max_tokens, etc.) */
  stopReason: string;

  /** Tool calls made during invocation */
  toolCalls?: ToolCall[];

  /** Agent context */
  context: AgentContext;
}

/**
 * Tool call information
 */
export interface ToolCall {
  /** Tool name */
  name: string;

  /** Tool input parameters */
  input: Record<string, unknown>;

  /** Tool execution result */
  result?: unknown;

  /** Error if tool execution failed */
  error?: string;
}

/**
 * Chimera Agent - wraps Strands agent with Chimera-specific features
 *
 * This is a facade that will integrate with actual Strands TypeScript SDK
 * once we add it as a dependency. For now, it provides the interface.
 */
export class ChimeraAgent {
  private config: AgentConfig;
  private context: AgentContext;
  private memoryClient: MemoryClient;

  constructor(config: AgentConfig) {
    this.config = config;

    // Initialize context
    this.context = {
      tenantId: config.tenantId,
      userId: config.userId,
      sessionId: config.sessionId || this.generateSessionId(),
      memoryNamespace: config.memoryNamespace || this.buildMemoryNamespace(config.tenantId, config.userId),
      config
    };

    // Initialize memory client (default to in-memory if not provided)
    this.memoryClient = config.memoryClient ||
      MemoryClientFactory.createInMemoryClient(this.context.memoryNamespace);

    // Initialize memory with tier-based configuration
    this.initializeMemory(config.tier || 'basic');
  }

  /**
   * Generate a new session identifier
   */
  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Build memory namespace following AgentCore convention:
   * 'tenant-{tenant_id}-user-{user_id}'
   */
  private buildMemoryNamespace(tenantId: string, userId?: string): string {
    if (userId) {
      return generateNamespace(tenantId, userId);
    }
    return `tenant-${tenantId}`;
  }

  /**
   * Initialize memory with tier-based configuration
   * Implements the tier-based strategy selection from the Python agent
   */
  private async initializeMemory(tier: 'basic' | 'advanced' | 'premium'): Promise<void> {
    const memoryConfig = this.getMemoryConfigForTier(tier);
    await this.memoryClient.initialize(memoryConfig);
  }

  /**
   * Get memory configuration based on tenant tier
   * Matches Python implementation in chimera_agent.py:get_memory_config_for_tier
   */
  private getMemoryConfigForTier(tier: 'basic' | 'advanced' | 'premium') {
    const configs = {
      basic: {
        namespace: this.context.memoryNamespace,
        strategies: {
          summary: {
            memoryWindow: 10,
            summaryRatio: 0.3,
          },
        },
      },
      advanced: {
        namespace: this.context.memoryNamespace,
        strategies: {
          summary: {
            memoryWindow: 50,
            summaryRatio: 0.3,
          },
          userPreference: {
            enabled: true,
            maxPreferences: 50,
          },
        },
      },
      premium: {
        namespace: this.context.memoryNamespace,
        strategies: {
          summary: {
            memoryWindow: 200,
            summaryRatio: 0.3,
          },
          userPreference: {
            enabled: true,
            maxPreferences: 100,
          },
          semantic: {
            embeddingModel: 'amazon.titan-embed-text-v2:0',
            vectorDimensions: 1024,
            similarityThreshold: 0.7,
            maxResults: 5,
          },
        },
      },
    };

    return configs[tier];
  }

  /**
   * Invoke the agent with a user message
   *
   * @param message - User input message
   * @returns Agent response and execution metadata
   */
  async invoke(message: string): Promise<AgentResult> {
    // Store user message in memory
    await this.memoryClient.storeMessage({
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });

    // Build prompt context
    const promptContext: PromptContext = {
      tenantId: this.context.tenantId,
      userId: this.context.userId,
      sessionId: this.context.sessionId
    };

    // Render system prompt
    const systemPrompt = this.config.systemPrompt.render(promptContext);

    // TODO: Integrate with actual Strands SDK
    // For now, return a placeholder response structure
    const result: AgentResult = {
      output: `[Placeholder] Agent invoked with message: "${message}"\nSystem prompt: ${systemPrompt.substring(0, 100)}...`,
      sessionId: this.context.sessionId,
      stopReason: 'end_turn',
      context: this.context
    };

    // Store assistant response in memory
    await this.memoryClient.storeMessage({
      role: 'assistant',
      content: result.output,
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  /**
   * Stream agent responses
   *
   * @param message - User input message
   * @returns Async iterator of streaming events
   */
  async *stream(message: string): AsyncGenerator<StreamEvent, void, unknown> {
    // TODO: Implement streaming with Strands SDK
    // For now, yield a single completion event
    yield {
      type: 'message_start',
      sessionId: this.context.sessionId
    };

    yield {
      type: 'content_block_delta',
      delta: { text: `[Placeholder] Streaming response for: "${message}"` }
    };

    yield {
      type: 'message_stop',
      stopReason: 'end_turn'
    };
  }

  /**
   * Get current agent context
   */
  getContext(): AgentContext {
    return { ...this.context };
  }

  /**
   * Update agent configuration
   */
  updateConfig(updates: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...updates };

    // Update context if relevant fields changed
    if (updates.sessionId) {
      this.context.sessionId = updates.sessionId;
    }
    if (updates.memoryNamespace) {
      this.context.memoryNamespace = updates.memoryNamespace;
    }
  }

  /**
   * Get memory client for direct memory operations
   */
  getMemoryClient(): MemoryClient {
    return this.memoryClient;
  }
}

/**
 * Streaming event types
 */
export type StreamEvent =
  | { type: 'message_start'; sessionId: string }
  | { type: 'content_block_start'; blockType: string }
  | { type: 'content_block_delta'; delta: { text?: string } }
  | { type: 'content_block_stop' }
  | { type: 'message_stop'; stopReason: string }
  | { type: 'tool_call'; toolCall: ToolCall };

/**
 * Factory function to create a Chimera agent
 */
export function createAgent(config: AgentConfig): ChimeraAgent {
  return new ChimeraAgent(config);
}
