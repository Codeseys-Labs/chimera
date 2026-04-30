---
title: "Wave-34: Tenant Hardening + Architectural Gap Closure"
status: proposed
date: 2026-04-30
supersedes: none
author: lead + 4 parallel codex critiques
source-reviews:
  - /tmp/codex-critique-infra.md
  - /tmp/codex-critique-security.md
  - /tmp/codex-critique-cli.md
  - /tmp/codex-critique-agents.md
---

# Wave-34 roadmap

Post-destroy-verification session (2026-04-30) dispatched 4 parallel
codex critiques across infra, security, CLI, and agent architecture.
The reviews converged on a 37-item backlog grouped into 6 CRITICAL,
10 HIGH, 16 MEDIUM, and 5 LOW. This doc is the plan for burning it
down.

## Executive summary

The CRITICAL items all trace to the same theme: **the self-evolution
vision has trust paths that fail-open, and user/tenant resolution has
one unfiltered GSI-style gap that Wave-33 missed**. None of them are
exploitable today because the platform is destroyed, but they must
land before any re-deploy that enables agent-autonomous infra edits.

The HIGH items are a mix of remaining tenant-filter gaps
(`queryByService`), IAM-scope narrowing, CLI correctness, and
AgentCore observability depth.

## Waves

### Wave-34a — CRITICAL tenant + audit (2–3 eng days)

Goal: close the six CRITICAL gaps before any re-deploy. Everything
else can wait.

| Seed | Title | Owner lens |
|---|---|---|
| chimera-8a97 | user-pairing DDB query missing tenantId | security |
| chimera-21c7 | evolution_tools fail-OPEN on Cedar policy-store miss | agents |
| chimera-6af8 | evolution commits to CodeCommit before audit record | agents |
| chimera-1033 | `chimera diff` swallows AccessDenied as empty | cli |
| chimera-c7d8 | `chimera destroy` ignores fallback failures | cli |
| chimera-923e | tenant onboarding wrong S3 bucket ARN format | infra |

Parallelizable across 4 agent workers; dispatch via Team of 4-5
builders per deep-work-loop convention.

### Wave-34b — HIGH tenant isolation completion + CLI correctness (2–3 eng days)

Goal: finish the tenant-filter sweep that Wave-33 started + close
remaining IAM + JWT + CLI correctness gaps.

| Seed | Title |
|---|---|
| chimera-9418 | audit-trail queryByService GSI missing tenant filter |
| chimera-facf | TenantRouter JWT signature not verified |
| chimera-3da5 | schedule-dispatcher stuck-RUNNING not idempotent |
| chimera-b862 | auto-skill-gen bypasses 7-stage pipeline (blocked on M8) |
| chimera-de08 | AgentCore namespace trusts raw claims |
| chimera-8bb6 | TS AgentCore memory client is unimplemented stub |
| chimera-c505 | chat task role account-wide AgentCore grant |
| chimera-cb0d | chimera deploy doesn't check InProgress before push |
| chimera-63a1 | AgentCore Observability drops GenAI attributes |
| chimera-533d | self-evolution-orchestrator cost-auth bypass (blocked on C2) |

### Wave-34c — Cedar coverage matrix + MEDIUM infra polish (3–5 eng days)

- chimera-a813 — Cedar policies for Skill/Session/Memory/Tenant × Read/List/Create/Update/Delete (blocks H4)
- chimera-79eb — IAM deny-after-allow replaced with positive LeadingKeys (blocks M9)
- chimera-3530 — agent-edited CDK needs repo/path allowlist + AST/synth validation + HITL (blocked on C2 + C3)
- chimera-b88b — orchestration-stack table constructs (blocks M3)
- chimera-fa07 — pipeline/orchestration wildcard ARN narrowing
- chimera-8d58 — DAX SG cross-stack cycle → move to NetworkStack
- chimera-ff85 — `/chat/message` body-tenantId mismatch check
- chimera-a806 — `/integrations/resolve-user` tenantId from context
- chimera-664e — skill discovery empty-tenantId guard on alt entries

### Wave-34d — CLI parity + observability depth (2–3 eng days)

- chimera-9b4e — dev ECS/NAT/DAX cost gating
- chimera-3a16 — Lambdas bypassing ChimeraLambda → standardize
- chimera-9814 — dev S3 autoDeleteObjects
- chimera-2651 — task-decomposer heuristic fallback gating
- chimera-e20d — CLI --json parity trigger/diff/completion
- chimera-f2a5 — CLI first-class commands for schedule/integration/evolution/quota-cost/audit/alarm-dashboard (the "one interface" completion)
- chimera-e4ff — CLI action-level testability (injectable SDK runners)
- chimera-1e39 — CLI help text examples + correct deploy wording

### Wave-34e — LOW + existing backlog (after a-d land)

- chimera-e401 — Registry stack tenant-scoped write design
- chimera-e948 — SSE persisted ownership across task restart
- chimera-b3c6 — ChimeraLambda/Queue removal-policy propagation
- chimera-59ee — Webhook delivery Phase 2 (pre-existing)
- chimera-606c — DGM composite fitness Phase 2 (pre-existing)
- chimera-8681 — Chimera Forge Phase 1 (pre-existing)
- chimera-b7af — strands-agents 1.0 GA migration (GA-blocked; monitor)

## Sequencing rules

1. **Wave-34a is gate**: no re-deploy until all 6 CRITICAL land and a
   fresh multi-tenant Playwright probe passes.
2. **H4 blocked on M8** (auto-skill publish needs Cedar Skill policies).
3. **H10 and M1 blocked on C2** (cost re-auth + repo allowlist both
   need the Cedar fail-closed fix to be useful).
4. **M9 blocked on C6** (positive LeadingKeys IAM pattern needs
   bucket-ARN-passing fix first).
5. **M3 blocked on M4** (narrowing wildcards needs explicit table
   constructs first).

## Test plan

Each wave ends with:

1. Unit tests for every bugfix (TDD: red before green).
2. Re-run the Wave-33 live Playwright probes (multi-tenant login, list/
   create schedules, cross-tenant 403, body-tenantId mismatch, foreign-
   session 404) post-deploy.
3. Re-run 4-lens codex critique to verify no regression + catch new
   gaps.

## Out of scope

- UTO (Unified Tenant Organization) — 8–12 eng day initiative, needs
  separate product decision on cross-tenant shared context; explicit
  Wave-35+.
- Full registry build-out (chimera-e401 is just the tenancy design;
  implementation is Wave-35+).
- Strands-agents SDK migration (waiting on upstream 1.0 GA release).

## References

- Session export: `docs/session-exports/2026-04-29-wave32-deploy-recovery.md`
- Multi-tenant isolation audit: `docs/reviews/multi-tenant-isolation-live-probes-2026-04-28.md`
- Memory isolation audit: `docs/reviews/memory-isolation-audit-2026-04-29.md`
- Wave-33 reviewer report: `docs/reviews/wave33-review-report.md`
- Codex critique outputs: `/tmp/codex-critique-{infra,security,cli,agents}.md`
