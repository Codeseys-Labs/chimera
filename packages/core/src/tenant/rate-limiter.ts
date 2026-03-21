/**
 * Rate Limiter
 *
 * Token bucket rate limiting with DynamoDB-backed state
 * Implements rate-limits table schema from canonical-data-model.md
 */

import { TokenBucket, RateLimitWindow, RateLimitCheckResult, RateLimitConfig } from '@chimera/shared';

import type {
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';

/**
 * DynamoDB client interface
 */
export interface DynamoDBClient {
  get(params: GetCommandInput): Promise<GetCommandOutput>;
  put(params: PutCommandInput): Promise<PutCommandOutput>;
  update(params: UpdateCommandInput): Promise<UpdateCommandOutput>;
  query(params: QueryCommandInput): Promise<QueryCommandOutput>;
}

/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
  /** DynamoDB table name for rate limits */
  rateLimitsTableName: string;

  /** DynamoDB client */
  dynamodb: DynamoDBClient;
}

/**
 * Rate limit check parameters
 */
export interface CheckRateLimitParams {
  tenantId: string;
  resource: string;
  cost?: number; // Token cost (default 1)
}

/**
 * Rate Limiter
 *
 * Implements token bucket algorithm with DynamoDB:
 * - Each tenant has token buckets per resource (API requests, tool executions, etc.)
 * - Tokens refill at configurable rate (e.g., 100 tokens/second)
 * - Failed requests when bucket is empty
 * - Uses atomic DynamoDB updates to prevent race conditions
 *
 * Also tracks 5-minute sliding windows for metrics/monitoring
 */
export class RateLimiter {
  private config: RateLimiterConfig;

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  /**
   * Get token bucket state
   *
   * @param tenantId - Tenant ID
   * @param resource - Resource name (e.g., "api-requests")
   * @returns Token bucket state or null if not initialized
   */
  async getTokenBucket(tenantId: string, resource: string): Promise<TokenBucket | null> {
    const params = {
      TableName: this.config.rateLimitsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `RATELIMIT#${resource}`,
      },
    };

