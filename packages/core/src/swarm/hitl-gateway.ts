/**
 * Human-in-the-Loop Gateway
 *
 * Decision policy engine that determines when autonomous agents should:
 * - Proceed autonomously (low risk, reversible)
 * - Ask for human approval (high impact, irreversible)
 * - Escalate immediately (critical, production)
 *
 * Based on research: docs/research/aws-account-agent/01-Task-Decomposition.md
 * Section: "Human-in-the-Loop Decision Points"
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import type { ISOTimestamp } from '../orchestration/types';

/**
 * Narrow DynamoDB interface for HITL persistence.
 * Plain objects can implement this in tests without hitting AWS.
 */
export interface HITLDDBClient {
  get(input: { TableName: string; Key: Record<string, unknown> }): Promise<{ Item?: Record<string, unknown> }>;
  put(input: { TableName: string; Item: Record<string, unknown> }): Promise<unknown>;
}

// Lazily-constructed module-level singleton for production use
let _defaultDDBClient: HITLDDBClient | undefined;

function getDefaultDDBClient(): HITLDDBClient {
  if (!_defaultDDBClient) {
    const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    _defaultDDBClient = {
      get: (input) => doc.send(new GetCommand(input)),
      put: (input) => doc.send(new PutCommand(input)),
    };
  }
  return _defaultDDBClient;
}

/**
 * Task urgency classification for escalation routing
 */
export type EscalationUrgency =
  | 'urgent'    // PagerDuty alert - blocks all work
  | 'high'      // Slack notification - blocks production
  | 'medium'    // Email notification - blocks current task
  | 'low';      // Background ticket - nice to have

/**
 * Environment impact classification
 */
export type Environment =
  | 'production'
  | 'staging'
  | 'development'
  | 'test'
  | 'sandbox';

/**
 * Task context for HITL policy decisions
 */
export interface TaskContext {
  taskId: string;
  description: string;
  environment: Environment;
  estimatedCostUsd: number;
  isIrreversible: boolean;
  affectsCompliance: boolean;
  requiresExternal: boolean;
  tenantId: string;
  metadata: Record<string, unknown>;
}

/**
 * HITL decision result
 */
export interface HITLDecision {
  shouldAskHuman: boolean;
  reason: string;
  urgency?: EscalationUrgency;
  suggestedActions?: string[];
  autoApprove?: boolean;
}

/**
 * Escalation request sent to humans
 */
export interface EscalationRequest {
  id: string;
  title: string;
  description: string;
  taskContext: TaskContext;
  resolutionAttempts: ResolutionAttempt[];
  suggestedActions: string[];
  urgency: EscalationUrgency;
  createdAt: ISOTimestamp;
  expiresAt?: ISOTimestamp;
}

/**
 * Resolution attempt metadata
 */
export interface ResolutionAttempt {
  strategy: string;
  actionsTaken: string[];
  timestamp: ISOTimestamp;
  succeeded: boolean;
  reasonFailed?: string;
}

/**
 * Human response to escalation
 */
export interface HumanResponse {
  requestId: string;
  approved: boolean;
  actionDescription: string;
  guidance?: string;
  respondedAt: ISOTimestamp;
}

/**
 * HITL policy configuration
 */
export interface HITLPolicyConfig {
  costThresholdUsd: number;
  allowProductionChanges: boolean;
  requireApprovalForIrreversible: boolean;
  requireApprovalForCompliance: boolean;
  autoApproveEnvironments: Environment[];
  /** DynamoDB table for persisting approval requests (chimera-sessions or chimera-tenants) */
  sessionsTableName?: string;
  /** Injectable DynamoDB client — provide in tests to avoid hitting AWS */
  ddb?: HITLDDBClient;
}

/**
 * DynamoDB record for an approval request.
 * SK pattern: APPROVAL#{requestId}
 */
export interface ApprovalRecord {
  requestId: string;
  tenantId: string;
  /** Description of the action requiring approval */
  action: string;
  status: 'pending' | 'approved' | 'denied';
  requestedAt: ISOTimestamp;
  resolvedAt?: ISOTimestamp;
  resolvedBy?: string;
}

/**
 * Human-in-the-Loop Gateway
 *
 * Enforces decision policies for autonomous agent actions:
 * 1. Low-risk operations → proceed autonomously
 * 2. High-impact operations → request approval
 * 3. Critical operations → immediate escalation
 *
 * Decision Matrix (from research):
 * - Multiple valid approaches → autonomous (pick best)
 * - Irreversible action (delete prod data) → ask human
 * - Cost exceeds threshold → ask human
 * - Compliance impact (HIPAA, PCI-DSS) → ask human
 * - Adding test environment resources → autonomous
 * - Changing production config → ask human
 * - POC/research tasks → autonomous
 */
