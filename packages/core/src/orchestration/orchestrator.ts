/**
 * Multi-Agent Orchestrator
 *
 * Coordinates agent spawning, monitoring, and event distribution using:
 * - EventBridge as central nervous system for agent events
 * - SQS queues for reliable agent-to-agent task delegation
 * - DynamoDB for agent state tracking
 *
 * Architecture Pattern: Agent Broker (from research docs)
 * - Centralized message distribution
 * - No workflow control (agents self-coordinate)
 * - Rule-based event routing
 */

import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  DeleteQueueCommand,
  QueueAttributeName,
} from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';

import type {
  ISOTimestamp,
} from './types';

// ---------------------------------------------------------------------------
// Narrow client interfaces — plain objects can implement these for testing
// ---------------------------------------------------------------------------

/**
 * SQS operations used by the orchestrator
 */
export interface OrchestratorSQSClient {
  createQueue(input: {
    QueueName: string;
    Attributes?: Record<string, string>;
    Tags?: Record<string, string>;
  }): Promise<{ QueueUrl?: string }>;

  getQueueAttributes(input: {
    QueueUrl: string;
    AttributeNames: string[];
  }): Promise<{ Attributes?: Record<string, string> }>;

  sendMessage(input: {
    QueueUrl: string;
    MessageBody: string;
    MessageAttributes?: Record<string, { DataType: string; StringValue?: string }>;
  }): Promise<{ MessageId?: string }>;

  deleteQueue(input: { QueueUrl: string }): Promise<unknown>;
}

/**
 * DynamoDB operations used by the orchestrator
 */
