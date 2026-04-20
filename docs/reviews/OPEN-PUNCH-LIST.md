---
title: "Chimera — Open Punch List"
status: living
last_updated: 2026-04-18
---

# Chimera — Open Punch List

Consolidates 7 waves of review findings + the AgentCore rabbithole research into a single prioritized source of truth. Use this to file seeds issues.

## Quick stats

**54 open items** across the categories below:

| Category | Count |
|----------|-------|
| spike-blocked | 1 |
| infra-refactor | 5 |
| python-hardening | 2 |
| typescript-hardening | 5 |
| docs | 10 |
| ops-runbooks | 6 |
| observability-emitter | 5 |
| cost-reduction | 3 |
| cleanup | 12 |

No severity conflicts across review docs; classifications consistent after dedup.

## Spike-blocked (DO NOT START)

### 1. AgentCore Registry multi-tenancy decision
- **Source:** `wave4-registry-migration-delta.md` + rabbithole index
- **Effort:** 1 week spike
- **Blocker:** ADR-034 open question #1 — per-tenant Registry vs shared with tenant-scoped records
- **Spike design:** `docs/designs/agentcore-registry-spike.md`
- **Gates:** Phase 2+ of the Registry migration, the 6-phase rollout, cost modeling, approval-workflow shape

## Top-10 highest-ROI (non-spike-blocked)

1. **Fix Code Interpreter service name** — 1d. CRITICAL. `packages/agents/tools/code_interpreter_tools.py:66` calls wrong boto3 service. *(Note: appears to be addressed in Wave 7 — verify before filing.)*
2. **Registry bootstrap fail-fast check** — 15min. `REGISTRY_ENABLED=true` without `REGISTRY_ID` silently no-ops. *(Note: addressed in Wave 7 — verify.)*
3. **Per-tenant model tier-violation metric** — 2d. $360/mo/100-Basic-sessions if missing.
4. **Per-tenant hourly cost metric** — 2d. Enables tenant-facing billing.
5. **Tool invocation duration + success-rate metrics** — 2d. SLA foundation.
6. **DDB PITR restore runbook** — 1d. Blocks GA; undefined RTO/RPO.
7. **Security-incident tenant-breach playbook** — 1d. Blocks GA.
8. **CDK deploy-failure recovery runbook** — 1d. Blocks prod confidence.
9. **Memory namespace canonical form** — 1d. IAM tenancy enforcement. *(Note: appears addressed in Wave 7 — verify.)*
10. **Delete `agentcore-runtime.ts` stubs** — 1d. 370 LOC dead. *(Note: addressed in Wave 7 — verify.)*

## By category

### infra-refactor (5)

| # | Item | Effort | Why it matters |
|---|------|--------|---------------|
| 1 | DAX SG narrowing to chat-gateway task SG (requires NetworkStack refactor) | 0.5-1d | Closes DAX blast radius (wave4 flagged; blocked by circular dep) |
| 2 | NAT Gateway consolidation + more VPC endpoints | 2-3d | $40-50/mo + data-processing savings |
| 3 | CloudWatch log retention harmonization + S3 archive | 1d | $80-120/mo; fixes chat-stack (6mo) vs evolution-stack (1mo) drift |
| 4 | S3 Intelligent-Tiering on 3 buckets | 0.5d | $40-80/mo |
| 5 | DDB provisioned vs on-demand rightsizing (rate-limits first) | 1-2d | $100-200/mo |

### python-hardening (2)

| # | Item | Effort |
|---|------|--------|
| 1 | Bare `except Exception` sweep — **NEEDS RERUN** | 1d |
| 2 | Boto3 timeout + retry verification across all tool files | 4h |

**Note on #1:** Wave 8 attempted the sweep but the agent worked against a stale
phantom-worktree base (pre-Wave-3 tenant_context + boto3 Config adds). The
narrowed exceptions + 3-way merge are non-trivial; re-dispatch against
current canonical (`packages/agents/tools/*.py`) in a follow-up wave.
Reference artifact: `.overstory/worktrees/builder-cherry-pick-main/packages/agents/tools/`
has the narrowed exceptions but based on a stale code tree. Do NOT blanket-copy.

### typescript-hardening (5)

| # | Item | Effort |
|---|------|--------|
| 1 | `ChatMessage.content.max(32768)` cap in Zod | 15min (security: prevents DoS) |
| 2 | `sendWithRetry` integration tests | 30min |
| 3 | Global `strict: true` + `any` quarantine (793 sites) | 2d (separate PR) |
| 4 | Zod at shared-type boundary (packages/shared) | 1d |
| 5 | Tier-ceiling vs retry ordering comment | 5min |

### docs (10)

All P0 items (CLAUDE.md, system-architecture §6, README) are **in-flight** this session. The rest:

| # | Item | P | Effort |
|---|------|---|--------|
| 1 | CLAUDE.md: 3-layer tenant isolation paragraph | P0 | 1h — in-flight |
| 2 | system-architecture.md §6 add Python ContextVar | P0 | 1-2h — in-flight |
| 3 | README.md stack count 15→14 | P0 | 15min — in-flight |
| 4 | ROADMAP.md ADR count 30→34 | P1 | 15min — in-flight |
| 5 | ROADMAP.md Phase-3 spike annotation | P1 | 15min — in-flight |
| 6 | VISION.md status + metrics sync | P1 | 15min — in-flight |
| 7 | system-architecture.md timestamp | P2 | 5min — in-flight |
| 8 | canonical-data-model.md `chimera-skills` footnote | P2 | 15min — in-flight |
| 9 | README.md skill-registry badge | P2 | 15min |
| 10 | CHANGELOG.md create or remove reference | P2 | 15min — in-flight |

