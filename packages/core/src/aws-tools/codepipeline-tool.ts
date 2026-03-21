/**
 * AWS CodePipeline Tool - CI/CD pipeline management for agents (Strands format)
 *
 * ⚠️ BLOCKED: Missing infrastructure in client-factory.ts
 * Required: getCodePipelineClient() method + CodePipelineClient import
 * Required: CODEPIPELINE_RETRYABLE_ERRORS constant in tool-utils.ts
 *
 * Operations (pending infrastructure):
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
import type { AWSClientFactory } from './client-factory';

/**
 * Create CodePipeline Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of CodePipeline tools for Strands Agent
 */
export function createCodePipelineTools(clientFactory: AWSClientFactory) {
  // IMPLEMENTATION BLOCKED: Missing client factory infrastructure
  // Once added, implement tools following the pattern in lambda-tool.ts
  // Required AWS SDK imports:
  //   import {
  //     CodePipelineClient,
  //     ListPipelinesCommand,
  //     GetPipelineCommand,
  //     GetPipelineStateCommand,
  //     StartPipelineExecutionCommand,
  //     GetPipelineExecutionCommand,
  //     ListPipelineExecutionsCommand,
  //     StopPipelineExecutionCommand,
  //     CreatePipelineCommand,
  //     UpdatePipelineCommand,
  //     DeletePipelineCommand,
  //   } from '@aws-sdk/client-codepipeline';

  const errorMessage = `CodePipeline tools blocked: Missing infrastructure.

Required additions to client-factory.ts:
1. Import: CodePipelineClient from '@aws-sdk/client-codepipeline'
2. Add to AWSClient union type: | CodePipelineClient
3. Implement getter:
   async getCodePipelineClient(context: AWSToolContext): Promise<CodePipelineClient> {
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

Required additions to tool-utils.ts:
export const CODEPIPELINE_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalServerException',
  'ServiceUnavailableException',
  'TimeoutError',
];

Once infrastructure is added, implement tools following lambda-tool.ts pattern.`;

  // Return placeholder tools that throw informative errors
  const listPipelines = tool({
    name: 'codepipeline_list_pipelines',
    description: 'List CodePipeline pipelines (BLOCKED: missing infrastructure)',
    inputSchema: z.object({
      tenantId: z.string(),
      agentId: z.string(),
      region: z.string().optional(),
    }),
    callback: async () => {
      throw new Error(errorMessage);
    },
  });

  return [listPipelines];
}
