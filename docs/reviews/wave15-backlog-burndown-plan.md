---
title: "Wave 15 Backlog Burndown — Plan & Execution Log"
status: execution-log
date: 2026-04-23
wave: 15
mode: iterative-until-zero
---

# Wave 15 Backlog Burndown

## Phase 1: Commit state

- **HEAD:** `b1837cf` `docs: CHANGELOG for v0.6.2`
- **Last tag:** `v0.6.2` (released 2026-04-23 — first deploy achieved, 14/14 stacks live)
- **Branch:** `main` (clean except `packages/shared/tsconfig.tsbuildinfo` — buildinfo, ignored)
- **Deploy state:** `Chimera-dev-*` all 14 stacks UPDATE/CREATE_COMPLETE in `baladita+Bedrock-Admin` (us-west-2)
- **Green workflows:** CI, Security Scan, Release
- **Cumulative post-v0.6.0:** 18 commits carrying 4 P0 fixes, 2 CRITICAL audit fixes, AgentCore research, system audit

## Phase 2: Backlog inventory

Sources:
- `docs/reviews/OPEN-PUNCH-LIST.md` (188 lines, 54 items)
- `docs/reviews/wave14-system-audit.md` (2 CRITICAL + 5 HIGH + 4 MEDIUM + 5 LOW)
- `docs/research/agentcore-harness-2026-04-22/RECOMMENDATION.md` open questions

### Stale items to dedup (already done in Wave 11-14)

| Marked-open in punch list | Reality |
|---------------------------|---------|
| C1 Skills GSI name mismatch | ✅ Fixed in `67723ed` |
| C2 TenantTier enterprise tier | ✅ Fixed in `e00837c` |
| Bare-except sweep | ✅ Complete (`cad682f` closed evolution_tools) |
| `tier_violation_count` metric | ✅ Emitted in `c29745c` |
| `tool:invocation_duration_ms` metric | ✅ Emitted in `35f8073` |
| `loop_iterations` metric | ✅ Emitted (caveat documented — stale ceiling) |
| Code Interpreter service-name fix | ✅ Wave 7 (verified) |
| Registry bootstrap fail-fast | ✅ Wave 7 (verified) |
| `agentcore-runtime.ts` delete | ✅ Wave 7 (verified) |
| Memory namespace canonical form | ✅ Wave 7 (verified) |
| ChatMessage content Zod cap | ✅ Wave 7 |

### Wave 15 scope (ordered by blast radius)

#### GROUP A — Security / compliance (P0, block GA)
A1. H1 — `chimera-cost-tracking` missing `ttlAttribute` (1 line)
A2. H4 — `cloudwatch:PutAnomalyDetector` on `*` → narrow ARN (5 min)
A3. secondary: `cedar-authorization.ts` condition evaluator only handles `==`/`!=` — add a guard/warn so it can't silently miss complex conditions

#### GROUP B — Documentation integrity (P0, 10 min)
B1. H2 — canonical-data-model.md live `<<<<<<<` merge conflict
B2. H3 — ADR-034 frontmatter/body status inconsistency
B3. `docs/reviews/OPEN-PUNCH-LIST.md` — sync to reality (mark stale items done)

#### GROUP C — Code hygiene (stability + simplification, P1)
C1. M1/M2 — guard skeleton orchestration code (`groupchat.ts`, `workflow.ts`, `cron-scheduler.ts`, `background-task.ts`) with `throw new Error('not implemented')`
C2. Evaluate deletion of `groupchat.ts` (435 LOC, never used vs throw-guard)
C3. `strands-agents.ts` + `.d.ts` shim — verify package published, delete shim
C4. LOW/backlog cleanup: `_tid` comment, `__future__` import, `@pytest.mark.integration` annotations
C5. Archive 6+ wave-specific audit docs into `docs/reviews/archive/`

#### GROUP D — Operational runbooks (P0 for GA, but already have real content in Wave 10 — verify)
D1. `docs/runbooks/ddb-pitr-restore.md` — already 432 LOC (Wave 10)
D2. `docs/runbooks/security-incident-tenant-breach.md` — already 507 LOC (Wave 10)
D3. `docs/runbooks/cdk-deploy-failure-recovery.md` — already 460 LOC (Wave 10)
D4. `docs/runbooks/skill-compromise-response.md` — verify exists
D5. `docs/runbooks/dlq-drain-procedure.md` — verify exists
D6. `docs/runbooks/canary-rollback.md` — verify exists

**Action:** verify existence + quality rather than re-draft from scratch.

#### GROUP E — Infrastructure cost optimization (P1, measurable $/mo)
E1. NAT Gateway consolidation + VPC endpoints (~$40-50/mo)
E2. CloudWatch log retention harmonization (~$80-120/mo)
E3. S3 Intelligent-Tiering on 3 buckets (~$40-80/mo)
E4. DDB provisioned vs on-demand rightsizing (~$100-200/mo)
E5. DAX SG narrowing (blocked by NetworkStack refactor — deferred)

#### GROUP F — Developer experience / observability (P1)
F1. M3 — Add `chimera health` post-deploy command
F2. `tool:success_rate_percent` emitter (gateway_proxy.py) — completes 4 of 5 metrics
F3. `tenant:hourly_cost_usd` emitter (budget-monitor.ts) — completes 5 of 5
F4. Publish code-coverage artifacts in CI
F5. Setup Dependabot / Renovate

#### GROUP G — Research-intensive items (deferred, need deep research first)
G1. AgentCore Registry multi-tenancy spike (1 week — blocks Phase 2 migration)
G2. Gateway migration cutover (−600 LOC from gateway_proxy.py)
G3. Evaluations gate for P1 evolution (replaces keyword overlap with LLM-as-judge)
G4. AgentCore Observability onboarding (OTEL + GenAI dashboard)
G5. Replace task-decomposer heuristic with LLM
G6. Implement skill-registry persistence (currently in-memory)

#### GROUP H — Testing + CI gaps (P2)
H1. `sendWithRetry` integration tests
H2. Global `strict: true` + `any` quarantine (793 sites, 2d separate PR)
H3. Zod at shared-type boundary (packages/shared)
H4. E2E for agent-loop timeout + circuit breaker
H5. Fix chat-gateway test exclusion (Bun CJS/ESM for `@aws-sdk/lib-dynamodb`)

## Phase 3-5: Execution waves

### Wave 15a — Parallel quick-wins (this wave)
- A1, A2 (infra fixes, < 30min)
- B1, B2, B3 (doc hygiene, 30min)
- C1, C3 (guard skeletons, delete shim, 30min)
- D-verify (read all 6 runbooks, catalog state, 15min)

### Wave 15b — Verified runbooks + observability
- F2, F3 (remaining 2 observability emitters)
- C2 (delete groupchat.ts if guard doesn't cover it)

### Wave 15c — Research + spike decisions
- G1 (Registry multi-tenancy deep-dive using Tavily/Exa/DeepWiki)
- G2/G3 research to inform Q3 plan

### Wave 15d — Cost optimization + F1
- E1-E4 (CDK changes + cost validation)
- F1 (chimera health)

### Wave 15e — Testing hardening
- H1, H4, H5

## Phase 6: Concurrent review

Separate reviewer agent dispatched in parallel with Wave 15a/b to:
- Validate each landed fix against the audit finding
- Surface NEW gaps not in the punch list
- Feed findings into Wave 15c/d inputs

## Phase 7/8: Iterative loop + final verification

After each wave: reconcile, re-prioritize, re-dispatch. Loop until reviewer confirms zero open items.

---

## Execution log (filled live)

### 15a dispatch: 2026-04-23
…(updated by main thread as commits land)
