/**
 * Activity module tests
 *
 * Tests for DecisionLogger, StatusDashboard, and activity logging
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DecisionLogger } from '../decision-logger';
import type {
  DecisionLoggerConfig,
  LogDecisionParams,
  DynamoDBClient
} from '../decision-logger';
import type {
  DecisionAlternative,
  DecisionContext,
  WellArchitectedPillar
} from '../types';

// Mock DynamoDB client
class MockDynamoDBClient implements DynamoDBClient {
  private store: Map<string, any> = new Map();

  async get(params: any) {
    const key = `${params.Key.PK}#${params.Key.SK}`;
    const item = this.store.get(key);
    return { Item: item };
  }

  async put(params: any) {
    const key = `${params.Item.PK}#${params.Item.SK}`;
    this.store.set(key, params.Item);
    return {};
  }

  async query(params: any) {
    const items = Array.from(this.store.values()).filter((item: any) => {
      if (params.KeyConditionExpression) {
        return item.PK === params.ExpressionAttributeValues[':pk'];
      }
      return true;
    });
    return { Items: items };
  }

  async scan(params: any) {
    return { Items: Array.from(this.store.values()) };
  }

  reset() {
    this.store.clear();
  }
}

describe('DecisionLogger', () => {
  let logger: DecisionLogger;
  let mockDynamoDB: MockDynamoDBClient;
  let config: DecisionLoggerConfig;

  beforeEach(() => {
    mockDynamoDB = new MockDynamoDBClient();
    config = {
      activityTableName: 'test-activity-table',
      dynamodb: mockDynamoDB,
      ttlDays: 90,
    };
    logger = new DecisionLogger(config);
  });

  describe('calculateConfidence', () => {
    it('should return high confidence for large score gap', () => {
      const alternatives: DecisionAlternative[] = [
        {
          option: 'Amazon DynamoDB',
          score: 9.0,
          wellArchitectedPillars: {} as any,
          costEstimate: { monthly: 50, annual: 600 },
          justification: 'Best fit',
        },
        {
          option: 'Amazon RDS',
          score: 6.0,
          wellArchitectedPillars: {} as any,
          costEstimate: { monthly: 100, annual: 1200 },
          justification: 'Alternative',
        },
      ];

      const result = logger.calculateConfidence(alternatives, 'Amazon DynamoDB');

      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      expect(result.factors.scoreGap).toBe(3.0);
      expect(result.factors.alternativeCount).toBe(2);
    });

    it('should return low confidence for small score gap', () => {
      const alternatives: DecisionAlternative[] = [
        {
          option: 'Option A',
          score: 7.5,
          wellArchitectedPillars: {} as any,
          costEstimate: { monthly: 50, annual: 600 },
          justification: 'Close call',
        },
        {
          option: 'Option B',
          score: 7.3,
          wellArchitectedPillars: {} as any,
          costEstimate: { monthly: 55, annual: 660 },
          justification: 'Very similar',
        },
      ];

      const result = logger.calculateConfidence(alternatives, 'Option A');

      expect(result.confidence).toBeLessThan(0.5);
      expect(result.factors.scoreGap).toBeCloseTo(0.2, 1);
    });

    it('should apply quality penalty for low winner score', () => {
      const alternatives: DecisionAlternative[] = [
        {
          option: 'Low Score Winner',
          score: 6.0,
          wellArchitectedPillars: {} as any,
          costEstimate: { monthly: 50, annual: 600 },
          justification: 'Best of bad options',
        },
        {
          option: 'Even Lower',
          score: 5.0,
          wellArchitectedPillars: {} as any,
          costEstimate: { monthly: 45, annual: 540 },
          justification: 'Worse',
        },
      ];

      const result = logger.calculateConfidence(alternatives, 'Low Score Winner');

      expect(result.confidence).toBeLessThan(0.6);
      expect(result.breakdown.qualityPenalty).toBeGreaterThan(0);
    });

    it('should increase confidence with more alternatives', () => {
      const createAlternative = (score: number): DecisionAlternative => ({
        option: `Option ${score}`,
        score,
        wellArchitectedPillars: {} as any,
        costEstimate: { monthly: 50, annual: 600 },
        justification: 'Test',
      });

      const twoAlternatives = [createAlternative(9.0), createAlternative(6.0)];
      const fiveAlternatives = [
        createAlternative(9.0),
        createAlternative(7.0),
        createAlternative(6.0),
        createAlternative(5.0),
        createAlternative(4.0),
      ];

      const resultTwo = logger.calculateConfidence(twoAlternatives, 'Option 9');
      const resultFive = logger.calculateConfidence(fiveAlternatives, 'Option 9');

      expect(resultFive.confidence).toBeGreaterThan(resultTwo.confidence);
      expect(resultFive.factors.diversityScore).toBeGreaterThan(resultTwo.factors.diversityScore);
    });
  });

  describe('logDecision', () => {
    it('should log a valid decision with all fields', async () => {
      const alternatives: DecisionAlternative[] = [
        {
          option: 'Amazon DynamoDB',
          score: 9.0,
          wellArchitectedPillars: {
            operational_excellence: { score: 9, justification: 'Serverless' },
            security: { score: 9, justification: 'IAM + encryption' },
            reliability: { score: 9, justification: 'Multi-AZ' },
            performance_efficiency: { score: 9, justification: 'Low latency' },
            cost_optimization: { score: 9, justification: 'Pay per request' },
            sustainability: { score: 8, justification: 'Efficient' },
          },
          costEstimate: { monthly: 50, annual: 600 },
          justification: 'Best fit for key-value workload',
        },
        {
          option: 'Amazon RDS',
          score: 7.0,
          wellArchitectedPillars: {
            operational_excellence: { score: 7, justification: 'Managed' },
            security: { score: 8, justification: 'VPC + encryption' },
            reliability: { score: 8, justification: 'Multi-AZ' },
            performance_efficiency: { score: 7, justification: 'Good' },
            cost_optimization: { score: 6, justification: 'Always-on cost' },
            sustainability: { score: 6, justification: 'Idle resources' },
          },
          costEstimate: { monthly: 150, annual: 1800 },
          justification: 'Relational database option',
        },
      ];

      const context: DecisionContext = {
        taskDescription: 'Choose session storage',
        constraints: ['Low latency', 'Serverless'],
        requirements: ['Multi-tenant isolation', 'TTL support'],
      };

      const params: LogDecisionParams = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        model: 'claude-opus-4',
        question: 'Which database for session storage?',
        decisionType: 'architecture',
        context,
        alternatives,
        selectedOption: 'Amazon DynamoDB',
        justification: 'Best fit for serverless key-value access pattern with TTL',
        sessionId: 'session-789',
      };

      const decision = await logger.logDecision(params);

      expect(decision.activityId).toMatch(/^act-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}-\d{3}$/);
      expect(decision.activityType).toBe('decision');
      expect(decision.tenantId).toBe('tenant-123');
      expect(decision.agentId).toBe('agent-456');
      expect(decision.selectedOption).toBe('Amazon DynamoDB');
      expect(decision.confidence).toBeGreaterThan(0);
      expect(decision.riskLevel).toBeDefined();
      expect(['low', 'medium', 'high', 'critical']).toContain(decision.riskLevel);
    });

    it('should throw error if selected option not in alternatives', async () => {
      const alternatives: DecisionAlternative[] = [
        {
          option: 'Option A',
          score: 8.0,
          wellArchitectedPillars: {} as any,
          costEstimate: { monthly: 50, annual: 600 },
          justification: 'Test',
        },
      ];

      const params: LogDecisionParams = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        model: 'claude-opus-4',
        question: 'Test question',
        decisionType: 'test',
        context: {} as any,
        alternatives,
        selectedOption: 'Invalid Option',
        justification: 'Test',
      };

      await expect(logger.logDecision(params)).rejects.toThrow(
        'Selected option "Invalid Option" not found in alternatives'
      );
    });

    it('should throw error if less than 2 alternatives provided', async () => {
      const alternatives: DecisionAlternative[] = [
        {
          option: 'Only Option',
          score: 8.0,
          wellArchitectedPillars: {} as any,
          costEstimate: { monthly: 50, annual: 600 },
          justification: 'Only choice',
        },
      ];

      const params: LogDecisionParams = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        model: 'claude-opus-4',
        question: 'Test question',
        decisionType: 'test',
        context: {} as any,
        alternatives,
        selectedOption: 'Only Option',
        justification: 'Test',
      };

      await expect(logger.logDecision(params)).rejects.toThrow(
        'At least 2 alternatives required for decision logging'
      );
    });

    it('should classify risk as critical for low confidence + high cost', async () => {
      const alternatives: DecisionAlternative[] = [
        {
          option: 'Expensive Uncertain Option',
          score: 6.5,
          wellArchitectedPillars: {} as any,
          costEstimate: { monthly: 800, annual: 9600 },
          justification: 'Risky choice',
        },
        {
          option: 'Close Alternative',
          score: 6.3,
          wellArchitectedPillars: {} as any,
          costEstimate: { monthly: 750, annual: 9000 },
          justification: 'Also risky',
        },
      ];

      const params: LogDecisionParams = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        model: 'claude-opus-4',
        question: 'Test question',
        decisionType: 'architecture',
        context: {} as any,
        alternatives,
        selectedOption: 'Expensive Uncertain Option',
        justification: 'Best of bad options',
      };

      const decision = await logger.logDecision(params);

      // Should be high or critical risk due to low confidence and high cost
      expect(['high', 'critical']).toContain(decision.riskLevel);
    });
  });

  describe('queryDecisions', () => {
    it('should filter decisions by date range', async () => {
      // Pre-populate with test data
      const testDecision = {
        PK: 'TENANT#tenant-123',
        SK: 'ACTIVITY#2026-03-20T10:00:00.000Z#act-test-001',
        activityType: 'decision',
        decisionType: 'architecture',
        selectedOption: 'Amazon DynamoDB',
        confidence: 0.9,
        riskLevel: 'low',
        monthlyCost: 50,
        decisionLog: {
          question: 'Test',
          selectedOption: 'Amazon DynamoDB',
        },
      };

      await mockDynamoDB.put({ Item: testDecision });

      const result = await logger.queryDecisions({
        tenantId: 'tenant-123',
        startDate: '2026-03-01T00:00:00.000Z',
        endDate: '2026-03-31T23:59:59.999Z',
        limit: 50,
      });

      expect(result.decisions.length).toBeGreaterThan(0);
    });
  });

  describe('generateAnalytics', () => {
    it('should return empty analytics for zero decisions', async () => {
      mockDynamoDB.reset();

      const analytics = await logger.generateAnalytics(
        'tenant-123',
        '2026-03-01T00:00:00.000Z',
        '2026-03-31T23:59:59.999Z'
      );

      expect(analytics.totalDecisions).toBe(0);
      expect(analytics.avgConfidence).toBe(0);
      expect(Object.keys(analytics.decisionsByType)).toHaveLength(0);
      expect(analytics.topSelectedOptions).toHaveLength(0);
    });
  });
});
