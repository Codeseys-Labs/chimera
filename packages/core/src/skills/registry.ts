/**
 * Skill Registry Service
 *
 * DynamoDB-backed skill registry for marketplace and installed skills
 * Implements the skills table schema from canonical-data-model.md
 */

import {
  Skill,
  SkillInstall,
  SkillCategory,
  SkillTrustLevel,
  SkillSearchResult,
  SearchSkillsRequest,
} from '@chimera/shared';

import type {
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
  DeleteCommandInput,
  DeleteCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  ScanCommandInput,
  ScanCommandOutput,
} from '@aws-sdk/lib-dynamodb';

/**
 * DynamoDB client interface
 */
export interface DynamoDBClient {
  query(params: QueryCommandInput): Promise<QueryCommandOutput>;
  put(params: PutCommandInput): Promise<PutCommandOutput>;
  update(params: UpdateCommandInput): Promise<UpdateCommandOutput>;
  delete(params: DeleteCommandInput): Promise<DeleteCommandOutput>;
  get(params: GetCommandInput): Promise<GetCommandOutput>;
  scan(params: ScanCommandInput): Promise<ScanCommandOutput>;
}

/**
 * Registry configuration
 */
export interface RegistryConfig {
  /** DynamoDB table name for skills */
  skillsTableName: string;

  /** DynamoDB table name for skill installs */
  installsTableName: string;

  /** DynamoDB client */
  dynamodb: DynamoDBClient;

  /** S3 bucket for skill bundles */
  bundleBucket: string;
}

/**
 * Skill Registry Service
 *
 * Manages skill metadata, installations, and discovery
 */
export class SkillRegistry {
  private config: RegistryConfig;

  constructor(config: RegistryConfig) {
    this.config = config;
  }

  /**
   * Get skill by name and version
   *
   * @param name - Skill name
   * @param version - Skill version (optional, returns latest if omitted)
   * @returns Skill metadata or null
   */
  async getSkill(name: string, version?: string): Promise<Skill | null> {
    const params = {
      TableName: this.config.skillsTableName,
      Key: {
        PK: `SKILL#${name}`,
        SK: version ? `VERSION#${version}` : 'META',
      },
    };

    const result = await this.config.dynamodb.get(params);
    return result.Item ? (result.Item as Skill) : null;
  }

  /**
   * List all versions of a skill
   *
   * @param name - Skill name
   * @returns Array of skill versions
   */
  async listVersions(name: string): Promise<Skill[]> {
    const params = {
      TableName: this.config.skillsTableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `SKILL#${name}`,
        ':sk': 'VERSION#',
      },
    };

