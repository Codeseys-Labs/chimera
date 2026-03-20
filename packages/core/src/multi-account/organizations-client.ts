/**
 * AWS Organizations client for multi-account management
 *
 * Provides tenant-scoped access to:
 * - List accounts in organization
 * - Create new accounts
 * - Manage organizational units
 * - Query organization structure
 *
 * Reference: docs/research/aws-account-agent/06-Multi-Region-Operations.md
 */

import {
  OrganizationsClient,
  ListAccountsCommand,
  DescribeAccountCommand,
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  DescribeOrganizationCommand,
  ListOrganizationalUnitsForParentCommand,
  ListRootsCommand,
  ListTagsForResourceCommand,
  type Account,
  type CreateAccountStatus as AWSCreateAccountStatus,
  type OrganizationalUnit as AWSOrganizationalUnit,
} from '@aws-sdk/client-organizations';
import type {
  AWSAccount,
  AccountStatus,
  OrganizationalUnit,
  OrganizationStructure,
  ListAccountsParams,
  ListAccountsResult,
  GetAccountResult,
  CreateAccountParams,
  CreateAccountResult,
  CreateAccountRequest,
  GetOrganizationResult,
  ListOrganizationalUnitsResult,
  MultiAccountContext,
} from './types';

/**
 * Configuration for Organizations client
 */
export interface OrganizationsClientConfig {
  /** AWS region for Organizations API calls (typically us-east-1) */
  region?: string;

  /** Request timeout in milliseconds */
  requestTimeout?: number;

  /** Max retry attempts */
  maxAttempts?: number;
}

/**
 * Client for AWS Organizations operations
 * Follows the AWSClientFactory pattern for consistency
 */
export class ChimeraOrganizationsClient {
  private client: OrganizationsClient;
  private config: Required<OrganizationsClientConfig>;

  constructor(config: OrganizationsClientConfig = {}) {
    this.config = {
      region: config.region ?? 'us-east-1', // Organizations API is global but needs a region
      requestTimeout: config.requestTimeout ?? 30000,
      maxAttempts: config.maxAttempts ?? 3,
    };

    this.client = new OrganizationsClient({
      region: this.config.region,
      maxAttempts: this.config.maxAttempts,
      requestHandler: {
        requestTimeout: this.config.requestTimeout,
      },
    });
  }

  /**
   * List all accounts in the organization
   */
  async listAccounts(
    context: MultiAccountContext,
    params: ListAccountsParams = {}
  ): Promise<ListAccountsResult> {
    const startTime = Date.now();

    try {
      const command = new ListAccountsCommand({
        NextToken: params.nextToken,
        MaxResults: params.limit ?? 20,
      });

      const response = await this.client.send(command);

      // Transform AWS SDK response to Chimera types
      const accounts: AWSAccount[] = (response.Accounts ?? [])
        .filter((account: Account) => {
          // Apply status filter if specified
          if (params.status && account.Status !== params.status) {
            return false;
          }
          return true;
        })
        .map((account: Account) => this.transformAccount(account));

      // Filter by OU if specified (requires additional API calls)
      let filteredAccounts = accounts;
      if (params.organizationalUnitId) {
        filteredAccounts = await this.filterAccountsByOU(
          accounts,
          params.organizationalUnitId
        );
      }

      return {
        success: true,
        data: {
          items: filteredAccounts,
          pagination: {
            nextToken: response.NextToken,
            hasMore: !!response.NextToken,
            pageSize: filteredAccounts.length,
          },
        },
        metadata: {
          region: this.config.region,
          durationMs: Date.now() - startTime,
          requestId: response.$metadata.requestId,
        },
      };
    } catch (error) {
      return this.handleError(error, startTime);
    }
  }

