# First Deploy: `baladita+Bedrock-Admin` (v0.6.0)

> **Last Updated:** 2026-04-20
> **Target release:** `v0.6.0`
> **Owner:** baladita (first-time deploy operator)

This runbook walks through deploying Chimera v0.6.0 to the
`baladita+Bedrock-Admin` AWS account for the first time. It's annotated
with the 7 deploy-risk items a Wave-10 code review flagged in
`packages/cli/src/commands/deploy.ts`.

## Pre-flight (~15 min)

### AWS account prerequisites
- [ ] `aws sts get-caller-identity --profile baladita+Bedrock-Admin` returns expected account
- [ ] Bedrock model access approved for Nova Lite + Claude Sonnet/Opus in the target region
- [ ] Region chosen (`cdk.json` defaults to `us-west-2`)
- [ ] Cost budget alarm set on the account (recommended)
- [ ] Service quotas adequate: 2 VPCs, 1–3 NAT Gateways, 1 NLB + 1 ALB, 1 Cognito pool, 2 ECR repos, 1000 Lambda concurrency

### Tool prerequisites
- [ ] `chimera` binary installed:
  ```bash
  curl -L https://github.com/Codeseys-Labs/chimera/releases/download/v0.6.0/chimera-darwin-arm64.tar.gz | tar xz
  chmod +x chimera-darwin-arm64
  sudo mv chimera-darwin-arm64 /usr/local/bin/chimera
  chimera --version
  ```
- [ ] `which cdk` returns NOTHING or a Node wrapper — NOT a Bun binary (**risk #5**)
- [ ] Node 20+ for `npx cdk`
- [ ] Docker running if using `--source local`

### Secrets + config
- [ ] `chimera.toml` created via `chimera init`
- [ ] No secrets left in shell env

## Deploy sequence

### Phase 1 — `chimera init` (~2 min)

```bash
cd ~/code
chimera init
```

Wizard prompts:
- AWS profile → `baladita+Bedrock-Admin`
- Region → your chosen region
- Environment name → `dev`
- Source strategy → `git`
- Git remote → `https://github.com/Codeseys-Labs/chimera.git`
- Branch → `main` (**must match CodeCommit default branch**, risk #4)

### Phase 2 — `chimera deploy` (~40 min)

```bash
chimera deploy --source git --remote https://github.com/Codeseys-Labs/chimera.git
```

Stack dependency order (14 stacks):

1. Network — VPC, subnets, NAT, SGs, VPC endpoints
2. Data — 6 DDB tables, 3 S3 buckets
3. Security — Cognito, WAF, KMS
4. Observability — CloudWatch, SNS, alarms, PITR Config rule
5. Api — HTTP + WebSocket API Gateway
6. Pipeline — CodePipeline, CodeBuild, ECR
7. SkillPipeline — 7-stage skill security pipeline
8. Chat — ECS Fargate + ALB + CloudFront
9. Orchestration — EventBridge + SQS
10. Evolution — self-evolution stack
11. TenantOnboarding — tenant workflow
12. Email — SES
13. Frontend — CloudFront + S3
14. Discovery — Cloud Map

**Endpoint collection** auto-runs after all 14 stacks are `CREATE_COMPLETE`. If Pipeline is still running, endpoints may report "not available yet" (risk #2) — re-run `chimera endpoints`.

### Phase 3 — post-deploy verification (~5 min)

```bash
chimera status
chimera doctor
chimera endpoints
chimera chat
```

If `chimera setup` silently no-ops because Security stack wasn't yet live (risk #3), re-run it after Security is `CREATE_COMPLETE`.

## Rollback paths

- Stack failure → classify using `docs/runbooks/cdk-deploy-failure-recovery.md`
- Unrecoverable → `chimera destroy --force` (CodeBuild-delegated, per ADR-032)

## Cost expectations (first month, idle)

| Config | Monthly cost |
|--------|--------------|
| Single-AZ (1 NAT) | ~$120–150 |
| 3-AZ HA (default) | ~$320–345 |

Risk #6: default is 3-AZ HA NAT. Edit `infra/lib/network-stack.ts` before `chimera deploy` if dev wants single-AZ.

## Known deploy risks (7, from Wave-10 code review)

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | CDK bootstrap auto-detect is stack-name-only | HIGH | Pre-run `npx cdk bootstrap` on new accounts |
| 2 | Endpoint collection racy during pipeline | MEDIUM | Re-run `chimera endpoints` after pipeline |
| 3 | `setup` silent-fails if Security not live | MEDIUM | Re-run `chimera setup` after Security stack done |
| 4 | CodeCommit branch must match pipeline context | MEDIUM | Default `main`; don't override |
| 5 | `which cdk` returning Bun binary breaks synth | HIGH | Use `npx cdk` only |
| 6 | Default 3-AZ NAT = $320/mo surprise | MEDIUM | Edit `network-stack.ts` for dev |
| 7 | ECS Fargate first image pull 3–5 min | LOW | Expected; monitor CloudFormation events |

## What's deliberately NOT in v0.6.0

- Real AgentCore Registry CDK (placeholder stack only; context-gated)
- Gateway migration enabled (scaffolding flag-gated default off)
- Evaluations gate enabled (same)
- Cross-region DR
- Bare-except sweep: 17 of 25 tool files still pending
- Per-tenant observability metric emitters (in Wave-10 queue)

## Timeline check

- T+0: `chimera init`
- T+2: deploy starts
- T+3: bootstrap + source push
- T+8: Network + Data + Security start
- T+25: Observability + API + Pipeline + SkillPipeline done
- T+35: Chat + Orchestration + Evolution done
- T+40: Remaining stacks + endpoint collection
- T+42: `chimera status` shows 14 ✅
- T+45: `chimera chat` end-to-end validated

If T+50 passes without `14 ✅`, start failure classification per `cdk-deploy-failure-recovery.md`.

## Cross-links

- `docs/reviews/STATE-OF-THE-WORLD-2026-04-20.md`
- `docs/reviews/WAVE-RETROSPECTIVE-10.md`
- `docs/runbooks/cdk-deploy-failure-recovery.md`
- `docs/runbooks/ddb-pitr-restore.md`
- `docs/reviews/OPEN-PUNCH-LIST.md`

**Owner:** Platform on-call
**Next review:** After first deploy; incorporate real observations.
