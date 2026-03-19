# Strands Agents Framework - Core Architecture & Deep Dive

> **Research date:** 2026-03-19
> **Sources:** Strands official docs (strandsagents.com), DeepWiki analysis (strands-agents/sdk-python), AWS blog posts, InfoQ, The New Stack
> **Related:** [[01-AgentCore-Architecture-Runtime]] | [[05-Strands-Advanced-Memory-MultiAgent]] | [[09-Multi-Provider-LLM-Support]]

---

## Overview and Philosophy

Strands Agents is an **open-source, model-driven SDK** for building AI agents, released by AWS in May 2025 under the Apache License 2.0. Available in both **Python** (mature, production-ready) and **TypeScript** (experimental preview since December 2025), it has been downloaded over 14 million times and powers production features in Amazon Q Developer, AWS Glue, and VPC Reachability Analyzer.

### The Model-Driven Approach

The central design philosophy is **letting the LLM drive the agent**, rather than forcing developers to define complex orchestration workflows. Strands embraces the capabilities of state-of-the-art models to:

- **Plan** multi-step task execution
- **Chain thoughts** for complex reasoning
- **Select tools** autonomously based on context
- **Reflect** on previous steps and self-correct

> "Compared with frameworks that require developers to define complex workflows for their agents, Strands simplifies agent development by embracing the capabilities of state-of-the-art models to plan, chain thoughts, call tools, and reflect."
> --- Clare Liguori, AWS Senior Principal Engineer

### Three Core Components

Every Strands agent is defined by exactly three things:

```
Agent = Model + Tools + Prompt
```

| Component | Role |
|-----------|------|
| **Model** | The reasoning engine -- any LLM with tool-use capabilities |
| **Tools** | Functions, MCP servers, or modules the agent can invoke |
| **Prompt** | System instructions that define the agent's role and constraints |

This simplicity is deliberate. Where it previously took Q Developer teams **months** to go from prototype to production, Strands reduced that timeline to **days and weeks**.

### Design Principles

1. **Model-driven over workflow-driven**: Trust the LLM's native reasoning rather than hardcoding execution paths
2. **Simplicity at the core**: A basic agent is 3 lines of code; complexity is opt-in
3. **Production-first**: Built for real workloads, not just demos
4. **Provider-agnostic**: Works with Bedrock, OpenAI, Anthropic, Ollama, local models, and more
5. **Deployment-agnostic**: Run locally, on Lambda, Fargate, ECS, EKS, or Bedrock AgentCore
6. **Open ecosystem**: Apache 2.0 license with contributions from Anthropic, Meta, Accenture, and others

### Origin Story

The Strands team started building AI agents in early 2023 alongside the ReAct (Reasoning and Acting) paper. At that time, LLMs needed complex scaffolding: prompt instructions on tool use, output parsers, and orchestration logic. As models rapidly improved with native tool-use and reasoning, the team realized the complex frameworks were **getting in the way** of leveraging newer LLM capabilities. Strands was born from this insight -- strip away the orchestration complexity and let the model do what it does best.

---

## Architecture Deep Dive

### High-Level Architecture

```
+------------------------------------------------------------------+
|                         Agent                                     |
|                                                                   |
|  +------------+  +----------------+  +-------------------------+  |
|  | System     |  | Model Provider |  | Tool Registry           |  |
|  | Prompt     |  | (Bedrock,      |  | (@tool decorators,      |  |
|  |            |  |  OpenAI, etc.) |  |  MCP clients,           |  |
|  +------------+  +----------------+  |  module tools)           |  |
|                                      +-------------------------+  |
|  +------------------------------------------------------------+  |
|  |                    Event Loop                               |  |
|  |  [Invoke Model] -> [Check Stop Reason] -> [Execute Tools]  |  |
|  |       ^                                        |            |  |
|  |       +----------------------------------------+            |  |
|  +------------------------------------------------------------+  |
|                                                                   |
|  +------------------+  +------------------+  +------------------+ |
|  | Conversation     |  | Hook Registry    |  | Session Manager  | |
|  | Manager          |  | (lifecycle       |  | (File, S3,       | |
|  | (sliding window, |  |  events)         |  |  repository)     | |
|  |  summarizing)    |  |                  |  |                  | |
|  +------------------+  +------------------+  +------------------+ |
|                                                                   |
|  +------------------+  +------------------+  +------------------+ |
|  | Plugin System    |  | Tool Executors   |  | Streaming        | |
|  | (skills,         |  | (concurrent,     |  | (async iterators,| |
|  |  steering)       |  |  sequential)     |  |  callbacks)      | |
|  +------------------+  +------------------+  +------------------+ |
+------------------------------------------------------------------+
```

### Core Python Package Structure

