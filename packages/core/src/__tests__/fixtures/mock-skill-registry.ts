/**
 * Mock skill registry for integration tests.
 *
 * Provides an in-memory implementation of the SkillRegistry DynamoDB
 * client interface, allowing integration tests to exercise skill
 * installation and discovery logic without real DynamoDB calls.
 *
 * Usage:
 *   import { createMockSkillRegistry, makeSkill } from './fixtures/mock-skill-registry';
 *   const { registry, ddb } = createMockSkillRegistry();
 *   const { seedSkill } = createMockSkillRegistry();
 *   seedSkill(makeSkill({ name: 'my-skill', version: '1.0.0' }));
 *   const skill = await registry.getSkill('my-skill', '1.0.0');
 */

import type { Skill } from '@chimera/shared';
import type { DynamoDBClient, RegistryConfig } from '../../skills/registry';
import { SkillRegistry } from '../../skills/registry';
import type {
  QueryCommandInput,
  QueryCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
  DeleteCommandInput,
  DeleteCommandOutput,
  GetCommandInput,
  GetCommandOutput,
  ScanCommandInput,
  ScanCommandOutput,
} from '@aws-sdk/lib-dynamodb';

// ---------------------------------------------------------------------------
// Shared $metadata stub required by all DynamoDB command outputs
// ---------------------------------------------------------------------------

const MOCK_METADATA = {
  httpStatusCode: 200,
  requestId: 'mock-request-id',
  attempts: 1,
  totalRetryDelay: 0,
};

// ---------------------------------------------------------------------------
// In-memory DynamoDB client stub
// ---------------------------------------------------------------------------

export class InMemoryDynamoDBClient implements DynamoDBClient {
  private items = new Map<string, Record<string, unknown>>();

  private itemKey(pk: string, sk: string) {
    return `${pk}#${sk}`;
  }

  async get(params: GetCommandInput): Promise<GetCommandOutput> {
    const pk = (params.Key as any)?.PK ?? '';
    const sk = (params.Key as any)?.SK ?? '';
    const item = this.items.get(this.itemKey(pk, sk));
    return { Item: item as any, $metadata: MOCK_METADATA };
  }

  async put(params: PutCommandInput): Promise<PutCommandOutput> {
    const pk = (params.Item as any)?.PK ?? '';
    const sk = (params.Item as any)?.SK ?? '';
    this.items.set(this.itemKey(pk, sk), { ...(params.Item as any) });
    return { $metadata: MOCK_METADATA };
  }

  async update(params: UpdateCommandInput): Promise<UpdateCommandOutput> {
    const pk = (params.Key as any)?.PK ?? '';
    const sk = (params.Key as any)?.SK ?? '';
    const existing = this.items.get(this.itemKey(pk, sk)) ?? { PK: pk, SK: sk };
    // Minimal SET expression parser for test purposes
    if ((params.UpdateExpression as string)?.startsWith('SET ')) {
      const names: Record<string, string> = (params.ExpressionAttributeNames as any) ?? {};
      const vals: Record<string, unknown> = (params.ExpressionAttributeValues as any) ?? {};
      const assignments = (params.UpdateExpression as string).slice(4).split(',').map((s: string) => s.trim());
      const updated: Record<string, unknown> = { ...existing };
      for (const assign of assignments) {
        const eqIdx = assign.indexOf('=');
        if (eqIdx === -1) continue;
        const lhsRaw = assign.slice(0, eqIdx).trim();
        const rhs = assign.slice(eqIdx + 1).trim();
        const fieldName = names[lhsRaw] ?? lhsRaw;
        updated[fieldName] = vals[rhs];
      }
      this.items.set(this.itemKey(pk, sk), updated);
    }
    return { $metadata: MOCK_METADATA };
  }

  async delete(params: DeleteCommandInput): Promise<DeleteCommandOutput> {
    const pk = (params.Key as any)?.PK ?? '';
    const sk = (params.Key as any)?.SK ?? '';
    this.items.delete(this.itemKey(pk, sk));
    return { $metadata: MOCK_METADATA };
  }

  async query(params: QueryCommandInput): Promise<QueryCommandOutput> {
    const pkCondition = (params.ExpressionAttributeValues as any)?.[':pk'] ?? '';
    const prefix = (params.ExpressionAttributeValues as any)?.[':sk'];

    const results = Array.from(this.items.values()).filter((item) => {
      if (item.PK !== pkCondition) return false;
      if (prefix && typeof item.SK === 'string') {
        return item.SK.startsWith(String(prefix));
      }
      return true;
    });

    return { Items: results as any[], $metadata: MOCK_METADATA };
  }

  async scan(_params: ScanCommandInput): Promise<ScanCommandOutput> {
    return { Items: Array.from(this.items.values()) as any[], $metadata: MOCK_METADATA };
  }

  /** Expose raw store for pre-seeding in tests */
  setItem(pk: string, sk: string, item: Record<string, unknown>) {
    this.items.set(this.itemKey(pk, sk), { PK: pk, SK: sk, ...item });
  }

  clearAll() {
    this.items.clear();
  }
}

// ---------------------------------------------------------------------------
// Skill builder helper — provides defaults for all required Skill fields
// ---------------------------------------------------------------------------

export function makeSkill(overrides: { name: string } & Partial<Omit<Skill, 'name'>>): Skill {
  const now = new Date().toISOString();
  const { name, ...rest } = overrides;
  const version = rest.version ?? '1.0.0';

  const base: Skill = {
    PK: `SKILL#${name}`,
    SK: `VERSION#${version}`,
    name,
    version,
    description: rest.description ?? `Mock skill: ${name}`,
    author: rest.author ?? 'test-author',
    category: rest.category ?? 'productivity',
    tags: rest.tags ?? [],
    trust_level: rest.trust_level ?? 'community',
    permissions_hash: rest.permissions_hash ?? 'mock-hash',
    signatures: rest.signatures ?? {},
    bundle: rest.bundle ?? {
      s3_key: `skills/${name}/${version}/bundle.zip`,
      sha256: 'mock-sha256',
      size_bytes: 0,
    },
    scan_status: rest.scan_status ?? 'pending',
    download_count: rest.download_count ?? 0,
    created_at: rest.created_at ?? now,
    updated_at: rest.updated_at ?? now,
  };

  return { ...base, ...rest, name, version, PK: base.PK, SK: base.SK };
}

// ---------------------------------------------------------------------------
// Factory: create an in-memory SkillRegistry for tests
// ---------------------------------------------------------------------------

export interface MockSkillRegistryResult {
  registry: SkillRegistry;
  ddb: InMemoryDynamoDBClient;
  /** Convenience helper: seed a skill into the registry's DynamoDB store */
  seedSkill(skill: Skill): void;
}

export function createMockSkillRegistry(
  overrides?: Partial<RegistryConfig>
): MockSkillRegistryResult {
  const ddb = new InMemoryDynamoDBClient();

  const config: RegistryConfig = {
    skillsTableName: 'test-skills',
    installsTableName: 'test-skill-installs',
    bundleBucket: 'test-skill-bundles',
    dynamodb: ddb,
    ...overrides,
  };

  const registry = new SkillRegistry(config);

  return {
    registry,
    ddb,
    seedSkill(skill: Skill) {
      ddb.setItem(skill.PK, skill.SK, skill as unknown as Record<string, unknown>);
    },
  };
}
