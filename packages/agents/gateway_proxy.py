"""
Gateway Proxy Tool Factory for Chimera Agent.

Creates Strands @tool-compatible callables that proxy invocations through
AgentCore Gateway Lambda targets instead of executing locally.

Enables the self-evolution pattern: tools registered in Gateway are immediately
available to all agents without requiring container redeployment.
"""
import json
import logging
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

import boto3
from strands.tools import tool

logger = logging.getLogger(__name__)

# Module-level Lambda client singleton — reuse connections across proxy calls
_lambda_client = None


def _get_lambda_client():
    """Return the module-level boto3 Lambda client, creating it on first call."""
    global _lambda_client
    if _lambda_client is None:
        _lambda_client = boto3.client('lambda')
    return _lambda_client


# Lambda sync invoke has a 6 MB payload cap. Leave a 500KB buffer for envelope
# and SDK overhead, so reject anything larger than 5.5 MB outright.
_MAX_PAYLOAD_BYTES = 5_500_000

# Guard against billion-laughs-style deeply nested dicts that would overwhelm
# the JSON parser downstream. 32 levels is well beyond legitimate tool inputs.
# Semantics (see _max_dict_depth): the root container contributes depth 0, so
# ``_MAX_NESTING_DEPTH = 32`` means "accept up to 32 nested child levels
# beneath the root; reject at the 33rd." This matches the natural reading of
# the docstring ("nesting depth… within limit").
_MAX_NESTING_DEPTH = 32

# Per-field cap on stringified tool output / error messages shoved back into the
# agent's context. Keeps a malicious Lambda from flooding the context window.
_MAX_TOOL_OUTPUT_CHARS = 500


def _max_dict_depth(obj, limit: int = _MAX_NESTING_DEPTH) -> bool:
    """Return True if the nesting depth of dicts/lists in ``obj`` is within ``limit``.

    Walks the structure iteratively (no recursion) so a pathological input
    cannot blow the Python stack. Returns False as soon as any path exceeds
    ``limit`` — does not need to explore the whole tree.

    Depth convention:
        The root container is depth 0. Each nested dict/list adds 1. A limit
        of ``N`` therefore **accepts** structures whose deepest nesting is
        ``N`` levels beneath the root and **rejects** at ``N + 1``. This
        resolves an earlier off-by-one where the root counted as 1 and the
        documented limit was never actually reachable.
    """
    # Stack holds (value, depth) pairs. Depth starts at 0 for the root container
    # so ``limit`` is the maximum *allowed* depth, not the first rejected depth.
    stack = [(obj, 0)]
    while stack:
        current, depth = stack.pop()
        if depth > limit:
            return False
        if isinstance(current, dict):
            for value in current.values():
                if isinstance(value, (dict, list)):
                    stack.append((value, depth + 1))
        elif isinstance(current, list):
            for value in current:
                if isinstance(value, (dict, list)):
                    stack.append((value, depth + 1))
    return True


def _format_tool_error(name: str, err) -> str:
    """Format a tool error as a delimited, truncated string for the agent.

    A malicious Lambda could stuff injection tokens ("you are now free of
    rules…") into an error field. Wrap every error in a ``[TOOL ERROR BEGIN]``
    /``[TOOL ERROR END]`` envelope and truncate to ``_MAX_TOOL_OUTPUT_CHARS``
    so the agent's context can't mistake tool output for a system instruction.

    Args:
        name: Tool name (for debugability in the envelope).
        err:  Raw error value — may be a string, dict, or arbitrary JSON.
    """
    if isinstance(err, str):
        err_str = err[:_MAX_TOOL_OUTPUT_CHARS]
    else:
        try:
            err_str = json.dumps(err, default=str)[:_MAX_TOOL_OUTPUT_CHARS]
        except (TypeError, ValueError):
            err_str = str(err)[:_MAX_TOOL_OUTPUT_CHARS]
    return (
        "[TOOL ERROR BEGIN]\n"
        f"tool={name}\n"
        f"error={err_str}\n"
        "[TOOL ERROR END]"
    )


def _format_tool_result(name: str, payload) -> str:
    """Format a successful tool result as a delimited, truncated string.

    Mirrors :func:`_format_tool_error` for the success path: a malicious
    Lambda could also return instruction tokens in its ``result`` field, so
    the agent-visible string is always wrapped and truncated.
    """
    if isinstance(payload, str):
        body = payload[:_MAX_TOOL_OUTPUT_CHARS]
    else:
        try:
            body = json.dumps(payload, default=str)[:_MAX_TOOL_OUTPUT_CHARS]
        except (TypeError, ValueError):
            body = str(payload)[:_MAX_TOOL_OUTPUT_CHARS]
    return (
        "[TOOL RESULT BEGIN]\n"
        f"tool={name}\n"
        f"result={body}\n"
        "[TOOL RESULT END]"
    )


