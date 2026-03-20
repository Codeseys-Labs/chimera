/**
 * Skill Discovery Service
 *
 * Two-tier search strategy:
 * 1. Semantic search via Bedrock Knowledge Base
 * 2. Full-text search via OpenSearch (or DynamoDB scan for MVP)
 *
 * Reference: Chimera-Skill-Ecosystem-Design.md section 3.4
 */

import { Skill, SkillCategory, SkillTrustLevel } from '@chimera/shared';
import { SkillRegistry } from './registry';

/**
 * Search result with relevance score
 */
export interface SearchResult {
  skill: Skill;
  score: number;
  match_reason: string;
}

/**
 * Discovery filters
 */
export interface DiscoveryFilters {
  category?: SkillCategory;
  trust_level?: SkillTrustLevel;
  tags?: string[];
  author?: string;
  min_rating?: number;
  min_downloads?: number;
}

/**
 * Discovery configuration
 */
export interface DiscoveryConfig {
  /** Skill registry */
  registry: SkillRegistry;

  /** Bedrock Knowledge Base ID (for semantic search) */
  knowledgeBaseId?: string;

  /** OpenSearch endpoint (for full-text search) */
  openSearchEndpoint?: string;

  /** Enable semantic search */
  enableSemanticSearch?: boolean;
}

/**
 * Bedrock Knowledge Base client interface (placeholder)
 */
export interface BedrockKBClient {
  query(params: any): Promise<any>;
}

/**
 * OpenSearch client interface (placeholder)
 */
export interface OpenSearchClient {
  search(params: any): Promise<any>;
}

/**
 * Skill Discovery Service
 *
 * Provides semantic and full-text search over skill marketplace
 */
export class SkillDiscovery {
  private config: DiscoveryConfig;
  private bedrockKB?: BedrockKBClient;
  private openSearch?: OpenSearchClient;

  constructor(config: DiscoveryConfig) {
    this.config = config;
  }

  /**
   * Set Bedrock Knowledge Base client
   */
  setBedrockKB(client: BedrockKBClient): void {
    this.bedrockKB = client;
  }

  /**
   * Set OpenSearch client
   */
  setOpenSearch(client: OpenSearchClient): void {
    this.openSearch = client;
  }

  /**
   * Search skills using natural language query
   *
   * Uses semantic search if available, otherwise falls back to keyword search
   *
   * @param query - Natural language query
   * @param tenantId - Tenant ID for security filtering
   * @param filters - Optional filters
   * @param limit - Max results
   * @returns Ranked search results
   */
  async search(
    query: string,
    tenantId: string,
    filters?: DiscoveryFilters,
    limit: number = 10
  ): Promise<SearchResult[]> {
    // Try semantic search first (if enabled and client available)
    if (this.config.enableSemanticSearch && this.bedrockKB) {
      return this.semanticSearch(query, filters, limit);
    }

    // Fall back to keyword search
    return this.keywordSearch(query, tenantId, filters, limit);
  }

