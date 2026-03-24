/**
 * GroupChat - SNS/SQS Fan-Out Pattern for Multi-Agent Communication
 *
 * Implements pub-sub messaging for agent swarms:
 * - SNS topic for message publishing (one-to-many)
 * - Per-agent SQS subscriptions for message receiving
 * - Any agent publishes to SNS → all agents receive via their SQS queues
 * - Supports A2A protocol message types (status, question, result, error)
 *
 * Architecture:
 * ```
 * Agent A ──┐
 *           ├──> SNS Topic ──┬──> SQS Queue (Agent A) ──> Agent A
 * Agent B ──┘                ├──> SQS Queue (Agent B) ──> Agent B
 *                            └──> SQS Queue (Agent C) ──> Agent C
 * ```
 *
 * Use Cases:
 * - Swarm coordination (agents sharing progress updates)
 * - Multi-agent collaboration (shared context, artifacts)
 * - Task group communication (all agents in a task group)
 * - Event broadcasting (system events to all active agents)
 */

import type { A2AMessage } from './a2a-protocol';
import type { ISOTimestamp } from './types';

/**
 * GroupChat message type
 * Extends A2A message with groupchat-specific fields
 */
export interface GroupChatMessage extends A2AMessage {
  /** Group/swarm identifier */
  groupId: string;

  /** Message visibility level */
  visibility: 'group' | 'all';

  /** Optional reply thread ID */
  threadId?: string;
}

/**
 * GroupChat configuration
 */
export interface GroupChatConfig {
  /** Tenant identifier */
  tenantId: string;

  /** Group/swarm identifier */
  groupId: string;

  /** AWS region */
  region?: string;

  /** Agent IDs in this group */
  agentIds: string[];

  /** SNS topic ARN (if already exists) */
  topicArn?: string;

  /** Message retention period in seconds (default: 4 days) */
  messageRetentionSeconds?: number;

  /** Visibility timeout for SQS messages (default: 30s) */
  visibilityTimeoutSeconds?: number;
}

/**
 * Agent subscription details
 */
export interface AgentSubscription {
  /** Agent identifier */
  agentId: string;

  /** SQS queue URL */
  queueUrl: string;

  /** SQS queue ARN */
  queueArn: string;

  /** SNS subscription ARN */
  subscriptionArn: string;

  /** Subscription status */
  status: 'pending' | 'active' | 'deleted';
}

/**
 * GroupChat metrics
 */
export interface GroupChatMetrics {
  /** Total messages published */
  messagesPublished: number;

  /** Total messages received across all agents */
  messagesReceived: number;

  /** Active subscriptions */
  activeSubscriptions: number;

  /** Failed deliveries */
  failedDeliveries: number;

  /** Last activity timestamp */
  lastActivityAt: ISOTimestamp;
}

/**
 * GroupChat - SNS/SQS fan-out for multi-agent pub-sub communication
 *
 * Manages lifecycle of SNS topic + per-agent SQS subscriptions:
 * 1. createGroup() - Initialize SNS topic
 * 2. addAgent() - Create SQS queue + subscribe to SNS
 * 3. publish() - Publish message to SNS (fan-out to all agents)
 * 4. receive() - Poll messages from agent's SQS queue
 * 5. removeAgent() - Unsubscribe and delete SQS queue
 * 6. deleteGroup() - Delete SNS topic and all subscriptions
 */
export class GroupChat {
  private config: GroupChatConfig;
  private topicArn?: string;
  private subscriptions: Map<string, AgentSubscription>;
  private metrics: GroupChatMetrics;

  constructor(config: GroupChatConfig) {
    this.config = config;
    this.topicArn = config.topicArn;
    this.subscriptions = new Map();
    this.metrics = {
      messagesPublished: 0,
      messagesReceived: 0,
      activeSubscriptions: 0,
      failedDeliveries: 0,
      lastActivityAt: new Date().toISOString(),
    };
  }

