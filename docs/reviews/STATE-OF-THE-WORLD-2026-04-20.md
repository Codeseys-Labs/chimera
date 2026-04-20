---
title: "Chimera State of the World — 2026-04-20"
status: executive-summary
last_updated: 2026-04-20
---

# Chimera — Where We Stand (2026-04-20)

## One-paragraph answer

Chimera is **~90% complete and ship-ready for first deployment.** All 14 CDK stacks synthesize cleanly, multi-tenant isolation is enforced across all three layers (CDK + TypeScript Cedar + Python ContextVar), and 2,200+ tests pass. The blocker is not code quality — it is execution: the first `cdk deploy` hasn't run end-to-end yet. ADR-034 (AgentCore Registry multi-tenancy spike) is scoped and designed but only gates Phase-2+ adoption — it does **not** block baseline production use. The single highest-value next move is executing that first deploy to staging, validating the chat end-to-end flow, then shifting focus to the three CRITICAL DR runbooks (PITR restore, tenant-breach playbook, CDK deploy-failure recovery) — those are the only items that block GA per `OPEN-PUNCH-LIST.md`.

## What landed in the last 72 hours (Waves 1-9)

- **Security (ADR-033):** tenant-context `ContextVar` + `require_tenant_id()` + `ensure_tenant_filter()` across 25 Python tool files + anti-pattern guard test + entrypoint try/finally cleanup
- **Hardening bundle:** SSE heartbeat + AbortSignal + drain-timeout; Zod validation at chat-gateway POST routes; ConverseStream race fix + Bedrock retry wrapper; model-tier ceiling; CLI JWT expiry + 5MB skip + monorepo-aware root; audit TTL per-tier enforcement
- **Infra:** WAF → CloudWatch Logs; PITR via AWS Config managed rule; Registry alarms (inert until flags flip); context-gated `RegistryStack`; Registry IAM region-scoped; ALB access logs gated by isProd
- **Migration scaffolding (Phase 0/1, flag-gated default-off):** Registry adapter (`packages/core/src/registry/`), Gateway adapter (`packages/core/src/gateway/`), Evaluations adapter (`packages/core/src/evaluations/`)
- **Fixes:** Code Interpreter service name (was silent-failing), Memory namespace canonical form, 370 LOC of `agentcore-runtime.ts` dead code deleted
- **Research:** 7 operator-grade AgentCore deep-dives (~3,900 lines) under `docs/research/agentcore-rabbithole/`
- **Docs refresh:** README stack count 15→14, 30→34 ADRs; CLAUDE.md 3-layer isolation paragraph; system-architecture/cli-lifecycle/deployment-architecture/agent-architecture/canonical-data-model all updated to reality
- **Commits:** 4 clean commits on `main` (cc252f5 retconned to d4bfb44; no `Co-Authored-By` trailers)

## What's ship-ready right now

- **Multi-tenant isolation** enforced at CDK + TypeScript Cedar + Python ContextVar layers
- **40 AWS tools** (19 TS + 21 Python) with tenant-gate protection
- **Skill ecosystem** (registry + discovery + installer + validator + trust engine + MCP gateway client)
- **Orchestration + evolution frameworks** (swarm, self-evolution, A/B testing, model routing)
- **All migration scaffolding** (Registry / Gateway / Evaluations) is flag-gated default-off — safe to merge, safe to deploy, zero production behavior change
- **14 CDK stacks synthesize** (+1 with `-c deployRegistry=true`)
- **CI Python split** — unit tests must pass; integration tests conditional

## What's blocked

**On ADR-034 Registry multi-tenancy spike** (~1 week):
- Phase 2+ of Registry migration (dual-read enablement, bulk import, cutover, DDB deletion)
- Any real Registry resource CDK (the placeholder stack is empty intentionally)

**On NetworkStack refactor** (~0.5-1 day):
- Full DAX SG narrowing to chat-gateway-task-only (fallback to broad ECS SG remains; requires moving SG ownership to NetworkStack to avoid circular dep)

**On dedicated re-run** (~1 day):
- Bare-except sweep across Python tool files (Wave 8 attempted against a stale base; in-flight in Wave 9)

**Not blocked but not yet done:**
- First real `cdk deploy` to any environment (biggest missing data point)
- 3 CRITICAL DR runbooks (in-flight in Wave 9)
- 3 CRITICAL observability metric emitters (in-flight in Wave 9)

## Top 3 open risks

1. **First-deploy unknowns.** All 14 stacks synth clean; no one has deployed them to a real AWS account end-to-end. The first cdk deploy will surface unknowns the reviews can't anticipate (IAM permission drift, service-quota limits, regional availability mismatches). Mitigation: deploy to a staging account before prod.
2. **Per-tenant observability metrics not emitted.** Dashboards reference `Chimera/Tenant:*` and `Chimera/Skills:*` dimensions that no code path actually emits. Wave 9 is closing the top 3 (tier_violation_count, loop_iterations, tool_invocation_duration_ms); the other 5 remain open.
3. **Registry SDK assumptions unverified.** Phase 0/1 scaffolding assumes `@aws-sdk/client-bedrock-agentcore-control` command names + response shapes that haven't been validated against a live Registry. Fine while flags are off; the spike must confirm before enabling Phase 2.

## Next 72 hours — recommended action

**Deploy to staging, then close the DR runbooks.**

Not: write more scaffolding. Not: start the Registry spike (that's 1+ week and needs its own decision point). Not: polish docs further.

Concrete steps:
1. `chimera deploy --profile <staging>` on a dev tenant — validate all 14 stacks actually deploy
2. Run chimera-0092 E2E validation (chat with system prompt + tool use)
3. In parallel, land the 3 Wave-9 runbooks (PITR restore, tenant-breach, CDK deploy-failure) — they're skeleton-complete in `dr-runbook-gaps.md`
4. After successful staging deploy + runbooks, schedule the ADR-034 Registry spike as a dedicated 1-week workstream

If this sequence succeeds: GA-readable within ~2 weeks. If staging deploy exposes issues: that's exactly the information the 8 waves of review can't give us.

## Cross-links (read these 5 first)

1. `docs/ROADMAP.md` — official status (90% complete; Phase-0 through Phase-6 complete)
2. `docs/reviews/OPEN-PUNCH-LIST.md` — 54 open items, prioritized
3. `docs/reviews/FINAL-REPORT.md` — what landed through Wave 7
4. `docs/architecture/decisions/ADR-033-tenant-context-injection-for-python-tools.md` — security foundation
5. `docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md` — strategic migration path

## Commit history reference

```
00958c5 feat(core): MODEL_TIER_ALLOWLIST + enforceTierCeiling in model-router
7c233f6 feat(infra+docs): CDK hardening, observability, Registry stack + doc refresh
aac5989 feat: P0 hardening + AgentCore migration scaffolding (Phase 0/1)
d4bfb44 feat(security): enforce tenant context across Python agent tool layer
851dcff docs: comprehensive README update + CHANGELOG for v0.3.0-v0.5.1
```

## TL;DR

**Ship-ready-pending-deploy-verification.** Run it against real AWS, close the 3 runbooks, and Chimera goes from "90% done on paper" to "production-validated." That's the work for this week.
