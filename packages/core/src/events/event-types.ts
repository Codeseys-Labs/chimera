/**
 * EventBridge Event Types for Chimera Agent Orchestration
 *
 * Defines TypeScript types for all EventBridge events in the multi-agent platform.
 * Events support:
 * - Agent lifecycle management
 * - Task orchestration and delegation
 * - Multi-agent coordination (swarm, graph, hierarchical)
 * - Cron scheduling
 * - Cross-framework agent communication (A2A protocol)
 */

/**
 * Base EventBridge event structure
 * All Chimera events extend this base interface
 */
export interface ChimeraEvent<TDetail = unknown> {
  /** Event version (always "0" for EventBridge) */
  version: '0';

  /** Unique event identifier */
  id: string;

  /** Event type identifier (e.g., "Agent Task Completed") */
  'detail-type': string;

  /** Event source namespace (e.g., "chimera.agents") */
  source: string;

  /** AWS account ID */
  account: string;

  /** ISO 8601 timestamp */
  time: string;

  /** AWS region */
  region: string;

  /** Resource ARNs associated with this event */
  resources: string[];

  /** Event-specific payload */
  detail: TDetail;
}

/**
 * Event source namespaces
 */
export enum EventSource {
  /** Agent lifecycle events */
  AGENTS = 'chimera.agents',

  /** Task orchestration events */
  TASKS = 'chimera.tasks',

  /** Multi-agent coordination events */
  COORDINATION = 'chimera.coordination',

  /** Cron scheduling events */
  CRON = 'chimera.cron',

  /** Agent-to-agent protocol events */
  A2A = 'chimera.a2a',

  /** System-level events */
  SYSTEM = 'chimera.system',
}

/**
 * Event detail type identifiers
 */
export enum EventDetailType {
  // Agent lifecycle
  AGENT_CREATED = 'Agent Created',
  AGENT_STARTED = 'Agent Started',
  AGENT_COMPLETED = 'Agent Completed',
  AGENT_FAILED = 'Agent Failed',
  AGENT_CANCELLED = 'Agent Cancelled',

  // Task lifecycle
  TASK_CREATED = 'Task Created',
  TASK_ASSIGNED = 'Task Assigned',
  TASK_RUNNING = 'Task Running',
  TASK_COMPLETED = 'Task Completed',
  TASK_FAILED = 'Task Failed',
  TASK_CANCELLED = 'Task Cancelled',

  // Agent coordination
  AGENT_DELEGATION = 'Agent Delegation',
  AGENT_ARTIFACT_EXCHANGE = 'Agent Artifact Exchange',
  SWARM_COORDINATION = 'Swarm Coordination',
  GRAPH_WORKFLOW = 'Graph Workflow',

  // Cron scheduling
  CRON_SCHEDULED = 'Cron Scheduled',
  CRON_TRIGGERED = 'Cron Triggered',
  CRON_COMPLETED = 'Cron Completed',

  // A2A protocol events
  A2A_TASK_CREATED = 'A2A Task Created',
  A2A_TASK_COMPLETED = 'A2A Task Completed',
  A2A_AGENT_DISCOVERED = 'A2A Agent Discovered',

  // System events
  SYSTEM_ERROR = 'System Error',
  SYSTEM_MAINTENANCE = 'System Maintenance',
}

/**
 * Agent execution status
 */
export enum AgentStatus {
  CREATED = 'created',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Task execution status
 */
export enum TaskStatus {
  CREATED = 'created',
  ASSIGNED = 'assigned',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

// ============================================================================
// Agent Lifecycle Events
// ============================================================================

/**
 * Base detail for agent lifecycle events
 */
export interface BaseAgentDetail {
  /** Tenant identifier for multi-tenant isolation */
  tenantId: string;

  /** Agent identifier */
  agentId: string;

  /** Agent name */
  agentName: string;

  /** Agent framework (strands, openai, langgraph, google-adk, etc.) */
  framework: string;

  /** Session identifier */
  sessionId?: string;

  /** User identifier */
  userId?: string;

  /** Correlation ID for tracing */
  correlationId?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Agent Created event detail
 */
export interface AgentCreatedDetail extends BaseAgentDetail {
  /** Agent configuration */
  config: {
    model?: string;
    systemPrompt?: string;
    tools?: string[];
    skills?: string[];
  };

