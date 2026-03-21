/**
 * Tests for ChimeraAgent.invoke() with ReAct loop
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { MockModel, mockTextResponse, mockToolCallResponse } from '../../../../../tests/helpers/mock-model';
import { createAgent, ChimeraAgent } from '../agent';
import { createDefaultSystemPrompt } from '../prompt';
import { z } from 'zod';

describe('ChimeraAgent.invoke()', () => {
  describe('Backward compatibility', () => {
    it('should return placeholder when no model provided', async () => {
      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant'
      });

      const result = await agent.invoke('Hello');

      expect(result.output).toContain('[Placeholder]');
      expect(result.output).toContain('Hello');
      expect(result.sessionId).toBeDefined();
      expect(result.stopReason).toBe('end_turn');
      expect(result.context.tenantId).toBe('test-tenant');
    });
  });

  describe('ReAct loop with model', () => {
    it('should invoke model.converse for simple text response', async () => {
      const model = new MockModel([
        mockTextResponse('Hello! How can I help you?')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model
      });

      const result = await agent.invoke('Hi there');

      expect(result.output).toBe('Hello! How can I help you?');
      expect(result.stopReason).toBe('end_turn');
      expect(result.toolCalls).toBeUndefined();
      expect(model.getCallCount()).toBe(1);
    });

    it('should handle tool calling through ReAct loop', async () => {
      // Create mock tool
      const mockCalculator = {
        name: 'calculator',
        description: 'Performs arithmetic operations',
        inputSchema: z.object({
          operation: z.string(),
          a: z.number(),
          b: z.number()
        }),
        callback: async (input: any) => {
          const { operation, a, b } = input;
          if (operation === 'add') return String(a + b);
          if (operation === 'multiply') return String(a * b);
          return 'Unknown operation';
        }
      };

      // Model first requests tool, then returns final answer
      const model = new MockModel([
        mockToolCallResponse('Let me calculate that', 'calculator', {
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
        loadedTools: [mockCalculator]
      });

      const result = await agent.invoke('What is 5 + 3?');

      expect(result.output).toBe('The result is 8');
      expect(result.stopReason).toBe('end_turn');
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('calculator');
      expect(result.toolCalls![0].input).toEqual({
        operation: 'add',
        a: 5,
        b: 3
      });
      expect(result.toolCalls![0].result).toBe('8');
      expect(model.getCallCount()).toBe(2); // Two turns in ReAct loop
    });

    it('should handle list S3 buckets through ReAct loop', async () => {
      // THE ACCEPTANCE TEST
      const mockS3Tool = {
        name: 'list_s3_buckets',
        description: 'Lists all S3 buckets in the account',
        inputSchema: z.object({}),
        callback: async () => {
          return JSON.stringify({
            buckets: [
              { name: 'my-app-data', createdAt: '2024-01-01' },
              { name: 'my-logs', createdAt: '2024-01-15' }
            ]
          });
        }
      };

      const model = new MockModel([
        mockToolCallResponse(
          "I'll list your S3 buckets",
          'list_s3_buckets',
          {}
        ),
        mockTextResponse(
          'You have 2 S3 buckets: my-app-data and my-logs'
        )
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockS3Tool]
      });

      const result = await agent.invoke('list my S3 buckets');

      expect(result.output).toContain('my-app-data');
      expect(result.output).toContain('my-logs');
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('list_s3_buckets');
      expect(result.toolCalls![0].result).toContain('my-app-data');
      expect(model.getCallCount()).toBe(2);
    });

    it('should handle multi-turn tool use', async () => {
      const mockWeather = {
        name: 'get_weather',
        description: 'Get weather for a location',
        inputSchema: z.object({ location: z.string() }),
        callback: async (input: any) => `Weather in ${input.location}: Sunny, 72°F`
      };

      const mockConvert = {
        name: 'convert_temp',
        description: 'Convert temperature units',
        inputSchema: z.object({ temp: z.number(), fromUnit: z.string(), toUnit: z.string() }),
        callback: async (input: any) => {
          const celsius = Math.round((input.temp - 32) * 5 / 9);
          return `${celsius}°C`;
        }
      };

      const model = new MockModel([
        mockToolCallResponse('Let me check the weather', 'get_weather', { location: 'Seattle' }),
        mockToolCallResponse('Now converting to Celsius', 'convert_temp', {
          temp: 72,
          fromUnit: 'F',
          toUnit: 'C'
        }),
        mockTextResponse('The weather in Seattle is sunny and 22°C')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockWeather, mockConvert]
      });

      const result = await agent.invoke('What is the weather in Seattle in Celsius?');

      expect(result.output).toContain('Seattle');
      expect(result.output).toContain('22');
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls![0].name).toBe('get_weather');
      expect(result.toolCalls![1].name).toBe('convert_temp');
      expect(model.getCallCount()).toBe(3);
    });

    it('should stop after max iterations', async () => {
      // Model keeps requesting tools indefinitely
      const model = new MockModel(
        Array(15).fill(null).map(() =>
          mockToolCallResponse('Still working', 'infinite_tool', {})
        )
      );

      const mockTool = {
        name: 'infinite_tool',
        description: 'A tool that never ends',
        inputSchema: z.object({}),
        callback: async () => 'result'
      };

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockTool]
      });

      const result = await agent.invoke('Do something');

      // Should stop after 10 iterations
      expect(model.getCallCount()).toBeLessThanOrEqual(10);
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThan(0);
    });

    it('should handle tool errors gracefully', async () => {
      const mockFailingTool = {
        name: 'failing_tool',
        description: 'A tool that fails',
        inputSchema: z.object({ shouldFail: z.boolean() }),
        callback: async (input: any) => {
          if (input.shouldFail) {
            throw new Error('Tool execution failed');
          }
          return 'success';
        }
      };

      const model = new MockModel([
        mockToolCallResponse('Trying the tool', 'failing_tool', { shouldFail: true }),
        mockTextResponse('The tool failed, but I handled it')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockFailingTool]
      });

      const result = await agent.invoke('Try the failing tool');

      expect(result.output).toBe('The tool failed, but I handled it');
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls![0].error).toBe('Tool execution failed');
      expect(result.toolCalls![0].result).toBeUndefined();
    });

    it('should handle missing tool gracefully', async () => {
      const model = new MockModel([
        mockToolCallResponse('Using a tool', 'nonexistent_tool', { param: 'value' }),
        mockTextResponse('The tool was not found')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [] // No tools loaded
      });

      const result = await agent.invoke('Use a tool');

      expect(result.output).toBe('The tool was not found');
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls![0].error).toContain('not found');
    });

    it('should store messages in memory during ReAct loop', async () => {
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

      await agent.invoke('Test message');

      // Verify memory client has stored messages
      const memoryClient = agent.getMemoryClient();
      const result = await memoryClient.retrieve({ limit: 10 });

      expect(result.entries.length).toBeGreaterThanOrEqual(2); // At least user + assistant
      // Check that user message was stored
      const userEntry = result.entries.find(e => e.content === 'Test message');
      expect(userEntry).toBeDefined();
    });

    it('should pass system prompt to model', async () => {
      const model = new MockModel([mockTextResponse('Hello')]);

      const customPrompt = createDefaultSystemPrompt();

      const agent = createAgent({
        systemPrompt: customPrompt,
        tenantId: 'test-tenant',
        model
      });

      await agent.invoke('Hi');

      const lastCall = model.getLastCall();
      expect(lastCall?.systemPrompt).toBeDefined();
      expect(lastCall?.systemPrompt).toContain('assistant');
    });

    it('should pass tools to model when loadedTools provided', async () => {
      const mockTool = {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: z.object({ param: z.string() }),
        callback: async () => 'result'
      };

      const model = new MockModel([mockTextResponse('Done without tools')]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockTool]
      });

      await agent.invoke('Test');

      const lastCall = model.getLastCall();
      expect(lastCall?.tools).toBeDefined();
      expect(lastCall?.tools).toHaveLength(1);
      expect(lastCall?.tools![0].name).toBe('test_tool');
    });

    it('should not pass tools when loadedTools is empty', async () => {
      const model = new MockModel([mockTextResponse('Done')]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: []
      });

      await agent.invoke('Test');

      const lastCall = model.getLastCall();
      expect(lastCall?.tools).toBeUndefined();
    });

    it('should handle tool callback returning non-string values', async () => {
      const mockTool = {
        name: 'json_tool',
        description: 'Returns JSON object',
        inputSchema: z.object({}),
        callback: async () => JSON.stringify({ status: 'success', count: 42 })
      };

      const model = new MockModel([
        mockToolCallResponse('Getting data', 'json_tool', {}),
        mockTextResponse('Got 42 items')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model,
        loadedTools: [mockTool]
      });

      const result = await agent.invoke('Get data');

      expect(result.toolCalls![0].result).toContain('success');
      expect(result.toolCalls![0].result).toContain('42');
    });
  });

  describe('Session management', () => {
    it('should maintain session ID across invocations', async () => {
      const model = new MockModel([
        mockTextResponse('First response'),
        mockTextResponse('Second response')
      ]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        model
      });

      const result1 = await agent.invoke('First message');
      const result2 = await agent.invoke('Second message');

      expect(result1.sessionId).toBe(result2.sessionId);
    });

    it('should use provided session ID', async () => {
      const customSessionId = 'custom-session-123';

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        sessionId: customSessionId
      });

      const result = await agent.invoke('Test');

      expect(result.sessionId).toBe(customSessionId);
    });
  });

  describe('Context propagation', () => {
    it('should include context in result', async () => {
      const model = new MockModel([mockTextResponse('Hello')]);

      const agent = createAgent({
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        userId: 'user-123',
        model
      });

      const result = await agent.invoke('Hi');

      expect(result.context.tenantId).toBe('test-tenant');
      expect(result.context.userId).toBe('user-123');
      expect(result.context.sessionId).toBeDefined();
      expect(result.context.memoryNamespace).toContain('test-tenant');
    });
  });
});
