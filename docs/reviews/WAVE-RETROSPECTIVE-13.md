---
title: "Wave 13 Retrospective — first chimera deploy + 2 bugs found"
status: retrospective
date: 2026-04-22
wave: 13
previous: WAVE-RETROSPECTIVE-12.md
---

# Wave 13 Retrospective

**Dates:** 2026-04-21 → 2026-04-22
**Outcome:** v0.6.1 released. First real `chimera deploy` to `baladita+Bedrock-Admin`. 11 of 14 stacks up. 2 pre-existing bugs uncovered + fixed. Observability stack blocked on account-level AWS Config dependency — fix landed, ready for retry.

## What shipped

| SHA | Title | Notable |
|-----|-------|---------|
| `cad682f` | `refactor(agents): narrow evolution_tools excepts to (ClientError, BotoCoreError)` | Closes bare-except sweep |
| `dfca38c` | `docs: Wave-13 deploy-risk sweep — risk #6 outdated` | Reviewer D found the runbook's $320/mo warning stale |
| `53f58f7` | `docs: CHANGELOG for v0.6.1` | Versioning hygiene |
| `475b932` | `fix(cli/deploy): auto-detect wrapped vs flat tarballs on extract` | **P0 bug** — blocked `--source github` |
| `1d7f77a` | `fix(observability): gate AWS Config PITR rule behind enableConfigRules context flag` | **P0 bug** — blocked 2 downstream stacks |

v0.6.1 released: https://github.com/Codeseys-Labs/chimera/releases/tag/v0.6.1 (5 assets)

## The deploy

```
cd ~/Documents/DevBox/chimera && \
  AWS_PROFILE=baladita+Bedrock-Admin chimera deploy \
    --source local --region us-west-2 --env dev \
    --skip-setup-prompt --monitor
```

Stack inventory at deploy end:
| Stack | Status |
|-------|--------|
| Chimera-dev-Network | ✅ CREATE_COMPLETE |
| Chimera-dev-Data | ✅ CREATE_COMPLETE |
| Chimera-dev-Security | ✅ CREATE_COMPLETE |
| Chimera-dev-Observability | ❌ ROLLBACK_COMPLETE |
| Chimera-dev-Api | ✅ CREATE_COMPLETE |
| Chimera-dev-Pipeline | ✅ UPDATE_COMPLETE |
| Chimera-dev-SkillPipeline | ✅ CREATE_COMPLETE |
| Chimera-dev-Chat | ✅ CREATE_COMPLETE |
| Chimera-dev-Orchestration | ✅ CREATE_COMPLETE |
| Chimera-dev-Evolution | ✅ CREATE_COMPLETE |
| Chimera-dev-Email | ✅ CREATE_COMPLETE |
| Chimera-dev-Frontend | ✅ CREATE_COMPLETE |
| Chimera-dev-Discovery | ⏸️ not reached |
| Chimera-dev-TenantOnboarding | ⏸️ not reached |

**11 of 14 succeeded on a fresh-account first attempt.** No stack got stuck in a state that required manual `aws cloudformation delete-stack --retain-resources`; Observability cleanly rolled back.

## Bugs found (both P0, both fixed)

### BUG-1: `--source github` extract was stripping top-level dirs
`packages/cli/src/utils/source.ts:extractTarball` used `--strip-components=1` unconditionally. Correct for GitHub auto-source archives (wrapped in `<owner>-<repo>-<sha>/`), WRONG for our custom `chimera-agent-*.tar.gz` which is built from repo root with `packages/`, `infra/`, `scripts/` as top-level entries. Stripping 1 level erased those dirs.

Symptom: deploy failed at "Installing dependencies" with `infra: No such file or directory`.

Fix (`475b932`): peek at first tar entry, apply `--strip-components=1` only when the archive is wrapped.

**Lesson:** Every `--source` mode should have an end-to-end smoke test. `chimera doctor` doesn't catch deploy-time extraction bugs because it runs BEFORE any source fetch.

### BUG-2: Observability stack silently required AWS Config to be enabled
`infra/lib/observability-stack.ts:629` unconditionally created an `aws_config.ManagedRule` for DynamoDB PITR compliance. The code comment at line 611 said "Requires AWS Config recorder + delivery channel to be active in the account" — but the CDK enforced no guard. A fresh account has no Config recorder, so the stack rolled back with `NoAvailableConfigurationRecorder`.

Fix (`1d7f77a`): gated the rule + alarm + EventBridge fan-out behind a `enableConfigRules` context flag (default off). PITR itself is still enforced at the DDB table level; the Config rule is defense-in-depth against humans disabling it post-deploy.

**Lesson:** Prose comments are not guards. When code says "requires X is set up", assert it or gate it. This bug had the explicit documentation to predict it, and it still shipped.

## Wave 13 process wins

- **Parallel implementer + reviewer teams compressed the wave.** Agents A (release cut), B (evolution narrowing), C (CDK review), D (deploy-risk sweep) ran simultaneously. Agent D noticed the Wave-12 retro's $320/mo runbook entry was stale against current `isProd ? 2 : 1` code, and fixed the runbook before the first deploy cost confusion.
- **Committing agents' work from the main thread when subagents' `git commit` got sandbox-blocked.** This is a stable pattern now: subagents stage changes, main thread commits atomically.
- **First deploy reached Observability in 40 minutes, not 3+ hours of debugging.** CloudFormation surfacing `NoAvailableConfigurationRecorder` in the first failure message was clean; CDK's error reporting did the heavy lifting.

## Process friction

- **CodeCommit API throttling on `chimera sync`.** The `Rate exceeded` error hit us once on the retry-push path. This was transient but not documented in any runbook.
- **`chimera --version` reports `0.0.0` on release binaries.** Cosmetic, but not ideal for support triage ("which version are you on?" → "zero-dot-zero-dot-zero").
- **Agent A (release cut) lost 8 minutes to re-discovering commit-sandbox denial,** then STOPPED cleanly per guardrail. Main thread had to finalize the release.

## Metrics

| Metric | Wave 12 end | Wave 13 end |
|--------|-------------|-------------|
| Tagged releases | v0.6.0 | v0.6.1 |
| Commits past tagged release | 6 | 1 (for v0.6.2) |
| Stacks deployed to AWS | 0 | 11 of 14 |
| P0 bugs fixed | — | 2 |
| Parallel agents per wave | 3 | 4 |
| Independent reviewer agents | 1 | 2 |
| Bare-except files remaining | 1 (evolution_tools) | 0 |
| AWS account state | clean | 11 stacks + CodePipeline running |

## Queued for Wave 14

**Primary goal: 14 of 14 stacks green + first `chimera login` / `chimera chat`.**

1. **Retry deploy** after the Observability fix (commit `1d7f77a`). Sync fix to CodeCommit, re-trigger pipeline, watch for 14 green.
2. **AgentCore Harness deep-dive research.** Can the managed AgentCore primitives replace or simplify Chimera's custom stack? Dedicated research agent running.
3. **Full system audit.** Independent reviewer agent running — code/architecture/logic/data/security/ops dimensions.
4. **Cut v0.6.2** carrying the Observability + tarball fixes so future operators don't hit these.
5. **Post-deploy validation.** `chimera endpoints`, `chimera setup`, `chimera login`, `chimera chat` — end-to-end smoke.

## References

- `docs/reviews/wave13-deploy-risk-sweep.md` (Reviewer D)
- `docs/runbooks/first-deploy-baladita.md` (updated risk #6)
- `docs/reviews/WAVE-RETROSPECTIVE-12.md` (prior wave)
