/**
 * Registry Reader — Phase 2 dual-read helper for ADR-034 (Bedrock AgentCore Registry migration).
 *
 * This module is flag-gated so merging is safe: behavior is unchanged from today
 * unless BOTH of these env vars are set to "true" (or "1"):
 *   - REGISTRY_ENABLED         — master switch for Registry path participation
 *   - REGISTRY_PRIMARY_READ    — this PR's flag; when true, try Registry before DDB
 *
 * Contract (see docs/reviews/wave4-registry-migration-delta.md §"Phase 2 dual-read"):
 *   - trySearchRegistry() NEVER throws. All errors become {attempted: true, error, records: []}
 *     so the caller can emit a metric and fall back to DDB.
 *   - When the flag is off, returns {attempted: false} immediately with no SDK load.
 *   - Even in the per-tenant Registry model (one registry per tenant), we still apply
 *     a defence-in-depth tenantId filter on returned records. Harmless there; essential
 *     for the shared-Registry-with-tenant-scoped-records model (see Pattern B in
 *     docs/research/agentcore-rabbithole/01-registry-deep-dive.md §8).
 *
 * CloudWatch metrics (namespace "Chimera/Registry"):
 *   - RegistryReadSuccess   — Registry returned records successfully
 *   - RegistryReadFallback  — attempted but empty/misconfigured; caller will use DDB
 *   - RegistryReadError     — SDK or API call threw; caller will use DDB
 *
 * Metrics are emitted as CloudWatch EMF (Embedded Metric Format) log lines so no
 * additional permissions or PutMetricData calls are required — the Lambda log group
 * wired to an EMF subscription picks them up. See emitMetric() below.
 */

// ---------------------------------------------------------------------------
// Feature flag + config
// ---------------------------------------------------------------------------

export function isPrimaryRead() {
  const v = process.env.REGISTRY_PRIMARY_READ;
  if (v === 'true' || v === '1') {
    // REGISTRY_ENABLED is the master switch; PRIMARY_READ requires it too.
    const master = process.env.REGISTRY_ENABLED;
    return master === 'true' || master === '1';
  }
  return false;
}

export function getRegistryConfig() {
  return {
    registryId: process.env.REGISTRY_ID,
    region: process.env.REGISTRY_REGION || process.env.AWS_REGION,
  };
}

/**
 * Bootstrap invariant — fail fast at cold start on incoherent flags.
 * REGISTRY_PRIMARY_READ without REGISTRY_ENABLED, or either without REGISTRY_ID,
 * means the operator thought Registry was on when it isn't. Failing at module
 * load surfaces the misconfig in the Lambda init log instead of a silent drift
 * that only appears by scanning access patterns.
 * (ref: docs/reviews/wave7-safety-audit.md §Blocker #2)
 */
(function assertBootConfig() {
  const primaryRead = process.env.REGISTRY_PRIMARY_READ;
  const master = process.env.REGISTRY_ENABLED;
  const wantsPrimaryRead = primaryRead === 'true' || primaryRead === '1';
  const masterOn = master === 'true' || master === '1';

  if (wantsPrimaryRead && !masterOn) {
    throw new Error(
      '[registry-reader] REGISTRY_PRIMARY_READ=true requires REGISTRY_ENABLED=true. ' +
        'Failing fast at module load to avoid silent skip.'
    );
  }
  if (masterOn && !process.env.REGISTRY_ID) {
    throw new Error(
      '[registry-reader] REGISTRY_ENABLED=true requires REGISTRY_ID to be set. ' +
        'Failing fast at module load to avoid silent skip.'
    );
  }
})();

// ---------------------------------------------------------------------------
// Metrics (CloudWatch EMF)
// ---------------------------------------------------------------------------

/**
 * Structured metric emitter. Logs a CloudWatch EMF line to stdout so metric
 * filters / EMF ingestion produce counters without needing PutMetricData IAM.
 *
 * Exported for testability; callers should prefer the named helpers below.
 */
