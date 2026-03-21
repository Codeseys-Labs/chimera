/**
 * Tests for ChimeraAgent.stream() with ReAct loop
 */

import { describe, it, expect } from 'bun:test';
import { MockModel, mockTextResponse, mockToolCallResponse } from '../../../../../tests/helpers/mock-model';
import { createAgent } from '../agent';
import { createDefaultSystemPrompt } from '../prompt';
import { z } from 'zod';

describe('ChimeraAgent.stream()', () => {
  describe('Placeholder mode (no model)', () => {
    it('should emit message_start, content_block_delta, message_stop for placeholder', async () => {
      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant'
      });

      const events = [];
      for await (const event of agent.stream('Hello')) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('message_start');
      expect(events[0]).toHaveProperty('sessionId');
      expect(events[1].type).toBe('content_block_delta');
      expect(events[1]).toHaveProperty('delta');
      expect(events[1].delta.text).toContain('[Placeholder]');
      expect(events[2].type).toBe('message_stop');
      expect(events[2]).toHaveProperty('stopReason');
    });
  });

  describe('ReAct loop with model', () => {
    it('should emit message_start, content_block_delta, message_stop for simple response', async () => {
      const model = new MockModel([
        mockTextResponse('Hello! How can I help you?')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model
      });

      const events = [];
      for await (const event of agent.stream('Hi there')) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThanOrEqual(3);

      // First event: message_start
      expect(events[0].type).toBe('message_start');
      expect(events[0]).toHaveProperty('sessionId');

      // Middle events: content_block_delta
      const deltaEvents = events.filter(e => e.type === 'content_block_delta');
      expect(deltaEvents.length).toBeGreaterThan(0);
      expect(deltaEvents[0].delta.text).toBe('Hello! How can I help you?');

      // Last event: message_stop
      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe('message_stop');
      expect(lastEvent.stopReason).toBe('end_turn');
    });

    it('should emit tool_call event during ReAct loop', async () => {
      const mockTool = {
        name: 'calculator',
        description: 'Performs arithmetic',
        inputSchema: z.object({
          operation: z.string(),
          a: z.number(),
          b: z.number()
        }),
        callback: async (input: any) => {
          if (input.operation === 'add') return String(input.a + input.b);
          return 'Unknown';
        }
      };

      const model = new MockModel([
        mockToolCallResponse('Let me calculate', 'calculator', {
          operation: 'add',
          a: 5,
          b: 3
        }),
        mockTextResponse('The result is 8')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockTool]
      });

      const events = [];
      for await (const event of agent.stream('What is 5 + 3?')) {
        events.push(event);
      }

      // Should have: message_start, content_delta(s), tool_call, content_delta(s), message_stop
      expect(events.length).toBeGreaterThan(3);

      // Find message_start
      const messageStart = events.find(e => e.type === 'message_start');
      expect(messageStart).toBeDefined();

      // Find tool_call event
      const toolCallEvent = events.find(e => e.type === 'tool_call');
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent!.toolCall.name).toBe('calculator');
      expect(toolCallEvent!.toolCall.input).toEqual({
        operation: 'add',
        a: 5,
        b: 3
      });
      expect(toolCallEvent!.toolCall.result).toBe('8');

      // Find message_stop
      const messageStop = events.find(e => e.type === 'message_stop');
      expect(messageStop).toBeDefined();
      expect(messageStop!.stopReason).toBe('end_turn');
    });

    it('should emit events in correct order with tools', async () => {
      const mockTool = {
        name: 'test_tool',
        description: 'Test tool',
        inputSchema: z.object({}),
        callback: async () => 'tool result'
      };

      const model = new MockModel([
        mockToolCallResponse('Using tool', 'test_tool', {}),
        mockTextResponse('Done')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockTool]
      });

      const events = [];
      for await (const event of agent.stream('Test')) {
        events.push(event);
      }

      const eventTypes = events.map(e => e.type);

      // Verify order
      expect(eventTypes[0]).toBe('message_start');
      expect(eventTypes[eventTypes.length - 1]).toBe('message_stop');

      // tool_call should come after message_start and before message_stop
      const toolCallIndex = eventTypes.indexOf('tool_call');
      expect(toolCallIndex).toBeGreaterThan(0);
      expect(toolCallIndex).toBeLessThan(eventTypes.length - 1);
    });

    it('should emit multiple tool_call events for multi-tool response', async () => {
      const mockWeather = {
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: z.object({ location: z.string() }),
        callback: async (input: any) => `Weather in ${input.location}: Sunny`
      };

      const mockTime = {
        name: 'get_time',
        description: 'Get current time',
        inputSchema: z.object({ timezone: z.string() }),
        callback: async (input: any) => `Time in ${input.timezone}: 3:00 PM`
      };

      const model = new MockModel([
        mockToolCallResponse('Checking weather', 'get_weather', { location: 'Seattle' }),
        mockToolCallResponse('Checking time', 'get_time', { timezone: 'PST' }),
        mockTextResponse('Weather is sunny and time is 3 PM')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockWeather, mockTime]
      });

      const events = [];
      for await (const event of agent.stream('Get weather and time in Seattle')) {
        events.push(event);
      }

      const toolCallEvents = events.filter(e => e.type === 'tool_call');
      expect(toolCallEvents).toHaveLength(2);
      expect(toolCallEvents[0].toolCall.name).toBe('get_weather');
      expect(toolCallEvents[1].toolCall.name).toBe('get_time');
    });

    it('should emit tool_call with error when tool fails', async () => {
      const mockFailingTool = {
        name: 'failing_tool',
        description: 'A tool that fails',
        inputSchema: z.object({}),
        callback: async () => {
          throw new Error('Tool failed');
        }
      };

      const model = new MockModel([
        mockToolCallResponse('Trying tool', 'failing_tool', {}),
        mockTextResponse('Tool failed but continuing')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockFailingTool]
      });

      const events = [];
      for await (const event of agent.stream('Test')) {
        events.push(event);
      }

      const toolCallEvent = events.find(e => e.type === 'tool_call');
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent!.toolCall.error).toBe('Tool failed');
      expect(toolCallEvent!.toolCall.result).toBeUndefined();
    });

    it('should handle multiple text blocks in response', async () => {
      const model = new MockModel([
        mockTextResponse('First part\nSecond part')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model
      });

      const events = [];
      for await (const event of agent.stream('Test')) {
        events.push(event);
      }

      const deltaEvents = events.filter(e => e.type === 'content_block_delta');
      expect(deltaEvents.length).toBeGreaterThan(0);

      // Collect all text
      const allText = deltaEvents.map(e => e.delta.text).join('');
      expect(allText).toContain('First part');
      expect(allText).toContain('Second part');
    });

    it('should stop streaming after max iterations', async () => {
      const model = new MockModel(
        Array(15).fill(null).map(() =>
          mockToolCallResponse('Still working', 'infinite_tool', {})
        )
      );

      const mockTool = {
        name: 'infinite_tool',
        description: 'Never ends',
        inputSchema: z.object({}),
        callback: async () => 'result'
      };

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockTool]
      });

      const events = [];
      for await (const event of agent.stream('Test')) {
        events.push(event);
      }

      // Should stop after max iterations
      const toolCallEvents = events.filter(e => e.type === 'tool_call');
      expect(toolCallEvents.length).toBeLessThanOrEqual(10);
    });

    it('should include session ID in message_start event', async () => {
      const model = new MockModel([mockTextResponse('Hello')]);
      const customSessionId = 'custom-session-123';

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        sessionId: customSessionId,
        model
      });

      const events = [];
      for await (const event of agent.stream('Test')) {
        events.push(event);
      }

      const messageStart = events.find(e => e.type === 'message_start');
      expect(messageStart).toBeDefined();
      expect(messageStart!.sessionId).toBe(customSessionId);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty tool list gracefully', async () => {
      const model = new MockModel([mockTextResponse('Hello')]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: []
      });

      const events = [];
      for await (const event of agent.stream('Test')) {
        events.push(event);
      }

      // Should work normally without tools
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('message_start');
      expect(events[events.length - 1].type).toBe('message_stop');
    });

    it('should handle model returning empty content', async () => {
      const model = new MockModel([
        { text: '', stopReason: 'end_turn' }
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model
      });

      const events = [];
      for await (const event of agent.stream('Test')) {
        events.push(event);
      }

      // Should still emit message_start and message_stop
      expect(events.some(e => e.type === 'message_start')).toBe(true);
      expect(events.some(e => e.type === 'message_stop')).toBe(true);
    });
  });
});
