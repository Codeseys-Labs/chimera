/**
 * Audit schema round-trip tests.
 */

import { describe, expect, it } from 'bun:test';
import {
  AuditEventTypeSchema,
  AuditSeveritySchema,
  AuditEventSchema,
  AuditLogQuerySchema,
} from '../schemas/audit';

describe('AuditEventTypeSchema', () => {
  it('accepts every documented event type', () => {
    const types = [
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
    ];
    for (const t of types) {
      expect(AuditEventTypeSchema.parse(t)).toBe(t);
    }
  });

  it('rejects arbitrary event types', () => {
    expect(AuditEventTypeSchema.safeParse('freeform-thing').success).toBe(false);
  });
});

describe('AuditSeveritySchema', () => {
  it('rejects severity levels outside the canonical 4', () => {
    expect(AuditSeveritySchema.safeParse('info').success).toBe(false);
    expect(AuditSeveritySchema.safeParse('critical').success).toBe(true);
  });
});

describe('AuditEventSchema', () => {
  const valid = {
    PK: 'TENANT#t-1',
    SK: 'EVENT#2026-01-01T00:00:00Z#evt-1',
    eventId: 'evt-1',
    tenantId: 't-1',
    eventType: 'authentication' as const,
    severity: 'low' as const,
    timestamp: '2026-01-01T00:00:00Z',
    action: 'login',
    resource: 'user-pool',
    outcome: 'success' as const,
    metadata: {
      ipAddress: '203.0.113.10',
      userAgent: 'chimera-cli/1.0',
    },
    ttl: 1893456000,
  };

  it('parses a valid audit event', () => {
    const parsed = AuditEventSchema.parse(valid);
    expect(parsed.eventId).toBe('evt-1');
  });

  it('accepts additional keys in metadata (open shape)', () => {
    const parsed = AuditEventSchema.parse({
      ...valid,
      metadata: { ...valid.metadata, customKey: 'customValue' },
    });
    expect((parsed.metadata as Record<string, unknown>).customKey).toBe('customValue');
  });

  it('rejects an event with outcome outside success/failure', () => {
    const result = AuditEventSchema.safeParse({ ...valid, outcome: 'pending' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['outcome']);
    }
  });

  it('rejects an empty eventId', () => {
    const result = AuditEventSchema.safeParse({ ...valid, eventId: '' });
    expect(result.success).toBe(false);
  });
});

describe('AuditLogQuerySchema', () => {
  it('accepts a minimal query (tenantId only)', () => {
    const parsed = AuditLogQuerySchema.parse({ tenantId: 't-1' });
    expect(parsed.tenantId).toBe('t-1');
  });

  it('rejects a limit of 0', () => {
    const result = AuditLogQuerySchema.safeParse({ tenantId: 't-1', limit: 0 });
    expect(result.success).toBe(false);
  });
});
