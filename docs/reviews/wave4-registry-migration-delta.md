# Skill Pipeline → AgentCore Registry Migration Delta

**Date:** 2026-04-17
**Prerequisite:** ADR-034 + `docs/designs/agentcore-registry-spike.md`

## TL;DR

Chimera can migrate from `chimera-skills` DDB + Skill Pipeline to AWS Bedrock AgentCore Registry with bounded risk. The 6 security-scanning stages stay; only the catalog/discovery/approval layer is replaced. Effort ~3-4 weeks. Blocker: multi-tenancy model (per-tenant Registry vs. shared with tenant-scoped records) must be resolved by the Phase-2 spike.

## Current-state inventory

| Component | Purpose | Disposition |
|-----------|---------|-------------|
| `infra/lib/skill-pipeline-stack.ts` | 7-stage Step Functions | **KEEP** stages 1-6; stage 7 calls Registry |
| `infra/lambdas/skill-pipeline/{static-analysis,dependency-audit,sandbox-run,signature-verification,performance-testing,manual-review}/index.mjs` | Stages 1-6 scanners | **KEEP** unchanged |
| `infra/lambdas/skill-pipeline/skill-deployment/index.mjs` | Stage 7 publish to DDB + S3 | **REPLACE** — call `CreateRegistryRecord()` + `UpdateRegistryRecordStatus()` |
| `infra/lambdas/skill-pipeline/scan-failure/index.mjs` | SNS + DDB status on failure | **KEEP** SNS; add Registry DEPRECATE call if record exists |
| `chimera-skills` DDB table (in `data-stack.ts`) | Marketplace catalog | **DUAL-WRITE** during migration; DELETE Phase 6 |
| `infra/lambdas/api-handlers/skills/index.mjs` | Skills API (GET/POST/DELETE) | **REPLACE** discovery path with `SearchRegistryRecords` |
| `packages/core/src/skills/registry.ts` | `SkillRegistry` (DDB-backed) | **REPLACE** with `BedrockRegistryClient` |
| `packages/core/src/skills/discovery.ts` | Marketplace discovery | **REPLACE** — call Registry search |
| `packages/core/src/skills/installer.ts` | Install workflow | **KEEP** (logic intact; queries Registry) |
| `packages/core/src/skills/{validator,trust-engine,parser}.ts` | Pre-Registry validation | **KEEP** |
| `packages/core/src/skills/scanners/*.ts` | 6 scanner modules | **KEEP** |
| `packages/core/src/skills/{mcp-provider,mcp-gateway-client}.ts` | MCP endpoint integration | **KEEP** |
| `docs/architecture/canonical-data-model.md` §3.3 | Schema for chimera-skills | **UPDATE** with Registry footnote + migration notes |
| `seed-data/skills.json` | ~50 sample skills | **MIGRATE** one-time bulk import (Phase 3) |

## Component → Registry mapping

| Chimera today | Registry primitive | Effort |
|---------------|-------------------|--------|
| Discovery GSI query | `SearchRegistryRecords` (hybrid semantic + keyword) | 1d |
| Skill install → DDB write | Keep local DDB for install state only; Registry is source of truth for metadata | 2d |
| Approval gate in manual-review Lambda | `UpdateRegistryRecordStatus(id, 'APPROVED')` | 2d |
| Publish (stage 7) | `CreateRegistryRecord` + status update | 2d |
| Ed25519 signing (stage 4) | Keep; publish signature as Registry record attribute | 1d |
| Failure path | Keep SNS + Registry DEPRECATE | 1d |
| `/api/v1/tenants/{id}/skills` | Route to Registry client | 3d |
| Per-tenant MCP directory (planned) | Registry MCP endpoint per registry | 1d |
| Multi-tenant isolation | **OPEN — spike decision** | 3-5d |
| Bulk migration of existing skills | Async Lambda job | 3d |

## KEPT / REPLACED / REMOVED / NEW

**KEPT:**
- Full security scanning pipeline (stages 1-6)
- Cedar policies on publish
- Per-tenant rate limits
- Trust-engine + validator + parser

**REPLACED:**
- Skill metadata storage (`chimera-skills` DDB → Registry `AgentSkills` records)
- Discovery API backend
- Approval state machine
- Publishing gate

