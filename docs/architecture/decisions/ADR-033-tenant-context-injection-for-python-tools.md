---
title: 'ADR-033: Tenant Context Injection for Python Tools'
status: accepted
date: 2026-04-17
decision_makers: [chimera-architecture-team]
---

# ADR-033: Tenant Context Injection for Python Tools

## Status

**Accepted** (2026-04-17)

## Context

A Phase 1 audit of the Python agent runtime (`packages/agents/`) found that tenant isolation at the Python layer relied entirely on tool authors correctly threading a `tenant_id` argument through every tool call. Specifically:

1. **`tenant_id` as a user-settable argument** — `swarm_tools.py` and `code_interpreter_tools.py` together exposed 5 tool entrypoints that accepted `tenant_id: str` as a positional or keyword argument. Because tool arguments are chosen by the LLM, a misbehaving or compromised agent could call these tools with a different tenant's id, or with an empty string, and bypass multi-tenant isolation at the Python boundary.
2. **Optional tenant filters on DDB queries** — `dynamodb_tools.py` treated `filter_expression` as optional. A GSI query without `FilterExpression='tenantId = :tid'` returns items from *all* tenants on that table; nothing in the Python layer prevented this.
3. **CDK/DDB layer was the only enforcement point** — IAM session policies and DDB condition expressions caught some (but not all) of these paths. The Python layer had no defense-in-depth.

Verified via `grep` for `tenant_id: str` parameters and `FilterExpression` usage across `packages/agents/tools/`. Results and severity ratings are captured in `docs/reviews/agent-runtime-review.md` (finding C3) and `docs/reviews/SYNTHESIS.md` (P0-1 and P0-2).

Multi-tenant isolation is the strongest safety invariant Chimera offers to customers. A single GSI query that leaks one tenant's items into another tenant's session breaks that invariant, regardless of what the CDK layer enforces.

## Decision

Introduce a module-level `ContextVar` that holds the tenant context for the duration of a single AgentCore invocation. Every tool reads the tenant id from this context; no tool accepts it as an argument.

**New module:** `packages/agents/tools/tenant_context.py`

```python
from contextvars import ContextVar
from dataclasses import dataclass

@dataclass(frozen=True)
class TenantContext:
    tenant_id: str
    tier: str
    user_id: str

_tenant_context: ContextVar[TenantContext | None] = ContextVar(
    "chimera_tenant_context", default=None
)

def set_tenant_context(ctx: TenantContext) -> None: ...
def get_tenant_context() -> TenantContext | None: ...
def require_tenant_id() -> str: ...   # raises if unset
def ensure_tenant_filter(expr: str | None, values: dict) -> tuple[str, dict]: ...
```

**Entrypoint change:** `chimera_agent.py::agent_handler` calls `set_tenant_context(TenantContext(tenant_id=..., tier=..., user_id=...))` immediately after JWT claims are verified, before any tool is registered with the Strands agent.

**Tool contract:**

- Tools **MUST NOT** declare `tenant_id` as a parameter. Instead they call `require_tenant_id()`.
- DDB tools **MUST** pass every `FilterExpression` through `ensure_tenant_filter()`, which prepends `tenantId = :__chimera_tid` (using a reserved placeholder name to avoid collisions) and injects `{":__chimera_tid": tenant_id}` into the expression attribute values.
- Tool authors may read the full `TenantContext` via `get_tenant_context()` when they need `tier` or `user_id`.

**Affected tools (to be updated in follow-up work):**

- `swarm_tools.py` — remove `tenant_id` argument from 3 tool entrypoints
- `code_interpreter_tools.py` — remove `tenant_id` argument from 2 tool entrypoints
- `dynamodb_tools.py` — wrap all `query`/`scan` calls in `ensure_tenant_filter()`

## Alternatives Considered

### Alternative 1: ContextVar + `require_tenant_id()` (Selected)

Module-level `ContextVar`, explicit `require_tenant_id()` inside each tool.

**Pros:**
- ✅ Honest about the dependency — each tool explicitly declares it needs a tenant id
- ✅ Trivial to test — tests call `set_tenant_context()` in a fixture
- ✅ Safe under `asyncio` — `ContextVar` is copied across tasks automatically
- ✅ No tool signature surgery beyond removing the tainted parameter
- ✅ `ensure_tenant_filter()` gives DDB a single chokepoint

