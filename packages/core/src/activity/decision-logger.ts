/**
 * Decision Logger
 *
 * Captures agent decision-making process with alternatives, justifications,
 * and AWS Well-Architected Framework alignment.
 *
 * Core capabilities:
 * - Log decisions with full context and alternatives
 * - Calculate confidence scores based on score gaps
 * - Query historical decisions for analysis
 * - Generate decision analytics and insights
 */

import type {
  DecisionLog,
  DecisionAlternative,
  DecisionContext,
  DecisionQueryFilter,
  DecisionQueryResult,
  DecisionAnalytics,
  ConfidenceFactors,
  ConfidenceResult,
  PillarWeights,
  WellArchitectedPillar,
  RiskLevel,
  CostEstimate,
  WellArchitectedEvaluation,
  ISOTimestamp,
} from './types';

/**
 * DynamoDB client interface
 */
export interface DynamoDBClient {
  get(params: any): Promise<any>;
  put(params: any): Promise<any>;
  query(params: any): Promise<any>;
  scan(params: any): Promise<any>;
}

/**
 * Decision logger configuration
 */
export interface DecisionLoggerConfig {
  /** DynamoDB table name for activity logs */
  activityTableName: string;

  /** DynamoDB client */
  dynamodb: DynamoDBClient;

  /** Default pillar weights for scoring */
  defaultWeights?: PillarWeights;

  /** TTL for decision logs (days) */
  ttlDays?: number;
}

/**
 * Parameters for logging a decision
 */
export interface LogDecisionParams {
  tenantId: string;
  agentId: string;
  model: string;
  question: string;
  decisionType: string;
  context: DecisionContext;
  alternatives: DecisionAlternative[];
  selectedOption: string;
  justification: string;
  sessionId?: string;
  traceId?: string;
  tags?: Record<string, string>;
  pillarWeights?: PillarWeights;
}

/**
 * Decision Logger
 *
 * Captures structured decision logs with Well-Architected Framework alignment,
 * cost estimation, and confidence scoring.
 *
 * Usage:
 * ```typescript
 * const logger = new DecisionLogger({ activityTableName: 'chimera-activity-logs', dynamodb });
 *
 * await logger.logDecision({
 *   tenantId: 'tenant-123',
 *   agentId: 'agent-456',
 *   question: 'Which database for session storage?',
 *   alternatives: [dynamodbOption, rdsOption, elasticacheOption],
 *   selectedOption: 'Amazon DynamoDB',
 *   justification: 'Best fit for key-value access pattern...'
 * });
 * ```
 */
export class DecisionLogger {
  private config: DecisionLoggerConfig;
  private defaultWeights: PillarWeights;

  constructor(config: DecisionLoggerConfig) {
    this.config = config;
    this.defaultWeights = config.defaultWeights || {
      operational_excellence: 1.0,
      security: 1.0,
      reliability: 1.0,
      performance_efficiency: 1.0,
      cost_optimization: 1.0,
      sustainability: 1.0,
    };
  }

  /**
   * Generate unique activity ID
   *
   * Format: act-{YYYY-MM-DD}-{shortHash}-{sequence}
   *
   * @returns Activity ID string
   */
  private generateActivityId(): string {
    const date = new Date().toISOString().split('T')[0];
    const hash = Math.random().toString(36).substring(2, 8);
    const seq = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `act-${date}-${hash}-${seq}`;
  }

  /**
   * Calculate TTL timestamp
   *
   * @param days - Number of days until expiration
   * @returns Unix timestamp
   */
  private calculateTTL(days: number = 90): number {
    const now = new Date();
    const expirationDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return Math.floor(expirationDate.getTime() / 1000);
  }

  /**
   * Calculate confidence score for a decision
   *
   * Confidence is based on:
   * - Score gap between winner and runner-up (larger gap = higher confidence)
   * - Number of alternatives considered (more alternatives = more thorough analysis)
   * - Diversity of options (different types = better coverage)
   *
   * @param alternatives - All alternatives that were considered
   * @param selectedOption - The option that was selected
   * @returns Confidence calculation result
   */
  calculateConfidence(alternatives: DecisionAlternative[], selectedOption: string): ConfidenceResult {
    // Sort alternatives by score descending
    const sorted = [...alternatives].sort((a, b) => b.score - a.score);

    const winner = sorted[0];
    const runnerUp = sorted[1] || { score: 0 };

    const scoreGap = winner.score - runnerUp.score;
    const alternativeCount = alternatives.length;

    // Gap confidence: 2+ point gap = 100% confidence from gap alone
    const gapConfidence = Math.min(scoreGap / 2.0, 1.0);

    // Diversity bonus: More alternatives = more thorough analysis
    // 5+ alternatives = 100% bonus, scales linearly
    const diversityBonus = Math.min(alternativeCount / 5.0, 1.0);

    // Quality penalty: If winner score is low (< 7.0), reduce confidence
    const qualityPenalty = winner.score < 7.0 ? (7.0 - winner.score) * 0.1 : 0;

    // Final confidence: average of gap confidence and diversity bonus, minus quality penalty
    const confidence = Math.max(0, Math.min(1, (gapConfidence + diversityBonus) / 2.0 - qualityPenalty));

    return {
      confidence,
      factors: {
        scoreGap,
        alternativeCount,
        diversityScore: diversityBonus,
        costEstimateQuality: 1.0, // Placeholder for future enhancement
      },
      breakdown: {
        gapConfidence,
        diversityBonus,
        qualityPenalty,
      },
    };
  }

