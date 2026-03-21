/**
 * AWS S3 Tool - Object storage management for agents
 *
 * Operations:
 * - put_object: Upload objects with encryption and metadata
 * - get_object: Download objects
 * - list_objects: Paginated object listing
 * - delete_object: Remove objects
 * - get_presigned_url: Generate time-limited URLs
 * - copy_object: Copy between buckets/keys
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  CopyObjectCommand,
  type ServerSideEncryption,
  type StorageClass,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AWSClientFactory } from './client-factory';
import type { AWSToolContext, AWSToolResult } from './types';
import { createResourceTags } from './client-factory';

/**
 * Configuration for uploading an object
 */
export interface PutObjectConfig {
  bucket: string;
  key: string;
  body: Buffer | string;
  contentType?: string;
  metadata?: Record<string, string>;
  serverSideEncryption?: ServerSideEncryption; // AES256 | aws:kms
  storageClass?: StorageClass; // STANDARD | GLACIER | INTELLIGENT_TIERING
  tagging?: Record<string, string>;
}

/**
 * Configuration for downloading an object
 */
export interface GetObjectConfig {
  bucket: string;
  key: string;
  versionId?: string;
}

/**
 * Configuration for listing objects
 */
export interface ListObjectsConfig {
  bucket: string;
  prefix?: string;
  maxKeys?: number;
  continuationToken?: string;
  delimiter?: string;
}

/**
 * Configuration for deleting an object
 */
export interface DeleteObjectConfig {
  bucket: string;
  key: string;
  versionId?: string;
}

/**
 * Configuration for generating presigned URL
 */
export interface GetPresignedUrlConfig {
  bucket: string;
  key: string;
  expiresIn: number; // Seconds
  operation: 'getObject' | 'putObject';
}

/**
 * Configuration for copying an object
 */
export interface CopyObjectConfig {
  sourceBucket: string;
  sourceKey: string;
  destinationBucket: string;
  destinationKey: string;
  sourceVersionId?: string;
}

/**
 * AWS S3 Tool
 */
export class S3Tool {
  constructor(private clientFactory: AWSClientFactory) {}

  /**
   * Upload an object to S3
   */
  async putObject(
    context: AWSToolContext,
    config: PutObjectConfig
  ): Promise<
    AWSToolResult<{
      etag: string;
      versionId?: string;
      serverSideEncryption?: string;
    }>
  > {
    const startTime = Date.now();

    try {
      const s3 = await this.clientFactory.getS3Client(context);

      // Build tagging string
      let tagging: string | undefined;
      if (config.tagging) {
        const tags = Object.entries(config.tagging)
          .map(([k, v]) => `${k}=${v}`)
          .join('&');
        tagging = tags;
      }

      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: config.key,
        Body: config.body,
        ContentType: config.contentType,
        Metadata: config.metadata,
        ServerSideEncryption: config.serverSideEncryption,
        StorageClass: config.storageClass,
        Tagging: tagging,
      });

      const response = await this.retryWithBackoff(() => s3.send(command));