export class HITLGateway {
  private config: HITLPolicyConfig;
  private pendingEscalations: Map<string, EscalationRequest>;
  private ddb: HITLDDBClient;

  constructor(config: HITLPolicyConfig) {
    this.config = config;
    this.pendingEscalations = new Map();
    this.ddb = config.ddb ?? getDefaultDDBClient();
  }

  /**
   * Determine if task requires human approval
   *
   * @param context - Task context with risk indicators
   * @returns Decision on whether to proceed autonomously
   */
  shouldAskHuman(context: TaskContext): HITLDecision {
    const reasons: string[] = [];

    // Check 1: High-cost operations
    if (context.estimatedCostUsd > this.config.costThresholdUsd) {
      reasons.push(`Cost exceeds threshold: $${context.estimatedCostUsd} > $${this.config.costThresholdUsd}`);
    }

    // Check 2: Irreversible operations
    if (context.isIrreversible && this.config.requireApprovalForIrreversible) {
      reasons.push('Operation is irreversible (cannot be undone)');
    }

    // Check 3: Production environment
    if (context.environment === 'production' && !this.config.allowProductionChanges) {
      reasons.push('Production environment changes require approval');
    }

    // Check 4: Compliance-sensitive
    if (context.affectsCompliance && this.config.requireApprovalForCompliance) {
      reasons.push('Operation affects compliance scope (HIPAA, PCI-DSS, SOC2)');
    }

    // Check 5: External dependencies
    if (context.requiresExternal) {
      reasons.push('Operation requires external service coordination');
    }

    // Auto-approve for allowed environments
    if (this.config.autoApproveEnvironments.includes(context.environment) && reasons.length === 0) {
      return {
        shouldAskHuman: false,
        reason: `Auto-approved for ${context.environment} environment`,
        autoApprove: true
      };
    }

    // Determine urgency based on impact
    let urgency: EscalationUrgency = 'low';
    if (context.environment === 'production') {
      urgency = reasons.length > 2 ? 'urgent' : 'high';
    } else if (context.isIrreversible) {
      urgency = 'high';
    } else if (context.estimatedCostUsd > this.config.costThresholdUsd * 2) {
      urgency = 'high';
    } else {
      urgency = reasons.length > 0 ? 'medium' : 'low';
    }

    // If any reasons exist, ask human
    if (reasons.length > 0) {
      return {
        shouldAskHuman: true,
        reason: reasons.join('; '),
        urgency,
        suggestedActions: this.generateSuggestedActions(context)
      };
    }

    // Low-risk operations can proceed autonomously
    return {
      shouldAskHuman: false,
      reason: 'Low-risk operation, proceeding autonomously',
      autoApprove: true
    };
  }

