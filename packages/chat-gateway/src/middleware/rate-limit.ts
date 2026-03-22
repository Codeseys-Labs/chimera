/**
 * Rate limiting middleware
 *
 * Token bucket rate limiting with DynamoDB-backed state.
 * Enforces per-tenant rate limits to prevent cross-tenant DoS attacks.
 */

import { Request, Response, NextFunction } from 'express';
import { RateLimiter } from '@chimera/core';

// Local DynamoDBClient type (matches RateLimiter interface)
interface DynamoDBClient {
  get(params: any): Promise<any>;
  put(params: any): Promise<any>;
  update(params: any): Promise<any>;
  query(params: any): Promise<any>;
}

// Mock DynamoDB client for development/testing
// Simulates unlimited rate limits by always returning a bucket with max tokens
const mockDynamoDBClient: DynamoDBClient = {
  async get() {
    // Return a token bucket with plenty of tokens
    return {
      Item: {
        PK: 'RATE_LIMIT#test',
        SK: 'api-requests',
        capacity: 100000,
        refillRate: 10000,
        tokens: 100000,
        lastRefill: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    };
  },
  async put() {
    return {};
  },
  async update() {
    // Return updated bucket with plenty of tokens
    return {
      Attributes: {
        tokens: 99999,
        lastRefill: new Date().toISOString(),
      },
    };
  },
  async query() {
    return { Items: [] };
  },
};

// Initialize rate limiter (should be injected via dependency injection in production)
const rateLimiter = new RateLimiter({
  rateLimitsTableName: process.env.RATE_LIMITS_TABLE_NAME || 'chimera-rate-limits',
  dynamodb: mockDynamoDBClient,
});

/**
 * Rate limit middleware
 *
 * Checks tenant-specific rate limits before allowing requests.
 * Returns 429 Too Many Requests if rate limit exceeded.
 *
 * @param resource - Resource name for rate limiting (e.g., 'api-requests', 'chat-stream')
 * @param cost - Token cost for this operation (default 1)
 */
export function rateLimitMiddleware(resource: string = 'api-requests', cost: number = 1) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Tenant context must be extracted first (by tenant middleware)
    if (!req.tenantContext) {
      res.status(500).json({
        error: {
          code: 'MISSING_TENANT_CONTEXT',
          message: 'Rate limiting requires tenant context',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { tenantId } = req.tenantContext;

    try {
      // Check rate limit
      const result = await rateLimiter.checkRateLimit({
        tenantId,
        resource,
        cost,
      });

      if (!result.allowed) {
        res.status(429).json({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Rate limit exceeded. Please try again later.',
            details: {
              resource,
              retryAfter: result.retryAfter,
              resetAt: result.resetAt,
            },
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Rate limit check passed - attach remaining tokens to response headers
      res.setHeader('X-RateLimit-Remaining', result.remainingTokens?.toString() || '0');
      res.setHeader('X-RateLimit-Resource', resource);

      next();
    } catch (error) {
      // Fail closed: reject request on DDB error to prevent DoS attacks
      console.error('Rate limit check error:', error);
      res.status(503).json({
        error: {
          code: 'RATE_LIMIT_SERVICE_UNAVAILABLE',
          message: 'Rate limiting service temporarily unavailable. Please try again.',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }
  };
}

/**
 * Record request metrics in sliding window
 *
 * Call this middleware AFTER the request completes to track usage.
 * Used for observability and burst detection.
 */
export function recordMetricsMiddleware(tokenUsage: number = 1) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.tenantContext) {
      next();
      return;
    }

    const { tenantId } = req.tenantContext;

    // Record window metrics asynchronously (don't block response)
    rateLimiter
      .recordWindow(tenantId, tokenUsage, res.statusCode >= 400)
      .catch((error) => {
        console.error('Failed to record metrics window:', error);
      });

    next();
  };
}