  /**
   * Create SNS topic for group communication
   *
   * @returns SNS topic ARN
   */
  async createGroup(): Promise<string> {
    if (this.topicArn) {
      console.log(`[GroupChat] Topic already exists: ${this.topicArn}`);
      return this.topicArn;
    }

    const topicName = `chimera-groupchat-${this.config.tenantId}-${this.config.groupId}`;

    // TODO: Implement SNS topic creation
    // const sns = new SNSClient({ region: this.config.region ?? 'us-east-1' });
    // const response = await sns.send(new CreateTopicCommand({
    //   Name: topicName,
    //   Tags: [
    //     { Key: 'tenantId', Value: this.config.tenantId },
    //     { Key: 'groupId', Value: this.config.groupId },
    //     { Key: 'component', Value: 'groupchat' },
    //   ],
    // }));
    // this.topicArn = response.TopicArn;

    // Placeholder implementation
    this.topicArn = `arn:aws:sns:${this.config.region ?? 'us-east-1'}:123456789012:${topicName}`;

    console.log(`[GroupChat] Created topic: ${this.topicArn}`);

    return this.topicArn;
  }

  /**
   * Add agent to group (create SQS queue + subscribe to SNS)
   *
   * @param agentId - Agent identifier
   * @returns Agent subscription details
   */
  async addAgent(agentId: string): Promise<AgentSubscription> {
    if (this.subscriptions.has(agentId)) {
      const existing = this.subscriptions.get(agentId);
      if (!existing) {
        throw new Error(`Agent subscription not found: ${agentId}`);
      }
      console.log(`[GroupChat] Agent already subscribed: ${agentId}`);
      return existing;
    }

    if (!this.topicArn) {
      await this.createGroup();
    }

    const queueName = `chimera-groupchat-${this.config.tenantId}-${this.config.groupId}-${agentId}`;

    // TODO: Implement SQS queue creation
    // const sqs = new SQSClient({ region: this.config.region ?? 'us-east-1' });
    // const queueResponse = await sqs.send(new CreateQueueCommand({
    //   QueueName: queueName,
    //   Attributes: {
    //     MessageRetentionPeriod: String(this.config.messageRetentionSeconds ?? 345600), // 4 days
    //     VisibilityTimeout: String(this.config.visibilityTimeoutSeconds ?? 30),
    //     ReceiveMessageWaitTimeSeconds: '20', // Enable long polling
    //   },
    //   tags: {
    //     tenantId: this.config.tenantId,
    //     groupId: this.config.groupId,
    //     agentId,
    //   },
    // }));
    // const queueUrl = queueResponse.QueueUrl!;
    //
    // // Get queue ARN for SNS subscription
    // const attrsResponse = await sqs.send(new GetQueueAttributesCommand({
    //   QueueUrl: queueUrl,
    //   AttributeNames: ['QueueArn'],
    // }));
    // const queueArn = attrsResponse.Attributes!['QueueArn'];

    // Placeholder implementation
    const queueUrl = `https://sqs.${this.config.region ?? 'us-east-1'}.amazonaws.com/123456789012/${queueName}`;
    const queueArn = `arn:aws:sqs:${this.config.region ?? 'us-east-1'}:123456789012:${queueName}`;

    // TODO: Implement SNS subscription
    // const sns = new SNSClient({ region: this.config.region ?? 'us-east-1' });
    // const subscriptionResponse = await sns.send(new SubscribeCommand({
    //   TopicArn: this.topicArn,
    //   Protocol: 'sqs',
    //   Endpoint: queueArn,
    //   Attributes: {
    //     RawMessageDelivery: 'true', // Deliver SNS message body directly (not wrapped in SNS metadata)
    //     FilterPolicyScope: 'MessageAttributes',
    //   },
    // }));
    // const subscriptionArn = subscriptionResponse.SubscriptionArn!;

    // TODO: Set SQS queue policy to allow SNS to send messages
    // await sqs.send(new SetQueueAttributesCommand({
    //   QueueUrl: queueUrl,
    //   Attributes: {
    //     Policy: JSON.stringify({
    //       Version: '2012-10-17',
    //       Statement: [
    //         {
    //           Effect: 'Allow',
    //           Principal: { Service: 'sns.amazonaws.com' },
    //           Action: 'sqs:SendMessage',
    //           Resource: queueArn,
    //           Condition: {
    //             ArnEquals: { 'aws:SourceArn': this.topicArn },
    //           },
    //         },
    //       ],
    //     }),
    //   },
    // }));

    // Placeholder implementation
    const subscriptionArn = `arn:aws:sns:${this.config.region ?? 'us-east-1'}:123456789012:${this.config.groupId}:${agentId}`;

    const subscription: AgentSubscription = {
      agentId,
      queueUrl,
      queueArn,
      subscriptionArn,
      status: 'active',
    };

    this.subscriptions.set(agentId, subscription);
    this.metrics.activeSubscriptions = this.subscriptions.size;

    console.log(`[GroupChat] Agent subscribed: ${agentId} (queue: ${queueUrl})`);

    return subscription;
  }

