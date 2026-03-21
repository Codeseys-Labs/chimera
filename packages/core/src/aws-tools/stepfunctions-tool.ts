/**
 * AWS Step Functions Tool - Workflow orchestration for agents (Strands format)
 *
 * ⚠️ BLOCKED: Missing infrastructure in client-factory.ts
 * Required: getStepFunctionsClient() method + SFNClient import
 * Required: STEPFUNCTIONS_RETRYABLE_ERRORS constant in tool-utils.ts
 *
 * Operations (pending infrastructure):
 * - stepfunctions_create_state_machine: Create workflow definition
 * - stepfunctions_start_execution: Start workflow execution
 * - stepfunctions_describe_execution: Get execution status and history
 * - stepfunctions_stop_execution: Cancel running execution
 * - stepfunctions_list_executions: List executions for state machine
 * - stepfunctions_describe_state_machine: Get state machine definition
 * - stepfunctions_update_state_machine: Modify workflow definition
 * - stepfunctions_delete_state_machine: Remove state machine
 * - stepfunctions_list_state_machines: List all state machines
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import type { AWSClientFactory } from './client-factory';

/**
 * Create Step Functions Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of Step Functions tools for Strands Agent
 */
export function createStepFunctionsTools(clientFactory: AWSClientFactory) {
  // IMPLEMENTATION BLOCKED: Missing client factory infrastructure
  // Once added, implement tools following the pattern in lambda-tool.ts
  // Required AWS SDK imports:
  //   import {
  //     SFNClient,
  //     CreateStateMachineCommand,
  //     StartExecutionCommand,
  //     DescribeExecutionCommand,
  //     StopExecutionCommand,
  //     ListExecutionsCommand,
  //     DescribeStateMachineCommand,
  //     UpdateStateMachineCommand,
  //     DeleteStateMachineCommand,
  //     ListStateMachinesCommand,
  //   } from '@aws-sdk/client-sfn';

  const errorMessage = `Step Functions tools blocked: Missing infrastructure.

Required additions to client-factory.ts:
1. Import: SFNClient from '@aws-sdk/client-sfn'
2. Add to AWSClient union type: | SFNClient
3. Implement getter:
   async getStepFunctionsClient(context: AWSToolContext): Promise<SFNClient> {
     return this.getOrCreateClient(
       'stepfunctions',
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

Required additions to tool-utils.ts:
export const STEPFUNCTIONS_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalServerException',
  'ServiceUnavailableException',
  'TimeoutError',
];

Once infrastructure is added, implement tools following lambda-tool.ts pattern.`;

  // Return placeholder tools that throw informative errors
  const createStateMachine = tool({
    name: 'stepfunctions_create_state_machine',
    description: 'Create Step Functions state machine (BLOCKED: missing infrastructure)',
    inputSchema: z.object({
      tenantId: z.string(),
      agentId: z.string(),
      region: z.string().optional(),
    }),
    callback: async () => {
      throw new Error(errorMessage);
    },
  });

  return [createStateMachine];
}
