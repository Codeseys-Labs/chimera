/**
 * Skill schema round-trip tests.
 */

import { describe, expect, it } from 'bun:test';
import {
  SkillTrustLevelSchema,
  SkillCategorySchema,
  ScanStatusSchema,
  SkillSchema,
  SkillInstallSchema,
  InstallSkillRequestSchema,
  MCPGatewayRegistrationSchema,
  MCPServerConfigSchema,
  SkillPermissionsSchema,
} from '../schemas/skill';

const validSkill = {
  PK: 'SKILL#web-fetch',
  SK: 'VERSION#1.2.3',
  name: 'web-fetch',
  version: '1.2.3',
  author: 'tenant-platform',
  description: 'Fetch a URL and return its body.',
  category: 'developer-tools' as const,
  tags: ['http', 'fetch'],
  trust_level: 'platform' as const,
  permissions_hash: 'a'.repeat(64),
  signatures: {
    author: 'base64-ed25519-sig',
    platform: 'base64-ed25519-cosig',
  },
  bundle: {
    s3_key: 'skills/web-fetch/1.2.3.tar.gz',
    sha256: 'b'.repeat(64),
    size_bytes: 4096,
  },
  scan_status: 'passed' as const,
  download_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('SkillTrustLevelSchema', () => {
  it('accepts every documented trust level', () => {
    for (const lvl of ['platform', 'verified', 'community', 'private', 'experimental']) {
      expect(SkillTrustLevelSchema.parse(lvl)).toBe(lvl);
    }
  });

  it('rejects arbitrary strings', () => {
    expect(SkillTrustLevelSchema.safeParse('trusted-by-ceo').success).toBe(false);
  });
});

describe('SkillCategorySchema', () => {
  it('rejects an unknown category', () => {
    const result = SkillCategorySchema.safeParse('blockchain');
    expect(result.success).toBe(false);
  });
});

describe('ScanStatusSchema', () => {
  it('accepts all four canonical statuses', () => {
    for (const s of ['pending', 'passed', 'failed', 'quarantined']) {
      expect(ScanStatusSchema.parse(s)).toBe(s);
    }
  });
});

describe('SkillSchema', () => {
  it('parses a valid skill record round-trip', () => {
    const parsed = SkillSchema.parse(validSkill);
    expect(parsed).toEqual(validSkill);
  });

  it('rejects a negative download_count', () => {
    const result = SkillSchema.safeParse({ ...validSkill, download_count: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['download_count']);
    }
  });

  it('rejects an invalid trust_level', () => {
    const result = SkillSchema.safeParse({ ...validSkill, trust_level: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('rejects a rating_avg out of 0-5 range', () => {
    const result = SkillSchema.safeParse({ ...validSkill, rating_avg: 7.5 });
    expect(result.success).toBe(false);
  });

  it('accepts optional deprecated fields', () => {
    const parsed = SkillSchema.parse({
      ...validSkill,
      deprecated: true,
      deprecated_message: 'Use web-fetch-v2',
    });
    expect(parsed.deprecated).toBe(true);
  });
});

describe('SkillInstallSchema', () => {
  it('parses a valid install record', () => {
    const parsed = SkillInstallSchema.parse({
      PK: 'TENANT#t-1',
      SK: 'SKILL#web-fetch',
      tenant_id: 't-1',
      skill_name: 'web-fetch',
      version: '1.2.3',
      pinned: true,
      installed_at: '2026-01-01T00:00:00Z',
      installed_by: 'user-123',
      auto_update: false,
      use_count: 0,
    });
    expect(parsed.tenant_id).toBe('t-1');
  });
});

describe('InstallSkillRequestSchema', () => {
  it('accepts a minimal install request', () => {
    const parsed = InstallSkillRequestSchema.parse({
      tenant_id: 't-1',
      skill_name: 'web-fetch',
      installed_by: 'user-123',
    });
    expect(parsed.skill_name).toBe('web-fetch');
  });

  it('rejects when required installed_by is missing', () => {
    const result = InstallSkillRequestSchema.safeParse({
      tenant_id: 't-1',
      skill_name: 'web-fetch',
    });
    expect(result.success).toBe(false);
  });
});

describe('MCPServerConfigSchema', () => {
  it('accepts a stdio server config with tools list', () => {
    const parsed = MCPServerConfigSchema.parse({
      transport: 'stdio',
      command: 'uv',
      args: ['run', 'mcp-server'],
      tools: [{ name: 'fetch', description: 'fetch a url' }],
    });
    expect(parsed.transport).toBe('stdio');
  });

  it('rejects an unknown transport', () => {
    const result = MCPServerConfigSchema.safeParse({
      transport: 'grpc',
      tools: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('SkillPermissionsSchema', () => {
  it('accepts permissions with network=true shorthand', () => {
    const parsed = SkillPermissionsSchema.parse({
      network: true,
    });
    expect(parsed.network).toBe(true);
  });

  it('accepts permissions with explicit endpoint allowlist', () => {
    const parsed = SkillPermissionsSchema.parse({
      network: { endpoints: ['https://api.example.com'] },
    });
    expect(parsed.network).toEqual({ endpoints: ['https://api.example.com'] });
  });
});

describe('MCPGatewayRegistrationSchema', () => {
  it('rejects a registration with a non-enum trust_level', () => {
    const result = MCPGatewayRegistrationSchema.safeParse({
      tenant_id: 't-1',
      skill_name: 'web-fetch',
      mcp_config: {
        transport: 'stdio',
        tools: [{ name: 'fetch', description: 'fetch a url' }],
      },
      permissions: {},
      trust_level: 'super-verified',
    });
    expect(result.success).toBe(false);
  });
});
