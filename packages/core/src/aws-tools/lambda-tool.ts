/**
 * AWS Lambda Tool - Serverless function management for agents (Strands format)
 *
 * Operations:
 * - lambda_create_function: Deploy Lambda from inline code or S3 artifact
 * - lambda_invoke_function: Synchronous or asynchronous invocation
 * - lambda_update_function_code: Modify code
 * - lambda_update_function_config: Modify configuration
 * - lambda_delete_function: Remove function
 * - lambda_list_functions: Paginated function listing
 * - lambda_get_function: Retrieve function metadata
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
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
import { createResourceTags } from './client-factory';
import { retryWithBackoff, formatToolError, LAMBDA_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create Lambda Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of Lambda tools for Strands Agent
 */
export function createLambdaTools(clientFactory: AWSClientFactory) {
  const createFunction = tool({
    name: 'lambda_create_function',
    description: 'Create a new Lambda function from ZIP file or S3 artifact',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      functionName: z.string().describe('Function name (unique within region)'),
      runtime: z.string().describe('Runtime (e.g., nodejs20.x, python3.12)'),
      handler: z.string().describe('Handler function (e.g., index.handler)'),
      role: z.string().describe('IAM role ARN with Lambda execution permissions'),
      zipFile: z.string().optional().describe('Base64-encoded ZIP file content'),
      s3Bucket: z.string().optional().describe('S3 bucket containing deployment package'),
      s3Key: z.string().optional().describe('S3 key of deployment package'),
      s3ObjectVersion: z.string().optional().describe('S3 object version ID'),
      timeout: z.number().optional().describe('Function timeout in seconds (default: 3)'),
      memorySize: z.number().optional().describe('Memory in MB (default: 128)'),
      environment: z.record(z.string()).optional().describe('Environment variables'),
      layers: z.array(z.string()).optional().describe('Layer ARNs'),
      description: z.string().optional().describe('Function description'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const lambda = await clientFactory.getLambdaClient(context);

        // Build code configuration
        const code: { ZipFile?: Buffer; S3Bucket?: string; S3Key?: string; S3ObjectVersion?: string } = {};
        if (input.zipFile) {
          code.ZipFile = Buffer.from(input.zipFile, 'base64');
        } else if (input.s3Bucket && input.s3Key) {
          code.S3Bucket = input.s3Bucket;
          code.S3Key = input.s3Key;
          if (input.s3ObjectVersion) {
            code.S3ObjectVersion = input.s3ObjectVersion;
          }
        } else {
          throw new Error('Either zipFile or s3Bucket+s3Key must be provided');
        }

        const command = new CreateFunctionCommand({
          FunctionName: input.functionName,
          Runtime: input.runtime as Runtime,
          Handler: input.handler,
          Role: input.role,
          Code: code,
          Timeout: input.timeout ?? 3,
          MemorySize: input.memorySize ?? 128,
          Environment: input.environment ? { Variables: input.environment } : undefined,
          Layers: input.layers,
          Description: input.description,
          Tags: Object.fromEntries(
            createResourceTags(input.tenantId, input.agentId, { billingCategory: 'compute-lambda' }).map((tag) => [
              tag.Key,
              tag.Value,
            ])
          ),
        });

        const response = await retryWithBackoff(() => lambda.send(command), LAMBDA_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            functionArn: response.FunctionArn,
            version: response.Version,
            codeSize: response.CodeSize,
            state: response.State,
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

  const invokeFunction = tool({
    name: 'lambda_invoke_function',
    description: 'Invoke a Lambda function synchronously or asynchronously',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      functionName: z.string().describe('Function name or ARN'),
      payload: z.unknown().describe('JSON payload to pass to function'),
      invocationType: z.enum(['RequestResponse', 'Event', 'DryRun']).optional().describe('Invocation type (default: RequestResponse)'),
      logType: z.enum(['None', 'Tail']).optional().describe('Include execution logs in response (default: None)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const lambda = await clientFactory.getLambdaClient(context);

        const command = new InvokeCommand({
          FunctionName: input.functionName,
          InvocationType: (input.invocationType ?? 'RequestResponse') as InvocationType,
          LogType: (input.logType ?? 'None') as LogType,
          Payload: Buffer.from(JSON.stringify(input.payload)),
        });

        const response = await retryWithBackoff(() => lambda.send(command), LAMBDA_RETRYABLE_ERRORS);

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

        return JSON.stringify({
          success: true,
          data: {
            statusCode: response.StatusCode ?? 200,
            payload,
            logResult,
            executedVersion: response.ExecutedVersion,
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

  const updateFunctionCode = tool({
    name: 'lambda_update_function_code',
    description: 'Update Lambda function code from ZIP file or S3 artifact',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      functionName: z.string().describe('Function name or ARN'),
      zipFile: z.string().optional().describe('Base64-encoded ZIP file content'),
      s3Bucket: z.string().optional().describe('S3 bucket containing deployment package'),
      s3Key: z.string().optional().describe('S3 key of deployment package'),
      s3ObjectVersion: z.string().optional().describe('S3 object version ID'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const lambda = await clientFactory.getLambdaClient(context);

        const command = new UpdateFunctionCodeCommand({
          FunctionName: input.functionName,
          ZipFile: input.zipFile ? Buffer.from(input.zipFile, 'base64') : undefined,
          S3Bucket: input.s3Bucket,
          S3Key: input.s3Key,
          S3ObjectVersion: input.s3ObjectVersion,
        });

        const response = await retryWithBackoff(() => lambda.send(command), LAMBDA_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            lastModified: response.LastModified,
            codeSize: response.CodeSize,
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

  const updateFunctionConfiguration = tool({
    name: 'lambda_update_function_config',
    description: 'Update Lambda function configuration (runtime, timeout, memory, environment variables)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      functionName: z.string().describe('Function name or ARN'),
      runtime: z.string().optional().describe('Runtime (e.g., nodejs20.x, python3.12)'),
      timeout: z.number().optional().describe('Function timeout in seconds'),
      memorySize: z.number().optional().describe('Memory in MB'),
      handler: z.string().optional().describe('Handler function (e.g., index.handler)'),
      environment: z.record(z.string()).optional().describe('Environment variables'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const lambda = await clientFactory.getLambdaClient(context);

        const command = new UpdateFunctionConfigurationCommand({
          FunctionName: input.functionName,
          Runtime: input.runtime as Runtime | undefined,
          Timeout: input.timeout,
          MemorySize: input.memorySize,
          Handler: input.handler,
          Environment: input.environment ? { Variables: input.environment } : undefined,
        });

        const response = await retryWithBackoff(() => lambda.send(command), LAMBDA_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            lastModified: response.LastModified,
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

  const deleteFunction = tool({
    name: 'lambda_delete_function',
    description: 'Delete a Lambda function permanently',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      functionName: z.string().describe('Function name or ARN to delete'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const lambda = await clientFactory.getLambdaClient(context);

        const command = new DeleteFunctionCommand({
          FunctionName: input.functionName,
        });

        await retryWithBackoff(() => lambda.send(command), LAMBDA_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
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

  const listFunctions = tool({
    name: 'lambda_list_functions',
    description: 'List Lambda functions in region with pagination',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      maxItems: z.number().optional().describe('Maximum number of functions to return'),
      functionVersion: z.enum(['ALL']).optional().describe('Include all versions (default: only $LATEST)'),
      marker: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const lambda = await clientFactory.getLambdaClient(context);

        const command = new ListFunctionsCommand({
          MaxItems: input.maxItems,
          FunctionVersion: input.functionVersion,
          Marker: input.marker,
        });

        const response = await retryWithBackoff(() => lambda.send(command), LAMBDA_RETRYABLE_ERRORS);

        const functions = (response.Functions ?? []).map((fn) => ({
          functionName: fn.FunctionName,
          runtime: fn.Runtime,
          memorySize: fn.MemorySize,
          timeout: fn.Timeout,
          lastModified: fn.LastModified,
        }));

        return JSON.stringify({
          success: true,
          data: {
            functions,
            nextMarker: response.NextMarker,
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

  const getFunction = tool({
    name: 'lambda_get_function',
    description: 'Get Lambda function configuration, metadata, and code location',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      functionName: z.string().describe('Function name or ARN'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const lambda = await clientFactory.getLambdaClient(context);

        const command = new GetFunctionCommand({
          FunctionName: input.functionName,
        });

        const response = await retryWithBackoff(() => lambda.send(command), LAMBDA_RETRYABLE_ERRORS);

        return JSON.stringify({
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
    createFunction,
    invokeFunction,
    updateFunctionCode,
    updateFunctionConfiguration,
    deleteFunction,
    listFunctions,
    getFunction,
  ];
}

// Legacy config types removed - now defined inline with Zod schemas
