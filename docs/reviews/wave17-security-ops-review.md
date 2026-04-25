---
title: "Wave-17 Security + Operations Review"
date: 2026-04-24
reviewer: wave-17-security-ops
scope: data-at-rest, data-in-transit, runbook coverage, alarm→action mapping, supply chain, disaster recovery
prior_reviews: Wave-14, Wave-15, Wave-15d, Wave-16
---

# Wave-17 Security + Operations Review

> Chimera v0.6.2 · us-west-2 · 14/14 stacks live

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 2 |
| HIGH | 4 |
| MEDIUM | 3 |
| LOW | 3 |
| TOTAL | 12 |

**External-tenant onboarding blockers:** C-2, H-3, M-3.

## CRITICAL

### C-1 — DAX cluster uses AWS-managed SSE, not CMK

**File:** `infra/lib/data-stack.ts:276`

```typescript
sseSpecification: { sseEnabled: true }  // AWS-managed key only
```

All 6 DDB tables use per-table CMKs; DAX (which caches them) uses SSE-AWS. Operator with AWS-level access can read cached tenant PII without key-policy controls. SOC-2 CC6.1 gap.

**Fix:** Add `kmsMasterKeyId: auditKey.keyArn` (or dedicated DAX CMK).

### C-2 — Pipeline alarm topic has no subscribers — canary failures silent

**File:** `infra/lib/pipeline-stack.ts:158-162, 1366, 1384`

Both pipeline alarms (`ErrorRate`, `Latency`) route to `pipelineAlarmTopic` with zero `addSubscription` calls. Auto-rollback Step Functions still works; humans are never paged. Any canary regression during the first external-tenant deploy is invisible.

**Fix:** Subscribe `opsEmail` / PagerDuty in prod, or connect to `highAlarmTopic` from `ObservabilityStack`.

## HIGH

### H-1 — Five DDB table CMKs use DESTROY in non-prod

**File:** `infra/constructs/chimera-table.ts:42-46`

Only `auditTable` receives an explicit `auditKey` with `RETAIN`. The other 5 auto-create anonymous CMKs with the stack's removal policy; `DESTROY` in non-prod means a recreated table against existing S3-backup data is unreadable.

**Fix:** Create named keys with stable aliases, always `RETAIN`.

### H-2 — ALB access-log bucket not wrapped in ChimeraBucket

**File:** `infra/lib/chat-stack.ts:388-395`

Uses `s3.BucketEncryption.KMS_MANAGED` (correct — ELB log delivery doesn't support CMK), but lacks the access-logging side-bucket + lifecycle + explicit SSL-enforcement policy that `ChimeraBucket` provides.

**Fix:** Extend `ChimeraBucket` to support `KMS_MANAGED` as a fallback for ELB-delivered logs.

### H-3 — No runbook drill schedule; DR scripts referenced but do not exist

**File:** `docs/guides/disaster-recovery.md` (DRAFT warning)

`scripts/dr/restore-dynamodb-from-pitr.sh` referenced but not created. No runbook has a drill schedule. Any SOC-2 / enterprise SLA surfaces this immediately.

**Fix:** (a) Create `scripts/dr/` with minimum restore script + smoke test. (b) Add quarterly tabletop + annual live DR failover schedule.

### H-4 — 11 alarms missing `addOkAction` — silent recovery

**File:** `infra/lib/observability-stack.ts` (multiple lines)

6 DDB throttle alarms + ApiErrorRate + CostAnomaly + BackupFailure + PITR + CrossRegion all send ALARM notifications but no OK. Operators must manually poll to see resolution.

**Fix:** Add `addOkAction(new cloudwatch_actions.SnsAction(topic))` to every alarm with `addAlarmAction`.

## MEDIUM

### M-1 — ApiStack CloudWatch log groups not KMS-encrypted

**File:** `infra/lib/api-stack.ts:60-64, 442-446`

`ApiAccessLogs` + `WsAccessLog` created without `encryptionKey`. API Gateway access logs contain Authorization header fragments.

**Fix:** Thread `platformKey` into `ApiStackProps`, pass to both log groups.

### M-2 — ECR tag-mutable + no image signing

**File:** `infra/lib/pipeline-stack.ts:83, 107` + `TODO` at 126

Both ECR repos allow tag mutation; `latest` tag can be silently overwritten.

**Fix (short-term):** Set `imageTagMutability: IMMUTABLE`; pin container refs to SHA-tagged images from Docker build.

### M-3 — No Cognito user pool backup strategy

**File:** `docs/guides/disaster-recovery.md` (no Cognito section)

If the user pool is accidentally deleted, all tenant Cognito users are gone with no recovery. `custom:tenant_id` linkage severed.

**Fix:** Weekly `cognito-idp:ListUsers` → S3 export, or AWS Backup plan on the user pool.

## LOW

### L-1 — ALB→ECS leg uses HTTP/8080

**File:** `infra/lib/chat-stack.ts:436` + `network-stack.ts:146`

VPC-internal, accepted risk for most compliance regimes. PCI-DSS / HIPAA would flag.

**Fix (future):** ACM private CA + end-to-end TLS.

### L-2 — CloudFront TLS minimum version not explicitly set

**File:** `infra/lib/chat-stack.ts:551-601`

Dev environments without certificate may negotiate TLS 1.0/1.1.

**Fix:** Set `minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021` unconditionally.

### L-3 — Pipeline SNS alarm topic unencrypted

**File:** `infra/lib/pipeline-stack.ts:158-162`

Missing `masterKey: platformKey` that all 4 Observability topics have.

**Fix:** Thread `platformKey` into `PipelineStackProps`.

## PITR ground truth

`ChimeraTable` unconditionally enforces `pointInTimeRecoverySpecification.pointInTimeRecoveryEnabled: true` for all 6 tables. Verified at construct level; cannot be overridden. PITR is confirmed enabled at deploy time.

## Cross-region replication reality check

DR guide assumes `us-west-2` replicas. `DataStack` creates `TableV2` without `replicas:`. No S3 cross-region replication. DR is **single-region + PITR-only** — RTO for regional failure is undefined, not 25 minutes.

## First-external-tenant onboarding blockers

1. **C-2** — Pipeline alarm topic silent
2. **H-3** — DR scripts missing + no drill schedule
3. **M-3** — No Cognito backup
