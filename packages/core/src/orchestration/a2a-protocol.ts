/**
 * Agent-to-Agent Communication Protocol (A2A)
 *
 * Defines message format and routing for direct agent communication:
 * - Structured message types (request, response, broadcast, event)
 * - Message routing via SQS
 * - Request-response correlation
 * - Broadcast to agent groups
 *
 * Complements MCP protocol: A2A for agent coordination, MCP for tool/data access
 */

import type { ISOTimestamp } from './types';

/**
 * A2A message types
 */
export type A2AMessageType =
  | 'request'      // Request-response pattern
  | 'response'     // Response to a request
  | 'broadcast'    // One-to-many notification
  | 'event';       // Event notification

/**
 * Message priority levels
 */
export type MessagePriority =
  | 'low'
  | 'normal'
  | 'high'
  | 'urgent';

/**
 * A2A message envelope
 */
export interface A2AMessage {
  messageId: string;
  type: A2AMessageType;
  sourceAgentId: string;
  targetAgentId?: string;      // Single recipient (undefined for broadcast)
  targetGroup?: string;         // Group name for broadcast
  tenantId: string;
  correlationId?: string;       // For request-response correlation
  replyTo?: string;            // Queue URL for async response
  priority: MessagePriority;
  timestamp: ISOTimestamp;
  expiresAt?: ISOTimestamp;    // Message TTL
  payload: A2APayload;
  metadata?: Record<string, unknown>;
}

/**
 * Message payload types
 */
export type A2APayload =
  | TaskRequest
  | TaskResponse
  | QueryRequest
  | QueryResponse
  | EventNotification
  | BroadcastMessage;

/**
 * Task delegation request
 */
export interface TaskRequest {
  type: 'task_request';
  taskId: string;
  instruction: string;
  context: Record<string, unknown>;
  timeoutSeconds?: number;
}

/**
 * Task completion response
 */
export interface TaskResponse {
  type: 'task_response';
  taskId: string;
  status: 'success' | 'failure' | 'timeout';
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Query request (request-response pattern)
 */
export interface QueryRequest {
  type: 'query_request';
  queryId: string;
  query: string;
  parameters?: Record<string, unknown>;
}

/**
 * Query response
 */
export interface QueryResponse {
  type: 'query_response';
  queryId: string;
  result: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Event notification
 */
export interface EventNotification {
  type: 'event';
  eventType: string;
  eventData: Record<string, unknown>;
}

/**
 * Broadcast message
 */
export interface BroadcastMessage {
  type: 'broadcast';
  topic: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Message routing configuration
 */
export interface RoutingConfig {
  tenantId: string;
  queueUrl: string;
  groups: Map<string, string[]>; // Group name -> agent IDs
}

/**
 * A2A Protocol Handler
 *
 * Manages agent-to-agent communication:
 * 1. Message serialization/deserialization
 * 2. Routing to target agents or groups
 * 3. Request-response correlation tracking
 * 4. Message validation and priority handling
 */
export class A2AProtocol {
  private routingConfig: RoutingConfig;
  private pendingRequests: Map<string, {
    messageId: string;
    timestamp: ISOTimestamp;
    timeoutMs: number;
  }>;

  constructor(config: RoutingConfig) {
    this.routingConfig = config;
    this.pendingRequests = new Map();
  }

