# Registry Fallback Rate Alarm

> Response procedure for `chimera-{env}-registry-fallback-rate`

**Last Updated:** 2026-04-17
**Audience:** On-call engineers, platform engineers
**Severity class:** SEV3 (informational during Phase 2 bake-in; promote to SEV2 if sustained past the planned cutover window)
**Related:** [Alarm Runbooks](./alarm-runbooks.md), [Registry Migration Operator Guide](../MIGRATION-registry.md), [Registry Read Error Runbook](./registry-read-error.md)

---

## Alarm Definition

| Field | Value |
|-------|-------|
| **Alarm name** | `chimera-{env}-registry-fallback-rate` |
| **Metric** | `(RegistryReadFallback / (RegistryReadFallback + RegistryReadSuccess)) * 100` (math expression) |
| **Trigger** | `>50%` fallback ratio for 3 consecutive 5-min windows |
| **Evaluation periods** | 3 |
| **SNS topic** | `chimera-alarms-medium-{env}` (and OK notification on recovery) |
| **Emitter** | `skills-api` Lambda (dual-read path) |

`treatMissingData: NOT_BREACHING` keeps the alarm at INSUFFICIENT_DATA when both metrics are absent (flag off, Lambda idle).

---

## What This Alarm Means

A fallback happens whenever the Registry read returns **no usable data** for a request — not just on errors. Reasons include:

- Registry returned empty result set for a query DDB serves successfully (missing migration data)
- Registry returned a record that failed schema validation client-side (effectively empty from the caller's perspective)
- Tenant not yet mapped into Registry (per-tenant rollout partially applied)
- Registry throttled or timed out (also raises `RegistryReadError`)

**High fallback rate = Registry is effectively not serving traffic.** Users see DDB results (the source of truth during Phase 2), so impact is latency-only, but it means the Phase 2 → Phase 4 promotion would fail if attempted now.

---

## High Fallback = Registry Unhealthy

Unlike `RegistryReadError`, a fallback is the fallback path **working as designed** — the alarm is a rollout-progress signal, not a failure signal. Treat it as:

> "Registry is not ready to be the primary read path. Figure out why before promoting."

Do **not** disable dual-read on the first firing. First determine whether the fallback is:

- **Expected** (bake-in period before bulk migration completes)
- **Partial rollout artifact** (only X% of tenants migrated; the other (100-X)% fall back correctly)
- **True failure** (Registry is unhealthy and impacting latency)

---

## Quick Investigation

```bash
export ENV=prod                                   # or dev
export LAMBDA=chimera-${ENV}-skills-api

# 1. Current rates (1h window)
for m in RegistryReadSuccess RegistryReadFallback RegistryReadError; do
  s=$(aws cloudwatch get-metric-statistics \
    --namespace Chimera/Registry \
    --metric-name ${m} \
    --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
    --period 3600 --statistics Sum \
    --query 'Datapoints[0].Sum' --output text)
  echo "${m}: ${s:-0}"
done

# 2. Did error alarm also fire? (correlates true failure)
aws cloudwatch describe-alarms \
  --alarm-names chimera-${ENV}-registry-read-error \
  --query 'MetricAlarms[0].StateValue'

# 3. Spot-check fallback reasons
aws logs filter-log-events \
  --log-group-name /aws/lambda/${LAMBDA} \
  --start-time $(($(date +%s) - 3600))000 \
  --filter-pattern '"RegistryReadFallback"' \
  | jq -r '.events[].message | fromjson? | .reason // "UNKNOWN"' \
  | sort | uniq -c | sort -rn

# 4. Compare with Phase 3 bulk-migration progress (if running)
aws bedrock-agentcore-control search-registry-records \
  --registry-id $(aws ssm get-parameter \
    --name /chimera/${ENV}/registry/id --query 'Parameter.Value' --output text) \
  --max-results 1 \
  --query 'summary // "(no summary API; use count via list)"'
```

---

## Decision Matrix: Wait vs. Disable Flag

| Condition | Action | Rationale |
|-----------|--------|-----------|
| Phase 3 bulk migration has been running < 1h AND total record count < 50% of DDB count | **WAIT** and monitor | Expected: fallback will trend down as migration completes |
| Bulk migration complete (Registry count ≈ DDB count) AND fallback still > 50% | **INVESTIGATE** — likely a query-shape mismatch | Registry has the data but the adapter cannot find it |
| `registry-read-error` alarm also in ALARM | Follow [registry-read-error runbook](./registry-read-error.md) first | Fallback is a symptom of the error condition, fix the error first |
| Per-tenant rollout only partially applied (X% of tenants) AND fallback ≈ (100-X)% | **WAIT** — expected | Unmapped tenants correctly fall back; monitor during rollout |
| Fallback > 80% AND user-facing skill-lookup latency is degraded (check `chimera-{env}-api-error-rate` or Chat-SDK latency) | **DISABLE** `REGISTRY_PRIMARY_READ` | Dual-read is hurting more than helping |
| Fallback > 50% sustained past the planned cutover window in the operator guide | **DISABLE** `REGISTRY_PRIMARY_READ` and file a ticket | Migration is blocked; do not proceed to Phase 4 |

---

## Option A — Wait and Monitor (Default During Bake-In)

During Phase 2 bake-in this alarm is expected to fire intermittently. The standard response is:

1. Acknowledge the alarm in the ops channel.
2. Record the current Registry / DDB record counts and the fallback %.
3. Schedule a re-check in 1h (the alarm will either clear as migration progresses, or re-fire and escalate to the decision matrix above).

Do NOT take action unless the decision matrix points to it.

---

## Option B — Disable Registry Primary Read

Use when the decision matrix says to disable.

```bash
aws lambda get-function-configuration --function-name ${LAMBDA} \
  --query 'Environment.Variables' --output json \
  | jq 'del(.REGISTRY_PRIMARY_READ)' \
  > /tmp/env.json
aws lambda update-function-configuration \
  --function-name ${LAMBDA} \
  --environment "Variables=$(cat /tmp/env.json)"
```

Effect:

- Reads go to DDB only. Fallback metric stops emitting.
- Alarm clears within ~20 minutes (3-period evaluation plus INSUFFICIENT_DATA transition).
- `REGISTRY_ENABLED` (dual-write) stays on — Registry still receives new writes, so the migration is **not** reversed, only paused at the read side.
- To re-enable later, restore the env var and redeploy.

---

## Root-Cause Classes

When you eventually investigate (post-incident, not during the page):

1. **Shape mismatch** — The adapter's query construction does not match Registry's indexed fields. Check `registryAdapter.search()` against the Registry API docs.
2. **Per-tenant mapping drift** — Some tenants in DDB never got mapped into Registry; check the migration script's tenant allowlist.
3. **Draft-vs-approved filter** — Registry may be returning only APPROVED records while DDB has drafts; check the adapter's `status` filter.
4. **Stale SDK** — An older SDK version missed a new index, returning empty. Update.
5. **Cross-region mismatch** — `REGISTRY_REGION` differs from where records were written. Confirm.

---

## Escalation

- **Do not promote to SEV2** unless the decision matrix explicitly calls for it, OR user-facing latency degrades
- **Migration lead** if fallback > 50% persists for > 6h with no clear cause
- **AWS Support SEV3** if the root cause is traced to Registry returning stale or inconsistent read results for records known to exist

---

## Related

- [Registry Migration Operator Guide](../MIGRATION-registry.md) — phase ordering, cutover criteria
- [Registry Read Error Runbook](./registry-read-error.md) — sibling alarm; fix first if both firing
- [Registry Write Failure Runbook](./registry-write-failure.md) — Phase 1 sibling
- [Alarm Runbooks Index](./alarm-runbooks.md)

---

**Owner:** Platform on-call
**Next review:** 2026-07-17 (quarterly)
