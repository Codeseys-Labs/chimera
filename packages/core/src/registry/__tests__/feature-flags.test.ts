import { describe, it, expect } from 'vitest';
import { loadRegistryFlags, assertFlagsConsistent } from '../feature-flags';

describe('registry feature flags', () => {
  it('all flags default to false with undefined registryId', () => {
    const f = loadRegistryFlags({});
    expect(f.registryEnabled).toBe(false);
    expect(f.registryPrimaryRead).toBe(false);
    expect(f.ddbWriteSkillsDisabled).toBe(false);
    expect(f.registryId).toBeUndefined();
  });

  it('parses string truthy values', () => {
    const f = loadRegistryFlags({
      REGISTRY_ENABLED: 'true',
      REGISTRY_PRIMARY_READ: '1',
      DDB_WRITE_SKILLS_DISABLED: 'YES',
      REGISTRY_ID: 'arn:aws:bedrock-agentcore:us-west-2:123:registry/foo',
      REGISTRY_REGION: 'us-west-2',
    });
    expect(f.registryEnabled).toBe(true);
    expect(f.registryPrimaryRead).toBe(true);
    expect(f.ddbWriteSkillsDisabled).toBe(true);
    expect(f.registryId).toContain('registry/foo');
    expect(f.registryRegion).toBe('us-west-2');
  });

  it('rejects primaryRead without enabled', () => {
    expect(() =>
      assertFlagsConsistent({
        registryEnabled: false,
        registryPrimaryRead: true,
        ddbWriteSkillsDisabled: false,
        registryId: undefined,
        registryRegion: undefined,
      })
    ).toThrow(/REGISTRY_PRIMARY_READ=true requires REGISTRY_ENABLED=true/);
  });

  it('rejects ddb-disabled without enabled', () => {
    expect(() =>
      assertFlagsConsistent({
        registryEnabled: false,
        registryPrimaryRead: false,
        ddbWriteSkillsDisabled: true,
        registryId: undefined,
        registryRegion: undefined,
      })
    ).toThrow(/DDB_WRITE_SKILLS_DISABLED=true requires REGISTRY_ENABLED=true/);
  });

  it('rejects enabled without registryId', () => {
    expect(() =>
      assertFlagsConsistent({
        registryEnabled: true,
        registryPrimaryRead: false,
        ddbWriteSkillsDisabled: false,
        registryId: undefined,
        registryRegion: 'us-west-2',
      })
    ).toThrow(/requires REGISTRY_ID to be set/);
  });

  it('accepts a valid Phase-1 config', () => {
    expect(() =>
      assertFlagsConsistent({
        registryEnabled: true,
        registryPrimaryRead: false,
        ddbWriteSkillsDisabled: false,
        registryId: 'arn:aws:bedrock-agentcore:us-west-2:123:registry/foo',
        registryRegion: 'us-west-2',
      })
    ).not.toThrow();
  });
});
