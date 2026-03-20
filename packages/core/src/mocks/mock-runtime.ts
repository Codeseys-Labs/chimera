/**
 * Mock AgentCore Runtime for local development
 *
 * Provides in-memory implementation of AgentCore Runtime session management
 * without requiring AWS infrastructure. Useful for local testing and development.
 */

import type {
  RuntimeConfig,
  RuntimeSession,
  MemoryResult,
} from '../runtime/agentcore-runtime';

/**
 * Mock runtime configuration
 */
export interface MockRuntimeConfig {
  /** Tenant identifier */
  tenantId: string;

  /** Memory strategy (default: SUMMARY) */
  memoryStrategy?: 'SUMMARY' | 'USER_PREFERENCE' | 'LONG_TERM';

  /** Session timeout in seconds (default: 3600) */
  sessionTimeoutSeconds?: number;
}

/**
 * Mock AgentCore Runtime
 *
 * In-memory implementation of AgentCore Runtime for local development.
 * Maintains sessions in a Map with automatic cleanup on timeout.
 */
export class MockRuntime {
  private config: MockRuntimeConfig;
  private sessions: Map<string, RuntimeSession>;
  private memory: Map<string, Map<string, string>>; // sessionId -> key -> value
  private sessionCounter: number;

  constructor(config: MockRuntimeConfig) {
    this.config = {
      memoryStrategy: 'SUMMARY',
      sessionTimeoutSeconds: 3600,
      ...config,
    };
    this.sessions = new Map();
    this.memory = new Map();
    this.sessionCounter = 0;
  }

  /**
   * Create a new session
   *
   * @param userId - Optional user identifier
   * @returns Session information
   */
  async createSession(userId?: string): Promise<RuntimeSession> {
    const sessionId = this.generateSessionId();
    const memoryNamespace = this.buildMemoryNamespace(this.config.tenantId, userId);

    const session: RuntimeSession = {
      sessionId,
      state: 'ACTIVE',
      tenantId: this.config.tenantId,
      userId,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      memoryNamespace,
      runtimeEndpointArn: 'mock://local-runtime',
    };

    this.sessions.set(sessionId, session);
    this.memory.set(sessionId, new Map());

    // Schedule automatic cleanup
    this.scheduleSessionCleanup(sessionId);

    return session;
  }

  /**
   * Resume an existing session
   *
   * @param sessionId - Session identifier to resume
   * @returns Session information
   * @throws Error if session not found or terminated
   */
  async resumeSession(sessionId: string): Promise<RuntimeSession> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state === 'TERMINATED') {
      throw new Error(`Session already terminated: ${sessionId}`);
    }

    // Update activity timestamp and state
    session.lastActivityAt = new Date();
    session.state = 'ACTIVE';

    return session;
  }

  /**
   * Terminate a session
   *
   * @param sessionId - Session identifier to terminate
   */
  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (session) {
      session.state = 'TERMINATED';
      session.lastActivityAt = new Date();

      // Clean up memory after a delay
      setTimeout(() => {
        this.sessions.delete(sessionId);
        this.memory.delete(sessionId);
      }, 5000); // 5 second grace period
    }
  }

  /**
   * Store data in memory
   *
   * @param sessionId - Session identifier
   * @param key - Memory key
   * @param value - Value to store
   * @returns Operation result
   */
  async storeMemory(sessionId: string, key: string, value: string): Promise<MemoryResult> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return {
        success: false,
        error: `Session not found: ${sessionId}`,
      };
    }

    let sessionMemory = this.memory.get(sessionId);
    if (!sessionMemory) {
      sessionMemory = new Map();
      this.memory.set(sessionId, sessionMemory);
    }

    sessionMemory.set(key, value);

    // Update activity timestamp
    session.lastActivityAt = new Date();

    return {
      success: true,
      data: { key, stored: true },
    };
  }

  /**
   * Retrieve data from memory
   *
   * @param sessionId - Session identifier
   * @param key - Memory key to retrieve
   * @returns Operation result with retrieved value
   */
  async retrieveMemory(sessionId: string, key: string): Promise<MemoryResult> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return {
        success: false,
        error: `Session not found: ${sessionId}`,
      };
    }

    const sessionMemory = this.memory.get(sessionId);
    const value = sessionMemory?.get(key);

    if (value === undefined) {
      return {
        success: false,
        error: `Key not found: ${key}`,
      };
    }

    // Update activity timestamp
    session.lastActivityAt = new Date();

    return {
      success: true,
      data: { key, value },
    };
  }

  /**
   * Query memory with semantic search (mock implementation)
   *
   * @param sessionId - Session identifier
   * @param query - Natural language query
   * @returns Operation result with matching memories
   */
  async queryMemory(sessionId: string, query: string): Promise<MemoryResult> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return {
        success: false,
        error: `Session not found: ${sessionId}`,
      };
    }

    const sessionMemory = this.memory.get(sessionId);
    if (!sessionMemory || sessionMemory.size === 0) {
      return {
        success: true,
        data: { query, results: [] },
      };
    }

    // Simple mock search: return all entries that contain query substring
    const results: Array<{ key: string; value: string; score: number }> = [];
    const queryLower = query.toLowerCase();

    for (const [key, value] of sessionMemory.entries()) {
      const valueLower = value.toLowerCase();
      if (valueLower.includes(queryLower)) {
        // Mock relevance score based on position of match
        const index = valueLower.indexOf(queryLower);
        const score = 1.0 - (index / valueLower.length);
        results.push({ key, value, score });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Update activity timestamp
    session.lastActivityAt = new Date();

    return {
      success: true,
      data: { query, results },
    };
  }

  /**
   * Get session by ID
   *
   * @param sessionId - Session identifier
   * @returns Session information or null if not found
   */
  async getSession(sessionId: string): Promise<RuntimeSession | null> {
    const session = this.sessions.get(sessionId);
    return session || null;
  }

  /**
   * List all sessions for tenant
   *
   * @param state - Optional state filter
   * @returns Array of sessions
   */
  async listSessions(state?: 'ACTIVE' | 'IDLE' | 'TERMINATED'): Promise<RuntimeSession[]> {
    const sessions = Array.from(this.sessions.values());

    if (state) {
      return sessions.filter((s) => s.state === state);
    }

    return sessions;
  }

  /**
   * Get current configuration
   */
  getConfig(): MockRuntimeConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<MockRuntimeConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Clear all sessions and memory (for testing)
   */
  reset(): void {
    this.sessions.clear();
    this.memory.clear();
    this.sessionCounter = 0;
  }

  /**
   * Generate a new session identifier
   */
  private generateSessionId(): string {
    this.sessionCounter++;
    return `mock-session-${this.sessionCounter}-${Date.now()}`;
  }

  /**
   * Build memory namespace following AgentCore convention
   */
  private buildMemoryNamespace(tenantId: string, userId?: string): string {
    if (userId) {
      return `tenant-${tenantId}-user-${userId}`;
    }
    return `tenant-${tenantId}`;
  }

  /**
   * Schedule automatic session cleanup after timeout
   */
  private scheduleSessionCleanup(sessionId: string): void {
    const timeoutMs = (this.config.sessionTimeoutSeconds || 3600) * 1000;

    setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (session && session.state !== 'TERMINATED') {
        const idleTime = Date.now() - session.lastActivityAt.getTime();
        if (idleTime >= timeoutMs) {
          session.state = 'IDLE';
        }
      }
    }, timeoutMs);
  }
}
