#!/usr/bin/env python3
"""
Terminal Chat REPL for Chimera Agent

Simple terminal interface for testing the Chimera agent locally.
Mocks the AgentCore Runtime context for local development.
"""
import asyncio
import sys
from typing import Dict, Any
from dataclasses import dataclass


# Mock AgentCore context for local testing
@dataclass
class MockAuth:
    """Mock authentication context"""
    claims: Dict[str, Any]


@dataclass
class MockSession:
    """Mock session metadata"""
    session_id: str = "local-test-session"


@dataclass
class MockContext:
    """Mock AgentCore Runtime context"""
    auth: MockAuth
    input_text: str
    session: MockSession


async def chat_repl():
    """
    Interactive REPL for chatting with the Chimera agent.

    Streams responses token-by-token to the terminal.
    """
    print("=" * 60)
    print("Chimera Agent - Terminal Chat")
    print("=" * 60)
    print("Type your message and press Enter.")
    print("Type 'exit' or 'quit' to end the session.")
    print("Type 'help' to see available commands.")
    print("=" * 60)
    print()

    # Import the agent handler
    try:
        from chimera_agent import handle
    except ImportError:
        print("ERROR: Could not import chimera_agent. Make sure you're in the packages/agents directory.")
        sys.exit(1)

    # Create mock context for local testing
    mock_context_base = MockContext(
        auth=MockAuth(claims={
            'tenantId': 'test-tenant',
            'tier': 'premium',  # Use premium tier to get all tools
            'userId': 'test-user',
        }),
        input_text="",
        session=MockSession(),
    )

    while True:
        try:
            # Get user input
            user_input = input("\n🧑 You: ").strip()

            if not user_input:
                continue

            # Handle special commands
            if user_input.lower() in ['exit', 'quit']:
                print("\n👋 Goodbye!")
                break

            if user_input.lower() == 'help':
                print("""
Available commands:
  - Type a message to chat with the agent
  - 'exit' or 'quit' to end the session
  - 'help' to see this message

Example queries:
  - "list my S3 buckets"
  - "show me EC2 instances"
  - "what buckets do I have?"
  - "describe instance i-1234567890abcdef0"
""")
                continue

            # Update context with user input
            mock_context = MockContext(
                auth=mock_context_base.auth,
                input_text=user_input,
                session=mock_context_base.session,
            )

            # Stream agent response
            print("\n🤖 Agent: ", end="", flush=True)

            try:
                async for chunk in handle(mock_context):
                    print(chunk, end="", flush=True)
                print()  # Newline after response

            except Exception as e:
                print(f"\n❌ Error: {str(e)}")
                print("This might happen if AWS credentials are not configured.")
                print("Set up AWS credentials with: aws configure")

        except KeyboardInterrupt:
            print("\n\n👋 Interrupted. Goodbye!")
            break
        except EOFError:
            print("\n\n👋 Goodbye!")
            break


def main():
    """
    Entry point for the chat REPL.
    """
    try:
        asyncio.run(chat_repl())
    except KeyboardInterrupt:
        print("\n👋 Goodbye!")
        sys.exit(0)


if __name__ == "__main__":
    main()
