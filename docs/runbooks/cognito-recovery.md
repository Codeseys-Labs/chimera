# Cognito User Pool Recovery

> Recovery playbook for Cognito user pool deletion, attribute corruption, and tenant-binding loss

**Last Updated:** 2026-04-22
**Audience:** On-call engineers, SREs, identity / security team
**Severity class:** SEV1 (prod pool deleted or mass-corruption) / SEV2 (single tenant attribute lost)
**RTO target:** 4 hours to a restored pool with users re-invited to reset passwords
**RPO target:** 7 days (weekly S3 export cadence — see [disaster-recovery.md](../guides/disaster-recovery.md) Drill Schedule)
**Related:** [Disaster Recovery Guide](../guides/disaster-recovery.md), [Incident Response](./incident-response.md), [Security Incident — Tenant Breach](./security-incident-tenant-breach.md), [DDB PITR Restore](./ddb-pitr-restore.md)

---

## Why This Runbook Exists

Cognito does **not** expose a first-party backup or export API. Once a user pool is deleted, the users inside it are gone — there is no "undelete". Password hashes are never retrievable even while the pool exists. The platform's tenant-binding attribute `custom:tenant_id` is carried inside Cognito and nowhere else, so a pool loss silently detaches every session from its tenant partition in DynamoDB.

This runbook exists because those three gaps combined would make a casual deletion catastrophic. We compensate with:

1. **Weekly S3 exports** of user attributes (`scripts/dr/export-cognito-users.sh`)
2. **CDK-managed pool definition** so the pool shape is reproducible from IaC
3. **This runbook** connecting the two into a workable recovery path

---

## Trigger Conditions

Use this runbook when any of the following is true:

| Trigger | Detection signal |
|---------|------------------|
| **User pool deleted** | CloudTrail event `DeleteUserPool`, Cognito console shows pool gone, Hosted UI 404s, API Gateway JWT authorizer returns `401 Unauthorized` on every request |
| **Mass attribute corruption** | Users report all sessions failing policy check, Cedar denial spike on principal `User::"..."`, `custom:tenant_id` missing or wrong on multiple users |
| **Single user attribute corruption** | Support ticket: "I can no longer access my tenant", single Cedar denial with `reason: tenant_mismatch` |
| **User pool client secret compromised** | GuardDuty finding on `CognitoIdentityPool` credentials, rotation required |
| **Accidental bulk `AdminDeleteUser`** | CloudTrail shows multiple `AdminDeleteUser` events from a single IAM identity within minutes |

Do **not** use this runbook for:
- A single user who forgot their password — self-service password reset via Hosted UI
- A tenant who requested deletion per GDPR — that is a scheduled deletion workflow, not a recovery

---

## Diagnostics

### 1. Confirm the damage via CloudTrail

```bash
# Look for pool-level destructive calls in the last 24 hours
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteUserPool \
  --start-time "$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)" \
  --max-results 50 \
  --query 'Events[].{Time:EventTime,User:Username,SourceIP:CloudTrailEvent}' \
  --output json

# Look for bulk per-user destruction
for event in AdminDeleteUser AdminDisableUser AdminUpdateUserAttributes; do
  echo "=== $event ==="
  aws cloudtrail lookup-events \
    --lookup-attributes AttributeKey=EventName,AttributeValue=$event \
    --start-time "$(date -u -v-6H +%Y-%m-%dT%H:%M:%SZ)" \
    --max-results 20 \
    --query 'Events[].{Time:EventTime,User:Username}' \
    --output table
done
```

Preserve the CloudTrail output — forensic evidence, especially if this recovery is triggered by a malicious actor.

### 2. Locate the last good S3 export

```bash
# Weekly exports land under chimera-backups-<acct>-<region>/cognito/<ts>/users.jsonl
aws s3 ls "s3://chimera-backups-${ACCOUNT}-${REGION}/cognito/" \
  --recursive \
  --human-readable \
  | sort -r \
  | head -20
```

