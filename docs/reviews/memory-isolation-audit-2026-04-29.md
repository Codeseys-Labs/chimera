---
title: "Multi-tenant memory isolation audit — 2026-04-29"
date: 2026-04-29
status: findings
scope: agent memory, session transcripts, AgentCore Memory, RAG/KB/OpenSearch, skill discovery
author: audit subagent + lead review
companion: docs/reviews/multi-tenant-isolation-live-probes-2026-04-28.md
---

# Memory isolation audit

User question: *"can we make sure that the memory also is isolated (unless we have a way to share context across users/orgs (UTO)?)"*

Summary: session transcripts and AgentCore Memory are **structurally
isolated**; one path in skill discovery (semantic search) is **missing
its tenant filter** and should be fixed before shipping semantic search
to prod. UTO (Unified Tenant Organization) is not implemented.

## TL;DR by layer

| Layer | Store | Isolation | Strength | Enforced at | UTO? | Risk |
|-------|-------|-----------|----------|-------------|------|------|
| Session transcripts | `chimera-sessions-dev` DDB | PK `TENANT#{id}#SESSION#{id}` | **Structural** | DDB constraint | No | LOW |
| STM (short-term memory) | Bedrock AgentCore | Namespace `/strategy/X/actor/tenant-{id}-user-{id}/session/{id}/` | **Structural** | IAM + Runtime | No | LOW |
| LTM (long-term memory) | Bedrock AgentCore (not yet impl in TS) | Same namespace scheme | **Structural** (when implemented) | IAM + Runtime | No | MED |
| Semantic skill search | Bedrock KB + OpenSearch | **no tenant filter** on KB query path | **Broken** | App code (missing) | Partial | **CRITICAL** |
| Keyword skill search | DDB Registry | `searchSkills(..., tenantId)` correctly scoped | Application | App code | No | LOW |
| Tenant context | JWT `custom:tenant_id` | JWT claim; header fallback only in dev | Structural | Middleware | No | LOW |

## Findings

### CRITICAL — Semantic search is not tenant-filtered

**File:** `packages/core/src/skills/discovery.ts:105-177`

`SkillDiscoveryService.search(query, tenantId, …)` accepts `tenantId`,
but when semantic search is enabled it forwards to
`semanticSearch(query, filters, limit)` — dropping `tenantId` on the
floor. The underlying Bedrock KB `retrieve` call has no
`filter` / `metadataFilter` clause keyed on tenant.

```typescript
async search(query, tenantId, filters, limit = 10) {
  if (this.config.enableSemanticSearch && this.bedrockKB) {
    return this.semanticSearch(query, filters, limit);  // <-- tenantId dropped
  }
  return this.keywordSearch(query, tenantId, filters, limit);
}
```

**Impact:** If `enableSemanticSearch=true` in any environment and the
shared KB ingests skills from multiple tenants, a caller from tenant A
can retrieve tenant B's skill documents. Current deployment flag state:
verify before shipping.

**Fix:** add `tenantId` to `semanticSearch()` signature and include it
as a `retrievalConfiguration.vectorSearchConfiguration.filter` clause
matching a `tenant_id` metadata field on the indexed documents.

### HIGH — AgentCore Memory TypeScript client is a stub

**File:** `packages/core/src/memory/client.ts:102-107`

`MemoryClientFactory.createAgentCoreClient()` throws
`"not yet implemented"`. Today the only live AgentCore Memory
integration is the Python runtime (`packages/agents/chimera_agent.py`),
which *does* derive namespaces correctly from JWT claims and clears
the tenant context var in a `finally` block.

**Risk:** When the TS client is implemented, isolation strength depends
entirely on whether the implementation mirrors the Python namespace
pattern *and* whether IAM policy on the AgentCore runtime role denies
foreign namespaces.

**Mitigation:** any PR adding the TS client MUST include a unit test
that asserts the namespace string contains `tenant-{tenantId}-` and
MUST add a Cedar / IAM assertion in the deploy contract.

### HIGH — Bedrock KB tenant-metadata presence unverified

**File:** `packages/core/src/skills/discovery.ts:244` (OpenSearch path)
also lacks a tenant `must`-clause.

**Mitigation:** Before enabling either semantic or OpenSearch search in
prod: (a) confirm every ingested skill record has a `tenant_id`
metadata field, (b) add `tenant_id` to the `must`/`filter` clause on
every query, (c) add an integration probe that indexes two skills
under two tenants and asserts cross-tenant retrieval returns zero.

### MEDIUM — Session messages returns 200 for non-existent foreign sessions

Already documented in the companion probe doc
(`multi-tenant-isolation-live-probes-2026-04-28.md` §FINDING 1). Not a
data leak; PK is still tenant-scoped. Convention nit — return 404
instead of empty 200.

### MEDIUM — Body-level `tenantId` silently ignored instead of 400

Already documented in the companion probe doc §PROBE 8. The JWT wins,
but a conflicting body value should fail loud.

### LOW / INFO — Sessions scoped to tenant, not user

`chat.ts:724` uses `PK=TENANT#{tenantId}`. All users in a tenant see
all tenant sessions. **By design** (multi-tenant SaaS). Per-user
privacy would require adding `userId` to the SK and Cedar policy on
`Session::Read`. Out of scope for tenant isolation — flagged for
future product decision.

## UTO (Unified Tenant Organization) assessment

**Status: NOT IMPLEMENTED.**

Grep across `packages/`, `infra/`, `docs/designs/`, `ADRs/` for
`organizationId | orgId | parentTenant | tenant group | workspace
group | shared | cross-tenant | uto` yields no product-level hits.
The tenant model is one-dimensional: opaque `tenantId` string.

**To enable UTO, the minimum path:**

1. **Schema** — add `organizationId` to Cognito claims, tenant table
   PROFILE row, and session PK pattern: e.g.
   `ORG#{orgId}#TENANT#{tenantId}#SESSION#{sessionId}`.
2. **JWT** — publish a list of `accessible_organization_ids` alongside
   `tenant_id` so a user can read (but not write) into shared org
   namespaces.
3. **AgentCore namespace** — extend to
   `/strategy/{strategy}/actor/org-{orgId}-shared-or-tenant-{tid}-user-{uid}/...`
   and split read/write namespaces so shared context is read-only by
   default.
4. **Cedar** — add policies `Memory::ReadSharedOrg` and
   `Memory::WriteSharedOrg` (the write policy must require an explicit
   "promote" action, so tenant-level memories don't accidentally leak
   into shared space).
5. **Skill / RAG** — extend metadata filter to
   `(tenant_id = :tid) OR (organization_id = :oid AND scope = 'shared')`.
6. **Integration test** — cross-tenant probe from a user with
   `accessible_organization_ids=[org1]` reading org1-shared content
   must succeed, reading tenant-B content must fail.

**Estimated effort:** 8–12 eng days for the minimum viable UTO; more
if we want Cedar policies auto-managed (Onboarding workflow already
has the hook points).

## Immediate action plan

1. **Before shipping semantic skill search anywhere:** land the tenant
   filter on `semanticSearch()` + KB metadata filter + integration
   probe.
2. **Before shipping AgentCore TS Memory client:** require the
   namespace assertion + IAM deny policy for foreign namespaces.
3. **Tighten** the body-`tenantId` and session 404 polish items at
   next Wave (low priority, but low cost).
4. **Decide on UTO.** Is the product intent to enable cross-org memory
   sharing? If yes, run the UTO design doc before Wave-34.
