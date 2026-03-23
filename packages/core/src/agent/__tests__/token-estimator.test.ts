/**
 * Tests for token estimation and cost calculation
 */

import { describe, it, expect } from 'bun:test';
import {
  estimateTokenCount,
  estimateMessageTokens,
  estimateRequestCost,
  BudgetExceededError,
} from '../token-estimator';

describe('estimateTokenCount', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('should estimate tokens for short text', () => {
    // "hello" = 5 chars → ceil(5/4) = 2 tokens
    expect(estimateTokenCount('hello')).toBe(2);
  });

  it('should estimate tokens for long text', () => {
    // 100 chars → ceil(100/4) = 25 tokens
    const text = 'a'.repeat(100);
    expect(estimateTokenCount(text)).toBe(25);
  });

  it('should handle text with spaces and punctuation', () => {
    const text = 'Hello, world! How are you?';
    // 26 chars → ceil(26/4) = 7 tokens
    expect(estimateTokenCount(text)).toBe(7);
  });

  it('should round up partial tokens', () => {
    // 3 chars → ceil(3/4) = 1 token
    expect(estimateTokenCount('hi!')).toBe(1);
  });
});

describe('estimateMessageTokens', () => {
  it('should estimate tokens from messages only', () => {
    const messages = [
      {
        role: 'user',
        content: [{ text: 'Hello' }] // 5 chars → 2 tokens
      },
      {
        role: 'assistant',
        content: [{ text: 'Hi there' }] // 8 chars → 2 tokens
      }
    ];

    expect(estimateMessageTokens({ messages })).toBe(4);
  });

  it('should include system prompt in estimate', () => {
    const messages = [
      { role: 'user', content: [{ text: 'test' }] } // 4 chars → 1 token
    ];
    const systemPrompt = 'You are a helpful assistant.'; // 28 chars → 7 tokens

    expect(estimateMessageTokens({ messages, systemPrompt })).toBe(8);
  });

  it('should include tool specifications in estimate', () => {
    const messages = [
      { role: 'user', content: [{ text: 'test' }] } // 1 token
    ];
    const tools = [
      {
        name: 'calculator',
        description: 'Does math',
        inputSchema: { type: 'object', properties: {} }
      }
    ];
    // Tool JSON will add tokens (exact count depends on JSON serialization)
    const estimate = estimateMessageTokens({ messages, tools });
    expect(estimate).toBeGreaterThan(1); // Should be more than just the message
  });

  it('should handle tool use in messages', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: 'tc_123',
              name: 'calculator',
              input: { operation: 'add', a: 1, b: 2 }
            }
          }
        ]
      }
    ];

    const estimate = estimateMessageTokens({ messages });
    expect(estimate).toBeGreaterThan(0);
  });

  it('should handle tool results in messages', () => {
    const messages = [
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'tc_123',
              content: 'The result is 3',
              status: 'success'
            }
          }
        ]
      }
    ];

    const estimate = estimateMessageTokens({ messages });
    expect(estimate).toBeGreaterThan(0);
  });

  it('should handle JSON tool result content', () => {
    const messages = [
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'tc_123',
              content: { result: 42, status: 'ok' }
            }
          }
        ]
      }
    ];

    const estimate = estimateMessageTokens({ messages });
    expect(estimate).toBeGreaterThan(0);
  });

  it('should return 0 for empty messages', () => {
    expect(estimateMessageTokens({ messages: [] })).toBe(0);
  });

  it('should handle multiple content blocks per message', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { text: 'Hello' }, // 2 tokens
          { text: 'World' }  // 2 tokens
        ]
      }
    ];

    expect(estimateMessageTokens({ messages })).toBe(4);
  });
});

