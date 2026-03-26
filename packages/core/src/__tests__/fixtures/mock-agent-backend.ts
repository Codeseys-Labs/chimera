/**
 * Mock agent backend for integration tests.
 *
 * Provides a stub `model.converse()` implementation that satisfies the
 * interface expected by the Agent class (AgentConfig.model), allowing
 * integration tests to exercise agent logic without real Bedrock calls.
 *
 * Usage:
 *   import { createMockAgentBackend } from './fixtures/mock-agent-backend';
 *   const backend = createMockAgentBackend({ response: 'Hello!' });
 *   const agent = new Agent({ ..., model: backend });
 */

import type { Message, ContentBlock } from '../../agent/bedrock-model';

export interface MockAgentBackendOptions {
  /** Fixed text response to return for all converse() calls */
  response?: string;
  /** Stop reason to return (defaults to 'end_turn') */
  stopReason?: string;
  /** If provided, throw this error on converse() calls */
  error?: Error;
  /** Optional tool use block to include in response */
  toolUse?: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  };
}

export interface ModelBackend {
  converse(turn: {
    messages: Message[];
    tools?: unknown[];
    systemPrompt?: string;
    modelId?: string;
  }): Promise<{
    output: { message: Message };
    stopReason: string;
  }>;
  calls: Array<{
    messages: Message[];
    tools?: unknown[];
    systemPrompt?: string;
    modelId?: string;
  }>;
  reset(): void;
}

/**
 * Create a mock agent backend stub for testing.
 *
 * Records all converse() calls so tests can assert on invocations.
 */
export function createMockAgentBackend(
  options: MockAgentBackendOptions = {}
): ModelBackend {
  const { response = 'Mock response.', stopReason = 'end_turn', error, toolUse } = options;

  const calls: ModelBackend['calls'] = [];

  const contentBlocks: ContentBlock[] = [];

  if (toolUse) {
    contentBlocks.push({
      toolUse: {
        toolUseId: toolUse.toolUseId,
        name: toolUse.name,
        input: toolUse.input,
      },
    } as ContentBlock);
  } else {
    contentBlocks.push({ text: response } as ContentBlock);
  }

  return {
    calls,

    reset() {
      calls.length = 0;
    },

    async converse(turn) {
      calls.push({ ...turn });

      if (error) {
        throw error;
      }

      return {
        output: {
          message: {
            role: 'assistant',
            content: contentBlocks,
          },
        },
        stopReason,
      };
    },
  };
}

/**
 * Create a mock backend that cycles through multiple responses.
 *
 * Useful for testing multi-turn conversations.
 */
export function createSequentialMockBackend(responses: string[]): ModelBackend {
  let callIndex = 0;
  const calls: ModelBackend['calls'] = [];

  return {
    calls,

    reset() {
      calls.length = 0;
      callIndex = 0;
    },

    async converse(turn) {
      calls.push({ ...turn });
      const response = responses[callIndex % responses.length];
      callIndex++;

      return {
        output: {
          message: {
            role: 'assistant',
            content: [{ text: response } as ContentBlock],
          },
        },
        stopReason: 'end_turn',
      };
    },
  };
}
