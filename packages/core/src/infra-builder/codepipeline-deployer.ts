/**
 * CodePipeline Deployment Manager
 *
 * Manages autonomous infrastructure deployment with approval gates:
 * - Create pipelines for agent-generated IaC
 * - Monitor execution status
 * - Handle manual approval actions
 * - Query change sets before deployment
 * - Track deployment history
 *
 * @see docs/research/validation/03-infra-workspace-deploy.md
 */

import {
  CodePipelineClient,
  CreatePipelineCommand,
  GetPipelineCommand,
  DeletePipelineCommand,
  StartPipelineExecutionCommand,
  GetPipelineExecutionCommand,
  ListPipelineExecutionsCommand,
  GetPipelineStateCommand,
  PutApprovalResultCommand,
  type PipelineDeclaration,
  type PipelineExecution as SDKPipelineExecution,
  type ApprovalResult,
} from '@aws-sdk/client-codepipeline';

import {
  CloudFormationClient,
  DescribeChangeSetCommand,
  DescribeStackDriftDetectionStatusCommand,
  DetectStackDriftCommand,
  type Change,
} from '@aws-sdk/client-cloudformation';

import type {
  AWSToolContext,
  PipelineConfig,
  PipelineExecution,
  StageExecution,
  ActionExecution,
  ApprovalAction,
  ApprovalStatus,
  ChangeSetSummary,
  ResourceChange,
  DriftDetection,
  InfraOperationResult,
  PipelineStatus,
  StageStatus,
} from './types';

/**
 * CodePipeline deployment manager for agent infrastructure
 */
export class CodePipelineDeployer {
  private readonly pipelineClient: CodePipelineClient;
  private readonly cfnClient: CloudFormationClient;

  constructor(
    private readonly context: AWSToolContext,
    pipelineClient?: CodePipelineClient,
    cfnClient?: CloudFormationClient
  ) {
    this.pipelineClient = pipelineClient ?? new CodePipelineClient({ region: context.region });
    this.cfnClient = cfnClient ?? new CloudFormationClient({ region: context.region });
  }

