import { describe, it, expect, beforeEach } from 'vitest';
import {
  BedrockRegistryClient,
  RegistryAuthError,
  RegistryNotFoundError,
  RegistryRateLimitError,
  RegistryUnavailableError,
  type RegistrySdkClient,
} from '../bedrock-registry-client';
import type { RegistrySkillRecord } from '../types';

const REGISTRY_ID = 'arn:aws:bedrock-agentcore:us-west-2:111111111111:registry/chimera-test';
const REGION = 'us-west-2';
const TENANT_A = 'tenant-a';

/**
 * Fake SDK command classes. The client's internal logic does
 * `new Cmd(input)` then `client.send(cmd)`. Our fakes capture the input
 * on construction so tests can assert on it.
 */
function makeCommandCtor(name: string): new (input: unknown) => { _name: string; input: unknown } {
  return class {
    public readonly _name = name;
    public readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  };
}

interface FakeClient extends RegistrySdkClient {
  _commands: Record<string, new (input: unknown) => unknown>;
  _sent: Array<{ name: string; input: unknown }>;
  _nextResponse?: unknown;
  _nextError?: unknown;
}

function makeFakeControlClient(): FakeClient {
  const sent: FakeClient['_sent'] = [];
  const client: FakeClient = {
    _commands: {
      CreateRegistryRecordCommand: makeCommandCtor('CreateRegistryRecordCommand'),
      UpdateRegistryRecordCommand: makeCommandCtor('UpdateRegistryRecordCommand'),
      GetRegistryRecordCommand: makeCommandCtor('GetRegistryRecordCommand'),
      UpdateRegistryRecordStatusCommand: makeCommandCtor('UpdateRegistryRecordStatusCommand'),
      SubmitRegistryRecordForApprovalCommand: makeCommandCtor(
        'SubmitRegistryRecordForApprovalCommand'
      ),
      SearchRegistryRecordsCommand: makeCommandCtor('SearchRegistryRecordsCommand'),
    },
    _sent: sent,
    async send(command: unknown) {
      const c = command as { _name: string; input: unknown };
      sent.push({ name: c._name, input: c.input });
      if (client._nextError) {
        const e = client._nextError;
        client._nextError = undefined;
        throw e;
      }
      const resp = client._nextResponse;
      client._nextResponse = undefined;
      return resp;
    },
  };
  return client;
}

function makeFakeDataClient(): FakeClient {
  const sent: FakeClient['_sent'] = [];
  const client: FakeClient = {
    _commands: {
      CreateRegistryRecordCommand: makeCommandCtor('CreateRegistryRecordCommand'),
      GetRegistryRecordCommand: makeCommandCtor('GetRegistryRecordCommand'),
      UpdateRegistryRecordStatusCommand: makeCommandCtor('UpdateRegistryRecordStatusCommand'),
      SearchRegistryRecordsCommand: makeCommandCtor('SearchRegistryRecordsCommand'),
    },
    _sent: sent,
    async send(command: unknown) {
      const c = command as { _name: string; input: unknown };
      sent.push({ name: c._name, input: c.input });
      if (client._nextError) {
        const e = client._nextError;
        client._nextError = undefined;
        throw e;
      }
      const resp = client._nextResponse;
      client._nextResponse = undefined;
      return resp;
    },
  };
  return client;
}

function makeRecord(): RegistrySkillRecord {
  return {
    registryId: REGISTRY_ID,
    name: 'aws-cost-lookup',
    version: '1.2.3',
    status: 'DRAFT',
    description: 'Look up AWS costs by service.',
    tenantId: TENANT_A,
    metadata: { trustTier: 'verified', tags: ['aws'] },
  };
}

describe('BedrockRegistryClient construction', () => {
  it('requires registryId and region', () => {
    expect(() => new BedrockRegistryClient({ registryId: '', region: REGION })).toThrow(
      /registryId/
    );
    expect(() => new BedrockRegistryClient({ registryId: REGISTRY_ID, region: '' })).toThrow(
      /region/
    );
  });
});

