# Strands Agents Advanced: Memory, Multi-Agent & Sessions

> **Series**: AWS Bedrock AgentCore and Strands Agents Research
> **Document**: 05 of series
> **Date**: 2026-03-19
> **Status**: Complete
> **Related**: [[04-Strands-Agents-Core]] | [[06-AWS-Services-Agent-Infrastructure]] | [[01-AgentCore-Architecture-Runtime]]

---

## Executive Summary

Strands Agents SDK (v1.30.0+, Apache 2.0, 5300+ GitHub stars) provides production-grade primitives for building stateful, multi-agent AI systems. This document covers the advanced features beyond the core agent loop: memory persistence, session management, multi-agent orchestration patterns (Swarm, Graph, Workflow, Agents-as-Tools), the Agent-to-Agent (A2A) protocol, state management strategies, conversation management, interrupt handling, and streaming patterns. These features collectively enable the construction of sophisticated, resumable, distributed agent architectures suitable for production deployment.

---

## Table of Contents

- [[#1. State Management Architecture]]
- [[#2. Session Management & Persistence]]
- [[#3. Conversation Management]]
- [[#4. Memory Architecture — Short-Term & Long-Term]]
- [[#5. Multi-Agent Orchestration Patterns]]
- [[#6. Agent-to-Agent (A2A) Protocol]]
- [[#7. Streaming & Async Patterns]]
- [[#8. Interrupt Handling & Human-in-the-Loop]]
- [[#9. Integration with External Storage]]
- [[#10. Advanced Tool Patterns]]
- [[#11. Production Patterns & Best Practices]]
- [[#12. Sources & References]]

---

## 1. State Management Architecture

Strands agents maintain state in three distinct layers, each with different scope, visibility to the LLM, and persistence characteristics.

### 1.1 The Three State Layers

| Layer | Scope | Visible to LLM | Persisted by Session Manager | Access Pattern |
|-------|-------|-----------------|------------------------------|----------------|
| **Conversation History** | Multi-turn | Yes (primary context) | Yes | `agent.messages` |
| **Agent State** | Multi-request | No | Yes | `agent.state.get/set/delete` |
| **Request State** | Single invocation | No | No | `tool_context.invocation_state` |

### 1.2 Conversation History

The primary form of context. Messages accumulate in `agent.messages` and are passed to the model on every inference call. This is the context window the LLM reasons over.

```python
from strands import Agent

agent = Agent()
agent("Hello!")

# Access the full conversation history
for message in agent.messages:
    print(f"{message['role']}: {message['content']}")

# Direct tool calling on the agent's conversation
agent.tool.calculator(expression="2+2")
```

**Key characteristics:**
- Directly accessible via `agent.messages`
- Subject to context window limits (managed by `ConversationManager`)
- Automatically persisted when a `SessionManager` is configured
- Direct modifications to `agent.messages` are NOT persisted — use the `ConversationManager` API

### 1.3 Agent State (App State)

Key-value storage for stateful information that exists outside the conversation context. Unlike conversation history, agent state is **not** passed to the model during inference but **is** accessible by tools and application logic.

```python
from strands import Agent

# Create with initial state
agent = Agent(state={
    "user_preferences": {"theme": "dark"},
    "session_count": 0
})

# CRUD operations
agent.state.get("user_preferences")         # {"theme": "dark"}
agent.state.set("last_action", "login")
agent.state.delete("last_action")
all_state = agent.state.get()                # Full dict
```

**Validation**: Agent state enforces JSON serialization validation. Non-serializable values (lambdas, custom objects) raise `ValueError`:

```python
try:
    agent.state.set("function", lambda x: x)  # Raises ValueError
except ValueError as e:
    print(f"Not JSON serializable: {e}")
```

### 1.4 Using State in Tools via ToolContext

Tools access agent state through `ToolContext`, which provides the bridge between the tool execution environment and the agent's state:

```python
from strands import Agent, tool, ToolContext

@tool(context=True)
def track_user_action(action: str, tool_context: ToolContext):
    """Track user actions in agent state.

    Args:
        action: The action to track
    """
    action_count = tool_context.agent.state.get("action_count") or 0
    tool_context.agent.state.set("action_count", action_count + 1)
    tool_context.agent.state.set("last_action", action)
    return f"Action '{action}' recorded. Total: {action_count + 1}"

@tool(context=True)
def get_user_stats(tool_context: ToolContext):
    """Get user statistics from agent state."""
    action_count = tool_context.agent.state.get("action_count") or 0
    last_action = tool_context.agent.state.get("last_action") or "none"
    return f"Actions: {action_count}, Last: {last_action}"

agent = Agent(tools=[track_user_action, get_user_stats])
agent("Track that I logged in")
agent("Track that I viewed my profile")
print(f"Actions: {agent.state.get('action_count')}")  # 2
```

### 1.5 Request State (Invocation State)

Per-invocation context that persists through event loop cycles within a single agent call but is **not** included in the agent's context or persisted:

```python
from strands import Agent, tool, ToolContext

@tool(context=True)
def query_data(query: str, tool_context: ToolContext) -> str:
    """Query data using request context."""
    user_id = tool_context.invocation_state.get("user_id")
    debug_mode = tool_context.invocation_state.get("debug_mode", False)
    return f"Query for user {user_id}: {query}"

agent = Agent(tools=[query_data])

# Pass request-scoped state at invocation time
result = agent(
    "Find recent orders",
    invocation_state={"user_id": "u-123", "debug_mode": True}
)
```

**Multi-agent shared state**: The same `invocation_state` dict flows through multi-agent patterns:

```python
from strands.multiagent import Swarm, GraphBuilder

shared_state = {"user_id": "u-123", "debug_mode": True}

# Works with both Swarm and Graph
result = swarm("Analyze data", invocation_state=shared_state)
result = graph("Process request", invocation_state=shared_state)
```

---

## 2. Session Management & Persistence

Session management provides the mechanism for persisting agent state and conversation history across multiple interactions, enabling agents to resume conversations after restarts.

### 2.1 Architecture Overview

```
Session
+-- session_id: str
+-- session_type: SessionType
+-- created_at / updated_at: ISO timestamps
+-- SessionAgent(s)
|   +-- agent_id: str
|   +-- state: dict (AgentState)
|   +-- conversation_manager_state: dict
|   +-- SessionMessage(s)
|       +-- message_id: str
|       +-- role: str
|       +-- content: list[ContentBlock]
+-- MultiAgentState (for Graph/Swarm)
    +-- shared_context: dict
    +-- execution_flow: list
    +-- node_transition_history: list
```

### 2.2 Session Persistence Triggers

Session persistence is automatically triggered by lifecycle events:

**Single Agent Events:**
- **Message Addition**: When a new message is added, `append_message` stores it
- **Agent Invocation**: After each invocation, `sync_agent` captures state changes
- **Message Redaction**: When sensitive information is redacted

**Multi-Agent Events:**
- **Node Completion**: After each node finishes execution
- **Handoff**: During swarm agent handoffs
- **Graph State Transitions**: When the execution flow changes

### 2.3 Built-in Session Managers

Strands provides two built-in session managers:

#### FileSessionManager

Local filesystem storage, ideal for development and single-machine deployments:

```python
from strands import Agent
from strands.session.file_session_manager import FileSessionManager

# Create a session manager with a unique session ID
session_manager = FileSessionManager(
    session_id="user-session-001",
    storage_dir="/tmp/strands_sessions"
)

agent = Agent(
    id="support_bot",
    session_manager=session_manager,
    system_prompt="You are a helpful support bot."
)

# First interaction
agent("My order #12345 hasn't arrived")

# --- Later, even after restart ---

# Restore session by creating agent with same session_id
session_manager_2 = FileSessionManager(
    session_id="user-session-001",
    storage_dir="/tmp/strands_sessions"
)

agent_2 = Agent(
    id="support_bot",
    session_manager=session_manager_2,
    system_prompt="You are a helpful support bot."
)

# Agent remembers the previous conversation
agent_2("Any update on my order?")  # Has context about order #12345
```

**File structure:**
```
storage_dir/
  {session_id}/
    session.json
    agents/
      {agent_id}/
        agent.json
        messages/
          {message_id}.json
    multi_agents/
      {multi_agent_id}/
        state.json
```

#### S3SessionManager

Cloud-based persistence for distributed environments:

```python
from strands import Agent
from strands.session.s3_session_manager import S3SessionManager

session_manager = S3SessionManager(
    session_id="user-session-001",
    bucket_name="my-agent-sessions",
    prefix="sessions/"  # Optional S3 key prefix
)

agent = Agent(
    id="support_bot",
    session_manager=session_manager
)
```

Uses the same directory structure within the S3 bucket as `FileSessionManager`.

### 2.4 Custom Session Repositories

For advanced use cases (DynamoDB, Redis, PostgreSQL, etc.), implement the `SessionRepository` interface:

```python
from typing import Optional
from strands.session.repository_session_manager import RepositorySessionManager
from strands.session.session_repository import SessionRepository
from strands.types.session import Session, SessionAgent, SessionMessage

class DynamoDBSessionRepository(SessionRepository):
    """Custom session repository backed by DynamoDB."""

    def __init__(self, table_name: str):
        self.table_name = table_name
        # Initialize DynamoDB client...

    def create_session(self, session: Session) -> Session:
        # Store session in DynamoDB
        ...

    def read_session(self, session_id: str) -> Optional[Session]:
        # Read session from DynamoDB
        ...

    def update_session(self, session: Session) -> Session:
        # Update session in DynamoDB
        ...

    def delete_session(self, session_id: str) -> None:
        # Delete session from DynamoDB
        ...

    def create_agent(self, session_id: str, agent: SessionAgent) -> SessionAgent:
        ...

    def read_agent(self, session_id: str, agent_id: str) -> Optional[SessionAgent]:
        ...

    def update_agent(self, session_id: str, agent: SessionAgent) -> SessionAgent:
        ...

    def create_message(self, session_id: str, agent_id: str,
                       message: SessionMessage) -> SessionMessage:
        ...

    def read_messages(self, session_id: str, agent_id: str) -> list[SessionMessage]:
        ...

    def list_sessions(self) -> list[Session]:
        ...

# Use with RepositorySessionManager
repo = DynamoDBSessionRepository(table_name="agent-sessions")
session_manager = RepositorySessionManager(
    session_id="user-session-001",
    session_repository=repo
)

agent = Agent(session_manager=session_manager)
```

### 2.5 Multi-Agent Session Management

Multi-agent systems (Graph/Swarm) have their own session persistence:

```python
from strands import Agent
from strands.multiagent import GraphBuilder
from strands.session.file_session_manager import FileSessionManager

# Each agent in a multi-agent system CANNOT have its own session manager
# Instead, sessions are managed at the multi-agent level

researcher = Agent(name="researcher", system_prompt="Research specialist")
analyst = Agent(name="analyst", system_prompt="Analysis specialist")

builder = GraphBuilder()
builder.add_node(researcher, "research")
builder.add_node(analyst, "analysis")
builder.add_edge("research", "analysis")

graph = builder.build()

# Session manager on the multi-agent system
session_manager = FileSessionManager(session_id="graph-session-001")
# (Multi-agent session support serializes execution flow, node history, shared context)
```

**Multi-Agent State includes:**
- Shared context (cross-agent state and variables)
- Execution flow (which nodes completed, in what order)
- Node transition history
- Results from each node

### 2.6 Third-Party Session Managers

| Session Manager | Provider | Description |
|----------------|----------|-------------|
| `AgentCoreMemorySessionManager` | Amazon | Advanced memory with STM + LTM via Bedrock AgentCore |
| `ValkeySessionManager` | Community | Redis-compatible Valkey for high-performance session storage |

### 2.7 Session Persistence Best Practices

1. **Secure Storage Directories**: Restrict filesystem permissions so only the agent process can read/write
2. **Single Agent per Session**: Cannot use a single agent with session manager inside a multi-agent system (throws exception)
3. **Use `conversation_manager` APIs**: Direct `agent.messages` modifications are not persisted
4. **Session ID Strategy**: Use deterministic IDs (user_id + context) for resumable sessions, UUIDs for ephemeral sessions
5. **Cleanup**: Implement session expiration/cleanup for long-running systems

---

## 3. Conversation Management

Conversation managers control how the message history is maintained within context window limits. They are distinct from session managers — conversation managers handle in-memory message optimization, while session managers handle persistence.

### 3.1 SlidingWindowConversationManager

Maintains a fixed-size window of recent messages, trimming older ones:

```python
from strands import Agent
from strands.agent.conversation_manager import SlidingWindowConversationManager

agent = Agent(
    conversation_manager=SlidingWindowConversationManager(
        window_size=500,              # Max messages to keep
        should_truncate_results=True  # Truncate large tool results
    )
)
```

**How it works:**
1. After each event loop cycle, `apply_management` enforces the window
2. If `should_truncate_results=True`, preserves first/last 200 chars of large tool results, replaces images with placeholders
3. Truncation prioritizes oldest tool results to retain recent context
4. Never breaks `toolUse`/`toolResult` pairs during trimming
5. Supports `per_turn` management (apply before every model call or every N calls)

**Interaction with sessions**: The `removed_message_count` is tracked, so when restoring from a session, the conversation manager knows how many messages were trimmed and can properly reconstruct state.

### 3.2 SummarizingConversationManager

Summarizes older messages instead of discarding them, preserving semantic information:

```python
from strands import Agent
from strands.agent.conversation_manager import SummarizingConversationManager

agent = Agent(
    conversation_manager=SummarizingConversationManager(
        summary_ratio=0.5,              # Summarize 50% of messages
        preserve_recent_messages=2,     # Always keep 2 most recent
        summarization_agent=None        # Uses default summarization prompt
    )
)
```

**How it works:**
1. Only triggered reactively on `ContextWindowOverflowException` (not proactive)
2. Calculates how many messages to summarize based on `summary_ratio`
3. Ensures minimum `preserve_recent_messages` are kept
4. Adjusts split point to avoid breaking `toolUse`/`toolResult` pairs
5. Replaces summarized messages with a single summary message
6. Can use a custom `summarization_agent` for the summarization step

### 3.3 NullConversationManager

No-op implementation. Raises `ContextWindowOverflowException` if the context overflows:

```python
from strands.agent.conversation_manager import NullConversationManager

agent = Agent(conversation_manager=NullConversationManager())
# Useful when you manage context externally or know messages won't exceed limits
```

### 3.4 Context Overflow Handling Flow

```
Agent Loop Cycle
  -> Model call raises ContextWindowOverflowException
  -> Agent catches exception
  -> Calls conversation_manager.reduce_context()
  -> SlidingWindow: trims oldest messages
  -> Summarizing: summarizes oldest N messages into one
  -> Null: re-raises the exception
  -> Syncs with session manager (if configured)
  -> Retries the event loop cycle
```

---

## 4. Memory Architecture — Short-Term & Long-Term

### 4.1 Overview

Strands memory is layered:

| Memory Type | Mechanism | Duration | Storage |
|------------|-----------|----------|---------|
| **Working Memory** | `agent.messages` + conversation manager | Within session | In-memory |
| **Short-Term Memory (STM)** | Session persistence | Across restarts | File / S3 / Custom |
| **Long-Term Memory (LTM)** | AgentCore Memory strategies | Across sessions | Bedrock AgentCore |

### 4.2 Short-Term Memory (STM)

STM is achieved through session managers. The full conversation history, agent state, and conversation manager state are persisted and can be restored:

```python
from strands import Agent
from strands.session.file_session_manager import FileSessionManager
from strands.agent.conversation_manager import SlidingWindowConversationManager

# Session 1: Initial conversation
session_mgr = FileSessionManager(session_id="stm-demo", storage_dir="/tmp/sessions")
agent = Agent(
    session_manager=session_mgr,
    conversation_manager=SlidingWindowConversationManager(window_size=100)
)
agent("My name is Alice and I like Python")

# Session 2: Restoring context (could be hours/days later)
session_mgr_2 = FileSessionManager(session_id="stm-demo", storage_dir="/tmp/sessions")
agent_2 = Agent(
    session_manager=session_mgr_2,
    conversation_manager=SlidingWindowConversationManager(window_size=100)
)
# agent_2 knows Alice's name and preference — full history restored
agent_2("What's my name and what language do I like?")
```

### 4.3 Long-Term Memory (LTM) with Bedrock AgentCore

The `AgentCoreMemorySessionManager` (community integration) provides intelligent LTM through Bedrock AgentCore Memory with three strategies:

#### Strategy 1: Session Summarization
Automatically summarizes conversation sessions for later retrieval:
```python
{
    "summaryMemoryStrategy": {
        "name": "SessionSummarizer",
        "namespaces": ["/summaries/{actorId}/{sessionId}"]
    }
}
```

#### Strategy 2: User Preference Learning
Extracts and stores user preferences across conversations:
```python
{
    "userPreferenceMemoryStrategy": {
        "name": "PreferenceLearner",
        "namespaces": ["/preferences/{actorId}"]
    }
}
```

#### Strategy 3: Semantic Fact Extraction
Extracts and stores factual information:
```python
{
    "semanticMemoryStrategy": {
        "name": "FactExtractor",
        "namespaces": ["/facts/{actorId}"]
    }
}
```

#### Full LTM Setup

```python
import os
from datetime import datetime
from strands import Agent
from bedrock_agentcore.memory import MemoryClient
from bedrock_agentcore.memory.integrations.strands.config import (
    AgentCoreMemoryConfig,
    RetrievalConfig
)
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager
)

# One-time: Create memory resource with all strategies
client = MemoryClient(region_name="us-east-1")
memory = client.create_memory_and_wait(
    name="ComprehensiveAgentMemory",
    description="Full-featured memory with all strategies",
    strategies=[
        {"summaryMemoryStrategy": {
            "name": "SessionSummarizer",
            "namespaces": ["/summaries/{actorId}/{sessionId}"]
        }},
        {"userPreferenceMemoryStrategy": {
            "name": "PreferenceLearner",
            "namespaces": ["/preferences/{actorId}"]
        }},
        {"semanticMemoryStrategy": {
            "name": "FactExtractor",
            "namespaces": ["/facts/{actorId}"]
        }}
    ]
)
memory_id = memory.get("id")

# Configure retrieval across namespaces
config = AgentCoreMemoryConfig(
    memory_id=memory_id,
    session_id=f"session_{datetime.now().strftime('%Y%m%d%H%M%S')}",
    actor_id="user-alice",
    retrieval_config={
        "/preferences/{actorId}": RetrievalConfig(top_k=5, relevance_score=0.7),
        "/facts/{actorId}": RetrievalConfig(top_k=10, relevance_score=0.3),
        "/summaries/{actorId}/{sessionId}": RetrievalConfig(top_k=5, relevance_score=0.5)
    }
)

# Use context manager to ensure messages are flushed
with AgentCoreMemorySessionManager(
    agentcore_memory_config=config,
    region_name="us-east-1"
) as session_manager:
    agent = Agent(
        system_prompt="Use all you know about the user to provide helpful responses.",
        session_manager=session_manager
    )
    agent("I like sushi with tuna")
    agent("What should I buy for lunch today?")
    # Agent remembers preferences across sessions via LTM
```

#### Message Batching

For performance optimization, messages can be batched before sending to AgentCore Memory:

```python
config = AgentCoreMemoryConfig(
    memory_id=memory_id,
    session_id="session-001",
    actor_id="user-alice",
    batch_size=5  # Buffer 5 messages before sending
)

# Context manager ensures flush on exit
with AgentCoreMemorySessionManager(config, region_name="us-east-1") as sm:
    agent = Agent(session_manager=sm)
    # Messages buffered locally, sent in batch of 5
    for i in range(10):
        agent(f"Message {i}")
    # Remaining messages flushed on context exit
```

---

## 5. Multi-Agent Orchestration Patterns

Strands 1.0 introduces four multi-agent primitives that build on the model/tool/prompt foundation:

| Pattern | Execution Flow | Coordination | Best For |
|---------|---------------|--------------|----------|
| **Agents as Tools** | Hierarchical delegation | Orchestrator calls specialists | Simple routing, focused expertise |
| **Swarm** | Autonomous handoffs | Peer-to-peer, self-organizing | Collaborative problem-solving |
| **Graph** | Deterministic DAG/cycles | Edge dependencies + conditions | Structured pipelines, review loops |
| **Workflow** | Task-based DAG | Dependency resolution + parallel | Complex multi-step processes |

### 5.1 Agents as Tools

The simplest multi-agent pattern. Wrap specialized agents as `@tool` functions that an orchestrator agent can call:

```python
from strands import Agent, tool

# Specialized agents wrapped as tools
@tool
def research_assistant(query: str) -> str:
    """Research specialist for factual information and analysis.

    Args:
        query: The research question to investigate
    """
    agent = Agent(
        system_prompt="You are a research specialist. Provide thorough, "
                      "well-sourced answers.",
        callback_handler=None
    )
    result = agent(query)
    return str(result)

@tool
def code_assistant(request: str) -> str:
    """Programming specialist for code generation and debugging.

    Args:
        request: The coding task or question
    """
    agent = Agent(
        system_prompt="You are a coding specialist. Write clean, "
                      "well-documented code.",
        callback_handler=None
    )
    result = agent(request)
    return str(result)

# Orchestrator agent with specialist tools
orchestrator = Agent(
    system_prompt="""You are an assistant that routes queries to specialists:
    - Research questions -> research_assistant
    - Coding tasks -> code_assistant
    Choose the most appropriate specialist for each query.""",
    tools=[research_assistant, code_assistant]
)

orchestrator("Write a Python function to calculate fibonacci numbers "
             "and explain the mathematical theory behind it")
```

**Key benefits:**
- Hierarchical delegation with clear chain of command
- Each specialist has focused system prompt and tools
- Orchestrator synthesizes results from multiple specialists
- Simple to understand and debug

### 5.2 Swarm Pattern

Self-organizing collaborative teams where agents autonomously hand off tasks to each other:

```python
from strands import Agent
from strands.multiagent import Swarm

# Create specialized agents
researcher = Agent(
    name="researcher",
    system_prompt="You are a researcher. When you need calculations, "
                  "hand off to the analyst.",
)

analyst = Agent(
    name="analyst",
    system_prompt="You are an analyst. Use tools to perform calculations.",
    tools=[calculator],
)

writer = Agent(
    name="writer",
    system_prompt="You are a technical writer. Compile findings into "
                  "clear reports.",
)

# Create swarm — handoff_to_agent tool is auto-injected
swarm = Swarm(
    [researcher, analyst, writer],
    max_handoffs=20,
    max_iterations=20,
    execution_timeout=900.0,  # 15 minutes
)

# Execute
result = swarm("Research quantum computing advances and write a report")
# Or async: result = await swarm.invoke_async(...)
```

#### How Handoffs Work

Each agent in a swarm automatically receives the `handoff_to_agent` tool:

```python
# Tool automatically available to each agent
handoff_to_agent(
    agent_name="analyst",
    message="I need help implementing this algorithm in Python",
    context={"algorithm_details": "..."}
)
```

#### Shared Context

The swarm maintains shared context accessible to all agents:
- List of available agents for collaboration
- Knowledge contributed by previous agents
- History of which agents worked on the task
- The original task description

#### Swarm as a Tool

An agent can dynamically create and orchestrate swarms:

```python
from strands import Agent
from strands_tools import swarm

agent = Agent(
    tools=[swarm],
    system_prompt="Create swarms to solve complex problems."
)
agent("Research, analyze, and summarize quantum computing advances")
```

#### Safety Mechanisms

1. **Repetitive handoff detection**: Prevents infinite back-and-forth
2. **Max handoffs limit**: Hard cap on total handoffs
3. **Max iterations**: Hard cap on total iterations
4. **Execution timeout**: Wall-clock timeout

### 5.3 Graph Pattern

Deterministic directed graph-based orchestration with explicit dependencies, conditions, and support for cycles:

```python
from strands import Agent
from strands.multiagent import GraphBuilder

# Create agents
researcher = Agent(name="researcher", system_prompt="Research specialist...")
analyst = Agent(name="analyst", system_prompt="Analysis specialist...")
fact_checker = Agent(name="fact_checker", system_prompt="Fact checking specialist...")
report_writer = Agent(name="report_writer", system_prompt="Report writing specialist...")

# Build the graph
builder = GraphBuilder()

# Add nodes
builder.add_node(researcher, "research")
builder.add_node(analyst, "analysis")
builder.add_node(fact_checker, "fact_check")
builder.add_node(report_writer, "report")

# Add edges (dependencies)
builder.add_edge("research", "analysis")      # analysis depends on research
builder.add_edge("research", "fact_check")    # fact_check depends on research
builder.add_edge("analysis", "report")        # report depends on analysis
builder.add_edge("fact_check", "report")      # report depends on fact_check

# Optional configuration
builder.set_entry_point("research")
builder.set_execution_timeout(600)  # 10 minutes

# Build and execute
graph = builder.build()
result = graph("Research AI in healthcare and create a report")

print(f"Status: {result.status}")
print(f"Execution order: {[n.node_id for n in result.execution_order]}")
```

#### Common Graph Topologies

**1. Sequential Pipeline:**
```
Research -> Analysis -> Review -> Report
```

**2. Parallel Processing with Aggregation:**
```
Coordinator -> Worker1 -+
            -> Worker2 -+-> Aggregator
            -> Worker3 -+
```

```python
builder = GraphBuilder()
builder.add_node(coordinator, "coordinator")
builder.add_node(worker1, "worker1")
builder.add_node(worker2, "worker2")
builder.add_node(worker3, "worker3")
builder.add_node(aggregator, "aggregator")

builder.add_edge("coordinator", "worker1")
builder.add_edge("coordinator", "worker2")
builder.add_edge("coordinator", "worker3")
builder.add_edge("worker1", "aggregator")
builder.add_edge("worker2", "aggregator")
builder.add_edge("worker3", "aggregator")
```

**3. Branching Logic:**
```python
def is_technical(state):
    result_text = str(state.results.get("classifier").result)
    return "technical" in result_text.lower()

def is_business(state):
    result_text = str(state.results.get("classifier").result)
    return "business" in result_text.lower()

builder.add_edge("classifier", "tech_specialist", condition=is_technical)
builder.add_edge("classifier", "business_specialist", condition=is_business)
```

**4. Feedback Loop (Cyclic):**
```python
def needs_revision(state):
    result_text = str(state.results.get("reviewer").result)
    return "revision needed" in result_text.lower()

def is_approved(state):
    result_text = str(state.results.get("reviewer").result)
    return "approved" in result_text.lower()

builder.add_node(draft_writer, "draft_writer")
builder.add_node(reviewer, "reviewer")
builder.add_node(publisher, "publisher")

builder.add_edge("draft_writer", "reviewer")
builder.add_edge("reviewer", "draft_writer", condition=needs_revision)
builder.add_edge("reviewer", "publisher", condition=is_approved)

# Prevent infinite loops
builder.set_max_node_executions(10)
builder.set_execution_timeout(300)
builder.reset_on_revisit(True)  # Fresh state on each revisit
```

#### Nested Patterns

Graphs can contain Swarms or other Graphs as nodes:

```python
inner_swarm = Swarm([agent_a, agent_b])
inner_graph = another_builder.build()

builder = GraphBuilder()
builder.add_node(inner_swarm, "collaborative_analysis")
builder.add_node(inner_graph, "structured_processing")
builder.add_edge("collaborative_analysis", "structured_processing")
```

#### Custom Node Types

For deterministic business logic that doesn't need an LLM:

```python
from strands.multiagent.graph import GraphNode

class DataTransformNode:
    """Custom node for deterministic data transformation."""

    async def invoke_async(self, task, **kwargs):
        # Pure business logic — no LLM call
        data = parse_input(task)
        transformed = transform(data)
        return transformed

builder.add_node(DataTransformNode(), "transform")
```

#### Input Propagation

Each node receives:
1. The **original task** (user's initial prompt)
2. **Results from all completed upstream dependencies** (formatted as context)

The graph automatically aggregates upstream outputs and formats them as input for downstream nodes.

#### Shared State in Graphs

```python
shared_state = {"user_id": "u-123", "config": {"verbose": True}}
result = graph("Process request", invocation_state=shared_state)
```

Tools in graph nodes access this via `tool_context.invocation_state`.

### 5.4 Workflow Pattern

Task-based DAG with automatic dependency resolution and parallel execution of independent tasks:

```python
from strands import Agent
from strands_tools import workflow

# Orchestrator uses the workflow tool
orchestrator = Agent(
    tools=[workflow],
    system_prompt="""You coordinate complex tasks by breaking them into
    subtasks with clear dependencies. Use the workflow tool to execute
    multi-step plans."""
)

orchestrator("Build a complete analysis of our Q4 sales data: "
             "gather data, clean it, run statistical analysis, "
             "create visualizations, and write a summary report")
```

**Key features:**
- Automatic task dependency resolution
- Parallel execution of independent tasks
- Context passing between dependent tasks
- Built-in tool in `strands_tools` package

### 5.5 Pattern Comparison

| Feature | Agents-as-Tools | Swarm | Graph | Workflow |
|---------|----------------|-------|-------|----------|
| **Execution model** | Hierarchical call | Autonomous handoff | Edge-based DAG | Task-based DAG |
| **Who decides routing** | Orchestrator LLM | Each agent LLM | Graph structure + conditions | Dependency resolver |
| **Parallelism** | Sequential (per tool call) | Sequential (handoff chain) | Parallel (independent nodes) | Parallel (independent tasks) |
| **Cycles** | No | Yes (with limits) | Yes (with limits) | No |
| **State sharing** | Via tool return values | Shared context + working memory | `invocation_state` + edge outputs | Task outputs as inputs |
| **Session persistence** | Per-agent | Multi-agent session | Multi-agent session | Per-task |
| **Best for** | Simple routing | Collaborative brainstorming | Structured pipelines | Complex multi-step processes |

### 5.6 Mixing Patterns

Patterns are composable — start simple and evolve:

```python
# Level 1: Single agent
agent = Agent(tools=[calculator, web_search])

# Level 2: Add specialists as tools
@tool
def math_agent(query: str) -> str: ...

@tool
def research_agent(query: str) -> str: ...

orchestrator = Agent(tools=[math_agent, research_agent])

# Level 3: Swarm for collaborative work
swarm = Swarm([math_specialist, research_specialist, writer])

# Level 4: Graph for structured pipeline
builder = GraphBuilder()
builder.add_node(swarm, "research_team")   # Swarm as a graph node
builder.add_node(reviewer, "review")
builder.add_edge("research_team", "review")
graph = builder.build()
```

---

## 6. Agent-to-Agent (A2A) Protocol

A2A is an open standard that enables agents from different platforms to communicate seamlessly over HTTP. Strands supports both serving agents via A2A and consuming remote A2A agents.

### 6.1 Architecture

```
                    HTTP/A2A Protocol
[Strands Agent] <--------------------> [A2A Server]
  (A2AAgent                              (A2AServer wrapping
   as client)                             a Strands Agent)
```

### 6.2 Exposing a Strands Agent via A2A Server

```python
from strands import Agent
from strands.multiagent.a2a import A2AServer

# Create a Strands agent
my_agent = Agent(
    name="calculator-agent",
    description="A specialist for mathematical calculations",
    tools=[calculator],
    system_prompt="You are a math specialist."
)

# Wrap in A2A server
a2a_server = A2AServer(
    agent=my_agent,
    host="0.0.0.0",
    port=9000,
    http_url="http://my-public-domain.com/calculator",  # Public URL
    serve_at_root=True  # Useful behind load balancers
)

# Start serving
if __name__ == "__main__":
    a2a_server.serve(app_type="fastapi")  # Or "starlette"
```

**Auto-generated AgentCard**: The server automatically creates an A2A AgentCard containing:
- Agent name, description, URL, version
- Skills (derived from agent tools)
- Capabilities (streaming, etc.)

### 6.3 Consuming Remote A2A Agents

```python
from strands.agent.a2a_agent import A2AAgent

# Connect to a remote A2A agent
remote_agent = A2AAgent(
    endpoint="http://my-public-domain.com/calculator",
    name="remote_calculator"
)

# Synchronous invocation
result = remote_agent("What is 42 * 17?")
print(result.message["content"][0]["text"])

# Async invocation
result = await remote_agent.invoke_async("Calculate compound interest")

# Streaming
async for event in remote_agent.stream_async("Solve this step by step"):
    print(event)
```

### 6.4 A2A Agents in Multi-Agent Graphs

Remote A2A agents can be graph nodes alongside local agents:

```python
from strands.agent.a2a_agent import A2AAgent
from strands.multiagent import GraphBuilder

# Remote A2A agents
math_agent = A2AAgent(endpoint="http://math-service:9000", name="math")
nlp_agent = A2AAgent(endpoint="http://nlp-service:9001", name="nlp")

# Local agent
summarizer = Agent(name="summarizer", system_prompt="Summarize results.")

# Build hybrid graph
builder = GraphBuilder()
builder.add_node(math_agent, "math")
builder.add_node(nlp_agent, "nlp")
builder.add_node(summarizer, "summary")

builder.add_edge("math", "summary")
builder.add_edge("nlp", "summary")

graph = builder.build()
result = await graph.invoke_async("Analyze the dataset")
```

### 6.5 A2A Client Tool Provider

The `strands_tools` package provides an `A2AClientToolProvider` for automatic discovery:

```python
from strands_tools.a2a_client import A2AClientToolProvider

# Discover and wrap A2A agents as tools
provider = A2AClientToolProvider(
    known_agent_urls=["http://agent1:9000", "http://agent2:9001"]
)

# Use discovered agents as tools
agent = Agent(tools=provider.tools)
agent("Ask the remote agents to help with this task")
```

### 6.6 Type Converters

The `strands.multiagent.a2a._converters` module handles translation:

| Function | Direction | Purpose |
|----------|-----------|---------|
| `convert_input_to_message` | Strands -> A2A | Converts `AgentInput` to A2A `Message` |
| `convert_content_blocks_to_parts` | Strands -> A2A | Converts `ContentBlock` list to A2A `Part` list |
| `convert_response_to_agent_result` | A2A -> Strands | Converts A2A response to `AgentResult` |

Supports text, images (base64), videos, documents, and data parts.

---

## 7. Streaming & Async Patterns

Strands 1.0 provides fully async-native streaming through two complementary approaches.

### 7.1 Async Iterator Pattern (stream_async)

The primary pattern for async frameworks (FastAPI, aiohttp, etc.):

```python
import asyncio
from strands import Agent
from strands_tools import calculator

agent = Agent(tools=[calculator], callback_handler=None)

async def process():
    async for event in agent.stream_async("Calculate 2+2"):
        # Text chunks
        if "data" in event:
            print(event["data"], end="")

        # Tool usage
        if "current_tool_use" in event:
            tool = event["current_tool_use"]
            print(f"\n[Using tool: {tool.get('name')}]")

        # Lifecycle events
        if event.get("init_event_loop"):
            print("Event loop initialized")
        if event.get("start_event_loop"):
            print("Event loop cycle starting")
        if "result" in event:
            print(f"\nCompleted: {event['result']}")

asyncio.run(process())
```

### 7.2 Callback Handler Pattern

Synchronous event handling for simpler use cases:

```python
def handle_events(**kwargs):
    if "data" in kwargs:
        print(kwargs["data"], end="")
    if "current_tool_use" in kwargs:
        print(f"\n[Tool: {kwargs['current_tool_use'].get('name')}]")

agent = Agent(callback_handler=handle_events)
agent("Tell me about quantum computing")
```

### 7.3 Multi-Agent Streaming Events

Multi-agent systems emit additional event types:

| Event | Fields | Description |
|-------|--------|-------------|
| `multiagent_node_start` | `node_id`, `node_type` | Node begins execution |
| `multiagent_node_stream` | `node_id`, `event` | Streaming from a node |
| `multiagent_node_stop` | `node_id`, `node_result` | Node completed |
| `multiagent_handoff` | `from_node_ids`, `to_node_ids`, `message` | Swarm handoff |
| `multiagent_result` | `result` | Final multi-agent result |

```python
async for event in swarm.stream_async("Design a REST API"):
    if event.get("type") == "multiagent_node_start":
        print(f"Agent {event['node_id']} starting...")
    elif event.get("type") == "multiagent_handoff":
        print(f"Handoff: {event['from_node_ids']} -> {event['to_node_ids']}")
    elif "data" in event:
        print(event["data"], end="")
```

### 7.4 FastAPI Integration

```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from strands import Agent

app = FastAPI()
agent = Agent(callback_handler=None)

@app.post("/chat")
async def chat(message: str):
    async def generate():
        async for event in agent.stream_async(message):
            if "data" in event:
                yield f"data: {event['data']}\n\n"
            if "current_tool_use" in event:
                tool_name = event["current_tool_use"].get("name")
                yield f"event: tool\ndata: {tool_name}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
```

### 7.5 Sub-Agent Streaming

When agents-as-tools stream events, they propagate through the `tool_stream_event`:

```python
from dataclasses import dataclass

@dataclass
class SubAgentResult:
    agent: Agent
    event: dict

@tool
async def research_agent(query: str) -> str:
    agent = Agent(system_prompt="Research specialist", callback_handler=None)
    async for event in agent.stream_async(query):
        yield SubAgentResult(agent=agent, event=event)
        if "result" in event:
            yield str(event["result"])

# Processing sub-agent events in the orchestrator
def process_sub_agent_events(event):
    tool_stream = event.get("tool_stream_event", {}).get("data")
    if isinstance(tool_stream, SubAgentResult):
        tool_name = tool_stream.event.get("current_tool_use", {}).get("name")
        if tool_name:
            print(f"Agent '{tool_stream.agent.name}' using tool '{tool_name}'")
```

---

## 8. Interrupt Handling & Human-in-the-Loop

The interrupt system enables pausing agent execution to request human input.

### 8.1 Flow

```
Invoke Agent -> Execute Hook/Tool -> Interrupts Raised?
  No  -> Continue Agent Loop
  Yes -> Stop Agent Loop -> Return Interrupts
         -> User Responds -> Execute with Responses
         -> New Interrupts? -> (cycle or continue)
```

### 8.2 Interrupts from Tools

```python
from strands import Agent, tool
from strands.interrupt import InterruptData

@tool
def approve_purchase(item: str, amount: float) -> str:
    """Process a purchase that requires human approval.

    Args:
        item: The item to purchase
        amount: The purchase amount
    """
    if amount > 100:
        raise InterruptData(
            interrupt_type="approval_required",
            data={"item": item, "amount": amount, "message": "High-value purchase"}
        )
    return f"Purchase of {item} for ${amount} approved automatically"

agent = Agent(tools=[approve_purchase])
result = agent("Buy a laptop for $1500")

# Check for interrupts
if result.interrupts:
    for interrupt in result.interrupts:
        print(f"Approval needed: {interrupt.data}")
        # Get human approval...
        result = agent.respond_to_interrupts(
            {interrupt.id: {"approved": True, "approver": "manager"}}
        )
```

### 8.3 Interrupts from Hooks

```python
from strands import Agent
from strands.hooks.events import BeforeToolCallEvent
from strands.interrupt import InterruptData

def review_tool_calls(event: BeforeToolCallEvent):
    """Hook that requires approval for certain tool calls."""
    if event.tool_name in ["delete_file", "send_email"]:
        raise InterruptData(
            interrupt_type="tool_review",
            data={"tool": event.tool_name, "args": event.tool_input}
        )

agent = Agent()
agent.hooks.register(BeforeToolCallEvent, review_tool_calls)
```

### 8.4 Session-Managed Interrupts

Interrupts persist across sessions, enabling async human-in-the-loop:

```python
# Session 1: Agent encounters interrupt
session_mgr = FileSessionManager(session_id="review-001")
agent = Agent(session_manager=session_mgr, tools=[approve_purchase])
result = agent("Buy expensive equipment")
# Interrupt raised, state saved to session

# Session 2: Hours later, human responds
session_mgr_2 = FileSessionManager(session_id="review-001")
agent_2 = Agent(session_manager=session_mgr_2, tools=[approve_purchase])
# Interrupt state restored from session
result = agent_2.respond_to_interrupts(
    {interrupt_id: {"approved": True}}
)
```

### 8.5 Multi-Agent Interrupts

Interrupts work in both Swarm and Graph patterns:

**Swarm**: Interrupts from any agent in the swarm bubble up to the caller. Responses are routed back to the specific agent.

**Graph**: Interrupts pause execution at the node level, preserving graph state for resumption.

---

## 9. Integration with External Storage

### 9.1 Storage Backend Comparison

| Backend | Session Manager | Use Case | Latency | Scalability |
|---------|----------------|----------|---------|-------------|
| Local filesystem | `FileSessionManager` | Development, single-machine | Low | Single machine |
| Amazon S3 | `S3SessionManager` | Cloud, distributed | Medium | High |
| Bedrock AgentCore | `AgentCoreMemorySessionManager` | LTM with intelligent retrieval | Medium | High |
| Valkey/Redis | `ValkeySessionManager` (community) | High-performance caching | Very low | High |
| Custom (DynamoDB, PostgreSQL, etc.) | `RepositorySessionManager` + custom repo | Any requirements | Varies | Varies |

### 9.2 DynamoDB Integration Pattern

```python
import boto3
from strands.session.session_repository import SessionRepository
from strands.types.session import Session, SessionAgent, SessionMessage
import json

class DynamoDBSessionRepository(SessionRepository):
    def __init__(self, table_name: str, region: str = "us-east-1"):
        self.dynamodb = boto3.resource("dynamodb", region_name=region)
        self.table = self.dynamodb.Table(table_name)

    def create_session(self, session: Session) -> Session:
        self.table.put_item(Item={
            "PK": f"SESSION#{session.session_id}",
            "SK": "METADATA",
            "data": json.dumps(session.__dict__)
        })
        return session

    def read_session(self, session_id: str):
        response = self.table.get_item(Key={
            "PK": f"SESSION#{session_id}",
            "SK": "METADATA"
        })
        if "Item" in response:
            return Session.from_dict(json.loads(response["Item"]["data"]))
        return None

    def create_message(self, session_id, agent_id, message):
        self.table.put_item(Item={
            "PK": f"SESSION#{session_id}#AGENT#{agent_id}",
            "SK": f"MSG#{message.message_id}",
            "data": json.dumps(message.__dict__)
        })
        return message

    # ... implement remaining methods
```

### 9.3 S3 for Large Artifacts

```python
from strands.session.s3_session_manager import S3SessionManager

# Automatic S3 persistence with configurable prefix
session_manager = S3SessionManager(
    session_id="production-session-001",
    bucket_name="my-agent-sessions",
    prefix="v2/sessions/"
)

agent = Agent(
    id="production_agent",
    session_manager=session_manager
)
```

---

## 10. Advanced Tool Patterns

### 10.1 Context-Aware Tools

Tools can access the full agent context through `ToolContext`:

```python
from strands import Agent, tool, ToolContext

@tool(context=True)
def smart_tool(query: str, tool_context: ToolContext) -> str:
    """A context-aware tool.

    Args:
        query: The query to process
    """
    # Access agent state
    user_prefs = tool_context.agent.state.get("preferences")

    # Access invocation state (request-scoped)
    request_id = tool_context.invocation_state.get("request_id")

    # Access the agent itself
    agent_name = tool_context.agent.name

    return f"Processed by {agent_name} for request {request_id}"
```

### 10.2 Concurrent Tool Execution

Strands supports concurrent tool execution for independent tool calls:

```python
from strands.tools.executors.concurrent import ConcurrentToolExecutor

agent = Agent(
    tools=[web_search, database_query, file_read],
    tool_executor=ConcurrentToolExecutor(max_workers=5)
)

# When the LLM requests multiple tool calls simultaneously,
# they execute in parallel
agent("Search the web for X, query the database for Y, and read file Z")
```

### 10.3 MCP Tool Integration

Native Model Context Protocol support for accessing external tool servers:

```python
from strands import Agent
from strands.tools.mcp import MCPClient

# Connect to an MCP server
mcp_client = MCPClient(
    command="uvx mcp-server-filesystem",
    args=["--allowed-directories", "/tmp"]
)

agent = Agent(tools=[mcp_client])
agent("List files in /tmp")
```

### 10.4 Tool Hot-Reloading

During development, tools can be modified without restarting the agent:

```python
agent = Agent(load_tools_from_directory=True)
# Agent watches ./tools/ directory for changes
# New or modified tools are picked up automatically
```

### 10.5 Streaming Tools

Tools can yield intermediate results for real-time feedback:

```python
@tool
async def long_running_analysis(data: str):
    """Perform analysis with progress updates.

    Args:
        data: The data to analyze
    """
    yield "Starting analysis..."
    result_1 = await step_1(data)
    yield f"Step 1 complete: {result_1}"
    result_2 = await step_2(result_1)
    yield f"Step 2 complete: {result_2}"
    yield f"Final result: {result_2}"
```

---

## 11. Production Patterns & Best Practices

### 11.1 Choosing the Right Multi-Agent Pattern

```
Is the task a simple question routing problem?
  Yes -> Agents as Tools

Does it require collaborative problem-solving with flexible handoffs?
  Yes -> Swarm

Does it have a fixed structure with clear dependencies?
  Yes -> Does it need LLM-driven conditional routing?
    Yes -> Graph
    No  -> Workflow

Need to combine patterns?
  -> Nest Swarms inside Graphs, or wrap agents as tools within graph nodes
```

### 11.2 Session Architecture Decisions

| Scenario | Recommended Approach |
|----------|---------------------|
| Development/testing | `FileSessionManager` with temp directories |
| Single-region production | `S3SessionManager` |
| Multi-region production | `S3SessionManager` with cross-region replication |
| Low-latency requirements | Custom `ValkeySessionManager` (community) |
| LTM with user personalization | `AgentCoreMemorySessionManager` |
| Custom compliance requirements | Custom `SessionRepository` implementation |

### 11.3 Conversation Management Strategy

| Scenario | Recommended Manager |
|----------|-------------------|
| Short conversations (<50 messages) | `NullConversationManager` |
| Long conversations, context not critical | `SlidingWindowConversationManager` |
| Long conversations, context preservation important | `SummarizingConversationManager` |
| External context management | `NullConversationManager` + custom logic |

### 11.4 Observability

Strands integrates with OpenTelemetry for production observability:

```python
from strands.telemetry.config import configure_telemetry

configure_telemetry(
    service_name="my-agent-service",
    exporter_endpoint="http://collector:4317"
)

# All agent operations are automatically traced:
# - Model calls (latency, tokens, cost)
# - Tool executions (inputs, outputs, duration)
# - Multi-agent handoffs and graph traversals
# - Session operations
```

### 11.5 Error Handling and Resilience

```python
from strands import Agent
from strands.agent.retry_strategies import ExponentialBackoffRetry

agent = Agent(
    retry_strategy=ExponentialBackoffRetry(
        max_retries=3,
        base_delay=1.0,
        max_delay=30.0
    )
)
```

### 11.6 Deployment Targets

Strands agents can be deployed to:
- **Bedrock AgentCore** — Managed agent hosting with auto-scaling
- **AWS Lambda** — Serverless, pay-per-invocation
- **AWS Fargate** — Container-based, long-running
- **AWS App Runner** — Simplified container deployment
- **Amazon EKS** — Kubernetes orchestration
- **Amazon EC2** — Full control
- **Docker** — Portable containers
- **Kubernetes** — Platform-agnostic orchestration
- **Terraform** — Infrastructure-as-code deployment

### 11.7 Experimental Features

| Feature | Status | Description |
|---------|--------|-------------|
| Bidirectional Streaming | Experimental | Real-time voice/audio with Nova Sonic, Gemini Live, OpenAI Realtime |
| Agent Config | Experimental | Declarative agent configuration |
| Steering & Plugins | Stable (vended) | Hook-based agent behavior steering |
| Skills | Stable (vended) | AgentSkills.io integration |

---

## 12. Sources & References

### Official Documentation
- [Strands Agents Documentation](https://strandsagents.com/docs/) — Full SDK documentation
- [Session Management](https://strandsagents.com/docs/user-guide/concepts/agents/session-management/) — Session persistence guide
- [State Management](https://strandsagents.com/docs/user-guide/concepts/agents/state/) — State layers documentation
- [Multi-agent Patterns](https://strandsagents.com/docs/user-guide/concepts/multi-agent/multi-agent-patterns/) — Pattern comparison
- [Graph Orchestration](https://strandsagents.com/docs/user-guide/concepts/multi-agent/graph/) — Graph-based workflows
- [Swarm Orchestration](https://strandsagents.com/docs/user-guide/concepts/multi-agent/swarm/) — Self-organizing agent teams
- [Agents as Tools](https://strandsagents.com/latest/user-guide/concepts/multi-agent/agents-as-tools/) — Hierarchical agent delegation
- [Workflow Pattern](https://strandsagents.com/docs/user-guide/concepts/multi-agent/workflow/) — Task-based workflows
- [A2A Protocol](https://strandsagents.com/docs/user-guide/concepts/multi-agent/agent-to-agent/) — Agent-to-Agent communication
- [Streaming Events](https://strandsagents.com/docs/user-guide/concepts/streaming/) — Real-time event streaming
- [Interrupts](https://strandsagents.com/docs/user-guide/concepts/interrupts/) — Human-in-the-loop patterns
- [Conversation Management](https://strandsagents.com/docs/user-guide/concepts/agents/conversation-management/) — Context window management
- [AgentCore Memory Session Manager](https://strandsagents.com/docs/community/session-managers/agentcore-memory/) — LTM integration

### GitHub
- [strands-agents/sdk-python](https://github.com/strands-agents/sdk-python) — Python SDK source (v1.30.0, 5300+ stars)
- [SDK Architecture (AGENTS.md)](https://github.com/strands-agents/sdk-python/blob/main/AGENTS.md) — Source code layout

### AWS Blog Posts
- [Introducing Strands Agents 1.0: Production-Ready Multi-Agent Orchestration Made Simple](https://aws.amazon.com/blogs/opensource/introducing-strands-agents-1-0-production-ready-multi-agent-orchestration-made-simple/) — v1.0 announcement
- [Strands Agents SDK: A Technical Deep Dive](https://aws.amazon.com/blogs/machine-learning/strands-agents-sdk-a-technical-deep-dive-into-agent-architectures-and-observability/) — Architecture and observability
- [Advanced Orchestration with Strands Agents](https://aws.amazon.com/blogs/machine-learning/customize-agent-workflows-with-advanced-orchestration-techniques-using-strands-agents/) — ReWOO and Reflexion patterns

### Community Resources
- [Understanding Multi-Agent Patterns in Strands Agent](https://dev.to/aws-builders/understanding-multi-agent-patterns-in-strands-agent-graph-swarm-and-workflow-4nb8) — Pattern comparison tutorial
- [Mastering Central State Management in Multi-Agent Systems](https://medium.com/@rlinlen/beyond-agent-to-agent-mastering-central-state-management-in-multi-agent-systems-with-strands-8b3e0f665902) — State management deep dive
- [Advanced Processing of Strands Agents](https://builder.aws.com/content/376o3RvCuXe0kqj4zNim2aXICej/advanced-processing-of-strands-agents-a-guide-for-aws-builders) — FastAPI streaming patterns

### DeepWiki Analysis
- [Strands SDK Python — Memory & Sessions](https://deepwiki.com/strands-agents/sdk-python) — Auto-generated architecture docs
- [Multi-Agent Patterns](https://deepwiki.com/strands-agents/sdk-python) — Orchestration pattern analysis

---

## Appendix A: SDK Source Structure (Relevant Modules)

```
src/strands/
  agent/
    agent.py                    # Main Agent class
    state.py                    # AgentState (key-value storage)
    a2a_agent.py                # A2AAgent client for remote agents
    conversation_manager/
      sliding_window_*.py       # Window-based context management
      summarizing_*.py          # Summarization-based context management
      null_*.py                 # No-op context management

  multiagent/
    base.py                     # MultiAgentBase (abstract)
    graph.py                    # Graph + GraphBuilder + GraphNode + GraphEdge
    swarm.py                    # Swarm orchestration
    a2a/
      server.py                 # A2AServer (expose agents via HTTP)
      executor.py               # StrandsA2AExecutor
      converters.py             # Strands <-> A2A type converters

  session/
    session_manager.py          # SessionManager (abstract)
    file_session_manager.py     # Local filesystem persistence
    s3_session_manager.py       # S3-based persistence
    repository_session_manager.py  # Generic repo-backed persistence
    session_repository.py       # SessionRepository interface

  types/
    session.py                  # Session, SessionAgent, SessionMessage dataclasses
    streaming.py                # Streaming event types
    interrupt.py                # Interrupt types

  tools/
    executors/
      concurrent.py             # Parallel tool execution
      sequential.py             # Sequential tool execution
    mcp/                        # MCP tool integration
    structured_output/          # Structured output handling

  telemetry/                    # OpenTelemetry integration
  experimental/
    bidi/                       # Bidirectional streaming (voice/audio)
```

---

## Appendix B: Quick Reference — Key Classes

| Class | Module | Purpose |
|-------|--------|---------|
| `Agent` | `strands.agent.agent` | Core agent with tools, state, sessions |
| `AgentState` | `strands.agent.state` | Key-value state storage |
| `A2AAgent` | `strands.agent.a2a_agent` | Client for remote A2A agents |
| `Swarm` | `strands.multiagent.swarm` | Self-organizing agent teams |
| `Graph` | `strands.multiagent.graph` | Directed graph orchestration |
| `GraphBuilder` | `strands.multiagent.graph` | Fluent API for building graphs |
| `A2AServer` | `strands.multiagent.a2a.server` | Expose agents via A2A HTTP |
| `FileSessionManager` | `strands.session` | Local file persistence |
| `S3SessionManager` | `strands.session` | S3-based persistence |
| `RepositorySessionManager` | `strands.session` | Custom backend persistence |
| `SlidingWindowConversationManager` | `strands.agent.conversation_manager` | Fixed-window context |
| `SummarizingConversationManager` | `strands.agent.conversation_manager` | Summarization-based context |
| `ToolContext` | `strands.types.tools` | Tool execution context |
| `InterruptData` | `strands.interrupt` | Human-in-the-loop interrupts |
| `AgentCoreMemorySessionManager` | `bedrock_agentcore.memory.integrations.strands` | LTM via Bedrock AgentCore |
