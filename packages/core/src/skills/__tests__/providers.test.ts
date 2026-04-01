/**
 * Tests for skill providers: InstructionProvider, MCPProvider, HybridProvider
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { InstructionProvider } from '../instruction-provider';
import { MCPProvider } from '../mcp-provider';
import { HybridProvider } from '../hybrid-provider';
import type { InstructionProviderConfig, MCPProviderConfig, HybridProviderConfig } from '../provider';
import type { MCPGatewayClient } from '../mcp-gateway-client';
import type { SkillRegistry } from '../registry';

// ─── Fakes ───────────────────────────────────────────────────────────────────

function makeFakeRegistry(skills: Record<string, any>): SkillRegistry {
  return {
    getInstalledSkills: async (_tenantId: string) =>
      Object.keys(skills).map(name => ({ skill_name: name })),
    getSkill: async (name: string) => skills[name] ?? null,
  } as unknown as SkillRegistry;
}

function makeFakeGatewayClient(
  targets: Array<{ target_name: string; tools: Array<{ name: string; description: string }> }>
): MCPGatewayClient {
  return {
    listTargets: async (_tenantId: string) => targets,
    getTargetStatus: async (_tenantId: string, targetName: string) => {
      const found = targets.find(t => t.target_name === targetName);
      return { status: found ? 'active' : 'error', message: found ? undefined : 'not found' };
    },
  } as unknown as MCPGatewayClient;
}

// ─── InstructionProvider ─────────────────────────────────────────────────────

describe('InstructionProvider', () => {
  let config: InstructionProviderConfig;

  beforeEach(() => {
    config = {
      tenantId: 'tenant-001',
      registry: makeFakeRegistry({
        'git-helper': {
          name: 'git-helper',
          version: '1.0.0',
          description: 'Git helper skill',
          author: 'platform',
          trust_level: 'platform',
          bundle: { s3_key: 'skills/git-helper/1.0.0/bundle.zip' },
        },
      }),
    };
  });

  it('has type "instruction"', () => {
    const provider = new InstructionProvider(config);
    expect(provider.type).toBe('instruction');
  });

  it('initialize and cleanup are no-ops', async () => {
    const provider = new InstructionProvider(config);
    await expect(provider.initialize()).resolves.toBeUndefined();
    await expect(provider.cleanup()).resolves.toBeUndefined();
  });

  it('listTools returns empty array', async () => {
    const provider = new InstructionProvider(config);
    const tools = await provider.listTools();
    expect(tools).toHaveLength(0);
  });

  it('discoverSkills returns installed instruction-based skills', async () => {
    const provider = new InstructionProvider(config);
    const skills = await provider.discoverSkills();
    // git-helper is instruction-based (no mcp_server in its SKILL.md)
    expect(skills.some(s => s.name === 'git-helper')).toBe(true);
  });

  it('loadSkill throws for unknown skill', async () => {
    const provider = new InstructionProvider(config);
    await expect(provider.loadSkill('unknown-skill')).rejects.toThrow('Skill not found');
  });

  it('loadSkill returns skill definition for known skill', async () => {
    const provider = new InstructionProvider(config);
    const skill = await provider.loadSkill('git-helper');
    expect(skill.name).toBe('git-helper');
    expect(skill.version).toBe('1.0.0');
  });

  it('executeSkill returns instruction content', async () => {
    const provider = new InstructionProvider(config);
    const result = await provider.executeSkill('git-helper', {});
    expect(result.skillName).toBe('git-helper');
    expect(result.isError).toBe(false);
  });

  it('executeSkill returns error result for unknown skill', async () => {
    const provider = new InstructionProvider(config);
    const result = await provider.executeSkill('no-such-skill', {});
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('SKILL_LOAD_FAILED');
  });

  it('invoke returns not-invocable error (use skill-bridge instead)', async () => {
    const provider = new InstructionProvider(config);
    const result = await provider.invoke({
      id: 'inv-1',
      toolName: 'git-helper',
      input: {},
      context: { tenantId: 'tenant-001', userId: 'user-1', sessionId: 'sess-1' },
    });
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('INSTRUCTION_SKILL_NOT_INVOCABLE');
  });
});

// ─── MCPProvider ─────────────────────────────────────────────────────────────

describe('MCPProvider', () => {
  let config: MCPProviderConfig;

  beforeEach(() => {
    config = {
      tenantId: 'tenant-001',
      gatewayClient: makeFakeGatewayClient([
        {
          target_name: 'skill-code-review',
          tools: [
            { name: 'review_code', description: 'Review source code' },
            { name: 'suggest_refactor', description: 'Suggest refactors' },
          ],
        },
        {
          target_name: 'non-skill-target',  // Should be filtered out
          tools: [],
        },
      ]),
    };
  });

  it('has type "mcp"', () => {
    const provider = new MCPProvider(config);
    expect(provider.type).toBe('mcp');
  });

  it('initialize marks provider as ready, cleanup resets it', async () => {
    const provider = new MCPProvider(config);
    await provider.initialize();
    // invoke after init should work
    const result = await provider.invoke({
      id: 'inv-1',
      toolName: 'review_code',
      input: {},
      context: { tenantId: 'tenant-001', userId: 'user-1', sessionId: 'sess-1' },
    });
    expect(result.isError).toBe(false);

    await provider.cleanup();
    // invoke after cleanup should fail
    const result2 = await provider.invoke({
      id: 'inv-2',
      toolName: 'review_code',
      input: {},
      context: { tenantId: 'tenant-001', userId: 'user-1', sessionId: 'sess-1' },
    });
    expect(result2.isError).toBe(true);
    expect(result2.error?.code).toBe('PROVIDER_NOT_INITIALISED');
  });

  it('discoverSkills returns only skill-prefixed targets', async () => {
    const provider = new MCPProvider(config);
    const skills = await provider.discoverSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('code-review');
    expect(skills[0].implementation.type).toBe('mcp_server');
  });

  it('discoverSkills populates tool list from gateway', async () => {
    const provider = new MCPProvider(config);
    const [skill] = await provider.discoverSkills();
    expect(skill.implementation.mcpServer?.tools).toHaveLength(2);
    expect(skill.implementation.mcpServer?.tools[0].name).toBe('review_code');
  });

  it('loadSkill returns skill definition for known skill', async () => {
    const provider = new MCPProvider(config);
    const skill = await provider.loadSkill('code-review');
    expect(skill.name).toBe('code-review');
    expect(skill.implementation.type).toBe('mcp_server');
  });

  it('loadSkill throws for skill not in gateway', async () => {
    const provider = new MCPProvider(config);
    await expect(provider.loadSkill('missing-skill')).rejects.toThrow();
  });

  it('executeSkill returns stub content', async () => {
    const provider = new MCPProvider(config);
    const result = await provider.executeSkill('code-review', { toolName: 'review_code', file: 'main.ts' });
    expect(result.skillName).toBe('code-review');
    expect(result.isError).toBe(false);
    expect(result.content).toContain('[MCP stub]');
    expect(result.content).toContain('review_code');
  });

  it('listTools returns tools from skillDefinition when provided', async () => {
    const configWithSkill: MCPProviderConfig = {
      ...config,
      skillDefinition: {
        name: 'code-review',
        version: '1.0.0',
        description: 'Code review skill',
        author: 'platform',
        trustLevel: 'platform',
        format: 'mcp',
        implementation: {
          type: 'mcp_server',
          mcpServer: {
            transport: 'http',
            tools: [
              { name: 'review_code', description: 'Review code', parameters: [] },
            ],
          },
        },
        source: { platform: 'mcp', formatVersion: 'v1', importedAt: new Date().toISOString() },
      },
    };

    const provider = new MCPProvider(configWithSkill);
    const tools = await provider.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('review_code');
  });
});

// ─── HybridProvider ───────────────────────────────────────────────────────────

describe('HybridProvider', () => {
  let config: HybridProviderConfig;

  beforeEach(() => {
    config = {
      mcpConfig: {
        tenantId: 'tenant-001',
        gatewayClient: makeFakeGatewayClient([
          {
            target_name: 'skill-api-client',
            tools: [{ name: 'call_api', description: 'Call external API' }],
          },
        ]),
      },
      instructionConfig: {
        tenantId: 'tenant-001',
        registry: makeFakeRegistry({
          'git-helper': {
            name: 'git-helper',
            version: '1.0.0',
            description: 'Git helper skill',
            author: 'platform',
            trust_level: 'platform',
            bundle: {},
          },
        }),
      },
    };
  });

  it('has type "hybrid"', () => {
    const provider = new HybridProvider(config);
    expect(provider.type).toBe('hybrid');
  });

  it('initialize and cleanup delegate to sub-providers without error', async () => {
    const provider = new HybridProvider(config);
    await expect(provider.initialize()).resolves.toBeUndefined();
    await expect(provider.cleanup()).resolves.toBeUndefined();
  });

  it('discoverSkills merges from both MCP and instruction backends', async () => {
    const provider = new HybridProvider(config);
    const skills = await provider.discoverSkills();

    const names = skills.map(s => s.name);
    // api-client from MCP, git-helper from instruction
    expect(names).toContain('api-client');
    expect(names).toContain('git-helper');
  });

  it('instruction skills take precedence over MCP skills with the same name', async () => {
    // Add a skill with the same name in both backends
    const overlappingConfig: HybridProviderConfig = {
      mcpConfig: {
        tenantId: 'tenant-001',
        gatewayClient: makeFakeGatewayClient([
          { target_name: 'skill-shared-skill', tools: [] },
        ]),
      },
      instructionConfig: {
        tenantId: 'tenant-001',
        registry: makeFakeRegistry({
          'shared-skill': {
            name: 'shared-skill',
            version: '2.0.0',
            description: 'Instruction version',
            author: 'platform',
            trust_level: 'platform',
            bundle: {},
          },
        }),
      },
    };

    const provider = new HybridProvider(overlappingConfig);
    const skills = await provider.discoverSkills();
    const shared = skills.find(s => s.name === 'shared-skill');
    expect(shared).toBeDefined();
    // Instruction provider wins — it parses SKILL.md with richer metadata
    expect(shared?.format).not.toBe('mcp');
  });

  it('loadSkill returns instruction skill when available', async () => {
    const provider = new HybridProvider(config);
    const skill = await provider.loadSkill('git-helper');
    expect(skill.name).toBe('git-helper');
  });

  it('loadSkill falls back to MCP when instruction registry has no match', async () => {
    const provider = new HybridProvider(config);
    const skill = await provider.loadSkill('api-client');
    expect(skill.name).toBe('api-client');
    expect(skill.implementation.type).toBe('mcp_server');
  });

  it('loadSkill throws when skill is in neither backend', async () => {
    const provider = new HybridProvider(config);
    await expect(provider.loadSkill('no-such-skill')).rejects.toThrow();
  });

  it('executeSkill routes instruction skills to InstructionProvider', async () => {
    const provider = new HybridProvider(config);
    const result = await provider.executeSkill('git-helper', {});
    expect(result.skillName).toBe('git-helper');
    expect(result.isError).toBe(false);
  });

  it('executeSkill routes MCP skills to MCPProvider', async () => {
    const provider = new HybridProvider(config);
    const result = await provider.executeSkill('api-client', { toolName: 'call_api' });
    expect(result.skillName).toBe('api-client');
    expect(result.isError).toBe(false);
    expect(result.content).toContain('[MCP stub]');
  });

  it('executeSkill returns error when skill cannot be found', async () => {
    const provider = new HybridProvider(config);
    const result = await provider.executeSkill('ghost-skill', {});
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('SKILL_LOAD_FAILED');
  });
});
