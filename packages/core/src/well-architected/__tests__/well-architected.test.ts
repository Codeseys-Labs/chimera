/**
 * Tests for Well-Architected Framework integration
 * Validates infrastructure decision evaluation against AWS best practices
 */

import { describe, it, expect } from 'bun:test';
import {
  type WellArchitectedPillar,
  type PillarScore,
  type ImpactSeverity,
  type PillarEvaluation,
  type WellArchitectedEvaluation,
  type InfrastructureChangeType,
  type InfrastructureChange,
  type TradeoffPresentation,
  type PillarPriorities,
  type WellArchitectedQuestion,
  type WellArchitectedReview,
  PILLAR_NAMES,
} from '../types';

describe('Well-Architected Framework Types', () => {
  describe('WellArchitectedPillar', () => {
    it('should define all six pillars', () => {
      const pillars: WellArchitectedPillar[] = [
        'operational_excellence',
        'security',
        'reliability',
        'performance_efficiency',
        'cost_optimization',
        'sustainability',
      ];

      expect(pillars).toHaveLength(6);
    });

    it('should provide human-readable pillar names', () => {
      expect(PILLAR_NAMES.operational_excellence).toBe('Operational Excellence');
      expect(PILLAR_NAMES.security).toBe('Security');
      expect(PILLAR_NAMES.reliability).toBe('Reliability');
      expect(PILLAR_NAMES.performance_efficiency).toBe('Performance Efficiency');
      expect(PILLAR_NAMES.cost_optimization).toBe('Cost Optimization');
      expect(PILLAR_NAMES.sustainability).toBe('Sustainability');
    });
  });

  describe('PillarScore', () => {
    it('should define impact scores', () => {
      const scores: PillarScore[] = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'];

      expect(scores).toHaveLength(3);
    });
  });

  describe('ImpactSeverity', () => {
    it('should define severity levels for negative impacts', () => {
      const severities: ImpactSeverity[] = ['MINOR', 'MODERATE', 'MAJOR'];

      expect(severities).toHaveLength(3);
    });
  });

  describe('InfrastructureChangeType', () => {
    it('should categorize different change types', () => {
      const types: InfrastructureChangeType[] = [
        'CAPACITY_INCREASE',
        'CAPACITY_DECREASE',
        'NEW_RESOURCE',
        'DELETE_RESOURCE',
        'CONFIGURATION_CHANGE',
        'POLICY_CHANGE',
        'SECURITY_UPDATE',
        'COST_OPTIMIZATION',
        'PERFORMANCE_OPTIMIZATION',
        'RELIABILITY_IMPROVEMENT',
      ];

      expect(types).toHaveLength(10);
      expect(types).toContain('CAPACITY_INCREASE');
      expect(types).toContain('SECURITY_UPDATE');
    });
  });
});

describe('PillarEvaluation structure', () => {
  it('should evaluate positive impact on reliability', () => {
    const evaluation: PillarEvaluation = {
      pillar: 'reliability',
      score: 'POSITIVE',
      rationale: 'Multi-AZ deployment eliminates single point of failure',
      metrics: {
        availability_sla: '99.99%',
        rto_minutes: 5,
      },
      recommendations: ['Consider cross-region replication for DR'],
    };

    expect(evaluation.score).toBe('POSITIVE');
    expect(evaluation.pillar).toBe('reliability');
    expect(evaluation.metrics?.availability_sla).toBe('99.99%');
  });

  it('should evaluate negative impact with severity', () => {
    const evaluation: PillarEvaluation = {
      pillar: 'cost_optimization',
      score: 'NEGATIVE',
      severity: 'MODERATE',
      rationale: 'Reserved capacity increases fixed costs by $500/month',
      metrics: {
        monthly_cost_increase: 500,
        cost_increase_percent: 25,
      },
    };

    expect(evaluation.score).toBe('NEGATIVE');
    expect(evaluation.severity).toBe('MODERATE');
    expect(evaluation.metrics?.monthly_cost_increase).toBe(500);
  });

  it('should evaluate neutral impact', () => {
    const evaluation: PillarEvaluation = {
      pillar: 'sustainability',
      score: 'NEUTRAL',
      rationale: 'No significant impact on carbon footprint',
    };

    expect(evaluation.score).toBe('NEUTRAL');
    expect(evaluation.severity).toBeUndefined();
  });
});

