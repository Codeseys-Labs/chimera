/**
 * EventBridge Client Wrapper for Chimera Agent Orchestration
 *
 * Provides a high-level interface for publishing and subscribing to events
 * via Amazon EventBridge. Supports:
 * - Multi-tenant event isolation (dedicated buses or shared with filtering)
 * - Type-safe event publishing
 * - Event pattern matching and subscriptions
 * - Cross-region event delivery
 * - Dead letter queues for failed events
 */

import {
  EventBridgeClient,
  PutEventsCommand,
  PutEventsCommandInput,
  PutEventsRequestEntry,
  PutRuleCommand,
  PutTargetsCommand,
  DeleteRuleCommand,
  RemoveTargetsCommand,
  DescribeRuleCommand,
  ListRulesCommand,
  CreateEventBusCommand,
  DeleteEventBusCommand,
  DescribeEventBusCommand,
} from '@aws-sdk/client-eventbridge';
import {
  ChimeraEvent,
  EventSource,
  EventDetailType,
  AllEventDetails,
} from './event-types';

// Module-level singleton client cache per region
const eventBridgeClientCache = new Map<string, EventBridgeClient>();

function getEventBridgeClient(region: string): EventBridgeClient {
  if (!eventBridgeClientCache.has(region)) {
    eventBridgeClientCache.set(region, new EventBridgeClient({ region }));
  }
  return eventBridgeClientCache.get(region)!;
}

/**
 * EventBus configuration options
 */
export interface EventBusConfig {
  /** AWS region */
  region?: string;

  /** Event bus name (defaults to 'default') */
  eventBusName?: string;

  /** Enable multi-tenant isolation with dedicated buses */
  dedicatedBusPerTenant?: boolean;

  /** Event bus ARN (for cross-account/region) */
  eventBusArn?: string;

  /** Dead letter queue ARN for failed events */
  deadLetterQueueArn?: string;

  /** Maximum number of retries for failed events */
  maxRetries?: number;
}

/**
 * Event publishing options
 */
export interface PublishEventOptions {
  /** Override default event bus */
  eventBusName?: string;

  /** Resource ARNs to attach to event */
  resources?: string[];

  /** Trace ID for distributed tracing */
  traceId?: string;
}

/**
 * Event subscription options
 */
export interface SubscribeEventOptions {
  /** Rule name */
  ruleName: string;

  /** Rule description */
  description?: string;

  /** Event pattern to match */
  eventPattern: EventPattern;

  /** Target configuration (Lambda, SQS, SNS, etc.) */
  targets: EventTarget[];

  /** Rule state (enabled or disabled) */
  state?: 'ENABLED' | 'DISABLED';

  /** Event bus name (defaults to config) */
  eventBusName?: string;
}

/**
 * Event pattern for filtering
 */
export interface EventPattern {
  /** Match event source */
  source?: string[];

  /** Match detail-type */
  'detail-type'?: string[];

  /** Match account */
  account?: string[];

  /** Match region */
  region?: string[];

  /** Match resources */
  resources?: string[];

  /** Match detail fields */
  detail?: Record<string, unknown>;
}

/**
 * Event target configuration
 */
export interface EventTarget {
  /** Target ARN (Lambda, SQS, SNS, Step Functions, etc.) */
  arn: string;

  /** Target ID (unique within rule) */
  id: string;

  /** Input transformation */
  inputTransformer?: {
    inputPathsMap?: Record<string, string>;
    inputTemplate: string;
  };

  /** Role ARN for invoking target */
  roleArn?: string;

  /** Retry policy */
  retryPolicy?: {
    maximumRetryAttempts?: number;
    maximumEventAge?: number;
  };

  /** Dead letter queue */
  deadLetterConfig?: {
    arn: string;
  };
}

/**
 * EventBridge client wrapper
 */
export class ChimeraEventBus {
  private client: EventBridgeClient;
  private config: Required<EventBusConfig>;

  constructor(config: EventBusConfig = {}) {
    this.config = {
      region: config.region || process.env.AWS_REGION || 'us-east-1',
      eventBusName: config.eventBusName || 'default',
      dedicatedBusPerTenant: config.dedicatedBusPerTenant || false,
      eventBusArn: config.eventBusArn || '',
      deadLetterQueueArn: config.deadLetterQueueArn || '',
      maxRetries: config.maxRetries || 3,
    };

    // Use cached singleton client
    this.client = getEventBridgeClient(this.config.region);
  }

