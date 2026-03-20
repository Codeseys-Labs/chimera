/**
 * CodeCommit Workspace Manager
 *
 * Manages agent-owned IaC repositories in CodeCommit:
 * - Create isolated workspaces per tenant/agent
 * - Commit CDK/CloudFormation code from agent generation
 * - Track workspace status and history
 * - Integration with CodePipeline for deployment
 *
 * @see docs/research/validation/03-infra-workspace-deploy.md
 */

import {
  CodeCommitClient,
  CreateRepositoryCommand,
  GetRepositoryCommand,
  DeleteRepositoryCommand,
  CreateBranchCommand,
  PutFileCommand,
  GetBranchCommand,
  ListRepositoriesCommand,
  type Repository,
  type BranchInfo,
} from '@aws-sdk/client-codecommit';

import type {
  AWSToolContext,
  InfraWorkspace,
  RepositoryConfig,
  CommitMetadata,
  FileCommit,
  WorkspaceStatus,
  InfraOperationResult,
} from './types';

/**
 * CodeCommit workspace manager for agent-generated IaC
 */
export class CodeCommitWorkspaceManager {
  private readonly client: CodeCommitClient;

  constructor(
    private readonly context: AWSToolContext,
    client?: CodeCommitClient
  ) {
    this.client = client ?? new CodeCommitClient({ region: context.region });
  }

