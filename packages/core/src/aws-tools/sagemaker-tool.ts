/**
 * AWS SageMaker Tool - ML model deployment and inference for agents (Strands format)
 *
 * Operations:
 * - sagemaker_create_model: Register trained model
 * - sagemaker_create_endpoint_config: Define deployment configuration
 * - sagemaker_create_endpoint: Deploy model to inference endpoint
 * - sagemaker_describe_endpoint: Get endpoint status and metadata
 * - sagemaker_delete_endpoint: Remove inference endpoint
 * - sagemaker_list_endpoints: List all endpoints
 *
 * Note: sagemaker_invoke_endpoint requires @aws-sdk/client-sagemaker-runtime (not in peerDependencies)
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  SageMakerClient,
  CreateModelCommand,
  CreateEndpointConfigCommand,
  CreateEndpointCommand,
  DescribeEndpointCommand,
  DeleteEndpointCommand,
  ListEndpointsCommand,
  type _InstanceType as InstanceType,
} from '@aws-sdk/client-sagemaker';
import type { AWSClientFactory } from './client-factory';
import { createResourceTags } from './client-factory';
import { retryWithBackoff, formatToolError, SAGEMAKER_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create SageMaker Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of SageMaker tools for Strands Agent
 */
export function createSageMakerTools(clientFactory: AWSClientFactory) {
  const createModel = tool({
    name: 'sagemaker_create_model',
    description: 'Register SageMaker model from S3 artifact for deployment',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      modelName: z.string().describe('Unique model name'),
      executionRoleArn: z.string().describe('IAM role ARN with SageMaker permissions'),
      primaryContainer: z.object({
        image: z.string().describe('Docker image URI for inference'),
        modelDataUrl: z.string().describe('S3 path to model artifact (model.tar.gz)'),
        environment: z.record(z.string()).optional().describe('Environment variables'),
      }).describe('Primary container configuration'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sagemaker = await clientFactory.getSageMakerClient(context);

        const tags = createResourceTags(input.tenantId, input.agentId, { billingCategory: 'ml-sagemaker' });

        const command = new CreateModelCommand({
          ModelName: input.modelName,
          ExecutionRoleArn: input.executionRoleArn,
          PrimaryContainer: {
            Image: input.primaryContainer.image,
            ModelDataUrl: input.primaryContainer.modelDataUrl,
            Environment: input.primaryContainer.environment,
          },
          Tags: tags,
        });

        const response = await retryWithBackoff(() => sagemaker.send(command), SAGEMAKER_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            modelArn: response.ModelArn,
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

  const createEndpointConfig = tool({
    name: 'sagemaker_create_endpoint_config',
    description: 'Create SageMaker endpoint configuration with instance type and count',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      endpointConfigName: z.string().describe('Unique endpoint config name'),
      productionVariants: z.array(z.object({
        variantName: z.string().describe('Variant name'),
        modelName: z.string().describe('Model name (from create_model)'),
        initialInstanceCount: z.number().describe('Number of instances'),
        instanceType: z.string().describe('Instance type (e.g., ml.t2.medium, ml.m5.xlarge)'),
        initialVariantWeight: z.number().optional().describe('Traffic weight (0.0-1.0)'),
      })).describe('Production variant configurations'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sagemaker = await clientFactory.getSageMakerClient(context);

        const tags = createResourceTags(input.tenantId, input.agentId, { billingCategory: 'ml-sagemaker' });

        const command = new CreateEndpointConfigCommand({
          EndpointConfigName: input.endpointConfigName,
          ProductionVariants: input.productionVariants.map((v) => ({
            VariantName: v.variantName,
            ModelName: v.modelName,
            InitialInstanceCount: v.initialInstanceCount,
            InstanceType: v.instanceType as any,
            InitialVariantWeight: v.initialVariantWeight ?? 1.0,
          })),
          Tags: tags,
        });

        const response = await retryWithBackoff(() => sagemaker.send(command), SAGEMAKER_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            endpointConfigArn: response.EndpointConfigArn,
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

  const createEndpoint = tool({
    name: 'sagemaker_create_endpoint',
    description: 'Deploy SageMaker endpoint with specified configuration',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      endpointName: z.string().describe('Unique endpoint name'),
      endpointConfigName: z.string().describe('Endpoint config name (from create_endpoint_config)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sagemaker = await clientFactory.getSageMakerClient(context);

        const tags = createResourceTags(input.tenantId, input.agentId, { billingCategory: 'ml-sagemaker' });

        const command = new CreateEndpointCommand({
          EndpointName: input.endpointName,
          EndpointConfigName: input.endpointConfigName,
          Tags: tags,
        });

        const response = await retryWithBackoff(() => sagemaker.send(command), SAGEMAKER_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            endpointArn: response.EndpointArn,
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

  // Note: invokeEndpoint tool requires @aws-sdk/client-sagemaker-runtime package
  // which is not currently in peerDependencies. Add it to implement inference tool.

  const describeEndpoint = tool({
    name: 'sagemaker_describe_endpoint',
    description: 'Get SageMaker endpoint status, configuration, and metadata',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      endpointName: z.string().describe('Endpoint name'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sagemaker = await clientFactory.getSageMakerClient(context);

        const command = new DescribeEndpointCommand({
          EndpointName: input.endpointName,
        });

        const response = await retryWithBackoff(() => sagemaker.send(command), SAGEMAKER_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            endpointName: response.EndpointName,
            endpointArn: response.EndpointArn,
            endpointConfigName: response.EndpointConfigName,
            endpointStatus: response.EndpointStatus,
            creationTime: response.CreationTime,
            lastModifiedTime: response.LastModifiedTime,
            productionVariants: response.ProductionVariants?.map((pv) => ({
              variantName: pv.VariantName,
              deployedImages: pv.DeployedImages,
              currentWeight: pv.CurrentWeight,
              desiredWeight: pv.DesiredWeight,
              currentInstanceCount: pv.CurrentInstanceCount,
              desiredInstanceCount: pv.DesiredInstanceCount,
            })),
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

  const deleteEndpoint = tool({
    name: 'sagemaker_delete_endpoint',
    description: 'Delete SageMaker endpoint (stops billing for instances)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      endpointName: z.string().describe('Endpoint name to delete'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sagemaker = await clientFactory.getSageMakerClient(context);

        const command = new DeleteEndpointCommand({
          EndpointName: input.endpointName,
        });

        await retryWithBackoff(() => sagemaker.send(command), SAGEMAKER_RETRYABLE_ERRORS);

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

  const listEndpoints = tool({
    name: 'sagemaker_list_endpoints',
    description: 'List SageMaker endpoints with filtering and pagination',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      statusEquals: z.enum(['OutOfService', 'Creating', 'Updating', 'SystemUpdating', 'RollingBack', 'InService', 'Deleting', 'Failed']).optional().describe('Filter by status'),
      nameContains: z.string().optional().describe('Filter by name substring'),
      maxResults: z.number().optional().describe('Max results (1-100)'),
      nextToken: z.string().optional().describe('Pagination token'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sagemaker = await clientFactory.getSageMakerClient(context);

        const command = new ListEndpointsCommand({
          StatusEquals: input.statusEquals as any,
          NameContains: input.nameContains,
          MaxResults: input.maxResults,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => sagemaker.send(command), SAGEMAKER_RETRYABLE_ERRORS);

        const endpoints = (response.Endpoints ?? []).map((ep) => ({
          endpointName: ep.EndpointName,
          endpointArn: ep.EndpointArn,
          endpointStatus: ep.EndpointStatus,
          creationTime: ep.CreationTime,
          lastModifiedTime: ep.LastModifiedTime,
        }));

        return JSON.stringify({
          success: true,
          data: {
            endpoints,
            nextToken: response.NextToken,
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
    createModel,
    createEndpointConfig,
    createEndpoint,
    // invokeEndpoint, // Requires @aws-sdk/client-sagemaker-runtime
    describeEndpoint,
    deleteEndpoint,
    listEndpoints,
  ];
}
