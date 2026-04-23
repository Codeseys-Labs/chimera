# Skill Compromise Response

> Playbook for a deployed skill discovered to be malicious — exfiltration, credential theft, backdoor, or supply-chain attack via dependency

**Last Updated:** 2026-04-22
**Audience:** Security on-call, platform on-call, skills team
**Severity class:** SEV1 (confirmed active compromise, multiple tenants affected) / SEV2 (single-tenant or pre-invocation compromise)
**SLA:** Quarantine within **30 minutes** of confirmed compromise; full revocation within **2 hours**
**Related:** [Incident Response](./incident-response.md), [Security Incident: Tenant Breach](./security-incident-tenant-breach.md), [Alarm Runbooks](./alarm-runbooks.md), [Canonical Data Model](../architecture/canonical-data-model.md)

---

## When to Use This Runbook

- A deployed skill is exfiltrating tenant data to a non-allow-listed endpoint
- A deployed skill is reading credentials/secrets it was not authorized to access
- A deployed skill creates a backdoor (persisted shell, scheduled callback, reverse tunnel)
- A skill's upstream dependency is flagged via CVE / OSV as supply-chain-attacked (e.g., typosquatted, post-install script, npm/PyPI takeover)
- A user reports a skill behaving in a way its manifest does not describe
- Cedar decision logs show an ALLOW for a skill action that was pre-deployment classified `prohibited`

