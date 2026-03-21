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

/**
 * DynamoDB client interface (placeholder for AWS SDK)
 */
export interface DynamoDBClient {
  query(params: any): Promise<any>;
  put(params: any): Promise<any>;
  update(params: any): Promise<any>;
  delete(params: any): Promise<any>;
  get(params: any): Promise<any>;
  scan(params: any): Promise<any>;
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

    const params: {
      TableName: string;
      FilterExpression: string;
      ExpressionAttributeValues: Record<string, any>;
      ExpressionAttributeNames?: Record<string, string>;
      Limit: number;
    } = {
      TableName: this.config.skillsTableName,
      FilterExpression: filterExpressions.join(' AND '),
      ExpressionAttributeValues: expressionValues,
      ExpressionAttributeNames: request.query ? { '#name': 'name' } : undefined,
      Limit: limit,
    };

    const result = await this.config.dynamodb.scan(params);
    const skills = (result.Items || []) as Skill[];

    // Filter to only META items (not VERSION items)
    const metaSkills = skills.filter(skill => skill.SK === 'META');

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
   * Uses GSI-2 (Category Index) for efficient querying
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
      IndexName: 'GSI-2',
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':pk': `CATEGORY#${category}`,
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
   * Uses GSI-3 (Trust Level Index) for efficient querying
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
      IndexName: 'GSI-3',
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':pk': `TRUST#${trustLevel}`,
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
   * Uses GSI-1 (Author Index) for efficient querying
   *
   * @param author - Author tenant ID
   * @param limit - Max results
   * @returns Skills by author
   */
  async listByAuthor(author: string, limit: number = 20): Promise<Skill[]> {
    const params = {
      TableName: this.config.skillsTableName,
      IndexName: 'GSI-1',
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `AUTHOR#${author}`,
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
