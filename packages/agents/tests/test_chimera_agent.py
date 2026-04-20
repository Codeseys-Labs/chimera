"""
Unit tests for packages/agents/chimera_agent.py.

Primary focus: the canonical AgentCore Memory namespace format used for
IAM condition-key enforcement on ``bedrock-agentcore:namespace``. The
namespace MUST:

1. Be slash-delimited per the AgentCore runtime contract.
2. Embed tenantId inside the actor segment so IAM
   ``StringLike`` conditions of the shape
   ``/strategy/*/actor/tenant-{id}-*/...`` can scope access per-tenant.
3. End with a mandatory trailing slash so prefix matches cannot leak
   across actors whose ids share a prefix (``Alice`` vs ``Alice-admin``).

The test module injects stub modules for ``strands``, ``strands.models.bedrock``,
``bedrock_agentcore.runtime`` (top-level ``entrypoint`` symbol), ``bedrock_agentcore.memory.integrations.strands``,
``gateway_config``, and ``system_prompt`` before importing ``chimera_agent``
so the canonical namespace helpers remain unit-testable even when the
SDK re-exports drift or the runtime dependencies are partially installed.
"""
from __future__ import annotations

import sys
import types

import pytest


def _install_stub(name: str, **attrs) -> types.ModuleType:
    """Inject a module into ``sys.modules`` carrying the given attributes."""
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


@pytest.fixture(scope="module", autouse=True)
def _chimera_agent_importable():
    """
    Shim out chimera_agent's third-party imports for the duration of the
    module's tests. Without this, importing ``chimera_agent`` can fail on
    CI runners where the bedrock-agentcore runtime re-exports drift away
    from the top-level ``entrypoint`` symbol the agent module expects.

    The fixture carefully records which module names it injected and only
    restores/deletes those, so real modules that happened to be imported
    earlier in the session (notably ``gateway_config`` and ``system_prompt``,
    which other tests rely on) are handed back intact after teardown.
    """

    class _StubAgent:  # pragma: no cover - only needs to exist
        def __init__(self, *a, **kw): ...

    class _StubBedrockModel:  # pragma: no cover
        def __init__(self, *a, **kw): ...

    class _StubBedrockAgentCoreApp:  # pragma: no cover
        def __init__(self, *a, **kw): ...

    class _StubSessionManager:  # pragma: no cover
        def __init__(self, *a, **kw): ...

    def _stub_entrypoint(func):  # pragma: no cover
        return func

    class _StubGatewayToolDiscovery:  # pragma: no cover
        def __init__(self, *a, **kw): ...

        def discover_tools(self, *a, **kw):
            return []

    stubs = {
        "strands": {"Agent": _StubAgent},
        "strands.models": {},
        "strands.models.bedrock": {"BedrockModel": _StubBedrockModel},
        "bedrock_agentcore": {},
        "bedrock_agentcore.runtime": {
            "BedrockAgentCoreApp": _StubBedrockAgentCoreApp,
            "entrypoint": _stub_entrypoint,
        },
        "bedrock_agentcore.runtime.context": {},
        "bedrock_agentcore.memory": {},
        "bedrock_agentcore.memory.integrations": {},
        "bedrock_agentcore.memory.integrations.strands": {
            "AgentCoreMemorySessionManager": _StubSessionManager,
        },
        "gateway_config": {"GatewayToolDiscovery": _StubGatewayToolDiscovery},
        "system_prompt": {
            "CHIMERA_SYSTEM_PROMPT": "stub system prompt",
            "wrap_untrusted_content": lambda text, source=None: text,
        },
    }

    # Snapshot any real modules we're about to shadow so we can restore them
    # on teardown instead of leaving stubs in place for later test modules.
    originals: dict[str, types.ModuleType | None] = {
        name: sys.modules.get(name) for name in stubs
    }

    for name, attrs in stubs.items():
        _install_stub(name, **attrs)

    # Flush any prior import so stubs take effect.
    chimera_original = sys.modules.pop("chimera_agent", None)

    try:
        yield
    finally:
        # Restore real modules (or remove the stub if nothing was there before)
        # so subsequent test modules — e.g. test_gateway_config — import the
        # genuine packages. Also evict our cached stubbed ``chimera_agent``
        # so future imports rebuild against whatever the environment provides.
        sys.modules.pop("chimera_agent", None)
        if chimera_original is not None:
            sys.modules["chimera_agent"] = chimera_original

        for name, original in originals.items():
            if original is not None:
                sys.modules[name] = original
            else:
                sys.modules.pop(name, None)