describe('estimateRequestCost', () => {
  it('should calculate cost for Nova Micro', () => {
    const cost = estimateRequestCost({
      modelId: 'us.amazon.nova-micro-v1:0',
      inputTokens: 1000,
      maxOutputTokens: 1000
    });

    // Nova Micro: 0.000088 per 1k tokens
    // (1000/1000 * 0.000088) + (1000/1000 * 0.000088) = 0.000176
    expect(cost).toBeCloseTo(0.000176, 6);
  });

  it('should calculate cost for Nova Lite', () => {
    const cost = estimateRequestCost({
      modelId: 'us.amazon.nova-lite-v1:0',
      inputTokens: 1000,
      maxOutputTokens: 1000
    });

    // Nova Lite: 0.00024 per 1k tokens
    // (1000/1000 * 0.00024) + (1000/1000 * 0.00024) = 0.00048
    expect(cost).toBeCloseTo(0.00048, 6);
  });

  it('should calculate cost for Claude Sonnet', () => {
    const cost = estimateRequestCost({
      modelId: 'us.anthropic.claude-sonnet-4-6-v1:0',
      inputTokens: 1000,
      maxOutputTokens: 1000
    });

    // Sonnet: 0.009 per 1k tokens
    // (1000/1000 * 0.009) + (1000/1000 * 0.009) = 0.018
    expect(cost).toBeCloseTo(0.018, 6);
  });

  it('should calculate cost for Claude Opus', () => {
    const cost = estimateRequestCost({
      modelId: 'us.anthropic.claude-opus-4-6-v1:0',
      inputTokens: 1000,
      maxOutputTokens: 1000
    });

    // Opus: 0.045 per 1k tokens
    // (1000/1000 * 0.045) + (1000/1000 * 0.045) = 0.09
    expect(cost).toBeCloseTo(0.09, 6);
  });

  it('should show large cost difference between Nova and Opus', () => {
    const novaCost = estimateRequestCost({
      modelId: 'us.amazon.nova-micro-v1:0',
      inputTokens: 10000,
      maxOutputTokens: 2000
    });

    const opusCost = estimateRequestCost({
      modelId: 'us.anthropic.claude-opus-4-6-v1:0',
      inputTokens: 10000,
      maxOutputTokens: 2000
    });

    // Opus should be much more expensive than Nova
    expect(opusCost).toBeGreaterThan(novaCost * 100);
  });

  it('should handle fractional token counts', () => {
    const cost = estimateRequestCost({
      modelId: 'us.amazon.nova-micro-v1:0',
      inputTokens: 500,
      maxOutputTokens: 250
    });

    // (500/1000 * 0.000088) + (250/1000 * 0.000088) = 0.000066
    expect(cost).toBeCloseTo(0.000066, 6);
  });

  it('should throw error for unknown model', () => {
    expect(() => {
      estimateRequestCost({
        modelId: 'unknown-model',
        inputTokens: 1000,
        maxOutputTokens: 1000
      });
    }).toThrow('Unknown model ID: unknown-model');
  });

  it('should handle zero tokens', () => {
    const cost = estimateRequestCost({
      modelId: 'us.amazon.nova-micro-v1:0',
      inputTokens: 0,
      maxOutputTokens: 0
    });

    expect(cost).toBe(0);
  });
});

describe('BudgetExceededError', () => {
  it('should create error with tenant context', () => {
    const error = new BudgetExceededError('tenant-123', 0.05, 0.02);

    expect(error.name).toBe('BudgetExceededError');
    expect(error.tenantId).toBe('tenant-123');
    expect(error.estimatedCost).toBe(0.05);
    expect(error.budgetRemaining).toBe(0.02);
    expect(error.message).toContain('tenant-123');
    expect(error.message).toContain('0.0500');
    expect(error.message).toContain('0.0200');
  });

  it('should be instanceof Error', () => {
    const error = new BudgetExceededError('tenant-123', 0.1, 0.05);
    expect(error instanceof Error).toBe(true);
  });

  it('should format costs with 4 decimal places', () => {
    const error = new BudgetExceededError('tenant-123', 0.123456, 0.001234);
    expect(error.message).toContain('0.1235');
    expect(error.message).toContain('0.0012');
  });
});
