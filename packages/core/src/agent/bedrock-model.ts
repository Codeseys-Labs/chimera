/**
 * Bedrock Model Adapter - Wraps AWS Bedrock Converse API for ChimeraAgent
 *
 * Supports both synchronous (converse) and streaming (converseStream) modes.
 * The streaming mode uses ConverseStreamCommand for true token-level streaming.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommandInput,
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
  /** Model ID (e.g., 'us.anthropic.claude-sonnet-4-6') */
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
  modelId?: string;
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
 * Events emitted by the streaming converseStream method.
 * These map closely to Bedrock's ConverseStreamOutput events.
 */
export type BedrockStreamEvent =
  | { type: 'messageStart' }
  | {
      type: 'contentBlockStart';
      blockIndex: number;
      blockType: 'text' | 'tool_use';
      toolUse?: { toolUseId: string; name: string };
    }
  | {
      type: 'contentBlockDelta';
      blockIndex: number;
      delta: { text?: string; toolUseInput?: string };
    }
  | { type: 'contentBlockStop'; blockIndex: number }
  | { type: 'messageStop'; stopReason: string }
  | { type: 'metadata'; inputTokens: number; outputTokens: number };

/**
 * BedrockModel wraps AWS Bedrock Converse API for agent integration.
 * Supports both synchronous (converse) and streaming (converseStream) modes.
 */
