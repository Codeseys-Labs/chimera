# Registry Write Failure Alarm

> Response procedure for `chimera-{env}-registry-write-failure`

**Last Updated:** 2026-04-17
**Audience:** On-call engineers, platform engineers
**Severity class:** SEV2 (no user-visible impact while DDB is canonical; promotion to SEV1 if sustained beyond the Phase 3 bulk-migration window)
**Related:** [Alarm Runbooks](./alarm-runbooks.md), [Registry Migration Operator Guide](../MIGRATION-registry.md), [Incident Response](./incident-response.md)

---

## Alarm Definition

| Field | Value |
|-------|-------|
| **Alarm name** | `chimera-{env}-registry-write-failure` |
| **Metric** | `Chimera/SkillPipeline.RegistryWriteFailure` (EMF, Sum) |
| **Trigger** | `>0` in any 5-minute window |
| **Evaluation periods** | 1 |
| **SNS topic** | `chimera-alarms-high-{env}` (and OK notification on recovery) |
| **Emitter** | `skill-deployment` Lambda (dual-write path) |

---

## Critical Reminder: DDB Remains Canonical

During Phase 1 dual-write, **DynamoDB is still the source of truth**. A Registry write failure does NOT drop the user-facing publish — the DDB write has already succeeded before the Registry call. The alarm exists to surface Registry adapter problems before they become blocking in Phase 3+ (bulk migration) or Phase 5 (DDB writes disabled).

If the alarm fires, the skill publish succeeded from the tenant's point of view. You are investigating infrastructure drift, not data loss.

---

## When to Use This Runbook

- The alarm fires (≥1 `RegistryWriteFailure` metric point in 5 minutes)
- You observe `RegistryWriteFailure` log entries in the `skill-deployment` Lambda without the alarm yet firing (early-warning investigation)
- After enabling `REGISTRY_ENABLED=true` on the Lambda for the first time — watch this alarm for the first hour to catch configuration mistakes

---

## Trigger Conditions

The adapter emits `RegistryWriteFailure` for any of:

| Failure reason | Likely cause | Remediation tier |
|----------------|--------------|------------------|
| `SDK_LOAD_FAILED` | `@aws-sdk/client-bedrock-agentcore*` not packaged | Code — bundle the SDK, redeploy Lambda |
| `REGISTRY_ID_MISSING` | `REGISTRY_ENABLED=true` but `REGISTRY_ID` env var unset | Config — set `REGISTRY_ID` or disable flag |
| `ACCESS_DENIED` | Lambda exec role missing `bedrock-agentcore-control:*` grants | IAM — update role policy |
| `VALIDATION` | Skill payload shape rejected by Registry schema | Code — fix the adapter's `toRegistryRecord()` mapping |
| `THROTTLING` / `INTERNAL_FAILURE` | Registry service-side | Wait, retry — AWS support if sustained |
| `NETWORK` / `TIMEOUT` | VPC routing / DNS / TLS | Network — verify VPC endpoint or internet egress |

---

## Quick Investigation

```bash
export ENV=prod                                   # or dev
export LAMBDA=chimera-${ENV}-skill-deployment

# 1. Count failures in last hour by reason
aws logs filter-log-events \
  --log-group-name /aws/lambda/${LAMBDA} \
  --start-time $(($(date +%s) - 3600))000 \
  --filter-pattern '"RegistryWriteFailure"' \
  | jq -r '.events[].message | fromjson? | .reason // "UNKNOWN"' \
  | sort | uniq -c | sort -rn

# 2. Confirm env vars on the Lambda
aws lambda get-function-configuration \
  --function-name ${LAMBDA} \
  --query 'Environment.Variables' \
  --output json | jq '{REGISTRY_ENABLED, REGISTRY_ID, REGISTRY_REGION}'

# 3. Confirm the Registry still exists + is ACTIVE
aws bedrock-agentcore-control get-registry \
  --registry-id "$(aws lambda get-function-configuration \
    --function-name ${LAMBDA} \
    --query 'Environment.Variables.REGISTRY_ID' --output text)"

# 4. Check the Lambda execution role permissions
ROLE=$(aws lambda get-function-configuration \
  --function-name ${LAMBDA} --query 'Role' --output text | awk -F/ '{print $NF}')
aws iam list-attached-role-policies --role-name ${ROLE}
aws iam list-role-policies --role-name ${ROLE}
```

