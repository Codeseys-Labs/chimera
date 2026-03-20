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
 * const evaluation = await generator.evaluateInfrastructureChange(
 *   'Increase DynamoDB capacity from 100 RCU to 200 RCU'
 * );
 *
 * console.log('Recommendation:', evaluation.recommendation);
 * evaluation.pillars.forEach(p => {
 *   console.log(`${p.pillar}: ${p.score} - ${p.rationale}`);
 * });
 * ```
 *
 * @module well-architected
 */

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
  type PillarScore,
  type PillarEvaluation,
  type InfrastructureEvaluation,
  type GeneratedAnswer,
  type ReviewGenerationResult,
  type ReviewGeneratorConfig,
} from './review-generator';