```
strands/
  agent/
    agent.py              # Main Agent class
    a2a_agent.py          # Agent-to-Agent protocol support
    agent_result.py       # AgentResult handling
    base.py               # Base agent abstractions
    conversation_manager/ # Context window management strategies
  event_loop/
    event_loop.py         # Central event loop (event_loop_cycle)
    streaming.py          # Stream message processing
  models/
    model.py              # Abstract Model base class
    bedrock.py            # Amazon Bedrock provider
    openai.py             # OpenAI provider
    anthropic.py          # Anthropic direct API
    ollama.py             # Ollama local models
    litellm.py            # LiteLLM multi-provider
    gemini.py             # Google Gemini
    llamaapi.py           # Meta Llama API
    llamacpp.py           # llama.cpp local inference
    mistral.py            # Mistral AI
    sagemaker.py          # SageMaker endpoints
    writer.py             # Writer API
  tools/
    decorator.py          # @tool decorator implementation
    registry.py           # ToolRegistry -- manages tool lifecycle
    loader.py             # Tool loading from files/modules
    tools.py              # Tool type definitions
    tool_provider.py      # ToolProvider interface
    watcher.py            # Hot-reload tool watching
    executors/
      concurrent.py       # ConcurrentToolExecutor (default)
      sequential.py       # SequentialToolExecutor
    mcp/
      mcp_client.py       # MCP client integration
      mcp_agent_tool.py   # Adapt MCP tools to agent framework
      mcp_types.py        # MCP type definitions
    structured_output/    # Schema-driven structured responses
  hooks/
    events.py             # Hook event types
    registry.py           # HookRegistry
  plugins/
    plugin.py             # Plugin base class
    decorator.py          # @hook decorator
    registry.py           # Plugin registry
  session/
    session_manager.py    # SessionManager interface
    file_session_manager.py
    s3_session_manager.py
    repository_session_manager.py
  multiagent/
    base.py               # Multi-agent base patterns
    graph.py              # Graph-based orchestration
    swarm.py              # Swarm collaboration
    a2a/                  # Agent-to-Agent protocol
  telemetry/
    config.py             # OpenTelemetry configuration
    metrics.py            # Metrics collection
    tracer.py             # Tracing spans
  interrupt.py            # Human-in-the-loop interrupts
  handlers/
    callback_handler.py   # Streaming callback handler
  types/                  # Type definitions (content, tools, streaming, etc.)
  experimental/
    bidi/                 # Bidirectional streaming (voice agents)
    agent_config.py       # Declarative agent configuration
  vended_plugins/
    skills/               # Agent Skills specification support
    steering/             # Steering hooks for complex tasks
```

### Agent Class Initialization

The `Agent` class is the central orchestrator. During initialization it:

1. **Configures the model provider** -- defaults to `BedrockModel` with Claude Sonnet if none specified
2. **Sets up the ToolRegistry** -- processes tools from functions, modules, file paths, MCP clients, and `ToolProvider` instances
3. **Initializes the HookRegistry** -- for lifecycle event callbacks
4. **Configures the ConversationManager** -- defaults to `SlidingWindowConversationManager`
5. **Sets up the SessionManager** -- for state persistence (if provided)
6. **Registers plugins** -- Skills, Steering, or custom plugins that modify agent behavior

```python
from strands import Agent
from strands.models.bedrock import BedrockModel

# Minimal agent -- uses Bedrock Claude Sonnet by default
agent = Agent()

# Fully configured agent
agent = Agent(
    model=BedrockModel(model_id="anthropic.claude-sonnet-4-20250514-v1:0"),
    system_prompt="You are a helpful assistant specializing in AWS.",
    tools=[my_tool, mcp_client, another_tool],
    conversation_manager=SlidingWindowConversationManager(window_size=40),
    session_manager=FileSessionManager(session_dir="./sessions"),
    hooks=[my_custom_hook],
    plugins=[SkillsPlugin(), SteeringPlugin()],
    tool_executor=ConcurrentToolExecutor(),
    retry_strategy=ModelRetryStrategy(max_attempts=3),
    name="aws-assistant"
)
```

---

## Agent Loop and Execution Model

The agent loop is the **foundational concept** in Strands. Everything else builds on top of it.

> "A language model can answer questions. An agent can *do things*. The agent loop is what makes that difference possible."

### How the Loop Works

The loop follows a recursive cycle:

```
Input & Context --> [Reasoning (LLM)] --> [Tool Selection] --> [Tool Execution] --> back to Reasoning
                                                                        |
                                                                  (until done)
                                                                        |
                                                                        v
                                                                    Response
```

Each iteration:
1. **Invoke the model** with the full conversation history (messages + system prompt + tool descriptions)
2. **Check the stop reason** from the model's response
3. If `tool_use`: execute the requested tools, append results to history, loop back to step 1
4. If `end_turn`: return the final response
5. If `max_tokens`, `content_filtered`, `guardrail_intervention`: terminate with appropriate handling

### The `event_loop_cycle` Function

The core implementation lives in `src/strands/event_loop/event_loop.py`. The `event_loop_cycle` function orchestrates a single turn:

1. **Initialization**: Sets up cycle state, metrics, and creates a tracing span
2. **Model execution** (`_handle_model_execution`):
   - Fires `BeforeModelCallEvent` hook
   - Streams messages from the model via the provider's `stream()` method
   - Fires `AfterModelCallEvent` hook
   - Returns the model's response with stop reason
3. **Tool execution** (`_handle_tool_execution`):
   - Validates tool requests against tool schemas
   - Fires `BeforeToolCallEvent` hook for each tool
   - Executes tools via the configured `ToolExecutor`
   - Fires `AfterToolCallEvent` hook for each tool
   - Appends tool results to conversation history
4. **Recursion**: If more actions needed (after tool execution, or for structured output enforcement), the cycle recurses
5. **Termination**: When a terminal stop reason is reached

### Stop Reasons

| Stop Reason | Behavior | Terminal? |
|-------------|----------|-----------|
| `end_turn` | Model finished, no more actions needed | Yes (success) |
| `tool_use` | Model wants to execute tools | No (loop continues) |
| `cancelled` | Agent stopped via `agent.cancel()` | Yes |
| `max_tokens` | Response truncated at token limit | Yes (error) |
| `stop_sequence` | Hit configured stop sequence | Yes (success) |
| `content_filtered` | Blocked by safety mechanisms | Yes (error) |
| `guardrail_intervention` | Guardrail policy stopped generation | Yes (error) |

