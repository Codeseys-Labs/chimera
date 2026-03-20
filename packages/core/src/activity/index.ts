 /**
 * Activity Logging Module
 *
 * Structured activity logging with decision capture, Well-Architected Framework alignment,
 * audit trail generation, and real-time agent activity monitoring:
 * - DecisionLogger: Capture agent decision-making with alternatives and justifications
 * - StatusDashboard: Aggregate view of agent sessions and metrics
 * - Types: Comprehensive type definitions for activity logging
 */

export {
  DecisionLogger,
  type DecisionLoggerConfig,
  type LogDecisionParams,
} from './decision-logger';

export {
  StatusDashboard,
  type StatusDashboardConfig,
  type SessionMetrics,
  type AgentActivitySummary,
  type TenantDashboard,
  type RecentActivityItem,
  type QuerySessionsParams,
  type QuerySessionsResult,
} from './status-dashboard';

export type { DynamoDBClient } from './status-dashboard';

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