  /**
   * Remove agent from group (unsubscribe + delete SQS queue)
   *
   * @param agentId - Agent identifier
   */
  async removeAgent(agentId: string): Promise<void> {
    const subscription = this.subscriptions.get(agentId);
    if (!subscription) {
      console.log(`[GroupChat] Agent not subscribed: ${agentId}`);
      return;
    }

    // TODO: Implement SNS unsubscribe
    // const sns = new SNSClient({ region: this.config.region ?? 'us-east-1' });
    // await sns.send(new UnsubscribeCommand({
    //   SubscriptionArn: subscription.subscriptionArn,
    // }));

    // TODO: Implement SQS queue deletion
    // const sqs = new SQSClient({ region: this.config.region ?? 'us-east-1' });
    // await sqs.send(new DeleteQueueCommand({
    //   QueueUrl: subscription.queueUrl,
    // }));

    subscription.status = 'deleted';
    this.subscriptions.delete(agentId);
    this.metrics.activeSubscriptions = this.subscriptions.size;

    console.log(`[GroupChat] Agent removed: ${agentId}`);
  }

  /**
   * Publish message to group (SNS fan-out to all agents)
   *
   * @param message - GroupChat message
   * @returns Message ID
   */
  async publish(message: GroupChatMessage): Promise<string> {
    if (!this.topicArn) {
      throw new Error('GroupChat not initialized. Call createGroup() first.');
    }

    // Validate message
    if (message.groupId !== this.config.groupId) {
      throw new Error(`Message groupId mismatch: expected ${this.config.groupId}, got ${message.groupId}`);
    }

    // TODO: Implement SNS publish
    // const sns = new SNSClient({ region: this.config.region ?? 'us-east-1' });
    // const response = await sns.send(new PublishCommand({
    //   TopicArn: this.topicArn,
    //   Message: JSON.stringify(message),
    //   MessageAttributes: {
    //     tenantId: {
    //       DataType: 'String',
    //       StringValue: message.tenantId,
    //     },
    //     groupId: {
    //       DataType: 'String',
    //       StringValue: message.groupId,
    //     },
    //     sourceAgentId: {
    //       DataType: 'String',
    //       StringValue: message.sourceAgentId,
    //     },
    //     messageType: {
    //       DataType: 'String',
    //       StringValue: message.type,
    //     },
    //     priority: {
    //       DataType: 'String',
    //       StringValue: message.priority,
    //     },
    //   },
    // }));
    // const messageId = response.MessageId!;

    // Placeholder implementation
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    this.metrics.messagesPublished++;
    this.metrics.lastActivityAt = new Date().toISOString();

    console.log(
      `[GroupChat] Published message: ${messageId} (from: ${message.sourceAgentId}, type: ${message.type})`
    );

    return messageId;
  }

  /**
   * Receive messages for specific agent (poll SQS queue)
   *
   * @param agentId - Agent identifier
   * @param maxMessages - Maximum messages to receive (1-10)
   * @returns Array of received messages
   */
  async receive(
    agentId: string,
    _options?: {
      maxMessages?: number;
      waitTimeSeconds?: number;
    }
  ): Promise<GroupChatMessage[]> {
    const subscription = this.subscriptions.get(agentId);
    if (!subscription) {
      throw new Error(`Agent not subscribed: ${agentId}`);
    }

    // TODO: Implement SQS receive
    // const sqs = new SQSClient({ region: this.config.region ?? 'us-east-1' });
    // const response = await sqs.send(new ReceiveMessageCommand({
    //   QueueUrl: subscription.queueUrl,
    //   MaxNumberOfMessages: options?.maxMessages ?? 10,
    //   WaitTimeSeconds: options?.waitTimeSeconds ?? 20, // Long polling
    //   MessageAttributeNames: ['All'],
    // }));
    //
    // const messages: GroupChatMessage[] = [];
    // for (const msg of response.Messages ?? []) {
    //   try {
    //     const parsed = JSON.parse(msg.Body!) as GroupChatMessage;
    //     messages.push(parsed);
    //
    //     // Delete message after successful processing
    //     await sqs.send(new DeleteMessageCommand({
    //       QueueUrl: subscription.queueUrl,
    //       ReceiptHandle: msg.ReceiptHandle!,
    //     }));
    //   } catch (error) {
    //     console.error(`[GroupChat] Failed to parse message: ${error}`);
    //     this.metrics.failedDeliveries++;
    //   }
    // }

    // Placeholder implementation
    const messages: GroupChatMessage[] = [];

    this.metrics.messagesReceived += messages.length;
    this.metrics.lastActivityAt = new Date().toISOString();

    console.log(`[GroupChat] Received ${messages.length} messages for agent: ${agentId}`);

    return messages;
  }

