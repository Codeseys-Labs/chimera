---
title: "AgentCore Registry Migration — Operator Guide"
status: living
last_updated: 2026-04-18
---

# Registry Migration — Operator Guide

## What this is

Phase 0-1 scaffolding for the AgentCore Registry migration has landed on `main` behind feature flags that default to off. No production behavior changes until an operator explicitly flips a flag on a specific Lambda; Phase 2+ enablement additionally requires the Phase-2 spike (`docs/designs/agentcore-registry-spike.md`) to close with an evidence-backed multi-tenancy decision.

This document is the runbook for the operator who needs to either enable Phase 1 dual-write on a dev tenant, exercise Phase 2 dual-read in dev, or roll back a mis-flipped flag.

## Feature flags (env vars)

All flags are read by `packages/core/src/registry/feature-flags.ts`. The skill-deployment Lambda and the skills-api Lambda are the only two runtime consumers today.

| Name | Default | Purpose |
|------|---------|---------|
| `REGISTRY_ENABLED` | unset (off) | Phase 1: dual-write to Registry alongside DDB from the skill-deployment Lambda |
| `REGISTRY_PRIMARY_READ` | unset (off) | Phase 2/4: read from Registry first, fall back to DDB on error or empty result |
| `DDB_WRITE_SKILLS_DISABLED` | unset (off) | Phase 5: stop writing to DDB entirely; Registry becomes the sole source of truth |
| `REGISTRY_ID` | unset | Required once `REGISTRY_ENABLED=true` — the registry ARN or ID the adapter targets |
| `REGISTRY_REGION` | = `AWS_REGION` | Optional override for the AWS region the Registry SDK client uses |

Flag truthiness: any non-empty value other than `0`, `false`, `no`, `off` is treated as on. The adapter refuses to run when `REGISTRY_ENABLED=true` and `REGISTRY_ID` is unset — this is fail-closed behavior.

Phase ordering matters. `DDB_WRITE_SKILLS_DISABLED` must never be set before `REGISTRY_ENABLED` has been on long enough to populate Registry with every record DDB holds (that's what Phase 3's bulk migration exists for). Setting `DDB_WRITE_SKILLS_DISABLED=true` with an empty Registry silently drops new writes on the floor.

Flags are per-Lambda, not per-tenant. Phase 1 flips the skill-deployment Lambda globally; Phase 2 flips the skills-api Lambda globally. Per-tenant rollout requires separate Lambda function copies or in-code tenant allowlisting, neither of which is wired up in this baseline.

## Enabling Phase 1 (dual-write) on dev

Pre-requisites: AWS CLI credentials for the dev account, permission to modify the skill-deployment Lambda's environment, and IAM grants on the Lambda's execution role for `bedrock-agentcore-control:CreateRegistryRecord`, `bedrock-agentcore-control:SubmitRegistryRecordForApproval`, `bedrock-agentcore-control:UpdateRegistryRecordStatus`, and `bedrock-agentcore-control:GetRegistryRecord` scoped to the target registry ARN. If those grants are missing, Phase 1 will emit `RegistryWriteFailure` on every publish.

1. **Create a Registry in the dev account.** Use the AWS CLI directly; there is no CDK construct for this yet (Phase 0 is adapter-only, not a full stack):
   ```bash
   aws bedrock-agentcore-control create-registry \
     --name chimera-dev-registry \
     --description "Chimera dev Registry for Phase 1 dual-write exercise" \
     --tags Key=Purpose,Value=registry-phase1,Key=Environment,Value=dev
   ```
   Record the returned `registryId` / ARN.

2. **Put the registryId + region into tenant-facing SSM.** The Lambda reads its env from CDK synth; for an ad-hoc dev flip, staging the value in SSM under `/chimera/dev/registry/id` makes it discoverable by operators and reversible without a redeploy:
   ```bash
   aws ssm put-parameter --name /chimera/dev/registry/id --type String \
     --value "<registryId-from-step-1>" --overwrite
   aws ssm put-parameter --name /chimera/dev/registry/region --type String \
     --value "us-east-1" --overwrite
   ```

