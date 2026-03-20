/**
 * Chimera Event System
 *
 * EventBridge-based event orchestration for multi-agent platform.
 *
 * @packageDocumentation
 */

// Event types
export {
  // Base event structure
  ChimeraEvent,

  // Enums
  EventSource,
  EventDetailType,
  AgentStatus,
  TaskStatus,

  // Agent event details
  BaseAgentDetail,
  AgentCreatedDetail,
  AgentStartedDetail,
  AgentCompletedDetail,
  AgentFailedDetail,
  AgentCancelledDetail,
  AgentEventDetail,

  // Task event details
  BaseTaskDetail,
  TaskCreatedDetail,
  TaskAssignedDetail,
  TaskRunningDetail,
  TaskCompletedDetail,
  TaskFailedDetail,
  TaskCancelledDetail,
  TaskEventDetail,

  // Coordination event details
  AgentDelegationDetail,
  AgentArtifactExchangeDetail,
  SwarmCoordinationDetail,
  GraphWorkflowDetail,
  CoordinationEventDetail,

  // Cron event details
  CronScheduledDetail,
  CronTriggeredDetail,
  CronCompletedDetail,
  CronEventDetail,

  // A2A protocol event details
  A2ATaskCreatedDetail,
  A2ATaskCompletedDetail,
  A2AAgentDiscoveredDetail,
  A2AEventDetail,

  // System event details
  SystemErrorDetail,
  SystemMaintenanceDetail,
  SystemEventDetail,

  // Type unions
  AllEventDetails,
} from './event-types';

// Event bus client
export {
  ChimeraEventBus,
  EventBusConfig,
  PublishEventOptions,
  SubscribeEventOptions,
  EventPattern,
  EventTarget,
  createTenantEventPattern,
  createAgentEventPattern,
  createTaskEventPattern,
  createCoordinationEventPattern,
} from './event-bus';

// Event handlers
export {
  EventHandler,
  AgentLifecycleHandler,
  TaskLifecycleHandler,
  EventHandlerContext,
  EventHandlerResult,
  EventHandlerOptions,
} from './event-handler';
