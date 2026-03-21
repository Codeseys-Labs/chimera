/**
 * Self-Reflection Loop for Evolution Engine
 *
 * Analyzes evolution metrics to provide insights and recommendations
 * for future self-evolution actions. Implements a feedback loop where
 * the agent monitors its own performance and adjusts evolution strategy.
 */

import type {
  EvolutionMetrics,
  TenantMetrics,
  HealthScoreWeights,
  EvolutionEventType,
} from './types';

/**
 * Trend analysis result
 */
export interface TrendAnalysis {
  healthTrend: 'improving' | 'declining' | 'stable';
  healthDelta: number;
  confidence: number;
  rollbackSpike: boolean;
  rollbackSpikeDate?: string;
  problemAreas: string[];
  strengths: string[];
}

/**
 * Reflection insights
 */
export interface ReflectionInsights {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: Array<{
    action: string;
    priority: 'high' | 'medium' | 'low';
    expectedImpact: string;
  }>;
  healthScore: number;
  trend: 'improving' | 'declining' | 'stable';
}

/**
 * Throttle decision
 */
export interface ThrottleDecision {
  shouldThrottle: boolean;
  reason?: string;
  severity?: 'critical' | 'high' | 'medium';
  throttleDurationHours?: number;
}

/**
 * Evolution action recommendation
 */
export interface EvolutionRecommendation {
  actionType: EvolutionEventType;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  rationale: string;
  expectedImpact: {
    healthScoreDelta: number;
    targetMetric: string;
  };
}

/**
 * Default health score weights
 */
const DEFAULT_WEIGHTS: HealthScoreWeights = {
  responseQuality: 0.25,
  taskCompletion: 0.20,
  costEfficiency: 0.15,
  correctionRateInv: 0.15,
  skillReuse: 0.10,
  memoryHitRate: 0.10,
  rollbackRateInv: 0.05,
};

/**
 * Calculate health score from tenant metrics
 *
 * Combines multiple performance metrics into a single 0-100 score.
 * Higher score indicates better overall system health.
 */
export function calculateHealthScore(
  metrics: TenantMetrics,
  weights: HealthScoreWeights = DEFAULT_WEIGHTS
): number {
  // Response quality (0-1) → 0-100
  const qualityScore = metrics.thumbsUpRatio * 100 * weights.responseQuality;

  // Task completion rate (0-1) → 0-100
  const taskScore = metrics.toolSuccessRate * 100 * weights.taskCompletion;

  // Cost efficiency: currentCost / baselineCost (lower is better)
  // Convert to 0-1 score where 0.5 = same cost, 1.0 = 50% reduction, 0 = 2x cost
  let costEfficiencyScore = 0;
  if (metrics.baselineCost > 0) {
    const ratio = metrics.currentCost / metrics.baselineCost;
    costEfficiencyScore = Math.max(0, Math.min(1, 2 - ratio));
  }
  const costScore = costEfficiencyScore * 100 * weights.costEfficiency;

  // Correction rate (0-1, lower is better) → invert to 0-100
  const correctionScore = (1 - metrics.correctionRate) * 100 * weights.correctionRateInv;

  // Skill reuse rate (uses per week) → normalize to 0-100
  // Assume 20+ uses per week = excellent (100), 0 uses = poor (0)
  const skillReuseScore = Math.min(100, (metrics.skillUsesPerWeek / 20) * 100) * weights.skillReuse;

  // Memory hit rate (0-1) → 0-100
  const memoryScore = metrics.memoryHitRate * 100 * weights.memoryHitRate;

  // Rollback rate (0-1, lower is better) → invert to 0-100
  const rollbackScore = (1 - metrics.rollbackRate) * 100 * weights.rollbackRateInv;

  const totalScore = qualityScore + taskScore + costScore + correctionScore +
                     skillReuseScore + memoryScore + rollbackScore;

  return Math.min(100, Math.max(0, totalScore));
}

/**
 * Analyze evolution trends from historical metrics
 *
 * Detects patterns in health scores, rollback rates, and other metrics
 * to identify if evolution is helping or hurting performance.
 */