3. **Set env vars on the `skill-deployment` Lambda.** In the dev stack:
   ```bash
   aws lambda update-function-configuration \
     --function-name chimera-dev-skill-deployment \
     --environment "Variables={REGISTRY_ENABLED=true,REGISTRY_ID=<registryId>,REGISTRY_REGION=us-east-1}"
   ```
   The Lambda uses dynamic import for the `@aws-sdk/client-bedrock-agentcore*` packages; if those packages are not yet in `package.json`, the adapter logs a `RegistryWriteFailure` and the Lambda continues with DDB-only writes (see "Known limitations" below).

4. **Verify.** Publish a test skill through the full 7-stage pipeline. Confirm it lands in both places:
   - DDB: `aws dynamodb get-item --table-name chimera-skills --key '{"pk":{"S":"SKILL#<id>"},"sk":{"S":"PROFILE"}}'` returns the record.
   - Registry: `aws bedrock-agentcore-control get-registry-record --registry-id <registryId> --record-id <id>` returns the record in DRAFT or PENDING_APPROVAL.
   - CloudWatch: the `Chimera/Registry/RegistryWriteFailure` metric should be 0 for the publish window.

5. **Rollback.** Unset `REGISTRY_ENABLED` on the Lambda and redeploy. Time-to-revert: < 5 minutes.
   ```bash
   aws lambda update-function-configuration \
     --function-name chimera-dev-skill-deployment \
     --environment "Variables={}"   # or re-apply prior env without REGISTRY_ENABLED
   ```
   DDB writes continue uninterrupted. Any records already written to Registry remain; they can be left in place or deleted via `delete-registry-record`.

## Enabling Phase 2 (dual-read) on dev

Pre-requisites: Phase 1 has been running on the same dev account for at least 24 hours; IAM grants on the skills-api Lambda's execution role for `bedrock-agentcore:SearchRegistryRecords` and `bedrock-agentcore-control:GetRegistryRecord` scoped to the target registry ARN.

**BLOCKED ON SPIKE — do not enable in production.** Phase 2 production enablement is gated on `docs/designs/agentcore-registry-spike.md` resolving the multi-tenancy model. In dev, Phase 2 dual-read is safe to *exercise* against synthetic data:

1. **Ensure Phase 1 dual-write has populated Registry with enough records.** At minimum, run Phase 1 for 24 hours on dev so the Registry has a representative set of APPROVED records. Registry's search index is eventually consistent (see `docs/research/agentcore-rabbithole/01-registry-deep-dive.md` §5.4) — a cold Registry returns empty results even when records exist in DDB.

2. **Set env vars on the `skills-api` Lambda.**
   ```bash
   aws lambda update-function-configuration \
     --function-name chimera-dev-skills-api \
     --environment "Variables={REGISTRY_PRIMARY_READ=true,REGISTRY_ID=<registryId>,REGISTRY_REGION=us-east-1}"
   ```

3. **Verify.** Call the discovery endpoint (`GET /api/v1/tenants/{id}/skills`) and compare results to the DDB-only path. In CloudWatch:
   - `RegistryReadSuccess` should increment on every hit.
   - `RegistryFallback` should stay low (< 1% of calls); a spike indicates Registry is returning empty results and the fallback is masking a problem.
   - `RegistryReadError` > 0 means the Registry call itself is failing — investigate IAM, SDK wiring, or eventual consistency windows.

4. **Rollback.** Unset `REGISTRY_PRIMARY_READ` on the Lambda. Discovery reverts to DDB-only immediately on the next cold start; warm containers revert on the next redeploy. Time-to-revert: < 5 minutes.

## Observability

The adapter emits metrics in the `Chimera/Registry` CloudWatch namespace:

| Metric | Source Lambda | Meaning |
|--------|---------------|---------|
| `RegistryWriteFailure` | skill-deployment | Registry write raised an error; DDB write proceeded |
| `RegistryReadSuccess` | skills-api | Registry search returned results and they were served to the caller |
| `RegistryFallback` | skills-api | Registry search returned empty or errored; fell back to DDB |
| `RegistryReadError` | skills-api | Registry call itself threw; typically IAM, auth, or SDK issue |

Recommended alarms:

- **Phase 1:** `RegistryWriteFailure` > 1 in 5 minutes → page the on-call. A single failure is recoverable (DDB still wrote) but a pattern indicates Registry is misconfigured.
- **Phase 2:** `RegistryFallback` > 10% of `RegistryReadSuccess + RegistryFallback + RegistryReadError` over 15 minutes → investigate. Either Registry is lagging, the dataset is incomplete, or the primary-read path has a bug.

Log fields the adapter emits alongside each metric:

- `tenantId` — present on every record-level operation; allows filtering to a single tenant.
- `recordId` — the Registry record ID (not the Chimera skill ID; the mapper assigns these separately).
- `op` — one of `create`, `submit`, `update-status`, `search`, `get`.
- `durationMs` — wall-clock latency of the Registry call.
- `errorCode` / `errorMessage` — populated only on failure paths; `errorCode` is the AWS SDK error name (e.g. `ThrottlingException`, `ResourceNotFoundException`).

Filter CloudWatch Logs Insights with `fields @timestamp, op, tenantId, recordId, durationMs, errorCode | filter errorCode != ""` for a quick triage view.

## Rollback playbook (per phase)

### Phase 1 — dual-write enabled, DDB still authoritative

- **Trigger conditions:** `RegistryWriteFailure` > 1/5min sustained; Registry calls timing out; observed cost spike.
- **Rollback procedure:** `aws lambda update-function-configuration` on `skill-deployment` to unset `REGISTRY_ENABLED`.
- **Time-to-revert:** < 5 minutes (Lambda env update is immediate for new invocations).
- **Post-rollback verification:** next pipeline run writes to DDB only; `RegistryWriteFailure` drops to 0 (no Registry calls being made).

### Phase 2 — dual-read, Registry primary with DDB fallback

- **Trigger conditions:** `RegistryReadError` > 1% of discovery calls; customer report of missing skills in discovery; `RegistryFallback` sustained > 10%.
- **Rollback procedure:** `aws lambda update-function-configuration` on `skills-api` to unset `REGISTRY_PRIMARY_READ`.
- **Time-to-revert:** < 5 minutes.
- **Post-rollback verification:** discovery calls return DDB results exclusively; `RegistryReadSuccess` / `RegistryFallback` metrics flatline.

### Phase 3 — bulk migration (future — not deployed yet)

- **Trigger conditions:** bulk migration Lambda job reports a count mismatch (DDB source count ≠ Registry target count), or the job fails partway through.
- **Rollback procedure:** the migration job is idempotent by design — rerun with `--skip-already-migrated` to resume from the last successful batch. If the job wrote partial records to Registry, call `delete-registry-record` for the batch identified by the job's failure log.
- **Time-to-revert:** depends on batch size; < 30 minutes for a small dev tenant, several hours for a prod-scale bulk import.
- **Post-rollback verification:** `ListRegistryRecords` count matches the DDB source count for the target tenant; spot-check 5 records end-to-end via `GetRegistryRecord`.

### Phase 4 — Registry-primary reads in prod (future — not deployed yet)

- **Trigger conditions:** p99 discovery latency regression > 500ms; customer-reported missing skills in search results; `RegistryReadError` spike.
- **Rollback procedure:** unset `REGISTRY_PRIMARY_READ` on the skills-api Lambda; traffic falls back to DDB immediately on new invocations.
- **Time-to-revert:** < 5 minutes (same as Phase 2 rollback in dev; the mechanism is identical).
- **Post-rollback verification:** discovery p99 returns to baseline; `RegistryReadSuccess` drops to 0; `RegistryFallback` also drops to 0 (the code path is no longer exercised).

### Phase 5 — DDB writes disabled (future — not deployed yet)

- **Trigger conditions:** Registry write or search SLO breach; data corruption detected in Registry.
- **Rollback procedure:** unset `DDB_WRITE_SKILLS_DISABLED`. The adapter resumes dual-write. Any records written to Registry during the DDB-disabled window must be back-filled into DDB via a one-shot script (not yet written).
- **Time-to-revert:** < 5 minutes for write behavior; back-fill is a separate multi-hour job.
- **Post-rollback verification:** new publishes land in both DDB and Registry; reconcile historical gap via back-fill script.

### Phase 6 — table deleted (future — IRREVERSIBLE)

- Intentionally not reversible per the migration plan. Pre-deletion snapshot to Glacier is the only safety net; see `docs/reviews/wave4-registry-migration-delta.md` row "W6".

## Spike prerequisite for Phase 2+

`docs/designs/agentcore-registry-spike.md` is the mandatory gate for Phase 2 production enablement. The spike runs for approximately one week on a dev tenant and produces evidence on:

- **Multi-tenancy model:** Pattern A (one registry per tenant, hard IAM isolation) vs. Pattern B (one shared registry, tenant-scoped records with app-layer filtering). Without a decision here, enabling `REGISTRY_PRIMARY_READ` on a shared prod registry risks cross-tenant data leakage through `ListRegistryRecords` or unfiltered `SearchRegistryRecords`.
- **Pricing:** per-record storage, per-search data-plane cost, per-MCP-invoke cost, EventBridge event cost. Measured via Cost Explorer tags.
- **EventBridge coverage:** whether APPROVED / REJECTED / DEPRECATED transitions emit EventBridge events (only `Pending Approval` and `Registry Ready` are documented today). Chimera's dual-write flow assumes approval transitions are observable; if not, the workflow must poll or hook `UpdateRegistryRecordStatus` directly.

Until the spike closes, Phase 2 remains dev-only. Operator-level shorthand: **do not set `REGISTRY_PRIMARY_READ=true` on any non-dev Lambda.**

## Operator concerns around flag flips

- **Warm Lambda containers.** `aws lambda update-function-configuration` applies to new invocations immediately but a warm container with the old env stays warm until it's idle-reaped or traffic patterns force a new container. For a fast rollback, follow the env update with `aws lambda publish-version` and update the live alias to force new containers.
- **Partial rollouts across Lambda copies.** If the deploy pipeline has spawned multiple copies of the skill-deployment Lambda (e.g., per-region), every copy needs its env updated. Verify with `aws lambda list-functions --query 'Functions[?starts_with(FunctionName, \`chimera-dev-skill-deployment\`)].FunctionName'` and loop over the list.
- **Eventual consistency during flag flips.** Registry's search index is eventually consistent (up to a few minutes per the devguide). After flipping `REGISTRY_PRIMARY_READ=true` on an empty-ish Registry, expect a burst of `RegistryFallback` hits until the index catches up. This is not a bug; rollback is only warranted if the burst persists beyond 5 minutes.
- **In-flight invocations.** Any Lambda invocation already executing at the moment of the env update completes with the OLD env. There's no graceful "drain" — flips are effectively immediate for new invocations and invisible for in-flight ones. Not an issue in practice for sub-second Lambdas.

## Known limitations of this baseline

- **`REGISTRY_REGION` defaults to `AWS_REGION`.** Cross-region Registry access (e.g., a Lambda in `us-west-2` talking to a Registry in `us-east-1`) is not explicitly supported by the adapter; the client binds to a single region per Lambda invocation.
- **Registry write failures are logged but do not fail the skill-deployment Lambda.** DDB is still the source of truth in Phase 1, so a Registry outage must not block skill publishing. This is deliberate and safe during Phase 1; it becomes unsafe in Phase 5 when DDB writes are disabled, at which point the failure mode flips (Registry failures must fail the Lambda).
- **`tenantId` enforcement on Registry reads uses app-layer filtering.** The Phase 2 dual-read path filters search results by `tenantId` in the adapter as defense-in-depth. This is the same pattern Chimera applies to DDB GSI reads and it is *not* a cryptographic boundary — it's a bug-prone post-retrieval filter. If the spike selects Pattern A (per-tenant registries), this app-layer filter becomes redundant because the IAM boundary is the authz primitive. If Pattern B is selected, the filter is load-bearing and every discovery code path must preserve it.
- **SDK packages may need adding to `package.json` before Phase 1 can actually be enabled.** The adapter at `packages/core/src/registry/bedrock-registry-client.ts` uses dynamic import for `@aws-sdk/client-bedrock-agentcore` and `@aws-sdk/client-bedrock-agentcore-control`. That keeps the repo buildable and mergeable without the packages installed, but Phase 1 dual-write will silently no-op (and emit `RegistryWriteFailure`) until those packages are added to the relevant workspace `package.json` and the Lambda bundle includes them. This is a deliberate choice — merging Phase 0-1 scaffolding should be risk-free regardless of SDK availability.

## Cross-links

- **ADR-034:** `docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md` — decision record, alternatives, risks, open questions.
- **Migration delta:** `docs/reviews/wave4-registry-migration-delta.md` — 6-phase rollout plan with per-file disposition table.
- **Spike proposal:** `docs/designs/agentcore-registry-spike.md` — the mandatory Phase-2 gate.
- **API reference:** `docs/research/agentcore-rabbithole/01-registry-deep-dive.md` — deep-dive on Registry's API surface, auth modes, search semantics, and multi-tenancy open question.
