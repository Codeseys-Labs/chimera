/**
 * AWS SDK Client Factory with tenant-scoped credentials
 *
 * Implements:
 * - Cached SDK clients per region to avoid repeated initialization
 * - STS AssumeRole with session tags for multi-tenant isolation
 * - Automatic credential refresh when expired
 * - Exponential backoff retry logic
 *
 * Reference: docs/research/aws-account-agent/02-SDK-Integration-Patterns.md
 */

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { EC2Client } from '@aws-sdk/client-ec2';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { TranscribeClient } from '@aws-sdk/client-transcribe';
import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { TextractClient } from '@aws-sdk/client-textract';
import { ECSClient } from '@aws-sdk/client-ecs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EFSClient } from '@aws-sdk/client-efs';
import { IAMClient } from '@aws-sdk/client-iam';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { Route53Client } from '@aws-sdk/client-route-53';
import { WAFV2Client } from '@aws-sdk/client-wafv2';
import { RDSClient } from '@aws-sdk/client-rds';
import { RedshiftClient } from '@aws-sdk/client-redshift';
import { GlueClient } from '@aws-sdk/client-glue';
import { AthenaClient } from '@aws-sdk/client-athena';
import { OpenSearchClient } from '@aws-sdk/client-opensearch';
import { CodeBuildClient } from '@aws-sdk/client-codebuild';
import { BedrockClient } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { SageMakerClient } from '@aws-sdk/client-sagemaker';
import { SFNClient } from '@aws-sdk/client-sfn';
import { SQSClient } from '@aws-sdk/client-sqs';
import { CodeCommitClient } from '@aws-sdk/client-codecommit';
import { CodePipelineClient } from '@aws-sdk/client-codepipeline';
import type {
  AWSClientFactoryConfig,
  AWSToolContext,
  TenantCredentials,
  CachedClient,
} from './types';

type AWSClient =
  | LambdaClient
  | S3Client
  | EC2Client
  | CloudWatchClient
  | CloudWatchLogsClient
  | TranscribeClient
  | RekognitionClient
  | TextractClient
  | ECSClient
  | DynamoDBClient
  | EFSClient
  | IAMClient
  | CloudFrontClient
  | Route53Client
  | WAFV2Client
  | RDSClient
  | RedshiftClient
  | GlueClient
  | AthenaClient
  | OpenSearchClient
  | CodeBuildClient
  | BedrockClient
  | BedrockRuntimeClient
  | SageMakerClient
  | SFNClient
  | SQSClient
  | CodeCommitClient
  | CodePipelineClient;

/**
 * Factory for creating and caching tenant-scoped AWS SDK clients
 */
export class AWSClientFactory {
  private config: AWSClientFactoryConfig & {
    credentialCacheTtl: number;
    retryConfig: { maxAttempts: number; mode: 'standard' | 'adaptive' };
    requestTimeout: number;
  };
  private clientCache = new Map<string, CachedClient<AWSClient>>();
  private credentialCache = new Map<string, TenantCredentials>();
  private stsClient: STSClient;

  constructor(config: AWSClientFactoryConfig) {
    this.config = {
      ...config,
      credentialCacheTtl: config.credentialCacheTtl ?? 3600,
      retryConfig: config.retryConfig ?? {
        maxAttempts: 3,
        mode: 'adaptive',
      },
      requestTimeout: config.requestTimeout ?? 30000,
    };

    // STS client for AssumeRole (uses default credentials)
    this.stsClient = new STSClient({
      region: this.config.defaultRegion,
      maxAttempts: this.config.retryConfig.maxAttempts,
    });
  }

