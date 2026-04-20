/**
 * AgentCore Registry — Chimera-side type model (Phase-0 adapter).
 *
 * These types are intentionally *purpose-built* for Chimera's dual-write
 * bridge code and the thin wrapper in `bedrock-registry-client.ts`. They do
 * NOT attempt to model every attribute the AWS SDK exposes. The rule is:
 * if we don't write or read it in the adapter, it doesn't live here.
 *
 * Upstream research: `docs/research/agentcore-rabbithole/01-registry-deep-dive.md`.
 * Migration context: `docs/reviews/wave4-registry-migration-delta.md`.
 */

/**
 * Registry record lifecycle status values we operate on.
 *
 * The full AgentCore lifecycle also includes `REJECTED`, but Chimera's
 * adapter never emits it (curators do, out-of-band). We deliberately omit
 * it here so every status a Chimera caller can *produce* is explicit.
 * Search results may still surface APPROVED or DEPRECATED only — see §4 of
 * the registry deep-dive for state transitions.
 */
export type RegistryRecordStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'DEPRECATED';

/**
 * A Chimera-shaped Registry record.
 *
 * `tenantId` is always carried explicitly as a record attribute. In the
 * "per-tenant registry" multi-tenancy option it is redundant (implied by
 * the registry ID), but we store it anyway so the `registryRecordToSkill`
 * mapper can fail closed if a stray cross-tenant record sneaks in — see
 * the cross-tenant defense in the mapper.
 */
export interface RegistrySkillRecord {
  /** Registry ARN or short ID this record belongs to. Always set. */
  registryId: string;
  /**
   * Record ID returned by `CreateRegistryRecord`. Undefined until the record
   * has been persisted (i.e. for client-side construction). Present on
   * read paths (`getRecord`, `searchRecords`).
   */
  recordId?: string;
  /** Record name. Maps to `Skill.name`. */
  name: string;
  /** Record version string. Maps to `Skill.version`. Must be non-empty. */
  version: string;
  /** Lifecycle status. */
  status: RegistryRecordStatus;
  /** Optional human-readable description. Maps to `Skill.description`. */
  description?: string;
  /**
   * Tenant that owns this record. Authoritative on round-trip: the mapper
   * refuses to emit a Skill whose record.tenantId doesn't match the caller's
   * expected tenantId. Phase-0 assumption only; Phase-2 spike may change
   * how tenancy is propagated (JWT claim vs. record attribute).
   */
  tenantId: string;
  /**
   * Arbitrary Chimera-side metadata. Stashed into the Registry record's
   * metadata/descriptor payload. Free-form by design — the Skill → Record
   * mapper decides which fields of `Skill` land here.
   */
  metadata: Record<string, unknown>;
}

/**
 * Paginated result shape for `SearchRegistryRecords` / `ListRegistryRecords`.
 */
export interface SearchRegistryRecordsResult {
  records: RegistrySkillRecord[];
  /**
   * Opaque pagination token the AWS SDK returns. Undefined when no further
   * pages are available.
   */
  nextToken?: string;
}

/**
 * Search filter fragment. AgentCore supports a rich filter expression
 * language; we only surface a minimal subset the adapter actually needs.
 * See §5 of the registry deep-dive for the full grammar.
 */
export interface RegistrySearchFilters {
  /** Restrict to a specific status (APPROVED in practice). */
  status?: RegistryRecordStatus;
  /** Restrict to records for a given tenant. */
  tenantId?: string;
}
