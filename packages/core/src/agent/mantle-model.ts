/**
 * Bedrock Mantle Model — OpenAI-compatible inference via Bedrock Mantle
 *
 * Mantle is Bedrock's distributed inference engine exposing OpenAI-compatible
 * endpoints at bedrock-mantle.{region}.api.aws. Supports:
 * - Chat Completions API (/v1/chat/completions)
 * - Responses API (/v1/responses) — stateful conversations
 * - Streaming SSE in OpenAI format
 * - All Bedrock models including OpenAI GPT-OSS
 *
 * Authentication: Bedrock API key or SigV4 bearer token.
 */

import type { ConverseTurn, ConverseResponse, Message, ContentBlock } from './bedrock-model';

export interface MantleModelConfig {
  /** Model ID (e.g., 'openai.gpt-oss-120b', 'us.anthropic.claude-sonnet-4-6') */
  modelId: string;

  /** AWS region for Mantle endpoint (default: us-east-1) */
  region?: string;

  /** Bedrock API key (required for Mantle auth) */
  apiKey?: string;

  /** Max tokens (default: 4096) */
  maxTokens?: number;

  /** Temperature (default: 1.0) */
  temperature?: number;

  /** Override base URL (default: https://bedrock-mantle.{region}.api.aws/v1) */
  baseUrl?: string;
}

/** OpenAI-format message for Chat Completions API */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** OpenAI Chat Completions response */
interface OpenAIChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** SSE chunk from streaming chat completions */
interface OpenAIStreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

/** Stream events emitted by converseStream */
export type MantleStreamEvent =
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
 * MantleModel provides the same interface as BedrockModel but routes through
 * Bedrock Mantle's OpenAI-compatible endpoint instead of the Converse API.
 *
 * Use this for:
 * - OpenAI GPT-OSS models (only available via Mantle)
 * - Any model when you want OpenAI SDK compatibility
 * - Migrating from OpenAI with minimal changes
 */
export class MantleModel {
  private baseUrl: string;
  private apiKey: string;
  private config: {
    modelId: string;
    region: string;
    maxTokens: number;
    temperature: number;
  };

  constructor(config: MantleModelConfig) {
    this.config = {
      modelId: config.modelId,
      region: config.region || 'us-east-1',
      maxTokens: config.maxTokens || 4096,
      temperature: config.temperature || 1.0,
    };

    this.apiKey = config.apiKey || process.env.BEDROCK_MANTLE_API_KEY || '';
    this.baseUrl = config.baseUrl || `https://bedrock-mantle.${this.config.region}.api.aws/v1`;
  }