  /** Timestamp when agent was created */
  createdAt: string;
}

/**
 * Agent Started event detail
 */
export interface AgentStartedDetail extends BaseAgentDetail {
  /** Initial instruction/prompt */
  instruction: string;

  /** Timestamp when agent started */
  startedAt: string;
}

/**
 * Agent Completed event detail
 */
export interface AgentCompletedDetail extends BaseAgentDetail {
  /** Agent execution status */
  status: AgentStatus.COMPLETED;

  /** Agent output/response */
  output: string;

  /** Execution duration in milliseconds */
  durationMs: number;

  /** Tool calls made during execution */
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    output?: unknown;
  }>;

  /** Timestamp when agent completed */
  completedAt: string;
}

/**
 * Agent Failed event detail
 */
export interface AgentFailedDetail extends BaseAgentDetail {
  /** Agent execution status */
  status: AgentStatus.FAILED;

  /** Error message */
  error: string;

  /** Error code */
  errorCode?: string;

  /** Stack trace (if available) */
  stackTrace?: string;

  /** Execution duration before failure */
  durationMs?: number;

  /** Timestamp when agent failed */
  failedAt: string;
}

/**
 * Agent Cancelled event detail
 */
export interface AgentCancelledDetail extends BaseAgentDetail {
  /** Agent execution status */
  status: AgentStatus.CANCELLED;

  /** Cancellation reason */
  reason: string;

  /** Timestamp when agent was cancelled */
  cancelledAt: string;
}

// ============================================================================
// Task Lifecycle Events
// ============================================================================

/**
 * Base detail for task lifecycle events
 */
export interface BaseTaskDetail {
  /** Tenant identifier */
  tenantId: string;

  /** Task identifier */
  taskId: string;

  /** Agent assigned to this task */
  agentId?: string;

  /** Parent task ID (for subtasks) */
  parentTaskId?: string;

  /** Task priority (1=highest, 5=lowest) */
  priority?: number;

  /** Correlation ID for tracing */
  correlationId?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Task Created event detail
 */
export interface TaskCreatedDetail extends BaseTaskDetail {
  /** Task instruction */
  instruction: string;

  /** Task context */
  context?: Record<string, unknown>;

  /** Timestamp when task was created */
  createdAt: string;
}

/**
 * Task Assigned event detail
 */
export interface TaskAssignedDetail extends BaseTaskDetail {
  /** Agent assigned to task */
  agentId: string;

  /** Timestamp when task was assigned */
  assignedAt: string;
}

/**
 * Task Running event detail
 */
export interface TaskRunningDetail extends BaseTaskDetail {
  /** Agent executing task */
  agentId: string;

  /** Task status */
  status: TaskStatus.RUNNING;

  /** Progress percentage (0-100) */
  progress?: number;

  /** Current step/phase */
  currentStep?: string;

  /** Timestamp when task started running */
  startedAt: string;
}

/**
 * Task Completed event detail
 */
export interface TaskCompletedDetail extends BaseTaskDetail {
  /** Agent that completed task */
  agentId: string;

  /** Task status */
  status: TaskStatus.COMPLETED;

  /** Task result/artifact */
  result: {
    /** Artifact type (text, json, image, etc.) */
    type: string;

    /** Artifact content */
    content: unknown;

    /** S3 URL if artifact is large */
    s3Url?: string;
  };

  /** Execution duration in milliseconds */
  durationMs: number;

  /** Timestamp when task completed */
  completedAt: string;
}

/**
 * Task Failed event detail
 */
export interface TaskFailedDetail extends BaseTaskDetail {
  /** Agent that attempted task */
  agentId?: string;

  /** Task status */
  status: TaskStatus.FAILED;

  /** Error message */
  error: string;

  /** Error code */
  errorCode?: string;

  /** Retry count */
  retryCount?: number;

  /** Execution duration before failure */
  durationMs?: number;

  /** Timestamp when task failed */
  failedAt: string;
}

/**
 * Task Cancelled event detail
 */
export interface TaskCancelledDetail extends BaseTaskDetail {
  /** Task status */
  status: TaskStatus.CANCELLED;

  /** Cancellation reason */
  reason: string;

