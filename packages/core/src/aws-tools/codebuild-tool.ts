/**
 * AWS CodeBuild Tool - CI/CD build management for agents (Strands format)
 *
 * Operations:
 * - codebuild_create_project: Create build project with buildspec
 * - codebuild_start_build: Trigger build execution
 * - codebuild_batch_get_builds: Get build details (status, logs, artifacts)
 * - codebuild_list_builds_for_project: List builds for a project
 * - codebuild_stop_build: Cancel running build
 * - codebuild_delete_project: Remove build project
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  CodeBuildClient,
  CreateProjectCommand,
  StartBuildCommand,
  BatchGetBuildsCommand,
  ListBuildsForProjectCommand,
  StopBuildCommand,
  DeleteProjectCommand,
  type EnvironmentType,
  type ComputeType,
  type SourceType,
} from '@aws-sdk/client-codebuild';
import type { AWSClientFactory } from './client-factory';
import { createResourceTags } from './client-factory';
import { retryWithBackoff, formatToolError, CODEBUILD_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create CodeBuild Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of CodeBuild tools for Strands Agent
 */
export function createCodeBuildTools(clientFactory: AWSClientFactory) {
  const createProject = tool({
    name: 'codebuild_create_project',
    description: 'Create CodeBuild project with source, environment, and buildspec configuration',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      projectName: z.string().describe('Unique project name'),
      description: z.string().optional().describe('Project description'),
      serviceRole: z.string().describe('IAM role ARN with CodeBuild permissions'),
      sourceType: z.enum(['CODECOMMIT', 'GITHUB', 'S3', 'NO_SOURCE']).describe('Source provider type'),
      sourceLocation: z.string().optional().describe('Source repository location (repo URL, S3 path, etc)'),
      buildspec: z.string().optional().describe('Inline buildspec YAML or path to buildspec.yml in repo'),
      environmentType: z.enum(['LINUX_CONTAINER', 'LINUX_GPU_CONTAINER', 'ARM_CONTAINER', 'WINDOWS_CONTAINER']).describe('Build environment type'),
      image: z.string().describe('Docker image for build environment (e.g., aws/codebuild/standard:7.0)'),
      computeType: z.enum(['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE', 'BUILD_GENERAL1_2XLARGE']).describe('Compute size'),
      environmentVariables: z.array(z.object({
        name: z.string(),
        value: z.string(),
        type: z.enum(['PLAINTEXT', 'PARAMETER_STORE', 'SECRETS_MANAGER']).optional(),
      })).optional().describe('Environment variables for build'),
      timeoutInMinutes: z.number().optional().describe('Build timeout (5-480, default: 60)'),
      artifactsType: z.enum(['NO_ARTIFACTS', 'S3', 'CODEPIPELINE']).optional().describe('Artifact output type'),
      artifactsLocation: z.string().optional().describe('S3 bucket for artifacts'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const codebuild = await clientFactory.getCodeBuildClient(context);

        const resourceTags = createResourceTags(input.tenantId, input.agentId, { billingCategory: 'cicd-codebuild' });
        // CodeBuild uses lowercase 'key' and 'value'
        const tags = resourceTags.map((t) => ({ key: t.Key, value: t.Value }));

        const command = new CreateProjectCommand({
          name: input.projectName,
          description: input.description,
          serviceRole: input.serviceRole,
          source: {
            type: input.sourceType as SourceType,
            location: input.sourceLocation,
            buildspec: input.buildspec,
          },
          environment: {
            type: input.environmentType as EnvironmentType,
            image: input.image,
            computeType: input.computeType as ComputeType,
            environmentVariables: input.environmentVariables?.map((ev) => ({
              name: ev.name,
              value: ev.value,
              type: ev.type ?? 'PLAINTEXT',
            })),
          },
          artifacts: {
            type: input.artifactsType ?? 'NO_ARTIFACTS',
            location: input.artifactsLocation,
          },
          timeoutInMinutes: input.timeoutInMinutes ?? 60,
          tags,
        });

        const response = await retryWithBackoff(() => codebuild.send(command), CODEBUILD_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            projectArn: response.project?.arn,
            projectName: response.project?.name,
            created: response.project?.created,
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

  const startBuild = tool({
    name: 'codebuild_start_build',
    description: 'Trigger build execution for CodeBuild project',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      projectName: z.string().describe('CodeBuild project name'),
      sourceVersion: z.string().optional().describe('Source version (commit SHA, branch, tag)'),
      environmentVariablesOverride: z.array(z.object({
        name: z.string(),
        value: z.string(),
        type: z.enum(['PLAINTEXT', 'PARAMETER_STORE', 'SECRETS_MANAGER']).optional(),
      })).optional().describe('Override environment variables for this build'),
      buildspecOverride: z.string().optional().describe('Override buildspec for this build'),
      timeoutInMinutesOverride: z.number().optional().describe('Override build timeout'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const codebuild = await clientFactory.getCodeBuildClient(context);

        const command = new StartBuildCommand({
          projectName: input.projectName,
          sourceVersion: input.sourceVersion,
          environmentVariablesOverride: input.environmentVariablesOverride?.map((ev) => ({
            name: ev.name,
            value: ev.value,
            type: ev.type ?? 'PLAINTEXT',
          })),
          buildspecOverride: input.buildspecOverride,
          timeoutInMinutesOverride: input.timeoutInMinutesOverride,
        });

        const response = await retryWithBackoff(() => codebuild.send(command), CODEBUILD_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            buildId: response.build?.id,
            buildNumber: response.build?.buildNumber,
            buildStatus: response.build?.buildStatus,
            startTime: response.build?.startTime,
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

  const batchGetBuilds = tool({
    name: 'codebuild_batch_get_builds',
    description: 'Get details for one or more builds (status, logs, artifacts, duration)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      buildIds: z.array(z.string()).describe('Build IDs to retrieve (up to 100)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const codebuild = await clientFactory.getCodeBuildClient(context);

        const command = new BatchGetBuildsCommand({
          ids: input.buildIds,
        });

        const response = await retryWithBackoff(() => codebuild.send(command), CODEBUILD_RETRYABLE_ERRORS);

        const builds = (response.builds ?? []).map((build) => ({
          id: build.id,
          buildNumber: build.buildNumber,
          buildStatus: build.buildStatus,
          startTime: build.startTime,
          endTime: build.endTime,
          sourceVersion: build.sourceVersion,
          logs: {
            groupName: build.logs?.groupName,
            streamName: build.logs?.streamName,
            deepLink: build.logs?.deepLink,
          },
          artifacts: {
            location: build.artifacts?.location,
          },
          phases: build.phases?.map((phase) => ({
            phaseType: phase.phaseType,
            phaseStatus: phase.phaseStatus,
            durationInSeconds: phase.durationInSeconds,
          })),
        }));

        return JSON.stringify({
          success: true,
          data: {
            builds,
            buildsNotFound: response.buildsNotFound ?? [],
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

  const listBuildsForProject = tool({
    name: 'codebuild_list_builds_for_project',
    description: 'List build IDs for a CodeBuild project (sorted by start time descending)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      projectName: z.string().describe('CodeBuild project name'),
      sortOrder: z.enum(['ASCENDING', 'DESCENDING']).optional().describe('Sort order (default: DESCENDING)'),
      nextToken: z.string().optional().describe('Pagination token'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const codebuild = await clientFactory.getCodeBuildClient(context);

        const command = new ListBuildsForProjectCommand({
          projectName: input.projectName,
          sortOrder: input.sortOrder ?? 'DESCENDING',
          nextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => codebuild.send(command), CODEBUILD_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            buildIds: response.ids ?? [],
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

  const stopBuild = tool({
    name: 'codebuild_stop_build',
    description: 'Cancel running CodeBuild execution',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      buildId: z.string().describe('Build ID to stop'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const codebuild = await clientFactory.getCodeBuildClient(context);

        const command = new StopBuildCommand({
          id: input.buildId,
        });

        const response = await retryWithBackoff(() => codebuild.send(command), CODEBUILD_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            buildId: response.build?.id,
            buildStatus: response.build?.buildStatus,
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

  const deleteProject = tool({
    name: 'codebuild_delete_project',
    description: 'Delete CodeBuild project (builds are retained)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      projectName: z.string().describe('Project name to delete'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const codebuild = await clientFactory.getCodeBuildClient(context);

        const command = new DeleteProjectCommand({
          name: input.projectName,
        });

        await retryWithBackoff(() => codebuild.send(command), CODEBUILD_RETRYABLE_ERRORS);

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

  return [
    createProject,
    startBuild,
    batchGetBuilds,
    listBuildsForProject,
    stopBuild,
    deleteProject,
  ];
}