describe('WellArchitectedEvaluation structure', () => {
  it('should evaluate all six pillars', () => {
    const evaluation: WellArchitectedEvaluation = {
      pillars: {
        operational_excellence: {
          pillar: 'operational_excellence',
          score: 'POSITIVE',
          rationale: 'CloudWatch alarms improve observability',
        },
        security: {
          pillar: 'security',
          score: 'POSITIVE',
          rationale: 'IAM least privilege policies enforced',
        },
        reliability: {
          pillar: 'reliability',
          score: 'POSITIVE',
          rationale: 'Multi-AZ deployment',
        },
        performance_efficiency: {
          pillar: 'performance_efficiency',
          score: 'NEUTRAL',
          rationale: 'No performance impact',
        },
        cost_optimization: {
          pillar: 'cost_optimization',
          score: 'NEGATIVE',
          severity: 'MINOR',
          rationale: 'Small cost increase acceptable',
        },
        sustainability: {
          pillar: 'sustainability',
          score: 'NEUTRAL',
          rationale: 'Minimal carbon impact',
        },
      },
      recommendation: 'APPROVE_WITH_CAUTION',
      summary: 'Increases reliability with minor cost trade-off',
      evaluatedAt: new Date().toISOString(),
    };

    expect(evaluation.pillars.operational_excellence.score).toBe('POSITIVE');
    expect(evaluation.pillars.cost_optimization.score).toBe('NEGATIVE');
    expect(evaluation.recommendation).toBe('APPROVE_WITH_CAUTION');
  });

  it('should reject changes with major negative impacts', () => {
    const evaluation: WellArchitectedEvaluation = {
      pillars: {
        operational_excellence: {
          pillar: 'operational_excellence',
          score: 'NEUTRAL',
          rationale: 'No operational impact',
        },
        security: {
          pillar: 'security',
          score: 'NEGATIVE',
          severity: 'MAJOR',
          rationale: 'Removes encryption at rest',
        },
        reliability: {
          pillar: 'reliability',
          score: 'NEUTRAL',
          rationale: 'No reliability impact',
        },
        performance_efficiency: {
          pillar: 'performance_efficiency',
          score: 'NEUTRAL',
          rationale: 'No performance impact',
        },
        cost_optimization: {
          pillar: 'cost_optimization',
          score: 'POSITIVE',
          rationale: 'Reduces costs',
        },
        sustainability: {
          pillar: 'sustainability',
          score: 'NEUTRAL',
          rationale: 'No sustainability impact',
        },
      },
      recommendation: 'REJECT',
      summary: 'Cost savings do not justify security degradation',
      evaluatedAt: new Date().toISOString(),
    };

    expect(evaluation.pillars.security.severity).toBe('MAJOR');
    expect(evaluation.recommendation).toBe('REJECT');
  });
});

