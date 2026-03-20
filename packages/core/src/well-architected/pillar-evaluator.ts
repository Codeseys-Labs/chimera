/**
 * AWS Well-Architected Framework pillar evaluation engine
 *
 * This module evaluates infrastructure changes against the six pillars
 * of the AWS Well-Architected Framework. Agents use this to make informed
 * decisions and present trade-offs transparently to users.
 *
 * Each pillar has evaluation logic that considers:
 * - Change type and scope
 * - Current vs. desired state
 * - Cost impact
 * - Resource characteristics
 * - Tenant impact
 *
 * @see docs/research/aws-account-agent/01-well-architected-framework.md
 */

import type {
  InfrastructureChange,
  InfrastructureChangeType,
  PillarEvaluation,
  PillarScore,
  WellArchitectedEvaluation,
  WellArchitectedPillar,
  ImpactSeverity,
} from './types.js';

/**
 * Evaluate an infrastructure change against all six Well-Architected pillars
 *
 * @param change - The infrastructure change to evaluate
 * @returns Complete Well-Architected evaluation with scores and recommendations
 *
 * @example
 * ```typescript
 * const change: InfrastructureChange = {
 *   type: 'CAPACITY_INCREASE',
 *   description: 'Increase DynamoDB from 100 RCU to 200 RCU',
 *   affectedResources: ['arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions'],
 *   currentState: { capacity: 100, throttlingRate: 0.15 },
 *   desiredState: { capacity: 200, throttlingRate: 0 },
 *   costImpact: 50, // +$50/month
 * };
 *
 * const evaluation = evaluateChange(change);
 * // evaluation.pillars.reliability.score === 'POSITIVE'
 * // evaluation.pillars.cost_optimization.score === 'NEGATIVE'
 * ```
 */
export function evaluateChange(change: InfrastructureChange): WellArchitectedEvaluation {
  const pillars = {
    operational_excellence: evaluateOperationalExcellence(change),
    security: evaluateSecurity(change),
    reliability: evaluateReliability(change),
    performance_efficiency: evaluatePerformanceEfficiency(change),
    cost_optimization: evaluateCostOptimization(change),
    sustainability: evaluateSustainability(change),
  };

  // Determine overall recommendation based on pillar scores
  const recommendation = determineRecommendation(pillars);

  return {
    pillars,
    recommendation,
    summary: change.description,
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * Evaluate Operational Excellence pillar
 *
 * Focuses on:
 * - Operations as code (IaC, automation)
 * - Observability and monitoring
 * - Incident response capability
 * - Operational burden reduction
 */
export function evaluateOperationalExcellence(
  change: InfrastructureChange
): PillarEvaluation {
  const pillar: WellArchitectedPillar = 'operational_excellence';

  // Automated changes are better than manual ones
  if (change.type === 'POLICY_CHANGE' || change.type === 'CONFIGURATION_CHANGE') {
    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Automated configuration changes reduce manual operational burden',
    };
  }

  // Capacity increases that prevent alerts reduce operational burden
  if (change.type === 'CAPACITY_INCREASE') {
    const throttlingRate = change.currentState?.throttlingRate as number | undefined;
    if (throttlingRate && throttlingRate > 0.05) {
      return {
        pillar,
        score: 'POSITIVE',
        rationale: `Eliminates throttling (${(throttlingRate * 100).toFixed(1)}%), reducing on-call burden and alert fatigue`,
        metrics: {
          current_throttling: `${(throttlingRate * 100).toFixed(1)}%`,
          projected_throttling: '0%',
        },
      };
    }
  }

  // New monitoring/observability resources improve operational excellence
  if (
    change.affectedResources.some(
      (arn) =>
        arn.includes(':logs:') || arn.includes(':cloudwatch:') || arn.includes(':xray:')
    )
  ) {
    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Enhances observability and monitoring capabilities',
    };
  }

  // Deletion of resources requires operational verification
  if (change.type === 'DELETE_RESOURCE') {
    return {
      pillar,
      score: 'NEGATIVE',
      severity: 'MODERATE',
      rationale:
        'Resource deletion requires operational verification to avoid service disruption',
      recommendations: ['Verify resource is unused', 'Check for dependencies'],
    };
  }

  // Default: neutral impact
  return {
    pillar,
    score: 'NEUTRAL',
    rationale: 'No significant operational impact',
  };
}

