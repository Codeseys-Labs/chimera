/**
 * ADR-034 Phase 1 — flag-gated Registry dual-write helper.
 *
 * Default behavior: when `REGISTRY_ENABLED` is unset/false, this module is a
 * no-op and does not import the AWS SDK. DDB remains the sole source of
 * truth in Phase 1.
 *
 * Invariant: `writeSkillToRegistryIfEnabled` MUST NOT throw. Registry
 * failures are logged, surfaced as CloudWatch metrics (RegistryWriteFailure),
 * and returned as `{ skipped: false, error }`. The DDB write is primary;
 * Registry is best-effort dual-write until Phase 4.
 *
 * Contract: see docs/reviews/wave4-registry-migration-delta.md §"Phase 1 dual-write"
 * API:      see docs/research/agentcore-rabbithole/01-registry-deep-dive.md §"API Surface"
 */

function isRegistryEnabled() {
  const v = process.env.REGISTRY_ENABLED;
  return v === '1' || v === 'true' || v === 'yes';
}

function getRegistryId() {
  return process.env.REGISTRY_ID || null;
}

/**
 * Bootstrap invariant — fail fast at cold start if the flags are in an
 * incoherent state. Silent no-ops on `REGISTRY_ENABLED=true` without
 * `REGISTRY_ID` cause drift that only shows up by scanning CloudWatch Logs.
 * Better to fail the Lambda at init so the operator sees the error in seconds.
 * (ref: docs/reviews/wave7-safety-audit.md §Blocker #2)
 */
(function assertBootConfig() {
  if (isRegistryEnabled() && !getRegistryId()) {
    throw new Error(
      '[registry-writer] REGISTRY_ENABLED=true requires REGISTRY_ID to be set. ' +
        'Failing fast at module load to avoid silent skip. Unset REGISTRY_ENABLED to disable.'
    );
  }
})();

function isAutoApproveEnabled() {
  const v = process.env.REGISTRY_AUTO_APPROVE;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Emit a CloudWatch EMF-formatted metric line to stdout. The Lambda runtime
 * auto-publishes EMF metrics from log output, so no PutMetricData IAM is
 * required. Failures here are swallowed (never throw).
 */
function emitRegistryWriteFailureMetric(reason) {
  try {
    const emf = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Chimera/SkillPipeline',
            Dimensions: [['Stage']],
            Metrics: [{ Name: 'RegistryWriteFailure', Unit: 'Count' }],
          },
        ],
      },
      Stage: 'SkillDeployment',
      RegistryWriteFailure: 1,
      reason: String(reason ?? 'unknown'),
    };
    console.log(JSON.stringify(emf));
  } catch {
    // never throw from metric emission
  }
}

/**
 * Build a CreateRegistryRecord payload from a skill descriptor.
 * Exported for unit testing.
 *
 * @param {object} skill   Normalized skill record produced by skill-deployment.
 * @param {string} registryId
 */
export function buildCreateRecordInput(skill, registryId) {
  const manifest = skill.manifest ?? {};
  const name = manifest.name ?? skill.skillId ?? 'unknown-skill';
  const description = manifest.description ?? '';
  const version = skill.version ?? manifest.version ?? '0.0.0';
  const author = manifest.author ?? 'unknown';
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];

  return {
    registryIdentifier: registryId,
    // Registry records are typed; Chimera skills map onto the CUSTOM descriptor.
    // See 01-registry-deep-dive §3.5 shared attributes.
    name,
    description,
    version,
    descriptorType: 'CUSTOM',
    descriptor: {
      customDescriptor: {
        // Embed the canonical Chimera skill descriptor. Consumers (MCP
        // discovery, evolution engine) read these via GetRegistryRecord.
        schemaVersion: '2025-12-11',
        skillId: skill.skillId,
        deploymentId: skill.deploymentId,
        bundleHash: skill.bundleHash ?? '',
        author,
        permissions,
        s3Location: skill.s3Key
          ? { bucket: skill.s3Bucket ?? '', key: skill.s3Key }
          : undefined,
        platformSignature: skill.platformSignature ?? '',
        deployedAt: skill.deployedAt,
      },
    },
    tags: {
      'chimera.skillId': skill.skillId ?? 'unknown',
      'chimera.version': version,
      'chimera.deploymentId': skill.deploymentId ?? '',
    },
  };
}

/**
 * Flag-gated Registry dual-write. Never throws.
 *
 * @param {object} skill    Skill descriptor from the skill-deployment Lambda.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]  If true, build the payload but do not call AWS.
 * @param {object}  [opts.sdkOverride]  Testing hook; inject SDK surface directly.
 * @returns {Promise<{skipped: boolean, reason?: string, recordId?: string, status?: string, error?: string}>}
 */
