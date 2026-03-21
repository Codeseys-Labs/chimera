/**
 * AWS Bedrock Tool - Foundation model inference for agents (Strands format)
 *
 * Operations:
 * - bedrock_invoke_model: Synchronous model invocation
 * - bedrock_invoke_model_stream: Streaming model invocation
 * - bedrock_list_foundation_models: List available models
 * - bedrock_get_foundation_model: Get model details
 * - bedrock_list_inference_profiles: List cross-region inference profiles
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  BedrockClient,
  ListFoundationModelsCommand,
  GetFoundationModelCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { AWSClientFactory } from './client-factory';
import { retryWithBackoff, formatToolError, BEDROCK_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create Bedrock Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of Bedrock tools for Strands Agent
 */
export function createBedrockTools(clientFactory: AWSClientFactory) {
  const invokeModel = tool({
    name: 'bedrock_invoke_model',
    description: 'Invoke Bedrock foundation model synchronously (returns complete response)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      modelId: z.string().describe('Model ID (e.g., anthropic.claude-3-sonnet-20240229-v1:0)'),
      body: z.unknown().describe('Model-specific request body (JSON object)'),
      accept: z.string().optional().describe('Accept header (default: application/json)'),
      contentType: z.string().optional().describe('Content-Type header (default: application/json)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const bedrockRuntime = await clientFactory.getBedrockRuntimeClient(context);

        const command = new InvokeModelCommand({
          modelId: input.modelId,
          body: JSON.stringify(input.body),
          accept: input.accept ?? 'application/json',
          contentType: input.contentType ?? 'application/json',
        });

        const response = await retryWithBackoff(() => bedrockRuntime.send(command), BEDROCK_RETRYABLE_ERRORS);

        // Parse response body
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));

        return JSON.stringify({
          success: true,
          data: {
            responseBody,
            contentType: response.contentType,
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

  const invokeModelStream = tool({
    name: 'bedrock_invoke_model_stream',
    description: 'Invoke Bedrock foundation model with streaming response (returns accumulated chunks)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      modelId: z.string().describe('Model ID (e.g., anthropic.claude-3-sonnet-20240229-v1:0)'),
      body: z.unknown().describe('Model-specific request body (JSON object)'),
      accept: z.string().optional().describe('Accept header (default: application/json)'),
      contentType: z.string().optional().describe('Content-Type header (default: application/json)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const bedrockRuntime = await clientFactory.getBedrockRuntimeClient(context);

        const command = new InvokeModelWithResponseStreamCommand({
          modelId: input.modelId,
          body: JSON.stringify(input.body),
          accept: input.accept ?? 'application/json',
          contentType: input.contentType ?? 'application/json',
        });

        const response = await retryWithBackoff(() => bedrockRuntime.send(command), BEDROCK_RETRYABLE_ERRORS);

        // Accumulate streaming response chunks
        const chunks: any[] = [];
        if (response.body) {
          for await (const event of response.body) {
            if (event.chunk) {
              const chunkData = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
              chunks.push(chunkData);
            }
          }
        }

        return JSON.stringify({
          success: true,
          data: {
            chunks,
            chunkCount: chunks.length,
            contentType: response.contentType,
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

  const listFoundationModels = tool({
    name: 'bedrock_list_foundation_models',
    description: 'List available Bedrock foundation models with filtering',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      byProvider: z.string().optional().describe('Filter by model provider (e.g., Anthropic, Amazon, AI21, Cohere)'),
      byCustomizationType: z.string().optional().describe('Filter by customization type (FINE_TUNING, CONTINUED_PRE_TRAINING)'),
      byOutputModality: z.string().optional().describe('Filter by output modality (TEXT, IMAGE, EMBEDDING)'),
      byInferenceType: z.string().optional().describe('Filter by inference type (ON_DEMAND, PROVISIONED)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const bedrock = await clientFactory.getBedrockClient(context);

        const command = new ListFoundationModelsCommand({
          byProvider: input.byProvider,
          byCustomizationType: input.byCustomizationType as any,
          byOutputModality: input.byOutputModality as any,
          byInferenceType: input.byInferenceType as any,
        });

        const response = await retryWithBackoff(() => bedrock.send(command), BEDROCK_RETRYABLE_ERRORS);

        const models = (response.modelSummaries ?? []).map((model) => ({
          modelId: model.modelId,
          modelName: model.modelName,
          providerName: model.providerName,
          inputModalities: model.inputModalities,
          outputModalities: model.outputModalities,
          responseStreamingSupported: model.responseStreamingSupported,
          customizationsSupported: model.customizationsSupported,
          inferenceTypesSupported: model.inferenceTypesSupported,
        }));

        return JSON.stringify({
          success: true,
          data: {
            models,
            count: models.length,
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

  const getFoundationModel = tool({
    name: 'bedrock_get_foundation_model',
    description: 'Get detailed information about a specific Bedrock foundation model',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      modelIdentifier: z.string().describe('Model ID or ARN'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const bedrock = await clientFactory.getBedrockClient(context);

        const command = new GetFoundationModelCommand({
          modelIdentifier: input.modelIdentifier,
        });

        const response = await retryWithBackoff(() => bedrock.send(command), BEDROCK_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            modelDetails: {
              modelId: response.modelDetails?.modelId,
              modelName: response.modelDetails?.modelName,
              providerName: response.modelDetails?.providerName,
              inputModalities: response.modelDetails?.inputModalities,
              outputModalities: response.modelDetails?.outputModalities,
              responseStreamingSupported: response.modelDetails?.responseStreamingSupported,
              customizationsSupported: response.modelDetails?.customizationsSupported,
              inferenceTypesSupported: response.modelDetails?.inferenceTypesSupported,
              modelLifecycle: response.modelDetails?.modelLifecycle,
            },
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

  const listInferenceProfiles = tool({
    name: 'bedrock_list_inference_profiles',
    description: 'List Bedrock cross-region inference profiles for high availability',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      maxResults: z.number().optional().describe('Max profiles to return (1-1000)'),
      nextToken: z.string().optional().describe('Pagination token'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const bedrock = await clientFactory.getBedrockClient(context);

        const command = new ListInferenceProfilesCommand({
          maxResults: input.maxResults,
          nextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => bedrock.send(command), BEDROCK_RETRYABLE_ERRORS);

        const profiles = (response.inferenceProfileSummaries ?? []).map((profile) => ({
          inferenceProfileId: profile.inferenceProfileId,
          inferenceProfileName: profile.inferenceProfileName,
          description: profile.description,
          status: profile.status,
          type: profile.type,
          models: profile.models,
        }));

        return JSON.stringify({
          success: true,
          data: {
            profiles,
            nextToken: response.nextToken,
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
    invokeModel,
    invokeModelStream,
    listFoundationModels,
    getFoundationModel,
    listInferenceProfiles,
  ];
}
