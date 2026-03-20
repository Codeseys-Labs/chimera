/**
 * AWS Well-Architected Framework types for agent decision-making
 *
 * This module provides types for evaluating infrastructure decisions against
 * the six pillars of the AWS Well-Architected Framework:
 * 1. Operational Excellence
 * 2. Security
 * 3. Reliability
 * 4. Performance Efficiency
 * 5. Cost Optimization
 * 6. Sustainability
 *
 * Agents use these types to:
 * - Evaluate infrastructure changes before proposing them
 * - Present trade-offs to users in Well-Architected terms
 * - Generate automated Well-Architected reviews
 * - Track architectural quality over time
 *
 * @see docs/research/aws-account-agent/01-well-architected-framework.md
 */

/**
 * The six pillars of the AWS Well-Architected Framework
 */
export type WellArchitectedPillar =
  | 'operational_excellence'
  | 'security'
  | 'reliability'
  | 'performance_efficiency'
  | 'cost_optimization'
  | 'sustainability';

/**
 * Human-readable names for each pillar
 */
export const PILLAR_NAMES: Record<WellArchitectedPillar, string> = {
  operational_excellence: 'Operational Excellence',
  security: 'Security',
  reliability: 'Reliability',
  performance_efficiency: 'Performance Efficiency',
  cost_optimization: 'Cost Optimization',
  sustainability: 'Sustainability',
};

/**
 * Score indicating impact of a decision on a specific pillar
 */
export type PillarScore =
  | 'POSITIVE' // Decision improves this pillar (✅)
  | 'NEUTRAL' // No significant impact on this pillar (✔️)
  | 'NEGATIVE'; // Decision degrades this pillar (⚠️/❌)

/**
 * Severity of a negative pillar impact
 */
export type ImpactSeverity =
  | 'MINOR' // Small trade-off, acceptable (⚠️)
  | 'MODERATE' // Noticeable trade-off, requires consideration (⚠️)
  | 'MAJOR'; // Significant trade-off, may block decision (❌)

/**
 * Evaluation of a decision against a single pillar
 */
export interface PillarEvaluation {
  /**
   * Which pillar this evaluation is for
   */
  pillar: WellArchitectedPillar;

  /**
   * Impact score: POSITIVE, NEUTRAL, or NEGATIVE
   */
  score: PillarScore;

  /**
   * For NEGATIVE scores, how severe is the impact?
   */
  severity?: ImpactSeverity;

  /**
   * Human-readable explanation of why this score was assigned
   * Example: "Eliminates 15% throttling rate, improving availability"
   */
  rationale: string;

  /**
   * Optional: Specific metrics or evidence supporting this evaluation
   * Example: { "current_throttling": "15%", "projected_throttling": "0%" }
   */
  metrics?: Record<string, string | number>;

  /**
   * Optional: Recommendations to improve this pillar score
   * Example: ["Enable auto-scaling instead of fixed capacity"]
   */
  recommendations?: string[];
}

/**
 * Complete Well-Architected evaluation of an infrastructure decision
 */
export interface WellArchitectedEvaluation {
  /**
   * Evaluation for each of the six pillars
   */
  pillars: {
    operational_excellence: PillarEvaluation;
    security: PillarEvaluation;
    reliability: PillarEvaluation;
    performance_efficiency: PillarEvaluation;
    cost_optimization: PillarEvaluation;
    sustainability: PillarEvaluation;
  };

  /**
   * Overall recommendation based on pillar scores
   */
  recommendation: 'APPROVE' | 'APPROVE_WITH_CAUTION' | 'REJECT';

  /**
   * Summary of the decision being evaluated
   */
  summary: string;

  /**
   * Timestamp when evaluation was performed
   */
  evaluatedAt: string; // ISO 8601 timestamp
}

/**
 * Infrastructure change types that can be evaluated
 */
export type InfrastructureChangeType =
  | 'CAPACITY_INCREASE' // Scale up resources (DynamoDB RCU/WCU, Lambda concurrency)
  | 'CAPACITY_DECREASE' // Scale down resources
  | 'NEW_RESOURCE' // Add new AWS resource
  | 'DELETE_RESOURCE' // Remove AWS resource
  | 'CONFIGURATION_CHANGE' // Modify resource configuration
  | 'POLICY_CHANGE' // Update IAM/Cedar policies
  | 'SECURITY_UPDATE' // Apply security patches or updates
  | 'COST_OPTIMIZATION' // Changes primarily for cost reduction
  | 'PERFORMANCE_OPTIMIZATION' // Changes primarily for performance
  | 'RELIABILITY_IMPROVEMENT'; // Changes primarily for reliability

