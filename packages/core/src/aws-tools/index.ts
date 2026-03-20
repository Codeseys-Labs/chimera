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

// Lambda Tool
export { LambdaTool } from './lambda-tool';
export type {
  CreateFunctionConfig,
  InvokeFunctionConfig,
  UpdateFunctionCodeConfig,
  UpdateFunctionConfigConfig,
} from './lambda-tool';

// S3 Tool
export { S3Tool } from './s3-tool';
export type {
  PutObjectConfig,
  GetObjectConfig,
  ListObjectsConfig,
  DeleteObjectConfig,
  GetPresignedUrlConfig,
  CopyObjectConfig,
} from './s3-tool';

// EC2 Tool
export { EC2Tool } from './ec2-tool';
export type {
  RunInstancesConfig,
  DescribeInstancesConfig,
  ModifyInstanceAttributeConfig,
} from './ec2-tool';

// CloudWatch Tool
export { CloudWatchTool } from './cloudwatch-tool';
export type {
  MetricDataPoint,
  PutMetricDataConfig,
  StartQueryConfig,
  PutMetricAlarmConfig,
  DescribeAlarmsConfig,
} from './cloudwatch-tool';
