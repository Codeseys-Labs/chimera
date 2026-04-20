# DynamoDB Point-in-Time Recovery (PITR) Restore

> Per-table restore procedure for the 6-table Chimera data plane

**Last Updated:** 2026-04-17
**Audience:** On-call engineers, SREs, incident commanders
**Severity class:** SEV1 (full platform restore) / SEV2 (single-table restore)
**Related:** [Incident Response](./incident-response.md), [Alarm Runbooks](./alarm-runbooks.md), [Canonical Data Model](../architecture/canonical-data-model.md), [ADR-001](../architecture/decisions/ADR-001-six-table-dynamodb.md)

---

## Recovery Objectives

| Metric | Target | Enforced by |
|--------|--------|-------------|
| **RTO** (Recovery Time Objective) | 4 hours for all 6 tables | This runbook + operator drill |
| **RPO** (Recovery Point Objective) | 35 days (DynamoDB PITR maximum retention) | `ChimeraTable` construct |
| **Dry-run cadence** | Quarterly against `chimera-*-dev` | Game-day schedule |

PITR in DynamoDB captures changes on a rolling 35-day window with a resolution of 1 second. Any restore target older than 35 days is unrecoverable — escalate to on-demand backups (not covered here).

---

## When to Use This Runbook

- Accidental `DELETE` or `UPDATE` against a production table
- Corruption from a bad migration or runaway Lambda
- Ransomware / malicious data tampering (also trigger [security-incident-tenant-breach.md](./security-incident-tenant-breach.md))
- Regional failure that requires restoring data into a new region (future — see `cross-region-failover.md` aspirational runbook)

**Do NOT use for:**
- Routine rollback of application code — that's a [deployment rollback](./deployment.md).
- Single-item corrections — use targeted `UpdateItem` with the old value.

---

## Pre-Conditions (confirm before starting)

### 1. PITR is actually enabled on the target table

All six production tables are created with PITR enabled via `ChimeraTable` (see `infra/constructs/chimera-table.ts`). Verify before relying on it:

```bash
for table in chimera-tenants chimera-sessions chimera-skills \
             chimera-rate-limits chimera-cost-tracking chimera-audit; do
  status=$(aws dynamodb describe-continuous-backups \
    --table-name ${table}-prod \
    --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' \
    --output text)
  echo "${table}-prod: ${status}"
done
```

**Expected output:** all tables `ENABLED`. If any is `DISABLED`, **stop** — you cannot PITR-restore and must fall back to the most recent on-demand backup.

### 2. Target timestamp is within the recoverable window

```bash
aws dynamodb describe-continuous-backups \
  --table-name chimera-tenants-prod \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.{Earliest:EarliestRestorableDateTime,Latest:LatestRestorableDateTime}'
```

Confirm the requested `RESTORE_TIMESTAMP` is between `Earliest` and `Latest`. Use ISO-8601 UTC (`2026-04-17T15:30:00Z`).

### 3. You have the right IAM role

The operator identity needs:
- `dynamodb:RestoreTableToPointInTime`
- `dynamodb:DescribeTable`
- `dynamodb:UpdateTable`
- `kms:CreateGrant` on `alias/chimera-audit-prod` (for the `chimera-audit` restore)

### 4. Freeze new writes if the corruption window is still open

If the bad actor / bad code is still running, containment comes first:

```bash
# Flip the application into read-only mode via SSM
aws ssm put-parameter \
  --name /chimera/platform/read-only-mode/prod \
  --value "true" --type String --overwrite
```

The chat gateway and API Lambdas read this flag every 60s and reject writes with `503 SERVICE_UNAVAILABLE`.

---

## Restore Sequence

Tables are restored in dependency order so the system passes through **no** broken-authZ state:

| Order | Table | Why this order | Owner |
|-------|-------|----------------|-------|
| 1 | `chimera-tenants` | AuthZ and tenant config are checked on every request — nothing else works without it | Platform |
| 2 | `chimera-audit` | Forensic integrity: restore audit **before** operational tables so we preserve the gap-in-writes evidence | Security |
| 3 | `chimera-sessions` | Operational: active chats. OK to lose (24h TTL anyway) | Platform |
| 4 | `chimera-skills` | Skills catalogue. Not session-critical | Platform |
| 5 | `chimera-rate-limits` | Token-bucket state. 5-minute TTL — safe to lose | Platform |
| 6 | `chimera-cost-tracking` | Billing reconciliation. Restore last so we have the final values | Finance |

