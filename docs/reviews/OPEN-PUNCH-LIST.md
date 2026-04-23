---
title: "Chimera — Open Punch List"
status: living
last_updated: 2026-04-22
---

<!--
Wave-15d hardening pass (2026-04-22) closed these items:
  python-hardening #1 bare-except sweep re-verification → resolved
    (code_interpreter_tools + swarm_tools narrowed to
    (ClientError, BotoCoreError); gateway_instrumentation retained
    intentionally with documented rationale)
  python-hardening #2 boto3 timeout+retry across tool files → resolved
    (dynamodb_tools, swarm_tools, evolution_tools DDB resources now
    pass _BOTO_CONFIG; all 105 callable boto3 sites verified)
  typescript-hardening #1 sendWithRetry additional tests → resolved
    (retry exhaustion + 4-code parametrized test; 22 → 28 tests)
  typescript-hardening #4 tier-ceiling/retry ordering comment → resolved
  docs #1 README skill-registry badge → resolved (ADR-034 linked)
  cleanup #7 `_tid` variable semantics → resolved (s3_tools module
    docstring + ec2_tools cross-ref)
Remaining: 23 items (1 spike-blocked, 5 infra-refactor, 4 ts-hardening,
  0 docs, 0 ops-runbooks, 5 obs-emitter, 3 cost-reduction, 7 cleanup).
-->

# Chimera — Open Punch List

Consolidates 7 waves of review findings + AgentCore rabbithole research +
Wave-14 system audit + Wave-15 concurrent review into a single prioritized
source of truth. Use this to file seeds issues.

## Quick stats

**21 open items** across the categories below (6 closed in Wave-15d hardening pass):

| Category | Count |
|----------|-------|
| spike-blocked | 1 |
| infra-refactor | 5 |
| python-hardening | 0 |
| typescript-hardening | 2 |
| docs | 0 |
| ops-runbooks | 0 |
| observability-emitter | 3 |
| cost-reduction | 3 |
| cleanup | 7 |

No severity conflicts across review docs; classifications consistent after dedup.

## Spike-blocked (DO NOT START)

### 1. AgentCore Registry multi-tenancy decision
- **Source:** `wave4-registry-migration-delta.md` + rabbithole index
- **Effort:** 1 week spike
- **Blocker:** ADR-034 open question #1 — per-tenant Registry vs shared with tenant-scoped records
- **Spike design:** `docs/designs/agentcore-registry-spike.md`
- **Gates:** Phase 2+ of the Registry migration, the 6-phase rollout, cost modeling, approval-workflow shape

## Top-7 highest-ROI (non-spike-blocked)

1. **Per-tenant model tier-violation metric** — 2d. $360/mo/100-Basic-sessions if missing. *(Note: landed in c29745c — verify wiring.)*
2. ~~**Per-tenant hourly cost metric**~~ — landed Wave-15d (see `docs/architecture/observability.md`).
3. ~~**Tool invocation `success_rate_percent`**~~ — landed Wave-15d via CloudWatch Metric Math; duration_ms from Wave-12 (35f8073).
4. ~~**Bare-except sweep re-verification**~~ — resolved Wave-15d (9 sites narrowed in code_interpreter_tools + swarm_tools; gateway_instrumentation retained intentionally).
5. **Global `strict: true` + `any` quarantine (793 sites)** — 2d. Separate PR.
6. **Log retention harmonization** — 1d. Chat-stack (6mo) vs evolution-stack (1mo) drift.
7. **Cost-opt: VPC interface endpoints + S3 Intelligent-Tiering** — 0.5d each. See `docs/research/cost-optimization-2026-04-23/RECOMMENDATIONS.md`.

## By category

### infra-refactor (5)

| # | Item | Effort | Why it matters |
|---|------|--------|---------------|
| 1 | DAX SG narrowing to chat-gateway task SG (requires NetworkStack refactor) | 0.5-1d | Closes DAX blast radius (wave4 flagged; blocked by circular dep) |
| 2 | NAT Gateway consolidation + more VPC endpoints | 2-3d | $40-50/mo + data-processing savings |
| 3 | CloudWatch log retention harmonization + S3 archive | 1d | $80-120/mo; fixes chat-stack (6mo) vs evolution-stack (1mo) drift |
| 4 | S3 Intelligent-Tiering on 3 buckets | 0.5d | $40-80/mo |
| 5 | DDB provisioned vs on-demand rightsizing (rate-limits first) | 1-2d | $100-200/mo |

