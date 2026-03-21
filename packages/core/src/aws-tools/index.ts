/**
 * AWS Tools - First-class AWS service integration for tenant agents
 *
 * Provides 25 AWS tools across 4 tiers:
 *
 * Tier 1 (Core Compute & Storage):
 * - Lambda: Serverless function management
 * - S3: Object storage operations
 * - EC2: Virtual machine lifecycle
 * - CloudWatch: Metrics and logging
 * - ECS: Container orchestration
 * - DynamoDB: NoSQL database operations
 * - EBS: Block storage (via EC2 client)
 * - EFS: File system operations
 *
 * Tier 2 (Networking & Security):
 * - VPC: Network configuration (via EC2 client)
 * - IAM: Identity and access management
 * - CloudFront: Content delivery
 * - Route53: DNS management
 * - WAF: Web application firewall
 *
 * Tier 3 (Data & Analytics):
 * - RDS: Relational database service
 * - Redshift: Data warehousing
 * - Glue: ETL service
 * - Athena: SQL query service
 * - OpenSearch: Search and analytics
 *
 * Tier 4 (DevOps & ML):
 * - CodeCommit: Git repositories
 * - CodePipeline: CI/CD pipelines
 * - CodeBuild: Build service
 * - Bedrock: Generative AI
 * - SageMaker: Machine learning
 * - StepFunctions: Workflow orchestration
 * - SQS: Message queuing
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
// Tier 1: Core Compute & Storage
export { createEC2Tools } from './ec2-tool';
export { createS3Tools } from './s3-tool';
export { createLambdaTools } from './lambda-tool';
export { createCloudWatchTools } from './cloudwatch-tool';
export { createTranscribeTools } from './transcribe-tool';
export { createRekognitionTools } from './rekognition-tool';
export { createTextractTools } from './textract-tool';
// TODO: Uncomment as tool files are created by other builders
// export { createECSTools } from './ecs-tool';
// export { createDynamoDBTools } from './dynamodb-tool';
// export { createEFSTools } from './efs-tool';

// Tier 2: Networking & Security
// TODO: Uncomment as tool files are created by other builders
// export { createIAMTools } from './iam-tool';
// export { createCloudFrontTools } from './cloudfront-tool';
// export { createRoute53Tools } from './route53-tool';
// export { createWAFv2Tools } from './wafv2-tool';

// Tier 3: Data & Analytics
// TODO: Uncomment as tool files are created by other builders
// export { createRDSTools } from './rds-tool';
// export { createRedshiftTools } from './redshift-tool';
// export { createGlueTools } from './glue-tool';
// export { createAthenaTools } from './athena-tool';
// export { createOpenSearchTools } from './opensearch-tool';

// Tier 4: DevOps & ML
// TODO: Uncomment as tool files are created by other builders
// export { createCodeBuildTools } from './codebuild-tool';
// export { createBedrockTools } from './bedrock-tool';
// export { createSageMakerTools } from './sagemaker-tool';
// export { createSFNTools } from './sfn-tool';
// export { createSQSTools } from './sqs-tool';

// Shared utilities
export {
  retryWithBackoff,
  formatToolError,
  EC2_RETRYABLE_ERRORS,
  S3_RETRYABLE_ERRORS,
  LAMBDA_RETRYABLE_ERRORS,
  CLOUDWATCH_RETRYABLE_ERRORS,
  TRANSCRIBE_RETRYABLE_ERRORS,
  REKOGNITION_RETRYABLE_ERRORS,
  TEXTRACT_RETRYABLE_ERRORS,
  ECS_RETRYABLE_ERRORS,
  DYNAMODB_RETRYABLE_ERRORS,
  EFS_RETRYABLE_ERRORS,
  IAM_RETRYABLE_ERRORS,
  CLOUDFRONT_RETRYABLE_ERRORS,
  ROUTE53_RETRYABLE_ERRORS,
  WAFV2_RETRYABLE_ERRORS,
  RDS_RETRYABLE_ERRORS,
  REDSHIFT_RETRYABLE_ERRORS,
  GLUE_RETRYABLE_ERRORS,
  ATHENA_RETRYABLE_ERRORS,
  OPENSEARCH_RETRYABLE_ERRORS,
  CODEBUILD_RETRYABLE_ERRORS,
  BEDROCK_RETRYABLE_ERRORS,
  SAGEMAKER_RETRYABLE_ERRORS,
  SFN_RETRYABLE_ERRORS,
  SQS_RETRYABLE_ERRORS,
} from './tool-utils';

// Legacy config types removed - now defined inline with Zod schemas in each tool file
