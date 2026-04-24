/**
 * Zod schemas for skill boundary types.
 *
 * Skills cross trust boundaries at multiple points:
 *   1. Publish request (tenant-authored skill bundle → scanning pipeline)
 *   2. DynamoDB skill record (stored in `chimera-skills`, loaded on each
 *      install/search)
 *   3. MCP Gateway registration (runtime enforcement)
 *
 * These schemas mirror `../types/skill.ts`. Buffer-typed fields (e.g.
 * `PublishSkillRequest.skill_bundle`) are NOT modeled here — Zod does not
 * represent Node `Buffer` well at runtime, and bundles are validated by
 * SHA256+signature rather than shape. API callers should validate the
 * metadata envelope with these schemas and the bundle separately.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const SkillTrustLevelSchema = z.enum([
  'platform',
  'verified',
  'community',
  'private',
  'experimental',
]);

export const SkillFormatSchema = z.enum([
  'SKILL.md',
  'mcp',
  'strands-tool',
  'openclaw-skill',
]);

export const SkillCategorySchema = z.enum([
  'developer-tools',
  'communication',
  'productivity',
  'data-analysis',
  'security',
  'cloud-ops',
  'knowledge',
  'creative',
  'integration',
  'automation',
]);

export const ScanStatusSchema = z.enum([
  'pending',
  'passed',
  'failed',
  'quarantined',
]);

// ---------------------------------------------------------------------------
// Nested objects
// ---------------------------------------------------------------------------

export const SkillMetadataSchema = z.object({
  author: z.string(),
  description: z.string(),
  version: z.string(),
  tags: z.array(z.string()),
  category: SkillCategorySchema,
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
});

export const SkillPermissionsSchema = z.object({
  filesystem: z
    .object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
    })
    .optional(),
  network: z
    .union([
      z.boolean(),
      z.object({ endpoints: z.array(z.string()).optional() }),
    ])
    .optional(),
  shell: z
    .object({
      allowed: z.array(z.string()).optional(),
      denied: z.array(z.string()).optional(),
    })
    .optional(),
  memory: z
    .object({
      read: z.boolean().optional(),
      write: z.array(z.string()).optional(),
    })
    .optional(),
  secrets: z.array(z.string()).optional(),
});

export const SkillDependenciesSchema = z.object({
  skills: z.array(z.string()).optional(),
  mcp_servers: z
    .array(z.object({ name: z.string(), optional: z.boolean() }))
    .optional(),
  packages: z
    .object({
      pip: z.array(z.string()).optional(),
      npm: z.array(z.string()).optional(),
    })
    .optional(),
  binaries: z.array(z.string()).optional(),
  env_vars: z
    .object({
      required: z.array(z.string()).optional(),
      optional: z.array(z.string()).optional(),
    })
    .optional(),
});

export const MCPServerConfigSchema = z.object({
  transport: z.enum(['stdio', 'streamable-http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    })
  ),
});

export const MCPEndpointSchema = z.object({
  url: z.string(),
  authMethod: z.enum(['api-key', 'oauth', 'none']).optional(),
  credentialsArn: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const SkillTestCaseSchema = z.object({
  name: z.string(),
  input: z.string(),
  expect: z.object({
    tool_calls: z.array(z.string()).optional(),
    output_contains: z.array(z.string()).optional(),
    output_not_contains: z.array(z.string()).optional(),
  }),
});

export const SkillTestConfigSchema = z.object({
  model: z.string().optional(),
  cases: z.array(SkillTestCaseSchema),
});

export const SecurityScanResultSchema = z.object({
  scannedAt: z.string(),
  status: ScanStatusSchema,
  stages: z.object({
    static_analysis: z
      .object({
        passed: z.boolean(),
        findings: z.array(z.string()).optional(),
      })
      .optional(),
    dependency_audit: z
      .object({
        passed: z.boolean(),
        vulnerabilities: z.array(z.string()).optional(),
      })
      .optional(),
    sandbox_run: z
      .object({
        passed: z.boolean(),
        violations: z.array(z.string()).optional(),
      })
      .optional(),
    permission_validation: z
      .object({
        passed: z.boolean(),
        errors: z.array(z.string()).optional(),
      })
      .optional(),
    signing: z
      .object({
        passed: z.boolean(),
        author_sig: z.string().optional(),
        platform_sig: z.string().optional(),
      })
      .optional(),
    monitoring_config: z.object({ passed: z.boolean() }).optional(),
    community_review: z.object({ pending: z.boolean() }).optional(),
  }),
  scannerVersion: z.string(),
});

export const SkillSignaturesSchema = z.object({
  author: z.string().optional(),
  platform: z.string().optional(),
});

export const SkillBundleSchema = z.object({
  s3_key: z.string(),
  sha256: z.string(),
  size_bytes: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Top-level skill record
// ---------------------------------------------------------------------------

export const SkillSchema = z.object({
  // DynamoDB keys
  PK: z.string(),
  SK: z.string(),

  // Identity
  name: z.string().min(1),
  version: z.string().min(1),
  author: z.string(),
  description: z.string(),
  category: SkillCategorySchema,
  tags: z.array(z.string()),

  // Trust & Security
  trust_level: SkillTrustLevelSchema,
  permissions_hash: z.string(),
  signatures: SkillSignaturesSchema,

  // Storage
  bundle: SkillBundleSchema,

  // Security scanning
  scan_status: ScanStatusSchema,
  scan_timestamp: z.string().optional(),
  scan_result: SecurityScanResultSchema.optional(),

  // Analytics
  download_count: z.number().int().nonnegative(),
  rating_avg: z.number().min(0).max(5).optional(),
  rating_count: z.number().int().nonnegative().optional(),

  // Lifecycle
  created_at: z.string(),
  updated_at: z.string(),
  deprecated: z.boolean().optional(),
  deprecated_message: z.string().optional(),
});

export const SkillInstallSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  tenant_id: z.string(),
  skill_name: z.string(),
  version: z.string(),
  pinned: z.boolean(),
  installed_at: z.string(),
  installed_by: z.string(),
  auto_update: z.boolean(),
  last_used: z.string().optional(),
  use_count: z.number().int().nonnegative(),
});

export const InstallSkillRequestSchema = z.object({
  tenant_id: z.string(),
  skill_name: z.string(),
  version: z.string().optional(),
  pinned: z.boolean().optional(),
  auto_update: z.boolean().optional(),
  installed_by: z.string(),
});

export const InstallSkillResponseSchema = z.object({
  skill_name: z.string(),
  version: z.string(),
  installed_at: z.string(),
  status: z.enum(['success', 'error']),
  message: z.string().optional(),
});

export const SearchSkillsRequestSchema = z.object({
  query: z.string().optional(),
  category: SkillCategorySchema.optional(),
  trust_level: SkillTrustLevelSchema.optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const MCPGatewayRegistrationSchema = z.object({
  tenant_id: z.string(),
  skill_name: z.string(),
  mcp_config: MCPServerConfigSchema,
  permissions: SkillPermissionsSchema,
  trust_level: SkillTrustLevelSchema,
});
