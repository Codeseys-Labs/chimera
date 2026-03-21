/**
 * User Pairing Service Tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { UserPairingService, type DynamoDBClient } from '../user-pairing';
import type { UserPairing } from '../types';

/**
 * Mock DynamoDB client for testing
 */
function createMockDynamoDBClient(): DynamoDBClient & {
  _store: Map<string, any>;
} {
  const store = new Map<string, any>();

  return {
    _store: store,

    async get(params: any) {
      const key = `${params.Key.PK}#${params.Key.SK}`;
      const item = store.get(key);
      return { Item: item };
    },

    async put(params: any) {
      const key = `${params.Item.PK}#${params.Item.SK}`;

      // Check ConditionExpression
      if (params.ConditionExpression?.includes('attribute_not_exists')) {
        if (store.has(key)) {
          throw new Error('ConditionalCheckFailedException');
        }
      }

      store.set(key, params.Item);
      return {};
    },

    async update(params: any) {
      const key = `${params.Key.PK}#${params.Key.SK}`;
      const item = store.get(key);

      if (!item) {
        throw new Error('Item not found');
      }

      // Simple update implementation (just merge values)
      const updates = { ...item };
      if (params.ExpressionAttributeValues) {
        Object.entries(params.ExpressionAttributeValues).forEach(([placeholder, value]) => {
          // Extract attribute name from UpdateExpression
          const match = params.UpdateExpression?.match(
            new RegExp(`(\\w+)\\s*=\\s*${placeholder.replace(':', '\\:')}`)
          );
          if (match) {
            updates[match[1]] = value;
          }
        });
      }

      store.set(key, updates);
      return {};
    },

    async delete(params: any) {
      const key = `${params.Key.PK}#${params.Key.SK}`;
      store.delete(key);
      return {};
    },

    async query(params: any) {
      const items: any[] = [];

      store.forEach((item, key) => {
        let match = false;

        // Simple PK match
        if (params.KeyConditionExpression?.includes('PK = :pk')) {
          const pk = params.ExpressionAttributeValues?.[':pk'];
          if (item.PK === pk) {
            match = true;
          }
        }

        // GSI1 query
        if (params.KeyConditionExpression?.includes('GSI1-PK') || params.KeyConditionExpression?.includes('#gsi1pk')) {
          const gsi1pk = params.ExpressionAttributeValues?.[':gsi1pk'];
          if (item['GSI1-PK'] === gsi1pk) {
            match = true;
          }
        }

        if (!match) {
          return;
        }

        // Check FilterExpression if present
        if (params.FilterExpression) {
          // Simple begins_with check for SK
          if (params.FilterExpression.includes('begins_with(SK')) {
            const skPrefix = params.ExpressionAttributeValues?.[':sk'];
            if (!item.SK.startsWith(skPrefix)) {
              return;
            }
          }

          // Tenant ID check
          if (params.FilterExpression.includes('tenantId = :tid')) {
            const tid = params.ExpressionAttributeValues?.[':tid'];
            if (item.tenantId !== tid) {
              return;
            }
          }
        }

        items.push(item);
      });

      return {
        Items: params.Limit ? items.slice(0, params.Limit) : items,
      };
    },
  };
}

