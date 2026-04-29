/**
 * Tests for buildFailedStageReport — CLI-1 / chimera-cc6f / Wave-33.
 *
 * `chimera logs --json` used to derive `executionStatus` by inference from
 * ListActionExecutions: if every visible action was Succeeded, it reported
 * `"executionStatus": "Succeeded"`. That is wrong whenever the pipeline is
 * still running but later stages (Deploy / Test / Rollout) haven't started —
 * ListActionExecutions only returns actions that *have* run, so the action
 * list looks all-green while the pipeline's real status is InProgress.
 *
 * Fix: call GetPipelineExecution and use `pipelineExecution.status` as the
 * authoritative overall status. ListActionExecutions is still used for
 * per-stage detail.
 *
 * The test below exercises that exact scenario — only a Source action is
 * returned from the action list (all Succeeded), but GetPipelineExecution
 * reports InProgress. The old behavior would have reported Succeeded; the
 * new behavior must report InProgress.
 */

import {
  CodePipelineClient,
  GetPipelineExecutionCommand,
  ListActionExecutionsCommand,
} from '@aws-sdk/client-codepipeline';
import { CodeBuildClient } from '@aws-sdk/client-codebuild';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { buildFailedStageReport } from '../utils/pipeline-logs';

describe('buildFailedStageReport — authoritative executionStatus (CLI-1)', () => {
  it('reports InProgress when GetPipelineExecution says InProgress even though all visible actions are Succeeded', async () => {
    const executionId = 'ad6f6236-837a-4361-82ce-49cab220af81';

    const codepipeline = {
      send: jest.fn(async (command: unknown) => {
        if (command instanceof GetPipelineExecutionCommand) {
          return {
            pipelineExecution: {
              pipelineName: 'chimera-deploy-dev',
              pipelineExecutionId: executionId,
              status: 'InProgress',
            },
          };
        }
        if (command instanceof ListActionExecutionsCommand) {
          // Only Source has run so far — Build/Deploy/Test/Rollout haven't
          // started yet, so AWS returns nothing for them. Pre-fix, the CLI
          // saw "every action is Succeeded" and reported Succeeded.
          return {
            actionExecutionDetails: [
              {
                stageName: 'Source',
                actionName: 'Source',
                status: 'Succeeded',
                startTime: new Date('2026-04-28T10:00:00Z'),
                lastUpdateTime: new Date('2026-04-28T10:00:30Z'),
                output: { executionResult: {} },
              },
            ],
          };
        }
        throw new Error(`Unexpected command: ${String(command)}`);
      }),
    } as unknown as CodePipelineClient;

    const codebuild = { send: jest.fn() } as unknown as CodeBuildClient;
    const logs = { send: jest.fn() } as unknown as CloudWatchLogsClient;

    const report = await buildFailedStageReport(
      codepipeline,
      codebuild,
      logs,
      'chimera-deploy-dev',
      executionId,
    );

    expect(report.executionStatus).toBe('InProgress');
    expect(report.executionId).toBe(executionId);
    // Sanity: action list still flows through for per-stage UI.
    expect(report.stages).toHaveLength(1);
    expect(report.stages[0]?.status).toBe('Succeeded');
    // No failed action, so no CodeBuild/CloudWatch resolution was attempted.
    expect(report.failedAction).toBeUndefined();
    expect(codebuild.send).not.toHaveBeenCalled();
    expect(logs.send).not.toHaveBeenCalled();
  });

  it('propagates Succeeded when GetPipelineExecution confirms Succeeded', async () => {
    const executionId = 'succeeded-exec-id';

    const codepipeline = {
      send: jest.fn(async (command: unknown) => {
        if (command instanceof GetPipelineExecutionCommand) {
          return {
            pipelineExecution: {
              pipelineName: 'chimera-deploy-dev',
              pipelineExecutionId: executionId,
              status: 'Succeeded',
            },
          };
        }
        if (command instanceof ListActionExecutionsCommand) {
          return {
            actionExecutionDetails: [
              {
                stageName: 'Source',
                actionName: 'Source',
                status: 'Succeeded',
                startTime: new Date('2026-04-28T10:00:00Z'),
                lastUpdateTime: new Date('2026-04-28T10:00:30Z'),
                output: { executionResult: {} },
              },
              {
                stageName: 'Deploy',
                actionName: 'Deploy',
                status: 'Succeeded',
                startTime: new Date('2026-04-28T10:05:00Z'),
                lastUpdateTime: new Date('2026-04-28T10:30:00Z'),
                output: { executionResult: {} },
              },
            ],
          };
        }
        throw new Error(`Unexpected command: ${String(command)}`);
      }),
    } as unknown as CodePipelineClient;

    const codebuild = { send: jest.fn() } as unknown as CodeBuildClient;
    const logs = { send: jest.fn() } as unknown as CloudWatchLogsClient;

    const report = await buildFailedStageReport(
      codepipeline,
      codebuild,
      logs,
      'chimera-deploy-dev',
      executionId,
    );

    expect(report.executionStatus).toBe('Succeeded');
    expect(report.stages).toHaveLength(2);
  });

  it('falls back to stage-inferred status if GetPipelineExecution throws', async () => {
    const executionId = 'fallback-exec-id';

    const codepipeline = {
      send: jest.fn(async (command: unknown) => {
        if (command instanceof GetPipelineExecutionCommand) {
          throw new Error('AccessDenied');
        }
        if (command instanceof ListActionExecutionsCommand) {
          return {
            actionExecutionDetails: [
              {
                stageName: 'Build',
                actionName: 'Build_Package',
                status: 'Failed',
                startTime: new Date('2026-04-28T10:00:00Z'),
                lastUpdateTime: new Date('2026-04-28T10:00:30Z'),
                output: {
                  executionResult: {
                    externalExecutionId: undefined,
                    externalExecutionSummary: 'build failed',
                  },
                },
              },
            ],
          };
        }
        throw new Error(`Unexpected command: ${String(command)}`);
      }),
    } as unknown as CodePipelineClient;

    const codebuild = { send: jest.fn() } as unknown as CodeBuildClient;
    const logs = { send: jest.fn() } as unknown as CloudWatchLogsClient;

    const report = await buildFailedStageReport(
      codepipeline,
      codebuild,
      logs,
      'chimera-deploy-dev',
      executionId,
    );

    // Fallback path still works: infers Failed from the visible action list.
    expect(report.executionStatus).toBe('Failed');
    expect(report.failedAction?.actionName).toBe('Build_Package');
  });
});
