# AgentCore Multi-Tenancy and Deployment Patterns

> **Research Date:** 2026-03-19
> **Sources:** AWS Prescriptive Guidance (multi-tenant agentic AI), AWS documentation, re:Invent 2025 SaaS track (SAS407/409/410), aws-samples repos, AWS blog posts
> **Related:** [[01-AgentCore-Architecture-Runtime]] | [[02-AgentCore-APIs-SDKs-MCP]] | [[06-AWS-Services-Agent-Infrastructure]]

---

## Table of Contents

- [[#1. The Agent-as-a-Service (AaaS) Paradigm]]
- [[#2. Multi-Tenancy Architecture Patterns]]
- [[#3. Session and Data Isolation]]
- [[#4. Tenant Context Propagation]]
- [[#5. Security Boundaries and Access Control]]
- [[#6. Scaling Strategies]]
- [[#7. Deployment Patterns]]
- [[#8. Cost Management and Attribution]]
- [[#9. Control Planes for Agentic Environments]]
- [[#10. Noisy Neighbor Protection]]
- [[#11. Observability in Multi-Tenant Agent Systems]]
- [[#12. Reference Implementations]]
- [[#13. Key Takeaways and Decision Framework]]

---

## 1. The Agent-as-a-Service (AaaS) Paradigm

AWS Prescriptive Guidance (July 2025, by Aaron Sempf and Tod Golding) formalizes the concept of **Agent as a Service (AaaS)** -- where AI agents are packaged, deployed, and consumed as managed services by multiple customers. This paradigm inherits the same architectural challenges as traditional SaaS: scale, noisy neighbor, resilience, cost efficiency, and operational excellence.

### Two AaaS Models

| Model | Description | Multi-Tenancy Impact |
|-------|-------------|---------------------|
| **Customer-Dedicated** | Separate agent instance per customer. Agent learns and evolves within a single customer's scope. | Simpler isolation, higher cost, limited economies of scale |
| **Shared Agent (AaaS)** | Single agent serves multiple customers. Evolves based on collective experience. | Requires tenant context, isolation policies, and shared resource management |

The shared AaaS model further splits into two variants:

1. **Context-Free AaaS** -- All customers get the same experience. No tenant-specific customization. Minimal tenancy impact.
2. **Tenant-Aware AaaS** -- The agent's resources, actions, tools, memory, and knowledge vary per tenant. Tenant context directly shapes outcomes.

> **Key Insight:** Most production agentic systems will be hybrid -- part traditional SaaS microservices, part agent-based. Multi-tenancy applies to the agents embedded within the broader system, not just standalone AaaS offerings.

### Why Multi-Tenancy Matters for Agents

Tenancy affects every agent component:

- **Memory** -- Per-tenant conversation history and learned preferences
- **Knowledge** -- Tenant-specific RAG data, vector stores, knowledge bases
- **Tools** -- Tenant-scoped tool access, API credentials, and permissions
- **Guardrails** -- Tenant-specific behavioral boundaries and compliance rules
- **Workflows** -- Custom orchestration paths per tenant or tier
- **Models** -- Different model versions or fine-tuned variants per tenant

**Source:** [AWS Prescriptive Guidance -- Building multi-tenant architectures for agentic AI on AWS](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-multitenant/introduction.html)

---

## 2. Multi-Tenancy Architecture Patterns

### 2.1 The Three Deployment Models

AgentCore supports three fundamental multi-tenant deployment models, directly mapping to classic SaaS patterns:

#### Silo Model (Dedicated)

```
Tenant A ──> [Agent A] ──> [Memory A] ──> [Tools A]
Tenant B ──> [Agent B] ──> [Memory B] ──> [Tools B]
Tenant C ──> [Agent C] ──> [Memory C] ──> [Tools C]
```

- Each tenant gets a fully isolated agent instance with dedicated compute, memory, and tools
- Agents do NOT share execution environments across tenants
- Maximum isolation; highest cost; simplest compliance story
- Best for: regulated industries, high-value enterprise tenants, strict data sovereignty

**Pros:**
- No noisy neighbor concerns
- Straightforward tenant cost tracking
- Limited blast radius on failures
- Supports challenging compliance models

**Cons:**
- Scaling challenges (linear cost growth)
- Higher operational overhead (per-tenant management)
- Slower onboarding automation
- Decentralized monitoring

#### Pool Model (Shared)

```
Tenant A ─┐
Tenant B ──> [Shared Agent] ──> [Shared Memory] ──> [Shared Tools]
Tenant C ─┘
           (tenant context applied at runtime)
```

- All tenants share the same agent, compute, memory, and service infrastructure
- Tenant isolation enforced through runtime policies (JWT claims, ABAC, IAM scoping)
- Maximum efficiency; requires robust isolation mechanisms
- Best for: high-volume, cost-sensitive deployments with many tenants

#### Hybrid/Bridge Model

```
Tenant A ──> [Silo Agent 1] ──> [Dedicated Memory]
             [Pool Agent 2] ──> [Shared Memory]
             [Pool Agent 3] ──> [Shared Tools]

Tenant B ──> [Silo Agent 1] ──> [Dedicated Memory]
             [Pool Agent 2] ──> [Shared Memory]
             [Pool Agent 3] ──> [Shared Tools]
```

- Some agents are siloed (e.g., compliance-sensitive ones), others are pooled
- Mix of dedicated and shared resources per agent or per component
- Most common in production -- balance isolation, cost, and operational efficiency
- Best for: tiered SaaS offerings (Premium = silo, Basic = pool)

### 2.2 Routing Strategies

Deployment models are implemented via routing constructs, not direct agent awareness:

```
                    ┌─ Silo Agent (Tenant A) ─┐
[Proxy/Router] ─────┼─ Silo Agent (Tenant B) ─┤
                    └─ Pool Agent (All)       ─┘
```

- Agent 1 uses a **proxy** to distribute requests to siloed tenant agents
- Agent 2 requires **no routing** -- single pooled agent serves all tenants
- Agent 3 is **hybrid** -- some tenants siloed, others pooled

Each agent provider independently chooses their deployment strategy. A multi-agent system can mix silo, pool, and hybrid across different agents from different providers.

**Source:** [Agent deployment models -- AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-multitenant/agent-deployment-models.html)

### 2.3 Tier-Based Multi-Tenancy

Production SaaS agents commonly map deployment models to subscription tiers:

| Tier | Deployment | Resources | Features |
|------|-----------|-----------|----------|
| **Premium** | Full silo | Dedicated AgentCore Runtime, dedicated memory, dedicated tools | Custom models, unlimited usage, priority support |
| **Advanced** | Hybrid | Dedicated memory, pooled compute | Extended tools, higher rate limits |
| **Basic** | Full pool | Shared everything | Standard tools, usage-capped, shared rate limits |

The `aws-samples/sample-multi-tenant-agent-core-app` reference implementation demonstrates this with subscription tiers (Basic, Advanced, Premium) controlling:
- Model access (which LLMs are available per tier)
- Tool availability
- Usage limits and rate caps
- Feature flags

**Source:** [github.com/aws-samples/sample-multi-tenant-agent-core-app](https://github.com/aws-samples/sample-multi-tenant-agent-core-app)

---

## 3. Session and Data Isolation

### 3.1 MicroVM-Based Session Isolation

AgentCore Runtime provides **hardware-level session isolation** through dedicated microVMs -- the strongest isolation model available for agent workloads.

#### How It Works

```
User A Session ──> [MicroVM-A: isolated CPU, memory, filesystem]
User B Session ──> [MicroVM-B: isolated CPU, memory, filesystem]
User C Session ──> [MicroVM-C: isolated CPU, memory, filesystem]
```

Each session receives:

| Resource | Isolation Level |
|----------|----------------|
| **CPU** | Dedicated per microVM |
| **Memory** | Dedicated per microVM, sanitized on termination |
| **Filesystem** | Isolated per microVM, destroyed on termination |
| **Network** | Session-scoped security contexts |
| **Credentials** | Per-session tool operation contexts |

#### Session Lifecycle

```
┌────────────┐    ┌────────────┐    ┌──────────────┐
│  CREATING  │───>│   ACTIVE   │───>│  TERMINATED  │
└────────────┘    └──────┬─────┘    └──────────────┘
                         │                   ^
                         v                   │
                  ┌────────────┐             │
                  │    IDLE    │─────────────┘
                  └────────────┘   (15min timeout
                                   or 8hr max)
```

**States:**
- **Active** -- Processing requests, executing commands, or running background tasks
- **Idle** -- Waiting for next invocation; context preserved; no charges for idle CPU
- **Terminated** -- MicroVM destroyed; memory sanitized; all session data removed

#### Key Characteristics

- Sessions last up to **8 hours** (configurable, default idle timeout 15 minutes)
- Context preserved across multiple `InvokeAgentRuntime` calls within same session
- Both `InvokeAgentRuntime` (reasoning) and `InvokeAgentRuntimeCommand` (shell) share the same session environment
- After termination, same `runtimeSessionId` creates a **new** environment
- Session data is **ephemeral** -- use AgentCore Memory for persistence

#### Why This Matters for Multi-Tenancy

1. **Complete execution environment separation** -- One user's agent cannot access another user's data
2. **Stateful reasoning processes** -- Complex contextual state preserved securely within sessions
3. **Privileged tool operations** -- Tool credentials and permissions scoped to individual sessions
4. **Deterministic security for non-deterministic processes** -- Consistent isolation boundaries despite probabilistic LLM behavior

> **Important:** AgentCore does NOT enforce session-to-user mappings. Your client backend must maintain the relationship between users and their session IDs, and implement lifecycle management (e.g., max sessions per user).

### 3.2 Session Usage Pattern

```python
import json
import uuid

# Generate a unique session ID per user conversation
session_id = f"tenant-{tenant_id}-user-{user_id}-{uuid.uuid4()}"

# First message
response1 = agentcore_client.invoke_agent_runtime(
    agentRuntimeArn=agent_arn,
    runtimeSessionId=session_id,
    payload=json.dumps({"prompt": "What's my order status?"}).encode()
)

# Follow-up in same session -- context preserved
response2 = agentcore_client.invoke_agent_runtime(
    agentRuntimeArn=agent_arn,
    runtimeSessionId=session_id,
    payload=json.dumps({"prompt": "Can I return the blue one?"}).encode()
)
```

### 3.3 Data Isolation Layers

Multi-tenant agent data isolation operates at multiple layers:

```
┌─────────────────────────────────────────┐
│ Layer 1: Network Isolation              │
│ VPC, PrivateLink, Security Groups       │
├─────────────────────────────────────────┤
│ Layer 2: Compute Isolation              │
│ MicroVM per session (AgentCore Runtime) │
├─────────────────────────────────────────┤
│ Layer 3: Identity Isolation             │
│ JWT claims, IAM policies, ABAC          │
├─────────────────────────────────────────┤
│ Layer 4: Data Isolation                 │
│ Per-tenant tables, row-level filtering, │
│ metadata filtering on vector stores     │
├─────────────────────────────────────────┤
│ Layer 5: Memory Isolation               │
│ AgentCore Memory with tenant namespaces │
├─────────────────────────────────────────┤
│ Layer 6: Tool Isolation                 │
│ Gateway interceptors, scoped credentials│
└─────────────────────────────────────────┘
```

**Source:** [Use isolated sessions for agents -- Amazon Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)

---

## 4. Tenant Context Propagation

### 4.1 The JWT-Based Tenant Context Model

The standard pattern for propagating tenant context through agentic systems uses JWT tokens:

```
┌─────────┐    ┌───────────┐    ┌──────────────┐    ┌─────────────┐
│  User   │───>│    IdP    │───>│ Client App   │───>│  AgentCore  │
│         │    │ (Cognito) │    │ (JWT bearer) │    │  Runtime    │
└─────────┘    └───────────┘    └──────────────┘    └──────┬──────┘
                                                           │
                                    JWT contains:          │
                                    - sub (user_id)        v
                                    - custom:tenantId  ┌──────────┐
                                    - scopes           │  Agent   │
                                    - tier             │  Logic   │
                                                       └──────────┘
```

#### Critical Security Rule

> **Never pass tenant context through LLM reasoning.** FMs are susceptible to prompt injection and cannot be trusted to preserve tenant context integrity. Tenant context must flow through deterministic components only.

### 4.2 Single-Provider vs. Multi-Provider Systems

**Single Provider (all agents owned by one entity):**
- Standard JWT propagation through internal agents
- Full control over identity and authorization schemes
- Simpler to implement

**Multi-Provider (agents from different entities):**
- Each agent has independent authentication and authorization
- Requires distributed identity resolution
- Agents must independently resolve users to tenants
- Need universal mechanism to share tenant context across agent boundaries

```
┌─────────────────────────────────────────────────────┐
│                Multi-Provider Agent System           │
│                                                     │
│  [Agent A]──JWT──>[Agent B]──JWT──>[Agent C]        │
│  Provider 1       Provider 2       Provider 3       │
│                                                     │
│  Each agent:                                        │
│  1. Validates JWT independently                     │
│  2. Resolves tenant from claims                     │
│  3. Applies own isolation policies                  │
│  4. Forwards scoped context to next agent           │
└─────────────────────────────────────────────────────┘
```

### 4.3 Session Attributes for Tenant Context

In the pooled model, tenant context is passed via `sessionAttributes` on the agent's `sessionState`:

```python
# Lambda function extracts tenant context from JWT
tenant_id = event["detail"]["identity"]["claims"]["custom:tenantId"]
user_id = event["detail"]["identity"]["claims"]["sub"]

# Generate tenant-scoped credentials via STS
scoped_credentials = sts_client.assume_role(
    RoleArn=tenant_scoped_role_arn,
    RoleSessionName=f"tenant-{tenant_id}",
    Tags=[{"Key": "TenantId", "Value": tenant_id}]
)

# Pass to agent via session attributes
response = bedrock_client.invoke_agent(
    agentId=agent_id,
    agentAliasId=alias_id,
    sessionId=session_id,
    sessionState={
        "sessionAttributes": {
            "tenantId": tenant_id,
            "userId": user_id,
            "tier": "premium"
        }
    },
    inputText=user_prompt
)
```

The agent's action group Lambda functions receive these session attributes and use them to apply tenant-scoped data access:

```python
def lambda_handler(event, context):
    session_attrs = event["sessionAttributes"]
    tenant_id = session_attrs["tenantId"]

    # Use tenant-scoped credentials for DynamoDB access
    # IAM policy restricts to tenant's partition key
    response = dynamodb.query(
        TableName="orders",
        KeyConditionExpression="tenantId = :tid",
        ExpressionAttributeValues={":tid": {"S": tenant_id}}
    )
    return response["Items"]
```

**Source:** [Implementing tenant isolation using Agents for Amazon Bedrock in a multi-tenant environment](https://aws.amazon.com/blogs/machine-learning/implementing-tenant-isolation-using-agents-for-amazon-bedrock-in-a-multi-tenant-environment/)

---

## 5. Security Boundaries and Access Control

### 5.1 AgentCore Identity -- Inbound Authentication

AgentCore Runtime integrates with identity providers for inbound authentication:

| Method | Description | Use Case |
|--------|-------------|----------|
| **AWS IAM (SigV4)** | Standard AWS credential-based authentication | Internal AWS services, backend-to-agent calls |
| **OAuth 2.0** | Bearer token from external IdP | End-user authentication via Cognito, Okta, Entra ID |

**OAuth Configuration:**
- **Discovery URL** -- OpenID Connect discovery endpoint of your IdP
- **Allowed Audiences** -- Valid audience values for token validation
- **Allowed Clients** -- Client identifiers authorized to access the agent

**Authentication Flow:**
1. User authenticates with IdP (Cognito, Okta, Entra ID)
2. Client receives bearer token
3. Token passed in Authorization header when invoking agent
4. AgentCore Runtime validates token with authorization server
5. Valid = processed; Invalid = rejected

### 5.2 AgentCore Identity -- Outbound Authentication

Agents accessing external tools and services use AgentCore Identity for outbound auth:

| Mode | Description |
|------|-------------|
| **User-delegated** | Agent acts on behalf of the end user with their credentials |
| **Autonomous** | Agent acts independently with service-level credentials |

```python
from bedrock_agentcore.identity import requires_access_token

@requires_access_token(provider="google", scopes=["calendar.read"])
def list_calendar_events(access_token):
    # AgentCore Identity automatically obtains scoped token
    # Agent can now access user's Google Calendar
    pass
```

### 5.3 Gateway Interceptors for Fine-Grained Access Control

AgentCore Gateway interceptors provide the primary mechanism for implementing tenant-level tool access control:

```
┌──────────┐    ┌─────────────────┐    ┌────────────┐    ┌─────────────────┐    ┌──────────┐
│  Agent   │───>│ Request         │───>│   Target   │───>│ Response        │───>│  Agent   │
│          │    │ Interceptor     │    │   Tool     │    │ Interceptor     │    │          │
└──────────┘    │ (Lambda)        │    │            │    │ (Lambda)        │    └──────────┘
                │                 │    └────────────┘    │                 │
                │ - Auth check    │                      │ - Tool filter   │
                │ - Tenant scope  │                      │ - Data redact   │
                │ - PII redaction │                      │ - Schema xlate  │
                │ - Header inject │                      │ - Audit log     │
                └─────────────────┘                      └─────────────────┘
```

#### Request Interceptor Capabilities

- Extract JWT claims and validate tenant/user identity
- Generate scoped credentials for downstream tool access
- Inject tenant-specific headers
- Redact PII from prompts before they reach tools
- Apply schema translation between MCP and downstream APIs

#### Response Interceptor Capabilities

- Filter tool lists based on tenant permissions and scopes
- Redact sensitive data from tool responses
- Log audit trails
- Apply schema translation on responses

#### Act-on-Behalf Pattern (Recommended)

AWS explicitly recommends the **act-on-behalf** pattern over direct token impersonation:

```
Impersonation (NOT recommended):
User Token (full scopes) ──> Agent ──> Order Tool (full scopes)
                                   ──> Promo Tool (full scopes)

Act-on-Behalf (RECOMMENDED):
User Token ──> Agent ──> Order Tool (order:read only)
                     ──> Promo Tool (promo:write only)
                     Each hop gets minimally-scoped credentials
```

**Benefits:**
- Principle of least privilege at every hop
- Reduced blast radius from compromised tokens
- Clear audit trail via AgentCore Observability
- Prevents confused deputy attacks

### 5.4 IAM-Based Tenant Isolation

For pooled resources, runtime IAM policy scoping is the primary isolation mechanism:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:*:*:table/orders",
      "Condition": {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["${aws:PrincipalTag/TenantId}"]
        }
      }
    }
  ]
}
```

This policy ensures DynamoDB queries are restricted to rows where the partition key matches the requesting tenant's ID, enforced at the IAM level (not application code).

### 5.5 AgentCore Policy (Cedar-Based)

AgentCore Policy provides real-time enforcement of agent action boundaries using Cedar policy language:

```cedar
// Allow premium tenants to use all tools
permit(
    principal in Group::"premium-tenants",
    action == Action::"invoke-tool",
    resource
);

// Restrict basic tenants to read-only tools
permit(
    principal in Group::"basic-tenants",
    action == Action::"invoke-tool",
    resource in ResourceGroup::"read-only-tools"
);

// Deny all tenants from accessing admin tools
forbid(
    principal,
    action == Action::"invoke-tool",
    resource in ResourceGroup::"admin-tools"
);
```

Policy supports natural language authoring -- describe your policy in plain English and it generates Cedar statements.

**Source:** [Apply fine-grained access control with Bedrock AgentCore Gateway interceptors](https://aws.amazon.com/blogs/machine-learning/apply-fine-grained-access-control-with-bedrock-agentcore-gateway-interceptors/)

---

## 6. Scaling Strategies

### 6.1 AgentCore Runtime Auto-Scaling

AgentCore Runtime is serverless and handles scaling automatically:

```
Low Load:    [MicroVM] [MicroVM]
             2 concurrent sessions

Peak Load:   [MicroVM] [MicroVM] [MicroVM] [MicroVM] [MicroVM] ...
             Scales to thousands of concurrent sessions in seconds

Off-Peak:    [MicroVM]
             Scales down; pay only for active consumption
```

**Key scaling characteristics:**
- **Horizontal** -- Each new session gets its own microVM; thousands in seconds
- **Consumption-based** -- No pre-allocation; charges only for active CPU and peak memory per second
- **Zero management** -- No capacity planning, auto-scaling groups, or scaling policies needed
- **I/O wait is free** -- 30-70% of agent time is I/O wait (LLM responses, API calls); no charges during idle CPU

### 6.2 Multi-Tenant Scaling Considerations

| Concern | Pooled Model | Silo Model |
|---------|-------------|------------|
| **Cold starts** | Shared agent binary cached; fast startup | Per-tenant container; potentially slower |
| **Burst capacity** | All tenants share scaling pool | Each tenant's pool scales independently |
| **Resource contention** | Noisy neighbor risk at tool/API layer | No cross-tenant contention |
| **Cost efficiency** | High (shared infrastructure) | Lower (dedicated per tenant) |
| **Scaling limits** | AgentCore service quotas shared | Per-tenant quota allocation |

### 6.3 Scaling Tool Access via Gateway

AgentCore Gateway scales tool access independently of agent compute:

- **API Invocations** -- $0.005 per 1,000 invocations (ListTools, InvokeTool, Ping)
- **Search API** -- $0.025 per 1,000 semantic search queries
- **Tool Indexing** -- $0.02 per 100 tools indexed per month
- Handles thousands of concurrent tool invocations across tenants
- Lambda-backed interceptors scale independently

### 6.4 Memory Scaling

AgentCore Memory scales independently:

- **Short-term memory** -- Per-event pricing ($0.25/1,000 events); scales with session volume
- **Long-term memory** -- Per-record storage ($0.75/1,000 records/month with built-in strategies)
- **Retrieval** -- Per-query pricing ($0.50/1,000 retrievals)
- Tenant-namespaced memory prevents cross-tenant leakage at scale

---

## 7. Deployment Patterns

### 7.1 AgentCore Runtime Versioning

AgentCore implements automatic immutable versioning for safe deployments:

```
V1 (Initial) ──> V2 (Protocol change) ──> V3 (Image update) ──> V4 (Network config)
     │                    │                       │                      │
  DEFAULT ──────────> DEFAULT ──────────────> DEFAULT ──────────────> DEFAULT
                         │
                      PROD ────────────────> PROD (manually updated)
```

| Event | Version | DEFAULT Endpoint | PROD Endpoint |
|-------|---------|-----------------|---------------|
| Initial creation | V1 auto-created | Points to V1 | -- |
| Protocol change | V2 auto-created | Auto-updates to V2 | -- |
| Create PROD endpoint | No new version | Points to V2 | Points to V2 |
| Container image update | V3 auto-created | Auto-updates to V3 | Stays on V2 |
| Update PROD to V3 | No new version | Points to V3 | Manually updated to V3 |

**Key properties:**
- Versions are **immutable** once created
- `DEFAULT` endpoint auto-updates to latest version
- Custom endpoints (prod, staging) require **explicit** updates
- Endpoints can be updated **without downtime**
- Full rollback capability by pointing endpoint to previous version

### 7.2 Blue-Green Deployment

```
Phase 1: Both versions active
┌──────────────────────────────────────┐
│  blue-endpoint ──> V1 (current)      │  100% traffic
│  green-endpoint ──> V2 (new)         │  0% traffic (testing)
└──────────────────────────────────────┘

Phase 2: Switch traffic
┌──────────────────────────────────────┐
│  blue-endpoint ──> V1 (standby)      │  0% traffic
│  green-endpoint ──> V2 (active)      │  100% traffic
└──────────────────────────────────────┘

Rollback: Revert endpoint
┌──────────────────────────────────────┐
│  blue-endpoint ──> V1 (restored)     │  100% traffic
│  green-endpoint ──> V2 (disabled)    │  0% traffic
└──────────────────────────────────────┘
```

**Implementation with AgentCore:**

```python
import boto3

client = boto3.client('bedrock-agentcore', region_name='us-west-2')

# Create green endpoint pointing to new version
client.create_agent_runtime_endpoint(
    agentRuntimeId='agent-runtime-12345',
    endpointName='green-endpoint',
    agentRuntimeVersion='v2',
    description='New version for testing'
)

# Test green endpoint thoroughly...

# Switch production to green
client.update_agent_runtime_endpoint(
    agentRuntimeId='agent-runtime-12345',
    endpointName='production',
    agentRuntimeVersion='v2',
    description='Promoted from green'
)

# Rollback if needed
client.update_agent_runtime_endpoint(
    agentRuntimeId='agent-runtime-12345',
    endpointName='production',
    agentRuntimeVersion='v1',
    description='Rolled back to v1'
)
```

### 7.3 Canary Deployment

Using agent aliases with routing configuration to gradually shift traffic:

```python
# Route 10% of traffic to new version (canary)
update_params = {
    'routingConfiguration': [
        {'agentVersion': '1', 'weight': 0.9},   # 90% existing
        {'agentVersion': '2', 'weight': 0.1}    # 10% canary
    ]
}

# Monitor metrics...if healthy, increase canary weight

# Route 50/50
update_params = {
    'routingConfiguration': [
        {'agentVersion': '1', 'weight': 0.5},
        {'agentVersion': '2', 'weight': 0.5}
    ]
}

# Full rollout
update_params = {
    'routingConfiguration': [
        {'agentVersion': '2', 'weight': 1.0}
    ]
}
```

### 7.4 CI/CD Pipeline for AgentCore

The recommended CI/CD approach uses GitHub Actions with OIDC authentication:

```
┌──────────┐    ┌──────────────┐    ┌────────────┐    ┌───────────────┐    ┌─────────────┐
│ Developer│───>│ GitHub Repo  │───>│ GitHub     │───>│ Amazon ECR    │───>│ AgentCore   │
│ Commit   │    │              │    │ Actions    │    │ (Container)   │    │ Runtime     │
└──────────┘    └──────────────┘    └──────┬─────┘    └───────┬───────┘    └─────────────┘
                                           │                  │
                                    OIDC Auth to AWS    Inspector Scan
                                    (no stored creds)   (vulnerability check)
```

**Pipeline stages:**
1. **Code push** -- Developer commits agent code
2. **Build** -- GitHub Actions builds container image
3. **Security scan** -- Amazon Inspector scans for vulnerabilities
4. **Push** -- Image pushed to ECR
5. **Deploy** -- AgentCore Runtime created/updated with new image
6. **Test** -- Automated verification of agent endpoint
7. **Promote** -- Update production endpoint to new version

**Repository structure:**
```
bedrock-agentcore-runtime-cicd/
+-- .github/workflows/
|   +-- deploy-agentcore.yml      # Build and deploy pipeline
|   +-- test-agent.yml            # Post-deployment test workflow
+-- agents/
|   +-- strands_agent.py          # Agent code (Strands framework)
|   +-- requirements.txt
+-- scripts/
|   +-- create_iam_role.py        # IAM setup
|   +-- deploy_agent.py           # Deployment script
|   +-- setup_oidc.py             # OIDC configuration
|   +-- create_guardrail.py       # Content filtering
|   +-- test_agent.py             # Test cases
+-- Dockerfile
```

### 7.5 Direct Code vs. Container Deployment

AgentCore Runtime supports two deployment modes:

| Feature | Direct Code | Container-Based |
|---------|------------|-----------------|
| **Artifact** | ZIP package in S3 | Docker image in ECR |
| **Size limit** | 250 MB | 2 GB |
| **Languages** | Python 3.10-3.13 | Any language/runtime |
| **Customization** | Dependencies via ZIP | Full Dockerfile control |
| **Iteration speed** | Faster (no container build) | Slower (build + push) |
| **Storage cost** | S3 Standard rates | ECR charges |

**Source:** [Deploy AI agents on Amazon Bedrock AgentCore using GitHub Actions](https://aws.amazon.com/blogs/machine-learning/deploy-ai-agents-on-amazon-bedrock-agentcore-using-github-actions/)

---

## 8. Cost Management and Attribution

### 8.1 AgentCore Pricing Model

AgentCore uses consumption-based pricing across all services:

| Service | Pricing Model | Key Metric |
|---------|--------------|------------|
| **Runtime** | Active consumption | CPU: $0.0895/vCPU-hr, Memory: $0.00945/GB-hr |
| **Gateway** | Per-invocation | $0.005/1,000 MCP operations |
| **Policy** | Per-authorization | $0.000025/authorization request |
| **Identity** | Per-token request | $0.010/1,000 tokens (free through Runtime/Gateway) |
| **Memory** | Per-event/record | Short: $0.25/1K events; Long: $0.75/1K records/mo |
| **Observability** | CloudWatch pricing | Per spans/logs/metrics ingested |
| **Evaluations** | Per-token/eval | Built-in: $0.0024/1K input tokens |

**Critical cost advantage:** I/O wait is free. Since agents spend 30-70% of time waiting for LLM responses and API calls, you only pay for active CPU consumption -- not idle time.

### 8.2 Per-Tenant Cost Attribution

The key pattern for per-tenant cost tracking uses DynamoDB-based trace capture:

```python
# In AgentCore Runtime session, capture all traces per tenant
class TenantCostTracker:
    def __init__(self, tenant_id, user_id, tier):
        self.tenant_id = tenant_id
        self.user_id = user_id
        self.tier = tier

    def log_invocation(self, model_id, input_tokens, output_tokens,
                       latency_ms, tools_used):
        dynamodb.put_item(
            TableName="agent-cost-attribution",
            Item={
                "tenantId": {"S": self.tenant_id},
                "timestamp": {"S": datetime.utcnow().isoformat()},
                "userId": {"S": self.user_id},
                "tier": {"S": self.tier},
                "modelId": {"S": model_id},
                "inputTokens": {"N": str(input_tokens)},
                "outputTokens": {"N": str(output_tokens)},
                "latencyMs": {"N": str(latency_ms)},
                "toolsUsed": {"SS": tools_used}
            }
        )
```

### 8.3 CloudWatch Logs Insights for Cost Analysis

Use CloudWatch Logs Insights queries against AgentCore Observability data for per-tenant cost analysis:

```sql
-- Per-tenant token usage over last 24 hours
fields @timestamp, tenant_id, model_id, input_tokens, output_tokens
| filter @timestamp > ago(24h)
| stats sum(input_tokens) as total_input,
        sum(output_tokens) as total_output,
        count(*) as invocations
  by tenant_id, model_id
| sort total_output desc
```

```sql
-- Noisy neighbor detection: tenants exceeding fair share
fields tenant_id, input_tokens, output_tokens
| stats sum(input_tokens + output_tokens) as total_tokens by tenant_id
| sort total_tokens desc
| limit 10
```

### 8.4 Cost Model Comparison

| Model | Per-Tenant Cost | Attribution Complexity | Efficiency |
|-------|----------------|----------------------|------------|
| **Silo** | Direct (dedicated resources) | Simple -- all costs are tenant's | Low (idle resources) |
| **Pool** | Requires telemetry tracking | Complex -- must parse traces | High (shared resources) |
| **Hybrid** | Mixed | Medium | Medium-High |

The pooled model requires granular telemetry (token counts, CPU seconds, memory peak, tool invocations) per tenant to enable accurate billing. The `sample-multi-tenant-agent-core-app` repo demonstrates this with DynamoDB-based trace capture that records every interaction with tenant attribution.

**Source:** [Amazon Bedrock AgentCore Pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)

---

## 9. Control Planes for Agentic Environments

### 9.1 Control Plane vs. Application Plane

Following SaaS best practices, multi-tenant agent systems should separate:

```
┌──────────────────────────────────────────────┐
│              CONTROL PLANE                    │
│                                               │
│  ┌─────────────┐  ┌──────────────────┐       │
│  │ Tenant      │  │ Agent Lifecycle   │       │
│  │ Onboarding  │  │ Management        │       │
│  └─────────────┘  └──────────────────┘       │
│  ┌─────────────┐  ┌──────────────────┐       │
│  │ Tenant      │  │ Billing &        │       │
│  │ Policies    │  │ Metering         │       │
│  └─────────────┘  └──────────────────┘       │
│  ┌─────────────┐  ┌──────────────────┐       │
│  │ Observability│  │ Configuration   │       │
│  │ Dashboard   │  │ Management       │       │
│  └─────────────┘  └──────────────────┘       │
├──────────────────────────────────────────────┤
│            APPLICATION PLANE                  │
│                                               │
│  ┌─────────────────────────────────────┐     │
│  │  AgentCore Runtime (Agents)         │     │
│  │  AgentCore Memory                   │     │
│  │  AgentCore Gateway (Tools)          │     │
│  │  Business Logic                     │     │
│  └─────────────────────────────────────┘     │
└──────────────────────────────────────────────┘
```

### 9.2 Control Plane Responsibilities

| Function | Description |
|----------|-------------|
| **Tenant Onboarding** | Create tenant identity, configure tier, provision per-tenant resources, set up agent-to-agent auth |
| **Agent Configuration** | Deploy/update agent versions, manage endpoints, configure routing between silo/pool |
| **Tenant Policies** | Tiering rules, rate limits, feature flags, guardrail configs |
| **Billing & Metering** | Collect consumption data, attribute costs to tenants, enforce usage limits |
| **Observability** | Cross-tenant health monitoring, per-tenant usage dashboards, alerting |
| **Lifecycle Management** | Agent version management, rollout orchestration, rollback capability |

### 9.3 Multi-Provider Control Planes

When a multi-agent system spans multiple providers, each provider maintains its own control plane:

```
┌─────────────────────────────────────────────┐
│  Provider A Control Plane                    │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │ Agent 1 │  │ Agent 2 │  │ Agent 3 │    │
│  └─────────┘  └─────────┘  └─────────┘    │
├─────────────────────────────────────────────┤
│  Provider B Control Plane                    │
│  ┌─────────┐  ┌─────────┐                  │
│  │ Agent 4 │  │ Agent 5 │                  │
│  └─────────┘  └─────────┘                  │
└─────────────────────────────────────────────┘
```

Each provider's control plane independently manages:
- Agent deployment and versioning
- Tenant provisioning and configuration
- Observability and cost tracking
- Cross-agent authentication (A2A protocol)

### 9.4 Onboarding Flow

```
1. Create tenant identity (Cognito user pool group / custom claims)
2. Assign tier (Basic/Advanced/Premium)
3. Provision per-tenant resources:
   - Silo: Deploy dedicated AgentCore Runtime + endpoint
   - Pool: Add tenant to shared routing table
   - Hybrid: Mix of above
4. Configure agent memory namespace
5. Set up tool access (Gateway interceptor rules)
6. Configure guardrails and policies
7. Set rate limits and usage quotas
8. If multi-agent: Configure A2A authentication
9. Activate tenant
```

**Source:** [AWS Prescriptive Guidance -- Employing control planes in agentic environments](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-multitenant/employing-control-planes-in-agentic-environments.html)

---

## 10. Noisy Neighbor Protection

### 10.1 Throttling Points

In a multi-tenant AaaS environment, noisy neighbor policies should be applied at multiple layers:

```
┌─────────────────────────────────────────────────┐
│  1. Agent Entry Point (Outer Edge)               │
│     - Global rate limits                         │
│     - Per-tenant rate limits                     │
│     - Tier-based throttling                      │
├─────────────────────────────────────────────────┤
│  2. LLM Access Layer                             │
│     - Per-tenant token budgets                   │
│     - Model-level throttling                     │
│     - Token rate limiting                        │
├─────────────────────────────────────────────────┤
│  3. Tool/API Layer                               │
│     - Per-tenant tool invocation limits          │
│     - Gateway interceptor enforcement            │
│     - Downstream API rate limiting               │
├─────────────────────────────────────────────────┤
│  4. Memory Access Layer                          │
│     - Per-tenant memory operation limits         │
│     - Storage quotas per tenant                  │
├─────────────────────────────────────────────────┤
│  5. Data Access Layer                            │
│     - Query throttling per tenant                │
│     - Read/write capacity per tenant             │
└─────────────────────────────────────────────────┘
```

### 10.2 Tier-Based Throttling Strategy

| Resource | Basic Tier | Advanced Tier | Premium Tier |
|----------|-----------|---------------|-------------|
| Requests/min | 10 | 100 | Unlimited |
| Tokens/day | 50,000 | 500,000 | 5,000,000 |
| Tool calls/session | 5 | 50 | Unlimited |
| Session duration | 15 min | 1 hour | 8 hours |
| Concurrent sessions | 2 | 10 | 100 |
| Memory storage | 100 MB | 1 GB | 10 GB |
| Models available | Nova Lite | Sonnet | Opus, custom |

### 10.3 Lambda Tenant Isolation Mode

AWS Lambda's tenant isolation mode (launched 2025) provides execution environment isolation at the Lambda level:

```python
# Create function with tenant isolation
lambda_client.create_function(
    FunctionName='multi-tenant-agent-tool',
    # ... other config ...
    TenancyConfig={
        'Mode': 'TenantIsolation',
        'TenantIdParam': 'tenantId'
    }
)

# Invoke with tenant context
lambda_client.invoke(
    FunctionName='multi-tenant-agent-tool',
    Payload=json.dumps({
        "tenantId": "tenant-abc",  # Lambda routes to tenant-specific env
        "action": "get_orders"
    })
)
```

Lambda ensures:
- Each tenant's invocations run in separate execution environments
- Execution environments are reused only within the same tenant
- Warm start benefits apply per-tenant (not cross-tenant)

**Source:** [Building multi-tenant SaaS applications with AWS Lambda's new tenant isolation mode](https://aws.amazon.com/blogs/compute/building-multi-tenant-saas-applications-with-aws-lambdas-new-tenant-isolation-mode/)

---

## 11. Observability in Multi-Tenant Agent Systems

### 11.1 AgentCore Observability

AgentCore Observability provides built-in monitoring through CloudWatch:

- **End-to-end agent execution traces** -- Full request lifecycle visibility
- **Latency metrics per component** -- LLM inference, tool calls, memory operations
- **Token usage tracking** -- Input/output tokens per model per invocation
- **Error rates and patterns** -- Failure categorization and trending
- **Custom dashboards** -- Tenant-specific and aggregate views

### 11.2 Multi-Tenant Observability Requirements

| Dimension | Single-Tenant | Multi-Tenant Addition |
|-----------|--------------|----------------------|
| Traces | Per-agent traces | Per-tenant trace filtering |
| Metrics | Aggregate latency/throughput | Per-tenant SLO tracking |
| Logs | Agent execution logs | Tenant-tagged log groups |
| Alerts | System-wide alerts | Per-tenant threshold alerts |
| Dashboards | Single view | Tenant drill-down + aggregate |
| Cost | Single bill | Per-tenant cost attribution |

### 11.3 Tenant-Aware Metrics

Key metrics to track per tenant:

```
Agent Metrics:
- agent.invocations.count{tenant_id=X}
- agent.latency.p99{tenant_id=X}
- agent.errors.count{tenant_id=X}
- agent.tokens.input{tenant_id=X, model_id=Y}
- agent.tokens.output{tenant_id=X, model_id=Y}

Tool Metrics:
- tool.invocations.count{tenant_id=X, tool_name=Y}
- tool.latency.p99{tenant_id=X, tool_name=Y}
- tool.errors.count{tenant_id=X, tool_name=Y}

Memory Metrics:
- memory.events.count{tenant_id=X}
- memory.retrievals.count{tenant_id=X}
- memory.storage.bytes{tenant_id=X}

Session Metrics:
- session.active.count{tenant_id=X}
- session.duration.avg{tenant_id=X}
- session.concurrent.max{tenant_id=X}
```

---

## 12. Reference Implementations

### 12.1 aws-samples/sample-agentcore-multi-tenant

**URL:** [github.com/aws-samples/sample-agentcore-multi-tenant](https://github.com/aws-samples/sample-agentcore-multi-tenant)

A comprehensive TypeScript implementation demonstrating multi-tenant log analytics with AgentCore:

**Architecture:**
- Multi-tenant architecture with JWT-based tenant isolation
- Dual tool sources: MCP server tools + Gateway-based Lambda functions
- Cognito authentication with fine-grained access control
- OpenSearch for multi-tenant log storage (query filters per tenant)
- CDK infrastructure (9 stacks)

**Technology stack:**
- AgentCore Runtime + Amazon Bedrock (Nova 2 Lite)
- Amazon OpenSearch Service
- Amazon Cognito
- TypeScript 5.3+, Node.js 20+

**Key patterns demonstrated:**
- JWT claims for tenant isolation at OpenSearch query level
- Session attributes for tenant context propagation
- Per-tenant log filtering without cross-tenant data leakage

### 12.2 aws-samples/sample-multi-tenant-agent-core-app

**URL:** [github.com/aws-samples/sample-multi-tenant-agent-core-app](https://github.com/aws-samples/sample-multi-tenant-agent-core-app)

Demonstrates granular cost attribution in a multi-tenant chat application:

**Key innovation:** Uses session attributes to pass tenant_id at runtime, enabling:
1. **Multi-tenant isolation** -- Complete data separation while sharing AgentCore Runtime
2. **Granular cost attribution** -- DynamoDB-based trace capture with full tenant context
3. **Subscription-based access control** -- Tier controls models, tools, and limits

**Architecture:**
- Cognito JWT authentication
- DynamoDB for session storage and cost tracking
- Terraform infrastructure
- Python agents with Strands framework

### 12.3 Implementing Tenant Isolation (Blog Post Reference)

**URL:** [aws.amazon.com/blogs/machine-learning/implementing-tenant-isolation-using-agents-for-amazon-bedrock-in-a-multi-tenant-environment/](https://aws.amazon.com/blogs/machine-learning/implementing-tenant-isolation-using-agents-for-amazon-bedrock-in-a-multi-tenant-environment/)

E-commerce sample with pooled Bedrock Agents and tenant+user isolation:

- AppSync + EventBridge + Lambda for async agent invocation
- Cognito JWT with `custom:tenantId` claims
- STS-scoped credentials per tenant for DynamoDB access
- Separation of tenant-level data (return policies) and user-level data (orders)
- Critical pattern: `answerId` prefixed with `userId` for subscription-level isolation

### 12.4 re:Invent 2025 SaaS Track Sessions

| Session | Title | Focus |
|---------|-------|-------|
| **SAS407** | Building Multi-Tenant SaaS Agents with Amazon Bedrock AgentCore | Identity, memory, gateway, observability, runtime for multi-tenant agents |
| **SAS409** | Agentic Tenant Isolation: Securing Multi-Tenant Agent Resources | Tenant context enforcement across MCP servers, memory, data, tools, models |
| **SAS410** | Inside a Multi-Tenant Architecture Built with Amazon Bedrock AgentCore | Real multi-tenant patterns with AgentCore components |
| **SAS403** | Hands-On Multi-Tenant Agents: Inside Tenant-Aware Agentic Systems | Practical integration with RAG, MCP servers, isolation, cost metrics |
| **SAS304** | Transforming from SaaS to Multi-Tenant Agentic SaaS | Migration patterns from traditional SaaS to agent-based |

---

## 13. Key Takeaways and Decision Framework

### 13.1 When to Use Each Pattern

```
START
  │
  ├── Need strict compliance/data sovereignty?
  │   YES ──> SILO MODEL
  │
  ├── Serving > 100 tenants, cost-sensitive?
  │   YES ──> POOL MODEL with IAM-based isolation
  │
  ├── Mix of enterprise + SMB tenants?
  │   YES ──> HYBRID MODEL (Premium=silo, Basic=pool)
  │
  ├── Single-provider, full control?
  │   YES ──> JWT propagation through system
  │
  └── Multi-provider agent system?
      YES ──> Distributed identity + A2A protocol + per-agent auth
```

### 13.2 Essential Checklist for Multi-Tenant Agent Deployment

- [ ] **Identity:** Configure IdP integration (Cognito/Okta/Entra ID) with tenant claims in JWT
- [ ] **Session isolation:** Use unique `runtimeSessionId` per user per conversation
- [ ] **Tenant context:** Pass tenant_id through deterministic components only (never through LLM)
- [ ] **Data isolation:** Implement IAM-scoped credentials or row-level security per tenant
- [ ] **Tool isolation:** Configure Gateway interceptors for per-tenant tool filtering
- [ ] **Memory isolation:** Namespace AgentCore Memory by tenant
- [ ] **Noisy neighbor:** Set tier-based rate limits at agent entry points
- [ ] **Cost tracking:** Capture per-tenant token usage and tool invocations in DynamoDB
- [ ] **Deployment:** Use versioned endpoints with blue-green or canary rollout
- [ ] **CI/CD:** Automate with GitHub Actions + OIDC + Inspector scanning
- [ ] **Observability:** Tag all telemetry with tenant_id for per-tenant dashboards
- [ ] **Control plane:** Build centralized management for onboarding, policies, and billing
- [ ] **Policy:** Define Cedar policies for tier-based tool access control
- [ ] **Testing:** Test tenant isolation with cross-tenant access attempts

### 13.3 Architecture Comparison Summary

| Dimension | Silo | Pool | Hybrid |
|-----------|------|------|--------|
| **Isolation** | Hardware-level | Runtime policy | Mixed |
| **Cost** | High | Low | Medium |
| **Scaling** | Per-tenant | Shared pool | Mixed |
| **Noisy neighbor** | None | Risk (mitigated by throttling) | Limited |
| **Compliance** | Easiest | Hardest | Moderate |
| **Onboarding** | Complex (new infra) | Simple (add to pool) | Moderate |
| **Operations** | Per-tenant management | Centralized | Mixed |
| **Cost attribution** | Trivial | Complex (telemetry) | Mixed |

---

## Sources and Further Reading

### AWS Official Documentation
- [Building multi-tenant architectures for agentic AI on AWS (Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-multitenant/introduction.html)
- [Use isolated sessions for agents -- AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)
- [How it works -- AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html)
- [AgentCore Runtime versioning and endpoints](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agent-runtime-versioning.html)
- [Amazon Bedrock AgentCore Pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)
- [SaaS Tenant Isolation Strategies (Whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/saas-tenant-isolation-strategies.html)
- [SaaS Architecture Fundamentals -- Tenant Isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html)

### AWS Blog Posts
- [Implementing tenant isolation using Agents for Bedrock in multi-tenant environments](https://aws.amazon.com/blogs/machine-learning/implementing-tenant-isolation-using-agents-for-amazon-bedrock-in-a-multi-tenant-environment/)
- [Apply fine-grained access control with Bedrock AgentCore Gateway interceptors](https://aws.amazon.com/blogs/machine-learning/apply-fine-grained-access-control-with-bedrock-agentcore-gateway-interceptors/)
- [Deploy AI agents on AgentCore using GitHub Actions](https://aws.amazon.com/blogs/machine-learning/deploy-ai-agents-on-amazon-bedrock-agentcore-using-github-actions/)
- [Securely launch and scale your agents on AgentCore Runtime](https://aws.amazon.com/blogs/machine-learning/securely-launch-and-scale-your-agents-and-tools-on-amazon-bedrock-agentcore-runtime/)
- [Move from proof of concept to production with AgentCore](https://aws.amazon.com/blogs/machine-learning/move-your-ai-agents-from-proof-of-concept-to-production-with-amazon-bedrock-agentcore/)
- [AI agents in enterprises: Best practices with AgentCore](https://aws.amazon.com/blogs/machine-learning/ai-agents-in-enterprises-best-practices-with-amazon-bedrock-agentcore/)
- [Building multi-tenant SaaS apps with Lambda's tenant isolation mode](https://aws.amazon.com/blogs/compute/building-multi-tenant-saas-applications-with-aws-lambdas-new-tenant-isolation-mode/)

### Reference Implementations
- [sample-agentcore-multi-tenant (TypeScript)](https://github.com/aws-samples/sample-agentcore-multi-tenant)
- [sample-multi-tenant-agent-core-app (Python)](https://github.com/aws-samples/sample-multi-tenant-agent-core-app)
- [sample-bedrock-agentcore-runtime-cicd (GitHub Actions CI/CD)](https://github.com/aws-samples/sample-bedrock-agentcore-runtime-cicd)

### re:Invent 2025 Sessions
- SAS407: Building Multi-Tenant SaaS Agents with Amazon Bedrock AgentCore
- SAS409: Agentic Tenant Isolation: Securing Multi-Tenant Agent Resources
- SAS410: Inside a Multi-Tenant Architecture Built with Amazon Bedrock AgentCore
- SAS403: Hands-On Multi-Tenant Agents: Inside Tenant-Aware Agentic Systems
- SAS304: Transforming from SaaS to Multi-Tenant Agentic SaaS

### Strands Agents Deployment
- [Deploying Strands Agents to AgentCore Runtime](https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/)
- [Operating Agents in Production](https://strandsagents.com/docs/user-guide/deploy/operating-agents-in-production/)
