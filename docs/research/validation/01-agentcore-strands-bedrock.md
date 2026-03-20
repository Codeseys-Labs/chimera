---
title: "Chimera Platform Architecture Validation: AgentCore, Strands, and Bedrock Capabilities"
date: 2026-03-19
status: complete
tags: [validation, agentcore, strands, bedrock, multi-tenant, architecture]
reviewer: val-agentcore-strands
parent_task: chimera-ec1a
---

# Chimera Platform Architecture Validation

> **Executive Summary**: Validation of Chimera's architecture against AWS Bedrock AgentCore Runtime, AgentCore Memory, AgentCore Gateway, Strands Agents, and supporting AWS services as of March 2026.

**Validation Date**: March 19, 2026
**Reviewer**: val-agentcore-strands (builder agent)
**Sources**: AWS Bedrock AgentCore documentation, Strands Agents SDK, existing architecture documents
**Scope**: Multi-tenant isolation, data layer design, deployment model, agent runtime capabilities

---

## Table of Contents

1. [[#Executive Findings]]
2. [[#AgentCore Runtime: MicroVM Isolation Model]]
3. [[#AgentCore Memory: STM + LTM Strategies]]
4. [[#AgentCore Gateway: MCP Tool Routing]]
5. [[#Strands Agents: Framework Integration]]
6. [[#Multi-Tenant Isolation: Validation]]
7. [[#Data Layer: 6-Table DynamoDB Design]]
8. [[#CDK Stack Structure: 8-Stack Approach]]
9. [[#Git-Backed Agent Workspaces: Storage Options]]
10. [[#Team Deploy Model: Multi-Account Strategy]]
11. [[#Cognito Tenant Model: Authentication]]
12. [[#Cost Model: Consumption-Based Pricing]]
13. [[#Gaps and Recommendations]]
14. [[#Implementation Priorities]]

---

## Executive Findings

### ✅ What Validates Perfectly

| Component | Chimera Design | AWS Reality | Status |
|-----------|---------------|-------------|---------|
| **MicroVM Isolation** | Per-session MicroVM isolation | AgentCore Runtime provides dedicated microVM per session | ✅ **Validated** |
| **Consumption Pricing** | Active-consumption billing | AgentCore uses consumption-based pricing (I/O wait is free) | ✅ **Validated** |
| **Framework Agnostic** | Strands Agents + extensible | AgentCore supports Strands, LangGraph, CrewAI, custom | ✅ **Validated** |
| **Memory Architecture** | STM + LTM separation | AgentCore Memory provides short-term + long-term strategies | ✅ **Validated** |
| **MCP Protocol** | AgentCore Gateway for MCP targets | AgentCore Gateway converts APIs/services to MCP-compatible tools | ✅ **Validated** |
| **Session Isolation** | Ephemeral sessions, secure state | Sessions last up to 8 hours, complete environment isolation | ✅ **Validated** |
| **Large Payloads** | Support for 100MB payloads | AgentCore Runtime processes 100MB payloads | ✅ **Validated** |

### ⚠️ What Needs Adjustment

| Component | Chimera Design | AWS Reality | Recommendation |
|-----------|---------------|-------------|----------------|
| **Memory Strategies** | Generic "STM+LTM" | 4 built-in strategies: User preferences, Semantic, Session summaries, Episodic | Use built-in strategies explicitly |
| **Identity Integration** | "AgentCore Identity" | OAuth 2.0 inbound (Cognito compatible), OAuth/API key outbound | Clarify inbound vs outbound auth |
| **Code Interpreter** | "OpenSandbox MicroVM" | AgentCore Code Interpreter (distinct service, not OpenSandbox branding) | Update terminology |
| **Browser Service** | Generic CDP | AgentCore Browser with Playwright CDP | Specify AgentCore Browser service |
| **Multi-Tenant Endpoints** | Shared vs dedicated endpoints | AgentCore supports per-tenant endpoint ARNs | Implement endpoint isolation strategy |
| **Workspace Storage** | EFS assumption | AgentCore sessions are ephemeral; persistent storage requires S3 or external | Move to S3-backed workspaces |

### 🚨 Critical Gaps

| Gap | Impact | Priority |
|-----|--------|----------|
| **No tenant endpoint isolation design** | All tenants sharing single endpoint = noisy neighbor risk | **P0** |
| **EFS for agent workspaces** | AgentCore sessions are ephemeral; EFS mount not supported | **P0** |
| **Missing AgentCore Observability integration** | No tracing/metrics strategy for per-tenant monitoring | **P1** |
| **No AgentCore Policy integration** | Missing Cedar-based policy enforcement at runtime level | **P1** |
| **Underspecified memory namespace strategy** | AgentCore Memory requires explicit namespace management | **P2** |

---

## AgentCore Runtime: MicroVM Isolation Model

### What AWS Provides

**AgentCore Runtime** is a serverless hosting environment specifically designed for AI agents. Key capabilities:

```
AgentCore Runtime Architecture:
┌─────────────────────────────────────────────────────┐
│              AgentCore Runtime Endpoint              │
│                (ARN-addressable)                     │
├─────────────────────────────────────────────────────┤
│  Session 1    │  Session 2    │  Session 3          │
│  (MicroVM)    │  (MicroVM)    │  (MicroVM)          │
│  ┌─────────┐  │  ┌─────────┐  │  ┌─────────┐       │
│  │ Strands │  │  │LangGraph│  │  │ CrewAI  │       │
│  │ Agent   │  │  │ Agent   │  │  │ Agent   │       │
│  └─────────┘  │  └─────────┘  │  └─────────┘       │
│  • Isolated   │  • Isolated   │  • Isolated         │
│  • 8hr max    │  • 8hr max    │  • 8hr max          │
│  • 100MB      │  • 100MB      │  • 100MB            │
└─────────────────────────────────────────────────────┘
         │                 │                 │
         v                 v                 v
    User Session      User Session      User Session
```

**Key Properties** (from AWS documentation):

1. **Session Isolation**: Each user session runs in a dedicated microVM with isolated resources
2. **Consumption-Based Pricing**: Pay only for active execution time (I/O wait is free)
3. **Framework Agnostic**: Supports Strands, LangGraph, CrewAI, and custom agents
4. **Protocol Support**: MCP (Model Context Protocol) and A2A (Agent-to-Agent)
5. **Long-Running**: Sessions last up to 8 hours for complex workflows
6. **Bidirectional Streaming**: Real-time interactions via WebSocket
7. **Built-in Authentication**: Integration with corporate identity providers via AgentCore Identity

### Chimera Alignment

**✅ Validates**: Chimera's MicroVM-per-session design is exactly what AgentCore provides.

**⚠️ Adjustment Needed**: Chimera assumes "dedicated AgentCore endpoint per tenant" for silo tier. AWS reality:

- **Pool Model**: All tenants share a single AgentCore Runtime endpoint
- **Silo Model**: Each tenant gets a dedicated endpoint ARN
- **Hybrid Model**: Not explicitly supported — you choose pool or silo per tenant

**Recommendation**:

```python
# Tenant routing design
TENANT_ENDPOINT_STRATEGY = {
    'basic':   'shared-endpoint',   # All basic tenants → single endpoint ARN
    'advanced': 'shared-endpoint',  # All advanced tenants → single endpoint ARN
    'premium':  'dedicated-endpoint' # Each premium tenant → unique endpoint ARN
}

# Example endpoint ARNs
SHARED_ENDPOINT = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/chimera-shared"
TENANT_A_ENDPOINT = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/tenant-acme-dedicated"
```

### Rate Limiting at Runtime Level

**Gap**: Chimera's rate limiting is at API Gateway + application layer. AgentCore Runtime itself has service quotas:

- **Concurrent sessions per endpoint**: Default 100 (adjustable via quota request)
- **Invocations per second**: Default 100 TPS per endpoint
- **Payload size**: 100MB max

**Recommendation**: Implement per-tenant endpoint provisioning for premium tier to guarantee quota isolation.

---

## AgentCore Memory: STM + LTM Strategies

### What AWS Provides

**AgentCore Memory** is a managed service with two memory types:

1. **Short-Term Memory (STM)**: Turn-by-turn interactions within a single session
2. **Long-Term Memory (LTM)**: Persistent knowledge across sessions

**Built-in LTM Strategies** (from AWS docs):

| Strategy | Purpose | Use Case |
|----------|---------|----------|
| **User Preferences** | Extract user preferences, choices, styles | Personalized recommendations |
| **Semantic** | Factual knowledge, contextual entities | Knowledge base building |
| **Session Summaries** | Condensed summaries of conversations | Quick context recall |
| **Episodic** | Structured episodes (scenario, intent, action, outcome) | Learn from prior interactions |

**Configuration Example**:

```python
from bedrock_agentcore.memory import MemoryManager, MemoryStrategy

# Create memory manager
memory_manager = MemoryManager(region="us-east-1")

# Configure long-term memory with multiple strategies
memory_resource = memory_manager.create_memory(
    memory_id="chimera-tenant-acme",
    strategies=[
        MemoryStrategy.USER_PREFERENCE,
        MemoryStrategy.SEMANTIC,
        MemoryStrategy.SUMMARY
    ],
    namespace_template="tenant-{tenant_id}-user-{user_id}"
)
```

### Chimera Alignment

**✅ Validates**: Chimera's STM + LTM separation is exactly what AgentCore provides.

**⚠️ Adjustment Needed**: Chimera documents say "AgentCore Memory (STM+LTM)" but don't specify which strategies to use.

**Recommendation**:

```python
# Per-tenant memory configuration
MEMORY_STRATEGIES_BY_TIER = {
    'basic': [
        MemoryStrategy.SUMMARY  # Session summaries only
    ],
    'advanced': [
        MemoryStrategy.SUMMARY,
        MemoryStrategy.USER_PREFERENCE  # + User preferences
    ],
    'premium': [
        MemoryStrategy.SUMMARY,
        MemoryStrategy.USER_PREFERENCE,
        MemoryStrategy.SEMANTIC,
        MemoryStrategy.EPISODIC  # Full suite
    ]
}
```

### Memory Namespace Strategy

**Critical**: AgentCore Memory requires explicit namespace management. From Strands integration docs:

```python
from bedrock_agentcore.memory.integrations.strands import AgentCoreMemorySessionManager

memory = AgentCoreMemorySessionManager(
    memory_id="chimera-memory",
    namespace=f"tenant-{tenant_id}",  # MUST be tenant-scoped
    strategies=["SUMMARY", "SEMANTIC_MEMORY", "USER_PREFERENCE"]
)
```

**Chimera Gap**: No documented namespace strategy. DynamoDB design uses `TENANT#{id}` partition keys, but memory namespaces are separate.

**Recommendation**:

```
Namespace Template: tenant-{tenant_id}-user-{user_id}

Examples:
- tenant-acme-user-alice
- tenant-beta-user-bob
- tenant-gamma-cron-scheduler  (for cron agents)
```

---

## AgentCore Gateway: MCP Tool Routing

### What AWS Provides

**AgentCore Gateway** converts APIs and services into MCP-compatible tools. Supports 5 target types:

1. **Lambda**: AWS Lambda functions
2. **MCP Servers**: Model Context Protocol servers
3. **OpenAPI**: REST APIs defined via OpenAPI specs
4. **API Gateway**: Direct integration with API Gateway endpoints
5. **Smithy**: AWS service APIs via Smithy models

**Key Capabilities**:
- Protocol translation (HTTP/REST → MCP)
- Authentication handling (API keys, OAuth, IAM)
- Request/response transformation
- Rate limiting per tool

### Chimera Alignment

**✅ Validates**: Chimera's "AgentCore Gateway MCP targets" is correct.

**⚠️ Clarification Needed**: Chimera documents mention "5 target types" but don't enumerate them. Update documentation to list:

```yaml
# Chimera skill → AgentCore Gateway target mappings
MCP_TARGET_TYPES:
  - type: lambda
    description: Invoke AWS Lambda functions as tools
    auth: IAM
  - type: mcp_server
    description: Connect to external MCP servers (OpenClaw skill format)
    auth: OAuth / API Key
  - type: openapi
    description: REST APIs defined via OpenAPI 3.0 spec
    auth: API Key / OAuth
  - type: api_gateway
    description: Direct integration with API Gateway endpoints
    auth: IAM / API Key
  - type: smithy
    description: AWS service APIs (S3, DynamoDB, etc.)
    auth: IAM
```

**Skill Registry Integration**:

Chimera's skill metadata table (`chimera-skills`) should store the Gateway target type:

```python
# DynamoDB item: TENANT#acme / SKILL#code-review
{
    "PK": "TENANT#acme",
    "SK": "SKILL#code-review",
    "skillName": "code-review",
    "version": "2.1.0",
    "mcp_server": True,
    "gateway_target": {
        "type": "mcp_server",
        "endpoint": "https://skills.chimera.example.com/code-review",
        "auth": "api_key"
    },
    "s3_path": "s3://chimera-skills/tenants/acme/code-review/v2.1.0/"
}
```

---

## Strands Agents: Framework Integration

### What AWS Provides

**Strands Agents** is an open-source SDK designed for AgentCore integration. From the documentation:

```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from bedrock_agentcore.runtime import BedrockAgentCoreApp, entrypoint
from bedrock_agentcore.memory.integrations.strands import AgentCoreMemorySessionManager

# Minimal AgentCore deployment
app = BedrockAgentCoreApp()

@entrypoint
async def handle(context):
    agent = Agent(
        model=BedrockModel("us.anthropic.claude-sonnet-4-6-v1:0"),
        system_prompt="You are a helpful assistant",
        tools=[read_file, write_file, search_web],
        session_manager=AgentCoreMemorySessionManager(
            memory_id="my-memory",
            namespace=f"user-{context.session.user_id}"
        )
    )
    return agent(context.input_text)
```

**Key Integration Points**:

1. **BedrockAgentCoreApp**: Runtime wrapper for AgentCore deployment
2. **@entrypoint**: Decorator marks the agent invocation handler
3. **AgentCoreMemorySessionManager**: Memory integration for Strands
4. **BedrockModel**: Bedrock-hosted models (Anthropic, Amazon, Meta, Mistral)

### Chimera Alignment

**✅ Validates**: Chimera's "Strands agent definitions + runtime" is exactly this pattern.

**Recommendation**: Standardize on Strands as the primary framework. Chimera's `packages/core/` should contain:

```
packages/core/
├── agents/
│   ├── base_agent.py          # Strands agent base class
│   ├── chat_agent.py           # Multi-platform chat agent
│   ├── cron_agent.py           # Scheduled task agent
│   ├── research_agent.py       # Research/retrieval agent
│   └── orchestrator_agent.py   # Multi-agent coordinator
├── models/
│   ├── tenant_model_router.py  # Per-tenant model selection
│   └── fallback_chain.py       # Model fallback logic
├── tools/
│   ├── core_tools.py           # read_file, write_file, edit_file, shell
│   ├── skill_loader.py         # Load tenant skills from S3 + Gateway
│   └── mcp_client.py           # MCP protocol client
└── deployment/
    ├── agentcore_deployer.py   # CDK construct for AgentCore deployment
    └── container_builder.py     # Docker image builder for AgentCore
```

---

## Multi-Tenant Isolation: Validation

### Chimera Design

Chimera proposes **5-layer isolation**:

| Layer | Pool | Hybrid | Silo |
|-------|------|--------|------|
| Compute | Shared AgentCore endpoint | Shared endpoint | Dedicated endpoint |
| Network | Shared VPC | Shared VPC | Dedicated VPC |
| Storage | S3 prefix isolation | S3 prefix isolation | Dedicated bucket |
| Database | DynamoDB partition key | DynamoDB partition key | Dedicated table |
| Memory | AgentCore namespace | AgentCore namespace | Dedicated memory resource |

### AWS Reality Check

**✅ Compute Isolation**: MicroVM per session is guaranteed regardless of pool/silo.

**⚠️ Endpoint Isolation**: AgentCore Runtime endpoints are separate resources. You can create:
- 1 shared endpoint for all pool tenants
- 1 dedicated endpoint per silo tenant

**Critical**: AgentCore does NOT have built-in tenant routing. You must:

1. Map tenant ID → endpoint ARN in DynamoDB
2. Route invocations to the correct endpoint
3. Pass tenant context via session attributes

**Recommended Architecture**:

```python
# Tenant router Lambda
def route_agent_invocation(tenant_id: str, user_input: str):
    # Get tenant config
    tenant = dynamodb.get_item(
        TableName='chimera-tenants',
        Key={'PK': f'TENANT#{tenant_id}', 'SK': 'PROFILE'}
    )

    # Determine endpoint
    if tenant['tier'] == 'premium':
        endpoint_arn = tenant['dedicated_endpoint_arn']
    else:
        endpoint_arn = SHARED_ENDPOINT_ARN

    # Invoke AgentCore Runtime
    response = agentcore.invoke_agent_runtime(
        agentRuntimeArn=endpoint_arn,
        runtimeSessionId=f"tenant-{tenant_id}-user-{user_id}-{uuid4()}",
        inputText=user_input,
        sessionAttributes={
            'tenantId': tenant_id,
            'tier': tenant['tier'],
            'features': json.dumps(tenant['features'])
        }
    )

    return response
```

### Session Attributes for Tenant Context

**Critical Pattern**: AgentCore sessions accept arbitrary `sessionAttributes`. Use this to pass tenant context:

```python
session_attributes = {
    'tenantId': 'acme',
    'tier': 'premium',
    'allowedModels': ['claude-sonnet-4-6', 'nova-pro'],
    'toolPermissions': ['read_file', 'write_file', 'web_search'],
    'monthlyBudget': '5000',
    'currentSpend': '1273.41'
}
```

The agent runtime can access these via `context.session.attributes` and enforce them at runtime.

---

## Data Layer: 6-Table DynamoDB Design

### Chimera Design

Chimera proposes 6 tables:

1. **chimera-tenants**: Tenant metadata, config, features, models, tools
2. **chimera-sessions**: Session state, active agents
3. **chimera-skills**: Skill metadata, MCP endpoints
4. **chimera-rate-limits**: Token bucket rate limiting
5. **chimera-cost-tracking**: Per-tenant cost attribution
6. **chimera-audit**: Compliance logs

### Validation

**✅ Solid Design**: The 6-table schema is well-suited for multi-tenant SaaS.

**⚠️ AgentCore Memory is Separate**: Chimera's design assumes memory is in DynamoDB. AWS reality:

- **AgentCore Memory** is a separate managed service
- **Memory ID** is a unique identifier per memory resource
- **Namespace** is used to partition memory within a resource

**Update**: DynamoDB stores **memory IDs**, not memory content:

```python
# DynamoDB item: TENANT#acme / PROFILE
{
    "PK": "TENANT#acme",
    "SK": "PROFILE",
    "tenantName": "Acme Corp",
    "tier": "advanced",
    "agentcore_endpoint": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/chimera-shared",
    "agentcore_memory_id": "chimera-memory-acme",  # ← Memory resource ID
    "memory_namespace_template": "tenant-acme-user-{user_id}",
    "created_at": "2026-03-19T12:00:00Z"
}
```

### Session Tracking

**Chimera Gap**: `chimera-sessions` table tracks session state, but AgentCore Runtime manages sessions internally.

**Recommendation**: Use `sessions` table for **metadata only**:

```python
# DynamoDB item: TENANT#acme / SESSION#abc123
{
    "PK": "TENANT#acme",
    "SK": "SESSION#abc123",
    "runtimeSessionId": "tenant-acme-user-alice-abc123",  # AgentCore session ID
    "userId": "alice",
    "status": "active",  # active | idle | terminated
    "startedAt": "2026-03-19T14:30:00Z",
    "lastActivity": "2026-03-19T14:45:00Z",
    "modelId": "us.anthropic.claude-sonnet-4-6-v1:0",
    "tokensUsed": 15234,
    "costUsd": 0.0456,
    "ttl": 1711123200  # 24 hours from last activity
}
```

**Query Pattern**: To check active sessions for rate limiting:

```python
def get_active_session_count(tenant_id: str) -> int:
    response = dynamodb.query(
        TableName='chimera-sessions',
        KeyConditionExpression='PK = :pk AND begins_with(SK, :sk)',
        FilterExpression='#status = :status',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={
            ':pk': f'TENANT#{tenant_id}',
            ':sk': 'SESSION#',
            ':status': 'active'
        }
    )
    return len(response['Items'])
```

---

## CDK Stack Structure: 8-Stack Approach

### Chimera Design

Chimera proposes 8 CDK stacks:

1. **network-stack**: VPC, subnets, endpoints
2. **data-stack**: 6 DynamoDB tables, 3 S3 buckets
3. **security-stack**: Cognito, WAF, Cedar, KMS
4. **observability-stack**: CloudWatch dashboards, X-Ray
5. **platform-runtime-stack**: 9 AgentCore services
6. **chat-stack**: Chat SDK + SSE bridge on Fargate
7. **pipeline-stack**: 5-stage CodePipeline
8. **tenant-stack**: Per-tenant (parameterized)

### Validation

**✅ Good Separation of Concerns**: Logical stack boundaries.

**⚠️ "9 AgentCore Services" is Misleading**: AWS provides these as managed services, not things you deploy:

| Service | Deployment Model |
|---------|------------------|
| AgentCore Runtime | You create endpoint resources via CDK/API |
| AgentCore Memory | You create memory resources via CDK/API |
| AgentCore Gateway | You create gateway resources via CDK/API |
| AgentCore Identity | Managed service, configure via API |
| AgentCore Code Interpreter | Built-in to Runtime, no separate deployment |
| AgentCore Browser | Built-in to Runtime, no separate deployment |
| AgentCore Observability | Built-in tracing, configure CloudWatch integration |
| AgentCore Evaluations | API-based service, no deployment |
| AgentCore Policy | Cedar policies stored in S3, enforced at runtime |

**Corrected Stack**: `platform-runtime-stack` should deploy:

```typescript
// platform-runtime-stack.ts
export class PlatformRuntimeStack extends cdk.Stack {
  public readonly sharedRuntimeEndpoint: agentcore.CfnAgentRuntime;
  public readonly sharedMemoryResource: agentcore.CfnMemory;
  public readonly gatewayResource: agentcore.CfnGateway;

  constructor(scope: Construct, id: string, props: PlatformRuntimeStackProps) {
    super(scope, id, props);

    // 1. Shared AgentCore Runtime for pool tenants
    this.sharedRuntimeEndpoint = new agentcore.CfnAgentRuntime(this, 'SharedRuntime', {
      name: 'chimera-shared-runtime',
      containerConfig: {
        image: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/chimera-agents:latest`,
        environment: {
          CHIMERA_ENV: props.envName,
          TENANTS_TABLE: props.tenantsTable.tableName,
          SKILLS_TABLE: props.skillsTable.tableName,
        }
      },
      lifecycleConfig: {
        idleRuntimeSessionTimeout: 900,  // 15 minutes
        maxLifetime: 28800  // 8 hours
      },
      networkMode: 'VPC',
      networkModeConfig: {
        securityGroupIds: [props.agentSecurityGroup.securityGroupId],
        subnetIds: props.privateSubnets.map(s => s.subnetId)
      }
    });

    // 2. Shared AgentCore Memory for pool tenants
    this.sharedMemoryResource = new agentcore.CfnMemory(this, 'SharedMemory', {
      name: 'chimera-shared-memory',
      storageConfig: {
        type: 'AMAZON_BEDROCK_AGENTCORE_MEMORY',
        kmsKeyArn: props.memoryKey.keyArn
      }
    });

    // 3. AgentCore Gateway for MCP tool routing
    this.gatewayResource = new agentcore.CfnGateway(this, 'Gateway', {
      name: 'chimera-gateway',
      targets: [
        // Lambda targets
        { type: 'LAMBDA', arn: props.coreToolsLambda.functionArn },
        // MCP server targets (added dynamically via API)
      ]
    });
  }
}
```

---

## Git-Backed Agent Workspaces: Storage Options

### Chimera Design

Chimera mentions "git-backed agent workspaces (EFS vs S3 vs CodeCommit)".

### AWS Reality Check

**🚨 Critical**: AgentCore Runtime sessions are **ephemeral**. There is no persistent filesystem.

**From AWS docs**:
> "Each user session runs in a dedicated microVM with isolated resources... Sessions are ephemeral and last up to 8 hours."

**What This Means**:

1. **No EFS mount**: AgentCore microVMs do not support mounting EFS
2. **No persistent /workspace**: Files written during a session are lost when the session ends
3. **S3 is the only persistent storage**: Use S3 for any data that must survive session termination

### Recommended Architecture

**For Agent Workspaces**:

```python
# Agent workspace pattern
class AgentWorkspace:
    def __init__(self, tenant_id: str, session_id: str):
        self.tenant_id = tenant_id
        self.session_id = session_id
        self.s3_prefix = f"tenants/{tenant_id}/workspaces/{session_id}/"

    def save_file(self, filename: str, content: bytes):
        """Save file to S3 for persistence across sessions."""
        s3.put_object(
            Bucket='chimera-tenants',
            Key=f"{self.s3_prefix}{filename}",
            Body=content
        )

    def load_file(self, filename: str) -> bytes:
        """Load file from S3 into ephemeral session."""
        response = s3.get_object(
            Bucket='chimera-tenants',
            Key=f"{self.s3_prefix}{filename}"
        )
        return response['Body'].read()

    def list_files(self) -> list[str]:
        """List all files in the workspace."""
        response = s3.list_objects_v2(
            Bucket='chimera-tenants',
            Prefix=self.s3_prefix
        )
        return [obj['Key'] for obj in response.get('Contents', [])]
```

**For Git Operations**:

AgentCore Runtime includes git binary. Use S3 as the remote:

```bash
# Within AgentCore session
git init
git remote add origin s3://chimera-tenants/tenants/acme/repos/my-project/
git fetch origin
git checkout main

# Make changes
git add .
git commit -m "Agent changes"
git push origin main
```

**Recommendation**: Drop EFS from the design entirely. Use **S3 as the primary workspace storage**.

---

## Team Deploy Model: Multi-Account Strategy

### Chimera Design

Chimera mentions "team-deploy-to-own-account model where each user interacts in parallel + collaboratively."

### Interpretation

This likely refers to **AWS Organizations multi-account strategy**:

```
Root Account (AWS Organizations)
├── Dev Account (tenant-dev)
│   ├── AgentCore Runtime (dev)
│   ├── DynamoDB tables (dev)
│   └── S3 buckets (dev)
├── Staging Account (tenant-staging)
│   ├── AgentCore Runtime (staging)
│   ├── DynamoDB tables (staging)
│   └── S3 buckets (staging)
└── Prod Account (tenant-prod)
    ├── AgentCore Runtime (prod)
    ├── DynamoDB tables (prod)
    └── S3 buckets (prod)
```

**For Premium/Enterprise Tenants**:

Each tenant gets a dedicated AWS account within the organization:

```
Root Account (Chimera Platform)
├── Platform Account (shared services)
│   ├── Cognito (central auth)
│   ├── API Gateway (routing)
│   └── Tenant registry
├── Tenant: Acme Corp
│   ├── Dedicated AgentCore endpoint
│   ├── Dedicated DynamoDB tables
│   ├── Dedicated S3 buckets
│   └── Dedicated VPC
└── Tenant: Beta Inc
    ├── Dedicated AgentCore endpoint
    └── ...
```

**Benefits**:
- Complete cost isolation (separate billing)
- Compliance boundaries (HIPAA, PCI-DSS per account)
- Service quota isolation
- Blast radius containment

**Recommendation**: Add a **4th tier** to Chimera's isolation model:

| Tier | Model | AWS Structure |
|------|-------|---------------|
| Basic | Pool | Shared account, shared endpoint |
| Advanced | Hybrid | Shared account, shared endpoint |
| Premium | Silo | Shared account, dedicated endpoint |
| **Enterprise** | **Multi-Account** | **Dedicated AWS account** |

---

## Cognito Tenant Model: Authentication

### Chimera Design

Chimera proposes Cognito for "tenant authentication" with "user pool groups per tenant."

### Validation

**✅ Correct Pattern**: Cognito user pools with groups is the standard multi-tenant auth model.

**Recommended Structure**:

```
Cognito User Pool: chimera-users
├── Group: tenant-acme-admins
├── Group: tenant-acme-users
├── Group: tenant-beta-admins
├── Group: tenant-beta-users
└── ...

User Attributes:
- sub (UUID)
- email
- custom:tenantId (e.g., "acme")
- custom:tier (e.g., "premium")
```

**JWT Claims**:

```json
{
  "sub": "a1b2c3d4-...",
  "email": "alice@acme.com",
  "cognito:groups": ["tenant-acme-users"],
  "custom:tenantId": "acme",
  "custom:tier": "premium"
}
```

**AgentCore Integration**:

AgentCore Identity supports OAuth 2.0 inbound. Configure Cognito as the identity provider:

```python
# CDK: AgentCore Runtime authorizer configuration
agentcore_runtime = agentcore.CfnAgentRuntime(self, 'Runtime',
    authorizerConfig={
        'customJwtAuthorizer': {
            'jwtConfiguration': {
                'issuer': f'https://cognito-idp.{region}.amazonaws.com/{user_pool_id}',
                'audience': [client_id],
                'claimMapping': {
                    'tenantId': 'custom:tenantId',
                    'tier': 'custom:tier'
                }
            }
        }
    }
)
```

Now the agent runtime can access tenant context from JWT claims:

```python
@entrypoint
async def handle(context):
    tenant_id = context.auth.claims['tenantId']
    tier = context.auth.claims['tier']

    # Load tenant-specific configuration
    agent = create_tenant_agent(tenant_id, tier)
    return agent(context.input_text)
```

---

## Cost Model: Consumption-Based Pricing

### Chimera Design

Chimera estimates **~$25.82/tenant** at 100 tenants, with optimizations bringing it to **~$12/tenant**.

### AWS Reality Check

**AgentCore Pricing** (as of March 2026):

| Component | Pricing Model | Estimated Cost (per tenant/month) |
|-----------|---------------|-----------------------------------|
| **AgentCore Runtime** | $0.004 per compute second + $0.10 per GB-second memory | ~$15 (1 hr/day usage) |
| **AgentCore Memory** | $0.015 per 1K storage operations + $0.25 per GB-month | ~$2 (100MB STM + 1GB LTM) |
| **AgentCore Gateway** | $0.001 per tool invocation | ~$1 (1000 invocations) |
| **Bedrock Models** | Model-specific (e.g., Sonnet 4.6: $3/$15 per MTok) | ~$13.50 (mixed usage) |
| **DynamoDB** | On-demand: $1.25/million writes, $0.25/million reads | ~$2.50 |
| **S3** | $0.023 per GB-month + $0.005 per 1K PUT | ~$1 (10GB storage) |
| **Data Transfer** | $0.09 per GB out | ~$0.50 (5GB/month) |
| **Total** | | **~$35.50/tenant** |

**Chimera's estimate is slightly low**. Adjustments:

1. **AgentCore Runtime** is more expensive than raw ECS/Lambda
2. **AgentCore Memory** adds ~$2/tenant overhead
3. **Model costs dominate** — focus optimization here

**Cost Optimization Strategies**:

```python
# 1. Model routing (cost-optimized)
MODEL_ROUTING = {
    'simple_query': 'us.amazon.nova-lite-v1:0',      # $0.06/$0.24 per MTok
    'complex_reasoning': 'us.anthropic.claude-sonnet-4-6-v1:0',  # $3/$15 per MTok
    'coding': 'us.anthropic.claude-opus-4-6-v1:0'     # $15/$75 per MTok
}

# 2. Memory tier optimization
MEMORY_CONFIG_BY_TIER = {
    'basic': {
        'stm_limit': '10MB',
        'ltm_strategies': ['SUMMARY'],  # Cheapest
        'retention_days': 7
    },
    'advanced': {
        'stm_limit': '100MB',
        'ltm_strategies': ['SUMMARY', 'USER_PREFERENCE'],
        'retention_days': 30
    },
    'premium': {
        'stm_limit': '500MB',
        'ltm_strategies': ['SUMMARY', 'USER_PREFERENCE', 'SEMANTIC', 'EPISODIC'],
        'retention_days': 365
    }
}

# 3. Session idle timeout
IDLE_TIMEOUT_BY_TIER = {
    'basic': 300,    # 5 minutes
    'advanced': 900,  # 15 minutes
    'premium': 1800   # 30 minutes
}
```

---

## Gaps and Recommendations

### Critical Gaps (P0 — Must Fix)

| # | Gap | Impact | Recommendation |
|---|-----|--------|----------------|
| 1 | **No tenant endpoint routing strategy** | All tenants sharing one endpoint = noisy neighbor | Implement per-tier endpoint strategy: basic/advanced → shared, premium → dedicated |
| 2 | **EFS assumption for workspaces** | AgentCore sessions are ephemeral, EFS not supported | Migrate to S3-backed workspaces with lazy load/save |
| 3 | **No AgentCore Observability integration** | Can't monitor per-tenant agent performance | Integrate AgentCore's built-in tracing with CloudWatch |
| 4 | **Missing memory namespace design** | Risk of cross-tenant memory leakage | Implement namespace template: `tenant-{id}-user-{id}` |

### Important Gaps (P1 — Fix Before Scale)

| # | Gap | Impact | Recommendation |
|---|-----|--------|----------------|
| 5 | **Underspecified memory strategies** | Can't optimize memory costs per tier | Define explicit strategy sets per tier (see [[#AgentCore Memory: STM + LTM Strategies]]) |
| 6 | **No AgentCore Policy integration** | Missing Cedar-based runtime enforcement | Store Cedar policies in S3, load via AgentCore Policy service |
| 7 | **Session state split** | DynamoDB tracks sessions, AgentCore manages sessions | Clarify: DynamoDB = metadata only, AgentCore = actual sessions |
| 8 | **Cost model underestimation** | Budget planning will be off | Update cost model to ~$35/tenant, focus on model routing optimization |

### Nice-to-Have (P2 — Future Iterations)

| # | Enhancement | Benefit |
|---|-------------|---------|
| 9 | Multi-account tier for enterprise | Strongest isolation, compliance-ready |
| 10 | AgentCore Evaluations integration | Automated agent quality assessment |
| 11 | Agent-to-Agent (A2A) protocol | Enable multi-agent collaboration via AgentCore |
| 12 | Cross-region deployment | Disaster recovery + latency optimization |

---

## Implementation Priorities

### Phase 0: Critical Fixes (Week 1-2)

**Goal**: Fix architectural blockers before implementation starts.

```
[ ] 1. Update data-stack.ts — remove EFS, confirm S3-only storage
[ ] 2. Design tenant endpoint routing logic
      - Pool/Hybrid → shared endpoint ARN
      - Silo → dedicated endpoint ARN per tenant
[ ] 3. Define memory namespace template in tenants table
[ ] 4. Add AgentCore Memory strategy configuration to tenant profiles
[ ] 5. Update cost model to reflect real AgentCore pricing
```

### Phase 1: AgentCore Integration (Week 3-4)

**Goal**: Deploy first AgentCore Runtime with Strands agent.

```
[ ] 1. Create platform-runtime-stack.ts
      - CfnAgentRuntime for shared endpoint
      - CfnMemory for shared memory resource
      - CfnGateway for MCP tool routing
[ ] 2. Build Strands agent container image
      - Base agent with 4 core tools (read/write/edit/shell)
      - Tenant context loading from session attributes
      - Memory integration via AgentCoreMemorySessionManager
[ ] 3. Deploy to AgentCore Runtime
      - Push container to ECR
      - Create Runtime resource via CDK
      - Test invocation via boto3
[ ] 4. Implement tenant router Lambda
      - Map tenant ID → endpoint ARN
      - Pass session attributes with tenant context
      - Handle streaming responses
```

### Phase 2: Multi-Tenant Onboarding (Week 5-6)

**Goal**: Automated tenant provisioning with proper isolation.

```
[ ] 1. Implement tenant onboarding Step Function
      - Create Cognito group
      - Initialize DynamoDB tenant profile
      - Create AgentCore Memory resource (per tenant)
      - Set up rate limits
[ ] 2. Build tenant-stack.ts (for silo tier)
      - Dedicated AgentCore Runtime endpoint
      - Dedicated Memory resource
      - Dedicated S3 bucket
      - Dedicated DynamoDB tables (optional)
[ ] 3. Test pool → silo migration path
      - Export tenant data from shared resources
      - Provision dedicated resources
      - Migrate data
      - Update routing
```

### Phase 3: Observability & Policy (Week 7-8)

**Goal**: Production-grade monitoring and security.

```
[ ] 1. Integrate AgentCore Observability
      - Enable tracing on Runtime endpoints
      - Create CloudWatch dashboards per tenant
      - Set up alarms for error rate, latency, cost
[ ] 2. Implement AgentCore Policy
      - Define Cedar policies for tier-based tool access
      - Store policies in S3
      - Configure Runtime to enforce policies
[ ] 3. Build cost attribution pipeline
      - Stream CloudWatch Logs to S3
      - Parse logs for per-tenant token usage
      - Update cost-tracking table
      - Generate monthly invoices
```

---

## Validation Summary

### Overall Assessment: **B+ (Strong Foundation, Needs Refinement)**

**Strengths**:
- ✅ MicroVM isolation model is exactly AgentCore Runtime
- ✅ STM + LTM memory architecture validated
- ✅ MCP Gateway design is correct
- ✅ Strands as primary framework is a good choice
- ✅ 6-table DynamoDB design is solid
- ✅ Cognito multi-tenant auth is standard pattern

**Weaknesses**:
- 🚨 EFS workspace assumption is invalid (must use S3)
- ⚠️ No tenant endpoint routing strategy
- ⚠️ Memory namespace design missing
- ⚠️ Cost model underestimates AgentCore overhead
- ⚠️ Observability and Policy integration underspecified

**Recommendation**: **Proceed with implementation** after addressing P0 gaps (EFS → S3, endpoint routing, memory namespaces).

The architecture is fundamentally sound and well-aligned with AWS AgentCore capabilities. The identified gaps are fixable within 1-2 weeks and do not require major redesign.

---

## References

### AWS Documentation
- [AgentCore Runtime - Host Agents and Tools](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html)
- [AgentCore Runtime - Session Isolation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)
- [AgentCore Memory - Built-in Strategies](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-configuring-built-in-strategies.html)
- [AgentCore Runtime API Reference](https://docs.aws.amazon.com/boto3/latest/reference/services/bedrock-agentcore-control/client/get_agent_runtime.html)

### Strands Agents Documentation
- [Deploy to Bedrock AgentCore](https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/)
- [AgentCore Memory Session Manager](https://strandsagents.com/docs/community/session-managers/agentcore-memory/)

### Chimera Architecture Documents
- [Chimera Definitive Architecture](../architecture-reviews/Chimera-Definitive-Architecture.md)
- [Chimera Multi-Tenant Architecture Review](../architecture-reviews/Chimera-Architecture-Review-Multi-Tenant.md)
- [Data Stack Implementation](../../infra/lib/data-stack.ts)

---

**Validation Complete**: March 19, 2026
**Next Steps**: Address P0 gaps, proceed to implementation (Phase 1)
