---
title: "Wave-15 Concurrent Review"
status: audit
date: 2026-04-23
auditor: wave15-concurrent-reviewer
---

# Wave-15 Concurrent Review

## Severity Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1     |
| HIGH     | 4     |
| MEDIUM   | 3     |
| LOW      | 2     |
| **Total**| **10**|

---

## CRITICAL

### C1 — `enterprise`/`dedicated` tenants silently downgraded to `basic` tier at chat-gateway

- **File:** `packages/chat-gateway/src/middleware/tenant.ts:102–107`
- **What:** The `validTiers` array is `['basic', 'advanced', 'premium']`. When an `enterprise` or `dedicated` JWT claim arrives (via `custom:tenant_tier`), it fails `.includes(tier)` and the fallback assigns `'basic'`. Every enterprise tenant request is processed as a basic tenant.
- **Why critical:** Enterprise tenants receive basic-tier model routing (Nova Lite instead of Opus), basic-tier tool access, and basic-tier memory (7-day retention, STM window 10 vs 200). An enterprise customer paying for dedicated resources gets degraded service silently. Combined with the now-fixed C2 (audit retention) this is a second tier-confusion path. Blocks any 10-tenant scale-up that includes an enterprise tenant.
- **Fix:** Add `'enterprise'` and `'dedicated'` to `validTiers`. Cross-check `chimera_agent.py:select_model_for_tier` and `get_memory_config_for_tier` — both also missing `enterprise`/`dedicated` entries (same fallback-to-basic applies in the Python path).

---

## HIGH

### H1 — `register_capability` omits GSI attributes — agent-registered skills are invisible to marketplace queries

- **File:** `packages/agents/tools/evolution_tools.py:418–431`
- **What:** `register_capability` writes a skill record with `SK: "REGISTRY"` but omits `author`, `category`, and `trustLevel` attributes. The three GSIs are keyed on those exact attributes. DynamoDB only indexes items where the GSI partition key attribute is present.
- **Why high:** Any capability registered via the self-evolution flow is invisible to `listByAuthor`, `listByCategory`, and `listByTrustLevel`. Queries now succeed with zero results rather than throwing — a more insidious failure mode than the pre-Wave-14 ValidationException.
- **Fix:** Add `author: tenant_id`, `category: "automation"` (or accept as a parameter), and `trustLevel: "private"` (or parametrize) to the `put_item` call. Also set `skillName` to `capability_name` so `GSI1-author` sort key resolves.

### H2 — `_check_evolution_rate_limit` TOCTOU race allows limit bypass

- **File:** `packages/agents/tools/evolution_tools.py:622–651`
- **What:** The rate-limiter reads the current count (`get_item`), checks `count >= daily_limit`, and then increments (`update_item`). Under concurrent requests from the same tenant, two goroutines can both read `count=4`, both pass the check, and both increment — allowing 6 evolution requests when the limit is 5.
- **Why high:** Self-evolution is the highest-privilege operation a tenant can perform (commits CDK code to production). A bypassed rate limit allows an adversarial or runaway agent to submit unlimited infrastructure mutations per day.
- **Fix:** Replace read-then-write with a single atomic `update_item` using `ConditionExpression='attribute_not_exists(#cnt) OR #cnt < :dlim'` and `ADD #cnt :one`. Catch `ConditionalCheckFailedException` as "denied".

### H3 — Cognito MFA is `OPTIONAL` in production — enterprise multi-tenant SaaS requires enforcement

- **File:** `infra/lib/security-stack.ts:104`
- **What:** `mfa: cognito.Mfa.OPTIONAL`. OTP MFA is available but not enforced. Admin and tenant-admin groups have no MFA requirement.
- **Why high:** Chimera holds cross-tenant infrastructure credentials and runs CDK self-evolution. Admin compromise via phishing (no MFA) can trigger evolutions or access all tenant data. SOC2 Type II and ISO 27001 both mandate MFA for privileged access.
- **Fix:** Set `mfa: cognito.Mfa.REQUIRED` for production (gate on `isProd`). For the `admin` and `tenant-admin` user pool groups, add an `AdminSetUserMFAPreference` Lambda trigger that enforces TOTP on first login.

### H4 — `StreamTee` buffer grows unbounded — memory pressure risk at 10-tenant scale

- **File:** `packages/sse-bridge/src/stream-tee.ts:8,71` and `packages/chat-gateway/src/stream-manager.ts:22`
- **What:** `StreamTee._buffer` is a plain `T[]` with no maximum size cap. Streams are retained for `STREAM_TTL_MS = 5 * 60 * 1000` (5 min) after completion.
- **Why high:** At 10-tenant scale with concurrent long-running sessions, unbounded buffer growth becomes a memory pressure risk. A 20-iteration pathological response with large tool outputs can OOM the ECS Fargate task.
- **Fix:** Add a `maxBufferSize` option to `StreamTee` (suggested default: 1000 parts). When exceeded, drop oldest from head (ring-buffer) and set a `truncated` flag. Reconnecting clients receive truncated history with a `X-Buffer-Truncated` header warning.

