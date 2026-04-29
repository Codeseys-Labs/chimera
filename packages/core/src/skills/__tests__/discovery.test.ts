/**
 * Skill Discovery Tests
 *
 * Focus: tenant-isolation enforcement on semantic and keyword search paths.
 * If `enableSemanticSearch=true` and a single Bedrock KB indexes docs from
 * multiple tenants, `SkillDiscovery.search()` must push a tenant_id filter
 * down to the KB retrieve call — otherwise tenant A can retrieve tenant B
 * documents (SEC-1, Wave-33 memory-isolation audit).
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  SkillDiscovery,
  type BedrockKBClient,
  type OpenSearchClient,
} from '../discovery';
import { SkillRegistry } from '../registry';

function makeRegistryStub(): SkillRegistry {
  return {
    getSkill: mock(async () => null),
  } as unknown as SkillRegistry;
}

describe('SkillDiscovery — tenant isolation', () => {
  describe('semanticSearch (Bedrock KB)', () => {
    let kbQuery: ReturnType<typeof mock>;
    let kbClient: BedrockKBClient;
    let discovery: SkillDiscovery;

    beforeEach(() => {
      kbQuery = mock(async () => ({ retrievalResults: [] }));
      kbClient = { query: kbQuery } as unknown as BedrockKBClient;
      discovery = new SkillDiscovery({
        registry: makeRegistryStub(),
        knowledgeBaseId: 'KB-TEST',
        enableSemanticSearch: true,
      });
      discovery.setBedrockKB(kbClient);
    });

    it('pushes tenant_id filter into vectorSearchConfiguration.filter', async () => {
      await discovery.search('find a code review skill', 'tenant-A', undefined, 5);

      expect(kbQuery).toHaveBeenCalledTimes(1);
      const [callArg] = kbQuery.mock.calls[0] as [any];

      const vsc = callArg?.retrievalConfiguration?.vectorSearchConfiguration;
      expect(vsc).toBeDefined();
      expect(vsc.numberOfResults).toBe(5);
      expect(vsc.filter).toBeDefined();
      expect(vsc.filter).toEqual({
        equals: { key: 'tenant_id', value: 'tenant-A' },
      });
    });

    it('uses the caller tenantId — not a hard-coded value — across tenants', async () => {
      await discovery.search('q', 'tenant-A', undefined, 10);
      await discovery.search('q', 'tenant-B', undefined, 10);

      const firstFilter =
        (kbQuery.mock.calls[0][0] as any).retrievalConfiguration
          .vectorSearchConfiguration.filter;
      const secondFilter =
        (kbQuery.mock.calls[1][0] as any).retrievalConfiguration
          .vectorSearchConfiguration.filter;

      expect(firstFilter.equals.value).toBe('tenant-A');
      expect(secondFilter.equals.value).toBe('tenant-B');
    });

    it('filters out KB results whose metadata tenant_id does not match the caller (defense-in-depth)', async () => {
      // Simulate a KB that (somehow) returned a document tagged for tenant-B
      // to a tenant-A caller. Even if the upstream filter leaked, discovery
      // must drop mismatched metadata.
      kbQuery = mock(async () => ({
        retrievalResults: [
          {
            metadata: { skill_name: 'leaked-skill', tenant_id: 'tenant-B' },
            content: { text: 'leaked doc' },
            score: 0.99,
          },
        ],
      }));
      const leakyClient = { query: kbQuery } as unknown as BedrockKBClient;
      const registry = {
        getSkill: mock(async () => ({
          name: 'leaked-skill',
          description: '',
          tags: [],
          category: 'developer-tools',
          trust_level: 'verified',
          author: 'x',
          download_count: 0,
        })),
      } as unknown as SkillRegistry;

      const d = new SkillDiscovery({
        registry,
        knowledgeBaseId: 'KB-TEST',
        enableSemanticSearch: true,
      });
      d.setBedrockKB(leakyClient);

      const results = await d.search('q', 'tenant-A', undefined, 10);
      expect(results).toHaveLength(0);
    });

    it('rejects empty tenantId on the public entry point', async () => {
      await expect(discovery.search('q', '', undefined, 5)).rejects.toThrow(
        /tenantId is required/
      );
    });

    it('rejects empty tenantId on direct semanticSearch() calls', async () => {
      await expect(
        discovery.semanticSearch('q', '', undefined, 5)
      ).rejects.toThrow(/tenantId is required/);
    });
  });

  describe('openSearchQuery (keyword path)', () => {
    it('adds a tenant_id term clause to the bool.must array', async () => {
      const searchFn = mock(async () => ({ hits: { hits: [] } }));
      const osClient = { search: searchFn } as unknown as OpenSearchClient;

      const discovery = new SkillDiscovery({
        registry: makeRegistryStub(),
        openSearchEndpoint: 'https://os.example.local',
      });
      discovery.setOpenSearch(osClient);

      await discovery.search('find something', 'tenant-A', undefined, 5);

      expect(searchFn).toHaveBeenCalledTimes(1);
      const [arg] = searchFn.mock.calls[0] as [any];
      const must = arg?.body?.query?.bool?.must;
      expect(Array.isArray(must)).toBe(true);

      const tenantClause = must.find(
        (c: any) => c?.term?.tenant_id !== undefined
      );
      expect(tenantClause).toBeDefined();
      expect(tenantClause.term.tenant_id).toBe('tenant-A');
    });
  });
});
