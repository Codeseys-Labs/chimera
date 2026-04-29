---
title: Wave-33 Isolation Polish Concurrent Review
reviewer: reviewer
date: 2026-04-29 (updated)
scope: Tenant-filter gaps, CDK warnings, CLI patterns, Phase 2 readiness, code smells
companion_audits:
  - docs/reviews/memory-isolation-audit-2026-04-29.md
  - docs/reviews/multi-tenant-isolation-live-probes-2026-04-28.md
---

# Wave-33 Concurrent Review Report

**Updated 2026-04-29:** Cross-referenced companion audits (memory isolation + live probes) and reviewed Phase 1 implementation status for 59ee, 606c, 8681.

### Companion Audit Cross-Reference

**Memory Isolation Audit (2026-04-29):** Confirms semantic search tenant filter is CRITICAL. Also flags:
- AgentCore Memory TS client is stub (not-yet-implemented) — Phase 2 blocker for LTM tenant namespace
- Session PK correctly tenant-scoped; no per-user privacy yet (by design)

**Live Probes (2026-04-28):** All 6 probes passed; confirms PK isolation holds, but identifies two low-priority observability smells:
1. Empty messages endpoint returns `200` instead of `404` for non-existent foreign sessions
2. Body-level `tenantId` silently ignored instead of `400` on conflict

**Finding:** All three reviews (this + memory audit + live probes) converge on same CRITICAL issue (semantic search) + same two LOW polish items (404 / 400).

---

## CRITICAL Issues

### 1. GSI Query Missing Tenant Filter — Audit Trail Resource Lookup
**File:** `packages/core/src/activity/audit-trail.ts:626–662`  
**Problem:** `queryByResource()` queries `resource-activity-index` GSI on `resourceArn` alone without `FilterExpression='tenantId = :tid'`. Method accepts `tenantId` parameter but never includes it in the DynamoDB query—allows tenant A to read audit logs for tenant B's resources via cross-tenant resourceArn enumeration.  
**Fix:** Add `FilterExpression: 'tenantId = :tenantId'` and expression value to KeyConditionExpression.  
**Blast Radius:** HIGH — breaks multi-tenant audit log isolation; security boundary violation on resource-scoped activity queries.

### 2. Unused Query Parameter in Audit Trail
**File:** `packages/core/src/activity/audit-trail.ts:626`  
**Problem:** `queryByResource(params: QueryByResourceParams)` receives params but tenantId is NOT extracted or validated from the context (method signature has no tenantId param).  
**Fix:** Add `tenantId: string` parameter or require it via context injection. Verify it's always present before querying.  
**Blast Radius:** MEDIUM — depends on caller context; fix prevents silent audit log leaks.

---

## HIGH Issues

### 3. CLI Commands Inconsistent —json Flag Coverage
**File:** `packages/cli/src/commands/{diff,trigger,completion}.ts`  
**Problem:** 20 commands have `--json` flag (diff, trigger, completion are missing). `trigger` and `diff` return structured data (CLI-1 tracking trigger output; diff returns FileDiff array) but lack parseable output formats.  
**Fix:** Add `--json` flag to `trigger`, `diff`, and `completion` commands for machine-consumability.  
**Blast Radius:** MED — affects automation scripts; blocking CLI-1 (logs status parsing) if pattern is inconsistent.

### 4. CDK Deprecation: DynamoDB TableGrantsProps
**File:** Warnings from `infra/lib/*.ts` (6+ TableGrants instantiations)  
**Problem:** `encryptedResource` and `policyResource` are deprecated in aws-cdk-lib. Currently harmless warnings but CDK v3 will remove these props.  
**Fix:** Migrate to new IGrantable/IResourceWithPolicy pattern or suppress with explicit AWS recommendation.  
**Blast Radius:** LOW-NOW / HIGH-LATER — code will break on CDK major upgrade.

### 5. CDK Deprecation: Lambda logRetention
**File:** Warnings from multiple Lambda functions in infra stacks  
**Problem:** `FunctionOptions#logRetention` deprecated (use `LogRetention` construct instead).  
**Fix:** Replace inline `logRetention: duration` with explicit `new LogRetention()` or use new property name.  
**Blast Radius:** LOW-NOW / HIGH-LATER — safe to defer but flag for next CDK bump cycle.

---

## MEDIUM Issues

### 6. Step Functions Definition Property Deprecated
**File:** `infra/lib/orchestration-stack.ts` (and related)  
**Problem:** `StateMachineProps#definition` is deprecated (use `definitionBody` instead).  
**Fix:** Migrate to `definitionBody: sfn.DefinitionBody.fromChainable()`.  
**Blast Radius:** MED — cosmetic for now but affects Step Functions state machine portability.

### 7. Unused Type Exports in Evolution & Swarm Modules
**File:** `packages/core/src/evolution/types.ts`, `packages/core/src/swarm/types.ts`  
**Problem:** Lint warns on unused types: `WellArchitectedPillar`, `WellArchitectedEvaluation`, `ConfidenceFactors` in evolution module never imported elsewhere.  
**Fix:** Remove unused type exports or document why they're exported (public API). Current state bloats type-checking surface.  
**Blast Radius:** LOW — type-only, no runtime impact; just dead surface area.

