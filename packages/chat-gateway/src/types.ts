/**
 * Request/Response types for chat gateway
 */

import { z } from 'zod';
import { TenantTier } from '@chimera/shared';

/**
 * Vercel AI SDK chat message format — internal normalized shape.
 *
 * Requests from clients may arrive in v4 (`content` string) or v5 (`parts`
 * array) shape; the platform adapter (adapters/web.ts) normalizes both into
 * this single-content representation before the agent sees the message.
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Zod schema for a single chat message.
 *
 * Accepts BOTH Vercel AI SDK v4 and v5 shapes:
 *   v4: { role, content: "text" }
 *   v5: { role, parts: [{ type: 'text', text: '...' }] } (+ optional id)
 *
 * The WebPlatformAdapter (adapters/web.ts) normalizes v5 `parts` into a
 * single `content` string downstream. Validation only cares that the text
 * payload is present in one form or the other; additional AI SDK fields
 * (id, experimental flags, etc.) pass through unvalidated via .passthrough().
 *
 * Wave-22: previously this schema rejected v5 requests with a 400
 * "Required" error on the `content` field before the adapter ran.
 */
export const ChatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant', 'system']),
    // v4: single content string. 32 KB cap rejects 10MB DoS payloads at the
    // Zod layer before any streaming pipe is opened.
    content: z.string().max(32768).optional(),
    // v5: parts array. We only validate the text-part shape here; the adapter
    // filters for `type === 'text'` and ignores other part types (tool calls,
    // attachments, etc. — not used by this deployment today).
    parts: z
      .array(
        z.object({
          type: z.string(),
          text: z.string().max(32768).optional(),
        }).passthrough(),
      )
      .optional(),
  })
  .passthrough()
  .refine(
    (msg) => typeof msg.content === 'string' || Array.isArray(msg.parts),
    { message: 'Message must have either `content` (v4) or `parts` (v5)' },
  );

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
 * Chat streaming request — raw input shape from clients.
 *
 * `messages` items may arrive as either AI SDK v4 (`content` string) or v5
 * (`parts` array) — the platform adapter normalizes them into the `ChatMessage`
 * shape used downstream. Do not narrow this type to `ChatMessage[]`; that
 * would over-constrain the v5 path.
 */
export interface ChatRequest {
  /** Conversation messages (raw AI SDK v4 or v5 shape) */
  messages: z.infer<typeof ChatMessageSchema>[];

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