export function emitMetric(metricName, reason) {
  const payload = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'Chimera/Registry',
          Dimensions: [['Reason']],
          Metrics: [{ Name: metricName, Unit: 'Count' }],
        },
      ],
    },
    Reason: reason || 'unspecified',
    [metricName]: 1,
  };
  // One JSON log line — EMF is parsed by CloudWatch Logs automatically.
  console.log(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// SDK loader (lazy, never throws)
// ---------------------------------------------------------------------------

let _sdkModule = null;
let _sdkLoadFailed = false;

async function loadSdk() {
  if (_sdkModule) return _sdkModule;
  if (_sdkLoadFailed) return null;
  try {
    // Data plane client for Registry search.
    _sdkModule = await import('@aws-sdk/client-bedrock-agentcore');
    return _sdkModule;
  } catch (e) {
    _sdkLoadFailed = true;
    console.info(
      '[registry-reader] @aws-sdk/client-bedrock-agentcore not available — falling back to DDB',
      { message: e?.message },
    );
    return null;
  }
}

// Allow tests to inject a fake SDK module without touching the real import.
export function __setSdkForTest(mod) {
  _sdkModule = mod;
  _sdkLoadFailed = false;
}

export function __resetSdkForTest() {
  _sdkModule = null;
  _sdkLoadFailed = false;
}

// ---------------------------------------------------------------------------
// Client singleton (reused across invocations per AWS SDK v3 best practice)
// ---------------------------------------------------------------------------

let _client = null;

function getClient(sdk, region) {
  if (_client) return _client;
  const { BedrockAgentCoreClient } = sdk;
  _client = new BedrockAgentCoreClient({ region });
  return _client;
}

export function __resetClientForTest() {
  _client = null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Attempt to search the Registry for skills matching `query`, scoped to `tenantId`.
 *
 * @param {object} params
 * @param {string} [params.query]       Free-text search query. Empty string or missing
 *                                      means "list everything visible"; the caller
 *                                      should still cap with maxResults.
 * @param {string} params.tenantId      Required; used for defence-in-depth filter
 *                                      on returned records regardless of Registry model.
 * @param {number} [params.maxResults=50]
 *
 * @returns {Promise<
 *   | { attempted: false }
 *   | { attempted: true, records: object[], nextToken?: string }
 *   | { attempted: true, error: string, records: [] }
 * >}
 */
export async function trySearchRegistry({ query, tenantId, maxResults = 50 } = {}) {
  if (!isPrimaryRead()) {
    return { attempted: false };
  }

  const { registryId, region } = getRegistryConfig();
  if (!registryId) {
    console.warn(
      '[registry-reader] REGISTRY_PRIMARY_READ=true but REGISTRY_ID unset — falling back to DDB',
    );
    emitMetric('RegistryReadFallback', 'MissingRegistryId');
    return { attempted: false };
  }

  if (!tenantId) {
    // Defensive: caller should always pass tenantId. Treat as misconfigured,
    // don't leak un-scoped Registry results.
    console.warn('[registry-reader] tenantId missing — refusing to search Registry');
    emitMetric('RegistryReadFallback', 'MissingTenantId');
    return { attempted: false };
  }

  const sdk = await loadSdk();
  if (!sdk) {
    emitMetric('RegistryReadFallback', 'SdkUnavailable');
    return { attempted: false };
  }

  let client;
  try {
    client = getClient(sdk, region);
  } catch (e) {
    emitMetric('RegistryReadError', 'ClientConstruct');
    return { attempted: true, error: `client_construct_failed: ${e?.message}`, records: [] };
  }

  const { SearchRegistryRecordsCommand } = sdk;
  if (!SearchRegistryRecordsCommand) {
    emitMetric('RegistryReadError', 'CommandMissing');
    return {
      attempted: true,
      error: 'SearchRegistryRecordsCommand not found in SDK module',
      records: [],
    };
  }

  // Registry search query: per devguide, searchQuery must be 1–256 chars.
  // Empty string is not valid — substitute a wildcard-ish placeholder.
  const searchQuery = (query && String(query).trim()) || '*';

  const input = {
    registryIdentifier: registryId,
    searchQuery: searchQuery.slice(0, 256),
    maxResults: Math.min(Math.max(maxResults, 1), 20), // devguide: 1–20
  };

  let response;
  try {
    response = await client.send(new SearchRegistryRecordsCommand(input));
  } catch (e) {
    console.error('[registry-reader] SearchRegistryRecords failed', {
      message: e?.message,
      name: e?.name,
    });
    emitMetric('RegistryReadError', e?.name || 'SearchFailed');
    return { attempted: true, error: e?.message || 'search_failed', records: [] };
  }

  const rawRecords = Array.isArray(response?.records) ? response.records : [];

  // Defence-in-depth: filter by tenantId regardless of Registry model.
  // Records may expose tenantId as a top-level field, inside metadata, or
  // inside descriptorAttributes depending on how writers mapped it.
  const records = rawRecords.filter((r) => recordMatchesTenant(r, tenantId));

  if (records.length === 0 && rawRecords.length > 0) {
    // Registry returned data but none matched our tenant — possible cross-tenant
    // contamination or a tenantId schema mismatch. Emit a distinct reason.
    emitMetric('RegistryReadFallback', 'TenantFilterEmptied');
  } else if (records.length === 0) {
    emitMetric('RegistryReadFallback', 'NoRegistryMatches');
  } else {
    emitMetric('RegistryReadSuccess', 'SearchOk');
  }

  return {
    attempted: true,
    records,
    nextToken: response?.nextToken,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a Registry record belongs to the given tenant.
 *
 * Looks in multiple plausible locations so we're tolerant of schema evolution
 * between dual-write (Phase 1) and Registry-primary (Phase 4). If *no* tenantId
 * is found on the record, we REJECT it — fail-closed is the only safe default
 * for cross-tenant data.
 */
export function recordMatchesTenant(record, tenantId) {
  if (!record || !tenantId) return false;

  const candidates = [
    record.tenantId,
    record.TenantId,
    record.metadata?.tenantId,
    record.metadata?.TenantId,
    record.descriptorAttributes?.tenantId,
    record.descriptorAttributes?.TenantId,
    record.attributes?.tenantId,
    record.attributes?.TenantId,
  ];

  const found = candidates.find((v) => v != null && v !== '');
  if (found == null) return false;
  return String(found) === String(tenantId);
}
