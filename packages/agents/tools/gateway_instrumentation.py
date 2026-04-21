"""
Per-tool invocation instrumentation for Chimera agents.

Emits two EMF-formatted CloudWatch metrics per tool call, at the
``Chimera/Tools`` namespace, with dimensions
``{Service, TenantId, Tier, ToolName}``:

    * ``tool_invocation_duration_ms`` (Milliseconds) — wall-clock
      duration of the tool function from entry to return/raise,
      measured with ``time.perf_counter``.
    * ``Success`` (Count, 0 or 1) — 1 when the wrapped function
      returned normally, 0 when it raised. Charted together they give
      both latency and reliability per-tenant, per-tool.

This is the third CRITICAL per-tenant observability metric from
``docs/research/cost-observability-audit.md``. The first two
(``chimera:model:tier_violation_count`` and
``chimera:agent:loop_iterations``) shipped in commit ``c29745c``; see
``observability.py`` for the shared EMF emitter that this module
builds on.

Contract:
    * Instrumentation MUST NOT break the wrapped tool. Any exception
      inside the instrumentation path (e.g. a broken stdout encoder,
      a context lookup failure) is caught and logged at ``WARNING``.
      The tool's own exceptions still propagate to the caller — we
      only swallow *our own* bookkeeping errors.
    * No tenant context is not a failure: we emit with
      ``TenantId=unknown`` / ``Tier=unknown`` so local smoke tests and
      pre-handler paths still record latency.
    * The wrapped function is untouched; its return value (or raised
      exception) is returned verbatim.

Usage::

    from .gateway_instrumentation import instrument_tool

    @tool
    @instrument_tool("hello_world_tool")
    def hello_world_tool(name: str = "World") -> str:
        ...

Decorator order matters: ``@instrument_tool`` must sit *inside*
strands' ``@tool`` so strands introspects the wrapped function (whose
signature is preserved by ``functools.wraps``) and the timing wrapper
runs at the actual invocation site.
"""
from __future__ import annotations

import functools
import logging
import os
import time
from typing import Any, Callable, TypeVar

from .tenant_context import get_tenant_context
from observability import emit_emf_metric

_LOG = logging.getLogger(__name__)

_NAMESPACE = "Chimera/Tools"
_SERVICE_NAME = os.environ.get("CHIMERA_SERVICE_NAME", "chimera-agents")

F = TypeVar("F", bound=Callable[..., Any])


def _dimensions_for(tool_name: str) -> dict[str, str]:
    """Build the EMF dimension map. Never raises."""
    try:
        ctx = get_tenant_context()
    except Exception:  # pragma: no cover — defensive
        ctx = None

    tenant_id = ctx.tenant_id if ctx is not None else "unknown"
    tier = ctx.tier if ctx is not None else "unknown"
    return {
        "Service": _SERVICE_NAME,
        "TenantId": tenant_id,
        "Tier": tier,
        "ToolName": tool_name,
    }


def _emit(tool_name: str, duration_ms: float, success: bool) -> None:
    """Emit both metrics. All failures are swallowed with a WARN log."""
    try:
        dims = _dimensions_for(tool_name)
        emit_emf_metric(
            namespace=_NAMESPACE,
            metric_name="tool_invocation_duration_ms",
            value=float(duration_ms),
            unit="Milliseconds",
            dimensions=dims,
        )
        emit_emf_metric(
            namespace=_NAMESPACE,
            metric_name="Success",
            value=1.0 if success else 0.0,
            unit="Count",
            dimensions=dims,
        )
    except Exception as exc:  # noqa: BLE001 — observability must never break tools
        _LOG.warning(
            "gateway_instrumentation: failed to emit metric for %s: %s",
            tool_name,
            exc,
        )


def instrument_tool(tool_name: str) -> Callable[[F], F]:
    """Return a decorator that emits per-invocation EMF metrics.

    The decorator measures wall-clock duration with
    ``time.perf_counter`` and emits:

        * ``tool_invocation_duration_ms`` — duration in milliseconds.
        * ``Success`` — ``1`` on normal return, ``0`` on exception.

    Both metrics share dimensions ``{Service, TenantId, Tier,
    ToolName}`` at namespace ``Chimera/Tools``. When no tenant context
    is in scope (e.g. a local smoke test before the AgentCore
    entrypoint runs), dimensions fall back to ``unknown`` rather than
    crashing.

    Args:
        tool_name: Stable identifier for the tool. This becomes the
            ``ToolName`` dimension value. Keep it short and stable —
            CloudWatch custom-metric charges scale with unique
            dimension combinations.

    Returns:
        A decorator suitable for application *inside* strands'
        ``@tool`` decorator (i.e. innermost).
    """

    def decorator(func: F) -> F:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            start = time.perf_counter()
            success = True
            try:
                return func(*args, **kwargs)
            except BaseException:
                success = False
                raise
            finally:
                duration_ms = (time.perf_counter() - start) * 1000.0
                _emit(tool_name, duration_ms, success)

        return wrapper  # type: ignore[return-value]

    return decorator


__all__ = ["instrument_tool"]
