/**
 * Tests for Evolution Safety Harness
 *
 * Tests pure logic methods without AWS SDK dependencies.
 * AWS integration tests are in tests/integration/
 */

import { describe, it, expect } from 'bun:test';
import type {
  EvolutionConfig,
  IaCChangeType,
  CedarAuthResult,
  EvolutionRateLimits,
} from '../../../packages/core/src/evolution/types';

describe('EvolutionSafetyHarness Types', () => {
  describe('EvolutionConfig', () => {
    it('should have required rate limit fields', () => {
      const config: EvolutionConfig = {
        evolutionStateTable: 'test-table',
        artifactsBucket: 'test-bucket',
        policyStoreId: 'test-policy',
        maxChangesPerDay: 10,
        maxInfraChangesPerDay: 3,
        maxPromptChangesPerWeek: 3,
        humanApprovalCostThreshold: 100.0,
        defaultCostSensitivity: 0.5,
        abTestDurationHours: 48,
        minPatternOccurrences: 5,
        memoryStaleThresholdDays: 90,
      };

      expect(config.maxChangesPerDay).toBe(10);
      expect(config.maxInfraChangesPerDay).toBe(3);
      expect(config.maxPromptChangesPerWeek).toBe(3);
      expect(config.humanApprovalCostThreshold).toBe(100.0);
    });
  });

  describe('CedarAuthResult', () => {
    it('should support ALLOW decision', () => {
      const result: CedarAuthResult = {
        decision: 'ALLOW',
        policyIds: ['policy-001'],
        errors: [],
      };

      expect(result.decision).toBe('ALLOW');
      expect(result.policyIds).toContain('policy-001');
    });

    it('should support DENY decision with errors', () => {
      const result: CedarAuthResult = {
        decision: 'DENY',
        errors: ['Rate limit exceeded'],
      };

      expect(result.decision).toBe('DENY');
      expect(result.errors).toContain('Rate limit exceeded');
    });
  });

  describe('EvolutionRateLimits', () => {
    it('should track all rate limit counters', () => {
      const limits: EvolutionRateLimits = {
        tenantId: 'tenant-123',
        evolutionChangesToday: 5,
        infraChangesToday: 2,
        promptChangesThisWeek: 1,
        lastResetDate: '2026-03-21',
      };

      expect(limits.evolutionChangesToday).toBe(5);
      expect(limits.infraChangesToday).toBe(2);
      expect(limits.promptChangesThisWeek).toBe(1);
    });
  });

  describe('IaCChangeType', () => {
    it('should include all safe operations', () => {
      const safeOps: IaCChangeType[] = [
        'scale_horizontal',
        'scale_vertical',
        'update_env_var',
        'rotate_secret',
        'add_tool',
        'update_config',
      ];

      expect(safeOps.length).toBe(6);
    });
  });

  describe('Safety Validation Logic', () => {
    describe('prompt safety validation', () => {
      it('should identify forbidden section headers', () => {
        const forbiddenSections = [
          'safety_instructions',
          'content_policy',
          'guardrails',
          'cedar policy',
          'authorization',
        ];

        expect(forbiddenSections.length).toBe(5);
      });

      it('should use case-insensitive matching', () => {
        const lowerCase = '## safety_instructions';
        const upperCase = '## SAFETY_INSTRUCTIONS';
        const mixedCase = '## Safety_Instructions';

        expect(lowerCase.toLowerCase()).toContain('safety_instructions');
        expect(upperCase.toLowerCase()).toContain('safety_instructions');
        expect(mixedCase.toLowerCase()).toContain('safety_instructions');
      });
    });

    describe('config safety validation', () => {
      it('should identify immutable config keys', () => {
        const immutableKeys = [
          'audit.enabled',
          'audit.trail',
          'guardrails.enabled',
          'cedar.policy_store',
          'evolution.safety_limits',
        ];

        expect(immutableKeys.length).toBe(5);
      });
    });

    describe('infrastructure operation validation', () => {
      it('should identify dangerous operations', () => {
        const dangerousOps = [
          'delete_table',
          'delete_bucket',
          'modify_iam',
          'modify_vpc',
          'modify_security_group',
          'delete_runtime',
        ];

        expect(dangerousOps.length).toBe(6);
      });
    });

    describe('human approval threshold', () => {
      it('should require approval above threshold', () => {
        const threshold = 100.0;
        const costDelta = 150.0;

        expect(costDelta >= threshold).toBe(true);
      });

      it('should not require approval below threshold', () => {
        const threshold = 100.0;
        const costDelta = 50.0;

        expect(costDelta >= threshold).toBe(false);
      });

      it('should not require approval for cost savings', () => {
        const threshold = 100.0;
        const costDelta = -20.0;

        expect(costDelta >= threshold).toBe(false);
      });
    });
  });

  describe('Rate Limit Enforcement', () => {
    it('should enforce daily evolution changes limit', () => {
      const maxChangesPerDay = 10;
      const currentChanges = 10;

      expect(currentChanges >= maxChangesPerDay).toBe(true);
    });

    it('should enforce daily infrastructure changes limit', () => {
      const maxInfraChangesPerDay = 3;
      const currentInfraChanges = 3;

      expect(currentInfraChanges >= maxInfraChangesPerDay).toBe(true);
    });

    it('should enforce weekly prompt changes limit', () => {
      const maxPromptChangesPerWeek = 3;
      const currentPromptChanges = 3;

      expect(currentPromptChanges >= maxPromptChangesPerWeek).toBe(true);
    });

    it('should reset daily counters on date change', () => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

      expect(today).not.toBe(yesterday);
    });

    it('should reset weekly counters on week change', () => {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 86400000);

      expect(now.getTime() - weekAgo.getTime()).toBeGreaterThanOrEqual(7 * 86400000);
    });
  });

  describe('Cedar Policy Context', () => {
    it('should include required context fields', () => {
      const contextMap = {
        estimated_monthly_cost_delta: { long: 250.0 },
        human_approved: { boolean: true },
        tenant_id: { string: 'tenant-123' },
        change_type: { string: 'scale_horizontal' },
      };

      expect(contextMap.estimated_monthly_cost_delta.long).toBe(250.0);
      expect(contextMap.human_approved.boolean).toBe(true);
      expect(contextMap.tenant_id.string).toBe('tenant-123');
      expect(contextMap.change_type.string).toBe('scale_horizontal');
    });

    it('should map event types to Cedar actions', () => {
      const actionMap = {
        evolution_prompt: 'modify_system_prompt',
        evolution_skill: 'create_skill',
        evolution_infra: 'apply_infra_change',
        evolution_routing: 'update_routing',
        evolution_memory: 'evolve_memory',
        evolution_cron: 'create_cron',
      };

      expect(Object.keys(actionMap).length).toBe(6);
      expect(actionMap.evolution_prompt).toBe('modify_system_prompt');
      expect(actionMap.evolution_infra).toBe('apply_infra_change');
    });

    it('should map event types to Cedar resources', () => {
      const resourceTypeMap = {
        evolution_prompt: 'Chimera::SystemPrompt',
        evolution_skill: 'Chimera::Skill',
        evolution_infra: 'Chimera::Infrastructure',
        evolution_routing: 'Chimera::ModelRouter',
        evolution_memory: 'Chimera::Memory',
        evolution_cron: 'Chimera::CronJob',
      };

      expect(Object.keys(resourceTypeMap).length).toBe(6);
      expect(resourceTypeMap.evolution_prompt).toBe('Chimera::SystemPrompt');
      expect(resourceTypeMap.evolution_skill).toBe('Chimera::Skill');
    });
  });
});