### Context Accumulation

What makes the loop powerful is **context accumulation**. Each iteration adds messages to the conversation history. The model sees:
- The original user request
- Every tool it has called
- Every result it has received
- Its own previous reasoning

This accumulated context enables sophisticated multi-step reasoning and self-correction.

### Cancellation

The `agent.cancel()` method provides thread-safe loop termination:

```python
import threading
import time
from strands import Agent

def timeout_watchdog(agent: Agent, timeout: float) -> None:
    time.sleep(timeout)
    agent.cancel()

agent = Agent()
watchdog = threading.Thread(target=timeout_watchdog, args=(agent, 30.0))
watchdog.start()

result = agent("Analyze this large dataset")
if result.stop_reason == "cancelled":
    print("Agent was cancelled due to timeout")
```

Cancellation checkpoints:
- During model response streaming: partial output is discarded
- Before tool execution: tool calls are skipped with error results to maintain valid conversation state

The cancel signal clears automatically when invocation completes, so the agent is immediately reusable.

### Interrupts (Human-in-the-Loop)

Unlike cancellation (which terminates), **interrupts** pause the agent for human input and allow resumption:

```
Invoke Agent --> Execute Hook/Tool --> Interrupts Raised?
    |                                       |
    No --> Continue                   Yes --> Stop Loop --> Return Interrupts
                                                           --> Respond to Interrupts
                                                           --> Resume from interruption point
```

Interrupts can be raised from hooks or tools, enabling approval workflows, clarification requests, and multi-step human collaboration.

### Retry Strategy

Strands automatically retries `ModelThrottledException` with exponential backoff:

```
Attempt 1: fails -> wait 4s
Attempt 2: fails -> wait 8s
Attempt 3: fails -> wait 16s
...up to max_attempts (default 6)
```

Customizable via `ModelRetryStrategy`:

```python
from strands import Agent, ModelRetryStrategy

agent = Agent(
    retry_strategy=ModelRetryStrategy(
        max_attempts=3,
        initial_delay=2,
        max_delay=60
    )
)
```

For fine-grained control, use `AfterModelCallEvent` hooks to implement custom retry logic with arbitrary conditions.

---

## Tool System

Tools are the primary mechanism for extending agent capabilities beyond text generation. They allow agents to interact with external systems, access data, and manipulate their environment.

### Tool Types

Strands supports three categories of tools:

| Type | Description | Use Case |
|------|-------------|----------|
| **Custom tools** (`@tool` decorator) | Python/TS functions transformed into tools | Application-specific logic |
| **Community tools** (`strands-agents-tools`) | 30+ pre-built tools | File ops, HTTP, AWS APIs, RAG |
| **MCP tools** (`MCPClient`) | Tools from Model Context Protocol servers | Thousands of published MCP servers |

### Creating Tools with `@tool` Decorator

The `@tool` decorator automatically extracts metadata from docstrings and type hints:

```python
from strands import tool

@tool
def weather_forecast(city: str, days: int = 3) -> str:
    """Get weather forecast for a city.

    Args:
        city: The name of the city
        days: Number of days for the forecast
    """
    return f"Weather forecast for {city} for the next {days} days..."
```

The decorator:
1. Extracts the first docstring paragraph as the **tool description**
2. Parses the `Args:` section for **parameter descriptions**
3. Uses Python type hints for **JSON schema generation**
4. Registers the function with its generated `ToolSpec`

#### Overriding Tool Metadata

```python
@tool(name="get_weather", description="Retrieves weather forecast for a specified location")
def weather_forecast(city: str, days: int = 3) -> str:
    """Implementation function for weather forecasting."""
    return f"Weather forecast for {city} for {days} days..."
```

#### Custom Input Schema

```python
@tool(
    inputSchema={
        "json": {
            "type": "object",
            "properties": {
                "shape": {"type": "string", "enum": ["circle", "rectangle"]},
                "radius": {"type": "number"},
            },
            "required": ["shape"]
        }
    }
)
def calculate_area(shape: str, radius: float = None) -> float:
    """Calculate area of a shape."""
    import math
    if shape == "circle" and radius is not None:
        return math.pi * radius ** 2
    return 0.0
```

#### TypeScript Tools (Zod or JSON Schema)

```typescript
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

const weatherTool = tool({
  name: 'weather_forecast',
  description: 'Get weather forecast for a city',
  inputSchema: z.object({
    city: z.string().describe('The name of the city'),
    days: z.number().default(3).describe('Number of days'),
  }),
  callback: (input) => {
    return `Weather forecast for ${input.city} for the next ${input.days} days...`
  },
})
```

### ToolContext -- Accessing Execution Context

Tools can access their execution context for agent interaction, tool metadata, and invocation state:

```python
from strands import tool, Agent, ToolContext

@tool(context=True)
def get_self_name(tool_context: ToolContext) -> str:
    return f"The agent name is {tool_context.agent.name}"

@tool(context=True)
def api_call(query: str, tool_context: ToolContext) -> dict:
    """Make an API call with user context.

    Args:
        query: The search query
    """
    user_id = tool_context.invocation_state.get("user_id")
    # Use user_id for authenticated API calls
    return {"result": f"Data for {user_id}"}

agent = Agent(tools=[api_call])
result = agent("Get my profile data", user_id="user123")
```

**State access patterns:**

| Pattern | Use Case | Example |
|---------|----------|---------|
| **Tool Parameters** | Data the LLM reasons about | Search queries, file paths |
| **Invocation State** | Per-request config not in prompts | User IDs, session IDs |
| **Class-based tools** | Shared resources across requests | API keys, DB connections |

