---
title: "Wave 14 System Audit — code, architecture, data, security, ops"
status: audit
date: 2026-04-22
auditor: wave14-system-auditor
---

# Wave 14 System Audit

## Summary

The system is in a good structural state post-first-deploy (11/14 stacks up, Config fix landed). Two findings require immediate action before enterprise tenants onboard: a skills GSI name mismatch that breaks marketplace browsing entirely, and a `TenantTier` type divergence that would give enterprise tenants 90-day audit retention instead of the 7-year compliance requirement. A third finding (missing `chimera-cost-tracking` TTL) silently accumulates data indefinitely. The open punch list (`docs/reviews/OPEN-PUNCH-LIST.md`) already captures most of these; this audit adds two new CRITICAL gaps.

---

## CRITICAL findings (fix before broader rollout)

### C1: Skills GSI name mismatch — marketplace browsing throws `ValidationException`

- **File:** `packages/core/src/skills/registry.ts:211,243,271` (queries `'GSI-1'`, `'GSI-2'`, `'GSI-3'`)
- **vs:** `infra/lib/data-stack.ts:139,145,151` (creates `'GSI1-author'`, `'GSI2-category'`, `'GSI3-trust'`)
- **Why critical:** Every call to `listByAuthor`, `listByCategory`, `listByTrustLevel` throws `ValidationException: The table does not have the specified index: GSI-2`. Skill marketplace browsing is entirely broken at runtime.
- **Fix:** In `registry.ts`, change `'GSI-1'` → `'GSI1-author'`, `'GSI-2'` → `'GSI2-category'`, `'GSI-3'` → `'GSI3-trust'`. Secondary bug in same file: `KeyConditionExpression` uses `'PK = :pk'` on these cross-tenant GSIs; partition key should be `category`, `trustLevel`, or `author` respectively (not `PK`).

### C2: `TenantTier` enum diverges from canonical data model — enterprise tenants get 90-day audit retention instead of 7 years

- **File:** `packages/shared/src/types/tenant.ts:10`
- **Code:** `type TenantTier = 'basic' | 'advanced' | 'premium'`
- **Canonical model:** `basic | advanced | enterprise | dedicated` (`docs/architecture/canonical-data-model.md:113`)
- **Impact:** `audit-trail.ts:36-40` `AUDIT_TTL_DAYS_BY_TIER` has keys `basic/advanced/premium`. An `enterprise` tenant is not a key; the fallback at line 54 (`if (typeof days !== 'number')`) applies `basic` = 90 days. Enterprise GDPR/SOC2 compliance requires 7 years. This silently violates the compliance contract at every `logAction` call for enterprise tenants.
- **Fix:** Add `enterprise: 365 * 7` to `AUDIT_TTL_DAYS_BY_TIER`. Decide whether `premium` is a synonym for `enterprise` or a separate tier, and update `TenantTier` accordingly.

---

## HIGH findings

### H1: `chimera-cost-tracking` table has no `ttlAttribute` — 2-year retention never enforced

- **File:** `infra/lib/data-stack.ts:180-184`
- **Issue:** `CostTrackingTable` is created without `ttlAttribute`. Canonical data model states `ttl` attribute carries 2-year retention. DynamoDB ignores `ttl` fields unless TTL is enabled on the table. Items accumulate indefinitely.
- **Fix:** Add `ttlAttribute: 'ttl'` to the `ChimeraTable` constructor call at line 180.

### H2: Unresolved merge conflict marker in canonical data model

- **File:** `docs/architecture/canonical-data-model.md:857-861`
- **Issue:** Live `<<<<<<<`/`=======`/`>>>>>>>` conflict markers. Document is `status: canonical` and declared `SINGLE SOURCE OF TRUTH`. Conflict is between `ClawCore-Architecture-Review-Platform-IaC.md` (old name) and `Chimera-Architecture-Review-Platform-IaC.md` (correct). Any agent reading this file sees conflicting content.
- **Fix:** Resolve to `Chimera-Architecture-Review-Platform-IaC.md`, remove conflict markers, commit.

### H3: ADR-034 status conflict — frontmatter `accepted` vs body `Proposed`

- **File:** `docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md:2` vs `:12`
- **Frontmatter:** `status: accepted (partial — Phase 0-1 only)`
- **Body:** `**Proposed** (2026-04-17)`
- **Impact:** ADRs are governance artifacts. An ambiguous status causes agents to disagree on whether Registry adoption is decided. Fix: update body to `**Accepted (partial — Phase 0-1 only)**`.

### H4: `cloudwatch:PutAnomalyDetector` on `resources: ['*']` — narrowable