  /**
   * Create a new IaC workspace in CodeCommit
   *
   * @param config Repository configuration
   * @returns Created workspace metadata
   */
  async createWorkspace(
    config: RepositoryConfig
  ): Promise<InfraOperationResult<InfraWorkspace>> {
    const startTime = Date.now();

    try {
      const command = new CreateRepositoryCommand({
        repositoryName: config.repositoryName,
        repositoryDescription: config.description,
        tags: {
          tenantId: this.context.tenantId,
          agentId: this.context.agentId,
          ManagedBy: `chimera-agent-${this.context.tenantId}`,
          CreatedAt: new Date().toISOString(),
          ...config.tags,
        },
        kmsKeyId: config.kmsKeyArn,
      });

      const response = await this.client.send(command);
      const repository = response.repositoryMetadata;

      if (!repository) {
        throw new Error('Repository creation returned empty metadata');
      }

      // Create default branch if specified
      const defaultBranch = config.defaultBranch ?? 'main';
      if (defaultBranch !== 'main') {
        await this.createBranch(
          config.repositoryName,
          defaultBranch,
          'HEAD' // Branch from default HEAD
        );
      }

      const workspace: InfraWorkspace = {
        workspaceId: `${this.context.tenantId}-${config.repositoryName}`,
        tenantId: this.context.tenantId,
        agentId: this.context.agentId,
        repositoryArn: repository.Arn!,
        repositoryName: repository.repositoryName!,
        defaultBranch,
        cloneUrl: repository.cloneUrlHttp!,
        status: 'READY' as WorkspaceStatus,
        createdAt: repository.creationDate?.toISOString() ?? new Date().toISOString(),
      };

      return {
        success: true,
        data: workspace,
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
   * Get workspace metadata
   *
   * @param repositoryName Repository name
   * @returns Workspace metadata
   */
  async getWorkspace(
    repositoryName: string
  ): Promise<InfraOperationResult<InfraWorkspace>> {
    const startTime = Date.now();

    try {
      const command = new GetRepositoryCommand({ repositoryName });
      const response = await this.client.send(command);
      const repository = response.repositoryMetadata;

      if (!repository) {
        throw new Error('Repository not found');
      }

      const workspace: InfraWorkspace = {
        workspaceId: `${this.context.tenantId}-${repositoryName}`,
        tenantId: this.context.tenantId,
        agentId: this.context.agentId,
        repositoryArn: repository.Arn!,
        repositoryName: repository.repositoryName!,
        defaultBranch: repository.defaultBranch ?? 'main',
        cloneUrl: repository.cloneUrlHttp!,
        status: 'READY' as WorkspaceStatus,
        createdAt: repository.creationDate?.toISOString() ?? new Date().toISOString(),
        lastCommitAt: repository.lastModifiedDate?.toISOString(),
      };

      return {
        success: true,
        data: workspace,
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
   * Delete a workspace (archives repository)
   *
   * @param repositoryName Repository name to delete
   * @returns Operation result
   */
  async deleteWorkspace(
    repositoryName: string
  ): Promise<InfraOperationResult<void>> {
    const startTime = Date.now();

    try {
      const command = new DeleteRepositoryCommand({ repositoryName });
      const response = await this.client.send(command);

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
   * Commit files to workspace
   *
   * @param repositoryName Repository name
   * @param branchName Branch name
   * @param files Files to commit
   * @param commitMessage Commit message
   * @param authorName Author name
   * @param authorEmail Author email
   * @returns Commit metadata
   */
  async commitFiles(
    repositoryName: string,
    branchName: string,
    files: FileCommit[],
    commitMessage: string,
    authorName?: string,
    authorEmail?: string
  ): Promise<InfraOperationResult<CommitMetadata>> {
    const startTime = Date.now();

    try {
      // Get current branch HEAD
      const branchResponse = await this.client.send(
        new GetBranchCommand({ repositoryName, branchName })
      );

      const parentCommitId = branchResponse.branch?.commitId;

      // Commit each file (CodeCommit API requires one PutFile per file)
      // In production, we'd batch these or use CreateCommit for multiple files
      let lastCommitId = parentCommitId;

      for (const file of files) {
        const putFileCommand = new PutFileCommand({
          repositoryName,
          branchName,
          fileContent: Buffer.from(file.content, 'utf-8'),
          filePath: file.filePath,
          fileMode: file.fileMode ?? '100644',
          parentCommitId: lastCommitId,
          commitMessage: files.length === 1 ? commitMessage : `${commitMessage} (${file.filePath})`,
          name: authorName ?? this.context.agentId,
          email: authorEmail ?? `${this.context.agentId}@chimera.local`,
        });

        const response = await this.client.send(putFileCommand);
        lastCommitId = response.commitId;
      }

      const metadata: CommitMetadata = {
        commitId: lastCommitId!,
        message: commitMessage,
        authorName: authorName ?? this.context.agentId,
        authorEmail: authorEmail ?? `${this.context.agentId}@chimera.local`,
        timestamp: new Date().toISOString(),
        parentCommitId,
        treeId: lastCommitId!, // Simplified - treeId same as commitId for this use case
      };

      return {
        success: true,
        data: metadata,
        metadata: {
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
   * Create a new branch in workspace
   *
   * @param repositoryName Repository name
   * @param branchName New branch name
   * @param commitId Commit ID to branch from
   * @returns Operation result
   */
  async createBranch(
    repositoryName: string,
    branchName: string,
    commitId: string
  ): Promise<InfraOperationResult<BranchInfo>> {
    const startTime = Date.now();

    try {
      const command = new CreateBranchCommand({
        repositoryName,
        branchName,
        commitId,
      });

      const response = await this.client.send(command);

      // Get branch info
      const branchResponse = await this.client.send(
        new GetBranchCommand({ repositoryName, branchName })
      );

      return {
        success: true,
        data: branchResponse.branch,
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
   * List all workspaces for this tenant
   *
   * @returns Array of workspace metadata
   */
  async listWorkspaces(): Promise<InfraOperationResult<InfraWorkspace[]>> {
    const startTime = Date.now();

    try {
      const command = new ListRepositoriesCommand({});
      const response = await this.client.send(command);

      // Filter repositories by tenant tag
      const workspaces: InfraWorkspace[] = [];

      if (response.repositories) {
        for (const repo of response.repositories) {
          // Get full repository metadata to check tags
          const detailResponse = await this.client.send(
            new GetRepositoryCommand({ repositoryName: repo.repositoryName })
          );

          const repository = detailResponse.repositoryMetadata;

          // Check if this repository belongs to our tenant
          // In production, we'd use tag-based filtering or naming conventions
          if (repository?.repositoryName?.includes(this.context.tenantId)) {
            workspaces.push({
              workspaceId: `${this.context.tenantId}-${repository.repositoryName}`,
              tenantId: this.context.tenantId,
              agentId: this.context.agentId,
              repositoryArn: repository.Arn!,
              repositoryName: repository.repositoryName!,
              defaultBranch: repository.defaultBranch ?? 'main',
              cloneUrl: repository.cloneUrlHttp!,
              status: 'READY' as WorkspaceStatus,
              createdAt: repository.creationDate?.toISOString() ?? new Date().toISOString(),
              lastCommitAt: repository.lastModifiedDate?.toISOString(),
            });
          }
        }
      }

      return {
        success: true,
        data: workspaces,
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
}
