# Security Incident: Cross-Tenant Breach Response

> Analyst playbook for confirmed or suspected cross-tenant data leakage, unauthorized access, or tenant account compromise

**Last Updated:** 2026-04-17
**Audience:** Security on-call, incident commanders, legal/compliance liaison
**Severity class:** SEV1 (confirmed cross-tenant breach) / SEV2 (suspected breach under investigation)
**SLA:** Containment within **72 hours** of first-observed signal (GDPR Art. 33 alignment)
**Related:** [Incident Response](./incident-response.md), [ADR-002 Cedar](../architecture/decisions/ADR-002-cedar-policy-engine.md), [Canonical Data Model](../architecture/canonical-data-model.md), [DR Runbook Gaps](../reviews/dr-runbook-gaps.md)

---

## Scope

This runbook covers breaches where **one tenant has (or may have) accessed another tenant's data, configuration, or session state.** It does NOT cover:

- Malicious skill payload (see [incident-response.md Runbook: Malicious Skill](./incident-response.md#runbook-malicious-skill-detected-f6---sev1))
- Memory poisoning of a single tenant (see [incident-response.md Runbook: Memory Poisoning](./incident-response.md#runbook-memory-poisoning-f7---sev2))
- Denial-of-service / rate abuse (see [alarm-runbooks.md](./alarm-runbooks.md))

If the attack vector is unclear, start here and branch once evidence narrows the classification.

---

## Triage Questions (first 10 minutes)

Answer these before taking any containment action. Document answers in the incident ticket — they drive every downstream decision.

| # | Question | Why it matters |
|---|----------|----------------|
| 1 | **Which tenant(s) are involved?** — attacker tenant, victim tenant(s), both | Scopes Cognito revocation + Cedar pause |
| 2 | **What attribute of the breach?** — data read, data written, config change, session hijack, token exfiltration | Determines which logs to pull first |
| 3 | **When was it first observed?** — UTC timestamp with second precision | Bounds the evidence-collection window |
| 4 | **How was it detected?** — customer report, WAF alarm, Cedar denial storm, `chimera-audit` anomaly | Signals reliability of the source |
| 5 | **Is it still active?** — attacker session still running? | Forces immediate containment |
| 6 | **Severity class:** SEV1 (confirmed leak) or SEV2 (suspected, under investigation) | Drives notification + SLA |
| 7 | **Compliance class of affected data:** PII, PHI, PCI, standard | Triggers 72h breach notification clock |

Post triage summary in `#chimera-incidents` within **15 minutes** of paging. Template:

```
SEV[1|2] SUSPECTED-TENANT-BREACH
IC: @<handle>
Attacker tenant: <id>
Victim tenant(s): <id(s)>
First observed (UTC): <timestamp>
Active: [yes|no]
Data class: [PII|PHI|PCI|STANDARD]
72h clock started: <timestamp>
```

---

## Evidence-Gathering Order

Collect evidence **before** containment changes log volume. The order is chosen so each source corroborates (not replaces) the previous.

### 1. WAF logs — external entry point

The WAF WebACL (`chimera-api-waf-${env}`, see `infra/lib/security-stack.ts`) logs every request that hits our API Gateway to `aws-waf-logs-chimera-api-${env}` in CloudWatch Logs.

```bash
export ENV=prod
export ATTACKER_TENANT=<TENANT_ID>
export VICTIM_TENANT=<TENANT_ID>
export START_TS=$(($(date -u -d "2026-04-17T00:00:00Z" +%s) * 1000))   # <-- EDIT
export END_TS=$(($(date -u +%s) * 1000))

# All requests that carried the attacker tenant's JWT in the last 24h
aws logs filter-log-events \
  --log-group-name aws-waf-logs-chimera-api-${ENV} \
  --start-time ${START_TS} --end-time ${END_TS} \
  --filter-pattern "\"${ATTACKER_TENANT}\"" \
  --output json > /tmp/waf-${ATTACKER_TENANT}.json

# Count blocked requests (Cedar/WAF terminal action)
jq '[.events[] | select(.message | fromjson | .action == "BLOCK")] | length' \
  /tmp/waf-${ATTACKER_TENANT}.json
```

Look for: source-IP clustering, unusual user-agent, path-traversal attempts, rate-limit rule hits.

### 2. CloudTrail — AWS-API level

CloudTrail captures every AWS SDK call made by our runtime. The smoking gun is a DynamoDB `GetItem` or `Query` against `TENANT#<victim>` performed by an IAM role assumed **for** the attacker tenant.

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=chimera-tenants-${ENV} \
  --start-time "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --max-results 200 > /tmp/cloudtrail-tenants.json

# Filter to the attacker's session ARN pattern
jq --arg tid "${ATTACKER_TENANT}" \
  '.Events[] | select(.CloudTrailEvent | fromjson | .userIdentity.arn | contains($tid))' \
  /tmp/cloudtrail-tenants.json
```

For an immediate sweep across all 6 tables:

```bash
for table in tenants sessions skills rate-limits cost-tracking audit; do
  echo "--- chimera-${table}-${ENV} ---"
  aws cloudtrail lookup-events \
    --lookup-attributes \
        AttributeKey=ResourceName,AttributeValue=chimera-${table}-${ENV} \
    --start-time "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)" \
    --max-results 50 \
    --query 'Events[].{Time:EventTime,Event:EventName,User:Username}' \
    --output table
done
```

### 3. Cedar decision logs

Cedar is the authorization engine (ADR-002). Every allow/deny decision is logged; denial storms against a specific resource are the strongest tenant-breach-attempt signal.

```bash
# Cedar decisions land in the agent-runtime log group
aws logs filter-log-events \
  --log-group-name /chimera/${ENV}/agent-runtime \
  --start-time ${START_TS} --end-time ${END_TS} \
  --filter-pattern "{ \$.event_type = \"cedar_decision\" && \$.principal = \"TenantAgent::${ATTACKER_TENANT}\" }"
```

Do not just count denies — count **allows** against the victim's resources:

```bash
aws logs filter-log-events \
  --log-group-name /chimera/${ENV}/agent-runtime \
  --start-time ${START_TS} --end-time ${END_TS} \
  --filter-pattern "{ \$.event_type = \"cedar_decision\" && \$.decision = \"ALLOW\" && \$.resource = \"*${VICTIM_TENANT}*\" && \$.principal = \"*${ATTACKER_TENANT}*\" }" \
  > /tmp/cedar-cross-tenant-allows.json
```

Any rows here are treated as **confirmed breach** evidence — escalate to SEV1 immediately and preserve the log group.

### 4. `chimera-audit` table — application-level truth

This table is CMK-encrypted (`alias/chimera-audit-${env}`) and retained 90d–7yr. Query the victim's partition for events authored by the attacker tenant.

```bash
aws dynamodb query \
  --table-name chimera-audit-${ENV} \
  --key-condition-expression "PK = :pk" \
  --filter-expression "actorTenantId = :atid" \
  --expression-attribute-values "{
    \":pk\": {\"S\": \"TENANT#${VICTIM_TENANT}\"},
    \":atid\": {\"S\": \"${ATTACKER_TENANT}\"}
  }" \
  --output json > /tmp/audit-${VICTIM_TENANT}-from-${ATTACKER_TENANT}.json
```

Every row is a candidate forensic artifact — hash the file and attach to the ticket:

```bash
sha256sum /tmp/audit-${VICTIM_TENANT}-from-${ATTACKER_TENANT}.json
```

---

## Containment (run in order — each step narrows blast radius)

### Step 1: Revoke Cognito sessions for the attacker tenant

`admin-user-global-sign-out` invalidates every refresh token the user holds. Existing access tokens remain valid until their TTL (default 1h) — see Step 4 for the auth-cache flush.

```bash
export USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name Chimera-${ENV}-Security \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text)

# List all users in the attacker tenant
aws cognito-idp list-users \
  --user-pool-id ${USER_POOL_ID} \
  --filter "custom:tenant_id = \"${ATTACKER_TENANT}\"" \
  --output json | jq -r '.Users[].Username' > /tmp/attacker-users.txt

# Global sign-out each one
while read username; do
  echo "Revoking: ${username}"
  aws cognito-idp admin-user-global-sign-out \
    --user-pool-id ${USER_POOL_ID} \
    --username "${username}"
done < /tmp/attacker-users.txt
```

### Step 2: Pause tenant at the Cedar policy layer

The Cedar policy store (see `infra/lib/tenant-onboarding-stack.ts`) holds per-tenant policies. Emit an emergency `forbid` policy.

```bash
export CEDAR_POLICY_STORE_ID=$(aws cloudformation describe-stacks \
  --stack-name Chimera-${ENV}-TenantOnboarding \
  --query "Stacks[0].Outputs[?OutputKey=='CedarPolicyStoreId'].OutputValue" \
  --output text)

cat > /tmp/emergency-deny.cedar <<EOF
// INCIDENT: <TICKET-ID>  Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
forbid (
  principal in TenantGroup::"${ATTACKER_TENANT}",
  action,
  resource
);
EOF

aws verifiedpermissions create-policy \
  --policy-store-id ${CEDAR_POLICY_STORE_ID} \
  --definition "static={statement=\"$(cat /tmp/emergency-deny.cedar | sed 's/"/\\"/g')\",description=\"Emergency deny — incident <TICKET-ID>\"}"
```

Policy propagation is < 60s. Verify:

```bash
# Any new request from the attacker tenant should now deny
aws logs filter-log-events \
  --log-group-name /chimera/${ENV}/agent-runtime \
  --start-time $(($(date +%s) * 1000 - 60000)) \
  --filter-pattern "{ \$.principal = \"*${ATTACKER_TENANT}*\" && \$.decision = \"DENY\" }" \
  --max-items 5
```

### Step 3: Freeze the evolution kill switch

The Evolution Engine (see `infra/lib/evolution-stack.ts` + ADR-011) can autonomously modify prompts, skills, and routing. During a breach, self-modification must stop so the attacker cannot persist by tweaking the system itself.

```bash
aws ssm put-parameter \
  --name /chimera/evolution/self-modify-enabled/${ENV} \
  --value "false" --type String --overwrite
```

Evolution Lambdas read this parameter on every invocation with a 60s cache. Confirm within 2 minutes:

```bash
aws logs filter-log-events \
  --log-group-name /chimera/${ENV}/evolution \
  --start-time $(($(date +%s) * 1000 - 120000)) \
  --filter-pattern "\"self-modify disabled\"" \
  --max-items 5
```

### Step 4: Flush the authorizer cache (belt & braces)

API Gateway caches JWT authorizer responses for up to 5 minutes by default. Force a flush by rotating the Cognito app client secret (if used) or toggling the authorizer:

```bash
# Nuclear option: disable then re-enable the authorizer
# Downside: every authenticated request gets a transient 401 for ~30s
# Only use if Step 1 is insufficient (e.g., attacker has stolen long-lived tokens)

export API_ID=$(aws apigateway get-rest-apis \
  --query "items[?name=='Chimera-${ENV}-Api'].id" --output text)
export AUTH_ID=$(aws apigateway get-authorizers --rest-api-id ${API_ID} \
  --query 'items[0].id' --output text)

aws apigateway update-authorizer \
  --rest-api-id ${API_ID} --authorizer-id ${AUTH_ID} \
  --patch-operations op=replace,path=/authorizerResultTtlInSeconds,value=0
```

Re-enable after 2 minutes to restore caching.

### Step 5: Terminate any live agent sessions

```bash
aws dynamodb query \
  --table-name chimera-sessions-${ENV} \
  --key-condition-expression "PK = :pk" \
  --filter-expression "#s = :active" \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values "{
    \":pk\":{\"S\":\"TENANT#${ATTACKER_TENANT}\"},
    \":active\":{\"S\":\"ACTIVE\"}
  }" --output json | jq -r '.Items[].sessionId.S' > /tmp/active-sessions.txt

while read session_id; do
  aws bedrock-agent-runtime terminate-session --session-id "${session_id}" || true
  # Mark session as quarantined in DDB for audit
  aws dynamodb update-item \
    --table-name chimera-sessions-${ENV} \
    --key "{\"PK\":{\"S\":\"TENANT#${ATTACKER_TENANT}\"},\"SK\":{\"S\":\"SESSION#${session_id}\"}}" \
    --update-expression "SET #s = :q, quarantinedAt = :now" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{
      \":q\":{\"S\":\"QUARANTINED\"},
      \":now\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}
    }"
done < /tmp/active-sessions.txt
```

---

## Forensics Preservation (do this before any cleanup)

### 1. Snapshot versioned S3 buckets

All three buckets (`chimera-tenants`, `chimera-skills`, `chimera-artifacts`) have versioning enabled (see `ChimeraBucket` construct). Tag the current versions as "incident evidence" so lifecycle rules don't expire them.

```bash
export EVIDENCE_BUCKET=s3://chimera-incident-evidence-${ENV}-$(date +%Y%m%d)
aws s3 mb ${EVIDENCE_BUCKET} --region us-west-2

# Copy the attacker tenant's data slice + the victim tenant's data slice
for tenant in ${ATTACKER_TENANT} ${VICTIM_TENANT}; do
  aws s3 sync \
    s3://chimera-tenants-$(aws sts get-caller-identity --query Account --output text)-us-west-2-${ENV}/tenants/${tenant}/ \
    ${EVIDENCE_BUCKET}/tenant-data/${tenant}/ \
    --source-region us-west-2
done
```

### 2. Export DDB partitions

Use on-demand backup (atomic, point-in-time) rather than Data Pipeline (slow, moves data through EMR).

```bash
for table in tenants sessions skills audit cost-tracking; do
  aws dynamodb create-backup \
    --table-name chimera-${table}-${ENV} \
    --backup-name "incident-<TICKET-ID>-${table}-$(date +%Y%m%d-%H%M)"
done
```

For a **partition-scoped** export (one tenant only), use export-to-S3 with a post-process filter:

```bash
aws dynamodb export-table-to-point-in-time \
  --table-arn $(aws dynamodb describe-table --table-name chimera-audit-${ENV} \
    --query 'Table.TableArn' --output text) \
  --s3-bucket ${EVIDENCE_BUCKET#s3://} \
  --s3-prefix ddb-exports/audit \
  --export-format DYNAMODB_JSON
```

### 3. Ship CloudTrail + WAF logs to the evidence bucket

```bash
# WAF
aws logs create-export-task \
  --log-group-name aws-waf-logs-chimera-api-${ENV} \
  --from ${START_TS} --to ${END_TS} \
  --destination ${EVIDENCE_BUCKET#s3://} \
  --destination-prefix waf-logs

# CloudTrail (export the management events trail)
aws cloudtrail get-trail-status --name chimera-management-trail
# Use the trail's S3 bucket; then cross-copy to evidence bucket:
aws s3 sync s3://<cloudtrail-bucket>/AWSLogs/ ${EVIDENCE_BUCKET}/cloudtrail/
```

### 4. Lock the evidence bucket

```bash
aws s3api put-bucket-versioning \
  --bucket ${EVIDENCE_BUCKET#s3://} \
  --versioning-configuration Status=Enabled

aws s3api put-object-lock-configuration \
  --bucket ${EVIDENCE_BUCKET#s3://} \
  --object-lock-configuration '{
    "ObjectLockEnabled": "Enabled",
    "Rule": {"DefaultRetention": {"Mode": "COMPLIANCE", "Days": 2555}}
  }'
```

7-year object-lock in COMPLIANCE mode: prevents deletion even by the root account. Required for regulated data breaches.

---

## Communications Template

Draft these in parallel with containment. **Do not send** until the IC + Legal sign off.

### Internal (`#chimera-incidents`)

```
[UPDATE t+<minutes>] SEV1 cross-tenant breach
IC: @<handle>  Legal: @<handle>  Comms: @<handle>
Containment: Step <N>/5 complete
Attacker tenant: <id> (paused)
Victim tenant(s): <id(s)>
Evidence preserved: <s3 path>
Next update: <UTC time, <=30 min>
```

### Legal hand-off (email)

```
Subject: [CONFIDENTIAL] Tenant breach notification — <TICKET-ID>

Incident ID: <TICKET-ID>
First observed (UTC): <timestamp>
Classification: <PII|PHI|PCI|STANDARD>
Jurisdictions affected: <list>
Victim tenants: <count + anonymized IDs>
Data scope: <records, fields, estimated row count>
Containment status: <step X of 5>
72h regulatory clock: expires <UTC timestamp>
Evidence bucket: <s3 path, retention locked 7y>

Attaching:
 - Triage summary
 - Cedar decision log extract
 - CloudTrail ResourceName query results
 - chimera-audit partition export

Required from Legal:
 - Review draft customer notification (below)
 - Determine notification obligation (GDPR Art. 33, state AG, sector regulators)
 - Preserve attorney-client privilege markers on investigation findings
```

### Customer notification (victim tenants)

```
Subject: Security notice regarding your Chimera account

We are writing to inform you that on <date UTC>, we detected and
contained a security event that may have exposed the following data
from your tenant account (<TENANT_ID>):

 - <specific data classes, NOT the raw rows>
 - Approximate number of records: <count>
 - Window of exposure: <from UTC> to <to UTC>

What we have done:
 - The source of the unauthorized access was paused within <X hours>.
 - We have rotated credentials for all user accounts in your tenant.
 - A full forensic snapshot of the affected data has been preserved.

What you should do:
 - Review recent activity on your account via https://<tenant console url>
 - Rotate any API keys or webhook secrets tied to this tenant
 - Contact security@<domain> to request the detailed incident report

We will provide a full written incident report within 30 days.

— Chimera Security Team
```

---

## 72-Hour SLA Checkpoints

| t+    | Milestone                                                 |
|-------|-----------------------------------------------------------|
| 0h    | Triage complete, IC assigned, `#chimera-incidents` posted |
| 1h    | Containment Steps 1–3 complete (Cognito, Cedar, Evolution)|
| 4h    | Evidence preservation complete (S3 + DDB backups locked)  |
| 8h    | Legal brief delivered, scope of affected data quantified  |
| 24h   | Internal stakeholder review; customer notification drafted|
| 48h   | Customer notification sent (pending Legal); external comms prepared |
| 72h   | **Regulatory notification sent** (GDPR Art. 33 deadline)  |
| +30d  | Full written incident report delivered to affected tenants|
| +60d  | Post-mortem published internally; preventive tasks filed  |

---

## Closeout Checklist

Before closing the ticket:

- [ ] All 5 containment steps completed and time-stamped
- [ ] Evidence bucket created, populated, and locked (7y COMPLIANCE)
- [ ] CloudTrail + WAF log snapshots exported
- [ ] DDB on-demand backups created for all 6 tables
- [ ] Cedar emergency `forbid` policy in place (named with ticket ID)
- [ ] Attacker tenant marked `status=suspended` in `chimera-tenants`
- [ ] Affected victim tenants notified (Legal sign-off captured)
- [ ] Regulatory notifications sent where required (timestamp recorded)
- [ ] Evolution kill switch re-enabled only after full RCA
- [ ] Cedar emergency policy removed only after attacker tenant is terminated or re-verified
- [ ] Platform read-only mode lifted (if engaged — see [ddb-pitr-restore.md](./ddb-pitr-restore.md))
- [ ] Post-mortem task filed with SEV1 template
- [ ] Detection-gap task filed if signal was late (drives new alarm — see [DR Runbook Gaps §Monitoring Gaps](../reviews/dr-runbook-gaps.md#monitoring-gaps-that-block-runbook-effectiveness))

---

## Escalation Matrix

| Role | When |
|------|------|
| Platform on-call (L1) | Initial triage, first 30 min |
| Security Team Lead (L2) | After 30 min without containment, or on SEV1 |
| VP Engineering + Legal Counsel | On confirmed cross-tenant data access |
| AWS TAM (Support SEV1) | If AWS-level forensic tooling needed (CloudTrail gaps, KMS key forensics) |
| External DFIR firm | If attacker is sophisticated / nation-state indicators / sector-regulator required |
| Law enforcement | Only on Legal's explicit direction |

---

## Related Documents

- [Incident Response Runbook](./incident-response.md) — Broader SEV structure + F5/F6/F9 runbooks
- [Alarm Runbooks](./alarm-runbooks.md) — Pre-breach signals (WAF rate-limit, error-rate spikes)
- [ADR-002: Cedar Policy Engine](../architecture/decisions/ADR-002-cedar-policy-engine.md)
- [Canonical Data Model](../architecture/canonical-data-model.md) — `chimera-audit` CMK retention tiers
- [DR Runbook Gaps](../reviews/dr-runbook-gaps.md) — Why this runbook exists
- [DDB PITR Restore](./ddb-pitr-restore.md) — Companion runbook if breach required data rollback

---

**Owner:** Security on-call
**Next review:** 2026-07-17 (quarterly) — or after any real incident
