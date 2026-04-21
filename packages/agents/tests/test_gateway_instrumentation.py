"""
Tests for tools.gateway_instrumentation.

Covers:
  * duration measurement with a deterministic ``time.perf_counter``
  * EMF JSON shape conforms to the CloudWatch EMF spec
  * ``Success=1`` on normal return, ``Success=0`` on exception
  * no-tenant-context falls back to ``TenantId=unknown`` / ``Tier=unknown``
    and does not crash
  * instrumentation errors (e.g. a failing emitter) are swallowed and the
    wrapped tool's return value still reaches the caller
  * end-to-end composition with strands' ``@tool`` (decorator order is
    ``@tool`` outer, ``@instrument_tool`` inner)
"""
from __future__ import annotations

import json

import pytest

import tools.gateway_instrumentation as gi
from tools.gateway_instrumentation import instrument_tool
from tools.tenant_context import clear_tenant_context, set_tenant_context


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _emf_records(capsys) -> list[dict]:
    """Parse every line captured on stdout as an EMF JSON envelope."""
    out = capsys.readouterr().out.strip()
    if not out:
        return []
    records = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        records.append(json.loads(line))
    return records


# ---------------------------------------------------------------------------
# Duration measurement
# ---------------------------------------------------------------------------

class TestDurationMeasurement:
    def test_duration_ms_measured_from_perf_counter(self, capsys, monkeypatch):
        """``tool_invocation_duration_ms`` equals (end - start) * 1000."""
        times = iter([10.0, 10.250])  # 250 ms
        monkeypatch.setattr(gi.time, "perf_counter", lambda: next(times))

        @instrument_tool("fast_tool")
        def fn() -> str:
            return "ok"

        result = fn()
        assert result == "ok"

        records = _emf_records(capsys)
        duration_records = [
            r for r in records if "tool_invocation_duration_ms" in r
        ]
        assert len(duration_records) == 1
        assert duration_records[0]["tool_invocation_duration_ms"] == pytest.approx(
            250.0
        )

    def test_duration_measured_even_on_exception(self, capsys, monkeypatch):
        """Duration still emitted when the wrapped function raises."""
        times = iter([0.0, 0.005])  # 5 ms
        monkeypatch.setattr(gi.time, "perf_counter", lambda: next(times))

        @instrument_tool("boom_tool")
        def fn() -> str:
            raise ValueError("kaboom")

        with pytest.raises(ValueError, match="kaboom"):
            fn()

        records = _emf_records(capsys)
        duration_records = [
            r for r in records if "tool_invocation_duration_ms" in r
        ]
        assert len(duration_records) == 1
        assert duration_records[0]["tool_invocation_duration_ms"] == pytest.approx(
            5.0
        )


# ---------------------------------------------------------------------------
# EMF shape
# ---------------------------------------------------------------------------

class TestEmfShape:
    def test_emf_envelope_matches_spec(self, capsys, monkeypatch):
        """Records carry _aws.CloudWatchMetrics + top-level metric values."""
        times = iter([0.0, 0.001])
        monkeypatch.setattr(gi.time, "perf_counter", lambda: next(times))

        @instrument_tool("shape_tool")
        def fn() -> int:
            return 42

        fn()

        records = _emf_records(capsys)
        assert len(records) == 2  # duration + Success

        for record in records:
            # Spec-required envelope
            assert "_aws" in record
            assert "Timestamp" in record["_aws"]
            assert isinstance(record["_aws"]["Timestamp"], int)
            assert "CloudWatchMetrics" in record["_aws"]

            cw_metrics = record["_aws"]["CloudWatchMetrics"]
            assert len(cw_metrics) == 1
            directive = cw_metrics[0]

            # Namespace + dimension group + metric definition
            assert directive["Namespace"] == "Chimera/Tools"
            assert directive["Dimensions"] == [
                ["Service", "TenantId", "Tier", "ToolName"]
            ]
            assert len(directive["Metrics"]) == 1

            metric_def = directive["Metrics"][0]
            assert metric_def["Name"] in {
                "tool_invocation_duration_ms",
                "Success",
            }

            # Dimension values at the top level
            assert "Service" in record
            assert "TenantId" in record
            assert "Tier" in record
            assert "ToolName" in record
            assert record["ToolName"] == "shape_tool"

            # Metric value at the top level
            assert metric_def["Name"] in record

    def test_tenant_dimensions_populated_from_context(self, capsys, monkeypatch):
        times = iter([0.0, 0.0])
        monkeypatch.setattr(gi.time, "perf_counter", lambda: next(times))

        # conftest sets ("test-tenant", tier="premium") — override for clarity
        set_tenant_context("acme-co", tier="enterprise", user_id="u1")

        @instrument_tool("tagged_tool")
        def fn() -> str:
            return "ok"

        fn()

        records = _emf_records(capsys)
        assert records, "expected EMF records on stdout"
        for record in records:
            assert record["TenantId"] == "acme-co"
            assert record["Tier"] == "enterprise"
            assert record["ToolName"] == "tagged_tool"


# ---------------------------------------------------------------------------
# Success=1 / Success=0
# ---------------------------------------------------------------------------

