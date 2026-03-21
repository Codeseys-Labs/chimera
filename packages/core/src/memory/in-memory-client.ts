/**
 * In-memory implementation of MemoryClient
 * Used for testing and local development
 *
 * Stores memory entries and session state in Maps for fast access
 * without requiring external dependencies.
 */

import {
  MemoryClient,
  MemoryStats,
} from './client';
import {
  AgentCoreMemoryConfig,
  MemoryEntry,
  MemoryQuery,
  MemoryQueryResult,
  Message,
  SessionState,
  MemoryStrategy,
} from './types';

/**
 * In-memory implementation of MemoryClient
 * Suitable for testing and local development
 */
export class InMemoryClient implements MemoryClient {
  private namespace: string;
  private config: AgentCoreMemoryConfig;

  // Storage: memory entries indexed by ID (timestamp-based)
  private entries: Map<string, MemoryEntry> = new Map();

  // Storage: session states indexed by sessionId
  private sessions: Map<string, SessionState> = new Map();

  // Counter for generating entry IDs
  private entryCounter = 0;

  constructor(namespace: string) {
    this.namespace = namespace;
    this.config = {
      namespace,
      strategies: {},
    };
  }

  async initialize(config: AgentCoreMemoryConfig): Promise<void> {
    this.config = config;
  }

  async storeMessage(message: Message): Promise<void> {
    // Determine strategy based on message role and content
    const strategy = this.selectStrategy(message);

    // Create memory entry
    const entryId = `${message.timestamp}-${this.entryCounter++}`;
    const entry: MemoryEntry = {
      content: message.content,
      metadata: {
        timestamp: message.timestamp,
        messageId: entryId,
        strategy,
      },
    };

    this.entries.set(entryId, entry);
  }

  async storeMessages(messages: Message[]): Promise<void> {
    // Batch operation - store all messages
    for (const message of messages) {
      await this.storeMessage(message);
    }
  }

  async retrieve(query: MemoryQuery): Promise<MemoryQueryResult> {
    let results: MemoryEntry[] = Array.from(this.entries.values());

    // Filter by session if specified
    if (query.sessionId) {
      results = results.filter(e => e.metadata.sessionId === query.sessionId);
    }

    // Filter by strategy if specified
    if (query.strategy) {
      results = results.filter(e => e.metadata.strategy === query.strategy);
    }

    // Text search if query string provided
    if (query.query) {
      const lowerQuery = query.query.toLowerCase();
      results = results.filter(e =>
        e.content.toLowerCase().includes(lowerQuery)
      );
    }

    // Sort by timestamp (newest first)
    results.sort((a, b) =>
      new Date(b.metadata.timestamp).getTime() - new Date(a.metadata.timestamp).getTime()
    );

    // Apply limit
    const limit = query.limit || 5;
    const limitedResults = results.slice(0, limit);

    return {
      entries: limitedResults,
      totalCount: results.length,
    };
  }

  async getSession(sessionId: string): Promise<SessionState | null> {
    return this.sessions.get(sessionId) || null;
  }

  async updateSession(state: SessionState): Promise<void> {
    this.sessions.set(state.sessionId, state);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);

    // Also remove entries associated with this session
    for (const [id, entry] of this.entries.entries()) {
      if (entry.metadata.sessionId === sessionId) {
        this.entries.delete(id);
      }
    }
  }

  async clearNamespace(): Promise<void> {
    this.entries.clear();
    this.sessions.clear();
    this.entryCounter = 0;
  }

  async getStats(): Promise<MemoryStats> {
    const entries = Array.from(this.entries.values());
    const timestamps = entries.map(e => e.metadata.timestamp).sort();

    // Count entries by strategy
    const strategyCounts = entries.reduce((acc, entry) => {
      const strategy = entry.metadata.strategy;
      if (strategy === 'SUMMARY') {
        acc.summary++;
      } else if (strategy === 'USER_PREFERENCE') {
        acc.userPreference++;
      } else if (strategy === 'SEMANTIC') {
        acc.semantic++;
      }
      return acc;
    }, { summary: 0, userPreference: 0, semantic: 0 });

    // Calculate total size (approximate)
    const totalSizeBytes = JSON.stringify(Array.from(this.entries.values())).length;

    return {
      namespace: this.namespace,
      totalEntries: entries.length,
      totalSizeBytes,
      strategyCounts,
      oldestEntry: timestamps.length > 0 ? timestamps[0] : null,
      newestEntry: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
    };
  }

  /**
   * Select appropriate memory strategy based on message content
   * This is a simplified heuristic for in-memory implementation
   */
  private selectStrategy(message: Message): MemoryStrategy {
    const content = message.content.toLowerCase();

    // User preferences: "I prefer", "I like", "I want", "always", "never"
    if (content.includes('i prefer') ||
        content.includes('i like') ||
        content.includes('i want') ||
        content.includes('always') ||
        content.includes('never')) {
      if (this.config.strategies.userPreference?.enabled) {
        return 'USER_PREFERENCE';
      }
    }

    // Semantic memory: factual statements, definitions
    if (content.includes('is') || content.includes('are') || content.includes('fact:')) {
      if (this.config.strategies.semantic) {
        return 'SEMANTIC';
      }
    }

    // Default to summary
    return 'SUMMARY';
  }

  /**
   * Get namespace for this client
   */
  getNamespace(): string {
    return this.namespace;
  }
}
