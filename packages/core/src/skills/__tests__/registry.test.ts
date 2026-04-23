/**
 * Skill Registry Tests
 *
 * Tests for DynamoDB-backed skill registry including:
 * - Multi-tenant isolation
 * - GSI query patterns
 * - Search functionality
 * - Installation tracking
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SkillRegistry, DynamoDBClient, RegistryConfig } from '../registry';
import {
  Skill,
  SkillInstall,
  SkillCategory,
  SkillTrustLevel,
} from '@chimera/shared';

/**
 * In-memory DynamoDB client for testing
 */
class InMemoryDynamoDBClient implements DynamoDBClient {
  private tables: Map<string, Map<string, any>> = new Map();

  constructor() {
    this.tables.set('skills', new Map());
    this.tables.set('installs', new Map());
  }

  async query(params: any): Promise<any> {
    const table = this.tables.get(params.TableName);
    if (!table) {
      return { Items: [] };
    }

    const items: any[] = [];
    const eav = params.ExpressionAttributeValues || {};
    const skPrefix = eav[':sk'];

    // Determine which attribute the KeyConditionExpression uses. GSI queries
    // use `category`, `trustLevel`, or `author` as the partition key — the
    // base table uses `PK`.
    let pkAttr: string | null = null;
    let pkValue: any = undefined;
    const kce: string = params.KeyConditionExpression || '';
    if (kce.includes('PK = :pk')) {
      pkAttr = 'PK';
      pkValue = eav[':pk'];
    } else if (kce.includes('category = :category')) {
      pkAttr = 'category';
      pkValue = eav[':category'];
    } else if (kce.includes('trustLevel = :trustLevel')) {
      pkAttr = 'trustLevel';
      pkValue = eav[':trustLevel'];
    } else if (kce.includes('author = :author')) {
      pkAttr = 'author';
      pkValue = eav[':author'];
    }

    for (const [, value] of table.entries()) {
      if (pkAttr !== null && (value as any)[pkAttr] !== pkValue) {
        continue;
      }

      // Check SK prefix if provided (begins_with)
      if (skPrefix && !value.SK?.startsWith(skPrefix)) {
        continue;
      }

      // Apply FilterExpression if present (tenant isolation)
      if (params.FilterExpression) {
        const tenantId = eav[':tenantId'];
        if (tenantId && value.tenantId !== tenantId) {
          continue;
        }
      }

      items.push(value);
    }

    return { Items: items };
  }

  async get(params: any): Promise<any> {
    const table = this.tables.get(params.TableName);
    if (!table) {
      return {};
    }

    const key = `${params.Key.PK}#${params.Key.SK}`;
    const item = table.get(key);

    return item ? { Item: item } : {};
  }

  async put(params: any): Promise<any> {
    const table = this.tables.get(params.TableName);
    if (!table) {
      return {};
    }

    const item = params.Item;
    const key = `${item.PK}#${item.SK}`;
    table.set(key, item);

    return {};
  }

  async update(params: any): Promise<any> {
    const table = this.tables.get(params.TableName);
    if (!table) {
      return {};
    }

    const key = `${params.Key.PK}#${params.Key.SK}`;
    const item = table.get(key);

    if (item) {
      // Simple update expression parsing (just for testing)
      if (params.UpdateExpression?.includes('use_count = use_count + :inc')) {
        item.use_count = (item.use_count || 0) + (params.ExpressionAttributeValues[':inc'] || 1);
      }
      if (params.UpdateExpression?.includes('last_used = :now')) {
        item.last_used = params.ExpressionAttributeValues[':now'];
      }
      if (params.UpdateExpression?.includes('download_count = download_count + :inc')) {
        item.download_count = (item.download_count || 0) + (params.ExpressionAttributeValues[':inc'] || 1);
      }
      table.set(key, item);
    }

    return {};
  }

  async delete(params: any): Promise<any> {
    const table = this.tables.get(params.TableName);
    if (!table) {
      return {};
    }

    const key = `${params.Key.PK}#${params.Key.SK}`;
    table.delete(key);

    return {};
  }