  /** Timestamp when task was cancelled */
  cancelledAt: string;
}

// ============================================================================
// Multi-Agent Coordination Events
// ============================================================================

/**
 * Agent Delegation event detail
 * Fired when an agent delegates a task to another agent
 */
export interface AgentDelegationDetail {
  /** Tenant identifier */
  tenantId: string;

  /** Source agent (delegating) */
  sourceAgentId: string;

  /** Target agent (receiving delegation) */
  targetAgentId: string;

  /** Task being delegated */
  taskId: string;

  /** Delegation instruction */
  instruction: string;

  /** Delegation context */
  context?: Record<string, unknown>;

  /** Delegation mode (sync or async) */
  mode: 'sync' | 'async';

  /** Callback URL (for async delegations) */
  callbackUrl?: string;

  /** Timestamp */
  delegatedAt: string;
}

/**
 * Agent Artifact Exchange event detail
 * Fired when agents exchange artifacts
 */
export interface AgentArtifactExchangeDetail {
  /** Tenant identifier */
  tenantId: string;

  /** Source agent */
  sourceAgentId: string;

  /** Target agent */
  targetAgentId: string;

  /** Task associated with artifact */
  taskId: string;

  /** Artifact details */
  artifact: {
    /** Artifact type */
    type: string;

    /** Artifact format (json, text, binary, etc.) */
    format: string;

    /** Artifact content (or S3 URL if large) */
    content?: unknown;

    /** S3 URL for large artifacts */
    s3Url?: string;

    /** Artifact size in bytes */
    sizeBytes?: number;
  };

  /** Timestamp */
  exchangedAt: string;
}

/**
 * Swarm Coordination event detail
 * Fired for dynamic agent pool coordination
 */
export interface SwarmCoordinationDetail {
  /** Tenant identifier */
  tenantId: string;

  /** Swarm identifier */
  swarmId: string;

  /** Coordination action */
  action: 'spawn' | 'scale' | 'terminate' | 'rebalance';

  /** Agent IDs in swarm */
  agentIds: string[];

  /** Swarm size */
  size: number;

  /** Target size (for scaling) */
  targetSize?: number;

  /** Workload metrics */
  workload?: {
    queueDepth: number;
    activeAgents: number;
    avgTaskDuration: number;
  };

  /** Timestamp */
  coordinatedAt: string;
}

/**
 * Graph Workflow event detail
 * Fired for DAG-based multi-agent workflows
 */
export interface GraphWorkflowDetail {
  /** Tenant identifier */
  tenantId: string;

  /** Workflow identifier */
  workflowId: string;

  /** Workflow action */
  action: 'started' | 'node_completed' | 'edge_traversed' | 'completed' | 'failed';

  /** Current node/agent */
  currentNode?: string;

  /** Next nodes to execute */
  nextNodes?: string[];

  /** Workflow progress */
  progress?: {
    totalNodes: number;
    completedNodes: number;
    failedNodes: number;
  };

  /** Timestamp */
  timestamp: string;
}

// ============================================================================
// Cron Scheduling Events
// ============================================================================

/**
 * Cron Scheduled event detail
 */
export interface CronScheduledDetail {
  /** Tenant identifier */
  tenantId: string;

  /** Cron job identifier */
  cronJobId: string;

  /** Agent to execute */
  agentId: string;

  /** Cron expression */
  cronExpression: string;

  /** Job instruction */
  instruction: string;

  /** Next execution time */
  nextExecutionTime: string;

  /** Timestamp */
  scheduledAt: string;
}

/**
 * Cron Triggered event detail
 */
export interface CronTriggeredDetail {
  /** Tenant identifier */
  tenantId: string;

  /** Cron job identifier */
  cronJobId: string;

  /** Agent executing */
  agentId: string;

  /** Scheduled execution time */
  scheduledTime: string;

  /** Actual trigger time */
  triggeredAt: string;
}

/**
 * Cron Completed event detail
 */
export interface CronCompletedDetail {
  /** Tenant identifier */
  tenantId: string;

  /** Cron job identifier */
  cronJobId: string;

  /** Agent that executed */
  agentId: string;

  /** Execution status */
  status: 'completed' | 'failed';

  /** Execution duration */
  durationMs: number;

  /** Error (if failed) */
  error?: string;

  /** Next execution time */
  nextExecutionTime?: string;