### Async Tools and Streaming

Async tools can yield intermediate results for real-time progress:

```python
from strands import tool
import asyncio

@tool
async def process_dataset(records: int) -> str:
    """Process records with progress updates."""
    for i in range(records):
        await asyncio.sleep(0.1)
        if i % 10 == 0:
            yield f"Processed {i}/{records} records"
    yield f"Completed {records} records"
```

### Class-Based Tools

For tools needing shared state and resources:

```python
from strands import tool

class DatabaseTools:
    def __init__(self, connection_string: str):
        self.conn = connect(connection_string)

    @tool
    def query(self, sql: str) -> str:
        """Execute a SQL query.

        Args:
            sql: The SQL query to execute
        """
        return str(self.conn.execute(sql).fetchall())

    @tool
    def insert(self, table: str, data: dict) -> str:
        """Insert data into a table.

        Args:
            table: Target table name
            data: Data to insert
        """
        self.conn.execute(f"INSERT INTO {table} ...", data)
        return "Inserted successfully"

db = DatabaseTools("postgresql://...")
agent = Agent(tools=[db.query, db.insert])
```

### Module-Based Tools (Python only)

Tools as standalone Python modules without SDK dependency:

```python
# my_tool.py
TOOL_SPEC = {
    "name": "my_tool",
    "description": "Does something useful",
    "inputSchema": {
        "json": {
            "type": "object",
            "properties": {
                "input": {"type": "string", "description": "The input"}
            },
            "required": ["input"]
        }
    }
}

def my_tool(tool_use_id: str, input: str) -> dict:
    return {"status": "success", "content": [{"text": f"Result: {input}"}]}
```

### Tool Registry

The `ToolRegistry` manages the complete tool lifecycle:

- **Registration**: Processes tools from functions, modules, file paths, MCP clients, `ToolProvider` instances
- **Discovery**: Tools are described to the model via their `ToolSpec` JSON schemas
- **Hot-reloading**: Can watch directories for tool file changes via the `Watcher`
- **Validation**: Validates tool call inputs against JSON schemas before execution

### Tool Execution

When the model requests a tool:

1. **Validate** the request against the tool's schema
2. **Locate** the tool in the registry
3. **Execute** with error handling (errors go back to model, not thrown as exceptions)
4. **Format** the result as a `ToolResult` message

Error resilience is key: tool failures are reported back to the model as error results, giving it the opportunity to recover or try alternatives rather than terminating the loop.

### Tool Executors

Control parallel vs sequential execution:

```python
from strands import Agent
from strands.tools.executors import ConcurrentToolExecutor, SequentialToolExecutor

# Default: concurrent execution when model returns multiple tool requests
agent = Agent(tool_executor=ConcurrentToolExecutor(), tools=[...])

# Sequential: tools execute in order even if model returns multiple
agent = Agent(tool_executor=SequentialToolExecutor(), tools=[...])
```

### MCP Tool Integration

Strands has first-class support for the Model Context Protocol:

```python
from strands import Agent
from strands.tools.mcp import MCPClient
from mcp import stdio_client, StdioServerParameters

# Connect to an MCP server
mcp_tools = MCPClient(lambda: stdio_client(
    StdioServerParameters(command="uvx", args=["my-mcp-server"])
))

with mcp_tools:
    tools = mcp_tools.list_tools_sync()
    agent = Agent(tools=tools)
    agent("Use MCP tools to help me")
```

Supports multiple transports: stdio, streamable HTTP, AWS IAM, and SSE. Multiple MCP servers can be combined in a single agent.

The `MCPClient` implements `ToolProvider`, enabling automatic lifecycle management when passed directly to the Agent constructor.

---

## Model Provider Abstraction

### The `Model` Abstract Base Class

All model providers implement the same interface defined in `strands.models.model`:

```python
class Model(ABC):
    @abstractmethod
    def update_config(self, **kwargs) -> None:
        """Update model configuration."""

    @abstractmethod
    def get_config(self) -> dict:
        """Get current configuration."""

    @abstractmethod
    def stream(self, messages, system_prompt, tool_specs, **kwargs):
        """Stream responses from the model.

        Yields StreamEvent objects that the event loop processes.
        """

    def structured_output(self, output_model, messages, ...):
        """Optional: Generate structured output conforming to a schema."""
```

The `stream()` method is the critical interface -- it yields `StreamEvent` objects that the event loop processes. This enables real-time streaming of model responses.

### StreamEvent Types

Custom model providers must emit these event types:

| Event | Purpose |
|-------|---------|
| `messageStart` | Signals beginning of model response |
| `contentBlockStart` | Start of a text or tool-use block |
| `contentBlockDelta` | Incremental content (text chunks, tool input) |
| `contentBlockStop` | End of a content block |
| `messageStop` | End of response with stop reason |
| `metadata` | Usage metrics (input/output tokens) |
| `redaction` | Guardrail redaction events |

### Supported Providers

#### Official (Python + TypeScript where noted)

| Provider | Class | Default Model | Notes |
|----------|-------|---------------|-------|
| **Amazon Bedrock** | `BedrockModel` | Claude Sonnet 4 | Default provider; TS support |
| **Amazon Nova** | `NovaSonicModel` | Nova models | Bidirectional streaming |
| **Anthropic** | `AnthropicModel` | Claude family | Direct API access |
| **OpenAI** | `OpenAIModel` | GPT-4o | TS support |
| **Gemini** | `GeminiModel` | Gemini Pro | TS support |
| **LiteLLM** | `LiteLLMModel` | Any | Meta-provider for 100+ models |
| **Ollama** | `OllamaModel` | Any local model | Local development |
| **llama.cpp** | `LlamaCppModel` | Any GGUF model | Edge/local inference |
| **LlamaAPI** | `LlamaAPIModel` | Llama family | Meta's official API |
| **MistralAI** | `MistralModel` | Mistral models | |
| **SageMaker** | `SageMakerModel` | Any endpoint | Custom inference endpoints |
| **Writer** | `WriterModel` | Palmyra models | |