  /**
   * Determine risk level based on decision characteristics
   *
   * Risk assessment considers:
   * - Confidence level (low confidence = higher risk)
   * - Cost impact (high cost = higher risk)
   * - Score gap (small gap = higher risk - close call)
   * - Selected option score (low score = higher risk)
   *
   * @param confidence - Decision confidence score
   * @param costEstimate - Cost estimate for selected option
   * @param selectedAlternative - The alternative that was selected
   * @param scoreGap - Gap between winner and runner-up
   * @returns Risk level classification
   */
  private determineRiskLevel(
    confidence: number,
    costEstimate: CostEstimate,
    selectedAlternative: DecisionAlternative,
    scoreGap: number
  ): RiskLevel {
    // Critical risk: Low confidence + high cost OR very low score
    if ((confidence < 0.6 && costEstimate.monthly > 500) || selectedAlternative.score < 5.0) {
      return 'critical';
    }

    // High risk: Low confidence OR high cost OR close call (small gap)
    if (confidence < 0.7 || costEstimate.monthly > 1000 || scoreGap < 1.0) {
      return 'high';
    }

    // Medium risk: Moderate confidence OR moderate cost
    if (confidence < 0.8 || costEstimate.monthly > 200) {
      return 'medium';
    }

    // Low risk: High confidence + reasonable cost + clear winner
    return 'low';
  }

  /**
   * Log a decision with full context and alternatives
   *
   * Captures the agent's reasoning process including:
   * - The question being answered
   * - All alternatives considered (not just the winner)
   * - Well-Architected Framework alignment
   * - Cost estimates
   * - Confidence and risk assessment
   *
   * @param params - Decision logging parameters
   * @returns The logged decision record
   */
  async logDecision(params: LogDecisionParams): Promise<DecisionLog> {
    const {
      tenantId,
      agentId,
      model,
      question,
      decisionType,
      context,
      alternatives,
      selectedOption,
      justification,
      sessionId,
      traceId,
      tags,
      pillarWeights,
    } = params;

    // Validate that selectedOption matches one of the alternatives
    const selectedAlternative = alternatives.find(alt => alt.option === selectedOption);
    if (!selectedAlternative) {
      throw new Error(`Selected option "${selectedOption}" not found in alternatives`);
    }

    // Require at least 2 alternatives for meaningful comparison
    if (alternatives.length < 2) {
      throw new Error('At least 2 alternatives required for decision logging');
    }

    // Calculate confidence
    const confidenceResult = this.calculateConfidence(alternatives, selectedOption);

    // Determine risk level
    const riskLevel = this.determineRiskLevel(
      confidenceResult.confidence,
      selectedAlternative.costEstimate,
      selectedAlternative,
      confidenceResult.factors.scoreGap
    );

    // Generate activity ID
    const activityId = this.generateActivityId();
    const timestamp = new Date().toISOString();

    // Build decision log
    const decisionLog: DecisionLog = {
      activityId,
      activityType: 'decision',
      tenantId,
      agentId,
      sessionId,
      traceId,
      tags,
      timestamp,
      question,
      decisionType,
      context,
      alternatives,
      selectedOption,
      justification,
      confidence: confidenceResult.confidence,
      riskLevel,
      wellArchitectedPillars: selectedAlternative.wellArchitectedPillars,
      costEstimate: selectedAlternative.costEstimate,
      model,
      pillarWeights,
    };

    // Store in DynamoDB
    const ttl = this.calculateTTL(this.config.ttlDays);

    await this.config.dynamodb.put({
      TableName: this.config.activityTableName,
      Item: {
        PK: `TENANT#${tenantId}`,
        SK: `ACTIVITY#${timestamp}#${activityId}`,
        activityType: 'decision',
        activityId,
        tenantId,
        timestamp,
        decisionLog,
        // Searchable fields for filtering
        decisionType,
        selectedOption,
        confidence: confidenceResult.confidence,
        riskLevel,
        monthlyCost: selectedAlternative.costEstimate.monthly,
        // Full-text search field
        searchableText: `${question} ${selectedOption} ${justification} ${alternatives.map(a => a.option).join(' ')}`,
        ttl,
      },
    });

    return decisionLog;
  }