**Cons:**
- A tool author who forgets to call `require_tenant_id()` silently runs without it. Mitigated by code review and a unit test that greps the tools directory for the anti-pattern.

**Verdict:** Selected.

### Alternative 2: `@with_tenant_context` decorator

Wrap every tool function in a decorator that injects `tenant_id` as a keyword argument from the `ContextVar`.

**Pros:**
- One line per tool

**Cons:**
- ❌ Requires every tool author to remember to apply the decorator — same failure mode as the status quo
- ❌ Hides the dependency inside a decorator, making tests harder to reason about
- ❌ Doesn't solve the DDB `FilterExpression` problem at all

**Verdict:** Rejected — moves the forgetting failure mode from "forget to pass an argument" to "forget to apply a decorator." No real improvement.

### Alternative 3: Status quo (`tenant_id` as a tool argument)

Keep `tenant_id` as a tool parameter and rely on Cedar + IAM to catch misuse.

**Pros:**
- No code changes

**Cons:**
- ❌ Cedar and IAM do not inspect DDB `FilterExpression` contents — a missing filter bypasses both
- ❌ Python-layer isolation depends on LLM behaviour, which is not a security boundary

**Verdict:** Rejected — this is the finding we are fixing.

## Consequences

### Positive

- **Multi-tenant isolation is enforced in code, not convention.** A tool cannot call DDB without a tenant filter, and cannot spoof a tenant id, because neither is reachable from tool arguments.
- **Single chokepoint for tenant scoping.** Future DDB tools route through `ensure_tenant_filter()` and inherit the behaviour for free.
- **Test-friendly.** Unit tests set the context explicitly; there is no global state to leak between tests because `ContextVar` is per-task.

### Negative

- **Stricter than the previous "optional" behaviour.** DDB query tools now *always* run with a tenant filter, even when the agent doesn't pass one. Any caller that relied on an unfiltered cross-tenant scan (there should be none in production) will break loudly. This is the intended outcome.
- **New tool authors must learn the contract.** Declaring `tenant_id: str = ""` on a new tool is now a review-blocking defect.

### Risks

- **Forgotten `require_tenant_id()` call** — a tool author writes a new tool and simply doesn't call it. Mitigated by: (a) a grep-based unit test in `tests/test_tenant_context.py` that fails if any tool in `tools/` references `boto3` or `dynamodb` without importing from `tenant_context`; (b) code review.
- **AgentCore invocation boundary** — the `ContextVar` is set per invocation. A bug that leaks context between invocations on the same worker would be catastrophic. Mitigated by: AgentCore's MicroVM-per-session isolation (ADR-007), and by resetting the context in a `finally` block at the end of `agent_handler`.

## Evidence

- **`docs/reviews/agent-runtime-review.md`** — finding C3 ("tenant_id is a user-settable tool argument")
- **`docs/reviews/SYNTHESIS.md`** — P0-1 (tenant id spoofing) and P0-2 (missing DDB tenant filter)
- **Grep verification**: `tenant_id: str` appeared in 5 tool signatures across `swarm_tools.py` and `code_interpreter_tools.py`; `dynamodb_tools.py` declared `filter_expression: str = ""` on all query/scan helpers.

## Related Decisions

- **ADR-007** (AgentCore MicroVM): provides the per-session isolation boundary that makes the `ContextVar` approach safe
- **ADR-002** (Cedar policy engine): complements this ADR — Cedar enforces *which* tools a tenant may call, this ADR enforces that tools cannot be called *on behalf of* another tenant
- **ADR-031** (Three-layer tool architecture): the Layer 2 Gateway Lambdas described there still rely on their own tenant enforcement; this ADR covers the Layer 1 (Python runtime) tools

## References

1. Python `contextvars` module: https://docs.python.org/3/library/contextvars.html
2. DynamoDB GSI filter expressions: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.FilterExpression.html
3. Agent runtime review: `docs/reviews/agent-runtime-review.md`
4. Synthesis document: `docs/reviews/SYNTHESIS.md`