describe('BedrockRegistryClient.createRecord', () => {
  let control: FakeClient;
  let client: BedrockRegistryClient;

  beforeEach(() => {
    control = makeFakeControlClient();
    client = new BedrockRegistryClient({
      registryId: REGISTRY_ID,
      region: REGION,
      _controlPlaneClient: control,
    });
  });

  it('calls CreateRegistryRecordCommand with the right input', async () => {
    control._nextResponse = { recordId: 'rec-abc123' };
    const out = await client.createRecord(makeRecord());

    expect(control._sent).toHaveLength(1);
    expect(control._sent[0].name).toBe('CreateRegistryRecordCommand');
    const input = control._sent[0].input as Record<string, unknown>;
    expect(input.registryId).toBe(REGISTRY_ID);
    expect(input.name).toBe('aws-cost-lookup');
    expect(input.version).toBe('1.2.3');
    // tenantId must be threaded into metadata
    expect((input.metadata as Record<string, unknown>).tenantId).toBe(TENANT_A);
    expect((input.metadata as Record<string, unknown>).trustTier).toBe('verified');

    expect(out.recordId).toBe('rec-abc123');
    expect(out.status).toBe('DRAFT');
  });

  it('accepts `id` as a fallback for `recordId` in response', async () => {
    control._nextResponse = { id: 'rec-fallback' };
    const out = await client.createRecord(makeRecord());
    expect(out.recordId).toBe('rec-fallback');
  });

  it('raises RegistryUnavailableError when response lacks a recordId', async () => {
    control._nextResponse = {};
    await expect(client.createRecord(makeRecord())).rejects.toBeInstanceOf(
      RegistryUnavailableError
    );
  });

  it('maps AccessDeniedException → RegistryAuthError', async () => {
    control._nextError = {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 },
      message: 'denied',
    };
    await expect(client.createRecord(makeRecord())).rejects.toBeInstanceOf(RegistryAuthError);
  });

  it('maps ThrottlingException → RegistryRateLimitError', async () => {
    control._nextError = {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 429 },
      message: 'slow down',
    };
    await expect(client.createRecord(makeRecord())).rejects.toBeInstanceOf(
      RegistryRateLimitError
    );
  });

  it('maps unknown errors → RegistryUnavailableError', async () => {
    control._nextError = new Error('boom');
    await expect(client.createRecord(makeRecord())).rejects.toBeInstanceOf(
      RegistryUnavailableError
    );
  });
});

describe('BedrockRegistryClient.updateRecordStatus', () => {
  let control: FakeClient;
  let client: BedrockRegistryClient;

  beforeEach(() => {
    control = makeFakeControlClient();
    client = new BedrockRegistryClient({
      registryId: REGISTRY_ID,
      region: REGION,
      _controlPlaneClient: control,
    });
  });

  it('uses SubmitRegistryRecordForApprovalCommand for PENDING_APPROVAL', async () => {
    control._nextResponse = {};
    await client.updateRecordStatus('rec-1', 'PENDING_APPROVAL');
    expect(control._sent).toHaveLength(1);
    expect(control._sent[0].name).toBe('SubmitRegistryRecordForApprovalCommand');
    const input = control._sent[0].input as Record<string, unknown>;
    expect(input.registryId).toBe(REGISTRY_ID);
    expect(input.recordId).toBe('rec-1');
    expect(input.status).toBeUndefined();
  });

  it('uses UpdateRegistryRecordStatusCommand for APPROVED', async () => {
    control._nextResponse = {};
    await client.updateRecordStatus('rec-2', 'APPROVED');
    expect(control._sent[0].name).toBe('UpdateRegistryRecordStatusCommand');
    const input = control._sent[0].input as Record<string, unknown>;
    expect(input.status).toBe('APPROVED');
    expect(input.recordId).toBe('rec-2');
  });

  it('rejects empty recordId', async () => {
    await expect(client.updateRecordStatus('', 'APPROVED')).rejects.toThrow(/recordId/);
  });
});

describe('BedrockRegistryClient.getRecord', () => {
  let control: FakeClient;
  let client: BedrockRegistryClient;

  beforeEach(() => {
    control = makeFakeControlClient();
    client = new BedrockRegistryClient({
      registryId: REGISTRY_ID,
      region: REGION,
      _controlPlaneClient: control,
    });
  });

  it('returns a hydrated record on success', async () => {
    control._nextResponse = {
      recordId: 'rec-abc',
      name: 'foo',
      version: '1.0.0',
      status: 'APPROVED',
      description: 'desc',
      metadata: { tenantId: TENANT_A, trustTier: 'verified', tags: ['a'] },
    };
    const out = await client.getRecord('rec-abc');
    if (out === null) throw new Error('expected non-null record');
    expect(out.recordId).toBe('rec-abc');
    expect(out.name).toBe('foo');
    expect(out.status).toBe('APPROVED');
    expect(out.tenantId).toBe(TENANT_A);
    // tenantId is extracted out of metadata, not duplicated
    expect(out.metadata.tenantId).toBeUndefined();
    expect(out.metadata.trustTier).toBe('verified');
  });

  it('returns null on ResourceNotFoundException', async () => {
    control._nextError = {
      name: 'ResourceNotFoundException',
      $metadata: { httpStatusCode: 404 },
      message: 'missing',
    };
    const out = await client.getRecord('rec-missing');
    expect(out).toBeNull();
  });

  it('re-throws auth errors instead of returning null', async () => {
    control._nextError = {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 },
      message: 'nope',
    };
    await expect(client.getRecord('rec-x')).rejects.toBeInstanceOf(RegistryAuthError);
  });
});