Restore commands create a **new** table (`${TABLE}-restore-${TS}`). The original is untouched until cutover (Step “Traffic Cutover”). This preserves a rollback path if the restore itself is corrupt.

### Common variables

```bash
export ENV=prod
export RESTORE_TIMESTAMP="2026-04-17T15:30:00Z"    # <-- EDIT
export RESTORE_TAG=$(date -u +%Y%m%d-%H%M)          # e.g. 20260417-1530
```

### Step 1 — Restore `chimera-tenants` (authZ-critical)

```bash
aws dynamodb restore-table-to-point-in-time \
  --source-table-name chimera-tenants-${ENV} \
  --target-table-name chimera-tenants-${ENV}-restore-${RESTORE_TAG} \
  --restore-date-time "${RESTORE_TIMESTAMP}" \
  --billing-mode-override PAY_PER_REQUEST
```

Poll for `ACTIVE`:

```bash
watch -n 30 "aws dynamodb describe-table \
  --table-name chimera-tenants-${ENV}-restore-${RESTORE_TAG} \
  --query 'Table.TableStatus' --output text"
```

Restore of a ~1M-item table typically takes 20–40 minutes.

### Step 2 — Restore `chimera-audit` (CMK-encrypted)

This table is encrypted with the `chimera-audit-${ENV}` CMK (see `infra/lib/data-stack.ts` `auditKey`). The restore inherits the source SSE settings; confirm the operator role has `kms:CreateGrant` on that key before running.

```bash
aws dynamodb restore-table-to-point-in-time \
  --source-table-name chimera-audit-${ENV} \
  --target-table-name chimera-audit-${ENV}-restore-${RESTORE_TAG} \
  --restore-date-time "${RESTORE_TIMESTAMP}" \
  --billing-mode-override PAY_PER_REQUEST \
  --sse-specification-override Enabled=true,SSEType=KMS,KMSMasterKeyId=alias/chimera-audit-${ENV}
```

### Step 3–6 — Restore operational tables

Run in parallel (independent of each other):

```bash
for table in sessions skills rate-limits cost-tracking; do
  aws dynamodb restore-table-to-point-in-time \
    --source-table-name chimera-${table}-${ENV} \
    --target-table-name chimera-${table}-${ENV}-restore-${RESTORE_TAG} \
    --restore-date-time "${RESTORE_TIMESTAMP}" \
    --billing-mode-override PAY_PER_REQUEST &
done
wait
```

Monitor all four:

```bash
for table in sessions skills rate-limits cost-tracking; do
  status=$(aws dynamodb describe-table \
    --table-name chimera-${table}-${ENV}-restore-${RESTORE_TAG} \
    --query 'Table.TableStatus' --output text 2>/dev/null)
  echo "${table}: ${status}"
done
```

---

## GSI Backfill Monitoring

`RestoreTableToPointInTime` restores the base table immediately, but GSIs are rebuilt asynchronously. A restored table can be `ACTIVE` while GSIs are still `CREATING`. Queries against those GSIs will return partial or empty results until backfill completes.

### Check GSI status per table

```bash
aws dynamodb describe-table \
  --table-name chimera-tenants-${ENV}-restore-${RESTORE_TAG} \
  --query 'Table.GlobalSecondaryIndexes[].{Index:IndexName,Status:IndexStatus,Backfilling:Backfilling}'
```

### Monitor backfill percentage via CloudWatch

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name OnlineIndexPercentageProgress \
  --dimensions \
      Name=TableName,Value=chimera-tenants-${ENV}-restore-${RESTORE_TAG} \
      Name=GlobalSecondaryIndexName,Value=GSI1-tier \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 60 \
  --statistics Average
```

**Do not cut over traffic until every GSI reports `IndexStatus=ACTIVE` and `Backfilling=false`.** Cutting over mid-backfill is a silent data-loss class bug: GSI reads return partial results with zero error signal.

Expected backfill duration: 5–20 minutes for `chimera-tenants` (2 GSIs), up to 2 hours for `chimera-skills` (3 GSIs with large projections).

---

## Validation Before Cutover

Run these **per table** against the restored copy. Fail fast if any row count is off by more than the expected write rate times the elapsed minutes since `RESTORE_TIMESTAMP`.

### Row-count parity

```bash
for table in tenants audit sessions skills rate-limits cost-tracking; do
  orig=$(aws dynamodb describe-table --table-name chimera-${table}-${ENV} \
    --query 'Table.ItemCount' --output text)
  rest=$(aws dynamodb describe-table \
    --table-name chimera-${table}-${ENV}-restore-${RESTORE_TAG} \
    --query 'Table.ItemCount' --output text)
  echo "${table}: original=${orig}  restored=${rest}"