The newest `users.jsonl` is your source of truth. If the newest is older than **7 days**, the weekly cadence has also broken — escalate the gap separately to avoid compounding the incident.

### 3. Inventory current pool state (if pool still exists)

```bash
# If the pool is present but corrupted, snapshot its current state
# BEFORE recovery so you can compare pre/post and build a delta
./scripts/dr/export-cognito-users.sh \
  --user-pool-id "$USER_POOL_ID" \
  --bucket "chimera-backups-${ACCOUNT}-${REGION}" \
  --prefix "cognito/incident-$(date -u +%Y%m%dT%H%M%SZ)"
```

This also acts as a rollback snapshot: if the recovery goes sideways you can re-diff.

---

## Recovery — Full Pool Deletion (SEV1)

### Step 1 — Recreate the pool via CDK re-deploy (30 min)

Cognito pool shape is defined in `infra/lib/security-stack.ts`. Re-deploying the stack will recreate the pool **with a different pool ID** — this is unavoidable.

```bash
# 1. Confirm the pool no longer exists
aws cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?contains(Name, 'chimera')]"

# 2. Remove the stale pool physical ID from SSM so CDK doesn't try to import
aws ssm delete-parameter --name /chimera/${ENV}/cognito/user-pool-id || true

# 3. Re-deploy the Security stack (note: npx, not bunx — ADR-021)
cd infra
npx cdk deploy Chimera-${ENV}-Security --context environment=${ENV}

# 4. Capture the NEW pool id
NEW_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name Chimera-${ENV}-Security \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' \
  --output text)
echo "New pool: $NEW_POOL_ID"
```

All dependent stacks (`Api`, `Chat`, `TenantOnboarding`) read the pool ID from SSM or CFN exports. Redeploy them if their `cdk diff` shows changes.

### Step 2 — Replay users from the S3 export (60 min)

Use `cognito-idp:admin-create-user` to re-invite each user. This sends a welcome email with a temporary password — users must then complete a password reset flow. **Passwords cannot be restored; the email cycle is mandatory.**

```bash
#!/usr/bin/env bash
# batch replay — pulls the latest users.jsonl and invites each user
set -euo pipefail

POOL_ID="$NEW_POOL_ID"
LATEST_EXPORT=$(aws s3 ls "s3://chimera-backups-${ACCOUNT}-${REGION}/cognito/" \
  | awk '{print $4}' | sort | tail -1)
aws s3 cp "s3://chimera-backups-${ACCOUNT}-${REGION}/cognito/${LATEST_EXPORT}users.jsonl" \
  /tmp/users.jsonl

python3 - <<'PYEOF'
import json, subprocess, sys, os

POOL_ID = os.environ["POOL_ID"]
with open("/tmp/users.jsonl") as f:
    for line in f:
        rec = json.loads(line)
        username = rec["Username"]
        # Filter out immutable server-set attributes
        attrs = [
            a for a in rec.get("Attributes", [])
            if a["Name"] not in ("sub", "email_verified", "phone_number_verified")
        ]
        email = next((a["Value"] for a in attrs if a["Name"] == "email"), None)
        if not email:
            print(f"SKIP {username} — no email attribute", file=sys.stderr)
            continue
        cmd = [
            "aws", "cognito-idp", "admin-create-user",
            "--user-pool-id", POOL_ID,
            "--username", email,
            "--user-attributes", json.dumps(attrs),
            "--desired-delivery-mediums", "EMAIL",
            "--message-action", "RESEND"
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            print(f"OK {email}")
        except subprocess.CalledProcessError as e:
            print(f"FAIL {email}: {e.stderr.decode()}", file=sys.stderr)
PYEOF
```

The script deliberately skips the `sub` UUID — Cognito re-assigns a new one on recreate. Downstream tables keyed by `sub` must be updated (Step 4).

