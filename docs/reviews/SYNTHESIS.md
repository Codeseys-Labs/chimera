# Chimera Deep-Work Review — Phase 2 Synthesis

**Date:** 2026-04-17
**Inputs:** 5 parallel Phase 1 reports under `docs/reviews/`
**Total findings across reports:** ~78 discrete items (11 CRITICAL, 21 HIGH, 35 MEDIUM, 11 LOW)

## Executive Summary

Chimera is a genuinely impressive build — 15 CDK stacks, 22 core modules, 40 AWS tools, 2206 passing tests, 30 ADRs. The architecture is sound and the team has already done the heavy lifting on multi-tenancy isolation at the **CDK/DynamoDB layer** (verified: every TS-layer GSI query filters on `tenantId`; Cedar policies test on reasons; no `unsafeUnwrap`; no unsafe HTML sinks).

**But** Phase 1 surfaced one high-impact contradiction and three runway-shortening hazards that collectively mean **Chimera is not yet production-ready** despite the README's "90% complete" framing:

1. **Tenant boundary leaks in the Python tool layer** — the exact same multi-tenancy guarantees the CDK layer enforces are bypassable inside agent tools. `tenant_id` is a user-settable argument in 5 places across `swarm_tools.py` and `code_interpreter_tools.py`, and `dynamodb_tools.py` treats `filter_expression` as optional. This contradicts the "PASS" signal the CDK-layer security audit returned for the same concern.
2. **Infinite polling loops in self-evolution** — a 15-minute hang per invocation, silent, with no circuit breaker.
3. **SSE stream has no heartbeat or backpressure** — long streams will time out at proxies; disconnects leak compute.
4. **CDK-layer criticals** — DAX SG over-permissive, WAF logs not wired to CloudWatch, KMS/log-group race, ALB access logs suppressed.

The agent-framework research was also decisive: **stay on Strands, pilot AWS AgentCore Registry, skip Hermes/Pi**. Registry is the high-ROI adopt-now move — it replaces a meaningful slice of what `chimera-skills` + the Skill Pipeline already hand-roll.

## The Contradiction That Matters Most

The CDK-layer security audit reported "PASS" on tenant isolation. The Python runtime audit found the opposite **in the same product** at a different layer. Both are correct about their own scope; the narrative about Chimera's isolation posture has to be re-told with that caveat:

> **CDK/DynamoDB layer: tenant isolation is enforced. Python agent tool layer: tenant isolation is bypassable by a misbehaving or compromised agent.**

Verified evidence:

```
packages/agents/tools/swarm_tools.py:49,151,236,307   tenant_id: str = ""
packages/agents/tools/code_interpreter_tools.py:280   tenant_id: str = ""
packages/agents/tools/dynamodb_tools.py:32,208        filter_expression: str = ""  (documented "Optional")
```

This is fixable in roughly a day via a `@with_tenant_context` decorator that (a) injects `tenant_id` from the AgentCore runtime env, (b) rejects any tool argument that attempts to set it, (c) enforces a tenant condition on every DDB query. **This is the single highest-ROI fix in the entire review.**

## Prioritized Gap List

### P0 — Blocking for production (ship-stoppers)

| # | Item | Source | Effort |
|---|------|--------|--------|
| P0-1 | Tenant boundary: remove `tenant_id` from tool signatures + enforce via decorator | runtime C3 | ~4h |
| P0-2 | Tenant boundary: make `filter_expression` non-optional with tenant condition | runtime H5 | ~3h |
| P0-3 | DAX SG scoped to chat-gateway tasks only (not whole ECS SG) | infra C1 | ~4h |
| P0-4 | WAF → CloudWatch Logs wired up | infra C2 | ~2h |
| P0-5 | Evolution + swarm polling loops: add circuit breaker + backoff | runtime C1, C2 | ~4h |
| P0-6 | Gateway Lambda proxy payload size/depth validation | runtime C4 | ~3h |
| P0-7 | SSE heartbeat + backpressure + client-disconnect | TS C2 | ~6h |
| P0-8 | Chat gateway request validation (Zod) | TS C1 | ~3h |
| P0-9 | Tool error envelope — required `status` field | TS C3 | ~2h |

**Total P0 effort: ~31 hours of focused work.**

### P1 — Should-fix-before-GA

| # | Item | Source | Effort |
|---|------|--------|--------|
| P1-1 | KMS/log-group race: guarantee policy attached before encrypted log group creation | infra C3 | ~2h |
| P1-2 | ALB access logs enabled in prod (S3 + 30-day lifecycle) | infra H5 | ~2h |
| P1-3 | ConverseStream state-machine race (flush pending tool blocks before finish) | TS H3 | ~3h |
| P1-4 | TypeScript `strict: true` in every package; quarantine 793 `any`/`as any` in one adapter layer | TS H1 | ~2d |
| P1-5 | Zod schemas at shared-type boundary (`packages/shared`) | TS H2 | ~1d |
| P1-6 | Boto3 timeouts + retries on every client | runtime H4 | ~4h |
| P1-7 | Loose Python version pins → upper-bound them | runtime H1 | ~1h |
| P1-8 | Bare `except Exception` sweep (30+ sites) | runtime H2 | ~1d |
| P1-9 | CLI token expiry check | TS H4 | ~2h |
| P1-10 | CodeCommit 5MB file skip warning + multi-commit fallback | TS H5 | ~4h |
| P1-11 | `findProjectRoot()` monorepo-aware (detect `workspaces`) | TS H6 | ~2h |
| P1-12 | PITR validation via AWS Config managed rule | infra H3 | ~3h |
| P1-13 | Audit TTL enforcement per tenant tier | security M3 | ~1d |
| P1-14 | JWT revocation path + per-tenant TTL | security M1 | ~2-3d |

