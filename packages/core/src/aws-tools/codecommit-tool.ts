/**
 * AWS CodeCommit Tool - Git repository management for agents (Strands format)
 *
 * ⚠️ BLOCKED: Missing infrastructure in client-factory.ts
 * Required: getCodeCommitClient() method + CodeCommitClient import
 * Required: CODECOMMIT_RETRYABLE_ERRORS constant in tool-utils.ts
 *
 * Operations (pending infrastructure):
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
import type { AWSClientFactory } from './client-factory';

/**
 * Create CodeCommit Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of CodeCommit tools for Strands Agent
 */
export function createCodeCommitTools(clientFactory: AWSClientFactory) {
  // IMPLEMENTATION BLOCKED: Missing client factory infrastructure
  // Once added, implement tools following the pattern in lambda-tool.ts
  // Required AWS SDK imports:
  //   import {
  //     CodeCommitClient,
  //     ListRepositoriesCommand,
  //     GetRepositoryCommand,
  //     CreateBranchCommand,
  //     GetBranchCommand,
  //     GetFileCommand,
  //     PutFileCommand,
  //     CreateCommitCommand,
  //     GetCommitCommand,
  //     ListBranchesCommand,
  //   } from '@aws-sdk/client-codecommit';

  const errorMessage = `CodeCommit tools blocked: Missing infrastructure.

Required additions to client-factory.ts:
1. Import: CodeCommitClient from '@aws-sdk/client-codecommit'
2. Add to AWSClient union type: | CodeCommitClient
3. Implement getter:
   async getCodeCommitClient(context: AWSToolContext): Promise<CodeCommitClient> {
     return this.getOrCreateClient(
       'codecommit',
       context,
       (credentials, region) =>
         new CodeCommitClient({
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
export const CODECOMMIT_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'InternalServerException',
  'ServiceUnavailableException',
  'TimeoutError',
];

Once infrastructure is added, implement tools following lambda-tool.ts pattern.`;

  // Return placeholder tools that throw informative errors
  const listRepositories = tool({
    name: 'codecommit_list_repositories',
    description: 'List CodeCommit repositories (BLOCKED: missing infrastructure)',
    inputSchema: z.object({
      tenantId: z.string(),
      agentId: z.string(),
      region: z.string().optional(),
    }),
    callback: async () => {
      throw new Error(errorMessage);
    },
  });

  return [listRepositories];
}
