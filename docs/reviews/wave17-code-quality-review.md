---
title: "Wave-17 Code Quality + Logic Review"
status: review
date: 2026-04-24
reviewer: wave17-code-quality
wave: 17
---

# Wave-17 Code Quality + Logic Review

## Severity Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 2     |
| HIGH     | 4     |
| MEDIUM   | 3     |
| LOW      | 2     |
| Total    | 11    |

## CRITICAL

### C1 — `background_task_tools.py` tenant isolation bypass via `os.environ`

**File:** `packages/agents/tools/background_task_tools.py:104,209`

Both `start_background_task` and `check_background_task` call `require_tenant_id()` as a guard, then IMMEDIATELY override with `os.environ.get('TENANT_ID', 'default-tenant')`. Exact pattern ADR-033 prohibits and Wave-16 H3 hardened against — `os.environ` is process-wide, not request-scoped. On shared ECS containers, all background tasks are written under the wrong DynamoDB partition key. Breaks multi-tenant isolation entirely for this tool pair.

**Fix:** Use the `tenant_id` from `require_tenant_id()` return value, not `os.environ`.

### C2 — `self-evolution-orchestrator.ts` `commit_failed` status race

**File:** `packages/core/src/evolution/self-evolution-orchestrator.ts:268-289`

Pipeline auto-triggers on EventBridge `referenceUpdated` from the commit (step 4) — BEFORE `startExecution()` is called at step 5. If step 5 fails, the orchestrator returns `status: 'error'` while the pipeline is already running. Audit record shows "failed" while infra deploys.

**Fix:** Either rely solely on commit-triggered pipeline (remove `startExecution`), or verify via `get_pipeline_state()` before recording `commit_failed`.

## HIGH

### H1 — `list_lambda_functions` pagination — silently truncates at 50

**File:** `packages/agents/tools/lambda_tools.py:40-41`

Single-page `list_functions()` returns max 50 with unconsumed `NextMarker`. Agent receives confidently-wrong count on accounts with >50 Lambdas.

**Fix:** Use paginator.

### H2 — `_format_tool_error` truncates error BEFORE logging

**File:** `packages/agents/gateway_proxy.py:81-105`

500-char truncation is right for LLM context but operator logs ALSO get the truncated form, making root-cause impossible for long stack traces.

**Fix:** `logger.error("...", exc)` full error THEN truncate for the LLM.

### H3 — `TierViolationCountAlarm` is non-functional — CloudWatch EMF dimension mismatch

**File:** `packages/core/src/evolution/model-router.ts:208-218` vs `infra/lib/observability-stack.ts:1219-1232`

Emitter writes dims `{tenant_id, tier, model_requested}`; alarm watches `Chimera/Agent::tier_violation_count` with NO dimension filter. EMF does not auto-create dimension-less rollups. Alarm has been `INSUFFICIENT_DATA` since Wave-16b.

**Fix:** Use a MathExpression with SEARCH aggregating across all dimension combinations.

### H4 — `_check_kill_switch` fails OPEN on `ParameterNotFound`

**File:** `packages/agents/tools/evolution_tools.py:553-567`

Missing SSM parameter → evolution ENABLED. Combined with Cedar + rate-limit both also failing open → fresh deploy has no safety gates active until all three SSM params provisioned.

**Fix:** Distinguish `ParameterNotFound` (fail CLOSED) from transient errors (fail open is OK).

## MEDIUM

### M1 — `logRetentionFor(INFINITE)` silently downgraded to 30d

**File:** `infra/constructs/log-retention.ts:98-101`

`Math.max(baseline, RetentionDays.INFINITE)` returns baseline because `INFINITE === -1`.

**Fix:** Add `if (options.prodMinimumDays === RetentionDays.INFINITE) return INFINITE`.

### M2 — `searchSkills` Scan Limit applied PRE-filter

**File:** `packages/core/src/skills/registry.ts:178-192`

`Limit: 20` caps scanned items, not returned items. On a 10k-skill table, search often returns 0 even with matches.

**Fix:** Paginate with `ExclusiveStartKey` until post-filter count reached, OR remove `Limit`.

### M3 — `monitorStackEvents` hangs forever on ValidationError

**File:** `packages/cli/src/commands/deploy.ts:338-381`

No retry-limit counter on the ValidationError branch. `chimera deploy --monitor` spins indefinitely before Pipeline stack exists.

**Fix:** Cap retries at ~60 iterations (10min) then break with warning.

## LOW

### L1 — `chimera sync` has no throttle retry/backoff

**File:** `packages/cli/src/utils/codecommit.ts:258-280`

Immediate throw on `ThrottlingException`. Caused the first-deploy rate-exceed incident.

**Fix:** 3-retry exponential backoff.

### L2 — `addToPolicy` pattern matches `addToRolePolicy`

**File:** `packages/agents/tools/evolution_tools.py:58-61` + `self-evolution-orchestrator.ts:128`

Literal substring match. Legitimate `addToRolePolicy` (least-privilege L2 pattern) is incorrectly rejected.

**Fix:** Python: `".addToPolicy("` (with trailing paren). TS regex: `/\baddToPolicy\b/i`.

## Already-confirmed-clean

- Tenant three-layer model (ContextVar clearing, ensure_tenant_filter idempotency)
- `_check_evolution_rate_limit` atomic ConditionExpression (Wave-15 H2)
- TenantTier type + all `Record<TenantTier>` uses exhaustive after Wave-14 C2
- GSI tenantId filter confirmed present in registry.ts (Wave-14 C1 / Wave-15d H1)
- logRetentionFor general case (non-INFINITE) correct
- EMF envelope shape correct in cost-tracker + model-router
- background_task_tools module-level boto3 clients with _BOTO_CONFIG
- gateway_config SSM cache at module level

## Out of scope (prior waves)

Wave-15 H2/H4, Wave-15d H1, Wave-16 H3/CORS/CI-perms — all confirmed present.

## v0.6.3 deploy blockers

- **C1** — live tenant isolation breach in background_task_tools. Must fix.
- **H4** — kill switch fails open on missing SSM. Must fix before production self-evolution gated on.
- **H3** — alarm non-functional, cost-leak alerting silently broken.