### P2 — Architectural improvements (post-GA)

- Cross-region DR (Global Tables v2, Route53 failover) — infra H2
- Managed agent runtime evaluation once Strands GA ships — runtime
- Adopt **AgentCore Registry** for skill discovery + governance — framework research
- Tenant-tier DAX scoping (don't cache tenants/audit/cost tables) — infra M11
- ECS egress tightening (VPC endpoints, no 0.0.0.0/0) — infra M12
- Structured logging across all Python tools + CloudWatch EMF metrics per tool — runtime M1, M6
- React error boundaries, bundle-size budget, CORS tightening — TS M6, M7, M1

### P3 — Nice-to-have / polish

- Full list in the individual review files (infra-review.md §Low, etc.)
- Includes: docstring completeness, magic-string DDB keys, inconsistent region defaults, error-message format.

## Top Two Strategic Moves

### 1. Adopt AWS AgentCore Registry (pilot now, migrate post-GA)

Registry is a direct fit for Chimera's current hand-rolled work in `chimera-skills` + the Skill Pipeline:

- Registry's `DRAFT → PENDING_APPROVAL → APPROVED` workflow replaces custom state in `chimera-skills`.
- `SearchRegistryRecords` (hybrid semantic + keyword) replaces the bespoke skill-catalog API.
- Registry exposes a **remote MCP endpoint** — any MCP client (including the Strands agent itself) can discover skills via MCP protocol. Eliminates the planned MCP-directory work in the Orchestration stack.
- JWT/IAM inbound auth + EventBridge on record submission.

**What Chimera keeps:** MicroVM, Strands ReAct loop, Memory, Gateway, Identity, Code Interpreter, Browser, Cedar, 6-table DDB schema, security-scanning stages of the Skill Pipeline.

**What Chimera replaces:** `chimera-skills` DDB schema → Registry records; custom skill-catalog API → `SearchRegistryRecords`; Skill Pipeline's "publish" stage → `submit_registry_record_for_approval` + `update_registry_record_status`.

**Risk:** multi-tenancy model (one registry per tenant vs. one registry with tenant-scoped records) is not documented in AWS's public docs. Phase 2 spike on a dev tenant to validate before committing.

### 2. Keep Strands; do not switch to Hermes or Pi

- **Hermes** — identity uncertain. Most likely interpretation: NousResearch Hermes model family, which is a model, not a runtime. It sits inside a Strands loop, not instead of one. Llama-3 community license constraints + no AWS-native story make it inferior to continuing on Bedrock-managed inference.
- **Pi (Mario Zechner's `pi-agent-core`)** — single-user local coding agent. Architecturally hostile to multi-tenant SaaS. Pre-1.0, solo maintainer, no MCP, no sub-agents, no managed-runtime story.
- **Strands** — remains the right ReAct loop for Chimera. De-risk it with upper-bound version pins and better observability, not by swapping it out.

## Proposed Phase 3 Scope (Act)

Given the volume (31 hours of P0 + substantial P1), Phase 3 should be **scoped tight**. My recommendation:

**Phase 3a (this session if time permits, otherwise a dedicated follow-up):**
- P0-1 and P0-2 — tenant-boundary fix in Python tools. Highest ROI, most alarming finding, bounded blast radius.
- P0-8 — Zod at chat-gateway route entry. Prevents crash-in-stream.
- P1-7 — Python version upper bounds.

**Phase 3b (follow-up sessions):**
- Remaining P0 items.
- P1 items in priority order.
- AgentCore Registry spike (separate work stream).

## Proposed ADRs to Draft

1. **ADR-033 — Tenant context injection decorator for Python tools.** Documents the `@with_tenant_context` pattern; deprecates `tenant_id` as a tool argument.
2. **ADR-034 — AWS AgentCore Registry adoption.** Pilot → migrate plan for replacing `chimera-skills` custom catalog.
3. **ADR-035 — SSE hardening.** Heartbeat, backpressure, client-disconnect semantics. Ties into C2 + existing Vercel AI SDK v5 DSP.

## What the Review Did Not Cover (acknowledged gaps)

- No live-environment runtime verification (marked "REQUIRES RUNTIME VERIFICATION" in security review).
- No performance/cost benchmarking.
- No chaos-engineering scenarios (pod-kill, region-fail, DDB throttle).
- Research-doc quality audit was out of scope (123 docs / 118k lines not rereviewed).
- Frontend UX/design was out of scope.

## References

- `docs/reviews/infra-review.md` — 28 findings (4 CRITICAL, 6 HIGH, 10 MEDIUM, 8 LOW)
- `docs/reviews/agent-runtime-review.md` — 30 findings (4 CRITICAL, 8 HIGH, 12 MEDIUM, 6 LOW)
- `docs/reviews/ts-packages-review.md` — 20 findings (3 CRITICAL, 7 HIGH, 10 MEDIUM)
- `docs/reviews/security-review.md` — 10 TS/CDK findings (0 CRITICAL, 0 HIGH, 3 MEDIUM, 2 LOW, 5 INFO)
- `docs/reviews/agent-framework-alternatives.md` — Adopt Registry, skip Hermes/Pi, keep Strands
