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
 * Retryable error codes for Transcribe operations
 */
export const TRANSCRIBE_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'LimitExceededException',
  'InternalFailureException',
  'ServiceUnavailableException',
  'TimeoutError',
];

/**
 * Retryable error codes for Rekognition operations
 */
export const REKOGNITION_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'InternalServerError',
  'ServiceUnavailableException',
  'TimeoutError',
];

/**
 * Retryable error codes for Textract operations
 */
export const TEXTRACT_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'InternalServerError',
  'ServiceUnavailableException',
  'TimeoutError',
];

/**
 * Retryable error codes for ECS operations
 */
export const ECS_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'ServerException',
  'ServiceUnavailableException',
  'TimeoutError',
];

/**
 * Retryable error codes for DynamoDB operations
 */
export const DYNAMODB_RETRYABLE_ERRORS = [
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'ThrottlingException',
  'InternalServerError',
  'ServiceUnavailable',
  'TimeoutError',
];

/**
 * Retryable error codes for EFS operations
 */
export const EFS_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalServerError',
  'ServiceUnavailable',
  'TimeoutError',
];

/**
 * Retryable error codes for IAM operations
 */
export const IAM_RETRYABLE_ERRORS = [
  'ServiceFailureException',
  'ThrottlingException',
  'TimeoutError',
];

/**
 * Retryable error codes for CloudFront operations
 */
export const CLOUDFRONT_RETRYABLE_ERRORS = [
  'TooManyRequestsException',
  'ServiceUnavailable',
  'ThrottlingException',
  'TimeoutError',
];

/**
 * Retryable error codes for Route53 operations
 */
export const ROUTE53_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'ServiceUnavailable',
  'TimeoutError',
];

/**
 * Retryable error codes for WAFv2 operations
 */
export const WAFV2_RETRYABLE_ERRORS = [
  'WAFServiceLinkedRoleErrorException',
  'WAFInternalErrorException',
  'WAFUnavailableEntityException',
  'ThrottlingException',
  'TimeoutError',
];

/**
 * Retryable error codes for RDS operations
 */
export const RDS_RETRYABLE_ERRORS = [
  'RequestLimitExceeded',
  'ThrottlingException',
  'ServiceUnavailable',
  'InternalFailure',
  'TimeoutError',
];

/**
 * Retryable error codes for Redshift operations
 */
export const REDSHIFT_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalFailure',
  'ServiceUnavailable',
  'TimeoutError',
];

/**
 * Retryable error codes for Glue operations
 */
export const GLUE_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalServiceException',
  'ServiceUnavailable',
  'TimeoutError',
];

/**
 * Retryable error codes for Athena operations
 */
export const ATHENA_RETRYABLE_ERRORS = [
  'TooManyRequestsException',
  'ThrottlingException',
  'InternalServerException',
  'TimeoutError',
];

/**
 * Retryable error codes for OpenSearch operations
 */
export const OPENSEARCH_RETRYABLE_ERRORS = [
  'LimitExceededException',
  'InternalException',
  'ThrottlingException',
  'ServiceUnavailable',
  'TimeoutError',
];

/**
 * Retryable error codes for CodeBuild operations
 */
export const CODEBUILD_RETRYABLE_ERRORS = [
  'AccountLimitExceededException',
  'ThrottlingException',
  'ServiceUnavailable',
  'TimeoutError',
];

/**
 * Retryable error codes for Bedrock operations
 */
export const BEDROCK_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalServerException',
  'ServiceUnavailableException',
  'ModelTimeoutException',
  'TimeoutError',
];

/**
 * Retryable error codes for SageMaker operations
 */
export const SAGEMAKER_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalFailure',
  'ServiceUnavailable',
  'TimeoutError',
];

/**
 * Retryable error codes for Step Functions operations
 */
export const SFN_RETRYABLE_ERRORS = [
  'TooManyRequestsException',
  'ThrottlingException',
  'ServiceUnavailable',
  'TimeoutError',
];

/**
 * Retryable error codes for SQS operations
 */
export const SQS_RETRYABLE_ERRORS = [
  'RequestThrottled',
  'ThrottlingException',
  'ServiceUnavailable',
  'InternalFailure',
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
    ...TRANSCRIBE_RETRYABLE_ERRORS,
    ...REKOGNITION_RETRYABLE_ERRORS,
    ...TEXTRACT_RETRYABLE_ERRORS,
    ...ECS_RETRYABLE_ERRORS,
    ...DYNAMODB_RETRYABLE_ERRORS,
    ...EFS_RETRYABLE_ERRORS,
    ...IAM_RETRYABLE_ERRORS,
    ...CLOUDFRONT_RETRYABLE_ERRORS,
    ...ROUTE53_RETRYABLE_ERRORS,
    ...WAFV2_RETRYABLE_ERRORS,
    ...RDS_RETRYABLE_ERRORS,
    ...REDSHIFT_RETRYABLE_ERRORS,
    ...GLUE_RETRYABLE_ERRORS,
    ...ATHENA_RETRYABLE_ERRORS,
    ...OPENSEARCH_RETRYABLE_ERRORS,
    ...CODEBUILD_RETRYABLE_ERRORS,
    ...BEDROCK_RETRYABLE_ERRORS,
    ...SAGEMAKER_RETRYABLE_ERRORS,
    ...SFN_RETRYABLE_ERRORS,
    ...SQS_RETRYABLE_ERRORS,
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