    const result = await this.config.dynamodb.query(params);
    return (result.Items || []) as Skill[];
  }

  /**
   * Search skills by query
   *
   * Supports:
   * - Category filtering
   * - Trust level filtering
   * - Tag filtering
   * - Full-text search (name, description)
   *
   * @param request - Search request
   * @param tenantId - Tenant ID for security filtering
   * @returns Search results
   */
  async searchSkills(request: SearchSkillsRequest, tenantId: string): Promise<SkillSearchResult> {
    const limit = request.limit || 20;
    const offset = request.offset || 0;

    // Build filter expression
    const filterExpressions: string[] = [];
    const expressionValues: Record<string, any> = {};

    // CRITICAL: Always filter by tenantId for multi-tenant isolation
    filterExpressions.push('tenantId = :tenantId');
    expressionValues[':tenantId'] = tenantId;

    if (request.category) {
      filterExpressions.push('category = :category');
      expressionValues[':category'] = request.category;
    }

    if (request.trust_level) {
      filterExpressions.push('trust_level = :trust_level');
      expressionValues[':trust_level'] = request.trust_level;
    }

    // For tags, check if any tag in the request matches
    if (request.tags && request.tags.length > 0) {
      const tagFilters = request.tags.map((tag: string, idx: number) => {
        expressionValues[`:tag${idx}`] = tag;
        return `contains(tags, :tag${idx})`;
      });
      filterExpressions.push(`(${tagFilters.join(' OR ')})`);
    }

    // Text search on name and description
    if (request.query) {
      const queryLower = request.query.toLowerCase();
      filterExpressions.push(
        '(contains(#name, :query) OR contains(description, :query))'
      );
      expressionValues[':query'] = queryLower;
    }

    // DynamoDB Scan Limit is applied PRE-filter: with 10k items in the
    // table and Limit=20, a single scan may evaluate 20 items and match
    // zero after the tenantId/category/etc. filters. To return up to
    // `limit` post-filter META items, paginate with ExclusiveStartKey
    // until enough results accumulate or we hit a safety ceiling.
    //
    // Safety ceiling: MAX_SCANNED_ITEMS bounds total items examined so
    // an unrelated tenant's 100k-skill table can't turn a stray search
    // into an unbounded read. A 2000-item ceiling at ~1 KB average is
    // ~1 MB read, which is 250 RCUs (eventual consistency) — well under
    // DDB per-request soft limits.
    const MAX_SCANNED_ITEMS = 2000;
    // Per-page scan size: 400 balances round-trips vs. over-reading.
    const PAGE_SIZE = 400;

    const metaSkills: Skill[] = [];
    let scannedCount = 0;
    let exclusiveStartKey: Record<string, any> | undefined = undefined;

    do {
      const params: {
        TableName: string;
        FilterExpression: string;
        ExpressionAttributeValues: Record<string, any>;
        ExpressionAttributeNames?: Record<string, string>;
        Limit: number;
        ExclusiveStartKey?: Record<string, any>;
      } = {
        TableName: this.config.skillsTableName,
        FilterExpression: filterExpressions.join(' AND '),
        ExpressionAttributeValues: expressionValues,
        ExpressionAttributeNames: request.query ? { '#name': 'name' } : undefined,
        Limit: PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      };

      const result = await this.config.dynamodb.scan(params);
      const pageSkills = (result.Items || []) as Skill[];
      scannedCount += result.ScannedCount ?? pageSkills.length;

      // Filter to only META items (not VERSION items)
      for (const skill of pageSkills) {
        if (skill.SK === 'META') {
          metaSkills.push(skill);
        }
      }

      exclusiveStartKey = result.LastEvaluatedKey;

      // Stop once we have enough to fulfill `offset + limit` OR we've
      // hit the safety ceiling.
      if (metaSkills.length >= offset + limit) break;
      if (scannedCount >= MAX_SCANNED_ITEMS) break;
    } while (exclusiveStartKey !== undefined);

    return {
      skills: metaSkills.slice(offset, offset + limit),
      total: metaSkills.length,
      offset,
      limit,
    };
  }

  /**
   * List skills by category
   *
   * Uses GSI2-category (Category Index) for efficient querying.
   * GSI partition key is `category` (plain attribute), sort key is `downloadCount`.
   *
   * @param category - Skill category
   * @param tenantId - Tenant ID for security filtering
   * @param limit - Max results
   * @returns Skills in category, sorted by popularity
   */
  async listByCategory(
    category: SkillCategory,
    tenantId: string,
    limit: number = 20
  ): Promise<Skill[]> {
    const params = {
      TableName: this.config.skillsTableName,
      IndexName: 'GSI2-category',
      KeyConditionExpression: 'category = :category',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':category': category,
        ':tenantId': tenantId,
      },
      Limit: limit,
      ScanIndexForward: false, // Descending order (most downloads first)
    };

    const result = await this.config.dynamodb.query(params);
    return (result.Items || []) as Skill[];
  }

  /**
   * List skills by trust level
   *
   * Uses GSI3-trust (Trust Level Index) for efficient querying.
   * GSI partition key is `trustLevel` (plain attribute), sort key is `updatedAt`.
   *
   * @param trustLevel - Trust level
   * @param tenantId - Tenant ID for security filtering
   * @param limit - Max results
   * @returns Skills at trust level, sorted by recency
   */
  async listByTrustLevel(
    trustLevel: SkillTrustLevel,
    tenantId: string,
    limit: number = 20
  ): Promise<Skill[]> {
    const params = {
      TableName: this.config.skillsTableName,
      IndexName: 'GSI3-trust',
      KeyConditionExpression: 'trustLevel = :trustLevel',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':trustLevel': trustLevel,
        ':tenantId': tenantId,
      },
      Limit: limit,
      ScanIndexForward: false, // Descending order (most recent first)
    };

    const result = await this.config.dynamodb.query(params);
    return (result.Items || []) as Skill[];
  }

  /**
   * List skills by author
   *
   * Uses GSI1-author (Author Index) for efficient querying.
   * GSI partition key is `author` (plain attribute), sort key is `skillName`.
   *
   * @param author - Author tenant ID
   * @param tenantId - Tenant ID for security filtering
   * @param limit - Max results
   * @returns Skills by author
   */
  async listByAuthor(author: string, tenantId: string, limit: number = 20): Promise<Skill[]> {
    const params = {
      TableName: this.config.skillsTableName,
      IndexName: 'GSI1-author',
      KeyConditionExpression: 'author = :author',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':author': author,
        ':tenantId': tenantId,
      },
      Limit: limit,
    };

    const result = await this.config.dynamodb.query(params);
    return (result.Items || []) as Skill[];
  }

  /**
   * Get installed skills for a tenant
   *
   * @param tenantId - Tenant identifier
   * @returns Array of skill installs
   */
  async getInstalledSkills(tenantId: string): Promise<SkillInstall[]> {
    const params = {
      TableName: this.config.installsTableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}`,
      },
    };

    const result = await this.config.dynamodb.query(params);
    return (result.Items || []) as SkillInstall[];
  }

  /**
   * Check if skill is installed for tenant
   *
   * @param tenantId - Tenant identifier
   * @param skillName - Skill name
   * @returns Skill install record or null
   */
  async getSkillInstall(
    tenantId: string,
    skillName: string
  ): Promise<SkillInstall | null> {
    const params = {
      TableName: this.config.installsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `SKILL#${skillName}`,
      },
    };

    const result = await this.config.dynamodb.get(params);
    return result.Item ? (result.Item as SkillInstall) : null;
  }

  /**
   * Record skill installation
   *
   * @param install - Skill install record
   */
  async recordInstall(install: SkillInstall): Promise<void> {
    const params = {
      TableName: this.config.installsTableName,
      Item: install,
    };

    await this.config.dynamodb.put(params);

    // Increment download count on skill
    await this.incrementDownloadCount(install.skill_name);
  }

  /**
   * Remove skill installation
   *
   * @param tenantId - Tenant identifier
   * @param skillName - Skill name
   */
  async removeInstall(tenantId: string, skillName: string): Promise<void> {
    const params = {
      TableName: this.config.installsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `SKILL#${skillName}`,
      },
    };

    await this.config.dynamodb.delete(params);
  }

  /**
   * Update skill usage stats
   *
   * @param tenantId - Tenant identifier
   * @param skillName - Skill name
   */
  async recordUsage(tenantId: string, skillName: string): Promise<void> {
    const now = new Date().toISOString();

    const params = {
      TableName: this.config.installsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `SKILL#${skillName}`,
      },
      UpdateExpression: 'SET last_used = :now, use_count = use_count + :inc',
      ExpressionAttributeValues: {
        ':now': now,
        ':inc': 1,
      },
    };

    await this.config.dynamodb.update(params);
  }

  /**
   * Increment download count (private helper)
   */
  private async incrementDownloadCount(skillName: string): Promise<void> {
    const params = {
      TableName: this.config.skillsTableName,
      Key: {
        PK: `SKILL#${skillName}`,
        SK: 'META',
      },
      UpdateExpression: 'SET download_count = download_count + :inc',
      ExpressionAttributeValues: {
        ':inc': 1,
      },
    };

    await this.config.dynamodb.update(params);
  }

  /**
   * Get registry statistics
   */
  async getStats(): Promise<{
    totalSkills: number;
    byCategory: Record<SkillCategory, number>;
    byTrustLevel: Record<SkillTrustLevel, number>;
  }> {
    // This would typically use DynamoDB metrics or a cached aggregate
    // For now, return placeholder
    return {
      totalSkills: 0,
      byCategory: {} as Record<SkillCategory, number>,
      byTrustLevel: {} as Record<SkillTrustLevel, number>,
    };
  }
}
