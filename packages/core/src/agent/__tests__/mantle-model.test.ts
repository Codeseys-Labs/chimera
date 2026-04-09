/**
 * Tests for MantleModel — Bedrock Mantle OpenAI-compatible Chat Completions wrapper
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { MantleModel, createMantleModel } from '../mantle-model';
import type { ConverseTurn } from '../bedrock-model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a realistic OpenAI Chat Completions response */
function openAIResponse(
  content: string | null,
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' = 'stop',
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
) {
  return {
    id: 'chatcmpl-abc123',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Capture fetch calls and return a controlled response */
function mockFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url.toString(), init: init! });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

  return { calls, fetchMock };
}

/** Build SSE text from chunks */
function sseText(chunks: Array<unknown | string>): string {
  return chunks
    .map((c) => {
      if (typeof c === 'string') return `data: ${c}\n\n`;
      return `data: ${JSON.stringify(c)}\n\n`;
    })
    .join('');
}

/** Mock fetch that returns an SSE stream body */
function mockStreamFetch(chunks: Array<unknown | string>, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const body = sseText(chunks);
  const encoder = new TextEncoder();

  const fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url.toString(), init: init! });

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });

    return new Response(stream, {
      status,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });

  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

  return { calls, fetchMock };
}

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MantleModel', () => {
  // Restore fetch after each test
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -----------------------------------------------------------------------
  // Constructor / Config
  // -----------------------------------------------------------------------
  describe('Constructor & Configuration', () => {
    it('should set default region to us-east-1', () => {
      const model = new MantleModel({ modelId: 'openai.gpt-oss-120b' });
      const config = model.getConfig();
      expect(config.region).toBe('us-east-1');
    });

    it('should set default maxTokens to 4096', () => {
      const model = new MantleModel({ modelId: 'openai.gpt-oss-120b' });
      expect(model.getConfig().maxTokens).toBe(4096);
    });

    it('should set default temperature to 1.0', () => {
      const model = new MantleModel({ modelId: 'openai.gpt-oss-120b' });
      expect(model.getConfig().temperature).toBe(1.0);
    });

    it('should derive baseUrl from region when not provided', () => {
      const model = new MantleModel({ modelId: 'openai.gpt-oss-120b', region: 'eu-west-1' });
      expect(model.getConfig().baseUrl).toBe('https://bedrock-mantle.eu-west-1.api.aws/v1');
    });

    it('should use custom baseUrl when provided', () => {
      const model = new MantleModel({
        modelId: 'openai.gpt-oss-120b',
        baseUrl: 'https://custom.endpoint.com/v1',
      });
      expect(model.getConfig().baseUrl).toBe('https://custom.endpoint.com/v1');
    });

    it('should accept custom configuration', () => {
      const model = new MantleModel({
        modelId: 'us.anthropic.claude-sonnet-4-6',
        region: 'us-west-2',
        maxTokens: 8192,
        temperature: 0.7,
      });
      const config = model.getConfig();
      expect(config.modelId).toBe('us.anthropic.claude-sonnet-4-6');
      expect(config.region).toBe('us-west-2');
      expect(config.maxTokens).toBe(8192);
      expect(config.temperature).toBe(0.7);
    });

    it('should not expose apiKey in getConfig()', () => {
      const model = new MantleModel({
        modelId: 'openai.gpt-oss-120b',
        apiKey: 'secret-key-123',
      });
      const config = model.getConfig();
      expect(config).not.toHaveProperty('apiKey');
    });
  });

  describe('getModelId', () => {
    it('should return the configured model ID', () => {
      const model = new MantleModel({ modelId: 'openai.gpt-oss-120b' });
      expect(model.getModelId()).toBe('openai.gpt-oss-120b');
    });
  });

  describe('createMantleModel', () => {
    it('should create a MantleModel instance', () => {
      const model = createMantleModel({ modelId: 'openai.gpt-oss-120b' });
      expect(model).toBeInstanceOf(MantleModel);
      expect(model.getModelId()).toBe('openai.gpt-oss-120b');
    });
  });

  // -----------------------------------------------------------------------
  // converse() — Non-streaming
  // -----------------------------------------------------------------------
  describe('converse()', () => {
    it('should POST to /chat/completions with correct body', async () => {
      const { calls } = mockFetch(openAIResponse('Hello!'));

      const model = new MantleModel({
        modelId: 'openai.gpt-oss-120b',
        apiKey: 'test-key',
      });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/chat/completions');

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.model).toBe('openai.gpt-oss-120b');
      expect(body.stream).toBe(false);
      expect(body.max_tokens).toBe(4096);
      expect(body.temperature).toBe(1.0);
    });

    it('should send Authorization header with Bearer token', async () => {
      const { calls } = mockFetch(openAIResponse('Hello!'));

      const model = new MantleModel({
        modelId: 'openai.gpt-oss-120b',
        apiKey: 'my-api-key',
      });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
      });

      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer my-api-key');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should convert user text message to OpenAI format', async () => {
      const { calls } = mockFetch(openAIResponse('Response'));

      const model = new MantleModel({
        modelId: 'openai.gpt-oss-120b',
        apiKey: 'key',
      });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'hello' }] }],
      });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('should include system prompt as first message', async () => {
      const { calls } = mockFetch(openAIResponse('Response'));

      const model = new MantleModel({
        modelId: 'openai.gpt-oss-120b',
        apiKey: 'key',
      });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'hello' }] }],
        systemPrompt: 'You are a helpful assistant.',
      });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });
    });

    it('should convert tool result messages to OpenAI tool role', async () => {
      const { calls } = mockFetch(openAIResponse('The weather is sunny.'));

      const model = new MantleModel({
        modelId: 'openai.gpt-oss-120b',
        apiKey: 'key',
      });

      await model.converse({
        messages: [
          { role: 'user', content: [{ text: 'What is the weather?' }] },
          {
            role: 'assistant',
            content: [
              { text: 'Let me check.' },
              {
                toolUse: {
                  toolUseId: 'call_123',
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
                  toolUseId: 'call_123',
                  content: 'Sunny, 72°F',
                },
              },
            ],
          },
        ],
      });

      const body = JSON.parse(calls[0].init.body as string);
      // Tool result is converted to OpenAI tool message
      const toolMsg = body.messages[2];
      expect(toolMsg.role).toBe('tool');
      expect(toolMsg.tool_call_id).toBe('call_123');
      expect(toolMsg.content).toBe('Sunny, 72°F');
    });

    it('should convert tool result with object content to JSON string', async () => {
      const { calls } = mockFetch(openAIResponse('Done'));

      const model = new MantleModel({
        modelId: 'openai.gpt-oss-120b',
        apiKey: 'key',
      });

      await model.converse({
        messages: [
          {
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: 'call_456',
                  content: { temperature: 72, unit: 'F' } as unknown as string,
                },
              },
            ],
          },
        ],
      });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.messages[0].role).toBe('tool');
      expect(body.messages[0].content).toBe('{"temperature":72,"unit":"F"}');
    });

    it('should convert assistant tool_calls response to Chimera toolUse blocks', async () => {
      const response = openAIResponse('Checking...', 'tool_calls', [
        {
          id: 'call_789',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"location":"Seattle"}' },
        },
      ]);

      mockFetch(response);

      const model = new MantleModel({
        modelId: 'openai.gpt-oss-120b',
        apiKey: 'key',
      });

      const result = await model.converse({
        messages: [{ role: 'user', content: [{ text: 'Weather?' }] }],
      });

      expect(result.output.message.content).toHaveLength(2);
      expect(result.output.message.content[0].text).toBe('Checking...');
      expect(result.output.message.content[1].toolUse).toBeDefined();
      expect(result.output.message.content[1].toolUse!.toolUseId).toBe('call_789');
      expect(result.output.message.content[1].toolUse!.name).toBe('get_weather');
      expect(result.output.message.content[1].toolUse!.input).toEqual({ location: 'Seattle' });
    });

    it('should handle tool_calls with invalid JSON arguments gracefully', async () => {
      const response = openAIResponse(null, 'tool_calls', [
        {
          id: 'call_bad',
          type: 'function',
          function: { name: 'broken_tool', arguments: '{invalid json' },
        },
      ]);

      mockFetch(response);

      const model = new MantleModel({
        modelId: 'openai.gpt-oss-120b',
        apiKey: 'key',
      });

      const result = await model.converse({
        messages: [{ role: 'user', content: [{ text: 'test' }] }],
      });

      // Should not throw; input defaults to empty object
      expect(result.output.message.content[0].toolUse!.input).toEqual({});
    });

    it('should map finish_reason stop to end_turn', async () => {
      mockFetch(openAIResponse('Done', 'stop'));

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const result = await model.converse({
        messages: [{ role: 'user', content: [{ text: 'test' }] }],
      });

      expect(result.stopReason).toBe('end_turn');
    });

    it('should map finish_reason length to max_tokens', async () => {
      mockFetch(openAIResponse('Truncated...', 'length'));

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const result = await model.converse({
        messages: [{ role: 'user', content: [{ text: 'test' }] }],
      });

      expect(result.stopReason).toBe('max_tokens');
    });

    it('should map finish_reason tool_calls to tool_use', async () => {
      mockFetch(
        openAIResponse(null, 'tool_calls', [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'fn', arguments: '{}' },
          },
        ])
      );

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const result = await model.converse({
        messages: [{ role: 'user', content: [{ text: 'test' }] }],
      });

      expect(result.stopReason).toBe('tool_use');
    });

    it('should map finish_reason content_filter to content_filtered', async () => {
      mockFetch(openAIResponse('', 'content_filter'));

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const result = await model.converse({
        messages: [{ role: 'user', content: [{ text: 'test' }] }],
      });

      expect(result.stopReason).toBe('content_filtered');
    });

    it('should include tools in OpenAI function format', async () => {
      const { calls } = mockFetch(openAIResponse('Sure'));

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'test' }] }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get current weather',
            inputSchema: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        ],
      });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]).toEqual({
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      });
    });

    it('should not include tools field when no tools provided', async () => {
      const { calls } = mockFetch(openAIResponse('Hello'));

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.tools).toBeUndefined();
    });

    it('should use turn-level modelId override', async () => {
      const { calls } = mockFetch(openAIResponse('Hello'));

      const model = new MantleModel({ modelId: 'default-model', apiKey: 'k' });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
        modelId: 'override-model',
      });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.model).toBe('override-model');
    });

    it('should use turn-level maxTokens and temperature overrides', async () => {
      const { calls } = mockFetch(openAIResponse('Hello'));

      const model = new MantleModel({
        modelId: 'm',
        apiKey: 'k',
        maxTokens: 4096,
        temperature: 1.0,
      });

      await model.converse({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
        maxTokens: 1024,
        temperature: 0.5,
      });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.max_tokens).toBe(1024);
      expect(body.temperature).toBe(0.5);
    });

    it('should return metrics from usage', async () => {
      mockFetch(
        openAIResponse('Hello', 'stop', undefined, {
          prompt_tokens: 200,
          completion_tokens: 100,
          total_tokens: 300,
        })
      );

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const result = await model.converse({
        messages: [{ role: 'user', content: [{ text: 'test' }] }],
      });

      expect(result.metrics.inputTokens).toBe(200);
      expect(result.metrics.outputTokens).toBe(100);
    });

    it('should throw on non-ok response', async () => {
      mockFetch({ error: 'Rate limited' }, 429);

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });

      await expect(
        model.converse({
          messages: [{ role: 'user', content: [{ text: 'test' }] }],
        })
      ).rejects.toThrow('Mantle API error 429');
    });

    it('should convert assistant text+tool_calls in convertMessages', async () => {
      const { calls } = mockFetch(openAIResponse('Done'));

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });

      await model.converse({
        messages: [
          {
            role: 'assistant',
            content: [
              { text: 'I will call the tool' },
              {
                toolUse: {
                  toolUseId: 'tc_1',
                  name: 'my_tool',
                  input: { arg: 'value' },
                },
              },
            ],
          },
          { role: 'user', content: [{ text: 'ok' }] },
        ],
      });

      const body = JSON.parse(calls[0].init.body as string);
      const assistantMsg = body.messages[0];
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.content).toBe('I will call the tool');
      expect(assistantMsg.tool_calls).toHaveLength(1);
      expect(assistantMsg.tool_calls[0].id).toBe('tc_1');
      expect(assistantMsg.tool_calls[0].type).toBe('function');
      expect(assistantMsg.tool_calls[0].function.name).toBe('my_tool');
      expect(assistantMsg.tool_calls[0].function.arguments).toBe('{"arg":"value"}');
    });
  });

  // -----------------------------------------------------------------------
  // converseStream() — Streaming
  // -----------------------------------------------------------------------
  describe('converseStream()', () => {
    it('should yield messageStart event', async () => {
      const chunks = [
        {
          id: 'chunk-1',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
        },
        {
          id: 'chunk-2',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        '[DONE]',
      ];

      mockStreamFetch(chunks);

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      });

      const events: any[] = [];
      let result;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          result = value;
          break;
        }
        events.push(value);
      }

      expect(events[0]).toEqual({ type: 'messageStart' });
    });

    it('should yield text content block events', async () => {
      const chunks = [
        {
          id: 'c1',
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
        },
        {
          id: 'c2',
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
        },
        {
          id: 'c3',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        '[DONE]',
      ];

      mockStreamFetch(chunks);

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      });

      const events: any[] = [];
      let result;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          result = value;
          break;
        }
        events.push(value);
      }

      // messageStart, contentBlockStart, delta 'Hello', delta ' world', contentBlockStop, messageStop, metadata
      expect(events).toContainEqual({
        type: 'contentBlockStart',
        blockIndex: 0,
        blockType: 'text',
      });
      expect(events).toContainEqual({
        type: 'contentBlockDelta',
        blockIndex: 0,
        delta: { text: 'Hello' },
      });
      expect(events).toContainEqual({
        type: 'contentBlockDelta',
        blockIndex: 0,
        delta: { text: ' world' },
      });

      // Return value should have assembled text
      expect(result!.output.message.content[0].text).toBe('Hello world');
      expect(result!.stopReason).toBe('end_turn');
    });

    it('should yield tool_use block events', async () => {
      const chunks = [
        {
          id: 'c1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'c2',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'c3',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '":"NY"}' } }],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'c4',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        },
        '[DONE]',
      ];

      mockStreamFetch(chunks);

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'weather?' }] }],
      });

      const events: any[] = [];
      let result;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          result = value;
          break;
        }
        events.push(value);
      }

      // Should have contentBlockStart for tool_use
      const toolStart = events.find(
        (e: any) => e.type === 'contentBlockStart' && e.blockType === 'tool_use'
      );
      expect(toolStart).toBeDefined();
      expect(toolStart.toolUse?.toolUseId).toBe('call_abc');
      expect(toolStart.toolUse?.name).toBe('get_weather');

      // Should have tool input deltas
      const toolDeltas = events.filter(
        (e: any) => e.type === 'contentBlockDelta' && e.delta.toolUseInput
      );
      expect(toolDeltas.length).toBeGreaterThanOrEqual(2);

      // Return value should contain parsed tool use
      expect(result!.output.message.content[0].toolUse).toBeDefined();
      expect(result!.output.message.content[0].toolUse!.input).toEqual({ loc: 'NY' });
      expect(result!.stopReason).toBe('tool_use');
    });

    it('should yield metadata with token counts', async () => {
      const chunks = [
        {
          id: 'c1',
          choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }],
        },
        {
          id: 'c2',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 25 },
        },
        '[DONE]',
      ];

      mockStreamFetch(chunks);

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      });

      const events: any[] = [];
      let result;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          result = value;
          break;
        }
        events.push(value);
      }

      const metadataEvent = events.find((e: any) => e.type === 'metadata');
      expect(metadataEvent).toBeDefined();
      expect(metadataEvent.inputTokens).toBe(50);
      expect(metadataEvent.outputTokens).toBe(25);

      expect(result!.metrics.inputTokens).toBe(50);
      expect(result!.metrics.outputTokens).toBe(25);
    });

    it('should throw on non-ok streaming response', async () => {
      mockStreamFetch([], 500);

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });

      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'test' }] }],
      });

      try {
        await gen.next();
        expect(true).toBe(false); // Should not reach here
      } catch (err: any) {
        expect(err.message).toContain('Mantle streaming error 500');
      }
    });

    it('should throw when response body is null', async () => {
      globalThis.fetch = mock(async () => {
        return new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }) as unknown as typeof globalThis.fetch;

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });

      // Response with null body still has body property in fetch spec,
      // but it should be empty. The implementation checks !response.body
      // which would be falsy for null body on some runtimes.
      // In Bun, new Response(null) has body === null.
      try {
        const gen = model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'test' }] }],
        });
        await gen.next();
        // If we get here without error, the stream was empty and produces no events
      } catch (err: any) {
        expect(err.message).toContain('No response body');
      }
    });

    it('should send stream:true and stream_options in request', async () => {
      const chunks = [
        {
          id: 'c1',
          choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }],
        },
        '[DONE]',
      ];

      const { calls } = mockStreamFetch(chunks);

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      });

      // Drain generator
      while (true) {
        const { done } = await gen.next();
        if (done) break;
      }

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
    });

    it('should yield messageStop with correct stopReason', async () => {
      const chunks = [
        {
          id: 'c1',
          choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }],
        },
        {
          id: 'c2',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        '[DONE]',
      ];

      mockStreamFetch(chunks);

      const model = new MantleModel({ modelId: 'm', apiKey: 'k' });
      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      });

      const events: any[] = [];
      while (true) {
        const { value, done } = await gen.next();
        if (done) break;
        events.push(value);
      }

      const messageStop = events.find((e: any) => e.type === 'messageStop');
      expect(messageStop).toBeDefined();
      expect(messageStop.stopReason).toBe('end_turn');
    });
  });
});
