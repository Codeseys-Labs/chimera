import { describe, it, expect } from 'vitest';
import type { Skill } from '@chimera/shared';
import {
  skillToRegistryRecord,
  registryRecordToSkill,
  CrossTenantRecordError,
} from '../skill-to-registry-mapper';
import type { RegistrySkillRecord } from '../types';

const REGISTRY_ID = 'arn:aws:bedrock-agentcore:us-west-2:111111111111:registry/chimera-test';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    PK: 'SKILL#aws-cost-lookup',
    SK: 'VERSION#1.2.3',
    name: 'aws-cost-lookup',
    version: '1.2.3',
    author: 'tenant-a',
    description: 'Look up AWS costs by service.',
    category: 'cloud-ops',
    tags: ['aws', 'cost', 'billing'],
    trust_level: 'verified',
    permissions_hash: 'sha256:deadbeef',
    signatures: { author: 'ed25519:abc', platform: 'ed25519:def' },
    bundle: { s3_key: 's3://chimera-skills/aws-cost-lookup/1.2.3.tgz', sha256: 'f00d', size_bytes: 12345 },
    scan_status: 'passed',
    scan_timestamp: '2026-04-17T12:00:00.000Z',
    download_count: 42,
    rating_avg: 4.5,
    rating_count: 10,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-04-17T12:00:00.000Z',
    ...overrides,
  };
}

describe('skillToRegistryRecord', () => {
  it('maps core fields and stashes extras under metadata', () => {
    const skill = makeSkill();
    const record = skillToRegistryRecord(skill, REGISTRY_ID, TENANT_A);

    expect(record.registryId).toBe(REGISTRY_ID);
    expect(record.name).toBe('aws-cost-lookup');
    expect(record.version).toBe('1.2.3');
    expect(record.description).toBe('Look up AWS costs by service.');
    expect(record.tenantId).toBe(TENANT_A);
    expect(record.status).toBe('DRAFT');
    expect(record.recordId).toBeUndefined();

    // metadata contents
    expect(record.metadata.trustTier).toBe('verified');
    expect(record.metadata.category).toBe('cloud-ops');
    expect(record.metadata.tags).toEqual(['aws', 'cost', 'billing']);
    expect(record.metadata.permissionsHash).toBe('sha256:deadbeef');
    expect(record.metadata.signatures).toEqual({
      author: 'ed25519:abc',
      platform: 'ed25519:def',
    });
    expect(record.metadata.ddbPK).toBe('SKILL#aws-cost-lookup');
    expect(record.metadata.ddbSK).toBe('VERSION#1.2.3');
  });

  it('maps deprecated skills to DEPRECATED status', () => {
    const skill = makeSkill({ deprecated: true, deprecated_message: 'replaced by v2' });
    const record = skillToRegistryRecord(skill, REGISTRY_ID, TENANT_A);
    expect(record.status).toBe('DEPRECATED');
    expect(record.metadata.deprecatedMessage).toBe('replaced by v2');
  });

  it('throws when required fields are missing', () => {
    expect(() => skillToRegistryRecord(makeSkill(), '', TENANT_A)).toThrow(/registryId/);
    expect(() => skillToRegistryRecord(makeSkill(), REGISTRY_ID, '')).toThrow(/tenantId/);
    expect(() =>
      skillToRegistryRecord(makeSkill({ name: '' }), REGISTRY_ID, TENANT_A)
    ).toThrow(/skill.name/);
    expect(() =>
      skillToRegistryRecord(makeSkill({ version: '' }), REGISTRY_ID, TENANT_A)
    ).toThrow(/skill.version/);
  });
});

describe('registryRecordToSkill', () => {
  it('reconstructs a Skill from a record', () => {
    const original = makeSkill();
    const record = skillToRegistryRecord(original, REGISTRY_ID, TENANT_A);
    // recordId would be populated by the client; simulate:
    record.recordId = 'rec-abc123';

    const roundTripped = registryRecordToSkill(record, TENANT_A);

    expect(roundTripped.name).toBe(original.name);
    expect(roundTripped.version).toBe(original.version);
    expect(roundTripped.author).toBe(original.author);
    expect(roundTripped.description).toBe(original.description);
    expect(roundTripped.category).toBe(original.category);
    expect(roundTripped.tags).toEqual(original.tags);
    expect(roundTripped.trust_level).toBe(original.trust_level);
    expect(roundTripped.permissions_hash).toBe(original.permissions_hash);
    expect(roundTripped.signatures).toEqual(original.signatures);
    expect(roundTripped.bundle).toEqual(original.bundle);
    expect(roundTripped.scan_status).toBe(original.scan_status);
    expect(roundTripped.download_count).toBe(original.download_count);
    expect(roundTripped.PK).toBe(original.PK);
    expect(roundTripped.SK).toBe(original.SK);
  });

  it('round-trips metadata idempotently (property-style)', () => {
    const original = makeSkill();
    const r1 = skillToRegistryRecord(original, REGISTRY_ID, TENANT_A);
    const s1 = registryRecordToSkill(r1, TENANT_A);
    const r2 = skillToRegistryRecord(s1, REGISTRY_ID, TENANT_A);
    // Metadata must be stable after a full Skill → Record → Skill → Record loop.
    expect(r2.metadata).toEqual(r1.metadata);
    expect(r2.name).toBe(r1.name);
    expect(r2.version).toBe(r1.version);
    expect(r2.description).toBe(r1.description);
    expect(r2.tenantId).toBe(r1.tenantId);
    expect(r2.status).toBe(r1.status);
  });

  it('refuses cross-tenant records when expectedTenantId is passed', () => {
    const record: RegistrySkillRecord = {
      registryId: REGISTRY_ID,
      recordId: 'rec-leak',
      name: 'rogue-skill',
      version: '0.1.0',
      status: 'APPROVED',
      tenantId: TENANT_B,
      metadata: {},
    };
    expect(() => registryRecordToSkill(record, TENANT_A)).toThrow(CrossTenantRecordError);
    expect(() => registryRecordToSkill(record, TENANT_A)).toThrow(
      /tenant-a/
    );
  });

  it('allows pass-through when expectedTenantId is not supplied (migration path)', () => {
    const record: RegistrySkillRecord = {
      registryId: REGISTRY_ID,
      recordId: 'rec-1',
      name: 'pass',
      version: '1.0.0',
      status: 'APPROVED',
      tenantId: TENANT_B,
      metadata: {},
    };
    const skill = registryRecordToSkill(record);
    expect(skill.name).toBe('pass');
    expect(skill.author).toBe(TENANT_B); // falls back to record.tenantId
  });

  it('throws on missing name/version', () => {
    const base: RegistrySkillRecord = {
      registryId: REGISTRY_ID,
      name: '',
      version: '1.0.0',
      status: 'DRAFT',
      tenantId: TENANT_A,
      metadata: {},
    };
    expect(() => registryRecordToSkill(base)).toThrow(/record.name/);
    expect(() =>
      registryRecordToSkill({ ...base, name: 'foo', version: '' })
    ).toThrow(/record.version/);
  });

  it('marks DEPRECATED records as deprecated on the Skill side', () => {
    const record: RegistrySkillRecord = {
      registryId: REGISTRY_ID,
      recordId: 'rec-dep',
      name: 'old-skill',
      version: '0.9.0',
      status: 'DEPRECATED',
      tenantId: TENANT_A,
      metadata: { deprecatedMessage: 'EOL' },
    };
    const skill = registryRecordToSkill(record, TENANT_A);
    expect(skill.deprecated).toBe(true);
    expect(skill.deprecated_message).toBe('EOL');
  });
});
