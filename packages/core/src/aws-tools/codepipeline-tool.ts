/**
 * AWS CodePipeline Tool - CI/CD pipeline management for agents (Strands format)
 *
 * Operations:
 * - codepipeline_list_pipelines: List CodePipeline pipelines
 * - codepipeline_get_pipeline: Get pipeline definition
 * - codepipeline_get_pipeline_state: Get current execution state
 * - codepipeline_start_pipeline_execution: Trigger pipeline run
 * - codepipeline_get_pipeline_execution: Get execution details
 * - codepipeline_list_pipeline_executions: List pipeline runs
 * - codepipeline_stop_pipeline_execution: Cancel running execution
 * - codepipeline_create_pipeline: Create new pipeline
 * - codepipeline_update_pipeline: Modify pipeline definition
 * - codepipeline_delete_pipeline: Remove pipeline
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  CodePipelineClient,
  ListPipelinesCommand,
  GetPipelineCommand,
  GetPipelineStateCommand,
  StartPipelineExecutionCommand,
  GetPipelineExecutionCommand,
  ListPipelineExecutionsCommand,
  StopPipelineExecutionCommand,
  CreatePipelineCommand,
  UpdatePipelineCommand,
  DeletePipelineCommand,
  type PipelineDeclaration,
} from '@aws-sdk/client-codepipeline';
import type { AWSClientFactory } from './client-factory';
import { retryWithBackoff, formatToolError } from './tool-utils';

/**
 * Retryable error codes for CodePipeline operations
 */
export const CODEPIPELINE_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalServerException',
  'ServiceUnavailableException',
  'TimeoutError',
];

/**
 * Create CodePipeline Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of CodePipeline tools for Strands Agent
 */
