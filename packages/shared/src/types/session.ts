/**
 * Session types for AWS Chimera agent sessions
 *
 * Based on canonical-data-model.md specification (Table 2: clawcore-sessions)
 */

/**
 * Session lifecycle status
 */
export type SessionStatus = 'active' | 'idle' | 'terminated';

/**
 * Session context information
 */
export interface SessionContext {
  workingDirectory?: string;
  environmentVars?: Record<string, string>;
  [key: string]: unknown; // Allow additional context fields
}

/**
 * Token usage for a session
 */
export interface SessionTokenUsage {
  input: number;
  output: number;
}

/**
 * Agent session record (Table: clawcore-sessions)
 */
export interface AgentSession {
  PK: string; // TENANT#{tenantId}
  SK: string; // SESSION#{sessionId}
  sessionId: string;
  agentId: string;
  userId: string;
  status: SessionStatus;
  createdAt: string; // ISO 8601
  lastActivity: string; // ISO 8601
  messageCount: number;
  tokenUsage: SessionTokenUsage;
  context: SessionContext;
  ttl: number; // Unix timestamp (24 hours from creation)
}

/**
 * Session creation request
 */
export interface CreateSessionRequest {
  tenantId: string;
  agentId: string;
  userId: string;
  context?: SessionContext;
}

/**
 * Session update request
 */
export interface UpdateSessionRequest {
  sessionId: string;
  status?: SessionStatus;
  lastActivity?: string;
  messageCount?: number;
  tokenUsage?: Partial<SessionTokenUsage>;
  context?: Partial<SessionContext>;
}
