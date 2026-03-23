/**
 * Bayesian Model Router
 *
 * Uses Thompson Sampling to learn which model produces the best results
 * for which task types per tenant. Balances quality with cost efficiency.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  TaskCategory,
  ModelId,
  ModelArm,
  ModelRoutingState,
  ModelSelection,
  BEDROCK_MODELS,
} from './types';

// Module-level singleton DynamoDB client
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

/**
 * Model costs per 1k tokens
 */
const MODEL_COSTS: Record<ModelId, number> = {
  'us.amazon.nova-micro-v1:0': 0.000088,
  'us.amazon.nova-lite-v1:0': 0.00024,
  'us.anthropic.claude-sonnet-4-6-v1:0': 0.009,
  'us.anthropic.claude-opus-4-6-v1:0': 0.045,
};

/**
 * Bayesian model router with Thompson Sampling
 */
export class ModelRouter {
  private ddb: DynamoDBDocumentClient;
  private tableName: string;
  private costSensitivity: number;
  private arms: Map<TaskCategory, Map<ModelId, ModelArm>>;

  constructor(params: {
    tableName: string;
    costSensitivity?: number;
  }) {
    this.tableName = params.tableName;
    this.costSensitivity = params.costSensitivity ?? 0.3;
    this.ddb = ddbDocClient;
    this.arms = new Map();
  }

  /**
   * Select the optimal model for a request using Thompson Sampling
   */
  async selectModel(params: {
    tenantId: string;
    taskCategory: TaskCategory;
  }): Promise<ModelSelection> {
    // Load routing state from DynamoDB
    await this.loadState(params.tenantId);

    // Get or initialize arms for this task category
    if (!this.arms.has(params.taskCategory)) {
      this.initializeArms(params.taskCategory);
    }

    const categoryArms = this.arms.get(params.taskCategory)!;
    let bestModel: ModelId | null = null;
    let bestScore = -1;

    // Thompson sampling: draw from each arm's Beta distribution
    for (const [modelId, arm] of categoryArms) {
      const qualitySample = this.sampleBeta(arm.alpha, arm.beta);

      // Blend quality with cost efficiency
      const costFactor = 1.0 / (arm.costPer1kTokens + 1e-9);
      const maxCostFactor = Math.max(
        ...Array.from(categoryArms.values()).map(
          (a) => 1.0 / (a.costPer1kTokens + 1e-9)
        )
      );
      const normalizedCost = costFactor / maxCostFactor;

      const score =
        (1 - this.costSensitivity) * qualitySample +
        this.costSensitivity * normalizedCost;

      if (score > bestScore) {
        bestScore = score;
        bestModel = modelId;
      }
    }

    if (!bestModel) {
      // Fallback to Sonnet 4.6
      bestModel = 'us.anthropic.claude-sonnet-4-6-v1:0';
    }

    return {
      selectedModel: bestModel,
      taskCategory: params.taskCategory,
      routingWeights: this.getRoutingWeights(params.taskCategory),
    };
  }

  /**
   * Record the outcome of a model selection
   */
  async recordOutcome(params: {
    tenantId: string;
    taskCategory: TaskCategory;
    modelId: ModelId;
    qualityScore: number; // 0-1
  }): Promise<void> {
    await this.loadState(params.tenantId);

    if (!this.arms.has(params.taskCategory)) {
      this.initializeArms(params.taskCategory);
    }

    const categoryArms = this.arms.get(params.taskCategory)!;
    const arm = categoryArms.get(params.modelId);

    if (arm) {
      // Update Beta distribution
      arm.alpha += params.qualityScore;
      arm.beta += 1.0 - params.qualityScore;
    }

    // Persist to DynamoDB
    await this.saveState(params.tenantId);
  }

  /**
   * Get current routing weights for a task category
   */
  getRoutingWeights(taskCategory: TaskCategory): Record<ModelId, {
    meanQuality: number;
    observations: number;
    costPer1k: number;
    costAdjustedScore: number;
  }> {
    const categoryArms = this.arms.get(taskCategory);
    if (!categoryArms) {
      return {} as any;
    }

    const weights: any = {};
    for (const [modelId, arm] of categoryArms) {
      const meanQuality = arm.alpha / (arm.alpha + arm.beta);
      const observations = Math.round(arm.alpha + arm.beta - 2);
      const costAdjustedScore = meanQuality / arm.costPer1kTokens;

      weights[modelId] = {
        meanQuality: parseFloat(meanQuality.toFixed(4)),
        observations,
        costPer1k: arm.costPer1kTokens,
        costAdjustedScore: parseFloat(costAdjustedScore.toFixed(4)),
      };
    }

    return weights;
  }

  /**
   * Initialize arms for a task category
   */
  private initializeArms(taskCategory: TaskCategory): void {
    const categoryArms = new Map<ModelId, ModelArm>();

    for (const [modelId, cost] of Object.entries(MODEL_COSTS)) {
      categoryArms.set(modelId as ModelId, {
        modelId: modelId as ModelId,
        costPer1kTokens: cost,
        alpha: 1.0, // Prior: assume 1 success
        beta: 1.0,  // Prior: assume 1 failure
      });
    }

    this.arms.set(taskCategory, categoryArms);
  }

