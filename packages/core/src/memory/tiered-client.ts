/**
 * Tiered memory client for managing SESSION, SWARM, and AGENT scopes
 *
 * Provides unified interface for accessing memory across three tiers:
 * - SESSION: Ephemeral conversation context (dies when session ends)
 * - SWARM: Shared namespace for multi-agent collaboration
 * - AGENT: Persistent cross-session knowledge (learnings, patterns, skills)
 *
 * Reference: docs/architecture/agent-architecture.md Section 6
 */

import {
  MemoryClient,
  MemoryClientFactory,
} from './client';
import {
  TieredMemoryConfig,
  MemoryScope,
  ScopedMemoryEntry,
  MemoryQuery,
  MemoryQueryResult,
  Message,
  SessionState,
} from './types';
import {
  generateSessionNamespace,
  generateSwarmNamespace,
  generateAgentNamespace,
} from './namespace';

/**
 * Tiered memory client managing all three scopes
 */
export class TieredMemoryClient {
  private config: TieredMemoryConfig;

  // Separate clients for each scope
  private sessionClient: MemoryClient;
  private swarmClient: MemoryClient | null = null;
  private agentClient: MemoryClient | null = null;

  constructor(config: TieredMemoryConfig) {
    this.config = config;

    // SESSION scope client (always required)
    const sessionNamespace = generateSessionNamespace(
      config.tenantId,
      config.userId,
      config.sessionId
    );
    this.sessionClient = MemoryClientFactory.createInMemoryClient(sessionNamespace);

    // SWARM scope client (if swarmId provided)
    if (config.swarmId) {
      const swarmNamespace = generateSwarmNamespace(
        config.tenantId,
        config.swarmId
      );
      this.swarmClient = MemoryClientFactory.createInMemoryClient(swarmNamespace);
    }

    // AGENT scope client (if agentId provided)
    if (config.agentId) {
      const agentNamespace = generateAgentNamespace(
        config.tenantId,
        config.agentId
      );
      this.agentClient = MemoryClientFactory.createInMemoryClient(agentNamespace);
    }
  }

  /**
   * Initialize all memory clients
   */
  async initialize(): Promise<void> {
    await this.sessionClient.initialize(this.config.memoryConfig);

    if (this.swarmClient) {
      await this.swarmClient.initialize(this.config.memoryConfig);
    }

    if (this.agentClient) {
      await this.agentClient.initialize(this.config.memoryConfig);
    }
  }

  /**
   * Store message to specific scope
   *
   * @param message - Message to store
   * @param scope - Memory scope (SESSION, SWARM, AGENT)
   */
  async storeMessage(message: Message, scope: MemoryScope = 'SESSION'): Promise<void> {
    const client = this.getClientForScope(scope);
    if (!client) {
      throw new Error(`No client configured for scope: ${scope}`);
    }

    await client.storeMessage(message);
  }

  /**
   * Store messages to multiple scopes simultaneously
   *
   * @param message - Message to store
   * @param scopes - Array of scopes to write to
   *
   * @example
   * ```ts
   * // Store to both SESSION and SWARM for multi-agent collaboration
   * await client.storeToScopes(message, ['SESSION', 'SWARM']);
   * ```
   */
  async storeToScopes(message: Message, scopes: MemoryScope[]): Promise<void> {
    const promises = scopes.map(scope => this.storeMessage(message, scope));
    await Promise.all(promises);
  }

  /**
   * Retrieve memories from specific scope
   *
   * @param query - Memory query
   * @param scope - Memory scope (SESSION, SWARM, AGENT)
   * @returns Query results
   */
  async retrieve(query: MemoryQuery, scope: MemoryScope = 'SESSION'): Promise<MemoryQueryResult> {
    const client = this.getClientForScope(scope);
    if (!client) {
      throw new Error(`No client configured for scope: ${scope}`);
    }

    return await client.retrieve(query);
  }

  /**
   * Retrieve memories from multiple scopes and merge results
   *
   * @param query - Memory query
   * @param scopes - Array of scopes to search
   * @returns Merged results from all scopes
   *
   * @example
   * ```ts
   * // Search across SESSION and SWARM for collaborative context
   * const results = await client.retrieveFromScopes(query, ['SESSION', 'SWARM']);
   * ```
   */
  async retrieveFromScopes(
    query: MemoryQuery,
    scopes: MemoryScope[]
  ): Promise<MemoryQueryResult> {
    const promises = scopes.map(async scope => {
      try {
        return await this.retrieve(query, scope);
      } catch (err) {
        // Ignore errors from unavailable scopes
        return { entries: [], totalCount: 0 };
      }
    });

    const results = await Promise.all(promises);

    // Merge all entries and sort by timestamp
    const allEntries = results.flatMap(r => r.entries);
    allEntries.sort((a, b) =>
      new Date(b.metadata.timestamp).getTime() - new Date(a.metadata.timestamp).getTime()
    );

    // Apply limit from query
    const limit = query.limit || 5;
    const limitedEntries = allEntries.slice(0, limit);

    return {
      entries: limitedEntries,
      totalCount: allEntries.length,
    };
  }

  /**
   * Get session state (STM)
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    return await this.sessionClient.getSession(sessionId);
  }

  /**
   * Update session state (STM)
   */
  async updateSession(state: SessionState): Promise<void> {
    await this.sessionClient.updateSession(state);
  }

  /**
   * Delete session and cleanup SESSION scope
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionClient.deleteSession(sessionId);
  }

  /**
   * Clear specific scope
   */
  async clearScope(scope: MemoryScope): Promise<void> {
    const client = this.getClientForScope(scope);
    if (!client) {
      throw new Error(`No client configured for scope: ${scope}`);
    }

    await client.clearNamespace();
  }

  /**
   * Get memory statistics for specific scope
   */
  async getStats(scope: MemoryScope) {
    const client = this.getClientForScope(scope);
    if (!client) {
      throw new Error(`No client configured for scope: ${scope}`);
    }

    return await client.getStats();
  }

  /**
   * Check if scope is available
   */
  hasScopeAvailable(scope: MemoryScope): boolean {
    return this.getClientForScope(scope) !== null;
  }

  /**
   * Get available scopes
   */
  getAvailableScopes(): MemoryScope[] {
    const scopes: MemoryScope[] = ['SESSION'];

    if (this.swarmClient) {
      scopes.push('SWARM');
    }

    if (this.agentClient) {
      scopes.push('AGENT');
    }

    return scopes;
  }

  /**
   * Get client for specific scope
   */
  private getClientForScope(scope: MemoryScope): MemoryClient | null {
    switch (scope) {
      case 'SESSION':
        return this.sessionClient;
      case 'SWARM':
        return this.swarmClient;
      case 'AGENT':
        return this.agentClient;
      default:
        return null;
    }
  }
}

/**
 * Factory for creating tiered memory clients
 */
export class TieredMemoryClientFactory {
  /**
   * Create tiered memory client for production (AgentCore)
   */
  static createAgentCoreClient(config: TieredMemoryConfig): TieredMemoryClient {
    // Implementation will use AgentCore Memory clients
    throw new Error('AgentCore TieredMemoryClient not yet implemented');
  }

  /**
   * Create tiered memory client for testing (in-memory)
   */
  static createInMemoryClient(config: TieredMemoryConfig): TieredMemoryClient {
    return new TieredMemoryClient(config);
  }
}