**Do NOT use for:**
- Skill publish-time scan failure — that's a rejection, not an incident (see `skill-pipeline-stack.ts` stages 1–7)
- A skill failing at runtime due to bugs / timeouts — see [alarm-runbooks.md §skills-throttles](./alarm-runbooks.md#skills-table-throttle-alarm)
- Cross-tenant data access regardless of skill involvement — see [security-incident-tenant-breach.md](./security-incident-tenant-breach.md) (run BOTH if the vector was a skill)

---

## The 7-Stage Pipeline — what it did and didn't catch

Every skill that reaches production was admitted by the 7-stage scanner (`infra/lib/skill-pipeline-stack.ts` lines 24–32, 74–150):

| Stage | Lambda | What it checks | Miss profile |
|-------|--------|---------------|--------------|
| 1. Static Analysis | `chimera-skill-static-analysis-${env}` | Regex/AST for `eval`, network calls, crypto mining | String obfuscation, runtime-loaded code |
| 2. Dependency Audit | `chimera-skill-dependency-audit-${env}` | OSV database for each dep | Zero-day pre-disclosure, typosquat, post-install hooks |
| 3. Sandbox Run | `chimera-skill-sandbox-test-${env}` | Isolated subprocess smoke test | Sandbox-aware payloads (`if TERM == 'dumb': return benign`) |
| 4. Signature Verification | `chimera-skill-signature-verification-${env}` | Ed25519 signature against signing-key secret | Signing key compromise, insider threat |
| 5. Performance Testing | `chimera-skill-performance-testing-${env}` | Token cost, latency, CW anomaly detectors | Low-frequency data exfil (1 call/hour) |
| 6. Manual Review | `chimera-skill-manual-review-${env}` | Permission diff review | Human error, reviewer fatigue |
| 7. Skill Deployment | `chimera-skill-deployment-${env}` | Publishes to DDB + S3 bundle bucket | N/A — publish step |

**Part of this runbook's closeout** is identifying which stage(s) should have caught the compromise and filing improvement tasks.

---

## Triage Questions (first 10 minutes)

Answer these before taking containment action. They scope the blast radius and determine severity.

| # | Question | Why it matters |
|---|----------|----------------|
| 1 | **Skill identity:** `PK=SKILL#<name>`, affected version(s)? | Scopes quarantine + cache flush |
| 2 | **Compromise vector:** exfil? creds? backdoor? dep? sandbox-evasion? | Drives stage-N post-mortem |
| 3 | **When was the skill deployed?** (UTC, DDB `publishedAt`) | Bounds exposure window |
| 4 | **Blast radius:** how many tenants have it installed? | Decides SEV1 vs SEV2 |
| 5 | **Is it still running?** | Forces immediate Step 1 |
| 6 | **What AWS resources does its IAM role touch?** | Scopes Step 4 (secret rotation) |
| 7 | **Is the CodeCommit commit SHA that published the skill known?** | Drives Step 3b (forensics) |

Post the triage summary in `#chimera-incidents` within 15 minutes:

```
SEV[1|2] SKILL-COMPROMISE
IC: @<handle>
Skill: <name>@<version>
Vector: [exfil|creds|backdoor|dep|sandbox-evasion]
Tenants installed: <count>
First deployed (UTC): <timestamp>
Active invocations in last 5 min: <count>
Missed stage: [1-7 | unknown]
```

---

## Step 1 — Quarantine the skill (within 30 minutes)

The skill registry is DDB-backed; quarantine is a single-item update. See `packages/core/src/skills/registry.ts` for the canonical schema.

### 1a. Flip the META record to `QUARANTINE` trust level

The platform enforces a hard-deny on any skill whose `trustLevel = QUARANTINE`. This blocks new invocations platform-wide regardless of tenant installation.

```bash
export ENV=prod
export SKILL_NAME=<skill-name>
export INCIDENT_ID=<TICKET-ID>

aws dynamodb update-item \
  --table-name chimera-skills-${ENV} \
  --key "{\"PK\":{\"S\":\"SKILL#${SKILL_NAME}\"},\"SK\":{\"S\":\"META\"}}" \
  --update-expression "SET trustLevel = :q, quarantinedAt = :now, quarantinedBy = :ic, incidentId = :iid" \
  --expression-attribute-values "{
    \":q\":{\"S\":\"QUARANTINE\"},
    \":now\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"},
    \":ic\":{\"S\":\"$(whoami)\"},
    \":iid\":{\"S\":\"${INCIDENT_ID}\"}
  }" \
  --return-values ALL_NEW
```

Confirm the update propagated:

```bash
aws dynamodb get-item \
  --table-name chimera-skills-${ENV} \
  --key "{\"PK\":{\"S\":\"SKILL#${SKILL_NAME}\"},\"SK\":{\"S\":\"META\"}}" \
  --projection-expression "trustLevel,quarantinedAt,incidentId"
```

### 1b. Also mark every version record

The GSI3-trust index is keyed on the VERSION records' `trustLevel` attribute (see `registry.ts` lines 238–258). Missing these leaves a window where a tenant pinned to a specific version can still invoke.

```bash
# List all versions of the skill
aws dynamodb query \
  --table-name chimera-skills-${ENV} \
  --key-condition-expression "PK = :pk AND begins_with(SK, :sk)" \
  --expression-attribute-values "{
    \":pk\":{\"S\":\"SKILL#${SKILL_NAME}\"},
    \":sk\":{\"S\":\"VERSION#\"}
  }" \
  --projection-expression "SK,version,trustLevel" \
  --output json > /tmp/skill-versions.json

# Update each one
jq -r '.Items[].SK.S' /tmp/skill-versions.json | while read sk; do
  aws dynamodb update-item \
    --table-name chimera-skills-${ENV} \
    --key "{\"PK\":{\"S\":\"SKILL#${SKILL_NAME}\"},\"SK\":{\"S\":\"${sk}\"}}" \
    --update-expression "SET trustLevel = :q, quarantinedAt = :now" \
    --expression-attribute-values "{
      \":q\":{\"S\":\"QUARANTINE\"},
      \":now\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}
    }"
done
```

### 1c. Flip the global skill-disable SSM flag (nuclear option)

If the skill's invocation path bypasses the registry check (e.g., cached in an ECS task's memory), force every chat-gateway task to re-read the registry on the next request:

```bash
aws ssm put-parameter \
  --name /chimera/skills/quarantine-list/${ENV} \
  --type StringList \
  --value "${SKILL_NAME}" \
  --overwrite

# Force ECS tasks to recycle and pick up the new parameter
aws ecs update-service \
  --cluster chimera-chat \
  --service chat-sdk \
  --force-new-deployment
aws ecs wait services-stable --cluster chimera-chat --services chat-sdk
```

---

## Step 2 — Force-remove from all tenant runtime caches

Tenant agent runtimes cache skill metadata in memory. A quarantined skill can still execute for up to **5 minutes** after Step 1 unless caches are invalidated.

### 2a. Invalidate the agent-runtime skill cache

Agent runtimes read a "cache epoch" from SSM on every invocation. Bump it to invalidate every cache in the fleet.

```bash
# Read current epoch
CURRENT_EPOCH=$(aws ssm get-parameter \
  --name /chimera/agent-runtime/skill-cache-epoch/${ENV} \
  --query 'Parameter.Value' --output text 2>/dev/null || echo "0")

# Bump it
NEW_EPOCH=$(($(date +%s)))
aws ssm put-parameter \
  --name /chimera/agent-runtime/skill-cache-epoch/${ENV} \
  --value "${NEW_EPOCH}" --type String --overwrite

echo "Cache epoch: ${CURRENT_EPOCH} -> ${NEW_EPOCH}"
```

