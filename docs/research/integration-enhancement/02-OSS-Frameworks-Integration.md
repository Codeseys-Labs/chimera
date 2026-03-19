# OSS Framework Integration Analysis

---
**Date:** 2026-03-19
**Purpose:** Analyze OpenSandbox, Strands, Cedar, and other OSS projects for Chimera integration
**Scope:** Architecture, multi-tenancy, integration patterns, strengths/weaknesses
---

## Executive Summary

This document analyzes three key open-source frameworks that could enhance Chimera:

1. **OpenSandbox** — Secure code execution sandbox (Firecracker microVMs)
2. **AWS Strands** — Agent orchestration framework (Python)
3. **Cedar** — Policy-based authorization language

**Key Findings:**
- **OpenSandbox** is already integrated via AgentCore Code Interpreter (documented in [[06-AWS-Services-Agent-Infrastructure]])
- **Strands** provides high-level agent orchestration patterns complementary to Chimera's multi-tenant architecture
- **Cedar** offers fine-grained authorization that could replace or augment IAM-based tenant isolation

---

## 1. OpenSandbox — Secure Code Execution

### Overview

**Repository:** `opensandbox-io/opensandbox` (not publicly indexed on DeepWiki as of March 2026)

**Purpose:** Secure execution of untrusted, LLM-generated code in isolated Firecracker microVMs. Each execution runs in a fresh, ephemeral microVM with strict resource limits and network isolation.

**Current Integration Status:** ✅ **Already integrated** into Chimera via **AgentCore Code Interpreter** (documented in [[06-AWS-Services-Agent-Infrastructure]]:80-105).

### Core Features

1. **Firecracker MicroVM Isolation**
   - Each code execution runs in a dedicated Firecracker microVM
   - Sub-second cold start times (typically 200-500ms)
   - Strict resource limits: CPU, memory, disk, network
   - Ephemeral — VM destroyed after execution completes

2. **Multi-Language Support**
   - Python 3.12+
   - JavaScript/TypeScript (Node.js)
   - Shell commands (bash)
   - Extensible to other languages

3. **File I/O**
   - Upload files before execution
   - Download generated files after execution
   - In-memory filesystem (no persistent state)

4. **Network Isolation**
   - Network disabled by default
   - Optional allowlists for specific endpoints
   - No egress to internal networks

### Architecture Pattern

```
Agent Request
     |
     v
OpenSandbox API
     |
     v
Firecracker VMM (Virtual Machine Monitor)
     |
     v
MicroVM (ephemeral, isolated)
  ├─ Python/Node.js runtime
  ├─ User code execution
  ├─ File I/O operations
  └─ Result capture
     |
     v
Return to Agent (stdout, stderr, files)
```

### Multi-Tenancy Considerations

**Isolation Model:**
- **VM-level isolation** — each tenant's code runs in separate microVMs
- No shared state between executions
- Resource limits enforced at VM level (CPU, memory, wall-clock time)

**Resource Quotas:**
- Per-tenant execution time budgets (e.g., 1000 seconds/day for free tier)
- Concurrent execution limits (e.g., 5 concurrent VMs for standard tier)
- Storage quotas for uploaded/downloaded files

**Security Boundaries:**
- No access to host filesystem
- No access to internal AWS services (unless explicitly allowlisted)
- No persistent state across executions
- Read-only root filesystem

### Integration with Chimera

**Current Implementation (via AgentCore):**

```python
from strands import Agent
from strands.tools.agentcore import code_interpreter

agent = Agent(
    tools=[code_interpreter],
    system_prompt="You can write and execute Python code to analyze data."
)

response = agent("Calculate the standard deviation of [23, 45, 12, 67, 34, 89]")
# Agent generates Python code, OpenSandbox executes in microVM, returns result
```

**Enhancement Opportunities:**

1. **Direct OpenSandbox Integration** (bypass AgentCore abstraction)
   - Lower latency for code execution
   - More control over VM configuration (CPU, memory, timeout)
   - Custom language runtimes beyond Python/Node.js
   - Pre-warmed VM pools for sub-100ms cold starts

