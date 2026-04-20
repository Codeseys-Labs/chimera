# Chimera Security & Multi-Tenancy Audit

**Audit Date:** 2026-04-17
**Scope:** Multi-tenancy, authorization, encryption, secrets, injection, audit, and compliance
**Findings Count:** 10 total — **0 CRITICAL, 0 HIGH, 3 MEDIUM, 2 LOW, 5 INFO**

> **Note:** This audit focused on TypeScript/CDK paths. A parallel Python-runtime audit
> flagged tenant-boundary risks inside the agent tools (`tenant_id` as user-settable
> tool parameter, optional DDB tenant filters). Cross-check findings in
> `agent-runtime-review.md` — the two views together are authoritative.

## Executive Summary

Across the TypeScript/CDK surface, Chimera's security posture is strong. No tenant-boundary breaches, auth bypasses, or secret leaks were identified at this layer. Known prior issues (`unsafeUnwrap`, unsafe-inner-HTML, GSI cross-tenant leakage) are all fixed. Three medium-priority gaps remain around token lifetime, CDK Nag justification rigor, and audit-TTL enforcement against tenant tier.

## Critical Findings

**None at the TS/CDK layer.** See `agent-runtime-review.md` for Python-side criticals.

## High-Priority Findings

**None at the TS/CDK layer.**

## Medium-Priority Findings

### M1 — JWT Token Expiry / Refresh Validation Gap

- **File:** `packages/chat-gateway/src/middleware/auth.ts:58-145`
- **Severity:** MEDIUM
- **Description:** No per-tenant token lifetime configuration. Default 1h expiry may be too long for sensitive tiers. Group-membership revocation is not reflected until the token expires.
- **Exploit:** A user whose role is downgraded retains elevated permissions for up to 1 hour.
- **Fix:** Implement per-tenant TTL, add a refresh-validation endpoint, emit an audit event on role-change so the gateway can proactively invalidate sessions.

### M2 — CDK Nag Suppression Justifications Are Incomplete

- **File:** `infra/cdk-nag-suppressions.ts:92-224`
- **Severity:** MEDIUM
- **Description:** Several suppressions reference vague criteria ("re-evaluate before GA") and manual rotation with no automated enforcement.
- **Exploit:** Quarterly secret rotation is not tracked; rotation can be forgotten silently.
- **Fix:** Track via SSM OpsCenter, enable Secrets Manager Lambda rotation where possible, replace vague criteria with measurable metrics.

### M3 — Audit Table TTL Not Enforced by Tenant Tier

- **File:** `infra/lib/data-stack.ts:174-191`
- **Severity:** MEDIUM
- **Description:** Schema documents tier-based TTL (90d / 1yr / 7yr) but the code path doesn't enforce it; a basic-tier tenant could write a 7-year record.
- **Exploit:** Basic-tier data is retained 7 years, violating compliance expectations.
- **Fix:** Add `calculateTTL(tenantId, tier)` validation, prevent non-admin tier TTL override, add integration tests.

## Low-Priority Findings

### L1 — WebSocket Authentication Path Not Documented (REQUIRES RUNTIME VERIFICATION)
May bypass the HTTP middleware path; needs API Gateway authorizer confirmation.

### L2 — Bun Lock File Lacks Integrity Hashes
Cannot detect tampered tarballs. Mitigated by `--frozen-lockfile`; suggest exact version pinning for Dockerized dependencies.

## Verified Strengths (TS/CDK layer only)

| Area | Result |
|------|--------|
| GSI cross-tenant isolation (TS) | All 8 GSI queries in `packages/core` include `FilterExpression='tenantId = :tenantId'` |
| Cedar authorization | 7 built-in policies; tests assert on specific reasons; cross-tenant isolation explicitly denied with `cross-tenant-isolation` reason |
| KMS | Per-table keys, rotation enabled, CloudWatch Logs uses key policy (not IAM) |
| IAM least privilege | No admin wildcards; 15+ documented suppressions with scoped permissions |
| Secrets | No `unsafeUnwrap()` (prior issue resolved); HMAC for webhooks; no plaintext env secrets |
| Frontend XSS / injection | No unsafe HTML sinks; no `eval`, `Function()`; React handles escaping |
| Skill pipeline | All 7 security stages enforced in sequence with Lambda DLQs |
| Audit trail | CMK encrypted; event streams for archival |
| Supply chain | `--frozen-lockfile`; ECR Public base images; skill trust tiers with signature verification |
| CDK Nag | Integrated globally; 15+ documented suppressions |

## Remediation Roadmap (TS/CDK only)

| Priority | Item | Effort |
|----------|------|--------|
| P1 | M3 audit-TTL enforcement | ~1 day |
| P1 | M1 token revocation path | ~2-3 days |
| P2 | M2 CDK Nag justification rigor + OpsCenter tracking | ~1 day |
| P3 | L1 WebSocket auth documentation + runtime test | ~0.5 day |
| P3 | L2 exact-version pinning for Docker deps | ~0.5 day |

## Files Analyzed (sample)

- `packages/core/src/tenant/tenant-service.ts`
- `packages/core/src/tenant/cedar-authorization.ts` + tests (600+ LOC)
- `packages/core/src/billing/cost-tracker.ts`
- `packages/core/src/tenant/rate-limiter.ts`
- `packages/core/src/skills/registry.ts`
- `infra/lib/security-stack.ts`
- `infra/lib/data-stack.ts`
- `infra/lib/skill-pipeline-stack.ts`
- `infra/cdk-nag-suppressions.ts`
- `packages/agents/Dockerfile`
- `packages/chat-gateway/Dockerfile`
- `packages/chat-gateway/src/middleware/auth.ts`

**Total files examined:** 100+. **Total lines analyzed:** 5000+.

## Verdict

TS/CDK layer: **proceed**, no blocking issues. **But** see `agent-runtime-review.md` for Python-side critical findings that change the overall picture.
