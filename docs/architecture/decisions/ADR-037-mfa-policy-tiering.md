---
title: 'ADR-037: MFA Policy Tiering (Optional dev / Required prod)'
status: accepted
date: 2026-04-24
decision_makers: [chimera-architecture-team]
---

# ADR-037: MFA Policy Tiering — Optional in dev, Required in prod

## Status

**Accepted** (2026-04-24)

## Context

Before Wave-15, Chimera's Cognito user pool was declared with `mfa: Mfa.OPTIONAL` in every environment. The setting is enforced by Cognito at sign-in time — OPTIONAL means users can enroll TOTP but are not required to. In practice, no user had enrolled, because nothing prompted them to.

Enterprise SaaS procurement for multi-tenant platforms requires MFA for privileged access. SOC 2 Type II CC6.1 and ISO 27001 A.9.4.2 both call for strong authentication on administrative interfaces. The Wave-15 security audit (`docs/reviews/` finding H3) rated the unconditional OPTIONAL setting as a HIGH severity gap: the user pool hosts tenant admins and platform operators, and a single phished password would grant session-length access to a tenant's control plane.

Requiring TOTP uniformly, however, would break developer iteration in ephemeral dev stacks. First-login flows on fresh user-pool deployments would force TOTP enrollment before a developer could exchange a password for a token against a stack they just `cdk deploy`ed, adding ~2 minutes of phone-based friction to every stack spin-up.

## Decision

Gate the Cognito `mfa` setting on the `isProd` CDK context flag:

```ts
mfa: isProd ? cognito.Mfa.REQUIRED : cognito.Mfa.OPTIONAL,
```

Prod enforces TOTP enrollment and challenge on every sign-in. Dev and staging retain OPTIONAL so ephemeral stacks and developer iteration are unblocked.

**Commit reference:** `84479de` (Wave-15 H3, bundled with M1 — see ADR-038).

TOTP is the only MFA factor declared (`mfaSecondFactor: { otp: true, sms: false }`). SMS is not used because SIM-swap is a known attack vector against high-value admin accounts.

## Alternatives Considered

### Alternative 1: REQUIRED everywhere

Enforce TOTP in all environments.

**Cons:** Developer iteration against fresh user pools adds phone-based enrollment to every `cdk deploy` of an ephemeral stack. For a team spinning up dozens of dev stacks per week, this is a daily tax. Rejected.

### Alternative 2: Separate admin user pool (REQUIRED) + tenant pool (OPTIONAL)

Split Cognito into two pools along a privilege axis.

**Cons:** Chimera's architecture is single-pool multi-tenant: tenant administrators, platform operators, and end users all live in one pool distinguished by Cognito groups and JWT claims. Splitting the pool requires re-architecting session-to-claims mapping and Cedar policy evaluation. The architectural cost does not map to the benefit delivered. Rejected.

### Alternative 3: Enforce MFA via Cognito Lambda trigger

Use a `PreAuthentication` or `CustomMessage` trigger to conditionally demand MFA based on group membership.

**Cons:** CDK L2 already supports the prod/dev gate cleanly. A Lambda trigger is correct indirection for dynamic per-user logic but wrong tool for a static per-environment policy. Rejected.

### Alternative 4: Environment-gated `Mfa.REQUIRED` (Selected)

`isProd ? REQUIRED : OPTIONAL`.

**Verdict:** Selected.

## Consequences

### Positive

- **SOC 2 / ISO 27001 readiness.** Prod sign-ins are MFA-protected; procurement checklists no longer fail on this control.
- **Blast-radius reduction.** A phished password in prod no longer grants a session.
- **Dev velocity preserved.** Ephemeral and dev stacks are unchanged.

### Negative

- **First-login flow for prod operators requires TOTP enrollment.** Operator onboarding documentation must now walk a new hire through the enrollment step. Runbook: `docs/runbooks/security-incident-tenant-breach.md` covers operator MFA recovery (device-lost flow); onboarding docs must reference this for the inverse path.
- **Dev behavior diverges from prod.** Developers who never log into prod will not exercise the enrollment flow locally. Mitigated by at least one staging deploy cycle per release train that exercises a REQUIRED user pool end-to-end.

### Risks

- **TOTP device loss in prod.** An admin who loses their TOTP device cannot sign in. Mitigated by the recovery flow documented in `security-incident-tenant-breach.md`: an identity-verified break-glass procedure reset via AdminResetUserPassword.

## Evidence

- **`infra/lib/security-stack.ts`** line 110: `mfa: isProd ? cognito.Mfa.REQUIRED : cognito.Mfa.OPTIONAL`.
- **Wave-15 audit H3** — documented in the Wave-15 review synthesis.
- **Commit `84479de`** — landing commit (bundled with ADR-038's token lifetime change).

## Related Decisions

- **ADR-028** (AWS Amplify Gen 2 for frontend auth) — the web UI consumes this Cognito user pool; Amplify's MFA flow honors the pool's `mfa` setting unchanged.
- **ADR-038** (Cognito token lifetime) — bundled in the same commit. MFA gates initial authentication; token lifetime gates session longevity after a successful sign-in.

## References

1. Cognito MFA documentation: <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html>
2. SOC 2 Type II CC6.1 (Logical Access): AICPA Trust Services Criteria.
3. ISO 27001 A.9.4.2 (Secure log-on procedures): ISO/IEC 27001:2022.
4. Security stack: `infra/lib/security-stack.ts`
5. Landing commit: `84479de`
6. Operator runbook: `docs/runbooks/security-incident-tenant-breach.md`
