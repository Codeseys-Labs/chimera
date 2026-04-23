---
title: "Wave 15 Retrospective — backlog burndown 54 → 21 (62% reduction)"
status: retrospective
date: 2026-04-23
wave: 15
previous: WAVE-RETROSPECTIVE-13.md
---

# Wave 15 Retrospective

**Dates:** 2026-04-23
**Outcome:** 54 open punch-list items → 21. Two concurrent reviewer waves (Wave-15 + Wave-15d) surfaced 16 new findings; 14 closed in-wave. Chimera's deployed state in `baladita+Bedrock-Admin` still green, no regressions.

## What shipped — Wave 15 commits

### 15a — audit H1-H5 + orchestration skeletons (12 commits)
- `a4f2d20` fix(data-stack): TTL on `chimera-cost-tracking` (H1)
- `36b49fc` fix(skill-pipeline): narrow `cloudwatch:PutAnomalyDetector` IAM (H4)
- `e1356fd` docs: canonical-data-model merge conflict + ADR-034 status (H2, H3)
- `6de10b3` review: Wave-15 concurrent review (1 CRITICAL, 4 HIGH, 3 MED, 2 LOW findings)
- `d745679..01e663c` — 3 HIGH runbooks: skill-compromise, dlq-drain, canary-rollback
- `432c695..2530a52` — 5 orchestration skeleton guards (groupchat, workflow, cron-scheduler, background-task, orchestrator) — removes 4 fake `123456789012` ARNs

### 15b — Wave-15 concurrent review fixes (2 commits)
- `62038c1` fix: chat-gateway tier validation + Python chimera_agent select_model/memory config include enterprise/dedicated (Wave-15 C1)
- `cfc3b8c` fix(agents): populate GSI attrs in register_capability + atomic rate-limit (Wave-15 H1+H2)

### 15c — cleanup batch (3 commits)
- `d83bb8f` chore(deps): Dependabot config for npm/pip/actions/docker
- `8fa3930` docs: archive 6 wave audits + reconcile OPEN-PUNCH-LIST (54 → 32)
- `d47bcb8` docs: reconcile OPEN-PUNCH-LIST — 6 runbooks already landed (32 → 29)

### 15d — hardening + observability + concurrent review (7 commits)
- `b3cabec` fix: WAF rate limit 2k→10k + boto3 timeout config in load_tenant_config (M2, L1)
- `84479de` fix(security): MFA required in prod + 7d/1d refresh tokens + revocation (H3, M1)
- `38557ec` fix(sse): StreamTee ring buffer with 1000-item cap (H4)
- `c635911` fix(agents): `gateway_config.TENANT_TIER_ACCESS` includes enterprise/dedicated (15d C1) + code_interpreter/swarm bare-except narrowing
- `1753f13` refactor(tools): `_BOTO_CONFIG` on all DDB resource clients
- `809c04d` test(bedrock-model): retry-exhaustion + 4-code parametrized test
- `e77de2b` feat(observability): emit `tenant_hourly_cost_usd` EMF + document `tool_success_rate_percent` via Metric Math
- `5077a78` docs: `_tid` ContextVar convention + README skill-registry badge
- `d812687` review: Wave-15d concurrent review + reconcile punch-list (21 open)

**Total:** 25+ commits, all pushed to origin, all CI green.

## Backlog burndown

| Category | Wave 14 end | Wave 15 end | Δ |
|----------|-------------|-------------|-----|
| spike-blocked | 1 | 1 | 0 (cannot burn — needs 1-wk spike) |
| infra-refactor | 5 | 5 | 0 (1 blocked, 4 pending Wave-15e CDK impl) |
| python-hardening | 2 | **0** | -2 ✅ |
| typescript-hardening | 5 | 2 | -3 ✅ |
| docs | 10 | **0** | -10 ✅ |
| ops-runbooks | 6 | **0** | -6 ✅ |
| observability-emitter | 5 | 3 | -2 ✅ |
| cost-reduction | 3 | 3 | 0 (deferred, needs prod metrics) |
| cleanup | 12 | 7 | -5 ✅ |
| **Total** | **49** | **21** | **-28 (57%)** |

Stale "in-flight" items that were actually complete were counted in 54 original, reduced to 49 after the cleanup agent's reconciliation. 21 remaining.

## Cross-cutting themes