  /**
   * Query decisions with filters
   *
   * @param filter - Query filter parameters
   * @returns Paginated decision query results
   */
  async queryDecisions(filter: DecisionQueryFilter): Promise<DecisionQueryResult> {
    const {
      tenantId,
      startDate,
      endDate,
      decisionTypes,
      minConfidence,
      maxConfidence,
      riskLevels,
      selectedOptions,
      minCost,
      maxCost,
      limit = 50,
      nextToken,
    } = filter;

    // Build key condition expression
    let keyConditionExpression = 'PK = :pk';
    const expressionAttributeValues: Record<string, any> = {
      ':pk': `TENANT#${tenantId}`,
    };

    if (startDate && endDate) {
      keyConditionExpression += ' AND SK BETWEEN :start AND :end';
      expressionAttributeValues[':start'] = `ACTIVITY#${startDate}`;
      expressionAttributeValues[':end'] = `ACTIVITY#${endDate}`;
    } else if (startDate) {
      keyConditionExpression += ' AND SK >= :start';
      expressionAttributeValues[':start'] = `ACTIVITY#${startDate}`;
    }

    // Build filter expression
    const filterExpressions: string[] = ['activityType = :actType'];
    expressionAttributeValues[':actType'] = 'decision';

    if (decisionTypes && decisionTypes.length > 0) {
      filterExpressions.push(`decisionType IN (${decisionTypes.map((_, i) => `:dt${i}`).join(', ')})`);
      decisionTypes.forEach((dt, i) => {
        expressionAttributeValues[`:dt${i}`] = dt;
      });
    }

    if (minConfidence !== undefined) {
      filterExpressions.push('confidence >= :minConf');
      expressionAttributeValues[':minConf'] = minConfidence;
    }

    if (maxConfidence !== undefined) {
      filterExpressions.push('confidence <= :maxConf');
      expressionAttributeValues[':maxConf'] = maxConfidence;
    }

    if (riskLevels && riskLevels.length > 0) {
      filterExpressions.push(`riskLevel IN (${riskLevels.map((_, i) => `:rl${i}`).join(', ')})`);
      riskLevels.forEach((rl, i) => {
        expressionAttributeValues[`:rl${i}`] = rl;
      });
    }

    if (selectedOptions && selectedOptions.length > 0) {
      filterExpressions.push(`selectedOption IN (${selectedOptions.map((_, i) => `:so${i}`).join(', ')})`);
      selectedOptions.forEach((so, i) => {
        expressionAttributeValues[`:so${i}`] = so;
      });
    }

    if (minCost !== undefined) {
      filterExpressions.push('monthlyCost >= :minCost');
      expressionAttributeValues[':minCost'] = minCost;
    }

    if (maxCost !== undefined) {
      filterExpressions.push('monthlyCost <= :maxCost');
      expressionAttributeValues[':maxCost'] = maxCost;
    }

    const filterExpression = filterExpressions.join(' AND ');

    // Execute query
    const params: any = {
      TableName: this.config.activityTableName,
      KeyConditionExpression: keyConditionExpression,
      FilterExpression: filterExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      Limit: limit,
      ScanIndexForward: false, // Most recent first
    };

    if (nextToken) {
      params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString('utf-8'));
    }

    const result = await this.config.dynamodb.query(params);

