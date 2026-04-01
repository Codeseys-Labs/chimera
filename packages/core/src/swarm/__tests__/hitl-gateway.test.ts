/**
 * Tests for HITLGateway DynamoDB persistence
 *
 * Uses an in-memory HITLDDBClient stub — no AWS SDK required.
 */

import { describe, it, expect } from 'bun:test';
import {
  HITLGateway,
  createHITLGateway,
  type HITLDDBClient,
  type HITLPolicyConfig,
} from '../hitl-gateway';

// ---------------------------------------------------------------------------
// In-memory DDB stub
// ---------------------------------------------------------------------------

class MemoryDDB implements HITLDDBClient {
  private store = new Map<string, Record<string, unknown>>();

  private key(pk: string, sk: string): string {
    return `${pk}::${sk}`;
  }

  async get(input: { TableName: string; Key: Record<string, unknown> }): Promise<{ Item?: Record<string, unknown> }> {
    const k = this.key(input.Key['PK'] as string, input.Key['SK'] as string);
    const item = this.store.get(k);
    return { Item: item };
  }

  async put(input: { TableName: string; Item: Record<string, unknown> }): Promise<unknown> {
    const k = this.key(input.Item['PK'] as string, input.Item['SK'] as string);
    this.store.set(k, { ...input.Item });
    return {};
  }