/**
 * Evaluate Security pillar
 *
 * Focuses on:
 * - Data protection (encryption, access control)
 * - Identity and access management
 * - Security monitoring and traceability
 * - Threat detection and response
 */
export function evaluateSecurity(change: InfrastructureChange): PillarEvaluation {
  const pillar: WellArchitectedPillar = 'security';

  // Security updates are always positive
  if (change.type === 'SECURITY_UPDATE') {
    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Applies security patches or updates, reducing vulnerability exposure',
    };
  }

  // Policy changes need careful review
  if (change.type === 'POLICY_CHANGE') {
    return {
      pillar,
      score: 'NEUTRAL',
      rationale: 'IAM/Cedar policy changes require security review',
      recommendations: [
        'Verify least privilege principle',
        'Check for privilege escalation risks',
        'Review audit logging coverage',
      ],
    };
  }

  // Check for encryption-related resources
  if (change.affectedResources.some((arn) => arn.includes(':kms:') || arn.includes(':secretsmanager:'))) {
    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Enhances data protection through encryption or secrets management',
    };
  }

  // Deletion of security resources is risky
  if (
    change.type === 'DELETE_RESOURCE' &&
    (change.affectedResources.some(
      (arn) =>
        arn.includes(':iam:') ||
        arn.includes(':kms:') ||
        arn.includes(':secretsmanager:') ||
        arn.includes(':guardduty:')
    ))
  ) {
    return {
      pillar,
      score: 'NEGATIVE',
      severity: 'MAJOR',
      rationale:
        'Deletion of security resources may expose vulnerabilities or break security controls',
      recommendations: [
        'Verify no active dependencies',
        'Ensure alternative security controls are in place',
      ],
    };
  }

  // Default: neutral impact
  return {
    pillar,
    score: 'NEUTRAL',
    rationale: 'No significant security impact',
  };
}

/**
 * Evaluate Reliability pillar
 *
 * Focuses on:
 * - Failure recovery and resilience
 * - Scaling to meet demand
 * - Service availability
 * - Change management
 */
export function evaluateReliability(change: InfrastructureChange): PillarEvaluation {
  const pillar: WellArchitectedPillar = 'reliability';

  // Capacity increases that eliminate throttling improve reliability
  if (change.type === 'CAPACITY_INCREASE') {
    const throttlingRate = change.currentState?.throttlingRate as number | undefined;
    if (throttlingRate && throttlingRate > 0) {
      return {
        pillar,
        score: 'POSITIVE',
        rationale: `Eliminates throttling (${(throttlingRate * 100).toFixed(1)}%), improving service availability`,
        metrics: {
          current_throttling: `${(throttlingRate * 100).toFixed(1)}%`,
          projected_throttling: '0%',
        },
      };
    }

    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Increases capacity headroom, reducing risk of service degradation',
    };
  }

  // Capacity decreases may risk reliability
  if (change.type === 'CAPACITY_DECREASE') {
    return {
      pillar,
      score: 'NEGATIVE',
      severity: 'MODERATE',
      rationale: 'Reducing capacity may increase throttling risk during traffic spikes',
      recommendations: [
        'Enable auto-scaling to handle spikes',
        'Monitor throttling metrics closely',
        'Test under peak load conditions',
      ],
    };
  }

  // Adding redundancy improves reliability
  if (
    change.affectedResources.some(
      (arn) =>
        arn.includes(':rds:') || // RDS multi-AZ
        arn.includes(':elasticloadbalancing:') || // Load balancers
        arn.includes(':backup:') // Backup plans
    )
  ) {
    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Adds redundancy or backup capability, improving fault tolerance',
    };
  }

  // Resource deletion may impact reliability
  if (change.type === 'DELETE_RESOURCE') {
    return {
      pillar,
      score: 'NEGATIVE',
      severity: 'MODERATE',
      rationale: 'Resource deletion may reduce redundancy or fault tolerance',
      recommendations: ['Verify no impact on service availability', 'Test failover scenarios'],
    };
  }

  // Default: neutral impact
  return {
    pillar,
    score: 'NEUTRAL',
    rationale: 'No significant reliability impact',
  };
}

