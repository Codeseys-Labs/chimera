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

import type { ISOTimestamp } from '../orchestration/types';

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

  constructor(config: HITLPolicyConfig) {
    this.config = config;
    this.pendingEscalations = new Map();
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
  createEscalation(
    context: TaskContext,
    resolutionAttempts: ResolutionAttempt[]
  ): EscalationRequest {
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
   * Check if human has responded to escalation
   * (Stub - in production, queries DynamoDB or SQS)
   */
  private async checkForResponse(requestId: string): Promise<HumanResponse | null> {
    // TODO: Implement DynamoDB query for human responses
    // For now, return null (no response yet)
    return null;
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