  /**
   * Create a deployment pipeline for infrastructure workspace
   *
   * @param config Pipeline configuration
   * @returns Created pipeline metadata
   */
  async createPipeline(
    config: PipelineConfig
  ): Promise<InfraOperationResult<{ pipelineArn: string; pipelineName: string }>> {
    const startTime = Date.now();

    try {
      // Build pipeline declaration
      const pipeline: PipelineDeclaration = {
        name: config.pipelineName,
        roleArn: config.roleArn,
        artifactStore: {
          type: 'S3',
          location: this.extractBucketName(config.artifactBucketArn),
        },
        stages: [
          // Source stage
          {
            name: 'Source',
            actions: [
              {
                name: 'SourceAction',
                actionTypeId: {
                  category: 'Source',
                  owner: 'AWS',
                  provider: 'CodeCommit',
                  version: '1',
                },
                configuration: {
                  RepositoryName: this.extractRepoName(config.repositoryArn),
                  BranchName: config.sourceBranch,
                  PollForSourceChanges: 'false', // Use EventBridge instead
                },
                outputArtifacts: [{ name: 'SourceOutput' }],
              },
            ],
          },
          // Build/Validate stage
          {
            name: 'Build',
            actions: [
              {
                name: 'ValidateTemplate',
                actionTypeId: {
                  category: 'Test',
                  owner: 'AWS',
                  provider: 'CloudFormation',
                  version: '1',
                },
                configuration: {
                  ActionMode: 'CHANGE_SET_REPLACE',
                  StackName: config.stackName,
                  ChangeSetName: `${config.stackName}-changeset`,
                  TemplatePath: `SourceOutput::${config.templatePath}`,
                  Capabilities: config.capabilities?.join(',') ?? 'CAPABILITY_IAM',
                  RoleArn: config.roleArn,
                  ParameterOverrides: this.formatParameters(config.parameters),
                },
                inputArtifacts: [{ name: 'SourceOutput' }],
              },
            ],
          },
        ],
      };

      // Tags for the pipeline (passed separately to CreatePipelineCommand)
      const pipelineTags = [
        { key: 'tenantId', value: this.context.tenantId },
        { key: 'agentId', value: this.context.agentId },
        { key: 'ManagedBy', value: `chimera-agent-${this.context.tenantId}` },
        ...(config.tags ? Object.entries(config.tags).map(([key, value]) => ({ key, value })) : []),
      ];

      // Add approval stage if required
      if (config.requireApproval) {
        pipeline.stages!.push({
          name: 'Approval',
          actions: [
            {
              name: 'ManualApproval',
              actionTypeId: {
                category: 'Approval',
                owner: 'AWS',
                provider: 'Manual',
                version: '1',
              },
              configuration: {
                NotificationArn: config.approvalTopicArn || '',
                CustomData: `Deployment approval required for stack: ${config.stackName}`,
                ExternalEntityLink: `https://console.aws.amazon.com/cloudformation/home?region=${this.context.region}#/stacks/changesets`,
              },
            },
          ],
        });
      }

      // Deploy stage
      pipeline.stages!.push({
        name: 'Deploy',
        actions: [
          {
            name: 'DeployStack',
            actionTypeId: {
              category: 'Deploy',
              owner: 'AWS',
              provider: 'CloudFormation',
              version: '1',
            },
            configuration: {
              ActionMode: 'CHANGE_SET_EXECUTE',
              StackName: config.stackName,
              ChangeSetName: `${config.stackName}-changeset`,
              RoleArn: config.roleArn,
            },
            inputArtifacts: [{ name: 'SourceOutput' }],
          },
        ],
      });

      const command = new CreatePipelineCommand({ pipeline, tags: pipelineTags });
      const response = await this.pipelineClient.send(command);

      const pipelineArn = `arn:aws:codepipeline:${this.context.region}:${this.extractAccountId(config.roleArn)}:${config.pipelineName}`;

      return {
        success: true,
        data: {
          pipelineArn,
          pipelineName: response.pipeline!.name!,
        },
        metadata: {
          requestId: response.$metadata.requestId,
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: (error as Error).name,
          message: (error as Error).message,
          details: error,
        },
        metadata: {
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Start a pipeline execution
   *
   * @param pipelineName Pipeline name
   * @returns Execution ID
   */
  async startExecution(
    pipelineName: string
  ): Promise<InfraOperationResult<{ executionId: string }>> {
    const startTime = Date.now();

    try {
      const command = new StartPipelineExecutionCommand({ name: pipelineName });
      const response = await this.pipelineClient.send(command);

      return {
        success: true,
        data: { executionId: response.pipelineExecutionId! },
        metadata: {
          requestId: response.$metadata.requestId,
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: (error as Error).name,
          message: (error as Error).message,
          details: error,
        },
        metadata: {
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Get pipeline execution status
   *
   * @param pipelineName Pipeline name
   * @param executionId Execution ID
   * @returns Execution details
   */
  async getExecution(
    pipelineName: string,
    executionId: string
  ): Promise<InfraOperationResult<PipelineExecution>> {
    const startTime = Date.now();

    try {
      const command = new GetPipelineExecutionCommand({ pipelineName, pipelineExecutionId: executionId });
      const response = await this.pipelineClient.send(command);

      const execution = response.pipelineExecution!;
      const pipelineArn = `arn:aws:codepipeline:${this.context.region}:*:${pipelineName}`;

      // Cast to access properties that may not be in the type definition
      const executionAny = execution as any;

      const result: PipelineExecution = {
        pipelineArn,
        executionId: executionId,
        pipelineName,
        status: execution.status as PipelineStatus,
        pipelineVersion: execution.pipelineVersion,
        startTime: executionAny.startTime?.toISOString?.() ?? new Date().toISOString(),
        endTime: executionAny.lastUpdateTime?.toISOString?.(),
      };

      return {
        success: true,
        data: result,
        metadata: {
          requestId: response.$metadata.requestId,
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: (error as Error).name,
          message: (error as Error).message,
          details: error,
        },
        metadata: {
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Get current pipeline state with stage/action details
   *
   * @param pipelineName Pipeline name
   * @returns Pipeline state with stages and actions
   */
  async getPipelineState(
    pipelineName: string
  ): Promise<InfraOperationResult<{ stages: StageExecution[] }>> {
    const startTime = Date.now();

    try {
      const command = new GetPipelineStateCommand({ name: pipelineName });
      const response = await this.pipelineClient.send(command);

      const stages: StageExecution[] = (response.stageStates ?? []).map((stage: any) => ({
        stageName: stage.stageName!,
        status: (stage.latestExecution?.status ?? 'InProgress') as StageStatus,
        startTime: stage.latestExecution?.lastStatusChange?.toISOString(),
        actions: (stage.actionStates ?? []).map((action: any) => ({
          actionName: action.actionName!,
          status: (action.latestExecution?.status ?? 'InProgress') as StageStatus,
          startTime: action.latestExecution?.lastStatusChange?.toISOString(),
          externalExecutionId: action.latestExecution?.externalExecutionId,
          externalExecutionUrl: action.latestExecution?.externalExecutionUrl,
          errorMessage: action.latestExecution?.errorDetails?.message,
        })),
      }));

      return {
        success: true,
        data: { stages },
        metadata: {
          requestId: response.$metadata.requestId,
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: (error as Error).name,
          message: (error as Error).message,
          details: error,
        },
        metadata: {
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Approve or reject a manual approval action
   *
   * @param pipelineName Pipeline name
   * @param stageName Stage name containing approval
   * @param actionName Action name
   * @param token Approval token
   * @param approved True to approve, false to reject
   * @param summary Optional approval summary
   * @returns Operation result
   */
  async respondToApproval(
    pipelineName: string,
    stageName: string,
    actionName: string,
    token: string,
    approved: boolean,
    summary?: string
  ): Promise<InfraOperationResult<void>> {
    const startTime = Date.now();

    try {
      const result: ApprovalResult = {
        status: approved ? 'Approved' : 'Rejected',
        summary: summary ?? (approved ? 'Approved by agent' : 'Rejected by agent'),
      };

      const command = new PutApprovalResultCommand({
        pipelineName,
        stageName,
        actionName,
        token,
        result,
      });

      const response = await this.pipelineClient.send(command);

      return {
        success: true,
        metadata: {
          requestId: response.$metadata.requestId,
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: (error as Error).name,
          message: (error as Error).message,
          details: error,
        },
        metadata: {
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Get CloudFormation change set details
   *
   * @param stackName Stack name
   * @param changeSetName Change set name
   * @returns Change set summary
   */
  async getChangeSet(
    stackName: string,
    changeSetName: string
  ): Promise<InfraOperationResult<ChangeSetSummary>> {
    const startTime = Date.now();

    try {
      const command = new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName });
      const response = await this.cfnClient.send(command);

      const changes: ResourceChange[] = (response.Changes ?? []).map((change: Change) => ({
        action: change.ResourceChange?.Action as any,
        logicalResourceId: change.ResourceChange?.LogicalResourceId ?? '',
        physicalResourceId: change.ResourceChange?.PhysicalResourceId,
        resourceType: change.ResourceChange?.ResourceType ?? '',
        replacement: change.ResourceChange?.Replacement as any,
        scope: change.ResourceChange?.Scope as any,
        details: change.ResourceChange?.Details?.map((detail: any) => ({
          target: {
            attribute: detail.Target?.Attribute ?? '',
            name: detail.Target?.Name,
            requiresRecreation: detail.Target?.RequiresRecreation as any,
          },
          evaluation: detail.Evaluation as any,
          changeSource: detail.ChangeSource as any,
        })),
      }));

      // Cast response to access properties that may not be in the type definition
      const responseAny = response as any;

      const changeSet: ChangeSetSummary = {
        changeSetId: response.ChangeSetId!,
        changeSetName: response.ChangeSetName!,
        stackName: response.StackName!,
        changeSetType: responseAny.ChangeSetType,
        executionStatus: responseAny.ExecutionStatus,
        status: responseAny.Status,
        statusReason: response.StatusReason,
        createdAt: response.CreationTime?.toISOString() ?? new Date().toISOString(),
        changes,
      };

      return {
        success: true,
        data: changeSet,
        metadata: {
          requestId: response.$metadata.requestId,
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: (error as Error).name,
          message: (error as Error).message,
          details: error,
        },
        metadata: {
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Detect stack drift
   *
   * @param stackName Stack name
   * @returns Drift detection result
   */
  async detectDrift(
    stackName: string
  ): Promise<InfraOperationResult<DriftDetection>> {
    const startTime = Date.now();

    try {
      // Initiate drift detection
      const detectCommand = new DetectStackDriftCommand({ StackName: stackName });
      const detectResponse = await this.cfnClient.send(detectCommand);

      const detectionId = detectResponse.StackDriftDetectionId!;

      // Poll for completion (simplified - in production use waiter)
      let status = 'DETECTION_IN_PROGRESS';
      let attempts = 0;
      const maxAttempts = 30;

      while (status === 'DETECTION_IN_PROGRESS' && attempts < maxAttempts) {
        await this.sleep(2000);

        const statusCommand = new DescribeStackDriftDetectionStatusCommand({ StackDriftDetectionId: detectionId });
        const statusResponse = await this.cfnClient.send(statusCommand);

        status = statusResponse.DetectionStatus!;

        if (status === 'DETECTION_COMPLETE') {
          const drift: DriftDetection = {
            stackId: statusResponse.StackId!,
            stackName: stackName,
            driftStatus: statusResponse.StackDriftStatus as any,
            detectionTime: statusResponse.Timestamp?.toISOString() ?? new Date().toISOString(),
            driftedResourceCount: statusResponse.DriftedStackResourceCount ?? 0,
            driftedResources: [], // Full details require separate API call
          };

          return {
            success: true,
            data: drift,
            metadata: {
              region: this.context.region ?? 'us-east-1',
              durationMs: Date.now() - startTime,
            },
          };
        }

        attempts++;
      }

      throw new Error('Drift detection timed out');
    } catch (error) {
      return {
        success: false,
        error: {
          code: (error as Error).name,
          message: (error as Error).message,
          details: error,
        },
        metadata: {
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Delete a pipeline
   *
   * @param pipelineName Pipeline name
   * @returns Operation result
   */
  async deletePipeline(pipelineName: string): Promise<InfraOperationResult<void>> {
    const startTime = Date.now();

    try {
      const command = new DeletePipelineCommand({ name: pipelineName });
      const response = await this.pipelineClient.send(command);

      return {
        success: true,
        metadata: {
          requestId: response.$metadata.requestId,
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: (error as Error).name,
          message: (error as Error).message,
          details: error,
        },
        metadata: {
          region: this.context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  // Helper methods

  private extractBucketName(bucketArn: string): string {
    return bucketArn.split(':').pop()!;
  }

  private extractRepoName(repoArn: string): string {
    return repoArn.split(':').pop()!;
  }

  private extractAccountId(roleArn: string): string {
    return roleArn.split(':')[4];
  }

  private formatParameters(params?: Record<string, string>): string {
    if (!params) return '{}';
    return JSON.stringify(params);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
