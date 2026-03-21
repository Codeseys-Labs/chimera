"""
Hello World Tool - Proves the agent loop works

This is a minimal tool to validate:
1. Strands @tool decorator works
2. Tool is loaded into agent
3. Agent can invoke tools via ReAct loop
4. Tool execution returns to agent
"""
from strands.tools import tool


@tool
def hello_world_tool(name: str = "World") -> str:
    """
    Say hello to someone.

    Args:
        name: The name to greet (default: "World")

    Returns:
        A friendly greeting message
    """
    return f"Hello, {name}! The Chimera agent is working correctly."
