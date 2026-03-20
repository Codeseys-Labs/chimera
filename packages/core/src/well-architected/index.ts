 /**
 * Well-Architected Framework Integration
 *
 * Provides AWS Well-Architected Tool API integration for automated
 * workload reviews, pillar evaluation, and infrastructure trade-off analysis.
 *
 * ## Features
 * - **AWS Well-Architected Tool API** - Create workloads, answer questions, track improvements
 * - **Automated Review Generation** - Introspect infrastructure and generate Well-Architected reviews
 * - **Pillar Evaluation** - Score infrastructure changes against six pillars
 * - **Trade-off Presentation** - Present decisions in Well-Architected terms
 *
 * ## Usage
 *
 * ### Create and Review a Workload
 * ```typescript
 * import { createWellArchitectedToolAPI, createReviewGenerator } from '@chimera/core';
 *
 * const api = createWellArchitectedToolAPI({ region: 'us-west-2' });
 *
 * // Create workload
 * const { workloadId } = await api.createWorkload({
 *   workloadName: 'Chimera Platform',
 *   description: 'Multi-tenant agent platform',
 *   environment: 'PRODUCTION',
 *   accountIds: ['123456789012'],
 *   awsRegions: ['us-west-2'],
 * });
 *
 * // Generate automated review
 * const generator = createReviewGenerator({ api });
 * const result = await generator.generateReview(workloadId);
 *
 * console.log(`Answered ${result.answeredQuestions} questions`);
 * console.log(`High risk issues: ${result.summary.riskCounts.HIGH}`);
 * ```
 *
 * ### Evaluate Infrastructure Changes
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
 * @module well-architected
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

// API client
export {
  WellArchitectedToolAPI,
  createWellArchitectedToolAPI,
  type WellArchitectedToolConfig,
  type CreateWorkloadParams,
  type UpdateAnswerParams,
  type CreateMilestoneParams,
  type RiskLevel,
  type PillarSummary,
  type ReviewSummary,
} from './wa-tool-api';

// Review generator
export {
  ReviewGenerator,
  createReviewGenerator,
  type PillarId,
  type PillarScore as ReviewPillarScore,
  type PillarEvaluation as ReviewPillarEvaluation,
  type InfrastructureEvaluation,
  type GeneratedAnswer,
  type ReviewGenerationResult,
  type ReviewGeneratorConfig,
} from './review-generator';
