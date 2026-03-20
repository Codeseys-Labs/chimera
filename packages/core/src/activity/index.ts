/**
 * Activity module
 *
 * Real-time agent activity monitoring and observability:
 * - StatusDashboard: Aggregate view of agent sessions and metrics
 */

export {
  StatusDashboard,
  type StatusDashboardConfig,
  type SessionMetrics,
  type AgentActivitySummary,
  type TenantDashboard,
  type RecentActivityItem,
  type QuerySessionsParams,
  type QuerySessionsResult,
} from './status-dashboard';

export type { DynamoDBClient } from './status-dashboard';