### python-hardening (0)

All items resolved in Wave-15d hardening pass (2026-04-22):
- Bare-except sweep: 9 sites in `code_interpreter_tools.py` and
  `swarm_tools.py` narrowed to `(ClientError, BotoCoreError)`. Two
  retained `except Exception` in `gateway_instrumentation.py` are
  intentional and documented (observability must never break tools).
  A third appears in the AgentCore sandbox fetch-script string literal,
  which executes inside the sandbox (not our process) — excluded.
- Boto3 timeout+retry: 6 DDB resources in `evolution_tools.py`,
  `dynamodb_tools.py`, and `swarm_tools.py` now pass `_BOTO_CONFIG`.
  All callable `boto3.client`/`boto3.resource` sites verified.

### typescript-hardening (2)

| # | Item | Effort |
|---|------|--------|
| 1 | ~~`sendWithRetry` additional integration tests~~ — resolved Wave-15d (retry-exhaustion + 4-code parametrized test; `RETRYABLE_ERROR_NAMES` widened to include `TooManyRequestsException` + `ProvisionedThroughputExceededException`) | ✅ |
| 2 | Global `strict: true` + `any` quarantine (793 sites) | 2d (separate PR) |
| 3 | Zod at shared-type boundary (packages/shared) | 1d |
| 4 | ~~Tier-ceiling vs retry ordering comment in `bedrock-model.ts`~~ — resolved Wave-15d | ✅ |

### docs (0)

| # | Item | P | Effort |
|---|------|---|--------|
| 1 | ~~README.md skill-registry badge~~ — resolved Wave-15d (shields.io badge linked to ADR-034) | P2 | ✅ |

All P0/P1 doc items (CLAUDE.md 3-layer tenant isolation, system-architecture
§6 Python ContextVar, stack count 15→14, ADR count 30→34, ROADMAP Phase-3
spike annotation, VISION status sync, canonical-data-model footnote,
CHANGELOG scaffolding) were landed in the Wave-7 doc-drift sweep +
e1356fd (canonical data model merge conflict + ADR-034 status).

### ops-runbooks (0)

All CRITICAL + HIGH runbooks landed:
- `ddb-pitr-restore.md` (432 LOC) — Wave 10
- `security-incident-tenant-breach.md` (507 LOC) — Wave 10
- `cdk-deploy-failure-recovery.md` (460 LOC) — Wave 10
- `skill-compromise-response.md` (607 LOC) — Wave 15a (commit d745679)
- `dlq-drain-procedure.md` (450 LOC) — Wave 15a (commit d1f1ee4)
- `canary-rollback.md` (561 LOC) — Wave 15a (commit 01e663c)

### observability-emitter (3)

Per `cost-observability-audit.md`; 2 of 5 landed in Wave-15d:

| # | Metric | Namespace | Dimensions | Emitter | Status |
|---|--------|-----------|------------|---------|--------|
| 1 | `tier_violation_count` | Chimera/Agent | tenant_id, tier, model_requested | model-router.ts | landed (c29745c — verify wiring) |
| 2 | `loop_iterations` | Chimera/Agent | tenant_id, session_id | chimera_agent.py ⚠️ emits ceiling (20) until Strands exposes iteration_count — do NOT wire alarms yet (see `TODO(rabbithole-02)`) | landed (partial; alarms blocked) |
| 3 | `tool_invocation_duration_ms` | Chimera/Tools | Service, TenantId, Tier, ToolName | `gateway_instrumentation.py` | **landed Wave-12** (35f8073) |
| 4 | `tool:success_rate_percent` | Chimera/Tools | Service, TenantId, Tier, ToolName | **computed via CloudWatch Metric Math** from `Success` (see `docs/architecture/observability.md`) | **landed Wave-15d** |
| 5 | `tenant_hourly_cost_usd` | Chimera/Billing | tenant_id, tier, model_id, service | `cost-tracker.ts::recordCost` | **landed Wave-15d** |

Remaining open (3): verification of #1 wiring, alarm-readiness for #2 (unblocked by Strands iteration_count fix), and any additional recommended-MEDIUM metrics from `cost-observability-audit.md` not in this table.

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
7. ~~Document `_tid` variable semantics in tool gate blocks~~ — resolved Wave-15d (canonical module docstring in `s3_tools.py`; cross-ref in `ec2_tools.py`). The pattern is now self-documenting for the other 19 tool files.
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