---

## Diagnosis: SDK-Missing Case

The most common failure mode. The adapter uses **dynamic import** for `@aws-sdk/client-bedrock-agentcore-control`; if the module is not in the Lambda bundle, `import()` rejects and the adapter records `RegistryWriteFailure` with reason `SDK_LOAD_FAILED`.

```bash
# Inspect the Lambda deployment package
aws lambda get-function --function-name ${LAMBDA} \
  --query 'Code.Location' --output text \
  | xargs curl -s -o /tmp/lambda.zip
unzip -l /tmp/lambda.zip | grep -i bedrock-agentcore
```

Expected: at least one `.js` file under `node_modules/@aws-sdk/client-bedrock-agentcore*/`. If absent:

1. Add the dependency to the Lambda asset's `package.json`.
2. Confirm the CDK bundler includes it (check `aws-lambda-nodejs` `externalModules` / `nodeModules` config in `infra/lib/skill-pipeline-stack.ts`).
3. Redeploy the stack.

Until the fix ships, the dual-write path is effectively a no-op — **DDB writes continue unharmed**, which is why this is SEV2 and not SEV1.

---

## Recovery Path

Two options; pick based on the failure reason.

### Option A — Disable the Flag (fast rollback, preferred for sustained failure)

Use when the root cause is unclear, fix is > 1 hour away, or you want to silence the alarm while investigating.

```bash
# Drop REGISTRY_ENABLED while preserving other env vars
aws lambda get-function-configuration --function-name ${LAMBDA} \
  --query 'Environment.Variables' --output json \
  | jq 'del(.REGISTRY_ENABLED)' \
  > /tmp/env.json

aws lambda update-function-configuration \
  --function-name ${LAMBDA} \
  --environment "Variables=$(cat /tmp/env.json)"
```

Effect: dual-write path is skipped entirely. DDB writes continue. Alarm clears within 10 minutes (1-period evaluation plus INSUFFICIENT_DATA transition).

**Time to effect:** < 30 seconds (env-var update is instant; next invocation sees the new config).

### Option B — Fix the Bug (root-cause repair)

Use when the failure reason is known and the fix is scoped.

1. Apply the fix (IAM grant, bundle update, adapter code change).
2. Deploy through the normal `npx cdk deploy` path.
3. Publish a test skill in `dev` to confirm a clean `RegistryWriteSuccess` emission.
4. Re-enable in prod — the alarm stays green because the fix landed before the flip.

**Never amend the Lambda in-place without rolling forward through CDK.** Out-of-band changes will be reverted on the next stack deploy and the alarm will re-fire.

---

## Validation After Recovery

```bash
# Confirm no new failures for 30 minutes
aws cloudwatch get-metric-statistics \
  --namespace Chimera/SkillPipeline \
  --metric-name RegistryWriteFailure \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum
```

Expected: all data points `0`, or no data points (if the flag was disabled).

---

## Escalation

- **AWS Support SEV3** if all `THROTTLING` / `INTERNAL_FAILURE` reasons and dev Registry exhibits same behavior (service-side incident)
- **Platform on-call lead** if sustained > 2h and rollback via Option A is blocked (e.g., canary flip-flop)
- **Security** if `ACCESS_DENIED` entries correlate with recent IAM policy changes (possible privilege regression)

---

## Related

- [Registry Migration Operator Guide](../MIGRATION-registry.md) — flag taxonomy, phase ordering, known limitations
- [Alarm Runbooks Index](./alarm-runbooks.md) — all CloudWatch alarm response procedures
- [Registry Read Error Runbook](./registry-read-error.md) — sibling Phase 2 alarm
- [Registry Fallback Rate Runbook](./registry-fallback-rate.md) — sibling Phase 2 alarm

---

**Owner:** Platform on-call
**Next review:** 2026-07-17 (quarterly)
