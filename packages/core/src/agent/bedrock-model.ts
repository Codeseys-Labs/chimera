/**
 * Bedrock Model Adapter - Wraps AWS Bedrock Converse API for ChimeraAgent
 *
 * Provides the same interface as MockModel but connects to real AWS Bedrock LLMs.
 * Supports Claude 3, Claude 4, and other Bedrock models via the Converse API.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandInput,
  ConverseCommandOutput,
  Message as BedrockMessage,
  ContentBlock as BedrockContentBlock,
  Tool as BedrockTool,
} from '@aws-sdk/client-bedrock-runtime';

// Module-level singleton client cache per region
// AWS SDK v3 clients are designed to be reused across requests
const bedrockClientCache = new Map<string, BedrockRuntimeClient>();

function getBedrockClient(region: string): BedrockRuntimeClient {
  if (!bedrockClientCache.has(region)) {
    bedrockClientCache.set(region, new BedrockRuntimeClient({ region }));
  }
  return bedrockClientCache.get(region)!;
}

export interface BedrockModelConfig {
  /** Model ID (e.g., 'anthropic.claude-3-sonnet-20240229-v1:0') */
  modelId: string;

  /** AWS region (default: us-east-1) */
  region?: string;

  /** Max tokens for responses (default: 4096) */
  maxTokens?: number;

  /** Temperature for sampling (default: 1.0) */
  temperature?: number;

  /** Top-p for nucleus sampling (default: undefined, uses model default) */
  topP?: number;

  /** Custom Bedrock client (optional, for testing or custom config) */
  client?: BedrockRuntimeClient;
}

export interface ConverseTurn {
  messages: Message[];
  tools?: ToolSpec[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ContentBlock {
  text?: string;
  toolUse?: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  };
  toolResult?: {
    toolUseId: string;
    content: string | Record<string, unknown>;
    status?: 'success' | 'error';
  };
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ConverseResponse {
  output: {
    message: {
      role: 'assistant';
      content: ContentBlock[];
    };
  };
  stopReason: string;
  metrics: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * BedrockModel wraps AWS Bedrock Converse API for agent integration.
 *
 * Usage:
 * ```typescript
 * const model = new BedrockModel({
 *   modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
 *   region: 'us-east-1',
 *   maxTokens: 4096,
 *   temperature: 1.0
 * });
 *
 * const agent = createAgent({
 *   systemPrompt: createDefaultSystemPrompt(),
 *   tenantId: 'tenant-123',
 *   model
 * });
 * ```
 */
export class BedrockModel {
  private client: BedrockRuntimeClient;
  private config: Required<Omit<BedrockModelConfig, 'client'>>;

  constructor(config: BedrockModelConfig) {
    this.config = {
      modelId: config.modelId,
      region: config.region || 'us-east-1',
      maxTokens: config.maxTokens || 4096,
      temperature: config.temperature || 1.0,
      topP: config.topP,
    };

    // Use provided client or get cached singleton
    this.client = config.client || getBedrockClient(this.config.region);
  }

  /**
   * Convert our ContentBlock format to Bedrock format
   */
  private convertContentBlock(block: ContentBlock): BedrockContentBlock {
    if (block.text) {
      return { text: block.text };
    }

    if (block.toolUse) {
      return {
        toolUse: {
          toolUseId: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: block.toolUse.input,
        },
      };
    }

    if (block.toolResult) {
      return {
        toolResult: {
          toolUseId: block.toolResult.toolUseId,
          content: typeof block.toolResult.content === 'string'
            ? [{ text: block.toolResult.content }]
            : [{ json: block.toolResult.content }],
          status: block.toolResult.status,
        },
      };
    }

    throw new Error('Invalid content block: must have text, toolUse, or toolResult');
  }

  /**
   * Convert our Message format to Bedrock format
   */
  private convertMessage(message: Message): BedrockMessage {
    return {
      role: message.role,
      content: message.content.map(block => this.convertContentBlock(block)),
    };
  }

  /**
   * Convert our ToolSpec format to Bedrock format
   */
  private convertTool(tool: ToolSpec): BedrockTool {
    return {
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          json: tool.inputSchema,
        },
      },
    };
  }

  /**
   * Convert Bedrock ContentBlock back to our format
   */
  private convertBedrockContentBlock(block: BedrockContentBlock): ContentBlock {
    if (block.text) {
      return { text: block.text };
    }

    if (block.toolUse) {
      return {
        toolUse: {
          toolUseId: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: block.toolUse.input as Record<string, unknown>,
        },
      };
    }

    // Bedrock shouldn't return toolResult in assistant messages, but handle it just in case
    if (block.toolResult) {
      const content = block.toolResult.content;
      let contentStr: string | Record<string, unknown>;

      if (Array.isArray(content)) {
        // Extract first content item
        const firstItem = content[0];
        if (firstItem && 'text' in firstItem) {
          contentStr = firstItem.text as string;
        } else if (firstItem && 'json' in firstItem) {
          contentStr = firstItem.json as Record<string, unknown>;
        } else {
          contentStr = JSON.stringify(content);
        }
      } else {
        contentStr = content as string;
      }

      return {
        toolResult: {
          toolUseId: block.toolResult.toolUseId,
          content: contentStr,
          status: block.toolResult.status as 'success' | 'error',
        },
      };
    }

    throw new Error('Invalid Bedrock content block');
  }

  /**
   * Call Bedrock Converse API
   */
  async converse(turn: ConverseTurn): Promise<ConverseResponse> {
    // Build Bedrock API request
    const input: ConverseCommandInput = {
      modelId: this.config.modelId,
      messages: turn.messages.map(msg => this.convertMessage(msg)),
      inferenceConfig: {
        maxTokens: turn.maxTokens || this.config.maxTokens,
        temperature: turn.temperature !== undefined ? turn.temperature : this.config.temperature,
        topP: this.config.topP,
      },
    };

    // Add system prompt if provided
    if (turn.systemPrompt) {
      input.system = [{ text: turn.systemPrompt }];
    }

    // Add tools if provided
    if (turn.tools && turn.tools.length > 0) {
      input.toolConfig = {
        tools: turn.tools.map(tool => this.convertTool(tool)),
      };
    }

    // Call Bedrock
    const command = new ConverseCommand(input);
    const response: ConverseCommandOutput = await this.client.send(command);

    // Validate response
    if (!response.output || !response.output.message) {
      throw new Error('Invalid Bedrock response: missing output.message');
    }

    // Convert response to our format
    const assistantMessage = response.output.message;
    const contentBlocks = (assistantMessage.content || []).map(block =>
      this.convertBedrockContentBlock(block)
    );

    return {
      output: {
        message: {
          role: 'assistant',
          content: contentBlocks,
        },
      },
      stopReason: response.stopReason || 'end_turn',
      metrics: {
        inputTokens: response.usage?.inputTokens || 0,
        outputTokens: response.usage?.outputTokens || 0,
      },
    };
  }

  /**
   * Get the model ID being used
   */
  getModelId(): string {
    return this.config.modelId;
  }

  /**
   * Get the current configuration
   */
  getConfig(): Omit<BedrockModelConfig, 'client'> {
    return { ...this.config };
  }
}

/**
 * Factory function to create a BedrockModel instance
 */
export function createBedrockModel(config: BedrockModelConfig): BedrockModel {
  return new BedrockModel(config);
}