### Step 3 — Users complete password reset via email (async, operator-parallel)

Cognito sends each re-invited user a one-time email with a temporary password. On first login the user is forced through the `NEW_PASSWORD_REQUIRED` flow. Monitor progression:

```bash
aws cognito-idp list-users \
  --user-pool-id "$NEW_POOL_ID" \
  --filter 'cognito:user_status = "FORCE_CHANGE_PASSWORD"' \
  --query 'Users[].Username' \
  --output text | wc -w

# As users complete reset, their status flips to CONFIRMED. Watch the count drop.
```

Communicate externally: status-page banner + email from a human account explaining "your account was restored; please use the password reset link; your data is intact". Do **not** send this via the automated Cognito email — the platform email account and the Cognito email account look different enough that users will report phishing.

### Step 4 — Re-link `custom:tenant_id` in DynamoDB (30 min)

The pool replay preserved `custom:tenant_id` on each user, but any row in `chimera-tenants-${env}` or `chimera-sessions-${env}` keyed on the OLD `sub` UUID is now orphaned. Walk each user and rewrite any references keyed on the old sub:

```bash
# Re-export users with the freshly-assigned new sub values
./scripts/dr/export-cognito-users.sh \
  --user-pool-id "$NEW_POOL_ID" \
  --bucket "chimera-backups-${ACCOUNT}-${REGION}" \
  --prefix "cognito/post-recovery-$(date -u +%Y%m%dT%H%M%SZ)"

# Run the sub-remapping migration — documented in
# docs/runbooks/ddb-pitr-restore.md §"User sub remapping"
# (cross-references a shared migration helper that is out of scope here)
```

Scan-and-rewrite at 6-table scale runs in < 15 minutes. If the job stalls, back it out — the sessions table has a 24 h TTL so orphaned rows self-heal; the tenants table is the only one that needs surgical remap.

### Step 5 — Verify

- [ ] `aws cognito-idp describe-user-pool --user-pool-id $NEW_POOL_ID` succeeds
- [ ] `list-users` count matches the S3 export line count (± expected deletions)
- [ ] Hosted UI renders for a test tenant
- [ ] A smoke test user can log in, land in their tenant, issue an API call that hits Cedar, see no `tenant_mismatch` denial
- [ ] CloudWatch alarm `ChimeraCognitoAuthFailureRate` back below threshold
- [ ] Post-mortem ticket filed

---

## Recovery — Single-User Attribute Corruption (SEV2)

Targeted fix, no pool re-deploy.

```bash
# 1. Pull the last good value from the S3 export
aws s3 cp "s3://chimera-backups-${ACCOUNT}-${REGION}/cognito/<ts>/users.jsonl" - \
  | grep '"Username": *"<target-username>"' \
  | python3 -c 'import json,sys; print(json.dumps(json.loads(sys.stdin.read()).get("Attributes", []), indent=2))'

# 2. Reapply the attribute
aws cognito-idp admin-update-user-attributes \
  --user-pool-id "$USER_POOL_ID" \
  --username "<target-username>" \
  --user-attributes Name=custom:tenant_id,Value="<correct-value>"

# 3. Invalidate the user's existing tokens so they re-fetch
aws cognito-idp admin-user-global-sign-out \
  --user-pool-id "$USER_POOL_ID" \
  --username "<target-username>"
```

Audit the change in `chimera-audit-${env}` within 5 minutes.

---

## Recovery — Client Secret Compromise (SEV1)

Less disruptive than pool recreation, but all active sessions get kicked.

```bash
# 1. Rotate the client secret (generates a new value)
aws cognito-idp update-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --generate-secret

# 2. Pull the new secret and push to Secrets Manager
NEW_SECRET=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --query 'UserPoolClient.ClientSecret' \
  --output text)

aws secretsmanager put-secret-value \
  --secret-id chimera/${ENV}/cognito/client-secret \
  --secret-string "$NEW_SECRET"

# 3. Force ECS tasks to pick up the new secret
aws ecs update-service \
  --cluster chimera-chat-${ENV} \
  --service chat-sdk \
  --force-new-deployment
```

