# Chimera Python Agent Runtime Review

**Review Date:** 2026-04-17
**Scope:** Phase 1 analysis (read-only, thorough)
**Files Analyzed:** 27 Python tools, 4 core runtime files, infra TypeScript stubs, tests

## Executive Summary

Chimera's Python agent runtime is architecturally sound but has scattered hygiene gaps and real production-readiness concerns. The custom Strands SDK integration is moderately over-engineered but defensible. The biggest concerns are **tenant-boundary enforcement at the Python tool layer** and **unbounded polling loops** in self-evolution/swarm tools.

**Severity breakdown:**
- CRITICAL: 4
- HIGH: 8
- MEDIUM: 12
- LOW: 6

## Critical Findings

### C1 — Infinite Loop in `wait_for_evolution_deployment`

- **File:** `packages/agents/tools/evolution_tools.py:268-342`
- **Severity:** CRITICAL
- **Issue:** DynamoDB polling loop has no circuit breaker. If polling fails or state is never written, the loop runs up to `max_wait_seconds` (900s default) silently swallowing exceptions.
- **Impact:** Agent hangs for 15 minutes waiting for infrastructure that may have failed silently.
- **Fix:** Add max-consecutive-error count + exponential backoff.

### C2 — Swarm Tool Polling Without Circuit Breaker

- **File:** `packages/agents/tools/swarm_tools.py:148-200`
- **Severity:** CRITICAL
- **Issue:** Same pattern as C1 — `check_swarm_status` queries DDB without error escalation.
- **Fix:** Add circuit breaker after N consecutive failures.

### C3 — `tenant_id` Exposed as User-Settable Tool Parameter

- **Files:** `packages/agents/tools/swarm_tools.py:49`, `packages/agents/tools/background_task_tools.py:90-92`
- **Severity:** CRITICAL
- **Issue:** `tenant_id` is accepted as a tool argument instead of being injected from the runtime context. A compromised or misbehaving agent could pass `tenant_id="<other-tenant>"` and bypass isolation.
- **Impact:** Full multi-tenant isolation break at the Python layer. **Contradicts the CDK-layer security review's "no tenant-boundary breach" finding for this surface.**
- **Fix:** Remove `tenant_id` from tool signatures; extract from an env var injected by the AgentCore runtime entrypoint; validate against JWT claims at the entrypoint.

### C4 — Gateway Lambda Proxy Payload Unvalidated

- **File:** `packages/agents/gateway_proxy.py:65-88`
- **Severity:** CRITICAL
- **Issue:** No validation on `kwargs` size/depth before Lambda invoke; billion-laughs attack possible; 6 MB Lambda payload limit unchecked.
- **Impact:** DoS via oversized payloads; potential injection attacks if gateway Lambda trusts `tool_input` unchecked.
- **Fix:** Validate payload size before invoke; enforce max nesting depth.

## High-Priority Findings

### H1 — Loose Version Pins
- **File:** `packages/agents/pyproject.toml`
- **Issue:** `strands-agents>=1.0.0` and `boto3>=1.34.0` allow major-version jumps.
- **Fix:** Add upper bounds (e.g., `<2.0.0`).

### H2 — Bare `except Exception` (30+ occurrences)
- **Files:** all tool files, gateway_proxy.py, evolution_tools.py
- **Issue:** Masks throttling errors that need exponential backoff.
- **Fix:** Catch specific `ClientError` / `BotoCoreError`; retry on throttling.

### H3 — Missing Input Validation on Tool Arguments
- **Files:** `lambda_tools.py`, `dynamodb_tools.py`
- **Fix:** Validate JSON payload format and size before use.

### H4 — No Timeouts on Boto3 Clients
- **Fix:** Use `botocore.config.Config(connect_timeout=5, read_timeout=10, retries={'max_attempts': 3})`.

### H5 — DDB Queries Missing Required Tenant Filters (Python layer)
- **File:** `packages/agents/tools/dynamodb_tools.py:28-89`
- **Issue:** `filter_expression` is optional; an agent can omit the tenant filter and leak data.
- **Fix:** Enforce that every query includes the tenant condition; inject from env if missing.

### H6 — CodeCommit Permissions Not Pre-Validated
- **File:** `packages/agents/tools/evolution_tools.py:663-701`
- **Fix:** Call `get_repository` before commit; surface clear error.

