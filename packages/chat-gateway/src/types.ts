/**
 * Request/Response types for chat gateway
 */

import { z } from 'zod';
import { TenantTier } from '@chimera/shared';

/**
 * Vercel AI SDK chat message format
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Zod schema for a single chat message.
 *
 * Enforces `role` is one of the allowed literals and that `content` is a string.
 * Used to validate incoming ChatRequest bodies at the route edge before any
 * stream is opened — malformed input mid-stream corrupts the SSE pipeline and
 * returns garbage to clients that have already been promised a stream.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  // 32 KB cap: plenty for any legitimate chat turn; rejects 10MB DoS
  // payloads at Zod validation before any streaming pipe is opened.
  content: z.string().max(32768),
});

/**
 * Zod schema for a chat streaming request.
 *
 * Mirrors the `ChatRequest` interface field-for-field. Validation happens at
 * the route entry point with `ChatRequestSchema.safeParse(body)`; a failure
 * returns HTTP 400 with a `flatten()` representation of the Zod error so the
 * client can surface a meaningful message before a stream is opened.
 *
 * Notes:
 *   - `messages` must be a non-empty array (the adapter layer also checks this,
 *     but enforcing it here catches malformed requests before any agent work).
 *   - `tenantId` must be a non-empty string. Tenant isolation is load-bearing;
 *     an empty tenant id is never acceptable.
 *   - Optional fields (`sessionId`, `userId`, `platform`) are omitted rather
 *     than nullable to match the existing TypeScript interface.
 */
export const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1, 'messages array cannot be empty'),
  tenantId: z.string().min(1, 'tenantId is required'),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  platform: z.enum(['web', 'slack', 'teams', 'telegram', 'discord']).optional(),
});

/**
 * Chat streaming request
 */
export interface ChatRequest {
  /** Conversation messages */
  messages: ChatMessage[];

  /** Tenant identifier (required for multi-tenant isolation) */
  tenantId: string;

  /** Optional session ID to resume existing conversation */
  sessionId?: string;

  /** Optional user identifier */
  userId?: string;

  /** Platform type (default: 'web') */
  platform?: 'web' | 'slack' | 'teams' | 'telegram' | 'discord';
}

/**
 * Non-streaming chat response
 */
export interface ChatResponse {
  /** Generated message ID */
  messageId: string;

  /** Session ID for conversation continuity */
  sessionId: string;

  /** Response content */
  content: string;

  /** Reason for completion */
  finishReason: string;

  /** Token usage statistics */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Tenant context extracted from request headers
 *
 * In production, API Gateway + Cognito JWT handles authentication.
 * This middleware extracts tenant claims that API Gateway passes as headers.
 */
export interface TenantContext {
  /** Tenant identifier */
  tenantId: string;

  /** User identifier (optional) */
  userId?: string;

  /** Tenant subscription tier */
  tier: TenantTier;
}

/**
 * Error response format
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
  requestId?: string;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  service: string;
  timestamp: string;
  version: string;
}

/**
 * Status of an async SSE stream held in the StreamManager.
 * Returned by diagnostic endpoints; not part of the SSE wire format.
 */
export interface AsyncStreamStatus {
  messageId: string;
  status: 'active' | 'complete' | 'error';
  bufferedParts: number;
  createdAt: string;
}
