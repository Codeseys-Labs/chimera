---
title: 'ADR-038: Cognito Token Lifetime (Web 7d / CLI 1d) with Revocation Enabled'
status: accepted
date: 2026-04-24
decision_makers: [chimera-architecture-team]
---

# ADR-038: Cognito Token Lifetime — Web 7 days / CLI 1 day, Revocation Enabled

## Status

**Accepted** (2026-04-24)

## Context

Cognito's default `refreshTokenValidity` is 30 days, and `enableTokenRevocation` defaults to the user pool's prior configuration (not reliably `true` on a fresh pool). Chimera's Wave-15 audit (`docs/reviews/` finding M1) flagged two consequences of the defaults:

1. **Long-lived refresh tokens.** A stolen refresh token granted 30 days of persistent access to a compromised account. This is long relative to incident-detection timelines and gives an attacker a month-wide window even after the credential theft is known.
2. **Revocation not explicitly enabled.** Without `enableTokenRevocation: true`, Cognito's per-session revocation API is not reliably usable for incident response. The fix for a stolen token is to revoke; if revocation is off, the only recourse is global sign-out, which is blunt and disruptive.

The two Cognito app clients have different threat profiles:

- **Web client** — tokens live in browser storage. Users expect weekly-active UX; forcing a daily re-login breaks that expectation.
- **CLI client** — tokens live on operator laptops, which have higher exposure (shared workstations, lost hardware, clipboard exfil via local malware). CLI users sign in interactively during work sessions; daily re-login is acceptable friction.

## Decision

Set Cognito app-client tokens to:

- **Web client** — `refreshTokenValidity: Duration.days(7)`, `enableTokenRevocation: true`
- **CLI client** — `refreshTokenValidity: Duration.days(1)`, `enableTokenRevocation: true`

Both clients enable explicit revocation so incident response can kill a specific session without forcing all users to re-sign-in.

**Commit reference:** `84479de` (Wave-15 M1, bundled with H3 — see ADR-037).

## Alternatives Considered

### Alternative 1: Uniform 24-hour refresh for everything

One short-lived config for both clients.

**Cons:** Breaks weekly-active web UX. For a developer-tools product, forcing a daily web re-login is a significant UX regression. Rejected.

### Alternative 2: SaaS-norm 90-day web refresh

Many SaaS products default to 60–90 day refresh on web for stickiness.

**Cons:** The audit severity on a stolen refresh token outweighs the stickiness UX win. 90 days is longer than most organizations' incident detection window. Rejected.

### Alternative 3: Server-side session tokens, bypass Cognito refresh

Build a custom token table with per-session TTL and replace Cognito refresh entirely.

**Cons:** Reinvents Cognito for no gain; introduces a new stateful dependency on the hot path of every auth check; loses the audit logging and revocation machinery Cognito already provides. Rejected.

### Alternative 4: Differentiated web/CLI with revocation (Selected)

Web 7 days, CLI 1 day, both with `enableTokenRevocation: true`.

**Verdict:** Selected.

## Consequences

### Positive

- **Blast-radius reduction.** A stolen web token is a 7-day window (down from 30); a stolen CLI token is a 1-day window (down from 30).
- **Incident response usable.** With `enableTokenRevocation: true`, operators can revoke a compromised session via the `RevokeToken` API rather than rotating every user in the pool.
- **UX preserved where it matters.** Weekly-active web users re-authenticate ~once per week, which matches the product cadence and respects "remember me" expectations.

### Negative

- **CLI operators re-authenticate daily.** Acceptable for admin tooling; the operator personas (platform engineers, security responders) already expect short-lived credentials.
- **Web users who skip a week re-authenticate.** Acceptable given the security trade. Amplify's session refresh handles this transparently on the next page load.

### Risks

- **Clock skew on client devices.** A client whose clock is hours ahead will see tokens expire early. Mitigated by Amplify's built-in refresh-on-401 retry.
- **Revocation coverage.** `enableTokenRevocation: true` applies to tokens issued after the setting was enabled. For tokens issued before the flag flipped, global sign-out (`GlobalSignOut`) remains the fallback.

## Evidence

- **`infra/lib/security-stack.ts`** — two `UserPoolClient` declarations at lines 283/284 (web) and 297/298 (CLI) showing the configured refresh validity and revocation flag.
- **Wave-15 audit M1** — documented in the Wave-15 review synthesis.
- **Commit `84479de`** — landing commit (bundled with ADR-037's MFA change).

## Related Decisions

- **ADR-037** (MFA policy tiering) — bundled in the same commit. MFA reduces the probability of credential theft; short refresh + revocation reduces the impact if theft happens anyway. Defense-in-depth.
- **ADR-028** (AWS Amplify Gen 2 for frontend auth) — Amplify honors the pool's `refreshTokenValidity` transparently; no frontend code changed.

## References

1. Cognito app client token validity: <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-with-identity-providers.html>
2. Cognito `RevokeToken` API: <https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html>
3. Security stack: `infra/lib/security-stack.ts`
4. Landing commit: `84479de`