      return {
        success: true,
        data: {
          etag: response.ETag!,
          versionId: response.VersionId,
          serverSideEncryption: response.ServerSideEncryption,
        },
        metadata: {
          requestId: response.$metadata.requestId,
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * Download an object from S3
   */
  async getObject(
    context: AWSToolContext,
    config: GetObjectConfig
  ): Promise<
    AWSToolResult<{
      body: Buffer;
      contentType: string;
      metadata: Record<string, string>;
      lastModified: Date;
      contentLength: number;
    }>
  > {
    const startTime = Date.now();

    try {
      const s3 = await this.clientFactory.getS3Client(context);

      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: config.key,
        VersionId: config.versionId,
      });

      const response = await this.retryWithBackoff(() => s3.send(command));

      // Convert stream to buffer
      const body = await this.streamToBuffer(response.Body as any);

      return {
        success: true,
        data: {
          body,
          contentType: response.ContentType ?? 'application/octet-stream',
          metadata: response.Metadata ?? {},
          lastModified: response.LastModified!,
          contentLength: response.ContentLength!,
        },
        metadata: {
          requestId: response.$metadata.requestId,
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * List objects in a bucket
   */
  async listObjects(
    context: AWSToolContext,
    config: ListObjectsConfig
  ): Promise<
    AWSToolResult<{
      contents: Array<{
        key: string;
        size: number;
        lastModified: Date;
        storageClass: string;
      }>;
      nextContinuationToken?: string;
      isTruncated: boolean;
    }>
  > {
    const startTime = Date.now();

    try {
      const s3 = await this.clientFactory.getS3Client(context);

      const command = new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: config.prefix,
        MaxKeys: config.maxKeys,
        ContinuationToken: config.continuationToken,
        Delimiter: config.delimiter,
      });

      const response = await this.retryWithBackoff(() => s3.send(command));

      const contents = (response.Contents ?? []).map((obj) => ({
        key: obj.Key!,
        size: obj.Size!,
        lastModified: obj.LastModified!,
        storageClass: obj.StorageClass!,
      }));

      return {
        success: true,
        data: {
          contents,
          nextContinuationToken: response.NextContinuationToken,
          isTruncated: response.IsTruncated ?? false,
        },
        metadata: {
          requestId: response.$metadata.requestId,
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * Delete an object from S3
   */
  async deleteObject(
    context: AWSToolContext,
    config: DeleteObjectConfig
  ): Promise<
    AWSToolResult<{
      deleteMarker?: boolean;
      versionId?: string;
    }>
  > {
    const startTime = Date.now();

    try {
      const s3 = await this.clientFactory.getS3Client(context);

      const command = new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: config.key,
        VersionId: config.versionId,
      });

      const response = await this.retryWithBackoff(() => s3.send(command));

      return {
        success: true,
        data: {
          deleteMarker: response.DeleteMarker,
          versionId: response.VersionId,
        },
        metadata: {
          requestId: response.$metadata.requestId,
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * Generate a presigned URL for an object
   */
  async getPresignedUrl(
    context: AWSToolContext,
    config: GetPresignedUrlConfig
  ): Promise<
    AWSToolResult<{
      url: string;
      expiresAt: Date;
    }>
  > {
    const startTime = Date.now();

    try {
      const s3 = await this.clientFactory.getS3Client(context);

      const command =
        config.operation === 'getObject'
          ? new GetObjectCommand({
              Bucket: config.bucket,
              Key: config.key,
            })
          : new PutObjectCommand({
              Bucket: config.bucket,
              Key: config.key,
            });

      const url = await getSignedUrl(s3, command, {
        expiresIn: config.expiresIn,
      });

      const expiresAt = new Date(Date.now() + config.expiresIn * 1000);

      return {
        success: true,
        data: {
          url,
          expiresAt,
        },
        metadata: {
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * Copy an object within S3
   */
  async copyObject(
    context: AWSToolContext,
    config: CopyObjectConfig
  ): Promise<
    AWSToolResult<{
      etag: string;
      lastModified: Date;
      versionId?: string;
    }>
  > {
    const startTime = Date.now();

    try {
      const s3 = await this.clientFactory.getS3Client(context);

      // Build copy source string
      let copySource = `${config.sourceBucket}/${config.sourceKey}`;
      if (config.sourceVersionId) {
        copySource += `?versionId=${config.sourceVersionId}`;
      }

      const command = new CopyObjectCommand({
        CopySource: copySource,
        Bucket: config.destinationBucket,
        Key: config.destinationKey,
      });

      const response = await this.retryWithBackoff(() => s3.send(command));

      return {
        success: true,
        data: {
          etag: response.CopyObjectResult?.ETag ?? '',
          lastModified: response.CopyObjectResult?.LastModified ?? new Date(),
          versionId: response.VersionId,
        },
        metadata: {
          requestId: response.$metadata.requestId,
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * Convert readable stream to buffer
   */
  private async streamToBuffer(stream: any): Promise<Buffer> {
    if (stream.transformToByteArray) {
      // AWS SDK v3 stream
      const bytes = await stream.transformToByteArray();
      return Buffer.from(bytes);
    }

    // Node.js readable stream fallback
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Retry with exponential backoff and jitter
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        const errorName = error.name;
        const retryableErrors = [
          'TooManyRequestsException',
          'ServiceException',
          'ThrottlingException',
          'TimeoutError',
          'RequestTimeout',
          'SlowDown',
        ];

        if (retryableErrors.includes(errorName) && attempt < maxRetries) {
          // Exponential backoff with jitter
          const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
          await this.sleep(delay);
        } else {
          throw error;
        }
      }
    }

    throw new Error('Unexpected: all retries exhausted');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Error handler with retryability detection
   */
  private handleError(
    error: any,
    context: AWSToolContext,
    startTime: number
  ): AWSToolResult<any> {
    const retryableErrors = [
      'TooManyRequestsException',
      'ServiceException',
      'ThrottlingException',
      'TimeoutError',
      'RequestTimeout',
      'SlowDown',
    ];

    return {
      success: false,
      error: {
        message: error.message ?? 'Unknown error',
        code: error.name ?? 'UnknownError',
        retryable: retryableErrors.includes(error.name),
      },
      metadata: {
        region: context.region ?? 'us-east-1',
        durationMs: Date.now() - startTime,
      },
    };
  }
}
