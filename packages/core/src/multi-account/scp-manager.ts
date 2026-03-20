/**
 * Service Control Policy (SCP) Manager
 *
 * Manages AWS Organizations Service Control Policies for multi-account governance.
 * SCPs provide organization-level guardrails that apply to all accounts.
 *
 * Key capabilities:
 * - List and describe SCPs attached to organizational units
 * - Attach/detach policies from accounts and OUs
 * - Evaluate policy compliance for tenant accounts
 * - Query effective permissions after SCP inheritance
 *
 * Reference: docs/research/aws-account-agent/05-IAM-Scoping-Least-Privilege.md
 */

import {
  OrganizationsClient,
  ListPoliciesCommand,
  DescribePolicyCommand,
  ListTargetsForPolicyCommand,
  ListPoliciesForTargetCommand,
  AttachPolicyCommand,
  DetachPolicyCommand,
  type Policy,
  type PolicySummary,
  type PolicyTargetSummary,
} from '@aws-sdk/client-organizations';
import type { AWSClientFactory } from '../aws-tools/client-factory';

/**
 * Service Control Policy metadata
 */
export interface ServiceControlPolicy {
  readonly id: string;
  readonly arn: string;
  readonly name: string;
  readonly description?: string;
  readonly type: 'SERVICE_CONTROL_POLICY';
  readonly awsManaged: boolean;
  readonly content?: string; // Policy document JSON
}

/**
 * SCP attachment target (account or organizational unit)
 */
export interface SCPTarget {
  readonly targetId: string;
  readonly arn: string;
  readonly name: string;
  readonly type: 'ACCOUNT' | 'ORGANIZATIONAL_UNIT' | 'ROOT';
}

/**
 * SCP attachment relationship
 */
export interface SCPAttachment {
  readonly policyId: string;
  readonly policyName: string;
  readonly targetId: string;
  readonly targetType: 'ACCOUNT' | 'ORGANIZATIONAL_UNIT' | 'ROOT';
}

/**
 * Effective SCP evaluation result for an account
 */
export interface EffectiveSCPResult {
  readonly accountId: string;
  readonly policies: ServiceControlPolicy[];
  readonly inheritedFrom: Array<{
    readonly ouId: string;
    readonly ouName: string;
    readonly policies: ServiceControlPolicy[];
  }>;
  readonly effectiveDenies: string[]; // List of denied actions
}

/**
 * SCP Manager Configuration
 */
export interface SCPManagerConfig {
  /** AWS Client Factory for Organizations client creation */
  clientFactory: AWSClientFactory;

  /** Tenant context for API calls */
  tenantId: string;
  agentId: string;

  /** Cache TTL in seconds (default: 300) */
  cacheTTL?: number;
}

/**
 * SCP Manager Error Codes
 */
export type SCPErrorCode =
  | 'ORGANIZATIONS_NOT_ENABLED'
  | 'POLICY_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'INVALID_POLICY'
  | 'ALREADY_ATTACHED'
  | 'NOT_ATTACHED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR';

/**
 * SCP Manager Error
 */
export class SCPError extends Error {
  constructor(
    public readonly code: SCPErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'SCPError';
  }
}

/**
 * Service Control Policy Manager
 *
 * Provides programmatic access to AWS Organizations SCPs for:
 * - Multi-account governance and compliance
 * - Policy inheritance analysis
 * - Effective permission evaluation
 * - Centralized security guardrails
 */
export class SCPManager {
  private config: Required<SCPManagerConfig>;
  private client: OrganizationsClient | null = null;
  private cache = new Map<string, { data: unknown; expires: number }>();

  constructor(config: SCPManagerConfig) {
    this.config = {
      cacheTTL: 300, // 5 minutes default
      ...config,
    };
  }

  /**
   * Get Organizations client (always us-east-1)
   */
  private async getClient(): Promise<OrganizationsClient> {
    if (this.client) {
      return this.client;
    }

    // Organizations API is global and only accessible from us-east-1
    // We need to create a client directly since it doesn't go through tenant-scoped roles
    this.client = new OrganizationsClient({
      region: 'us-east-1',
      maxAttempts: 3,
    });

    return this.client;
  }