### 8. Task Decomposer & Skill Registry TODOs Indicate Incomplete MVP
**File:** `packages/core/src/swarm/task-decomposer.ts:lines 68, 75, 85` and `packages/core/src/tools/skill-registry.ts:lines 201, 207`  
**Problem:** Multiple "TODO: In production use LLM" and "TODO: Implement persistence" markers indicate fallback/placeholder logic still wired in.  
**Fix:** Document which TODOs are acceptable for Phase 1 (intended fallback) vs. which are pre-Phase-2 blockers. Consider feature flag if not yet ready.  
**Blast Radius:** MED — Phase 2 planning depends on which are actually blocking.

---

## INFORMATIONAL Issues

### 9. CloudWatch Alarm SEARCH Limitation Documented
**File:** `infra/lib/observability-stack.ts:220–230` (comments only)  
**Problem:** Design choice documented: `SUM(SEARCH(...))` invalid in alarm metrics (CloudWatch limitation), SEARCH only works in dashboard widgets.  
**Fix:** None needed — already documented as known limitation. Ensure future wave developers read comments before attempting to add SEARCH to alarm expressions.  
**Blast Radius:** INFO — correctly mitigated in Wave-23; educational for future contributors.

### 10. Strands Agents SDK Migration Note
**File:** `packages/core/src/aws-tools/strands-agents.ts` (and `.d.ts` shim)  
**Problem:** TODO marker notes migration needed when `@strands-agents/sdk` hits 1.0.0 GA. Currently using custom `.d.ts` shim.  
**Fix:** When SDK is GA'd, remove `.d.ts` file and update imports. Not urgent (SDK pre-GA).  
**Blast Radius:** INFO — planned migration, low urgency.

---

## Phase 2 Readiness Scan

### Implementation Status (from Wave-29 commit aa691598)

| Issue | Scope | Phase 1 Code | Phase 2 Next Steps |
|-------|-------|--------------|-------------------|
| **chimera-59ee** (Webhook Delivery) | Stripe-style HMAC signing + SSRF guard | **COMPLETE** — `@chimera/webhook-sender` package with 13 unit tests | Infrastructure: EventBridge rule → SQS → Lambda integration into orchestration + onboarding flows |
| **chimera-606c** (DGM Evolution) | Composite fitness + Pareto dominance | **COMPLETE** — `CompositeFitness`, `paretoDominates`, cold-start fallback, lineage edges; 5 unit tests | Admin API: lineage query routes + fitness trajectory dashboard + integration with A/B test harness |
| **chimera-8681** (Chimera Forge) | Meta-Harness outer loop | **COMPLETE** — `ChimeraHarness` interface, baseline harness, 3 bench tasks, runner; 10 unit tests | Evaluation: hook forge runner into PromptEvolutionPipeline, wire environment bootstrap snapshot into each task |

### Dependency-Ready vs Phase 2 Blocked

**Immediately dependency-ready (no Phase 1 blockers):**
1. ✅ `chimera-59ee` webhook sender logic can integrate into any trigger (skills, alerts, user events)
2. ✅ `chimera-606c` fitness computation + Pareto winner can wire into existing A/B test harness now
3. ✅ `chimera-8681` harness runner can execute offline bench tasks against any Lambda harness

**Phase 2 blockers (requires Phase 1 completion):**
1. 🔴 **OpenSearch semantic search tenant filter** — blocks `chimera-59ee` webhook delivery for skill-discovery events (if enableSemanticSearch=true, event will contain leaked tenant data)
2. 🔴 **AgentCore Memory TS client implementation** — blocks `chimera-606c` from using LTM for prompt lineage scoring (currently blocks only Python agent, not TS yet)
3. 🟡 **Skill installer SKILL.md parser** — Phase 2 nice-to-have for DGM (auto-skill generation needs tool signature extraction; currently TODO)

### Key Assumption Verified

All three Phase 1 implementations **assume Wave-33 isolation polish completes** (semantic filter + audit trail filter). If a Phase 2 builder pulls code before SEC-1 / SEC-2 land, they'll inherit the leaks. **Action:** Merge SEC-1 and SEC-2 fixes before any Phase 2 feature branch spawns.

---

## Summary by Actionability

### Immediately Actionable (Before Merge)
1. **Add tenantId filter to `audit-trail.ts` queryByResource()** — Security boundary fix, simple 2-line change
2. **Suppress or update deprecated CDK props** — Non-blocking but prevents future build breaks

### Needs Design Clarification (Phase Planning)
3. **CLI --json flags on {diff, trigger, completion}** — Affects CLI-1 status parsing; check with CLI team scope
4. **Task decomposer TODOs** — Clarify if fallback behavior is intentional or pre-Phase-2 blocker

### Nice-to-Haves (Tech Debt)
5. **Remove unused type exports** — Lint cleanup, low priority
6. **Migrate StepFunctions definition property** — Cosmetic for now, flag for next CDK cycle

### Already Mitigated
7. **CloudWatch SEARCH limitation** — Correctly documented and worked around

---

**Report generated:** 2026-04-28  
**Updated:** 2026-04-29 with companion audit cross-reference and Phase 2 readiness analysis  
**Concurrent with:** Tasks #1 (CLI logs), #3 (body-tenantId), #4 (foreign session), #5 (semantic filter), #6 (audit-trail GSI)

### Recommendations Priority Order

1. **Merge SEC-1 (semantic filter)** — blocks Phase 2 webhook events from leaking tenant data
2. **Merge SEC-2 (audit-trail GSI)** — blocks cross-tenant resource audit log reads
3. **Merge POLISH-1 (400 on tenantId mismatch)** — hardens body-level validation
4. **Merge POLISH-2 (404 on empty messages)** — fixes observability smell
5. **Queue Phase 2 work** — all three issue holders (59ee/606c/8681) are ready; start Phase 2 builders only after all four polish items land