    return {
      decisions: result.Items.map((item: any) => item.decisionLog),
      nextToken: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : undefined,
      total: result.Items.length,
    };
  }

  /**
   * Get decision by activity ID
   *
   * @param tenantId - Tenant identifier
   * @param activityId - Activity identifier
   * @returns Decision log or null if not found
   */
  async getDecision(tenantId: string, activityId: string): Promise<DecisionLog | null> {
    // Query by activity ID (requires scanning since activityId is not in SK)
    const result = await this.config.dynamodb.query({
      TableName: this.config.activityTableName,
      IndexName: 'activity-id-index', // Assumes GSI on activityId
      KeyConditionExpression: 'activityId = :id',
      FilterExpression: 'tenantId = :tenantId AND activityType = :type',
      ExpressionAttributeValues: {
        ':id': activityId,
        ':tenantId': tenantId,
        ':type': 'decision',
      },
      Limit: 1,
    });

    return result.Items.length > 0 ? result.Items[0].decisionLog : null;
  }

  /**
   * Generate decision analytics for a tenant
   *
   * Aggregates decision patterns over a time period:
   * - Total decisions made
   * - Average confidence levels
   * - Decisions by type and risk level
   * - Top selected options
   * - Cost impact summary
   * - Well-Architected pillar score averages
   *
   * @param tenantId - Tenant identifier
   * @param startDate - Analysis period start
   * @param endDate - Analysis period end
   * @returns Decision analytics summary
   */
  async generateAnalytics(
    tenantId: string,
    startDate: ISOTimestamp,
    endDate: ISOTimestamp
  ): Promise<DecisionAnalytics> {
    // Query all decisions in the period
    const decisions = await this.queryDecisions({
      tenantId,
      startDate,
      endDate,
      limit: 1000, // Process up to 1000 decisions
    });

    const decisionsList = decisions.decisions;
    const totalDecisions = decisionsList.length;

    if (totalDecisions === 0) {
      return {
        tenantId,
        period: `${startDate} to ${endDate}`,
        totalDecisions: 0,
        avgConfidence: 0,
        decisionsByType: {},
        decisionsByRisk: { low: 0, medium: 0, high: 0, critical: 0 },
        topSelectedOptions: [],
        costSummary: {
          totalMonthlyImpact: 0,
          avgCostPerDecision: 0,
          maxCostDecision: 0,
        },
        pillarScoreAverages: {
          operational_excellence: 0,
          security: 0,
          reliability: 0,
          performance_efficiency: 0,
          cost_optimization: 0,
          sustainability: 0,
        },
      };
    }

    // Calculate average confidence
    const avgConfidence = decisionsList.reduce((sum, d) => sum + d.confidence, 0) / totalDecisions;

    // Group by decision type
    const decisionsByType: Record<string, number> = {};
    decisionsList.forEach(d => {
      decisionsByType[d.decisionType] = (decisionsByType[d.decisionType] || 0) + 1;
    });

    // Group by risk level
    const decisionsByRisk: Record<RiskLevel, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    decisionsList.forEach(d => {
      decisionsByRisk[d.riskLevel]++;
    });

    // Top selected options
    const optionCounts: Record<string, { count: number; totalScore: number }> = {};
    decisionsList.forEach(d => {
      if (!optionCounts[d.selectedOption]) {
        optionCounts[d.selectedOption] = { count: 0, totalScore: 0 };
      }
      optionCounts[d.selectedOption].count++;
      const selectedAlt = d.alternatives.find(a => a.option === d.selectedOption);
      if (selectedAlt) {
        optionCounts[d.selectedOption].totalScore += selectedAlt.score;
      }
    });

    const topSelectedOptions = Object.entries(optionCounts)
      .map(([option, { count, totalScore }]) => ({
        option,
        count,
        avgScore: totalScore / count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Cost summary
    const costs = decisionsList.map(d => d.costEstimate.monthly);
    const totalMonthlyImpact = costs.reduce((sum, cost) => sum + cost, 0);
    const avgCostPerDecision = totalMonthlyImpact / totalDecisions;
    const maxCostDecision = Math.max(...costs);

    // Pillar score averages
    const pillarTotals: Record<WellArchitectedPillar, number> = {
      operational_excellence: 0,
      security: 0,
      reliability: 0,
      performance_efficiency: 0,
      cost_optimization: 0,
      sustainability: 0,
    };

    decisionsList.forEach(d => {
      Object.entries(d.wellArchitectedPillars).forEach(([pillar, pillarScore]) => {
        pillarTotals[pillar as WellArchitectedPillar] += pillarScore.score;
      });
    });

    const pillarScoreAverages: Record<WellArchitectedPillar, number> = {
      operational_excellence: pillarTotals.operational_excellence / totalDecisions,
      security: pillarTotals.security / totalDecisions,
      reliability: pillarTotals.reliability / totalDecisions,
      performance_efficiency: pillarTotals.performance_efficiency / totalDecisions,
      cost_optimization: pillarTotals.cost_optimization / totalDecisions,
      sustainability: pillarTotals.sustainability / totalDecisions,
    };

    return {
      tenantId,
      period: `${startDate} to ${endDate}`,
      totalDecisions,
      avgConfidence,
      decisionsByType,
      decisionsByRisk,
      topSelectedOptions,
      costSummary: {
        totalMonthlyImpact,
        avgCostPerDecision,
        maxCostDecision,
      },
      pillarScoreAverages,
    };
  }
}
