---
title: "Wave-18 Concurrent Review"
status: audit
date: 2026-04-25
auditor: wave18-concurrent-reviewer
scope: Areas not covered by Waves 14-17 — test quality, dependency ranges, monorepo package coherence, CI coverage, frontend code, observability runbook-to-alarm mapping
---

# Wave-18 Concurrent Review

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 6 |
| MEDIUM   | 0 |
| LOW      | 0 |
| **Total**| **6** |

## HIGH findings

### I1 — `chat-gateway` tests permanently excluded from CI (no tracking)

- **File:** `.github/workflows/ci.yml:46-64`
- **Issue:** `bun test` enumerates test dirs and omits `packages/chat-gateway/`. Comment cites "Bun CJS/ESM compat with `@aws-sdk/lib-dynamodb`" as justification. 178 tests "verified locally" never run in CI.
- **Violates:** CLAUDE.md Quality Gates: "`bun test` — all tests must pass."
- **Fix:** File Seeds issue to fix `@aws-sdk/lib-dynamodb` CJS/ESM. Add comment referencing the blocking issue ID so the exclusion has a visible exit condition.

### I2 — `AdminPage` Revoke button has no onClick — destructive visual, no action

- **File:** `packages/web/src/pages/admin.tsx:208`
- **Issue:** `<Button variant="destructive" size="sm">Revoke</Button>` renders red-urgency with zero handler. Users click and get no feedback, no API call. Blocks legitimate key rotation from the UI.
- **Fix:** Wire `apiDelete` to `/tenants/${tenantId}/api-keys/${k.id}` behind confirmation dialog; invalidate `['api-keys', tenantId]` query. At minimum add `disabled` + tooltip.

### I3 — Cedar authorization test asserts `reasons.length > 0` instead of policy ID

- **File:** `packages/core/src/tenant/__tests__/cedar-authorization.test.ts:98`
- **Issue:** Test only verifies *some* reason was returned. If `cross-tenant-isolation` accidentally didn't fire and a different permit policy matched, test still passes. Other permission tests in the same file correctly assert on policy ID.
- **Violates:** CLAUDE.md Security: "Cedar Authorization Tests: Assert on specific policy reasons, not just allow/deny."
- **Fix:** `expect(result.reasons).toContain('user-read-own-sessions');`

### I4 — Three alarms have no runbook entries

- **Files:** `observability-stack.ts:1167-1178, 1231-1243, 662-675` vs `docs/runbooks/alarm-runbooks.md:14-29`
- **Missing alarms:** `chimera-{env}-tool-success-rate-low`, `chimera-{env}-tier-violation-count-high`, `chimera-{env}-dynamodb-pitr-disabled` (latter only with `enableConfigRules=true`).
- **Impact:** Both active alarms route to `highAlarmTopic`; on-call engineers have no documented triage path.
- **Fix:** Add runbook sections to `alarm-runbooks.md`. Each needs: name pattern, trigger condition, impact, investigation commands, resolution.

### I5 — React major version split (CLI 18 / web 19) — no inline comment explaining

- **Files:** `packages/cli/package.json:52` (`react ^18.3.0`), `packages/web/package.json:35` (`react ^19.0.0`)
- **Issue:** CLI uses `ink` which requires React 18; not upgradeable until ink v6. Future devs may "fix" the split and break the CLI.
- **Fix:** Add inline comment in `packages/cli/package.json`: `"react": "^18.3.0"  // ink@5 requires React 18; not upgradeable to 19 until ink v6 ships`.

### I6 — `useCurrentPath` hook doesn't intercept `pushState` — programmatic nav breaks silently

- **File:** `packages/web/src/App.tsx:33-41`
- **Issue:** Router subscribes only to `popstate`. Browser fires `popstate` on back/forward but NOT on `history.pushState()` / `replaceState()`. Any in-app link using `pushState` directly (auth redirects, future `<Link>` component) silently fails.
- **Fix:** Patch `pushState`/`replaceState` to dispatch a custom event:
  ```typescript
  const origPush = history.pushState.bind(history);
  history.pushState = (...args) => { origPush(...args); handler(); };
  ```
  Or document gap + plan TanStack Router migration.

## Lower-confidence observations (below reporting threshold)

- `packages/cli` has unused `aws-cdk ^2.1112.0` in `devDependencies` (leftover from infra work)
- Python `strands-agents>=1.0.0,<2.0.0` upper bound may over-constrain; `uv.lock` hashes mitigate
- `AdminPage` doesn't enforce admin group client-side; relies on backend (acceptable)

## Top 3 findings

1. **I1** — 178 chat-gateway tests permanently excluded from CI
2. **I2** — Revoke button non-functional (UI key rotation blocked)
3. **I4** — 3 active alarms with no runbook entries

## v0.6.3 blockers

**None hard-block.** I1 is process risk (tests claimed to pass locally); I2 is UI completeness (API works directly). I1 + I4 should resolve before next release candidate.