  /**
   * Get or create Lambda client for tenant
   */
  async getLambdaClient(context: AWSToolContext): Promise<LambdaClient> {
    return this.getOrCreateClient(
      'lambda',
      context,
      (credentials, region) =>
        new LambdaClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create S3 client for tenant
   */
  async getS3Client(context: AWSToolContext): Promise<S3Client> {
    return this.getOrCreateClient(
      's3',
      context,
      (credentials, region) =>
        new S3Client({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create EC2 client for tenant
   */
  async getEC2Client(context: AWSToolContext): Promise<EC2Client> {
    return this.getOrCreateClient(
      'ec2',
      context,
      (credentials, region) =>
        new EC2Client({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create CloudWatch client for tenant
   */
  async getCloudWatchClient(
    context: AWSToolContext
  ): Promise<CloudWatchClient> {
    return this.getOrCreateClient(
      'cloudwatch',
      context,
      (credentials, region) =>
        new CloudWatchClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create CloudWatch Logs client for tenant
   */
  async getCloudWatchLogsClient(
    context: AWSToolContext
  ): Promise<CloudWatchLogsClient> {
    return this.getOrCreateClient(
      'cloudwatch-logs',
      context,
      (credentials, region) =>
        new CloudWatchLogsClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create Transcribe client for tenant
   */
  async getTranscribeClient(
    context: AWSToolContext
  ): Promise<TranscribeClient> {
    return this.getOrCreateClient(
      'transcribe',
      context,
      (credentials, region) =>
        new TranscribeClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create Rekognition client for tenant
   */
  async getRekognitionClient(
    context: AWSToolContext
  ): Promise<RekognitionClient> {
    return this.getOrCreateClient(
      'rekognition',
      context,
      (credentials, region) =>
        new RekognitionClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create Textract client for tenant
   */
  async getTextractClient(
    context: AWSToolContext
  ): Promise<TextractClient> {
    return this.getOrCreateClient(
      'textract',
      context,
      (credentials, region) =>
        new TextractClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create ECS client for tenant
   */
  async getECSClient(context: AWSToolContext): Promise<ECSClient> {
    return this.getOrCreateClient(
      'ecs',
      context,
      (credentials, region) =>
        new ECSClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create DynamoDB client for tenant
   */
  async getDynamoDBClient(context: AWSToolContext): Promise<DynamoDBClient> {
    return this.getOrCreateClient(
      'dynamodb',
      context,
      (credentials, region) =>
        new DynamoDBClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create EFS client for tenant
   */
  async getEFSClient(context: AWSToolContext): Promise<EFSClient> {
    return this.getOrCreateClient(
      'efs',
      context,
      (credentials, region) =>
        new EFSClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create IAM client for tenant
   */
  async getIAMClient(context: AWSToolContext): Promise<IAMClient> {
    return this.getOrCreateClient(
      'iam',
      context,
      (credentials, region) =>
        new IAMClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create CloudFront client for tenant
   */
  async getCloudFrontClient(
    context: AWSToolContext
  ): Promise<CloudFrontClient> {
    return this.getOrCreateClient(
      'cloudfront',
      context,
      (credentials, region) =>
        new CloudFrontClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create Route53 client for tenant
   */
  async getRoute53Client(context: AWSToolContext): Promise<Route53Client> {
    return this.getOrCreateClient(
      'route53',
      context,
      (credentials, region) =>
        new Route53Client({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create WAFv2 client for tenant
   */
  async getWAFV2Client(context: AWSToolContext): Promise<WAFV2Client> {
    return this.getOrCreateClient(
      'wafv2',
      context,
      (credentials, region) =>
        new WAFV2Client({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create RDS client for tenant
   */
  async getRDSClient(context: AWSToolContext): Promise<RDSClient> {
    return this.getOrCreateClient(
      'rds',
      context,
      (credentials, region) =>
        new RDSClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create Redshift client for tenant
   */
  async getRedshiftClient(context: AWSToolContext): Promise<RedshiftClient> {
    return this.getOrCreateClient(
      'redshift',
      context,
      (credentials, region) =>
        new RedshiftClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create Glue client for tenant
   */
  async getGlueClient(context: AWSToolContext): Promise<GlueClient> {
    return this.getOrCreateClient(
      'glue',
      context,
      (credentials, region) =>
        new GlueClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create Athena client for tenant
   */
  async getAthenaClient(context: AWSToolContext): Promise<AthenaClient> {
    return this.getOrCreateClient(
      'athena',
      context,
      (credentials, region) =>
        new AthenaClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create OpenSearch client for tenant
   */
  async getOpenSearchClient(
    context: AWSToolContext
  ): Promise<OpenSearchClient> {
    return this.getOrCreateClient(
      'opensearch',
      context,
      (credentials, region) =>
        new OpenSearchClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create CodeBuild client for tenant
   */
  async getCodeBuildClient(context: AWSToolContext): Promise<CodeBuildClient> {
    return this.getOrCreateClient(
      'codebuild',
      context,
      (credentials, region) =>
        new CodeBuildClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create Bedrock client for tenant
   */
  async getBedrockClient(context: AWSToolContext): Promise<BedrockClient> {
    return this.getOrCreateClient(
      'bedrock',
      context,
      (credentials, region) =>
        new BedrockClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create Bedrock Runtime client for tenant
   */
  async getBedrockRuntimeClient(
    context: AWSToolContext
  ): Promise<BedrockRuntimeClient> {
    return this.getOrCreateClient(
      'bedrock-runtime',
      context,
      (credentials, region) =>
        new BedrockRuntimeClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create SageMaker client for tenant
   */
  async getSageMakerClient(context: AWSToolContext): Promise<SageMakerClient> {
    return this.getOrCreateClient(
      'sagemaker',
      context,
      (credentials, region) =>
        new SageMakerClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create Step Functions client for tenant
   */
  async getSFNClient(context: AWSToolContext): Promise<SFNClient> {
    return this.getOrCreateClient(
      'sfn',
      context,
      (credentials, region) =>
        new SFNClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create SQS client for tenant
   */
  async getSQSClient(context: AWSToolContext): Promise<SQSClient> {
    return this.getOrCreateClient(
      'sqs',
      context,
      (credentials, region) =>
        new SQSClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create CodeCommit client for tenant
   */
  async getCodeCommitClient(
    context: AWSToolContext
  ): Promise<CodeCommitClient> {
    return this.getOrCreateClient(
      'codecommit',
      context,
      (credentials, region) =>
        new CodeCommitClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Get or create CodePipeline client for tenant
   */
  async getCodePipelineClient(
    context: AWSToolContext
  ): Promise<CodePipelineClient> {
    return this.getOrCreateClient(
      'codepipeline',
      context,
      (credentials, region) =>
        new CodePipelineClient({
          region,
          credentials,
          maxAttempts: this.config.retryConfig.maxAttempts,
          requestHandler: {
            requestTimeout: this.config.requestTimeout,
          },
        })
    );
  }

  /**
   * Assume tenant-specific IAM role with session tags
   */
  private async assumeTenantRole(
    context: AWSToolContext
  ): Promise<TenantCredentials> {
    // Check credential cache first
    const cacheKey = `${context.tenantId}:${context.agentId}`;
    const cached = this.credentialCache.get(cacheKey);

    if (cached && cached.expiration && cached.expiration.getTime() > Date.now()) {
      return cached;
    }

    // Build role ARN
    const roleName = this.config.roleNamePattern.replace(
      '{tenantId}',
      context.tenantId
    );
    const roleArn = `arn:aws:iam::${this.config.accountId}:role/${roleName}`;

    // Session name: agentId-timestamp
    const sessionName =
      context.sessionName ?? `${context.agentId}-${Date.now()}`;

    const command = new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: this.config.credentialCacheTtl,
      Tags: [
        { Key: 'tenantId', Value: context.tenantId },
        { Key: 'agentId', Value: context.agentId },
        { Key: 'assumedAt', Value: new Date().toISOString() },
      ],
    });

    const response = await this.stsClient.send(command);

    if (!response.Credentials) {
      throw new Error(
        `Failed to assume role for tenant ${context.tenantId}: no credentials returned`
      );
    }

    const credentials: TenantCredentials = {
      accessKeyId: response.Credentials.AccessKeyId!,
      secretAccessKey: response.Credentials.SecretAccessKey!,
      sessionToken: response.Credentials.SessionToken!,
      expiration: response.Credentials.Expiration,
    };

    // Cache credentials
    this.credentialCache.set(cacheKey, credentials);

    return credentials;
  }

  /**
   * Get or create cached client for service/region/tenant
   */
  private async getOrCreateClient<T extends AWSClient>(
    service: string,
    context: AWSToolContext,
    factory: (credentials: TenantCredentials, region: string) => T
  ): Promise<T> {
    const region = context.region ?? this.config.defaultRegion;
    const cacheKey = `${service}:${region}:${context.tenantId}:${context.agentId}`;

    // Check cache
    const cached = this.clientCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.client as T;
    }

    // Assume role to get credentials
    const credentials = await this.assumeTenantRole(context);

    // Create new client
    const client = factory(credentials, region);

    // Cache client
    const expiresAt = credentials.expiration
      ? credentials.expiration.getTime()
      : now + this.config.credentialCacheTtl * 1000;

    this.clientCache.set(cacheKey, {
      client,
      credentials,
      createdAt: now,
      expiresAt,
    });

    return client;
  }

  /**
   * Clear all cached clients and credentials
   * Useful for testing or forced refresh
   */
  clearCache(): void {
    this.clientCache.clear();
    this.credentialCache.clear();
  }

  /**
   * Clear cached clients for specific tenant
   */
  clearTenantCache(tenantId: string): void {
    // Remove all entries with matching tenantId
    for (const key of this.clientCache.keys()) {
      if (key.includes(`:${tenantId}:`)) {
        this.clientCache.delete(key);
      }
    }
    for (const key of this.credentialCache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.credentialCache.delete(key);
      }
    }
  }

  /**
   * Get cache statistics (for monitoring)
   */
  getCacheStats(): {
    clientCount: number;
    credentialCount: number;
    expiredClients: number;
  } {
    const now = Date.now();
    let expiredClients = 0;

    for (const cached of this.clientCache.values()) {
      if (cached.expiresAt <= now) {
        expiredClients++;
      }
    }

    return {
      clientCount: this.clientCache.size,
      credentialCount: this.credentialCache.size,
      expiredClients,
    };
  }
}

/**
 * Helper function to create resource tags
 */
export function createResourceTags(
  tenantId: string,
  agentId: string,
  additionalTags?: Record<string, string>
): Array<{ Key: string; Value: string }> {
  const tags = [
    { Key: 'ManagedBy', Value: `chimera-agent-${tenantId}` },
    { Key: 'CreatedAt', Value: new Date().toISOString() },
    { Key: 'CreatedBy', Value: agentId },
    { Key: 'tenantId', Value: tenantId },
  ];

  if (additionalTags) {
    for (const [key, value] of Object.entries(additionalTags)) {
      tags.push({ Key: key, Value: value });
    }
  }

  return tags;
}
