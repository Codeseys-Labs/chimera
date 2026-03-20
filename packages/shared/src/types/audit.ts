/**
 * Audit types for AWS Chimera security and compliance
 *
 * Based on canonical-data-model.md specification (Table 6: clawcore-audit)
 */

/**
 * Audit event type
 */
export type AuditEventType =
  | 'authentication'
  | 'authorization'
  | 'data-access'
  | 'config-change'
  | 'skill-install'
  | 'skill-uninstall'
  | 'session-create'
  | 'session-terminate'
  | 'api-request'
  | 'policy-violation'
  | 'security-alert';

/**
 * Audit severity level
 */
export type AuditSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Audit event metadata
 */
export interface AuditEventMetadata {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  sessionId?: string;
  resourceId?: string;
  previousValue?: unknown;
  newValue?: unknown;
  [key: string]: unknown; // Allow additional metadata
}

/**
 * Audit event record (Table: clawcore-audit)
 */
export interface AuditEvent {
  PK: string; // TENANT#{tenantId}
  SK: string; // EVENT#{timestamp}#{eventId}
  eventId: string;
  tenantId: string;
  eventType: AuditEventType;
  severity: AuditSeverity;
  timestamp: string; // ISO 8601
  userId?: string;
  agentId?: string;
  action: string;
  resource: string;
  outcome: 'success' | 'failure';
  errorMessage?: string;
  metadata: AuditEventMetadata;
  ttl: number; // Unix timestamp (90d-7yr based on tier)
}

/**
 * Audit log query parameters
 */
export interface AuditLogQuery {
  tenantId: string;
  startTime?: string; // ISO 8601
  endTime?: string; // ISO 8601
  eventType?: AuditEventType;
  severity?: AuditSeverity;
  userId?: string;
  outcome?: 'success' | 'failure';
  limit?: number;
}

/**
 * Audit log summary
 */
export interface AuditLogSummary {
  tenantId: string;
  period: string; // YYYY-MM-DD or YYYY-MM
  totalEvents: number;
  eventsByType: Record<AuditEventType, number>;
  eventsBySeverity: Record<AuditSeverity, number>;
  failureRate: number; // 0-1
  topUsers: Array<{ userId: string; eventCount: number }>;
}