    const result = await this.config.dynamodb.get(params);
    return (result.Item as TokenBucket) || null;
  }

  /**
   * Initialize or update token bucket configuration
   *
   * @param tenantId - Tenant ID
   * @param config - Rate limit configuration
   */
  async setRateLimit(tenantId: string, config: RateLimitConfig): Promise<void> {
    const bucket: TokenBucket = {
      PK: `TENANT#${tenantId}`,
      SK: `RATELIMIT#${config.resource}`,
      resource: config.resource,
      tokens: config.capacity, // Start with full capacity
      capacity: config.capacity,
      refillRate: config.refillRate,
      lastRefill: new Date().toISOString(),
    };

    const params = {
      TableName: this.config.rateLimitsTableName,
      Item: bucket,
    };

    await this.config.dynamodb.put(params);
  }

  /**
   * Check rate limit and consume tokens
   *
   * Implements token bucket algorithm with atomic DynamoDB operations:
   * 1. Fetch current bucket state
   * 2. Calculate refilled tokens based on elapsed time
   * 3. Attempt to consume tokens with ConditionExpression
   *
   * SECURITY: Fails closed on errors - any exception results in denied request
   *
   * @param params - Rate limit check parameters
   * @returns Check result with allowed status and retry info
   */
  async checkRateLimit(params: CheckRateLimitParams): Promise<RateLimitCheckResult> {
    try {
      const { tenantId, resource, cost = 1 } = params;

      // Fetch current bucket
      let bucket = await this.getTokenBucket(tenantId, resource);

      // If bucket doesn't exist, create with default config (100 req/sec, 10k capacity)
      if (!bucket) {
        await this.setRateLimit(tenantId, {
          resource,
          capacity: 10000,
          refillRate: 100, // 100 tokens per second
        });
        bucket = await this.getTokenBucket(tenantId, resource);
        if (!bucket) {
          // Fail closed: deny request if bucket initialization fails
          return {
            allowed: false,
            remainingTokens: 0,
          };
        }
      }

      // Calculate tokens to add based on elapsed time
      const now = new Date();
      const lastRefill = new Date(bucket.lastRefill);
      const elapsedSeconds = (now.getTime() - lastRefill.getTime()) / 1000;
      const tokensToAdd = Math.floor(elapsedSeconds * bucket.refillRate);

      // Calculate new token count (capped at capacity)
      const refilledTokens = Math.min(bucket.tokens + tokensToAdd, bucket.capacity);

      // Check if we have enough tokens
      if (refilledTokens < cost) {
        // Not enough tokens - calculate retry after
        const tokensNeeded = cost - refilledTokens;
        const retryAfterSeconds = Math.ceil(tokensNeeded / bucket.refillRate);

        return {
          allowed: false,
          remainingTokens: refilledTokens,
          resetAt: new Date(now.getTime() + retryAfterSeconds * 1000).toISOString(),
          retryAfter: retryAfterSeconds,
        };
      }

      // Attempt to consume tokens atomically
      try {
        const updateParams = {
          TableName: this.config.rateLimitsTableName,
          Key: {
            PK: `TENANT#${tenantId}`,
            SK: `RATELIMIT#${resource}`,
          },
          UpdateExpression: 'SET tokens = :newTokens, lastRefill = :now',
          ConditionExpression: 'lastRefill = :expectedLastRefill', // Optimistic locking
          ExpressionAttributeValues: {
            ':newTokens': refilledTokens - cost,
            ':now': now.toISOString(),
            ':expectedLastRefill': bucket.lastRefill,
          },
          ReturnValues: 'ALL_NEW',
        };

        const result = await this.config.dynamodb.update(updateParams);
        const updatedBucket = result.Attributes as TokenBucket;

        return {
          allowed: true,
          remainingTokens: updatedBucket.tokens,
        };
      } catch (error: any) {
        // Retry on concurrent modification
        if (error.name === 'ConditionalCheckFailedException') {
          // Another request modified the bucket concurrently, retry
          return this.checkRateLimit(params);
        }
        // Fail closed: any other DynamoDB error denies the request
        return {
          allowed: false,
          remainingTokens: 0,
        };
      }
    } catch (error: any) {
      // Fail closed: any unexpected error denies the request
      return {
        allowed: false,
        remainingTokens: 0,
      };
    }
  }

  /**
   * Refill tokens without consuming (administrative operation)
   *
   * @param tenantId - Tenant ID
   * @param resource - Resource name
   * @param tokens - Number of tokens to add (default: refill to capacity)
   */
  async refillTokens(tenantId: string, resource: string, tokens?: number): Promise<void> {
    const bucket = await this.getTokenBucket(tenantId, resource);
    if (!bucket) {
      throw new Error(`Rate limit bucket not found: ${tenantId}/${resource}`);
    }

    const newTokens = tokens !== undefined ? Math.min(bucket.tokens + tokens, bucket.capacity) : bucket.capacity;

    const params = {
      TableName: this.config.rateLimitsTableName,
      Key: {
        PK: `TENANT#${tenantId}`,
        SK: `RATELIMIT#${resource}`,
      },
      UpdateExpression: 'SET tokens = :tokens, lastRefill = :now',
      ExpressionAttributeValues: {
        ':tokens': newTokens,
        ':now': new Date().toISOString(),
      },
    };

    await this.config.dynamodb.update(params);
  }

  /**
   * Record request in sliding window (for metrics)
   *
   * Creates 5-minute window buckets with TTL for automatic cleanup
   *
   * @param tenantId - Tenant ID
   * @param tokenUsage - Number of tokens used in this request
   * @param isError - Whether the request resulted in an error
   */
  async recordWindow(tenantId: string, tokenUsage: number, isError: boolean = false): Promise<void> {
    const now = new Date();

    // Round down to nearest 5-minute bucket
    const windowStart = new Date(Math.floor(now.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000));

    // TTL: 5 minutes after window starts
    const ttl = Math.floor(windowStart.getTime() / 1000) + 5 * 60;

    const window: RateLimitWindow = {
      PK: `TENANT#${tenantId}`,
      SK: `WINDOW#${windowStart.toISOString()}`,
      windowStart: windowStart.toISOString(),
      requestCount: 1,
      tokenUsage,
      errorCount: isError ? 1 : 0,
      ttl,
    };

    // Upsert: increment counters if window already exists
    const params = {
      TableName: this.config.rateLimitsTableName,
      Key: {
        PK: window.PK,
        SK: window.SK,
      },
      UpdateExpression:
        'SET requestCount = if_not_exists(requestCount, :zero) + :one, ' +
        'tokenUsage = if_not_exists(tokenUsage, :zero) + :tokens, ' +
        'errorCount = if_not_exists(errorCount, :zero) + :errors, ' +
        'windowStart = if_not_exists(windowStart, :windowStart), ' +
        '#ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames: {
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':one': 1,
        ':zero': 0,
        ':tokens': tokenUsage,
        ':errors': isError ? 1 : 0,
        ':windowStart': windowStart.toISOString(),
        ':ttl': ttl,
      },
    };

    await this.config.dynamodb.update(params);
  }

  /**
   * Get recent windows for metrics
   *
   * @param tenantId - Tenant ID
   * @param minutes - Number of minutes to look back (default 60)
   * @returns Array of window records
   */
  async getRecentWindows(tenantId: string, minutes: number = 60): Promise<RateLimitWindow[]> {
    const now = new Date();
    const lookback = new Date(now.getTime() - minutes * 60 * 1000);

    const params = {
      TableName: this.config.rateLimitsTableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix) AND SK >= :minSK',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}`,
        ':prefix': 'WINDOW#',
        ':minSK': `WINDOW#${lookback.toISOString()}`,
      },
      ScanIndexForward: false, // Most recent first
    };

    const result = await this.config.dynamodb.query(params);
    return (result.Items || []) as RateLimitWindow[];
  }

  /**
   * Calculate current request rate (requests per second)
   *
   * @param tenantId - Tenant ID
   * @param minutes - Time window for calculation (default 5)
   * @returns Average requests per second
   */
  async getCurrentRate(tenantId: string, minutes: number = 5): Promise<number> {
    const windows = await this.getRecentWindows(tenantId, minutes);

    if (windows.length === 0) {
      return 0;
    }

    const totalRequests = windows.reduce((sum, w) => sum + w.requestCount, 0);
    const totalSeconds = minutes * 60;

    return totalRequests / totalSeconds;
  }
}