export class BedrockModel {
  private client: BedrockRuntimeClient;
  private config: Omit<Required<Omit<BedrockModelConfig, 'client'>>, 'topP'> & { topP?: number };

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
          toolUseId: block.toolUse.toolUseId ?? '',
          name: block.toolUse.name ?? '',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: block.toolUse.input as any,
        },
      };
    }

    if (block.toolResult) {
      return {
        toolResult: {
          toolUseId: block.toolResult.toolUseId ?? '',
          content:
            typeof block.toolResult.content === 'string'
              ? [{ text: block.toolResult.content }]
              : // eslint-disable-next-line @typescript-eslint/no-explicit-any
                [{ json: block.toolResult.content as any }],
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
      content: message.content.map((block) => this.convertContentBlock(block)),
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          json: tool.inputSchema as any,
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
          toolUseId: block.toolUse.toolUseId ?? '',
          name: block.toolUse.name ?? '',
          input: block.toolUse.input as Record<string, unknown>,
        },
      };
    }

    if (block.toolResult) {
      const content = block.toolResult.content;
      let contentStr: string | Record<string, unknown>;

      if (Array.isArray(content)) {
        const firstItem = content[0];
        if (firstItem && 'text' in firstItem) {
          contentStr = firstItem.text as string;
        } else if (firstItem && 'json' in firstItem) {
          contentStr = firstItem.json as Record<string, unknown>;
        } else {
          contentStr = JSON.stringify(content);
        }
      } else {
        contentStr = content as unknown as string;
      }

      return {
        toolResult: {
          toolUseId: block.toolResult.toolUseId ?? '',
          content: contentStr,
          status: block.toolResult.status as 'success' | 'error',
        },
      };
    }

    throw new Error('Invalid Bedrock content block');
  }

  /**
   * Build Bedrock API input from a ConverseTurn.
   */
  private buildInput(turn: ConverseTurn): ConverseCommandInput {
    const input: ConverseCommandInput = {
      modelId: turn.modelId || this.config.modelId,
      messages: turn.messages.map((msg) => this.convertMessage(msg)),
      inferenceConfig: {
        maxTokens: turn.maxTokens || this.config.maxTokens,
        temperature: turn.temperature !== undefined ? turn.temperature : this.config.temperature,
        topP: this.config.topP,
      },
    };

    if (turn.systemPrompt) {
      input.system = [{ text: turn.systemPrompt }];
    }

    if (turn.tools && turn.tools.length > 0) {
      input.toolConfig = {
        tools: turn.tools.map((tool) => this.convertTool(tool)),
      };
    }

    return input;
  }

  /**
   * Call Bedrock Converse API (synchronous — waits for full response).
   * Used as fallback and for tool result handling.
   */
  async converse(turn: ConverseTurn): Promise<ConverseResponse> {
    const input = this.buildInput(turn);
    const command = new ConverseCommand(input);
    const response: ConverseCommandOutput = await this.client.send(command);

    if (!response.output || !response.output.message) {
      throw new Error('Invalid Bedrock response: missing output.message');
    }

    const assistantMessage = response.output.message;
    const contentBlocks = (assistantMessage.content || []).map((block) =>
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
   * Call Bedrock ConverseStream API — yields events token-by-token.
   *
   * This is the key method for true streaming. Each text token arrives
   * as a separate contentBlockDelta event, giving the user immediate
   * visual feedback as the model generates.
   *
   * Also returns the assembled assistant message for ReAct loop continuation.
   */
  async *converseStream(
    turn: ConverseTurn
  ): AsyncGenerator<BedrockStreamEvent, ConverseResponse, unknown> {
    const input = this.buildInput(turn) as ConverseStreamCommandInput;
    const command = new ConverseStreamCommand(input);
    const response = await this.client.send(command);

    if (!response.stream) {
      throw new Error('Invalid Bedrock response: missing stream');
    }

    // Accumulate the full response for return value
    const contentBlocks: ContentBlock[] = [];
    let currentBlockIndex = -1;
    let currentText = '';
    let currentToolInput = '';
    let currentToolUseId = '';
    let currentToolName = '';
    let stopReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of response.stream) {
      if (event.messageStart) {
        yield { type: 'messageStart' };
      }

      if (event.contentBlockStart) {
        currentBlockIndex = event.contentBlockStart.contentBlockIndex ?? 0;
        const startEvent = event.contentBlockStart.start;

        if (startEvent && 'toolUse' in startEvent && startEvent.toolUse) {
          currentToolUseId = startEvent.toolUse.toolUseId ?? '';
          currentToolName = startEvent.toolUse.name ?? '';
          currentToolInput = '';
          yield {
            type: 'contentBlockStart',
            blockIndex: currentBlockIndex,
            blockType: 'tool_use',
            toolUse: { toolUseId: currentToolUseId, name: currentToolName },
          };
        } else {
          currentText = '';
          yield {
            type: 'contentBlockStart',
            blockIndex: currentBlockIndex,
            blockType: 'text',
          };
        }
      }

      if (event.contentBlockDelta) {
        const delta = event.contentBlockDelta.delta;
        if (delta && 'text' in delta && delta.text) {
          currentText += delta.text;
          yield {
            type: 'contentBlockDelta',
            blockIndex: event.contentBlockDelta.contentBlockIndex ?? currentBlockIndex,
            delta: { text: delta.text },
          };
        }
        if (delta && 'toolUse' in delta && delta.toolUse?.input) {
          currentToolInput += delta.toolUse.input;
          yield {
            type: 'contentBlockDelta',
            blockIndex: event.contentBlockDelta.contentBlockIndex ?? currentBlockIndex,
            delta: { toolUseInput: delta.toolUse.input },
          };
        }
      }

      if (event.contentBlockStop) {
        const blockIdx = event.contentBlockStop.contentBlockIndex ?? currentBlockIndex;
        // Assemble the block
        if (currentToolName) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(currentToolInput);
          } catch {
            /* invalid JSON — leave empty */
          }
          contentBlocks.push({
            toolUse: {
              toolUseId: currentToolUseId,
              name: currentToolName,
              input: parsedInput,
            },
          });
          currentToolName = '';
          currentToolUseId = '';
          currentToolInput = '';
        } else if (currentText) {
          contentBlocks.push({ text: currentText });
          currentText = '';
        }
        yield { type: 'contentBlockStop', blockIndex: blockIdx };
      }

      if (event.messageStop) {
        stopReason = event.messageStop.stopReason ?? 'end_turn';
        yield { type: 'messageStop', stopReason };
      }

      if (event.metadata) {
        inputTokens = event.metadata.usage?.inputTokens ?? 0;
        outputTokens = event.metadata.usage?.outputTokens ?? 0;
        yield { type: 'metadata', inputTokens, outputTokens };
      }
    }

    // Return the assembled response for the ReAct loop
    return {
      output: {
        message: {
          role: 'assistant' as const,
          content: contentBlocks,
        },
      },
      stopReason,
      metrics: { inputTokens, outputTokens },
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
