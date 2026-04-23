"""
Hello World Tool - Proves the agent loop works

This is a minimal tool to validate:
1. Strands @tool decorator works
2. Tool is loaded into agent
3. Agent can invoke tools via ReAct loop
4. Tool execution returns to agent

Production gating: this module exposes ``__production_excluded__ = True``
so ``GatewayToolDiscovery`` can drop it from the tool set when
``CHIMERA_ENV`` is ``prod`` / ``production``. See Wave-15 M3 in
``docs/reviews/OPEN-PUNCH-LIST.md``.
"""
from strands.tools import tool

from .gateway_instrumentation import instrument_tool

# Exclude this diagnostic tool from production tenant tool sets.
# The gateway discovery layer checks this sentinel when loading modules.
__production_excluded__ = True


@tool
@instrument_tool("hello_world_tool")
def hello_world_tool(name: str = "World") -> str:
    """
    Say hello to someone.

    Args:
        name: The name to greet (default: "World")

    Returns:
        A friendly greeting message
    """
    return f"Hello, {name}! The Chimera agent is working correctly."