  /**
   * Convert Chimera messages to OpenAI format
   */
  private convertMessages(messages: Message[], systemPrompt?: string): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        // Check for tool results
        const toolResults = msg.content.filter((b) => b.toolResult);
        if (toolResults.length > 0) {
          for (const block of toolResults) {
            result.push({
              role: 'tool',
              content:
                typeof block.toolResult!.content === 'string'
                  ? block.toolResult!.content
                  : JSON.stringify(block.toolResult!.content),
              tool_call_id: block.toolResult!.toolUseId,
            });
          }
        } else {
          const text = msg.content
            .filter((b) => b.text)
            .map((b) => b.text!)
            .join('');
          result.push({ role: 'user', content: text });
        }
      } else if (msg.role === 'assistant') {
        const text = msg.content
          .filter((b) => b.text)
          .map((b) => b.text!)
          .join('');
        const toolUses = msg.content.filter((b) => b.toolUse);

        const oaiMsg: OpenAIMessage = {
          role: 'assistant',
          content: text || null,
        };

        if (toolUses.length > 0) {
          oaiMsg.tool_calls = toolUses.map((b) => ({
            id: b.toolUse!.toolUseId,
            type: 'function' as const,
            function: {
              name: b.toolUse!.name,
              arguments: JSON.stringify(b.toolUse!.input),
            },
          }));
        }

        result.push(oaiMsg);
      }
    }

    return result;
  }

  /**
   * Convert OpenAI response to Chimera ConverseResponse format
   */
  private convertResponse(response: OpenAIChatResponse): ConverseResponse {
    const choice = response.choices[0];
    if (!choice) throw new Error('Empty response from Mantle');

    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({ text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          /* invalid JSON */
        }
        content.push({
          toolUse: {
            toolUseId: tc.id,
            name: tc.function.name,
            input,
          },
        });
      }
    }

    // Map OpenAI finish_reason to Bedrock stop reason
    const stopReasonMap: Record<string, string> = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      content_filter: 'content_filtered',
    };

    return {
      output: {
        message: { role: 'assistant', content },
      },
      stopReason: stopReasonMap[choice.finish_reason] || 'end_turn',
      metrics: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      },
    };
  }

  /**
   * Non-streaming converse (Chat Completions API, stream: false)
   */
  async converse(turn: ConverseTurn): Promise<ConverseResponse> {
    const messages = this.convertMessages(turn.messages, turn.systemPrompt);

    const body: Record<string, unknown> = {
      model: turn.modelId || this.config.modelId,
      messages,
      max_tokens: turn.maxTokens || this.config.maxTokens,
      temperature: turn.temperature !== undefined ? turn.temperature : this.config.temperature,
      stream: false,
    };

    // Add tools if provided
    if (turn.tools && turn.tools.length > 0) {
      body.tools = turn.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Mantle API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    return this.convertResponse(data);
  }

  /**
   * Streaming converse (Chat Completions API, stream: true)
   *
   * Yields events in the same format as BedrockModel.converseStream()
   * for transparent substitution in the agent ReAct loop.
   */
  async *converseStream(
    turn: ConverseTurn
  ): AsyncGenerator<MantleStreamEvent, ConverseResponse, unknown> {
    const messages = this.convertMessages(turn.messages, turn.systemPrompt);

    const body: Record<string, unknown> = {
      model: turn.modelId || this.config.modelId,
      messages,
      max_tokens: turn.maxTokens || this.config.maxTokens,
      temperature: turn.temperature !== undefined ? turn.temperature : this.config.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (turn.tools && turn.tools.length > 0) {
      body.tools = turn.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Mantle streaming error ${response.status}: ${errText}`);
    }

    if (!response.body) throw new Error('No response body from Mantle');

    // Accumulate for the return value
    let fullText = '';
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let finishReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    let emittedStart = false;
    let textBlockStarted = false;
    let textBlockIndex = 0;

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        if (!emittedStart) {
          emittedStart = true;
          yield { type: 'messageStart' };
        }

        for (const choice of chunk.choices) {
          const delta = choice.delta;

          // Text content
          if (delta.content) {
            if (!textBlockStarted) {
              textBlockStarted = true;
              yield { type: 'contentBlockStart', blockIndex: textBlockIndex, blockType: 'text' };
            }
            fullText += delta.content;
            yield {
              type: 'contentBlockDelta',
              blockIndex: textBlockIndex,
              delta: { text: delta.content },
            };
          }

          // Tool calls
          if (delta.tool_calls) {
            // Close text block if open
            if (textBlockStarted) {
              yield { type: 'contentBlockStop', blockIndex: textBlockIndex };
              textBlockStarted = false;
              textBlockIndex++;
            }

            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, { id: tc.id || '', name: '', arguments: '' });
                yield {
                  type: 'contentBlockStart',
                  blockIndex: textBlockIndex + idx,
                  blockType: 'tool_use',
                  toolUse: { toolUseId: tc.id || '', name: tc.function?.name || '' },
                };
              }
              const existing = toolCalls.get(idx)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) {
                existing.arguments += tc.function.arguments;
                yield {
                  type: 'contentBlockDelta',
                  blockIndex: textBlockIndex + idx,
                  delta: { toolUseInput: tc.function.arguments },
                };
              }
            }
          }

          if (choice.finish_reason) {
            const reasonMap: Record<string, string> = {
              stop: 'end_turn',
              length: 'max_tokens',
              tool_calls: 'tool_use',
              content_filter: 'content_filtered',
            };
            finishReason = reasonMap[choice.finish_reason] || 'end_turn';
          }
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || 0;
        }
      }
    }

    // Close any open blocks
    if (textBlockStarted) {
      yield { type: 'contentBlockStop', blockIndex: textBlockIndex };
    }
    for (const [idx] of toolCalls) {
      yield { type: 'contentBlockStop', blockIndex: textBlockIndex + idx };
    }

    yield { type: 'messageStop', stopReason: finishReason };
    yield { type: 'metadata', inputTokens, outputTokens };

    // Assemble return value
    const content: ContentBlock[] = [];
    if (fullText) content.push({ text: fullText });
    for (const [, tc] of toolCalls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.arguments);
      } catch {
        /* invalid JSON */
      }
      content.push({
        toolUse: { toolUseId: tc.id, name: tc.name, input },
      });
    }

    return {
      output: { message: { role: 'assistant', content } },
      stopReason: finishReason,
      metrics: { inputTokens, outputTokens },
    };
  }

  getModelId(): string {
    return this.config.modelId;
  }

  getConfig(): Omit<MantleModelConfig, 'apiKey'> {
    return {
      modelId: this.config.modelId,
      region: this.config.region,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      baseUrl: this.baseUrl,
    };
  }
}

export function createMantleModel(config: MantleModelConfig): MantleModel {
  return new MantleModel(config);
}
