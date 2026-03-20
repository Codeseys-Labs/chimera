/**
 * Rate limit types for AWS Chimera rate limiting
 *
 * Based on canonical-data-model.md specification (Table 4: clawcore-rate-limits)
 */

/**
 * Sliding window counter (5-minute buckets)
 */
export interface RateLimitWindow {
  PK: string; // TENANT#{tenantId}
  SK: string; // WINDOW#{timestamp}
  windowStart: string; // ISO 8601
  requestCount: number;
  tokenUsage: number;
  errorCount: number;
  ttl: number; // Unix timestamp (5 minutes from windowStart)
}

/**
 * Token bucket state for rate limiting
 */
export interface TokenBucket {
  PK: string; // TENANT#{tenantId}
  SK: string; // RATELIMIT#{resource}
  resource: string;
  tokens: number; // Current available tokens
  capacity: number; // Maximum capacity
  refillRate: number; // Tokens per second
  lastRefill: string; // ISO 8601
}

/**
 * Rate limit check result
 */
export interface RateLimitCheckResult {
  allowed: boolean;
  remainingTokens: number;
  resetAt?: string; // ISO 8601
  retryAfter?: number; // Seconds
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  resource: string;
  capacity: number;
  refillRate: number; // Tokens per second
}
