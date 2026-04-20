"""
Shared pytest fixtures for packages/agents.

Most tools call `require_tenant_id()` at the top of their body, which raises
`TenantContextError` when no tenant context is set. Unit tests don't run inside
the AgentCore entrypoint, so we install a default tenant context for every test
here. Individual tests can override (or clear) it if they exercise the no-context
error path explicitly.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _default_tenant_context():
    """
    Set a default tenant context for every test in packages/agents.

    Tests that need to verify the no-context error path can clear the context
    inside their test body via `clear_tenant_context()`.
    """
    from tools.tenant_context import clear_tenant_context, set_tenant_context

    set_tenant_context("test-tenant", tier="premium", user_id="test-user")
    yield
    clear_tenant_context()