export interface OrchestratorDDBClient {
  put(input: { TableName: string; Item: Record<string, unknown> }): Promise<unknown>;
  update(input: {
    TableName: string;
    Key: Record<string, unknown>;
    UpdateExpression: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * EventBridge operations used by the orchestrator
 */
export interface OrchestratorEventBridgeClient {
  putEvents(input: {
    Entries: Array<{
      Source: string;
      DetailType: string;
      Detail: string;
      EventBusName: string;
    }>;
  }): Promise<{ FailedEntryCount?: number }>;
}

// ---------------------------------------------------------------------------
// Module-level singleton client factories (per region, reuse connections)
// ---------------------------------------------------------------------------

const sqsClientCache = new Map<string, SQSClient>();
const ddbClientCache = new Map<string, DynamoDBDocumentClient>();
const ebClientCache = new Map<string, EventBridgeClient>();

function buildSQSClient(region: string): OrchestratorSQSClient {
  if (!sqsClientCache.has(region)) {
    sqsClientCache.set(region, new SQSClient({ region }));
  }
  const raw = sqsClientCache.get(region)!;
  return {
    createQueue: (input) =>
      raw.send(new CreateQueueCommand({
        QueueName: input.QueueName,
        Attributes: input.Attributes,
        tags: input.Tags,
      })),
    getQueueAttributes: (input) =>
      raw.send(new GetQueueAttributesCommand({
        QueueUrl: input.QueueUrl,
        AttributeNames: input.AttributeNames as QueueAttributeName[],
      })),
    sendMessage: (input) =>
      raw.send(new SendMessageCommand({
        QueueUrl: input.QueueUrl,
        MessageBody: input.MessageBody,
        MessageAttributes: input.MessageAttributes as any,
      })),
    deleteQueue: (input) =>
      raw.send(new DeleteQueueCommand({ QueueUrl: input.QueueUrl })),
  };
}

function buildDDBClient(region: string): OrchestratorDDBClient {
  if (!ddbClientCache.has(region)) {
    ddbClientCache.set(
      region,
      DynamoDBDocumentClient.from(new DynamoDBClient({ region }))
    );
  }
  const raw = ddbClientCache.get(region)!;
  return {
    put: (input) => raw.send(new PutCommand(input)),
    update: (input) => raw.send(new UpdateCommand(input)),
  };
}

function buildEventBridgeClient(region: string): OrchestratorEventBridgeClient {
  if (!ebClientCache.has(region)) {
    ebClientCache.set(region, new EventBridgeClient({ region }));
  }
  const raw = ebClientCache.get(region)!;
  return {
    putEvents: (input) => raw.send(new PutEventsCommand(input)),
  };
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Agent lifecycle status
 */
export type AgentStatus =
  | 'initializing'  // Agent runtime starting
  | 'ready'         // Idle, waiting for tasks
  | 'processing'    // Actively working on task
  | 'blocked'       // Waiting on external dependency
  | 'terminating'   // Shutting down
  | 'failed';       // Error state

/**
 * Agent role in orchestration
 */
export type AgentRole =
  | 'coordinator'   // Orchestrates other agents
  | 'worker'        // Processes delegated tasks
  | 'specialist'    // Domain-specific expert
  | 'monitor';      // Observability/health checks

/**
 * Event types published to EventBridge
 */
export type AgentEventType =
  | 'agent.spawned'
  | 'agent.ready'
  | 'agent.task.started'
  | 'agent.task.progress'
  | 'agent.task.completed'
  | 'agent.task.failed'
  | 'agent.terminated'
  | 'agent.health.degraded'
  | 'agent.health.recovered';

/**
 * Agent spawn configuration
 */
export interface SpawnAgentConfig {
  tenantId: string;
  agentId: string;
  role: AgentRole;
  capabilities: string[];
  modelId?: string;
  memoryStrategy?: 'SUMMARY' | 'USER_PREFERENCE' | 'BOTH';
  maxConcurrentTasks?: number;
  timeoutSeconds?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Agent runtime metadata
 */
export interface AgentRuntimeMetadata {
  agentId: string;
  tenantId: string;
  status: AgentStatus;
  role: AgentRole;
  capabilities: string[];
  runtimeArn: string;
  queueUrl: string;
  spawnedAt: ISOTimestamp;
  lastHeartbeat: ISOTimestamp;
  taskCount: number;
  failureCount: number;
  metadata: Record<string, unknown>;
}

/**
 * Task delegation request sent via SQS
 */
export interface TaskDelegation {
  taskId: string;
  sourceAgentId: string;
  targetAgentId: string;
  tenantId: string;
  instruction: string;
  context: Record<string, unknown>;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  timeoutSeconds?: number;
  callbackQueueUrl?: string; // For async response
  correlationId?: string;    // For request-response pattern
}

/**
 * Agent event published to EventBridge
 */
export interface AgentEvent {
  eventType: AgentEventType;
  agentId: string;
  tenantId: string;
  timestamp: ISOTimestamp;
  details: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Orchestrator configuration
 */
export interface OrchestratorConfig {
  region: string;
  eventBusName: string;
  agentTableName: string;
  defaultQueuePrefix: string;
  dlqRetentionDays?: number;
  maxConcurrentAgents?: number;
  /** Injectable clients for testing — defaults to real AWS SDK singletons */
  clients?: {
    sqs?: OrchestratorSQSClient;
    dynamodb?: OrchestratorDDBClient;
    eventBridge?: OrchestratorEventBridgeClient;
  };
}

/**
 * Multi-Agent Orchestrator
 *
 * Manages agent lifecycle and event-driven coordination:
 * 1. Spawns agents with dedicated SQS queues
 * 2. Publishes lifecycle events to EventBridge
 * 3. Routes tasks between agents via queues
 * 4. Monitors agent health via heartbeats
 */
export class AgentOrchestrator {
  private config: OrchestratorConfig;
  private activeAgents: Map<string, AgentRuntimeMetadata>;
  private sqs: OrchestratorSQSClient;
  private ddb: OrchestratorDDBClient;
  private eb: OrchestratorEventBridgeClient;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.activeAgents = new Map();
    this.sqs = config.clients?.sqs ?? buildSQSClient(config.region);
    this.ddb = config.clients?.dynamodb ?? buildDDBClient(config.region);
    this.eb = config.clients?.eventBridge ?? buildEventBridgeClient(config.region);
  }

  /**
   * Spawn a new agent with dedicated resources
   *
   * Creates:
   * - AgentCore Runtime (serverless MicroVM)
   * - SQS queue for task delegation
   * - DLQ for failed tasks
   * - EventBridge rule for agent events
   *
   * @param config - Agent spawn configuration
   * @returns Agent runtime metadata
   */
  async spawnAgent(config: SpawnAgentConfig): Promise<AgentRuntimeMetadata> {
    const agentKey = `${config.tenantId}:${config.agentId}`;

    // Check concurrency limit
    if (this.activeAgents.size >= (this.config.maxConcurrentAgents || 100)) {
      throw new Error('Max concurrent agents reached');
    }

    // Create AgentCore Runtime (stub — AgentCore SDK integration pending)
    const runtimeArn = await this.createAgentRuntime(config);

    // Create dedicated SQS queue with DLQ
    const queueUrl = await this.createAgentQueue(config);

    // Create agent metadata
    const metadata: AgentRuntimeMetadata = {
      agentId: config.agentId,
      tenantId: config.tenantId,
      status: 'initializing',
      role: config.role,
      capabilities: config.capabilities,
      runtimeArn,
      queueUrl,
      spawnedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      taskCount: 0,
      failureCount: 0,
      metadata: config.metadata || {}
    };

    // Store in memory registry
    this.activeAgents.set(agentKey, metadata);

    // Persist agent state to DynamoDB
    await this.ddb.put({
      TableName: this.config.agentTableName,
      Item: {
        PK: `AGENT#${config.tenantId}`,
        SK: `AGENT#${config.agentId}`,
        ...metadata,
      },
    });

    // Publish spawn event to EventBridge
    await this.publishEvent({
      eventType: 'agent.spawned',
      agentId: config.agentId,
      tenantId: config.tenantId,
      timestamp: new Date().toISOString(),
      details: {
        role: config.role,
        capabilities: config.capabilities,
        runtimeArn,
        queueUrl
      }
    });

    return metadata;
  }

  /**
   * Delegate task to another agent via SQS
   *
   * Implements async request-response pattern:
   * - Sender publishes to target agent's queue
   * - Target processes and optionally calls back
   *
   * @param delegation - Task delegation request
   */
  async delegateTask(delegation: TaskDelegation): Promise<void> {
    const targetAgent = this.activeAgents.get(
      `${delegation.tenantId}:${delegation.targetAgentId}`
    );

    if (!targetAgent) {
      throw new Error(`Agent not found: ${delegation.targetAgentId}`);
    }

    if (targetAgent.status === 'failed' || targetAgent.status === 'terminating') {
      throw new Error(`Agent unavailable: ${delegation.targetAgentId}`);
    }

    // Send delegation as JSON message to target agent's SQS queue
    await this.sqs.sendMessage({
      QueueUrl: targetAgent.queueUrl,
      MessageBody: JSON.stringify(delegation),
      MessageAttributes: {
        taskId:     { DataType: 'String', StringValue: delegation.taskId },
        priority:   { DataType: 'String', StringValue: delegation.priority ?? 'normal' },
        sourceAgent:{ DataType: 'String', StringValue: delegation.sourceAgentId },
      },
    });

    // Publish task delegation event
    await this.publishEvent({
      eventType: 'agent.task.started',
      agentId: delegation.targetAgentId,
      tenantId: delegation.tenantId,
      timestamp: new Date().toISOString(),
      details: {
        taskId: delegation.taskId,
        sourceAgentId: delegation.sourceAgentId,
        priority: delegation.priority || 'normal'
      }
    });
  }

  /**
   * Terminate agent and clean up resources
   *
   * @param tenantId - Tenant ID
   * @param agentId - Agent ID
   */
  async terminateAgent(tenantId: string, agentId: string): Promise<void> {
    const agentKey = `${tenantId}:${agentId}`;
    const agent = this.activeAgents.get(agentKey);

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Update status
    agent.status = 'terminating';

    // AgentCore Runtime termination stub (AgentCore SDK integration pending)

    // Delete the agent's SQS queue
    await this.sqs.deleteQueue({ QueueUrl: agent.queueUrl });

    // Remove from active registry
    this.activeAgents.delete(agentKey);

    // Publish termination event
    await this.publishEvent({
      eventType: 'agent.terminated',
      agentId,
      tenantId,
      timestamp: new Date().toISOString(),
      details: {
        taskCount: agent.taskCount,
        failureCount: agent.failureCount,
        uptime: Date.now() - new Date(agent.spawnedAt).getTime()
      }
    });
  }

  /**
   * Update agent heartbeat (called by agent periodically)
   *
   * @param tenantId - Tenant ID
   * @param agentId - Agent ID
   * @param status - Current agent status
   */
  async updateHeartbeat(
    tenantId: string,
    agentId: string,
    status: AgentStatus
  ): Promise<void> {
    const agentKey = `${tenantId}:${agentId}`;
    const agent = this.activeAgents.get(agentKey);

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const now = new Date().toISOString();
    agent.lastHeartbeat = now;
    agent.status = status;

    // Persist heartbeat and status update to DynamoDB
    await this.ddb.update({
      TableName: this.config.agentTableName,
      Key: { PK: `AGENT#${tenantId}`, SK: `AGENT#${agentId}` },
      UpdateExpression: 'SET lastHeartbeat = :hb, #s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':hb': now, ':status': status },
    });
  }

  /**
   * List active agents for a tenant
   *
   * @param tenantId - Tenant ID
   * @param filters - Optional filters (role, status, capability)
   * @returns Array of agent metadata
   */
  listAgents(
    tenantId: string,
    filters?: {
      role?: AgentRole;
      status?: AgentStatus;
      capability?: string;
    }
  ): AgentRuntimeMetadata[] {
    let agents = Array.from(this.activeAgents.values())
      .filter(a => a.tenantId === tenantId);

    if (filters?.role) {
      agents = agents.filter(a => a.role === filters.role);
    }

    if (filters?.status) {
      agents = agents.filter(a => a.status === filters.status);
    }

    if (filters?.capability) {
      agents = agents.filter(a =>
        a.capabilities.includes(filters.capability!)
      );
    }

    return agents;
  }

  /**
   * Publish event to EventBridge
   *
   * Events are routed to interested consumers via EventBridge rules.
   * Examples:
   * - agent.task.failed → Alerting service
   * - agent.spawned → Monitoring dashboard
   * - agent.task.completed → Coordinator agent
   *
   * @param event - Agent event
   */
  private async publishEvent(event: AgentEvent): Promise<void> {
    await this.eb.putEvents({
      Entries: [{
        Source: 'chimera.agent',
        DetailType: event.eventType,
        Detail: JSON.stringify(event),
        EventBusName: this.config.eventBusName,
      }],
    });
  }

  /**
   * Create AgentCore Runtime for agent
   *
   * NOT IMPLEMENTED — AgentCore SDK integration is pending. The previous
   * implementation returned a fabricated ARN containing the placeholder
   * AWS account ID `123456789012`, producing garbage ARNs in every
   * `spawnAgent` call. Because `spawnAgent` is the sole caller, throwing
   * here effectively gates the entire `spawnAgent` path until AgentCore
   * integration lands. See Wave-14 audit finding M1.
   */
  private async createAgentRuntime(
    _config: SpawnAgentConfig
  ): Promise<string> {
    throw new Error(
      'not implemented: AgentOrchestrator.createAgentRuntime — AgentCore SDK integration is pending (Wave-14 audit M1)'
    );
  }

  /**
   * Create dedicated SQS queue with DLQ for agent task delegation
   *
   * Queue naming: {prefix}-{tenantId}-{agentId}
   * DLQ naming:   {prefix}-{tenantId}-{agentId}-dlq
   */
  private async createAgentQueue(
    config: SpawnAgentConfig
  ): Promise<string> {
    const base    = `${this.config.defaultQueuePrefix}-${config.tenantId}-${config.agentId}`;
    const dlqName = `${base}-dlq`;

    // 1. Create DLQ
    const dlqResult = await this.sqs.createQueue({
      QueueName: dlqName,
      Attributes: {
        MessageRetentionPeriod: String((this.config.dlqRetentionDays ?? 14) * 86400),
      },
      Tags: { tenantId: config.tenantId, agentId: config.agentId },
    });

    if (!dlqResult.QueueUrl) {
      throw new Error(`Failed to create DLQ for agent ${config.agentId}`);
    }

    // 2. Resolve DLQ ARN (required for RedrivePolicy)
    const dlqAttrs = await this.sqs.getQueueAttributes({
      QueueUrl: dlqResult.QueueUrl,
      AttributeNames: ['QueueArn'],
    });

    const dlqArn = dlqAttrs.Attributes?.['QueueArn'];
    if (!dlqArn) {
      throw new Error(`Failed to get DLQ ARN for agent ${config.agentId}`);
    }

    // 3. Create main queue with DLQ redrive policy
    const queueResult = await this.sqs.createQueue({
      QueueName: base,
      Attributes: {
        VisibilityTimeout: String(config.timeoutSeconds ?? 300),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: 3,
        }),
      },
      Tags: { tenantId: config.tenantId, agentId: config.agentId },
    });

    if (!queueResult.QueueUrl) {
      throw new Error(`Failed to create queue for agent ${config.agentId}`);
    }

    return queueResult.QueueUrl;
  }
}

/**
 * Create orchestrator instance with default config
 */
export function createOrchestrator(
  config: Partial<OrchestratorConfig> = {}
): AgentOrchestrator {
  const defaultConfig: OrchestratorConfig = {
    region: process.env.AWS_REGION || 'us-east-1',
    eventBusName: 'chimera-agent-events',
    agentTableName: 'chimera-agents',
    defaultQueuePrefix: 'chimera-agent',
    dlqRetentionDays: 14,
    maxConcurrentAgents: 100,
    ...config
  };

  return new AgentOrchestrator(defaultConfig);
}
