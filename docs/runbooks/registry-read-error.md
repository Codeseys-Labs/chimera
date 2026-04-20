# Registry Read Error Alarm

> Response procedure for `chimera-{env}-registry-read-error`

**Last Updated:** 2026-04-17
**Audience:** On-call engineers, platform engineers
**Severity class:** SEV2 (DDB fallback keeps reads flowing; promote to SEV1 if the fallback-rate alarm also fires)
**Related:** [Alarm Runbooks](./alarm-runbooks.md), [Registry Migration Operator Guide](../MIGRATION-registry.md), [Registry Fallback Rate Runbook](./registry-fallback-rate.md)

---

## Alarm Definition

| Field | Value |
|-------|-------|
| **Alarm name** | `chimera-{env}-registry-read-error` |
| **Metric** | `Chimera/Registry.RegistryReadError` (EMF, Sum) |
| **Trigger** | `>5` errors per 5-minute window for 2 consecutive periods |
| **Evaluation periods** | 2 |
| **SNS topic** | `chimera-alarms-high-{env}` (and OK notification on recovery) |
| **Emitter** | `skills-api` Lambda (dual-read path) |

The 2-period requirement suppresses single transient errors (cold starts, momentary throttles) while catching sustained breakage.

---

## Critical Reminder: Fallback to DDB is Automatic

Every error in the Registry read path triggers an automatic fallback to the DDB read. This is by design. The alarm fires when the **rate** of fallback-triggering errors is sustained — it does not indicate that users are seeing stale or missing data (yet). Users see DDB results, which are the source of truth during Phase 2.

You escalate to SEV1 only if:

- `chimera-{env}-registry-fallback-rate` is also in ALARM (confirms Registry is unhealthy, not just erroring occasionally), OR
- User-facing latency for skill lookups has degraded (fallback path runs sequentially after the failed Registry call; each error adds ~1 Registry RTT).

---

## Trigger Conditions

`RegistryReadError` is emitted for any failure of the primary Registry read in the dual-read path:

| Failure reason | Likely cause | Remediation tier |
|----------------|--------------|------------------|
| `SDK_LOAD_FAILED` | `@aws-sdk/client-bedrock-agentcore*` not in Lambda bundle | Code — bundle fix + redeploy |
| `ACCESS_DENIED` | `skills-api` exec role missing `bedrock-agentcore:SearchRegistryRecords` / `GetRegistryRecord` | IAM |
| `RESOURCE_NOT_FOUND` | Wrong `REGISTRY_ID` for env | Config |
| `THROTTLING` | Registry SearchRegistryRecords API limit | Backoff or AWS quota increase |
| `INTERNAL_FAILURE` | Registry service-side 5xx | Wait, monitor — AWS support if sustained |
| `TIMEOUT` | VPC egress / DNS | Network |
| `PARSE_ERROR` | Registry returned a record that doesn't map cleanly to the skills schema | Code — fix `fromRegistryRecord()` |

---

## Quick Investigation

```bash
export ENV=prod                                   # or dev
export LAMBDA=chimera-${ENV}-skills-api

# 1. Break down errors by reason in last hour
aws logs filter-log-events \
  --log-group-name /aws/lambda/${LAMBDA} \
  --start-time $(($(date +%s) - 3600))000 \
  --filter-pattern '"RegistryReadError"' \
  | jq -r '.events[].message | fromjson? | .reason // "UNKNOWN"' \
  | sort | uniq -c | sort -rn

# 2. Compare success vs fallback vs error rates
for m in RegistryReadSuccess RegistryReadFallback RegistryReadError; do
  s=$(aws cloudwatch get-metric-statistics \
    --namespace Chimera/Registry \
    --metric-name ${m} \
    --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
    --period 3600 --statistics Sum \
    --query 'Datapoints[0].Sum' --output text)
  echo "${m}: ${s}"
done

# 3. Confirm the Registry is still ACTIVE
aws bedrock-agentcore-control get-registry \
  --registry-id "$(aws lambda get-function-configuration \
    --function-name ${LAMBDA} \
    --query 'Environment.Variables.REGISTRY_ID' --output text)"

# 4. Confirm Lambda env flags
aws lambda get-function-configuration \
  --function-name ${LAMBDA} \
  --query 'Environment.Variables' \
  --output json | jq '{REGISTRY_ENABLED, REGISTRY_PRIMARY_READ, REGISTRY_ID, REGISTRY_REGION}'
```

