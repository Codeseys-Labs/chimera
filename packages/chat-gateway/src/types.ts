/**
 * Request/Response types for chat gateway
 */

import { TenantTier } from '@chimera/shared';

/**
 * Vercel AI SDK chat message format
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

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
  platform?: 'web' | 'slack' | 'teams';
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
