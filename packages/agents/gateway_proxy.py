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
        payload = {
            'tool_name': service_identifier,
            'action': name,
            'tool_input': kwargs,
            'tenant_id': tenant_id,
        }
        try:
            response = lambda_client.invoke(
                FunctionName=target_arn,
                InvocationType='RequestResponse',
                Payload=json.dumps(payload).encode('utf-8'),
            )
            raw = response['Payload'].read()
            result = json.loads(raw)
            if isinstance(result, dict) and result.get('statusCode', 200) >= 400:
                return f"Error from gateway tool {name}: {result.get('error', result)}"
            if isinstance(result, dict) and 'result' in result:
                return str(result['result'])
            return str(result)
        except Exception as exc:
            logger.error("Gateway proxy error for tool %s: %s", name, exc)
            return f"Error invoking gateway tool {name}: {exc}"

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
