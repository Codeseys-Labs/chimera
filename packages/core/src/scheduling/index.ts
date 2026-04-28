/**
 * Scheduling module — chimera-2b2a EventBridge scheduled tasks.
 *
 * Exposes the ScheduleService + types used by the chat-gateway `/schedules`
 * routes. Infrastructure wiring (DDB table, dispatcher Lambda, signing key
 * secret) lives in `infra/lib/orchestration-stack.ts`.
 */

export {
  ScheduleService,
  ScheduleLimitExceededError,
  InvalidScheduleExpressionError,
  ScheduleNotFoundError,
  SCHEDULE_LIMITS_BY_TIER,
  type ScheduleServiceConfig,
  type ScheduleDynamoDBClient,
  type EventBridgeSchedulerClient,
  type CreateScheduleParams,
  type UpdateScheduleParams,
  type ScheduleItem,
  type ScheduleRun,
  type ScheduleRunStatus,
  type CreateScheduleInput,
  type UpdateScheduleInput,
  type ScheduleTenantTier,
} from './schedule-service';
