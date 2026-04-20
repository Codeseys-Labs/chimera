# CDK Deploy Failure Recovery

> Classification and recovery playbook for every failure class that can occur during `npx cdk deploy` or `chimera deploy`

**Last Updated:** 2026-04-17
**Audience:** On-call engineers, release managers, platform team
**Severity class:** SEV2 (deploy blocked) / SEV1 (production stack in `UPDATE_ROLLBACK_FAILED`)
**RTO target:** 2 hours to a green deploy or an intentional hold
**Related:** [Deployment Runbook](./deployment.md), [Incident Response](./incident-response.md), [ADR-005 AWS CDK](../architecture/decisions/ADR-005-aws-cdk-iac.md), [ADR-021 npx for CDK](../architecture/decisions/ADR-021-npx-for-cdk-commands.md), [ADR-032 CodeBuild-delegated destroy](../architecture/decisions/ADR-032-codebuild-delegated-destroy.md)

---

## When to Use This Runbook

- `chimera deploy` exits non-zero and CloudFormation shows a stack in a non-terminal state (`UPDATE_IN_PROGRESS`, `UPDATE_ROLLBACK_FAILED`, `CREATE_FAILED`, etc.)
- Synthesis (`cdk synth`) fails with TypeScript or CDK-nag errors
- CodeBuild pipeline (`chimera-${env}-Deploy` project) reports deploy failure
- An operator sees CloudFormation drift on a stack that should be IaC-managed

**Do NOT use for:**
- Pre-deployment code quality issues (lint, tests) — fix locally before deploy.
- Runtime production incidents — see [incident-response.md](./incident-response.md).
- Accidental data loss during teardown — see [ddb-pitr-restore.md](./ddb-pitr-restore.md).

---

## Stack Dependency Order (14 production stacks)

From `infra/bin/chimera.ts`. The order matters because each stack imports CFN exports from the one above. Destroy proceeds in reverse order; redeploy proceeds in forward order.

```
1. Chimera-${env}-Network            (VPC, subnets, NAT, SGs, VPC endpoints)
2. Chimera-${env}-Data               (6 DDB tables + 3 S3 buckets + DAX)   depends on: 1
3. Chimera-${env}-Security           (Cognito, WAF, KMS platformKey)       depends on: —
4. Chimera-${env}-Observability      (CW dashboards, SNS, alarms)          depends on: 2, 3
5. Chimera-${env}-Api                (API GW REST + WS, JWT authorizer)    depends on: 3, 2
6. Chimera-${env}-Pipeline           (CodePipeline, CodeCommit, ECR)       depends on: —
7. Chimera-${env}-SkillPipeline      (Step Functions 7-stage scan)         depends on: 2
8. Chimera-${env}-Chat               (ECS Fargate + ALB + SSE bridge)      depends on: 1, 2, 3, 6
9. Chimera-${env}-Orchestration      (EventBridge + SQS)                   depends on: 3
10. Chimera-${env}-Evolution         (self-modify engine)                  depends on: 2, 9
11. Chimera-${env}-TenantOnboarding  (Cedar policy store + Step Functions) depends on: 2, 3, 4
12. Chimera-${env}-Email             (SES inbound, Lambdas, SQS)           depends on: 2, 9
13. Chimera-${env}-Frontend          (S3 + CloudFront React SPA)           depends on: —
14. Chimera-${env}-Discovery         (Cloud Map registrations)             depends on: 5, 8, 3, 2, 6, 13
```

**Safe to redeploy independently** (no downstream consumers in CFN): `Security`, `Pipeline`, `Frontend`.

**Never redeploy independently** (downstream exports): `Network`, `Data`, `Api`.

---

## Failure Taxonomy

Match the symptom to a class, then jump to the matching recovery section.

