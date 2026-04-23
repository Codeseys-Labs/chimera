---
title: "Chimera — Open Punch List"
status: living
last_updated: 2026-04-22
---

# Chimera — Open Punch List

Consolidates 7 waves of review findings + AgentCore rabbithole research +
Wave-14 system audit + Wave-15 concurrent review into a single prioritized
source of truth. Use this to file seeds issues.

## Quick stats

**32 open items** across the categories below:

| Category | Count |
|----------|-------|
| spike-blocked | 1 |
| infra-refactor | 5 |
| python-hardening | 2 |
| typescript-hardening | 4 |
| docs | 1 |
| ops-runbooks | 3 |
| observability-emitter | 5 |
| cost-reduction | 3 |
| cleanup | 8 |

No severity conflicts across review docs; classifications consistent after dedup.

## Spike-blocked (DO NOT START)

### 1. AgentCore Registry multi-tenancy decision
- **Source:** `wave4-registry-migration-delta.md` + rabbithole index
- **Effort:** 1 week spike
- **Blocker:** ADR-034 open question #1 — per-tenant Registry vs shared with tenant-scoped records
- **Spike design:** `docs/designs/agentcore-registry-spike.md`
- **Gates:** Phase 2+ of the Registry migration, the 6-phase rollout, cost modeling, approval-workflow shape

## Top-7 highest-ROI (non-spike-blocked)

1. **Per-tenant model tier-violation metric** — 2d. $360/mo/100-Basic-sessions if missing.
2. **Per-tenant hourly cost metric** — 2d. Enables tenant-facing billing.
3. **Tool invocation duration + success-rate metrics** — 2d. SLA foundation.
4. **DDB PITR restore runbook** — 1d. Blocks GA; undefined RTO/RPO.
5. **Security-incident tenant-breach playbook** — 1d. Blocks GA.
6. **CDK deploy-failure recovery runbook** — 1d. Blocks prod confidence.
7. **Global `strict: true` + `any` quarantine (793 sites)** — 2d. Separate PR.

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

**Note on #1:** Wave 8 attempted the sweep but worked against a stale
phantom-worktree base. Re-dispatch against current canonical
(`packages/agents/tools/*.py`) in a follow-up wave.

### typescript-hardening (4)

| # | Item | Effort |
|---|------|--------|
| 1 | `sendWithRetry` additional integration tests (beyond the two in `bedrock-model.test.ts`) | 30min |
| 2 | Global `strict: true` + `any` quarantine (793 sites) | 2d (separate PR) |
| 3 | Zod at shared-type boundary (packages/shared) | 1d |
| 4 | Tier-ceiling vs retry ordering comment in `bedrock-model.ts` | 5min |

### docs (1)

| # | Item | P | Effort |
|---|------|---|--------|
| 1 | README.md skill-registry badge | P2 | 15min |

All P0/P1 doc items (CLAUDE.md 3-layer tenant isolation, system-architecture
§6 Python ContextVar, stack count 15→14, ADR count 30→34, ROADMAP Phase-3
spike annotation, VISION status sync, canonical-data-model footnote,
CHANGELOG scaffolding) were landed in the Wave-7 doc-drift sweep +
e1356fd (canonical data model merge conflict + ADR-034 status).

### ops-runbooks (3)

| # | File | Sev | Effort |
|---|------|-----|--------|
| 1 | `docs/runbooks/ddb-pitr-restore.md` | CRITICAL | 1d |
| 2 | `docs/runbooks/security-incident-tenant-breach.md` | CRITICAL | 1d |
| 3 | `docs/runbooks/cdk-deploy-failure-recovery.md` | CRITICAL | 1d |

Skeletons for each in `docs/reviews/dr-runbook-gaps.md`.

HIGH-severity runbooks (skill-compromise, dlq-drain, canary-rollback) landed
in commits d745679..01e663c — see the "Already landed" section.

### observability-emitter (5)

All metrics below are *defined in dashboards* but *not emitted* by any code path. Per `cost-observability-audit.md`:

| # | Metric | Namespace | Dimensions | Emitter |
|---|--------|-----------|------------|---------|
| 1 | `tier_violation_count` | Chimera/Agent | tenant_id, tier, model_requested | model-router.ts |
| 2 | `loop_iterations` | Chimera/Agent | tenant_id, session_id | chimera_agent.py ⚠️ emits ceiling (20) until Strands exposes iteration_count — do NOT wire alarms yet (see `TODO(rabbithole-02)`) |
| 3 | `tool:invocation_duration_ms` | Chimera/Agent | tenant_id, tier, tool_name, status | gateway_proxy.py |
| 4 | `tool:success_rate_percent` | Chimera/Agent | tenant_id, tier, tool_name | gateway_proxy.py |
| 5 | `tenant:hourly_cost_usd` | Chimera/Billing | tenant_id, tier, model_id | budget-monitor.ts |

### cost-reduction (3)

1. DAX cache-hit-rate monitoring + rightsize (potential $1,200-1,500/mo).
2. Model-router Opus-fallback live verification.
3. Region-specific resource audit.

### cleanup (8)

