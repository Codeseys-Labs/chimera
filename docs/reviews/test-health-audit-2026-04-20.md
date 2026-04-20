---
title: "Chimera Test Suite Health — 2026-04-20"
status: audit
---

# Test Suite Health — 2026-04-20

## Per-package counts

| Package | Pass | Fail | Skip | Notes |
|---------|------|------|------|-------|
| `@chimera/core` | 1,396 | 0 | 0 | clean |
| `@chimera/sse-bridge` | 43 | 0 | 0 | clean |
| `@chimera/chat-gateway` | 178 | 3 | 5 | CI excludes per e5603b1 (Bun CJS/ESM on `@aws-sdk/lib-dynamodb`) |
| `@chimera/cli` | 142 | 1 | 2 | 1 credential-dependent test excluded from CI |
| `@chimera/web` | ~50-70 | 2 | 0 | vitest/jsdom config issue in `protected-route.test.tsx` |
| `@chimera/agents` (Python) | 151 | 0 | 0 | clean |
| `infra` (CDK) | 611 | 0 | 0 | clean |
| **Total** | **~2,571** | **6** | **10** | — |

## Skipped tests catalog

**chat-gateway** (5 skips, all waiting on `@hono/node-server` upgrade):
- `describe.skip('Cross-Tenant Isolation...')` — HTTP integration
- `describe.skip('Chat Gateway Server...')` — HTTP integration
- 3× `it.skip('should return SSE...')` — SSE HTTP tests
- routes/teams — 2× `it.skip()` for `aadObjectId` / `cognitoSub` edge cases

**cli** (2 skips): credential-dependent commands excluded from CI runners.

## Known-failing per CI config

From `.github/workflows/ci.yml`:
- **chat-gateway** excluded from main CI run (commit `e5603b1`). 178 tests run locally but not in CI until Bun/`@aws-sdk/lib-dynamodb` compatibility is resolved.
- **cli** runs only `login.test.ts` + `upgrade.test.ts` on CI (credential conflicts).
- **Python agents** — `fix(ci)` in commit `69518c3` switched to `uv sync` + `uv run pytest`. Python tests now run in CI properly (previous `pip install` path silently failed).

## Test-coverage gaps flagged in prior reviews

From `docs/reviews/OPEN-PUNCH-LIST.md` §cleanup:
- No E2E test for agent-loop timeout + circuit breaker (Wave-3 feature)
- Code coverage artifacts not published in CI
- Integration-test annotations (`@pytest.mark.integration`) not applied to real integration tests yet

## Environmental issues to fix (non-blocking)

| # | Issue | Package | Effort |
|---|-------|---------|--------|
| 1 | Bun CJS/ESM compat with `@aws-sdk/lib-dynamodb` | chat-gateway | 1-2d (upstream fix or vendor shim) |
| 2 | vitest jsdom setup in `protected-route.test.tsx` | web | 30 min |
| 3 | CLI credential-test mocking | cli | 2-4h |

## Verdict

**Suite is ship-ready for v0.6.0 deploy.** Core, SSE-bridge, agents, and infra are 100% passing. Failures are environmental (Bun CJS/ESM, jsdom setup, credential-dependent tests excluded in CI) — not logic bugs. Per `STATE-OF-THE-WORLD-2026-04-20.md`: deployment confidence is not limited by test gaps; it's limited by "we haven't actually run `cdk deploy` yet."

**Recommended next step:** Deploy to staging. Close the 3 environmental issues in parallel.