---

## Fallback-to-DDB Path (What Users Actually See)

```
skills-api.handler
  └─> registryAdapter.search()    ─┐   on error:
         │                          ├── emits RegistryReadError (alarm source)
         │                          └── emits RegistryReadFallback
         │
         └─> ddbSkillsRepo.query() ──> returns to user (source of truth)
```

Latency penalty per error: one Registry RTT (typ. 50-200ms p50, up to timeout on network failures).

If the fallback also errors, the Lambda returns a normal 5xx, which shows up in `chimera-{env}-api-error-rate`. That is the user-facing cliff.

---

## Recovery Path

### Option A — Disable Registry Primary Read (fastest)

Use when the root cause is in Registry itself, AWS service-side, or the cause is unclear.

```bash
# Remove the flag; DDB remains the sole read path. The adapter stops
# calling Registry entirely, so errors and fallbacks both stop.
aws lambda get-function-configuration --function-name ${LAMBDA} \
  --query 'Environment.Variables' --output json \
  | jq 'del(.REGISTRY_PRIMARY_READ)' \
  > /tmp/env.json
aws lambda update-function-configuration \
  --function-name ${LAMBDA} \
  --environment "Variables=$(cat /tmp/env.json)"
```

Effect: alarm returns to OK within ~15 minutes (2-period evaluation). Users are unaffected — reads were already coming from DDB via the fallback path.

### Option B — Fix the Underlying Cause

| Cause | Fix |
|-------|-----|
| `ACCESS_DENIED` | Add missing IAM actions on the `skills-api` exec role via CDK (`security-stack.ts` or `api-stack.ts`) |
| `SDK_LOAD_FAILED` | Add `@aws-sdk/client-bedrock-agentcore` to Lambda bundle in CDK bundler config |
| `RESOURCE_NOT_FOUND` | Correct `REGISTRY_ID` env var (SSM `/chimera/{env}/registry/id`) |
| `THROTTLING` | Request service quota increase for `SearchRegistryRecords` TPS |
| `PARSE_ERROR` | Fix the shape mismatch in `fromRegistryRecord()` and add a regression test |

Deploy fix via `npx cdk deploy`. Alarm clears within 15 minutes of a clean 10-minute window.

---

## Validation After Recovery

```bash
# Confirm zero errors over 30 minutes
aws cloudwatch get-metric-statistics \
  --namespace Chimera/Registry \
  --metric-name RegistryReadError \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 --statistics Sum

# And confirm success metric still ticks (proves the flag is still on
# if you chose Option B)
aws cloudwatch get-metric-statistics \
  --namespace Chimera/Registry \
  --metric-name RegistryReadSuccess \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 --statistics Sum
```

---

## Escalation

- **SEV1 promotion** if `chimera-{env}-registry-fallback-rate` also fires (Registry is unhealthy for the majority of reads)
- **SEV1 promotion** if `chimera-{env}-api-error-rate` fires (fallback path is also broken)
- **AWS Support SEV3** for sustained `INTERNAL_FAILURE` / `THROTTLING` when dev Registry shows the same symptoms
- **Security** for `ACCESS_DENIED` bursts correlating with recent IAM changes

---

## Related

- [Registry Migration Operator Guide](../MIGRATION-registry.md)
- [Registry Write Failure Runbook](./registry-write-failure.md)
- [Registry Fallback Rate Runbook](./registry-fallback-rate.md)
- [Alarm Runbooks Index](./alarm-runbooks.md)

---

**Owner:** Platform on-call
**Next review:** 2026-07-17 (quarterly)