@pytest.fixture(scope="module")
def chimera_agent(_chimera_agent_importable):
    import chimera_agent as module  # noqa: WPS433 — late import is intentional

    return module


class TestBuildAgentCoreNamespace:
    """Exercise the ``_build_agentcore_namespace`` helper."""

    def test_canonical_format_with_trailing_slash(self, chimera_agent):
        """The happy path format must match the AgentCore contract exactly."""
        result = chimera_agent._build_agentcore_namespace(
            "summaryStrategy", "acme", "bob", "sess-123"
        )
        assert result == (
            "/strategy/summaryStrategy/actor/tenant-acme-user-bob/session/sess-123/"
        )

    def test_trailing_slash_is_mandatory(self, chimera_agent):
        """The namespace must end with a trailing slash (prefix-collision guard)."""
        result = chimera_agent._build_agentcore_namespace(
            "semanticMemoryStrategy", "tenant-a", "user-a", "sess-a"
        )
        assert result.endswith("/"), (
            "AgentCore namespaces require a trailing slash to avoid "
            "prefix collisions between ``Alice`` and ``Alice-admin``."
        )

    def test_leading_slash_is_mandatory(self, chimera_agent):
        """The namespace must be absolute — IAM policies match the leading /."""
        result = chimera_agent._build_agentcore_namespace(
            "userPreferenceMemoryStrategy", "acme", "bob", "sess-123"
        )
        assert result.startswith("/strategy/")

    def test_actor_segment_embeds_tenant_then_user(self, chimera_agent):
        """IAM conditions rely on ``tenant-{id}-user-*`` ordering inside actor."""
        result = chimera_agent._build_agentcore_namespace(
            "summaryStrategy", "acme", "bob", "sess-123"
        )
        # The segment that follows /actor/ must start with tenant-{id}- so
        # IAM wildcards of the form /actor/tenant-acme-* match exclusively
        # tenant acme and never another tenant whose userId happens to be
        # "acme".
        assert "/actor/tenant-acme-user-bob/" in result

    @pytest.mark.parametrize(
        "strategy",
        [
            "summaryStrategy",
            "userPreferenceMemoryStrategy",
            "semanticMemoryStrategy",
        ],
    )
    def test_all_tier_strategies_produce_valid_namespace(self, chimera_agent, strategy):
        """Every strategy the tiers enable must round-trip through the helper."""
        result = chimera_agent._build_agentcore_namespace(
            strategy, "t1", "u1", "s1"
        )
        assert result == f"/strategy/{strategy}/actor/tenant-t1-user-u1/session/s1/"


class TestGetMemoryConfigForTier:
    """The tier-to-strategy map must use canonical SDK identifier strings."""

    def test_basic_tier_enables_summary_only(self, chimera_agent):
        cfg = chimera_agent.get_memory_config_for_tier("basic")
        assert cfg["strategies"] == ["summaryStrategy"]

    def test_advanced_tier_adds_user_preference(self, chimera_agent):
        cfg = chimera_agent.get_memory_config_for_tier("advanced")
        assert cfg["strategies"] == [
            "summaryStrategy",
            "userPreferenceMemoryStrategy",
        ]

    def test_premium_tier_enables_all_three_strategies(self, chimera_agent):
        cfg = chimera_agent.get_memory_config_for_tier("premium")
        assert cfg["strategies"] == [
            "summaryStrategy",
            "userPreferenceMemoryStrategy",
            "semanticMemoryStrategy",
        ]

    def test_unknown_tier_falls_back_to_basic(self, chimera_agent):
        cfg = chimera_agent.get_memory_config_for_tier("nonexistent")
        assert cfg["strategies"] == ["summaryStrategy"]


class TestResolveRuntimeSessionId:
    """
    ``_resolve_runtime_session_id`` must pull from the AgentCore Runtime
    ContextVar when present and fall through to environment/sentinel
    otherwise so namespace construction never blows up.
    """

    def test_falls_back_to_env_when_no_runtime_context(self, chimera_agent, monkeypatch):
        monkeypatch.setenv("AGENTCORE_SESSION_ID", "env-session-42")
        assert chimera_agent._resolve_runtime_session_id() == "env-session-42"

    def test_falls_back_to_local_sentinel_when_env_missing(self, chimera_agent, monkeypatch):
        monkeypatch.delenv("AGENTCORE_SESSION_ID", raising=False)
        assert chimera_agent._resolve_runtime_session_id() == "local-session"
