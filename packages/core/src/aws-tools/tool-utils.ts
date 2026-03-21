/**
 * Shared utilities for AWS Strands tools
 *
 * Provides retry logic with exponential backoff and error formatting
 * for all AWS SDK tool implementations.
 */

/**
 * Retryable error codes for EC2 operations
 */
export const EC2_RETRYABLE_ERRORS = [
  'RequestLimitExceeded',
  'ServiceUnavailable',
  'InternalError',
  'ThrottlingException',
  'TimeoutError',
];

/**
 * Retryable error codes for S3 operations
 */
export const S3_RETRYABLE_ERRORS = [
  'TooManyRequestsException',
  'ServiceException',
  'ThrottlingException',
  'TimeoutError',
  'SlowDown',
];

/**
 * Retryable error codes for Lambda operations
 */
export const LAMBDA_RETRYABLE_ERRORS = [
  'TooManyRequestsException',
  'ServiceException',
  'ThrottlingException',
  'TimeoutError',
];

/**
 * Retryable error codes for CloudWatch operations
 */
export const CLOUDWATCH_RETRYABLE_ERRORS = [
  'Throttling',
  'ThrottlingException',
  'ServiceUnavailable',
  'InternalServiceError',
  'TimeoutError',
];

/**
 * Retry an operation with exponential backoff and jitter
 *
 * @param operation - Async operation to retry
 * @param retryableErrors - List of error codes/names that should trigger retry
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param baseDelay - Base delay in milliseconds (default: 1000)
 * @returns Promise resolving to operation result
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  retryableErrors: string[],
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      const errorCode = error.Code ?? error.name;

      if (retryableErrors.includes(errorCode) && attempt < maxRetries) {
        // Exponential backoff with jitter
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }

  throw new Error('Unexpected: all retries exhausted');
}

/**
 * Sleep for a specified duration
 *
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format AWS SDK error into JSON string response
 *
 * @param error - Error object from AWS SDK
 * @param region - AWS region where error occurred
 * @param startTime - Start time of operation (for duration calculation)
 * @returns JSON string with error details
 */
export function formatToolError(
  error: any,
  region: string,
  startTime: number
): string {
  const errorCode = error.Code ?? error.name;
  const retryableErrors = [
    ...EC2_RETRYABLE_ERRORS,
    ...S3_RETRYABLE_ERRORS,
    ...LAMBDA_RETRYABLE_ERRORS,
    ...CLOUDWATCH_RETRYABLE_ERRORS,
  ];

  return JSON.stringify({
    success: false,
    error: {
      message: error.message ?? 'Unknown error',
      code: errorCode ?? 'UnknownError',
      retryable: retryableErrors.includes(errorCode),
    },
    metadata: {
      region,
      durationMs: Date.now() - startTime,
    },
  });
}
