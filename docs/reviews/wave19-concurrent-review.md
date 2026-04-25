---
title: "Wave-19 Concurrent Review"
status: audit
date: 2026-04-25
auditor: wave19-concurrent-reviewer
scope: Wave-17 security-ops carryovers (C-1 DAX CMK, H-1 named DDB CMKs, H-2 ALB logs, M-1 API log KMS, M-2 ECR immutable) + Wave-18 carryovers (I1 chat-gateway CI, I4 alarm runbooks)
starting_commit: db42f30
---

# Wave-19 Concurrent Review

> No Wave-19 commits have landed on main as of this baseline audit (HEAD = db42f30). All findings
> are confirmed open items in the pre-Wave-19 baseline and constitute the acceptance checklist.

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1     |
| HIGH     | 3     |
| MEDIUM   | 2     |
| LOW      | 1     |
| **Total**| **7** |

---

## CRITICAL

### I1 — DAX at-rest encryption uses AWS-managed key, not CMK (C-1 carryover)

- **File:** `infra/lib/data-stack.ts:267-279`
- **Confidence:** 100
- **Issue:** `CfnCluster.sseSpecification` sets `sseEnabled: true` only. This activates SSE with an AWS-owned key — the comment on line 275 acknowledges "AWS-managed key." `CfnCluster` requires `sseType: 'KMS'` and `kmsMasterKeyId` to use a CMK. All 6 DynamoDB tables receive CMKs (via ChimeraTable); DAX does not. This breaks the platform's uniform CMK coverage and removes CloudTrail key-usage auditability for DAX data.
- **Violates:** CLAUDE.md Infrastructure: "named CMKs with RETAIN"; platform CMK encryption standard.
- **Fix:**
  ```typescript
  const daxKey = new kms.Key(this, 'DaxKey', {
    alias: `chimera-dax-${props.envName}`,
    enableKeyRotation: true,
    description: 'CMK for DAX cluster encryption at rest',
    removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
  });
  // in CfnCluster:
  sseSpecification: { sseEnabled: true, sseType: 'KMS', kmsMasterKeyId: daxKey.keyArn }
  ```
  Grant `daxRole` `kms:GenerateDataKey*` and `kms:Decrypt` on the key, and add those same actions to the key policy for the `dax.amazonaws.com` principal (KMS key policy requirement per CLAUDE.md).

---

## HIGH

### I2 — Five DynamoDB CMKs lack aliases (H-1 carryover)

- **File:** `infra/constructs/chimera-table.ts:42-46`
- **Confidence:** 100
- **Issue:** The auto-created `kms.Key` inside ChimeraTable has `description` and `enableKeyRotation` but no `alias`. Five of six tables (tenants, sessions, skills, rate-limits, cost-tracking) use this path. The audit table's key is aliased (`chimera-audit-${envName}`) only because it is created explicitly in `data-stack.ts`. Without aliases, keys are identified only by AWS-generated key ID, making them invisible in the KMS console by name and impossible to reference symbolically in IAM.
- **Violates:** CLAUDE.md Infrastructure: "named CMKs with RETAIN."
- **Fix:** Add `alias: \`chimera-${props.tableName}\`` to the `kms.Key` in `chimera-table.ts:42-46`. This will propagate named aliases to all 5 un-aliased tables.

### I3 — API Gateway access log group has no KMS encryption (M-1 carryover, promoted to HIGH)

- **File:** `infra/lib/api-stack.ts:60-64`
- **Confidence:** 95
- **Issue:** `LogGroup` for API access logs has no `encryptionKey`. This captures caller IPs, user IDs, resource paths, and response codes unencrypted. The platform log group in `ObservabilityStack` is protected by `platformKey`; consistency requires the same here. CloudWatch Logs CMK access requires a key policy grant (per CLAUDE.md); omitting the key skips that requirement entirely.
- **Violates:** CLAUDE.md Security: "KMS for CloudWatch Logs: Must grant permissions via key policy."
- **Fix:** Add `platformKey?: kms.IKey` to `ApiStackProps`; pass `encryptionKey: props.platformKey` to the `LogGroup`. Add `logs.amazonaws.com` to the key policy with `kms:GenerateDataKey*` and `kms:Decrypt`.

### I4 — Three alarms have no runbook entries (I4 carryover)