| Class | Symptom | Typical root cause | Section |
|-------|---------|--------------------|---------|
| **F-SYN** | `cdk synth` fails before any CloudFormation call | TS error, ADR-022 missing `skipLibCheck`, wrong CDK context, cdk-nag violation | [§1](#class-f-syn-synthesis-error) |
| **F-THR** | `Rate exceeded`, `Throttling`, slow deploy | CFN / IAM / EC2 throttle | [§2](#class-f-thr-transient-throttle) |
| **F-DRF** | `Resource … does not exist` or `already exists` | Out-of-band change, deleted resource, manual create | [§3](#class-f-drf-drift--out-of-band-change) |
| **F-DEL** | `UPDATE_ROLLBACK_FAILED` on resource replacement | CDK tried to delete a retained resource with data | [§4](#class-f-del-hard-resource-deletion-during-update) |
| **F-IAM** | Deploy fails then succeeds on retry without code change | IAM eventual-consistency race | [§5](#class-f-iam-iam-eventual-consistency-race) |
| **F-STK** | `UPDATE_ROLLBACK_FAILED` with no obvious cause | Multi-resource update conflict; rollback itself failed | [§6](#class-f-stk-stuck-in-update_rollback_failed) |
| **F-DEP** | `Cannot delete stack: exports in use` | Downstream stack still imports an export | [§7](#class-f-dep-export-in-use-by-another-stack) |
| **F-BS** | Bootstrap-related error (`CDKToolkit` missing, asset bucket missing) | New account/region, or bootstrap rolled back | [§8](#class-f-bs-cdk-bootstrap-issue) |

---

## Pre-Deploy Hygiene Checklist

Run before every non-trivial deploy. Catches 80% of F-SYN and F-DRF before you burn CloudFormation quota.

- [ ] `bun install` — lockfile clean
- [ ] `bun run lint` — zero errors
- [ ] `bun run typecheck` — no TS errors
- [ ] `npx cdk synth --context environment=${ENV} -q` — synth succeeds
- [ ] `npx cdk diff --context environment=${ENV}` — diff reviewed, no surprise replacements
- [ ] Drift check on critical stacks:
      ```bash
      for stack in Chimera-${ENV}-Data Chimera-${ENV}-Security; do
        aws cloudformation detect-stack-drift --stack-name ${stack}
      done
      ```
- [ ] On-call is aware; change window in `#chimera-releases`
- [ ] Rollback plan documented in the deploy ticket

---

## Class F-SYN — Synthesis Error

**Failure happens before CloudFormation is touched.** Cheapest to fix.

### Symptoms
- `Error: Cannot find module '…'`
- `TypeError: … is not a function` (often `peer.canInlineRule` — bun vs npx issue)
- `AwsSolutions-IAM5: … must use wildcard … suppressed` (cdk-nag)
- `Error: CDK_DEFAULT_ACCOUNT` missing

### Recovery
```bash
# 1. Make sure you are using npx (NOT bunx) — ADR-021
command -v cdk  # should not be in use — always run `npx cdk`

# 2. Confirm toolchain
node --version     # >= 18
bun --version      # >= 1.1
cat infra/tsconfig.json | grep skipLibCheck  # must be true — ADR-022

# 3. Synth with verbose output
cd infra
npx cdk synth --context environment=dev --verbose 2>&1 | tee /tmp/synth.log

# 4. For cdk-nag errors, check the suppressions file:
grep -R "<RULE_ID>" infra/cdk-nag-suppressions.ts || echo "missing suppression"
```

### Escalation
If synth works on a peer's machine but not yours: clean reinstall.

```bash
rm -rf node_modules bun.lock
bun install
```

**Abort.** Do not deploy past a synth error. Fix code, commit, re-run.

---

## Class F-THR — Transient Throttle

### Symptoms
- `Rate exceeded` in CloudFormation events
- `Throttling: Rate exceeded` from EC2 / IAM / Lambda APIs
- Deploy succeeds on retry without any code change

### Recovery

```bash
# 1. Check CloudFormation stack status
aws cloudformation describe-stacks --stack-name Chimera-${ENV}-<FAILED_STACK> \
  --query 'Stacks[0].StackStatus'

# 2. If status is UPDATE_ROLLBACK_COMPLETE (clean rollback), just retry
npx cdk deploy Chimera-${ENV}-<FAILED_STACK> --context environment=${ENV}

# 3. If status is UPDATE_IN_PROGRESS, WAIT — do not cancel
# CloudFormation retries internally with exponential backoff for throttles
aws cloudformation describe-stack-events --stack-name Chimera-${ENV}-<FAILED_STACK> \
  --max-items 20 \
  --query 'StackEvents[].{Time:Timestamp,Status:ResourceStatus,Reason:ResourceStatusReason}'
```

**Do not** run `continue-update-rollback` during an in-progress deploy — it creates split-brain state.

### Prevention
- Use `--concurrency 2` (CDK default is 10) on large deploys to back off from CFN:
  ```bash
  npx cdk deploy --all --concurrency 2 --context environment=${ENV}
  ```
- Schedule large deploys off-peak (us-west-2 daytime is the throttle hotspot).

---

## Class F-DRF — Drift / Out-of-Band Change

### Symptoms
- `Resource does not exist` on update (someone deleted it via console)
- `Resource already exists` on create (someone created it manually)
- `Parameter path not found` — SSM param changed by another tool

### Recovery

**Path A: Someone deleted a resource CloudFormation thought it owned**

```bash
# Use cloudformation import to reconcile
# 1. Detect drift
aws cloudformation detect-stack-drift --stack-name Chimera-${ENV}-<STACK>
aws cloudformation describe-stack-drift-detection-status \
  --stack-drift-detection-id <ID>

# 2. If resource is truly gone, remove it from the template and deploy
#    (edit the CDK source, re-synth, deploy)

# 3. If resource was recreated manually and is functional, IMPORT it:
aws cloudformation get-template \
  --stack-name Chimera-${ENV}-<STACK> \
  --template-stage Processed > /tmp/current-template.json

# Build resources-to-import.json with the logical ID + physical ID mapping
# Then:
aws cloudformation create-change-set \
  --stack-name Chimera-${ENV}-<STACK> \
  --change-set-name import-drifted-$(date +%s) \
  --change-set-type IMPORT \
  --resources-to-import file:///tmp/resources-to-import.json \
  --template-body file:///tmp/current-template.json
```

**Path B: Someone created a conflicting resource**

Rename the manual resource OR remove it from AWS, then redeploy:

```bash
# Example: Cognito user pool manually named chimera-users-prod
aws cognito-idp update-user-pool \
  --user-pool-id <POOL_ID> \
  --pool-name chimera-users-prod-manual-migrate-me

# Then redeploy
npx cdk deploy Chimera-${ENV}-Security --context environment=${ENV}
```

### Prevention
- Lock CloudFormation stacks with `deletion-protection` (already set for all prod stacks with `RETAIN` resources).
- SCPs forbidding `cloudformation:UpdateStack` + direct mutating API calls on CDK-managed resource types.

---

## Class F-DEL — Hard Resource Deletion During Update

### Symptoms
- CloudFormation shows `UPDATE_ROLLBACK_FAILED`
- Failed resource is a DynamoDB table, S3 bucket, KMS key, or Cognito user pool
- Stack event says `DELETE_FAILED` then `UPDATE_ROLLBACK_FAILED`

This is the **most dangerous class.** CDK tried to replace a stateful resource and CloudFormation couldn't delete the old one because it had data or deletion protection.

### Recovery

```bash
# 1. Identify which resource failed to delete
aws cloudformation describe-stack-events \
  --stack-name Chimera-${ENV}-Data \
  --max-items 50 \
  --query 'StackEvents[?ResourceStatus==`DELETE_FAILED` || ResourceStatus==`UPDATE_ROLLBACK_FAILED`].{LogicalId:LogicalResourceId,Reason:ResourceStatusReason}' \
  --output table

# 2. DO NOT DELETE THE RESOURCE MANUALLY. Skip it during rollback:
aws cloudformation continue-update-rollback \
  --stack-name Chimera-${ENV}-Data \
  --resources-to-skip <LogicalResourceIdA> <LogicalResourceIdB>

# 3. Wait for UPDATE_ROLLBACK_COMPLETE
aws cloudformation wait stack-update-rollback-complete \
  --stack-name Chimera-${ENV}-Data
```

Now the stack thinks those resources are gone, but they still exist in your account. Re-import them:

```bash
# Build resources-to-import.json with original logical IDs and ARNs
# Then run an IMPORT change set (see Class F-DRF Path A)
```

### When to escalate
If the failed resource is `chimera-audit-${env}` (CMK-encrypted) or `chimera-tenants-${env}` — **open AWS Support SEV2 before skipping**. These hold compliance-critical data and the skip-then-import path is narrow.

### Prevention
- All stateful resources use `RemovalPolicy.RETAIN` in prod (`data-stack.ts`, `security-stack.ts`).
- Never change the `tableName` / `bucketName` of a stateful resource in CDK — that triggers replacement.
- Rename changes must go through a dual-write migration first.

---

## Class F-IAM — IAM Eventual-Consistency Race

### Symptoms
- Deploy fails during `CREATE_IN_PROGRESS` of a Lambda or ECS task
- Error message mentions `AccessDenied` or `NoPermission` on an action the role clearly has in the template
- Retry **without code changes** succeeds

### Recovery

```bash
# 1. Wait 60 seconds for IAM to propagate
sleep 60

# 2. Continue the in-progress rollback (if stack rolled back)
aws cloudformation describe-stacks --stack-name Chimera-${ENV}-<STACK> \
  --query 'Stacks[0].StackStatus'

# 3. Re-run the deploy
npx cdk deploy Chimera-${ENV}-<STACK> --context environment=${ENV}
```

### Prevention
- Insert explicit CDK `CfnResource` `DependsOn` between the role and its consumer when deploying a resource that immediately uses the role (e.g., Lambda function → IAM role).
- Step Functions tasks: configure retry with `errors: ['States.ALL']` (ADR-021 pattern).

---

## Class F-STK — Stuck in UPDATE_ROLLBACK_FAILED

### Symptoms
- Stack status: `UPDATE_ROLLBACK_FAILED`
- No in-progress change set
- `npx cdk deploy` errors immediately with "stack is in UPDATE_ROLLBACK_FAILED state"

### Recovery

```bash
# 1. Identify which resource(s) blocked the rollback
aws cloudformation describe-stack-events \
  --stack-name Chimera-${ENV}-<STACK> \
  --max-items 100 \
  --query 'StackEvents[?ResourceStatus==`UPDATE_ROLLBACK_FAILED`]'

# 2. Option A: skip the problem resources
aws cloudformation continue-update-rollback \
  --stack-name Chimera-${ENV}-<STACK> \
  --resources-to-skip <LogicalA> <LogicalB>

# 3. Option B: fix the underlying issue then continue
# Example: Lambda function failed to delete because a version is in use
#   - Remove provisioned concurrency manually
#   - aws cloudformation continue-update-rollback --stack-name ...

# 4. Wait to UPDATE_ROLLBACK_COMPLETE
aws cloudformation wait stack-update-rollback-complete \
  --stack-name Chimera-${ENV}-<STACK>

# 5. Redeploy clean
npx cdk deploy Chimera-${ENV}-<STACK> --context environment=${ENV}
```

### CLI helper

The CLI ships a `chimera cleanup` subcommand for `ROLLBACK_COMPLETE` stacks (see `packages/cli/src/commands/destroy.ts` around line 714). Use when a clean new-stack create failed:

```bash
chimera cleanup --env ${ENV}
chimera redeploy --env ${ENV}
```

---

## Class F-DEP — Export In Use By Another Stack

### Symptoms
- Destroy fails with `Export … is in use by stack …`
- Update fails with `Cannot update exported output`

### Recovery

```bash
# 1. Find the consumer
aws cloudformation list-imports --export-name <EXPORT_NAME>

# 2. Either (a) redeploy the consumer first to unbind,
#    or (b) skip the update of the export and reintroduce it after the consumer is updated

# Typical pattern: Network exports VPC ID, every other stack imports it.
# If you must replace the VPC, redeploy EVERY downstream stack first to a
# temporary vpc-import context, destroy Network, recreate, re-deploy.
# This is an all-hands maintenance window.
```

### Prevention
- Never replace the VPC, Cognito User Pool, or DDB table logical IDs in CDK — these propagate exports across ≥8 stacks.
- If a rename is required, stage it across 2 releases: release N adds a new export alongside old; release N+1 drops the old.

---

## Class F-BS — CDK Bootstrap Issue

### Symptoms
- `This stack uses assets, so the toolkit stack must be deployed`
- `CDKToolkit stack is in ROLLBACK_COMPLETE state`
- Deploy says `Could not find assumable role arn:aws:iam::…:role/cdk-<qualifier>-…`

### Recovery

```bash
# Bootstrap the account + region (idempotent)
npx cdk bootstrap aws://<ACCOUNT>/<REGION> \
  --context environment=${ENV} \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess

# If CDKToolkit is in ROLLBACK_COMPLETE, delete and re-bootstrap:
aws cloudformation delete-stack --stack-name CDKToolkit
aws cloudformation wait stack-delete-complete --stack-name CDKToolkit
npx cdk bootstrap
```

Note: `packages/cli/src/commands/deploy.ts` (around line 90) auto-bootstraps on first run. If you're running `npx cdk` by hand, you are responsible.

---

## Destroy Path (last resort)

When recovery via rollback / import is not feasible and the environment is non-prod:

```bash
chimera destroy --env ${ENV} --force
```

`chimera destroy` (see `packages/cli/src/commands/destroy.ts` + ADR-032):

1. Triggers CodeBuild `chimera-${env}-Deploy` with `ACTION=destroy` — runs `npx cdk destroy --all` inside a VPC-attached builder (needed to delete VPC-resident ENIs cleanly)
2. Falls back to direct `aws cloudformation delete-stack` if CodeBuild fails
3. Deletes stacks in reverse dependency order (Discovery → Frontend → ... → Data → Network)
4. `--retain-data` exports DDB tables to S3 first
5. `--keep-repo` preserves the CodeCommit source

**Do not use `--force` in prod.** The `RemovalPolicy.RETAIN` guards on stateful resources will **still** block deletion, but misuse here is how data loss happens. In prod, always go via Option-skip + continue-rollback first.

---

## Escalation to AWS Support

Open a Support case **SEV2** (24/7 for Business/Enterprise) when:

- A CloudFormation stack has been `UPDATE_IN_PROGRESS` for > 4 hours with no event progress
- `continue-update-rollback --resources-to-skip` returns `Invalid state`
- A KMS key or CMK used by a retained table appears in an unrecoverable state
- CloudFormation is silently retrying and consuming our rate limit budget for other workloads

Open SEV1 when:

- Production `Chimera-prod-Data` or `Chimera-prod-Security` is stuck in `UPDATE_ROLLBACK_FAILED` and affects running traffic

Provide in the support case:
1. Stack ARN + event timeline (`describe-stack-events` output)
2. CDK version (`npx cdk --version`) and CDK context (`cdk.context.json`)
3. The synth artifact (`cdk.out/Chimera-${env}-<Stack>.template.json`)
4. The commit SHA being deployed

---

## Post-Recovery Checklist

- [ ] Stack is `UPDATE_COMPLETE` or `CREATE_COMPLETE` — verify with `describe-stacks`
- [ ] Drift detection clean: `aws cloudformation detect-stack-drift …`
- [ ] Downstream stacks healthy (Discovery, Chat, Api)
- [ ] Smoke-test: hit `/v1/health` on API Gateway; `curl` the ALB DNS; log in via Cognito Hosted UI
- [ ] Close all `CREATE_FAILED` / `UPDATE_FAILED` alarms in CloudWatch
- [ ] File an incident task if the failure class was F-STK or F-DEL — these indicate a missed hygiene gap
- [ ] Update [deployment.md](./deployment.md) with any new `resources-to-skip` patterns
- [ ] If an AWS Support case was opened, attach the final resolution to the ticket

---

## Related Documents

- [Deployment Runbook](./deployment.md) — Happy-path deploy procedure
- [First Deployment](./first-deployment.md) — Initial account setup
- [Incident Response](./incident-response.md) — Broader SEV structure
- [ADR-005: AWS CDK as IaC](../architecture/decisions/ADR-005-aws-cdk-iac.md)
- [ADR-021: npx (not bunx) for CDK](../architecture/decisions/ADR-021-npx-for-cdk-commands.md)
- [ADR-022: skipLibCheck for CDK synth](../architecture/decisions/ADR-022-skipLibCheck-cdk-synth.md)
- [ADR-032: CodeBuild-delegated destroy](../architecture/decisions/ADR-032-codebuild-delegated-destroy.md)
- [DR Runbook Gaps](../reviews/dr-runbook-gaps.md) — Why this runbook exists

---

**Owner:** Platform on-call
**Next review:** 2026-07-17 (quarterly) — or after any stuck deploy incident