  /** Timestamp */
  completedAt: string;
}

// ============================================================================
// A2A Protocol Events
// ============================================================================

/**
 * A2A Task Created event detail
 * Fired when an A2A task is created on a remote agent
 */
export interface A2ATaskCreatedDetail {
  /** Tenant identifier */
  tenantId: string;

  /** A2A task identifier */
  taskId: string;

  /** Client agent (requester) */
  clientAgentId: string;

  /** Server agent (executor) */
  serverAgentId: string;

  /** Task instruction */
  instruction: string;

  /** Task context */
  context?: Record<string, unknown>;

  /** A2A protocol version */
  protocolVersion: string;

  /** Timestamp */
  createdAt: string;
}

/**
 * A2A Task Completed event detail
 */
export interface A2ATaskCompletedDetail {
  /** Tenant identifier */
  tenantId: string;

  /** A2A task identifier */
  taskId: string;

  /** Client agent */
  clientAgentId: string;

  /** Server agent */
  serverAgentId: string;

  /** Task status */
  status: 'completed' | 'failed';

  /** Artifact (if completed) */
  artifact?: {
    type: string;
    content: unknown;
  };

  /** Error (if failed) */
  error?: string;

  /** Execution duration */
  durationMs: number;

  /** Timestamp */
  completedAt: string;
}

/**
 * A2A Agent Discovered event detail
 * Fired when an agent discovers another agent via agent card
 */
export interface A2AAgentDiscoveredDetail {
  /** Tenant identifier */
  tenantId: string;

  /** Discovering agent */
  discovererAgentId: string;

  /** Discovered agent */
  discoveredAgentId: string;

  /** Agent card details */
  agentCard: {
    name: string;
    description: string;
    version: string;
    capabilities: string[];
    endpoints: {
      agentCard: string;
      tasks: string;
      streaming?: string;
    };
  };

  /** Timestamp */
  discoveredAt: string;
}

// ============================================================================
// System Events
// ============================================================================

/**
 * System Error event detail
 */
export interface SystemErrorDetail {
  /** Tenant identifier (if applicable) */
  tenantId?: string;

  /** Error severity */
  severity: 'low' | 'medium' | 'high' | 'critical';

  /** Error message */
  error: string;

  /** Error code */
  errorCode?: string;

  /** Stack trace */
  stackTrace?: string;

  /** Component that generated error */
  component: string;

  /** Timestamp */
  timestamp: string;
}

/**
 * System Maintenance event detail
 */
export interface SystemMaintenanceDetail {
  /** Maintenance action */
  action: 'scheduled' | 'started' | 'completed';

  /** Maintenance type */
  type: 'upgrade' | 'patch' | 'configuration' | 'scaling';

  /** Affected components */
  components: string[];

  /** Scheduled time (for 'scheduled' action) */
  scheduledTime?: string;

  /** Duration estimate */
  estimatedDurationMs?: number;

  /** Timestamp */
  timestamp: string;
}

// ============================================================================
// Event Type Unions
// ============================================================================

/**
 * All agent lifecycle event details
 */
export type AgentEventDetail =
  | AgentCreatedDetail
  | AgentStartedDetail
  | AgentCompletedDetail
  | AgentFailedDetail
  | AgentCancelledDetail;

/**
 * All task lifecycle event details
 */
export type TaskEventDetail =
  | TaskCreatedDetail
  | TaskAssignedDetail
  | TaskRunningDetail
  | TaskCompletedDetail
  | TaskFailedDetail
  | TaskCancelledDetail;

/**
 * All coordination event details
 */
export type CoordinationEventDetail =
  | AgentDelegationDetail
  | AgentArtifactExchangeDetail
  | SwarmCoordinationDetail
  | GraphWorkflowDetail;

/**
 * All cron event details
 */
export type CronEventDetail =
  | CronScheduledDetail
  | CronTriggeredDetail
  | CronCompletedDetail;

/**
 * All A2A event details
 */
export type A2AEventDetail =
  | A2ATaskCreatedDetail
  | A2ATaskCompletedDetail
  | A2AAgentDiscoveredDetail;

/**
 * All system event details
 */
export type SystemEventDetail =
  | SystemErrorDetail
  | SystemMaintenanceDetail;

/**
 * Union of all event details
 */
export type AllEventDetails =
  | AgentEventDetail
  | TaskEventDetail
  | CoordinationEventDetail
  | CronEventDetail
  | A2AEventDetail
  | SystemEventDetail;