- **Files:** `infra/lib/observability-stack.ts:1167` (`tool-success-rate-low`), `:1248` (`tier-violation-count-high`), `:662` (`dynamodb-pitr-disabled`); vs `docs/runbooks/alarm-runbooks.md`
- **Confidence:** 100
- **Issue:** All three alarms route to `highAlarmTopic`. The `alarm-runbooks.md` Alarm Index does not list them. On-call engineers paged by these alarms have no documented investigation path. The inline `alarmDescription` fallback (when `runbookBaseUrl` is unset) is a one-liner, not a triage guide.
- **Fix:** Add three sections to `docs/runbooks/alarm-runbooks.md` following the existing format: alarm name pattern, trigger condition, impact, investigation commands (CloudWatch Logs Insights / Metrics queries), resolution steps, prevention.

---

## MEDIUM

### I5 — Both ECR repositories use MUTABLE image tags (M-2 carryover)

- **File:** `infra/lib/pipeline-stack.ts:93, 118`
- **Confidence:** 100
- **Issue:** `AgentRuntimeRepository` and `ChatGatewayRepository` both set `imageTagMutability: ecr.TagMutability.MUTABLE`. A push to any existing tag silently overwrites it. A compromised build can overwrite `:latest` or a version tag without a detectable artifact change, bypassing the 7-stage skill security pipeline's supply-chain protections.
- **Fix:** Set `imageTagMutability: ecr.TagMutability.IMMUTABLE`. Update CI to tag images with the git commit SHA rather than overwriting `:latest`.

### I6 — chat-gateway CI exclusion has no tracking issue ID (I1 carryover)

- **File:** `.github/workflows/ci.yml:46-64`
- **Confidence:** 95
- **Issue:** `packages/chat-gateway/` is excluded from `bun test` due to "Bun CJS/ESM compat with `@aws-sdk/lib-dynamodb`". 178 tests never run in CI. The comment cites no Seeds issue ID, so the exclusion has no exit condition and will persist indefinitely.
- **Violates:** CLAUDE.md Quality Gates: "`bun test` — all tests must pass."
- **Fix:** File a Seeds issue for the CJS/ESM fix. Add the issue ID to the CI comment (e.g., `# chimera-XXXX blocks re-inclusion`).

---

## LOW

### I7 — ALB log bucket uses KMS_MANAGED (AWS constraint, documentation gap only)

- **File:** `infra/lib/chat-stack.ts:388`
- **Confidence:** 80
- **Issue:** `BucketEncryption.KMS_MANAGED` is an AWS constraint (ELB delivery service does not support CMKs). The code correctly documents this inline. However, this means ALB access logs are the only platform data path not covered by the CMK audit trail, and this exception is not reflected in the architecture or runbook docs.
- **Fix (documentation only):** Add a note to `docs/architecture/` documenting this AWS-imposed exception.

---

## Not-an-issue (H-2 ALB logs)

**H-2 (Wave-17 carryover) is confirmed fixed.** `chat-stack.ts:382-406` correctly gates ALB log enablement on `isProd && hasConcreteRegion`, creates a dedicated S3 bucket with a 30-day lifecycle rule, and calls `alb.logAccessLogs(albAccessLogsBucket, 'alb/chat-gateway')`. No action needed.

---

## Acceptance criteria for Wave-19 commits

| ID | Target file | Verification |
|----|-------------|--------------|
| I1 | `infra/lib/data-stack.ts` | `CfnCluster` has `sseType: KMS` + `kmsMasterKeyId`; CDK test asserts `AWS::KMS::Key` with alias + `AWS::DAX::Cluster` KMS reference |
| I2 | `infra/constructs/chimera-table.ts` | `kms.Key` includes `alias`; CDK test asserts aliases on all 5 auto-created table keys |
| I3 | `infra/lib/api-stack.ts` | `accessLogGroup` has `encryptionKey`; CDK test asserts `KmsKeyId` on `AWS::Logs::LogGroup` |
| I4 | `docs/runbooks/alarm-runbooks.md` | 3 new sections: `tool-success-rate-low`, `tier-violation-count-high`, `dynamodb-pitr-disabled` |
| I5 | `infra/lib/pipeline-stack.ts` | Both ECR repos set `IMMUTABLE`; CDK test asserts `ImageTagMutability: IMMUTABLE` |
| I6 | `.github/workflows/ci.yml` | Seeds issue ID present in chat-gateway exclusion comment |
