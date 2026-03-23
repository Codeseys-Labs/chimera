/**
 * Blocker Resolution Engine
 *
 * Detects and autonomously resolves blockers in agent swarm execution.
 * Implements taxonomy-based resolution strategies with escalation paths.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Module-level singleton clients
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});

/**
 * Blocker taxonomy categories
 */
export type BlockerType =
  | 'missing_dependency'
  | 'permission_error'
  | 'resource_unavailable'
  | 'api_rate_limit'
  | 'validation_error'
  | 'configuration_error'
  | 'network_error'
  | 'unknown';

/**
 * Resolution strategies mapped to blocker types
 */
export type ResolutionStrategy =
  | 'provision_on_demand'
  | 'escalate_to_human'
  | 'retry_with_backoff'
  | 'use_fallback'
  | 'request_permission'
  | 'auto_configure'
  | 'wait_and_retry';

/**
 * Blocker detection result
 */
export interface Blocker {
  blockerId: string;
  tenantId: string;
  agentId: string;
  taskId?: string;
  type: BlockerType;
  description: string;
  context: Record<string, unknown>;
  detectedAt: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  autoResolvable: boolean;
}

/**
 * Resolution attempt record
 */
export interface ResolutionAttempt {
  attemptId: string;
  blockerId: string;
  strategy: ResolutionStrategy;
  startedAt: string;
  completedAt?: string;
  status: 'in_progress' | 'succeeded' | 'failed' | 'escalated';
  result?: Record<string, unknown>;
  error?: string;
  retryCount: number;
}

/**
 * Resolution result
 */
export interface ResolutionResult {
  blockerId: string;
  resolved: boolean;
  strategy: ResolutionStrategy;
  attempts: number;
  duration: number;
  escalated: boolean;
  escalationReason?: string;
  result?: Record<string, unknown>;
}

/**
 * Blocker pattern for learning
 */
export interface BlockerPattern {
  patternId: string;
  type: BlockerType;
  occurrences: number;
  successfulStrategy?: ResolutionStrategy;
  successRate: number;
  avgResolutionTime: number;
  lastSeen: string;
}

/**
 * Blocker resolver configuration
 */
export interface BlockerResolverConfig {
  /** DynamoDB table for blocker tracking */
  blockersTable: string;

  /** S3 bucket for blocker diagnostics */
  diagnosticsBucket: string;

  /** Maximum retry attempts before escalation */
  maxRetries: number;

  /** Retry backoff multiplier */
  backoffMultiplier: number;

  /** Maximum wait time for retry (ms) */
  maxBackoffMs: number;

  /** Enable autonomous provisioning */
  enableAutoProvisioning: boolean;

  /** Enable pattern learning */
  enablePatternLearning: boolean;
}

/**
 * Blocker detection and resolution engine
 */
export class BlockerResolver {
  private ddb: DynamoDBDocumentClient;
  private s3: S3Client;
  private config: BlockerResolverConfig;

  constructor(config: BlockerResolverConfig) {
    this.config = config;
    this.ddb = ddbDocClient;
    this.s3 = s3Client;
  }

  /**
   * Detect blocker from error context
   */
  async detectBlocker(params: {
    tenantId: string;
    agentId: string;
    taskId?: string;
    error: Error;
    context: Record<string, unknown>;
  }): Promise<Blocker> {
    const type = this.classifyBlocker(params.error, params.context);
    const severity = this.assessSeverity(type, params.context);
    const autoResolvable = this.canAutoResolve(type, severity);

    const blocker: Blocker = {
      blockerId: this.generateBlockerId(),
      tenantId: params.tenantId,
      agentId: params.agentId,
      taskId: params.taskId,
      type,
      description: params.error.message,
      context: params.context,
      detectedAt: new Date().toISOString(),
      severity,
      autoResolvable,
    };

    // Store blocker
    await this.ddb.send(
      new PutCommand({
        TableName: this.config.blockersTable,
        Item: {
          PK: `TENANT#${params.tenantId}`,
          SK: `BLOCKER#${blocker.blockerId}`,
          ...blocker,
          GSI1PK: `AGENT#${params.agentId}`,
          GSI1SK: blocker.detectedAt,
        },
      })
    );

    // Store diagnostic data in S3
    await this.storeDiagnostics(blocker, params.error);

    return blocker;
  }