### 2b. Kill in-flight sessions using the skill

Query `chimera-sessions-${env}` for active sessions whose most-recent invocation references the compromised skill.

```bash
aws dynamodb scan \
  --table-name chimera-sessions-${ENV} \
  --filter-expression "#s = :active AND contains(invokedSkills, :sk)" \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values "{
    \":active\":{\"S\":\"ACTIVE\"},
    \":sk\":{\"S\":\"${SKILL_NAME}\"}
  }" \
  --projection-expression "PK,SK,sessionId,tenantId" \
  --output json > /tmp/sessions-using-skill.json

# Quarantine each session
jq -c '.Items[]' /tmp/sessions-using-skill.json | while read item; do
  pk=$(echo $item | jq -r '.PK.S')
  sk=$(echo $item | jq -r '.SK.S')
  aws dynamodb update-item \
    --table-name chimera-sessions-${ENV} \
    --key "{\"PK\":{\"S\":\"${pk}\"},\"SK\":{\"S\":\"${sk}\"}}" \
    --update-expression "SET #s = :q, quarantinedAt = :now, quarantineReason = :r" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{
      \":q\":{\"S\":\"QUARANTINED\"},
      \":now\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"},
      \":r\":{\"S\":\"skill-compromise:${INCIDENT_ID}\"}
    }"
done
```

### 2c. Remove the skill bundle from S3 (preserve for forensics)

Move rather than delete — the bundle is forensic evidence (Step 5).

```bash
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export SKILLS_BUCKET=chimera-skills-${ACCOUNT}-us-west-2-${ENV}
export EVIDENCE_BUCKET=s3://chimera-incident-evidence-${ENV}-$(date +%Y%m%d)

aws s3 mb ${EVIDENCE_BUCKET} --region us-west-2 2>/dev/null || true

# Copy all versions of the compromised skill to evidence bucket
aws s3 sync \
  s3://${SKILLS_BUCKET}/skills/${SKILL_NAME}/ \
  ${EVIDENCE_BUCKET}/compromised-skills/${SKILL_NAME}/

# Remove from the live bundle bucket (versioning preserves history)
aws s3 rm s3://${SKILLS_BUCKET}/skills/${SKILL_NAME}/ --recursive
```

---

## Step 3 — Audit the pipeline to find which stage missed it

The Step Functions state machine for the pipeline is `chimera-skill-pipeline-${env}` (see `skill-pipeline-stack.ts` line 318). Every execution is logged to `/aws/states/chimera-skill-pipeline-${env}`.

### 3a. Find the execution that admitted the compromised skill

```bash
# Get the skill's publishedAt timestamp
export PUBLISHED_AT=$(aws dynamodb get-item \
  --table-name chimera-skills-${ENV} \
  --key "{\"PK\":{\"S\":\"SKILL#${SKILL_NAME}\"},\"SK\":{\"S\":\"META\"}}" \
  --query 'Item.publishedAt.S' --output text)

echo "Skill was published at: ${PUBLISHED_AT}"

# Find state machine executions in a ±30 min window
aws stepfunctions list-executions \
  --state-machine-arn "arn:aws:states:us-west-2:${ACCOUNT}:stateMachine:chimera-skill-pipeline-${ENV}" \
  --status-filter SUCCEEDED \
  --max-results 100 \
  --query "executions[?starts_with(name, \`${SKILL_NAME}\`)].{Name:name,Start:startDate,Arn:executionArn}" \
  --output table
```

### 3b. Pull every stage's output from the execution history

```bash
export EXEC_ARN=<execution-arn-from-3a>

aws stepfunctions get-execution-history \
  --execution-arn ${EXEC_ARN} \
  --output json > /tmp/skill-pipeline-history.json

# Which stages passed?
jq -r '.events[] | select(.type == "TaskSucceeded") | .taskSucceededEventDetails.resource + " :: " + (.taskSucceededEventDetails.output | fromjson | tostring | .[0:200])' \
  /tmp/skill-pipeline-history.json
```

### 3c. Pull each stage Lambda's CloudWatch log for that invocation

