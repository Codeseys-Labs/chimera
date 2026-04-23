# Wave-7 Doc-Drift Audit

**Date:** 2026-04-18
**Method:** read-only scan of top-level and `docs/` after waves 1-6 + ADR-034.

## TL;DR

**10 docs need updates. Severity: 3 HIGH + 5 MEDIUM + 2 LOW.** The codebase now enforces tenant isolation in **three layers** (CDK + TypeScript Cedar + Python `ContextVar` per ADR-033), but `system-architecture.md` and `CLAUDE.md` still describe only the CDK/Cedar layers. README claims 30 ADRs + 15 stacks; reality is 34 ADRs + 14 deployed stacks (Discovery consolidated into GatewayRegistration).

## README.md — 4 drift items

1. **Stack count:** "15 production-grade CDK stacks" → should be **14** (Discovery consolidated).
2. **Architecture diagram:** "AgentCore Gateway (MCP)" positioned as universal tool router → inaccurate. Per rabbithole doc 03, Chimera does not actually use Gateway — tools route via Lambda tiers 1-4.
3. **Skills status badge:** "Registry, discovery, installer, validator, MCP gateway client ✅ **BUILT**" is stale post-ADR-034. Current is DDB-backed; Registry adoption is in Phase-0/1 scaffolding + spike.
4. **Phase 3 status:** "✅ COMPLETE" should read "Code complete; Registry migration spike pending".

## CLAUDE.md — 4 drift items

1. **Tenant-isolation section (~line 110):** lists CDK/Cedar/KMS but omits the Python `ContextVar` layer added in ADR-033. Needs a short paragraph naming the three layers.
2. **Python conventions (~line 146):** doesn't name `tools/tenant_context.py` or the `require_tenant_id()` contract that every new tool must honor.
3. **6-table DynamoDB ref (~line 385):** doesn't reference the enhanced multi-item tenant-config pattern (`PROFILE` · `CONFIG#features` · `CONFIG#models`).
4. **GSI cross-tenant leakage section (~line 449):** TypeScript `FilterExpression` filtering is documented; mention that Python enforces the same invariant via `ensure_tenant_filter()`.

## docs/ROADMAP.md — 3 drift items

1. **ADR count (2 places):** "30 ADRs" → **34 ADRs** after 031, 032, 033, 034.
2. **Test-result narrative:** doesn't mention polling circuit breakers added in waves 2-3.
3. **Dependency graph:** Phase-3 block should surface "[SPIKE: ADR-034 Registry adoption]" so readers see the gate.

## docs/VISION.md — 2 drift items

1. **"85% complete"** conflicts with ROADMAP's more current "90%". Sync the number.
2. **Metrics table** (962 tests / 48.3K LOC / 11 stacks) is 2+ weeks stale. ROADMAP shows 2269 tests / 75.7K LOC / 14 stacks.

## docs/architecture/system-architecture.md — 3 drift items

1. **GatewayRegistration stack section:** no mention of Python-tool `ContextVar` step. New readers miss the enforcement layer.
2. **Timestamp:** "2026-04-10" — 8 days stale. Waves 4-6 happened after.
3. **§6 Multi-Tenant Data Flow diagram:** doesn't include the Python `ContextVar` step or `ensure_tenant_filter()`. Critical flow step missing.

## docs/architecture/canonical-data-model.md — 1 drift item

1. **`chimera-skills` table section:** needs a footnote that ADR-034 proposes migration to AgentCore Registry; the DDB table remains canonical until the spike resolves multi-tenancy.

## CHANGELOG.md — 1 finding

File does not exist despite commit `851dcff` referencing it. Either create it or fix the reference.

## ADR cross-reference drift

- **ADR-033 itself is clean.** But downstream docs (system-architecture, CLAUDE.md) haven't caught up to the 3-layer model.
- **ADR-034** references `docs/MIGRATION-registry.md` — file now exists (wave 6), so the link works.
- **ADR-034** references `docs/designs/agentcore-registry-spike.md` — exists, link works.

## Priority list (~4 hours total)

### P0 (blocks contributor understanding)
1. CLAUDE.md §tenant-isolation — add 3-layer paragraph
2. system-architecture.md §6 — add Python `ContextVar` to multi-tenant data-flow diagram
3. README.md — stack count 14

### P1 (reduces confusion)
4. ROADMAP.md ADR count (2 places)
5. ROADMAP.md Phase-3 spike annotation
6. VISION.md status + metrics

### P2 (nice-to-have)
7. system-architecture.md timestamp
8. canonical-data-model.md `chimera-skills` footnote
9. README.md skill registry badge
10. CHANGELOG.md (create, or remove the reference)

## Notes

All edits are 1-3 sentence additions. No restructuring. No new sections required. Total remediation ~4 hours if done in one pass.