---

## MEDIUM

### M1 — `refreshTokenValidity: 30 days` with no rotation or revocation strategy

- **File:** `infra/lib/security-stack.ts:272–284`
- **What:** Both web client and CLI client have `refreshTokenValidity: cdk.Duration.days(30)` with no `enableTokenRevocation`. A stolen refresh token grants 30 days of persistent access.
- **Fix:** Add `enableTokenRevocation: true` to both `addClient` calls. Reduce `refreshTokenValidity` to 7 days for basic/advanced and 24 hours for CLI sessions. Document the revocation procedure in `security-incident-tenant-breach.md`.

### M2 — WAF rate limit (2000 req/5 min per IP) blocks multi-tenant corporate-NAT traffic

- **File:** `infra/lib/security-stack.ts:336–349`
- **What:** The `RateLimitPerIP` rule blocks IPs exceeding 2000 req/5min. Multi-tenant corporate-NAT egress hits this trivially at 10 users.
- **Fix:** Switch to JWT-based rate limiting for authenticated endpoints (WAF supports header-based keys). Keep IP-based as a bot/DDoS backstop at 10000 req/5min. Add tenant-level rate limiting at the API Gateway usage plan layer.

### M3 — `hello_world_tool` has `@tool` with no `require_tenant_id()` — production gating unverified

- **File:** `packages/agents/tools/hello_world.py:15–27`
- **What:** `hello_world_tool` uses `@tool` without a `require_tenant_id()` call. If `GatewayToolDiscovery` loads it into any tier's tool list, it runs unauth'd.
- **Fix:** Either add `require_tenant_id()` at the top, OR add a module-level `__production_excluded__ = True` sentinel that `GatewayToolDiscovery` honors.

---

## LOW

### L1 — `load_tenant_config` in `chimera_agent.py` uses low-level DDB client with no timeout config

- **File:** `packages/agents/chimera_agent.py:148–173`
- **What:** Creates raw `boto3.client('dynamodb')` with no `Config(connect_timeout=, read_timeout=, retries=)`. All other DynamoDB callers use `_BOTO_CONFIG = Config(connect_timeout=5, read_timeout=30, retries={"max_attempts": 3})`.
- **Fix:** Add `_BOTO_CONFIG` to `chimera_agent.py` module (or import from a shared constants module) and pass it to the client constructor.

### L2 — `code_interpreter_tools.py` API-shape bugs still present behind kill-switch

- **File:** `packages/agents/tools/code_interpreter_tools.py:90–130`
- **What:** `TODO(rabbithole-04)` documents three unfixed wire-shape bugs; kill-switch protection relies on `bedrock-agentcore` not being a valid boto3 service name in all regions. If the service name resolves in a new region, all three bugs activate simultaneously.
- **Fix:** File a seeds issue to track the three specific fixes before flipping the kill-switch default.

---

## Already-confirmed clean areas

- **Python agent tenant isolation (`packages/agents/tools/`):** All `@tool` functions except `hello_world_tool` (M3) correctly call `require_tenant_id()`.
- **SSE streaming path:** Heartbeat (15s), `AbortSignal`, 5s drain-timeout, `formatSSEDone()` flush, `messageStop` handling all correct. No back-pressure issues beyond H4.
- **CodePipeline artifact bucket:** `ChimeraBucket` enforces CMK encryption, versioning, SSL, access logging, public-access block. Not a finding.
- **Lambda cold-start in hot path:** Python 3.12 with minimal imports; Step Functions retries address cold-start transients.
- **CloudFront cache-key config:** HTML behavior uses `CacheHeaderBehavior.none()`, `CacheQueryStringBehavior.none()`, `CacheCookieBehavior.none()` with TTL=0. No tenant-scoped auth state leakage.

---

## Out of scope (already tracked)

- Wave-14 findings C1, C2, H1–H5
- Observability metrics not yet emitted (`tier_violation_count`, `tenant:hourly_cost_usd`)
- Orchestration skeleton stubs — covered by Wave-15a guards
- AgentCore Registry multi-tenancy spike (ADR-034 Phase 2)
- Python bare `except` sweep — evolution_tools closed, others verified clean
- `strands-agents.ts` shim removal — cleanup item
- DAX SG narrowing — blocked by circular dep

---

## Findings that block 10-tenant scale-up

1. **C1** — every enterprise tenant gets wrong-tier service silently
2. **H4** — unbounded `StreamTee` buffer, ECS memory pressure
3. **M2** — WAF IP rate limit triggers false-positives on corporate-NAT traffic