```bash
for stage in static-analysis dependency-audit sandbox-test signature-verification performance-testing manual-review; do
  LG=/aws/lambda/chimera-skill-${stage}-${ENV}
  echo "=== ${stage} ==="
  aws logs filter-log-events \
    --log-group-name ${LG} \
    --start-time $(date -u -d "${PUBLISHED_AT} -30 minutes" +%s)000 \
    --end-time $(date -u -d "${PUBLISHED_AT} +30 minutes" +%s)000 \
    --filter-pattern "\"${SKILL_NAME}\"" \
    --output json > /tmp/${stage}.json
  jq -r '.events[] | .message' /tmp/${stage}.json | head -20
done
```

### 3d. Identify the CodeCommit commit that submitted the skill

```bash
# The publish event emits an audit record with the commit SHA
aws dynamodb query \
  --table-name chimera-audit-${ENV} \
  --key-condition-expression "PK = :pk" \
  --filter-expression "eventType = :et AND skillName = :sn" \
  --expression-attribute-values "{
    \":pk\":{\"S\":\"PLATFORM\"},
    \":et\":{\"S\":\"skill_published\"},
    \":sn\":{\"S\":\"${SKILL_NAME}\"}
  }" \
  --projection-expression "commitSha,author,publishedAt,pipelineExecutionArn"
```

Preserve the commit for forensics — do not force-delete it:

```bash
# Tag the commit in CodeCommit for auditors
export COMMIT_SHA=<sha-from-above>
aws codecommit put-file \
  --repository-name chimera-source-${ENV} \
  --branch-name main \
  --file-path .incident/skill-compromise-${INCIDENT_ID}.md \
  --file-content "$(echo "Incident ${INCIDENT_ID}: commit ${COMMIT_SHA} published compromised skill ${SKILL_NAME}" | base64)" \
  --parent-commit-id $(aws codecommit get-branch --repository-name chimera-source-${ENV} --branch-name main --query 'branch.commitId' --output text)
```

---

## Step 4 — Rotate secrets touched by the skill

Any secret the skill's IAM role could read must be considered compromised.

### 4a. Identify the skill's IAM role + attached policies

Skills execute under a per-skill IAM role named `chimera-skill-${SKILL_NAME}-${env}` (provisioned at deploy time in Stage 7).

```bash
export SKILL_ROLE=chimera-skill-${SKILL_NAME}-${ENV}

aws iam list-attached-role-policies --role-name ${SKILL_ROLE}
aws iam list-role-policies --role-name ${SKILL_ROLE}

# Dump each inline policy
aws iam list-role-policies --role-name ${SKILL_ROLE} --output json \
  | jq -r '.PolicyNames[]' | while read p; do
      aws iam get-role-policy --role-name ${SKILL_ROLE} --policy-name ${p} \
        --query 'PolicyDocument' --output json > /tmp/policy-${p}.json
    done
```

### 4b. Enumerate Secrets Manager secrets the role can read

```bash
# Look at the Resource ARNs in each policy
jq -r '.Statement[] | select(.Effect == "Allow") | .Resource' /tmp/policy-*.json \
  | grep "secretsmanager" | sort -u
```

### 4c. Rotate each one

For each secret ARN from 4b:

```bash
export SECRET_ARN=<arn>

# Trigger immediate rotation (requires a rotation Lambda configured on the secret)
aws secretsmanager rotate-secret --secret-id ${SECRET_ARN}

# If no rotation Lambda: update the value manually
aws secretsmanager put-secret-value \
  --secret-id ${SECRET_ARN} \
  --secret-string "$(openssl rand -base64 48)" \
  --version-stages AWSCURRENT
```

### 4d. Revoke the skill's IAM role

The role should no longer be assumable. Delete inline policies and deny AssumeRole:

```bash
# Attach an explicit deny on AssumeRole trust
aws iam update-assume-role-policy \
  --role-name ${SKILL_ROLE} \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Deny",
      "Principal": "*",
      "Action": "sts:AssumeRole"
    }]
  }'

# Tag with incident ID so the cleanup job knows why
aws iam tag-role --role-name ${SKILL_ROLE} \
  --tags "Key=ChimeraIncident,Value=${INCIDENT_ID}" \
         "Key=ChimeraQuarantined,Value=$(date -u +%Y-%m-%d)"
```

### 4e. If the compromise vector was a dependency (supply chain)

Identify every other skill that pulls the same upstream package:

```bash
# Dependency metadata is stored on each skill's META record
aws dynamodb scan \
  --table-name chimera-skills-${ENV} \
  --filter-expression "contains(dependencies, :dep)" \
  --expression-attribute-values "{\":dep\":{\"S\":\"<package-name>@<version>\"}}" \
  --projection-expression "PK,SK,version,trustLevel" \
  --output table
```