  /** Test helper — read a stored item directly */
  read(pk: string, sk: string): Record<string, unknown> | undefined {
    return this.store.get(this.key(pk, sk));
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGateway(ddb: MemoryDDB, tableName = 'chimera-sessions-test'): HITLGateway {
  const config: HITLPolicyConfig = {
    costThresholdUsd: 100,
    allowProductionChanges: false,
    requireApprovalForIrreversible: true,
    requireApprovalForCompliance: true,
    autoApproveEnvironments: ['development', 'test', 'sandbox'],
    sessionsTableName: tableName,
    ddb,
  };
  return new HITLGateway(config);
}

const baseContext = {
  taskId: 'task-001',
  description: 'Deploy to production',
  environment: 'production' as const,
  estimatedCostUsd: 50,
  isIrreversible: false,
  affectsCompliance: false,
  requiresExternal: false,
  tenantId: 'tenant-acme',
  metadata: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HITLGateway — saveApprovalRequest', () => {
  it('should persist approval record with status=pending', async () => {
    const ddb = new MemoryDDB();
    const gw = makeGateway(ddb);

    await gw.saveApprovalRequest({
      requestId: 'req-1',
      tenantId: 'tenant-acme',
      action: 'Deploy service X',
      requestedAt: new Date().toISOString(),
    });

    const item = ddb.read('TENANT#tenant-acme', 'APPROVAL#req-1');
    expect(item).toBeDefined();
    if (!item) throw new Error('item not found');
    expect(item['requestId']).toBe('req-1');
    expect(item['tenantId']).toBe('tenant-acme');
    expect(item['action']).toBe('Deploy service X');
    expect(item['status']).toBe('pending');
    expect(item['PK']).toBe('TENANT#tenant-acme');
    expect(item['SK']).toBe('APPROVAL#req-1');
  });

  it('should be a no-op when sessionsTableName is not configured', async () => {
    const ddb = new MemoryDDB();
    const gw = new HITLGateway({
      costThresholdUsd: 100,
      allowProductionChanges: false,
      requireApprovalForIrreversible: true,
      requireApprovalForCompliance: true,
      autoApproveEnvironments: ['test'],
      // no sessionsTableName
      ddb,
    });

    await gw.saveApprovalRequest({
      requestId: 'req-noop',
      tenantId: 'tenant-x',
      action: 'Some action',
      requestedAt: new Date().toISOString(),
    });

    expect(ddb.read('TENANT#tenant-x', 'APPROVAL#req-noop')).toBeUndefined();
  });
});

describe('HITLGateway — getApprovalStatus', () => {
  it('should return null when record does not exist', async () => {
    const ddb = new MemoryDDB();
    const gw = makeGateway(ddb);

    const result = await gw.getApprovalStatus({
      requestId: 'missing',
      tenantId: 'tenant-acme',
    });

    expect(result).toBeNull();
  });

  it('should return the stored approval record', async () => {
    const ddb = new MemoryDDB();
    const gw = makeGateway(ddb);

    await gw.saveApprovalRequest({
      requestId: 'req-2',
      tenantId: 'tenant-acme',
      action: 'Resize production cluster',
      requestedAt: new Date().toISOString(),
    });

    const record = await gw.getApprovalStatus({
      requestId: 'req-2',
      tenantId: 'tenant-acme',
    });

    expect(record).not.toBeNull();
    if (!record) throw new Error('record not found');
    expect(record.status).toBe('pending');
    expect(record.action).toBe('Resize production cluster');
  });
});

describe('HITLGateway — resolveApproval', () => {
  it('should update status to approved', async () => {
    const ddb = new MemoryDDB();
    const gw = makeGateway(ddb);

    await gw.saveApprovalRequest({
      requestId: 'req-3',
      tenantId: 'tenant-acme',
      action: 'Delete old snapshots',
      requestedAt: new Date().toISOString(),
    });

    await gw.resolveApproval({
      requestId: 'req-3',
      tenantId: 'tenant-acme',
      approved: true,
      resolvedBy: 'alice@example.com',
    });

    const record = await gw.getApprovalStatus({
      requestId: 'req-3',
      tenantId: 'tenant-acme',
    });

    if (!record) throw new Error('record not found');
    expect(record.status).toBe('approved');
    expect(record.resolvedBy).toBe('alice@example.com');
    expect(record.resolvedAt).toBeDefined();
  });

  it('should update status to denied', async () => {
    const ddb = new MemoryDDB();
    const gw = makeGateway(ddb);

    await gw.saveApprovalRequest({
      requestId: 'req-4',
      tenantId: 'tenant-acme',
      action: 'Scale down prod workers',
      requestedAt: new Date().toISOString(),
    });

    await gw.resolveApproval({
      requestId: 'req-4',
      tenantId: 'tenant-acme',
      approved: false,
      resolvedBy: 'bob@example.com',
    });

    const record = await gw.getApprovalStatus({
      requestId: 'req-4',
      tenantId: 'tenant-acme',
    });

    if (!record) throw new Error('record not found');
    expect(record.status).toBe('denied');
    expect(record.resolvedBy).toBe('bob@example.com');
  });
});

describe('HITLGateway — createEscalation persists to DDB', () => {
  it('should save approval record when escalation is created', async () => {
    const ddb = new MemoryDDB();
    const gw = makeGateway(ddb);

    const escalation = await gw.createEscalation(baseContext, []);

    const item = ddb.read('TENANT#tenant-acme', `APPROVAL#${escalation.id}`);
    expect(item).toBeDefined();
    expect(item!['status']).toBe('pending');
    expect(item!['tenantId']).toBe('tenant-acme');
  });
});

describe('HITLGateway — tenant isolation', () => {
  it('should not leak approval records across tenants', async () => {
    const ddb = new MemoryDDB();
    const gw = makeGateway(ddb);

    await gw.saveApprovalRequest({
      requestId: 'req-5',
      tenantId: 'tenant-a',
      action: 'Action A',
      requestedAt: new Date().toISOString(),
    });

    // Querying with wrong tenantId returns null
    const wrong = await gw.getApprovalStatus({
      requestId: 'req-5',
      tenantId: 'tenant-b',
    });
    expect(wrong).toBeNull();

    // Correct tenant finds the record
    const correct = await gw.getApprovalStatus({
      requestId: 'req-5',
      tenantId: 'tenant-a',
    });
    expect(correct).not.toBeNull();
  });
});

describe('createHITLGateway factory', () => {
  it('should create gateway with default config', () => {
    const gw = createHITLGateway();
    expect(gw).toBeInstanceOf(HITLGateway);
  });

  it('should override defaults with partial config', () => {
    const ddb = new MemoryDDB();
    const gw = createHITLGateway({
      costThresholdUsd: 500,
      sessionsTableName: 'chimera-sessions-prod',
      ddb,
    });
    expect(gw).toBeInstanceOf(HITLGateway);
  });
});
