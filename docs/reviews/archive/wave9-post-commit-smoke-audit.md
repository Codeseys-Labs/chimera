# Wave-9 Post-Commit Smoke Audit

**Date:** 2026-04-20
**Commits audited:** 4 (from `d4bfb44` to `00958c5`)
**Verdict:** SHIP-READY. All claims verified against code.

## Per-commit verification

### `d4bfb44` feat(security): enforce tenant context across Python agent tool layer

**Claim vs reality — MATCH.**

| Claim | Verification | Result |
|-------|--------------|--------|
| "25 tool files refactored" | `grep -l 'require_tenant_id()' packages/agents/tools/*.py` | 25 files ✅ |
| Anti-pattern guard test exists | `tests/test_tenant_context.py:140` | `test_no_tool_imports_boto3_without_tenant_context` ✅ |
| ContextVar-backed primitives | `tools/tenant_context.py` | 131 LOC, exports verified ✅ |
| Word-boundary regex idempotency | `ensure_tenant_filter` implementation | `(?<![A-Za-z0-9_])tenantId\s*=\s*:__chimera_tid\b` ✅ |

Test counts: 12 (`test_tenant_context`) + 11 (`test_chimera_agent`) + 6 (`test_code_interpreter_tools`) = 29 new tests.

**Gaps:** None.

### `aac5989` feat: P0 hardening + AgentCore migration scaffolding (Phase 0/1)

**Claim vs reality — MATCH.**

| Claim | Verification | Result |
|-------|--------------|--------|
| `assertFlagsConsistent` boot check | `packages/core/src/registry/feature-flags.ts:60` | Exported ✅ |
| registry-writer fail-fast IIFE | `registry-writer.mjs:33` | `(function assertBootConfig() { ... })()` ✅ |
| registry-reader fail-fast IIFE | `registry-reader.mjs:57` | Same pattern ✅ |
| Gateway scaffolding (42 tests) | `packages/core/src/gateway/` | 11 TS files + 4 test files, ~1,130 LOC tests ✅ |
| Evaluations adapter | `packages/core/src/evaluations/` | 5 TS files + 2 test files, ~419 LOC tests ✅ |
| MIGRATION-registry.md (193 LOC) | File check | Present ✅ |
| MIGRATION-gateway.md (175 LOC) | File check | Present ✅ |
| All feature flags default OFF | Read feature-flags.ts files | Verified ✅ |

**Gaps:** None.

### `7c233f6` feat(infra+docs): CDK hardening, observability, Registry stack + doc refresh

**Claim vs reality — MATCH.**

| Claim | Verification | Result |
|-------|--------------|--------|
| Default 14 stacks | `npx cdk list` | 14 ✅ |
| `-c deployRegistry=true` → 15 stacks | `npx cdk list -c deployRegistry=true` | 15 ✅ |
| Zero `15 production` refs in docs | `grep -r "15 production" README.md CLAUDE.md docs/` | No matches ✅ |
| WAF → CloudWatch Logs wired | `security-stack.ts` CfnLoggingConfiguration | Present ✅ |
| AWS Config PITR managed rule | `observability-stack.ts` | Present ✅ |
| 3 Registry alarms | `observability-stack.ts addRegistryAlarms()` | Present ✅ |
| CLAUDE.md 3-layer paragraph | `grep '3-layer' CLAUDE.md` | Lines 134-137 ✅ |
| Python CI split | `.github/workflows/ci.yml` | Unit + integration markers ✅ |

**Gaps:** None.

### `00958c5` feat(core): MODEL_TIER_ALLOWLIST + enforceTierCeiling in model-router

**Claim vs reality — MATCH.**

| Claim | Verification | Result |
|-------|--------------|--------|
| `MODEL_TIER_ALLOWLIST` exported | `evolution/index.ts:29` | Verified ✅ |
| `enforceTierCeiling` called from `BedrockModel.buildInput` | `agent/bedrock-model.ts:251` | Verified ✅ |
| 10 new tests in model-router.test.ts | `describe('enforceTierCeiling')` block lines 187-278 | 10 cases present ✅ |
| Allowlist shape: Record<TenantTier, readonly string[]> | Type check | Verified ✅ |
| Fallback returns cheapest allowed | `cheapestAllowedForTier` impl | Verified ✅ |

**Gaps:** None.

## Dead / duplicate / unused exports

- `bun run typecheck` — clean (zero TS errors)
- All new exports (`MODEL_TIER_ALLOWLIST`, `assertFlagsConsistent`, registry/gateway/evaluations clients) are consumed in-package or in tests
- Evolution `index.ts` re-exports flow through to `packages/core/src/index.ts`
- No orphan exports detected

## Test-coverage matrix

| Commit | Suite | Count | Status |
|--------|-------|-------|--------|
| d4bfb44 | test_tenant_context.py | 12 | ✅ includes anti-pattern guard |
| d4bfb44 | test_chimera_agent.py | 11 | ✅ context lifecycle |
| d4bfb44 | test_code_interpreter_tools.py | 6 | ✅ tool-level binding |
| aac5989 | registry/*.test.ts | ~683 LOC | ✅ Phases 1-5 scaffolding |
| aac5989 | gateway/*.test.ts | ~1,130 LOC | ✅ 42+ tests |
| aac5989 | evaluations/*.test.ts | ~419 LOC | ✅ scoring normalization |
| 00958c5 | model-router.test.ts | 10 new | ✅ tier enforcement matrix |

**Gaps:** None. All claimed tests exist and exercise the stated behavior.

## Ship-ready verdict

**SHIP-READY.**

- ✅ All commit message claims match the changeset
- ✅ Load-bearing exports and integrations verified
- ✅ Tests cover stated functionality
- ✅ Feature flags default off (safe merge, safe deploy)
- ✅ Typecheck clean
- ✅ Docs consistent (stack count, ADR count, 3-layer tenant isolation all updated)
- ✅ Cold-start boot checks present in both `.mjs` helpers
- ✅ Anti-pattern guard test prevents tenant-context regressions

The only item between this state and production GA is **executing the first `cdk deploy` to staging** and closing the 3 CRITICAL runbooks (in-flight Wave 9). See `STATE-OF-THE-WORLD-2026-04-20.md`.