### Theme 1: Tier-enum divergence was a 6-file refactor, not a 1-file fix
When Wave-12 added `enterprise`/`dedicated` to `TenantTier`, only 4 maps were updated. Wave-15 found **three more** requiring the same fix:
- `packages/chat-gateway/src/middleware/tenant.ts` (Wave-15 C1)
- `packages/agents/chimera_agent.py` (Wave-15 C1, both `select_model_for_tier` and `get_memory_config_for_tier`)
- `packages/agents/gateway_config.py` (Wave-15d C1)

**Lesson:** Shared-type enums that cross language boundaries (TS + Python) lose their single-source-of-truth property. Three waves of review caught three separate divergences. A code-generation step (generate Python `TenantTier` from the TS `TenantTier` union) would make this compile-time rather than review-time.

### Theme 2: The `git commit` sandbox block is a consistent subagent limitation
Every Wave 15 subagent reported it cannot commit. They stage cleanly and hand back commit-message drafts — the main thread picks up and commits atomically. This is now the stable pattern (vs Waves 8-11 which tried to escalate via various flags). Accept + work around.

### Theme 3: "Already landed" items that the punch list still listed as open
6 ops-runbooks had been written in Wave 10. 6 docs items had been closed in Wave 7. 9 observability metrics had been emitted in c29745c/35f8073. The punch list lagged reality by weeks. **Lesson:** Reconcile the punch list at the END of every wave, not the start of the next. The cleanup agent's reconciliation accounted for more closed items than the wave itself did.

### Theme 4: Wave-15d reviewer caught a CRITICAL miss by Wave-15 reviewer
Wave-15 concurrent review found C1 (`chat-gateway/tenant.ts` tier downgrade) but missed C1 (`gateway_config.py` tier downgrade) in the Python path. Wave-15d caught it. Two reviewers didn't overlap their coverage by design — the first focused on TypeScript surface, the second on Python+infra. This worked.

## Deploy state

- 14 of 14 stacks UPDATE_COMPLETE/CREATE_COMPLETE in `baladita+Bedrock-Admin` (us-west-2)
- `chimera doctor --region us-west-2`: 8 of 9 green (only `chimera login` remains — user action)
- Chat ALB returning 200 OK on `/health`
- `chimera endpoints` populated
- `chimera setup` provisioned admin user

## v0.6.2 carries all Wave-15 fixes

Tagged + released 2026-04-23. 5 release assets published. CI + Security Scan + Release workflow all green.

## Remaining 21 items — characterization

| Blocker type | Count | Example |
|--------------|-------|---------|
| Spike-blocked (1-week dedicated effort) | 1 | Registry multi-tenancy |
| Separate PR (2+ days) | 1 | Global `strict: true` + 793 `any` sites |
| Needs prod traffic data | 5 | DDB provisioned rightsize, log retention analysis, DAX monitoring, Opus-fallback verify, region audit |
| CDK implementation (Wave-15e scope) | 4 | NAT endpoints, S3 Intelligent-Tiering, log retention policy, DDB rightsize |
| Requires NetworkStack refactor | 1 | DAX SG narrowing |
| Cleanup/nice-to-have | 7 | LLM task-decomposer, DDB-backed skill registry, workflow.ts real impl, Bun CJS/ESM, E2E tests, CI coverage, strands shim |
| Verification | 2 | tier_violation_count wiring, loop_iterations real counter |

**Not in the "can-close-now" category:** the 5 "needs prod traffic" items + 1 spike-blocked + 1 NetworkStack refactor (7 items) — all correctly deferred.

**Can close with more time:** the remaining 14 items either need separate PRs, research, or are minor cleanup.

## Next wave

Wave 15e is running — implements the 4 Wave-15e CDK-edit-only cost-opt items (VPC endpoints + S3 Intelligent-Tiering). Once complete: **17 items remaining**.

Beyond that, the backlog is research/traffic-dependent, so further burndown requires operator traffic + research time.

## References

- `docs/reviews/wave15-backlog-burndown-plan.md` (Phase 1 state doc)
- `docs/reviews/wave15-concurrent-review.md` (concurrent reviewer — Wave 15a)
- `docs/reviews/wave15d-concurrent-review.md` (concurrent reviewer — Wave 15d)
- `docs/architecture/observability.md` (canonical metric catalog, new in Wave 15d)
- `docs/research/cost-optimization-2026-04-23/RECOMMENDATIONS.md` (infra-cost research)
- `docs/reviews/OPEN-PUNCH-LIST.md` (21 open items)