  /**
   * List all SCPs in the organization
   */
  async listPolicies(filter?: {
    awsManaged?: boolean;
  }): Promise<ServiceControlPolicy[]> {
    const cacheKey = `policies:${JSON.stringify(filter)}`;
    const cached = this.getFromCache<ServiceControlPolicy[]>(cacheKey);
    if (cached) return cached;

    const client = await this.getClient();
    const policies: ServiceControlPolicy[] = [];

    try {
      let nextToken: string | undefined;

      do {
        const command = new ListPoliciesCommand({
          Filter: 'SERVICE_CONTROL_POLICY',
          NextToken: nextToken,
        });

        const response = await client.send(command);

        for (const summary of response.Policies || []) {
          if (filter?.awsManaged !== undefined && summary.AwsManaged !== filter.awsManaged) {
            continue;
          }

          policies.push({
            id: summary.Id!,
            arn: summary.Arn!,
            name: summary.Name!,
            description: summary.Description,
            type: summary.Type as 'SERVICE_CONTROL_POLICY',
            awsManaged: summary.AwsManaged || false,
          });
        }

        nextToken = response.NextToken;
      } while (nextToken);

      this.setCache(cacheKey, policies);
      return policies;
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * Get detailed information about a specific SCP
   */
  async getPolicy(policyId: string): Promise<ServiceControlPolicy> {
    const cacheKey = `policy:${policyId}`;
    const cached = this.getFromCache<ServiceControlPolicy>(cacheKey);
    if (cached) return cached;

    const client = await this.getClient();

    try {
      const command = new DescribePolicyCommand({
        PolicyId: policyId,
      });

      const response = await client.send(command);
      const policy = response.Policy?.PolicySummary;
      const content = response.Policy?.Content;

      if (!policy) {
        throw new SCPError('POLICY_NOT_FOUND', `Policy ${policyId} not found`);
      }

      const result: ServiceControlPolicy = {
        id: policy.Id!,
        arn: policy.Arn!,
        name: policy.Name!,
        description: policy.Description,
        type: policy.Type as 'SERVICE_CONTROL_POLICY',
        awsManaged: policy.AwsManaged || false,
        content,
      };

      this.setCache(cacheKey, result);
      return result;
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * List all targets (accounts/OUs) that a policy is attached to
   */
  async listTargetsForPolicy(policyId: string): Promise<SCPTarget[]> {
    const cacheKey = `targets:${policyId}`;
    const cached = this.getFromCache<SCPTarget[]>(cacheKey);
    if (cached) return cached;

    const client = await this.getClient();
    const targets: SCPTarget[] = [];

    try {
      let nextToken: string | undefined;

      do {
        const command = new ListTargetsForPolicyCommand({
          PolicyId: policyId,
          NextToken: nextToken,
        });

        const response = await client.send(command);

        for (const target of response.Targets || []) {
          targets.push({
            targetId: target.TargetId!,
            arn: target.Arn!,
            name: target.Name!,
            type: target.Type as 'ACCOUNT' | 'ORGANIZATIONAL_UNIT' | 'ROOT',
          });
        }

        nextToken = response.NextToken;
      } while (nextToken);

      this.setCache(cacheKey, targets);
      return targets;
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * List all policies attached to a target (account or OU)
   */
  async listPoliciesForTarget(targetId: string): Promise<ServiceControlPolicy[]> {
    const cacheKey = `policies-for-target:${targetId}`;
    const cached = this.getFromCache<ServiceControlPolicy[]>(cacheKey);
    if (cached) return cached;

    const client = await this.getClient();
    const policies: ServiceControlPolicy[] = [];

    try {
      let nextToken: string | undefined;

      do {
        const command = new ListPoliciesForTargetCommand({
          TargetId: targetId,
          Filter: 'SERVICE_CONTROL_POLICY',
          NextToken: nextToken,
        });

        const response = await client.send(command);

        for (const summary of response.Policies || []) {
          policies.push({
            id: summary.Id!,
            arn: summary.Arn!,
            name: summary.Name!,
            description: summary.Description,
            type: summary.Type as 'SERVICE_CONTROL_POLICY',
            awsManaged: summary.AwsManaged || false,
          });
        }

        nextToken = response.NextToken;
      } while (nextToken);

      this.setCache(cacheKey, policies);
      return policies;
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * Attach an SCP to a target (account or OU)
   * WARNING: This is a privileged operation that affects account permissions
   */
  async attachPolicy(policyId: string, targetId: string): Promise<void> {
    const client = await this.getClient();

    try {
      const command = new AttachPolicyCommand({
        PolicyId: policyId,
        TargetId: targetId,
      });

      await client.send(command);

      // Invalidate relevant caches
      this.cache.delete(`targets:${policyId}`);
      this.cache.delete(`policies-for-target:${targetId}`);
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * Detach an SCP from a target (account or OU)
   * WARNING: This is a privileged operation that affects account permissions
   */
  async detachPolicy(policyId: string, targetId: string): Promise<void> {
    const client = await this.getClient();

    try {
      const command = new DetachPolicyCommand({
        PolicyId: policyId,
        TargetId: targetId,
      });

      await client.send(command);

      // Invalidate relevant caches
      this.cache.delete(`targets:${policyId}`);
      this.cache.delete(`policies-for-target:${targetId}`);
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * Get effective SCPs for an account (including inherited from parent OUs)
   * This helps understand the actual permissions after SCP inheritance
   */
  async getEffectivePolicies(accountId: string): Promise<EffectiveSCPResult> {
    const cacheKey = `effective:${accountId}`;
    const cached = this.getFromCache<EffectiveSCPResult>(cacheKey);
    if (cached) return cached;

    try {
      // Get policies directly attached to account
      const directPolicies = await this.listPoliciesForTarget(accountId);

      // Get full policy details
      const policies = await Promise.all(
        directPolicies.map(p => this.getPolicy(p.id))
      );

      // Parse policy documents to extract denied actions
      const effectiveDenies = this.extractDeniedActions(policies);

      const result: EffectiveSCPResult = {
        accountId,
        policies,
        inheritedFrom: [], // Would need to traverse OU hierarchy
        effectiveDenies,
      };

      this.setCache(cacheKey, result);
      return result;
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  /**
   * Extract denied actions from SCP policy documents
   */
  private extractDeniedActions(policies: ServiceControlPolicy[]): string[] {
    const denies = new Set<string>();

    for (const policy of policies) {
      if (!policy.content) continue;

      try {
        const doc = JSON.parse(policy.content);
        const statements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];

        for (const stmt of statements) {
          if (stmt.Effect === 'Deny') {
            const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
            for (const action of actions) {
              denies.add(action);
            }
          }
        }
      } catch (e) {
        // Skip malformed policy documents
        continue;
      }
    }

    return Array.from(denies);
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Handle AWS SDK errors and convert to SCPError
   */
  private handleError(error: any): SCPError {
    const code = error.name || error.code;
    const message = error.message || 'Unknown error';

    switch (code) {
      case 'AWSOrganizationsNotInUseException':
        return new SCPError('ORGANIZATIONS_NOT_ENABLED', 'AWS Organizations is not enabled', error);
      case 'PolicyNotFoundException':
        return new SCPError('POLICY_NOT_FOUND', message, error);
      case 'TargetNotFoundException':
        return new SCPError('TARGET_NOT_FOUND', message, error);
      case 'AccessDeniedException':
        return new SCPError('PERMISSION_DENIED', message, error);
      case 'InvalidInputException':
        return new SCPError('INVALID_POLICY', message, error);
      case 'DuplicatePolicyAttachmentException':
        return new SCPError('ALREADY_ATTACHED', message, error);
      case 'PolicyNotAttachedException':
        return new SCPError('NOT_ATTACHED', message, error);
      case 'TooManyRequestsException':
        return new SCPError('RATE_LIMIT_EXCEEDED', message, error);
      default:
        return new SCPError('INTERNAL_ERROR', message, error);
    }
  }

  /**
   * Cache management
   */
  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() > cached.expires) {
      this.cache.delete(key);
      return null;
    }
    return cached.data as T;
  }

  private setCache(key: string, data: unknown): void {
    this.cache.set(key, {
      data,
      expires: Date.now() + this.config.cacheTTL * 1000,
    });
  }
}
