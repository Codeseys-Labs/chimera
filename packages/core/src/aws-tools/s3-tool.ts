/**
 * AWS S3 Tool - Object storage management for agents (Strands format)
 *
 * Operations:
 * - s3_put_object: Upload objects with encryption and metadata
 * - s3_get_object: Download objects
 * - s3_list_objects: Paginated object listing
 * - s3_delete_object: Remove objects
 * - s3_get_presigned_url: Generate time-limited URLs
 * - s3_copy_object: Copy between buckets/keys
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
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
import { retryWithBackoff, formatToolError, S3_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Convert readable stream to buffer
 */
async function streamToBuffer(stream: any): Promise<Buffer> {
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
 * Create S3 Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of S3 tools for Strands Agent
 */
export function createS3Tools(clientFactory: AWSClientFactory) {
  const putObject = tool({
    name: 's3_put_object',
    description: 'Upload an object to S3 bucket with optional encryption, metadata, and storage class',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      bucket: z.string().describe('S3 bucket name'),
      key: z.string().describe('Object key (path within bucket)'),
      body: z.string().describe('Object content (base64-encoded for binary data)'),
      contentType: z.string().optional().describe('MIME type (e.g., text/plain, application/json)'),
      metadata: z.record(z.string()).optional().describe('Custom metadata key-value pairs'),
      serverSideEncryption: z.enum(['AES256', 'aws:kms']).optional().describe('Server-side encryption method'),
      storageClass: z.enum(['STANDARD', 'GLACIER', 'INTELLIGENT_TIERING']).optional().describe('S3 storage class'),
      tagging: z.record(z.string()).optional().describe('Object tags'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const s3 = await clientFactory.getS3Client(context);

        // Build tagging string
        let tagging: string | undefined;
        if (input.tagging) {
          const tags = Object.entries(input.tagging)
            .map(([k, v]) => `${k}=${v}`)
            .join('&');
          tagging = tags;
        }

        const command = new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          Metadata: input.metadata,
          ServerSideEncryption: input.serverSideEncryption as ServerSideEncryption,
          StorageClass: input.storageClass as StorageClass,
          Tagging: tagging,
        });

        const response = await retryWithBackoff(() => s3.send(command), S3_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            etag: response.ETag,
            versionId: response.VersionId,
            serverSideEncryption: response.ServerSideEncryption,
          },
          metadata: {
            requestId: response.$metadata.requestId,
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const getObject = tool({
    name: 's3_get_object',
    description: 'Download an object from S3 bucket, returns base64-encoded content',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      bucket: z.string().describe('S3 bucket name'),
      key: z.string().describe('Object key (path within bucket)'),
      versionId: z.string().optional().describe('Specific version ID (for versioned buckets)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const s3 = await clientFactory.getS3Client(context);

        const command = new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          VersionId: input.versionId,
        });

        const response = await retryWithBackoff(() => s3.send(command), S3_RETRYABLE_ERRORS);

        // Convert stream to buffer and base64 encode
        const body = await streamToBuffer(response.Body as any);
        const base64Body = body.toString('base64');

        return JSON.stringify({
          success: true,
          data: {
            body: base64Body,
            contentType: response.ContentType ?? 'application/octet-stream',
            metadata: response.Metadata ?? {},
            lastModified: response.LastModified?.toISOString(),
            contentLength: response.ContentLength,
          },
          metadata: {
            requestId: response.$metadata.requestId,
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const listObjects = tool({
    name: 's3_list_objects',
    description: 'List objects in S3 bucket with optional prefix filter and pagination',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      bucket: z.string().describe('S3 bucket name'),
      prefix: z.string().optional().describe('Filter objects by key prefix'),
      maxKeys: z.number().optional().describe('Maximum number of keys to return'),
      continuationToken: z.string().optional().describe('Pagination token from previous call'),
      delimiter: z.string().optional().describe('Delimiter for grouping keys (e.g., / for directories)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const s3 = await clientFactory.getS3Client(context);

        const command = new ListObjectsV2Command({
          Bucket: input.bucket,
          Prefix: input.prefix,
          MaxKeys: input.maxKeys,
          ContinuationToken: input.continuationToken,
          Delimiter: input.delimiter,
        });

        const response = await retryWithBackoff(() => s3.send(command), S3_RETRYABLE_ERRORS);

        const contents = (response.Contents ?? []).map((obj) => ({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified?.toISOString(),
          storageClass: obj.StorageClass,
        }));

        return JSON.stringify({
          success: true,
          data: {
            contents,
            nextContinuationToken: response.NextContinuationToken,
            isTruncated: response.IsTruncated ?? false,
          },
          metadata: {
            requestId: response.$metadata.requestId,
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const deleteObject = tool({
    name: 's3_delete_object',
    description: 'Delete an object from S3 bucket',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      bucket: z.string().describe('S3 bucket name'),
      key: z.string().describe('Object key (path within bucket)'),
      versionId: z.string().optional().describe('Specific version ID to delete (for versioned buckets)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const s3 = await clientFactory.getS3Client(context);

        const command = new DeleteObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          VersionId: input.versionId,
        });

        const response = await retryWithBackoff(() => s3.send(command), S3_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            deleteMarker: response.DeleteMarker,
            versionId: response.VersionId,
          },
          metadata: {
            requestId: response.$metadata.requestId,
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const getPresignedUrl = tool({
    name: 's3_get_presigned_url',
    description: 'Generate a time-limited presigned URL for uploading or downloading an S3 object',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      bucket: z.string().describe('S3 bucket name'),
      key: z.string().describe('Object key (path within bucket)'),
      expiresIn: z.number().describe('URL expiration time in seconds'),
      operation: z.enum(['getObject', 'putObject']).describe('Operation type: getObject for download, putObject for upload'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const s3 = await clientFactory.getS3Client(context);

        const command =
          input.operation === 'getObject'
            ? new GetObjectCommand({
                Bucket: input.bucket,
                Key: input.key,
              })
            : new PutObjectCommand({
                Bucket: input.bucket,
                Key: input.key,
              });

        const url = await getSignedUrl(s3, command, {
          expiresIn: input.expiresIn,
        });

        const expiresAt = new Date(Date.now() + input.expiresIn * 1000);

        return JSON.stringify({
          success: true,
          data: {
            url,
            expiresAt: expiresAt.toISOString(),
          },
          metadata: {
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const copyObject = tool({
    name: 's3_copy_object',
    description: 'Copy an object from one S3 location to another (within or across buckets)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      sourceBucket: z.string().describe('Source bucket name'),
      sourceKey: z.string().describe('Source object key'),
      destinationBucket: z.string().describe('Destination bucket name'),
      destinationKey: z.string().describe('Destination object key'),
      sourceVersionId: z.string().optional().describe('Source version ID (for versioned buckets)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const s3 = await clientFactory.getS3Client(context);

        // Build copy source string
        let copySource = `${input.sourceBucket}/${input.sourceKey}`;
        if (input.sourceVersionId) {
          copySource += `?versionId=${input.sourceVersionId}`;
        }

        const command = new CopyObjectCommand({
          CopySource: copySource,
          Bucket: input.destinationBucket,
          Key: input.destinationKey,
        });

        const response = await retryWithBackoff(() => s3.send(command), S3_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            etag: response.CopyObjectResult?.ETag ?? '',
            lastModified: response.CopyObjectResult?.LastModified?.toISOString() ?? new Date().toISOString(),
            versionId: response.VersionId,
          },
          metadata: {
            requestId: response.$metadata.requestId,
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  return [
    putObject,
    getObject,
    listObjects,
    deleteObject,
    getPresignedUrl,
    copyObject,
  ];
}

// Legacy config types removed - now defined inline with Zod schemas