  /**
   * Get details for a specific account
   */
  async getAccount(
    context: MultiAccountContext,
    accountId: string
  ): Promise<GetAccountResult> {
    const startTime = Date.now();

    try {
      const command = new DescribeAccountCommand({
        AccountId: accountId,
      });

      const response = await this.client.send(command);

      if (!response.Account) {
        throw new Error(`Account ${accountId} not found`);
      }

      const account = this.transformAccount(response.Account);

      // Fetch tags for account
      try {
        const tagsCommand = new ListTagsForResourceCommand({
          ResourceId: accountId,
        });
        const tagsResponse = await this.client.send(tagsCommand);
        if (tagsResponse.Tags) {
          account.tags = Object.fromEntries(
            tagsResponse.Tags.map((tag: { Key?: string; Value?: string }) => [tag.Key!, tag.Value!])
          );
        }
      } catch (tagsError) {
        // Tags are optional, continue without them
        console.warn(`Failed to fetch tags for account ${accountId}:`, tagsError);
      }

      return {
        success: true,
        data: account,
        metadata: {
          region: this.config.region,
          durationMs: Date.now() - startTime,
          requestId: response.$metadata.requestId,
        },
      };
    } catch (error) {
      return this.handleError(error, startTime);
    }
  }

  /**
   * Create a new account in the organization
   */
  async createAccount(
    context: MultiAccountContext,
    params: CreateAccountParams
  ): Promise<CreateAccountResult> {
    const startTime = Date.now();

    try {
      const command = new CreateAccountCommand({
        AccountName: params.accountName,
        Email: params.email,
        IamUserAccessToBilling: params.iamUserAccessToBilling ?? 'ALLOW',
        RoleName: params.roleName ?? 'OrganizationAccountAccessRole',
        Tags: params.tags
          ? Object.entries(params.tags).map(([Key, Value]) => ({ Key, Value }))
          : undefined,
      });

      const response = await this.client.send(command);

      if (!response.CreateAccountStatus) {
        throw new Error('CreateAccount response missing status');
      }

      const request = this.transformCreateAccountStatus(
        response.CreateAccountStatus,
        params.accountName
      );

      return {
        success: true,
        data: request,
        metadata: {
          region: this.config.region,
          durationMs: Date.now() - startTime,
          requestId: response.$metadata.requestId,
        },
      };
    } catch (error) {
      return this.handleError(error, startTime);
    }
  }

  /**
   * Check status of account creation request
   */
  async getCreateAccountStatus(
    context: MultiAccountContext,
    requestId: string
  ): Promise<CreateAccountResult> {
    const startTime = Date.now();

    try {
      const command = new DescribeCreateAccountStatusCommand({
        CreateAccountRequestId: requestId,
      });

      const response = await this.client.send(command);

      if (!response.CreateAccountStatus) {
        throw new Error(`Create account request ${requestId} not found`);
      }

      const request = this.transformCreateAccountStatus(
        response.CreateAccountStatus,
        response.CreateAccountStatus.AccountName ?? 'Unknown'
      );

      return {
        success: true,
        data: request,
        metadata: {
          region: this.config.region,
          durationMs: Date.now() - startTime,
          requestId: response.$metadata.requestId,
        },
      };
    } catch (error) {
      return this.handleError(error, startTime);
    }
  }