/**
 * Evaluate Performance Efficiency pillar
 *
 * Focuses on:
 * - Right-sizing resources
 * - Technology selection
 * - Monitoring performance
 * - Experimentation and optimization
 */
export function evaluatePerformanceEfficiency(
  change: InfrastructureChange
): PillarEvaluation {
  const pillar: WellArchitectedPillar = 'performance_efficiency';

  // Performance optimizations are positive
  if (change.type === 'PERFORMANCE_OPTIMIZATION') {
    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Directly improves performance characteristics',
    };
  }

  // Capacity increases that reduce latency improve performance
  if (change.type === 'CAPACITY_INCREASE') {
    const currentLatency = change.currentState?.latency_p99 as number | undefined;
    const desiredLatency = change.desiredState?.latency_p99 as number | undefined;

    if (currentLatency && desiredLatency && desiredLatency < currentLatency) {
      return {
        pillar,
        score: 'POSITIVE',
        rationale: `Reduces p99 latency from ${currentLatency}ms to ${desiredLatency}ms`,
        metrics: {
          current_latency_p99: `${currentLatency}ms`,
          projected_latency_p99: `${desiredLatency}ms`,
        },
      };
    }

    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Increases capacity, reducing contention and improving response times',
    };
  }

  // Capacity decreases may degrade performance
  if (change.type === 'CAPACITY_DECREASE') {
    return {
      pillar,
      score: 'NEGATIVE',
      severity: 'MODERATE',
      rationale: 'Reducing capacity may increase latency during peak load',
      recommendations: ['Monitor latency metrics', 'Enable auto-scaling if needed'],
    };
  }

  // Default: neutral impact
  return {
    pillar,
    score: 'NEUTRAL',
    rationale: 'No significant performance impact',
  };
}

/**
 * Evaluate Cost Optimization pillar
 *
 * Focuses on:
 * - Eliminating waste
 * - Right-sizing resources
 * - Cost attribution and tracking
 * - Choosing cost-effective resources
 */
export function evaluateCostOptimization(change: InfrastructureChange): PillarEvaluation {
  const pillar: WellArchitectedPillar = 'cost_optimization';

  // Direct cost impact analysis
  if (change.costImpact !== undefined) {
    if (change.costImpact > 0) {
      // Cost increase
      const severity: ImpactSeverity =
        change.costImpact > 200 ? 'MAJOR' : change.costImpact > 50 ? 'MODERATE' : 'MINOR';

      return {
        pillar,
        score: 'NEGATIVE',
        severity,
        rationale: `Increases monthly cost by $${change.costImpact.toFixed(2)}`,
        metrics: {
          monthly_cost_increase: `$${change.costImpact.toFixed(2)}`,
        },
        recommendations:
          severity === 'MAJOR' || severity === 'MODERATE'
            ? ['Consider auto-scaling to reduce idle capacity', 'Evaluate reserved capacity pricing']
            : undefined,
      };
    } else if (change.costImpact < 0) {
      // Cost savings
      return {
        pillar,
        score: 'POSITIVE',
        rationale: `Reduces monthly cost by $${Math.abs(change.costImpact).toFixed(2)}`,
        metrics: {
          monthly_cost_savings: `$${Math.abs(change.costImpact).toFixed(2)}`,
        },
      };
    }
  }

  // Cost optimization changes are positive
  if (change.type === 'COST_OPTIMIZATION') {
    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Directly reduces costs through optimization',
    };
  }

  // Resource deletion typically saves costs
  if (change.type === 'DELETE_RESOURCE') {
    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Eliminates costs for unused resource',
    };
  }

  // Capacity increases cost more
  if (change.type === 'CAPACITY_INCREASE') {
    return {
      pillar,
      score: 'NEGATIVE',
      severity: 'MODERATE',
      rationale: 'Increased capacity typically increases monthly costs',
      recommendations: ['Consider auto-scaling to match actual demand'],
    };
  }

  // Default: neutral impact
  return {
    pillar,
    score: 'NEUTRAL',
    rationale: 'No significant cost impact',
  };
}

