/**
 * Event Handler Base Class for Chimera Agent Orchestration
 *
 * Provides an abstract base class for handling EventBridge events.
 * Handlers can be deployed as:
 * - Lambda functions (invoked by EventBridge rules)
 * - ECS tasks (long-running handlers)
 * - Step Functions (workflow orchestration)
 *
 * Features:
 * - Type-safe event handling
 * - Automatic error handling and retries
 * - Distributed tracing (X-Ray)
 * - Dead letter queue support
 * - Event validation
 */

import {
  ChimeraEvent,
  EventSource,
  EventDetailType,
  AllEventDetails,
  AgentEventDetail,
  TaskEventDetail,
  CoordinationEventDetail,
  CronEventDetail,
  A2AEventDetail,
  SystemEventDetail,
} from './event-types';

/**
 * Event handler context
 * Provides metadata about the invocation
 */
export interface EventHandlerContext {
  /** Invocation ID for tracing */
  invocationId: string;

  /** AWS request ID (for Lambda) */
  requestId?: string;

  /** Remaining execution time (for Lambda) */
  remainingTimeMs?: number;

  /** Retry count (0 for first attempt) */
  retryCount: number;

  /** Original event (before any transformations) */
  originalEvent: ChimeraEvent<AllEventDetails>;

  /** Additional context data */
  metadata?: Record<string, unknown>;
}

/**
 * Event handler result
 */
export interface EventHandlerResult {
  /** Handler execution status */
  status: 'success' | 'error' | 'retry';

  /** Optional message */
  message?: string;

  /** Output data (for downstream processing) */
  output?: unknown;

  /** Error details (if status is 'error') */
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

/**
 * Event handler options
 */
export interface EventHandlerOptions {
  /** Handler name (for logging/tracing) */
  name: string;

  /** Maximum retry attempts */
  maxRetries?: number;

  /** Enable X-Ray tracing */
  enableTracing?: boolean;

  /** Validate events before processing */
  validateEvents?: boolean;

  /** Dead letter queue ARN (for failed events) */
  deadLetterQueueArn?: string;
}

/**
 * Abstract base class for event handlers
 *
 * Subclasses implement specific event handling logic by overriding
 * the appropriate handle* methods.
 */
export abstract class EventHandler {
  protected options: Required<EventHandlerOptions>;

  constructor(options: EventHandlerOptions) {
    this.options = {
      name: options.name,
      maxRetries: options.maxRetries ?? 3,
      enableTracing: options.enableTracing ?? true,
      validateEvents: options.validateEvents ?? true,
      deadLetterQueueArn: options.deadLetterQueueArn ?? '',
    };
  }

  /**
   * Main entry point for event processing
   * Routes events to appropriate handlers based on source and detail-type
   */
  async handleEvent(
    event: ChimeraEvent<AllEventDetails>,
    context?: Partial<EventHandlerContext>
  ): Promise<EventHandlerResult> {
    const handlerContext: EventHandlerContext = {
      invocationId: this.generateInvocationId(),
      retryCount: context?.retryCount ?? 0,
      originalEvent: event,
      ...context,
    };

    try {
      // Validate event if enabled
      if (this.options.validateEvents) {
        this.validateEvent(event);
      }

      // Start tracing segment if enabled
      if (this.options.enableTracing) {
        this.startTracing(event, handlerContext);
      }

      // Route event to appropriate handler
      const result = await this.routeEvent(event, handlerContext);

      // End tracing segment
      if (this.options.enableTracing) {
        this.endTracing(result);
      }

      return result;
    } catch (error) {
      const handlerError = error as Error;

      // Determine if error is retryable
      const isRetryable = this.isRetryableError(handlerError);

      if (isRetryable && handlerContext.retryCount < this.options.maxRetries) {
        return {
          status: 'retry',
          error: {
            code: 'HANDLER_ERROR',
            message: handlerError.message,
            retryable: true,
          },
        };
      }

      // Send to DLQ if configured
      if (this.options.deadLetterQueueArn) {
        await this.sendToDeadLetterQueue(event, handlerError);
      }

      return {
        status: 'error',
        error: {
          code: 'HANDLER_ERROR',
          message: handlerError.message,
          retryable: false,
        },
      };
    }
  }