Apply Step 1 (quarantine) to **every** result. File CVE tracking entries in `docs/security/cve-tracking.md` and escalate to the upstream maintainer via security@ if the CVE isn't already public.

---

## Step 5 — Forensics preservation

Before any cleanup, snapshot the evidence. The evidence bucket is the one created in Step 2c.

### 5a. Export the skill's audit trail

```bash
aws dynamodb query \
  --table-name chimera-audit-${ENV} \
  --key-condition-expression "PK = :pk" \
  --filter-expression "skillName = :sn" \
  --expression-attribute-values "{
    \":pk\":{\"S\":\"PLATFORM\"},
    \":sn\":{\"S\":\"${SKILL_NAME}\"}
  }" \
  --output json > /tmp/audit-${SKILL_NAME}.json

# Also scan every tenant partition for invocations of this skill
aws dynamodb scan \
  --table-name chimera-audit-${ENV} \
  --filter-expression "skillName = :sn" \
  --expression-attribute-values "{\":sn\":{\"S\":\"${SKILL_NAME}\"}}" \
  --output json > /tmp/audit-tenant-invocations.json

sha256sum /tmp/audit-${SKILL_NAME}.json /tmp/audit-tenant-invocations.json
aws s3 cp /tmp/audit-${SKILL_NAME}.json ${EVIDENCE_BUCKET}/audit/
aws s3 cp /tmp/audit-tenant-invocations.json ${EVIDENCE_BUCKET}/audit/
```

### 5b. Snapshot the skills DDB partition

```bash
aws dynamodb create-backup \
  --table-name chimera-skills-${ENV} \
  --backup-name "incident-${INCIDENT_ID}-skills-$(date +%Y%m%d-%H%M)"
```

### 5c. Lock the evidence bucket (7-year retention)

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

---

## Step 6 — Tenant notification + incident report

Every tenant that installed the compromised skill requires notification.

### 6a. List affected tenants

```bash
aws dynamodb scan \
  --table-name chimera-skills-${ENV} \
  --filter-expression "begins_with(PK, :t) and contains(SK, :sk)" \
  --expression-attribute-values "{
    \":t\":{\"S\":\"TENANT#\"},
    \":sk\":{\"S\":\"SKILL#${SKILL_NAME}\"}
  }" \
  --projection-expression "PK,SK,installedAt,installedVersion" \
  --output json > /tmp/affected-tenants.json

jq -r '.Items[].PK.S' /tmp/affected-tenants.json | sort -u > /tmp/affected-tenant-ids.txt
wc -l /tmp/affected-tenant-ids.txt
```

### 6b. Notification template

```
Subject: Security notice — skill "<name>" removed from your Chimera tenant

We are writing to inform you that on <UTC date>, we discovered and removed
a security issue in the skill "<name>" (version <X>) that was installed on
your tenant account (<TENANT_ID>).

What we found:
  - Compromise vector: <exfiltration | credential access | backdoor | supply-chain>
  - Window of exposure: <installedAt> to <quarantinedAt>
  - Invocations from your tenant during exposure: <count>

What we have done:
  - The skill has been quarantined platform-wide; it can no longer execute.
  - All credentials the skill was authorized to read have been rotated.
  - A full forensic snapshot of skill activity is preserved for 7 years.

What you should do:
  - Rotate any API keys or webhook secrets the skill had access to.
  - Review activity in your audit log: https://<console>/audit?skill=<name>
  - Contact security@<domain> for the detailed incident report.

Incident report follows within 30 days.

— Chimera Security Team
```

### 6c. File the incident report

- Post-mortem template: `docs/runbooks/incident-response.md` SEV1 template
- Include: compromise vector, which of the 7 stages missed it, why, what detection/prevention task closes the gap
- File a detection-gap seeds task — do NOT close the incident without a `sd create --title "Detection gap: <stage>"` reference

---

## Rollback (in case quarantine was a false positive)

Only if forensics confirms no actual compromise occurred:

```bash
# 1. Restore trustLevel on META
aws dynamodb update-item \
  --table-name chimera-skills-${ENV} \
  --key "{\"PK\":{\"S\":\"SKILL#${SKILL_NAME}\"},\"SK\":{\"S\":\"META\"}}" \
  --update-expression "SET trustLevel = :t REMOVE quarantinedAt, quarantinedBy, incidentId" \
  --expression-attribute-values "{\":t\":{\"S\":\"VERIFIED\"}}"

# 2. Remove from quarantine SSM list
aws ssm put-parameter \
  --name /chimera/skills/quarantine-list/${ENV} \
  --type StringList --value "-" --overwrite

# 3. Restore skill bundle from evidence bucket
aws s3 sync \
  ${EVIDENCE_BUCKET}/compromised-skills/${SKILL_NAME}/ \
  s3://${SKILLS_BUCKET}/skills/${SKILL_NAME}/

# 4. Reinstate IAM role trust policy (pull from terraform/CDK template)
# 5. Tenant notification retracting the original alert
```

**Evidence bucket remains locked for 7 years regardless of rollback** — required for audit trail integrity.

---

## Closeout Checklist

Before closing the SEV ticket:

- [ ] Skill META + all VERSION records have `trustLevel = QUARANTINE`
- [ ] Global quarantine SSM list updated + ECS recycled
- [ ] Cache epoch bumped
- [ ] In-flight sessions quarantined
- [ ] Skill bundle moved to evidence bucket; live S3 cleared
- [ ] 7-stage pipeline execution history pulled; missing stage identified
- [ ] CodeCommit commit SHA tagged with incident ID
- [ ] Every secret the skill's IAM role could read is rotated
- [ ] IAM role trust policy replaced with explicit Deny
- [ ] If supply-chain: every other skill using the same dep is quarantined
- [ ] Audit trail exported to evidence bucket + SHA-256 logged
- [ ] Evidence bucket locked (7-year COMPLIANCE retention)
- [ ] DDB on-demand backup of `chimera-skills-${env}` taken
- [ ] Affected tenants enumerated + notified (Legal sign-off captured)
- [ ] Detection-gap seeds issue filed against the missed stage
- [ ] CVE entry added to `docs/security/cve-tracking.md` (if applicable)
- [ ] Post-mortem scheduled within 48h; docs task filed for runbook improvements

---

## Common Failure Modes During Response

| Symptom | Cause | Fix |
|---------|-------|-----|
| Quarantine doesn't take effect within 5 min | Agent runtime cache epoch not bumped | Run Step 2a |
| Affected-tenant scan returns 0 but Cedar logs show invocations | Install records use `SKILL#<n>` not `SKILL#<n>@<v>` | Re-scan with `contains(SK, :sk)` instead of `=` |
| `update-item` on META fails `ResourceNotFoundException` | Wrong env suffix | Verify `${ENV}` — staging vs prod tables are distinct |
| Skill bundle sync to evidence bucket partial | S3 versioning timing | Re-run `aws s3 sync` — it is idempotent |
| IAM role still assumable after Deny policy | Long-lived session credentials still valid | Revoke via `iam revoke-old-sessions` (max TTL 12h) |
| Cedar decisions still ALLOW after QUARANTINE | Cedar policy doesn't check skill trustLevel | File emergency `forbid` policy per [security-incident-tenant-breach.md Step 2](./security-incident-tenant-breach.md) |

---

## Cross-References

- [Security Incident: Tenant Breach](./security-incident-tenant-breach.md) — If the skill was used to breach another tenant
- [Alarm Runbooks: skills-throttles](./alarm-runbooks.md#skills-table-throttle-alarm) — Pre-incident signal (invocation surge)
- [Alarm Runbooks: audit-throttles](./alarm-runbooks.md#audit-table-throttle-alarm) — Cedar policy denial storm detector
- [Canonical Data Model](../architecture/canonical-data-model.md) — `chimera-skills` table schema (META vs VERSION items)
- [Skill Pipeline Stack](../../infra/lib/skill-pipeline-stack.ts) — 7-stage pipeline definition
- [Skill Registry](../../packages/core/src/skills/registry.ts) — TypeScript adapter (`getSkill`, `listVersions`, etc.)
- [Incident Response](./incident-response.md) — Broader SEV1/SEV2 structure
- [DDB PITR Restore](./ddb-pitr-restore.md) — Companion runbook if a skill tampered with shared state
- [CVE Tracking](../security/cve-tracking.md) — Supply-chain CVE log
- [DR Runbook Gaps](../reviews/dr-runbook-gaps.md) — Why this runbook exists

---

**Owner:** Security on-call (primary), Skills team (secondary)
**Next review:** 2026-07-22 (quarterly) — or immediately after any real skill-compromise incident
