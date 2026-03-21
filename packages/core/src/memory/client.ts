/**
 * Memory client interface for AgentCore Memory operations
 *
 * Provides unified interface for STM and LTM operations with tenant isolation
 */

import {
  AgentCoreMemoryConfig,
  MemoryEntry,
  MemoryQuery,
  MemoryQueryResult,
  Message,
  SessionState,
} from './types';

/**
 * Memory client interface
 *
 * Implementations: AgentCoreMemoryClient, FileMemoryClient (for local dev)
 */
export interface MemoryClient {
  /**
   * Initialize memory for a tenant-user namespace
   * Creates memory namespace if it doesn't exist
   */
  initialize(config: AgentCoreMemoryConfig): Promise<void>;

  /**
   * Store a message in memory
   * Routes to appropriate strategy (summary, user preference, semantic)
   */
  storeMessage(message: Message): Promise<void>;

  /**
   * Store multiple messages (batch operation)
   * More efficient than individual stores
   */
  storeMessages(messages: Message[]): Promise<void>;

  /**
   * Retrieve memories based on query
   * Supports semantic search, filtering by session/strategy
   */
  retrieve(query: MemoryQuery): Promise<MemoryQueryResult>;

  /**
   * Get session state (STM)
   * Returns conversation history and context for a session
   */
  getSession(sessionId: string): Promise<SessionState | null>;

  /**
   * Update session state (STM)
   * Stores conversation history and context
   */
  updateSession(state: SessionState): Promise<void>;

  /**
   * Delete session state (STM cleanup)
   * Called when session terminates
   */
  deleteSession(sessionId: string): Promise<void>;

  /**
   * Clear all memory for a namespace
   * Used for tenant data deletion
   */
  clearNamespace(): Promise<void>;

  /**
   * Get memory statistics
   * Returns usage metrics for billing/monitoring
   */
  getStats(): Promise<MemoryStats>;
}

/**
 * Memory usage statistics
 */
export interface MemoryStats {
  namespace: string;
  totalEntries: number;
  totalSizeBytes: number;
  strategyCounts: {
    summary: number;
    userPreference: number;
    semantic: number;
  };
  oldestEntry: string | null; // ISO 8601
  newestEntry: string | null; // ISO 8601
}

/**
 * Memory client factory
 * Creates appropriate client based on environment
 */
export class MemoryClientFactory {
  /**
   * Create AgentCore Memory client (production)
   */
  static createAgentCoreClient(
    region: string,
    namespace: string
  ): MemoryClient {
    // Implementation will use AWS SDK for Bedrock Agent Runtime
    throw new Error('AgentCoreMemoryClient not yet implemented');
  }

  /**
   * Create file-based memory client (local development)
   */
  static createFileClient(storagePath: string, namespace: string): MemoryClient {
    // Implementation will use local filesystem
    throw new Error('FileMemoryClient not yet implemented');
  }

  /**
   * Create in-memory client (testing)
   */
  static createInMemoryClient(namespace: string): MemoryClient {
    const { InMemoryClient } = require('./in-memory-client');
    return new InMemoryClient(namespace);
  }
}