#### Community Providers

Cohere, CLOVA Studio, Fireworks AI, MLX, Nebius, NVIDIA NIM, SGLang, vLLM, xAI

### Provider Installation

```bash
# Install with specific provider
pip install 'strands-agents[bedrock]'
pip install 'strands-agents[openai]'
pip install 'strands-agents[anthropic]'

# Install all providers
pip install 'strands-agents[all]'
```

### Provider Swapping

Models are fully interchangeable -- switch providers by changing the model instance:

```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.models.openai import OpenAIModel

# Use Bedrock
bedrock = BedrockModel(model_id="anthropic.claude-sonnet-4-20250514-v1:0")
agent = Agent(model=bedrock)
response = agent("What can you help me with?")

# Switch to OpenAI -- same agent pattern, different model
openai = OpenAIModel(client_args={"api_key": "<KEY>"}, model_id="gpt-4o")
agent = Agent(model=openai)
response = agent("What can you help me with?")
```

### Amazon Bedrock Provider (Default)

The `BedrockModel` is the default and most feature-rich provider:

```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from botocore.config import Config as BotocoreConfig

model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
    region_name="us-east-1",
    temperature=0.3,
    top_p=0.8,
    max_tokens=4096,
    stop_sequences=["###"],
    boto_client_config=BotocoreConfig(
        retries={"max_attempts": 3, "mode": "standard"},
        connect_timeout=5,
        read_timeout=60
    ),
    streaming=True,  # Default; set False for non-streaming models
)

agent = Agent(model=model)
```

**Advanced Bedrock Features:**
- Multimodal support (images, documents, video)
- S3 location references for large content
- Guardrail integration (content filtering)
- System prompt, tool, and message **caching** for reduced latency/cost
- Runtime config updates via `model.update_config()`
- Reasoning support (extended thinking)
- Structured output with schema enforcement

### Building a Custom Provider

Implement the `Model` abstract class:

```python
from strands.models.model import Model

class MyCustomModel(Model):
    def __init__(self, api_key: str, model_name: str):
        self.api_key = api_key
        self.model_name = model_name

    def update_config(self, **kwargs):
        # Update configuration parameters
        pass

    def get_config(self):
        return {"model_name": self.model_name}

    def stream(self, messages, system_prompt=None, tool_specs=None, **kwargs):
        # Convert Strands types to your API format
        # Call your API
        # Yield StreamEvent objects:
        #   messageStart, contentBlockStart, contentBlockDelta,
        #   contentBlockStop, messageStop, metadata
        pass

# Use it like any other provider
agent = Agent(model=MyCustomModel(api_key="...", model_name="my-model"))
```

Key considerations for custom providers:
1. **Stream interface**: Must yield `StreamEvent` dicts with proper structure
2. **Message formatting**: Convert Strands `Message`, `ToolSpec`, `SystemPrompt` types to your API format
3. **Tool support**: Map tool specifications to your API's function calling format
4. **Error handling**: Raise `ModelThrottledException` for rate limits (enables retry)
5. **Streaming**: Handle both streaming and non-streaming modes

---

## Hooks and Plugin System

### Hook System

Hooks are a composable extensibility mechanism for subscribing to events throughout the agent lifecycle. They are strongly-typed and support multiple subscribers per event type.

#### Hook Event Lifecycle

```
BeforeInvocationEvent
  |
  v
BeforeModelCallEvent -> [Model Inference] -> AfterModelCallEvent
  |
  v
BeforeToolsEvent
  |
  v (for each tool)
BeforeToolCallEvent -> [Tool Execution] -> AfterToolCallEvent
  |
  v
AfterToolsEvent
  |
  v
MessageAddedEvent
  |
  v (loop back to BeforeModelCallEvent if more tools needed)
  |
  v
AfterInvocationEvent
```

#### Available Events

| Event | Timing | Key Properties |
|-------|--------|----------------|
| `BeforeInvocationEvent` | Before agent starts processing | messages, system_prompt, tools |
| `AfterInvocationEvent` | After agent completes | result, messages |
| `BeforeModelCallEvent` | Before each model API call | messages, model_config |
| `AfterModelCallEvent` | After each model response | response, stop_reason, retry flag |
| `BeforeToolCallEvent` | Before each tool execution | tool_name, tool_input, skip flag |
| `AfterToolCallEvent` | After each tool execution | tool_name, result, error |
| `BeforeToolsEvent` | Before tool batch execution | tool_calls |
| `AfterToolsEvent` | After tool batch execution | results |
| `MessageAddedEvent` | When a message is added to history | message |

#### Registering Hooks

```python
from strands import Agent
from strands.hooks import AfterModelCallEvent, BeforeToolCallEvent

agent = Agent()

# Register individual callbacks
@agent.hooks.on(AfterModelCallEvent)
async def log_model_response(event: AfterModelCallEvent):
    print(f"Model responded with stop_reason: {event.stop_reason}")

@agent.hooks.on(BeforeToolCallEvent)
async def approve_tool(event: BeforeToolCallEvent):
    if event.tool_name == "dangerous_tool":
        event.skip = True  # Skip this tool call
```

