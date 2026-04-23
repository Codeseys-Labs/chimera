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
   *
   * NOT IMPLEMENTED — the SNS integration is a skeleton. Previous
   * versions returned a fabricated ARN containing the placeholder
   * account ID `123456789012`, which silently produced invalid ARNs
   * in reachable code paths. See Wave-14 audit finding M1.
   */
  async createGroup(): Promise<string> {
    throw new Error(
      'not implemented: GroupChat.createGroup — SNS integration is a skeleton (Wave-14 audit M1/M2)'
    );
  }

  /**
   * Add agent to group (create SQS queue + subscribe to SNS)
   *
   * @param agentId - Agent identifier
   * @returns Agent subscription details
   *
   * NOT IMPLEMENTED — see {@link createGroup}.
   */
  async addAgent(_agentId: string): Promise<AgentSubscription> {
    throw new Error(
      'not implemented: GroupChat.addAgent — SQS subscription is a skeleton (Wave-14 audit M1/M2)'
    );
  }

  /**
   * Remove agent from group (unsubscribe + delete SQS queue)
   *
   * @param agentId - Agent identifier
   *
   * NOT IMPLEMENTED — see {@link createGroup}.
   */
  async removeAgent(_agentId: string): Promise<void> {
    throw new Error(
      'not implemented: GroupChat.removeAgent — SNS/SQS teardown is a skeleton (Wave-14 audit M1/M2)'
    );
  }

  /**
   * Publish message to group (SNS fan-out to all agents)
   *
   * @param message - GroupChat message
   * @returns Message ID
   *
   * NOT IMPLEMENTED — see {@link createGroup}.
   */
  async publish(_message: GroupChatMessage): Promise<string> {
    throw new Error(
      'not implemented: GroupChat.publish — SNS publish is a skeleton (Wave-14 audit M1/M2)'
    );
  }

  /**
   * Receive messages for specific agent (poll SQS queue)
   *
   * @param agentId - Agent identifier
   * @param _options - Poll options
   * @returns Array of received messages
   *
   * NOT IMPLEMENTED — see {@link createGroup}.
   */
  async receive(
    _agentId: string,
    _options?: {
      maxMessages?: number;
      waitTimeSeconds?: number;
    }
  ): Promise<GroupChatMessage[]> {
    throw new Error(
      'not implemented: GroupChat.receive — SQS polling is a skeleton (Wave-14 audit M1/M2)'
    );
  }

  /**
   * Delete group (SNS topic + all SQS subscriptions)
   *
   * NOT IMPLEMENTED — see {@link createGroup}.
   */
  async deleteGroup(): Promise<void> {
    throw new Error(
      'not implemented: GroupChat.deleteGroup — SNS topic teardown is a skeleton (Wave-14 audit M1/M2)'
    );
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