done
```

`ItemCount` updates every ~6 hours — for a hot-path check, issue a `Scan --select COUNT` on a bounded partition.

### Tenants sanity (authZ smoke test)

```bash
# Pick a known-good tenant ID from before the incident window
export TEST_TENANT=<TENANT_ID>

aws dynamodb get-item \
  --table-name chimera-tenants-${ENV}-restore-${RESTORE_TAG} \
  --key "{\"PK\":{\"S\":\"TENANT#${TEST_TENANT}\"},\"SK\":{\"S\":\"PROFILE\"}}"
```

Verify the returned `tier`, `accountStatus`, and `createdAt` match the expected values.

### Audit integrity

```bash
aws dynamodb query \
  --table-name chimera-audit-${ENV}-restore-${RESTORE_TAG} \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values "{\":pk\":{\"S\":\"TENANT#${TEST_TENANT}\"}}" \
  --limit 10 \
  --scan-index-forward false
```

Confirm the most recent events pre-date `RESTORE_TIMESTAMP` by less than 60 seconds.

### GSI cross-tenant guard (ADR-001)

```bash
# GSI queries MUST include FilterExpression for tenantId. Sanity-check one.
aws dynamodb query \
  --table-name chimera-tenants-${ENV}-restore-${RESTORE_TAG} \
  --index-name GSI1-tier \
  --key-condition-expression "tier = :t" \
  --filter-expression "tenantId = :tid" \
  --expression-attribute-values "{\":t\":{\"S\":\"enterprise\"},\":tid\":{\"S\":\"${TEST_TENANT}\"}}"
```

---

## Traffic Cutover

You have **two** cutover strategies. Pick one before you start the restore — switching mid-flight is painful.

### Strategy A — Rename swap (recommended, 5 minutes of downtime)

The application reads table names from SSM Parameter Store (see `DiscoveryStack` outputs). A rename is done by updating those parameters.

**Pros:** atomic, reversible, no stale references, 5-min downtime.
**Cons:** Requires the app to re-read the parameter — the chat gateway and Lambdas cache it for 60s. Users mid-request may see one transient 5xx.

```bash
# 1. Rename original out of the way (keep as rollback)
aws dynamodb update-table \
  --table-name chimera-tenants-${ENV} \
  --deletion-protection-enabled
# DynamoDB does NOT support rename — the "rename" is actually:
#   a) Mark original retained (already done via RemovalPolicy.RETAIN in prod)
#   b) Point discovery/SSM at the restored table

# 2. Point application at restored table
aws ssm put-parameter \
  --name /chimera/discovery/tables/tenants/prod \
  --value chimera-tenants-${ENV}-restore-${RESTORE_TAG} \
  --type String --overwrite

# 3. Force ECS tasks to recycle (picks up new parameter)
aws ecs update-service \
  --cluster chimera-chat \
  --service chat-sdk \
  --force-new-deployment

# 4. Wait for rolling deploy
aws ecs wait services-stable --cluster chimera-chat --services chat-sdk
```

Repeat per table. For Lambda-backed services (API stack), force a new version by updating an env var:

```bash
aws lambda update-function-configuration \
  --function-name Chimera-${ENV}-Api-TenantsHandler \
  --environment "Variables={RESTORE_CACHE_BUST=${RESTORE_TAG}}"
```

### Strategy B — In-place replace (zero-downtime, destructive)

Copy items from the restored table back into the original using `dynamodb scan | batch-write-item`. Only for **small** tables (`chimera-rate-limits`, `chimera-cost-tracking`).

**Pros:** zero change to discovery/SSM/consumers.
**Cons:** Destroys the original data you might need for forensics. Not atomic — concurrent writes can race. Slow for large tables.

**Do not use Strategy B on `chimera-tenants` or `chimera-audit`.**

Rough procedure (Strategy B):
```bash
# Disable deletion protection on the target, scan+copy, then re-enable.
# Full script in docs/runbooks/scripts/ddb-in-place-copy.sh (TODO).
```

---

## Rollback if the Restore is Corrupt

If post-cutover validation fails (row counts off, queries returning bad data, customer reports):

### Strategy A rollback

```bash
# 1. Point discovery back to the original table
aws ssm put-parameter \
  --name /chimera/discovery/tables/tenants/prod \
  --value chimera-tenants-prod \
  --type String --overwrite