class TestSuccessMetric:
    def test_success_one_on_normal_return(self, capsys, monkeypatch):
        times = iter([0.0, 0.0])
        monkeypatch.setattr(gi.time, "perf_counter", lambda: next(times))

        @instrument_tool("good_tool")
        def fn() -> str:
            return "ok"

        fn()

        records = _emf_records(capsys)
        success_records = [r for r in records if "Success" in r and "_aws" in r]
        assert len(success_records) == 1
        assert success_records[0]["Success"] == 1.0

    def test_success_zero_on_exception(self, capsys, monkeypatch):
        times = iter([0.0, 0.0])
        monkeypatch.setattr(gi.time, "perf_counter", lambda: next(times))

        @instrument_tool("bad_tool")
        def fn() -> str:
            raise RuntimeError("oops")

        with pytest.raises(RuntimeError):
            fn()

        records = _emf_records(capsys)
        success_records = [r for r in records if "Success" in r and "_aws" in r]
        assert len(success_records) == 1
        assert success_records[0]["Success"] == 0.0

    def test_success_zero_on_base_exception(self, capsys, monkeypatch):
        """Even KeyboardInterrupt-style BaseExceptions mark Success=0."""
        times = iter([0.0, 0.0])
        monkeypatch.setattr(gi.time, "perf_counter", lambda: next(times))

        @instrument_tool("interrupted_tool")
        def fn() -> str:
            raise KeyboardInterrupt()

        with pytest.raises(KeyboardInterrupt):
            fn()

        records = _emf_records(capsys)
        success_records = [r for r in records if "Success" in r and "_aws" in r]
        assert len(success_records) == 1
        assert success_records[0]["Success"] == 0.0


# ---------------------------------------------------------------------------
# No-tenant-context fallback
# ---------------------------------------------------------------------------

class TestNoTenantContext:
    def test_emits_with_unknown_tenant_when_context_absent(
        self, capsys, monkeypatch
    ):
        """No crash, dimensions fall back to 'unknown'."""
        # Tear down the autouse tenant context for this test only
        clear_tenant_context()
        # Also clear any env fallback set by get_tenant_context()
        monkeypatch.delenv("CHIMERA_TENANT_ID", raising=False)
        monkeypatch.delenv("CHIMERA_TENANT_TIER", raising=False)

        times = iter([0.0, 0.0])
        monkeypatch.setattr(gi.time, "perf_counter", lambda: next(times))

        @instrument_tool("orphan_tool")
        def fn() -> str:
            return "ok"

        # Must not raise
        assert fn() == "ok"

        records = _emf_records(capsys)
        assert records, "expected EMF records even without tenant context"
        for record in records:
            assert record["TenantId"] == "unknown"
            assert record["Tier"] == "unknown"
            assert record["ToolName"] == "orphan_tool"

    def test_get_tenant_context_raising_is_swallowed(
        self, capsys, monkeypatch
    ):
        """A crash inside get_tenant_context still produces 'unknown' dims."""
        def boom():
            raise RuntimeError("context lookup broken")

        monkeypatch.setattr(gi, "get_tenant_context", boom)

        times = iter([0.0, 0.0])
        monkeypatch.setattr(gi.time, "perf_counter", lambda: next(times))

        @instrument_tool("resilient_tool")
        def fn() -> str:
            return "ok"

        assert fn() == "ok"

        records = _emf_records(capsys)
        assert records
        for record in records:
            assert record["TenantId"] == "unknown"
            assert record["Tier"] == "unknown"


# ---------------------------------------------------------------------------
# Instrumentation error swallowing
# ---------------------------------------------------------------------------

class TestInstrumentationSwallowsErrors:
    def test_emitter_failure_does_not_break_tool(self, monkeypatch, caplog):
        """If the emit path raises, the tool's return value still propagates."""
        import logging

        def broken_emit(*args, **kwargs):
            raise TypeError("json broke")

        # Break the underlying EMF emitter; wrapper must swallow + log.
        monkeypatch.setattr(gi, "emit_emf_metric", broken_emit)

        @instrument_tool("insulated_tool")
        def fn(x: int) -> int:
            return x * 2

        with caplog.at_level(logging.WARNING, logger=gi.__name__):
            result = fn(21)

        assert result == 42
        warn_messages = [
            r.getMessage() for r in caplog.records if r.levelno == logging.WARNING
        ]
        assert any(
            "gateway_instrumentation" in m and "insulated_tool" in m
            for m in warn_messages
        ), f"expected a WARN log, got {warn_messages!r}"

    def test_emitter_failure_preserves_exception_from_tool(
        self, monkeypatch, caplog
    ):
        """Tool exception still propagates even when emit also fails."""
        import logging

        def broken_emit(*args, **kwargs):
            raise TypeError("json broke")

        monkeypatch.setattr(gi, "emit_emf_metric", broken_emit)

        @instrument_tool("double_failure_tool")
        def fn() -> str:
            raise ValueError("original failure")

        with caplog.at_level(logging.WARNING, logger=gi.__name__):
            with pytest.raises(ValueError, match="original failure"):
                fn()


# ---------------------------------------------------------------------------
# functools.wraps preservation (so strands @tool can still introspect)
# ---------------------------------------------------------------------------

class TestWrapsPreservation:
    def test_wrapper_preserves_name_and_docstring(self):
        @instrument_tool("docs_tool")
        def fn(arg: str) -> str:
            """Do something useful."""
            return arg

        assert fn.__name__ == "fn"
        assert fn.__doc__ == "Do something useful."
        assert fn.__wrapped__.__name__ == "fn"

    def test_composes_with_strands_tool_decorator(self):
        """The canonical decoration order (@tool outer, @instrument inner)
        produces a valid strands tool whose spec carries the docstring.
        """
        from strands.tools import tool

        @tool
        @instrument_tool("composed_tool")
        def composed_tool(name: str = "World") -> str:
            """Say hello to someone."""
            return f"Hello, {name}"

        # strands introspection succeeded — i.e. the wrapped function's
        # signature survived the decorator stack.
        assert composed_tool.tool_name == "composed_tool"
        spec = composed_tool.tool_spec
        assert "description" in spec
        assert "Say hello" in spec["description"]
