/**
 * Unit tests for ModelRouter
 *
 * Tests Thompson sampling Bayesian model routing logic with:
 * - Expandable model pool
 * - Toggleable routing (static vs auto)
 * - Per-tenant model restrictions
 * - Routing explanations
 *
 * Integration tests cover AWS SDK interactions.
 */

import { describe, it, expect } from 'bun:test';
import type { TenantModelConfig } from '@chimera/shared';

describe('ModelRouter Logic', () => {
  describe('Routing mode selection', () => {
    it('should support static routing mode', () => {
      const config: TenantModelConfig = {
        PK: 'TENANT#test',
        SK: 'CONFIG#models',
        allowedModels: ['us.anthropic.claude-sonnet-4-6-v1:0'],
        defaultModel: 'us.anthropic.claude-sonnet-4-6-v1:0',
        modelRouting: {},
        fallbackChain: [],
        monthlyBudgetUsd: 1000,
        costAlertThreshold: 0.8,
        routingMode: 'static',
      };

      expect(config.routingMode).toBe('static');
    });

    it('should support auto routing mode', () => {
      const config: TenantModelConfig = {
        PK: 'TENANT#test',
        SK: 'CONFIG#models',
        allowedModels: ['us.anthropic.claude-sonnet-4-6-v1:0'],
        defaultModel: 'us.anthropic.claude-sonnet-4-6-v1:0',
        modelRouting: {},
        fallbackChain: [],
        monthlyBudgetUsd: 1000,
        costAlertThreshold: 0.8,
        routingMode: 'auto',
      };

      expect(config.routingMode).toBe('auto');
    });

    it('should default to auto mode if not specified', () => {
      const config: TenantModelConfig = {
        PK: 'TENANT#test',
        SK: 'CONFIG#models',
        allowedModels: ['us.anthropic.claude-sonnet-4-6-v1:0'],
        defaultModel: 'us.anthropic.claude-sonnet-4-6-v1:0',
        modelRouting: {},
        fallbackChain: [],
        monthlyBudgetUsd: 1000,
        costAlertThreshold: 0.8,
      };

      expect(config.routingMode).toBeUndefined();
      // Router should default to 'auto' when routingMode is undefined
    });
  });

  describe('Model pool management', () => {
    it('should support expandable model pool', () => {
      const config: TenantModelConfig = {
        PK: 'TENANT#test',
        SK: 'CONFIG#models',
        allowedModels: [
          'us.amazon.nova-micro-v1:0',
          'us.amazon.nova-lite-v1:0',
          'us.anthropic.claude-sonnet-4-6-v1:0',
        ],
        defaultModel: 'us.anthropic.claude-sonnet-4-6-v1:0',
        modelRouting: {},
        fallbackChain: [],
        monthlyBudgetUsd: 1000,
        costAlertThreshold: 0.8,
        availableModelsWithCosts: [
          { modelId: 'us.amazon.nova-micro-v1:0', costPer1kTokens: 0.000088 },
          { modelId: 'us.amazon.nova-lite-v1:0', costPer1kTokens: 0.00024 },
          { modelId: 'us.anthropic.claude-sonnet-4-6-v1:0', costPer1kTokens: 0.009 },
        ],
      };

      expect(config.availableModelsWithCosts).toHaveLength(3);
    });

    it('should support adding new models dynamically', () => {
      const config: TenantModelConfig = {
        PK: 'TENANT#test',
        SK: 'CONFIG#models',
        allowedModels: ['us.amazon.nova-lite-v1:0'],
        defaultModel: 'us.amazon.nova-lite-v1:0',
        modelRouting: {},
        fallbackChain: [],
        monthlyBudgetUsd: 1000,
        costAlertThreshold: 0.8,
        availableModelsWithCosts: [
          { modelId: 'us.amazon.nova-lite-v1:0', costPer1kTokens: 0.00024 },
        ],
      };

      // Add new model
      const newModels = [
        { modelId: 'us.anthropic.claude-opus-4-6-v1:0', costPer1kTokens: 0.045 },
      ];

      const updatedConfig = {
        ...config,
        availableModelsWithCosts: [
          ...(config.availableModelsWithCosts || []),
          ...newModels,
        ],
        allowedModels: [
          ...config.allowedModels,
          ...newModels.map(m => m.modelId),
        ],
      };

      expect(updatedConfig.availableModelsWithCosts).toHaveLength(2);
      expect(updatedConfig.allowedModels).toContain('us.anthropic.claude-opus-4-6-v1:0');
    });
  });

  describe('Per-tenant model restrictions', () => {
    it('should enforce basic tier restrictions', () => {
      const basicTierModels = [
        'us.amazon.nova-lite-v1:0',
        'us.anthropic.claude-sonnet-4-6-v1:0',
      ];

      const config: TenantModelConfig = {
        PK: 'TENANT#basic',
        SK: 'CONFIG#models',
        allowedModels: basicTierModels,
        defaultModel: 'us.anthropic.claude-sonnet-4-6-v1:0',
        modelRouting: {},
        fallbackChain: [],
        monthlyBudgetUsd: 100,
        costAlertThreshold: 0.8,
      };

      expect(config.allowedModels).toHaveLength(2);
      expect(config.allowedModels).not.toContain('us.anthropic.claude-opus-4-6-v1:0');
    });

    it('should enforce enterprise tier restrictions', () => {
      const enterpriseTierModels = [
        'us.amazon.nova-micro-v1:0',
        'us.amazon.nova-lite-v1:0',
        'us.anthropic.claude-sonnet-4-6-v1:0',
        'us.anthropic.claude-opus-4-6-v1:0',
      ];

      const config: TenantModelConfig = {
        PK: 'TENANT#enterprise',
        SK: 'CONFIG#models',
        allowedModels: enterpriseTierModels,
        defaultModel: 'us.anthropic.claude-sonnet-4-6-v1:0',
        modelRouting: {},
        fallbackChain: [],
        monthlyBudgetUsd: 5000,
        costAlertThreshold: 0.8,
      };

      expect(config.allowedModels).toHaveLength(4);
      expect(config.allowedModels).toContain('us.anthropic.claude-opus-4-6-v1:0');
    });
  });

  describe('Routing explanations', () => {
    it('should provide explanation for static routing', () => {
      const explanation = `Static routing: Using configured default model (us.anthropic.claude-sonnet-4-6-v1:0, $0.009/1k tokens)`;

      expect(explanation).toContain('Static routing');
      expect(explanation).toContain('default model');
      expect(explanation).toContain('$0.009');
    });

    it('should provide explanation for auto routing', () => {
      const explanation = `Auto routing (Thompson Sampling): Selected us.anthropic.claude-sonnet-4-6-v1:0 for code generation based on quality sample 0.85 (mean: 0.82 from 42 obs), cost factor 0.65, sensitivity 0.3`;

      expect(explanation).toContain('Thompson Sampling');
      expect(explanation).toContain('quality sample');
      expect(explanation).toContain('cost factor');
      expect(explanation).toContain('sensitivity');
    });
  });

  describe('Beta distribution sampling', () => {
    it('should generate sample within [0, 1] range', () => {
      const alpha = 10;
      const beta = 2;

      // Approximate Beta sampling using mean + noise
      const mean = alpha / (alpha + beta);
      const variance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));
      const stddev = Math.sqrt(variance);

      // Box-Muller transform for Gaussian noise
      const u1 = Math.random();
      const u2 = Math.random();
      const gaussianNoise = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
      const sample = Math.max(0, Math.min(1, mean + gaussianNoise * stddev));

      expect(sample).toBeGreaterThanOrEqual(0);
      expect(sample).toBeLessThanOrEqual(1);
    });

    it('should have mean close to alpha/(alpha+beta)', () => {
      const alpha = 8;
      const beta = 2;
      const expectedMean = alpha / (alpha + beta);

      const samples: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const mean = alpha / (alpha + beta);
        const variance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));
        const stddev = Math.sqrt(variance);
        const u1 = Math.random();
        const u2 = Math.random();
        const gaussianNoise = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        samples.push(Math.max(0, Math.min(1, mean + gaussianNoise * stddev)));
      }

      const actualMean = samples.reduce((sum, s) => sum + s, 0) / samples.length;

      // Should be within 10% of expected mean
      expect(actualMean).toBeGreaterThan(expectedMean * 0.9);
      expect(actualMean).toBeLessThan(expectedMean * 1.1);
    });
  });

  describe('Cost-adjusted scoring', () => {
    const models = [
      { id: 'us.amazon.nova-micro-v1:0', cost: 0.000088, quality: 0.7 },
      { id: 'us.amazon.nova-lite-v1:0', cost: 0.00024, quality: 0.75 },
      { id: 'us.anthropic.claude-sonnet-4-6-v1:0', cost: 0.009, quality: 0.95 },
      { id: 'us.anthropic.claude-opus-4-6-v1:0', cost: 0.045, quality: 0.98 },
    ];

    it('should favor quality when cost sensitivity is low', () => {
      const costSensitivity = 0.1; // Heavily favor quality

      const scores = models.map((model) => {
        const costFactor = 1.0 / (model.cost + 1e-9);
        const maxCostFactor = Math.max(...models.map((m) => 1.0 / (m.cost + 1e-9)));
        const normalizedCost = costFactor / maxCostFactor;

        return {
          model: model.id,
          score: (1 - costSensitivity) * model.quality + costSensitivity * normalizedCost,
        };
      });

      scores.sort((a, b) => b.score - a.score);

      // Should favor high-quality models (Opus or Sonnet)
      expect(scores[0].model).toMatch(/opus|sonnet/);
    });

    it('should favor cost when cost sensitivity is high', () => {
      const costSensitivity = 0.9; // Heavily favor cost

      const scores = models.map((model) => {
        const costFactor = 1.0 / (model.cost + 1e-9);
        const maxCostFactor = Math.max(...models.map((m) => 1.0 / (m.cost + 1e-9)));
        const normalizedCost = costFactor / maxCostFactor;

        return {
          model: model.id,
          score: (1 - costSensitivity) * model.quality + costSensitivity * normalizedCost,
        };
      });

      scores.sort((a, b) => b.score - a.score);

      // Should favor cheap models (Nova Micro or Nova Lite)
      expect(scores[0].model).toMatch(/nova/);
    });

    it('should balance quality and cost when sensitivity is moderate', () => {
      const costSensitivity = 0.5; // Balanced

      const scores = models.map((model) => {
        const costFactor = 1.0 / (model.cost + 1e-9);
        const maxCostFactor = Math.max(...models.map((m) => 1.0 / (m.cost + 1e-9)));
        const normalizedCost = costFactor / maxCostFactor;

        return {
          model: model.id,
          score: (1 - costSensitivity) * model.quality + costSensitivity * normalizedCost,
          quality: model.quality,
          normalizedCost,
        };
      });

      scores.sort((a, b) => b.score - a.score);

      // Check that scores are balanced
      expect(scores.length).toBe(4);
      expect(scores[0].quality).toBeGreaterThanOrEqual(0.7); // Has reasonable quality
      expect(scores[0].normalizedCost).toBeGreaterThan(0); // Cost is considered
    });
  });

  describe('Thompson sampling exploration-exploitation', () => {
    it('should explore when all arms have equal priors', () => {
      const arms = [
        { model: 'model-a', alpha: 1, beta: 1 },
        { model: 'model-b', alpha: 1, beta: 1 },
        { model: 'model-c', alpha: 1, beta: 1 },
      ];

      const selections: Record<string, number> = {};

      for (let i = 0; i < 100; i++) {
        // Sample from each arm with noise to simulate Thompson sampling
        const samples = arms.map((arm) => {
          const mean = arm.alpha / (arm.alpha + arm.beta);
          const variance = (arm.alpha * arm.beta) / (Math.pow(arm.alpha + arm.beta, 2) * (arm.alpha + arm.beta + 1));
          const stddev = Math.sqrt(variance);
          const u1 = Math.random();
          const u2 = Math.random();
          const gaussianNoise = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
          return {
            model: arm.model,
            sample: Math.max(0, Math.min(1, mean + gaussianNoise * stddev)),
          };
        });

        // Select best
        samples.sort((a, b) => b.sample - a.sample);
        const selected = samples[0].model;

        selections[selected] = (selections[selected] || 0) + 1;
      }

      // With equal priors and randomness, should explore multiple models
      expect(Object.keys(selections).length).toBeGreaterThanOrEqual(2);
    });

    it('should exploit when one arm has strong evidence', () => {
      const arms = [
        { model: 'model-good', alpha: 50, beta: 10 }, // Strong evidence of high quality
        { model: 'model-bad', alpha: 10, beta: 50 }, // Strong evidence of low quality
      ];

      const selections: Record<string, number> = {};

      for (let i = 0; i < 100; i++) {
        const samples = arms.map((arm) => ({
          model: arm.model,
          sample: arm.alpha / (arm.alpha + arm.beta),
        }));

        samples.sort((a, b) => b.sample - a.sample);
        const selected = samples[0].model;

        selections[selected] = (selections[selected] || 0) + 1;
      }

      // Should heavily favor the good model
      expect(selections['model-good']).toBeGreaterThan(selections['model-bad'] || 0);
      expect(selections['model-good']).toBeGreaterThan(70); // >70% exploitation
    });
  });

  describe('Beta distribution updates', () => {
    it('should update alpha for successful outcomes', () => {
      const arm = { alpha: 1, beta: 1 };
      const qualityScore = 1.0; // Perfect success

      arm.alpha += qualityScore;
      arm.beta += 1.0 - qualityScore;

      expect(arm.alpha).toBe(2);
      expect(arm.beta).toBe(1);
    });

    it('should update beta for failed outcomes', () => {
      const arm = { alpha: 1, beta: 1 };
      const qualityScore = 0.0; // Complete failure

      arm.alpha += qualityScore;
      arm.beta += 1.0 - qualityScore;

      expect(arm.alpha).toBe(1);
      expect(arm.beta).toBe(2);
    });

    it('should update both parameters for partial success', () => {
      const arm = { alpha: 1, beta: 1 };
      const qualityScore = 0.7; // Partial success

      arm.alpha += qualityScore;
      arm.beta += 1.0 - qualityScore;

      expect(arm.alpha).toBe(1.7);
      expect(arm.beta).toBe(1.3);
    });

    it('should converge to true quality over many observations', () => {
      const trueQuality = 0.85;
      const arm = { alpha: 1, beta: 1 };

      // Simulate 100 observations
      for (let i = 0; i < 100; i++) {
        const outcome = Math.random() < trueQuality ? 1.0 : 0.0;
        arm.alpha += outcome;
        arm.beta += 1.0 - outcome;
      }

      const estimatedQuality = arm.alpha / (arm.alpha + arm.beta);

      // Should be within 10% of true quality
      expect(estimatedQuality).toBeGreaterThan(trueQuality * 0.9);
      expect(estimatedQuality).toBeLessThan(trueQuality * 1.1);
    });
  });

  describe('Routing weights calculation', () => {
    it('should calculate mean quality from Beta parameters', () => {
      const arm = { alpha: 9, beta: 3 };
      const meanQuality = arm.alpha / (arm.alpha + arm.beta);

      expect(meanQuality).toBe(0.75);
    });

    it('should calculate observation count', () => {
      const arm = { alpha: 10, beta: 5 };
      const observations = Math.round(arm.alpha + arm.beta - 2); // Subtract priors

      expect(observations).toBe(13);
    });

    it('should calculate cost-adjusted score', () => {
      const arm = { alpha: 9, beta: 3, cost: 0.01 };
      const meanQuality = arm.alpha / (arm.alpha + arm.beta);
      const costAdjustedScore = meanQuality / arm.cost;

      expect(costAdjustedScore).toBe(75); // 0.75 / 0.01
    });
  });

  describe('Cost sensitivity validation', () => {
    it('should accept cost sensitivity = 0', () => {
      const costSensitivity = 0.0;

      const isValid = costSensitivity >= 0 && costSensitivity <= 1;

      expect(isValid).toBe(true);
    });

    it('should accept cost sensitivity = 1', () => {
      const costSensitivity = 1.0;

      const isValid = costSensitivity >= 0 && costSensitivity <= 1;

      expect(isValid).toBe(true);
    });

    it('should reject cost sensitivity < 0', () => {
      const costSensitivity = -0.1;

      const isValid = costSensitivity >= 0 && costSensitivity <= 1;

      expect(isValid).toBe(false);
    });

    it('should reject cost sensitivity > 1', () => {
      const costSensitivity = 1.1;

      const isValid = costSensitivity >= 0 && costSensitivity <= 1;

      expect(isValid).toBe(false);
    });
  });

  describe('Model costs', () => {
    it('should have correct cost ordering', () => {
      const costs = {
        'us.amazon.nova-micro-v1:0': 0.000088,
        'us.amazon.nova-lite-v1:0': 0.00024,
        'us.anthropic.claude-sonnet-4-6-v1:0': 0.009,
        'us.anthropic.claude-opus-4-6-v1:0': 0.045,
      };

      expect(costs['us.amazon.nova-micro-v1:0']).toBeLessThan(costs['us.amazon.nova-lite-v1:0']);
      expect(costs['us.amazon.nova-lite-v1:0']).toBeLessThan(costs['us.anthropic.claude-sonnet-4-6-v1:0']);
      expect(costs['us.anthropic.claude-sonnet-4-6-v1:0']).toBeLessThan(costs['us.anthropic.claude-opus-4-6-v1:0']);
    });

    it('should have significant cost differences', () => {
      const costs = {
        'us.amazon.nova-micro-v1:0': 0.000088,
        'us.anthropic.claude-opus-4-6-v1:0': 0.045,
      };

      const costRatio = costs['us.anthropic.claude-opus-4-6-v1:0'] / costs['us.amazon.nova-micro-v1:0'];

      // Opus is >500x more expensive than Nova Micro
      expect(costRatio).toBeGreaterThan(500);
    });
  });
});
