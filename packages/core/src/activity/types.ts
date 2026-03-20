/**
 * Activity Logging Types
 *
 * Type definitions for AWS Chimera's activity logging system.
 * Captures agent decision-making, action auditing, and Well-Architected Framework alignment.
 */

/**
 * ISO 8601 timestamp string
 */
export type ISOTimestamp = string;

// ============================================================
// Activity Types
// ============================================================

/**
 * Activity categories tracked in the system
 */
export type ActivityType =
  | 'decision'       // Decision logs with alternatives
  | 'action'         // API calls, resource creation
  | 'observation'    // Metrics, log analysis
  | 'error'          // Failures, exceptions
  | 'milestone';     // Significant events (deployment, rollback)

/**
 * Activity severity levels
 */
export type ActivitySeverity =
  | 'info'
  | 'warning'
  | 'error'
  | 'critical';

/**
 * Base activity metadata shared across all activity types
 */
export interface BaseActivity {
  readonly activityId: string;
  readonly tenantId: string;
  readonly timestamp: ISOTimestamp;
  readonly activityType: ActivityType;
  readonly agentId: string;
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly tags?: Record<string, string>;
}

// ============================================================
// AWS Well-Architected Framework Types
// ============================================================

/**
 * AWS Well-Architected Framework pillars
 */
export type WellArchitectedPillar =
  | 'operational_excellence'
  | 'security'
  | 'reliability'
  | 'performance_efficiency'
  | 'cost_optimization'
  | 'sustainability';

/**
 * Pillar evaluation score (0-10 scale)
 */
export interface PillarScore {
  /** Score from 0 (poor) to 10 (excellent) */
  readonly score: number;

  /** Human-readable rationale for the score */
  readonly rationale: string;
}

/**
 * Well-Architected Framework evaluation for a decision or alternative
 */
export interface WellArchitectedEvaluation {
  readonly operational_excellence: PillarScore;
  readonly security: PillarScore;
  readonly reliability: PillarScore;
  readonly performance_efficiency: PillarScore;
  readonly cost_optimization: PillarScore;
  readonly sustainability: PillarScore;
}

/**
 * Pillar weighting for multi-criteria decision analysis
 */
export interface PillarWeights {
  readonly operational_excellence: number;
  readonly security: number;
  readonly reliability: number;
  readonly performance_efficiency: number;
  readonly cost_optimization: number;
  readonly sustainability: number;
}

/**
 * Default balanced weights (all pillars equal importance)
 */
export const BALANCED_WEIGHTS: PillarWeights = {
  operational_excellence: 1.0,
  security: 1.0,
  reliability: 1.0,
  performance_efficiency: 1.0,
  cost_optimization: 1.0,
  sustainability: 1.0,
};

/**
 * Cost-optimized weights (3x emphasis on cost)
 */
export const COST_OPTIMIZED_WEIGHTS: PillarWeights = {
  operational_excellence: 1.0,
  security: 1.5,
  reliability: 1.0,
  performance_efficiency: 1.0,
  cost_optimization: 3.0,
  sustainability: 0.5,
};

/**
 * Reliability-focused weights (3x emphasis on reliability)
 */
export const RELIABILITY_WEIGHTS: PillarWeights = {
  operational_excellence: 1.0,
  security: 2.0,
  reliability: 3.0,
  performance_efficiency: 1.5,
  cost_optimization: 1.0,
  sustainability: 0.5,
};

// ============================================================
// Cost Estimation Types
// ============================================================

/**
 * Cost estimate for a decision alternative
 */
export interface CostEstimate {
  /** One-time upfront cost (USD) */
  readonly immediate: number;

  /** Recurring monthly cost (USD) */
  readonly monthly: number;

  /** Per-transaction or per-unit cost (USD) */
  readonly perTransaction?: number;

  /** Assumptions used in the cost calculation */
  readonly assumptions: string[];

  /** Confidence in the estimate (0.0-1.0) */
  readonly confidence?: number;
}

// ============================================================
// Decision Logging Types
// ============================================================

/**
 * Risk level for a decision
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Decision context and requirements
 */
export interface DecisionContext {
  /** Functional and non-functional requirements */
  readonly requirements: string[];

  /** Business or technical constraints */
  readonly constraints: string[];

  /** Assumptions made during analysis */
  readonly assumptions: string[];

  /** Additional context information */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Alternative option considered during decision-making
 */
export interface DecisionAlternative {
  /** Name or description of the option */
  readonly option: string;

  /** Overall score (0.0-10.0) */
  readonly score: number;

  /** Advantages of this alternative */
  readonly pros: string[];

