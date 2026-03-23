/**
 * Token Estimation and Cost Calculation
 *
 * Provides pre-flight token estimation for budget enforcement.
 * Uses heuristic approximation (text.length / 4) as a conservative estimate.
 *
 * Production systems should use actual tokenizer (e.g., tiktoken) for accuracy,
 * but this heuristic is sufficient for budget gates.
 */

import { BEDROCK_MODELS, ModelId } from '../evolution/types';

/**
 * Estimate token count from text using simple heuristic
 *
 * Uses 4 chars per token as a conservative estimate.
 * This tends to overestimate, which is safer for budget enforcement.
 *
 * @param text - Text to estimate
 * @returns Estimated token count
 */
export function estimateTokenCount(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total input tokens for a Bedrock request
 *
 * Sums token estimates across:
 * - System prompt
 * - User/assistant messages
 * - Tool specifications
 *
 * @param params - Request parameters
 * @returns Estimated input token count
 */
export function estimateMessageTokens(params: {
  messages: any[];
  systemPrompt?: string;
  tools?: any[];
}): number {
  let totalTokens = 0;

  // System prompt
  if (params.systemPrompt) {
    totalTokens += estimateTokenCount(params.systemPrompt);
  }

  // Messages
  for (const message of params.messages) {
    if (message.content) {
      for (const block of message.content) {
        if (block.text) {
          totalTokens += estimateTokenCount(block.text);
        }
        // Tool use/result - estimate as JSON string
        if (block.toolUse) {
          totalTokens += estimateTokenCount(JSON.stringify(block.toolUse));
        }
        if (block.toolResult) {
          const content = typeof block.toolResult.content === 'string'
            ? block.toolResult.content
            : JSON.stringify(block.toolResult.content);
          totalTokens += estimateTokenCount(content);
        }
      }
    }
  }

  // Tool specifications (if provided)
  if (params.tools && params.tools.length > 0) {
    const toolsJson = JSON.stringify(params.tools);
    totalTokens += estimateTokenCount(toolsJson);
  }

  return totalTokens;
}

/**
 * Estimate cost for a Bedrock request
 *
 * Uses model-specific pricing from BEDROCK_MODELS constant.
 * Cost = (inputTokens * inputCost) + (maxOutputTokens * outputCost)
 *
 * @param params - Cost estimation parameters
 * @returns Estimated cost in USD
 */
export function estimateRequestCost(params: {
  modelId: string;
  inputTokens: number;
  maxOutputTokens: number;
}): number {
  // Validate model ID
  if (!(params.modelId in BEDROCK_MODELS)) {
    throw new Error(`Unknown model ID: ${params.modelId}`);
  }

  const modelId = params.modelId as ModelId;
  const costPer1kTokens = BEDROCK_MODELS[modelId];

  // Bedrock pricing is the same for input and output tokens (simplified)
  // In reality, some models have different input/output pricing, but BEDROCK_MODELS
  // uses a single cost value, so we apply it uniformly
  const inputCost = (params.inputTokens / 1000) * costPer1kTokens;
  const outputCost = (params.maxOutputTokens / 1000) * costPer1kTokens;

  return inputCost + outputCost;
}

/**
 * Budget exceeded error
 *
 * Thrown when a request would exceed tenant budget limits.
 * Includes context for debugging and user feedback.
 */
export class BudgetExceededError extends Error {
  public readonly tenantId: string;
  public readonly estimatedCost: number;
  public readonly budgetRemaining: number;

  constructor(tenantId: string, estimatedCost: number, budgetRemaining: number) {
    super(
      `Budget exceeded for tenant ${tenantId}. ` +
      `Request would cost $${estimatedCost.toFixed(4)}, ` +
      `but only $${budgetRemaining.toFixed(4)} remaining.`
    );
    this.name = 'BudgetExceededError';
    this.tenantId = tenantId;
    this.estimatedCost = estimatedCost;
    this.budgetRemaining = budgetRemaining;
  }
}
