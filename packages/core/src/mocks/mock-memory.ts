/**
 * Mock Memory Client for local development
 *
 * Provides in-memory implementation of AgentCore Memory (STM + LTM)
 * for local development without requiring AWS infrastructure.
 */

import type {
  AgentCoreMemoryConfig,
  MemoryEntry,
  MemoryQuery,
  MemoryQueryResult,
  Message,
  SessionState,
  MemoryStrategy,
} from '../memory/types';
import type { MemoryClient, MemoryStats } from '../memory/client';

/**
 * Mock Memory Client
 *
 * In-memory implementation of MemoryClient interface for local development.
 * Maintains separate storage for STM (sessions) and LTM (long-term memories).
 */
export class MockMemoryClient implements MemoryClient {
  private namespace: string;
  private config?: AgentCoreMemoryConfig;

  // STM: Session storage
  private sessions: Map<string, SessionState>;

  // LTM: Long-term memory storage
  private memories: Map<string, MemoryEntry>;

  // Counter for generating memory IDs
  private memoryCounter: number;

  constructor(namespace: string) {
    this.namespace = namespace;
    this.sessions = new Map();
    this.memories = new Map();
    this.memoryCounter = 0;
  }

  /**
   * Initialize memory for a tenant-user namespace
   */
  async initialize(config: AgentCoreMemoryConfig): Promise<void> {
    this.config = config;
  }

  /**
   * Store a message in memory
   */
  async storeMessage(message: Message): Promise<void> {
    // Determine strategy based on config
    const strategies = this.getEnabledStrategies();

    for (const strategy of strategies) {
      const memoryId = this.generateMemoryId();
      const entry: MemoryEntry = {
        content: message.content,
        metadata: {
          timestamp: message.timestamp,
          messageId: memoryId,
          sessionId: undefined, // Can be set by caller
          strategy,
        },
      };

      // For semantic strategy, generate mock embedding
      if (strategy === 'SEMANTIC') {
        entry.embedding = this.generateMockEmbedding(message.content);
      }

      this.memories.set(memoryId, entry);
    }
  }

  /**
   * Store multiple messages (batch operation)
   */
  async storeMessages(messages: Message[]): Promise<void> {
    for (const message of messages) {
      await this.storeMessage(message);
    }
  }

  /**
   * Retrieve memories based on query
   */
  async retrieve(query: MemoryQuery): Promise<MemoryQueryResult> {
    let entries = Array.from(this.memories.values());

    // Filter by session if provided
    if (query.sessionId) {
      entries = entries.filter((e) => e.metadata.sessionId === query.sessionId);
    }

    // Filter by strategy if provided
    if (query.strategy) {
      entries = entries.filter((e) => e.metadata.strategy === query.strategy);
    }

    // Semantic search if query text provided
    if (query.query) {
      const queryLower = query.query.toLowerCase();
      const scoredEntries = entries
        .map((entry) => {
          // Simple mock similarity: substring match with position scoring
          const contentLower = entry.content.toLowerCase();
          const index = contentLower.indexOf(queryLower);
          if (index === -1) {
            return { entry, score: 0 };
          }
          const score = 1.0 - (index / contentLower.length);
          return { entry, score };
        })
        .filter((item) => item.score >= (query.minScore || 0.7))
        .sort((a, b) => b.score - a.score);

      entries = scoredEntries.map((item) => item.entry);
    }

    // Apply limit
    const limit = query.limit || 5;
    const resultEntries = entries.slice(0, limit);

    return {
      entries: resultEntries,
      totalCount: entries.length,
    };
  }

  /**
   * Get session state (STM)
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Update session state (STM)
   */
  async updateSession(state: SessionState): Promise<void> {
    this.sessions.set(state.sessionId, {
      ...state,
      lastActivity: new Date().toISOString(),
    });
  }

  /**
   * Delete session state (STM cleanup)
   */
  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);

    // Also clean up memories associated with this session
    for (const [id, entry] of this.memories.entries()) {
      if (entry.metadata.sessionId === sessionId) {
        this.memories.delete(id);
      }
    }
  }

  /**
   * Clear all memory for a namespace
   */
  async clearNamespace(): Promise<void> {
    this.sessions.clear();
    this.memories.clear();
    this.memoryCounter = 0;
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<MemoryStats> {
    const entries = Array.from(this.memories.values());

    const strategyCounts = {
      summary: 0,
      userPreference: 0,
      semantic: 0,
    };

    let totalSizeBytes = 0;
    let oldestTimestamp: string | null = null;
    let newestTimestamp: string | null = null;

    for (const entry of entries) {
      // Count by strategy
      if (entry.metadata.strategy === 'SUMMARY') {
        strategyCounts.summary++;
      } else if (entry.metadata.strategy === 'USER_PREFERENCE') {
        strategyCounts.userPreference++;
      } else if (entry.metadata.strategy === 'SEMANTIC') {
        strategyCounts.semantic++;
      }

      // Calculate size (approximate)
      totalSizeBytes += new Blob([entry.content]).size;
      if (entry.embedding) {
        totalSizeBytes += entry.embedding.length * 4; // 4 bytes per float
      }

      // Track timestamps
      const timestamp = entry.metadata.timestamp;
      if (!oldestTimestamp || timestamp < oldestTimestamp) {
        oldestTimestamp = timestamp;
      }
      if (!newestTimestamp || timestamp > newestTimestamp) {
        newestTimestamp = timestamp;
      }
    }

    return {
      namespace: this.namespace,
      totalEntries: entries.length,
      totalSizeBytes,
      strategyCounts,
      oldestEntry: oldestTimestamp,
      newestEntry: newestTimestamp,
    };
  }

  /**
   * Get enabled memory strategies from config
   */
  private getEnabledStrategies(): MemoryStrategy[] {
    if (!this.config) {
      return ['SUMMARY']; // Default to summary only
    }

    const strategies: MemoryStrategy[] = [];

    if (this.config.strategies.summary) {
      strategies.push('SUMMARY');
    }
    if (this.config.strategies.userPreference?.enabled) {
      strategies.push('USER_PREFERENCE');
    }
    if (this.config.strategies.semantic) {
      strategies.push('SEMANTIC');
    }

    return strategies.length > 0 ? strategies : ['SUMMARY'];
  }

  /**
   * Generate a unique memory ID
   */
  private generateMemoryId(): string {
    this.memoryCounter++;
    return `mock-memory-${this.memoryCounter}-${Date.now()}`;
  }

  /**
   * Generate mock embedding vector
   * In production, this would use Amazon Titan or another embedding model
   */
  private generateMockEmbedding(text: string): number[] {
    // Generate a deterministic but varied embedding based on text content
    const dimensions = 1024; // Match Titan Embed Text v2
    const embedding: number[] = [];

    // Simple hash-based embedding for testing
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Generate vector with some variation
    for (let i = 0; i < dimensions; i++) {
      const seed = hash + i;
      const value = Math.sin(seed) * 0.5 + 0.5; // Normalize to [0, 1]
      embedding.push(value);
    }

    return embedding;
  }

  /**
   * Get current namespace
   */
  getNamespace(): string {
    return this.namespace;
  }

  /**
   * Get session count (for testing/debugging)
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get memory count (for testing/debugging)
   */
  getMemoryCount(): number {
    return this.memories.size;
  }
}
