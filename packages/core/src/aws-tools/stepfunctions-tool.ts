/**
 * AWS Step Functions Tool - Workflow orchestration for agents (Strands format)
 *
 * Operations:
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
import {
  SFNClient,
  CreateStateMachineCommand,
  StartExecutionCommand,
  DescribeExecutionCommand,
  StopExecutionCommand,
  ListExecutionsCommand,
  DescribeStateMachineCommand,
  UpdateStateMachineCommand,
  DeleteStateMachineCommand,
  ListStateMachinesCommand,
  type StateMachineType,
  type LogLevel,
  type TracingConfiguration,
  type LoggingConfiguration,
} from '@aws-sdk/client-sfn';
import type { AWSClientFactory } from './client-factory';
import { createResourceTags } from './client-factory';
import { retryWithBackoff, formatToolError } from './tool-utils';

/**
 * Retryable error codes for Step Functions operations
 */
export const STEPFUNCTIONS_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalServerException',
  'ServiceUnavailableException',
  'TimeoutError',
];

/**
 * Create Step Functions Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of Step Functions tools for Strands Agent
 */
export function createStepFunctionsTools(clientFactory: AWSClientFactory) {
  const createStateMachine = tool({
    name: 'stepfunctions_create_state_machine',
    description: 'Create a new Step Functions state machine',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      name: z.string().describe('Name for the state machine'),
      definition: z.string().describe('Amazon States Language definition (JSON string)'),
      roleArn: z.string().describe('IAM role ARN for Step Functions execution'),
      type: z
        .enum(['STANDARD', 'EXPRESS'])
        .optional()
        .describe('State machine type (default: STANDARD)'),
      loggingConfiguration: z
        .object({
          level: z.enum(['ALL', 'ERROR', 'FATAL', 'OFF']),
          includeExecutionData: z.boolean().optional(),
          destinations: z
            .array(
              z.object({
                cloudWatchLogsLogGroup: z.object({
                  logGroupArn: z.string(),
                }),
              })
            )
            .optional(),
        })
        .optional()
        .describe('CloudWatch Logs configuration'),
      tracingConfiguration: z
        .object({
          enabled: z.boolean(),
        })
        .optional()
        .describe('X-Ray tracing configuration'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const sfn = await clientFactory.getSFNClient(context);

        const command = new CreateStateMachineCommand({
          name: input.name,
          definition: input.definition,
          roleArn: input.roleArn,
          type: (input.type ?? 'STANDARD') as StateMachineType,
          loggingConfiguration: input.loggingConfiguration as LoggingConfiguration,
          tracingConfiguration: input.tracingConfiguration as TracingConfiguration,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tags: createResourceTags(input.tenantId, input.agentId, {
            billingCategory: 'workflow-stepfunctions',
          }) as any,
        });

        const response = await retryWithBackoff(
          () => sfn.send(command),
          STEPFUNCTIONS_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            stateMachineArn: response.stateMachineArn,
            creationDate: response.creationDate,
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

  const startExecution = tool({
    name: 'stepfunctions_start_execution',
    description: 'Start a Step Functions state machine execution',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      stateMachineArn: z.string().describe('ARN of the state machine'),
      name: z.string().optional().describe('Name for the execution (auto-generated if omitted)'),
      input: z.string().optional().describe('Input JSON for the execution'),
      traceHeader: z.string().optional().describe('X-Ray trace header'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const sfn = await clientFactory.getSFNClient(context);

        const command = new StartExecutionCommand({
          stateMachineArn: input.stateMachineArn,
          name: input.name,
          input: input.input,
          traceHeader: input.traceHeader,
        });

        const response = await retryWithBackoff(
          () => sfn.send(command),
          STEPFUNCTIONS_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            executionArn: response.executionArn,
            startDate: response.startDate,
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

  const describeExecution = tool({
    name: 'stepfunctions_describe_execution',
    description: 'Get details about a Step Functions execution',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      executionArn: z.string().describe('ARN of the execution'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const sfn = await clientFactory.getSFNClient(context);

        const command = new DescribeExecutionCommand({
          executionArn: input.executionArn,
        });

        const response = await retryWithBackoff(
          () => sfn.send(command),
          STEPFUNCTIONS_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            executionArn: response.executionArn,
            stateMachineArn: response.stateMachineArn,
            name: response.name,
            status: response.status,
            startDate: response.startDate,
            stopDate: response.stopDate,
            input: response.input,
            output: response.output,
            error: response.error,
            cause: response.cause,
            traceHeader: response.traceHeader,
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

  const stopExecution = tool({
    name: 'stepfunctions_stop_execution',
    description: 'Stop a running Step Functions execution',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      executionArn: z.string().describe('ARN of the execution to stop'),
      error: z.string().optional().describe('Error code'),
      cause: z.string().optional().describe('Human-readable cause for stopping'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const sfn = await clientFactory.getSFNClient(context);

        const command = new StopExecutionCommand({
          executionArn: input.executionArn,
          error: input.error,
          cause: input.cause,
        });

        const response = await retryWithBackoff(
          () => sfn.send(command),
          STEPFUNCTIONS_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            stopDate: response.stopDate,
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

  const listExecutions = tool({
    name: 'stepfunctions_list_executions',
    description: 'List executions for a Step Functions state machine',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      stateMachineArn: z.string().describe('ARN of the state machine'),
      statusFilter: z
        .enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'])
        .optional()
        .describe('Filter by execution status'),
      maxResults: z.number().optional().describe('Maximum number of results (1-1000)'),
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
        const sfn = await clientFactory.getSFNClient(context);

        const command = new ListExecutionsCommand({
          stateMachineArn: input.stateMachineArn,
          statusFilter: input.statusFilter,
          maxResults: input.maxResults,
          nextToken: input.nextToken,
        });

        const response = await retryWithBackoff(
          () => sfn.send(command),
          STEPFUNCTIONS_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            executions: response.executions ?? [],
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

  const describeStateMachine = tool({
    name: 'stepfunctions_describe_state_machine',
    description: 'Get details about a Step Functions state machine',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      stateMachineArn: z.string().describe('ARN of the state machine'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const sfn = await clientFactory.getSFNClient(context);

        const command = new DescribeStateMachineCommand({
          stateMachineArn: input.stateMachineArn,
        });

        const response = await retryWithBackoff(
          () => sfn.send(command),
          STEPFUNCTIONS_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            stateMachineArn: response.stateMachineArn,
            name: response.name,
            status: response.status,
            definition: response.definition,
            roleArn: response.roleArn,
            type: response.type,
            creationDate: response.creationDate,
            loggingConfiguration: response.loggingConfiguration,
            tracingConfiguration: response.tracingConfiguration,
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

  const updateStateMachine = tool({
    name: 'stepfunctions_update_state_machine',
    description: 'Update an existing Step Functions state machine',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      stateMachineArn: z.string().describe('ARN of the state machine'),
      definition: z
        .string()
        .optional()
        .describe('Updated Amazon States Language definition (JSON string)'),
      roleArn: z.string().optional().describe('Updated IAM role ARN'),
      loggingConfiguration: z
        .object({
          level: z.enum(['ALL', 'ERROR', 'FATAL', 'OFF']),
          includeExecutionData: z.boolean().optional(),
          destinations: z
            .array(
              z.object({
                cloudWatchLogsLogGroup: z.object({
                  logGroupArn: z.string(),
                }),
              })
            )
            .optional(),
        })
        .optional()
        .describe('Updated CloudWatch Logs configuration'),
      tracingConfiguration: z
        .object({
          enabled: z.boolean(),
        })
        .optional()
        .describe('Updated X-Ray tracing configuration'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const sfn = await clientFactory.getSFNClient(context);

        const command = new UpdateStateMachineCommand({
          stateMachineArn: input.stateMachineArn,
          definition: input.definition,
          roleArn: input.roleArn,
          loggingConfiguration: input.loggingConfiguration as LoggingConfiguration,
          tracingConfiguration: input.tracingConfiguration as TracingConfiguration,
        });

        const response = await retryWithBackoff(
          () => sfn.send(command),
          STEPFUNCTIONS_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            updateDate: response.updateDate,
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

  const deleteStateMachine = tool({
    name: 'stepfunctions_delete_state_machine',
    description: 'Delete a Step Functions state machine',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      stateMachineArn: z.string().describe('ARN of the state machine to delete'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const sfn = await clientFactory.getSFNClient(context);

        const command = new DeleteStateMachineCommand({
          stateMachineArn: input.stateMachineArn,
        });

        await retryWithBackoff(
          () => sfn.send(command),
          STEPFUNCTIONS_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            stateMachineArn: input.stateMachineArn,
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

  const listStateMachines = tool({
    name: 'stepfunctions_list_state_machines',
    description: 'List all Step Functions state machines in the AWS account',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      maxResults: z.number().optional().describe('Maximum number of results (1-1000)'),
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
        const sfn = await clientFactory.getSFNClient(context);

        const command = new ListStateMachinesCommand({
          maxResults: input.maxResults,
          nextToken: input.nextToken,
        });

        const response = await retryWithBackoff(
          () => sfn.send(command),
          STEPFUNCTIONS_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            stateMachines: response.stateMachines ?? [],
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
    createStateMachine,
    startExecution,
    describeExecution,
    stopExecution,
    listExecutions,
    describeStateMachine,
    updateStateMachine,
    deleteStateMachine,
    listStateMachines,
  ];
}