  /** Disadvantages of this alternative */
  readonly cons: string[];

  /** Cost estimation for this alternative */
  readonly costEstimate: CostEstimate;

  /** Well-Architected pillar evaluation */
  readonly wellArchitectedPillars: WellArchitectedEvaluation;

  /** Risk factors specific to this alternative */
  readonly riskFactors: string[];

  /** Additional metadata */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Complete decision log capturing agent reasoning
 */
export interface DecisionLog extends BaseActivity {
  readonly activityType: 'decision';

  /** The question being answered */
  readonly question: string;

  /** Decision type/category for classification */
  readonly decisionType: string;

  /** Context, requirements, constraints, and assumptions */
  readonly context: DecisionContext;

  /** All alternatives that were considered */
  readonly alternatives: DecisionAlternative[];

  /** The selected option (must match one alternative.option) */
  readonly selectedOption: string;

  /** Detailed justification for the selection */
  readonly justification: string;

  /** Agent's confidence in the decision (0.0-1.0) */
  readonly confidence: number;

  /** Risk level of the decision */
  readonly riskLevel: RiskLevel;

  /** Well-Architected evaluation of the selected option */
  readonly wellArchitectedPillars: WellArchitectedEvaluation;

  /** Cost estimate for the selected option */
  readonly costEstimate: CostEstimate;

  /** Model used to make the decision */
  readonly model: string;

  /** Pillar weights used in scoring */
  readonly pillarWeights?: PillarWeights;
}

// ============================================================
// Query and Analysis Types
// ============================================================

/**
 * Decision query filters
 */
export interface DecisionQueryFilter {
  readonly tenantId: string;
  readonly startDate?: ISOTimestamp;
  readonly endDate?: ISOTimestamp;
  readonly decisionTypes?: string[];
  readonly minConfidence?: number;
  readonly maxConfidence?: number;
  readonly riskLevels?: RiskLevel[];
  readonly selectedOptions?: string[];
  readonly minCost?: number;
  readonly maxCost?: number;
  readonly limit?: number;
  readonly nextToken?: string;
}

/**
 * Decision query result with pagination
 */
export interface DecisionQueryResult {
  readonly decisions: DecisionLog[];
  readonly nextToken?: string;
  readonly total: number;
}

/**
 * Decision analytics aggregation
 */
export interface DecisionAnalytics {
  readonly tenantId: string;
  readonly period: string;
  readonly totalDecisions: number;
  readonly avgConfidence: number;
  readonly decisionsByType: Record<string, number>;
  readonly decisionsByRisk: Record<RiskLevel, number>;
  readonly topSelectedOptions: Array<{
    readonly option: string;
    readonly count: number;
    readonly avgScore: number;
  }>;
  readonly costSummary: {
    readonly totalMonthlyImpact: number;
    readonly avgCostPerDecision: number;
    readonly maxCostDecision: number;
  };
  readonly pillarScoreAverages: Record<WellArchitectedPillar, number>;
}

// ============================================================
// Confidence Calculation Types
// ============================================================

/**
 * Factors that influence decision confidence
 */
export interface ConfidenceFactors {
  /** Score gap between winner and runner-up */
  readonly scoreGap: number;

  /** Number of alternatives considered */
  readonly alternativeCount: number;

  /** Diversity of alternative types */
  readonly diversityScore?: number;

  /** Quality of cost estimates */
  readonly costEstimateQuality?: number;
}

/**
 * Confidence calculation result
 */
export interface ConfidenceResult {
  readonly confidence: number;
  readonly factors: ConfidenceFactors;
  readonly breakdown: {
    readonly gapConfidence: number;
    readonly diversityBonus: number;
    readonly qualityPenalty: number;
  };
}

// ============================================================
// Decision Scoring Types
// ============================================================

/**
 * Weighted score calculation input
 */
export interface ScoreCalculationInput {
  readonly alternative: DecisionAlternative;
  readonly weights: PillarWeights;
}

/**
 * Weighted score calculation result
 */
export interface ScoreCalculationResult {
  readonly totalScore: number;
  readonly weightedPillarScores: Record<WellArchitectedPillar, number>;
  readonly normalizedScore: number;
}

// ============================================================
// Recommendation Types
// ============================================================

/**
 * Decision recommendation from analysis
 */
export interface DecisionRecommendation {
  readonly recommendedOption: string;
  readonly score: number;
  readonly reasoning: string;
  readonly alternativeRanking: Array<{
    readonly option: string;
    readonly score: number;
    readonly rank: number;
  }>;
  readonly warnings: string[];
  readonly tradeoffs: string[];
}