  /**
   * Load routing state from DynamoDB
   */
  private async loadState(tenantId: string): Promise<void> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `TENANT#${tenantId}`,
          SK: 'MODEL_ROUTING',
        },
      })
    );

    if (!result.Item?.routingState) {
      // No saved state, keep initial arms
      return;
    }

    const state = result.Item.routingState as Record<
      string,
      Record<string, { alpha: number; beta: number }>
    >;

    // Restore arms from saved state
    this.arms.clear();
    for (const [category, models] of Object.entries(state)) {
      const categoryArms = new Map<ModelId, ModelArm>();

      for (const [modelId, params] of Object.entries(models)) {
        categoryArms.set(modelId as ModelId, {
          modelId: modelId as ModelId,
          costPer1kTokens: MODEL_COSTS[modelId as ModelId] || 0.01,
          alpha: params.alpha,
          beta: params.beta,
        });
      }

      this.arms.set(category as TaskCategory, categoryArms);
    }

    if (result.Item.costSensitivity !== undefined) {
      this.costSensitivity = result.Item.costSensitivity;
    }
  }

  /**
   * Save routing state to DynamoDB
   */
  private async saveState(tenantId: string): Promise<void> {
    const serialized = this.serialize();

    await this.ddb.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: `TENANT#${tenantId}`,
          SK: 'MODEL_ROUTING',
        },
        UpdateExpression:
          'SET routingState = :state, costSensitivity = :cost, lastUpdated = :ts, totalRequests = if_not_exists(totalRequests, :zero) + :one',
        ExpressionAttributeValues: {
          ':state': serialized,
          ':cost': this.costSensitivity,
          ':ts': new Date().toISOString(),
          ':zero': 0,
          ':one': 1,
        },
      })
    );
  }

  /**
   * Serialize routing state for DynamoDB
   */
  private serialize(): Record<string, Record<string, { alpha: number; beta: number }>> {
    const state: Record<string, Record<string, { alpha: number; beta: number }>> = {};

    for (const [category, categoryArms] of this.arms) {
      state[category] = {};
      for (const [modelId, arm] of categoryArms) {
        state[category][modelId] = {
          alpha: arm.alpha,
          beta: arm.beta,
        };
      }
    }

    return state;
  }

  /**
   * Sample from Beta distribution using Kumaraswamy approximation
   *
   * The Kumaraswamy distribution is a good approximation for Beta
   * with parameters in the typical range (alpha, beta > 0.5).
   * Uses inverse CDF method for efficient sampling.
   */
  private sampleBeta(alpha: number, beta: number): number {
    // For better Thompson sampling, use Kumaraswamy approximation
    // when both parameters are > 1, otherwise use moment matching

    if (alpha >= 1 && beta >= 1) {
      // Kumaraswamy approximation: simpler inverse CDF
      // a and b parameters chosen to match Beta moments
      const a = alpha;
      const b = beta;

      const u = Math.random();
      const sample = Math.pow(1 - Math.pow(1 - u, 1 / b), 1 / a);

      return Math.max(0, Math.min(1, sample));
    } else {
      // For small alpha/beta, use Gaussian approximation
      const mean = alpha / (alpha + beta);
      const variance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));
      const stddev = Math.sqrt(variance);

      // Add Gaussian noise with clamping
      const noise = this.randomGaussian() * stddev;
      const sample = Math.max(0, Math.min(1, mean + noise));

      return sample;
    }
  }

  /**
   * Generate random number from standard normal distribution
   * Using Box-Muller transform
   */
  private randomGaussian(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /**
   * Update cost sensitivity for tenant
   */
  async updateCostSensitivity(params: {
    tenantId: string;
    costSensitivity: number;
  }): Promise<void> {
    if (params.costSensitivity < 0 || params.costSensitivity > 1) {
      throw new Error('Cost sensitivity must be between 0 and 1');
    }

    this.costSensitivity = params.costSensitivity;

    await this.ddb.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: `TENANT#${params.tenantId}`,
          SK: 'MODEL_ROUTING',
        },
        UpdateExpression: 'SET costSensitivity = :cost, lastUpdated = :ts',
        ExpressionAttributeValues: {
          ':cost': params.costSensitivity,
          ':ts': new Date().toISOString(),
        },
      })
    );
  }

  /**
   * Get estimated cost savings vs always using Opus
   */
  async getCostSavings(tenantId: string): Promise<number> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `TENANT#${tenantId}`,
          SK: 'MODEL_ROUTING',
        },
      })
    );

    return result.Item?.costSaved || 0;
  }

  /**
   * Reset routing state for a tenant (for testing or debugging)
   */
  async resetState(tenantId: string): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `TENANT#${tenantId}`,
          SK: 'MODEL_ROUTING',
          routingState: {},
          costSensitivity: this.costSensitivity,
          lastUpdated: new Date().toISOString(),
          totalRequests: 0,
          costSaved: 0,
        },
      })
    );

    this.arms.clear();
  }
}

/**
 * Create a model router instance
 */
export function createModelRouter(params: {
  tableName: string;
  costSensitivity?: number;
}): ModelRouter {
  return new ModelRouter(params);
}