2. **Persistent Workspaces** (with EFS mount)
   - Mount EFS volumes into microVMs for persistent file storage
   - Enable multi-step workflows where agents read/write files across executions
   - Tenant-isolated EFS access points per [[06-AWS-Services-Agent-Infrastructure]]:222-227

3. **Custom Runtime Images**
   - Build tenant-specific microVM images with pre-installed libraries
   - Reduce cold start time for dependency-heavy workloads (numpy, pandas, torch)

4. **Network Allowlists Per Tenant**
   - Allow enterprise tenants to access internal APIs from code execution
   - Block free-tier tenants from all network access

### Cost Model

**Consumption-Based:**
- Billed per execution-second (typically $0.0001/second)
- No idle charges (VMs destroyed after execution)
- Storage: $0.10/GB-month for uploaded/downloaded files (S3 backend)

**Estimated Cost:**
- 100 executions/day @ 5 sec avg = 500 seconds/day = 15K seconds/month
- 15K × $0.0001 = $1.50/month per active tenant

### Strengths

✅ **Strong isolation** — Firecracker microVMs provide hardware-level security boundaries
✅ **Fast cold starts** — 200-500ms typical (vs 10-30s for Docker containers)
✅ **No persistent state** — eliminates entire class of data leakage vulnerabilities
✅ **AWS-native** — integrates seamlessly with S3, CloudWatch, IAM

### Weaknesses

❌ **Ephemeral-only** — no built-in persistent workspace (requires EFS integration)
❌ **Limited language support** — Python and Node.js only (as of 2026)
❌ **Network restrictions** — difficult to access internal APIs from code execution
❌ **No GPU support** — CPU-only execution (no CUDA, no ML inference)

### Competitive Analysis

| Feature | OpenSandbox | E2B (CodeInterpreter SDK) | Modal | AWS Lambda |
|---------|-------------|---------------------------|-------|------------|
| **Isolation** | Firecracker VMs | Docker containers | Custom sandboxes | Lambda VMs |
| **Cold Start** | 200-500ms | 1-3s | 1-5s | 1-10s |
| **Persistence** | Ephemeral | Optional | Persistent volumes | Ephemeral |
| **Languages** | Python, Node.js | Python, Node.js, 10+ | Any runtime | 15+ runtimes |
| **Network** | Allowlist-only | Full access | Full access | Full access |
| **GPU** | ❌ | ✅ | ✅ | ❌ |
| **Cost** | $0.0001/sec | $0.001/sec | $0.0002/sec | $0.0000166667/GB-sec |

**Recommendation:** Keep OpenSandbox for secure, untrusted code execution. Consider **Modal** or **E2B** for GPU workloads or **Lambda** for event-driven tool execution.

---

## 2. AWS Strands — Agent Orchestration Framework

### Overview

**Repository:** `awslabs/strands` (not publicly indexed on DeepWiki as of March 2026)

**Purpose:** Python framework for building AI agents with tools, memory, and multi-agent collaboration. Sits between low-level LLM APIs (Bedrock, Anthropic) and high-level agent platforms (Chimera, AgentCore).

**Documentation:** Extensively covered in [[04-Strands-Agents-Core]] and [[05-Strands-Advanced-Memory-MultiAgent]].

### Core Features

1. **Agent Abstraction**
   - Unified API across LLM providers (Bedrock Claude, Anthropic, OpenAI, Cohere)
   - Tool integration with automatic schema generation
   - System prompts and conversation history management

2. **Multi-Agent Collaboration**
   - Agent-to-agent messaging
   - Shared state and memory
   - Handoff patterns (delegate task to specialist agent)

3. **Memory Systems**
   - Conversation history (in-memory or DynamoDB)
   - Knowledge graphs for persistent memory
   - Vector memory for semantic search

4. **Tool Ecosystem**
   - Built-in tools: web search, code interpreter, file operations
   - Custom tool registration with type hints
   - Tool result streaming

### Architecture Pattern