describe('UserPairingService', () => {
  let service: UserPairingService;
  let mockClient: DynamoDBClient & { _store: Map<string, any> };

  beforeEach(() => {
    mockClient = createMockDynamoDBClient();
    service = new UserPairingService({
      pairingsTableName: 'test-pairings',
      dynamodb: mockClient,
    });
  });

  describe('createPairing', () => {
    it('should create a new user pairing', async () => {
      const params = {
        tenantId: 'tenant-123',
        platform: 'slack' as const,
        platformUserId: 'U123456',
        cognitoSub: 'cognito-abc-123',
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
        displayName: 'John Doe',
      };

      const pairing = await service.createPairing(params);

      expect(pairing.PK).toBe('USER_PAIRING#slack#U123456');
      expect(pairing.SK).toBe('COGNITO#cognito-abc-123');
      expect(pairing['GSI1-PK']).toBe('TENANT#tenant-123');
      expect(pairing['GSI1-SK']).toBe('USER_PAIRING#slack#U123456');
      expect(pairing.tenantId).toBe('tenant-123');
      expect(pairing.platform).toBe('slack');
      expect(pairing.platformUserId).toBe('U123456');
      expect(pairing.cognitoSub).toBe('cognito-abc-123');
      expect(pairing.status).toBe('active');
    });

    it('should prevent duplicate pairings', async () => {
      const params = {
        tenantId: 'tenant-123',
        platform: 'slack' as const,
        platformUserId: 'U123456',
        cognitoSub: 'cognito-abc-123',
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
      };

      await service.createPairing(params);

      // Attempt to create duplicate
      await expect(service.createPairing(params)).rejects.toThrow();
    });
  });

  describe('getPairing', () => {
    it('should retrieve a user pairing', async () => {
      // Create pairing
      await service.createPairing({
        tenantId: 'tenant-123',
        platform: 'slack',
        platformUserId: 'U123456',
        cognitoSub: 'cognito-abc-123',
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
      });

      // Retrieve it
      const pairing = await service.getPairing({
        platform: 'slack',
        platformUserId: 'U123456',
      });

      expect(pairing).not.toBeNull();
      expect(pairing?.platformUserId).toBe('U123456');
      expect(pairing?.cognitoSub).toBe('cognito-abc-123');
    });

    it('should return null for non-existent pairing', async () => {
      const pairing = await service.getPairing({
        platform: 'slack',
        platformUserId: 'U999999',
      });

      expect(pairing).toBeNull();
    });
  });

  describe('resolveUser', () => {
    it('should resolve platform user to Cognito context', async () => {
      await service.createPairing({
        tenantId: 'tenant-123',
        platform: 'slack',
        platformUserId: 'U123456',
        cognitoSub: 'cognito-abc-123',
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
        displayName: 'John Doe',
      });

      const context = await service.resolveUser({
        platform: 'slack',
        platformUserId: 'U123456',
      });

      expect(context).not.toBeNull();
      expect(context?.tenantId).toBe('tenant-123');
      expect(context?.cognitoSub).toBe('cognito-abc-123');
      expect(context?.email).toBe('john.doe@example.com');
      expect(context?.platform).toBe('slack');
    });

    it('should return null for revoked pairings', async () => {
      await service.createPairing({
        tenantId: 'tenant-123',
        platform: 'slack',
        platformUserId: 'U123456',
        cognitoSub: 'cognito-abc-123',
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
      });

      // Revoke pairing
      await service.revokePairing({
        platform: 'slack',
        platformUserId: 'U123456',
      });

      // Should not resolve
      const context = await service.resolveUser({
        platform: 'slack',
        platformUserId: 'U123456',
      });

      expect(context).toBeNull();
    });
  });

  describe('getPairingsByCognito', () => {
    it('should retrieve all pairings for a Cognito user', async () => {
      const cognitoSub = 'cognito-abc-123';

      // Create multiple pairings for same user
      await service.createPairing({
        tenantId: 'tenant-123',
        platform: 'slack',
        platformUserId: 'U123456',
        cognitoSub,
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
      });

      await service.createPairing({
        tenantId: 'tenant-123',
        platform: 'discord',
        platformUserId: 'D789012',
        cognitoSub,
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
      });

      const pairings = await service.getPairingsByCognito({
        tenantId: 'tenant-123',
        cognitoSub,
      });

      expect(pairings).toHaveLength(2);
      expect(pairings.map(p => p.platform).sort()).toEqual(['discord', 'slack']);
    });

    it('should enforce tenant isolation', async () => {
      // Create pairing in tenant-123
      await service.createPairing({
        tenantId: 'tenant-123',
        platform: 'slack',
        platformUserId: 'U123456',
        cognitoSub: 'cognito-abc-123',
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
      });

      // Query from different tenant
      const pairings = await service.getPairingsByCognito({
        tenantId: 'tenant-999',
        cognitoSub: 'cognito-abc-123',
      });

      // Should not return pairings from other tenant
      expect(pairings).toHaveLength(0);
    });
  });

  describe('updatePairing', () => {
    it('should update pairing metadata', async () => {
      await service.createPairing({
        tenantId: 'tenant-123',
        platform: 'slack',
        platformUserId: 'U123456',
        cognitoSub: 'cognito-abc-123',
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
        displayName: 'John Doe',
      });

      await service.updatePairing({
        platform: 'slack',
        platformUserId: 'U123456',
        displayName: 'John M. Doe',
        avatarUrl: 'https://example.com/avatar.jpg',
      });

      const updated = await service.getPairing({
        platform: 'slack',
        platformUserId: 'U123456',
      });

      expect(updated?.displayName).toBe('John M. Doe');
      expect(updated?.avatarUrl).toBe('https://example.com/avatar.jpg');
    });
  });

  describe('revokePairing', () => {
    it('should mark pairing as revoked', async () => {
      await service.createPairing({
        tenantId: 'tenant-123',
        platform: 'slack',
        platformUserId: 'U123456',
        cognitoSub: 'cognito-abc-123',
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
      });

      await service.revokePairing({
        platform: 'slack',
        platformUserId: 'U123456',
      });

      const revoked = await service.getPairing({
        platform: 'slack',
        platformUserId: 'U123456',
      });

      expect(revoked?.status).toBe('revoked');
    });
  });

  describe('deletePairing', () => {
    it('should permanently delete pairing', async () => {
      await service.createPairing({
        tenantId: 'tenant-123',
        platform: 'slack',
        platformUserId: 'U123456',
        cognitoSub: 'cognito-abc-123',
        cognitoUsername: 'john.doe',
        email: 'john.doe@example.com',
      });

      await service.deletePairing({
        platform: 'slack',
        platformUserId: 'U123456',
      });

      const deleted = await service.getPairing({
        platform: 'slack',
        platformUserId: 'U123456',
      });

      expect(deleted).toBeNull();
    });
  });
});
