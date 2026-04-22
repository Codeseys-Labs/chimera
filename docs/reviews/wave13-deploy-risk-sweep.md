---
title: "Wave-13 Deploy-Risk Sweep: baladita+Bedrock-Admin first deploy"
date: 2026-04-20
reviewer: Wave-13 Reviewer D
target_runbook: docs/runbooks/first-deploy-baladita.md
verdict: 1 risk OUTDATED, 6 accurate, 2 new risks identified
---

# Wave-13 Deploy-Risk Sweep

Re-validation of the 7 deploy risks in `docs/runbooks/first-deploy-baladita.md`
against current `main` (post-commit `851dcff`). Scope: TS CLI + CDK infra only;
AWS CLI spot-checks were blocked by the sandbox so Bedrock model access and
service quotas could not be independently verified.

## Per-risk verdict

| # | Risk | Verdict | Evidence |
|---|------|---------|----------|
| 1 | CDK bootstrap auto-detect | **ACCURATE** (but mitigation is already automated) | `deploy.ts:93-125` — `ensureCdkBootstrap()` does `DescribeStacks CDKToolkit`, auto-runs `npx cdk bootstrap` on miss, logs `skipped` on error. `chimera doctor` already saw v31 `UPDATE_COMPLETE`, so this codepath short-circuits to `'already'`. Runbook's "pre-run `npx cdk bootstrap`" advice is now belt-and-suspenders, not required. |
| 2 | Endpoint collection racy during pipeline | **ACCURATE** | `deploy.ts:155-195` (`autoCollectEndpoints`) queries 4 stacks in one `Promise.all` with no retry. If `Api`/`Security` outputs are absent it returns `false` and prints "Endpoints not available yet — run chimera endpoints". User-facing message still tells them to re-run. No retry/backoff was added. |
| 3 | `setup` silent-fails if Security not live | **ACCURATE but softer than runbook implies** | `deploy.ts:649-672` now catches the error and prints `Admin setup deferred: <msg>` + `Password saved. Run "chimera setup" after the pipeline finishes.` The standalone `setup.ts` itself fails loudly with `NO_EMAIL` / `NO_PASSWORD` / stack-not-found. "Silent" is an overstatement — it's deferred-with-warning. Mitigation ("re-run `chimera setup`") still valid. |
| 4 | CodeCommit branch must match pipeline context | **ACCURATE** | `infra/bin/chimera.ts:148` — `branch: app.node.tryGetContext('branch') ?? 'main'`. `deploy.ts:573` hardcodes `pushToCodeCommit(..., 'main')`. `utils/codecommit.ts:201` default also `'main'`. All three aligned — no override path for `--branch` flag reaches CDK context, so don't pass `--context branch=...` without also changing the push. |
| 5 | `which cdk` returning Bun binary | **PARTIALLY OUTDATED** | No runtime `which cdk` check or Bun-binary detection exists in `deploy.ts`. Instead the file relies entirely on `Bun.$\`npx cdk ...\`` (lines 117, 393). The header comment (`deploy.ts:1-6`) documents *why* but there's no guard: if the user has `cdk` globally installed as a Bun binary, `npx cdk` still resolves to a registry-installed Node wrapper, so this is fine. Keep the risk listed — operators reading `which cdk` output and running it directly would still trip it — but it's not code-enforced. |
| 6 | Default 3-AZ NAT = $320/mo | **OUTDATED** ✅ confirmed | `infra/lib/network-stack.ts:33` — `natGateways: isProd ? 2 : 1`. Dev defaults to 1 NAT (~$120/mo). 3-AZ HA is prod-only. Runbook row updated in this sweep. |
| 7 | ECS Fargate first image pull 3-5 min | **ACCURATE** | Inherent AWS behavior; nothing to verify in-repo. |

## Bedrock model access — UNVERIFIED

The AWS CLI (`aws bedrock list-foundation-models`) was denied by the sandbox
(read-only). **Action item for operator:** run the command in the runbook
pre-flight manually and confirm Nova Lite + at least one Claude model appear.

## Service quotas — UNVERIFIED

Same sandbox denial blocked quota checks. The runbook's list (2 VPCs, 1-3 NAT
Gateways, 1 NLB + 1 ALB, 1 Cognito pool, 2 ECR repos, 1000 Lambda concurrency)
looks correct against the 14-stack topology. Operator should spot-check the
low-default quotas (NAT Gateway limit is 5/region; VPC is 5/region — default
account has 1 VPC already if never deployed, plenty of headroom).

## New deploy risks the runbook doesn't mention

### NEW-1: Frontend deploy runOrder requires CDK to succeed first (MEDIUM)
`pipeline-stack.ts:1297-1314` — Deploy stage has `Cdk_Deploy` (runOrder 1) and
`Frontend_Deploy` (runOrder 2). Frontend deploy queries `Chimera-${env}-Frontend`
for `FrontendBucketName` output. If CDK deploy partially fails and FrontendStack
never reaches `CREATE_COMPLETE`, the frontend deploy step will error with
"Stack does not exist" — operator sees pipeline red at Deploy stage but the
root cause is upstream.

### NEW-2: buildspec deps on ec2:DescribeAvailabilityZones (LOW, already mitigated)
`pipeline-stack.ts:212-217` — Build CodeBuild role has `ec2:DescribeAvailabilityZones`
grant (added in commit `a7521e9`). This was historically missing and broke fresh
deploys when `cdk.context.json` wasn't committed. Confirmed fixed in current main.

### NEW-3: Dev bake is only 2 min (LOW, intentional)
`pipeline-stack.ts:1064-1068` — Dev bake duration is 2 min (prod 30, staging 10).
This is short enough that a cold-start Fargate task that takes 3-5 min to pull
the first ECR image (risk #7) may still be pulling when validation runs. The
validation Lambda treats missing metrics as `PASS` (`treatMissingData` not set,
and no-invocations → 0 error rate), so first deploys pass silently without real
signal. Worth adding to the "what's deliberately NOT in v0.6.0" list as known.

## Overall verdict

Runbook is materially accurate. One risk (#6) was already outdated — fixed in
this sweep. Risk #5 is half-stale (no code-level guard, but `npx cdk` is
enforced end-to-end so the failure mode is operator-only). Deploy should
proceed once operator confirms Bedrock model access + checks frontend stack
doesn't leave the pipeline in a confusing half-red state.
