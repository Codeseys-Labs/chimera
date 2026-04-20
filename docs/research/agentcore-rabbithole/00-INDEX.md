---
title: "AgentCore Rabbithole — Index + Synthesis"
status: research
date: 2026-04-17
---

# AgentCore Deep-Dive Rabbithole

A set of operator-grade deep-dives on AWS Bedrock AgentCore primitives, produced to inform Chimera's strategic direction. Six documents total.

| # | Topic | Lines | Status |
|---|-------|-------|--------|
| 01 | [Registry](01-registry-deep-dive.md) | 706 | ✅ |
| 02 | [Runtime + Memory](02-runtime-memory-deep-dive.md) | 495 | ✅ |
| 03 | [Gateway + Identity](03-gateway-identity-deep-dive.md) | 502 | ✅ |
| 04 | [Code Interpreter + Browser](04-code-interpreter-browser-deep-dive.md) | 562 | ✅ |
| 05 | [Observability + Evaluations](05-observability-evaluations-deep-dive.md) | 393 | ✅ |
| 06 | [Self-Evolution Architectures](06-self-evolution-architectures.md) | 1243 | ✅ |

Total: ~3,900 lines of operator-grade reference material, cross-linked to 8 prior review docs + 2 ADRs + 1 spike design.

## TL;DR across all six

Chimera is **not yet using AgentCore the way the README suggests.** The Python agent wraps `@entrypoint` and `AgentCoreMemorySessionManager` correctly, but meaningful slices of custom code duplicate managed primitives — and in one case (`validate_cdk_in_sandbox`) call the wrong service name and silently fall through to the regex fallback every time.

After adopting Registry + Evaluations + Memory native strategies + fixing the Code Interpreter service name, Chimera deletes ≈ 1,800 LOC of hand-rolled substrate and gains native semantic search, governed approval workflow, LLM-as-judge evals, and quarterly-auditable cost reduction.

## The six biggest surprises

### 1. `packages/core/src/runtime/agentcore-runtime.ts` (~370 LOC) is dead code

From doc #02: every method (`createSession`, `resumeSession`, `terminateSession`, `storeMemory`, `invokeAgent`, `generateSessionId`) either TODO-stubs a managed primitive or reinvents a Runtime behavior the Python entrypoint already bypasses. `resumeSession` specifically can't exist — AgentCore intentionally doesn't support it. Triage candidate for deletion.

### 2. `packages/agents/gateway_proxy.py` is NOT using AgentCore Gateway

From doc #03: despite the README's claim, there's no real Gateway target registration. `gateway_proxy.py` + `gateway_config.py` + `GatewayRegistrationStack` is a hand-rolled tier-grouped Lambda fanout via `boto3.invoke`. The `chimera-agentcore-invoke` IAM role is provisioned but never attached to a real Gateway. **~600 LOC of custom dispatch could be replaced with ~19 `CreateGatewayTarget` calls.**

### 3. Code Interpreter tool calls the wrong service name → always falls through to regex

From doc #04: `packages/agents/tools/code_interpreter_tools.py:66` uses `boto3.client("bedrock-agentcore-runtime", ...)` but the actual service name is `bedrock-agentcore` (data plane). Every call raises `UnknownServiceError`, caught by the fallback path. **The sandbox has never actually validated a CDK stack in production.** One-day fix, highest-impact bug in the session.

### 4. Memory namespace format is incompatible with IAM enforcement

From doc #02: Chimera uses `tenant-{id}-user-{id}` but AgentCore's canonical format is `/strategy/{id}/actor/{actorId}/session/{sessionId}/` with mandatory trailing slash. IAM condition keys on `bedrock-agentcore:namespace` won't enforce tenancy as written.

### 5. Eight observability metrics are defined for the dashboard but never emitted

From doc #05: `Chimera/Tenant:*` + `Chimera/Skills:*` dimensions referenced in CloudWatch dashboards have no emitters. Adopting AgentCore Observability gives us ~4 of them free (aggregates) but the tenant-dimensioned versions still need custom emitters.

### 6. The self-evolution weak spot is the gate, not the generator

From doc #06: Chimera already has all 5 evolution axes (P1 prompt / P2 skill / P3 routing / P4 memory / P5 IaC) with 8 safety rails — unusually comprehensive vs. competitors. The weak link is **gate quality** — P1 uses keyword overlap (1990s bag-of-words), P2 has no automated `APPROVED` transition. **Evaluations + Registry plug directly into this weak spot.**