/**
 * Evaluate Sustainability pillar
 *
 * Focuses on:
 * - Maximizing resource utilization
 * - Minimizing environmental impact
 * - Using efficient hardware and software
 * - Reducing data movement and storage
 */
export function evaluateSustainability(change: InfrastructureChange): PillarEvaluation {
  const pillar: WellArchitectedPillar = 'sustainability';

  // Resource deletion improves sustainability (less waste)
  if (change.type === 'DELETE_RESOURCE') {
    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Eliminates unnecessary resource consumption and environmental impact',
    };
  }

  // Capacity increases may lead to idle resources
  if (change.type === 'CAPACITY_INCREASE') {
    return {
      pillar,
      score: 'NEGATIVE',
      severity: 'MINOR',
      rationale: 'Increased capacity may lead to idle resources during low-traffic periods',
      recommendations: [
        'Enable auto-scaling to match demand',
        'Consider consumption-based pricing models',
        'Monitor utilization to avoid waste',
      ],
    };
  }

  // Right-sizing improves sustainability
  if (change.type === 'CAPACITY_DECREASE') {
    return {
      pillar,
      score: 'POSITIVE',
      rationale: 'Right-sizing reduces resource waste and environmental impact',
    };
  }

  // Serverless/managed services are more efficient
  if (
    change.affectedResources.some(
      (arn) =>
        arn.includes(':lambda:') || // Lambda is serverless
        arn.includes(':fargate:') || // Fargate is serverless containers
        arn.includes(':dynamodb:') // DynamoDB is managed
    )
  ) {
    return {
      pillar,
      score: 'POSITIVE',
      rationale:
        'Serverless and managed services optimize resource utilization at AWS scale',
    };
  }

  // Default: neutral impact
  return {
    pillar,
    score: 'NEUTRAL',
    rationale: 'No significant sustainability impact',
  };
}

/**
 * Determine overall recommendation based on pillar scores
 *
 * Logic:
 * - REJECT if any pillar has MAJOR negative impact
 * - APPROVE_WITH_CAUTION if any pillar has MODERATE/MINOR negative impact
 * - APPROVE if all pillars are POSITIVE or NEUTRAL
 */
function determineRecommendation(
  pillars: WellArchitectedEvaluation['pillars']
): 'APPROVE' | 'APPROVE_WITH_CAUTION' | 'REJECT' {
  const pillarArray = Object.values(pillars);

  // Check for MAJOR negative impacts -> REJECT
  const hasMajorImpact = pillarArray.some(
    (p) => p.score === 'NEGATIVE' && p.severity === 'MAJOR'
  );
  if (hasMajorImpact) {
    return 'REJECT';
  }

  // Check for any negative impacts -> APPROVE_WITH_CAUTION
  const hasNegativeImpact = pillarArray.some((p) => p.score === 'NEGATIVE');
  if (hasNegativeImpact) {
    return 'APPROVE_WITH_CAUTION';
  }

  // All POSITIVE or NEUTRAL -> APPROVE
  return 'APPROVE';
}

/**
 * Get a subset of pillars with a specific score
 *
 * Useful for extracting benefits (POSITIVE) or trade-offs (NEGATIVE)
 */
export function getPillarsByScore(
  evaluation: WellArchitectedEvaluation,
  score: PillarScore
): PillarEvaluation[] {
  return Object.values(evaluation.pillars).filter((p) => p.score === score);
}

/**
 * Count pillars by score
 */
export function countPillarScores(evaluation: WellArchitectedEvaluation): {
  positive: number;
  neutral: number;
  negative: number;
} {
  const pillars = Object.values(evaluation.pillars);
  return {
    positive: pillars.filter((p) => p.score === 'POSITIVE').length,
    neutral: pillars.filter((p) => p.score === 'NEUTRAL').length,
    negative: pillars.filter((p) => p.score === 'NEGATIVE').length,
  };
}