export function analyzeEvolutionTrends(history: EvolutionMetrics[]): TrendAnalysis {
  if (history.length === 0) {
    return {
      healthTrend: 'stable',
      healthDelta: 0,
      confidence: 0,
      rollbackSpike: false,
      problemAreas: [],
      strengths: [],
    };
  }

  // Sort by date ascending
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));

  // Insufficient data
  if (sorted.length === 1) {
    return {
      healthTrend: 'stable',
      healthDelta: 0,
      confidence: 0.2,
      rollbackSpike: sorted[0].rollbackRate > 0.3,
      rollbackSpikeDate: sorted[0].rollbackRate > 0.3 ? sorted[0].date : undefined,
      problemAreas: identifyProblemAreas(sorted[0]),
      strengths: identifyStrengths(sorted[0]),
    };
  }

  // Calculate health delta (most recent - oldest)
  const healthDelta = sorted[sorted.length - 1].healthScore - sorted[0].healthScore;

  // Determine trend
  let healthTrend: 'improving' | 'declining' | 'stable';
  if (Math.abs(healthDelta) < 5) {
    healthTrend = 'stable';
  } else if (healthDelta > 0) {
    healthTrend = 'improving';
  } else {
    healthTrend = 'declining';
  }

  // Confidence based on data points and consistency
  const confidence = Math.min(1.0, sorted.length / 7); // 7 days = full confidence

  // Detect rollback spikes (> 30% rollback rate)
  let rollbackSpike = false;
  let rollbackSpikeDate: string | undefined;
  for (const metric of sorted) {
    if (metric.rollbackRate > 0.3) {
      rollbackSpike = true;
      rollbackSpikeDate = metric.date;
      break;
    }
  }

  // Identify problem areas and strengths from most recent metrics
  const latest = sorted[sorted.length - 1];
  const problemAreas = identifyProblemAreas(latest);
  const strengths = identifyStrengths(latest);

  return {
    healthTrend,
    healthDelta,
    confidence,
    rollbackSpike,
    rollbackSpikeDate,
    problemAreas,
    strengths,
  };
}

/**
 * Identify problem areas from metrics
 */
function identifyProblemAreas(metrics: EvolutionMetrics): string[] {
  const problems: string[] = [];

  if (metrics.responseQuality < 0.6) {
    problems.push('Low response quality (thumbs up ratio < 60%)');
  }
  if (metrics.taskCompletionRate < 0.7) {
    problems.push('Low task completion rate (< 70%)');
  }
  if (metrics.costEfficiency < 0.7) {
    problems.push('Poor cost efficiency');
  }
  if (metrics.correctionRate > 0.3) {
    problems.push('High correction rate (> 30%)');
  }
  if (metrics.skillReuseRate < 5) {
    problems.push('Low skill reuse (< 5 uses/week)');
  }
  if (metrics.memoryHitRate < 0.5) {
    problems.push('Low memory hit rate (< 50%)');
  }
  if (metrics.rollbackRate > 0.2) {
    problems.push('High rollback rate (> 20%)');
  }

  return problems;
}

/**
 * Identify strengths from metrics
 */
function identifyStrengths(metrics: EvolutionMetrics): string[] {
  const strengths: string[] = [];

  if (metrics.responseQuality >= 0.8) {
    strengths.push('Excellent response quality');
  }
  if (metrics.taskCompletionRate >= 0.85) {
    strengths.push('High task completion rate');
  }
  if (metrics.costEfficiency >= 0.9) {
    strengths.push('Excellent cost efficiency');
  }
  if (metrics.correctionRate <= 0.15) {
    strengths.push('Low correction rate');
  }
  if (metrics.skillReuseRate >= 15) {
    strengths.push('High skill reuse');
  }
  if (metrics.memoryHitRate >= 0.75) {
    strengths.push('Strong memory utilization');
  }
  if (metrics.rollbackRate <= 0.1) {
    strengths.push('Low rollback rate');
  }

  return strengths;
}

/**
 * Generate reflection insights from evolution history
 *
 * Provides human-readable summary of system performance and
 * actionable recommendations for improvement.
 */
export function generateReflectionInsights(history: EvolutionMetrics[]): ReflectionInsights {
  if (history.length === 0) {
    return {
      summary: 'No evolution metrics available for analysis.',
      strengths: [],
      weaknesses: [],
      recommendations: [],
      healthScore: 0,
      trend: 'stable',
    };
  }

  const trends = analyzeEvolutionTrends(history);
  const latest = history[history.length - 1];

  // Generate summary
  let summary = `System health is ${trends.healthTrend}`;
  if (trends.healthTrend !== 'stable') {
    summary += ` (${trends.healthDelta > 0 ? '+' : ''}${trends.healthDelta.toFixed(1)} points)`;
  }
  summary += `. Current health score: ${latest.healthScore.toFixed(1)}/100.`;

  if (trends.rollbackSpike) {
    summary += ` Warning: Rollback spike detected on ${trends.rollbackSpikeDate}.`;
  }

  // Generate recommendations
  const recommendations: Array<{
    action: string;
    priority: 'high' | 'medium' | 'low';
    expectedImpact: string;
  }> = [];

  if (latest.responseQuality < 0.7) {
    recommendations.push({
      action: 'Run prompt A/B test to improve response quality',
      priority: 'high',
      expectedImpact: 'Improve thumbs up ratio by 10-20%',
    });
  }

  if (latest.costEfficiency < 0.7) {
    recommendations.push({
      action: 'Optimize model routing to reduce costs',
      priority: 'high',
      expectedImpact: 'Reduce costs by 15-30% while maintaining quality',
    });
  }

  if (latest.skillReuseRate < 5) {
    recommendations.push({
      action: 'Generate skills from repetitive patterns',
      priority: 'medium',
      expectedImpact: 'Increase automation and reduce latency',
    });
  }

  if (latest.memoryHitRate < 0.5) {
    recommendations.push({
      action: 'Evolve memory strategy (prune stale, promote valuable)',
      priority: 'medium',
      expectedImpact: 'Improve context relevance by 20-30%',
    });
  }

  if (latest.rollbackRate > 0.2) {
    recommendations.push({
      action: 'Pause evolution and investigate rollback causes',
      priority: 'high',
      expectedImpact: 'Reduce system instability',
    });
  }

  if (latest.correctionRate > 0.3) {
    recommendations.push({
      action: 'Analyze correction patterns and update prompts',
      priority: 'medium',
      expectedImpact: 'Reduce user corrections by 10-15%',
    });
  }

  return {
    summary,
    strengths: trends.strengths,
    weaknesses: trends.problemAreas,
    recommendations,
    healthScore: latest.healthScore,
    trend: trends.healthTrend,
  };
}

