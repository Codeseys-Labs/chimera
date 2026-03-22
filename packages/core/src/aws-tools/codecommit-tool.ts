/**
 * AWS CodeCommit Tool - Git repository management for agents (Strands format)
 *
 * Operations:
 * - codecommit_list_repositories: List CodeCommit repositories
 * - codecommit_get_repository: Get repository metadata
 * - codecommit_create_branch: Create new branch
 * - codecommit_get_branch: Get branch details
 * - codecommit_get_file: Read file contents from repository
 * - codecommit_put_file: Create or update file
 * - codecommit_create_commit: Create commit with multiple files
 * - codecommit_get_commit: Get commit details
 * - codecommit_list_branches: List repository branches
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  CodeCommitClient,
  ListRepositoriesCommand,
  GetRepositoryCommand,
  CreateBranchCommand,
  GetBranchCommand,
  GetFileCommand,
  PutFileCommand,
  CreateCommitCommand,
  GetCommitCommand,
  ListBranchesCommand,
  type PutFileEntry,
  type DeleteFileEntry,
  type SetFileModeEntry,
} from '@aws-sdk/client-codecommit';
import type { AWSClientFactory } from './client-factory';
import { retryWithBackoff, formatToolError } from './tool-utils';

/**
 * Retryable error codes for CodeCommit operations
 */
export const CODECOMMIT_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalServerException',
  'ServiceUnavailableException',
  'TimeoutError',
];

/**
 * Create CodeCommit Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of CodeCommit tools for Strands Agent
 */