1. Replace task-decomposer heuristic with LLM.
2. Implement skill-registry persistence (currently in-memory).
3. Triage `workflow.ts` stubs (wait-for-agent, JSONPath, map iteration).
4. Fix chat-gateway test exclusion (Bun CJS/ESM).
5. Add E2E for agent-loop timeout + circuit breaker.
6. Publish code-coverage artifacts.
7. Document `_tid` variable semantics in tool gate blocks (the `_tid = require_tenant_id()` prefix underscore means "referenced by the `ensure_tenant_filter` ContextVar, not read in this function body").
8. Remove the `aws-tools/strands-agents.{ts,d.ts}` shim once the real `strands-agents` npm package is published. Currently imported by **~30 files** across `packages/core/src/aws-tools/` and `packages/core/src/discovery/`; cannot be deleted until those callers migrate to `@strands-agents/sdk` (already declared as a type-only module in `strands-agents-shim.d.ts`). Track alongside the Gateway migration cutover.

## Already landed (reference)

Verified in code + git history:

- Tenant-context enforcement in Python (ADR-033)
- Anti-pattern guard test for boto3-without-tenant_context
- Polling circuit breakers (swarm_tools, evolution_tools)
- Zod at chat-gateway route entry + `ChatMessage.content.max(32768)` DoS cap
- SSE heartbeat + AbortSignal + 5s drain-timeout
- `StreamTee` 1000-item ring buffer (Wave-15 H4, commit 38557ec)
- ConverseStream `messageStop` flush + Bedrock retry wrapper (+ 2 retry tests)
- CLI JWT expiry check + 5MB skip warn + monorepo-aware root
- WAF → CloudWatch Logs wired
- PITR monitored via AWS Config managed rule
- Tier-ceiling enforcement at Bedrock invoke
- ErrorBoundary + EmptyState in web
- Audit TTL per-tenant tier enforcement (basic/advanced/premium) + **enterprise tier** (commit e00837c, Wave-15 C1 extension 62038c1)
- Docker digest scaffolding + quarterly refresh policy
- CI Python split (unit must pass, integration conditional)
- Code Interpreter service-name fix + kill-switch shim (Wave 7)
- Memory namespace canonical form (Wave 7)
- `agentcore-runtime.ts` deleted (Wave 7) — `packages/core/src/runtime/index.ts` retains only the rationale comment
- Registry observability alarms (3 alarms + panel, INSUFFICIENT_DATA by default)
- Registry IAM region-scoped (inert until flags flip)
- Context-gated `RegistryStack` placeholder
- Registry bootstrap fail-fast in `.mjs` helpers (Wave 7)
- **Skill registry GSI alignment + partition keys** (commit 67723ed — audit P0)
- **cost-tracking TTL enabled** (commit a4f2d20, 2-year retention — audit H1)
- **PutAnomalyDetector IAM narrowed** from `*` to account-scoped ARN (commit 36b49fc — audit H4)
- **canonical-data-model merge conflict** resolved (commit e1356fd — audit H2)
- **ADR-034 status** aligned with implementation (commit e1356fd — audit H3)
- **Orchestration skeleton guards** — 5 commits 432c695..2530a52 replace fake ARNs with throw-stubs in groupchat, workflow, cron-scheduler, background-task, and orchestrator.createAgentRuntime (audit M1/M2)
- **Wave-15 HIGH runbooks** — skill-compromise (d745679), dlq-drain (d1f1ee4), canary-rollback (01e663c)
- **Cognito MFA required in prod + 7-day web / 1-day CLI refresh tokens + token revocation** (commit 84479de, Wave-15 H3+M1)
- **Evolution tools GSI attrs + atomic rate-limit** (commit cfc3b8c, Wave-15 H1+H2)
- **Wave-15c cleanup batch** (this wave):
  - `hello_world_tool` production-gated via `__production_excluded__` sentinel + `CHIMERA_ENV=prod` filter in `gateway_config.py` (Wave-15 M3)
  - `load_tenant_config` uses `_BOTO_CONFIG` (5s connect / 30s read / 3 retries) matching tools/*.py posture (Wave-15 L1)
  - `from __future__ import annotations` added to `code_interpreter_tools.py`
  - Dependabot config added (`.github/dependabot.yml`) — npm/pip/GH-Actions/Docker, weekly cadence
  - 6 oldest wave-specific audit docs archived to `docs/reviews/archive/`
  - Integration test annotation sweep — **N/A**: all `packages/agents/tests/*.py` already mock boto3; no test hits live AWS

## Strategic next-quarter outlook

1. **Registry spike + 6-phase migration** (3-4wk post-spike) — unblocks semantic search + governed approval workflow
2. **AgentCore Observability onboarding** (1-2wk) — OTEL + GenAI dashboard; gains 4 metrics free
3. **Gateway migration cutover** (1wk) — net −600 LOC from `gateway_proxy.py`; also retires the `aws-tools/strands-agents.ts` shim
4. **Evaluations gate for P1 evolution** (1-2wk) — replaces keyword overlap with LLM-as-judge
5. **Cost optimization sprint** (1wk) — NAT, log retention, S3 tiering → ~$2,000-2,500/mo savings

## Notes

- All items previously marked "verify — possibly addressed in Wave 7" were
  confirmed resolved in code + git history during the Wave-15c sweep and moved
  to "Already landed".
- `wave4-registry-migration-delta.md` intentionally kept in `docs/reviews/`
  root (not archived) because it is still cited by `docs/MIGRATION-registry.md`
  and the agentcore-rabbithole dossier as the authoritative 6-phase plan.
