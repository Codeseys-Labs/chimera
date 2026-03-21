/**
 * Billing module tests
 *
 * Tests for CostTracker and BudgetMonitor
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { CostTracker } from '../cost-tracker';
import type { CostTrackerConfig, RecordCostParams, DynamoDBClient } from '../cost-tracker';

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
    // Check condition expression for idempotency
    if (params.ConditionExpression?.includes('attribute_not_exists')) {
      if (this.store.has(key)) {
        const error: any = new Error('ConditionalCheckFailedException');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
    }
    this.store.set(key, params.Item);
    return {};
  }

  async update(params: any) {
    const key = `${params.Key.PK}#${params.Key.SK}`;
    // Get existing item - DynamoDB update creates if doesn't exist with default values
    let item = this.store.get(key);

    if (!item) {
      // Create minimal item if it doesn't exist (DynamoDB behavior)
      item = {
        PK: params.Key.PK,
        SK: params.Key.SK,
        totalCostUsd: 0,
        requestCount: 0,
        breakdown: {},
      };
    } else {
      // Clone to avoid mutation issues
      item = { ...item };
      if (item.breakdown) {
        item.breakdown = { ...item.breakdown };
      }
    }

    // Parse update expression and apply changes
    if (params.ExpressionAttributeValues) {
      const cost = params.ExpressionAttributeValues[':cost'];
      const reqCount = params.ExpressionAttributeValues[':reqCount'];
      const now = params.ExpressionAttributeValues[':now'];

      // Apply updates - simulate if_not_exists behavior
      if (cost !== undefined) {
        item.totalCostUsd = (item.totalCostUsd || 0) + cost;
      }
      if (now !== undefined) {
        item.lastUpdated = now;
      }
      if (reqCount !== undefined) {
        item.requestCount = (item.requestCount || 0) + reqCount;
      }

      // Handle breakdown updates
      if (!item.breakdown) item.breakdown = {};
      const service = params.ExpressionAttributeNames?.['#service'];
      if (service && cost !== undefined) {
        item.breakdown[service] = (item.breakdown[service] || 0) + cost;
      }

      // Handle budget exceeded flag
      if (params.ExpressionAttributeValues[':true'] !== undefined) {
        item.budgetExceeded = params.ExpressionAttributeValues[':true'];
      }
    }

    this.store.set(key, item);
    return { Attributes: item };
  }

  async query(params: any) {
    const items = Array.from(this.store.values()).filter((item: any) => {
      if (params.KeyConditionExpression?.includes('PK = :pk')) {
        return item.PK === params.ExpressionAttributeValues[':pk'];
      }
      return true;
    });
    return { Items: items };
  }

  reset() {
    this.store.clear();
  }

  getStore() {
    return this.store;
  }
}

describe('CostTracker', () => {
  let tracker: CostTracker;
  let mockDynamoDB: MockDynamoDBClient;
  let config: CostTrackerConfig;

  beforeEach(() => {
    mockDynamoDB = new MockDynamoDBClient();
    config = {
      costTrackingTableName: 'test-cost-tracking',
      dynamodb: mockDynamoDB,
    };
    tracker = new CostTracker(config);
  });

  describe('recordCost', () => {
    it('should record bedrock inference cost with token usage', async () => {
      const params: RecordCostParams = {
        tenantId: 'tenant-123',
        service: 'bedrock-inference',
        costUsd: 0.05,
        modelId: 'claude-opus-4',
        inputTokens: 1000,
        outputTokens: 500,
        requestCount: 1,
      };

      await tracker.recordCost(params);

      const cost = await tracker.getMonthlyCost('tenant-123');
      expect(cost).not.toBeNull();
      expect(cost!.totalCostUsd).toBe(0.05);
      expect(cost!.breakdown['bedrock-inference']).toBe(0.05);
      expect(cost!.requestCount).toBe(1);
    });

    it('should accumulate costs across multiple requests', async () => {
      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'bedrock-inference',
        costUsd: 0.05,
        requestCount: 1,
      });

      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'bedrock-inference',
        costUsd: 0.03,
        requestCount: 1,
      });

      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'dynamodb',
        costUsd: 0.02,
        requestCount: 10,
      });

      const cost = await tracker.getMonthlyCost('tenant-123');
      expect(cost).not.toBeNull();
      expect(cost!.totalCostUsd).toBe(0.10);
      expect(cost!.breakdown['bedrock-inference']).toBe(0.08);
      expect(cost!.breakdown['dynamodb']).toBe(0.02);
      expect(cost!.requestCount).toBe(12);
    });

    it('should handle multiple services independently', async () => {
      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'bedrock-inference',
        costUsd: 1.00,
      });

      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 's3',
        costUsd: 0.25,
      });

      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'cloudwatch',
        costUsd: 0.10,
      });

      const cost = await tracker.getMonthlyCost('tenant-123');
      expect(cost!.totalCostUsd).toBe(1.35);
      expect(cost!.breakdown['bedrock-inference']).toBe(1.00);
      expect(cost!.breakdown['s3']).toBe(0.25);
      expect(cost!.breakdown['cloudwatch']).toBe(0.10);
    });
  });

  describe('getMonthlyCost', () => {
    it('should return null for non-existent tenant', async () => {
      const cost = await tracker.getMonthlyCost('non-existent');
      expect(cost).toBeNull();
    });

    it('should return current month by default', async () => {
      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'bedrock-inference',
        costUsd: 0.50,
      });

      const cost = await tracker.getMonthlyCost('tenant-123');
      expect(cost).not.toBeNull();
      expect(cost!.period).toMatch(/^\d{4}-\d{2}$/);
    });
  });

  describe('isBudgetExceeded', () => {
    it('should return false when under budget', async () => {
      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'bedrock-inference',
        costUsd: 50.00,
      });

      const exceeded = await tracker.isBudgetExceeded('tenant-123', 100.00);
      expect(exceeded).toBe(false);
    });

    it('should return true when at or over budget', async () => {
      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'bedrock-inference',
        costUsd: 100.00,
      });

      const exceeded = await tracker.isBudgetExceeded('tenant-123', 100.00);
      expect(exceeded).toBe(true);
    });

    it('should return false for non-existent tenant', async () => {
      const exceeded = await tracker.isBudgetExceeded('non-existent', 100.00);
      expect(exceeded).toBe(false);
    });
  });

  describe('getCostSummary', () => {
    it('should calculate percent used correctly', async () => {
      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'bedrock-inference',
        costUsd: 75.00,
      });

      const summary = await tracker.getCostSummary('tenant-123', 100.00);
      expect(summary.totalCostUsd).toBe(75.00);
      expect(summary.budgetLimitUsd).toBe(100.00);
      expect(summary.percentUsed).toBe(75.00);
    });

    it('should rank top services by cost', async () => {
      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'bedrock-inference',
        costUsd: 50.00,
      });

      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 's3',
        costUsd: 10.00,
      });

      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'dynamodb',
        costUsd: 25.00,
      });

      const summary = await tracker.getCostSummary('tenant-123', 200.00);
      expect(summary.topServices).toHaveLength(3);
      expect(summary.topServices[0].service).toBe('bedrock-inference');
      expect(summary.topServices[0].cost).toBe(50.00);
      expect(summary.topServices[1].service).toBe('dynamodb');
      expect(summary.topServices[1].cost).toBe(25.00);
    });

    it('should return zero values for non-existent tenant', async () => {
      const summary = await tracker.getCostSummary('non-existent', 100.00);
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.percentUsed).toBe(0);
      expect(summary.projectedMonthlySpend).toBe(0);
      expect(summary.topServices).toHaveLength(0);
    });
  });

  describe('markBudgetExceeded', () => {
    it('should set budgetExceeded flag', async () => {
      await tracker.recordCost({
        tenantId: 'tenant-123',
        service: 'bedrock-inference',
        costUsd: 150.00,
      });

      await tracker.markBudgetExceeded('tenant-123');

      const cost = await tracker.getMonthlyCost('tenant-123');
      expect(cost!.budgetExceeded).toBe(true);
    });
  });

  describe('getCostHistory', () => {
    it('should return empty array for tenant with no history', async () => {
      const history = await tracker.getCostHistory('tenant-123', 12);
      expect(history).toHaveLength(0);
    });
  });

  describe('initializePeriod', () => {
    it('should create period with zero costs', async () => {
      const period = '2026-03';
      await tracker.initializePeriod('tenant-123', period);

      const cost = await tracker.getMonthlyCost('tenant-123', period);
      expect(cost).not.toBeNull();
      expect(cost!.totalCostUsd).toBe(0);
      expect(cost!.period).toBe(period);
      expect(cost!.budgetExceeded).toBe(false);
    });

    it('should be idempotent (not fail on second call)', async () => {
      const period = '2026-03';
      await tracker.initializePeriod('tenant-123', period);

      // Second call should not throw (idempotent)
      await tracker.initializePeriod('tenant-123', period);

      const cost = await tracker.getMonthlyCost('tenant-123', period);
      expect(cost).not.toBeNull();
      expect(cost!.totalCostUsd).toBe(0);
    });
  });
});