/**
 * Determine if evolution should be throttled based on metrics
 *
 * Implements safety circuit breaker: if system health is declining
 * or rollback rate is high, pause evolution temporarily.
 */
export function shouldThrottleEvolution(history: EvolutionMetrics[]): ThrottleDecision {
  if (history.length === 0) {
    return { shouldThrottle: false };
  }

  const latest = history[history.length - 1];
  const trends = analyzeEvolutionTrends(history);

  // Critical: Health score below 40
  if (latest.healthScore < 40) {
    return {
      shouldThrottle: true,
      reason: 'Critical health score below 40/100',
      severity: 'critical',
      throttleDurationHours: 72, // 3 days
    };
  }

  // High: Rollback rate above 30%
  if (latest.rollbackRate > 0.3) {
    return {
      shouldThrottle: true,
      reason: 'High rollback rate (> 30%)',
      severity: 'high',
      throttleDurationHours: 48, // 2 days
    };
  }

  // High: Rapid decline in health
  if (trends.healthTrend === 'declining' && trends.healthDelta < -20 && history.length >= 3) {
    return {
      shouldThrottle: true,
      reason: 'Rapid health decline detected (> 20 points)',
      severity: 'high',
      throttleDurationHours: 48, // 2 days
    };
  }

  // Medium: Health score below 60 with declining trend
  if (latest.healthScore < 60 && trends.healthTrend === 'declining') {
    return {
      shouldThrottle: true,
      reason: 'Low health score (< 60) with declining trend',
      severity: 'medium',
      throttleDurationHours: 24, // 1 day
    };
  }

  return { shouldThrottle: false };
}

/**
 * Recommend specific evolution actions based on metrics
 *
 * Analyzes which evolution subsystems should be activated to
 * improve weak areas. Prioritizes by potential impact.
 */
export function recommendEvolutionActions(history: EvolutionMetrics[]): EvolutionRecommendation[] {
  if (history.length === 0) {
    return [];
  }

  const latest = history[history.length - 1];
  const trends = analyzeEvolutionTrends(history);
  const recommendations: EvolutionRecommendation[] = [];

  // Response quality issues → Prompt optimization
  if (latest.responseQuality < 0.7) {
    const severity = latest.responseQuality < 0.5 ? 'high' : 'medium';
    recommendations.push({
      actionType: 'evolution_prompt',
      priority: severity,
      confidence: trends.confidence,
      rationale: `Low response quality (${(latest.responseQuality * 100).toFixed(1)}%). A/B test new prompts.`,
      expectedImpact: {
        healthScoreDelta: 8,
        targetMetric: 'responseQuality',
      },
    });
  }

  // Cost efficiency issues → Model routing optimization
  if (latest.costEfficiency < 0.7) {
    const severity = latest.costEfficiency < 0.5 ? 'high' : 'medium';
    recommendations.push({
      actionType: 'evolution_routing',
      priority: severity,
      confidence: trends.confidence,
      rationale: `Poor cost efficiency (${(latest.costEfficiency * 100).toFixed(1)}%). Optimize model routing.`,
      expectedImpact: {
        healthScoreDelta: 6,
        targetMetric: 'costEfficiency',
      },
    });
  }

  // Low skill reuse → Auto-skill generation
  if (latest.skillReuseRate < 5) {
    recommendations.push({
      actionType: 'evolution_skill',
      priority: 'medium',
      confidence: trends.confidence * 0.8, // Lower confidence for pattern detection
      rationale: `Low skill reuse (${latest.skillReuseRate} uses/week). Generate skills from patterns.`,
      expectedImpact: {
        healthScoreDelta: 4,
        targetMetric: 'skillReuseRate',
      },
    });
  }

  // Low memory hit rate → Memory evolution
  if (latest.memoryHitRate < 0.5) {
    recommendations.push({
      actionType: 'evolution_memory',
      priority: 'medium',
      confidence: trends.confidence,
      rationale: `Low memory hit rate (${(latest.memoryHitRate * 100).toFixed(1)}%). Evolve memory strategy.`,
      expectedImpact: {
        healthScoreDelta: 5,
        targetMetric: 'memoryHitRate',
      },
    });
  }

  // Sort by expected impact (descending)
  recommendations.sort((a, b) => b.expectedImpact.healthScoreDelta - a.expectedImpact.healthScoreDelta);

  return recommendations;
}