  /**
   * Create escalation request for human approval
   *
   * @param context - Task context
   * @param resolutionAttempts - Previous autonomous resolution attempts
   * @returns Escalation request ID
   */
  async createEscalation(
    context: TaskContext,
    resolutionAttempts: ResolutionAttempt[]
  ): Promise<EscalationRequest> {
    const decision = this.shouldAskHuman(context);
    const urgency = decision.urgency || 'medium';

    const request: EscalationRequest = {
      id: `escalation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      title: `Agent Approval Required: ${context.description}`,
      description: decision.reason,
      taskContext: context,
      resolutionAttempts,
      suggestedActions: decision.suggestedActions || [],
      urgency,
      createdAt: new Date().toISOString() as ISOTimestamp,
      expiresAt: urgency === 'urgent'
        ? new Date(Date.now() + 3600000).toISOString() as ISOTimestamp // 1 hour
        : undefined
    };

    this.pendingEscalations.set(request.id, request);

    // Persist to DynamoDB so the approval survives gateway restarts
    await this.saveApprovalRequest({
      requestId: request.id,
      tenantId: context.tenantId,
      action: request.title,
      requestedAt: request.createdAt,
    });

    return request;
  }

  /**
   * Wait for human response to escalation
   *
   * @param requestId - Escalation request ID
   * @param timeoutMs - Maximum wait time (default: 24 hours)
   * @returns Human response or timeout
   */
  async waitForHumanResponse(
    requestId: string,
    timeoutMs: number = 86400000 // 24 hours
  ): Promise<HumanResponse | null> {
    const startTime = Date.now();

    // Poll for response (in production, this would use EventBridge/SQS)
    while (Date.now() - startTime < timeoutMs) {
      const response = await this.checkForResponse(requestId);
      if (response) {
        this.pendingEscalations.delete(requestId);
        return response;
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Timeout
    this.pendingEscalations.delete(requestId);
    return null;
  }

  /**
   * Persist an approval request to DynamoDB.
   *
   * PK: TENANT#{tenantId}, SK: APPROVAL#{requestId}
   * Status starts as 'pending'.
   */
  async saveApprovalRequest(params: {
    requestId: string;
    tenantId: string;
    action: string;
    requestedAt: ISOTimestamp;
  }): Promise<void> {
    if (!this.config.sessionsTableName) return;

    await this.ddb.put({
      TableName: this.config.sessionsTableName,
      Item: {
        PK: `TENANT#${params.tenantId}`,
        SK: `APPROVAL#${params.requestId}`,
        requestId: params.requestId,
        tenantId: params.tenantId,
        action: params.action,
        status: 'pending' as const,
        requestedAt: params.requestedAt,
      },
    });
  }

  /**
   * Query DynamoDB for the current status of an approval request.
   *
   * @returns The approval record, or null if not found
   */
  async getApprovalStatus(params: {
    requestId: string;
    tenantId: string;
  }): Promise<ApprovalRecord | null> {
    if (!this.config.sessionsTableName) return null;

    const result = await this.ddb.get({
      TableName: this.config.sessionsTableName,
      Key: {
        PK: `TENANT#${params.tenantId}`,
        SK: `APPROVAL#${params.requestId}`,
      },
    });

    if (!result.Item) return null;

    return result.Item as unknown as ApprovalRecord;
  }

  /**
   * Record a human's approval or denial decision to DynamoDB.
   *
   * Called by the API endpoint when a human responds to an escalation.
   */
  async resolveApproval(params: {
    requestId: string;
    tenantId: string;
    approved: boolean;
    resolvedBy: string;
    resolvedAt?: ISOTimestamp;
  }): Promise<void> {
    if (!this.config.sessionsTableName) return;

    const resolvedAt = params.resolvedAt ?? (new Date().toISOString() as ISOTimestamp);
    const status: ApprovalRecord['status'] = params.approved ? 'approved' : 'denied';

    await this.ddb.put({
      TableName: this.config.sessionsTableName,
      Item: {
        PK: `TENANT#${params.tenantId}`,
        SK: `APPROVAL#${params.requestId}`,
        requestId: params.requestId,
        tenantId: params.tenantId,
        status,
        resolvedAt,
        resolvedBy: params.resolvedBy,
      },
    });
  }

  /**
   * Check if human has responded to escalation by querying DynamoDB.
   * Returns null while status is 'pending' or if DDB is not configured.
   */
  private async checkForResponse(requestId: string): Promise<HumanResponse | null> {
    const escalation = this.pendingEscalations.get(requestId);
    if (!escalation) return null;

    const record = await this.getApprovalStatus({
      requestId,
      tenantId: escalation.taskContext.tenantId,
    });

    if (!record || record.status === 'pending') return null;

    return {
      requestId,
      approved: record.status === 'approved',
      actionDescription: record.action,
      guidance: record.resolvedBy,
      respondedAt: record.resolvedAt ?? (new Date().toISOString() as ISOTimestamp),
    };
  }

  /**
   * Generate suggested actions for humans
   */
  private generateSuggestedActions(context: TaskContext): string[] {
    const actions: string[] = [];

    if (context.isIrreversible) {
      actions.push('Review rollback plan before approval');
      actions.push('Verify backup exists before proceeding');
    }

    if (context.environment === 'production') {
      actions.push('Schedule maintenance window');
      actions.push('Enable CloudWatch alarms for monitoring');
      actions.push('Prepare runbook for rollback');
    }

    if (context.estimatedCostUsd > this.config.costThresholdUsd) {
      actions.push(`Review cost impact: $${context.estimatedCostUsd}/month`);
      actions.push('Consider cost optimization alternatives');
    }

    if (context.affectsCompliance) {
      actions.push('Review compliance checklist before approval');
      actions.push('Document change for audit trail');
    }

    return actions;
  }

  /**
   * Get pending escalation requests
   */
  getPendingEscalations(): EscalationRequest[] {
    return Array.from(this.pendingEscalations.values());
  }

  /**
   * Get escalation by ID
   */
  getEscalation(requestId: string): EscalationRequest | undefined {
    return this.pendingEscalations.get(requestId);
  }
}

/**
 * Factory function to create HITL Gateway with default config
 */
export function createHITLGateway(config?: Partial<HITLPolicyConfig>): HITLGateway {
  const defaultConfig: HITLPolicyConfig = {
    costThresholdUsd: 100, // $100/month threshold
    allowProductionChanges: false,
    requireApprovalForIrreversible: true,
    requireApprovalForCompliance: true,
    autoApproveEnvironments: ['development', 'test', 'sandbox']
  };

  return new HITLGateway({ ...defaultConfig, ...config });
}