describe('InfrastructureChange structure', () => {
  it('should describe capacity increase change', () => {
    const change: InfrastructureChange = {
      type: 'CAPACITY_INCREASE',
      description: 'Increase DynamoDB chimera-sessions from 100 RCU to 200 RCU',
      affectedResources: [
        'arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions',
      ],
      currentState: {
        read_capacity: 100,
        write_capacity: 100,
        throttling_rate: 15,
      },
      desiredState: {
        read_capacity: 200,
        write_capacity: 100,
        throttling_rate: 0,
      },
      costImpact: 50, // $50/month increase
      impactedTiers: ['advanced', 'premium'],
      proposedBy: 'agent-capacity-monitor',
    };

    expect(change.type).toBe('CAPACITY_INCREASE');
    expect(change.costImpact).toBe(50);
    expect(change.impactedTiers).toContain('advanced');
  });

  it('should describe new resource creation', () => {
    const change: InfrastructureChange = {
      type: 'NEW_RESOURCE',
      description: 'Add CloudFront distribution for static assets',
      affectedResources: [],
      desiredState: {
        resource_type: 'AWS::CloudFront::Distribution',
        price_class: 'PriceClass_100',
      },
      costImpact: 75, // $75/month estimated
    };

    expect(change.type).toBe('NEW_RESOURCE');
    expect(change.affectedResources).toHaveLength(0);
  });

  it('should describe resource deletion', () => {
    const change: InfrastructureChange = {
      type: 'DELETE_RESOURCE',
      description: 'Remove obsolete staging environment',
      affectedResources: [
        'arn:aws:ec2:us-west-2:123456789012:instance/i-abc123',
        'arn:aws:rds:us-west-2:123456789012:db:staging-db',
      ],
      currentState: {
        monthly_cost: 200,
      },
      costImpact: -200, // $200/month savings
    };

    expect(change.type).toBe('DELETE_RESOURCE');
    expect(change.costImpact).toBe(-200);
    expect(change.affectedResources).toHaveLength(2);
  });
});

describe('TradeoffPresentation structure', () => {
  it('should present benefits and trade-offs clearly', () => {
    const change: InfrastructureChange = {
      type: 'CAPACITY_INCREASE',
      description: 'Scale up DynamoDB capacity',
      affectedResources: ['arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions'],
      costImpact: 50,
    };

    const presentation: TradeoffPresentation = {
      change,
      evaluation: {
        pillars: {
          operational_excellence: {
            pillar: 'operational_excellence',
            score: 'NEUTRAL',
            rationale: 'No operational changes',
          },
          security: {
            pillar: 'security',
            score: 'NEUTRAL',
            rationale: 'No security impact',
          },
          reliability: {
            pillar: 'reliability',
            score: 'POSITIVE',
            rationale: 'Eliminates throttling',
          },
          performance_efficiency: {
            pillar: 'performance_efficiency',
            score: 'POSITIVE',
            rationale: 'Faster response times',
          },
          cost_optimization: {
            pillar: 'cost_optimization',
            score: 'NEGATIVE',
            severity: 'MINOR',
            rationale: '$50/month increase',
          },
          sustainability: {
            pillar: 'sustainability',
            score: 'NEUTRAL',
            rationale: 'Minimal impact',
          },
        },
        recommendation: 'APPROVE',
        summary: 'Improves reliability and performance with minor cost increase',
        evaluatedAt: new Date().toISOString(),
      },
      presentation: '## Trade-off Analysis\n\n**Benefits:**\n- Eliminates throttling\n- Faster response\n\n**Trade-offs:**\n- $50/month cost increase',
      benefits: [
        {
          pillar: 'reliability',
          pillarName: 'Reliability',
          description: 'Eliminates throttling',
        },
        {
          pillar: 'performance_efficiency',
          pillarName: 'Performance Efficiency',
          description: 'Faster response times',
        },
      ],
      tradeoffs: [
        {
          pillar: 'cost_optimization',
          pillarName: 'Cost Optimization',
          severity: 'MINOR',
          description: '$50/month increase',
        },
      ],
      recommendation: {
        decision: 'APPROVE',
        reasoning: 'Performance improvements justify minor cost increase',
      },
    };

    expect(presentation.benefits).toHaveLength(2);
    expect(presentation.tradeoffs).toHaveLength(1);
    expect(presentation.recommendation.decision).toBe('APPROVE');
  });
});

