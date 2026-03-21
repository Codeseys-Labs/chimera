/**
 * AWS Tools - First-class AWS service integration for tenant agents
 *
 * Provides Tier 1 AWS tools:
 * - Lambda: Serverless function management
 * - S3: Object storage operations
 * - EC2: Virtual machine lifecycle
 * - CloudWatch: Metrics and logging
 *
 * All tools use tenant-scoped IAM credentials via STS AssumeRole
 * with automatic credential caching and exponential backoff retries.
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

// Types
export type {
  AWSToolContext,
  AgentResourceTags,
  TenantCredentials,
  AWSClientFactoryConfig,
  AWSToolResult,
  CachedClient,
} from './types';

// Client Factory
export { AWSClientFactory, createResourceTags } from './client-factory';

// Strands Tool Factories (new format)
export { createEC2Tools } from './ec2-tool';
export { createS3Tools } from './s3-tool';
export { createLambdaTools } from './lambda-tool';
export { createCloudWatchTools } from './cloudwatch-tool';

// Shared utilities
export {
  retryWithBackoff,
  formatToolError,
  EC2_RETRYABLE_ERRORS,
  S3_RETRYABLE_ERRORS,
  LAMBDA_RETRYABLE_ERRORS,
  CLOUDWATCH_RETRYABLE_ERRORS,
} from './tool-utils';

// Legacy config types removed - now defined inline with Zod schemas in each tool file
