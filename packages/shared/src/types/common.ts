/**
 * Common types shared across AWS Chimera platform
 */

/**
 * ISO 8601 timestamp string
 */
export type ISOTimestamp = string;

/**
 * Unix timestamp (seconds since epoch)
 */
export type UnixTimestamp = number;

/**
 * AWS region identifier
 */
export type AWSRegion = string;

/**
 * AWS ARN (Amazon Resource Name)
 */
export type ARN = string;

/**
 * DynamoDB partition key (PK)
 */
export type PartitionKey = string;

/**
 * DynamoDB sort key (SK)
 */
export type SortKey = string;

/**
 * Generic API response wrapper
 */
export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
  timestamp: ISOTimestamp;
}

/**
 * Pagination metadata
 */
export interface PaginationMetadata {
  nextToken?: string;
  hasMore: boolean;
  totalCount?: number;
  pageSize: number;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  items: T[];
  pagination: PaginationMetadata;
}

/**
 * Query parameters for list operations
 */
export interface ListQueryParams {
  limit?: number;
  nextToken?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * DynamoDB GSI filter expression
 */
export interface GSIFilter {
  indexName: string;
  keyConditionExpression: string;
  filterExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, unknown>;
}

/**
 * Health check status
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Service health check result
 */
export interface ServiceHealth {
  service: string;
  status: HealthStatus;
  timestamp: ISOTimestamp;
  latencyMs?: number;
  errorRate?: number;
  message?: string;
}