export async function writeSkillToRegistryIfEnabled(skill, opts = {}) {
  const { dryRun = false, sdkOverride = null } = opts;

  if (!isRegistryEnabled()) {
    return { skipped: true, reason: 'REGISTRY_ENABLED=false' };
  }

  const registryId = getRegistryId();
  if (!registryId) {
    console.warn('[registry-writer] REGISTRY_ENABLED=true but REGISTRY_ID unset — skipping');
    return { skipped: true, reason: 'REGISTRY_ID unset' };
  }

  // Dynamic import so module-load doesn't fail if the SDK package isn't
  // present in the Lambda's dependency closure. This keeps Phase 1 cutover
  // a single flag flip + redeploy.
  let BedrockAgentCoreControlClient, CreateRegistryRecordCommand,
      SubmitRegistryRecordForApprovalCommand, UpdateRegistryRecordStatusCommand;
  try {
    const sdk = sdkOverride ?? (await import('@aws-sdk/client-bedrock-agentcore-control'));
    BedrockAgentCoreControlClient = sdk.BedrockAgentCoreControlClient;
    CreateRegistryRecordCommand = sdk.CreateRegistryRecordCommand;
    SubmitRegistryRecordForApprovalCommand = sdk.SubmitRegistryRecordForApprovalCommand;
    UpdateRegistryRecordStatusCommand = sdk.UpdateRegistryRecordStatusCommand;
  } catch (err) {
    console.warn(
      '[registry-writer] AWS SDK client-bedrock-agentcore-control not installed; skipping write',
      err?.message ?? ''
    );
    return { skipped: true, reason: 'SDK not installed' };
  }

  if (!BedrockAgentCoreControlClient || !CreateRegistryRecordCommand) {
    console.warn('[registry-writer] SDK loaded but required exports missing; skipping write');
    return { skipped: true, reason: 'SDK exports missing' };
  }

  const input = buildCreateRecordInput(skill, registryId);

  if (dryRun) {
    return { skipped: false, dryRun: true, recordId: null, status: 'DRY_RUN' };
  }

  try {
    const client = new BedrockAgentCoreControlClient({});

    // 1. Create the record (enters DRAFT).
    const createResp = await client.send(new CreateRegistryRecordCommand(input));
    const recordId =
      createResp?.recordIdentifier ??
      createResp?.recordId ??
      createResp?.registryRecord?.recordIdentifier ??
      null;

    if (!recordId) {
      const reason = 'CreateRegistryRecord returned no recordIdentifier';
      console.error('[registry-writer]', reason, createResp);
      emitRegistryWriteFailureMetric(reason);
      return { skipped: false, error: reason };
    }

    // 2. Submit for approval (DRAFT → PENDING_APPROVAL).
    if (SubmitRegistryRecordForApprovalCommand) {
      try {
        await client.send(
          new SubmitRegistryRecordForApprovalCommand({
            registryIdentifier: registryId,
            recordIdentifier: recordId,
          })
        );
      } catch (submitErr) {
        const reason = `SubmitRegistryRecordForApproval failed: ${submitErr?.message ?? submitErr}`;
        console.error('[registry-writer]', reason);
        emitRegistryWriteFailureMetric(reason);
        // DRAFT record exists in Registry; DDB is still source of truth.
        return { skipped: false, recordId, status: 'DRAFT', error: reason };
      }
    }

    let finalStatus = 'PENDING_APPROVAL';

    // 3. Optional auto-approve (Phase 1 dev tenants only; guarded by flag).
    //    The scanning pipeline already ran stages 1-6 — if REGISTRY_AUTO_APPROVE
    //    is on, the operator has decided that pipeline-pass ⇒ APPROVED.
    if (isAutoApproveEnabled() && UpdateRegistryRecordStatusCommand) {
      try {
        await client.send(
          new UpdateRegistryRecordStatusCommand({
            registryIdentifier: registryId,
            recordIdentifier: recordId,
            status: 'APPROVED',
          })
        );
        finalStatus = 'APPROVED';
      } catch (approveErr) {
        const reason = `UpdateRegistryRecordStatus(APPROVED) failed: ${approveErr?.message ?? approveErr}`;
        console.error('[registry-writer]', reason);
        emitRegistryWriteFailureMetric(reason);
        // Record is PENDING_APPROVAL; not a hard failure for the Lambda.
        return { skipped: false, recordId, status: 'PENDING_APPROVAL', error: reason };
      }
    }

    console.log(
      '[registry-writer] dual-write OK skillId=%s recordId=%s status=%s',
      skill.skillId,
      recordId,
      finalStatus
    );
    return { skipped: false, recordId, status: finalStatus };
  } catch (err) {
    const reason = `CreateRegistryRecord failed: ${err?.message ?? err}`;
    console.error('[registry-writer]', reason);
    emitRegistryWriteFailureMetric(reason);
    return { skipped: false, error: reason };
  }
}

// Exposed for tests.
export const __internal = {
  isRegistryEnabled,
  getRegistryId,
  isAutoApproveEnabled,
  emitRegistryWriteFailureMetric,
};
