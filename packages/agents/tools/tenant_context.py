"""
Tenant context injection for Strands tools.

Tools must NEVER accept `tenant_id` as a user-settable argument — a misbehaving
or compromised agent could pass another tenant's ID and break isolation. Instead,
`tenant_id` is set once per session from the JWT claims at the AgentCore entrypoint
(`chimera_agent.py::agent_handler`) and read here from a module-level contextvar.

Usage in a tool:

    from .tenant_context import require_tenant_id, ensure_tenant_filter

    @tool
    def my_tool(some_arg: str) -> str:
        tenant_id = require_tenant_id()          # raises if unset
        ...

    @tool
    def dynamodb_query(table_name, key_condition, expression_values,
                       filter_expression=""):
        filter_expression = ensure_tenant_filter(filter_expression, values)
        ...

The entrypoint sets the context via `set_tenant_context(tenant_id, tier, user_id)`
before invoking the agent, and resets it when the session ends.
"""

from __future__ import annotations

import json
import os
import re
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class TenantContext:
    tenant_id: str
    tier: str = "basic"
    user_id: Optional[str] = None


_tenant_ctx: ContextVar[Optional[TenantContext]] = ContextVar(
    "chimera_tenant_ctx", default=None
)


class TenantContextError(RuntimeError):
    """Raised when a tool is invoked without a tenant context in scope."""


def set_tenant_context(
    tenant_id: str, tier: str = "basic", user_id: Optional[str] = None
) -> None:
    """Set the tenant context for the current execution. Called by the entrypoint."""
    if not tenant_id:
        raise ValueError("tenant_id must be non-empty")
    _tenant_ctx.set(TenantContext(tenant_id=tenant_id, tier=tier, user_id=user_id))


def clear_tenant_context() -> None:
    """Clear the tenant context at session end."""
    _tenant_ctx.set(None)


def get_tenant_context() -> Optional[TenantContext]:
    """Return the current tenant context, or None if unset.

    SECURITY (Wave-16 H3): This function deliberately does NOT fall back to
    `os.environ.get("CHIMERA_TENANT_ID")`. `os.environ` is process-wide and
    cannot be isolated per concurrent request. An ECS task with
    CHIMERA_TENANT_ID set in its environment would leak that tenant's context
    to every request that reached this function without a prior
    `set_tenant_context()` call — silently satisfying `require_tenant_id()`
    with the wrong tenant. ADR-033 requires entrypoints to call
    `set_tenant_context()` explicitly; there is no legitimate fallback path.
    """
    return _tenant_ctx.get()


def require_tenant_id() -> str:
    """Return the current tenant_id or raise TenantContextError."""
    ctx = get_tenant_context()
    if ctx is None:
        raise TenantContextError(
            "Tool invoked without a tenant context. The AgentCore entrypoint must "
            "call set_tenant_context(...) before invoking tools."
        )
    return ctx.tenant_id


def ensure_tenant_filter(filter_expression: str, expression_values: str) -> tuple[str, str]:
    """
    Guarantee a DDB filter/expression-values pair includes a tenant condition.

    Returns `(filter_expression, expression_values)` with `tenantId = :__chimera_tid`
    appended (AND-ed) when not already present. Raises TenantContextError if no
    tenant context is in scope.

    `expression_values` is a JSON string (matching the tool signature). The returned
    JSON adds `:__chimera_tid` to the values map.
    """
    tenant_id = require_tenant_id()

    try:
        values = json.loads(expression_values) if expression_values else {}
    except json.JSONDecodeError as e:
        raise ValueError(f"expression_values is not valid JSON: {e}") from e
    if not isinstance(values, dict):
        raise ValueError("expression_values must decode to a JSON object")

    placeholder = ":__chimera_tid"
    tenant_clause = f"tenantId = {placeholder}"

    # Idempotency check uses word boundaries so prefixed fields like
    # `myField_tenantId = :__chimera_tid` do NOT suppress the injected clause
    # (a plain substring match would false-match and leak cross-tenant data).
    _TENANT_CLAUSE_RE = re.compile(
        r"(?<![A-Za-z0-9_])tenantId\s*=\s*:__chimera_tid\b"
    )
    if _TENANT_CLAUSE_RE.search(filter_expression):
        combined = filter_expression
    elif filter_expression.strip():
        combined = f"({filter_expression}) AND {tenant_clause}"
    else:
        combined = tenant_clause

    values[placeholder] = tenant_id
    return combined, json.dumps(values)