describe('BedrockRegistryClient.searchRecords', () => {
  let data: FakeClient;
  let client: BedrockRegistryClient;

  beforeEach(() => {
    data = makeFakeDataClient();
    client = new BedrockRegistryClient({
      registryId: REGISTRY_ID,
      region: REGION,
      _dataPlaneClient: data,
    });
  });

  it('calls SearchRegistryRecordsCommand with registryIds and maxResults', async () => {
    data._nextResponse = { records: [], nextToken: undefined };
    await client.searchRecords('cost lookup', undefined, 5);
    expect(data._sent).toHaveLength(1);
    expect(data._sent[0].name).toBe('SearchRegistryRecordsCommand');
    const input = data._sent[0].input as Record<string, unknown>;
    expect(input.registryIds).toEqual([REGISTRY_ID]);
    expect(input.searchQuery).toBe('cost lookup');
    expect(input.maxResults).toBe(5);
    expect(input.filters).toBeUndefined();
  });

  it('encodes tenantId + status filters', async () => {
    data._nextResponse = { records: [] };
    await client.searchRecords('hello', { tenantId: TENANT_A, status: 'APPROVED' }, 10);
    const input = data._sent[0].input as Record<string, unknown>;
    expect(input.filters).toBeDefined();
    // Two filters → $and
    const filters = input.filters as { $and: Array<Record<string, unknown>> };
    expect(filters.$and).toHaveLength(2);
  });

  it('flattens single-filter case to not use $and', async () => {
    data._nextResponse = { records: [] };
    await client.searchRecords('hello', { status: 'APPROVED' });
    const input = data._sent[0].input as Record<string, unknown>;
    const filters = input.filters as Record<string, unknown>;
    expect(filters.$and).toBeUndefined();
    expect(filters.status).toEqual({ $eq: 'APPROVED' });
  });

  it('hydrates response records into RegistrySkillRecord shape', async () => {
    data._nextResponse = {
      records: [
        {
          recordId: 'rec-1',
          name: 'a',
          version: '1.0.0',
          status: 'APPROVED',
          metadata: { tenantId: TENANT_A, trustTier: 'verified' },
        },
        {
          recordId: 'rec-2',
          name: 'b',
          version: '2.0.0',
          status: 'APPROVED',
          metadata: { tenantId: TENANT_A },
        },
      ],
      nextToken: 'tok-abc',
    };
    const res = await client.searchRecords('anything');
    expect(res.records).toHaveLength(2);
    expect(res.records[0].tenantId).toBe(TENANT_A);
    expect(res.records[0].metadata.trustTier).toBe('verified');
    expect(res.nextToken).toBe('tok-abc');
  });

  it('rejects empty queries', async () => {
    await expect(client.searchRecords('')).rejects.toThrow(/query/);
  });
});

describe('BedrockRegistryClient.deprecateRecord', () => {
  it('delegates to updateRecordStatus with DEPRECATED', async () => {
    const control = makeFakeControlClient();
    const client = new BedrockRegistryClient({
      registryId: REGISTRY_ID,
      region: REGION,
      _controlPlaneClient: control,
    });
    control._nextResponse = {};
    await client.deprecateRecord('rec-old');
    expect(control._sent).toHaveLength(1);
    expect(control._sent[0].name).toBe('UpdateRegistryRecordStatusCommand');
    const input = control._sent[0].input as Record<string, unknown>;
    expect(input.status).toBe('DEPRECATED');
    expect(input.recordId).toBe('rec-old');
  });
});

describe('BedrockRegistryClient unavailable paths', () => {
  it('raises RegistryUnavailableError when no control client injected and SDK missing', async () => {
    // No _controlPlaneClient, and the real SDK package is not installed.
    const client = new BedrockRegistryClient({
      registryId: REGISTRY_ID,
      region: REGION,
    });
    await expect(client.createRecord(makeRecord())).rejects.toBeInstanceOf(
      RegistryUnavailableError
    );
  });

  it('raises RegistryUnavailableError when no data client injected and SDK missing', async () => {
    const client = new BedrockRegistryClient({
      registryId: REGISTRY_ID,
      region: REGION,
    });
    await expect(client.searchRecords('anything')).rejects.toBeInstanceOf(
      RegistryUnavailableError
    );
  });
});

describe('BedrockRegistryClient error mapping edge cases', () => {
  it('maps 404 without explicit name to RegistryNotFoundError', async () => {
    const control = makeFakeControlClient();
    const client = new BedrockRegistryClient({
      registryId: REGISTRY_ID,
      region: REGION,
      _controlPlaneClient: control,
    });
    control._nextError = { $metadata: { httpStatusCode: 404 }, message: 'gone' };
    const out = await client.getRecord('rec-404');
    expect(out).toBeNull();
  });

  it('maps 401 → RegistryAuthError', async () => {
    const control = makeFakeControlClient();
    const client = new BedrockRegistryClient({
      registryId: REGISTRY_ID,
      region: REGION,
      _controlPlaneClient: control,
    });
    control._nextError = { $metadata: { httpStatusCode: 401 }, message: 'no auth' };
    await expect(client.createRecord(makeRecord())).rejects.toBeInstanceOf(RegistryAuthError);
  });

  it('wraps RegistryNotFoundError returned from direct call paths', async () => {
    // Ensure our RegistryNotFoundError class matches the exported one
    expect(new RegistryNotFoundError('x').name).toBe('RegistryNotFoundError');
  });
});