  /**
   * Send request message (expects response)
   *
   * @param sourceAgentId - Sending agent ID
   * @param targetAgentId - Target agent ID
   * @param payload - Message payload
   * @param options - Optional settings
   * @returns Message ID for response correlation
   */
  async sendRequest(
    sourceAgentId: string,
    targetAgentId: string,
    payload: TaskRequest | QueryRequest,
    options?: {
      priority?: MessagePriority;
      timeoutMs?: number;
      replyTo?: string;
    }
  ): Promise<string> {
    const messageId = `a2a-req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const correlationId = messageId; // Use message ID as correlation ID

    const message: A2AMessage = {
      messageId,
      type: 'request',
      sourceAgentId,
      targetAgentId,
      tenantId: this.routingConfig.tenantId,
      correlationId,
      replyTo: options?.replyTo,
      priority: options?.priority || 'normal',
      timestamp: new Date().toISOString(),
      payload
    };

    // Track pending request for correlation
    this.pendingRequests.set(correlationId, {
      messageId,
      timestamp: message.timestamp,
      timeoutMs: options?.timeoutMs || 30000
    });

    // Send message (placeholder - will use SQS)
    await this.sendMessage(message);

    console.log(`[A2A] Request sent: ${messageId} (${sourceAgentId} → ${targetAgentId})`);

    return messageId;
  }

  /**
   * Send response message
   *
   * @param sourceAgentId - Responding agent ID
   * @param targetAgentId - Original requester ID
   * @param correlationId - Original request message ID
   * @param payload - Response payload
   */
  async sendResponse(
    sourceAgentId: string,
    targetAgentId: string,
    correlationId: string,
    payload: TaskResponse | QueryResponse
  ): Promise<void> {
    const messageId = `a2a-resp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const message: A2AMessage = {
      messageId,
      type: 'response',
      sourceAgentId,
      targetAgentId,
      tenantId: this.routingConfig.tenantId,
      correlationId,
      priority: 'normal',
      timestamp: new Date().toISOString(),
      payload
    };

    // Remove from pending requests
    this.pendingRequests.delete(correlationId);

    await this.sendMessage(message);

    console.log(`[A2A] Response sent: ${messageId} (correlation: ${correlationId})`);
  }

  /**
   * Broadcast message to agent group
   *
   * @param sourceAgentId - Broadcasting agent ID
   * @param groupName - Target group name
   * @param payload - Broadcast payload
   */
  async broadcast(
    sourceAgentId: string,
    groupName: string,
    payload: BroadcastMessage | EventNotification
  ): Promise<void> {
    const agentIds = this.routingConfig.groups.get(groupName);
    if (!agentIds || agentIds.length === 0) {
      throw new Error(`Group not found or empty: ${groupName}`);
    }

    const messageId = `a2a-bc-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const message: A2AMessage = {
      messageId,
      type: 'broadcast',
      sourceAgentId,
      targetGroup: groupName,
      tenantId: this.routingConfig.tenantId,
      priority: 'normal',
      timestamp: new Date().toISOString(),
      payload
    };

    // Send to all agents in group
    for (const targetAgentId of agentIds) {
      const targetMessage = { ...message, targetAgentId };
      await this.sendMessage(targetMessage);
    }

    console.log(`[A2A] Broadcast sent: ${messageId} (group: ${groupName}, ${agentIds.length} recipients)`);
  }

  /**
   * Publish event (fire-and-forget)
   *
   * @param sourceAgentId - Event source agent ID
   * @param targetAgentId - Target agent ID (optional, can be broadcast)
   * @param payload - Event payload
   */
  async publishEvent(
    sourceAgentId: string,
    targetAgentId: string,
    payload: EventNotification
  ): Promise<void> {
    const messageId = `a2a-evt-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const message: A2AMessage = {
      messageId,
      type: 'event',
      sourceAgentId,
      targetAgentId,
      tenantId: this.routingConfig.tenantId,
      priority: 'low',
      timestamp: new Date().toISOString(),
      payload
    };

    await this.sendMessage(message);

    console.log(`[A2A] Event published: ${messageId} (${payload.eventType})`);
  }

