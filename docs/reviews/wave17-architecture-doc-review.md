---
title: "Wave-17 Architecture + Documentation Review"
status: review
date: 2026-04-24
reviewer: Wave-17 Architecture Reviewer
scope: README, ROADMAP, VISION, CLAUDE.md, system-architecture, canonical-data-model, observability, self-evolution-pattern, deployment-architecture, ADR-033, ADR-034
---

# Wave-17 Architecture + Documentation Review

## Summary

14/14 CDK stacks live in `baladita+Bedrock-Admin`. Codebase in strong shape after Waves 15 + 16. Primary doc risk is **staleness across three files last updated before Wave-15** and a **factual error in the brand-new self-evolution-pattern.md** introduced this wave. Vision alignment: ON-TRACK. No blocker for v0.6.3 tag; one finding (deployment-architecture.md 13-stack count) should be fixed before external-audience use.

## Documentation Drift (ranked by severity)

### CRITICAL

**#1 — `docs/architecture/deployment-architecture.md`: 13-stack count, last_updated 2026-03-27**
States "Chimera uses AWS CDK to define and synthesize **13** CloudFormation stacks" and lists 13 rows, omitting `GatewayRegistration`. Project has had 14 stacks since Wave-7. Any operator reading this will misconfigure.

**Fix:** Update to 14 stacks, add GatewayRegistration row, bump `last_updated` + version.

### HIGH

**#2 — `self-evolution-pattern.md` §3: `bunx cdk synth`**
Line 124: `bun install && bun test && bunx cdk synth`. Contradicts mandatory CDK convention (ADR-021, CLAUDE.md): `npx cdk` required, `bunx cdk` breaks `instanceof` checks. system-architecture.md §8 correctly says `npx cdk synth --all`.

**Fix:** Change to `bun install && bun test && npx cdk synth --all`.

**#3 — `self-evolution-pattern.md` §3: Canary percentages mismatch system-architecture.md**
self-evolution-pattern.md: `10% → 50% → 100%`. system-architecture.md §8: `5% → 25% → 50% → 100%`. Authoritative source is system-architecture.md; verify against `pipeline-stack.ts`.

**Fix:** Align self-evolution-pattern.md to `5% → 25% → 50% → 100%`.

**#4 — `README.md`: Version still v0.6.0**
| Field | README | Actual |
|-------|--------|--------|
| Current Status | v0.6.0 | v0.6.2 |
| Quick Start install | v0.6.0 | v0.6.2 |
| TypeScript LOC | ~91,300 | ROADMAP says ~75,700 |
| CLI commands | 21 | ROADMAP says 16 |
| ADR count | 32 | 34 |

**Fix:** Bump version refs, resolve TS LOC + CLI count contradictions, bump ADR count.

### MEDIUM

**#5 — `ROADMAP.md`: Wave-15/16 not reflected, 54-item backlog reference stale**
Header says "Platform 90% complete. Phases 0-6 delivered. First CDK deploy ready — pending execution." All 14 stacks now live. "First CDK Deploy — Blocking" already shipped. "54 open items" reference (now 15). last_updated 2026-04-18 predates Waves 15-16.

**Fix:** Update to reflect deployed status, open-items count 15, bump last_updated.

**#6 — `VISION.md`: Stale test count + TS LOC**
- "2269 tests across 120 files" — punch list + system-arch cite ~2,500 tests / 150+ files
- "~75,700 TypeScript LOC" — README says ~91,300

**Fix:** Resolve README-vs-ROADMAP TS LOC first, then sync VISION.

### LOW

**#7 — `CLAUDE.md`: "11-Stack Architecture" header**
Section still titled "11-Stack Architecture" and lists 11 stacks in a condensed table. Actual: 14. Prose is a snapshot, not full inventory. Low risk but visually incorrect.

**Fix (optional):** Rename to "CDK Stack Architecture", point to system-architecture.md for inventory.

**#8 — `system-architecture.md`: Stale diagram TODO + duplicate Discovery row**
- Line 19 carries `<!-- TODO(wave7+): diagram shows 13 nodes but stack set is 14... -->`. 10-wave-old TODO never landed.
- §1 stack table lists "GatewayRegistration" AND "Discovery" as separate rows. ROADMAP says "Discovery consolidated into GatewayRegistration."

**Fix:** Remove TODO comment; remove standalone Discovery row.

**#9 — `canonical-data-model.md`: Tier enum label inconsistency vs VISION.md**
Data model uses `enterprise | dedicated`; VISION.md Tenant Tiers table uses `Basic / Advanced / Premium`. ADR-024 governs. Confirm canonical set and align both.

## Architecture Coherence Gaps

- Stack-count mapping 1:1 across README/ROADMAP/system-arch; deployment-architecture is the outlier (finding #1).
- Self-evolution-pattern.md cross-refs accurate (except findings #2, #3).
- All current ADRs correctly marked "accepted"; no stale "proposed".
- Observability metric catalog coherent after Wave-15d.

## Missing ADRs Recommended

| ADR | Rationale |
|-----|-----------|
| **ADR-035: CloudWatch Log Retention Classes** | Wave-16b `log-retention.ts` with 3-tier strategy; no ADR |
| **ADR-036: Zod at Shared-Type Boundary** | Wave-16a schemas; runtime validation shift, no ADR |
| **ADR-037: MFA Policy Tiering (Optional dev / Required prod)** | Wave-15 H3 security decision; only in punch list |
| **ADR-038: Cognito Token Lifetime (Web 7d / CLI 1d)** | Wave-15 M1 non-obvious security/UX tradeoff |
| **ADR-039: EMF as Canonical Metric Emission** | Both TS + Python use EMF; no PutMetricData API calls |

## Vision Alignment Verdict: ON-TRACK

Self-evolving multi-tenant platform delivered. All 7 evolution modules code-complete. 14 stacks live. Three-layer tenant isolation enforced in code. Self-evolution-pattern doc strengthens narrative.

No silent pivots. Strands ReAct canonical (ADR-003 unchanged). AgentCore Registry Phase 0-1 gated (ADR-034 partial, honest spike gate not scope creep).

Auto-skill + canary remain "design-intent pending Registry spike" — properly tracked in VISION.

## In-Scope for Next Wave (max 7)

1. **Fix `bunx cdk synth` → `npx cdk synth`** in self-evolution-pattern.md §3 (10min)
2. **Reconcile canary percentages** (30min)
3. **Update deployment-architecture.md to 14 stacks** (1h)
4. **Bump README.md to v0.6.2** + TS LOC / CLI count fixes (1h)
5. **Write ADR-035 + ADR-036** (2h each)
6. **Update ROADMAP.md "Current State"** (1h)
7. **Remove TODO comment + duplicate Discovery row** from system-architecture.md (20min)

## Already Clean

- `observability.md` — fully up-to-date after Wave-15d
- `canonical-data-model.md` — data model accurate, Wave-15 TTL reflected
- `CLAUDE.md` 3-layer tenant isolation — accurate after Wave-16 H3
- `agent-architecture.md`, `cli-lifecycle.md` — flagged canonical, updated 2026-04-17
- ADR-033, ADR-034 — both correctly reflect implementation
- `OPEN-PUNCH-LIST.md` — accurate, 15-item count current
- All six Wave-15a HIGH runbooks — filed + verified
