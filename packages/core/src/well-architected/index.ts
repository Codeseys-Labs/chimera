/**
 * AWS Well-Architected Framework integration for Chimera agents
 *
 * This module provides agent decision-making capabilities using the
 * AWS Well-Architected Framework's six pillars:
 *
 * 1. Operational Excellence — Run and monitor systems effectively
 * 2. Security — Protect data, systems, and assets
 * 3. Reliability — Recover from failures, meet demand
 * 4. Performance Efficiency — Use resources efficiently
 * 5. Cost Optimization — Achieve outcomes at lowest price
 * 6. Sustainability — Minimize environmental impact
 *
 * @example
 * ```typescript
 * import { evaluateChange, presentTradeoffs } from '@chimera/core/well-architected';
 *
 * const change: InfrastructureChange = {
 *   type: 'CAPACITY_INCREASE',
 *   description: 'Scale DynamoDB from 100 to 200 RCU',
 *   affectedResources: ['arn:aws:dynamodb:...'],
 *   costImpact: 50,
 * };
 *
 * const presentation = presentTradeoffs(change);
 * console.log(presentation.presentation); // Formatted markdown
 * ```
 *
 * @see docs/research/aws-account-agent/01-well-architected-framework.md
 */

// Export types
export type {
  WellArchitectedPillar,
  PillarScore,
  ImpactSeverity,
  PillarEvaluation,
  WellArchitectedEvaluation,
  InfrastructureChangeType,
  InfrastructureChange,
  TradeoffPresentation,
  PillarPriorities,
  WellArchitectedQuestion,
  WellArchitectedReview,
} from './types.js';

export { PILLAR_NAMES } from './types.js';

// Export evaluation functions
export {
  evaluateChange,
  evaluateOperationalExcellence,
  evaluateSecurity,
  evaluateReliability,
  evaluatePerformanceEfficiency,
  evaluateCostOptimization,
  evaluateSustainability,
  getPillarsByScore,
  countPillarScores,
} from './pillar-evaluator.js';

// Export presentation functions
export {
  presentTradeoffs,
  createCompactSummary,
  createPillarComparisonTable,
  formatForSlack,
  formatForEmail,
  formatForAPI,
} from './tradeoff-presenter.js';