### ops-runbooks (6)

| # | File | Sev | Effort |
|---|------|-----|--------|
| 1 | `docs/runbooks/ddb-pitr-restore.md` | CRITICAL | 1d |
| 2 | `docs/runbooks/security-incident-tenant-breach.md` | CRITICAL | 1d |
| 3 | `docs/runbooks/cdk-deploy-failure-recovery.md` | CRITICAL | 1d |
| 4 | `docs/runbooks/skill-compromise-response.md` | HIGH | 0.5d |
| 5 | `docs/runbooks/dlq-drain-procedure.md` | HIGH | 0.5d |
| 6 | `docs/runbooks/canary-rollback.md` | HIGH | 0.5d |

Skeletons for each in `docs/reviews/dr-runbook-gaps.md`.

### observability-emitter (5)

All metrics below are *defined in dashboards* but *not emitted* by any code path. Per `cost-observability-audit.md`:

| # | Metric | Namespace | Dimensions | Emitter |
|---|--------|-----------|------------|---------|
| 1 | `tier_violation_count` | Chimera/Agent | tenant_id, tier, model_requested | model-router.ts |
| 2 | `loop_iterations` | Chimera/Agent | tenant_id, session_id | chimera_agent.py |
| 3 | `tool:invocation_duration_ms` | Chimera/Agent | tenant_id, tier, tool_name, status | gateway_proxy.py |
| 4 | `tool:success_rate_percent` | Chimera/Agent | tenant_id, tier, tool_name | gateway_proxy.py |
| 5 | `tenant:hourly_cost_usd` | Chimera/Billing | tenant_id, tier, model_id | budget-monitor.ts |

### cost-reduction (3)

1. DAX cache-hit-rate monitoring + rightsize (potential $1,200-1,500/mo).
2. Model-router Opus-fallback live verification.
3. Region-specific resource audit.

### cleanup (12)

1. ~~Delete `agentcore-runtime.ts`~~ — addressed in Wave 7 (verify).
2. Replace task-decomposer heuristic with LLM.
3. Implement skill-registry persistence (currently in-memory).
4. Triage `workflow.ts` stubs (wait-for-agent, JSONPath, map iteration).
5. Fix chat-gateway test exclusion (Bun CJS/ESM).
6. Add E2E for agent-loop timeout + circuit breaker.
7. Publish code-coverage artifacts.
8. Setup Dependabot / Renovate.
9. `from __future__ import annotations` on code_interpreter_tools.py (1min nit).
10. Document `_tid` variable semantics in tool gate blocks.
11. Annotate integration tests with `@pytest.mark.integration`.
12. Archive wave-specific audit docs into `docs/reviews/archive/` (keep 7 strategic, archive 6+).

## Already landed (reference)

Verified in code + git history:

- Tenant-context enforcement in Python (ADR-033)
- Anti-pattern guard test for boto3-without-tenant_context
- Polling circuit breakers (swarm_tools, evolution_tools)
- Zod at chat-gateway route entry
- SSE heartbeat + AbortSignal + 5s drain-timeout
- ConverseStream `messageStop` flush + Bedrock retry wrapper
- CLI JWT expiry check + 5MB skip warn + monorepo-aware root
- WAF → CloudWatch Logs wired
- PITR monitored via AWS Config managed rule
- Tier-ceiling enforcement at Bedrock invoke
- ErrorBoundary + EmptyState in web
- Audit TTL per-tenant tier enforcement
- Docker digest scaffolding + quarterly refresh policy
- CI Python split (unit must pass, integration conditional)
- Code Interpreter service-name fix + kill-switch shim (Wave 7)
- Memory namespace canonical form (Wave 7)
- `agentcore-runtime.ts` deleted (Wave 7)
- Registry observability alarms (3 alarms + panel, INSUFFICIENT_DATA by default)
- Registry IAM region-scoped (inert until flags flip)
- Context-gated `RegistryStack` placeholder
- Registry bootstrap fail-fast in `.mjs` helpers (Wave 7)

## Strategic next-quarter outlook

1. **Registry spike + 6-phase migration** (3-4wk post-spike) — unblocks semantic search + governed approval workflow
2. **AgentCore Observability onboarding** (1-2wk) — OTEL + GenAI dashboard; gains 4 metrics free
3. **Gateway migration cutover** (1wk) — net −600 LOC from `gateway_proxy.py`; aligns with managed runtime
4. **Evaluations gate for P1 evolution** (1-2wk) — replaces keyword overlap with LLM-as-judge
5. **Cost optimization sprint** (1wk) — NAT, log retention, S3 tiering → ~$2,000-2,500/mo savings

## Notes

- Several items marked "verify — possibly addressed in Wave 7" are genuinely possibly already closed. Before filing seeds issues, grep/test-check those first.
- All docs P0 items are in-flight this session from the doc-drift-fix agent.
- Several cleanup items (archive wave docs, `_tid` comment, __future__ import) are sub-hour.