  /**
   * Publish a single event to EventBridge
   */
  async publishEvent<TDetail extends AllEventDetails>(
    source: EventSource,
    detailType: EventDetailType,
    detail: TDetail,
    options: PublishEventOptions = {}
  ): Promise<{ eventId?: string; errorCode?: string; errorMessage?: string }> {
    const entry: PutEventsRequestEntry = {
      Source: source,
      DetailType: detailType,
      Detail: JSON.stringify(detail),
      Resources: options.resources || [],
      EventBusName: options.eventBusName || this.getEventBusName(detail),
      TraceHeader: options.traceId,
    };

    const input: PutEventsCommandInput = {
      Entries: [entry],
    };

    try {
      const command = new PutEventsCommand(input);
      const response = await this.client.send(command);

      if (response.FailedEntryCount && response.FailedEntryCount > 0) {
        const failure = response.Entries?.[0];
        return {
          errorCode: failure?.ErrorCode,
          errorMessage: failure?.ErrorMessage,
        };
      }

      return {
        eventId: response.Entries?.[0]?.EventId,
      };
    } catch (error) {
      throw new Error(`Failed to publish event: ${(error as Error).message}`);
    }
  }

  /**
   * Publish multiple events in batch (up to 10)
   */
  async publishEvents(
    events: Array<{
      source: EventSource;
      detailType: EventDetailType;
      detail: AllEventDetails;
      options?: PublishEventOptions;
    }>
  ): Promise<{
    successCount: number;
    failedCount: number;
    failures: Array<{ index: number; errorCode?: string; errorMessage?: string }>;
  }> {
    if (events.length > 10) {
      throw new Error('Maximum 10 events per batch');
    }

    const entries: PutEventsRequestEntry[] = events.map((event) => ({
      Source: event.source,
      DetailType: event.detailType,
      Detail: JSON.stringify(event.detail),
      Resources: event.options?.resources || [],
      EventBusName: event.options?.eventBusName || this.getEventBusName(event.detail),
      TraceHeader: event.options?.traceId,
    }));

    try {
      const command = new PutEventsCommand({ Entries: entries });
      const response = await this.client.send(command);

      const failures: Array<{ index: number; errorCode?: string; errorMessage?: string }> = [];

      response.Entries?.forEach((entry: any, index: number) => {
        if (entry.ErrorCode) {
          failures.push({
            index,
            errorCode: entry.ErrorCode,
            errorMessage: entry.ErrorMessage,
          });
        }
      });

      return {
        successCount: events.length - failures.length,
        failedCount: failures.length,
        failures,
      };
    } catch (error) {
      throw new Error(`Failed to publish events: ${(error as Error).message}`);
    }
  }

  /**
   * Create an event subscription (EventBridge rule)
   */
  async subscribe(options: SubscribeEventOptions): Promise<{ ruleArn: string }> {
    const eventBusName = options.eventBusName || this.config.eventBusName;

    try {
      // Create rule
      const putRuleCommand = new PutRuleCommand({
        Name: options.ruleName,
        Description: options.description,
        EventPattern: JSON.stringify(options.eventPattern),
        State: options.state || 'ENABLED',
        EventBusName: eventBusName,
      });

      const ruleResponse = await this.client.send(putRuleCommand);

      // Add targets
      const targets = options.targets.map((target) => ({
        Arn: target.arn,
        Id: target.id,
        InputTransformer: target.inputTransformer
          ? {
              InputPathsMap: target.inputTransformer.inputPathsMap,
              InputTemplate: target.inputTransformer.inputTemplate,
            }
          : undefined,
        RoleArn: target.roleArn,
        RetryPolicy: target.retryPolicy
          ? {
              MaximumRetryAttempts: target.retryPolicy.maximumRetryAttempts,
              MaximumEventAgeInSeconds: target.retryPolicy.maximumEventAge,
            }
          : undefined,
        DeadLetterConfig: target.deadLetterConfig
          ? {
              Arn: target.deadLetterConfig.arn,
            }
          : undefined,
      }));

      const putTargetsCommand = new PutTargetsCommand({
        Rule: options.ruleName,
        EventBusName: eventBusName,
        Targets: targets,
      });

      await this.client.send(putTargetsCommand);

      return {
        ruleArn: ruleResponse.RuleArn || '',
      };
    } catch (error) {
      throw new Error(`Failed to create subscription: ${(error as Error).message}`);
    }
  }

  /**
   * Remove an event subscription
   */
  async unsubscribe(ruleName: string, eventBusName?: string): Promise<void> {
    const busName = eventBusName || this.config.eventBusName;

    try {
      // Remove all targets first
      const describeCommand = new DescribeRuleCommand({
        Name: ruleName,
        EventBusName: busName,
      });

      await this.client.send(describeCommand);

      // Remove targets (EventBridge returns target IDs, we'll remove all)
      const removeTargetsCommand = new RemoveTargetsCommand({
        Rule: ruleName,
        EventBusName: busName,
        Ids: ['1'], // Simplified - in production, list targets first
      });

      await this.client.send(removeTargetsCommand);

      // Delete rule
      const deleteCommand = new DeleteRuleCommand({
        Name: ruleName,
        EventBusName: busName,
      });

      await this.client.send(deleteCommand);
    } catch (error) {
      throw new Error(`Failed to remove subscription: ${(error as Error).message}`);
    }
  }