  /**
   * Attempt to resolve a blocker
   */
  async resolveBlocker(blocker: Blocker): Promise<ResolutionResult> {
    const strategy = this.selectStrategy(blocker);
    const startTime = Date.now();
    let attempts = 0;
    let resolved = false;
    let escalated = false;
    let escalationReason: string | undefined;
    let result: Record<string, unknown> | undefined;

    // Try resolution with retries
    while (attempts < this.config.maxRetries && !resolved && !escalated) {
      attempts++;

      const attempt = await this.executeResolution(blocker, strategy, attempts);

      if (attempt.status === 'succeeded') {
        resolved = true;
        result = attempt.result;
      } else if (attempt.status === 'escalated') {
        escalated = true;
        escalationReason = attempt.error;
      } else if (attempts < this.config.maxRetries) {
        // Wait before retry
        await this.backoff(attempts);
      }
    }

    // If not resolved after max retries, escalate
    if (!resolved && !escalated) {
      escalated = true;
      escalationReason = `Failed after ${attempts} attempts`;
      await this.escalateToHuman(blocker, strategy, attempts);
    }

    const duration = Date.now() - startTime;

    // Update blocker status
    await this.updateBlockerStatus(blocker.blockerId, resolved, escalated);

    // Learn from this resolution attempt
    if (this.config.enablePatternLearning) {
      await this.learnFromResolution(blocker, strategy, resolved, duration);
    }

    return {
      blockerId: blocker.blockerId,
      resolved,
      strategy,
      attempts,
      duration,
      escalated,
      escalationReason,
      result,
    };
  }

