/**
 * Activity Logging Module
 *
 * Structured activity logging with decision capture, Well-Architected Framework alignment,
 * and audit trail generation:
 * - DecisionLogger: Capture agent decision-making with alternatives and justifications
 * - Types: Comprehensive type definitions for activity logging
 */

export {
  DecisionLogger,
  type DecisionLoggerConfig,
  type LogDecisionParams,
  type DynamoDBClient,
} from './decision-logger';

export type {
  // Activity Types
  ActivityType,
  ActivitySeverity,
  BaseActivity,

  // Well-Architected Framework
  WellArchitectedPillar,
  PillarScore,
  WellArchitectedEvaluation,
  PillarWeights,

  // Cost Estimation
  CostEstimate,

  // Decision Logging
  RiskLevel,
  DecisionContext,
  DecisionAlternative,
  DecisionLog,

  // Query and Analysis
  DecisionQueryFilter,
  DecisionQueryResult,
  DecisionAnalytics,

  // Confidence Calculation
  ConfidenceFactors,
  ConfidenceResult,

  // Decision Scoring
  ScoreCalculationInput,
  ScoreCalculationResult,

  // Recommendations
  DecisionRecommendation,

  // Shared Types
  ISOTimestamp,
} from './types';

export {
  BALANCED_WEIGHTS,
  COST_OPTIMIZED_WEIGHTS,
  RELIABILITY_WEIGHTS,
} from './types';