  /**
   * Route event to appropriate handler based on source
   */
  private async routeEvent(
    event: ChimeraEvent<AllEventDetails>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult> {
    switch (event.source) {
      case EventSource.AGENTS:
        return this.handleAgentEvent(event as ChimeraEvent<AgentEventDetail>, context);

      case EventSource.TASKS:
        return this.handleTaskEvent(event as ChimeraEvent<TaskEventDetail>, context);

      case EventSource.COORDINATION:
        return this.handleCoordinationEvent(
          event as ChimeraEvent<CoordinationEventDetail>,
          context
        );

      case EventSource.CRON:
        return this.handleCronEvent(event as ChimeraEvent<CronEventDetail>, context);

      case EventSource.A2A:
        return this.handleA2AEvent(event as ChimeraEvent<A2AEventDetail>, context);

      case EventSource.SYSTEM:
        return this.handleSystemEvent(event as ChimeraEvent<SystemEventDetail>, context);

      default:
        throw new Error(`Unsupported event source: ${event.source}`);
    }
  }

  /**
   * Handle agent lifecycle events
   * Override this method in subclasses to implement custom logic
   */
  protected async handleAgentEvent(
    event: ChimeraEvent<AgentEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult> {
    return {
      status: 'success',
      message: `Agent event ${event['detail-type']} not handled`,
    };
  }

  /**
   * Handle task lifecycle events
   * Override this method in subclasses to implement custom logic
   */
  protected async handleTaskEvent(
    event: ChimeraEvent<TaskEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult> {
    return {
      status: 'success',
      message: `Task event ${event['detail-type']} not handled`,
    };
  }

  /**
   * Handle coordination events
   * Override this method in subclasses to implement custom logic
   */
  protected async handleCoordinationEvent(
    event: ChimeraEvent<CoordinationEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult> {
    return {
      status: 'success',
      message: `Coordination event ${event['detail-type']} not handled`,
    };
  }

  /**
   * Handle cron events
   * Override this method in subclasses to implement custom logic
   */
  protected async handleCronEvent(
    event: ChimeraEvent<CronEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult> {
    return {
      status: 'success',
      message: `Cron event ${event['detail-type']} not handled`,
    };
  }

  /**
   * Handle A2A protocol events
   * Override this method in subclasses to implement custom logic
   */
  protected async handleA2AEvent(
    event: ChimeraEvent<A2AEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult> {
    return {
      status: 'success',
      message: `A2A event ${event['detail-type']} not handled`,
    };
  }

  /**
   * Handle system events
   * Override this method in subclasses to implement custom logic
   */
  protected async handleSystemEvent(
    event: ChimeraEvent<SystemEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult> {
    return {
      status: 'success',
      message: `System event ${event['detail-type']} not handled`,
    };
  }

  /**
   * Validate event structure
   */
  protected validateEvent(event: ChimeraEvent<AllEventDetails>): void {
    if (!event.version || event.version !== '0') {
      throw new Error('Invalid event version');
    }

    if (!event.id || !event.source || !event['detail-type']) {
      throw new Error('Missing required event fields');
    }

    if (!event.detail) {
      throw new Error('Missing event detail');
    }

    // Validate tenant ID is present for non-system events
    if (event.source !== EventSource.SYSTEM && !('tenantId' in event.detail)) {
      throw new Error('Missing tenantId in event detail');
    }
  }

  /**
   * Determine if error is retryable
   * Override this method to customize retry logic
   */
  protected isRetryableError(error: Error): boolean {
    // Common retryable errors
    const retryablePatterns = [
      /timeout/i,
      /throttl/i,
      /rate limit/i,
      /service unavailable/i,
      /temporarily unavailable/i,
      /connection/i,
    ];

    return retryablePatterns.some((pattern) => pattern.test(error.message));
  }

  /**
   * Send failed event to dead letter queue
   */
  protected async sendToDeadLetterQueue(
    event: ChimeraEvent<AllEventDetails>,
    error: Error
  ): Promise<void> {
    // Implementation would send to SQS/SNS
    console.error('Sending to DLQ:', {
      event,
      error: error.message,
      dlq: this.options.deadLetterQueueArn,
    });
  }

  /**
   * Start X-Ray tracing segment
   */
  protected startTracing(
    event: ChimeraEvent<AllEventDetails>,
    context: EventHandlerContext
  ): void {
    // Implementation would use AWS X-Ray SDK
    console.log('Starting trace:', {
      handlerName: this.options.name,
      invocationId: context.invocationId,
      eventSource: event.source,
      eventType: event['detail-type'],
    });
  }

  /**
   * End X-Ray tracing segment
   */
  protected endTracing(result: EventHandlerResult): void {
    // Implementation would use AWS X-Ray SDK
    console.log('Ending trace:', {
      status: result.status,
      message: result.message,
    });
  }

  /**
   * Generate unique invocation ID
   */
  protected generateInvocationId(): string {
    return `inv-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Log event processing
   */
  protected log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      handler: this.options.name,
      level,
      message,
      data,
    };

    console.log(JSON.stringify(logEntry));
  }
}

/**
 * Specialized handler for agent lifecycle events
 */
export abstract class AgentLifecycleHandler extends EventHandler {
  /**
   * Override to handle all agent events with typed detail
   */
  protected async handleAgentEvent(
    event: ChimeraEvent<AgentEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult> {
    // Route to specific agent event handlers
    switch (event['detail-type']) {
      case EventDetailType.AGENT_CREATED:
        return this.onAgentCreated(event, context);
      case EventDetailType.AGENT_STARTED:
        return this.onAgentStarted(event, context);
      case EventDetailType.AGENT_COMPLETED:
        return this.onAgentCompleted(event, context);
      case EventDetailType.AGENT_FAILED:
        return this.onAgentFailed(event, context);
      case EventDetailType.AGENT_CANCELLED:
        return this.onAgentCancelled(event, context);
      default:
        return { status: 'success', message: 'Agent event not handled' };
    }
  }

  protected abstract onAgentCreated(
    event: ChimeraEvent<AgentEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;

  protected abstract onAgentStarted(
    event: ChimeraEvent<AgentEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;

  protected abstract onAgentCompleted(
    event: ChimeraEvent<AgentEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;

  protected abstract onAgentFailed(
    event: ChimeraEvent<AgentEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;

  protected abstract onAgentCancelled(
    event: ChimeraEvent<AgentEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;
}

/**
 * Specialized handler for task lifecycle events
 */
export abstract class TaskLifecycleHandler extends EventHandler {
  /**
   * Override to handle all task events with typed detail
   */
  protected async handleTaskEvent(
    event: ChimeraEvent<TaskEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult> {
    // Route to specific task event handlers
    switch (event['detail-type']) {
      case EventDetailType.TASK_CREATED:
        return this.onTaskCreated(event, context);
      case EventDetailType.TASK_ASSIGNED:
        return this.onTaskAssigned(event, context);
      case EventDetailType.TASK_RUNNING:
        return this.onTaskRunning(event, context);
      case EventDetailType.TASK_COMPLETED:
        return this.onTaskCompleted(event, context);
      case EventDetailType.TASK_FAILED:
        return this.onTaskFailed(event, context);
      case EventDetailType.TASK_CANCELLED:
        return this.onTaskCancelled(event, context);
      default:
        return { status: 'success', message: 'Task event not handled' };
    }
  }

  protected abstract onTaskCreated(
    event: ChimeraEvent<TaskEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;

  protected abstract onTaskAssigned(
    event: ChimeraEvent<TaskEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;

  protected abstract onTaskRunning(
    event: ChimeraEvent<TaskEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;

  protected abstract onTaskCompleted(
    event: ChimeraEvent<TaskEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;

  protected abstract onTaskFailed(
    event: ChimeraEvent<TaskEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;

  protected abstract onTaskCancelled(
    event: ChimeraEvent<TaskEventDetail>,
    context: EventHandlerContext
  ): Promise<EventHandlerResult>;
}
