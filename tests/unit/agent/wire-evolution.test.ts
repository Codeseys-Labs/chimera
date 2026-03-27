/**
 * Tests for ChimeraAgent evolution subsystem wiring
 *
 * Verifies integration with ModelRouter, PromptOptimizer, and
 * self-reflection persistence to DynamoDB.
 */

import { describe, it, expect, mock, spyOn } from 'bun:test';
import { ChimeraAgent, type AgentConfig } from '../../../packages/core/src/agent';
import { ModelRouter } from '../../../packages/core/src/evolution/model-router';
import { PromptOptimizer } from '../../../packages/core/src/evolution/prompt-optimizer';
import { createDefaultSystemPrompt } from '../../../packages/core/src/agent/prompt';
import type { ModelSelection, PromptABExperiment } from '../../../packages/core/src/evolution/types';

describe('ChimeraAgent Evolution Wiring', () => {
  // Helper to create mock model
  const createMockModel = () => ({
    converse: mock(() => Promise.resolve({
      stopReason: 'end_turn',
      output: {
        message: {
          content: [{ text: 'Mock response' }],
        },
      },
    })),
  });

  describe('ModelRouter integration', () => {
    it('should consult ModelRouter for model selection', async () => {
      const mockModelRouter = {
        selectModel: mock(() => Promise.resolve({
          selectedModel: 'us.amazon.nova-lite-v1:0',
          taskCategory: 'simple_qa',
          routingWeights: {},
        } as ModelSelection)),
        recordOutcome: mock(() => Promise.resolve(undefined)),
      } as unknown as ModelRouter;

      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        modelRouter: mockModelRouter,
        taskCategory: 'simple_qa',
        model: createMockModel(),
      };

      const agent = new ChimeraAgent(config);
      await agent.invoke('Test message');

      // Verify ModelRouter.selectModel was called
      expect(mockModelRouter.selectModel).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        taskCategory: 'simple_qa',
      });
    });

    it('should record outcome to ModelRouter after invocation', async () => {
      const mockModelRouter = {
        selectModel: mock(() => Promise.resolve({
          selectedModel: 'us.anthropic.claude-sonnet-4-6-v1:0',
          taskCategory: 'analysis',
          routingWeights: {},
        } as ModelSelection)),
        recordOutcome: mock(() => Promise.resolve(undefined)),
      } as unknown as ModelRouter;

      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        modelRouter: mockModelRouter,
        taskCategory: 'analysis',
        model: createMockModel(),
      };

      const agent = new ChimeraAgent(config);
      await agent.invoke('Analyze this data');

      // Verify recordOutcome was called with quality score
      expect(mockModelRouter.recordOutcome).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        taskCategory: 'analysis',
        modelId: 'us.anthropic.claude-sonnet-4-6-v1:0',
        qualityScore: expect.any(Number),
      });

      const qualityScore = (mockModelRouter.recordOutcome as any).mock.calls[0][0].qualityScore;
      expect(qualityScore).toBeGreaterThanOrEqual(0);
      expect(qualityScore).toBeLessThanOrEqual(1);
    });

    it('should work without ModelRouter (backward compatibility)', async () => {
      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
      };

      const agent = new ChimeraAgent(config);
      const result = await agent.invoke('Test without router');

      expect(result.output).toBeDefined();
      expect(result.stopReason).toBe('end_turn');
    });
  });

  describe('PromptOptimizer integration', () => {
    it('should select prompt variant from PromptOptimizer', async () => {
      const mockPromptOptimizer = {
        selectPromptVariant: mock(() => Promise.resolve('b')),
        getExperiment: mock(() => Promise.resolve({
          experimentId: 'exp-123',
          variantAPromptS3: 'prompts/control.txt',
          variantBPromptS3: 'prompts/improved.txt',
          status: 'running',
        } as PromptABExperiment)),
        loadPrompt: mock(() => Promise.resolve('Improved system prompt')),
        recordVariantOutcome: mock(() => Promise.resolve(undefined)),
      } as unknown as PromptOptimizer;

      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        promptOptimizer: mockPromptOptimizer,
        promptExperimentId: 'exp-123',
        model: createMockModel(),
      };

      const agent = new ChimeraAgent(config);
      await agent.invoke('Test with A/B prompt');

      // Verify variant selection
      expect(mockPromptOptimizer.selectPromptVariant).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        experimentId: 'exp-123',
      });

      // Verify prompt loading
      expect(mockPromptOptimizer.loadPrompt).toHaveBeenCalledWith('prompts/improved.txt');
    });

    it('should record variant outcome after invocation', async () => {
      const mockPromptOptimizer = {
        selectPromptVariant: mock(() => Promise.resolve('a')),
        getExperiment: mock(() => Promise.resolve({
          experimentId: 'exp-456',
          variantAPromptS3: 'prompts/control.txt',
          variantBPromptS3: 'prompts/improved.txt',
          status: 'running',
        } as PromptABExperiment)),
        loadPrompt: mock(() => Promise.resolve('Control system prompt')),
        recordVariantOutcome: mock(() => Promise.resolve(undefined)),
      } as unknown as PromptOptimizer;

      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        promptOptimizer: mockPromptOptimizer,
        promptExperimentId: 'exp-456',
        model: createMockModel(),
      };

      const agent = new ChimeraAgent(config);
      await agent.invoke('Test variant outcome');

      // Verify outcome recording
      expect(mockPromptOptimizer.recordVariantOutcome).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        experimentId: 'exp-456',
        variant: 'a',
        qualityScore: expect.any(Number),
        cost: expect.any(Number),
      });
    });

    it('should fallback to static prompt if experiment not found', async () => {
      const mockPromptOptimizer = {
        selectPromptVariant: mock(() => Promise.resolve('a')),
        getExperiment: mock(() => Promise.resolve(null)),
        loadPrompt: mock(() => Promise.resolve('Should not be called')),
        recordVariantOutcome: mock(() => Promise.resolve(undefined)),
      } as unknown as PromptOptimizer;

      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        promptOptimizer: mockPromptOptimizer,
        promptExperimentId: 'nonexistent-exp',
      };

      const agent = new ChimeraAgent(config);
      const result = await agent.invoke('Test fallback');

      // Verify static prompt was used
      expect(mockPromptOptimizer.loadPrompt).not.toHaveBeenCalled();
      expect(result.output).toBeDefined();
    });
  });

  describe('Self-reflection persistence', () => {
    it('should persist reflection data to DynamoDB', async () => {
      const mockDdbClient = {
        send: mock(() => Promise.resolve({})),
      };

      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        evolutionTable: 'chimera-evolution-test',
        model: createMockModel(),
      };

      const agent = new ChimeraAgent(config);
      (agent as any).ddbClient = mockDdbClient;

      await agent.invoke('Test reflection persistence');

      // Verify DynamoDB PutCommand was called
      expect(mockDdbClient.send).toHaveBeenCalled();
      const putCommand = mockDdbClient.send.mock.calls[0][0];

      // Verify reflection data structure
      expect(putCommand.input.TableName).toBe('chimera-evolution-test');
      expect(putCommand.input.Item.PK).toBe('TENANT#test-tenant');
      expect(putCommand.input.Item.SK).toMatch(/^REFLECTION#/);
      expect(putCommand.input.Item.type).toBe('self_reflection');
      expect(putCommand.input.Item.quality).toBeDefined();
      expect(putCommand.input.Item.ttl).toBeDefined();
    });

    it('should include model and prompt metadata in reflection', async () => {
      const mockDdbClient = {
        send: mock(() => Promise.resolve({})),
      };

      const mockModelRouter = {
        selectModel: mock(() => Promise.resolve({
          selectedModel: 'us.anthropic.claude-opus-4-6-v1:0',
          taskCategory: 'research',
          routingWeights: {},
        } as ModelSelection)),
        recordOutcome: mock(() => Promise.resolve(undefined)),
      } as unknown as ModelRouter;

      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        evolutionTable: 'chimera-evolution-test',
        modelRouter: mockModelRouter,
        taskCategory: 'research',
        model: createMockModel(),
      };

      const agent = new ChimeraAgent(config);
      (agent as any).ddbClient = mockDdbClient;

      await agent.invoke('Deep research query');

      // Verify model metadata was stored
      const putCommand = mockDdbClient.send.mock.calls[0][0];
      expect(putCommand.input.Item.modelId).toBe('us.anthropic.claude-opus-4-6-v1:0');
      expect(putCommand.input.Item.taskCategory).toBe('research');
    });

    it('should not fail if DynamoDB client not configured', async () => {
      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        // No evolutionTable configured
      };

      const agent = new ChimeraAgent(config);

      // Should not throw
      await expect(agent.invoke('Test without DDB')).resolves.toBeDefined();
    });
  });

  describe('Feedback capture', () => {
    it('should capture thumbs_up feedback', async () => {
      const mockDdbClient = {
        send: mock(() => Promise.resolve({})),
      };

      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        evolutionTable: 'chimera-evolution-test',
      };

      const agent = new ChimeraAgent(config);
      (agent as any).ddbClient = mockDdbClient;

      await agent.captureFeedback({
        feedbackType: 'thumbs_up',
        turnIndex: 0,
      });

      // Verify feedback was stored
      expect(mockDdbClient.send).toHaveBeenCalled();
      const putCommand = mockDdbClient.send.mock.calls[0][0];

      expect(putCommand.input.Item.feedbackType).toBe('thumbs_up');
      expect(putCommand.input.Item.turnIndex).toBe(0);
      expect(putCommand.input.Item.processed).toBe(false);
    });

    it('should capture correction feedback with value', async () => {
      const mockDdbClient = {
        send: mock(() => Promise.resolve({})),
      };

      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        evolutionTable: 'chimera-evolution-test',
      };

      const agent = new ChimeraAgent(config);
      (agent as any).ddbClient = mockDdbClient;

      await agent.captureFeedback({
        feedbackType: 'correction',
        feedbackValue: 'Actually, the correct answer is X',
        turnIndex: 2,
      });

      const putCommand = mockDdbClient.send.mock.calls[0][0];
      expect(putCommand.input.Item.feedbackType).toBe('correction');
      expect(putCommand.input.Item.feedbackValue).toBe('Actually, the correct answer is X');
    });

    it('should warn if DynamoDB not configured', async () => {
      const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
        // No evolutionTable
      };

      const agent = new ChimeraAgent(config);

      await agent.captureFeedback({
        feedbackType: 'thumbs_down',
        turnIndex: 1,
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot capture feedback')
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('Quality score calculation', () => {
    it('should calculate quality score for successful completion', async () => {
      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
      };

      const agent = new ChimeraAgent(config);
      const calculateQualityScore = (agent as any).calculateQualityScore.bind(agent);

      const result = {
        output: 'Successful response with content',
        stopReason: 'end_turn',
        sessionId: 'session-123',
        toolCalls: [],
        context: {} as any,
      };

      const score = calculateQualityScore(result);

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(score).toBeGreaterThan(0.5); // Base + completion + output
    });

    it('should factor in tool success rate', async () => {
      const config: AgentConfig = {
        systemPrompt: createDefaultSystemPrompt(),
        tenantId: 'test-tenant',
      };

      const agent = new ChimeraAgent(config);
      const calculateQualityScore = (agent as any).calculateQualityScore.bind(agent);

      const resultWithSuccessfulTools = {
        output: 'Response',
        stopReason: 'end_turn',
        sessionId: 'session-123',
        toolCalls: [
          { name: 'tool1', input: {}, result: 'success' },
          { name: 'tool2', input: {}, result: 'success' },
        ],
        context: {} as any,
      };

      const scoreSuccess = calculateQualityScore(resultWithSuccessfulTools);

      const resultWithFailedTools = {
        output: 'Response',
        stopReason: 'end_turn',
        sessionId: 'session-123',
        toolCalls: [
          { name: 'tool1', input: {}, error: 'Failed' },
          { name: 'tool2', input: {}, error: 'Failed' },
        ],
        context: {} as any,
      };

      const scoreFailed = calculateQualityScore(resultWithFailedTools);

      expect(scoreSuccess).toBeGreaterThan(scoreFailed);
    });
  });
});