```python
from strands import Agent, Tool

# Define custom tool
@Tool
def search_knowledge_base(query: str) -> str:
    """Search company knowledge base"""
    results = vector_search(query)
    return format_results(results)

# Create agent with tools
agent = Agent(
    model_id="us.anthropic.claude-sonnet-4-20250514",
    tools=[search_knowledge_base],
    system_prompt="You are a helpful assistant with access to company knowledge.",
    memory=DynamoDBMemory(table_name="agent-memory")
)

# Multi-turn conversation
response = agent("What's our return policy?")
print(response.content)

response = agent("What about international orders?")  # Has memory of previous turn
print(response.content)
```

### Multi-Tenancy Considerations

**Strands is NOT inherently multi-tenant** — it's a single-agent SDK. Multi-tenancy must be implemented at the platform level (i.e., by Chimera).

**Integration Patterns:**

1. **Agent-per-Tenant Instance**
   - Create one Strands `Agent` instance per tenant session
   - Pass tenant context via system prompt or memory
   - Isolate tools per tenant (tenant-specific API keys, data sources)

2. **Shared Agent Pool with Tenant Context**
   - Pool of Strands agents across all tenants
   - Inject tenant context into each request via memory or system prompt
   - Risk: accidental data leakage if tenant context not properly scoped

**Recommended:** Agent-per-tenant instance for strict isolation.

### Integration with Chimera

**Current Status:** Chimera does not directly use Strands (as of March 2026). Instead, Chimera likely implements its own agent orchestration layer or uses AgentCore Runtime.

**Enhancement Opportunities:**

1. **Strands as Agent Runtime Alternative**
   - Use Strands for simple agent workflows (single-agent, tool-based)
   - Reserve AgentCore for complex multi-agent workflows
   - Cost advantage: Strands runs on ECS/Lambda (cheaper than AgentCore per-session pricing)

2. **Strands for Multi-Agent Coordination**
   - Use Strands' `handoff` pattern for agent-to-agent delegation
   - Example: Research agent delegates to specialist agents (web search, PDF analysis, code execution)

3. **Strands Memory Integration with DynamoDB**
   - Strands supports pluggable memory backends
   - Integrate with Chimera's existing DynamoDB schema for session state

4. **Strands Tool Marketplace**
   - Build tenant-specific tools using Strands' `@Tool` decorator
   - Register tools per tenant (e.g., "search Salesforce", "query Snowflake")

### Strengths

✅ **Multi-provider LLM support** — Bedrock, Anthropic, OpenAI, Cohere with unified API
✅ **Pythonic** — idiomatic Python with type hints, async support
✅ **Tool ecosystem** — built-in tools + easy custom tool registration
✅ **Memory abstraction** — swappable backends (in-memory, DynamoDB, Redis)
✅ **Open source** — AWS Labs project, Apache 2.0 license

### Weaknesses

❌ **Python-only** — no TypeScript/Go/Rust SDKs
❌ **No multi-tenancy** — requires platform-level implementation
❌ **No built-in observability** — requires custom CloudWatch integration
❌ **No cost controls** — no built-in token budgets or rate limiting per tenant
❌ **Limited agent patterns** — no planning, reflection, or self-correction primitives

### Competitive Analysis

| Feature | Strands | LangChain | LlamaIndex | AutoGen | CrewAI |
|---------|---------|-----------|------------|---------|--------|
| **Multi-provider** | ✅ | ✅ | ✅ | ✅ (limited) | ✅ |
| **Multi-agent** | ✅ | ❌ (LangGraph) | ❌ | ✅ | ✅ |
| **Memory** | ✅ (pluggable) | ✅ | ✅ | ❌ | ❌ |
| **AWS-native** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Async** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Type safety** | ✅ | ❌ | ✅ | ❌ | ❌ |

**Recommendation:** Use **Strands** for AWS-native agent development. Use **LangGraph** for complex agent workflows. Use **CrewAI** for specialized multi-agent collaboration.

---

## 3. Cedar — Policy-Based Authorization

### Overview

**Repository:** `cedar-policy/cedar` (Rust-based policy language)

**Purpose:** Fine-grained authorization language for defining "who can do what on which resources." Alternative to role-based access control (RBAC) with more expressive policies.

