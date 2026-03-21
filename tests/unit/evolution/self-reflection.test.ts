/**
 * Tests for Self-Reflection Loop
 *
 * Verifies agent's ability to analyze its own evolution metrics,
 * calculate health scores, and make informed decisions about
 * future evolution actions based on past performance.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import type {
  EvolutionMetrics,
  TenantMetrics,
  HealthScoreWeights,
} from '../../../packages/core/src/evolution/types';
import {
  calculateHealthScore,
  analyzeEvolutionTrends,
  generateReflectionInsights,
  shouldThrottleEvolution,
  recommendEvolutionActions,
} from '../../../packages/core/src/evolution/self-reflection';

describe('Self-Reflection Loop', () => {
  describe('calculateHealthScore', () => {
    it('should calculate perfect health score for optimal metrics', () => {
      const metrics: TenantMetrics = {
        thumbsUpRatio: 1.0,
        toolSuccessRate: 1.0,
        baselineCost: 100,
        currentCost: 50,
        correctionRate: 0.0,
        skillUsesPerWeek: 50,
        memoryHitRate: 1.0,
        rollbackRate: 0.0,
      };

      const weights: HealthScoreWeights = {
        responseQuality: 0.25,
        taskCompletion: 0.20,
        costEfficiency: 0.15,
        correctionRateInv: 0.15,
        skillReuse: 0.10,
        memoryHitRate: 0.10,
        rollbackRateInv: 0.05,
      };

      const score = calculateHealthScore(metrics, weights);

      expect(score).toBeGreaterThanOrEqual(95);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('should calculate low health score for poor metrics', () => {
      const metrics: TenantMetrics = {
        thumbsUpRatio: 0.2,
        toolSuccessRate: 0.3,
        baselineCost: 100,
        currentCost: 300,
        correctionRate: 0.8,
        skillUsesPerWeek: 1,
        memoryHitRate: 0.1,
        rollbackRate: 0.5,
      };

      const weights: HealthScoreWeights = {
        responseQuality: 0.25,
        taskCompletion: 0.20,
        costEfficiency: 0.15,
        correctionRateInv: 0.15,
        skillReuse: 0.10,
        memoryHitRate: 0.10,
        rollbackRateInv: 0.05,
      };

      const score = calculateHealthScore(metrics, weights);

      expect(score).toBeLessThan(40);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('should handle zero baseline cost gracefully', () => {
      const metrics: TenantMetrics = {
        thumbsUpRatio: 0.8,
        toolSuccessRate: 0.9,
        baselineCost: 0,
        currentCost: 50,
        correctionRate: 0.1,
        skillUsesPerWeek: 10,
        memoryHitRate: 0.7,
        rollbackRate: 0.05,
      };

      const weights: HealthScoreWeights = {
        responseQuality: 0.25,
        taskCompletion: 0.20,
        costEfficiency: 0.15,
        correctionRateInv: 0.15,
        skillReuse: 0.10,
        memoryHitRate: 0.10,
        rollbackRateInv: 0.05,
      };

      const score = calculateHealthScore(metrics, weights);

      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('should cap health score at 100', () => {
      const metrics: TenantMetrics = {
        thumbsUpRatio: 1.0,
        toolSuccessRate: 1.0,
        baselineCost: 100,
        currentCost: 10, // 90% cost reduction
        correctionRate: 0.0,
        skillUsesPerWeek: 100,
        memoryHitRate: 1.0,
        rollbackRate: 0.0,
      };

      const weights: HealthScoreWeights = {
        responseQuality: 0.25,
        taskCompletion: 0.20,
        costEfficiency: 0.15,
        correctionRateInv: 0.15,
        skillReuse: 0.10,
        memoryHitRate: 0.10,
        rollbackRateInv: 0.05,
      };

      const score = calculateHealthScore(metrics, weights);

      expect(score).toBeLessThanOrEqual(100);
    });

    it('should weight response quality highest', () => {
      const baseMetrics: TenantMetrics = {
        thumbsUpRatio: 0.5,
        toolSuccessRate: 0.5,
        baselineCost: 100,
        currentCost: 100,
        correctionRate: 0.5,
        skillUsesPerWeek: 10,
        memoryHitRate: 0.5,
        rollbackRate: 0.1,
      };

      const weights: HealthScoreWeights = {
        responseQuality: 0.25,
        taskCompletion: 0.20,
        costEfficiency: 0.15,
        correctionRateInv: 0.15,
        skillReuse: 0.10,
        memoryHitRate: 0.10,
        rollbackRateInv: 0.05,
      };

      const scoreBase = calculateHealthScore(baseMetrics, weights);

      // Improve only response quality
      const improvedMetrics = { ...baseMetrics, thumbsUpRatio: 1.0 };
      const scoreImproved = calculateHealthScore(improvedMetrics, weights);

      // Should see significant improvement (25% weight)
      expect(scoreImproved - scoreBase).toBeGreaterThan(10);
    });
  });

  describe('analyzeEvolutionTrends', () => {
    it('should identify improving health trend', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.6,
          taskCompletionRate: 0.7,
          costEfficiency: 0.8,
          correctionRate: 0.3,
          skillReuseRate: 5,
          memoryHitRate: 0.5,
          rollbackRate: 0.2,
          healthScore: 60,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-15',
          responseQuality: 0.7,
          taskCompletionRate: 0.75,
          costEfficiency: 0.85,
          correctionRate: 0.25,
          skillReuseRate: 8,
          memoryHitRate: 0.6,
          rollbackRate: 0.15,
          healthScore: 70,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.1,
          healthScore: 80,
        },
      ];

      const trends = analyzeEvolutionTrends(history);

      expect(trends.healthTrend).toBe('improving');
      expect(trends.healthDelta).toBeGreaterThan(0);
      expect(trends.confidence).toBeGreaterThan(0.4); // 3 days of data = 3/7 confidence
    });

    it('should identify declining health trend', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.1,
          healthScore: 80,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-15',
          responseQuality: 0.7,
          taskCompletionRate: 0.75,
          costEfficiency: 0.85,
          correctionRate: 0.25,
          skillReuseRate: 8,
          memoryHitRate: 0.6,
          rollbackRate: 0.15,
          healthScore: 70,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.6,
          taskCompletionRate: 0.7,
          costEfficiency: 0.8,
          correctionRate: 0.3,
          skillReuseRate: 5,
          memoryHitRate: 0.5,
          rollbackRate: 0.2,
          healthScore: 60,
        },
      ];

      const trends = analyzeEvolutionTrends(history);

      expect(trends.healthTrend).toBe('declining');
      expect(trends.healthDelta).toBeLessThan(0);
    });

    it('should identify stable health trend', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.75,
          taskCompletionRate: 0.8,
          costEfficiency: 0.85,
          correctionRate: 0.2,
          skillReuseRate: 8,
          memoryHitRate: 0.65,
          rollbackRate: 0.1,
          healthScore: 75,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-15',
          responseQuality: 0.76,
          taskCompletionRate: 0.79,
          costEfficiency: 0.86,
          correctionRate: 0.21,
          skillReuseRate: 7,
          memoryHitRate: 0.64,
          rollbackRate: 0.11,
          healthScore: 74,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.74,
          taskCompletionRate: 0.81,
          costEfficiency: 0.84,
          correctionRate: 0.19,
          skillReuseRate: 9,
          memoryHitRate: 0.66,
          rollbackRate: 0.09,
          healthScore: 76,
        },
      ];

      const trends = analyzeEvolutionTrends(history);

      expect(trends.healthTrend).toBe('stable');
      expect(Math.abs(trends.healthDelta)).toBeLessThan(5);
    });

    it('should detect rollback spike patterns', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.05,
          healthScore: 85,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-15',
          responseQuality: 0.75,
          taskCompletionRate: 0.75,
          costEfficiency: 0.85,
          correctionRate: 0.25,
          skillReuseRate: 8,
          memoryHitRate: 0.65,
          rollbackRate: 0.4, // Spike!
          healthScore: 70,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.05,
          healthScore: 85,
        },
      ];

      const trends = analyzeEvolutionTrends(history);

      expect(trends.rollbackSpike).toBe(true);
      expect(trends.rollbackSpikeDate).toBe('2026-03-15');
    });

    it('should return low confidence with insufficient data', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.1,
          healthScore: 80,
        },
      ];

      const trends = analyzeEvolutionTrends(history);

      expect(trends.confidence).toBeLessThan(0.3);
      expect(trends.healthTrend).toBe('stable');
    });
  });

  describe('generateReflectionInsights', () => {
    it('should generate insights from healthy evolution', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.7,
          taskCompletionRate: 0.75,
          costEfficiency: 0.85,
          correctionRate: 0.25,
          skillReuseRate: 8,
          memoryHitRate: 0.6,
          rollbackRate: 0.1,
          healthScore: 75,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-15',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.05,
          healthScore: 85,
        },
      ];

      const insights = generateReflectionInsights(history);

      expect(insights.summary).toContain('improving');
      expect(insights.strengths).toBeDefined();
      expect(insights.strengths.length).toBeGreaterThan(0);
      expect(insights.recommendations).toBeDefined();
    });

    it('should identify weaknesses in declining health', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.1,
          healthScore: 85,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-15',
          responseQuality: 0.6,
          taskCompletionRate: 0.7,
          costEfficiency: 0.8,
          correctionRate: 0.35,
          skillReuseRate: 5,
          memoryHitRate: 0.5,
          rollbackRate: 0.25,
          healthScore: 60,
        },
      ];

      const insights = generateReflectionInsights(history);

      expect(insights.summary).toContain('declining');
      expect(insights.weaknesses).toBeDefined();
      expect(insights.weaknesses.length).toBeGreaterThan(0);
      expect(insights.recommendations.some(r => r.priority === 'high')).toBe(true);
    });

    it('should recommend cost optimization when efficiency drops', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.5, // Poor cost efficiency
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.1,
          healthScore: 70,
        },
      ];

      const insights = generateReflectionInsights(history);

      expect(insights.recommendations.some(r =>
        r.action.toLowerCase().includes('cost') ||
        r.action.toLowerCase().includes('routing')
      )).toBe(true);
    });

    it('should recommend skill generation when reuse is low', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 2, // Low skill reuse
          memoryHitRate: 0.7,
          rollbackRate: 0.1,
          healthScore: 75,
        },
      ];

      const insights = generateReflectionInsights(history);

      expect(insights.recommendations.some(r =>
        r.action.toLowerCase().includes('skill') ||
        r.action.toLowerCase().includes('pattern')
      )).toBe(true);
    });

    it('should recommend memory optimization when hit rate is low', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.3, // Low memory hit rate
          rollbackRate: 0.1,
          healthScore: 75,
        },
      ];

      const insights = generateReflectionInsights(history);

      expect(insights.recommendations.some(r =>
        r.action.toLowerCase().includes('memory')
      )).toBe(true);
    });
  });

  describe('shouldThrottleEvolution', () => {
    it('should not throttle when health is good', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.85,
          taskCompletionRate: 0.85,
          costEfficiency: 0.9,
          correctionRate: 0.15,
          skillReuseRate: 12,
          memoryHitRate: 0.75,
          rollbackRate: 0.05,
          healthScore: 85,
        },
      ];

      const result = shouldThrottleEvolution(history);

      expect(result.shouldThrottle).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it('should throttle when health score is critically low', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.4,
          taskCompletionRate: 0.5,
          costEfficiency: 0.6,
          correctionRate: 0.6,
          skillReuseRate: 2,
          memoryHitRate: 0.3,
          rollbackRate: 0.4,
          healthScore: 35,
        },
      ];

      const result = shouldThrottleEvolution(history);

      expect(result.shouldThrottle).toBe(true);
      expect(result.reason).toContain('health score');
      expect(result.severity).toBe('critical');
    });

    it('should throttle when rollback rate is too high', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.7,
          taskCompletionRate: 0.7,
          costEfficiency: 0.8,
          correctionRate: 0.2,
          skillReuseRate: 8,
          memoryHitRate: 0.6,
          rollbackRate: 0.35, // High rollback rate
          healthScore: 65,
        },
      ];

      const result = shouldThrottleEvolution(history);

      expect(result.shouldThrottle).toBe(true);
      expect(result.reason).toContain('rollback');
      expect(result.severity).toBe('high');
    });

    it('should throttle when health is declining rapidly', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.1,
          healthScore: 80,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-15',
          responseQuality: 0.65,
          taskCompletionRate: 0.7,
          costEfficiency: 0.75,
          correctionRate: 0.35,
          skillReuseRate: 6,
          memoryHitRate: 0.55,
          rollbackRate: 0.2,
          healthScore: 60,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.5,
          taskCompletionRate: 0.6,
          costEfficiency: 0.6,
          correctionRate: 0.5,
          skillReuseRate: 3,
          memoryHitRate: 0.4,
          rollbackRate: 0.3,
          healthScore: 40,
        },
      ];

      const result = shouldThrottleEvolution(history);

      expect(result.shouldThrottle).toBe(true);
      expect(result.reason).toContain('decline'); // Matches "Rapid health decline"
      expect(result.severity).toBe('high');
    });

    it('should provide throttle duration recommendation', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.4,
          taskCompletionRate: 0.5,
          costEfficiency: 0.6,
          correctionRate: 0.6,
          skillReuseRate: 2,
          memoryHitRate: 0.3,
          rollbackRate: 0.4,
          healthScore: 35,
        },
      ];

      const result = shouldThrottleEvolution(history);

      expect(result.throttleDurationHours).toBeDefined();
      expect(result.throttleDurationHours!).toBeGreaterThan(0);
    });
  });

  describe('recommendEvolutionActions', () => {
    it('should recommend prompt optimization for poor response quality', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.4, // Poor quality
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.5,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.1,
          healthScore: 65,
        },
      ];

      const recommendations = recommendEvolutionActions(history);

      expect(recommendations.some(r =>
        r.actionType === 'evolution_prompt'
      )).toBe(true);
    });

    it('should recommend model routing for poor cost efficiency', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.4, // Poor efficiency
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.7,
          rollbackRate: 0.1,
          healthScore: 70,
        },
      ];

      const recommendations = recommendEvolutionActions(history);

      expect(recommendations.some(r =>
        r.actionType === 'evolution_routing'
      )).toBe(true);
    });

    it('should recommend skill generation for low reuse rate', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 2, // Low reuse
          memoryHitRate: 0.7,
          rollbackRate: 0.1,
          healthScore: 75,
        },
      ];

      const recommendations = recommendEvolutionActions(history);

      expect(recommendations.some(r =>
        r.actionType === 'evolution_skill'
      )).toBe(true);
    });

    it('should recommend memory evolution for low hit rate', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.8,
          taskCompletionRate: 0.8,
          costEfficiency: 0.9,
          correctionRate: 0.2,
          skillReuseRate: 10,
          memoryHitRate: 0.3, // Low hit rate
          rollbackRate: 0.1,
          healthScore: 75,
        },
      ];

      const recommendations = recommendEvolutionActions(history);

      expect(recommendations.some(r =>
        r.actionType === 'evolution_memory'
      )).toBe(true);
    });

    it('should prioritize recommendations by impact', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.4, // Worst metric (highest weight)
          taskCompletionRate: 0.5,
          costEfficiency: 0.5,
          correctionRate: 0.5,
          skillReuseRate: 3,
          memoryHitRate: 0.4,
          rollbackRate: 0.2,
          healthScore: 50,
        },
      ];

      const recommendations = recommendEvolutionActions(history);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations[0].priority).toBe('high');
      expect(recommendations[0].actionType).toBe('evolution_prompt');
    });

    it('should not recommend actions when metrics are good', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-16',
          responseQuality: 0.9,
          taskCompletionRate: 0.9,
          costEfficiency: 0.95,
          correctionRate: 0.05,
          skillReuseRate: 20,
          memoryHitRate: 0.85,
          rollbackRate: 0.02,
          healthScore: 95,
        },
      ];

      const recommendations = recommendEvolutionActions(history);

      expect(recommendations.length).toBe(0);
    });

    it('should include confidence scores with recommendations', () => {
      const history: EvolutionMetrics[] = [
        {
          tenantId: 'tenant-123',
          date: '2026-03-14',
          responseQuality: 0.5,
          taskCompletionRate: 0.6,
          costEfficiency: 0.7,
          correctionRate: 0.4,
          skillReuseRate: 4,
          memoryHitRate: 0.5,
          rollbackRate: 0.15,
          healthScore: 55,
        },
        {
          tenantId: 'tenant-123',
          date: '2026-03-15',
          responseQuality: 0.45,
          taskCompletionRate: 0.55,
          costEfficiency: 0.65,
          correctionRate: 0.45,
          skillReuseRate: 3,
          memoryHitRate: 0.45,
          rollbackRate: 0.2,
          healthScore: 50,
        },
      ];

      const recommendations = recommendEvolutionActions(history);

      expect(recommendations.every(r =>
        r.confidence !== undefined &&
        r.confidence >= 0 &&
        r.confidence <= 1
      )).toBe(true);
    });
  });
});