export function createCodeCommitTools(clientFactory: AWSClientFactory) {
  const listRepositories = tool({
    name: 'codecommit_list_repositories',
    description: 'List CodeCommit repositories in the AWS account',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      sortBy: z
        .enum(['repositoryName', 'lastModifiedDate'])
        .optional()
        .describe('Sort order for repositories'),
      order: z.enum(['ascending', 'descending']).optional().describe('Sort direction'),
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
        const codecommit = await clientFactory.getCodeCommitClient(context);

        const command = new ListRepositoriesCommand({
          sortBy: input.sortBy,
          order: input.order,
          nextToken: input.nextToken,
        });

        const response = await retryWithBackoff(
          () => codecommit.send(command),
          CODECOMMIT_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            repositories: response.repositories ?? [],
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

  const getRepository = tool({
    name: 'codecommit_get_repository',
    description: 'Get detailed metadata about a CodeCommit repository',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      repositoryName: z.string().describe('Name of the repository'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codecommit = await clientFactory.getCodeCommitClient(context);

        const command = new GetRepositoryCommand({
          repositoryName: input.repositoryName,
        });

        const response = await retryWithBackoff(
          () => codecommit.send(command),
          CODECOMMIT_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            repositoryMetadata: response.repositoryMetadata,
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

  const createBranch = tool({
    name: 'codecommit_create_branch',
    description: 'Create a new branch in a CodeCommit repository',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      repositoryName: z.string().describe('Name of the repository'),
      branchName: z.string().describe('Name for the new branch'),
      commitId: z.string().describe('Commit ID to point the branch at'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codecommit = await clientFactory.getCodeCommitClient(context);

        const command = new CreateBranchCommand({
          repositoryName: input.repositoryName,
          branchName: input.branchName,
          commitId: input.commitId,
        });

        await retryWithBackoff(
          () => codecommit.send(command),
          CODECOMMIT_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            branchName: input.branchName,
            commitId: input.commitId,
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

  const getBranch = tool({
    name: 'codecommit_get_branch',
    description: 'Get information about a branch in a CodeCommit repository',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      repositoryName: z.string().describe('Name of the repository'),
      branchName: z.string().describe('Name of the branch'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codecommit = await clientFactory.getCodeCommitClient(context);

        const command = new GetBranchCommand({
          repositoryName: input.repositoryName,
          branchName: input.branchName,
        });

        const response = await retryWithBackoff(
          () => codecommit.send(command),
          CODECOMMIT_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            branch: response.branch,
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

  const getFile = tool({
    name: 'codecommit_get_file',
    description: 'Read file contents from a CodeCommit repository',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      repositoryName: z.string().describe('Name of the repository'),
      filePath: z.string().describe('Path to the file in the repository'),
      commitSpecifier: z
        .string()
        .optional()
        .describe('Branch name, tag, or commit ID (default: default branch)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codecommit = await clientFactory.getCodeCommitClient(context);

        const command = new GetFileCommand({
          repositoryName: input.repositoryName,
          filePath: input.filePath,
          commitSpecifier: input.commitSpecifier,
        });

        const response = await retryWithBackoff(
          () => codecommit.send(command),
          CODECOMMIT_RETRYABLE_ERRORS
        );

        // Convert file content from Uint8Array to base64 string for transport
        const fileContent = response.fileContent
          ? Buffer.from(response.fileContent).toString('base64')
          : undefined;

        return JSON.stringify({
          success: true,
          data: {
            fileContent, // Base64-encoded
            filePath: response.filePath,
            blobId: response.blobId,
            commitId: response.commitId,
            fileMode: response.fileMode,
            fileSize: response.fileSize,
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

  const putFile = tool({
    name: 'codecommit_put_file',
    description: 'Create or update a single file in a CodeCommit repository',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      repositoryName: z.string().describe('Name of the repository'),
      branchName: z.string().describe('Name of the branch to commit to'),
      fileContent: z.string().describe('Base64-encoded file content'),
      filePath: z.string().describe('Path for the file in the repository'),
      commitMessage: z.string().describe('Commit message'),
      name: z.string().optional().describe('Name for the commit author'),
      email: z.string().optional().describe('Email for the commit author'),
      parentCommitId: z
        .string()
        .optional()
        .describe('Parent commit ID (required if branch has commits)'),
      fileMode: z
        .enum(['EXECUTABLE', 'NORMAL', 'SYMLINK'])
        .optional()
        .describe('File mode (default: NORMAL)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codecommit = await clientFactory.getCodeCommitClient(context);

        const command = new PutFileCommand({
          repositoryName: input.repositoryName,
          branchName: input.branchName,
          fileContent: Buffer.from(input.fileContent, 'base64'),
          filePath: input.filePath,
          commitMessage: input.commitMessage,
          name: input.name,
          email: input.email,
          parentCommitId: input.parentCommitId,
          fileMode: input.fileMode,
        });

        const response = await retryWithBackoff(
          () => codecommit.send(command),
          CODECOMMIT_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            commitId: response.commitId,
            blobId: response.blobId,
            treeId: response.treeId,
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

  const createCommit = tool({
    name: 'codecommit_create_commit',
    description:
      'Create a commit with multiple file changes (add, update, delete) in a CodeCommit repository',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      repositoryName: z.string().describe('Name of the repository'),
      branchName: z.string().describe('Name of the branch to commit to'),
      commitMessage: z.string().describe('Commit message'),
      name: z.string().optional().describe('Name for the commit author'),
      email: z.string().optional().describe('Email for the commit author'),
      parentCommitId: z
        .string()
        .optional()
        .describe('Parent commit ID (required if branch has commits)'),
      putFiles: z
        .array(
          z.object({
            filePath: z.string(),
            fileContent: z.string().describe('Base64-encoded file content'),
            fileMode: z.enum(['EXECUTABLE', 'NORMAL', 'SYMLINK']).optional(),
          })
        )
        .optional()
        .describe('Files to add or update'),
      deleteFiles: z
        .array(
          z.object({
            filePath: z.string(),
          })
        )
        .optional()
        .describe('Files to delete'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codecommit = await clientFactory.getCodeCommitClient(context);

        // Build put file entries
        const putFiles: PutFileEntry[] | undefined = input.putFiles?.map((f) => ({
          filePath: f.filePath,
          fileContent: Buffer.from(f.fileContent, 'base64'),
          fileMode: f.fileMode,
        }));

        // Build delete file entries
        const deleteFiles: DeleteFileEntry[] | undefined = input.deleteFiles?.map(
          (f) => ({
            filePath: f.filePath,
          })
        );

        const command = new CreateCommitCommand({
          repositoryName: input.repositoryName,
          branchName: input.branchName,
          commitMessage: input.commitMessage,
          authorName: input.name,
          email: input.email,
          parentCommitId: input.parentCommitId,
          putFiles,
          deleteFiles,
        });

        const response = await retryWithBackoff(
          () => codecommit.send(command),
          CODECOMMIT_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            commitId: response.commitId,
            treeId: response.treeId,
            filesAdded: response.filesAdded,
            filesUpdated: response.filesUpdated,
            filesDeleted: response.filesDeleted,
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

  const getCommit = tool({
    name: 'codecommit_get_commit',
    description: 'Get details about a specific commit in a CodeCommit repository',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      repositoryName: z.string().describe('Name of the repository'),
      commitId: z.string().describe('Commit ID to retrieve'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = {
          tenantId: input.tenantId,
          agentId: input.agentId,
          region: input.region,
        };
        const codecommit = await clientFactory.getCodeCommitClient(context);

        const command = new GetCommitCommand({
          repositoryName: input.repositoryName,
          commitId: input.commitId,
        });

        const response = await retryWithBackoff(
          () => codecommit.send(command),
          CODECOMMIT_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            commit: response.commit,
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

  const listBranches = tool({
    name: 'codecommit_list_branches',
    description: 'List all branches in a CodeCommit repository',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      repositoryName: z.string().describe('Name of the repository'),
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
        const codecommit = await clientFactory.getCodeCommitClient(context);

        const command = new ListBranchesCommand({
          repositoryName: input.repositoryName,
          nextToken: input.nextToken,
        });

        const response = await retryWithBackoff(
          () => codecommit.send(command),
          CODECOMMIT_RETRYABLE_ERRORS
        );

        return JSON.stringify({
          success: true,
          data: {
            branches: response.branches ?? [],
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
    listRepositories,
    getRepository,
    createBranch,
    getBranch,
    getFile,
    putFile,
    createCommit,
    getCommit,
    listBranches,
  ];
}
