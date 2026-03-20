/**
 * Mock LLM provider for deterministic unit and integration testing.
 * Replaces real Bedrock model calls with pre-configured responses.
 *
 * Based on MockModel pattern from docs/research/enhancement/06-Testing-Strategy.md
 */

export interface MockResponse {
  /** Text content of the assistant response */
  text?: string;
  /** Tool calls to simulate */
  toolCalls?: MockToolCall[];
  /** Stop reason (end_turn, tool_use, max_tokens, etc.) */
  stopReason?: string;
  /** Simulated token usage */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface MockToolCall {
  /** Tool use ID */
  id: string;
  /** Tool name */
  name: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
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
  role: 'user' | 'assistant' | 'system';
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
 * MockModel provides deterministic responses for agent testing.
 * Simulates Bedrock Converse API behavior without LLM calls.
 *
 * @example
 * ```typescript
 * const model = new MockModel([
 *   { text: "I'll search for that.", toolCalls: [
 *     { id: "tc_1", name: "web_search", input: { query: "test" } }
 *   ]},
 *   { text: "Here's what I found..." },
 * ]);
 *
 * const response = await model.converse({
 *   messages: [{ role: 'user', content: [{ text: 'Search for test' }] }],
 *   tools: [webSearchTool],
 * });
 *
 * expect(response.output.message.content[0].toolUse).toBeDefined();
 * expect(model.getCallCount()).toBe(1);
 * ```
 */
export class MockModel {
  private responses: MockResponse[];
  private callIndex: number = 0;
  private callHistory: ConverseTurn[] = [];

  /**
   * Create a mock model with pre-configured responses.
   *
   * @param responses - Array of responses to return in sequence
   */
  constructor(responses: MockResponse[]) {
    if (responses.length === 0) {
      throw new Error('MockModel requires at least one response');
    }
    this.responses = responses;
  }

  /**
   * Simulate Bedrock Converse API call.
   */
  async converse(turn: ConverseTurn): Promise<ConverseResponse> {
    // Record call for assertions
    this.callHistory.push({
      messages: turn.messages,
      tools: turn.tools,
      systemPrompt: turn.systemPrompt,
      maxTokens: turn.maxTokens,
      temperature: turn.temperature,
    });

    // Check if we've exhausted responses
    if (this.callIndex >= this.responses.length) {
      throw new Error(
        `MockModel exhausted: ${this.callIndex} calls made, ` +
        `only ${this.responses.length} responses configured. ` +
        `Consider adding more mock responses or checking for unexpected agent loops.`
      );
    }

    const response = this.responses[this.callIndex];
    this.callIndex += 1;

    // Build content blocks
    const content: ContentBlock[] = [];

    if (response.text) {
      content.push({ text: response.text });
    }

    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        content.push({
          toolUse: {
            toolUseId: tc.id,
            name: tc.name,
            input: tc.input,
          },
        });
      }
    }

    // Default token usage
    const tokenUsage = response.tokenUsage || {
      inputTokens: 100,
      outputTokens: response.text ? response.text.length / 4 : 50,
    };

    return {
      output: {
        message: {
          role: 'assistant',
          content,
        },
      },
      stopReason: response.stopReason || (response.toolCalls ? 'tool_use' : 'end_turn'),
      metrics: {
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
      },
    };
  }

  /**
   * Get number of converse calls made.
   */
  getCallCount(): number {
    return this.callHistory.length;
  }

  /**
   * Get all recorded converse calls.
   */
  getCallHistory(): ConverseTurn[] {
    return this.callHistory;
  }

  /**
   * Get the last converse call.
   */
  getLastCall(): ConverseTurn | undefined {
    return this.callHistory[this.callHistory.length - 1];
  }

  /**
   * Assert that the system prompt in the first call contains a substring.
   */
  assertCalledWithSystemPrompt(expectedSubstring: string): void {
    if (this.callHistory.length === 0) {
      throw new Error('MockModel was never called');
    }

    const firstCall = this.callHistory[0];
    const systemPrompt = firstCall.systemPrompt || '';

    if (!systemPrompt.includes(expectedSubstring)) {
      throw new Error(
        `System prompt did not contain '${expectedSubstring}'. ` +
        `Actual system prompt: ${systemPrompt.substring(0, 200)}...`
      );
    }
  }

  /**
   * Assert that a specific tool was provided in any call.
   */
  assertCalledWithTool(toolName: string): void {
    const foundTool = this.callHistory.some((call) =>
      call.tools?.some((tool) => tool.name === toolName)
    );

    if (!foundTool) {
      const toolNames = this.callHistory
        .flatMap((call) => call.tools?.map((t) => t.name) || [])
        .join(', ');
      throw new Error(
        `Tool '${toolName}' was never provided. Available tools: ${toolNames || 'none'}`
      );
    }
  }

  /**
   * Assert that the model was called exactly N times.
   */
  assertCallCount(expectedCount: number): void {
    const actualCount = this.callHistory.length;
    if (actualCount !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} converse calls, but got ${actualCount}`
      );
    }
  }

  /**
   * Assert that the model was called at least N times.
   */
  assertMinCallCount(minCount: number): void {
    const actualCount = this.callHistory.length;
    if (actualCount < minCount) {
      throw new Error(
        `Expected at least ${minCount} converse calls, but got ${actualCount}`
      );
    }
  }

  /**
   * Assert that a user message was sent containing specific text.
   */
  assertUserMessageContains(substring: string): void {
    const found = this.callHistory.some((call) =>
      call.messages.some(
        (msg) =>
          msg.role === 'user' &&
          msg.content.some(
            (block) => block.text && block.text.includes(substring)
          )
      )
    );

    if (!found) {
      throw new Error(`No user message contained '${substring}'`);
    }
  }

  /**
   * Reset call history and index (useful between test cases).
   */
  reset(): void {
    this.callIndex = 0;
    this.callHistory = [];
  }

  /**
   * Add more responses dynamically (extends the sequence).
   */
  addResponses(...responses: MockResponse[]): void {
    this.responses.push(...responses);
  }
}

/**
 * Create a simple text-only mock response.
 */
export function mockTextResponse(text: string): MockResponse {
  return { text };
}

/**
 * Create a mock response with a tool call.
 */
export function mockToolCallResponse(
  text: string,
  toolName: string,
  input: Record<string, unknown>
): MockResponse {
  return {
    text,
    toolCalls: [
      {
        id: `tc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        name: toolName,
        input,
      },
    ],
  };
}

/**
 * Create a mock response simulating an error.
 */
export function mockErrorResponse(): MockResponse {
  return {
    text: "I encountered an error and cannot complete this request.",
    stopReason: 'end_turn',
  };
}
