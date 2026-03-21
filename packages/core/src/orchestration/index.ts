/**
 * Multi-Agent Orchestration Module
 *
 * Provides comprehensive agent orchestration capabilities:
 * - Agent lifecycle management (spawn, monitor, terminate)
 * - EventBridge-based event distribution
 * - SQS-based task delegation
 * - Self-expanding swarms
 * - Step Functions workflow integration
 * - Enhanced cron scheduling
 *
 * Architecture:
 * - EventBridge = Central nervous system for agent events
 * - SQS = Reliable task queuing
 * - DynamoDB = Agent state persistence
 * - Step Functions = Complex workflow orchestration
 *
 * @packageDocumentation
 */

// Orchestrator
export {
  AgentOrchestrator,
  createOrchestrator,
  type AgentStatus,
  type AgentRole,
  type AgentEventType,
  type SpawnAgentConfig,
  type AgentRuntimeMetadata,
  type TaskDelegation,
  type AgentEvent,
  type OrchestratorConfig
} from './orchestrator';

// Swarm
export {
  AgentSwarm,
  createSwarm,
  SwarmPresets,
  type ScalingStrategy,
  type SwarmConfig,
  type SwarmMetrics,
  type SwarmState
} from './swarm';

// Workflow
export {
  WorkflowEngine,
  createWorkflowEngine,
  WorkflowPatterns,
  type WorkflowStepType,
  type WorkflowStepStatus,
  type WorkflowStep,
  type WorkflowChoice,
  type RetryConfig,
  type WorkflowDefinition,
  type WorkflowExecution,
  type StepExecutionResult
} from './workflow';

// Cron Scheduler
export {
  CronScheduler,
  createCronScheduler,
  CronPatterns,
  CronJobPresets,
  type CronExpression,
  type CronJobStatus,
  type CronExecutionStatus,
  type CronJob,
  type CronExecution,
  type CronSchedulerConfig
} from './cron-scheduler';

// Background Tasks
export {
  BackgroundTaskManager,
  createBackgroundTaskManager,
  startBackgroundTaskTool,
  type BackgroundTaskStatus,
  type BackgroundTask,
  type TaskSubmissionResult
} from './background-task';

// A2A Protocol
export {
  A2AProtocol,
  createA2AProtocol,
  A2AMessageBuilder,
  type A2AMessageType,
  type MessagePriority,
  type A2AMessage,
  type A2APayload,
  type TaskRequest,
  type TaskResponse,
  type QueryRequest,
  type QueryResponse,
  type EventNotification,
  type BroadcastMessage,
  type RoutingConfig
} from './a2a-protocol';
