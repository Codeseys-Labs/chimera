# Wave-7 Safety Audit — Registry Phase 0/1

**Date:** 2026-04-18
**Scope:** Audit the "nothing changes with flags off" claim for Wave 6 Registry scaffolding.

## TL;DR

Flag-off claim **holds** for side effects (no SDK imports, no metrics, no logs, no IAM use). But there is **one legitimate blocker**: `assertFlagsConsistent()` is exported and tested but **never called at Lambda bootstrap**, so a misconfigured env (e.g., `REGISTRY_ENABLED=true` without `REGISTRY_ID`) silently no-ops instead of failing loud. That violates the documented fail-closed contract.

## Per-category verdicts

| # | Category | Status |
|---|----------|--------|
| 1 | Flag-off invariant | ✅ PASS |
| 2 | Default-flip risk | 🚩 **BLOCKER** — see below |
| 3 | Cross-tenant leakage | ✅ PASS |
| 4 | Dual-write ordering | ✅ PASS |
| 5 | Response-shape drift | ✅ PASS |
| 6 | Metric namespace hygiene | ✅ PASS |
| 7 | IAM surface drift | ✅ PASS |
| 8 | Test coverage invariants | ✅ PASS |
| 9 | Dynamic-import exception swallow | ✅ PASS |
| 10 | Export collision | ✅ PASS |

## Blocker detail (#2)

**File:** `packages/core/src/registry/feature-flags.ts:71-75`

`assertFlagsConsistent()` correctly throws when `REGISTRY_ENABLED=true && !REGISTRY_ID`. But grep confirms **zero runtime callers** — only tests call it. Lambda bootstrap never invokes it.

Actual runtime behavior in this failure mode (at `infra/lambdas/skill-pipeline/skill-deployment/registry-writer.mjs:119-130`):
```js
const registryId = getRegistryId();
if (!registryId) {
  console.warn('[registry-writer] REGISTRY_ENABLED=true but REGISTRY_ID unset — skipping');
  return { skipped: true, reason: 'REGISTRY_ID unset' };
}
```

The Lambda runs, logs a warning, and silently no-ops. Operator sees a deployed Lambda with the env var "turned on" but no actual Registry writes.

### Fix (~5 min)

Add at top of each handler module — not per-invocation, once at cold start:

```js
// skill-deployment/index.mjs (top level)
import { assertFlagsConsistent, loadRegistryFlags } from '../../shared/registry-flags.mjs'; // or whatever resolution works
assertFlagsConsistent(loadRegistryFlags());
```

For `.mjs` Lambdas without a direct package path to `packages/core/src/registry/feature-flags.ts`, inline the check in the `registry-writer.mjs` / `registry-reader.mjs` helpers at module load time:

```js
// At top of registry-writer.mjs
(function assertBootConfig() {
  const enabled = isRegistryEnabled();
  if (enabled && !getRegistryId()) {
    throw new Error('[registry-writer] REGISTRY_ENABLED=true requires REGISTRY_ID. Failing fast.');
  }
})();
```

This runs at cold start. If misconfigured, the Lambda fails to boot → operator sees the error in CloudWatch within seconds. No silent drift.

## Non-blocking follow-ups

1. Add an infra integration test that asserts flag-off skill-deployment output is byte-identical to the control baseline.
2. Add a CloudWatch Logs Insights snippet to the MIGRATION-registry.md runbook: `fields @timestamp, @message | filter @message like /REGISTRY_ID unset/ | stats count() by bin(5m)` — catches silent-skip drift.
3. Confirm when `@aws-sdk/client-bedrock-agentcore-control` + `@aws-sdk/client-bedrock-agentcore` get added to `package.json` (currently dynamic-import-on-demand).
4. Phase 2 spike must resolve multi-tenancy model before prod enablement (blocked by ADR-034 open question #1).

## Verdict

**One-line fix blocks safe merge.** Add the fail-fast check in both `.mjs` helpers at module load. Everything else in Wave 6 is cleaner than claimed.
