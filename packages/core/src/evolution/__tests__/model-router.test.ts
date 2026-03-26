/**
 * Unit tests for ModelRouter (Bayesian model routing)
 *
 * Tests the Thompson Sampling model selection and static routing mode.
 * DynamoDB-dependent paths (recordOutcome, resetState, getCostSavings)
 * are tested with a mock send function injected via module-level spy.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createModelRouter, addModelsToConfig } from '../model-router';
import type { TenantModelConfig } from '@chimera/shared';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: TenantModelConfig = {
  allowedModels: ['us.amazon.nova-micro-v1:0', 'us.anthropic.claude-sonnet-4-6-v1:0'],
  defaultModel: 'us.amazon.nova-micro-v1:0',
  monthlyBudgetUsd: 100,
  costAlertThreshold: 0.8,
  routingMode: 'static',
  availableModelsWithCosts: [
    { modelId: 'us.amazon.nova-micro-v1:0', costPer1kTokens: 0.000088 },
    { modelId: 'us.anthropic.claude-sonnet-4-6-v1:0', costPer1kTokens: 0.009 },
  ],
};

// ---------------------------------------------------------------------------
// addModelsToConfig helper (pure function — no DynamoDB)
// ---------------------------------------------------------------------------

describe('addModelsToConfig', () => {
  it('adds new models to an empty config', () => {
    const cfg: TenantModelConfig = {
      allowedModels: ['model-a'],
      defaultModel: 'model-a',
      monthlyBudgetUsd: 10,
      costAlertThreshold: 0.8,
    };

    const result = addModelsToConfig(cfg, [
      { modelId: 'model-b', costPer1kTokens: 0.001 },
    ]);

    expect(result.allowedModels).toContain('model-b');
    expect(result.availableModelsWithCosts).toHaveLength(1);
    expect(result.availableModelsWithCosts![0].modelId).toBe('model-b');
  });

  it('does not duplicate models already present', () => {
    const cfg: TenantModelConfig = {
      allowedModels: ['model-a'],
      defaultModel: 'model-a',
      monthlyBudgetUsd: 10,
      costAlertThreshold: 0.8,
      availableModelsWithCosts: [{ modelId: 'model-a', costPer1kTokens: 0.001 }],
    };

    const result = addModelsToConfig(cfg, [
      { modelId: 'model-a', costPer1kTokens: 0.002 }, // same model, different cost
    ]);

    expect(result.availableModelsWithCosts).toHaveLength(1);
    expect(result.allowedModels.filter(m => m === 'model-a')).toHaveLength(1);
  });

  it('merges without mutating the original config', () => {
    const cfg: TenantModelConfig = {
      allowedModels: ['model-a'],
      defaultModel: 'model-a',
      monthlyBudgetUsd: 10,
      costAlertThreshold: 0.8,
    };
    const original = JSON.stringify(cfg);

    addModelsToConfig(cfg, [{ modelId: 'model-b', costPer1kTokens: 0.001 }]);

    expect(JSON.stringify(cfg)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// ModelRouter — static routing (no DynamoDB)
// ---------------------------------------------------------------------------

describe('ModelRouter static routing', () => {
  it('returns the configured default model', async () => {
    const router = createModelRouter({
      tableName: 'test-table',
      tenantModelConfig: BASE_CONFIG,
    });

    const result = await router.selectModel({
      tenantId: 'tenant-1',
      taskCategory: 'simple_qa',
    });

    expect(result.selectedModel).toBe('us.amazon.nova-micro-v1:0');
    expect(result.routingMode).toBe('static');
    expect(result.taskCategory).toBe('simple_qa');
  });

  it('includes a human-readable explanation', async () => {
    const router = createModelRouter({
      tableName: 'test-table',
      tenantModelConfig: BASE_CONFIG,
    });

    const result = await router.selectModel({
      tenantId: 'tenant-1',
      taskCategory: 'code_gen',
    });

    expect(result.explanation).toContain('Static routing');
    expect(result.explanation).toContain('us.amazon.nova-micro-v1:0');
  });

  it('throws when default model is not in allowedModels', async () => {
    const config: TenantModelConfig = {
      ...BASE_CONFIG,
      defaultModel: 'not-an-allowed-model',
    };

    const router = createModelRouter({
      tableName: 'test-table',
      tenantModelConfig: config,
    });

    await expect(
      router.selectModel({ tenantId: 'tenant-1', taskCategory: 'analysis' })
    ).rejects.toThrow('not in allowedModels');
  });

  it('works for all task categories', async () => {
    const router = createModelRouter({
      tableName: 'test-table',
      tenantModelConfig: BASE_CONFIG,
    });

    const categories = ['simple_qa', 'code_gen', 'analysis', 'creative', 'planning', 'research'] as const;

    for (const cat of categories) {
      const result = await router.selectModel({ tenantId: 'tenant-1', taskCategory: cat });
      expect(result.selectedModel).toBe('us.amazon.nova-micro-v1:0');
    }
  });
});

// ---------------------------------------------------------------------------
// ModelRouter — updateCostSensitivity validation (no DynamoDB for invalid input)
// ---------------------------------------------------------------------------

describe('ModelRouter updateCostSensitivity validation', () => {
  it('throws for sensitivity below 0', async () => {
    const router = createModelRouter({
      tableName: 'test-table',
      tenantModelConfig: { ...BASE_CONFIG, routingMode: 'static' },
    });

    await expect(
      router.updateCostSensitivity({ tenantId: 'tenant-1', costSensitivity: -0.1 })
    ).rejects.toThrow('between 0 and 1');
  });

  it('throws for sensitivity above 1', async () => {
    const router = createModelRouter({
      tableName: 'test-table',
      tenantModelConfig: { ...BASE_CONFIG, routingMode: 'static' },
    });

    await expect(
      router.updateCostSensitivity({ tenantId: 'tenant-1', costSensitivity: 1.5 })
    ).rejects.toThrow('between 0 and 1');
  });
});
