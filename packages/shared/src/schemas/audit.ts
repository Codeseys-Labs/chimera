/**
 * Zod schemas for audit boundary types.
 *
 * Audit events cross the DynamoDB boundary (chimera-audit, CMK-encrypted,
 * 90d-7yr retention by tier) and downstream consumers (SIEM, log shippers,
 * incident-response runbooks). External consumers and log-restore flows
 * MUST validate before trusting event fields for dashboards or access
 * decisions.
 *
 * Mirrors `../types/audit.ts`.
 */

import { z } from 'zod';

export const AuditEventTypeSchema = z.enum([
  'authentication',
  'authorization',
  'data-access',
  'config-change',
  'skill-install',
  'skill-uninstall',
  'session-create',
  'session-terminate',
  'api-request',
  'policy-violation',
  'security-alert',
]);

export const AuditSeveritySchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
]);

// AuditEventMetadata permits open-ended additional fields (see TS definition).
export const AuditEventMetadataSchema = z
  .object({
    ipAddress: z.string().optional(),
    userAgent: z.string().optional(),
    requestId: z.string().optional(),
    sessionId: z.string().optional(),
    resourceId: z.string().optional(),
    previousValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
  })
  .passthrough();

export const AuditEventSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  eventId: z.string().min(1),
  tenantId: z.string().min(1),
  eventType: AuditEventTypeSchema,
  severity: AuditSeveritySchema,
  timestamp: z.string(),
  userId: z.string().optional(),
  agentId: z.string().optional(),
  action: z.string(),
  resource: z.string(),
  outcome: z.enum(['success', 'failure']),
  errorMessage: z.string().optional(),
  metadata: AuditEventMetadataSchema,
  ttl: z.number().int(),
});

export const AuditLogQuerySchema = z.object({
  tenantId: z.string().min(1),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  eventType: AuditEventTypeSchema.optional(),
  severity: AuditSeveritySchema.optional(),
  userId: z.string().optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  limit: z.number().int().positive().optional(),
});