/**
 * Metadata about an infrastructure change being evaluated
 */
export interface InfrastructureChange {
  /**
   * Type of change being proposed
   */
  type: InfrastructureChangeType;

  /**
   * Brief description of the change
   * Example: "Increase DynamoDB chimera-sessions from 100 RCU to 200 RCU"
   */
  description: string;

  /**
   * AWS resource(s) affected by this change
   * Example: ["arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions"]
   */
  affectedResources: string[];

  /**
   * Optional: Current state before change
   * Example: { "capacity": "100 RCU", "throttling_rate": "15%" }
   */
  currentState?: Record<string, unknown>;

  /**
   * Optional: Desired state after change
   * Example: { "capacity": "200 RCU", "throttling_rate": "0%" }
   */
  desiredState?: Record<string, unknown>;

  /**
   * Optional: Estimated monthly cost impact (USD)
   * Positive = cost increase, Negative = cost savings
   */
  costImpact?: number;

  /**
   * Optional: Which tenant tier(s) are impacted
   */
  impactedTiers?: ('basic' | 'pro' | 'enterprise')[];

  /**
   * Optional: Agent proposing this change
   */
  proposedBy?: string;
}

/**
 * Well-Architected trade-off presentation for user consumption
 */
export interface TradeoffPresentation {
  /**
   * The change being evaluated
   */
  change: InfrastructureChange;

  /**
   * Complete Well-Architected evaluation
   */
  evaluation: WellArchitectedEvaluation;

  /**
   * Formatted text presentation for user display (supports markdown)
   */
  presentation: string;

  /**
   * Structured list of benefits (POSITIVE pillars)
   */
  benefits: Array<{
    pillar: WellArchitectedPillar;
    pillarName: string;
    description: string;
  }>;

  /**
   * Structured list of trade-offs (NEGATIVE pillars)
   */
  tradeoffs: Array<{
    pillar: WellArchitectedPillar;
    pillarName: string;
    severity: ImpactSeverity;
    description: string;
  }>;

  /**
   * Agent's final recommendation with reasoning
   */
  recommendation: {
    decision: 'APPROVE' | 'APPROVE_WITH_CAUTION' | 'REJECT';
    reasoning: string;
  };
}

/**
 * User preference for pillar prioritization
 * Used when users want to override agent decisions based on their priorities
 */
export interface PillarPriorities {
  /**
   * Weight for each pillar (1-10 scale)
   * Higher weight = more important for this workload
   * Default: all pillars weighted equally at 5
   */
  weights: {
    operational_excellence: number;
    security: number;
    reliability: number;
    performance_efficiency: number;
    cost_optimization: number;
    sustainability: number;
  };

  /**
   * Optional: User notes explaining priority choices
   * Example: "Cost is priority #1 for this dev environment"
   */
  notes?: string;
}

/**
 * Well-Architected question and answer structure
 * Used for automated Well-Architected Tool reviews
 */
export interface WellArchitectedQuestion {
  /**
   * Question ID (e.g., "sec-1", "rel-4")
   */
  questionId: string;

  /**
   * Which pillar this question belongs to
   */
  pillar: WellArchitectedPillar;

  /**
   * The question text
   * Example: "How do you securely operate your workload?"
   */
  question: string;

  /**
   * Possible answer choices
   */
  choices: Array<{
    choiceId: string;
    title: string;
    description: string;
  }>;

  /**
   * Selected answer choice IDs
   */
  selectedChoices?: string[];

  /**
   * Optional notes about the answer
   */
  notes?: string;

  /**
   * Risk level based on answer
   */
  risk?: 'NONE' | 'MEDIUM' | 'HIGH';
}

/**
 * Complete Well-Architected review results
 */
export interface WellArchitectedReview {
  /**
   * AWS Well-Architected Tool workload ID
   */
  workloadId: string;

  /**
   * Workload name
   * Example: "Chimera Multi-Tenant Agent Platform"
   */
  workloadName: string;

  /**
   * When this review was conducted
   */
  reviewDate: string; // ISO 8601 timestamp

  /**
   * All questions answered (should be 58 for standard lens)
   */
  questions: WellArchitectedQuestion[];

  /**
   * Summary of risk counts
   */
  riskSummary: {
    high: number;
    medium: number;
    none: number;
  };

  /**
   * Prioritized improvement plan
   */
  improvementPlan: Array<{
    priority: number;
    pillar: WellArchitectedPillar;
    issue: string;
    recommendation: string;
    estimatedEffort: 'LOW' | 'MEDIUM' | 'HIGH';
  }>;

  /**
   * Optional: Milestone snapshot
   */
  milestoneId?: string;
}