  /**
   * Parse incoming A2A message
   *
   * @param rawMessage - Raw message from SQS
   * @returns Parsed A2A message
   */
  parseMessage(rawMessage: string): A2AMessage {
    try {
      const message = JSON.parse(rawMessage) as A2AMessage;

      // Validate required fields
      if (!message.messageId || !message.type || !message.sourceAgentId) {
        throw new Error('Invalid A2A message: missing required fields');
      }

      // Check expiration
      if (message.expiresAt) {
        const expiresAt = new Date(message.expiresAt).getTime();
        if (Date.now() > expiresAt) {
          throw new Error(`Message expired: ${message.messageId}`);
        }
      }

      return message;
    } catch (error) {
      throw new Error(`Failed to parse A2A message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Register agent group for broadcast routing
   *
   * @param groupName - Group name
   * @param agentIds - Array of agent IDs in the group
   */
  registerGroup(groupName: string, agentIds: string[]): void {
    this.routingConfig.groups.set(groupName, agentIds);
    console.log(`[A2A] Registered group: ${groupName} (${agentIds.length} agents)`);
  }

  /**
   * Unregister agent group
   *
   * @param groupName - Group name
   */
  unregisterGroup(groupName: string): void {
    this.routingConfig.groups.delete(groupName);
    console.log(`[A2A] Unregistered group: ${groupName}`);
  }

  /**
   * Get pending requests (for timeout monitoring)
   */
  getPendingRequests(): Array<{
    messageId: string;
    timestamp: ISOTimestamp;
    timeoutMs: number;
  }> {
    return Array.from(this.pendingRequests.values());
  }

  /**
   * Check for timed-out requests
   */
  checkTimeouts(): string[] {
    const now = Date.now();
    const timedOut: string[] = [];

    for (const [correlationId, request] of this.pendingRequests.entries()) {
      const age = now - new Date(request.timestamp).getTime();
      if (age > request.timeoutMs) {
        timedOut.push(correlationId);
        this.pendingRequests.delete(correlationId);
      }
    }

    if (timedOut.length > 0) {
      console.log(`[A2A] Timed out requests: ${timedOut.length}`);
    }

    return timedOut;
  }

  /**
   * Send message via SQS
   * (Placeholder - will use SQS SDK)
   */
  private async sendMessage(message: A2AMessage): Promise<void> {
    // TODO: Send to SQS queue
    // const queueUrl = this.routingConfig.queueUrl;
    // await sqs.sendMessage({
    //   QueueUrl: queueUrl,
    //   MessageBody: JSON.stringify(message),
    //   MessageAttributes: {
    //     priority: {
    //       DataType: 'String',
    //       StringValue: message.priority
    //     },
    //     tenantId: {
    //       DataType: 'String',
    //       StringValue: message.tenantId
    //     },
    //     targetAgentId: {
    //       DataType: 'String',
    //       StringValue: message.targetAgentId || ''
    //     }
    //   }
    // });

    console.log(`[A2A] Message sent: ${message.messageId}`);
  }
}

/**
 * Create A2A protocol handler
 */
export function createA2AProtocol(config: RoutingConfig): A2AProtocol {
  return new A2AProtocol(config);
}

/**
 * A2A message builder helpers
 */
export const A2AMessageBuilder = {
  /**
   * Build task request
   */
  taskRequest: (
    taskId: string,
    instruction: string,
    context: Record<string, unknown> = {}
  ): TaskRequest => ({
    type: 'task_request',
    taskId,
    instruction,
    context
  }),

  /**
   * Build task response
   */
  taskResponse: (
    taskId: string,
    status: 'success' | 'failure' | 'timeout',
    result?: Record<string, unknown>,
    error?: { code: string; message: string }
  ): TaskResponse => ({
    type: 'task_response',
    taskId,
    status,
    result,
    error
  }),

  /**
   * Build query request
   */
  queryRequest: (
    queryId: string,
    query: string,
    parameters?: Record<string, unknown>
  ): QueryRequest => ({
    type: 'query_request',
    queryId,
    query,
    parameters
  }),

  /**
   * Build query response
   */
  queryResponse: (
    queryId: string,
    result: Record<string, unknown>,
    error?: { code: string; message: string }
  ): QueryResponse => ({
    type: 'query_response',
    queryId,
    result,
    error
  }),

  /**
   * Build event notification
   */
  event: (
    eventType: string,
    eventData: Record<string, unknown>
  ): EventNotification => ({
    type: 'event',
    eventType,
    eventData
  }),

  /**
   * Build broadcast message
   */
  broadcast: (
    topic: string,
    message: string,
    data?: Record<string, unknown>
  ): BroadcastMessage => ({
    type: 'broadcast',
    topic,
    message,
    data
  })
};
