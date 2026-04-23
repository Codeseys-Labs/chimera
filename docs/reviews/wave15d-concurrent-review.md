---
title: "Wave-15d Concurrent Review"
status: audit
date: 2026-04-23
auditor: wave15d-concurrent-reviewer
---

# Wave-15d Concurrent Review

## Severity Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1     |
| HIGH     | 2     |
| MEDIUM   | 2     |
| LOW      | 1     |
| **Total**| **6** |

---

## CRITICAL

### C1 — `gateway_config.py` `TENANT_TIER_ACCESS` missing `enterprise`/`dedicated` — enterprise tenants get Tier 1 tools only

- **File:** `packages/agents/gateway_config.py:32–36`
- **What:** `TENANT_TIER_ACCESS` maps `{'basic': 1, 'advanced': 2, 'premium': 3}`. Keys `enterprise` and `dedicated` absent. `_load_tools_for_tier` and `_discover_from_gateway` both call `TENANT_TIER_ACCESS.get(tier, TENANT_TIER_ACCESS["basic"])`, so enterprise tenants fall back to `max_tier = 1`. Silently denies all Tier 2 (RDS, Redshift, Athena, Glue, OpenSearch, swarm) and Tier 3 (Step Functions, Bedrock, SageMaker, CodeBuild, CodeCommit, CodePipeline, Evolution) tools.
- **Why critical:** The TypeScript `TENANT_TIER_ACCESS` + `select_model_for_tier` + `get_memory_config_for_tier` were fixed in Wave-15 to include `enterprise`/`dedicated`. `gateway_config.py` was NOT updated. Wave-15 C1 routed enterprise JWT claims correctly through TypeScript middleware; this Python tool-loading path is the same bug in a different file. Enterprise tenant receives Tier 1 tools — no Evolution, no self-evolution, no swarm orchestration.
- **Fix:** Add `'enterprise': 3, 'dedicated': 3` to `TENANT_TIER_ACCESS`. The `premium` → 3 mapping already exists and should remain as the legacy alias. Two-line fix.

---

## HIGH

### H1 — `SkillRegistry` GSI query methods filter on `tenantId` attribute that does not exist — all three return empty

- **File:** `packages/core/src/skills/registry.ts:214, 249, 277`
- **What:** `listByCategory`, `listByTrustLevel`, `listByAuthor` all use `FilterExpression: 'tenantId = :tenantId'`. The canonical `Skill` interface in `packages/shared/src/types/skill.ts:175–211` has no `tenantId` field. `register_capability` writes `registered_by: tenant_id` but not `tenantId`. Platform-loaded skills (via skill pipeline) don't include `tenantId`. DynamoDB `FilterExpression` silently drops items where the referenced attribute is absent.
- **Why high:** Skill marketplace is completely non-functional via GSI query paths. `listByCategory` (skill browsing), `listByTrustLevel` (trust-filtered discovery), `listByAuthor` (self-evolution audit trail) all return empty lists. Schema alignment regression — Wave-15 H1 fixed writers, but the TS query layer references a non-existent field.
- **Fix option A (recommended):** Add `tenantId: string` to the `Skill` interface; populate in `register_capability` and the skill pipeline writer. Platform skills use sentinel `tenantId: '__platform__'`. Update query methods to accept optional `tenantId` and apply filter only when provided.
- **Fix option B (minimal):** Remove the `FilterExpression` from the three methods and rely on the GSI partition key for scoping, accepting platform skills are cross-tenant visible (shared marketplace model).

### H2 — Strands `agent.stream()` has no AbortSignal / cancel path for Bedrock throttle scenarios

- **File:** `packages/agents/chimera_agent.py:88–91`
- **What:** Agent loop `async for chunk in agent.stream(context.input_text): yield chunk`. No cancellation signal from AgentCore Runtime context into Strands. When Bedrock throttles for 30+ seconds, Strands retry backoff holds the generator open, pinning the worker slot.
- **Why high:** At 10-tenant scale, a Bedrock throttle burst stalls multiple workers simultaneously. AgentCore has a max concurrent invocation budget; stalled workers block new requests. `max_iterations=20` ceiling doesn't help — the loop simply waits.
- **Fix:** Thread cancellation signal from AgentCore context into Strands stream. Minimum: wrap `agent.stream()` in `asyncio.wait_for(...)` with total session timeout (5min matching AgentCore timeout) so stalled generators are forcibly terminated. If Strands exposes a `cancel_token`, wire to an `asyncio.Event` fired on AgentCore's `on_cancel` hook.

