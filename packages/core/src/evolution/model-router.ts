/**
 * Bayesian Model Router
 *
 * Uses Thompson Sampling to learn which model produces the best results
 * for which task types per tenant. Balances quality with cost efficiency.
 *
 * Supports:
 * - Expandable model pool (load from tenant config)
 * - Toggleable routing: static (use default) or auto (Thompson Sampling)
 * - Per-tenant model restrictions based on tier
 * - Routing explanations for transparency
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { TenantModelConfig, ModelWithCost, ModelRoutingMode } from '@chimera/shared';
import type {
  TaskCategory,
  ModelId,
  ModelArm,
  ModelRoutingState,
  ModelSelection,
} from './types';

// Lazy singleton to avoid TDZ errors from circular imports
let _ddbDocClient: DynamoDBDocumentClient | undefined;
function getDefaultDdbClient(): DynamoDBDocumentClient {
  if (!_ddbDocClient) {
    _ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return _ddbDocClient;
}

/**
 * Default model costs (fallback if not in tenant config)
 */
const DEFAULT_MODEL_COSTS: Record<string, number> = {
  'us.amazon.nova-micro-v1:0': 0.000088,
  'us.amazon.nova-lite-v1:0': 0.00024,
  'us.anthropic.claude-sonnet-4-6-v1:0': 0.009,
  'us.anthropic.claude-opus-4-6-v1:0': 0.045,
};

/**
 * Bayesian model router with Thompson Sampling
 */
export class ModelRouter {
  private _ddb: DynamoDBDocumentClient | undefined;
  private _ddbOverride: DynamoDBDocumentClient | undefined;
  private tableName: string;
  private costSensitivity: number;
  private arms: Map<TaskCategory, Map<ModelId, ModelArm>>;
  private tenantModelConfig: TenantModelConfig;
  private modelCosts: Map<ModelId, number>;

  private get ddb(): DynamoDBDocumentClient {
    if (!this._ddb) {
      this._ddb = this._ddbOverride ?? getDefaultDdbClient();
    }
    return this._ddb;
  }

  constructor(params: {
    tableName: string;
    tenantModelConfig: TenantModelConfig;
    costSensitivity?: number;
    ddbClient?: DynamoDBDocumentClient;
  }) {
    this.tableName = params.tableName;
    this.tenantModelConfig = params.tenantModelConfig;
    this.costSensitivity = params.costSensitivity ?? 0.3;
    this._ddbOverride = params.ddbClient;
    this.arms = new Map();

    // Build model costs map from tenant config or fallback
    this.modelCosts = this.buildModelCostsMap();
  }

  /**
   * Build model costs map from tenant config or defaults
   */
  private buildModelCostsMap(): Map<ModelId, number> {
    const costs = new Map<ModelId, number>();

    // Load from tenant config if available
    if (this.tenantModelConfig.availableModelsWithCosts) {
      for (const model of this.tenantModelConfig.availableModelsWithCosts) {
        costs.set(model.modelId, model.costPer1kTokens);
      }
    }

    // Fallback to defaults for any missing models
    for (const [modelId, cost] of Object.entries(DEFAULT_MODEL_COSTS)) {
      if (!costs.has(modelId)) {
        costs.set(modelId, cost);
      }
    }

    return costs;
  }

  /**
   * Get allowed models for this tenant
   */
  private getAllowedModels(): ModelId[] {
    const allowedModels = this.tenantModelConfig.allowedModels || [];

    // Filter to only models we have costs for
    return allowedModels.filter(modelId => this.modelCosts.has(modelId));
  }

  /**
   * Get routing mode (static or auto)
   */
  private getRoutingMode(): ModelRoutingMode {
    return this.tenantModelConfig.routingMode || 'auto';
  }