  /**
   * Get blocker patterns for a tenant
   */
  async getBlockerPatterns(tenantId: string): Promise<BlockerPattern[]> {
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.config.blockersTable,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `TENANT#${tenantId}`,
          ':prefix': 'PATTERN#',
        },
      })
    );

    return (result.Items || []) as BlockerPattern[];
  }

  /**
   * Get blockers for an agent
   */
  async getAgentBlockers(params: {
    tenantId: string;
    agentId: string;
    limit?: number;
  }): Promise<Blocker[]> {
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.config.blockersTable,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        FilterExpression: 'tenantId = :tenantId',
        ExpressionAttributeValues: {
          ':pk': `AGENT#${params.agentId}`,
          ':tenantId': params.tenantId,
        },
        ScanIndexForward: false, // Most recent first
        Limit: params.limit || 50,
      })
    );

    return (result.Items || []) as Blocker[];
  }

  // Private helper methods

  /**
   * Classify error into blocker taxonomy
   */
  private classifyBlocker(error: Error, context: Record<string, unknown>): BlockerType {
    const message = error.message.toLowerCase();
    const errorName = error.name.toLowerCase();

    // Permission errors
    if (
      message.includes('permission') ||
      message.includes('unauthorized') ||
      message.includes('access denied') ||
      errorName.includes('accessdenied')
    ) {
      return 'permission_error';
    }

    // Missing dependencies
    if (
      message.includes('not found') ||
      message.includes('does not exist') ||
      message.includes('missing') ||
      message.includes('undefined')
    ) {
      return 'missing_dependency';
    }

    // Rate limiting
    if (
      message.includes('rate limit') ||
      message.includes('throttle') ||
      message.includes('too many requests')
    ) {
      return 'api_rate_limit';
    }

    // Resource unavailable
    if (
      message.includes('unavailable') ||
      message.includes('timeout') ||
      message.includes('capacity')
    ) {
      return 'resource_unavailable';
    }

    // Validation errors
    if (
      message.includes('invalid') ||
      message.includes('validation') ||
      errorName.includes('validation')
    ) {
      return 'validation_error';
    }

    // Configuration errors
    if (message.includes('config') || message.includes('environment')) {
      return 'configuration_error';
    }

    // Network errors
    if (
      message.includes('network') ||
      message.includes('connection') ||
      errorName.includes('network')
    ) {
      return 'network_error';
    }

    return 'unknown';
  }

  /**
   * Assess blocker severity
   */
  private assessSeverity(
    type: BlockerType,
    context: Record<string, unknown>
  ): 'low' | 'medium' | 'high' | 'critical' {
    // Critical: permission errors, missing dependencies in critical path
    if (type === 'permission_error' || (type === 'missing_dependency' && context.critical)) {
      return 'critical';
    }

    // High: resource unavailable, configuration errors
    if (type === 'resource_unavailable' || type === 'configuration_error') {
      return 'high';
    }

    // Medium: rate limits, validation errors
    if (type === 'api_rate_limit' || type === 'validation_error') {
      return 'medium';
    }

    // Low: network errors (usually transient), unknown
    return 'low';
  }

  /**
   * Check if blocker can be auto-resolved
   */
  private canAutoResolve(type: BlockerType, severity: 'low' | 'medium' | 'high' | 'critical'): boolean {
    // Never auto-resolve critical permission errors
    if (type === 'permission_error' && severity === 'critical') {
      return false;
    }

    // Can auto-resolve: rate limits, network errors, some resource issues
    return ['api_rate_limit', 'network_error', 'resource_unavailable'].includes(type);
  }

  /**
   * Select resolution strategy based on blocker type
   */
  private selectStrategy(blocker: Blocker): ResolutionStrategy {
    const strategyMap: Record<BlockerType, ResolutionStrategy> = {
      missing_dependency: 'provision_on_demand',
      permission_error: 'escalate_to_human',
      resource_unavailable: 'retry_with_backoff',
      api_rate_limit: 'retry_with_backoff',
      validation_error: 'use_fallback',
      configuration_error: 'auto_configure',
      network_error: 'retry_with_backoff',
      unknown: 'escalate_to_human',
    };

    return strategyMap[blocker.type];
  }

  /**
   * Execute resolution attempt
   */
  private async executeResolution(
    blocker: Blocker,
    strategy: ResolutionStrategy,
    attemptNumber: number
  ): Promise<ResolutionAttempt> {
    const attempt: ResolutionAttempt = {
      attemptId: `${blocker.blockerId}-${attemptNumber}`,
      blockerId: blocker.blockerId,
      strategy,
      startedAt: new Date().toISOString(),
      status: 'in_progress',
      retryCount: attemptNumber,
    };

    try {
      let result: Record<string, unknown> | undefined;

      switch (strategy) {
        case 'provision_on_demand':
          result = await this.provisionResource(blocker);
          break;

        case 'retry_with_backoff':
          result = await this.retryOperation(blocker);
          break;

        case 'use_fallback':
          result = await this.useFallback(blocker);
          break;

        case 'auto_configure':
          result = await this.autoConfigureResource(blocker);
          break;

        case 'request_permission':
        case 'escalate_to_human':
          attempt.status = 'escalated';
          break;

        default:
          attempt.status = 'failed';
          attempt.error = 'Unknown resolution strategy';
      }

      if (result) {
        attempt.status = 'succeeded';
        attempt.result = result;
      }
    } catch (error) {
      attempt.status = 'failed';
      attempt.error = error instanceof Error ? error.message : String(error);
    }

    attempt.completedAt = new Date().toISOString();

    // Store attempt
    await this.ddb.send(
      new PutCommand({
        TableName: this.config.blockersTable,
        Item: {
          PK: `BLOCKER#${blocker.blockerId}`,
          SK: `ATTEMPT#${attempt.attemptId}`,
          ...attempt,
        },
      })
    );

    return attempt;
  }

  /**
   * Provision missing resource on demand
   */
  private async provisionResource(blocker: Blocker): Promise<Record<string, unknown>> {
    if (!this.config.enableAutoProvisioning) {
      throw new Error('Auto-provisioning is disabled');
    }

    // Implementation would create resource based on blocker context
    // For now, return success indication
    return {
      provisioned: true,
      resourceType: blocker.context.resourceType || 'unknown',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Retry the operation that caused the blocker
   */
  private async retryOperation(blocker: Blocker): Promise<Record<string, unknown>> {
    // Implementation would retry the original operation
    // For now, return retry indication
    return {
      retried: true,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Use fallback approach
   */
  private async useFallback(blocker: Blocker): Promise<Record<string, unknown>> {
    // Implementation would use alternative approach
    return {
      fallbackUsed: true,
      fallbackType: blocker.context.fallbackType || 'default',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Auto-configure resource
   */
  private async autoConfigureResource(blocker: Blocker): Promise<Record<string, unknown>> {
    // Implementation would apply configuration fix
    return {
      configured: true,
      configKey: blocker.context.configKey || 'unknown',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Escalate blocker to human
   */
  private async escalateToHuman(
    blocker: Blocker,
    strategy: ResolutionStrategy,
    attempts: number
  ): Promise<void> {
    // Update blocker with escalation flag
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.config.blockersTable,
        Key: {
          PK: `TENANT#${blocker.tenantId}`,
          SK: `BLOCKER#${blocker.blockerId}`,
        },
        UpdateExpression: 'SET escalated = :true, escalatedAt = :ts, attempts = :attempts',
        ExpressionAttributeValues: {
          ':true': true,
          ':ts': new Date().toISOString(),
          ':attempts': attempts,
        },
      })
    );

    // In production, would send notification to operations team
  }

  /**
   * Exponential backoff
   */
  private async backoff(attemptNumber: number): Promise<void> {
    const baseDelay = 1000; // 1 second
    const delay = Math.min(
      baseDelay * Math.pow(this.config.backoffMultiplier, attemptNumber - 1),
      this.config.maxBackoffMs
    );

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Update blocker resolution status
   */
  private async updateBlockerStatus(
    blockerId: string,
    resolved: boolean,
    escalated: boolean
  ): Promise<void> {
    // Note: tenantId needed for key - would be passed in production
    // Simplified for demonstration
  }

  /**
   * Learn from resolution attempt
   */
  private async learnFromResolution(
    blocker: Blocker,
    strategy: ResolutionStrategy,
    resolved: boolean,
    duration: number
  ): Promise<void> {
    const patternId = `${blocker.type}-${strategy}`;

    // Get or create pattern
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.config.blockersTable,
        Key: {
          PK: `TENANT#${blocker.tenantId}`,
          SK: `PATTERN#${patternId}`,
        },
      })
    );

    const existing = result.Item as BlockerPattern | undefined;

    const pattern: BlockerPattern = {
      patternId,
      type: blocker.type,
      occurrences: (existing?.occurrences || 0) + 1,
      successfulStrategy: resolved ? strategy : existing?.successfulStrategy,
      successRate: existing
        ? (existing.successRate * existing.occurrences + (resolved ? 1 : 0)) /
          (existing.occurrences + 1)
        : resolved
        ? 1
        : 0,
      avgResolutionTime: existing
        ? (existing.avgResolutionTime * existing.occurrences + duration) /
          (existing.occurrences + 1)
        : duration,
      lastSeen: new Date().toISOString(),
    };

    await this.ddb.send(
      new PutCommand({
        TableName: this.config.blockersTable,
        Item: {
          PK: `TENANT#${blocker.tenantId}`,
          SK: `PATTERN#${patternId}`,
          ...pattern,
        },
      })
    );
  }

  /**
   * Store diagnostic data in S3
   */
  private async storeDiagnostics(blocker: Blocker, error: Error): Promise<void> {
    const diagnostics = {
      blockerId: blocker.blockerId,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      blocker,
      timestamp: new Date().toISOString(),
    };

    const key = `diagnostics/${blocker.tenantId}/${blocker.blockerId}.json`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.diagnosticsBucket,
        Key: key,
        Body: JSON.stringify(diagnostics, null, 2),
        ContentType: 'application/json',
      })
    );
  }

  /**
   * Generate unique blocker ID
   */
  private generateBlockerId(): string {
    return `blk-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Create a blocker resolver instance
 */
export function createBlockerResolver(config: BlockerResolverConfig): BlockerResolver {
  return new BlockerResolver(config);
}