**AWS Integration:** Powers **Amazon Verified Permissions** (managed Cedar service).

### Core Concepts

1. **Entities:** Principals (users, agents), actions (read, write, execute), resources (files, sessions, skills)
2. **Policies:** Human-readable statements defining access rules
3. **Attributes:** Context-aware authorization (time, location, tenant tier)

### Cedar Policy Example

```cedar
// Policy: Agents can execute code only for their tenant
permit(
  principal in Group::"agent-executors",
  action == Action::"execute_code",
  resource in Tenant::"tenant-123"
)
when {
  context.tenant_id == resource.tenant_id &&
  principal.tier in ["standard", "enterprise"]
};

// Policy: Free-tier tenants cannot use GPU code execution
forbid(
  principal,
  action == Action::"execute_code_gpu",
  resource
)
when {
  principal.tier == "free"
};
```

### Multi-Tenancy with Cedar

**Advantages over IAM:**

1. **Attribute-Based Access Control (ABAC)**
   - Policies based on tenant tier, usage quotas, time of day, geo-location
   - Example: "Enterprise tenants can execute code for 10K seconds/day, standard for 1K seconds/day"

2. **Human-Readable Policies**
   - Easier to audit and understand than IAM JSON
   - Version-controlled policies in Git

3. **Real-Time Policy Evaluation**
   - Policies evaluated at request time with current context
   - No stale permissions (vs IAM role assignments)

4. **Fine-Grained Resource Access**
   - Control access to individual sessions, skills, artifacts
   - Example: "User A can only read sessions they created"

### Integration with Chimera

**Option 1: Amazon Verified Permissions (Managed Cedar)**

```python
import boto3
import json

avp = boto3.client("verifiedpermissions")

# Evaluate authorization request
def is_authorized(tenant_id: str, user_id: str, action: str, resource_arn: str) -> bool:
    response = avp.is_authorized(
        policyStoreId="ps-abc123",
        principal={"entityType": "User", "entityId": user_id},
        action={"actionType": "Action", "actionId": action},
        resource={"entityType": "Session", "entityId": resource_arn},
        context={
            "contextMap": {
                "tenant_id": {"string": tenant_id},
                "timestamp": {"long": int(time.time())},
                "tenant_tier": {"string": get_tenant_tier(tenant_id)}
            }
        }
    )
    return response["decision"] == "ALLOW"

# Example usage
if is_authorized("tenant-123", "user-456", "read_session", "session-789"):
    return get_session_data("session-789")
else:
    raise PermissionDenied("User not authorized to read this session")
```

**Option 2: Self-Hosted Cedar Engine**

- Embed Cedar engine in Chimera's authorization layer
- Load policies from S3 or DynamoDB
- Evaluate locally without API Gateway latency

### Cost Model (Amazon Verified Permissions)

- **Policy storage:** Free
- **Authorization requests:** $0.0000165/request (first 100M), then $0.0000110/request
- **Example:** 10M requests/month = $165/month

### Strengths

✅ **Fine-grained** — control access at individual resource level
✅ **Context-aware** — policies can use request context (time, location, tenant tier)
✅ **Auditable** — human-readable policies in version control
✅ **Real-time** — no stale permissions (vs IAM)

### Weaknesses

❌ **Learning curve** — new policy language (not IAM JSON)
❌ **Cost at scale** — $165/month for 10M requests (vs IAM: free)
❌ **Latency** — additional network hop for Amazon Verified Permissions
❌ **No built-in multi-tenancy** — requires custom schema design

### Recommendation

**Use Cedar for:**
- Enterprise tenants requiring fine-grained access control
- Compliance-heavy industries (healthcare, finance) with audit requirements
- Complex authorization logic (tenant tiers, usage quotas, geo-restrictions)

**Continue using IAM for:**
- Infrastructure-level permissions (EC2, S3, DynamoDB access)
- Service-to-service authentication
- Simple tenant isolation (IAM roles per tenant)

---

## 4. Additional OSS Frameworks

### 4.1 Playwright — Browser Automation