- **File:** `infra/lib/skill-pipeline-stack.ts:180-183`
- **Issue:** Performance-testing Lambda granted `cloudwatch:PutAnomalyDetector` with `resources: ['*']`. Unlike `PutMetricData`, anomaly detectors can be ARN-scoped. A compromised pipeline Lambda could create detectors on arbitrary account metrics.
- **Fix:** Scope to `arn:aws:cloudwatch:${stack.region}:${stack.account}:alarm:chimera-*` or remove `PutAnomalyDetector` if unused.

### H5: Three critical operational runbooks are stubs

- **Files:** `docs/runbooks/ddb-pitr-restore.md`, `docs/runbooks/security-incident-tenant-breach.md`, `docs/runbooks/cdk-deploy-failure-recovery.md`
- **Issue:** Per `docs/reviews/OPEN-PUNCH-LIST.md:107-113`, these are CRITICAL stubs with no actionable procedure. Blocks GA readiness.

---

## MEDIUM findings

### M1: `groupchat.ts` and `orchestrator.ts` hardcode placeholder account ID `123456789012` in production ARNs

- **Files:** `packages/core/src/orchestration/groupchat.ts:165,219,220,257`; `packages/core/src/orchestration/orchestrator.ts:558`
- **Issue:** SNS, SQS, and AgentCore runtime ARNs are constructed with literal `123456789012`. These are reachable code paths (not test fixtures). Calls to `GroupChat.createGroup()` or `Orchestrator.createAgentRuntime()` emit invalid ARNs silently.
- **Fix:** Wrap unimplemented public methods with `throw new Error('not implemented')` until real implementations land.

### M2: Large orchestration skeleton code is reachable from public `packages/core` API

- **Files:** `groupchat.ts` (7 TODOs), `workflow.ts` (3 stubs), `cron-scheduler.ts` (5 stubs), `background-task.ts` (2 stubs)
- **Issue:** All exported from `packages/core/src/index.ts`. Silently return garbage. Fix: throw until real.

### M3: No post-deploy health check command

- **Issue:** `chimera doctor` is pre-flight only. `chimera status` checks CloudFormation only. Neither verifies runtime health: ECS service stability, DDB read/write, ALB `/health` response.
- **Fix:** Add `chimera health` command.

### M4: `chimera-skills` GSI partition key design inconsistency (extends C1)

- **Issue:** CDK defines GSIs with partition keys `author`, `category`, `trustLevel` (attribute names). Application queries use `KeyConditionExpression: 'PK = :pk'` with prefixes `'AUTHOR#xyz'`. The key schema doesn't match.

---

## LOW findings (backlog)

- Evolution stack adds a 7th DynamoDB table (`chimera-evolution-state`) not in the canonical 6-table design.
- `strands-agents.ts` + `.d.ts` shims marked "TODO remove once published". Verify published and remove.
- `hello_world.py:15` has `@tool` without `require_tenant_id()` — intentional but confirm it's gated from production.
- ADR-034 GA status of AgentCore Registry is self-described as "inferred, not confirmed." Verify before Phase 2.
- `cedar-authorization.ts` condition evaluator handles only `==`/`!=`. Not real Cedar; must not be mistaken for full Cedar enforcement.

---

## Simplification opportunities

1. **Delete `packages/core/src/orchestration/groupchat.ts`** — 435 LOC, 7 TODO stubs, placeholder ARNs.
2. **Consolidate skill registry abstractions** — post ADR-034 spike, delete `skills/registry.ts` (300+ LOC).
3. **Remove `packages/core/src/aws-tools/strands-agents.ts` shim** — self-described temporary.
4. **Collapse `workflow.ts` stubs** — 3 of 4 methods silently return `undefined`.
5. **`skill-pipeline-stack.ts` IAM consolidation** — 5 separate `addToRolePolicy` calls could be one statement.

---

## Next-wave recommendations (priority order)

1. **Fix skills GSI names + query expressions** (C1) — unblocks marketplace. ~2h
2. **Fix `TenantTier` enum** (C2) — add `enterprise` to shared types and audit map. ~2h
3. **Enable cost-tracking TTL** (H1) — one-line CDK fix. 15min
4. **Resolve canonical data model merge conflict** (H2) + ADR-034 status (H3). 10min total
5. **Write three CRITICAL runbooks** (H5) before first external tenant. ~1 day
6. **Guard skeleton orchestration code** with `throw new Error('not implemented')` (M1, M2). ~1h
7. **Add `chimera health` post-deploy command** (M3). ~1 day
8. **Registry spike** (ADR-034 Phase 2 precondition) — resolves dual-registry duplication. ~1 week
