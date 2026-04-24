---
title: "Wave-16 Concurrent Review"
status: audit
date: 2026-04-24
auditor: wave16-concurrent-reviewer
---

# Wave-16 Concurrent Review

## Severity Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 3 |
| MEDIUM   | 3 |
| LOW      | 2 |
| **Total**| **8** |

---

## HIGH

### H1 — CI workflow has no `permissions:` block — GITHUB_TOKEN defaults to broad write access

- **File:** `.github/workflows/ci.yml` (entire file — no `permissions:` key)
- **What:** Without an explicit `permissions:` block, GITHUB_TOKEN uses the repo-level default (often write on `contents`, `pull-requests`, `packages`, etc.). Any third-party action in the workflow can access the token.
- **Why high:** A compromised action under a mutable tag could push to `main`, create releases, or publish packages without obvious evidence.
- **Fix:** Add at top-level: `permissions: contents: read`. Re-grant `checks: write` / `actions: write` per-job where required.

### H2 — `astral-sh/setup-uv@v5` with `version: 'latest'` — non-deterministic uv install

- **File:** `.github/workflows/ci.yml:72-74`
- **What:** `@v5` is a mutable tag; `version: 'latest'` installs newest uv at runtime. Two supply-chain risks in one step.
- **Fix:** Pin `version` to a specific uv release (e.g., `'0.7.3'`). SHA-pin all third-party actions.

### H3 — `tenant_context.py` env-var fallback is process-wide — cross-tenant leak in shared ECS containers

- **File:** `packages/agents/tools/tenant_context.py:73-80`
- **What:** `get_tenant_context()` falls back to `os.environ.get("CHIMERA_TENANT_ID")` when the ContextVar is unset. `os.environ` is process-wide. If any ECS task has `CHIMERA_TENANT_ID` set, every request that reaches `get_tenant_context()` without a prior `set_tenant_context()` call acquires the wrong tenant ID. `require_tenant_id()` silently passes.
- **Why high:** The anti-pattern guard test (CLAUDE.md security layer 3) checks imports but cannot catch this runtime fallback path. Active cross-tenant data leak vector in any ECS deployment with the env var set.
- **Fix:** Remove the env-var fallback block. Return `None` when ContextVar is unset.

---

## MEDIUM

### M1 — `cloudfront:CreateInvalidation` scoped to all distributions in account

- **File:** `infra/lib/pipeline-stack.ts:471-477`
- **What:** `resources: ['arn:aws:cloudfront::${account}:distribution/*']`. A compromised build can invalidate any CloudFront distribution in the account.
- **Fix:** Pass the specific distribution ARN as a CDK context parameter or CodeBuild env var; restrict `resources` to that ARN.

### M2 — CORS `ALL_ORIGINS` + `allowCredentials: true` in non-prod is spec-invalid

- **File:** `infra/lib/api-stack.ts:104-120`
- **What:** CORS spec prohibits `Access-Control-Allow-Credentials: true` with `Access-Control-Allow-Origin: *`. Browsers reject the preflight. Staging frontend tests fail silently.
- **Fix:** Enumerate staging origins for non-prod, or set `allowCredentials: false` when using `ALL_ORIGINS`.

### M3 — No S3 export pathway for 7-year enterprise audit retention

- **File:** `infra/lib/data-stack.ts:194-208`
- **What:** `chimera-audit` relies only on DynamoDB TTL (eventual deletion) + PITR (35-day window). Enterprise 7-year retention cannot survive a table accidental-delete + restore after 35 days. SOC2/ISO27001 would flag.
- **Fix:** Add EventBridge-scheduled Lambda that exports items approaching TTL expiry to S3 Glacier Deep Archive under `audit-archive/{tenantId}/{year}/`.

---

## LOW

### L1 — WAF logs have no Metric Filter for blocked requests

- **File:** `infra/lib/security-stack.ts:315-406`
- **What:** WAF logs flow to CloudWatch but no Metric Filter counts `action=BLOCK` by rule. Attack pattern detection requires manual Insights queries.
- **Fix:** Add `addMetricFilter` for blocked requests + alarm at >200/5min.

### L2 — Dependabot lacks auto-merge for security patches

- **File:** `.github/dependabot.yml`
- **What:** No auto-merge workflow. Critical CVE fixes wait in the queue for manual review.
- **Fix:** GitHub Actions workflow that auto-merges Dependabot PRs for patch-level updates after CI passes.

---

## Already-confirmed clean

- ECR `imageScanOnPush` — enabled on both repos
- `secretValue.unsafeUnwrap()` — not found anywhere
- Hardcoded credentials — none
- `pull_request_target` trigger — not used
- KMS for CloudWatch Logs — correct key policy
- Cognito MFA — `REQUIRED` in prod
- Web UI XSS — uses ReactMarkdown + text content (no `innerHTML`)
- All remaining `resources: ['*']` IAM grants are justified AWS API limitations, documented inline

---

## Out of scope (tracked elsewhere)

- Wave-15d C1 (gateway_config.py) — CLOSED in commit c635911
- Wave-15d H1 (SkillRegistry empty GSI) — open
- DAX SG narrowing — blocked by circular dep
- ECR image signing — tracked in pipeline-stack.ts TODO
- `ecs:Register/UpdateService` wildcards on canary Lambdas — pre-existing

---

## Deploy blockers

Two findings warrant remediation before the next deploy:

1. **H3** — cross-tenant leak via env var fallback (7-line delete)
2. **M2** — staging CORS silently fails (1-line change)