### H7 — Async/Sync Mixing
- **Files:** `swarm_tools.py`, `background_task_tools.py`
- **Issue:** Agent is async but tools are sync blocking I/O; Strands SDK behavior here is unclear.
- **Fix:** Standardize; document.

### H8 — `@tool` Registration Errors Not Logged
- **Fix:** Central registry with try/except around each registration.

## Medium-Priority Findings (condensed)

| # | File | Issue | Fix |
|---|------|-------|-----|
| M1 | all tools | Unstructured logs (no tenant_id/request_id) | structlog + JSON |
| M2 | `code_interpreter_tools.py:35` | `_active_sessions` dict not thread-safe | `threading.Lock` |
| M3 | `evolution_tools.py:508-569` | Kill switch / Cedar / rate limits fail-open | Circuit breaker w/ graduated fail-closed |
| M4 | `chimera_agent.py:230-244` | Tenant-config interpolation into system prompt unescaped | Escape/whitelist tenant-supplied strings |
| M5 | runtime | No per-tenant rate limiting on tool calls | Token bucket per tenant |
| M6 | all tools | No tool success/failure metrics | Emit CloudWatch EMF |
| M7 | tests/ | No multi-tenant isolation tests | Add `test_tenant_isolation.py` |
| M8 | `chimera_agent.py:109-131` | `allowedModels` not validated against Bedrock | `get_foundation_model` check |
| M9-12 | misc | logging/format/constants/regions | see category notes below |

## Low-Priority Findings

- Incomplete tool docstrings (error cases undocumented)
- Inconsistent error message formatting
- Magic DDB key strings (use constants)
- Unused imports
- Inconsistent region defaults (`us-west-2` vs `us-east-1`)
- Minor inconsistency in decorator usage across tools

## Cross-Cutting Themes

### Theme 1 — Polling loops without guards
Multiple tools poll DDB/EventBridge without circuit breakers, backoff, or escalation. Risk: infinite loops, DDB throttling.
**Recommendation:** `PollWithBackoff` helper class.

### Theme 2 — Tenant isolation not enforced *in code*
Context is extracted at entrypoint but not propagated through decorators. `tenant_id` appears as a tool parameter, DDB filters are optional.
**Recommendation:** `@with_tenant_context` decorator that injects `tenant_id`, validates against JWT, and rejects tool args that try to override it.

### Theme 3 — Fail-open safety pattern
Kill switch, Cedar, rate limits all allow operations when external services fail. Acceptable at small scale but risky at volume.
**Recommendation:** Graduated circuit breaker (allow 1, deny after 3 failures, metric every decision).

## Is the Custom Strands Setup Over-Engineered?

### Current architecture
- Strands SDK + custom gateway discovery + tier-based tool loading
- 27 local tools + gateway proxies to Lambda tiers
- Self-evolution via CodeCommit + CodePipeline
- Multi-tenant isolation via DDB namespaces + Cedar

### Alternatives
**Bedrock Agents (managed):**
- ✅ Ops support, session management built-in
- ❌ Can't customize ReAct loop, self-evolution, or tier-gating

**LangChain Agents:**
- ✅ Large community, many integrations
- ❌ Doesn't solve Chimera-specific needs; still custom

### Verdict — Justified but moderately over-engineered

**Justified if:**
1. Self-evolution is a core product differentiator
2. Strict multi-tenant isolation with custom partitioning is required
3. Dynamic tool discovery is needed without container rebuilds

**Over-engineered:**
- 27 local tools + gateway proxy layer — consolidate to gateway-only?
- Per-tool tier overrides — three clean tiers would do
- Pre-GA Strands pinning risk

**Under-engineered:**
- Observability (per-tool success/cost)
- Per-tenant tool-call rate limiting
- Tool versioning / rollback

**Recommendation:** Keep the custom setup **if** self-evolution is core. De-risk Strands version pins, simplify tool discovery, add observability.

## Summary: Top 5 Critical/High

| Rank | Finding | Severity | Effort |
|------|---------|----------|--------|
| 1 | Infinite loop in evolution polling | CRITICAL | 2h |
| 2 | `tenant_id` exposed as tool parameter | CRITICAL | 4h |
| 3 | Gateway Lambda payload unvalidated | CRITICAL | 3h |
| 4 | Python DDB queries missing tenant filters | HIGH | 3h |
| 5 | Broad `except Exception` (30+ places) | HIGH | 8h |

**Total critical/high effort:** ~20 hours. Must be addressed before production.