  /**
   * Semantic search using Bedrock Knowledge Base
   *
   * Embeds query using Titan Embeddings V2 and retrieves relevant skills
   *
   * @param query - Natural language query
   * @param filters - Optional filters
   * @param limit - Max results
   * @returns Ranked search results
   */
  async semanticSearch(
    query: string,
    filters?: DiscoveryFilters,
    limit: number = 10
  ): Promise<SearchResult[]> {
    if (!this.bedrockKB || !this.config.knowledgeBaseId) {
      throw new Error('Bedrock Knowledge Base not configured');
    }

    // Query Knowledge Base
    const kbResponse = await this.bedrockKB.query({
      knowledgeBaseId: this.config.knowledgeBaseId,
      retrievalQuery: {
        text: query,
      },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: limit,
        },
      },
    });

    // Map KB results to skills
    const results: SearchResult[] = [];

    for (const result of kbResponse.retrievalResults || []) {
      // Extract skill name from metadata
      const skillName = result.metadata?.skill_name;
      if (!skillName) continue;

      // Get skill from registry
      const skill: Skill | null = await this.config.registry.getSkill(skillName);
      if (!skill) continue;

      // Apply filters
      if (filters && !this.matchesFilters(skill, filters)) {
        continue;
      }

      results.push({
        skill,
        score: result.score || 0,
        match_reason: `Semantic match: ${result.content?.text?.substring(0, 100)}...`,
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Keyword search using OpenSearch or DynamoDB scan
   *
   * @param query - Search query
   * @param tenantId - Tenant ID for security filtering
   * @param filters - Optional filters
   * @param limit - Max results
   * @returns Ranked search results
   */
  async keywordSearch(
    query: string,
    tenantId: string,
    filters?: DiscoveryFilters,
    limit: number = 10
  ): Promise<SearchResult[]> {
    if (this.openSearch && this.config.openSearchEndpoint) {
      return this.openSearchQuery(query, filters, limit);
    }

    // Fall back to registry search (DynamoDB scan)
    return this.registryKeywordSearch(query, tenantId, filters, limit);
  }

  /**
   * OpenSearch full-text search
   */
  private async openSearchQuery(
    query: string,
    filters?: DiscoveryFilters,
    limit: number = 10
  ): Promise<SearchResult[]> {
    if (!this.openSearch) {
      throw new Error('OpenSearch client not configured');
    }

    // Build OpenSearch query
    const must: any[] = [
      {
        multi_match: {
          query,
          fields: ['name^3', 'description^2', 'tags', 'author'],
        },
      },
    ];

    // Add filters
    if (filters) {
      if (filters.category) {
        must.push({ term: { category: filters.category } });
      }
      if (filters.trust_level) {
        must.push({ term: { trust_level: filters.trust_level } });
      }
      if (filters.author) {
        must.push({ term: { author: filters.author } });
      }
      if (filters.min_rating) {
        must.push({ range: { rating_avg: { gte: filters.min_rating } } });
      }
      if (filters.min_downloads) {
        must.push({ range: { download_count: { gte: filters.min_downloads } } });
      }
    }

    const searchParams = {
      index: 'chimera-skills',
      body: {
        query: {
          bool: { must },
        },
        size: limit,
      },
    };

    const response = await this.openSearch.search(searchParams);

    return (response.hits?.hits || []).map((hit: any) => ({
      skill: hit._source as Skill,
      score: hit._score || 0,
      match_reason: 'Keyword match',
    }));
  }

  /**
   * Registry-based keyword search (fallback)
   */
  private async registryKeywordSearch(
    query: string,
    tenantId: string,
    filters?: DiscoveryFilters,
    limit: number = 10
  ): Promise<SearchResult[]> {
    // Use registry search (simple DynamoDB scan)
    const searchResult = await this.config.registry.searchSkills({
      query,
      category: filters?.category,
      trust_level: filters?.trust_level,
      tags: filters?.tags,
      limit,
    }, tenantId);

    return searchResult.skills.map((skill: Skill) => ({
      skill,
      score: this.calculateSimpleScore(skill, query),
      match_reason: 'Registry keyword match',
    }));
  }

  /**
   * Browse skills by category
   *
   * @param category - Skill category
   * @param tenantId - Tenant ID for security filtering
   * @param limit - Max results
   * @returns Skills in category, sorted by popularity
   */
  async browseByCategory(
    category: SkillCategory,
    tenantId: string,
    limit: number = 20
  ): Promise<Skill[]> {
    return this.config.registry.listByCategory(category, tenantId, limit);
  }

  /**
   * Get trending skills
   *
   * Returns skills with high download velocity
   *
   * @param tenantId - Tenant ID for security filtering
   * @param limit - Max results
   * @returns Trending skills
   */
  async getTrending(tenantId: string, limit: number = 10): Promise<Skill[]> {
    // Placeholder: would query time-series data for download velocity
    // For now, return top downloaded skills
    const categories: SkillCategory[] = [
      'developer-tools',
      'communication',
      'productivity',
      'data-analysis',
      'security',
      'cloud-ops',
      'knowledge',
      'creative',
      'integration',
      'automation',
    ];

    const allSkills: Skill[] = [];

    for (const category of categories) {
      const skills = await this.config.registry.listByCategory(category, tenantId, 5);
      allSkills.push(...skills);
    }

    // Sort by download count
    return allSkills
      .sort((a, b) => b.download_count - a.download_count)
      .slice(0, limit);
  }

  /**
   * Get recommended skills for tenant
   *
   * Based on:
   * - Installed skills (collaborative filtering)
   * - Usage patterns
   * - Trust level preferences
   *
   * @param tenantId - Tenant identifier
   * @param limit - Max results
   * @returns Recommended skills
   */
  async getRecommendations(
    tenantId: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    // Get tenant's installed skills
    const installs = await this.config.registry.getInstalledSkills(tenantId);

    // Extract categories and tags
    const categories = new Set<SkillCategory>();
    const tags = new Set<string>();

    for (const install of installs) {
      const skill = await this.config.registry.getSkill(install.skill_name);
      if (skill) {
        categories.add(skill.category);
        skill.tags.forEach((tag: string) => tags.add(tag));
      }
    }

    // Find skills in same categories with similar tags
    const recommendations: SearchResult[] = [];

    for (const category of categories) {
      const categorySkills = await this.config.registry.listByCategory(category, tenantId, 10);

      for (const skill of categorySkills) {
        // Skip already installed
        if (installs.some(i => i.skill_name === skill.name)) {
          continue;
        }

        // Calculate similarity score based on tag overlap
        const tagOverlap = skill.tags.filter((t: string) => tags.has(t)).length;
        const score = tagOverlap / Math.max(skill.tags.length, 1);

        if (score > 0) {
          recommendations.push({
            skill,
            score,
            match_reason: `Similar to your installed skills (${tagOverlap} matching tags)`,
          });
        }
      }
    }

    return recommendations
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Check if skill matches filters
   */
  private matchesFilters(skill: Skill, filters: DiscoveryFilters): boolean {
    if (filters.category && skill.category !== filters.category) {
      return false;
    }

    if (filters.trust_level && skill.trust_level !== filters.trust_level) {
      return false;
    }

    if (filters.author && skill.author !== filters.author) {
      return false;
    }

    if (filters.min_rating && (!skill.rating_avg || skill.rating_avg < filters.min_rating)) {
      return false;
    }

    if (filters.min_downloads && skill.download_count < filters.min_downloads) {
      return false;
    }

    if (filters.tags && !filters.tags.some(tag => skill.tags.includes(tag))) {
      return false;
    }

    return true;
  }

  /**
   * Calculate simple relevance score (used when OpenSearch unavailable)
   */
  private calculateSimpleScore(skill: Skill, query: string): number {
    const lowerQuery = query.toLowerCase();
    let score = 0;

    // Exact name match: high score
    if (skill.name.toLowerCase() === lowerQuery) {
      score += 10;
    } else if (skill.name.toLowerCase().includes(lowerQuery)) {
      score += 5;
    }

    // Description match
    if (skill.description.toLowerCase().includes(lowerQuery)) {
      score += 3;
    }

    // Tag match
    if (skill.tags.some((tag: string) => tag.toLowerCase().includes(lowerQuery))) {
      score += 2;
    }

    // Popularity boost
    score += Math.log(skill.download_count + 1) * 0.1;

    return score;
  }
}
