/**
 * Tests for BedrockModel - AWS Bedrock Converse API adapter
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { BedrockModel } from '../bedrock-model';
import type { BedrockRuntimeClient, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';

/**
 * Mock Bedrock client for testing
 */
class MockBedrockClient {
  private responses: ConverseCommandOutput[] = [];
  private callIndex: number = 0;
  private calls: any[] = [];

  constructor(responses: ConverseCommandOutput[]) {
    this.responses = responses;
  }

  async send(command: any): Promise<ConverseCommandOutput> {
    this.calls.push(command);

    if (this.callIndex >= this.responses.length) {
      throw new Error('MockBedrockClient: No more responses configured');
    }

    const response = this.responses[this.callIndex];
    this.callIndex++;
    return response;
  }

  getCalls() {
    return this.calls;
  }

  getCallCount() {
    return this.calls.length;
  }
}

/**
 * Helper to create mock Bedrock response
 */
function mockBedrockResponse(
  text: string,
  stopReason: string = 'end_turn',
  inputTokens: number = 100,
  outputTokens: number = 50
): ConverseCommandOutput {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [{ text }],
      },
    },
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    metrics: {
      latencyMs: 1000,
    },
    $metadata: {},
  };
}

/**
 * Helper to create mock Bedrock response with tool use
 */
function mockBedrockToolResponse(
  text: string,
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): ConverseCommandOutput {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [
          { text },
          {
            toolUse: {
              toolUseId,
              name: toolName,
              input: toolInput,
            },
          },
        ],
      },
    },
    stopReason: 'tool_use',
    usage: {
      inputTokens: 150,
      outputTokens: 75,
      totalTokens: 225,
    },
    metrics: {
      latencyMs: 1200,
    },
    $metadata: {},
  };
}

