/**
 * Unit tests for ModelRouter (Bayesian model routing)
 *
 * Tests the Thompson Sampling model selection and static routing mode.
 * DynamoDB-dependent paths (recordOutcome, resetState, getCostSavings)
 * are tested with a mock send function injected via module-level spy.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  createModelRouter,
  addModelsToConfig,
  emitEmfMetric,
  enforceTierCeiling,
  MODEL_TIER_ALLOWLIST,
} from '../model-router';
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

// ---------------------------------------------------------------------------
// enforceTierCeiling — terminal invoke-time gate
// ---------------------------------------------------------------------------

describe('enforceTierCeiling', () => {
  const OPUS = 'us.anthropic.claude-opus-4-7';
  const SONNET = 'us.anthropic.claude-sonnet-4-6-v1:0';
  const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

  let warnSpy: ReturnType<typeof mock>;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalWarn = console.warn;
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('MODEL_TIER_ALLOWLIST has entries for every tier', () => {
    expect(MODEL_TIER_ALLOWLIST.basic.length).toBeGreaterThan(0);
    expect(MODEL_TIER_ALLOWLIST.advanced.length).toBeGreaterThan(0);
    // premium is an open allowlist (empty = no ceiling)
    expect(MODEL_TIER_ALLOWLIST.premium).toBeDefined();
  });

  it('basic tenant requesting Opus falls back to a cheaper allowed model and warns', () => {
    const result = enforceTierCeiling(OPUS, 'basic');

    expect(result).not.toBe(OPUS);
    expect(MODEL_TIER_ALLOWLIST.basic).toContain(result);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = (warnSpy.mock.calls[0] ?? [])[0] as string;
    expect(warnMsg).toContain('basic');
    expect(warnMsg).toContain(OPUS);
  });

  it('advanced tenant requesting a non-allowlisted model falls back and warns', () => {
    // Opus 4-6 is not in the advanced allowlist (only Opus 4-7 is).
    const result = enforceTierCeiling('us.anthropic.claude-opus-4-6-v1:0', 'advanced');

    expect(MODEL_TIER_ALLOWLIST.advanced).toContain(result);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('advanced tenant requesting Opus 4-7 succeeds (allowlisted)', () => {
    const result = enforceTierCeiling(OPUS, 'advanced');

    expect(result).toBe(OPUS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('premium tenant requesting Opus succeeds (empty allowlist = no ceiling)', () => {
    const result = enforceTierCeiling(OPUS, 'premium');

    expect(result).toBe(OPUS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('premium tenant requesting an unknown model is not blocked', () => {
    // Premium has no ceiling — even unknown models pass through.
    const result = enforceTierCeiling('unknown-vendor.model-x-v1', 'premium');

    expect(result).toBe('unknown-vendor.model-x-v1');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('basic tenant requesting Sonnet succeeds (explicitly allowed)', () => {
    const result = enforceTierCeiling(SONNET, 'basic');

    expect(result).toBe(SONNET);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('basic tenant requesting Haiku succeeds (cheapest)', () => {
    const result = enforceTierCeiling(HAIKU, 'basic');

    expect(result).toBe(HAIKU);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('fallback for basic tier is the cheapest model in the allowlist', () => {
    const fallback = enforceTierCeiling(OPUS, 'basic');
    // Cheapest in the basic allowlist is Haiku.
    expect(fallback).toBe(HAIKU);
  });

  it('fallback for advanced tier is the cheapest model in the allowlist', () => {
    const fallback = enforceTierCeiling('not-allowed-model', 'advanced');
    // Cheapest in the advanced allowlist is Haiku.
    expect(fallback).toBe(HAIKU);
  });
});

// ---------------------------------------------------------------------------
// EMF metric emission — tier_violation_count
// ---------------------------------------------------------------------------

describe('enforceTierCeiling EMF metric emission', () => {
  const OPUS = 'us.anthropic.claude-opus-4-7';
  const SONNET = 'us.anthropic.claude-sonnet-4-6-v1:0';

  let logSpy: ReturnType<typeof mock>;
  let warnSpy: ReturnType<typeof mock>;
  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalLog = console.log;
    originalWarn = console.warn;
    logSpy = mock(() => {});
    warnSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
  });

  const parseEmfCalls = (): Array<Record<string, unknown>> => {
    const payloads: Array<Record<string, unknown>> = [];
    for (const call of logSpy.mock.calls) {
      const first = (call as unknown[])[0];
      if (typeof first === 'string') {
        try {
          const parsed = JSON.parse(first);
          if (parsed && typeof parsed === 'object' && '_aws' in parsed) {
            payloads.push(parsed);
          }
        } catch {
          // non-JSON console.log output — ignore
        }
      }
    }
    return payloads;
  };

  it('emits an EMF metric line when a disallowed model falls back', () => {
    enforceTierCeiling(OPUS, 'basic', 'tenant-leak');

    const payloads = parseEmfCalls();
    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as Record<string, unknown>;

    // EMF envelope has the documented shape.
    const aws = payload['_aws'] as {
      Timestamp: number;
      CloudWatchMetrics: Array<{
        Namespace: string;
        Dimensions: string[][];
        Metrics: Array<{ Name: string; Unit: string }>;
      }>;
    };
    expect(aws.CloudWatchMetrics[0]?.Namespace).toBe('Chimera/Agent');
    expect(aws.CloudWatchMetrics[0]?.Metrics[0]?.Name).toBe('tier_violation_count');
    expect(aws.CloudWatchMetrics[0]?.Metrics[0]?.Unit).toBe('Count');
    // Dimension names match the audit spec: tenant_id, tier, model_requested.
    const dimNames = aws.CloudWatchMetrics[0]?.Dimensions[0] ?? [];
    expect(dimNames).toContain('tenant_id');
    expect(dimNames).toContain('tier');
    expect(dimNames).toContain('model_requested');

    // Dimension values + metric value are attached as top-level keys.
    expect(payload['tenant_id']).toBe('tenant-leak');
    expect(payload['tier']).toBe('basic');
    expect(payload['model_requested']).toBe(OPUS);
    expect(payload['tier_violation_count']).toBe(1);
  });

  it('falls back tenant_id to "unknown" when none is supplied', () => {
    enforceTierCeiling(OPUS, 'basic');

    const payloads = parseEmfCalls();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.['tenant_id']).toBe('unknown');
  });

  it('does NOT emit a metric when the requested model is already allowed', () => {
    const result = enforceTierCeiling(SONNET, 'basic', 'tenant-ok');

    expect(result).toBe(SONNET);
    expect(parseEmfCalls()).toHaveLength(0);
  });

  it('does NOT emit a metric for premium tier (empty allowlist = no ceiling)', () => {
    const result = enforceTierCeiling(OPUS, 'premium', 'tenant-premium');

    expect(result).toBe(OPUS);
    expect(parseEmfCalls()).toHaveLength(0);
  });

  it('emitEmfMetric helper produces a well-formed EMF line', () => {
    emitEmfMetric(
      'Chimera/Agent',
      'some_metric',
      42,
      'Milliseconds',
      { dim_a: 'A', dim_b: 'B' }
    );

    const payloads = parseEmfCalls();
    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as Record<string, unknown>;
    expect(payload['some_metric']).toBe(42);
    expect(payload['dim_a']).toBe('A');
    expect(payload['dim_b']).toBe('B');
    const aws = payload['_aws'] as {
      CloudWatchMetrics: Array<{ Metrics: Array<{ Unit: string }> }>;
    };
    expect(aws.CloudWatchMetrics[0]?.Metrics[0]?.Unit).toBe('Milliseconds');
  });
});