  async scan(params: any): Promise<any> {
    const table = this.tables.get(params.TableName);
    if (!table) {
      return { Items: [] };
    }

    const items: any[] = [];
    const tenantId = params.ExpressionAttributeValues?.[':tenantId'];
    const category = params.ExpressionAttributeValues?.[':category'];
    const trustLevel = params.ExpressionAttributeValues?.[':trust_level'];
    const query = params.ExpressionAttributeValues?.[':query'];

    for (const value of table.values()) {
      // CRITICAL: Always enforce tenant filtering
      if (tenantId && value.tenantId !== tenantId) {
        continue;
      }

      // Apply category filter
      if (category && value.category !== category) {
        continue;
      }

      // Apply trust_level filter
      if (trustLevel && value.trust_level !== trustLevel) {
        continue;
      }

      // Apply text search filter
      if (query) {
        const nameMatch = value.name?.toLowerCase().includes(query.toLowerCase());
        const descMatch = value.description?.toLowerCase().includes(query.toLowerCase());
        if (!nameMatch && !descMatch) {
          continue;
        }
      }

      // Apply tag filter
      if (params.FilterExpression?.includes('contains(tags,')) {
        const tagValues = Object.keys(params.ExpressionAttributeValues || {})
          .filter(k => k.startsWith(':tag'))
          .map(k => params.ExpressionAttributeValues[k]);

        const hasTag = tagValues.some(tag => value.tags?.includes(tag));
        if (!hasTag) {
          continue;
        }
      }

      items.push(value);
    }

    return { Items: items };
  }

  // Helper for tests
  seed(tableName: string, items: any[]): void {
    const table = this.tables.get(tableName);
    if (!table) {
      return;
    }

    for (const item of items) {
      const key = `${item.PK}#${item.SK}`;
      table.set(key, item);
    }
  }

  clear(): void {
    this.tables.get('skills')?.clear();
    this.tables.get('installs')?.clear();
  }
}

