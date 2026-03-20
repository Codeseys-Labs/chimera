/**
 * Safety Harness for Self-Evolution
 *
 * Enforces Cedar policies and rate limits on all self-modification operations.
 * Every evolution action must pass through this harness before execution.
 */

import {
  VerifiedPermissionsClient,
  IsAuthorizedCommand,
  type IsAuthorizedCommandInput,
} from '@aws-sdk/client-verifiedpermissions';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  CedarAuthResult,
  EvolutionConfig,
  EvolutionRateLimits,
  EvolutionEventType,
  EvolutionAction,
  IaCChangeType,
} from './types';

/**
 * Safety harness for evolution operations
 */
export class EvolutionSafetyHarness {
  private avp: VerifiedPermissionsClient;
  private ddb: DynamoDBDocumentClient;
  private config: EvolutionConfig;

  constructor(config: EvolutionConfig) {
    this.config = config;
    this.avp = new VerifiedPermissionsClient({});
    this.ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  /**
   * Check if a self-evolution action is authorized
   */
  async authorize(params: {
    tenantId: string;
    agentId: string;
    action: EvolutionAction;
    eventType: EvolutionEventType;
    changeType?: IaCChangeType;
    estimatedMonthlyCostDelta?: number;
    humanApproved?: boolean;
  }): Promise<CedarAuthResult> {
    // Step 1: Check rate limits
    const rateLimitCheck = await this.checkRateLimits(
      params.tenantId,
      params.eventType
    );
    if (!rateLimitCheck.allowed) {
      return {
        decision: 'DENY',
        errors: [rateLimitCheck.reason || 'Rate limit exceeded'],
      };
    }

    // Step 2: Evaluate Cedar policy
    const cedarResult = await this.evaluateCedarPolicy({
      tenantId: params.tenantId,
      agentId: params.agentId,
      action: params.action,
      eventType: params.eventType,
      changeType: params.changeType,
      estimatedMonthlyCostDelta: params.estimatedMonthlyCostDelta || 0,
      humanApproved: params.humanApproved || false,
    });

    return cedarResult;
  }

  /**
   * Check rate limits for evolution operations
   */
  private async checkRateLimits(
    tenantId: string,
    eventType: EvolutionEventType
  ): Promise<{ allowed: boolean; reason?: string }> {
    const limits = await this.getOrCreateRateLimits(tenantId);

    // Check daily evolution changes limit
    if (limits.evolutionChangesToday >= this.config.maxChangesPerDay) {
      return {
        allowed: false,
        reason: `Maximum ${this.config.maxChangesPerDay} evolution changes per day exceeded`,
      };
    }

    // Check daily infrastructure changes limit
    if (
      eventType === 'evolution_infra' &&
      limits.infraChangesToday >= this.config.maxInfraChangesPerDay
    ) {
      return {
        allowed: false,
        reason: `Maximum ${this.config.maxInfraChangesPerDay} infrastructure changes per day exceeded`,
      };
    }

    // Check weekly prompt changes limit
    if (
      eventType === 'evolution_prompt' &&
      limits.promptChangesThisWeek >= this.config.maxPromptChangesPerWeek
    ) {
      return {
        allowed: false,
        reason: `Maximum ${this.config.maxPromptChangesPerWeek} prompt changes per week exceeded`,
      };
    }

    return { allowed: true };
  }

  /**
   * Evaluate Cedar policy for an evolution action
   */
  private async evaluateCedarPolicy(params: {
    tenantId: string;
    agentId: string;
    action: EvolutionAction;
    eventType: EvolutionEventType;
    changeType?: IaCChangeType;
    estimatedMonthlyCostDelta: number;
    humanApproved: boolean;
  }): Promise<CedarAuthResult> {
    const actionMap: Record<EvolutionEventType, string> = {
      evolution_prompt: 'modify_system_prompt',
      evolution_skill: 'create_skill',
      evolution_infra: 'apply_infra_change',
      evolution_routing: 'update_routing',
      evolution_memory: 'evolve_memory',
      evolution_cron: 'create_cron',
    };

    // Build context map conditionally
    const contextMap: Record<string, any> = {
      estimated_monthly_cost_delta: {
        long: params.estimatedMonthlyCostDelta,
      },
      human_approved: { boolean: params.humanApproved },
      tenant_id: { string: params.tenantId },
    };

    if (params.changeType) {
      contextMap.change_type = { string: params.changeType };
    }

    const input: IsAuthorizedCommandInput = {
      policyStoreId: this.config.policyStoreId,
      principal: {
        entityType: 'Chimera::Agent',
        entityId: params.agentId,
      },
      action: {
        actionType: 'Chimera::Action',
        actionId: actionMap[params.eventType],
      },
      resource: {
        entityType: this.getResourceType(params.eventType),
        entityId: `${params.tenantId}/${params.eventType}`,
      },
      context: {
        contextMap,
      },
    };

    try {
      const command = new IsAuthorizedCommand(input);
      const response = await this.avp.send(command);

      return {
        decision: response.decision as 'ALLOW' | 'DENY',
        policyIds: response.determiningPolicies?.map((p: any) => p.policyId || ''),
        errors: response.errors?.map((e: any) => e.errorDescription || ''),
      };
    } catch (error) {
      console.error('Cedar policy evaluation failed:', error);
      return {
        decision: 'DENY',
        errors: ['Policy evaluation failed'],
      };
    }
  }

  /**
   * Get resource type for Cedar evaluation
   */
  private getResourceType(eventType: EvolutionEventType): string {
    const resourceTypeMap: Record<EvolutionEventType, string> = {
      evolution_prompt: 'Chimera::SystemPrompt',
      evolution_skill: 'Chimera::Skill',
      evolution_infra: 'Chimera::Infrastructure',
      evolution_routing: 'Chimera::ModelRouter',
      evolution_memory: 'Chimera::Memory',
      evolution_cron: 'Chimera::CronJob',
    };
    return resourceTypeMap[eventType];
  }

  /**
   * Increment rate limit counters after successful authorization
   */
  async incrementRateLimitCounters(
    tenantId: string,
    eventType: EvolutionEventType
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const weekStart = this.getWeekStart();

    const updates: string[] = ['evolutionChangesToday = evolutionChangesToday + :inc'];
    const values: Record<string, any> = { ':inc': 1, ':today': today };

    if (eventType === 'evolution_infra') {
      updates.push('infraChangesToday = infraChangesToday + :inc');
    }

    if (eventType === 'evolution_prompt') {
      updates.push('promptChangesThisWeek = promptChangesThisWeek + :inc');
      values[':weekStart'] = weekStart;
    }

    // Reset counters if date has changed
    updates.push('lastResetDate = if_not_exists(lastResetDate, :today)');

    await this.ddb.send(
      new UpdateCommand({
        TableName: this.config.evolutionStateTable,
        Key: {
          PK: `TENANT#${tenantId}`,
          SK: 'RATE_LIMITS',
        },
        UpdateExpression: `SET ${updates.join(', ')}`,
        ExpressionAttributeValues: values,
      })
    );
  }

  /**
   * Get or create rate limit entry for tenant
   */
  private async getOrCreateRateLimits(
    tenantId: string
  ): Promise<EvolutionRateLimits> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.config.evolutionStateTable,
        Key: {
          PK: `TENANT#${tenantId}`,
          SK: 'RATE_LIMITS',
        },
      })
    );

    const today = new Date().toISOString().split('T')[0];
    const weekStart = this.getWeekStart();

    if (!result.Item) {
      // Create initial rate limit entry
      const limits: EvolutionRateLimits = {
        tenantId,
        evolutionChangesToday: 0,
        infraChangesToday: 0,
        promptChangesThisWeek: 0,
        lastResetDate: today,
      };

      await this.ddb.send(
        new PutCommand({
          TableName: this.config.evolutionStateTable,
          Item: {
            PK: `TENANT#${tenantId}`,
            SK: 'RATE_LIMITS',
            ...limits,
          },
        })
      );

      return limits;
    }

    const limits = result.Item as EvolutionRateLimits;

    // Reset counters if date has changed
    if (limits.lastResetDate !== today) {
      limits.evolutionChangesToday = 0;
      limits.infraChangesToday = 0;
      limits.lastResetDate = today;
    }

    // Reset weekly prompt counter if week has changed
    const lastResetWeek = this.getWeekStart(new Date(limits.lastResetDate));
    if (lastResetWeek !== weekStart) {
      limits.promptChangesThisWeek = 0;
    }

    return limits;
  }

  /**
   * Get ISO week start (Monday) for current or given date
   */
  private getWeekStart(date: Date = new Date()): string {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
    d.setDate(diff);
    return d.toISOString().split('T')[0];
  }

  /**
   * Check if cost threshold requires human approval
   */
  requiresHumanApproval(estimatedMonthlyCostDelta: number): boolean {
    return estimatedMonthlyCostDelta >= this.config.humanApprovalCostThreshold;
  }

  /**
   * Validate that safety instructions cannot be modified
   */
  validatePromptSafety(promptContent: string): { safe: boolean; reason?: string } {
    // Extract sections (rough heuristic - production would use AST parsing)
    const forbiddenSections = [
      'safety_instructions',
      'content_policy',
      'guardrails',
      'cedar policy',
      'authorization',
    ];

    const lowerContent = promptContent.toLowerCase();

    for (const section of forbiddenSections) {
      if (lowerContent.includes(`## ${section}`) || lowerContent.includes(`# ${section}`)) {
        return {
          safe: false,
          reason: `Cannot modify safety-critical section: ${section}`,
        };
      }
    }

    return { safe: true };
  }

  /**
   * Validate that immutable config keys cannot be modified
   */
  validateConfigSafety(configKey: string): { safe: boolean; reason?: string } {
    const immutableKeys = [
      'audit.enabled',
      'audit.trail',
      'guardrails.enabled',
      'cedar.policy_store',
      'evolution.safety_limits',
    ];

    if (immutableKeys.includes(configKey)) {
      return {
        safe: false,
        reason: `Cannot modify immutable configuration: ${configKey}`,
      };
    }

    return { safe: true };
  }

  /**
   * Validate that dangerous IaC operations are blocked
   */
  validateInfraOperation(changeType: string): { safe: boolean; reason?: string } {
    const dangerousOps = [
      'delete_table',
      'delete_bucket',
      'modify_iam',
      'modify_vpc',
      'modify_security_group',
      'delete_runtime',
    ];

    if (dangerousOps.includes(changeType)) {
      return {
        safe: false,
        reason: `Dangerous operation ${changeType} is unconditionally blocked`,
      };
    }

    return { safe: true };
  }
}

/**
 * Create a safety harness instance
 */
export function createSafetyHarness(config: EvolutionConfig): EvolutionSafetyHarness {
  return new EvolutionSafetyHarness(config);
}