export function createCodePipelineTools(clientFactory: AWSClientFactory) {
  const listPipelines = tool({
    name: 'codepipeline_list_pipelines',
    description: 'List all CodePipeline pipelines in the AWS account',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
      maxResults: z.number().optional().describe('Maximum number of results (1-1000)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codepipeline = await clientFactory.getCodePipelineClient(context);

        const command = new ListPipelinesCommand({
          nextToken: input.nextToken,
          maxResults: input.maxResults,
        });

        const response = await retryWithBackoff(
          () => codepipeline.send(command),
          CODEPIPELINE_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            pipelines: response.pipelines ?? [],
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

  const getPipeline = tool({
    name: 'codepipeline_get_pipeline',
    description: 'Get the full definition of a CodePipeline pipeline',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      name: z.string().describe('Name of the pipeline'),
      version: z.number().optional().describe('Pipeline version number'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codepipeline = await clientFactory.getCodePipelineClient(context);

        const command = new GetPipelineCommand({
          name: input.name,
          version: input.version,
        });

        const response = await retryWithBackoff(
          () => codepipeline.send(command),
          CODEPIPELINE_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            pipeline: response.pipeline,
            metadata: response.metadata,
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

  const getPipelineState = tool({
    name: 'codepipeline_get_pipeline_state',
    description:
      'Get the current state of a pipeline including stage and action states',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      name: z.string().describe('Name of the pipeline'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codepipeline = await clientFactory.getCodePipelineClient(context);

        const command = new GetPipelineStateCommand({
          name: input.name,
        });

        const response = await retryWithBackoff(
          () => codepipeline.send(command),
          CODEPIPELINE_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            pipelineName: response.pipelineName,
            pipelineVersion: response.pipelineVersion,
            stageStates: response.stageStates ?? [],
            created: response.created,
            updated: response.updated,
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

  const startPipelineExecution = tool({
    name: 'codepipeline_start_pipeline_execution',
    description: 'Manually trigger a pipeline execution',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      name: z.string().describe('Name of the pipeline'),
      clientRequestToken: z
        .string()
        .optional()
        .describe('Idempotency token (auto-generated if not provided)'),
      variables: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
          })
        )
        .optional()
        .describe('Pipeline variables to override'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codepipeline = await clientFactory.getCodePipelineClient(context);

        const command = new StartPipelineExecutionCommand({
          name: input.name,
          clientRequestToken: input.clientRequestToken,
          variables: input.variables,
        });

        const response = await retryWithBackoff(
          () => codepipeline.send(command),
          CODEPIPELINE_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            pipelineExecutionId: response.pipelineExecutionId,
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

  const getPipelineExecution = tool({
    name: 'codepipeline_get_pipeline_execution',
    description: 'Get details about a specific pipeline execution',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      pipelineName: z.string().describe('Name of the pipeline'),
      pipelineExecutionId: z.string().describe('Pipeline execution ID'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codepipeline = await clientFactory.getCodePipelineClient(context);

        const command = new GetPipelineExecutionCommand({
          pipelineName: input.pipelineName,
          pipelineExecutionId: input.pipelineExecutionId,
        });

        const response = await retryWithBackoff(
          () => codepipeline.send(command),
          CODEPIPELINE_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            pipelineExecution: response.pipelineExecution,
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

  const listPipelineExecutions = tool({
    name: 'codepipeline_list_pipeline_executions',
    description: 'List execution history for a pipeline',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      pipelineName: z.string().describe('Name of the pipeline'),
      maxResults: z.number().optional().describe('Maximum number of results (1-100)'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codepipeline = await clientFactory.getCodePipelineClient(context);

        const command = new ListPipelineExecutionsCommand({
          pipelineName: input.pipelineName,
          maxResults: input.maxResults,
          nextToken: input.nextToken,
        });

        const response = await retryWithBackoff(
          () => codepipeline.send(command),
          CODEPIPELINE_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            pipelineExecutionSummaries: response.pipelineExecutionSummaries ?? [],
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

  const stopPipelineExecution = tool({
    name: 'codepipeline_stop_pipeline_execution',
    description: 'Stop a running pipeline execution',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      pipelineName: z.string().describe('Name of the pipeline'),
      pipelineExecutionId: z.string().describe('Pipeline execution ID to stop'),
      abandon: z
        .boolean()
        .optional()
        .describe('Abandon execution (true) or wait for in-progress actions (false)'),
      reason: z.string().optional().describe('Reason for stopping the execution'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codepipeline = await clientFactory.getCodePipelineClient(context);

        const command = new StopPipelineExecutionCommand({
          pipelineName: input.pipelineName,
          pipelineExecutionId: input.pipelineExecutionId,
          abandon: input.abandon,
          reason: input.reason,
        });

        const response = await retryWithBackoff(
          () => codepipeline.send(command),
          CODEPIPELINE_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            pipelineExecutionId: response.pipelineExecutionId,
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

  const createPipeline = tool({
    name: 'codepipeline_create_pipeline',
    description: 'Create a new CodePipeline pipeline',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      pipeline: z.unknown().describe('Pipeline definition (PipelineDeclaration structure)'),
      tags: z
        .array(
          z.object({
            key: z.string(),
            value: z.string(),
          })
        )
        .optional()
        .describe('Resource tags'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codepipeline = await clientFactory.getCodePipelineClient(context);

        const command = new CreatePipelineCommand({
          pipeline: input.pipeline as PipelineDeclaration,
          tags: input.tags,
        });

        const response = await retryWithBackoff(
          () => codepipeline.send(command),
          CODEPIPELINE_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            pipeline: response.pipeline,
            tags: response.tags,
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

  const updatePipeline = tool({
    name: 'codepipeline_update_pipeline',
    description: 'Update an existing pipeline definition',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      pipeline: z.unknown().describe('Updated pipeline definition (PipelineDeclaration structure)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codepipeline = await clientFactory.getCodePipelineClient(context);

        const command = new UpdatePipelineCommand({
          pipeline: input.pipeline as PipelineDeclaration,
        });

        const response = await retryWithBackoff(
          () => codepipeline.send(command),
          CODEPIPELINE_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            pipeline: response.pipeline,
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

  const deletePipeline = tool({
    name: 'codepipeline_delete_pipeline',
    description: 'Delete a CodePipeline pipeline',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      name: z.string().describe('Name of the pipeline to delete'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codepipeline = await clientFactory.getCodePipelineClient(context);

        const command = new DeletePipelineCommand({
          name: input.name,
        });

        await retryWithBackoff(
          () => codepipeline.send(command),
          CODEPIPELINE_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            pipelineName: input.name,
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
    listPipelines,
    getPipeline,
    getPipelineState,
    startPipelineExecution,
    getPipelineExecution,
    listPipelineExecutions,
    stopPipelineExecution,
    createPipeline,
    updatePipeline,
    deletePipeline,
  ];
}
