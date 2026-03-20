/**
 * AWS Lambda Tool - Serverless function management for agents
 *
 * Operations:
 * - create_function: Deploy Lambda from inline code or S3 artifact
 * - invoke_function: Synchronous or asynchronous invocation
 * - update_function: Modify code or configuration
 * - delete_function: Remove function
 * - list_functions: Paginated function listing
 * - get_function: Retrieve function metadata
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import {
  LambdaClient,
  CreateFunctionCommand,
  InvokeCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  DeleteFunctionCommand,
  ListFunctionsCommand,
  GetFunctionCommand,
  type Runtime,
  type InvocationType,
  type LogType,
} from '@aws-sdk/client-lambda';
import type { AWSClientFactory } from './client-factory';
import type { AWSToolContext, AWSToolResult } from './types';
import { createResourceTags } from './client-factory';

/**
 * Configuration for creating a Lambda function
 */
export interface CreateFunctionConfig {
  functionName: string;
  runtime: Runtime;
  handler: string;
  role: string; // IAM role ARN
  code: {
    zipFile?: Buffer;
    s3Bucket?: string;
    s3Key?: string;
    s3ObjectVersion?: string;
  };
  timeout?: number; // Seconds (default: 3)
  memorySize?: number; // MB (default: 128)
  environment?: Record<string, string>;
  layers?: string[]; // Layer ARNs
  description?: string;
}

/**
 * Configuration for invoking a Lambda function
 */
export interface InvokeFunctionConfig {
  functionName: string;
  payload: unknown;
  invocationType?: InvocationType; // RequestResponse | Event | DryRun
  logType?: LogType; // None | Tail
}

/**
 * Configuration for updating function code
 */
export interface UpdateFunctionCodeConfig {
  functionName: string;
  zipFile?: Buffer;
  s3Bucket?: string;
  s3Key?: string;
  s3ObjectVersion?: string;
}

/**
 * Configuration for updating function configuration
 */
export interface UpdateFunctionConfigConfig {
  functionName: string;
  runtime?: Runtime;
  timeout?: number;
  memorySize?: number;
  environment?: Record<string, string>;
  handler?: string;
}

/**
 * AWS Lambda Tool
 */
export class LambdaTool {
  constructor(private clientFactory: AWSClientFactory) {}