  /**
   * Select the optimal model for a request
   *
   * Supports two modes:
   * - static: Always use tenant's defaultModel
   * - auto: Use Thompson Sampling to balance quality and cost
   */
  async selectModel(params: {
    tenantId: string;
    taskCategory: TaskCategory;
  }): Promise<ModelSelection> {
    const routingMode = this.getRoutingMode();
    const allowedModels = this.getAllowedModels();

    // Static mode: use defaultModel
    if (routingMode === 'static') {
      const defaultModel = this.tenantModelConfig.defaultModel;

      // Validate default model is allowed
      if (!allowedModels.includes(defaultModel)) {
        throw new Error(
          `Default model ${defaultModel} is not in allowedModels for tenant`
        );
      }

      const modelCost = this.modelCosts.get(defaultModel) || 0;
      const explanation = `Static routing: Using configured default model (${defaultModel}, $${modelCost}/1k tokens)`;

      return {
        selectedModel: defaultModel,
        taskCategory: params.taskCategory,
        routingMode: 'static',
        explanation,
      };
    }

    // Auto mode: Thompson Sampling
    await this.loadState(params.tenantId);

    if (!this.arms.has(params.taskCategory)) {
      this.initializeArms(params.taskCategory);
    }

    const categoryArms = this.arms.get(params.taskCategory)!;
    let bestModel: ModelId | null = null;
    let bestScore = -1;
    let bestQualitySample = 0;
    let bestCostFactor = 0;

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
        bestQualitySample = qualitySample;
        bestCostFactor = normalizedCost;
      }
    }

    if (!bestModel || !allowedModels.includes(bestModel)) {
      // Fallback to default model if Thompson sampling fails or selects disallowed model
      bestModel = this.tenantModelConfig.defaultModel;
    }

    const arm = categoryArms.get(bestModel);
    const meanQuality = arm ? arm.alpha / (arm.alpha + arm.beta) : 0;
    const observations = arm ? Math.round(arm.alpha + arm.beta - 2) : 0;
    const modelCost = this.modelCosts.get(bestModel) || 0;

    // Build explanation
    const taskComplexityMap: Record<TaskCategory, string> = {
      simple_qa: 'simple query',
      code_gen: 'code generation',
      analysis: 'complex analysis',
      creative: 'creative task',
      planning: 'planning',
      research: 'research',
    };

    const explanation = `Auto routing (Thompson Sampling): Selected ${bestModel} for ${taskComplexityMap[params.taskCategory]} based on quality sample ${bestQualitySample.toFixed(3)} (mean: ${meanQuality.toFixed(3)} from ${observations} obs), cost factor ${bestCostFactor.toFixed(3)}, sensitivity ${this.costSensitivity}`;

    return {
      selectedModel: bestModel,
      taskCategory: params.taskCategory,
      routingMode: 'auto',
      explanation,
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
   *
   * Uses tenant's allowed models and their costs
   */
  private initializeArms(taskCategory: TaskCategory): void {
    const categoryArms = new Map<ModelId, ModelArm>();
    const allowedModels = this.getAllowedModels();

    // Initialize arms only for allowed models
    for (const modelId of allowedModels) {
      const cost = this.modelCosts.get(modelId);
      if (cost !== undefined) {
        categoryArms.set(modelId, {
          modelId,
          costPer1kTokens: cost,
          alpha: 1.0, // Prior: assume 1 success
          beta: 1.0,  // Prior: assume 1 failure
        });
      }
    }

    this.arms.set(taskCategory, categoryArms);
  }

  /**
   * Load routing state from DynamoDB
   *
   * Restores Thompson Sampling state for tenant-allowed models
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

    const allowedModels = this.getAllowedModels();

    // Restore arms from saved state (filter to allowed models)
    this.arms.clear();
    for (const [category, models] of Object.entries(state)) {
      const categoryArms = new Map<ModelId, ModelArm>();

      for (const [modelId, params] of Object.entries(models)) {
        // Only restore arms for models that are still allowed
        if (allowedModels.includes(modelId)) {
          const cost = this.modelCosts.get(modelId) || 0.01;
          categoryArms.set(modelId, {
            modelId,
            costPer1kTokens: cost,
            alpha: params.alpha,
            beta: params.beta,
          });
        }
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
  tenantModelConfig: TenantModelConfig;
  costSensitivity?: number;
}): ModelRouter {
  return new ModelRouter(params);
}

/**
 * Add models to tenant configuration
 *
 * Helper to dynamically expand model pool
 */
export function addModelsToConfig(
  config: TenantModelConfig,
  newModels: ModelWithCost[]
): TenantModelConfig {
  const existingModels = config.availableModelsWithCosts || [];
  const existingModelIds = new Set(existingModels.map(m => m.modelId));

  // Only add models that don't exist yet
  const modelsToAdd = newModels.filter(m => !existingModelIds.has(m.modelId));

  return {
    ...config,
    availableModelsWithCosts: [...existingModels, ...modelsToAdd],
    allowedModels: [
      ...config.allowedModels,
      ...modelsToAdd.map(m => m.modelId),
    ],
  };
}