**REMOVED:**
- Custom skill-catalog API (returns 410 after cutover)
- `chimera-skills` DDB table (tombstoned Phase 6; archived to Glacier)
- Custom skill search GSIs (3 indexes)

**NEW:**
- `packages/core/src/registry/bedrock-registry-client.ts` (~200 LOC)
- `packages/core/src/registry/skill-to-registry-mapper.ts` (~150 LOC)
- `infra/lambdas/skill-pipeline/registry-submitter/index.mjs` (~300 LOC)
- `infra/lib/registry-stack.ts` — new CDK stack (~100 LOC)
- Unit tests (~150 LOC)

Total new code ≈ 900 LOC / 5 engineering days.

## Feature-flag rollout plan

| Phase | Week | Flag | Behavior | Rollback |
|-------|------|------|----------|----------|
| 1 — dual-write | W1 | `REGISTRY_ENABLED` off→on | Write both DDB + Registry | Toggle flag off (<5 min) |
| 2 — dual-read | W2 | `REGISTRY_PRIMARY_READ=false` | Try Registry, fallback DDB | Revert flag |
| 3 — bulk migrate | W3 | — | Async Lambda export+import; idempotent | Re-run with skip-already-migrated |
| 4 — Registry-primary | W4 | `REGISTRY_PRIMARY_READ=true` | Read Registry only | Revert (<5 min) if error > 1% |
| 5 — Registry-only writes | W5 | `DDB_WRITE_SKILLS_DISABLED=true` | Writes Registry only | Resume dual-write |
| 6 — cleanup | W6 | remove flags | Snapshot DDB → Glacier, delete table | **IRREVERSIBLE** |

## Multi-tenancy resolution (spike decision)

**Option A — per-tenant Registry:**
- ✅ Hard isolation boundary, per-tenant quotas, per-tenant approval workflows
- ❌ Cost scales linearly with tenant count; quota-at-scale unclear

**Option B — shared Registry with tenant-scoped records:**
- ✅ Flat cost regardless of tenant count, simpler ops
- ❌ Relies on JWT `tenantId` claim + app-layer filter (error-prone)
- ❌ Shared approval queue requires curator filtering

Spike both on a dev tenant. Decide based on scaling target + isolation requirement.

## Test plan (23 tests)

- 8 unit (`bedrock-registry-client`, `skill-to-registry-mapper`, both feature-flag paths in skill-deployment)
- 8 integration (dev AWS: create test Registry, submit 5 skills, verify flags, multi-tenant isolation)
- 4 E2E (full pipeline APPROVED path, rejection path, rollback, bulk migration)
- 3 load (SearchRegistryRecords p99 < 500ms, concurrent `CreateRegistryRecord`, fallback behavior under Registry slowdown)

## Risk register

**HIGH:**
- Multi-tenant isolation bug in Option B → tenant cross-contamination. Mitigate: exhaustive Phase-2 testing + two-engineer review.
- Registry quotas insufficient for 1000-tenant SaaS. Mitigate: contact AWS for limits + quota-increase process.
- Schema mapping incomplete. Mitigate: Phase-3 export/import validation + count reconciliation.

**MEDIUM:**
- Registry GA status uncertain. Mitigate: verify at AWS What's New before Phase 2.
- EventBridge schema changes. Mitigate: Phase-2 schema tests.
- Latency regression. Mitigate: perf tests; cache if needed.

**LOW:**
- Dual-write cost during weeks 1-2 (small).
- Ops learning curve.

## Open questions for the spike

1. Per-tenant Registry vs shared-with-scope — decision criteria and cost model.
2. Per-region record limits; quota-increase process.
3. Registry GA confirmation (not preview).
4. SKILL.md-v2 → Registry `AgentSkills` schema mapping — any gaps?
5. Can Registry auto-approve if Chimera scanning passes, or is manual always required?
6. Can Strands agents call Registry's MCP endpoint directly, or must Chimera proxy?
7. Pricing model — per-record? per-API-call? storage?
8. JWT claim routing: `tenantId` propagation through Registry APIs.
9. EventBridge event types emitted by Registry.
10. Degradation: graceful behavior when Registry is unavailable.

## Recommended ADR-034 outline

Already drafted in this wave at `docs/architecture/decisions/ADR-034-*.md`. Covers: pilot scope, migration plan, multi-tenancy risks, rollback story, timeline.
