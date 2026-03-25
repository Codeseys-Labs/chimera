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
 * Stream status for async message completion
 */
export type StreamStatus = 'streaming' | 'completed' | 'failed';

/**
 * A single buffered chunk from an LLM stream
 */
export interface StreamChunk {
  /** Monotonically increasing index within the stream */
  index: number;
  /** Vercel AI SDK Data Stream Protocol event type */
  type: 'text-delta' | 'tool-call' | 'tool-result' | 'finish' | 'error' | 'step-start' | 'step-finish';
  /** Raw DSP-encoded JSON string for the event */
  data: string;
  /** ISO 8601 timestamp of when the chunk was buffered */
  timestamp: string;
}

/**
 * DynamoDB record for a buffered stream (stored in chimera-sessions table)
 * PK: TENANT#{tenantId}, SK: STREAM#{streamId}
 */
export interface StreamBufferRecord {
  PK: string; // TENANT#{tenantId}
  SK: string; // STREAM#{streamId}
  streamId: string;
  sessionId: string;
  status: StreamStatus;
  /** All buffered chunks — populated atomically on stream completion */
  chunks: StreamChunk[];
  startedAt: string; // ISO 8601
  completedAt?: string; // ISO 8601 — set when status transitions to completed/failed
  /** True when the client disconnected before stream completion */
  isDisconnect?: boolean;
  error?: string;
  /** Unix timestamp — 1 hour after completion for automatic expiry */
  ttl: number;
}

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
  /** ID of the currently active stream, if any */
  activeStreamId?: string;
  /** Status of the active stream */
  streamStatus?: StreamStatus;
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