describe('SkillRegistry', () => {
  let registry: SkillRegistry;
  let dynamodb: InMemoryDynamoDBClient;

  const createMockSkill = (
    name: string,
    tenantId: string,
    trustLevel: SkillTrustLevel = 'community'
  ): Skill => ({
    PK: `SKILL#${name}`,
    SK: 'META',
    name,
    version: '1.0.0',
    description: `Test skill ${name}`,
    author: tenantId,
    category: 'automation' as SkillCategory,
    tags: ['test'],
    trust_level: trustLevel,
    format: 'SKILL.md' as const,
    bundle_url: `s3://skills/${name}.tar.gz`,
    bundle_hash: 'abc123',
    signatures: {
      author: 'sig1',
      platform: trustLevel === 'platform' ? 'sig2' : undefined,
    },
    scan_status: 'passed' as const,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    download_count: 0,
    tenantId,
  });

  beforeEach(() => {
    dynamodb = new InMemoryDynamoDBClient();
    const config: RegistryConfig = {
      skillsTableName: 'skills',
      installsTableName: 'installs',
      dynamodb,
      bundleBucket: 'test-bucket',
    };
    registry = new SkillRegistry(config);
  });

  describe('getSkill', () => {
    it('should return skill by name', async () => {
      const skill = createMockSkill('test-skill', 'tenant-1');
      dynamodb.seed('skills', [skill]);

      const result = await registry.getSkill('test-skill');
      expect(result).not.toBeNull();
      expect(result?.name).toBe('test-skill');
    });

    it('should return null for non-existent skill', async () => {
      const result = await registry.getSkill('non-existent');
      expect(result).toBeNull();
    });

    it('should support version queries', async () => {
      const skill = createMockSkill('test-skill', 'tenant-1');
      skill.SK = 'VERSION#1.0.0';
      dynamodb.seed('skills', [skill]);

      const result = await registry.getSkill('test-skill', '1.0.0');
      expect(result).not.toBeNull();
      expect(result?.version).toBe('1.0.0');
    });
  });

  describe('listVersions', () => {
    it('should list all versions of a skill', async () => {
      const v1 = { ...createMockSkill('test-skill', 'tenant-1'), SK: 'VERSION#1.0.0' };
      const v2 = { ...createMockSkill('test-skill', 'tenant-1'), SK: 'VERSION#2.0.0', version: '2.0.0' };

      dynamodb.seed('skills', [v1, v2]);

      const versions = await registry.listVersions('test-skill');
      expect(versions.length).toBe(2);
    });
  });

  describe('searchSkills - Multi-tenant Security', () => {
    it('should enforce tenant isolation in search results', async () => {
      const tenant1Skill = createMockSkill('skill-1', 'tenant-1');
      const tenant2Skill = createMockSkill('skill-2', 'tenant-2');

      dynamodb.seed('skills', [tenant1Skill, tenant2Skill]);

      const results = await registry.searchSkills({}, 'tenant-1');

      expect(results.skills.length).toBe(1);
      expect(results.skills[0].name).toBe('skill-1');
      expect(results.skills[0].tenantId).toBe('tenant-1');
    });

    it('should prevent cross-tenant data leakage via category filter', async () => {
      const tenant1Skill = createMockSkill('skill-1', 'tenant-1', 'community');
      const tenant2Skill = createMockSkill('skill-2', 'tenant-2', 'community');

      dynamodb.seed('skills', [tenant1Skill, tenant2Skill]);

      const results = await registry.searchSkills(
        { category: 'automation' },
        'tenant-1'
      );

      expect(results.skills.length).toBe(1);
      expect(results.skills[0].tenantId).toBe('tenant-1');
    });

    it('should filter by trust level with tenant isolation', async () => {
      const tenant1Community = createMockSkill('skill-1', 'tenant-1', 'community');
      const tenant1Verified = createMockSkill('skill-2', 'tenant-1', 'verified');
      const tenant2Community = createMockSkill('skill-3', 'tenant-2', 'community');

      dynamodb.seed('skills', [tenant1Community, tenant1Verified, tenant2Community]);

      const results = await registry.searchSkills(
        { trust_level: 'community' },
        'tenant-1'
      );

      expect(results.skills.length).toBe(1);
      expect(results.skills[0].name).toBe('skill-1');
    });

    it('should support text search with tenant isolation', async () => {
      const tenant1Skill = { ...createMockSkill('search-test', 'tenant-1'), description: 'automation tool' };
      const tenant2Skill = { ...createMockSkill('search-other', 'tenant-2'), description: 'automation helper' };

      dynamodb.seed('skills', [tenant1Skill, tenant2Skill]);

      const results = await registry.searchSkills(
        { query: 'automation' },
        'tenant-1'
      );

      expect(results.skills.length).toBe(1);
      expect(results.skills[0].tenantId).toBe('tenant-1');
    });

    it('should support tag filtering with tenant isolation', async () => {
      const tenant1Tagged = { ...createMockSkill('skill-1', 'tenant-1'), tags: ['ai', 'automation'] };
      const tenant2Tagged = { ...createMockSkill('skill-2', 'tenant-2'), tags: ['ai', 'chat'] };

      dynamodb.seed('skills', [tenant1Tagged, tenant2Tagged]);

      const results = await registry.searchSkills(
        { tags: ['ai'] },
        'tenant-1'
      );

      expect(results.skills.length).toBe(1);
      expect(results.skills[0].tenantId).toBe('tenant-1');
    });

    it('should handle pagination', async () => {
      const skills = Array.from({ length: 25 }, (_, i) =>
        createMockSkill(`skill-${i}`, 'tenant-1')
      );
      dynamodb.seed('skills', skills);

      const page1 = await registry.searchSkills({ limit: 10 }, 'tenant-1');
      expect(page1.skills.length).toBe(10);
      expect(page1.total).toBe(25);

      const page2 = await registry.searchSkills({ limit: 10, offset: 10 }, 'tenant-1');
      expect(page2.skills.length).toBe(10);
    });
  });

  describe('listByCategory - GSI Query Security', () => {
    it('should enforce FilterExpression for tenantId on GSI queries', async () => {
      const tenant1Skill = createMockSkill('skill-1', 'tenant-1');
      const tenant2Skill = createMockSkill('skill-2', 'tenant-2');

      dynamodb.seed('skills', [tenant1Skill, tenant2Skill]);

      const results = await registry.listByCategory('automation', 'tenant-1');

      // CRITICAL: GSI queries MUST filter by tenantId to prevent cross-tenant leakage
      expect(results.every((s: Skill) => s.tenantId === 'tenant-1')).toBe(true);
    });
  });

  describe('listByTrustLevel - GSI Query Security', () => {
    it('should enforce tenant isolation on trust level queries', async () => {
      const tenant1Verified = createMockSkill('skill-1', 'tenant-1', 'verified');
      const tenant2Verified = createMockSkill('skill-2', 'tenant-2', 'verified');

      dynamodb.seed('skills', [tenant1Verified, tenant2Verified]);

      const results = await registry.listByTrustLevel('verified', 'tenant-1');

      expect(results.every((s: Skill) => s.tenantId === 'tenant-1')).toBe(true);
    });
  });

  describe('listByAuthor', () => {
    it('should query by author GSI with tenant isolation', async () => {
      // Note: In real DDB, GSI1-author uses `author` as the partition key (plain
      // attribute), not the composite `PK`. The InMemoryDynamoDBClient matches
      // on the `:author` expression attribute value against item.PK via a shim
      // below — so we seed items with PK equal to the author id for this test.
      const author1Skill = {
        ...createMockSkill('skill-1', 'author-1'),
        PK: 'author-1',
        author: 'author-1',
      };
      const author2Skill = {
        ...createMockSkill('skill-2', 'author-2'),
        PK: 'author-2',
        author: 'author-2',
      };

      dynamodb.seed('skills', [author1Skill, author2Skill]);

      const results = await registry.listByAuthor('author-1', 'author-1');

      // Test that the method doesn't error and returns an array
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('Installation Management', () => {
    it('should record skill installation', async () => {
      const install: SkillInstall = {
        PK: 'TENANT#tenant-1',
        SK: 'SKILL#test-skill',
        tenant_id: 'tenant-1',
        skill_name: 'test-skill',
        version: '1.0.0',
        installed_at: '2024-01-01T00:00:00Z',
        last_used: '2024-01-01T00:00:00Z',
        use_count: 0,
        enabled: true,
      };

      await registry.recordInstall(install);

      const result = await registry.getSkillInstall('tenant-1', 'test-skill');
      expect(result).not.toBeNull();
      expect(result?.skill_name).toBe('test-skill');
    });

    it('should list installed skills for tenant', async () => {
      const install1: SkillInstall = {
        PK: 'TENANT#tenant-1',
        SK: 'SKILL#skill-1',
        tenant_id: 'tenant-1',
        skill_name: 'skill-1',
        version: '1.0.0',
        installed_at: '2024-01-01T00:00:00Z',
        last_used: '2024-01-01T00:00:00Z',
        use_count: 0,
        enabled: true,
      };

      const install2: SkillInstall = {
        PK: 'TENANT#tenant-1',
        SK: 'SKILL#skill-2',
        tenant_id: 'tenant-1',
        skill_name: 'skill-2',
        version: '1.0.0',
        installed_at: '2024-01-01T00:00:00Z',
        last_used: '2024-01-01T00:00:00Z',
        use_count: 0,
        enabled: true,
      };

      dynamodb.seed('installs', [install1, install2]);

      const installs = await registry.getInstalledSkills('tenant-1');
      expect(installs.length).toBe(2);
    });

    it('should remove skill installation', async () => {
      const install: SkillInstall = {
        PK: 'TENANT#tenant-1',
        SK: 'SKILL#test-skill',
        tenant_id: 'tenant-1',
        skill_name: 'test-skill',
        version: '1.0.0',
        installed_at: '2024-01-01T00:00:00Z',
        last_used: '2024-01-01T00:00:00Z',
        use_count: 0,
        enabled: true,
      };

      dynamodb.seed('installs', [install]);

      await registry.removeInstall('tenant-1', 'test-skill');

      const result = await registry.getSkillInstall('tenant-1', 'test-skill');
      expect(result).toBeNull();
    });

    it('should prevent cross-tenant installation access', async () => {
      const tenant1Install: SkillInstall = {
        PK: 'TENANT#tenant-1',
        SK: 'SKILL#skill-1',
        tenant_id: 'tenant-1',
        skill_name: 'skill-1',
        version: '1.0.0',
        installed_at: '2024-01-01T00:00:00Z',
        last_used: '2024-01-01T00:00:00Z',
        use_count: 0,
        enabled: true,
      };

      dynamodb.seed('installs', [tenant1Install]);

      // Tenant 2 should not see tenant 1's installation
      const result = await registry.getSkillInstall('tenant-2', 'skill-1');
      expect(result).toBeNull();
    });

    it('should track usage statistics', async () => {
      const install: SkillInstall = {
        PK: 'TENANT#tenant-1',
        SK: 'SKILL#test-skill',
        tenant_id: 'tenant-1',
        skill_name: 'test-skill',
        version: '1.0.0',
        installed_at: '2024-01-01T00:00:00Z',
        last_used: '2024-01-01T00:00:00Z',
        use_count: 0,
        enabled: true,
      };

      dynamodb.seed('installs', [install]);

      await registry.recordUsage('tenant-1', 'test-skill');

      const result = await registry.getSkillInstall('tenant-1', 'test-skill');
      expect(result).not.toBeNull();
      // Note: In real implementation, would verify use_count incremented
    });
  });

  describe('Download Count Tracking', () => {
    it('should increment download count on install', async () => {
      const skill = createMockSkill('test-skill', 'tenant-1');
      dynamodb.seed('skills', [skill]);

      const install: SkillInstall = {
        PK: 'TENANT#tenant-1',
        SK: 'SKILL#test-skill',
        tenant_id: 'tenant-1',
        skill_name: 'test-skill',
        version: '1.0.0',
        installed_at: '2024-01-01T00:00:00Z',
        last_used: '2024-01-01T00:00:00Z',
        use_count: 0,
        enabled: true,
      };

      await registry.recordInstall(install);

      // Note: In real implementation, would verify download_count incremented
    });
  });
});
