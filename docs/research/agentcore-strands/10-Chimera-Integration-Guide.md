# Chimera Platform: AgentCore + Strands Integration Guide

> **Document Type:** Integration Guide (Research Synthesis)
> **Date:** 2026-03-20
> **Status:** Ready for Implementation
> **Target Audience:** Chimera implementation team (leads + builders)
> **Research Base:** 10,848 lines across 9 research documents + validation analysis

---

## Table of Contents

1. [[#Executive Summary]]
2. [[#Integration Architecture Overview]]
3. [[#Core Integration Patterns]]
   - [[#Pattern 1: Runtime Deployment]]
   - [[#Pattern 2: Memory Management]]
   - [[#Pattern 3: Gateway and Tool Integration]]
   - [[#Pattern 4: Multi-Tenant Isolation]]
   - [[#Pattern 5: Identity and Authorization]]
4. [[#Code Examples]]
5. [[#Implementation Roadmap]]
6. [[#Decision Matrix]]
7. [[#Known Gaps and Mitigations]]
8. [[#Cost Model]]
9. [[#References]]

---

## Executive Summary

### What This Document Provides

This guide synthesizes 10,848 lines of AgentCore + Strands research into **actionable integration patterns** for the Chimera platform. It answers:

- **How** to deploy Chimera agents on AgentCore Runtime
- **How** to implement multi-tenant isolation using AgentCore services
- **What** code patterns to use for Strands agent integration
- **Which** architecture decisions remain open
- **Where** validation gaps exist and how to address them

### Integration Verdict

**✅ PROCEED WITH IMPLEMENTATION**

The validation analysis (see [[01-agentcore-strands-bedrock]]) confirms:
- Chimera's architecture aligns 85%+ with AgentCore capabilities
- Critical gaps (EFS → S3, endpoint routing, memory namespaces) are fixable in 1-2 weeks
- No fundamental redesign required

### Key Architectural Decisions (Already Made)

| Decision | Rationale | ADR |
|----------|-----------|-----|
| **AgentCore Runtime over ECS/Lambda** | MicroVM isolation + active-consumption billing | [[ADR-007-agentcore-microvm]] |
| **Strands as primary framework** | Model-driven, production-tested, AWS-native | [[ADR-003-strands-agent-framework]] |
| **AgentCore Memory (STM+LTM)** | Managed service, 4 built-in strategies | [[ADR-016-agentcore-memory-strategy]] |
| **S3 workspace storage** | AgentCore sessions are ephemeral (no EFS) | [[ADR-007-agentcore-microvm]] |
| **MCP via AgentCore Gateway** | 5 target types (Lambda, MCP, OpenAPI, API Gateway, Smithy) | [[02-AgentCore-APIs-SDKs-MCP]] |

### Critical Path Items (P0 — Block Implementation)

Before writing implementation code, resolve these:

1. **Endpoint routing strategy** — Map tiers to endpoints (pool vs silo)
2. **Memory namespace template** — Define tenant+user isolation pattern
3. **S3 workspace design** — Replace EFS assumptions with S3 lazy-load pattern
4. **Cost model update** — Adjust estimates to ~$35/tenant (from $25)

---

## Integration Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chimera Platform                          │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Chat Gateway (ECS)                      │  │
│  │  • Vercel AI SDK integration                              │  │
│  │  • Multi-platform support (Slack, Teams, Web)             │  │
│  │  • WebSocket + SSE streaming                              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                             │                                    │
│                             ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Tenant Router Lambda                         │  │
│  │  • Map tenantId → AgentCore endpoint ARN                  │  │
│  │  • Load tenant config from DynamoDB                       │  │
│  │  • Inject session attributes                              │  │
│  └──────────────────────────────────────────────────────────┘  │
│              │                              │                    │
│              ▼                              ▼                    │
│  ┌─────────────────────┐      ┌────────────────────────────┐  │
│  │ Shared AgentCore    │      │ Dedicated AgentCore        │  │
│  │ Runtime (Pool)      │      │ Runtime (Silo)             │  │
│  │  • Basic tier       │      │  • Premium tier            │  │
│  │  • Advanced tier    │      │  • Per-tenant endpoint     │  │
│  └─────────────────────┘      └────────────────────────────┘  │
│              │                              │                    │
│              └──────────┬───────────────────┘                    │
│                         ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           AgentCore Ecosystem                             │  │
│  │  ┌────────────┐ ┌────────────┐ ┌─────────────────────┐  │  │
│  │  │  Memory    │ │  Gateway   │ │  Identity           │  │  │
│  │  │  (STM+LTM) │ │  (MCP)     │ │  (Cognito OAuth)    │  │  │
│  │  └────────────┘ └────────────┘ └─────────────────────┘  │  │
│  │  ┌────────────┐ ┌────────────┐ ┌─────────────────────┐  │  │
│  │  │Observability│ │   Policy   │ │  Code Interpreter   │  │  │
│  │  │(CloudWatch)│ │   (Cedar)  │ │  (Python sandbox)   │  │  │
│  │  └────────────┘ └────────────┘ └─────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                         │                                        │
│                         ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Data Layer (6 DynamoDB Tables)               │  │
│  │  • chimera-tenants    • chimera-sessions                  │  │
│  │  • chimera-skills     • chimera-rate-limits               │  │
│  │  • chimera-cost-tracking  • chimera-audit                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                         │                                        │
│                         ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │          Storage Layer (3 S3 Buckets)                     │  │
│  │  • chimera-tenants (workspaces, skills, Cedar policies)   │  │
│  │  • chimera-observability (logs, traces)                   │  │
│  │  • chimera-pipeline (CDK assets, container images)        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Service Mapping: Chimera → AgentCore

| Chimera Component | AgentCore Service | Integration Pattern |
|------------------|-------------------|---------------------|
| **Agent Runtime** | AgentCore Runtime | Strands agent deployed as Docker container to ECR → Runtime |
| **Agent Memory** | AgentCore Memory | `AgentCoreMemorySessionManager` with namespace isolation |
| **Skill Registry** | AgentCore Gateway | S3 skill metadata → Gateway targets (Lambda, MCP, OpenAPI) |
| **Tenant Auth** | AgentCore Identity | Cognito → OAuth 2.0 inbound, JWT claims for tenantId |
| **Tool Execution** | Code Interpreter | Python tools run in sandboxed microVM environment |
| **Web Tools** | AgentCore Browser | Playwright CDP integration for web automation |
| **Observability** | AgentCore Observability | CloudWatch integration via OTEL tracing |
| **Guardrails** | AgentCore Policy | Cedar policies stored in S3, enforced at runtime |
| **Quality Assurance** | AgentCore Evaluations | 13 built-in evaluators for agent response quality |

---

## Core Integration Patterns

### Pattern 1: Runtime Deployment

**Objective:** Deploy Chimera Strands agent to AgentCore Runtime with multi-tenant isolation.

#### Architecture

```
                    ┌──────────────────────────────────┐
                    │  AWS CDK Stack: PlatformRuntime  │
                    └──────────────────────────────────┘
                                    │
                    ┌───────────────┴──────────────────┐
                    │                                   │
          ┌─────────▼────────┐            ┌────────────▼──────────┐
          │  Docker Image    │            │  AgentCore Runtime    │
          │  (ECR)           │            │  Resource (CFN)       │
          │                  │            │                       │
          │  • Strands SDK   │────────────▶│  • Container ref     │
          │  • Chimera tools │            │  • Network: VPC       │
          │  • Tenant router │            │  • Lifecycle: 8h max  │
          │  • Base deps     │            │  • Auth: Cognito      │
          └──────────────────┘            └───────────────────────┘
```

#### CDK Stack: `platform-runtime-stack.ts`

```typescript
import * as cdk from 'aws-cdk-lib';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface PlatformRuntimeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  agentSecurityGroup: ec2.ISecurityGroup;
  tenantsTable: dynamodb.ITable;
  skillsTable: dynamodb.ITable;
  memoryKey: kms.IKey;
  cognitoUserPoolId: string;
  cognitoClientId: string;
}

export class PlatformRuntimeStack extends cdk.Stack {
  public readonly sharedRuntimeEndpoint: agentcore.AgentRuntime;
  public readonly sharedMemoryResource: agentcore.Memory;
  public readonly gatewayResource: agentcore.Gateway;

  constructor(scope: Construct, id: string, props: PlatformRuntimeStackProps) {
    super(scope, id, props);

    // 1. Shared AgentCore Runtime for pool tenants (Basic + Advanced)
    this.sharedRuntimeEndpoint = new agentcore.AgentRuntime(this, 'SharedRuntime', {
      name: 'chimera-shared-runtime',

      // Container configuration
      container: {
        imageUri: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/chimera-agents:latest`,
        environment: {
          CHIMERA_ENV: 'production',
          TENANTS_TABLE: props.tenantsTable.tableName,
          SKILLS_TABLE: props.skillsTable.tableName,
          AWS_REGION: this.region,
        },
      },

      // Lifecycle configuration
      lifecycle: {
        idleRuntimeSessionTimeout: cdk.Duration.minutes(15),  // 15 min idle
        maxSessionLifetime: cdk.Duration.hours(8),            // 8 hr max
      },

      // Network configuration (VPC mode for tenant isolation)
      network: {
        mode: agentcore.NetworkMode.VPC,
        vpc: props.vpc,
        securityGroups: [props.agentSecurityGroup],
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      },

      // Authentication (Cognito OAuth 2.0)
      authentication: {
        customJwtAuthorizer: {
          issuerUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.cognitoUserPoolId}`,
          audience: [props.cognitoClientId],
          claimsMapping: {
            tenantId: 'custom:tenantId',
            tier: 'custom:tier',
            userId: 'sub',
          },
        },
      },

      // Resource limits
      memory: agentcore.MemorySize.mebibytes(2048),  // 2 GB
      ephemeralStorage: cdk.Size.gibibytes(10),       // 10 GB
    });

    // Grant DynamoDB access to Runtime execution role
    props.tenantsTable.grantReadData(this.sharedRuntimeEndpoint);
    props.skillsTable.grantReadData(this.sharedRuntimeEndpoint);

    // 2. Shared AgentCore Memory for pool tenants
    this.sharedMemoryResource = new agentcore.Memory(this, 'SharedMemory', {
      name: 'chimera-shared-memory',

      storageConfiguration: {
        type: agentcore.MemoryStorageType.BEDROCK_MEMORY,
        kmsKey: props.memoryKey,
      },

      // Long-term memory strategies (all 3)
      ltmStrategies: [
        agentcore.LtmStrategy.SUMMARY,           // Compress old messages
        agentcore.LtmStrategy.SEMANTIC_MEMORY,   // Extract facts
        agentcore.LtmStrategy.USER_PREFERENCE,   // Track preferences
      ],
    });

    // 3. AgentCore Gateway for MCP tool routing
    this.gatewayResource = new agentcore.Gateway(this, 'Gateway', {
      name: 'chimera-gateway',
      description: 'MCP tool routing for Chimera skills',
    });

    // Outputs
    new cdk.CfnOutput(this, 'SharedRuntimeEndpointArn', {
      value: this.sharedRuntimeEndpoint.runtimeArn,
      description: 'ARN for shared AgentCore Runtime endpoint',
    });

    new cdk.CfnOutput(this, 'SharedMemoryId', {
      value: this.sharedMemoryResource.memoryId,
      description: 'Memory ID for shared AgentCore Memory',
    });
  }
}
```

#### Strands Agent: `packages/agents/chimera-agent.py`

```python
"""
Chimera Platform Agent
Deployed to AgentCore Runtime via Docker container
"""
from strands import Agent
from strands.models.bedrock import BedrockModel
from bedrock_agentcore.runtime import BedrockAgentCoreApp, entrypoint
from bedrock_agentcore.memory.integrations.strands import AgentCoreMemorySessionManager
import os
import json

# Initialize AgentCore app
app = BedrockAgentCoreApp()

@entrypoint
async def handle(context):
    """
    AgentCore Runtime entrypoint
    context.auth.claims contains: tenantId, tier, userId (from Cognito JWT)
    context.input_text contains: user's message
    context.session contains: session metadata
    """

    # 1. Extract tenant context from JWT claims
    tenant_id = context.auth.claims.get('tenantId')
    tier = context.auth.claims.get('tier')
    user_id = context.auth.claims.get('userId')

    if not tenant_id:
        raise ValueError("Missing tenantId in JWT claims")

    # 2. Load tenant configuration from DynamoDB
    tenant_config = load_tenant_config(tenant_id)

    # 3. Select model based on tier
    model_id = select_model_for_tier(tier, tenant_config)

    # 4. Load tenant-specific tools
    tools = load_tenant_tools(tenant_id, tier, tenant_config)

    # 5. Configure memory with tenant+user namespace
    memory_manager = AgentCoreMemorySessionManager(
        memory_id=tenant_config['agentcore_memory_id'],
        namespace=f"tenant-{tenant_id}-user-{user_id}",
        strategies=get_memory_strategies_for_tier(tier),
    )

    # 6. Build system prompt with tenant context
    system_prompt = build_system_prompt(tenant_id, tier, tenant_config)

    # 7. Create Strands agent
    agent = Agent(
        model=BedrockModel(model_id),
        system_prompt=system_prompt,
        tools=tools,
        session_manager=memory_manager,
        max_iterations=20,
    )

    # 8. Execute agent and stream response
    async for chunk in agent.stream(context.input_text):
        yield chunk


def load_tenant_config(tenant_id: str) -> dict:
    """Load tenant configuration from DynamoDB."""
    import boto3

    dynamodb = boto3.client('dynamodb')
    response = dynamodb.get_item(
        TableName=os.environ['TENANTS_TABLE'],
        Key={'PK': {'S': f'TENANT#{tenant_id}'}, 'SK': {'S': 'PROFILE'}}
    )

    if 'Item' not in response:
        raise ValueError(f"Tenant {tenant_id} not found")

    # Parse DynamoDB item
    item = response['Item']
    return {
        'tier': item['tier']['S'],
        'features': json.loads(item.get('features', {}).get('S', '{}')),
        'allowedModels': json.loads(item.get('allowedModels', {}).get('S', '[]')),
        'agentcore_memory_id': item['agentcore_memory_id']['S'],
        'monthlyBudget': float(item.get('monthlyBudget', {}).get('N', '1000')),
        'currentSpend': float(item.get('currentSpend', {}).get('N', '0')),
    }


def select_model_for_tier(tier: str, config: dict) -> str:
    """Select Bedrock model based on tenant tier."""
    tier_models = {
        'basic': 'us.amazon.nova-lite-v1:0',         # $0.06/$0.24 per MTok
        'advanced': 'us.anthropic.claude-sonnet-4-6-v1:0',  # $3/$15 per MTok
        'premium': 'us.anthropic.claude-opus-4-6-v1:0',     # $15/$75 per MTok
    }

    default_model = tier_models.get(tier, tier_models['basic'])

    # Allow tenant override if in allowedModels
    if config['allowedModels']:
        return config['allowedModels'][0]  # Use first allowed model

    return default_model


def load_tenant_tools(tenant_id: str, tier: str, config: dict) -> list:
    """Load tools for tenant based on tier and skill registry."""
    from strands.tools import tool

    # Core tools (always available)
    tools = [
        read_file_tool,
        write_file_tool,
        edit_file_tool,
        shell_tool,
    ]

    # Tier-based tools
    if tier in ['advanced', 'premium']:
        tools.append(web_search_tool)

    if tier == 'premium':
        tools.append(code_review_tool)
        tools.append(data_analysis_tool)

    # Load custom skills from skill registry (DynamoDB)
    custom_skills = load_custom_skills(tenant_id)
    tools.extend(custom_skills)

    return tools


def get_memory_strategies_for_tier(tier: str) -> list[str]:
    """Memory strategies based on tier."""
    strategies = {
        'basic': ['SUMMARY'],
        'advanced': ['SUMMARY', 'USER_PREFERENCE'],
        'premium': ['SUMMARY', 'USER_PREFERENCE', 'SEMANTIC_MEMORY'],
    }
    return strategies.get(tier, ['SUMMARY'])


def build_system_prompt(tenant_id: str, tier: str, config: dict) -> str:
    """Build system prompt with tenant context."""
    base_prompt = f"""You are an AI assistant for {tenant_id}.

Tier: {tier}
Features: {', '.join(config['features'])}
Monthly budget: ${config['monthlyBudget']}
Current spend: ${config['currentSpend']:.2f}

Follow tenant-specific guidelines and respect budget constraints.
"""
    return base_prompt


# Tool definitions
@tool
def read_file_tool(path: str) -> str:
    """Read file from S3 workspace."""
    # Implementation: Load from S3 tenant prefix
    pass

@tool
def write_file_tool(path: str, content: str) -> str:
    """Write file to S3 workspace."""
    # Implementation: Save to S3 tenant prefix
    pass

@tool
def edit_file_tool(path: str, edits: dict) -> str:
    """Apply edits to file."""
    # Implementation: Read, edit, write
    pass

@tool
def shell_tool(command: str) -> str:
    """Execute shell command in sandbox."""
    # Implementation: AgentCore Code Interpreter
    pass

@tool
def web_search_tool(query: str) -> list[dict]:
    """Search the web."""
    # Implementation: Call search API via AgentCore Gateway
    pass
```

#### Dockerfile: `packages/agents/Dockerfile`

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy agent code
COPY chimera-agent.py .
COPY tools/ ./tools/

# Set environment variables
ENV PYTHONUNBUFFERED=1

# AgentCore Runtime expects port 8080
EXPOSE 8080

# Run agent
CMD ["python", "-m", "bedrock_agentcore.runtime"]
```

#### Deployment: `Makefile`

```makefile
# Build and deploy Chimera agent to AgentCore Runtime

.PHONY: build push deploy

# Build Docker image
build:
	docker build -t chimera-agents:latest packages/agents/

# Tag and push to ECR
push:
	aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $(AWS_ACCOUNT).dkr.ecr.us-east-1.amazonaws.com
	docker tag chimera-agents:latest $(AWS_ACCOUNT).dkr.ecr.us-east-1.amazonaws.com/chimera-agents:latest
	docker push $(AWS_ACCOUNT).dkr.ecr.us-east-1.amazonaws.com/chimera-agents:latest

# Deploy CDK stack
deploy:
	cd infra && bun run cdk deploy PlatformRuntimeStack
```

---

### Pattern 2: Memory Management

**Objective:** Implement multi-tenant memory isolation using AgentCore Memory with STM + LTM strategies.

#### Memory Namespace Strategy

**Critical:** AgentCore Memory requires explicit namespace management to prevent cross-tenant data leakage.

**Namespace Template:**

```
tenant-{tenant_id}-user-{user_id}
```

**Examples:**
- `tenant-acme-user-alice`
- `tenant-beta-user-bob`
- `tenant-gamma-cron-scheduler` (for cron agents)

#### Memory Configuration by Tier

```python
MEMORY_STRATEGIES_BY_TIER = {
    'basic': {
        'strategies': ['SUMMARY'],
        'stm_window': 10,          # Last 10 messages
        'ltm_retention_days': 7,   # 1 week
    },
    'advanced': {
        'strategies': ['SUMMARY', 'USER_PREFERENCE'],
        'stm_window': 50,          # Last 50 messages
        'ltm_retention_days': 30,  # 1 month
    },
    'premium': {
        'strategies': ['SUMMARY', 'USER_PREFERENCE', 'SEMANTIC_MEMORY'],
        'stm_window': 200,         # Last 200 messages
        'ltm_retention_days': 365, # 1 year
    },
}
```

#### DynamoDB Schema Update: `chimera-tenants`

Add memory configuration to tenant profile:

```python
# DynamoDB item: TENANT#acme / PROFILE
{
    "PK": "TENANT#acme",
    "SK": "PROFILE",
    "tenantName": "Acme Corp",
    "tier": "advanced",

    # AgentCore Memory configuration
    "agentcore_memory_id": "chimera-memory-acme",
    "memory_namespace_template": "tenant-acme-user-{user_id}",
    "memory_strategies": ["SUMMARY", "USER_PREFERENCE"],
    "memory_stm_window": 50,
    "memory_ltm_retention_days": 30,

    # AgentCore Runtime configuration
    "agentcore_endpoint": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/chimera-shared",

    "created_at": "2026-03-19T12:00:00Z"
}
```

#### Memory Integration: Strands Agent

```python
from bedrock_agentcore.memory.integrations.strands import AgentCoreMemorySessionManager

def create_memory_manager(tenant_id: str, user_id: str, tier: str) -> AgentCoreMemorySessionManager:
    """Create memory manager with tenant+user isolation."""

    # Load tenant config
    tenant_config = load_tenant_config(tenant_id)
    memory_config = MEMORY_STRATEGIES_BY_TIER[tier]

    # Create memory manager
    return AgentCoreMemorySessionManager(
        memory_id=tenant_config['agentcore_memory_id'],
        namespace=f"tenant-{tenant_id}-user-{user_id}",
        strategies=memory_config['strategies'],

        # STM configuration
        conversation_window_size=memory_config['stm_window'],

        # LTM configuration
        retention_policy={
            'max_age_days': memory_config['ltm_retention_days'],
        },
    )
```

#### CDK: Per-Tenant Memory Resources (Silo Tier)

For premium tenants, create dedicated memory resources:

```typescript
export class TenantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TenantStackProps) {
    super(scope, id, props);

    // Dedicated AgentCore Memory for this tenant
    const memory = new agentcore.Memory(this, 'TenantMemory', {
      name: `chimera-memory-${props.tenantId}`,

      storageConfiguration: {
        type: agentcore.MemoryStorageType.BEDROCK_MEMORY,
        kmsKey: props.memoryKey,  // Per-tenant KMS key
      },

      ltmStrategies: [
        agentcore.LtmStrategy.SUMMARY,
        agentcore.LtmStrategy.SEMANTIC_MEMORY,
        agentcore.LtmStrategy.USER_PREFERENCE,
      ],
    });

    // Store memory ID in DynamoDB
    new dynamodb.CfnTableItem(this, 'TenantMemoryConfig', {
      tableName: props.tenantsTable.tableName,
      item: {
        PK: { S: `TENANT#${props.tenantId}` },
        SK: { S: 'PROFILE' },
        agentcore_memory_id: { S: memory.memoryId },
      },
    });
  }
}
```

---

### Pattern 3: Gateway and Tool Integration

**Objective:** Register Chimera skills as AgentCore Gateway targets for MCP tool routing.

#### AgentCore Gateway Target Types

| Type | Use Case | Example |
|------|----------|---------|
| **Lambda** | Custom tool logic | Code review, data analysis |
| **MCP Server** | External skill servers | OpenClaw skills, community tools |
| **OpenAPI** | REST APIs | Weather API, Slack API |
| **API Gateway** | Internal services | Tenant management, billing |
| **Smithy** | AWS services | S3, DynamoDB, Lambda |

#### Skill Registration Flow

```
┌────────────────────────────────────────────────────────────┐
│  1. Skill Uploaded to S3                                   │
│     s3://chimera-tenants/tenants/acme/skills/code-review/  │
└────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────┐
│  2. Metadata Stored in DynamoDB (chimera-skills)           │
│     PK: TENANT#acme  SK: SKILL#code-review                 │
│     {                                                       │
│       "skillName": "code-review",                          │
│       "version": "2.1.0",                                  │
│       "gatewayTarget": {                                   │
│         "type": "mcp_server",                              │
│         "endpoint": "https://skills.acme.com/code-review", │
│         "auth": "api_key"                                  │
│       }                                                    │
│     }                                                      │
└────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────┐
│  3. Gateway Target Created via CDK/API                     │
│     AgentCore Gateway resource updated                     │
└────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────┐
│  4. Tool Available to Strands Agent                        │
│     @tool decorator auto-loads from Gateway                │
└────────────────────────────────────────────────────────────┘
```

#### CDK: Gateway Target Registration

```typescript
export class GatewayTargetsConstruct extends Construct {
  constructor(scope: Construct, id: string, props: GatewayTargetsProps) {
    super(scope, id, props);

    // Lambda target: Code review tool
    new agentcore.GatewayTarget(this, 'CodeReviewTarget', {
      gateway: props.gateway,
      name: 'code-review',
      description: 'AI-powered code review tool',

      target: {
        type: agentcore.TargetType.LAMBDA,
        lambdaFunction: props.codeReviewLambda,
      },

      authentication: {
        type: agentcore.AuthenticationType.IAM,
      },
    });

    // MCP Server target: External skill
    new agentcore.GatewayTarget(this, 'SlackIntegrationTarget', {
      gateway: props.gateway,
      name: 'slack-integration',
      description: 'Slack messaging and channel management',

      target: {
        type: agentcore.TargetType.MCP_SERVER,
        endpoint: 'https://skills.chimera.example.com/slack',
      },

      authentication: {
        type: agentcore.AuthenticationType.API_KEY,
        apiKeySecretArn: props.slackApiKeySecret.secretArn,
      },
    });

    // OpenAPI target: Weather API
    new agentcore.GatewayTarget(this, 'WeatherTarget', {
      gateway: props.gateway,
      name: 'weather',
      description: 'Weather data API',

      target: {
        type: agentcore.TargetType.OPENAPI,
        specUrl: 'https://api.weather.com/openapi.json',
      },

      authentication: {
        type: agentcore.AuthenticationType.API_KEY,
        apiKeySecretArn: props.weatherApiKeySecret.secretArn,
      },
    });
  }
}
```

#### Python: Dynamic Tool Loading from Gateway

```python
from strands.tools import tool
from strands.tools.mcp import MCPClient
import boto3

def load_tenant_tools(tenant_id: str, tier: str) -> list:
    """Load tools for tenant from skill registry + Gateway."""

    # 1. Load skill metadata from DynamoDB
    dynamodb = boto3.client('dynamodb')
    response = dynamodb.query(
        TableName=os.environ['SKILLS_TABLE'],
        KeyConditionExpression='PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues={
            ':pk': {'S': f'TENANT#{tenant_id}'},
            ':sk': {'S': 'SKILL#'},
        }
    )

    tools = []

    # 2. Convert skill metadata to tool definitions
    for item in response.get('Items', []):
        skill_name = item['skillName']['S']
        gateway_target = json.loads(item['gatewayTarget']['S'])

        # Create tool from Gateway target
        if gateway_target['type'] == 'mcp_server':
            mcp_client = MCPClient(gateway_target['endpoint'])
            tools.extend(mcp_client.get_tools())

        elif gateway_target['type'] == 'lambda':
            tools.append(create_lambda_tool(skill_name, gateway_target))

        elif gateway_target['type'] == 'openapi':
            tools.append(create_openapi_tool(skill_name, gateway_target))

    return tools


def create_lambda_tool(name: str, target: dict):
    """Create Strands tool from Lambda Gateway target."""
    import boto3

    lambda_client = boto3.client('lambda')

    @tool(name=name, description=target.get('description', ''))
    def lambda_tool(**kwargs):
        response = lambda_client.invoke(
            FunctionName=target['lambdaArn'],
            Payload=json.dumps(kwargs)
        )
        return json.loads(response['Payload'].read())

    return lambda_tool
```

---

### Pattern 4: Multi-Tenant Isolation

**Objective:** Enforce tenant isolation at compute, network, storage, and memory layers.

#### Isolation Strategy by Tier

| Layer | Basic (Pool) | Advanced (Hybrid) | Premium (Silo) |
|-------|--------------|-------------------|----------------|
| **Compute** | Shared endpoint | Shared endpoint | Dedicated endpoint |
| **Network** | Shared VPC | Shared VPC | Dedicated VPC (optional) |
| **Storage** | S3 prefix isolation | S3 prefix isolation | Dedicated bucket |
| **Memory** | Namespace isolation | Namespace isolation | Dedicated memory resource |
| **Database** | Partition key isolation | Partition key isolation | Dedicated tables (optional) |

#### Tenant Router Lambda

```python
"""
Tenant Router Lambda
Routes agent invocations to correct AgentCore endpoint based on tier
"""
import boto3
import json
import os

bedrock_agentcore = boto3.client('bedrock-agentcore-runtime')
dynamodb = boto3.client('dynamodb')

# Endpoint ARNs (from CDK outputs)
SHARED_ENDPOINT_ARN = os.environ['SHARED_RUNTIME_ARN']

def lambda_handler(event, context):
    """
    API Gateway proxy integration
    event['headers']['Authorization'] contains Cognito JWT
    event['body'] contains user input
    """

    # 1. Extract tenant ID from JWT (API Gateway adds this after Cognito auth)
    tenant_id = event['requestContext']['authorizer']['claims']['custom:tenantId']
    tier = event['requestContext']['authorizer']['claims']['custom:tier']
    user_id = event['requestContext']['authorizer']['claims']['sub']

    # 2. Load tenant config
    tenant_config = load_tenant_config(tenant_id)

    # 3. Determine endpoint ARN
    if tier == 'premium' and tenant_config.get('dedicated_endpoint_arn'):
        endpoint_arn = tenant_config['dedicated_endpoint_arn']
    else:
        endpoint_arn = SHARED_ENDPOINT_ARN

    # 4. Parse user input
    user_input = json.loads(event['body'])['message']

    # 5. Invoke AgentCore Runtime
    runtime_session_id = f"tenant-{tenant_id}-user-{user_id}-{uuid4()}"

    response = bedrock_agentcore.invoke_agent_runtime(
        agentRuntimeArn=endpoint_arn,
        runtimeSessionId=runtime_session_id,
        inputText=user_input,

        # Pass tenant context via session attributes
        sessionAttributes={
            'tenantId': tenant_id,
            'tier': tier,
            'userId': user_id,
            'features': json.dumps(tenant_config['features']),
            'allowedModels': json.dumps(tenant_config['allowedModels']),
            'monthlyBudget': str(tenant_config['monthlyBudget']),
            'currentSpend': str(tenant_config['currentSpend']),
        },

        # Enable streaming
        enableStreaming=True,
    )

    # 6. Stream response back to client
    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
        },
        'body': stream_response(response),
    }


def load_tenant_config(tenant_id: str) -> dict:
    """Load tenant configuration from DynamoDB."""
    response = dynamodb.get_item(
        TableName=os.environ['TENANTS_TABLE'],
        Key={'PK': {'S': f'TENANT#{tenant_id}'}, 'SK': {'S': 'PROFILE'}}
    )

    if 'Item' not in response:
        raise ValueError(f"Tenant {tenant_id} not found")

    item = response['Item']
    return {
        'tier': item['tier']['S'],
        'features': json.loads(item.get('features', {}).get('S', '{}')),
        'allowedModels': json.loads(item.get('allowedModels', {}).get('S', '[]')),
        'agentcore_endpoint': item['agentcore_endpoint']['S'],
        'dedicated_endpoint_arn': item.get('dedicated_endpoint_arn', {}).get('S'),
        'monthlyBudget': float(item.get('monthlyBudget', {}).get('N', '1000')),
        'currentSpend': float(item.get('currentSpend', {}).get('N', '0')),
    }


def stream_response(response):
    """Stream AgentCore response chunks."""
    for event in response['stream']:
        if 'chunk' in event:
            yield event['chunk']['text']
        elif 'error' in event:
            yield json.dumps({'error': event['error']})
```

#### Session Tracking: DynamoDB

```python
# DynamoDB item: TENANT#acme / SESSION#abc123
{
    "PK": "TENANT#acme",
    "SK": "SESSION#abc123",

    # AgentCore session metadata
    "runtimeSessionId": "tenant-acme-user-alice-abc123",
    "endpointArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/chimera-shared",

    # User context
    "userId": "alice",
    "tier": "advanced",

    # Session state
    "status": "active",  # active | idle | terminated
    "startedAt": "2026-03-19T14:30:00Z",
    "lastActivity": "2026-03-19T14:45:00Z",

    # Usage tracking
    "modelId": "us.anthropic.claude-sonnet-4-6-v1:0",
    "tokensUsed": 15234,
    "costUsd": 0.0456,

    # TTL (24 hours from last activity)
    "ttl": 1711123200
}
```

#### Rate Limiting Query Pattern

```python
def check_active_session_limit(tenant_id: str, tier: str) -> bool:
    """Check if tenant has exceeded concurrent session limit."""

    # Session limits by tier
    session_limits = {
        'basic': 2,
        'advanced': 10,
        'premium': 100,
    }

    limit = session_limits.get(tier, 2)

    # Query active sessions
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

    active_count = len(response['Items'])
    return active_count < limit
```

---

### Pattern 5: Identity and Authorization

**Objective:** Integrate Cognito with AgentCore Identity for inbound auth and tenant context injection.

#### Cognito User Pool Structure

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
- custom:role (e.g., "admin" | "user")
```

#### JWT Claims Structure

```json
{
  "sub": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "email": "alice@acme.com",
  "cognito:groups": ["tenant-acme-users"],
  "custom:tenantId": "acme",
  "custom:tier": "premium",
  "custom:role": "user",
  "iat": 1711000000,
  "exp": 1711003600
}
```

#### CDK: Cognito + AgentCore Integration

```typescript
export class SecurityStack extends cdk.Stack {
  public readonly userPool: cognito.IUserPool;
  public readonly userPoolClient: cognito.IUserPoolClient;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // 1. Create Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'ChimeraUserPool', {
      userPoolName: 'chimera-users',

      // Custom attributes for tenant context
      customAttributes: {
        tenantId: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: false }),
        tier: new cognito.StringAttribute({ minLen: 1, maxLen: 32, mutable: true }),
        role: new cognito.StringAttribute({ minLen: 1, maxLen: 32, mutable: true }),
      },

      // Sign-in configuration
      signInAliases: { email: true },
      selfSignUpEnabled: false,  // Admin-only registration

      // Password policy
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },

      // MFA configuration
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: true, otp: true },
    });

    // 2. Create User Pool Client
    this.userPoolClient = this.userPool.addClient('ChimeraWebClient', {
      userPoolClientName: 'chimera-web-client',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ['https://chimera.example.com/callback'],
        logoutUrls: ['https://chimera.example.com/logout'],
      },
    });

    // 3. Configure AgentCore Runtime to use Cognito
    // (This is done in PlatformRuntimeStack, but shown here for context)
    /*
    runtime.addAuthentication({
      customJwtAuthorizer: {
        issuerUrl: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
        audience: [this.userPoolClient.userPoolClientId],
        claimsMapping: {
          tenantId: 'custom:tenantId',
          tier: 'custom:tier',
          role: 'custom:role',
          userId: 'sub',
        },
      },
    });
    */
  }
}
```

#### Tenant Onboarding Lambda

```python
"""
Tenant Onboarding Lambda
Creates Cognito groups and DynamoDB tenant profile
"""
import boto3
import json
from datetime import datetime

cognito = boto3.client('cognito-idp')
dynamodb = boto3.client('dynamodb')

def lambda_handler(event, context):
    """
    event: {
      "tenantId": "acme",
      "tenantName": "Acme Corp",
      "tier": "advanced",
      "adminEmail": "admin@acme.com"
    }
    """

    tenant_id = event['tenantId']
    tenant_name = event['tenantName']
    tier = event['tier']
    admin_email = event['adminEmail']

    # 1. Create Cognito groups
    user_pool_id = os.environ['USER_POOL_ID']

    cognito.create_group(
        GroupName=f'tenant-{tenant_id}-admins',
        UserPoolId=user_pool_id,
        Description=f'Administrators for {tenant_name}',
    )

    cognito.create_group(
        GroupName=f'tenant-{tenant_id}-users',
        UserPoolId=user_pool_id,
        Description=f'Users for {tenant_name}',
    )

    # 2. Create admin user
    cognito.admin_create_user(
        UserPoolId=user_pool_id,
        Username=admin_email,
        UserAttributes=[
            {'Name': 'email', 'Value': admin_email},
            {'Name': 'email_verified', 'Value': 'true'},
            {'Name': 'custom:tenantId', 'Value': tenant_id},
            {'Name': 'custom:tier', 'Value': tier},
            {'Name': 'custom:role', 'Value': 'admin'},
        ],
        DesiredDeliveryMediums=['EMAIL'],
    )

    cognito.admin_add_user_to_group(
        UserPoolId=user_pool_id,
        Username=admin_email,
        GroupName=f'tenant-{tenant_id}-admins',
    )

    # 3. Create AgentCore Memory resource
    agentcore = boto3.client('bedrock-agentcore')
    memory_response = agentcore.create_memory(
        name=f'chimera-memory-{tenant_id}',
        storageConfiguration={
            'type': 'AMAZON_BEDROCK_AGENTCORE_MEMORY',
            'kmsKeyId': os.environ['MEMORY_KMS_KEY_ID'],
        },
    )

    memory_id = memory_response['memoryId']

    # 4. Create DynamoDB tenant profile
    dynamodb.put_item(
        TableName=os.environ['TENANTS_TABLE'],
        Item={
            'PK': {'S': f'TENANT#{tenant_id}'},
            'SK': {'S': 'PROFILE'},
            'tenantName': {'S': tenant_name},
            'tier': {'S': tier},
            'adminEmail': {'S': admin_email},

            # AgentCore configuration
            'agentcore_endpoint': {'S': os.environ['SHARED_RUNTIME_ARN']},
            'agentcore_memory_id': {'S': memory_id},
            'memory_namespace_template': {'S': f'tenant-{tenant_id}-user-{{user_id}}'},

            # Default limits
            'monthlyBudget': {'N': '1000'},
            'currentSpend': {'N': '0'},
            'maxConcurrentSessions': {'N': '10'},

            # Metadata
            'created_at': {'S': datetime.utcnow().isoformat()},
            'status': {'S': 'active'},
        }
    )

    return {
        'statusCode': 200,
        'body': json.dumps({
            'tenantId': tenant_id,
            'memoryId': memory_id,
            'adminEmail': admin_email,
        })
    }
```

---

## Code Examples

### Example 1: Simple Strands Agent

```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.tools import tool

@tool
def get_weather(city: str) -> str:
    """Get current weather for a city."""
    return f"Weather in {city}: Sunny, 72°F"

agent = Agent(
    model=BedrockModel("us.anthropic.claude-sonnet-4-6-v1:0"),
    system_prompt="You are a helpful assistant",
    tools=[get_weather],
)

response = agent("What's the weather in Seattle?")
print(response.content)
```

### Example 2: Multi-Agent Orchestration

```python
from strands import Agent
from strands.multiagent import Swarm
from strands.models.bedrock import BedrockModel

# Research agent
research_agent = Agent(
    model=BedrockModel("us.anthropic.claude-sonnet-4-6-v1:0"),
    system_prompt="You research topics and gather information",
    tools=[web_search, read_article],
)

# Writer agent
writer_agent = Agent(
    model=BedrockModel("us.anthropic.claude-opus-4-6-v1:0"),
    system_prompt="You write high-quality content based on research",
    tools=[],
)

# Orchestrate agents in a swarm
swarm = Swarm([research_agent, writer_agent])
result = swarm("Write a blog post about AWS AgentCore")
```

### Example 3: Streaming Response

```python
async def stream_agent_response(user_input: str):
    """Stream agent response token-by-token."""

    agent = Agent(
        model=BedrockModel("us.anthropic.claude-sonnet-4-6-v1:0"),
        system_prompt="You are a helpful assistant",
    )

    async for chunk in agent.stream(user_input):
        if chunk.type == 'content':
            print(chunk.text, end='', flush=True)
        elif chunk.type == 'tool_call':
            print(f"\n[Calling tool: {chunk.tool_name}]")
```

---

## Implementation Roadmap

### Phase 0: Critical Fixes (Week 1-2)

**Goal:** Resolve P0 architectural blockers before implementation.

```
[ ] 1. Update data-stack.ts — remove EFS, confirm S3-only storage
[ ] 2. Design tenant endpoint routing logic
      - Pool/Hybrid → shared endpoint ARN
      - Silo → dedicated endpoint ARN per tenant
[ ] 3. Define memory namespace template in tenants table
[ ] 4. Add AgentCore Memory strategy configuration to tenant profiles
[ ] 5. Update cost model to reflect real AgentCore pricing (~$35/tenant)
```

### Phase 1: AgentCore Integration (Week 3-4)

**Goal:** Deploy first AgentCore Runtime with Strands agent.

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

**Goal:** Automated tenant provisioning with proper isolation.

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

**Goal:** Production-grade monitoring and security.

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

## Decision Matrix

### Open Architectural Decisions

| Decision | Options | Recommendation | Priority |
|----------|---------|----------------|----------|
| **Endpoint routing strategy** | (A) All tenants → shared endpoint<br>(B) Premium → dedicated, others → shared<br>(C) Hybrid per-service | **B** — Balance cost and isolation | P0 |
| **Memory resource allocation** | (A) One shared memory for all<br>(B) Per-tenant memory resources<br>(C) Hybrid by tier | **C** — Shared for pool, dedicated for silo | P0 |
| **S3 workspace structure** | (A) Single bucket with prefixes<br>(B) Dedicated bucket per tenant<br>(C) Hybrid by tier | **C** — Shared bucket for pool, dedicated for premium | P1 |
| **Cost tracking granularity** | (A) Per-tenant total<br>(B) Per-tenant per-session<br>(C) Per-tenant per-tool | **B** — Session-level for chargeback | P1 |
| **Multi-region deployment** | (A) Single region (us-east-1)<br>(B) Multi-region active-active<br>(C) Multi-region DR only | **A initially, C for prod** — Start simple, add DR | P2 |

### Key Trade-Offs

| Trade-Off | Option A | Option B | Impact |
|-----------|----------|----------|--------|
| **Pool vs Silo** | Lower cost, higher noisy neighbor risk | Higher cost, stronger isolation | Cost 3-5x, isolation 10x |
| **Shared vs Dedicated Memory** | Lower operational overhead | Per-tenant data sovereignty | Compliance requirements |
| **Single vs Multi-Region** | Simpler ops, single point of failure | Higher availability, complex routing | Cost 2x, availability +99.9% |

---

## Known Gaps and Mitigations

### Critical Gaps (P0 — Must Fix)

| Gap | Impact | Mitigation | Owner |
|-----|--------|------------|-------|
| **No tenant endpoint routing strategy** | All tenants sharing one endpoint = noisy neighbor | Implement per-tier endpoint strategy (see Pattern 4) | @lead-arch |
| **EFS assumption for workspaces** | AgentCore sessions are ephemeral, EFS not supported | Migrate to S3-backed workspaces with lazy load/save | @builder-data |
| **No AgentCore Observability integration** | Can't monitor per-tenant agent performance | Integrate AgentCore's built-in tracing with CloudWatch | @builder-observability |
| **Missing memory namespace design** | Risk of cross-tenant memory leakage | Implement namespace template: `tenant-{id}-user-{id}` | @builder-data |

### Important Gaps (P1 — Fix Before Scale)

| Gap | Impact | Mitigation | Owner |
|-----|--------|------------|-------|
| **Underspecified memory strategies** | Can't optimize memory costs per tier | Define explicit strategy sets per tier (see Pattern 2) | @builder-data |
| **No AgentCore Policy integration** | Missing Cedar-based runtime enforcement | Store Cedar policies in S3, load via AgentCore Policy service | @builder-security |
| **Session state split** | DynamoDB tracks sessions, AgentCore manages sessions | Clarify: DynamoDB = metadata only, AgentCore = actual sessions | @builder-data |
| **Cost model underestimation** | Budget planning will be off | Update cost model to ~$35/tenant, focus on model routing optimization | @lead-arch |

### Nice-to-Have (P2 — Future Iterations)

| Enhancement | Benefit | Effort |
|-------------|---------|--------|
| Multi-account tier for enterprise | Strongest isolation, compliance-ready | High (8-12 weeks) |
| AgentCore Evaluations integration | Automated agent quality assessment | Medium (4-6 weeks) |
| Agent-to-Agent (A2A) protocol | Enable multi-agent collaboration via AgentCore | Medium (4-6 weeks) |
| Cross-region deployment | Disaster recovery + latency optimization | High (8-12 weeks) |

---

## Cost Model

### Revised Cost Estimate (Per Tenant/Month)

| Component | Pricing Model | Basic Tier | Advanced Tier | Premium Tier |
|-----------|---------------|------------|---------------|--------------|
| **AgentCore Runtime** | $0.004/compute-sec + $0.10/GB-sec | $5 (30min/day) | $15 (1hr/day) | $45 (3hr/day) |
| **AgentCore Memory** | $0.015/1K ops + $0.25/GB-month | $1 (10MB) | $2 (100MB) | $5 (500MB) |
| **AgentCore Gateway** | $0.001/tool invocation | $0.50 (500 calls) | $1 (1K calls) | $5 (5K calls) |
| **Bedrock Models** | Variable (see below) | $5 (Nova Lite) | $13.50 (Sonnet) | $30 (Opus) |
| **DynamoDB** | On-demand | $1 | $2.50 | $5 |
| **S3** | $0.023/GB-month | $0.50 (1GB) | $1 (10GB) | $5 (50GB) |
| **Data Transfer** | $0.09/GB out | $0.20 (2GB) | $0.50 (5GB) | $2 (20GB) |
| **Total** | | **~$13/tenant** | **~$35/tenant** | **~$97/tenant** |

### Model Pricing (Input/Output per MTok)

| Model | Provider | Input | Output | Use Case |
|-------|----------|-------|--------|----------|
| **Nova Lite** | Amazon | $0.06 | $0.24 | Simple queries, high volume |
| **Sonnet 4.6** | Anthropic | $3 | $15 | Complex reasoning, coding |
| **Opus 4.6** | Anthropic | $15 | $75 | Maximum intelligence, critical tasks |
| **Nova Pro** | Amazon | $0.80 | $3.20 | Balanced performance/cost |

### Cost Optimization Strategies

1. **Model routing by complexity** — Route simple queries to Nova Lite, complex to Sonnet
2. **Memory tier optimization** — Basic = SUMMARY only, Premium = all 3 strategies
3. **Session idle timeout** — Basic = 5min, Premium = 30min
4. **Tool invocation caching** — Cache frequent tool results (weather, exchange rates)
5. **Batch operations** — Group multiple tenant operations in single Runtime session

---

## References

### Research Documents (This Guide Synthesizes)

1. [[01-AgentCore-Architecture-Runtime]] (969 lines) — 9 managed services, MicroVM isolation
2. [[02-AgentCore-APIs-SDKs-MCP]] (1,707 lines) — 60+ API actions, Python/TS SDKs
3. [[03-AgentCore-Multi-Tenancy-Deployment]] (1,223 lines) — Silo/Pool/Hybrid patterns
4. [[04-Strands-Agents-Core]] (1,351 lines) — Agent loop, tool system, 13+ providers
5. [[05-Strands-Advanced-Memory-MultiAgent]] (1,745 lines) — 4 multi-agent patterns, A2A
6. [[06-AWS-Services-Agent-Infrastructure]] (658 lines) — 15 AWS services for platforms
7. [[07-Vercel-AI-SDK-Chat-Layer]] (1,760 lines) — Multi-platform chat integration
8. [[08-IaC-Patterns-Agent-Platforms]] (749 lines) — CDK/OpenTofu/Pulumi patterns
9. [[09-Multi-Provider-LLM-Support]] (686 lines) — 17 providers, LiteLLM, cross-region

### Validation Analysis

- [[01-agentcore-strands-bedrock]] — Comprehensive validation of Chimera vs AgentCore

### Architecture Decision Records

- [[ADR-007-agentcore-microvm]] — AgentCore MicroVM over ECS/Lambda
- [[ADR-003-strands-agent-framework]] — Strands as primary framework
- [[ADR-016-agentcore-memory-strategy]] — AgentCore Memory (STM+LTM)

### External References

| Resource | URL |
|----------|-----|
| AgentCore Documentation | https://docs.aws.amazon.com/bedrock/latest/userguide/agents-agentcore.html |
| Strands Agents (Python) | https://github.com/strands-agents/sdk-python |
| Strands Agents (TypeScript) | https://github.com/strands-agents/sdk-typescript |
| AgentCore Python SDK | https://pypi.org/project/bedrock-agentcore |
| CDK AgentCore Alpha | https://www.npmjs.com/package/@aws-cdk/aws-bedrock-agentcore-alpha |
| AgentCore Starter Toolkit | https://github.com/awslabs/bedrock-agentcore-starter-toolkit |
| Vercel AI SDK | https://github.com/vercel/ai |
| Multi-Tenant Prescriptive Guidance | https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-multitenant/ |

---

**Document Status:** Ready for Implementation
**Next Steps:**
1. Review with leads (lead-arch, lead-data, lead-infra, lead-security)
2. Resolve P0 decisions (endpoint routing, memory namespaces, S3 workspace)
3. Proceed to Phase 1 implementation (Week 3-4)

**Feedback:** Send to `lead-research-aws` or open issue in Seeds tracker
