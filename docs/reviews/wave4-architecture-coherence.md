# Wave-4 Audit — Architecture Coherence

**Date:** 2026-04-17
**Scope:** Three waves of implementation + all 33 ADRs + 13 review docs.

## TL;DR

The architecture is coherent in outline but shows **documentary drift** at the Python tool layer — the very place where multi-tenant isolation had been the gap. Wave 3 fixed the code via ADR-033, but `system-architecture.md` and `canonical-data-model.md` don't yet describe the three-layer isolation model (CDK + TypeScript + Python) as a single story. A new contributor will think CDK handles it all and miss the Python layer's new guardrails. Fixable in an hour.

**Weakest seams:** (1) 3-layer tenant isolation is documented only in ADR-033 and code; (2) 25+ TODO stubs remain in orchestration/runtime/skill-registry; (3) three CRITICAL runbooks are missing (PITR restore, tenant breach, CDK deploy failure); (4) ADR-034 didn't exist until this wave.

## Layer boundaries

### CDK / infrastructure — clean
- Partition key `TENANT#{id}` on all 6 tables
- Every TypeScript GSI query filters on `tenantId`
- Cedar policies at the API Gateway → Lambda layer
- Per-tenant KMS keys, per-tenant IAM boundaries

### TypeScript / agent — tight post-Wave 3
- `bedrock-model.ts` tier-ceiling gate (nothing bypasses it)
- `chat-gateway/routes/chat.ts` Zod validation at route entry
- SSE bridge heartbeat + abort + drain

### Python tool layer — fixed this session
- `tools/tenant_context.py` `ContextVar` + `require_tenant_id()` + `ensure_tenant_filter()`
- 25 tool files refactored; `@tool` sigs no longer accept `tenant_id`
- Entrypoint `try/finally: clear_tenant_context()`
- Anti-pattern guard test (`test_no_tool_imports_boto3_without_tenant_context`)

### Documentation layer — lagging
- No doc under `docs/architecture/` tells the 3-layer story yet. Fix: append a short section to `system-architecture.md` and a footnote in `canonical-data-model.md`.

## Canonical data flows

- Chat request → tool call flow in `system-architecture.md §3` matches the code today.
- Self-evolution flow in §5 is accurate but doesn't show the new polling circuit breakers.
- Multi-tenant flow does not mention the Python `ContextVar` step.

## ADR-implementation drift

| ADR | Status | Code alignment | Docs alignment |
|-----|--------|---------------|---------------|
| **033** Tenant context for Python tools | Accepted 2026-04-17 | ✅ 25 tool files + test guard | ✅ in ADR; ❌ not in system-architecture |
| **034** AgentCore Registry adoption | Proposed (this wave) | ⏳ spike pending | — |
| **032** CodeBuild-delegated destroy | Accepted 2026-03-22 | ✅ | ✅ |

## Naming / convention drift

| Layer | Form | Example |
|-------|------|---------|
| JWT claim | camelCase | `custom:tenantId` |
| DDB PK | literal | `TENANT#...` |
| Python ContextVar / var | snake_case | `tenant_id` |
| TypeScript interfaces | camelCase | `tenantId` |
| Cedar | camelCase | `tenantId` |

Consistent within layers; DDB magic strings scattered. Recommend: `packages/shared/src/constants/ddb-keys.ts`.

## README / ROADMAP truthiness

Overall ~95% accurate.
- "40 AWS tools" ✓ (19 TS + 21 Py)
- "Multi-tenant isolation" ✓ after Wave 3 (was true at CDK layer, false at Python until this session)
- "Production-ready v0.5.1" — code yes, ops runbooks partial
- Stack count says 15 but bin/chimera.ts instantiates 14
- ADR count says 30 but code has 34 (through ADR-034)

## Unfinished work catalog

**High-risk TODOs:**
- `packages/core/src/runtime/agentcore-runtime.ts` — 15+ TODOs ("integrate with AgentCore Runtime API"). Needs triage: blocker or aspirational scaffolding?
- `packages/core/src/orchestration/workflow.ts` — wait-for-agent, JSONPath conditions, map iteration all stubbed
- `packages/core/src/tools/skill-registry.ts` — in-memory only, persistence TODO

**Medium-risk:**
- `task-decomposer.ts` — heuristic, marked "use LLM in production"
- `strands-agents.ts` — documented shim awaiting npm publish

**Missing operational docs (now tracked in `dr-runbook-gaps.md`):**
- PITR restore
- Tenant-breach incident playbook
- CDK deploy-failure recovery
- Skill-compromise response
- DLQ drain procedure

## Agent-framework next steps

ADR-034 now drafted this wave. Phase-2 spike design at `docs/designs/agentcore-registry-spike.md`. Multi-tenancy decision (per-tenant Registry vs. shared with scoped records) deferred to spike.

## Operational readiness

| Pillar | Status |
|--------|--------|
| Tenant isolation | ✅ 3-layer |
| Code quality | ✅ all test suites green |
| CDK infra | ✅ 14 stacks synthesize |
| SSE streaming | ✅ heartbeat + backpressure |
| Auth | ✅ Cognito + MFA |
| DR runbooks | 🔴 3 critical missing |
| Per-tenant cost tracking | 🟡 aggregate only |
| Incident response | 🟡 generic framework; topic-specific gaps |

**Verdict:** Ship baseline. 2-day ops sprint closes the gap to GA.

## Review-doc consolidation

Currently 14 docs in `docs/reviews/`. Recommendation: keep 7 strategic (SYNTHESIS, FINAL-REPORT, agent-framework-alternatives, fresh-gaps, cost-observability-audit, dr-runbook-gaps, pr-readiness-audit); archive the 6 wave-specific audits + boundary-leak-sweep into a `docs/reviews/archive/` dir.

## Top 3 architectural investments for next sprint

1. **Ops hardening (2 days) — unblocks GA.** Write PITR restore + tenant-breach + CDK-failure runbooks; emit the 5 CRITICAL metrics.
2. **Triage `agentcore-runtime.ts` (1 day).** Determine if stubs are blocking or aspirational.
3. **AgentCore Registry spike (1 week, post-GA).** Resolves ADR-034's open questions.

## Coherence scorecard

| Dimension | Score |
|-----------|-------|
| Layer boundaries | 7/10 |
| Canonical data flows | 8/10 |
| ADR-implementation fit | 9/10 (was 8 pre-ADR-034) |
| Naming conventions | 9/10 |
| README / ROADMAP truthiness | 8/10 |
| Unfinished-work clarity | 7/10 |
| Operational readiness | 5/10 |
| Documentation tax | 6/10 |

**Overall 7.4/10.** The architecture holds together. Operational story needs a sprint.