---

## MEDIUM

### M1 — `GatewayToolDiscovery` instantiated per invocation — internal cache always cold

- **File:** `packages/agents/chimera_agent.py:222`
- **What:** `load_tenant_tools` calls `gateway = GatewayToolDiscovery()` on every agent invocation. `GatewayToolDiscovery._cache` is an instance-level dict. SSM parameter lookups (`_gateway_arns_cache`) are module-level and survive, but the tool-loading result cache is a no-op.
- **Fix:** Hoist `GatewayToolDiscovery` to module level (one singleton per process), or move `_cache` to a module-level dict keyed by `(tier, allow_list, deny_list)`.

### M2 — `BackgroundTaskManager.tasks` is in-memory — state lost on ECS restart

- **File:** `packages/core/src/orchestration/background-task.ts:104–106, 128`
- **What:** `this.tasks = new Map()` stores task state in process memory. `getTask(taskId)` returns `undefined` after any ECS restart, scale-in, or deployment.
- **Fix:** Persist task state to DynamoDB (`chimera-sessions` table with `PK=TENANT#{id}#BGTASK#{taskId}` pattern, already used by `background_task_tools.py`). Add DDB update alongside in-memory update in `updateTaskStatus`.

---

## LOW

### L1 — DAX cluster has no cache-hit-rate monitoring

- **File:** `infra/lib/data-stack.ts:267–279`, `packages/core/src/billing/cost-tracker.ts:121`
- **What:** DAX cluster has no CloudWatch alarm on `CacheHits`/`CacheMisses`. With $1,200-1,500/mo cost estimate, a misconfigured app that never hits DAX would waste the entire budget silently. `CostTracker` bypasses DAX (correct — high-cardinality writes) but DAX is effectively single-purpose (sessions table reads).
- **Fix (L1a):** Add CloudWatch alarm on `CacheHits < 100 / 5min` in prod. **(L1b):** Document in `data-stack.ts` that `costTrackingTable` is intentionally excluded from DAX read path.

---

## Already-confirmed clean (Wave-15 fixes verified)

- Wave-15 C1 (tenant.ts middleware): `validTiers` includes all 5 tiers — clean
- Wave-15 H1 (register_capability GSI attrs): evolution_tools.py writes author/category/trustLevel/skillName/updatedAt — clean
- Wave-15 H2 (atomic rate limit): single UpdateItem with ConditionExpression — TOCTOU eliminated
- Wave-15 H3 (MFA required in prod): isProd gate on cognito.Mfa.REQUIRED — clean
- Wave-15 H4 (StreamTee ring buffer): maxBufferSize=1000 with splice semantics — bounded
- Wave-15 M1/M2 (refresh tokens + WAF limit): 7-day web / 1-day CLI with revocation; 10k WAF — clean
- Wave-15 M3 (hello_world gating): `__production_excluded__` sentinel + gateway_config filter — clean
- Wave-15 L1 (boto3 timeout): load_tenant_config uses _BOTO_CONFIG — clean
- JWT claim injection: aws-jwt-verify + Cognito-signed, custom:tenant_tier is Cognito-managed — clean
- Cross-tenant skill leak: intent correct (tenantId filter uses CALLER's tenantId), but broken in practice via H1 — see H1 fix
- Orchestration skeleton guards: callers now fail loudly rather than producing garbage state — clean
- SSE back-pressure (chat.ts): AbortSignal wired, 5s drain-timeout, 15s keepalive — clean
- DAX failover / cost-tracker: bypasses DAX (correct for high-cardinality writes) — clean

---

## Out of scope (tracked elsewhere)

- Observability metric emitters `tier_violation_count` (verify wiring)
- AgentCore Registry multi-tenancy spike — spike-blocked per ADR-034
- `strands-agents.ts` shim removal — pending npm publication
- Global `strict: true` + `any` quarantine (793 sites) — separate PR
- DAX SG narrowing — blocked by circular dependency
- Wave-15c cleanup items confirmed landed

---

## Findings that should BLOCK the next production deploy

1. **C1** — Enterprise tenants receive Tier 1 tools via the Python AgentCore path. Two-line fix to `gateway_config.py`.
2. **H1** — `SkillRegistry` listByCategory/listByTrustLevel/listByAuthor return empty arrays for all queries. Requires schema decision (Option A vs B).