  /**
   * Delete group (SNS topic + all SQS subscriptions)
   */
  async deleteGroup(): Promise<void> {
    // Remove all agents
    for (const agentId of this.subscriptions.keys()) {
      await this.removeAgent(agentId);
    }

    if (!this.topicArn) {
      console.log('[GroupChat] No topic to delete');
      return;
    }

    // TODO: Implement SNS topic deletion
    // const sns = new SNSClient({ region: this.config.region ?? 'us-east-1' });
    // await sns.send(new DeleteTopicCommand({
    //   TopicArn: this.topicArn,
    // }));

    console.log(`[GroupChat] Deleted topic: ${this.topicArn}`);

    this.topicArn = undefined;
    this.metrics.activeSubscriptions = 0;
  }

  /**
   * Get current metrics
   */
  getMetrics(): GroupChatMetrics {
    return { ...this.metrics };
  }

  /**
   * Get active subscriptions
   */
  getSubscriptions(): AgentSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Check if agent is subscribed
   */
  isSubscribed(agentId: string): boolean {
    return this.subscriptions.has(agentId);
  }

  /**
   * Get topic ARN
   */
  getTopicArn(): string | undefined {
    return this.topicArn;
  }
}

/**
 * Create GroupChat instance
 *
 * @param config - GroupChat configuration
 * @returns GroupChat instance
 */
export function createGroupChat(config: GroupChatConfig): GroupChat {
  return new GroupChat(config);
}

/**
 * GroupChat message builder helpers
 */
export const GroupChatMessageBuilder = {
  /**
   * Build status update message
   */
  status: (
    groupId: string,
    tenantId: string,
    sourceAgentId: string,
    status: string,
    data?: Record<string, unknown>
  ): GroupChatMessage => ({
    messageId: `gchat-status-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'broadcast',
    sourceAgentId,
    tenantId,
    groupId,
    visibility: 'group',
    priority: 'normal',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'broadcast',
      topic: 'agent_status',
      message: status,
      data,
    },
  }),

  /**
   * Build question message
   */
  question: (
    groupId: string,
    tenantId: string,
    sourceAgentId: string,
    question: string,
    context?: Record<string, unknown>
  ): GroupChatMessage => ({
    messageId: `gchat-question-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'broadcast',
    sourceAgentId,
    tenantId,
    groupId,
    visibility: 'group',
    priority: 'high',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'broadcast',
      topic: 'agent_question',
      message: question,
      data: context,
    },
  }),

  /**
   * Build result message
   */
  result: (
    groupId: string,
    tenantId: string,
    sourceAgentId: string,
    result: string,
    data?: Record<string, unknown>
  ): GroupChatMessage => ({
    messageId: `gchat-result-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'broadcast',
    sourceAgentId,
    tenantId,
    groupId,
    visibility: 'group',
    priority: 'normal',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'broadcast',
      topic: 'agent_result',
      message: result,
      data,
    },
  }),

  /**
   * Build error message
   */
  error: (
    groupId: string,
    tenantId: string,
    sourceAgentId: string,
    error: string,
    errorCode?: string
  ): GroupChatMessage => ({
    messageId: `gchat-error-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'broadcast',
    sourceAgentId,
    tenantId,
    groupId,
    visibility: 'group',
    priority: 'urgent',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'broadcast',
      topic: 'agent_error',
      message: error,
      data: { errorCode },
    },
  }),

  /**
   * Build event notification message
   */
  event: (
    groupId: string,
    tenantId: string,
    sourceAgentId: string,
    eventType: string,
    eventData: Record<string, unknown>
  ): GroupChatMessage => ({
    messageId: `gchat-event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'event',
    sourceAgentId,
    tenantId,
    groupId,
    visibility: 'group',
    priority: 'low',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'event',
      eventType,
      eventData,
    },
  }),
};
