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
import { ModelRouter } from '../evolution/model-router';
import { PromptOptimizer } from '../evolution/prompt-optimizer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { TaskCategory, ModelId, FeedbackEvent, FeedbackType } from '../evolution/types';
import { BudgetMonitor } from '../billing/budget-monitor';
import { estimateTokenCount, estimateMessageTokens, estimateRequestCost, BudgetExceededError } from './token-estimator';
import type { Message, ContentBlock, ToolSpec } from './bedrock-model';

// Module-level singleton DynamoDB client (reused across all agent instances)
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  skillRegistry?: any; // SkillRegistry type from skills module - avoid circular dependency

  /** Agent name/identifier */
  name?: string;

  /** Additional configuration */
  config?: Record<string, unknown>;

  /** Memory client (optional, defaults to in-memory for testing) */
  memoryClient?: MemoryClient;

  /** Tenant tier for memory strategy selection (basic, advanced, premium) */
  tier?: 'basic' | 'advanced' | 'premium';

  /** Model instance with converse API (optional, for real LLM calls) */
  model?: {
    converse(turn: { messages: Message[]; tools?: ToolSpec[]; systemPrompt?: string }): Promise<{ output: { message: Message }; stopReason: string }>
  };

  /** Loaded tools with full specifications (optional, for tool calling) */
  loadedTools?: Array<{
    name: string;
    description: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (input: any) => Promise<string>
  }>;

  /** Model router for dynamic model selection (optional) */
  modelRouter?: ModelRouter;

  /** Prompt optimizer for A/B testing (optional) */
  promptOptimizer?: PromptOptimizer;

  /** Task category for model routing (optional, defaults to 'analysis') */
  taskCategory?: TaskCategory;

  /** Active prompt experiment ID (optional) */
  promptExperimentId?: string;

  /** DynamoDB table for evolution metrics persistence (optional) */
  evolutionTable?: string;

  /** Budget monitor for pre-flight cost checking (optional) */
  budgetMonitor?: BudgetMonitor;
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
  private ddbClient?: DynamoDBDocumentClient;
  private currentModelId?: ModelId;
  private currentPromptVariant?: 'a' | 'b';

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

    // Use module-level DynamoDB client if evolution table is provided
    if (config.evolutionTable) {
      this.ddbClient = ddbDocClient;
    }

    // Load skills if specified and registry provided
    if (config.skills && config.skills.length > 0 && config.skillRegistry) {
      this.loadSkillsAsync(config.skills, config.skillRegistry);
    }
  }

  /**
   * Load skills asynchronously and inject into agent
   * Private helper called during initialization
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // Select model via ModelRouter if available
    if (this.config.modelRouter) {
      const taskCategory = this.config.taskCategory || 'analysis';
      const modelSelection = await this.config.modelRouter.selectModel({
        tenantId: this.context.tenantId,
        taskCategory,
      });
      this.currentModelId = modelSelection.selectedModel;

      // Log model selection for debugging
      if (process.env.DEBUG === 'true') {
        console.log('[ModelRouter]', {
          selected: modelSelection.selectedModel,
          category: taskCategory,
          weights: modelSelection.routingWeights,
        });
      }
    }

    // Build prompt context
    const promptContext: PromptContext = {
      tenantId: this.context.tenantId,
      userId: this.context.userId,
      sessionId: this.context.sessionId
    };

    // Select prompt variant via PromptOptimizer if experiment is active
    let systemPrompt: string;
    if (this.config.promptOptimizer && this.config.promptExperimentId) {
      this.currentPromptVariant = await this.config.promptOptimizer.selectPromptVariant({
        tenantId: this.context.tenantId,
        experimentId: this.config.promptExperimentId,
      });

      // Load prompt from S3 based on variant
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const experiment = await (this.config.promptOptimizer as any).getExperiment(
        this.context.tenantId,
        this.config.promptExperimentId
      );

      if (experiment) {
        const s3Key = this.currentPromptVariant === 'b'
          ? experiment.variantBPromptS3
          : experiment.variantAPromptS3;

        systemPrompt = await this.config.promptOptimizer.loadPrompt(s3Key);

        if (process.env.DEBUG === 'true') {
          console.log('[PromptOptimizer]', {
            variant: this.currentPromptVariant,
            experimentId: this.config.promptExperimentId,
          });
        }
      } else {
        // Fallback to static prompt if experiment not found
        systemPrompt = this.config.systemPrompt.render(promptContext);
      }
    } else {
      // Use static system prompt
      systemPrompt = this.config.systemPrompt.render(promptContext);
    }

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

    // Pre-flight budget check if BudgetMonitor is configured
    if (this.config.budgetMonitor) {
      await this.checkBudgetBeforeInvoke(message, systemPrompt);
    }

    // Run ReAct loop with model
    const result = await this.runReActLoop(message, systemPrompt);

    // Record outcomes to evolution subsystems
    await this.recordEvolutionOutcomes(result);

    return result;
  }

  /**
   * Check budget before invocation
   *
   * Estimates token costs and enforces budget limits.
   * Throws BudgetExceededError if budget is exhausted.
   */
  private async checkBudgetBeforeInvoke(message: string, systemPrompt: string): Promise<void> {
    if (!this.config.budgetMonitor) {
      return;
    }

    // Build tool specs for token estimation
    const toolSpecs = this.config.loadedTools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: this.convertZodToJsonSchema(tool.inputSchema)
    })) || [];

    // Estimate input tokens
    const inputTokens = estimateMessageTokens({
      messages: [{ role: 'user', content: [{ text: message }] }],
      systemPrompt,
      tools: toolSpecs.length > 0 ? toolSpecs : undefined
    });

    // Estimate max output tokens (use config default)
    const maxOutputTokens = 4096; // Default from BedrockModel config

    // Estimate cost using selected model (or fall back to default)
    const modelId = this.currentModelId || 'us.anthropic.claude-sonnet-4-6-v1:0';
    const estimatedCost = estimateRequestCost({
      modelId,
      inputTokens,
      maxOutputTokens
    });

    // Check budget action
    const action = await this.config.budgetMonitor.getBudgetAction(this.context.tenantId);

    if (action === 'block') {
      // Get budget details for error message
      const check = await this.config.budgetMonitor.checkBudget(this.context.tenantId);
      throw new BudgetExceededError(
        this.context.tenantId,
        estimatedCost,
        check.budgetLimit - check.currentSpend
      );
    }

    if (action === 'warn') {
      // Log warning but proceed
      console.warn(
        `[BudgetWarning] Tenant ${this.context.tenantId} has exceeded budget threshold. ` +
        `Estimated cost: $${estimatedCost.toFixed(4)}`
      );
    }

    // action === 'allow' - proceed without warning
  }

  /**
   * Run the ReAct (Reason + Act) loop with tool calling
   */
  private async runReActLoop(message: string, systemPrompt: string): Promise<AgentResult> {
    const messages: Message[] = [];
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

      // Call model (pass selected modelId if available)
      const response = await this.config.model!.converse({
        messages,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        systemPrompt,
        modelId: this.currentModelId
      });

      stopReason = response.stopReason;
      const assistantMessage = response.output.message;

      // Extract text content
      const textBlocks = assistantMessage.content.filter((block): block is ContentBlock & { text: string } => !!block.text);
      if (textBlocks.length > 0) {
        finalOutput = textBlocks.map(block => block.text).join('\n');
      }

      // Check for tool use
      const toolUseBlocks = assistantMessage.content.filter((block): block is ContentBlock & { toolUse: NonNullable<ContentBlock['toolUse']> } => !!block.toolUse);

      if (toolUseBlocks.length === 0 || stopReason === 'end_turn') {
        // No tools to execute, we're done
        messages.push(assistantMessage);
        break;
      }

      // Add assistant message with tool requests
      messages.push(assistantMessage);

      // Execute tools and collect results
      interface ToolResultBlock {
        toolUseId: string;
        content: string;
        status: 'success' | 'error';
      }
      const toolResults: ToolResultBlock[] = [];

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

    // Self-reflection hook: Analyze interaction and update evolution metrics
    await this.performSelfReflection(message, result);

    return result;
  }

  /**
   * Convert Zod schema to JSON Schema format for Bedrock API
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
              Object.entries(zodSchema._def.shape()).map(([key]) => [
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
   * Record outcomes to evolution subsystems (ModelRouter, PromptOptimizer)
   */
  private async recordEvolutionOutcomes(result: AgentResult): Promise<void> {
    try {
      // Calculate quality score from result
      const qualityScore = this.calculateQualityScore(result);

      // Estimate cost (simplified - in production would use actual token counts)
      const estimatedCost = 0.001; // Placeholder

      // Record to ModelRouter if model was selected
      if (this.config.modelRouter && this.currentModelId) {
        const taskCategory = this.config.taskCategory || 'analysis';
        await this.config.modelRouter.recordOutcome({
          tenantId: this.context.tenantId,
          taskCategory,
          modelId: this.currentModelId,
          qualityScore,
        });
      }

      // Record to PromptOptimizer if variant was selected
      if (
        this.config.promptOptimizer &&
        this.config.promptExperimentId &&
        this.currentPromptVariant
      ) {
        await this.config.promptOptimizer.recordVariantOutcome({
          tenantId: this.context.tenantId,
          experimentId: this.config.promptExperimentId,
          variant: this.currentPromptVariant,
          qualityScore,
          cost: estimatedCost,
        });
      }
    } catch (error) {
      console.warn('[ChimeraAgent] Failed to record evolution outcomes:', error);
    }
  }

  /**
   * Calculate quality score from agent result
   * Returns 0-1 score based on completion, tool success, and response characteristics
   */
  private calculateQualityScore(result: AgentResult): number {
    let score = 0.5; // Base score

    // Successful completion
    if (result.stopReason === 'end_turn') {
      score += 0.2;
    }

    // Tool usage success rate
    if (result.toolCalls && result.toolCalls.length > 0) {
      const successCount = result.toolCalls.filter((tc) => !tc.error).length;
      const successRate = successCount / result.toolCalls.length;
      score += successRate * 0.2;
    }

    // Response has content
    if (result.output && result.output.length > 10) {
      score += 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Perform self-reflection after each interaction
   *
   * Analyzes the interaction quality and updates evolution metrics.
   * This creates a feedback loop where the agent monitors its own
   * performance and can recommend evolution actions.
   */
  private async performSelfReflection(userMessage: string, result: AgentResult): Promise<void> {
    try {
      // Extract interaction metadata
      const hadToolCalls = result.toolCalls && result.toolCalls.length > 0;
      const toolErrors = result.toolCalls?.filter(tc => tc.error).length || 0;
      const toolSuccesses = result.toolCalls?.filter(tc => !tc.error).length || 0;

      // Calculate basic quality signals
      const interactionQuality = {
        completed: result.stopReason === 'end_turn',
        toolSuccessRate: hadToolCalls ? toolSuccesses / (toolSuccesses + toolErrors) : 1.0,
        responseLength: result.output.length,
        sessionId: result.sessionId,
        timestamp: new Date().toISOString(),
      };

      // Store reflection metadata in memory for evolution analysis
      await this.memoryClient.storeMessage({
        role: 'system',
        content: JSON.stringify({
          type: 'self_reflection',
          tenantId: this.context.tenantId,
          quality: interactionQuality,
        }),
        timestamp: new Date().toISOString(),
      });

      // Persist to DynamoDB for aggregation into EvolutionMetrics
      if (this.ddbClient && this.config.evolutionTable) {
        await this.ddbClient.send(
          new PutCommand({
            TableName: this.config.evolutionTable,
            Item: {
              PK: `TENANT#${this.context.tenantId}`,
              SK: `REFLECTION#${new Date().toISOString()}#${result.sessionId}`,
              type: 'self_reflection',
              tenantId: this.context.tenantId,
              sessionId: result.sessionId,
              timestamp: new Date().toISOString(),
              quality: interactionQuality,
              modelId: this.currentModelId,
              promptVariant: this.currentPromptVariant,
              taskCategory: this.config.taskCategory || 'analysis',
              // Include user message hash for pattern detection
              userMessageHash: this.hashString(userMessage),
              // TTL: 90 days
              ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
            },
          })
        );
      }

      // Log reflection data
      if (process.env.DEBUG === 'true') {
        console.log('[Self-Reflection]', {
          tenantId: this.context.tenantId,
          sessionId: result.sessionId,
          quality: interactionQuality,
          modelId: this.currentModelId,
          promptVariant: this.currentPromptVariant,
        });
      }
    } catch (error) {
      // Self-reflection errors should not break the agent
      console.warn('[ChimeraAgent] Self-reflection failed:', error);
    }
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

    const messages: Message[] = [];
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
        systemPrompt,
        modelId: this.currentModelId
      });

      const assistantMessage = response.output.message;

      // Emit text content
      const textBlocks = assistantMessage.content.filter((block): block is ContentBlock & { text: string } => !!block.text);
      for (const block of textBlocks) {
        yield {
          type: 'content_block_delta',
          delta: { text: block.text }
        };
      }

      // Check for tool use
      const toolUseBlocks = assistantMessage.content.filter((block): block is ContentBlock & { toolUse: NonNullable<ContentBlock['toolUse']> } => !!block.toolUse);

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

  /**
   * Capture user feedback signal
   *
   * Stores feedback events to DynamoDB for evolution subsystems to consume.
   * Feedback signals (thumbs up/down, corrections) train ModelRouter and PromptOptimizer.
   */
  async captureFeedback(params: {
    feedbackType: FeedbackType;
    feedbackValue?: string;
    turnIndex: number;
  }): Promise<void> {
    if (!this.ddbClient || !this.config.evolutionTable) {
      console.warn('[ChimeraAgent] Cannot capture feedback: DynamoDB client not configured');
      return;
    }

    try {
      const feedbackEvent: FeedbackEvent = {
        tenantId: this.context.tenantId,
        sessionId: this.context.sessionId,
        turnIndex: params.turnIndex,
        feedbackType: params.feedbackType,
        feedbackValue: params.feedbackValue,
        modelUsed: this.currentModelId || ('us.anthropic.claude-sonnet-4-6-v1:0' as ModelId),
        taskCategory: this.config.taskCategory || 'analysis',
        agentResponse: '', // Would be populated from conversation history
        userMessage: '', // Would be populated from conversation history
        processed: false,
        consumedBy: [],
        timestamp: new Date().toISOString(),
      };

      await this.ddbClient.send(
        new PutCommand({
          TableName: this.config.evolutionTable,
          Item: {
            PK: `TENANT#${this.context.tenantId}`,
            SK: `FEEDBACK#${feedbackEvent.timestamp}#${this.context.sessionId}`,
            ...feedbackEvent,
            // TTL: 90 days
            ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
          },
        })
      );

      if (process.env.DEBUG === 'true') {
        console.log('[Feedback]', {
          type: params.feedbackType,
          sessionId: this.context.sessionId,
          turnIndex: params.turnIndex,
        });
      }
    } catch (error) {
      console.error('[ChimeraAgent] Failed to capture feedback:', error);
    }
  }

  /**
   * Simple string hash for deduplication (not cryptographic)
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
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