describe('PillarPriorities', () => {
  it('should define equal priority weights by default', () => {
    const priorities: PillarPriorities = {
      weights: {
        operational_excellence: 5,
        security: 5,
        reliability: 5,
        performance_efficiency: 5,
        cost_optimization: 5,
        sustainability: 5,
      },
    };

    const values = Object.values(priorities.weights);
    expect(values.every(weight => weight === 5)).toBe(true);
  });

  it('should allow custom priority weighting', () => {
    const priorities: PillarPriorities = {
      weights: {
        operational_excellence: 7,
        security: 10, // Highest priority
        reliability: 9,
        performance_efficiency: 5,
        cost_optimization: 3, // Lower priority
        sustainability: 2, // Lowest priority
      },
      notes: 'Security and reliability are top priorities for production workload',
    };

    expect(priorities.weights.security).toBe(10);
    expect(priorities.weights.cost_optimization).toBe(3);
    expect(priorities.notes).toContain('Security');
  });
});

describe('WellArchitectedQuestion structure', () => {
  it('should define question with choices', () => {
    const question: WellArchitectedQuestion = {
      questionId: 'sec-1',
      pillar: 'security',
      question: 'How do you securely operate your workload?',
      choices: [
        {
          choiceId: 'sec_securely_operate_multi_accounts',
          title: 'Separate workloads using accounts',
          description: 'Use AWS accounts to isolate workloads',
        },
        {
          choiceId: 'sec_securely_operate_aws_account',
          title: 'Secure AWS account',
          description: 'Apply security best practices to AWS account',
        },
      ],
      selectedChoices: ['sec_securely_operate_multi_accounts'],
      notes: 'Using AWS Organizations for account separation',
      risk: 'NONE',
    };

    expect(question.pillar).toBe('security');
    expect(question.choices).toHaveLength(2);
    expect(question.selectedChoices).toContain('sec_securely_operate_multi_accounts');
    expect(question.risk).toBe('NONE');
  });

  it('should identify high-risk questions', () => {
    const question: WellArchitectedQuestion = {
      questionId: 'rel-8',
      pillar: 'reliability',
      question: 'How do you back up data?',
      choices: [
        {
          choiceId: 'rel_back_up_data_automated',
          title: 'Automated backups',
          description: 'Use automated backup solutions',
        },
      ],
      selectedChoices: [], // No backups selected
      risk: 'HIGH',
    };

    expect(question.risk).toBe('HIGH');
    expect(question.selectedChoices).toHaveLength(0);
  });
});

describe('WellArchitectedReview structure', () => {
  it('should contain complete review with improvement plan', () => {
    const review: WellArchitectedReview = {
      workloadId: 'abcd1234-5678-90ab-cdef-EXAMPLE11111',
      workloadName: 'Chimera Multi-Tenant Agent Platform',
      reviewDate: new Date().toISOString(),
      questions: [
        {
          questionId: 'sec-1',
          pillar: 'security',
          question: 'How do you securely operate your workload?',
          choices: [],
          selectedChoices: ['sec_securely_operate_multi_accounts'],
          risk: 'NONE',
        },
        {
          questionId: 'cost-3',
          pillar: 'cost_optimization',
          question: 'How do you monitor usage and cost?',
          choices: [],
          selectedChoices: [],
          risk: 'MEDIUM',
        },
      ],
      riskSummary: {
        high: 2,
        medium: 5,
        none: 51,
      },
      improvementPlan: [
        {
          priority: 1,
          pillar: 'security',
          issue: 'Encryption at rest not enabled for all data stores',
          recommendation: 'Enable encryption for S3 buckets and DynamoDB tables',
          estimatedEffort: 'LOW',
        },
        {
          priority: 2,
          pillar: 'cost_optimization',
          issue: 'No automated cost monitoring',
          recommendation: 'Set up CloudWatch alarms for budget thresholds',
          estimatedEffort: 'MEDIUM',
        },
      ],
      milestoneId: 'milestone-001',
    };

    expect(review.questions).toHaveLength(2);
    expect(review.riskSummary.high).toBe(2);
    expect(review.improvementPlan).toHaveLength(2);
    expect(review.improvementPlan[0].priority).toBe(1);
  });
});

