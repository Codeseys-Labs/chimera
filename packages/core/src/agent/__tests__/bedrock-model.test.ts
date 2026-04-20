/**
 * Tests for BedrockModel - AWS Bedrock Converse API adapter
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
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

  describe('converseStream — messageStop flush race (H3)', () => {
    it('should flush a pending tool_use block when messageStop arrives without contentBlockStop', async () => {
      // Simulate the race: contentBlockStart(tool_use) + deltas + messageStop
      // but NO contentBlockStop. Prior to the fix, the tool call would be
      // silently lost because only `contentBlockStop` pushed into contentBlocks.
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: 'tool_race_1', name: 'get_weather' } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"location":' } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '"Seattle"}' } },
          },
        },
        // NOTE: deliberately NO contentBlockStop here — this is the race.
        { messageStop: { stopReason: 'tool_use' } },
        {
          metadata: { usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 } },
        },
      ];

      async function* streamGen() {
        for (const ev of streamEvents) yield ev;
      }

      const mockClient = {
        send: async () => ({ stream: streamGen() }),
      };

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const events: any[] = [];
      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'weather?' }] }],
      });

      let result: any;
      while (true) {
        const next = await gen.next();
        if (next.done) {
          result = next.value;
          break;
        }
        events.push(next.value);
      }

      // The assembled response MUST include the tool_use block even though
      // contentBlockStop never arrived.
      expect(result.output.message.content).toHaveLength(1);
      expect(result.output.message.content[0].toolUse).toBeDefined();
      expect(result.output.message.content[0].toolUse.toolUseId).toBe('tool_race_1');
      expect(result.output.message.content[0].toolUse.name).toBe('get_weather');
      expect(result.output.message.content[0].toolUse.input).toEqual({ location: 'Seattle' });
      expect(result.stopReason).toBe('tool_use');

      // A synthetic contentBlockStop must be emitted BEFORE messageStop so
      // downstream consumers see a consistent start/stop sequence.
      const stopIdx = events.findIndex((e) => e.type === 'contentBlockStop');
      const msgStopIdx = events.findIndex((e) => e.type === 'messageStop');
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(msgStopIdx).toBeGreaterThanOrEqual(0);
      expect(stopIdx).toBeLessThan(msgStopIdx);
    });
  });

  describe('converseStream — transient error retry (M3)', () => {
    it('should retry a ThrottlingException once and succeed on second attempt', async () => {
      let calls = 0;

      async function* streamGen() {
        yield { messageStart: { role: 'assistant' } };
        yield {
          contentBlockStart: { contentBlockIndex: 0, start: {} },
        };
        yield {
          contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hi' } },
        };
        yield { contentBlockStop: { contentBlockIndex: 0 } };
        yield { messageStop: { stopReason: 'end_turn' } };
        yield {
          metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
        };
      }

      const throttlingErr = Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
      });

      const mockClient = {
        send: async () => {
          calls++;
          if (calls === 1) throw throttlingErr;
          return { stream: streamGen() };
        },
      };

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      });

      let result: any;
      while (true) {
        const next = await gen.next();
        if (next.done) {
          result = next.value;
          break;
        }
      }

      expect(calls).toBe(2);
      expect(result.output.message.content[0].text).toBe('hi');
      expect(result.stopReason).toBe('end_turn');
    });

    it('should NOT retry on ValidationException', async () => {
      let calls = 0;
      const validationErr = Object.assign(new Error('Bad input'), {
        name: 'ValidationException',
      });

      const mockClient = {
        send: async () => {
          calls++;
          throw validationErr;
        },
      };

      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      });

      await expect(gen.next()).rejects.toThrow('Bad input');
      expect(calls).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Tier-ceiling enforcement — terminal gate before Bedrock invoke
  // -------------------------------------------------------------------------
  describe('tier-ceiling enforcement', () => {
    const OPUS = 'us.anthropic.claude-opus-4-7';
    const SONNET = 'us.anthropic.claude-sonnet-4-6-v1:0';
    const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

    let warnSpy: ReturnType<typeof mock>;
    let originalWarn: typeof console.warn;

    beforeEach(() => {
      originalWarn = console.warn;
      warnSpy = mock(() => {});
      console.warn = warnSpy as unknown as typeof console.warn;
    });

    afterEach(() => {
      console.warn = originalWarn;
    });

    it('basic tenant requesting Opus falls back to a cheaper allowed model at construction', () => {
      const mockClient = new MockBedrockClient([]);

      const model = new BedrockModel({
        modelId: OPUS,
        tier: 'basic',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      // modelId on the stored config must be downgraded.
      expect(model.getModelId()).not.toBe(OPUS);
      expect(model.getModelId()).toBe(HAIKU);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('basic tenant Opus request emits a warning mentioning the tier', () => {
      const mockClient = new MockBedrockClient([]);

      new BedrockModel({
        modelId: OPUS,
        tier: 'basic',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = (warnSpy.mock.calls[0] ?? [])[0] as string;
      expect(warnMsg).toContain('basic');
      expect(warnMsg).toContain(OPUS);
    });

    it('advanced tenant requesting Opus 4-6 (not allowlisted) falls back and warns', () => {
      const mockClient = new MockBedrockClient([]);

      const model = new BedrockModel({
        modelId: 'us.anthropic.claude-opus-4-6-v1:0',
        tier: 'advanced',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      expect(model.getModelId()).toBe(HAIKU);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('advanced tenant requesting Opus 4-7 succeeds (allowlisted)', () => {
      const mockClient = new MockBedrockClient([]);

      const model = new BedrockModel({
        modelId: OPUS,
        tier: 'advanced',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      expect(model.getModelId()).toBe(OPUS);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('premium tenant requesting Opus succeeds (no ceiling)', () => {
      const mockClient = new MockBedrockClient([]);

      const model = new BedrockModel({
        modelId: OPUS,
        tier: 'premium',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      expect(model.getModelId()).toBe(OPUS);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('basic tenant requesting Sonnet succeeds (explicitly allowed but costly)', () => {
      const mockClient = new MockBedrockClient([]);

      const model = new BedrockModel({
        modelId: SONNET,
        tier: 'basic',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      expect(model.getModelId()).toBe(SONNET);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('no tier configured means no enforcement (legacy / internal callers)', () => {
      const mockClient = new MockBedrockClient([]);

      const model = new BedrockModel({
        modelId: OPUS,
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      expect(model.getModelId()).toBe(OPUS);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('per-turn modelId override for a Basic tenant is downgraded before Bedrock invoke', async () => {
      const mockClient = new MockBedrockClient([
        mockBedrockResponse('ok'),
      ]);

      const model = new BedrockModel({
        modelId: HAIKU, // config default is allowed
        tier: 'basic',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      // Construction did not warn (HAIKU is allowed for basic).
      expect(warnSpy).not.toHaveBeenCalled();

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
        modelId: OPUS, // per-turn override tries to escalate to Opus
      });

      // The ConverseCommand MUST have been called with the enforced model,
      // NOT the requested Opus. This is the terminal gate.
      const calls = mockClient.getCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].input.modelId).not.toBe(OPUS);
      expect(calls[0].input.modelId).toBe(HAIKU);
      // Warning fires at invoke time for the per-turn override.
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('per-turn modelId override for a Premium tenant is passed through unchanged', async () => {
      const mockClient = new MockBedrockClient([
        mockBedrockResponse('ok'),
      ]);

      const model = new BedrockModel({
        modelId: HAIKU,
        tier: 'premium',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
        modelId: OPUS,
      });

      const calls = mockClient.getCalls();
      expect(calls[0].input.modelId).toBe(OPUS);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