#### Modifiable Event Properties

Most event properties are read-only, but certain key properties can be modified:

- `AfterModelCallEvent.retry = True` -- trigger model retry
- `BeforeToolCallEvent.skip = True` -- skip tool execution
- `BeforeToolCallEvent.tool_input` -- modify tool input arguments
- `AfterToolCallEvent.result` -- modify tool result before it goes to the model

### Plugin System

Plugins bundle multiple hooks and tools into reusable components:

```python
from strands.plugins import plugin, hook
from strands.hooks import BeforeInvocationEvent, AfterToolCallEvent

@plugin
class AuditPlugin:
    """Audit all agent actions."""

    def __init__(self, log_path: str):
        self.log_path = log_path

    @hook(BeforeInvocationEvent)
    async def log_start(self, event):
        with open(self.log_path, "a") as f:
            f.write(f"Invocation started: {event.messages[-1]}\n")

    @hook(AfterToolCallEvent)
    async def log_tool(self, event):
        with open(self.log_path, "a") as f:
            f.write(f"Tool {event.tool_name}: {event.result}\n")

agent = Agent(plugins=[AuditPlugin(log_path="audit.log")])
```

#### Built-in Plugins

| Plugin | Purpose |
|--------|---------|
| **Skills** | On-demand modular instructions following the [Agent Skills spec](https://agentskills.io/specification) |
| **Steering** | Context-aware guidance that provides feedback at the right moment without rigid workflows |
| **Agent Control** (community) | Runtime guardrails without code changes |
| **Datadog AI Guard** (community) | Datadog integration for AI observability |

---

## State and Conversation Management

### Three Forms of State

| State Type | Scope | Passed to Model? | Use Case |
|------------|-------|-------------------|----------|
| **Conversation History** | Multi-turn | Yes | Messages between user and agent |
| **Agent State** | Multi-request | No | Key-value storage (user prefs, counters) |
| **Request State** | Single request | No | Per-invocation context (user ID, session) |

### Conversation Managers

Manage context window growth with pluggable strategies:

#### NullConversationManager
No management -- conversation grows unbounded. Useful for single-turn agents.

#### SlidingWindowConversationManager (Default)
Keeps a fixed number of recent messages:

```python
from strands.agent.conversation_manager import SlidingWindowConversationManager

agent = Agent(
    conversation_manager=SlidingWindowConversationManager(window_size=40)
)
```

Automatically trims older messages when context exceeds the window, preserving tool call/result pairs for consistency.

#### SummarizingConversationManager (Python only)
Uses the model itself to summarize older context:

```python
from strands.agent.conversation_manager import SummarizingConversationManager

agent = Agent(
    conversation_manager=SummarizingConversationManager(
        summary_ratio=0.3  # Summarize when 30% of context used
    )
)
```

### Session Management

Persist state across application restarts and distributed environments:

```python
from strands import Agent
from strands.session import FileSessionManager

# Create with file-based persistence
agent = Agent(
    session_manager=FileSessionManager(session_dir="./sessions"),
    session_id="user-123-session"
)

# State persists automatically
agent("Remember my name is Alice")
# ... application restarts ...
agent("What is my name?")  # "Your name is Alice"
```

**Built-in Session Managers:**
- `FileSessionManager` -- Local filesystem
- `S3SessionManager` -- Amazon S3
- `RepositorySessionManager` -- Custom backend

**Community Session Managers:**
- AgentCore Memory -- Bedrock AgentCore native memory
- Valkey Session Manager -- Redis-compatible distributed store

Session data includes:
- Conversation history (messages)
- Agent state (key-value pairs)
- Tool configurations
- Multi-agent shared state

---

## Streaming

Strands provides real-time streaming for responsive UIs and monitoring.

### Two Streaming Approaches

| Approach | Best For | Execution Model |
|----------|----------|-----------------|
| **Async Iterators** | Server frameworks, async applications | `async for event in agent.stream_async(...)` |
| **Callback Handlers** (Python only) | Synchronous apps, custom processing | `agent(prompt, callback_handler=handler)` |

### Event Types

#### Lifecycle Events
- `BeforeInvocationEvent`, `AfterInvocationEvent`
- `InitializedEvent`

#### Model Stream Events
- `ModelMessageStartEvent`, `ModelMessageStopEvent`
- `ModelContentBlockStartEvent`, `ModelContentBlockDeltaEvent`, `ModelContentBlockStopEvent`
- `ModelMetadataEvent` (usage/token info)
- `ModelRedactionEvent` (guardrail redactions)

#### Tool Events
- `ToolResultEvent` -- final tool result
- `ToolStreamEvent` / `ToolStreamUpdateEvent` -- intermediate tool updates

### Async Iterator Example

```python
import asyncio
from strands import Agent

async def main():
    agent = Agent()
    async for event in agent.stream_async("Write a poem about coding"):
        if hasattr(event, 'data') and hasattr(event.data, 'text'):
            print(event.data.text, end="", flush=True)

asyncio.run(main())
```

### TypeScript Streaming

```typescript
const agent = new Agent({ model: bedrockModel })

for await (const event of agent.stream('Tell me about AWS')) {
  if (event.type === 'contentBlockDelta' && event.delta?.text) {
    process.stdout.write(event.delta.text)
  }
}
```

---

## Structured Output

Get type-safe, validated responses from agents:

```python
from pydantic import BaseModel
from strands import Agent

class WeatherReport(BaseModel):
    city: str
    temperature: float
    conditions: str
    humidity: int

agent = Agent(structured_output_model=WeatherReport)
result = agent("What's the weather in Seattle?")
report = result.output  # WeatherReport instance
print(f"{report.city}: {report.temperature}F, {report.conditions}")
```

The system converts Pydantic/Zod schemas into tool specifications that guide the model to produce correctly formatted responses. All model providers support structured output.

---

## Observability and Telemetry

Strands integrates with **OpenTelemetry** for production observability:

- **Traces**: Span-based tracing of agent invocations, model calls, and tool executions
- **Metrics**: Token usage, latency, tool call counts, error rates
- **Logs**: Structured logging with configurable verbosity

Each event loop cycle creates a tracing span, and hooks fire at every lifecycle point for custom metric collection.

---

## Deployment

### Local Development

```bash
pip install strands-agents
python agent.py
```

### Production Deployment Options

| Target | Description |
|--------|-------------|
| **Bedrock AgentCore Runtime** | Serverless, session-isolated microVMs, auto-scaling |
| **AWS Lambda** | Event-driven, pay-per-use |
| **AWS Fargate** | Containerized, long-running agents |
| **Amazon EKS** | Kubernetes orchestration |
| **Amazon EC2** | Full control, GPU instances |
| **Docker/Kubernetes** | Any container environment |
| **AWS App Runner** | Simplified container deployment |
| **Terraform** | IaC-based deployment |

### Bedrock AgentCore Integration

Strands is the native framework for AgentCore Runtime:

```python
# Deploy to AgentCore -- the agent code stays the same
from strands import Agent

agent = Agent(
    system_prompt="You are a helpful assistant",
    tools=[my_tool]
)

# AgentCore provides:
# - Session isolation (dedicated microVMs per user)
# - Session persistence
# - Auto-scaling to thousands of sessions
# - Identity integration (Cognito, Entra ID, Okta)
# - Built-in observability
```

See [[01-AgentCore-Architecture-Runtime]] for full AgentCore deployment details.

---

## Getting Started Examples

### Minimal Agent (3 Lines)

```python
from strands import Agent

agent = Agent()
agent("What is the capital of France?")
```

Uses Bedrock Claude Sonnet by default. Requires AWS credentials configured.

### Agent with Custom Tools

```python
from strands import Agent, tool
import math

@tool
def calculate_circle_area(radius: float) -> str:
    """Calculate the area of a circle.

    Args:
        radius: The radius of the circle
    """
    area = math.pi * radius ** 2
    return f"The area is {area:.2f} square units"

@tool
def get_current_time(timezone: str = "UTC") -> str:
    """Get the current time in a timezone.

    Args:
        timezone: IANA timezone name
    """
    from datetime import datetime
    import pytz
    tz = pytz.timezone(timezone)
    return datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S %Z")

agent = Agent(
    system_prompt="You are a helpful assistant with math and time tools.",
    tools=[calculate_circle_area, get_current_time]
)

agent("What time is it in Tokyo, and what is the area of a circle with radius 7?")
```

### Agent with MCP Tools

```python
from strands import Agent
from strands.tools.mcp import MCPClient
from mcp import stdio_client, StdioServerParameters

# Use a filesystem MCP server
fs_tools = MCPClient(lambda: stdio_client(
    StdioServerParameters(command="npx", args=["-y", "@modelcontextprotocol/server-filesystem", "/tmp"])
))

with fs_tools:
    agent = Agent(tools=fs_tools.list_tools_sync())
    agent("List all files in /tmp and summarize what you find")
```

### Agent with Conversation Memory

```python
from strands import Agent
from strands.session import FileSessionManager

agent = Agent(
    system_prompt="You are a personal assistant. Remember user preferences.",
    session_manager=FileSessionManager(session_dir="./sessions"),
    session_id="user-alice"
)

# First conversation
agent("My favorite color is blue and I prefer metric units")

# Later conversation (state persisted)
agent("What units should you use when giving me measurements?")
# Agent remembers: "metric units"
```

### Multi-Provider Agent

```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.models.openai import OpenAIModel
from strands.models.ollama import OllamaModel

# Same tools, different models
tools = [my_tool_a, my_tool_b]

# Production: Bedrock Claude
prod_agent = Agent(
    model=BedrockModel(model_id="anthropic.claude-sonnet-4-20250514-v1:0"),
    tools=tools
)

# Development: Local Ollama
dev_agent = Agent(
    model=OllamaModel(host="http://localhost:11434", model_id="llama3.2"),
    tools=tools
)

# Alternative: OpenAI
alt_agent = Agent(
    model=OpenAIModel(client_args={"api_key": "..."}, model_id="gpt-4o"),
    tools=tools
)
```

### The Original Naming Agent (from launch blog)

```python
from strands import Agent
from strands.tools.mcp import MCPClient
from strands_tools import http_request
from mcp import stdio_client, StdioServerParameters

NAMING_SYSTEM_PROMPT = """
You are an assistant that helps to name open source projects.
When providing open source project name suggestions, always provide
one or more available domain names and one or more available GitHub
organization names that could be used for the project.
Before providing your suggestions, use your tools to validate
that the domain names are not already registered and that the GitHub
organization names are not already used.
"""

domain_name_tools = MCPClient(lambda: stdio_client(
    StdioServerParameters(command="uvx", args=["fastdomaincheck-mcp-server"])
))

github_tools = [http_request]

with domain_name_tools:
    tools = domain_name_tools.list_tools_sync() + github_tools
    naming_agent = Agent(
        system_prompt=NAMING_SYSTEM_PROMPT,
        tools=tools
    )
    naming_agent("I need to name an open source project for building AI agents.")
```

---

## Strands Labs

In early 2026, AWS launched **Strands Labs** (github.com/strands-agents-labs) as a separate organization for experimental features. This boundary protects the stable SDK from breaking changes while enabling rapid iteration.

Strands Labs projects:
- Ship with documentation, functional code, and basic tests
- May have breaking changes between releases
- Graduate to the main SDK when interfaces stabilize

The steering feature, for example, started as an experiment before graduating to the main SDK as an experimental feature.

---

## Comparison with Other Frameworks

| Aspect | Strands | LangChain/LangGraph | CrewAI |
|--------|---------|---------------------|--------|
| **Philosophy** | Model-driven, minimal scaffolding | Framework-driven workflows | Role-based agent teams |
| **Complexity** | 3 lines for basic agent | Chains, graphs, memory configs | Crew/task/agent definitions |
| **Multi-agent** | Graph, Swarm, Workflow, A2A | LangGraph state machines | Sequential/hierarchical crews |
| **Tool system** | @tool + MCP native | Tool classes + some MCP | Tool classes |
| **Model support** | 13+ providers + LiteLLM | Multiple via abstractions | Multiple via abstractions |
| **Production use** | Powers Q Developer, Glue | Widely adopted | Growing adoption |
| **Deployment** | AgentCore native + Lambda/Fargate/EKS | Self-managed | Self-managed |
| **License** | Apache 2.0 | MIT | Apache 2.0 |

---

## Feature Matrix: Python vs TypeScript

| Category | Feature | Python | TypeScript |
|----------|---------|--------|------------|
| **Core** | Agent creation and invocation | Yes | Yes |
| | Streaming responses | Yes | Yes |
| | Structured output | Yes | Yes |
| **Model Providers** | Amazon Bedrock | Yes | Yes |
| | OpenAI | Yes | Yes |
| | Anthropic | Yes | Yes |
| | Ollama | Yes | No |
| | LiteLLM | Yes | No |
| | Custom providers | Yes | Yes |
| **Tools** | Custom function tools | Yes | Yes |
| | MCP tools | Yes | Yes |
| | Community tools | 30+ | 4 built-in |
| **Conversation** | Sliding window | Yes | Yes |
| | Summarizing | Yes | No |
| **Multi-agent** | Swarms, Graphs, Workflows | Yes | Yes |
| | Agent-to-Agent (A2A) | Yes | Yes |
| **Advanced** | Bidirectional streaming | Yes | No |
| | Agent steering | Yes | No |
| | Cancellation | Yes | No |

---

## Key Links and Resources

### Official
- **Website**: [strandsagents.com](https://strandsagents.com)
- **GitHub (Python SDK)**: [github.com/strands-agents/sdk-python](https://github.com/strands-agents/sdk-python)
- **GitHub (TypeScript SDK)**: [github.com/strands-agents/sdk-typescript](https://github.com/strands-agents/sdk-typescript)
- **GitHub (Tools)**: [github.com/strands-agents/tools](https://github.com/strands-agents/tools)
- **Strands Labs**: [github.com/strands-agents-labs](https://github.com/strands-agents-labs)
- **MCP Server**: [github.com/strands-agents/mcp-server](https://github.com/strands-agents/mcp-server)

### AWS Blog Posts
- [Introducing Strands Agents](https://aws.amazon.com/blogs/opensource/introducing-strands-agents-an-open-source-ai-agents-sdk/) -- May 2025 launch announcement
- [Technical Deep Dive: Agent Architectures and Observability](https://aws.amazon.com/blogs/machine-learning/strands-agents-sdk-a-technical-deep-dive-into-agent-architectures-and-observability/)
- [Advanced Orchestration Techniques](https://aws.amazon.com/blogs/machine-learning/customize-agent-workflows-with-advanced-orchestration-techniques-using-strands-agents/)
- [TypeScript Support Announcement](https://aws.amazon.com/about-aws/whats-new/2025/12/typescript-strands-agents-preview/) -- December 2025

### Community
- [Strands Community Packages Catalog](https://strandsagents.com/docs/community/community-packages/)
- [Strands Agent Skills Specification](https://agentskills.io/specification)
- [How Steering Hooks Achieved 100% Agent Accuracy](https://strandsagents.com/blog/steering-accuracy-beats-prompts-workflows/) -- Blog post on steering
- [Runtime Guardrails with Agent Control](https://strandsagents.com/blog/strands-agents-with-agent-control/) -- Community plugin

### Related Research Documents
- [[01-AgentCore-Architecture-Runtime]] -- Bedrock AgentCore deployment and runtime
- [[05-Strands-Advanced-Memory-MultiAgent]] -- Multi-agent patterns, memory, sessions
- [[09-Multi-Provider-LLM-Support]] -- Deep dive on model provider ecosystem

---

## Summary

Strands Agents represents a fundamental shift in how AI agents are built: instead of complex orchestration frameworks, it trusts the model's native reasoning capabilities and provides minimal but powerful primitives. The architecture is clean and composable:

- **Agent loop** as the execution primitive, with hooks for extensibility
- **Tool system** that unifies `@tool` decorators, MCP servers, and module tools
- **Model provider abstraction** enabling seamless switching between 13+ providers
- **Plugin system** for reusable behavioral modifications (skills, steering)
- **Session management** for production-grade state persistence
- **Streaming** for real-time user experiences

The framework's production pedigree (Q Developer, Glue, VPC Reachability Analyzer) and rapid community growth (14M+ downloads) validate its model-driven approach. Combined with native Bedrock AgentCore deployment support, Strands is positioned as the primary agent framework in the AWS ecosystem.