## The moat (post-AgentCore adoption)

> Evolution-as-governed-CI/CD-for-agents on a multi-tenant AWS substrate.

No competitor checks all five boxes simultaneously:
- Multi-tenant (vs OpenClaw: single-user; Pi: single-user)
- AWS-infrastructure-aware (vs NemoClaw: on-prem; Hermes: model-only)
- Self-evolving (vs Bedrock Agents GA: not yet)
- Governed (vs AutoGPT: no gate)
- AWS-managed (vs hand-rolled everything else)

## Prioritized adoption sequence (6 months)

### Sprint 1 (weeks 1-2) — Fixes + quick wins
1. **Fix Code Interpreter service name** (1 day, critical bug) — doc #04
2. **Fix Memory namespace format** to AgentCore canonical (1 day) — doc #02
3. **Delete `agentcore-runtime.ts` dead code** after confirming nothing imports it (1 day) — doc #02
4. **Start emitting the 8 custom-dimension metrics** that dashboards expect — doc #05

### Sprint 2 (weeks 3-4) — Gateway migration
5. **Replace `gateway_proxy.py` with real Gateway target registration** (1 week) — doc #03. Net -600 LOC.
6. **Keep Cedar + rate-limits + structured JSON logging** — Gateway doesn't replace these.

### Sprint 3 (weeks 5-6) — Observability + Evaluations
7. **Onboard AgentCore Observability** — OTEL instrumentation + CloudWatch GenAI dashboard — doc #05.
8. **Wire AgentCore Evaluations as the P1/P2 gate** — replace keyword-overlap, unblock automated APPROVED transition — doc #05 + #06.

### Sprint 4 (weeks 7-8) — Registry spike + decision
9. Execute the spike in `docs/designs/agentcore-registry-spike.md` — resolve multi-tenancy model.
10. Commit to a migration path per ADR-034.

### Sprint 5-6 (months 3-4) — Migration execution
11. 6-phase Registry migration per `docs/reviews/wave4-registry-migration-delta.md`.

### Sprint 7-8 (months 5-6) — Self-evolution flywheel
12. Close the generate → gate → promote loop per doc #06.
13. Competitive positioning as "governed self-evolution on AWS."

## New findings surfaced by doc #01 (Registry)

Beyond the prior review memo:
- **MCP endpoint** conforms to MCP spec `2025-11-25` and exposes exactly one tool, `search_registry_records`.
- **`SearchRegistryRecords` is single-registry** — no federated cross-registry search. Reinforces the per-tenant-vs-shared multi-tenancy question.
- **Eventual consistency is documented** — "a few seconds, sometimes minutes" between APPROVED status and searchability. Affects rollout staging.
- **Keyword search weights `name` heavily** — operational hint for skill authors + catalog naming conventions.
- **Console is IAM-only** — JWT-authed registries must be driven from CLI/HTTP/MCP (relevant for tenant-facing UI).
- **EventBridge surface** — docs only confirm "pending approval" + "registry ready" events; APPROVED/REJECTED/DEPRECATED transition events are unverified (spike question #5).

## Known gaps in this research

| Gap | Severity | Mitigation |
|-----|----------|------------|
| GA status inferred (no launch announcement fetched) | medium | Verify at AWS What's New before committing |
| Registry per-record/per-call pricing | low | Consumption-based confirmed; per-dimension TBD — spike open question |
| Exact Runtime/Memory quotas | medium | Follow-up `pricing-and-quotas.md` doc |
| Browser VPC mode absent | medium | Blocks some private-infra inspection use cases; reverse-proxy workaround |
| Evaluations pricing not published | low | Planning estimate $300-$1,500/mo at 10% sampling |
| MCP registry schemaVersion `2025-12-11` (reused, not re-verified) | low | Spike will verify against live Registry |
| A2A v0.3 card schema (reused, not re-verified) | low | Spike will verify if Agent records are used |

## Cross-links

- Strategic: `docs/reviews/agent-framework-alternatives.md`, `docs/reviews/SYNTHESIS.md`
- Decision: `docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md`
- Migration: `docs/reviews/wave4-registry-migration-delta.md`
- Spike: `docs/designs/agentcore-registry-spike.md`
- Architecture coherence: `docs/reviews/wave4-architecture-coherence.md`
