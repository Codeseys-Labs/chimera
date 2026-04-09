/**
 * Tests for BedrockModel.converseStream() — streaming via ConverseStreamCommand
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { BedrockModel } from '../bedrock-model';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

// ---------------------------------------------------------------------------
// Mock async iterable stream builder
// ---------------------------------------------------------------------------

/** Create an AsyncIterable that yields Bedrock ConverseStream events */
function createMockStream(
  events: Record<string, unknown>[]
): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= events.length) {
            return { done: true as const, value: undefined };
          }
          const value = events[index++];
          return { done: false as const, value };
        },
      };
    },
  };
}

/**
 * Mock BedrockRuntimeClient that returns a controlled stream response
 */
class MockStreamClient {
  private streamResponse: AsyncIterable<Record<string, unknown>> | null;
  public calls: any[] = [];

  constructor(events: Record<string, unknown>[] | null) {
    this.streamResponse = events ? createMockStream(events) : null;
  }

  async send(command: any): Promise<any> {
    this.calls.push(command);
    return {
      stream: this.streamResponse,
    };
  }
}

/** Collect all yielded events and the return value from the generator */
async function drainGenerator(
  gen: AsyncGenerator<any, any, unknown>
): Promise<{ events: any[]; result: any }> {
  const events: any[] = [];
  let result: any;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      result = value;
      break;
    }
    events.push(value);
  }
  return { events, result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BedrockModel.converseStream()', () => {
  describe('text streaming', () => {
    it('should yield messageStart event', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { events } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        })
      );

      expect(events[0]).toEqual({ type: 'messageStart' });
    });

    it('should yield contentBlockStart with blockType text', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { events } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        })
      );

      const blockStart = events.find((e: any) => e.type === 'contentBlockStart');
      expect(blockStart).toEqual({
        type: 'contentBlockStart',
        blockIndex: 0,
        blockType: 'text',
      });
    });

    it('should yield contentBlockDelta with text for each token', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: ' world' } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '!' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 10, outputTokens: 8 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { events } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        })
      );

      const deltas = events.filter((e: any) => e.type === 'contentBlockDelta');
      expect(deltas).toHaveLength(3);
      expect(deltas[0].delta).toEqual({ text: 'Hello' });
      expect(deltas[1].delta).toEqual({ text: ' world' });
      expect(deltas[2].delta).toEqual({ text: '!' });
    });

    it('should yield contentBlockStop at end of block', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 5, outputTokens: 2 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { events } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        })
      );

      const blockStop = events.find((e: any) => e.type === 'contentBlockStop');
      expect(blockStop).toEqual({ type: 'contentBlockStop', blockIndex: 0 });
    });

    it('should yield messageStop with correct stopReason', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Done' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'max_tokens' } },
        { metadata: { usage: { inputTokens: 10, outputTokens: 100 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { events } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'Long text' }] }],
        })
      );

      const messageStop = events.find((e: any) => e.type === 'messageStop');
      expect(messageStop).toEqual({ type: 'messageStop', stopReason: 'max_tokens' });
    });

    it('should yield metadata with token counts', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 42, outputTokens: 17 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { events } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        })
      );

      const metadata = events.find((e: any) => e.type === 'metadata');
      expect(metadata).toEqual({ type: 'metadata', inputTokens: 42, outputTokens: 17 });
    });

    it('should assemble full text in return value', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: ' world' } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '!' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 10, outputTokens: 8 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { result } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        })
      );

      expect(result.output.message.role).toBe('assistant');
      expect(result.output.message.content).toHaveLength(1);
      expect(result.output.message.content[0].text).toBe('Hello world!');
      expect(result.stopReason).toBe('end_turn');
      expect(result.metrics).toEqual({ inputTokens: 10, outputTokens: 8 });
    });
  });

  describe('tool_use streaming', () => {
    it('should handle tool_use blocks with contentBlockStart and input deltas', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        // Text block
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Let me check.' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        // Tool use block
        {
          contentBlockStart: {
            contentBlockIndex: 1,
            start: {
              toolUse: { toolUseId: 'tool_123', name: 'get_weather' },
            },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { toolUse: { input: '{"location"' } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { toolUse: { input: ':"Seattle"}' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 1 } },
        { messageStop: { stopReason: 'tool_use' } },
        { metadata: { usage: { inputTokens: 30, outputTokens: 20 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { events, result } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'Weather?' }] }],
        })
      );

      // Check tool_use contentBlockStart
      const toolStart = events.find(
        (e: any) => e.type === 'contentBlockStart' && e.blockType === 'tool_use'
      );
      expect(toolStart).toBeDefined();
      expect(toolStart.blockIndex).toBe(1);
      expect(toolStart.toolUse).toEqual({ toolUseId: 'tool_123', name: 'get_weather' });

      // Check tool input deltas
      const toolDeltas = events.filter(
        (e: any) => e.type === 'contentBlockDelta' && e.delta.toolUseInput
      );
      expect(toolDeltas).toHaveLength(2);
      expect(toolDeltas[0].delta.toolUseInput).toBe('{"location"');
      expect(toolDeltas[1].delta.toolUseInput).toBe(':"Seattle"}');

      // Check return value
      expect(result.output.message.content).toHaveLength(2);
      expect(result.output.message.content[0].text).toBe('Let me check.');
      expect(result.output.message.content[1].toolUse).toEqual({
        toolUseId: 'tool_123',
        name: 'get_weather',
        input: { location: 'Seattle' },
      });
      expect(result.stopReason).toBe('tool_use');
    });

    it('should handle tool_use with invalid JSON input gracefully', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: {
              toolUse: { toolUseId: 'tool_bad', name: 'broken_tool' },
            },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{invalid json' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'tool_use' } },
        { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { result } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'test' }] }],
        })
      );

      // Should not throw; input defaults to empty object
      expect(result.output.message.content[0].toolUse!.input).toEqual({});
    });
  });

  describe('error handling', () => {
    it('should throw when response.stream is missing', async () => {
      const mockClient = new MockStreamClient(null);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const gen = model.converseStream({
        messages: [{ role: 'user', content: [{ text: 'test' }] }],
      });

      try {
        await gen.next();
        expect(true).toBe(false); // Should not reach here
      } catch (err: any) {
        expect(err.message).toBe('Invalid Bedrock response: missing stream');
      }
    });
  });

  describe('event ordering', () => {
    it('should yield events in correct order for a complete text response', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 5, outputTokens: 2 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { events } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        })
      );

      const types = events.map((e: any) => e.type);
      expect(types).toEqual([
        'messageStart',
        'contentBlockStart',
        'contentBlockDelta',
        'contentBlockStop',
        'messageStop',
        'metadata',
      ]);
    });

    it('should handle multi-block response (text + tool)', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Calling tool' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        {
          contentBlockStart: {
            contentBlockIndex: 1,
            start: { toolUse: { toolUseId: 'tc1', name: 'calc' } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { toolUse: { input: '{"x":1}' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 1 } },
        { messageStop: { stopReason: 'tool_use' } },
        { metadata: { usage: { inputTokens: 20, outputTokens: 15 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { events, result } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'calc' }] }],
        })
      );

      // Verify two content block start events
      const starts = events.filter((e: any) => e.type === 'contentBlockStart');
      expect(starts).toHaveLength(2);
      expect(starts[0].blockType).toBe('text');
      expect(starts[1].blockType).toBe('tool_use');

      // Verify return value has both blocks
      expect(result.output.message.content).toHaveLength(2);
      expect(result.output.message.content[0].text).toBe('Calling tool');
      expect(result.output.message.content[1].toolUse!.name).toBe('calc');
    });
  });

  describe('default stopReason', () => {
    it('should default stopReason to end_turn when messageStop has no stopReason', async () => {
      const streamEvents = [
        { messageStart: { role: 'assistant' } },
        { contentBlockStart: { contentBlockIndex: 0, start: {} } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: {} }, // No stopReason
        { metadata: { usage: { inputTokens: 5, outputTokens: 2 } } },
      ];

      const mockClient = new MockStreamClient(streamEvents);
      const model = new BedrockModel({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        client: mockClient as unknown as BedrockRuntimeClient,
      });

      const { result } = await drainGenerator(
        model.converseStream({
          messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        })
      );

      expect(result.stopReason).toBe('end_turn');
    });
  });
});