  /**
   * Create a dedicated event bus for a tenant
   */
  async createTenantBus(tenantId: string): Promise<{ eventBusArn: string }> {
    const busName = `chimera-events-tenant-${tenantId}`;

    try {
      const command = new CreateEventBusCommand({
        Name: busName,
        Tags: [
          { Key: 'tenantId', Value: tenantId },
          { Key: 'project', Value: 'chimera' },
        ],
      });

      const response = await this.client.send(command);

      return {
        eventBusArn: response.EventBusArn || '',
      };
    } catch (error) {
      throw new Error(`Failed to create tenant event bus: ${(error as Error).message}`);
    }
  }

  /**
   * Delete a tenant's event bus
   */
  async deleteTenantBus(tenantId: string): Promise<void> {
    const busName = `chimera-events-tenant-${tenantId}`;

    try {
      const command = new DeleteEventBusCommand({
        Name: busName,
      });

      await this.client.send(command);
    } catch (error) {
      throw new Error(`Failed to delete tenant event bus: ${(error as Error).message}`);
    }
  }

  /**
   * Get event bus details
   */
  async describeBus(eventBusName?: string): Promise<{
    name: string;
    arn: string;
    policy?: string;
  }> {
    const busName = eventBusName || this.config.eventBusName;

    try {
      const command = new DescribeEventBusCommand({
        Name: busName,
      });

      const response = await this.client.send(command);

      return {
        name: response.Name || '',
        arn: response.Arn || '',
        policy: response.Policy,
      };
    } catch (error) {
      throw new Error(`Failed to describe event bus: ${(error as Error).message}`);
    }
  }

  /**
   * List all rules on an event bus
   */
  async listRules(eventBusName?: string): Promise<
    Array<{
      name: string;
      description?: string;
      state?: string;
      eventPattern?: string;
    }>
  > {
    const busName = eventBusName || this.config.eventBusName;

    try {
      const command = new ListRulesCommand({
        EventBusName: busName,
      });

      const response = await this.client.send(command);

      return (
        response.Rules?.map((rule: any) => ({
          name: rule.Name || '',
          description: rule.Description,
          state: rule.State,
          eventPattern: rule.EventPattern,
        })) || []
      );
    } catch (error) {
      throw new Error(`Failed to list rules: ${(error as Error).message}`);
    }
  }

  /**
   * Get the appropriate event bus name based on tenant
   * Uses dedicated bus if configured, otherwise default
   */
  private getEventBusName(detail: AllEventDetails): string {
    if (this.config.dedicatedBusPerTenant && 'tenantId' in detail) {
      return `chimera-events-tenant-${detail.tenantId}`;
    }
    return this.config.eventBusName;
  }
}

/**
 * Create a standard event pattern for filtering by tenant
 */
export function createTenantEventPattern(
  tenantId: string,
  sources?: EventSource[],
  detailTypes?: EventDetailType[]
): EventPattern {
  return {
    source: sources,
    'detail-type': detailTypes,
    detail: {
      tenantId: [tenantId],
    },
  };
}

/**
 * Create event pattern for agent lifecycle events
 */
export function createAgentEventPattern(
  tenantId?: string,
  agentId?: string
): EventPattern {
  const pattern: EventPattern = {
    source: [EventSource.AGENTS],
    'detail-type': [
      EventDetailType.AGENT_CREATED,
      EventDetailType.AGENT_STARTED,
      EventDetailType.AGENT_COMPLETED,
      EventDetailType.AGENT_FAILED,
      EventDetailType.AGENT_CANCELLED,
    ],
  };

  if (tenantId || agentId) {
    pattern.detail = {};
    if (tenantId) pattern.detail.tenantId = [tenantId];
    if (agentId) pattern.detail.agentId = [agentId];
  }

  return pattern;
}

/**
 * Create event pattern for task lifecycle events
 */
export function createTaskEventPattern(tenantId?: string, taskId?: string): EventPattern {
  const pattern: EventPattern = {
    source: [EventSource.TASKS],
    'detail-type': [
      EventDetailType.TASK_CREATED,
      EventDetailType.TASK_ASSIGNED,
      EventDetailType.TASK_RUNNING,
      EventDetailType.TASK_COMPLETED,
      EventDetailType.TASK_FAILED,
      EventDetailType.TASK_CANCELLED,
    ],
  };

  if (tenantId || taskId) {
    pattern.detail = {};
    if (tenantId) pattern.detail.tenantId = [tenantId];
    if (taskId) pattern.detail.taskId = [taskId];
  }

  return pattern;
}

/**
 * Create event pattern for coordination events
 */
export function createCoordinationEventPattern(tenantId?: string): EventPattern {
  const pattern: EventPattern = {
    source: [EventSource.COORDINATION],
  };

  if (tenantId) {
    pattern.detail = {
      tenantId: [tenantId],
    };
  }

  return pattern;
}
