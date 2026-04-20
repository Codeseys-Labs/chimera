"""
Shared EMF (CloudWatch Embedded Metric Format) helpers for Chimera agents.

The Lambda / AgentCore runtime auto-publishes EMF-formatted JSON written to
stdout as CloudWatch metrics, so no ``PutMetricData`` IAM / API call is
required from the agent code. This module produces the canonical envelope
so every Python emitter in ``packages/agents`` ships metrics in a shape the
dashboards and alarms can consume.

Contract:
    * ``emit_emf_metric`` MUST NOT raise. Metric emission is best-effort —
      a broken stdout encoder must never take down a tool invocation or a
      user-facing request.
    * Dimension keys and values MUST be strings. The helper coerces
      non-string values to ``str`` defensively.
    * Dimension cardinality is the caller's responsibility. Per the
      cost-observability audit, ``tenant_id`` is an acceptable dimension
      but arbitrarily high-cardinality values (e.g. random UUIDs in every
      call) must be avoided — CloudWatch custom-metric charges scale with
      unique dimension combinations.

See ``infra/lambdas/skill-pipeline/skill-deployment/registry-writer.mjs``
for the JavaScript analogue; both emit the identical EMF JSON shape.
"""
from __future__ import annotations

import json
import time
from typing import Mapping


def emit_emf_metric(
    namespace: str,
    metric_name: str,
    value: float,
    unit: str,
    dimensions: Mapping[str, str],
) -> None:
    """Emit a CloudWatch EMF-formatted metric line to stdout.

    The Lambda runtime auto-publishes EMF metrics from log output, so this
    is the only step required to land the datapoint in CloudWatch. Never
    raises; all exceptions are swallowed.

    Args:
        namespace:   CloudWatch metric namespace, e.g. ``"Chimera/Agent"``.
        metric_name: Metric identifier, e.g. ``"tool_invocation_duration_ms"``.
        value:       Numeric datapoint (count, milliseconds, bytes, etc.).
        unit:        CloudWatch unit string, e.g. ``"Count"``,
                     ``"Milliseconds"``, ``"Bytes"``.
        dimensions:  Mapping of dimension name → value. All values are
                     coerced to ``str`` for CloudWatch compatibility.
    """
    try:
        # Coerce dimension values to strings defensively — CloudWatch
        # requires string dimension values.
        dim_map: dict[str, str] = {
            str(k): str(v) for k, v in dimensions.items()
        }

        envelope: dict[str, object] = {
            "_aws": {
                "Timestamp": int(time.time() * 1000),
                "CloudWatchMetrics": [
                    {
                        "Namespace": namespace,
                        "Dimensions": [list(dim_map.keys())],
                        "Metrics": [{"Name": metric_name, "Unit": unit}],
                    }
                ],
            },
            **dim_map,
            metric_name: value,
        }
        print(json.dumps(envelope))
    except Exception:
        # Never let metric emission break the caller. Silently dropping a
        # datapoint is strictly better than a tool invocation failing
        # because stdout/json choked.
        pass
