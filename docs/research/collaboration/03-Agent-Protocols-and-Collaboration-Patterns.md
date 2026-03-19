# Agent Protocols and Collaboration Patterns

> **Research Date:** 2026-03-19
> **Status:** Complete
> **Series:** AWS Chimera Multi-Agent Architecture Research (3 of 5)
> **See also:** [[04-Real-Time-Async-and-Shared-Memory]] | [[06-Multi-Agent-Orchestration]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#Google A2A Protocol (Agent-to-Agent)]]
  - [[#A2A Protocol Overview]]
  - [[#A2A Request Lifecycle]]
  - [[#A2A vs MCP - Complementary Roles]]
  - [[#Agent Cards - Capability Discovery]]
  - [[#Task Lifecycle Management]]
  - [[#Streaming via Server-Sent Events]]
  - [[#Security Model]]
- [[#Model Context Protocol (MCP)]]
  - [[#MCP Purpose and Design]]
  - [[#MCP Integration Patterns]]
  - [[#MCP vs A2A Comparison]]
- [[#AWS Multi-Agent Protocols]]
  - [[#Amazon Bedrock AgentCore A2A Implementation]]
  - [[#Amazon Bedrock Agents (Classic) - Configuration-Based]]
  - [[#Workflow Orchestration Agents]]
- [[#Collaboration Pattern Architectures]]
  - [[#Hub-and-Spoke (Supervisor)]]
  - [[#Peer-to-Peer Coordination]]
  - [[#Agent Broker Pattern]]
  - [[#Hierarchical Delegation]]
- [[#OpenClaw Lane Queue Model]]
  - [[#Lane-Aware FIFO Queue]]
  - [[#Named Lanes and Concurrency Control]]
  - [[#Subagent Spawning]]
  - [[#Known Limitations - Nested Lane Bottleneck]]
- [[#Strands Swarm and Graph Patterns]]
- [[#Task Handoff Mechanisms]]
  - [[#Synchronous Delegation]]
  - [[#Asynchronous Delegation]]
  - [[#Task Artifact Exchange]]
- [[#Cross-Framework Interoperability]]
  - [[#Strands + Google ADK + OpenAI via A2A]]
  - [[#Framework Translation Layers]]
- [[#Security and Authentication]]
  - [[#OAuth 2.0 for A2A]]
  - [[#AWS IAM Authentication]]
  - [[#JWT Custom Authorizers]]
  - [[#Agent Identity Management]]
- [[#Observability and Tracing]]
  - [[#Distributed Tracing (X-Ray)]]
  - [[#Agent Reasoning Traces]]
  - [[#Multi-Agent Workflow Logs]]
- [[#Key Takeaways]]
- [[#Sources]]

---

## Executive Summary

Agent collaboration protocols define how AI agents discover, communicate, and coordinate with each other to solve complex tasks. This research examines three primary protocol families:

1. **Google A2A (Agent-to-Agent) Protocol** - An HTTP+JSON-RPC standard for agent discovery, task delegation, and artifact exchange across frameworks
2. **Model Context Protocol (MCP)** - A protocol for connecting agents to tools, data sources, and external services
3. **AWS Multi-Agent Orchestration** - Platform-specific patterns using Bedrock AgentCore, Step Functions, and EventBridge

**A2A vs MCP: Complementary, Not Competing**
- **MCP** connects a **single agent** to its **tools and data** (vertical integration)
- **A2A** connects **multiple agents** to **each other** (horizontal coordination)
- Example: A retail agent uses **MCP** to query inventory databases, then uses **A2A** to coordinate with a supplier agent

**Key Architecture Patterns:**
- **Hub-and-Spoke (Supervisor)**: Central orchestrator routes tasks to specialized workers
- **Peer-to-Peer**: Agents discover and coordinate directly without central authority
- **Agent Broker**: Hybrid pattern with message distribution but no workflow control
- **Hierarchical Delegation**: Multi-tier agent organization with parent-child relationships

**Framework Interoperability:**
Amazon Bedrock AgentCore Runtime supports A2A protocol, enabling agents built with **Strands Agents**, **OpenAI Agents SDK**, **LangGraph**, **Google ADK**, and **Claude Agents SDK** to collaborate seamlessly through standardized agent cards and task objects.

**OpenClaw Lane Queue Model** provides an alternative concurrency approach: lane-aware FIFO queues with named lanes (`main`, `subagent`, `cron`, `nested`) that guarantee session-level serialization while allowing cross-lane parallelism.

---

## Google A2A Protocol (Agent-to-Agent)

### A2A Protocol Overview

The **Agent-to-Agent (A2A) protocol** is an open standard for multi-agent coordination developed by Google and adopted by Amazon Bedrock AgentCore Runtime. It enables agents built with different frameworks and hosted on different platforms to:

- **Discover peers** through standardized agent cards
- **Share capabilities** via machine-readable schemas
- **Coordinate actions** using HTTP+JSON-RPC communication
- **Exchange artifacts** with multimodal content support

**Design Principles:**
1. **Framework-agnostic** - Works with any agent framework
2. **Model-agnostic** - LLM-independent protocol
3. **Platform-agnostic** - Can run on AWS, GCP, Azure, or on-premise
4. **Stateless** - No persistent connections required
5. **Secure** - OAuth 2.0 and IAM-based authentication

**Protocol Specification:**
- Transport: HTTP/S
- Messaging: JSON-RPC 2.0
- Streaming: Server-Sent Events (SSE)
- Authentication: OAuth 2.0, AWS SigV4, JWT

### A2A Request Lifecycle

The A2A protocol defines a structured request lifecycle with six key components:

```
┌─────────────────────────────────────────────────────────────┐
│                    A2A Request Lifecycle                     │
└─────────────────────────────────────────────────────────────┘

 ┌──────┐        ┌────────────┐        ┌────────────┐
 │ User │───────>│ A2A Client │───────>│ A2A Server │
 └──────┘        │  (Agent 1) │        │  (Agent 2) │
                 └────────────┘        └────────────┘
                       │                     │
                       │  1. Discover        │
                       │─────────────────────>│
                       │  GET /agent-card    │
                       │                     │
                       │<─────────────────────│
                       │  Agent Card JSON    │
                       │                     │
                       │  2. Create Task     │
                       │─────────────────────>│
                       │  POST /tasks        │
                       │                     │
                       │<─────────────────────│
                       │  Task ID + status   │
                       │                     │
                       │  3. Stream Updates  │
                       │<~~~~~~~~~~~~~~~~~~~~~│
                       │  SSE: progress      │
                       │                     │
                       │  4. Complete        │
                       │<─────────────────────│
                       │  Artifact + result  │
                       └─────────────────────┘
```

**Component Definitions:**

1. **User**: Initiates requests through the Client Agent (human or automated service)
2. **A2A Client (Client Agent)**: Acts on behalf of the user, discovering and delegating tasks to remote agents
3. **A2A Server (Remote Agent)**: Exposes HTTP endpoints implementing A2A protocol
4. **Agent Card**: JSON metadata advertising agent identity, capabilities, and endpoints
5. **Task Object**: Represents each unit of work with unique ID and lifecycle
6. **Artifact**: Output produced when task completes (text, JSON, images, audio, etc.)

### A2A vs MCP - Complementary Roles

**Model Context Protocol (MCP)** and **Agent-to-Agent (A2A)** serve different but complementary purposes:

| Aspect | MCP | A2A |
|--------|-----|-----|
| **Purpose** | Connect agent to tools/data | Connect agents to each other |
| **Scope** | Single-agent vertical integration | Multi-agent horizontal coordination |
| **Use Case** | Database queries, file systems, APIs | Task delegation, collaborative problem-solving |
| **Communication** | Agent ↔ Tool Server | Agent ↔ Agent |
| **Discovery** | Tool manifest | Agent card |
| **Execution** | Tool invocation | Task creation |
| **Result** | Tool output | Artifact |

**Example Workflow:**
```python
# Retail inventory agent uses BOTH protocols

# 1. Use MCP to query local inventory database
inventory_data = agent.invoke_mcp_tool(
    tool="query_inventory",
    params={"product_id": "ABC123"}
)

# 2. If out of stock, use A2A to coordinate with supplier agent
if inventory_data["quantity"] == 0:
    supplier_card = a2a_client.discover_agent("supplier-agent")
    task = a2a_client.create_task(
        agent_url=supplier_card["endpoint"],
        instruction="Order 100 units of product ABC123",
        context={"current_inventory": inventory_data}
    )
    order_result = a2a_client.wait_for_task(task["task_id"])
```

### Agent Cards - Capability Discovery

**Agent Cards** are JSON metadata files that each A2A server publishes to advertise its capabilities. They enable dynamic agent discovery without hardcoding endpoints.

**Agent Card Schema:**
```json
{
  "name": "monitoring-agent",
  "description": "AWS CloudWatch log and metric analysis",
  "version": "1.0.0",
  "capabilities": [
    {
      "name": "analyze_cloudwatch_logs",
      "description": "Parse and analyze CloudWatch log streams for errors and anomalies",
      "parameters": {
        "log_group": "string",
        "time_range": "string",
        "filter_pattern": "string (optional)"
      }
    },
    {
      "name": "fetch_cloudwatch_metrics",
      "description": "Retrieve CloudWatch metrics for specified resources",
      "parameters": {
        "resource_arn": "string",
        "metric_name": "string",
        "statistic": "Average|Sum|Maximum|Minimum"
      }
    }
  ],
  "endpoints": {
    "agent_card": "https://monitoring.example.com/.well-known/agent-card",
    "tasks": "https://monitoring.example.com/api/tasks",
    "streaming": "https://monitoring.example.com/api/stream"
  },
  "authentication": {
    "type": "oauth2",
    "token_url": "https://auth.example.com/token",
    "scopes": ["agent:read", "agent:invoke"]
  }
}
```

**Discovery Flow:**
```python
# Client agent discovers remote agent capabilities
import requests

def discover_agent(agent_url: str) -> dict:
    """Fetch agent card from remote A2A server."""
    response = requests.get(f"{agent_url}/.well-known/agent-card")
    response.raise_for_status()
    return response.json()

# Example usage
monitoring_agent = discover_agent("https://monitoring.example.com")
print(f"Agent: {monitoring_agent['name']}")
print(f"Capabilities: {[c['name'] for c in monitoring_agent['capabilities']]}")
```

### Task Lifecycle Management

A2A tasks follow a well-defined lifecycle:

```
┌─────────────────────────────────────────────────┐
│             A2A Task Lifecycle States            │
└─────────────────────────────────────────────────┘

  created ──> running ──> completed
      │           │           │
      │           └──> failed │
      │                       │
      └──> cancelled          │
                              │
                          artifact
```

**Task States:**
- `created`: Task submitted but not yet started
- `running`: Task is being processed
- `completed`: Task finished successfully, artifact available
- `failed`: Task encountered an error
- `cancelled`: Task was cancelled before completion

**Task Object Schema:**
```json
{
  "task_id": "task-abc123",
  "status": "running",
  "created_at": "2026-03-19T22:00:00Z",
  "updated_at": "2026-03-19T22:00:15Z",
  "instruction": "Analyze CloudWatch logs for Lambda function errors in the last hour",
  "context": {
    "log_group": "/aws/lambda/my-function",
    "time_range": "1h"
  },
  "metadata": {
    "priority": "high",
    "requester": "host-agent",
    "correlation_id": "incident-456"
  }
}
```

**Task API Endpoints:**
```http
# Create task
POST /api/tasks
Content-Type: application/json

{
  "instruction": "Analyze logs for errors",
  "context": {"log_group": "/aws/lambda/my-function"}
}

# Get task status
GET /api/tasks/{task_id}

# Update task (for multi-turn interactions)
PATCH /api/tasks/{task_id}
{
  "additional_context": "Focus on timeout errors"
}

# Cancel task
DELETE /api/tasks/{task_id}
```

### Streaming via Server-Sent Events

A2A supports **streaming updates** for long-running tasks using **Server-Sent Events (SSE)**:

```python
# Client subscribes to task updates via SSE
import sseclient
import requests

def stream_task_updates(task_id: str, base_url: str):
    """Stream task progress updates via SSE."""
    url = f"{base_url}/api/stream/{task_id}"
    response = requests.get(url, stream=True, headers={"Accept": "text/event-stream"})
    client = sseclient.SSEClient(response)

    for event in client.events():
        if event.event == "progress":
            print(f"Progress: {event.data}")
        elif event.event == "artifact":
            print(f"Artifact received: {event.data}")
        elif event.event == "complete":
            print("Task complete")
            break
        elif event.event == "error":
            print(f"Error: {event.data}")
            break

# Example usage
stream_task_updates("task-abc123", "https://monitoring.example.com")
```

**SSE Event Types:**
- `progress`: Task is making progress (percentage, status message)
- `artifact`: Partial or final artifact available
- `complete`: Task finished successfully
- `error`: Task encountered an error
- `cancelled`: Task was cancelled

### Security Model

A2A protocol supports multiple authentication mechanisms:

#### 1. OAuth 2.0
```python
import requests
from requests_oauthlib import OAuth2Session

# Client credentials flow for agent-to-agent auth
client_id = "monitoring-agent-client"
client_secret = "secret"
token_url = "https://auth.example.com/oauth/token"

session = OAuth2Session(client=BackendApplicationClient(client_id=client_id))
token = session.fetch_token(
    token_url=token_url,
    client_id=client_id,
    client_secret=client_secret
)

# Use token for A2A requests
response = session.post(
    "https://operational-agent.example.com/api/tasks",
    json={"instruction": "Search for remediation strategies"}
)
```

#### 2. AWS IAM (SigV4)
```python
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
import boto3

# Sign A2A request with AWS credentials
session = boto3.Session()
credentials = session.get_credentials()
request = AWSRequest(
    method="POST",
    url="https://agent.us-east-1.amazonaws.com/api/tasks",
    data=json.dumps({"instruction": "Analyze logs"}),
    headers={"Content-Type": "application/json"}
)
SigV4Auth(credentials, "bedrock-agentcore", "us-east-1").add_auth(request)
```

#### 3. JWT Custom Authorizers
```python
import jwt

# Agent generates JWT for inbound requests
token = jwt.encode(
    {
        "sub": "monitoring-agent",
        "exp": datetime.utcnow() + timedelta(hours=1),
        "scopes": ["agent:invoke"]
    },
    private_key,
    algorithm="RS256"
)

# Attach to request header
headers = {"Authorization": f"Bearer {token}"}
```

---

## Model Context Protocol (MCP)

### MCP Purpose and Design

**Model Context Protocol (MCP)** is an open protocol developed by Anthropic that connects AI agents to **tools, data sources, and external services**. Unlike A2A (which connects agents to other agents), MCP connects a **single agent** to its **execution environment**.

**MCP Architecture:**
```
┌───────────────────────────────────────────────┐
│              MCP Architecture                  │
└───────────────────────────────────────────────┘

         ┌─────────────────┐
         │   Agent Host    │
         │  (Claude Code,  │
         │   AgentCore)    │
         └────────┬────────┘
                  │
                  │ MCP Protocol
                  │ (JSON-RPC)
                  │
    ┌─────────────┼─────────────┐
    │             │             │
┌───▼───┐   ┌────▼────┐   ┌───▼───┐
│ MCP   │   │  MCP    │   │ MCP   │
│Server │   │ Server  │   │Server │
│(Files)│   │(Database)│  │(API)  │
└───────┘   └─────────┘   └───────┘
```

**Key Features:**
- **Tool Discovery**: Agents discover available tools via MCP manifest
- **Tool Invocation**: Agents call tools with typed parameters
- **Resource Access**: Agents read/write files, query databases, call APIs
- **Prompts**: MCP servers can provide prompt templates to agents

### MCP Integration Patterns

#### Pattern 1: AgentCore Gateway as MCP Front Door

Amazon Bedrock AgentCore Gateway converts backend APIs into MCP-compatible tools:

```python
# AgentCore Gateway exposes AWS APIs as MCP tools
from bedrock_agentcore import Gateway

gateway = Gateway(
    name="aws-tools-gateway",
    targets=[
        {
            "type": "mcp",
            "name": "cloudwatch-logs",
            "endpoint": "https://logs.us-east-1.amazonaws.com",
            "operations": [
                {"name": "filter_log_events", "method": "POST", "path": "/"},
                {"name": "describe_log_streams", "method": "POST", "path": "/"}
            ]
        }
    ]
)

# Agent discovers and invokes MCP tool
tools = gateway.list_tools()
result = gateway.invoke_tool(
    tool_name="cloudwatch-logs.filter_log_events",
    parameters={
        "logGroupName": "/aws/lambda/my-function",
        "filterPattern": "ERROR"
    }
)
```

#### Pattern 2: Direct MCP Server Deployment

Deploy standalone MCP servers on AgentCore Runtime:

```python
# MCP server running on AgentCore Runtime
from mcp import Server

server = Server("file-system-mcp")

@server.tool()
def read_file(path: str) -> str:
    """Read file contents from agent workspace."""
    with open(f"/workspace/{path}", "r") as f:
        return f.read()

@server.tool()
def write_file(path: str, content: str) -> None:
    """Write content to file in agent workspace."""
    with open(f"/workspace/{path}", "w") as f:
        f.write(content)

# Deploy to AgentCore Runtime
runtime = agentcore.Runtime.create(
    name="file-system-mcp-runtime",
    code_artifact=package_mcp_server(server)
)
```

### MCP vs A2A Comparison

| Aspect | MCP | A2A |
|--------|-----|-----|
| **Protocol Layer** | Tool/Resource access | Agent coordination |
| **Communication** | JSON-RPC | JSON-RPC + HTTP/S |
| **Discovery** | Tool manifest | Agent card |
| **Invocation** | `invoke_tool(name, params)` | `create_task(instruction, context)` |
| **Response** | Structured tool output | Artifact (multimodal) |
| **State Management** | Stateless | Stateful tasks |
| **Streaming** | Not specified | SSE for progress |
| **Authentication** | Varies by implementation | OAuth 2.0, IAM, JWT |

---

## AWS Multi-Agent Protocols

### Amazon Bedrock AgentCore A2A Implementation

Amazon Bedrock AgentCore Runtime provides **full A2A protocol support** as of November 2025. This enables cross-framework agent collaboration.

**Supported Frameworks:**
- Strands Agents SDK
- OpenAI Agents SDK
- LangGraph
- Google ADK (Agent Development Kit)
- Claude Agents SDK

**A2A Features in AgentCore:**
- **Stateless servers**: No persistent connections required
- **Authenticated agent cards**: Secured with OAuth or IAM
- **VPC connectivity**: Agents can communicate within VPC boundaries
- **Lifecycle management**: Automatic task creation, progress tracking, completion
- **Multi-region support**: Agents in different regions can coordinate

**Example: Multi-Agent Incident Response**
```python
# Host agent (Google ADK) coordinates with AWS-hosted agents via A2A

from google_adk import Agent
from bedrock_agentcore import A2AClient

# Host agent running on AgentCore with Google ADK
host_agent = Agent(name="host-agent", framework="google-adk")

# Discover remote monitoring agent (Strands SDK)
a2a_client = A2AClient(auth="iam")
monitoring_card = a2a_client.discover_agent(
    agent_url="https://monitoring-agent.us-east-1.amazonaws.com"
)

# Create task on monitoring agent
task = a2a_client.create_task(
    agent_url=monitoring_card["endpoints"]["tasks"],
    instruction="Analyze CloudWatch logs for Lambda timeout errors in the last hour",
    context={
        "log_group": "/aws/lambda/api-handler",
        "severity": "high"
    }
)

# Stream progress updates
for event in a2a_client.stream_task(task["task_id"]):
    if event["type"] == "progress":
        print(f"Monitoring agent: {event['message']}")
    elif event["type"] == "artifact":
        # Forward to operational agent for remediation
        operational_card = a2a_client.discover_agent(
            agent_url="https://operational-agent.us-east-1.amazonaws.com"
        )
        remediation_task = a2a_client.create_task(
            agent_url=operational_card["endpoints"]["tasks"],
            instruction=f"Propose remediation for: {event['data']['summary']}",
            context=event["data"]
        )
```

### Amazon Bedrock Agents (Classic) - Configuration-Based

**Bedrock Agents (Classic)** predates AgentCore and uses a configuration-driven approach rather than code:

**Key Differences:**
| Feature | Bedrock Agents (Classic) | Bedrock AgentCore |
|---------|-------------------------|-------------------|
| **Approach** | Configuration-based | Code-based |
| **Orchestration** | Managed by AWS | Developer-controlled |
| **Frameworks** | AWS-specific | Framework-agnostic |
| **A2A Protocol** | Not supported | Fully supported |
| **Multi-Agent** | Single agent per resource | Multi-agent collaboration |

**When to Use Classic:**
- Rapid prototyping without code
- Business teams configuring agents
- Tight integration with Bedrock Knowledge Bases
- Simple single-agent workflows

### Workflow Orchestration Agents

**AWS Step Functions** provides state machine orchestration for multi-agent workflows:

```json
{
  "Comment": "Multi-agent workflow orchestration",
  "StartAt": "ReceiveIncident",
  "States": {
    "ReceiveIncident": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "parse-incident"
      },
      "Next": "RouteToAgent"
    },
    "RouteToAgent": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.incident_type",
          "StringEquals": "lambda_error",
          "Next": "InvokeMonitoringAgent"
        },
        {
          "Variable": "$.incident_type",
          "StringEquals": "cost_anomaly",
          "Next": "InvokeFinOpsAgent"
        }
      ],
      "Default": "InvokeGeneralAgent"
    },
    "InvokeMonitoringAgent": {
      "Type": "Task",
      "Resource": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/monitoring-agent",
      "Parameters": {
        "instruction": "Analyze logs and identify root cause",
        "context.$": "$.incident_data"
      },
      "Next": "InvokeOperationalAgent"
    },
    "InvokeOperationalAgent": {
      "Type": "Task",
      "Resource": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/operational-agent",
      "Parameters": {
        "instruction": "Propose remediation steps",
        "context.$": "$.analysis_result"
      },
      "End": true
    }
  }
}
```

---

## Collaboration Pattern Architectures

### Hub-and-Spoke (Supervisor)

**Pattern:** Central supervisor agent coordinates all task delegation to specialized worker agents.

**Architecture:**
```
                    ┌──────────────┐
                    │  Supervisor  │
                    │    Agent     │
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
     ┌────▼────┐      ┌───▼────┐      ┌───▼────┐
     │ Worker  │      │ Worker │      │ Worker │
     │ Agent 1 │      │Agent 2 │      │Agent 3 │
     │(Monitor)│      │(Ops)   │      │(FinOps)│
     └─────────┘      └────────┘      └────────┘
```

**Advantages:**
- Centralized control and visibility
- Easier to trace workflow execution
- Supervisor can enforce policies and priorities

**Disadvantages:**
- Supervisor becomes bottleneck
- Single point of failure
- Workers cannot collaborate directly

**AWS Implementation:**
```python
# Supervisor agent using A2A to delegate
from bedrock_agentcore import A2AClient

class SupervisorAgent:
    def __init__(self):
        self.a2a = A2AClient()
        self.workers = {
            "monitoring": "https://monitoring.example.com",
            "ops": "https://ops.example.com",
            "finops": "https://finops.example.com"
        }

    def handle_incident(self, incident_data: dict):
        # Supervisor routes based on incident type
        if incident_data["type"] == "lambda_error":
            # Delegate to monitoring agent
            task = self.a2a.create_task(
                agent_url=self.workers["monitoring"],
                instruction="Analyze logs for root cause",
                context=incident_data
            )
            analysis = self.a2a.wait_for_task(task["task_id"])

            # Then delegate to ops agent
            remediation_task = self.a2a.create_task(
                agent_url=self.workers["ops"],
                instruction="Propose remediation",
                context=analysis["artifact"]
            )
            return self.a2a.wait_for_task(remediation_task["task_id"])
```

### Peer-to-Peer Coordination

**Pattern:** Agents discover and coordinate directly without central authority.

**Architecture:**
```
     ┌─────────┐ ←──A2A──→ ┌─────────┐
     │ Agent 1 │            │ Agent 2 │
     │(Monitor)│            │  (Ops)  │
     └────┬────┘            └────┬────┘
          │                      │
          │                      │
          └──────────A2A─────────┘
                     │
                ┌────▼────┐
                │ Agent 3 │
                │(FinOps) │
                └─────────┘
```

**Advantages:**
- No bottleneck
- Agents can collaborate dynamically
- Fault-tolerant (no single point of failure)

**Disadvantages:**
- Harder to trace workflows
- Potential for circular dependencies
- Complex state management

**AWS Implementation:**
```python
# Monitoring agent discovers and coordinates with ops agent directly

from bedrock_agentcore import A2AClient, AgentCardRegistry

class MonitoringAgent:
    def __init__(self):
        self.a2a = A2AClient()
        self.registry = AgentCardRegistry()

    def analyze_logs(self, log_data: dict):
        # Perform analysis
        errors = self._parse_errors(log_data)

        if errors["severity"] == "critical":
            # Discover ops agent dynamically
            ops_agents = self.registry.search_agents(capability="remediation")
            if ops_agents:
                ops_card = ops_agents[0]
                task = self.a2a.create_task(
                    agent_url=ops_card["endpoints"]["tasks"],
                    instruction=f"Immediate remediation needed: {errors['summary']}",
                    context=errors
                )
                return task
```

### Agent Broker Pattern

**Pattern:** Hybrid approach with centralized message distribution but no workflow control.

**Architecture:**
```
                    ┌──────────────┐
                    │    Broker    │
                    │  (EventBus)  │
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
     ┌────▼────┐      ┌───▼────┐      ┌───▼────┐
     │ Agent 1 │      │Agent 2 │      │Agent 3 │
     │(Monitor)│      │(Ops)   │      │(FinOps)│
     └─────────┘      └────────┘      └────────┘
          │                                 │
          └────────────EventBridge──────────┘
```

**Advantages:**
- Decoupled agents (only interact with broker)
- Agents can join/leave dynamically
- Message persistence and replay

**Disadvantages:**
- Broker can become bottleneck
- More complex routing logic

**AWS Implementation with EventBridge:**
```python
import boto3

eventbridge = boto3.client('events')

# Agent publishes event to broker
eventbridge.put_events(
    Entries=[
        {
            'Source': 'monitoring-agent',
            'DetailType': 'LogAnalysisComplete',
            'Detail': json.dumps({
                'errors': ['Lambda timeout', 'Out of memory'],
                'severity': 'high',
                'log_group': '/aws/lambda/api-handler'
            }),
            'EventBusName': 'agent-broker-bus'
        }
    ]
)

# EventBridge rule routes to ops agent
# Rule pattern:
{
  "source": ["monitoring-agent"],
  "detail-type": ["LogAnalysisComplete"],
  "detail": {
    "severity": ["high", "critical"]
  }
}
```

### Hierarchical Delegation

**Pattern:** Multi-tier agent organization with parent-child relationships.

**Architecture:**
```
                    ┌──────────────┐
                    │   Tier 1     │
                    │ Orchestrator │
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
     ┌────▼────┐      ┌───▼────┐      ┌───▼────┐
     │ Tier 2  │      │ Tier 2 │      │ Tier 2 │
     │ Domain  │      │ Domain │      │ Domain │
     │ Manager │      │Manager │      │Manager │
     └────┬────┘      └───┬────┘      └────┬───┘
          │               │                │
     ┌────▼────┐     ┌───▼───┐       ┌────▼───┐
     │ Tier 3  │     │Tier 3 │       │ Tier 3 │
     │ Worker  │     │Worker │       │ Worker │
     └─────────┘     └───────┘       └────────┘
```

**Use Case: Enterprise SRE System**
- **Tier 1**: Global incident coordinator
- **Tier 2**: Regional incident managers (US-East, EU-West, AP-Southeast)
- **Tier 3**: Service-specific agents (Lambda, ECS, RDS, S3)

---

## OpenClaw Lane Queue Model

OpenClaw's multi-agent concurrency uses a **lane-aware FIFO queue** instead of threads or processes.

### Lane-Aware FIFO Queue

**Design Philosophy:**
- **No threads or worker processes**: Entire Gateway runs on async promises
- **Session-level serialization**: Only one active run per session
- **Lane-based parallelism**: Different lanes run in parallel
- **Concurrency caps per lane**: Prevent resource exhaustion

### Named Lanes and Concurrency Control

| Lane | Default Concurrency | Purpose |
|------|-------------------|---------|
| `main` | 4 | Inbound messages + main heartbeats |
| `subagent` | 8 | Background subagent runs |
| `cron` | 1 | Scheduled cron jobs |
| `nested` | 1 | Agent-to-agent `sessions_send` calls |

**Configuration:**
```jsonc
{
  "agents": {
    "defaults": {
      "maxConcurrent": 4,       // main lane
      "subagents": {
        "maxConcurrent": 8      // subagent lane
      },
      "cron": {
        "maxConcurrentRuns": 2  // cron lane
      }
    }
  }
}
```

### Subagent Spawning

OpenClaw subagents are **background agent runs** spawned from an existing agent:

```javascript
// Spawn subagent via slash command
/subagents spawn --model claude-opus-4 "Analyze CloudWatch logs for errors"

// Programmatic spawning
const subagent = await spawnSubagent({
  prompt: "Research AWS Lambda best practices",
  model: "claude-sonnet-4",
  thinking: true,
  tools: ["web_search", "read_docs"]
});

// Session isolation: agent:main:subagent:abc-123
// Each subagent gets independent context window and memory
```

### Known Limitations - Nested Lane Bottleneck

The `nested` lane (used for `sessions_send` agent-to-agent communication) defaults to concurrency **1**, creating a severe bottleneck in multi-agent setups:

```
20:09:51 lane enqueue: lane=nested queueSize=1 (dequeued immediately)
20:10:31 lane enqueue: lane=nested queueSize=2 (blocked)
20:13:04 lane enqueue: lane=nested queueSize=3 (blocked)
20:16:11 lane task done: lane=nested durationMs=379024 (6.3 minutes!)
```

**Workaround:** Manual lane configuration to increase nested lane concurrency
**Proposed Fix:** Config knob for nested lane concurrency (tracked in issue #22167)

---

## Strands Swarm and Graph Patterns

*(To be researched in detail - see Strands Agents documentation)*

Strands Agents provides **swarm** and **graph** patterns for multi-agent coordination:

- **Swarm**: Dynamic agent pool that scales based on workload
- **Graph**: DAG-based workflow with agent nodes and data edges

---

## Task Handoff Mechanisms

### Synchronous Delegation

Agent A blocks until Agent B completes the delegated task:

```python
# Synchronous A2A delegation
task = a2a_client.create_task(
    agent_url="https://ops-agent.example.com",
    instruction="Propose remediation for Lambda timeout"
)

# Block until complete
result = a2a_client.wait_for_task(task["task_id"], timeout=300)
print(result["artifact"])
```

### Asynchronous Delegation

Agent A delegates task to Agent B and continues processing:

```python
# Asynchronous A2A delegation
task = a2a_client.create_task(
    agent_url="https://ops-agent.example.com",
    instruction="Propose remediation for Lambda timeout",
    callback_url="https://monitoring-agent.example.com/callbacks"
)

# Continue processing
print(f"Task delegated: {task['task_id']}")

# Agent B will POST artifact to callback_url when complete
```

### Task Artifact Exchange

Artifacts are the primary data exchange format between agents:

```python
# Agent B completes task and generates artifact
artifact = {
    "type": "remediation_plan",
    "format": "json",
    "content": {
        "steps": [
            "Increase Lambda memory to 1024 MB",
            "Add CloudWatch alarm for timeout errors",
            "Implement exponential backoff in retry logic"
        ],
        "estimated_time": "15 minutes",
        "risk_level": "low"
    },
    "metadata": {
        "generated_by": "operational-agent",
        "timestamp": "2026-03-19T22:30:00Z"
    }
}

# Agent A receives artifact via callback or polling
```

---

## Cross-Framework Interoperability

### Strands + Google ADK + OpenAI via A2A

**Real-World Example: AWS Incident Response System**

```
┌─────────────────────────────────────────┐
│  Host Agent (Google ADK)                │
│  - Runs on Bedrock AgentCore            │
│  - Fetches IDP config from Parameter    │
│    Store                                 │
│  - Routes queries to specialists         │
└────────────┬────────────────────────────┘
             │
    ┌────────┴──────────┐
    │                   │
┌───▼──────────┐  ┌────▼──────────────┐
│ Monitoring   │  │ Operational       │
│ Agent        │  │ Agent             │
│ (Strands SDK)│  │ (OpenAI SDK)      │
│              │  │                   │
│ CloudWatch   │  │ Tavily Web Search │
│ Analysis     │  │ Remediation Plans │
└──────────────┘  └───────────────────┘
```

All three agents communicate via **A2A protocol**, despite using different frameworks and SDKs.

### Framework Translation Layers

AgentCore Runtime provides automatic translation between framework-specific formats and A2A protocol:

```python
# Strands agent exposes A2A endpoint automatically
from strands import Agent, a2a_server

agent = Agent(name="monitoring-agent")

@agent.tool()
def analyze_logs(log_group: str) -> dict:
    # Tool implementation
    pass

# A2A server wrapper (auto-generated)
server = a2a_server(agent)
server.run(host="0.0.0.0", port=8080)

# Agent card exposed at /.well-known/agent-card
# Tasks endpoint at /api/tasks
```

---

## Security and Authentication

### OAuth 2.0 for A2A

**Client Credentials Flow** is the standard OAuth pattern for agent-to-agent authentication:

```python
from requests_oauthlib import OAuth2Session
from oauthlib.oauth2 import BackendApplicationClient

# Agent authenticates to remote agent
client_id = "monitoring-agent-client"
client_secret = "secret"
token_url = "https://auth.example.com/oauth/token"

client = BackendApplicationClient(client_id=client_id)
session = OAuth2Session(client=client)
token = session.fetch_token(
    token_url=token_url,
    client_id=client_id,
    client_secret=client_secret,
    scope=["agent:invoke"]
)

# Use token for A2A requests
response = session.post(
    "https://ops-agent.example.com/api/tasks",
    json={"instruction": "Analyze errors"}
)
```

### AWS IAM Authentication

AgentCore uses **workload identities** for agent-to-service authentication:

```python
import boto3

# Create workload identity for agent
client = boto3.client('bedrock-agentcore-control')
response = client.create_workload_identity(
    name='monitoring-agent-identity',
    allowedResourceOauth2ReturnUrls=['https://monitoring.example.com/callback']
)

workload_identity_arn = response['workloadIdentityArn']

# Agent uses workload access token for A2A calls
token = client.create_workload_access_token(
    workloadIdentityId=response['workloadIdentityId']
)
```

### JWT Custom Authorizers

For gateway and runtime inbound authorization:

```python
import jwt
from datetime import datetime, timedelta

# Agent generates JWT for authenticated A2A requests
private_key = load_private_key("agent.pem")
token = jwt.encode(
    {
        "sub": "monitoring-agent",
        "iss": "https://auth.example.com",
        "aud": "https://ops-agent.example.com",
        "exp": datetime.utcnow() + timedelta(hours=1),
        "scopes": ["agent:invoke", "task:create"]
    },
    private_key,
    algorithm="RS256"
)

headers = {"Authorization": f"Bearer {token}"}
```

### Agent Identity Management

**AgentCore Identity** provides secure identity management for agents:

```python
from bedrock_agentcore import Identity

# Create identity for agent
identity = Identity.create(
    name="monitoring-agent-identity",
    authentication_method="oauth2",
    oauth_provider="cognito",
    user_pool_id="us-east-1_ABC123",
    allowed_scopes=["agent:invoke", "cloudwatch:read"]
)

# Agent uses identity to access resources
access_token = identity.get_access_token()
```

---

## Observability and Tracing

### Distributed Tracing (X-Ray)

**AWS X-Ray** provides end-to-end tracing for multi-agent workflows:

```python
from aws_xray_sdk.core import xray_recorder

# Start trace segment for A2A task
@xray_recorder.capture('create_a2a_task')
def create_task(agent_url: str, instruction: str):
    # Add metadata to trace
    xray_recorder.put_metadata('agent_url', agent_url)
    xray_recorder.put_metadata('instruction', instruction)

    # Create task
    task = a2a_client.create_task(agent_url, instruction)

    # Add task ID to trace
    xray_recorder.put_annotation('task_id', task['task_id'])

    return task
```

**X-Ray Service Map** visualizes agent interactions:
```
User Request → Host Agent → Monitoring Agent → Operational Agent → Result
     │              │              │                    │
     └──X-Ray────────┴──X-Ray───────┴───────X-Ray───────┘
```

### Agent Reasoning Traces

**Bedrock AgentCore** provides reasoning traces for debugging agent decisions:

```python
from bedrock_agentcore import Runtime

runtime = Runtime.create(
    name="monitoring-agent-runtime",
    enable_tracing=True,
    trace_level="verbose"
)

# Invoke agent with tracing enabled
response = runtime.invoke(
    instruction="Analyze logs for errors",
    trace=True
)

# Inspect reasoning trace
for step in response["trace"]:
    print(f"Step: {step['type']}")
    print(f"  Thought: {step['thought']}")
    print(f"  Action: {step['action']}")
    print(f"  Observation: {step['observation']}")
```

### Multi-Agent Workflow Logs

**Structured logging** for multi-agent coordination:

```python
import logging
import structlog

logger = structlog.get_logger()

# Log A2A task creation
logger.info(
    "a2a_task_created",
    task_id="task-abc123",
    source_agent="host-agent",
    target_agent="monitoring-agent",
    instruction="Analyze CloudWatch logs"
)

# Log task completion
logger.info(
    "a2a_task_completed",
    task_id="task-abc123",
    duration_ms=5432,
    artifact_type="log_analysis",
    errors_found=3
)
```

---

## Key Takeaways

1. **A2A Protocol** enables cross-framework agent collaboration through standardized agent cards, task objects, and artifacts
2. **MCP vs A2A**: Complementary protocols - MCP connects agents to tools, A2A connects agents to each other
3. **AWS Support**: Bedrock AgentCore Runtime fully supports A2A protocol, enabling Strands, OpenAI, LangGraph, Google ADK, and Claude SDK agents to collaborate
4. **Architecture Patterns**:
   - **Hub-and-Spoke**: Best for centralized control and tracing
   - **Peer-to-Peer**: Best for dynamic, fault-tolerant systems
   - **Agent Broker**: Best for event-driven architectures
   - **Hierarchical**: Best for enterprise-scale systems
5. **OpenClaw Lane Queue**: Alternative concurrency model using lane-aware FIFO queues with session-level serialization
6. **Security**: OAuth 2.0, AWS IAM, and JWT are standard authentication mechanisms for A2A
7. **Observability**: X-Ray, reasoning traces, and structured logs are essential for debugging multi-agent systems

---

## Sources

1. [Introducing agent-to-agent protocol support in Amazon Bedrock AgentCore Runtime](https://aws.amazon.com/blogs/machine-learning/introducing-agent-to-agent-protocol-support-in-amazon-bedrock-agentcore-runtime/) - AWS Machine Learning Blog, November 2025
2. [Creating asynchronous AI agents with Amazon Bedrock](https://aws.amazon.com/blogs/machine-learning/creating-asynchronous-ai-agents-with-amazon-bedrock/) - AWS Machine Learning Blog
3. [Build multi-agent site reliability engineering assistants with Amazon Bedrock AgentCore](https://aws.amazon.com/blogs/machine-learning/build-multi-agent-site-reliability-engineering-assistants-with-amazon-bedrock-agentcore/) - AWS Machine Learning Blog
4. [Amazon SQS, Amazon SNS, or Amazon EventBridge?](https://docs.aws.amazon.com/decision-guides/latest/sns-or-sqs-or-eventbridge/sns-or-sqs-or-eventbridge.html) - AWS Decision Guide
5. [Workflow orchestration agents](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/workflow-orchestration-agents.html) - AWS Prescriptive Guidance
6. [Amazon Bedrock AgentCore Runtime Documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html) - AWS Documentation
7. [Model Context Protocol Specification](https://modelcontextprotocol.io/) - Anthropic
8. OpenClaw Multi-Agent Orchestration (Internal Research Document)
9. Strands Agents SDK Documentation - strandsagents.com