  /**
   * Create a new Lambda function
   */
  async createFunction(
    context: AWSToolContext,
    config: CreateFunctionConfig
  ): Promise<
    AWSToolResult<{
      functionArn: string;
      version: string;
      codeSize: number;
      state: string;
    }>
  > {
    const startTime = Date.now();

    try {
      const lambda = await this.clientFactory.getLambdaClient(context);

      // Build code configuration
      const code: { ZipFile?: Buffer; S3Bucket?: string; S3Key?: string; S3ObjectVersion?: string } = {};
      if (config.code.zipFile) {
        code.ZipFile = config.code.zipFile;
      } else if (config.code.s3Bucket && config.code.s3Key) {
        code.S3Bucket = config.code.s3Bucket;
        code.S3Key = config.code.s3Key;
        if (config.code.s3ObjectVersion) {
          code.S3ObjectVersion = config.code.s3ObjectVersion;
        }
      } else {
        throw new Error('Either zipFile or s3Bucket+s3Key must be provided');
      }

      const command = new CreateFunctionCommand({
        FunctionName: config.functionName,
        Runtime: config.runtime,
        Handler: config.handler,
        Role: config.role,
        Code: code,
        Timeout: config.timeout ?? 3,
        MemorySize: config.memorySize ?? 128,
        Environment: config.environment
          ? { Variables: config.environment }
          : undefined,
        Layers: config.layers,
        Description: config.description,
        Tags: Object.fromEntries(
          createResourceTags(context.tenantId, context.agentId, {
            billingCategory: 'compute-lambda',
          }).map((tag) => [tag.Key, tag.Value])
        ),
      });

      const response = await this.retryWithBackoff(() => lambda.send(command));

      return {
        success: true,
        data: {
          functionArn: response.FunctionArn!,
          version: response.Version!,
          codeSize: response.CodeSize!,
          state: response.State!,
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
   * Invoke a Lambda function
   */
  async invokeFunction(
    context: AWSToolContext,
    config: InvokeFunctionConfig
  ): Promise<
    AWSToolResult<{
      statusCode: number;
      payload: unknown;
      logResult?: string;
      executedVersion?: string;
    }>
  > {
    const startTime = Date.now();

    try {
      const lambda = await this.clientFactory.getLambdaClient(context);

      const command = new InvokeCommand({
        FunctionName: config.functionName,
        InvocationType: config.invocationType ?? 'RequestResponse',
        LogType: config.logType ?? 'None',
        Payload: Buffer.from(JSON.stringify(config.payload)),
      });

      const response = await this.retryWithBackoff(() => lambda.send(command));

      // Parse response payload
      let payload: unknown = null;
      if (response.Payload) {
        const payloadStr = Buffer.from(response.Payload).toString();
        try {
          payload = JSON.parse(payloadStr);
        } catch {
          payload = payloadStr;
        }
      }

      // Decode log result if present
      let logResult: string | undefined;
      if (response.LogResult) {
        logResult = Buffer.from(response.LogResult, 'base64').toString();
      }

      return {
        success: true,
        data: {
          statusCode: response.StatusCode ?? 200,
          payload,
          logResult,
          executedVersion: response.ExecutedVersion,
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
   * Update function code
   */
  async updateFunctionCode(
    context: AWSToolContext,
    config: UpdateFunctionCodeConfig
  ): Promise<AWSToolResult<{ lastModified: string; codeSize: number }>> {
    const startTime = Date.now();

    try {
      const lambda = await this.clientFactory.getLambdaClient(context);

      const command = new UpdateFunctionCodeCommand({
        FunctionName: config.functionName,
        ZipFile: config.zipFile,
        S3Bucket: config.s3Bucket,
        S3Key: config.s3Key,
        S3ObjectVersion: config.s3ObjectVersion,
      });

      const response = await this.retryWithBackoff(() => lambda.send(command));

      return {
        success: true,
        data: {
          lastModified: response.LastModified!,
          codeSize: response.CodeSize!,
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
   * Update function configuration
   */
  async updateFunctionConfiguration(
    context: AWSToolContext,
    config: UpdateFunctionConfigConfig
  ): Promise<AWSToolResult<{ lastModified: string }>> {
    const startTime = Date.now();

    try {
      const lambda = await this.clientFactory.getLambdaClient(context);

      const command = new UpdateFunctionConfigurationCommand({
        FunctionName: config.functionName,
        Runtime: config.runtime,
        Timeout: config.timeout,
        MemorySize: config.memorySize,
        Handler: config.handler,
        Environment: config.environment
          ? { Variables: config.environment }
          : undefined,
      });

      const response = await this.retryWithBackoff(() => lambda.send(command));

      return {
        success: true,
        data: {
          lastModified: response.LastModified!,
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
   * Delete a Lambda function
   */
  async deleteFunction(
    context: AWSToolContext,
    functionName: string
  ): Promise<AWSToolResult<void>> {
    const startTime = Date.now();

    try {
      const lambda = await this.clientFactory.getLambdaClient(context);

      const command = new DeleteFunctionCommand({
        FunctionName: functionName,
      });

      await this.retryWithBackoff(() => lambda.send(command));

      return {
        success: true,
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
   * List Lambda functions with pagination
   */
  async listFunctions(
    context: AWSToolContext,
    options?: {
      maxItems?: number;
      functionVersion?: 'ALL';
      marker?: string;
    }
  ): Promise<
    AWSToolResult<{
      functions: Array<{
        functionName: string;
        runtime: string;
        memorySize: number;
        timeout: number;
        lastModified: string;
      }>;
      nextMarker?: string;
    }>
  > {
    const startTime = Date.now();

    try {
      const lambda = await this.clientFactory.getLambdaClient(context);

      const command = new ListFunctionsCommand({
        MaxItems: options?.maxItems,
        FunctionVersion: options?.functionVersion,
        Marker: options?.marker,
      });

      const response = await this.retryWithBackoff(() => lambda.send(command));

      const functions = (response.Functions ?? []).map((fn) => ({
        functionName: fn.FunctionName!,
        runtime: fn.Runtime!,
        memorySize: fn.MemorySize!,
        timeout: fn.Timeout!,
        lastModified: fn.LastModified!,
      }));

      return {
        success: true,
        data: {
          functions,
          nextMarker: response.NextMarker,
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
   * Get function configuration and metadata
   */
  async getFunction(
    context: AWSToolContext,
    functionName: string
  ): Promise<
    AWSToolResult<{
      configuration: any;
      code: { repositoryType: string; location: string };
      tags: Record<string, string>;
    }>
  > {
    const startTime = Date.now();

    try {
      const lambda = await this.clientFactory.getLambdaClient(context);

      const command = new GetFunctionCommand({
        FunctionName: functionName,
      });

      const response = await this.retryWithBackoff(() => lambda.send(command));

      return {
        success: true,
        data: {
          configuration: response.Configuration,
          code: {
            repositoryType: response.Code?.RepositoryType ?? '',
            location: response.Code?.Location ?? '',
          },
          tags: response.Tags ?? {},
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