describe('BedrockModel', () => {
  describe('Configuration', () => {
    it('should create with default configuration', () => {
      const mockClient = new MockBedrockClient([]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const config = model.getConfig();
      expect(config.modelId).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
      expect(config.region).toBe('us-east-1');
      expect(config.maxTokens).toBe(4096);
      expect(config.temperature).toBe(1.0);
    });

    it('should create with custom configuration', () => {
      const mockClient = new MockBedrockClient([]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
        region: 'us-west-2',
        maxTokens: 2048,
        temperature: 0.7,
        topP: 0.9,
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const config = model.getConfig();
      expect(config.modelId).toBe('anthropic.claude-3-haiku-20240307-v1:0');
      expect(config.region).toBe('us-west-2');
      expect(config.maxTokens).toBe(2048);
      expect(config.temperature).toBe(0.7);
      expect(config.topP).toBe(0.9);
    });
  });

  describe('Simple text conversations', () => {
    it('should handle simple text request and response', async () => {
      const mockClient = new MockBedrockClient([
        mockBedrockResponse('Hello! How can I help you today?'),
      ]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const response = await model.converse({
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hi there!' }],
          },
        ],
        systemPrompt: 'You are a helpful assistant.',
      });

      expect(response.output.message.role).toBe('assistant');
      expect(response.output.message.content).toHaveLength(1);
      expect(response.output.message.content[0].text).toBe('Hello! How can I help you today?');
      expect(response.stopReason).toBe('end_turn');
      expect(response.metrics.inputTokens).toBe(100);
      expect(response.metrics.outputTokens).toBe(50);
    });

    it('should pass system prompt to Bedrock', async () => {
      const mockClient = new MockBedrockClient([
        mockBedrockResponse('Response'),
      ]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'Test' }] }],
        systemPrompt: 'You are a test assistant.',
      });

      const calls = mockClient.getCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].input.system).toBeDefined();
      expect(calls[0].input.system[0].text).toBe('You are a test assistant.');
    });

    it('should use custom inference config', async () => {
      const mockClient = new MockBedrockClient([
        mockBedrockResponse('Response'),
      ]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        maxTokens: 2048,
        temperature: 0.5,
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'Test' }] }],
      });

      const calls = mockClient.getCalls();
      expect(calls[0].input.inferenceConfig.maxTokens).toBe(2048);
      expect(calls[0].input.inferenceConfig.temperature).toBe(0.5);
    });

    it('should override model config with turn-specific config', async () => {
      const mockClient = new MockBedrockClient([
        mockBedrockResponse('Response'),
      ]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        maxTokens: 4096,
        temperature: 1.0,
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'Test' }] }],
        maxTokens: 1024,
        temperature: 0.3,
      });

      const calls = mockClient.getCalls();
      expect(calls[0].input.inferenceConfig.maxTokens).toBe(1024);
      expect(calls[0].input.inferenceConfig.temperature).toBe(0.3);
    });
  });

  describe('Tool use', () => {
    it('should handle tool use requests', async () => {
      const mockClient = new MockBedrockClient([
        mockBedrockToolResponse(
          'Let me check the weather for you.',
          'tool_use_1',
          'get_weather',
          { location: 'Seattle' }
        ),
      ]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const response = await model.converse({
        messages: [{ role: 'user', content: [{ text: 'What is the weather in Seattle?' }] }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a location',
            inputSchema: {
              type: 'object',
              properties: {
                location: { type: 'string' },
              },
              required: ['location'],
            },
          },
        ],
      });

      expect(response.output.message.content).toHaveLength(2);
      expect(response.output.message.content[0].text).toBe('Let me check the weather for you.');
      expect(response.output.message.content[1].toolUse).toBeDefined();
      expect(response.output.message.content[1].toolUse!.toolUseId).toBe('tool_use_1');
      expect(response.output.message.content[1].toolUse!.name).toBe('get_weather');
      expect(response.output.message.content[1].toolUse!.input).toEqual({ location: 'Seattle' });
      expect(response.stopReason).toBe('tool_use');
    });

    it('should send tools to Bedrock in correct format', async () => {
      const mockClient = new MockBedrockClient([
        mockBedrockResponse('Done'),
      ]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'Test' }] }],
        tools: [
          {
            name: 'test_tool',
            description: 'A test tool',
            inputSchema: {
              type: 'object',
              properties: {
                param: { type: 'string' },
              },
            },
          },
        ],
      });

      const calls = mockClient.getCalls();
      expect(calls[0].input.toolConfig).toBeDefined();
      expect(calls[0].input.toolConfig.tools).toHaveLength(1);
      expect(calls[0].input.toolConfig.tools[0].toolSpec.name).toBe('test_tool');
      expect(calls[0].input.toolConfig.tools[0].toolSpec.description).toBe('A test tool');
    });

    it('should handle tool result messages', async () => {
      const mockClient = new MockBedrockClient([
        mockBedrockResponse('The weather is sunny and 72°F.'),
      ]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const response = await model.converse({
        messages: [
          { role: 'user', content: [{ text: 'What is the weather?' }] },
          {
            role: 'assistant',
            content: [
              { text: 'Let me check.' },
              {
                toolUse: {
                  toolUseId: 'tool_1',
                  name: 'get_weather',
                  input: { location: 'Seattle' },
                },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: 'tool_1',
                  content: 'Sunny, 72°F',
                  status: 'success',
                },
              },
            ],
          },
        ],
      });

      expect(response.output.message.content[0].text).toBe('The weather is sunny and 72°F.');
      expect(mockClient.getCallCount()).toBe(1);
    });
  });

  describe('Multi-turn conversations', () => {
    it('should handle conversation history', async () => {
      const mockClient = new MockBedrockClient([
        mockBedrockResponse('Nice to meet you too!'),
      ]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const response = await model.converse({
        messages: [
          { role: 'user', content: [{ text: 'Hello' }] },
          { role: 'assistant', content: [{ text: 'Hi there!' }] },
          { role: 'user', content: [{ text: 'Nice to meet you' }] },
        ],
      });

      expect(response.output.message.content[0].text).toBe('Nice to meet you too!');

      const calls = mockClient.getCalls();
      expect(calls[0].input.messages).toHaveLength(3);
      expect(calls[0].input.messages[0].content[0].text).toBe('Hello');
      expect(calls[0].input.messages[1].content[0].text).toBe('Hi there!');
      expect(calls[0].input.messages[2].content[0].text).toBe('Nice to meet you');
    });
  });

  describe('Error handling', () => {
    it('should throw error for invalid Bedrock response', async () => {
      const mockClient = new MockBedrockClient([
        {} as ConverseCommandOutput, // Invalid response
      ]);

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      await expect(
        model.converse({
          messages: [{ role: 'user', content: [{ text: 'Test' }] }],
        })
      ).rejects.toThrow('Invalid Bedrock response');
    });
  });
});