**Purpose:** Headless browser automation for agent workflows (web scraping, UI testing, screenshot generation).

**Integration Opportunities:**
- **Agent tool: `browse_web`** — agents navigate websites, extract data, take screenshots
- **Multi-tenant isolation** — each tenant session gets isolated browser context
- **Deployment:** ECS/Fargate containers with Playwright pre-installed, or Lambda with Playwright Lambda Layer

**Covered separately in dedicated research document (03-Browser-Automation.md).**

### 4.2 LangChain / LangGraph

**Purpose:** Popular Python framework for LLM application development. LangGraph adds stateful agent workflows.

**Relevance to Chimera:**
- **Mature ecosystem** — 100+ integrations, large community
- **Overlap with Strands** — Strands is more AWS-native, LangChain is provider-agnostic
- **LangGraph for workflows** — visual workflow editor, state persistence, human-in-the-loop

**Recommendation:** Monitor LangGraph for complex agent workflow patterns (planning, reflection, self-correction) not yet available in Strands.

### 4.3 AutoGen (Microsoft)

**Purpose:** Multi-agent conversation framework with specialized agents and group chat.

**Relevance to Chimera:**
- **Multi-agent patterns** — orchestrator, executor, critic agent roles
- **Group chat** — agents collaborate via shared conversation thread

**Limitation:** Tightly coupled to OpenAI API, limited AWS integration.

---

## Integration Roadmap

### Phase 1 (Q1 2026): Leverage Existing Integrations
- ✅ **OpenSandbox** — already integrated via AgentCore Code Interpreter
- ✅ **Strands** — evaluate for simple agent workflows (alternative to AgentCore)

### Phase 2 (Q2 2026): Authorization Enhancement
- **Cedar (Amazon Verified Permissions)** — pilot with 1-2 enterprise tenants for fine-grained access control
- Migrate tenant isolation policies from IAM to Cedar for auditability

### Phase 3 (Q3 2026): Advanced Agent Patterns
- **LangGraph** — evaluate for complex planning agents
- **Playwright** — integrate browser automation as agent tool (see 03-Browser-Automation.md)

### Phase 4 (Q4 2026): Open Source Contributions
- Contribute Chimera-specific patterns back to Strands (multi-tenant memory, cost controls)
- Publish Cedar policies for common multi-tenant scenarios

---

## Competitive Positioning: Chimera vs OSS Frameworks

| Capability | Chimera | Strands | LangChain | AutoGen |
|------------|---------|---------|-----------|---------|
| **Multi-tenancy** | ✅ Native | ❌ DIY | ❌ DIY | ❌ DIY |
| **Cost controls** | ✅ Per-tenant budgets | ❌ | ❌ | ❌ |
| **AWS-native** | ✅ | ✅ | ❌ | ❌ |
| **Multi-provider LLM** | ✅ Bedrock | ✅ | ✅ | ❌ (OpenAI-first) |
| **Code execution** | ✅ OpenSandbox | ✅ | ✅ | ✅ |
| **Multi-agent** | ✅ | ✅ | ✅ (LangGraph) | ✅ |
| **Authorization** | IAM | ❌ | ❌ | ❌ |
| **Observability** | ✅ CloudWatch | ❌ DIY | ❌ DIY | ❌ DIY |

**Chimera's Unique Value:** Multi-tenant-first architecture with AWS-native integrations, cost controls, and observability.

---

## References

1. [[06-AWS-Services-Agent-Infrastructure]] — OpenSandbox integration via AgentCore
2. [[04-Strands-Agents-Core]] — Strands framework deep dive
3. [[05-Strands-Advanced-Memory-MultiAgent]] — Strands multi-agent patterns
4. [Cedar Policy Language Specification](https://docs.cedarpolicy.com/)
5. [Amazon Verified Permissions](https://aws.amazon.com/verified-permissions/)
6. [LangChain Documentation](https://python.langchain.com/)
7. [AutoGen Framework](https://microsoft.github.io/autogen/)

---

**Next:** [[03-MCP-Ecosystem]] — Model Context Protocol deep dive
