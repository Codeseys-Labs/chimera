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

  /** Skill registry (optional, for dynamic skill loading) */
  skillRegistry?: any; // SkillRegistry type from skills module

  /** Agent name/identifier */
  name?: string;

  /** Additional configuration */
  config?: Record<string, unknown>;

  /** Memory client (optional, defaults to in-memory for testing) */
  memoryClient?: MemoryClient;

  /** Tenant tier for memory strategy selection (basic, advanced, premium) */
  tier?: 'basic' | 'advanced' | 'premium';

  /** Model instance with converse API (optional, for real LLM calls) */
  model?: { converse(turn: any): Promise<any> };

  /** Loaded tools with full specifications (optional, for tool calling) */
  loadedTools?: Array<{
    name: string;
    description: string;
    inputSchema: any;
    callback: (input: any) => Promise<string>
  }>;
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
  private memoryInitialized: Promise<void> | null = null;

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

    // Initialize memory with tier-based configuration (async, will complete before first use)
    this.initializeMemory(config.tier || 'basic');

    // Load skills if specified and registry provided
    if (config.skills && config.skills.length > 0 && config.skillRegistry) {
      this.loadSkillsAsync(config.skills, config.skillRegistry);
    }
  }

  /**
   * Load skills asynchronously and inject into agent
   * Private helper called during initialization
   */
  private async loadSkillsAsync(skillNames: string[], registry: any): Promise<void> {
    try {
      // Dynamically import skill bridge to avoid circular dependency
      const { loadSkillsForAgent } = await import('../skills/skill-bridge');

      // Load skills
      const { config: enhancedConfig, result } = await loadSkillsForAgent(
        this.context.tenantId,
        skillNames,
        registry,
        this.config
      );

      // Update config with loaded skills
      this.config = enhancedConfig;
      this.context.config = enhancedConfig;

      // Log warnings if any
      if (result.warnings.length > 0) {
        console.warn(`[ChimeraAgent] Skill loading warnings:`, result.warnings);
      }

      // Log failed skills
      if (result.failed.length > 0) {
        console.error(`[ChimeraAgent] Failed to load skills:`, result.failed);
      }
    } catch (error) {
      console.error('[ChimeraAgent] Failed to load skills:', error);
    }
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
    if (!this.memoryInitialized) {
      this.memoryInitialized = (async () => {
        const memoryConfig = this.getMemoryConfigForTier(tier);
        await this.memoryClient.initialize(memoryConfig);
      })();
    }
    return this.memoryInitialized;
  }

  /**
   * Ensure memory is initialized before use
   */
  private async ensureMemoryInitialized(): Promise<void> {
    if (this.memoryInitialized) {
      await this.memoryInitialized;
    }
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
    // Ensure memory is initialized before first use
    await this.ensureMemoryInitialized();

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

    // If no model provided, return placeholder (backward compatibility)
    if (!this.config.model) {
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

    // Run ReAct loop with model
    return await this.runReActLoop(message, systemPrompt);
  }

  /**
   * Run the ReAct (Reason + Act) loop with tool calling
   */
  private async runReActLoop(message: string, systemPrompt: string): Promise<AgentResult> {
    const messages: any[] = [];
    const toolCalls: ToolCall[] = [];
    const maxIterations = 10;
    let iterations = 0;
    let finalOutput = '';
    let stopReason = 'end_turn';

    // Build initial user message
    messages.push({
      role: 'user',
      content: [{ text: message }]
    });

    // Build tool specifications for model
    const toolSpecs = this.config.loadedTools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: this.convertZodToJsonSchema(tool.inputSchema)
    })) || [];

    // ReAct loop
    while (iterations < maxIterations) {
      iterations++;

      // Call model
      const response = await this.config.model!.converse({
        messages,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        systemPrompt
      });

      stopReason = response.stopReason;
      const assistantMessage = response.output.message;

      // Extract text content
      const textBlocks = assistantMessage.content.filter((block: any) => block.text);
      if (textBlocks.length > 0) {
        finalOutput = textBlocks.map((block: any) => block.text).join('\n');
      }

      // Check for tool use
      const toolUseBlocks = assistantMessage.content.filter((block: any) => block.toolUse);

      if (toolUseBlocks.length === 0 || stopReason === 'end_turn') {
        // No tools to execute, we're done
        messages.push(assistantMessage);
        break;
      }

      // Add assistant message with tool requests
      messages.push(assistantMessage);

      // Execute tools and collect results
      const toolResults: any[] = [];

      for (const block of toolUseBlocks) {
        const toolUse = block.toolUse;
        const tool = this.config.loadedTools?.find(t => t.name === toolUse.name);

        if (!tool) {
          // Tool not found - add error result
          toolResults.push({
            toolUseId: toolUse.toolUseId,
            content: `Error: Tool '${toolUse.name}' not found`,
            status: 'error'
          });

          toolCalls.push({
            name: toolUse.name,
            input: toolUse.input,
            error: `Tool '${toolUse.name}' not found`
          });
          continue;
        }

        // Execute tool
        try {
          const result = await tool.callback(toolUse.input);

          toolResults.push({
            toolUseId: toolUse.toolUseId,
            content: result,
            status: 'success'
          });

          toolCalls.push({
            name: toolUse.name,
            input: toolUse.input,
            result
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          toolResults.push({
            toolUseId: toolUse.toolUseId,
            content: `Error: ${errorMessage}`,
            status: 'error'
          });

          toolCalls.push({
            name: toolUse.name,
            input: toolUse.input,
            error: errorMessage
          });
        }
      }

      // Add tool results message
      messages.push({
        role: 'user',
        content: toolResults.map(result => ({ toolResult: result }))
      });
    }

    // Build result
    const result: AgentResult = {
      output: finalOutput,
      sessionId: this.context.sessionId,
      stopReason,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
   * Convert Zod schema to JSON Schema format for Bedrock API
   */
  private convertZodToJsonSchema(zodSchema: any): any {
    // For now, pass through assuming it's already in correct format
    // TODO: Implement full Zod -> JSON Schema conversion if needed
    if (zodSchema && typeof zodSchema === 'object') {
      if (zodSchema.type && zodSchema.properties) {
        // Already JSON Schema format
        return zodSchema;
      }
      // Try to extract _def from Zod schema
      if (zodSchema._def) {
        return {
          type: 'object',
          properties: zodSchema._def.shape ?
            Object.fromEntries(
              Object.entries(zodSchema._def.shape()).map(([key, val]: [string, any]) => [
                key,
                { type: 'string' } // Simplified
              ])
            ) : {}
        };
      }
    }
    // Fallback: assume it's a valid schema
    return zodSchema;
  }

  /**
   * Stream agent responses
   *
   * @param message - User input message
   * @returns Async iterator of streaming events
   */
  async *stream(message: string): AsyncGenerator<StreamEvent, void, unknown> {
    // Ensure memory is initialized
    await this.ensureMemoryInitialized();

    // If no model, yield placeholder events
    if (!this.config.model) {
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
      return;
    }

    // Stream with ReAct loop
    yield {
      type: 'message_start',
      sessionId: this.context.sessionId
    };

    // Build prompt context
    const promptContext: PromptContext = {
      tenantId: this.context.tenantId,
      userId: this.context.userId,
      sessionId: this.context.sessionId
    };

    const systemPrompt = this.config.systemPrompt.render(promptContext);

    const messages: any[] = [];
    messages.push({
      role: 'user',
      content: [{ text: message }]
    });

    const toolSpecs = this.config.loadedTools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: this.convertZodToJsonSchema(tool.inputSchema)
    })) || [];

    const maxIterations = 10;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      const response = await this.config.model.converse({
        messages,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        systemPrompt
      });

      const assistantMessage = response.output.message;

      // Emit text content
      const textBlocks = assistantMessage.content.filter((block: any) => block.text);
      for (const block of textBlocks) {
        yield {
          type: 'content_block_delta',
          delta: { text: block.text }
        };
      }

      // Check for tool use
      const toolUseBlocks = assistantMessage.content.filter((block: any) => block.toolUse);

      if (toolUseBlocks.length === 0 || response.stopReason === 'end_turn') {
        messages.push(assistantMessage);
        yield {
          type: 'message_stop',
          stopReason: response.stopReason
        };
        break;
      }

      // Emit tool call events
      for (const block of toolUseBlocks) {
        const toolUse = block.toolUse;
        const tool = this.config.loadedTools?.find(t => t.name === toolUse.name);

        if (tool) {
          try {
            const result = await tool.callback(toolUse.input);
            yield {
              type: 'tool_call',
              toolCall: {
                name: toolUse.name,
                input: toolUse.input,
                result
              }
            };

            // Add to messages for next iteration
            messages.push(assistantMessage);
            messages.push({
              role: 'user',
              content: [{
                toolResult: {
                  toolUseId: toolUse.toolUseId,
                  content: result,
                  status: 'success'
                }
              }]
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            yield {
              type: 'tool_call',
              toolCall: {
                name: toolUse.name,
                input: toolUse.input,
                error: errorMessage
              }
            };
          }
        } else {
          yield {
            type: 'tool_call',
            toolCall: {
              name: toolUse.name,
              input: toolUse.input,
              error: `Tool '${toolUse.name}' not found`
            }
          };
        }
      }
    }
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

    // Update context.config to reflect changes
    this.context.config = this.config;

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