describe('Type exports and constants', () => {
  it('should export pillar names constant', () => {
    expect(PILLAR_NAMES).toBeDefined();
    expect(Object.keys(PILLAR_NAMES)).toHaveLength(6);
    expect(PILLAR_NAMES.security).toBe('Security');
  });
});

describe('Decision recommendation logic', () => {
  it('should approve changes with all positive scores', () => {
    const evaluation: WellArchitectedEvaluation = {
      pillars: {
        operational_excellence: {
          pillar: 'operational_excellence',
          score: 'POSITIVE',
          rationale: 'Improved monitoring',
        },
        security: {
          pillar: 'security',
          score: 'POSITIVE',
          rationale: 'Enhanced encryption',
        },
        reliability: {
          pillar: 'reliability',
          score: 'POSITIVE',
          rationale: 'Multi-AZ',
        },
        performance_efficiency: {
          pillar: 'performance_efficiency',
          score: 'POSITIVE',
          rationale: 'Better performance',
        },
        cost_optimization: {
          pillar: 'cost_optimization',
          score: 'NEUTRAL',
          rationale: 'No cost impact',
        },
        sustainability: {
          pillar: 'sustainability',
          score: 'NEUTRAL',
          rationale: 'No environmental impact',
        },
      },
      recommendation: 'APPROVE',
      summary: 'Strong improvements across all pillars',
      evaluatedAt: new Date().toISOString(),
    };

    expect(evaluation.recommendation).toBe('APPROVE');
  });

  it('should approve with caution for minor negative impacts', () => {
    const evaluation: WellArchitectedEvaluation = {
      pillars: {
        operational_excellence: {
          pillar: 'operational_excellence',
          score: 'POSITIVE',
          rationale: 'Better observability',
        },
        security: {
          pillar: 'security',
          score: 'NEUTRAL',
          rationale: 'No security impact',
        },
        reliability: {
          pillar: 'reliability',
          score: 'POSITIVE',
          rationale: 'Improved availability',
        },
        performance_efficiency: {
          pillar: 'performance_efficiency',
          score: 'NEUTRAL',
          rationale: 'No performance change',
        },
        cost_optimization: {
          pillar: 'cost_optimization',
          score: 'NEGATIVE',
          severity: 'MINOR',
          rationale: 'Small cost increase',
        },
        sustainability: {
          pillar: 'sustainability',
          score: 'NEUTRAL',
          rationale: 'Minimal impact',
        },
      },
      recommendation: 'APPROVE_WITH_CAUTION',
      summary: 'Benefits outweigh minor cost increase',
      evaluatedAt: new Date().toISOString(),
    };

    expect(evaluation.recommendation).toBe('APPROVE_WITH_CAUTION');
  });

  it('should reject changes with major negative impacts', () => {
    const evaluation: WellArchitectedEvaluation = {
      pillars: {
        operational_excellence: {
          pillar: 'operational_excellence',
          score: 'NEUTRAL',
          rationale: 'No operational impact',
        },
        security: {
          pillar: 'security',
          score: 'NEGATIVE',
          severity: 'MAJOR',
          rationale: 'Disables WAF protection',
        },
        reliability: {
          pillar: 'reliability',
          score: 'NEGATIVE',
          severity: 'MAJOR',
          rationale: 'Removes redundancy',
        },
        performance_efficiency: {
          pillar: 'performance_efficiency',
          score: 'NEUTRAL',
          rationale: 'No performance impact',
        },
        cost_optimization: {
          pillar: 'cost_optimization',
          score: 'POSITIVE',
          rationale: 'Saves money',
        },
        sustainability: {
          pillar: 'sustainability',
          score: 'NEUTRAL',
          rationale: 'No environmental impact',
        },
      },
      recommendation: 'REJECT',
      summary: 'Cost savings do not justify security and reliability degradation',
      evaluatedAt: new Date().toISOString(),
    };

    expect(evaluation.recommendation).toBe('REJECT');
    expect(evaluation.pillars.security.severity).toBe('MAJOR');
    expect(evaluation.pillars.reliability.severity).toBe('MAJOR');
  });
});