All currently-issued JWTs become invalid on next rotation — users get a single-login-page blip, no data loss.

---

## Dependencies on Other Runbooks

- [ddb-pitr-restore.md](./ddb-pitr-restore.md) — referenced by Step 4 for the `sub` remapping helper. If the DDB restore runbook is itself in play (e.g., a concurrent data incident), do the DDB restore **first**, then Cognito — the remap needs a stable tenants table.
- [security-incident-tenant-breach.md](./security-incident-tenant-breach.md) — if the root cause of the Cognito damage is credential compromise, run the containment steps in that runbook in parallel (rotate IAM keys, enable MFA-delete on backup bucket) so the attacker can't replay the destruction while you recover.
- [incident-response.md](./incident-response.md) — SEV structure, paging, comms templates.

---

## Backup & Retention Schedule

| Artefact | Cadence | Retention | Storage class |
|----------|---------|-----------|---------------|
| `users.jsonl` via `export-cognito-users.sh` | **Weekly** (Monday 14:00 UTC via EventBridge) | 90 days hot | `STANDARD` in `chimera-backups-<acct>-<region>` |
| `users.jsonl` archived copies | After 90 days | 7 years (compliance) | `GLACIER_IR` via S3 Lifecycle policy |
| Pool CDK definition | Every commit | Forever | git main branch |
| Pool CloudTrail events | Continuous | 7 years | `chimera-cloudtrail-logs-<acct>` |

The 90-day hot window exists so a SEV2 recovery (single-user attribute fix) can pull the last export without a Glacier thaw. Everything older than 90 days costs ~5 hours to restore from Glacier IR — acceptable for compliance audits, not for operational recovery.

---

## Post-Recovery Checklist

- [ ] Pool ID captured in SSM, CFN outputs, and incident ticket
- [ ] All dependent stacks redeployed and reading new pool ID
- [ ] 100% of exported users re-invited (or intentionally skipped with written reason)
- [ ] User sub → tenant_id remap complete in DynamoDB
- [ ] Status page closed
- [ ] Forensic snapshot of the pre-incident state saved to `s3://.../cognito/incident-*`
- [ ] Post-mortem scheduled within 72 hours
- [ ] Updated this runbook with any gaps found during execution
- [ ] Filed seeds issue for every `NOT YET IMPLEMENTED` helper invoked

---

## Known Gaps

These are acknowledged limitations — acceptable now, planned for future waves:

1. **Passwords cannot be exported.** Cognito does not expose password hashes. Every recovery forces a password reset for every user. Mitigation: we document this prominently in the pre-incident comms template.
2. **MFA configurations are lost on pool recreate.** Users who had TOTP or SMS MFA enrolled will re-enroll on first login. The reset email flow prompts for this.
3. **Social / federated identities carry their IdP sub, not their Cognito sub.** Federated users (Google, Apple, SAML) can be re-invited but their old social-provider link must be rebuilt — the identity provider keeps its side, Cognito rebuilds its side.
4. **Pool-level lambda triggers** (pre-sign-up, pre-auth, post-confirm) are defined in CDK, so they redeploy cleanly — no manual restore step needed.

---

## Related Documents

- [Disaster Recovery Guide](../guides/disaster-recovery.md)
- [DDB PITR Restore](./ddb-pitr-restore.md)
- [Incident Response](./incident-response.md)
- [Security Incident — Tenant Breach](./security-incident-tenant-breach.md)
- [Security Stack CDK](../../infra/lib/security-stack.ts)
- [DR operator scripts](../../scripts/dr/)

---

**Owner:** Platform identity team
**Next review:** 2026-07-22 (quarterly) — or after any Cognito incident
