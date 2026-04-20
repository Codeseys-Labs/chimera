/**
 * Audit Trail Service
 *
 * Structured activity logging for AWS API actions with full context
 * Implements action audit trail from activity logging architecture
 *
 * See: docs/research/aws-account-agent/03-Action-Audit-Trail-Structured-Storage.md
 */

import type {
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  ScanCommandInput,
  ScanCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { TenantTier } from '@chimera/shared';

/**
 * Tier-based audit retention in days.
 *
 * Compliance requirement (see security-review.md M3):
 *   basic    -> 90 days
 *   advanced -> 365 days (1 year)
 *   premium  -> 2555 days (7 years)
 *
 * These values are the single source of truth for audit TTL. A caller
 * MUST NOT override the TTL -- doing so defeats compliance (e.g. a basic
 * tenant could write a 7-year TTL).
 */
export const AUDIT_TTL_DAYS_BY_TIER: Record<TenantTier, number> = {
  basic: 90,
  advanced: 365,
  premium: 365 * 7,
};

/**
 * Calculate the Unix epoch-seconds TTL for an audit event written now,
 * based on the writing tenant's subscription tier.
 *
 * Using `Date.now()` + day-milliseconds ensures correctness across DST
 * boundaries and avoids mutating a shared Date reference.
 *
 * @param tenantTier - Subscription tier of the tenant whose audit row is being written
 * @returns Unix epoch seconds when DynamoDB TTL should expire the row
 */
export function calculateAuditTTL(tenantTier: TenantTier): number {
  const days = AUDIT_TTL_DAYS_BY_TIER[tenantTier];
  if (typeof days !== 'number') {
    // Defensive: unknown tier falls back to the strictest retention so we
    // never accidentally retain PII for longer than the basic policy allows.
    const fallbackDays = AUDIT_TTL_DAYS_BY_TIER.basic;
    const ms = Date.now() + fallbackDays * 24 * 60 * 60 * 1000;
    return Math.floor(ms / 1000);
  }
  const ms = Date.now() + days * 24 * 60 * 60 * 1000;
  return Math.floor(ms / 1000);
}

/**
 * DynamoDB client interface
 */
export interface DynamoDBClient {
  get(params: GetCommandInput): Promise<GetCommandOutput>;
  put(params: PutCommandInput): Promise<PutCommandOutput>;
  update(params: UpdateCommandInput): Promise<UpdateCommandOutput>;
  query(params: QueryCommandInput): Promise<QueryCommandOutput>;
  scan(params: ScanCommandInput): Promise<ScanCommandOutput>;
}

/**
 * Audit trail configuration
 */
export interface AuditTrailConfig {
  /** DynamoDB table name for activity logs */
  activityLogsTableName: string;

  /** DynamoDB client */
  dynamodb: DynamoDBClient;

  /**
   * DEPRECATED: TTL is now computed per-write from the tenant's subscription tier
   * via {@link calculateAuditTTL}. Passing this value has no effect and will be
   * removed in a future release. Kept temporarily for backwards compat with
   * existing construction call sites.
   */
  hotStorageTTLDays?: number;
}

/**
 * Action category classification
 */
export type ActionCategory = 'create' | 'update' | 'delete' | 'read' | 'config_change';

/**
 * Action result status
 */
export type ActionResult = 'success' | 'failure' | 'partial';

/**
 * Cost confidence level
 */
export type CostConfidence = 'high' | 'medium' | 'low';

/**
 * Cost estimate source
 */
export type CostSource = 'aws-pricing-api' | 'estimate' | 'actual';

/**
 * Resource information
 */
export interface ResourceInfo {
  type: string; // e.g., "DynamoDB Table", "Lambda Function"
  name: string;
  arn?: string;
  identifier?: string; // Resource ID, table name, function name, etc.
  metadata?: Record<string, any>;
}

/**
 * API call details
 */
export interface APICallDetails {
  requestParameters: any; // What was sent to AWS API
  responseElements?: any; // What AWS API returned
  errorCode?: string; // If action failed
  errorMessage?: string;
  durationMs: number; // How long API call took
  retryCount: number; // Number of retries
}

/**
 * State change information (for updates)
 */
export interface StateChange {
  before: any;
  after: any;
  diff: any; // JSONPatch format
}

/**
 * Cost impact estimation
 */
export interface CostImpact {
  immediate: number; // One-time cost (USD)
  estimatedMonthly: number;
  estimatedAnnual: number;
  confidence: CostConfidence;
  source: CostSource;
  breakdown?: Record<string, number>;
}

/**
 * Execution context
 */
export interface ExecutionContext {
  traceId: string; // X-Ray trace ID
  parentSpanId?: string; // Parent span for nested calls
  toolName?: string; // Which tool was used
  codeLocation?: string; // File:line where action originated
}

/**
 * Action log record
 *
 * Comprehensive audit trail for every AWS API action with business context
 */
export interface ActionLog {
  // Identity
  actionId: string; // "action-2026-03-20-x7y8z9"
  activityId: string; // "act-2026-03-20-a1b2c3" (parent activity/decision)
  decisionId?: string; // Optional: explicit decision reference
  tenantId: string;
  agentId: string;
  sessionId: string;
  timestamp: string; // ISO 8601

  // Action Classification
  actionType: string; // "aws.dynamodb.create_table"
  actionCategory: ActionCategory;
  actionIntent: string; // Human-readable purpose

  // AWS API Details
  awsService: string; // "DynamoDB"
  awsAction: string; // "CreateTable"
  awsRegion: string;
  awsRequestId: string; // AWS request ID from API response
  awsEventTime: string;

  // Resource Information
  resource: ResourceInfo;

  // API Call Details
  apiCall: APICallDetails;

  // State Change (for updates)
  stateChange?: StateChange;

  // Cost Impact
  cost: CostImpact;

  // Execution Context
  executionContext: ExecutionContext;

  // Tags (propagated to resource)
  tags: Record<string, string>;

  // Result
  result: ActionResult;
  resultMessage?: string;
}

/**
 * DynamoDB item structure for action logs
 *
 * Hot storage (0-90 days) in chimera-activity-logs table
 */
export interface ActionLogItem {
  PK: string; // TENANT#{tenantId}
  SK: string; // ACTION#{timestamp}#{actionId}

  // Core fields for efficient querying
  actionId: string;
  activityId: string;
  actionType: string;
  actionCategory: ActionCategory;
  timestamp: string;

  // Full action log (nested document)
  actionLog: ActionLog;

  // Searchable fields (for GSI queries)
  resourceArn?: string;
  resourceName: string;
  awsService: string;
  awsAction: string;

  // Cost tracking
  estimatedMonthlyCost: number;

  // TTL (90 days default)
  ttl: number; // Unix timestamp
}

/**
 * Parameters for logging an action
 */
export interface LogActionParams {
  // Identity
  activityId: string;
  decisionId?: string;
  tenantId: string;
  /**
   * Subscription tier of the tenant whose audit row is being written.
   * Drives TTL enforcement (90d basic / 1y advanced / 7y premium).
   * Required: compliance retention cannot be determined without it.
   */
  tenantTier: TenantTier;
  agentId: string;
  sessionId: string;

  // Action details
  actionType: string;
  actionCategory: ActionCategory;
  actionIntent: string;

  // AWS API details
  awsService: string;
  awsAction: string;
  awsRegion: string;
  awsRequestId: string;

  // Resource
  resource: ResourceInfo;

  // API call
  apiCall: APICallDetails;

  // Optional fields
  stateChange?: StateChange;
  cost?: Partial<CostImpact>;
  executionContext?: Partial<ExecutionContext>;
  tags?: Record<string, string>;
  result?: ActionResult;
  resultMessage?: string;

  /**
   * DO NOT SET. Reserved for internal invariant tests only. If provided,
   * {@link AuditTrail.logAction} will throw -- audit TTL is strictly a function
   * of tenant tier and cannot be overridden by callers. This field exists so
   * a negative test can assert that overrides are rejected.
   */
  ttl?: never;
}

/**
 * Query parameters for action logs
 */
export interface QueryActionsParams {
  tenantId: string;
  startTime?: string; // ISO 8601
  endTime?: string; // ISO 8601
  actionCategory?: ActionCategory;
  awsService?: string;
  result?: ActionResult;
  limit?: number;
}

/**
 * Query by resource ARN parameters
 */
export interface QueryByResourceParams {
  resourceArn: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

/**
 * Audit Trail Service
 *
 * Records every AWS API call with full context:
 * - Decision linkage (why this action was taken)
 * - Cost estimation (what this will cost)
 * - State change tracking (what changed)
 * - Resource tagging (linking resources to decisions)
 *
 * Storage: DynamoDB (hot), S3 (warm), Glacier (cold)
 */
export class AuditTrail {
  private config: AuditTrailConfig;

  constructor(config: AuditTrailConfig) {
    this.config = config;
  }

  /**
   * Generate unique action ID
   *
   * Format: action-YYYY-MM-DD-{random}
   */
  private generateActionId(): string {
    const date = new Date().toISOString().split('T')[0];
    const random = Math.random().toString(36).substring(2, 8);
    return `action-${date}-${random}`;
  }

  /**
   * Log an AWS API action
   *
   * Records action with full context to DynamoDB. The DynamoDB TTL attribute
   * is always computed from the tenant's subscription tier via
   * {@link calculateAuditTTL}; any caller-supplied `ttl` on `params` is rejected.
   *
   * @param params - Action logging parameters (must include `tenantTier`)
   * @returns Action ID
   */
  async logAction(params: LogActionParams): Promise<string> {
    // Enforce tier-driven TTL invariant. This guards against a caller (or a
    // future refactor) smuggling in a longer retention than the tenant's tier
    // allows. See security-review.md M3.
    if (Object.prototype.hasOwnProperty.call(params, 'ttl')) {
      throw new Error(
        'AuditTrail.logAction: caller-supplied `ttl` is not permitted. ' +
          'TTL is derived from tenantTier via calculateAuditTTL().'
      );
    }
    if (!params.tenantTier) {
      throw new Error(
        'AuditTrail.logAction: `tenantTier` is required to compute compliance TTL.'
      );
    }

    const actionId = this.generateActionId();
    const timestamp = new Date().toISOString();
    const awsEventTime = timestamp;

    // Build full ActionLog object
    const actionLog: ActionLog = {
      // Identity
      actionId,
      activityId: params.activityId,
      decisionId: params.decisionId,
      tenantId: params.tenantId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      timestamp,

      // Action Classification
      actionType: params.actionType,
      actionCategory: params.actionCategory,
      actionIntent: params.actionIntent,

      // AWS API Details
      awsService: params.awsService,
      awsAction: params.awsAction,
      awsRegion: params.awsRegion,
      awsRequestId: params.awsRequestId,
      awsEventTime,

      // Resource
      resource: params.resource,

      // API Call
      apiCall: params.apiCall,

      // State Change (optional)
      stateChange: params.stateChange,

      // Cost Impact (with defaults)
      cost: {
        immediate: params.cost?.immediate || 0,
        estimatedMonthly: params.cost?.estimatedMonthly || 0,
        estimatedAnnual: params.cost?.estimatedAnnual || 0,
        confidence: params.cost?.confidence || 'low',
        source: params.cost?.source || 'estimate',
        breakdown: params.cost?.breakdown,
      },

      // Execution Context (with defaults)
      executionContext: {
        traceId: params.executionContext?.traceId || this.generateTraceId(),
        parentSpanId: params.executionContext?.parentSpanId,
        toolName: params.executionContext?.toolName,
        codeLocation: params.executionContext?.codeLocation,
      },

      // Tags (with chimera defaults)
      tags: {
        'chimera:tenant-id': params.tenantId,
        'chimera:action-id': actionId,
        'chimera:activity-id': params.activityId,
        ...(params.decisionId ? { 'chimera:decision-id': params.decisionId } : {}),
        'chimera:agent-id': params.agentId,
        'chimera:created-at': timestamp,
        ...(params.tags || {}),
      },

      // Result
      result: params.result || 'success',
      resultMessage: params.resultMessage,
    };

    // Create DynamoDB item
    const item: ActionLogItem = {
      PK: `TENANT#${params.tenantId}`,
      SK: `ACTION#${timestamp}#${actionId}`,

      // Core fields
      actionId,
      activityId: params.activityId,
      actionType: params.actionType,
      actionCategory: params.actionCategory,
      timestamp,

      // Full log
      actionLog,

      // Searchable fields
      resourceArn: params.resource.arn,
      resourceName: params.resource.name,
      awsService: params.awsService,
      awsAction: params.awsAction,

      // Cost
      estimatedMonthlyCost: actionLog.cost.estimatedMonthly,

      // TTL: tier-enforced (90d basic / 1y advanced / 7y premium).
      // See calculateAuditTTL() and security-review.md M3.
      ttl: calculateAuditTTL(params.tenantTier),
    };

    // Write to DynamoDB
    await this.config.dynamodb.put({
      TableName: this.config.activityLogsTableName,
      Item: item,
    });

    return actionId;
  }

  /**
   * Generate X-Ray trace ID
   *
   * Format: 1-{hex8}-{hex24}
   */
  private generateTraceId(): string {
    const time = Math.floor(Date.now() / 1000).toString(16);
    const random = Array.from({ length: 24 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
    return `1-${time}-${random}`;
  }

  /**
   * Get action log by ID
   *
   * @param tenantId - Tenant ID
   * @param actionId - Action ID
   * @returns Action log or null
   */
  async getAction(tenantId: string, actionId: string): Promise<ActionLog | null> {
    // Query by PK and SK prefix (we need timestamp, so query instead of get)
    const params = {
      TableName: this.config.activityLogsTableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'actionId = :actionId',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}`,
        ':skPrefix': 'ACTION#',
        ':actionId': actionId,
      },
      Limit: 1,
    };

    const result = await this.config.dynamodb.query(params);

    if (!result.Items || result.Items.length === 0) {
      return null;
    }

    const item = result.Items[0] as ActionLogItem;
    return item.actionLog;
  }

  /**
   * Query actions for tenant
   *
   * @param params - Query parameters
   * @returns Array of action logs
   */
  async queryActions(params: QueryActionsParams): Promise<ActionLog[]> {
    const {
      tenantId,
      startTime,
      endTime,
      actionCategory,
      awsService,
      result,
      limit = 100,
    } = params;

    // Build key condition
    let keyConditionExpression = 'PK = :pk';
    const expressionAttributeValues: Record<string, any> = {
      ':pk': `TENANT#${tenantId}`,
    };

    // Add time range if provided
    if (startTime && endTime) {
      keyConditionExpression += ' AND SK BETWEEN :startSK AND :endSK';
      expressionAttributeValues[':startSK'] = `ACTION#${startTime}`;
      expressionAttributeValues[':endSK'] = `ACTION#${endTime}`;
    } else if (startTime) {
      keyConditionExpression += ' AND SK >= :startSK';
      expressionAttributeValues[':startSK'] = `ACTION#${startTime}`;
    } else if (endTime) {
      keyConditionExpression += ' AND SK <= :endSK';
      expressionAttributeValues[':endSK'] = `ACTION#${endTime}`;
    }

    // Build filter expression for optional filters
    const filterExpressions: string[] = [];

    if (actionCategory) {
      filterExpressions.push('actionCategory = :category');
      expressionAttributeValues[':category'] = actionCategory;
    }

    if (awsService) {
      filterExpressions.push('awsService = :service');
      expressionAttributeValues[':service'] = awsService;
    }

    if (result) {
      filterExpressions.push('actionLog.#result = :result');
      expressionAttributeValues[':result'] = result;
    }

    const queryParams: any = {
      TableName: this.config.activityLogsTableName,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: false, // Most recent first
      Limit: limit,
    };

    if (filterExpressions.length > 0) {
      queryParams.FilterExpression = filterExpressions.join(' AND ');

      // Add expression attribute names if 'result' is in filter (reserved word)
      if (result) {
        queryParams.ExpressionAttributeNames = { '#result': 'result' };
      }
    }

    const queryResult = await this.config.dynamodb.query(queryParams);

    return (queryResult.Items || []).map((item) => (item as ActionLogItem).actionLog);
  }

  /**
   * Query actions by resource ARN
   *
   * Uses GSI1 (resource-activity-index) for efficient lookup
   *
   * @param params - Query parameters
   * @returns Array of action logs
   */
  async queryByResource(params: QueryByResourceParams): Promise<ActionLog[]> {
    const { resourceArn, startTime, endTime, limit = 100 } = params;

    // Build key condition for GSI
    let keyConditionExpression = 'resourceArn = :arn';
    const expressionAttributeValues: Record<string, any> = {
      ':arn': resourceArn,
    };

    // Add time range if provided (GSI sort key is timestamp)
    if (startTime && endTime) {
      keyConditionExpression += ' AND #ts BETWEEN :start AND :end';
      expressionAttributeValues[':start'] = startTime;
      expressionAttributeValues[':end'] = endTime;
    } else if (startTime) {
      keyConditionExpression += ' AND #ts >= :start';
      expressionAttributeValues[':start'] = startTime;
    } else if (endTime) {
      keyConditionExpression += ' AND #ts <= :end';
      expressionAttributeValues[':end'] = endTime;
    }

    const queryParams = {
      TableName: this.config.activityLogsTableName,
      IndexName: 'resource-activity-index',
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeNames: {
        '#ts': 'timestamp',
      },
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: true, // Chronological order for resource history
      Limit: limit,
    };

    const result = await this.config.dynamodb.query(queryParams);

    return (result.Items || []).map((item) => (item as ActionLogItem).actionLog);
  }

  /**
   * Query actions by service
   *
   * Uses GSI2 (service-action-index) for efficient lookup
   *
   * @param awsService - AWS service name (e.g., "DynamoDB", "Lambda")
   * @param startTime - Optional start time filter
   * @param endTime - Optional end time filter
   * @param limit - Maximum number of results
   * @returns Array of action logs
   */
  async queryByService(
    awsService: string,
    startTime?: string,
    endTime?: string,
    limit: number = 100
  ): Promise<ActionLog[]> {
    let keyConditionExpression = 'awsService = :service';
    const expressionAttributeValues: Record<string, any> = {
      ':service': awsService,
    };

    // Add time range if provided
    if (startTime && endTime) {
      keyConditionExpression += ' AND #ts BETWEEN :start AND :end';
      expressionAttributeValues[':start'] = startTime;
      expressionAttributeValues[':end'] = endTime;
    } else if (startTime) {
      keyConditionExpression += ' AND #ts >= :start';
      expressionAttributeValues[':start'] = startTime;
    } else if (endTime) {
      keyConditionExpression += ' AND #ts <= :end';
      expressionAttributeValues[':end'] = endTime;
    }

    const queryParams = {
      TableName: this.config.activityLogsTableName,
      IndexName: 'service-action-index',
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeNames: {
        '#ts': 'timestamp',
      },
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: false, // Most recent first
      Limit: limit,
    };

    const result = await this.config.dynamodb.query(queryParams);

    return (result.Items || []).map((item) => (item as ActionLogItem).actionLog);
  }

  /**
   * Find all failed actions
   *
   * @param tenantId - Tenant ID
   * @param startTime - Optional start time
   * @param endTime - Optional end time
   * @param limit - Maximum number of results
   * @returns Array of failed action logs
   */
  async findFailedActions(
    tenantId: string,
    startTime?: string,
    endTime?: string,
    limit: number = 100
  ): Promise<ActionLog[]> {
    return this.queryActions({
      tenantId,
      startTime,
      endTime,
      result: 'failure',
      limit,
    });
  }

  /**
   * Get total infrastructure cost created in period
   *
   * Aggregates estimated monthly costs for all 'create' actions
   *
   * @param tenantId - Tenant ID
   * @param startTime - Start time
   * @param endTime - End time
   * @returns Total estimated monthly cost
   */
  async getTotalCostCreated(
    tenantId: string,
    startTime: string,
    endTime: string
  ): Promise<number> {
    const actions = await this.queryActions({
      tenantId,
      startTime,
      endTime,
      actionCategory: 'create',
      result: 'success',
      limit: 1000, // Adjust based on expected volume
    });

    return actions.reduce((total, action) => total + action.cost.estimatedMonthly, 0);
  }

  /**
   * Get resource lifecycle
   *
   * Finds all actions (create, update, delete) for a resource
   *
   * @param resourceArn - Resource ARN
   * @returns Array of actions in chronological order
   */
  async getResourceLifecycle(resourceArn: string): Promise<ActionLog[]> {
    return this.queryByResource({
      resourceArn,
      // No time filter to get complete history
    });
  }

  /**
   * Find actions by decision ID
   *
   * Links back to originating decision to understand "why"
   *
   * @param tenantId - Tenant ID
   * @param decisionId - Decision ID
   * @returns Array of actions linked to this decision
   */
  async findActionsByDecision(tenantId: string, decisionId: string): Promise<ActionLog[]> {
    const params = {
      TableName: this.config.activityLogsTableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'actionLog.decisionId = :decisionId',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}`,
        ':skPrefix': 'ACTION#',
        ':decisionId': decisionId,
      },
    };

    const result = await this.config.dynamodb.query(params);

    return (result.Items || []).map((item) => (item as ActionLogItem).actionLog);
  }
}
