# Amazon Bedrock AgentCore: Architecture & Runtime Deep Dive

> **Research Date:** 2026-03-19
> **Status:** Complete
> **Series:** AWS Bedrock AgentCore and Strands Agents (1 of 4)
> **See also:** [[02-AgentCore-APIs-SDKs-MCP]] | [[03-AgentCore-Multi-Tenancy-Deployment]] | [[04-Strands-Agents-Core]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#What is Amazon Bedrock AgentCore?]]
- [[#Timeline and Availability]]
- [[#Architecture Overview]]
- [[#AgentCore Runtime Deep Dive]]
- [[#AgentCore Memory]]
- [[#AgentCore Gateway]]
- [[#AgentCore Identity]]
- [[#AgentCore Observability]]
- [[#AgentCore Policy]]
- [[#AgentCore Evaluations]]
- [[#AgentCore Browser]]
- [[#AgentCore Code Interpreter]]
- [[#AgentCore vs Bedrock Agents (Classic)]]
- [[#Framework and Model Support]]
- [[#Protocol Support]]
- [[#Pricing]]
- [[#Regional Availability]]
- [[#Code Examples]]
- [[#Customer Adoption]]
- [[#Key Takeaways]]
- [[#Sources]]

---

## Executive Summary

Amazon Bedrock AgentCore is an **agentic platform** for building, deploying, and operating AI agents securely at scale. Unlike the older "Bedrock Agents" (now called "Classic Agents"), which provides a fully managed, configuration-based approach, AgentCore is designed for developers who need **full control over orchestration logic, state management, and agent coordination** while offloading infrastructure complexity to AWS.

AgentCore is:
- **Framework-agnostic** -- works with Strands Agents, LangGraph, CrewAI, LlamaIndex, Google ADK, OpenAI Agents SDK, or custom frameworks
- **Model-agnostic** -- supports any LLM: Amazon Nova, Anthropic Claude, Meta Llama, Mistral, OpenAI, Google Gemini, and others
- **Protocol-native** -- supports MCP (Model Context Protocol), A2A (Agent-to-Agent), and AG-UI (Agent-User Interaction)
- **Modular** -- 9 composable services that work independently or together
- **Consumption-based** -- pay only for active resource usage, not pre-allocated capacity

The platform went from **preview in July 2025** to **general availability in October 2025**, with major additions (Policy, Evaluations, episodic memory) announced at **re:Invent 2025 in December 2025**. As of March 2026, the AgentCore SDK has been downloaded over 2 million times.

---

## What is Amazon Bedrock AgentCore?

AgentCore sits at the **infrastructure layer** of the AWS AI stack:

```
+---------------------------------------------------+
|              Application Layer                     |
|  (Your agent code, business logic, UX)            |
+---------------------------------------------------+
|           Agent Framework Layer                    |
|  (Strands Agents, LangGraph, CrewAI, custom)      |
+---------------------------------------------------+
|        Amazon Bedrock AgentCore                    |  <-- This layer
|  Runtime | Memory | Gateway | Identity |           |
|  Observability | Policy | Evaluations |            |
|  Browser | Code Interpreter                        |
+---------------------------------------------------+
|           Foundation Model Layer                   |
|  (Amazon Bedrock: Nova, Claude, Llama, Mistral)    |
|  (External: OpenAI, Gemini, self-hosted)           |
+---------------------------------------------------+
|           AWS Infrastructure                       |
|  (VPC, IAM, CloudWatch, ECR, S3, Lambda)          |
+---------------------------------------------------+
```

**Amazon Bedrock** supplies the models. **AgentCore** supplies the operational environment -- identity, memory, secure tool invocation, scaling, observability, and governance. **Agent frameworks** (like Strands) handle behavior, prompts, tools, and workflows.

### Core Value Propositions

1. **Faster time to value** -- pre-built services eliminate months of infrastructure work
2. **Flexibility and interoperability** -- any framework, any model, any protocol
3. **Security and trust at scale** -- enterprise-grade session isolation, VPC support, identity management
4. **Consumption-based economics** -- active-resource pricing means I/O wait time is free

### What Can You Build?

- **Autonomous AI applications** -- customer support, workflow automation, data analysis, coding assistance
- **Tool platforms** -- transform existing APIs, databases, or services into MCP-compatible tools
- **Agent platforms** -- provide internal developers with governed, observable infrastructure for shipping agent-powered features

---

## Timeline and Availability

| Date | Milestone |
|------|-----------|
| **2025-07-16** | Preview announced at AWS Summit New York 2025. Initial services: Runtime, Memory, Observability, Identity, Gateway, Browser, Code Interpreter |
| **2025-07-28** | Preview code examples updated and simplified |
| **2025-08-20** | Deep Dive series on Runtime published (AWS Show and Tell) |
| **2025-10-13** | **General Availability** in 9 AWS Regions. Added: VPC support, PrivateLink, CloudFormation, resource tagging, A2A protocol support, self-managed memory strategy, MCP servers as Gateway targets, identity-aware authorization |
| **2025-11-04** | Direct code deployment (ZIP upload) added. Langfuse integration announced. |
| **2025-10-30** | Web Bot Auth (Preview) for Browser -- reduces CAPTCHAs via IETF draft protocol |
| **2025-12-02** | **re:Invent 2025 announcements:** AgentCore Policy (Preview), AgentCore Evaluations (Preview), episodic memory GA, bidirectional streaming, authentication token support for Gateway |
| **2026-03-13** | AG-UI (Agent-User Interaction) protocol support added to Runtime |

---

## Architecture Overview

AgentCore consists of **9 modular services** that can be used independently or composed:

### Service Map

| Service | Purpose | Key Capability |
|---------|---------|----------------|
| **Runtime** | Serverless agent execution | MicroVM session isolation, 8-hour workloads, auto-scaling |
| **Memory** | Context management | Short-term (session) + long-term (cross-session) + episodic memory |
| **Gateway** | Tool integration | Transform APIs/Lambda into MCP tools, semantic tool discovery |
| **Identity** | Authentication & authorization | IdP integration (Cognito, Okta, Entra ID), OAuth/API key management |
| **Observability** | Monitoring & debugging | OTEL-compatible traces, CloudWatch dashboards, step-by-step visualization |
| **Policy** | Governance & boundaries | Natural language policy authoring, real-time Cedar enforcement |
| **Evaluations** | Quality assessment | 13 built-in evaluators, custom evaluators, CI/CD integration |
| **Browser** | Web interaction | Managed Chromium instances, Playwright/BrowserUse support, Web Bot Auth |
| **Code Interpreter** | Code execution | Sandboxed Python/JS/TS execution, file access, library installation |

### High-Level Architecture

```
                    End Users
                       |
              [Identity Provider]
              (Cognito/Okta/Entra)
                       |
                  [Inbound Auth]
                       |
         +----------------------------+
         |    AgentCore Runtime        |
         |  +----------------------+  |
         |  | Session (MicroVM)    |  |
         |  |  - Agent Code        |  |
         |  |  - Framework Runtime |  |
         |  |  - Isolated CPU/Mem  |  |
         |  +----------------------+  |
         |  +----------------------+  |
         |  | Session (MicroVM)    |  |
         |  |  (another user)      |  |
         |  +----------------------+  |
         +----------------------------+
              |    |    |    |    |
    +---------+    |    |    |    +---------+
    |              |    |    |              |
[Gateway]    [Memory] [Identity] [Observability]
    |              |    |    |              |
[MCP Tools]  [DynamoDB] | [CloudWatch]   [Policy]
[Lambda]     [S3]    [OAuth]              [Cedar]
[APIs]               [API Keys]
[3rd Party]
```

---

## AgentCore Runtime Deep Dive

AgentCore Runtime is the **foundational compute service** -- a serverless, purpose-built hosting environment for AI agents. It is the most complex and central component.

### Key Components

#### 1. AgentCore Runtime (the Agent)

A containerized application that:
- Hosts your AI agent or tool code
- Processes user inputs and maintains context
- Executes actions using AI capabilities
- Has a **unique identity** and is **versioned**

You can deploy using:
- **AgentCore Python SDK** (simplest path)
- **AgentCore Starter Toolkit** (template-based)
- **AWS SDKs** (maximum control)
- **Direct code deployment** (ZIP upload, added Nov 2025)
- **Container deployment** (Docker image to ECR)

#### 2. Versions

Each AgentCore Runtime maintains **immutable versions**:
- Version 1 (V1) is created automatically on `CreateAgentRuntime`
- Each configuration update creates a new version
- Versions capture complete snapshots: container image, protocol settings, network settings
- Enables reliable **rollback** capabilities

#### 3. Endpoints

Addressable access points to specific versions:

| Property | Description |
|----------|-------------|
| **ARN** | Unique identifier for invocation |
| **Version Reference** | Points to a specific version |
| **DEFAULT endpoint** | Auto-created, auto-updates to latest version |
| **Custom endpoints** | Created via `CreateAgentRuntimeEndpoint` for dev/test/prod |

Endpoint lifecycle states: `CREATING` -> `CREATE_FAILED` | `READY` -> `UPDATING` -> `UPDATE_FAILED` | `READY`

Endpoints can be updated **without downtime** for seamless version transitions.

#### 4. Sessions

Sessions are the interaction contexts between users and agents:

| Property | Detail |
|----------|--------|
| **Identifier** | Unique `runtimeSessionId` (provided by app or auto-generated) |
| **Isolation** | Dedicated **microVM** with isolated CPU, memory, and filesystem |
| **Context** | Preserved across multiple interactions in same conversation |
| **Max Duration** | Up to **8 hours** of total runtime |
| **Idle Timeout** | 15 minutes of inactivity triggers termination |
| **Cleanup** | On termination, entire microVM is destroyed and memory sanitized |

Session states:
- **Active** -- currently processing a request or executing background tasks
- **Idle** -- not processing, but maintaining context, waiting for next interaction
- **Terminated** -- ended (inactivity, max lifetime, or health check failure)

> **Critical:** After termination, a new request with the same `runtimeSessionId` creates a **fresh** execution environment. Session state is ephemeral -- use AgentCore Memory for durable context.

### Session Isolation Architecture

```
+----------------------------------+
|        AgentCore Runtime         |
|                                  |
|  +-----------+  +-----------+   |
|  | MicroVM 1 |  | MicroVM 2 |   |
|  | User A    |  | User B    |   |
|  | - CPU     |  | - CPU     |   |
|  | - Memory  |  | - Memory  |   |
|  | - Disk    |  | - Disk    |   |
|  | - Network |  | - Network |   |
|  +-----------+  +-----------+   |
|                                  |
|  +-----------+  +-----------+   |
|  | MicroVM 3 |  | MicroVM N |   |
|  | User C    |  | User N    |   |
|  +-----------+  +-----------+   |
+----------------------------------+
```

Each session runs in a **dedicated microVM** (similar to AWS Firecracker technology):
- **Complete separation** between user sessions
- Prevents cross-session data contamination
- Safeguards stateful agent reasoning processes
- Critical for enterprise security with non-deterministic AI

### Runtime vs Traditional Serverless

| Dimension | Traditional Serverless (Lambda) | AgentCore Runtime |
|-----------|-------------------------------|-------------------|
| **Execution time** | Up to 15 minutes | Up to **8 hours** |
| **Payload size** | ~6 MB (sync) / ~256 KB (async) | Up to **100 MB** |
| **State management** | Stateless | Session state retention (8h max / 15m idle) |
| **Billing model** | Request count + execution time | **Active CPU usage only** (I/O wait is free) |
| **Isolation level** | Process-level | **MicroVM-level** (dedicated CPU/memory/disk) |
| **Streaming** | Limited | Bidirectional (HTTP + WebSocket) |
| **Protocol support** | HTTP | HTTP, MCP, A2A, AG-UI |

### Scaling Behavior

AgentCore Runtime scales automatically:
- **From zero** to thousands of concurrent sessions
- No capacity planning required
- No infrastructure maintenance
- Consumption-based pricing means you pay nothing when idle

### Communication Patterns

#### HTTP API (Request/Response)
Standard REST endpoints for traditional request-response patterns.

#### Streaming
- **Unidirectional streaming** -- agents stream partial results as they generate content
- **Bidirectional streaming** -- WebSocket connections for real-time interactive communication (added Dec 2025)
- Particularly powerful for **voice agents** and responsive text interactions

#### Asynchronous Processing
For long-running workloads:
- Background task handling for operations beyond request/response cycles
- Automatic status tracking via `/ping` endpoint
- Operations up to 8 hours

### Authentication & Security

#### Inbound Authentication

Controls who can access and invoke agents:

| Method | Description |
|--------|-------------|
| **AWS IAM (SigV4)** | Standard AWS credential-based authentication |
| **OAuth 2.0** | Integration with external identity providers |

OAuth flow:
1. End user authenticates with IdP (Cognito, Okta, Entra ID)
2. Client app receives bearer token
3. Token passed in authorization header to agent
4. AgentCore validates token with authorization server
5. Request processed if valid, rejected if invalid

#### Outbound Authentication

Enables agents to securely access third-party services:

| Method | Description |
|--------|-------------|
| **OAuth** | For services supporting OAuth flows |
| **API Keys** | For key-based authentication |

Two modes:
- **User-delegated** -- agent acts on behalf of the end user with their credentials
- **Autonomous** -- agent acts independently with service-level credentials

Supported services: Slack, Zoom, GitHub, Salesforce, Stripe, custom APIs, AWS services.

AgentCore Identity manages credentials securely, preventing credential exposure in agent code or logs.

---

## AgentCore Memory

Manages both **short-term** (within-session) and **long-term** (cross-session) context.

### Memory Types

| Type | Scope | Duration | Use Case |
|------|-------|----------|----------|
| **Short-term** | Single session | Session lifetime | Multi-turn conversation context |
| **Long-term** | Cross-session | Persistent | User preferences, learned patterns, historical context |
| **Episodic** (GA Dec 2025) | Cross-session | Persistent | Agent learns from past experiences to improve decisions |

### Memory Strategies

1. **Built-in (automatic)** -- AWS handles extraction and consolidation
2. **Built-in with override** -- automatic processing with your custom prompt/model
3. **Self-managed** (GA Oct 2025) -- complete control over extraction and consolidation pipelines

### How It Works

```
User Message --> Short-term Memory (raw events)
                      |
              [Extraction Pipeline]
                      |
              Long-term Memory (processed knowledge)
                      |
              [Retrieval on next interaction]
                      |
              Agent has context for personalized response
```

### Key Capabilities

- **Conversation continuity** across sessions
- **Personalized service** based on user history
- **Contextual troubleshooting** with awareness of past issues
- Eliminates complex memory infrastructure management
- Full control over what the agent remembers and learns

---

## AgentCore Gateway

Transforms existing APIs and services into **agent-ready tools** through a unified endpoint.

### What Gateway Does

1. **Converts APIs** -- transforms OpenAPI, Smithy, and Lambda functions into MCP-compatible tools
2. **Connects MCP servers** -- acts as proxy to existing MCP servers (added at GA)
3. **1-click integrations** -- pre-built connectors for Salesforce, Slack, Jira, Asana, Zendesk
4. **Semantic tool discovery** -- built-in search helps agents find the right tool for their task
5. **Unified access** -- single endpoint for all tools regardless of underlying protocol

### Architecture

```
Agent Code
    |
    v
AgentCore Gateway (unified MCP endpoint)
    |
    +-- AWS Lambda functions
    +-- REST APIs (OpenAPI specs)
    +-- Smithy service models
    +-- Existing MCP servers
    +-- 3rd party services (Slack, Jira, Salesforce, etc.)
    +-- ECR containerized tools
```

### Security

- **IAM authorization** for agent-to-tool interactions (added at GA)
- **OAuth integration** for third-party services
- **Metadata-based filtering** to manage tool access based on risk levels
- Integration with **AgentCore Policy** for real-time enforcement

---

## AgentCore Identity

A secure, scalable agent identity and access management service.

### Capabilities

- **IdP integration** -- works with Amazon Cognito, Okta, Microsoft Entra ID, Auth0
- **No user migration** -- compatible with existing identity providers
- **Token management** -- secure vault storage for refresh tokens (added at GA)
- **Identity-aware authorization** -- fine-grained access control (added at GA)
- **Dual mode** -- user-delegated (act on behalf of user) or autonomous (service credentials)

### How It Works

```
End User --> Authenticates with IdP --> Gets token
    |
    v
Agent Runtime (Inbound Auth validates token)
    |
    v
Agent needs to call Salesforce API
    |
    v
AgentCore Identity (retrieves OAuth token for Salesforce)
    |
    v
Agent calls Salesforce on behalf of user
```

No additional charges when used through AgentCore Runtime or Gateway.

---

## AgentCore Observability

Provides **complete visibility** into agent workflows with production-grade monitoring.

### Capabilities

- **Step-by-step visualization** of agent execution
- **Metadata tagging** for organizing and filtering traces
- **Custom scoring** for quality metrics
- **Trajectory inspection** -- audit intermediate outputs
- **Troubleshooting/debugging filters** for isolating issues
- **OTEL-compatible** telemetry format

### Architecture

```
Agent Execution
    |
    v
[OTEL Exporter] --> Amazon CloudWatch (native)
                 --> Datadog
                 --> Dynatrace
                 --> Arize Phoenix
                 --> LangSmith
                 --> Langfuse
```

### What Gets Captured

- Model invocations (which model, tokens, latency)
- Tool calls (which tools, parameters, results)
- Memory operations (reads, writes, retrievals)
- Errors and execution traces
- Agent reasoning steps

Observability is **powered by Amazon CloudWatch** and supports any monitoring stack that integrates with OTEL.

---

## AgentCore Policy

> Added at re:Invent 2025 (December 2, 2025) -- **Preview**

Provides **comprehensive control** over agent actions through deterministic, real-time enforcement.

### How It Works

1. Define policies in **natural language** (converted to Cedar policies automatically)
2. Policies are integrated into **AgentCore Gateway**
3. Every tool call is checked against policies in **milliseconds**
4. Unauthorized actions are **blocked** before execution
5. Operates **outside the agent code** -- works regardless of framework or model

### Key Features

- **Natural language authoring** -- write policies in plain English
- **Cedar policy engine** -- deterministic, auditable enforcement
- **Real-time checking** -- sub-millisecond evaluation
- **Tool-level granularity** -- control which tools, data, and conditions are allowed
- **Framework-independent** -- works with any agent regardless of how it was built

### Policy vs Guardrails

| Feature | AgentCore Policy | Bedrock Guardrails |
|---------|------------------|--------------------|
| **Scope** | Tool call authorization | Content safety and filtering |
| **Mechanism** | Deterministic Cedar rules | Model-based evaluation |
| **Integration** | Gateway-level interception | Model invocation layer |
| **Use case** | "Can this agent call this API?" | "Is this content appropriate?" |

---

## AgentCore Evaluations

> Added at re:Invent 2025 (December 2, 2025) -- **Preview**

Automated, continuous agent quality assessment.

### Built-in Evaluators (13)

Common quality dimensions:
- Correctness
- Helpfulness
- Tool selection accuracy
- Safety
- Goal success rate
- Context relevance
- And more

### Features

- **Custom evaluators** -- bring your own prompt + model for business-specific scoring
- **CI/CD integration** -- configurable quality thresholds for deployment gates
- **Production monitoring** -- sampling rules and dashboard aggregation
- **Cost control** -- percentage-based sampling, conditional sampling, selective metric monitoring
- Results integrated into **AgentCore Observability** via CloudWatch

---

## AgentCore Browser

A fast, secure, cloud-based **managed browser runtime** for agents.

### Capabilities

- Interact with web applications at scale
- Fill forms, navigate websites, extract information
- Compatible with **Playwright** and **BrowserUse** frameworks
- **Web Bot Auth** (Preview, Oct 2025) -- IETF draft protocol that cryptographically identifies AI agents to websites, reducing CAPTCHA challenges

### Isolation

Same microVM-based isolation as Runtime:
- Dedicated compute per session
- Consumption-based pricing (active CPU/memory only)
- Support for browser profiles (cookies, local storage) persisted to S3

---

## AgentCore Code Interpreter

An isolated **sandbox environment** for agents to execute code.

### Capabilities

- **Languages:** Python, JavaScript, TypeScript
- **Secure sandbox** -- isolated execution environment
- **File access** -- agents can read/write files within the sandbox
- **Library installation** -- agents can install packages from the internet
- **Use cases:** data analysis, computation, code generation/testing, mathematical operations

This is not limited to "coding agents" -- any agent can use code execution to enhance accuracy for computational tasks.

---

## AgentCore vs Bedrock Agents (Classic)

This is one of the most common questions. The two services serve **different needs** and are **not mutually exclusive**.

### Comparison Table

| Dimension | Bedrock Agents (Classic) | AgentCore |
|-----------|------------------------|-----------|
| **Philosophy** | Managed, configuration-based | Infrastructure platform, code-first |
| **Framework** | AWS-managed orchestration | Any framework (Strands, LangGraph, CrewAI, custom) |
| **Model support** | Bedrock-hosted models | Any model (Bedrock, OpenAI, Gemini, self-hosted) |
| **Orchestration** | AWS handles reasoning loops, prompts | You control orchestration logic |
| **Deployment** | GUI/API configuration | Container or code deployment |
| **Session isolation** | Shared infrastructure | Dedicated microVM per session |
| **Max runtime** | Minutes | Up to 8 hours |
| **Protocol support** | Proprietary | MCP, A2A, AG-UI |
| **Memory** | Built-in, limited control | Full control (short-term, long-term, episodic) |
| **Tool integration** | Action groups, knowledge bases | MCP Gateway, Lambda, APIs, 3rd party |
| **Governance** | IAM, Guardrails | IAM, Policy (Cedar), Guardrails |
| **Observability** | CloudWatch logs | Full OTEL-compatible tracing + dashboards |
| **VPC support** | Limited | Full VPC, PrivateLink across all services |
| **Pricing** | Per-step pricing | Active consumption-based |
| **Best for** | Quick deployment, standard workflows | Complex multi-agent systems, custom logic, enterprise scale |

### Decision Guide

**Choose Classic Agents when:**
- You have a clear workflow with well-defined tools
- You want AWS to handle orchestration
- You need rapid prototyping
- Standard patterns are sufficient

**Choose AgentCore when:**
- You need multiple intelligent agents with custom coordination
- You cannot be constrained by pre-built orchestration patterns
- You require enterprise-grade security, scale, and flexibility
- You use custom frameworks or need fine-grained control
- You need long-running workloads (>15 minutes)

**You can use both:**
- Prototype with Classic Agents, then migrate to AgentCore for production
- Use Classic Agents for simple workflows and AgentCore for complex ones
- They are complementary, not competing services

### From the AWS FAQ

> "If you are using Amazon Bedrock Agents today, you can continue to do so. AgentCore is an agentic platform that provides enhanced capabilities including support for any open-source framework, and the flexibility to use any foundation model of your choice, whether in or outside of Amazon Bedrock."

---

## Framework and Model Support

### Supported Frameworks

| Framework | Type | Notes |
|-----------|------|-------|
| **Strands Agents** | AWS open-source | Native SDK integration with AgentCore services |
| **LangGraph** | LangChain ecosystem | Full support via container deployment |
| **CrewAI** | Multi-agent orchestration | Full support |
| **LlamaIndex** | Data-centric agents | Full support |
| **Google ADK** | Google's Agent Dev Kit | Full support |
| **OpenAI Agents SDK** | OpenAI's framework | Full support |
| **Custom frameworks** | Any | Container-based deployment |

### Supported Models

Any LLM accessible via API:
- **Amazon Nova** (Lite, Pro, Premier)
- **Anthropic Claude** (Sonnet, Opus, Haiku)
- **Meta Llama** (3, 3.1, 3.2)
- **Mistral** (Large, Medium, Small)
- **OpenAI** (GPT-4o, o1, o3)
- **Google Gemini** (Pro, Flash, Ultra)
- Self-hosted models via API

---

## Protocol Support

| Protocol | Support | Description |
|----------|---------|-------------|
| **HTTP** | GA | Standard REST API for request/response |
| **MCP** (Model Context Protocol) | GA | Standardized tool access protocol |
| **A2A** (Agent-to-Agent) | GA (Runtime), expanding | Multi-agent communication and discovery via JSON-RPC |
| **AG-UI** (Agent-User Interaction) | GA (Mar 2026) | Real-time responsive agent experiences for frontends |
| **WebSocket** | GA | Bidirectional streaming for real-time interactions |

### A2A Architecture in AgentCore

```
Agent A (AgentCore Runtime)
    |
    | JSON-RPC over A2A protocol
    |
Agent B (AgentCore Runtime, port 9000)
    |
    +-- /.well-known/agent-card.json  (discovery)
    +-- JSON-RPC endpoints             (communication)
```

Key differentiators from HTTP-based agents:
- Port 9000 (vs 8080 for HTTP)
- Mount path `/` (vs `/invocations`)
- Standardized agent discovery via Agent Cards
- Enterprise auth (SigV4/OAuth 2.0) layered on top

---

## Pricing

AgentCore uses **consumption-based pricing** with no upfront commitments or minimum fees.

### Pricing Table (US East, N. Virginia)

| Service | Metric | Price |
|---------|--------|-------|
| **Runtime** | CPU | $0.0895 per vCPU-hour |
| **Runtime** | Memory | $0.00945 per GB-hour |
| **Browser** | CPU | $0.0895 per vCPU-hour |
| **Browser** | Memory | $0.00945 per GB-hour |
| **Code Interpreter** | CPU | $0.0895 per vCPU-hour |
| **Code Interpreter** | Memory | $0.00945 per GB-hour |
| **Gateway** | API Invocations | $0.005 per 1,000 invocations |
| **Gateway** | Search API | $0.025 per 1,000 invocations |
| **Gateway** | Tool Indexing | $0.02 per 100 tools indexed/month |
| **Policy** | Authorization Requests | $0.000025 per request |
| **Policy** | NL Policy Authoring | $0.13 per 1,000 input tokens |
| **Identity** | Token/API key requests | $0.010 per 1,000 requests* |
| **Memory** | Short-term events | $0.25 per 1,000 events |
| **Memory** | Long-term storage (built-in) | $0.75 per 1,000 records/month |
| **Memory** | Long-term storage (self-managed) | $0.25 per 1,000 records/month |
| **Memory** | Long-term retrieval | $0.50 per 1,000 retrievals |
| **Observability** | Spans, logs, metrics | CloudWatch pricing |
| **Evaluations** | Built-in (input tokens) | $0.0024 per 1,000 tokens |
| **Evaluations** | Built-in (output tokens) | $0.012 per 1,000 tokens |
| **Evaluations** | Custom | $1.50 per 1,000 evaluations |

*Identity is free when used through Runtime or Gateway.

### Cost Optimization: Active Consumption

The key pricing innovation is **active-consumption billing**:

```
Traditional Compute:
  [Active CPU] [I/O Wait] [Active CPU] [I/O Wait] [Active CPU]
  $$$$$$$$$$$  $$$$$$$$$  $$$$$$$$$$$  $$$$$$$$$  $$$$$$$$$$$

AgentCore Runtime:
  [Active CPU] [I/O Wait] [Active CPU] [I/O Wait] [Active CPU]
  $$$$$$$$$$$  FREE       $$$$$$$$$$$  FREE       $$$$$$$$$$$
```

Since agentic workloads typically spend **30-70% of time** in I/O wait (waiting for LLM responses, tool calls, database queries), active-consumption pricing delivers substantial savings.

### Billing Details

- Per-second increments, 1-second minimum
- CPU: charged on actual consumption (zero during I/O wait)
- Memory: charged on peak memory consumed up to that second
- 128MB minimum memory billing
- System overhead included in billing
- ECR storage billed separately for container deployments
- Network data transfer at standard EC2 rates

### Free Tier

New AWS customers receive up to **$200 in Free Tier credits** applicable to AgentCore.

### Pricing Example: Customer Support Agent

For a deployment serving 10K monthly active users (5 interactions each):
- Active processing per interaction: ~30 seconds CPU, ~512MB memory
- Typical monthly cost: scales linearly with actual usage
- 30-70% savings vs equivalent pre-allocated compute

---

## Regional Availability

As of GA (October 2025), AgentCore is available in **9 AWS Regions**:

| Region | Code | Notes |
|--------|------|-------|
| US East (N. Virginia) | us-east-1 | All services |
| US East (Ohio) | us-east-2 | All services except Evaluations |
| US West (Oregon) | us-west-2 | All services |
| Asia Pacific (Mumbai) | ap-south-1 | All services |
| Asia Pacific (Singapore) | ap-southeast-1 | All services |
| Asia Pacific (Sydney) | ap-southeast-2 | All services |
| Asia Pacific (Tokyo) | ap-northeast-1 | All services |
| Europe (Frankfurt) | eu-central-1 | All services |
| Europe (Ireland) | eu-west-1 | All services |

---

## Code Examples

### Minimal Agent Deployment with Strands

```python
# agent.py
from strands import Agent, tool
from strands_tools import calculator, current_time

SYSTEM_PROMPT = """
You are a helpful customer support assistant.
You can answer questions, check order status, and process returns.
"""

agent = Agent(
    model="us.amazon.nova-lite-v1:0",
    system_prompt=SYSTEM_PROMPT,
    tools=[calculator, current_time],
)
```

### Deploying to AgentCore Runtime

```python
from bedrock_agentcore.runtime import AgentCoreApp

app = AgentCoreApp()

@app.handler
def handle_request(request):
    response = agent(request.payload["prompt"])
    return {"response": str(response)}

if __name__ == "__main__":
    app.serve()
```

### Using AgentCore Memory

```python
from bedrock_agentcore.memory import MemoryClient

memory = MemoryClient(memory_id="my-memory-store")

# Store short-term event
memory.create_event(
    session_id="user-123-session-1",
    event={"role": "user", "content": "I need help with my order"}
)

# Retrieve long-term memories
memories = memory.retrieve(
    namespace="user-123",
    query="order history and preferences"
)
```

### Using AgentCore Gateway (MCP Tools)

```python
from strands import Agent
from bedrock_agentcore.gateway import GatewayClient

gateway = GatewayClient(gateway_id="my-gateway")
tools = gateway.get_tools()  # Returns MCP-compatible tools

agent = Agent(
    model="us.anthropic.claude-sonnet-4-v1:0",
    tools=tools,
)
```

### Container Deployment (Dockerfile)

```dockerfile
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY agent.py .

EXPOSE 8080
CMD ["python", "agent.py"]
```

### Direct Code Deployment (ZIP)

```bash
# Package your agent code
zip -r agent.zip agent.py requirements.txt

# Deploy via CLI
aws bedrock-agentcore create-agent-runtime \
    --agent-runtime-name "my-agent" \
    --code-artifact file://agent.zip \
    --handler "agent.handle_request"
```

---

## Customer Adoption

Major organizations using AgentCore in production:

| Organization | Use Case | Impact |
|--------------|----------|--------|
| **Ericsson** | R&D agents across millions of LOC, 3G-6G systems | Unprecedented capability in real-world R&D |
| **Thomson Reuters** | Content workflow reimagination | Compressing timelines from months to weeks |
| **Cox Automotive** | Automotive AI initiatives | Secured deployments with observability |
| **Epsilon** | Campaign automation | 30% reduced setup time, 20% more personalization, 8h/week saved |
| **Iberdrola** | IT operations (ServiceNow) | Change validation + incident enrichment with multi-agent orchestration |
| **Amazon Devices** | Operations & supply chain | Advanced manufacturing and quality |
| **Grupo Elfa** | Reactive-to-proactive operations | Complete audit traceability, 95% cost reduction |
| **S&P Global** | Astra -- internal agentic workflow platform | Unified memory layer resolved fragmentation |
| **Natera** | Healthcare AI | Enterprise security and compliance |
| **PGA TOUR** | Sports analytics | Scalable agent infrastructure |
| **Workday** | HR/Finance AI | Production agent deployments |

The AgentCore SDK has been downloaded **over 2 million times** as of December 2025.

---

## Key Takeaways

1. **AgentCore is an operational platform, not an agent framework.** It handles the infrastructure (runtime, identity, memory, observability, governance) so you can focus on agent logic.

2. **Framework and model agnostic.** You are not locked into any single ecosystem. Use Strands, LangGraph, CrewAI, or your own framework. Use any LLM.

3. **MicroVM session isolation** is the core security differentiator. Each user gets a dedicated compute environment -- no shared state, no data leakage.

4. **Active-consumption pricing** is genuinely novel for agentic workloads. You do not pay for I/O wait, which is typically 30-70% of agent execution time.

5. **The GA release (Oct 2025)** added critical enterprise features: VPC, PrivateLink, CloudFormation, resource tagging, A2A protocol, self-managed memory.

6. **re:Invent 2025 additions** (Policy, Evaluations, episodic memory) address the governance gap that was blocking production adoption.

7. **AgentCore and Classic Agents are complementary.** Use Classic for simple, managed workflows. Use AgentCore for complex, multi-agent, custom-framework scenarios.

8. **The Strands Agents SDK** is the natural companion framework, providing native integration with all AgentCore services through a simple SDK.

9. **9 regions at GA** with broad service coverage. Most services available in all regions; Evaluations has slightly narrower availability.

10. **The trajectory is clear:** AWS is positioning AgentCore as the foundational infrastructure layer for the "billions of agents" future, similar to how EC2 became the foundation for cloud computing.

---

## Sources

### AWS Official Documentation
- [What is Amazon Bedrock AgentCore?](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)
- [How AgentCore Runtime Works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html)
- [Host Agents with AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html)
- [AgentCore Pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)
- [AgentCore FAQs](https://aws.amazon.com/bedrock/agentcore/faqs/)
- [AgentCore Product Page](https://aws.amazon.com/bedrock/agentcore/)
- [Document History](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/doc-history.html)

### AWS Blog Posts
- [Introducing Amazon Bedrock AgentCore (Preview)](https://aws.amazon.com/blogs/aws/introducing-amazon-bedrock-agentcore-securely-deploy-and-operate-ai-agents-at-any-scale/) -- Jul 2025
- [AgentCore Now Generally Available](https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-agentcore-is-now-generally-available/) -- Oct 2025
- [AgentCore Adds Evaluations and Policy](https://aws.amazon.com/blogs/aws/amazon-bedrock-agentcore-adds-quality-evaluations-and-policy-controls-for-deploying-trusted-ai-agents/) -- Dec 2025
- [Move from POC to Production with AgentCore](https://aws.amazon.com/blogs/machine-learning/move-your-ai-agents-from-proof-of-concept-to-production-with-amazon-bedrock-agentcore/)
- [Deploy Agents with GitHub Actions](https://aws.amazon.com/blogs/machine-learning/deploy-ai-agents-on-amazon-bedrock-agentcore-using-github-actions/)
- [Full-Stack Starter Template (FAST)](https://aws.amazon.com/blogs/machine-learning/accelerate-agentic-application-development-with-a-full-stack-starter-template-for-amazon-bedrock-agentcore/)
- [Iberdrola Case Study](https://aws.amazon.com/blogs/machine-learning/iberdrola-enhances-it-operations-using-amazon-bedrock-agentcore/)

### AWS Announcements
- [AgentCore GA Announcement](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-bedrock-agentcore-available/) -- Oct 13, 2025
- [AgentCore Preview Announcement](https://aws.amazon.com/about-aws/whats-new/2025/07/amazon-bedrock-agentcore-preview/) -- Jul 2025
- [AG-UI Protocol Support](https://aws.amazon.com/about-aws/whats-new/2026/03/amazon-bedrock-agentcore-runtime-ag-ui-protocol/) -- Mar 2026
- [New AgentCore Capabilities (re:Invent 2025)](https://www.aboutamazon.com/news/aws/aws-amazon-bedrock-agent-core-ai-agents) -- Dec 2025

### AWS Prescriptive Guidance
- [AgentCore in AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-frameworks/amazon-bedrock-agentcore.html)
- [AgentCore for SAP](https://docs.aws.amazon.com/sap/latest/general/rise-agenticai-bedrock-agentcore.html)

### Community & Third-Party
- [AWS re:Post: Bedrock Agents vs AgentCore](https://repost.aws/questions/QUjkf4WbikQ6WrpuH9sppjnw/bedrock-agents-vs-bedrock-agentcore)
- [Builder.aws: Classic Agent vs AgentCore Agent](https://builder.aws.com/content/37CiyFazLQbrG6RC7lR6c1a2fPQ/amazon-bedrock-classic-agent-vs-agentcore-agent)
- [Builder.aws: AI Agents on AWS in 2025](https://builder.aws.com/content/37j0ql3ZfI6mE0SDYxxGvq18YCM/building-ai-agents-on-aws-in-2025-a-practitioners-guide-to-bedrock-agentcore-and-beyond)
- [Architecting AI Agents at Scale (Medium)](https://aws.plainenglish.io/architecting-ai-agents-at-scale-with-aws-agentcore-994fb68df8f9)
- [AgentCore Beginner's Guide](https://hidekazu-konishi.com/entry/amazon_bedrock_agentcore_beginners_guide.html)
- [Langfuse AgentCore Integration](https://langfuse.com/changelog/2025-11-04-amazon-bedrock-agentcore-integration)
- [Metal Toad: AgentCore Overview](https://www.metaltoad.com/blog/amazon-bedrock-agentcore-awss-answer-to-ai-agents)
- [re:Invent 2025 Serverless & Agentic AI Takeaways](https://ranthebuilder.cloud/blog/aws-re-invent-2025-my-serverless-agentic-ai-takeaways/)
- [AgentCore Runtime Deep Dive (YouTube)](https://www.youtube.com/watch?v=wizEw5a4gvM)

### API References
- [AgentCore Control Plane API -- AgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_AgentRuntime.html)
- [AgentCore Data Plane API -- InvokeAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html)

### GitHub
- [AgentCore Samples](https://github.com/awslabs/agents-for-amazon-bedrock-agentcore-samples)
- [Strands Agents SDK (Python)](https://github.com/strands-agents/sdk-python)
- [AgentCore Starter Toolkit](https://github.com/awslabs/amazon-bedrock-agentcore-starter-toolkit)
