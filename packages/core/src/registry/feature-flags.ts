/**
 * Feature flags for the AgentCore Registry migration (ADR-034).
 *
 * All flags default to OFF so merging this code does NOT change production
 * behavior. Each flag is read once per process from env vars so toggling
 * requires a deployment, not a hot-reload — this is deliberate for safety.
 *
 * Phases (from docs/reviews/wave4-registry-migration-delta.md):
 *   Phase 1 dual-write: REGISTRY_ENABLED=true
 *   Phase 2 dual-read:  + REGISTRY_PRIMARY_READ=true (fallback still on)
 *   Phase 3 bulk import: ad-hoc job
 *   Phase 4 registry-primary read: REGISTRY_PRIMARY_READ=true, fallback off
 *   Phase 5 writes-only-to-registry: DDB_WRITE_SKILLS_DISABLED=true
 *   Phase 6 delete DDB table (IRREVERSIBLE; manual CDK step)
 */

function readBool(name: string, defaultValue = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

export interface RegistryFeatureFlags {
  /** Write skill publish events to Registry alongside DDB (Phase 1+). */
  readonly registryEnabled: boolean;
  /** Read from Registry first, fallback to DDB on error/miss (Phase 2+). */
  readonly registryPrimaryRead: boolean;
  /** Stop writing skills to DDB entirely; Registry is sole source (Phase 5+). */
  readonly ddbWriteSkillsDisabled: boolean;
  /** Registry ID (ARN or short id) — required once registryEnabled is true. */
  readonly registryId: string | undefined;
  /** AWS region for Registry calls. Defaults to the process AWS_REGION. */
  readonly registryRegion: string | undefined;
}

export function loadRegistryFlags(
  env: NodeJS.ProcessEnv = process.env
): RegistryFeatureFlags {
  const _read = (n: string, d = false) => {
    const v = env[n];
    if (v === undefined || v === '') return d;
    return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
  };
  return {
    registryEnabled: _read('REGISTRY_ENABLED'),
    registryPrimaryRead: _read('REGISTRY_PRIMARY_READ'),
    ddbWriteSkillsDisabled: _read('DDB_WRITE_SKILLS_DISABLED'),
    registryId: env.REGISTRY_ID || undefined,
    registryRegion: env.REGISTRY_REGION || env.AWS_REGION || undefined,
  };
}

/** Default singleton, read from process.env at import time. */
export const registryFlags: RegistryFeatureFlags = loadRegistryFlags();

/**
 * Invariant check — call at boot to fail loudly if flags are misconfigured.
 * E.g., you can't enable primary-read without enabling writes first.
 */
export function assertFlagsConsistent(f: RegistryFeatureFlags = registryFlags): void {
  if (f.registryPrimaryRead && !f.registryEnabled) {
    throw new Error(
      '[registry-flags] REGISTRY_PRIMARY_READ=true requires REGISTRY_ENABLED=true'
    );
  }
  if (f.ddbWriteSkillsDisabled && !f.registryEnabled) {
    throw new Error(
      '[registry-flags] DDB_WRITE_SKILLS_DISABLED=true requires REGISTRY_ENABLED=true'
    );
  }
  if (f.registryEnabled && !f.registryId) {
    throw new Error(
      '[registry-flags] REGISTRY_ENABLED=true requires REGISTRY_ID to be set'
    );
  }
}

// Re-export readBool for symmetry/testing if other modules want the same helper.
export { readBool };