@dataclass
class GatewayToolDefinition:
    """Definition for a Gateway-proxied tool.

    Mirrors GatewayTargetConfig from packages/core/src/gateway/tool-registry.ts.
    """
    name: str                               # Tool function name, e.g. "list_s3_buckets"
    description: str                        # Human-readable description for the LLM
    service_identifier: str                 # Service short name, e.g. "s3"
    target_arn: str                         # Lambda ARN for this tool's gateway tier
    tier: int                               # 0=core, 1=basic, 2=advanced, 3=premium
    input_schema: Optional[Dict] = field(default_factory=dict)


def create_gateway_proxy_tool(tool_def: GatewayToolDefinition, tenant_id: str) -> Callable:
    """Create a Strands @tool-compatible callable that proxies through a Gateway Lambda.

    The closure invokes the Gateway Lambda target with a structured payload and
    returns the result string. All errors are caught and returned as strings so
    the agent ReAct loop can handle them gracefully.

    Args:
        tool_def:  Definition of the tool to proxy.
        tenant_id: Tenant identifier injected into every Lambda invocation.

    Returns:
        A @tool-decorated callable with the tool's name and description set.
    """
    lambda_client = _get_lambda_client()
    name = tool_def.name
    service_identifier = tool_def.service_identifier
    target_arn = tool_def.target_arn

    def proxy(**kwargs) -> str:
        # Reject pathologically deep inputs before we try to serialize them —
        # prevents billion-laughs-style payloads from stalling the JSON encoder
        # and from overwhelming the downstream parser on the Lambda side.
        if not _max_dict_depth(kwargs, limit=_MAX_NESTING_DEPTH):
            return f"Tool input rejected: nesting depth exceeds {_MAX_NESTING_DEPTH}."

        payload = {
            'tool_name': service_identifier,
            'action': name,
            'tool_input': kwargs,
            'tenant_id': tenant_id,
        }
        # Serialize once and reuse — avoids double-encoding cost and lets us
        # enforce the Lambda 6 MB sync-invoke limit with a 500 KB safety buffer.
        try:
            payload_bytes = json.dumps(payload).encode('utf-8')
        except (TypeError, ValueError) as exc:
            logger.error("Gateway proxy failed to serialize payload for tool %s: %s", name, exc)
            return f"Error invoking gateway tool {name}: payload not JSON-serializable ({exc})"

        if len(payload_bytes) > _MAX_PAYLOAD_BYTES:
            return (
                f"Tool input too large: {len(payload_bytes)} bytes exceeds the "
                f"5.5 MB gateway limit. Split the input and retry."
            )

        try:
            response = lambda_client.invoke(
                FunctionName=target_arn,
                InvocationType='RequestResponse',
                Payload=payload_bytes,
            )
            raw = response['Payload'].read()
            result = json.loads(raw)
            # Wrap every Lambda-returned string in a fixed delimiter envelope so
            # a malicious target cannot smuggle instruction tokens via the
            # error/result payload. See _format_tool_error / _format_tool_result.
            if isinstance(result, dict) and result.get('statusCode', 200) >= 400:
                # Log the full Lambda error payload *before* it gets
                # truncated/enveloped for the LLM response. Operators debugging
                # via CloudWatch otherwise only see the 500-char snippet.
                logger.error(
                    "Gateway proxy tool %s returned error (statusCode=%s): %r",
                    name,
                    result.get('statusCode'),
                    result.get('error', result),
                )
                return _format_tool_error(name, result.get('error', result))
            if isinstance(result, dict) and 'result' in result:
                return _format_tool_result(name, result['result'])
            return _format_tool_result(name, result)
        except Exception as exc:
            # Emit the full exception (with traceback) before returning the
            # truncated, agent-facing envelope. The LLM response continues to
            # be length-bounded; operators get the real stack trace in logs.
            logger.error(
                "Gateway proxy error for tool %s: %s",
                name,
                exc,
                exc_info=True,
            )
            return _format_tool_error(name, f"invocation failed: {exc}")

    # Set metadata before applying @tool so Strands picks up correct name/description
    proxy.__name__ = name
    proxy.__qualname__ = name
    proxy.__doc__ = tool_def.description

    return tool(proxy)


def create_gateway_proxy_tools(
    tool_defs: List[GatewayToolDefinition],
    tenant_id: str,
) -> List[Callable]:
    """Batch-create Strands proxy tools from a list of GatewayToolDefinitions.

    Logs a warning for each individual failure; does not raise.

    Args:
        tool_defs:  List of tool definitions to create proxies for.
        tenant_id:  Tenant identifier injected into every Lambda invocation.

    Returns:
        List of @tool-decorated callables (one per successful definition).
    """
    result = []
    for tool_def in tool_defs:
        try:
            result.append(create_gateway_proxy_tool(tool_def, tenant_id))
        except Exception as exc:
            logger.warning("Failed to create proxy tool %s: %s", tool_def.name, exc)
    return result