# 2. Force another ECS deploy
aws ecs update-service --cluster chimera-chat --service chat-sdk --force-new-deployment
aws ecs wait services-stable --cluster chimera-chat --services chat-sdk

# 3. Do NOT delete the restore table -- keep for forensics
aws dynamodb update-table \
  --table-name chimera-tenants-${ENV}-restore-${RESTORE_TAG} \
  --deletion-protection-enabled
```

### Strategy B rollback

Not possible. The original was overwritten. Issue a second PITR restore to a **pre-cutover** timestamp.

---

## Post-Restore Cleanup

**Wait 7 days** before deleting the retained restore tables. Cost of an idle PAY_PER_REQUEST table with storage only is ~$0.25/GB-month — trivial relative to the insurance value.

After the 7-day cooldown:

```bash
# Remove deletion protection then delete
for table in tenants audit sessions skills rate-limits cost-tracking; do
  aws dynamodb update-table \
    --table-name chimera-${table}-${ENV}-restore-${RESTORE_TAG} \
    --no-deletion-protection-enabled
  aws dynamodb delete-table \
    --table-name chimera-${table}-${ENV}-restore-${RESTORE_TAG}
done
```

Lift the platform read-only flag:

```bash
aws ssm put-parameter \
  --name /chimera/platform/read-only-mode/prod \
  --value "false" --type String --overwrite
```

---

## Quarterly Dry-Run Checklist

Once per quarter, restore `chimera-*-dev` to a timestamp 12 hours old. Target: prove the full 6-table restore completes under RTO.

- [ ] Choose a `RESTORE_TIMESTAMP` 12h in the past
- [ ] Run Steps 1–6 against `dev` tables (suffix `-dev-drill-YYYYMMDD`)
- [ ] Record total elapsed time per table and sum across the sequence
- [ ] Verify GSI backfill progress monitoring script returns real numbers
- [ ] Run validation queries end-to-end
- [ ] Practice Strategy A cutover in `dev`
- [ ] Practice rollback
- [ ] Delete drill tables
- [ ] File timing into [capacity-planning.md](./capacity-planning.md) RTO row
- [ ] If total time > 4h: file SEV3 task to optimize (PAY_PER_REQUEST → PROVISIONED pre-warm, parallel restore, etc.)

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ResourceNotFoundException` on restore | Source table name typo or wrong env suffix | Re-check `${ENV}` and exact name |
| `ValidationException: RestoreDateTime before EarliestRestorableDateTime` | Target > 35 days old | Use on-demand backup; PITR cannot help |
| Restore stuck in `CREATING` > 2h | AWS service issue (rare) | Open AWS Support SEV2 ticket, reference restore ARN |
| GSI `Backfilling: true` for > 4h on a small table | Hot partition during backfill | Wait; DynamoDB throttles its own backfill |
| `AccessDeniedException` on audit restore | Missing KMS grant | Add `kms:CreateGrant` on `alias/chimera-audit-${ENV}` to operator role |
| Queries return empty post-cutover | GSI not yet `ACTIVE` | Roll back via Strategy A, wait, re-cutover |

---

## Escalation

- **AWS Support SEV2** if a single restore hangs > 2h or fails with a 5xx-class error.
- **VP Engineering** if total restore time exceeds 4h RTO target.
- **Legal / Compliance** if restored data includes records deleted under GDPR/HIPAA erasure requests — a restore un-deletes them and triggers a re-deletion obligation.

---

## Related Documents

- [Incident Response Runbook](./incident-response.md) — Broader SEV1/SEV2 structure
- [Alarm Runbook: DynamoDB Throttles](./alarm-runbooks.md#dynamodb-throttle-alarms) — What to do before it becomes a restore
- [Canonical Data Model](../architecture/canonical-data-model.md) — Table schemas and access patterns
- [ADR-001: Six-Table DynamoDB Design](../architecture/decisions/ADR-001-six-table-dynamodb.md)
- [Security Incident: Tenant Breach](./security-incident-tenant-breach.md) — If the corruption was malicious
- [DR Runbook Gaps](../reviews/dr-runbook-gaps.md) — Why this runbook exists

---

**Owner:** Platform on-call
**Next review:** 2026-07-17 (quarterly)
