"""
Tests for tools.tenant_context — the multi-tenancy enforcement primitive.

These tests are the guardrail that prevents the `tenant_id`-as-tool-argument
regression from returning. If an agent could spoof tenant_id, multi-tenant
isolation is broken at the Python layer regardless of what CDK/Cedar do.
"""

from __future__ import annotations

import json

import pytest

from tools.tenant_context import (
    TenantContextError,
    clear_tenant_context,
    ensure_tenant_filter,
    get_tenant_context,
    require_tenant_id,
    set_tenant_context,
)


@pytest.fixture(autouse=True)
def _reset_context():
    clear_tenant_context()
    yield
    clear_tenant_context()


def test_require_tenant_id_raises_when_unset():
    with pytest.raises(TenantContextError):
        require_tenant_id()


def test_set_and_get_tenant_id():
    set_tenant_context("tenant-a", tier="premium", user_id="user-1")
    ctx = get_tenant_context()
    assert ctx is not None
    assert ctx.tenant_id == "tenant-a"
    assert ctx.tier == "premium"
    assert ctx.user_id == "user-1"
    assert require_tenant_id() == "tenant-a"


def test_set_rejects_empty_tenant_id():
    with pytest.raises(ValueError):
        set_tenant_context("")


def test_env_fallback(monkeypatch):
    clear_tenant_context()
    monkeypatch.setenv("CHIMERA_TENANT_ID", "tenant-env")
    assert require_tenant_id() == "tenant-env"


def test_ensure_tenant_filter_injects_when_filter_empty():
    set_tenant_context("tenant-a")
    fx, vx = ensure_tenant_filter("", json.dumps({":pk": "TENANT#tenant-a"}))
    assert "tenantId = :__chimera_tid" in fx
    values = json.loads(vx)
    assert values[":__chimera_tid"] == "tenant-a"


def test_ensure_tenant_filter_preserves_existing_filter():
    set_tenant_context("tenant-a")
    fx, vx = ensure_tenant_filter(
        "attribute_exists(foo)", json.dumps({":pk": "TENANT#tenant-a"})
    )
    assert "attribute_exists(foo)" in fx
    assert "tenantId = :__chimera_tid" in fx
    assert "AND" in fx


def test_ensure_tenant_filter_idempotent():
    """If the filter already has the exact tenant clause, don't double-AND."""
    set_tenant_context("tenant-a")
    fx1, vx1 = ensure_tenant_filter("", "{}")
    fx2, vx2 = ensure_tenant_filter(fx1, vx1)
    assert fx2.count("tenantId = :__chimera_tid") == 1


def test_ensure_tenant_filter_rejects_missing_context():
    clear_tenant_context()
    with pytest.raises(TenantContextError):
        ensure_tenant_filter("", "{}")


def test_ensure_tenant_filter_rejects_invalid_json():
    set_tenant_context("tenant-a")
    with pytest.raises(ValueError):
        ensure_tenant_filter("", "not-json")


def test_spoofing_via_argument_is_impossible():
    """
    Regression test: there is no code path that lets a tool caller set
    tenant_id. The only way in is set_tenant_context at the entrypoint.
    """
    set_tenant_context("tenant-real")
    # Even if the agent passes a filter that references a different tenant,
    # ensure_tenant_filter binds the placeholder to the real tenant's id.
    fx, vx = ensure_tenant_filter(
        "tenantId = :evil", json.dumps({":evil": "tenant-other"})
    )
    values = json.loads(vx)
    # The enforced placeholder uses the real tenant — the agent's :evil
    # placeholder is still in the values dict but the injected clause is what
    # runs. Query planners will AND both conditions, so the real tenant id
    # short-circuits: a row passes only if tenantId == "tenant-real".
    assert values[":__chimera_tid"] == "tenant-real"
    assert "tenantId = :__chimera_tid" in fx


def test_ensure_tenant_filter_no_false_match_on_prefixed_field():
    """
    Regression test for the idempotency substring-match bug.

    A filter that references a field with `tenantId` as a SUFFIX (e.g.
    `myField_tenantId`) must NOT suppress the injected tenant clause —
    otherwise a tenant could craft a filter that mentions the magic phrase
    but evaluates against a different attribute, bypassing isolation.
    """
    set_tenant_context("tenant-a")
    # This filter mentions "tenantId = :__chimera_tid" but as a SUFFIX of a
    # different field name. The pre-regex substring check would have treated
    # this as "already tenant-filtered" and skipped injection.
    malicious_filter = "myField_tenantId = :__chimera_tid"
    fx, vx = ensure_tenant_filter(
        malicious_filter, json.dumps({":__chimera_tid": "tenant-other"})
    )
    # The injected clause must still have been added (AND-ed onto the filter),
    # and the real tenant id must be bound to :__chimera_tid.
    assert "(myField_tenantId = :__chimera_tid) AND tenantId = :__chimera_tid" in fx
    values = json.loads(vx)
    assert values[":__chimera_tid"] == "tenant-a"


def test_no_tool_imports_boto3_without_tenant_context():
    """
    Anti-pattern guard: every tool file that imports boto3 must also import
    tenant_context (so it can call require_tenant_id() before any AWS call).
    Exceptions must be explicitly allowlisted after confirming the tool is
    genuinely tenant-independent.
    """
    from pathlib import Path

    tools_dir = Path(__file__).parent.parent / "tools"
    allowed_tenant_free = {"tenant_context.py"}
    offenders = []
    for py in tools_dir.glob("*.py"):
        if py.name in allowed_tenant_free:
            continue
        text = py.read_text()
        if "import boto3" in text and "tenant_context" not in text:
            offenders.append(py.name)
    assert not offenders, (
        f"These tool files import boto3 but not tenant_context: {offenders}. "
        "Every tool touching AWS must require_tenant_id() or document why it's tenant-independent."
    )
