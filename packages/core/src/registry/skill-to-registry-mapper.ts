/**
 * Pure mapping functions between Chimera's `Skill` (DDB-shaped) and the
 * `RegistrySkillRecord` we push to AgentCore Registry.
 *
 * Hard rules:
 *   1. No I/O. Pure functions only.
 *   2. Never silently drop data that the dual-write path later needs.
 *      Stash everything under `metadata` unless there's a first-class
 *      Registry field for it.
 *   3. Fail closed on cross-tenant records. A Registry round-trip must
 *      preserve `tenantId`; if a read returns a record whose tenantId
 *      doesn't match the caller's expected tenantId, that's a potential
 *      GSI-style cross-tenant leak and we refuse to produce a Skill.
 *      See failure-mode "GSI Cross-Tenant Data Leakage" in CLAUDE.md.
 */

import type { Skill } from '@chimera/shared';
import type { RegistrySkillRecord } from './types';

/** Thrown when the mapper refuses to produce a Skill from a record. */
export class CrossTenantRecordError extends Error {
  constructor(expected: string, actual: string, recordName: string) {
    super(
      `[registry-mapper] record '${recordName}' tenantId=${actual || '<empty>'} ` +
        `does not match expected=${expected}`
    );
    this.name = 'CrossTenantRecordError';
  }
}

/**
 * Chimera Skill → Registry record.
 *
 * The Chimera-specific fields that don't have a Registry equivalent
 * (trust_level, bundle, scan metadata, the original SKILL.md body, etc.)
 * are packaged under `metadata` so round-trip reconstruction is possible.
 *
 * Why separate `trustTier` from trust_level?  The Registry "descriptor
 * type" is orthogonal to Chimera's 5-tier trust ladder; we namespace
 * under `metadata.trustTier` to keep Chimera semantics clear.
 */
export function skillToRegistryRecord(
  skill: Skill,
  registryId: string,
  tenantId: string
): RegistrySkillRecord {
  if (!registryId) {
    throw new Error('[registry-mapper] registryId is required');
  }
  if (!tenantId) {
    throw new Error('[registry-mapper] tenantId is required');
  }
  if (!skill.name) {
    throw new Error('[registry-mapper] skill.name is required');
  }
  if (!skill.version) {
    throw new Error('[registry-mapper] skill.version is required');
  }

  // Status is a ladder: a just-scanned skill lands in DRAFT, the Chimera
  // approval lambda flips it to PENDING_APPROVAL, then curators approve.
  // A skill that carries `deprecated: true` immediately maps to DEPRECATED.
  const status: RegistrySkillRecord['status'] = skill.deprecated
    ? 'DEPRECATED'
    : 'DRAFT';

  const metadata: Record<string, unknown> = {
    trustTier: skill.trust_level,
    category: skill.category,
    tags: skill.tags,
    author: skill.author,
    permissionsHash: skill.permissions_hash,
    signatures: skill.signatures,
    bundle: skill.bundle,
    scanStatus: skill.scan_status,
    scanTimestamp: skill.scan_timestamp,
    scanResult: skill.scan_result,
    downloadCount: skill.download_count,
    ratingAvg: skill.rating_avg,
    ratingCount: skill.rating_count,
    createdAt: skill.created_at,
    updatedAt: skill.updated_at,
    deprecatedMessage: skill.deprecated_message,
    // We stash the original DDB primary key so an operator can trace a
    // Registry record back to its ChimeraDB origin during dual-write.
    ddbPK: skill.PK,
    ddbSK: skill.SK,
  };

  return {
    registryId,
    name: skill.name,
    version: skill.version,
    status,
    description: skill.description,
    tenantId,
    metadata,
  };
}

/**
 * Registry record → Chimera Skill.
 *
 * The inverse of `skillToRegistryRecord`, with one extra safety gate:
 * the caller may pass `expectedTenantId`. If set, the mapper throws
 * `CrossTenantRecordError` when the record's tenantId doesn't match.
 * This is our last line of defense against a cross-tenant leak should
 * Option B (shared registry) be chosen in Phase-2.
 *
 * Fields not stored in metadata (because they were never in Skill to
 * begin with on the write path) are filled with defensive defaults.
 */
export function registryRecordToSkill(
  record: RegistrySkillRecord,
  expectedTenantId?: string
): Skill {
  if (expectedTenantId && record.tenantId !== expectedTenantId) {
    throw new CrossTenantRecordError(expectedTenantId, record.tenantId, record.name);
  }
  if (!record.name) {
    throw new Error('[registry-mapper] record.name is required');
  }
  if (!record.version) {
    throw new Error('[registry-mapper] record.version is required');
  }

  const m = record.metadata ?? {};

  // Reconstruct DDB keys: prefer stashed originals, synthesize if absent.
  const pk = (m.ddbPK as string) || `SKILL#${record.name}`;
  const sk = (m.ddbSK as string) || `VERSION#${record.version}`;

  const skill: Skill = {
    PK: pk,
    SK: sk,
    name: record.name,
    version: record.version,
    author: (m.author as string) ?? record.tenantId,
    description: record.description ?? '',
    category: (m.category as Skill['category']) ?? 'developer-tools',
    tags: Array.isArray(m.tags) ? (m.tags as string[]) : [],
    trust_level: (m.trustTier as Skill['trust_level']) ?? 'experimental',
    permissions_hash: (m.permissionsHash as string) ?? '',
    signatures: (m.signatures as Skill['signatures']) ?? {},
    bundle: (m.bundle as Skill['bundle']) ?? { s3_key: '', sha256: '', size_bytes: 0 },
    scan_status: (m.scanStatus as Skill['scan_status']) ?? 'pending',
    scan_timestamp: m.scanTimestamp as string | undefined,
    scan_result: m.scanResult as Skill['scan_result'],
    download_count: typeof m.downloadCount === 'number' ? (m.downloadCount as number) : 0,
    rating_avg: m.ratingAvg as number | undefined,
    rating_count: m.ratingCount as number | undefined,
    created_at: (m.createdAt as string) ?? new Date(0).toISOString(),
    updated_at: (m.updatedAt as string) ?? new Date(0).toISOString(),
    deprecated: record.status === 'DEPRECATED' ? true : undefined,
    deprecated_message: m.deprecatedMessage as string | undefined,
  };

  return skill;
}
