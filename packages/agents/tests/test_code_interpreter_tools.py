"""
Tests for code_interpreter_tools module.

These tests lock in the service-name regression fix from rabbithole-04: the
AgentCore data-plane service is `bedrock-agentcore`, NOT
`bedrock-agentcore-runtime`. The old name silently produced a
`CodeInterpreterUnavailableError` in production and every sandbox call fell
through to regex-based CDK validation, so the sandbox effectively never ran.

If anyone re-introduces the old name, these tests will fail.
"""

from __future__ import annotations

import importlib
from unittest.mock import MagicMock, patch

import pytest

import tools.code_interpreter_tools as code_interpreter_tools
from tools.code_interpreter_tools import (
    CodeInterpreterUnavailableError,
    _get_agentcore_client,
)


@pytest.fixture(autouse=True)
def _reset_session_cache():
    """Clear the module-level session cache between tests so state doesn't leak."""
    code_interpreter_tools._active_sessions.clear()
    yield
    code_interpreter_tools._active_sessions.clear()


@pytest.fixture(autouse=True)
def _force_shim_enabled(monkeypatch):
    """
    Ensure the kill-switch env var is enabled (or absent) for these tests so
    we actually exercise the boto3 code path. Tests that want to verify the
    kill-switch disable it explicitly.
    """
    monkeypatch.delenv("CODE_INTERPRETER_USE_AGENTCORE_SHIM", raising=False)
    yield


class TestServiceNameRegression:
    """
    Lock in the rabbithole-04 fix: boto3.client must be called with
    'bedrock-agentcore', not 'bedrock-agentcore-runtime'.
    """

    def test_uses_bedrock_agentcore_service_name(self, monkeypatch):
        """_get_agentcore_client must call boto3.client('bedrock-agentcore', ...)."""
        monkeypatch.setenv("AWS_REGION", "us-west-2")
        fake_client = MagicMock(name="fake-agentcore-client")

        with patch.object(
            code_interpreter_tools.boto3, "client", return_value=fake_client
        ) as mock_boto3:
            result = _get_agentcore_client()

        assert result is fake_client
        assert mock_boto3.call_count == 1
        # First positional argument is the service name.
        args, kwargs = mock_boto3.call_args
        service_name = args[0] if args else kwargs.get("service_name")
        assert service_name == "bedrock-agentcore", (
            f"Expected boto3.client to be called with 'bedrock-agentcore' "
            f"(the AgentCore data plane). Got: {service_name!r}. "
            f"See docs/research/agentcore-rabbithole/"
            f"04-code-interpreter-browser-deep-dive.md."
        )

    def test_does_not_use_legacy_runtime_service_name(self, monkeypatch):
        """
        Explicit regression guard: the old wrong name must never be used.

        This test asserts that we never pass a service name that ends in
        '-runtime' to boto3.client for AgentCore. If this fails, the
        rabbithole-04 regression has been reintroduced.
        """
        fake_client = MagicMock()
        with patch.object(
            code_interpreter_tools.boto3, "client", return_value=fake_client
        ) as mock_boto3:
            _get_agentcore_client()

        args, kwargs = mock_boto3.call_args
        service_name = args[0] if args else kwargs.get("service_name")
        assert not service_name.endswith("-runtime"), (
            f"Service name {service_name!r} ends with '-runtime', which was "
            f"the original bug. The AgentCore data plane is 'bedrock-agentcore'."
        )

    def test_boto3_failure_raises_unavailable_error(self, monkeypatch):
        """
        If boto3 can't find the service model, we must raise
        CodeInterpreterUnavailableError so callers fall back to regex
        validation instead of crashing.

        Uses UnknownServiceError (a BotoCoreError subclass) because that is
        what boto3 actually raises when the installed SDK lacks a service
        model — it is NOT a bare Exception. The tool's except clause is
        narrowed to (ClientError, BotoCoreError) so this test uses the
        realistic failure type.
        """
        from botocore.exceptions import UnknownServiceError

        unknown_service = UnknownServiceError(
            service_name="bedrock-agentcore",
            known_service_names=["s3", "ec2"],
        )
        with patch.object(
            code_interpreter_tools.boto3,
            "client",
            side_effect=unknown_service,
        ):
            with pytest.raises(CodeInterpreterUnavailableError) as exc_info:
                _get_agentcore_client()

        # The error message must reference the CORRECT service name so
        # operators don't chase the old bug.
        assert "bedrock-agentcore" in str(exc_info.value)

    def test_shim_kill_switch_forces_fallback(self, monkeypatch):
        """
        Operators can disable the AgentCore path entirely by setting
        CODE_INTERPRETER_USE_AGENTCORE_SHIM=false. When set, we must raise
        CodeInterpreterUnavailableError without ever calling boto3.client.
        """
        monkeypatch.setenv("CODE_INTERPRETER_USE_AGENTCORE_SHIM", "false")

        with patch.object(code_interpreter_tools.boto3, "client") as mock_boto3:
            with pytest.raises(CodeInterpreterUnavailableError):
                _get_agentcore_client()

        assert mock_boto3.call_count == 0, (
            "Kill-switch must short-circuit before boto3.client is invoked."
        )

    def test_shim_kill_switch_accepts_multiple_false_values(self, monkeypatch):
        """Accept 'false', '0', 'no', 'off' as disable values (case-insensitive)."""
        for value in ("false", "False", "FALSE", "0", "no", "off"):
            monkeypatch.setenv("CODE_INTERPRETER_USE_AGENTCORE_SHIM", value)
            with patch.object(code_interpreter_tools.boto3, "client"):
                with pytest.raises(CodeInterpreterUnavailableError):
                    _get_agentcore_client()


class TestSourceLevelRegressionGuard:
    """
    Belt-and-suspenders: the literal string 'bedrock-agentcore-runtime' must
    not appear anywhere in code_interpreter_tools.py source, even in comments,
    because any accidental copy-paste of the old name back into the boto3 call
    would reintroduce the bug.
    """

    def test_source_does_not_contain_legacy_service_name(self):
        import pathlib

        source_path = pathlib.Path(code_interpreter_tools.__file__)
        source = source_path.read_text()
        assert "bedrock-agentcore-runtime" not in source, (
            "The legacy service name 'bedrock-agentcore-runtime' appeared in "
            f"{source_path}. Use 'bedrock-agentcore' (the data plane) instead. "
            "See rabbithole-04."
        )
