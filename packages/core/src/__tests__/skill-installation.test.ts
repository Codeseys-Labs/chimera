/**
 * Skill Installation Integration Tests
 *
 * Tests skill registry CRUD using the in-memory mock DynamoDB backend.
 * Validates that skill metadata can be stored and retrieved correctly
 * without requiring a real DynamoDB connection.
 */

import { describe, it, expect } from 'bun:test';
import { createMockSkillRegistry, makeSkill } from './fixtures/mock-skill-registry';

describe('Skill Registry — getSkill', () => {
  it('returns null for unknown skill', async () => {
    const { registry } = createMockSkillRegistry();
    const result = await registry.getSkill('nonexistent-skill', '1.0.0');
    expect(result).toBeNull();
  });

  it('returns seeded skill by name and version', async () => {
    const { registry, seedSkill } = createMockSkillRegistry();
    const skill = makeSkill({ name: 'code-review', version: '1.2.0' });
    seedSkill(skill);

    const found = await registry.getSkill('code-review', '1.2.0');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('code-review');
    expect(found!.version).toBe('1.2.0');
  });

  it('does not confuse different skill names', async () => {
    const { registry, seedSkill } = createMockSkillRegistry();
    seedSkill(makeSkill({ name: 'skill-a', version: '1.0.0' }));
    seedSkill(makeSkill({ name: 'skill-b', version: '1.0.0' }));

    const a = await registry.getSkill('skill-a', '1.0.0');
    const b = await registry.getSkill('skill-b', '1.0.0');
    expect(a!.name).toBe('skill-a');
    expect(b!.name).toBe('skill-b');
  });
});

describe('Skill Registry — listVersions', () => {
  it('returns empty array when no versions exist', async () => {
    const { registry } = createMockSkillRegistry();
    const versions = await registry.listVersions('unknown-skill');
    expect(versions).toEqual([]);
  });

  it('returns all seeded versions for a skill', async () => {
    const { registry, seedSkill } = createMockSkillRegistry();
    seedSkill(makeSkill({ name: 'my-skill', version: '1.0.0' }));
    seedSkill(makeSkill({ name: 'my-skill', version: '2.0.0' }));

    const versions = await registry.listVersions('my-skill');
    // At least both versions should be returned
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });
});

describe('mock-skill-registry fixture', () => {
  it('makeSkill fills in defaults', () => {
    const skill = makeSkill({ name: 'test' });
    expect(skill.version).toBe('1.0.0');
    expect(skill.description).toContain('test');
    expect(skill.author).toBeTruthy();
    expect(skill.trust_level).toBeTruthy();
    expect(skill.created_at).toBeTruthy();
  });

  it('makeSkill respects overrides', () => {
    const skill = makeSkill({ name: 'test', version: '3.0.0', author: 'alice' });
    expect(skill.version).toBe('3.0.0');
    expect(skill.author).toBe('alice');
  });

  it('InMemoryDynamoDBClient clearAll empties store', async () => {
    const { registry, ddb, seedSkill } = createMockSkillRegistry();
    seedSkill(makeSkill({ name: 'my-skill', version: '1.0.0' }));

    ddb.clearAll();

    const result = await registry.getSkill('my-skill', '1.0.0');
    expect(result).toBeNull();
  });
});