  /**
   * Get organization structure (root, OUs, accounts)
   */
  async getOrganization(
    context: MultiAccountContext
  ): Promise<GetOrganizationResult> {
    const startTime = Date.now();

    try {
      // Get organization details
      const orgCommand = new DescribeOrganizationCommand({});
      const orgResponse = await this.client.send(orgCommand);

      if (!orgResponse.Organization) {
        throw new Error('No organization found');
      }

      const org = orgResponse.Organization;

      // Get root OU
      const rootsCommand = new ListRootsCommand({});
      const rootsResponse = await this.client.send(rootsCommand);

      if (!rootsResponse.Roots || rootsResponse.Roots.length === 0) {
        throw new Error('No root OU found');
      }

      const rootOU = rootsResponse.Roots[0];

      // Get all OUs recursively
      const organizationalUnits = await this.listAllOUs(rootOU.Id!);

      // Get all accounts
      const accountsResult = await this.listAccounts(context, { limit: 100 });
      const accounts = accountsResult.data?.items ?? [];

      const structure: OrganizationStructure = {
        organizationId: org.Id!,
        organizationArn: org.Arn!,
        masterAccountId: org.MasterAccountId!,
        root: {
          id: rootOU.Id!,
          arn: rootOU.Arn!,
          name: rootOU.Name ?? 'Root',
        },
        organizationalUnits,
        accounts,
        enabledPolicyTypes: org.AvailablePolicyTypes?.map((pt: { Type?: string }) => pt.Type!) ?? [],
      };

      return {
        success: true,
        data: structure,
        metadata: {
          region: this.config.region,
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return this.handleError(error, startTime);
    }
  }

  /**
   * List organizational units under a parent
   */
  async listOrganizationalUnits(
    context: MultiAccountContext,
    parentId: string
  ): Promise<ListOrganizationalUnitsResult> {
    const startTime = Date.now();

    try {
      const organizationalUnits = await this.listAllOUs(parentId);

      return {
        success: true,
        data: {
          items: organizationalUnits,
          pagination: {
            hasMore: false,
            pageSize: organizationalUnits.length,
          },
        },
        metadata: {
          region: this.config.region,
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return this.handleError(error, startTime);
    }
  }

  /**
   * Transform AWS SDK Account to Chimera AWSAccount
   */
  private transformAccount(account: Account): AWSAccount {
    return {
      id: account.Id!,
      arn: account.Arn!,
      name: account.Name!,
      email: account.Email!,
      status: account.Status as AccountStatus,
      joinedTimestamp: account.JoinedTimestamp?.toISOString() ?? new Date().toISOString(),
    };
  }

  /**
   * Transform AWS SDK CreateAccountStatus to Chimera CreateAccountRequest
   */
  private transformCreateAccountStatus(
    status: AWSCreateAccountStatus,
    accountName: string
  ): CreateAccountRequest {
    return {
      id: status.Id!,
      state: status.State as any,
      accountId: status.AccountId,
      accountName,
      requestedTimestamp: status.RequestedTimestamp?.toISOString() ?? new Date().toISOString(),
      completedTimestamp: status.CompletedTimestamp?.toISOString(),
      failureReason: status.FailureReason,
    };
  }

  /**
   * Recursively list all OUs under a parent
   */
  private async listAllOUs(parentId: string): Promise<OrganizationalUnit[]> {
    const result: OrganizationalUnit[] = [];
    let nextToken: string | undefined;

    do {
      const command = new ListOrganizationalUnitsForParentCommand({
        ParentId: parentId,
        NextToken: nextToken,
      });

      const response = await this.client.send(command);
      nextToken = response.NextToken;

      if (response.OrganizationalUnits) {
        for (const ou of response.OrganizationalUnits) {
          const transformed: OrganizationalUnit = {
            id: ou.Id!,
            arn: ou.Arn!,
            name: ou.Name!,
            parentId,
          };
          result.push(transformed);

          // Recursively get child OUs
          const childOUs = await this.listAllOUs(ou.Id!);
          result.push(...childOUs);
        }
      }
    } while (nextToken);

    return result;
  }

  /**
   * Filter accounts by organizational unit
   * Note: This is a helper since Organizations API doesn't support direct OU filtering
   */
  private async filterAccountsByOU(
    accounts: AWSAccount[],
    organizationalUnitId: string
  ): Promise<AWSAccount[]> {
    // This would require additional API calls to list accounts for parent
    // For now, return all accounts with a warning
    console.warn(
      'OU filtering requires additional API implementation - returning all accounts'
    );
    return accounts;
  }

  /**
   * Handle errors and transform to AWSToolResult format
   */
  private handleError<T>(error: unknown, startTime: number): any {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode =
      error && typeof error === 'object' && 'name' in error
        ? (error as any).name
        : 'UnknownError';

    // Determine if error is retryable
    const retryableErrors = [
      'ThrottlingException',
      'TooManyRequestsException',
      'ServiceUnavailableException',
      'InternalErrorException',
    ];
    const isRetryable = retryableErrors.includes(errorCode);

    return {
      success: false,
      error: {
        message: errorMessage,
        code: errorCode,
        retryable: isRetryable,
      },
      metadata: {
        region: this.config.region,
        durationMs: Date.now() - startTime,
      },
    };
  }
}
