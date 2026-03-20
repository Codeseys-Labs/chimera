# Chimera Architecture Guide

> A practical guide to Chimera's architecture for developers building on or deploying the platform.

**Audience:** Developers, not architects. This guide focuses on how things work, not why they were designed this way.

**Note:** For architectural decision rationale, see the [research docs](../research/architecture-reviews/Chimera-Definitive-Architecture.md).

---

## What Is Chimera?

Chimera is an **Agent-as-a-Service platform** running on AWS where:

- **Tenants** (organizations) deploy AI agents that interact across 23+ channels (Slack, Teams, Discord, Telegram, WhatsApp, Web, etc.)
- **Agents** autonomously use skills, tools, memory, and subagents to accomplish tasks
- **The platform** continuously improves itself through prompt A/B testing, auto-skill generation, model routing optimization, and self-modifying infrastructure
- **Everything** runs on AWS managed services with MicroVM isolation for security

### Key Capabilities

| Feature | Implementation |
|---------|---------------|
| **Multi-channel chat** | Vercel AI SDK + Slack/Teams/Discord/Telegram/WhatsApp/Web adapters |
| **Agent runtime** | AWS Bedrock AgentCore Runtime + Strands agents (Python) |
| **Skills & tools** | SKILL.md format + MCP protocol + 1,000+ community MCP servers |
| **Memory** | AgentCore Memory (short-term + long-term with semantic search) |
| **Multi-tenancy** | MicroVM isolation + DynamoDB partitions + S3 prefixes + IAM roles |
| **Self-evolution** | Prompt A/B testing, auto-skill generation, model routing, memory optimization |
| **Security** | 8-layer defense, Cedar policies, Ed25519 signatures, 7-stage skill pipeline |
| **Infrastructure** | 11 AWS CDK stacks (TypeScript), self-modifying IaC capability |

### What Chimera Preserves from OpenClaw

Chimera maintains OpenClaw's core philosophy while adding enterprise features:

| OpenClaw | Chimera |
|----------|---------|
| 4-tool minimalism (read/write/edit/bash) | Same 4 tools in Strands agent |
| SKILL.md format | SKILL.md v2 (backward-compatible) |
| Skills = MCP servers | AgentCore Gateway routes to MCP servers |
| 23+ chat channels | Vercel Chat SDK (native multi-platform) |
| MEMORY.md persistence | AgentCore Memory (STM + LTM) |
| Self-editing agents | Self-modifying IaC via GitOps |
| Multi-agent orchestration | Strands Swarm/Graph/Workflow + Agent-to-Agent protocol |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Users (Multi-Channel)                    │
│  Slack • Teams • Discord • Telegram • WhatsApp • Web        │
└─────────────────────┬───────────────────────────────────────┘
                      │
          ┌───────────▼───────────┐
          │   Chat Gateway (ECS)  │
          │   Vercel AI SDK       │
          │   + SSE Bridge        │
          └───────────┬───────────┘
                      │ HTTPS / WebSocket
          ┌───────────▼───────────┐
          │   API Gateway         │
          │   + Cognito Auth      │
          │   + WAF               │
          └───────────┬───────────┘
                      │ JWT → Tenant Router
          ┌───────────▼────────────────────────┐
          │    AgentCore Runtime (MicroVMs)    │
          │  ┌──────┐  ┌──────┐  ┌──────┐     │
          │  │Tenant│  │Tenant│  │ Cron │     │
          │  │  A   │  │  B   │  │ Jobs │     │
          │  │(Strands)│(Strands)│      │     │
          │  └───┬──┘  └───┬──┘  └───┬──┘     │
          └──────┼─────────┼─────────┼─────────┘
                 │         │         │
     ┌───────────┴─────────┴─────────┴─────────┐
     │                                          │
┌────▼────┐  ┌────────┐  ┌──────────┐  ┌──────▼──┐
│AgentCore│  │AgentCore│  │AgentCore │  │AgentCore│
│ Memory  │  │ Gateway │  │   Code   │  │ Browser │
│(STM+LTM)│  │  (MCP)  │  │Interpreter│  │  (CDP)  │
└────┬────┘  └────┬───┘  └─────┬────┘  └─────────┘
     │            │             │
┌────▼────┐  ┌────▼─────┐  ┌───▼──────┐
│   S3    │  │ DynamoDB │  │  Skills  │
│ Buckets │  │6 Tables  │  │ (S3+DDB) │
└─────────┘  └──────────┘  └──────────┘
```

**Flow:**
1. User sends message via Slack/Teams/Discord/etc.
2. Chat Gateway receives message, resolves tenant from user identity
3. API Gateway validates JWT (Cognito), routes to tenant's AgentCore Runtime
4. AgentCore Runtime spawns ephemeral MicroVM running Strands agent
5. Agent processes message using tools (read/write/edit/bash + skills + MCP tools)
6. Agent accesses Memory for context, Gateway for external tools
7. Response streams back through SSE Bridge → Chat Gateway → user's platform

---

## Core Components

### 1. Agent Runtime (Pillar 1)

**What it is:** AWS Bedrock AgentCore Runtime provides MicroVM execution environments (Firecracker) for running Strands agents.

**Key files:**
- `packages/core/src/agent.py` — Strands agent definition
- `packages/core/src/runtime/` — AgentCore integration
- `infra/lib/tenant-onboarding-stack.ts` — AgentCore Runtime CDK resources

**How it works:**

```python
# packages/core/src/agent.py (simplified)
from strands import Agent
from strands.models.bedrock import BedrockModel
from bedrock_agentcore.runtime import BedrockAgentCoreApp, entrypoint
from bedrock_agentcore.memory import MemorySessionManager

app = BedrockAgentCoreApp()

@entrypoint
async def handle(context):
    tenant_id = context.session.attributes["tenant_id"]

    agent = Agent(
        model=BedrockModel("anthropic.claude-4-sonnet-v2"),
        system_prompt=load_tenant_prompt(tenant_id),
        tools=[
            read_file, write_file, edit_file, shell,  # 4-tool minimalism
            *load_skills(tenant_id),                   # Tenant-installed skills
            *load_mcp_tools(tenant_id),                # MCP Gateway tools
        ],
        session_manager=MemorySessionManager(
            namespace=f"tenant-{tenant_id}",
            strategies=["SUMMARY", "SEMANTIC_MEMORY", "USER_PREFERENCE"]
        ),
    )

    return agent(context.input_text)
```

**Isolation:**
- Each session runs in isolated MicroVM (no container escape)
- Tenants on "Pool" tier share compute, "Silo" tier gets dedicated runtime
- Active-consumption billing: only pay when agent is working (I/O wait is free)

**Deployment:**
- Docker image pushed to ECR: `chimera-agent-runtime:{version}`
- Two endpoints per runtime: `production` (stable) and `canary` (5% traffic)
- Cold start < 2 seconds

---

### 2. Multi-Platform Chat (Pillar 2)

**What it is:** ECS Fargate service running Express/Fastify with Vercel AI SDK Chat adapters. Translates between platform-specific protocols (Slack Events API, Discord Gateway, etc.) and AgentCore's streaming protocol.

**Key files:**
- `packages/chat-gateway/` — Chat adapters for each platform
- `packages/sse-bridge/` — Translates AgentCore streaming → Vercel Data Stream Protocol
- `infra/lib/chat-stack.ts` — ECS Fargate + ALB CDK resources

**How it works:**

```typescript
// packages/chat-gateway/src/index.ts (simplified)
import { Bot } from 'chat';
import { SlackAdapter, TeamsAdapter, DiscordAdapter } from 'chat/adapters';
import { streamSSEToAgent } from '@chimera/sse-bridge';

const bot = new Bot({
  adapters: [
    new SlackAdapter({ token: process.env.SLACK_TOKEN }),
    new TeamsAdapter({ appId: process.env.TEAMS_APP_ID }),
    new DiscordAdapter({ token: process.env.DISCORD_TOKEN }),
    // ... 20+ more adapters
  ],
});

bot.on('message', async (thread) => {
  // Resolve tenant from platform user ID
  const tenant = await resolveTenant(thread.platformUserId);

  // Invoke AgentCore Runtime endpoint
  const agentStream = await invokeAgentCore({
    tenantId: tenant.id,
    message: thread.text,
    sessionId: thread.threadId,
  });

  // Stream response back to user's platform
  await thread.post(streamSSEToAgent(agentStream));
});
```

**Features:**
- JSX cards render natively on each platform (Slack blocks, Discord embeds, etc.)
- Cross-platform identity linking (Slack user = Discord user = Web user)
- SSE Bridge translates AgentCore `StreamEvent` → Data Stream Protocol

**Deployment:**
- ECS Fargate service behind ALB (public subnets)
- Auto-scaling: 2-10 tasks based on CPU/memory
- Health checks via `/health` endpoint

---

### 3. Skill Ecosystem (Pillar 3)

**What it is:** A marketplace of reusable agent capabilities packaged as SKILL.md files, distributed via S3, registered in DynamoDB, and exposed through AgentCore Gateway as MCP servers.

**Key files:**
- `packages/core/src/skills/` — Skill registry, installer, scanner services
- `packages/shared/src/types/skill.ts` — SKILL.md v2 TypeScript types
- `infra/lib/skill-pipeline-stack.ts` — 7-stage security pipeline CDK resources
- `skills/` — Built-in platform skills

**SKILL.md v2 format:**

```yaml
---
name: code-review
version: 2.1.0
description: Review code for bugs, security issues, and style violations
author: platform
tags: [code-quality, security, linting]
trust_level: platform  # platform | verified | community | private | experimental
permissions:
  files: read
  network: none
  tools: [read_file, analyze_code]
dependencies:
  skills: [syntax-checker]
  mcp_servers: []
mcp_server: true  # Exposed as MCP server
tests:
  - input: "Review this Python function"
    expect_tools: [read_file]
    expect_no_errors: true
---

# Code Review Skill

When asked to review code:
1. Read the file(s) using `read_file`
2. Analyze syntax, logic, security, style
3. Return findings as structured report
```

**5-tier trust model:**

| Trust Level | Description | Examples |
|-------------|-------------|----------|
| **Platform** | Built by Chimera team, pre-installed | `code-review`, `web-search`, `file-manager` |
| **Verified** | Community skills passing rigorous review + Ed25519 signed | `stripe-payments`, `github-integration` |
| **Community** | Public marketplace, sandboxed execution | Most skills |
| **Private** | Tenant-authored, tenant-scoped | Custom business logic |
| **Experimental** | Alpha/beta, explicit opt-in required | New features |

**7-stage security pipeline (ClawHavoc-informed):**

1. **Static analysis** — AST scanning for suspicious patterns
2. **Dependency audit** — Check npm/pip packages against OSV database
3. **Sandbox execution** — Run tests in OpenSandbox MicroVM
4. **Permission validation** — Verify skill only requests declared permissions
5. **Ed25519 signing** — Cryptographically sign verified skills
6. **Runtime monitoring** — CloudWatch alarms on anomalous behavior
7. **Community reporting** — Users can flag malicious skills

**How skills are installed:**

```typescript
// Tenant installs a skill
await skillRegistry.installSkill({
  tenantId: 'acme',
  skillName: 'code-review',
  version: '2.1.0',
});

// DynamoDB `chimera-skills` table gets new item:
// PK: TENANT#acme, SK: SKILL#code-review
// Attributes: { version, s3Key, mcpEndpoint, trustLevel, ... }

// DynamoDB stream triggers Lambda → EventBridge → AgentCore Gateway reload
// Next agent invocation includes code-review in available tools
```

---

### 4. Self-Evolution Engine (Pillar 4)

**What it is:** Chimera's defining feature — the platform continuously improves itself through feedback loops, A/B testing, and self-modifying infrastructure.

**Key files:**
- `packages/core/src/evolution/` — Evolution services (prompt, skill, model, memory)
- `infra/lib/evolution-stack.ts` — A/B testing, auto-skill gen, routing optimization CDK
- `infra/lib/orchestration-stack.ts` — Cron self-scheduling

**Evolution systems:**

| System | What It Does | Guardrail |
|--------|--------------|-----------|
| **Prompt evolution** | A/B tests system prompts, promotes winner | Max 5 experiments/week/tenant, Thompson sampling |
| **Auto-skill generation** | Detects repeated tool sequences → generates skill | Sandbox test + security scan before publish |
| **Model routing** | Optimizes cost vs. quality per task type | Budget ceiling per tenant |
| **Memory evolution** | Lifecycle: active → hot → warm → cold → archived | Contradiction detection, max 10K facts/tenant |
| **Cron self-scheduling** | Detects temporal patterns → creates EventBridge rules | Cedar policy limits, max 20 cron jobs/tenant |
| **Self-modifying IaC** | Agent proposes CDK changes → GitOps PR → review | Cedar bounds, $50/mo infra budget limit |

**Example: Prompt A/B Testing**

```typescript
// packages/core/src/evolution/prompt-evolution.ts (simplified)
import { ThompsonSampling } from './thompson-sampling';

export class PromptEvolutionService {
  async selectPrompt(tenantId: string): Promise<string> {
    const experiments = await this.getActiveExperiments(tenantId);

    if (experiments.length === 0) {
      return this.getProductionPrompt(tenantId);
    }

    // Thompson sampling: balance explore vs. exploit
    const arm = ThompsonSampling.selectArm(experiments);

    return arm.prompt;
  }

  async recordOutcome(tenantId: string, promptId: string, success: boolean) {
    // Update Beta distribution parameters (alpha, beta)
    await this.updateExperimentStats(tenantId, promptId, success);

    // Promote winner if statistical significance reached
    if (await this.isWinner(promptId)) {
      await this.promoteToProduction(tenantId, promptId);
    }
  }
}
```

**Safety:** All self-evolution operations pass through `EvolutionSafetyHarness` which enforces:
- Rate limits (max N experiments per time window)
- Budget limits (max cost per experiment)
- Cedar policy checks (can this tenant do this?)
- Audit logging (every evolution event logged to DynamoDB)
- Rollback capability (S3 snapshots of previous state)

---

### 5. Multi-Tenant Isolation (Pillar 5)

**What it is:** Defense-in-depth isolation ensuring tenants cannot access each other's data, agents, or infrastructure.

**Key files:**
- `infra/lib/security-stack.ts` — Cognito, Cedar policies, KMS keys
- `infra/lib/tenant-onboarding-stack.ts` — Per-tenant resources
- `packages/core/src/auth/` — Authentication & authorization services

**Isolation layers:**

| Layer | Mechanism | Example |
|-------|-----------|---------|
| **Compute** | MicroVM per session | AgentCore Runtime MicroVM = tenant boundary |
| **State** | DynamoDB partition keys | PK = `TENANT#{id}`, FilterExpression on GSI queries |
| **Storage** | S3 prefixes + IAM policies | `s3://chimera-data/tenants/{tenantId}/...` |
| **Memory** | AgentCore Memory namespaces | `namespace = tenant-{tenantId}-user-{userId}` |
| **Policy** | Cedar policies scoped to tenant | `permit(principal == Tenant::"acme", ...)` |
| **Network** | Security groups per tier | Silo tenants get dedicated VPC |
| **Auth** | Cognito user pool groups | JWT claim: `custom:tenant_id` |
| **Billing** | CloudWatch Logs per tenant | Logs tagged with `tenantId` dimension |

**Tenant tiers:**

| Tier | Compute | Data Plane | Monthly Cost |
|------|---------|------------|--------------|
| **Pool** (standard) | Shared AgentCore Runtime | Shared DDB/S3 (partition-isolated) | $16 |
| **Hybrid** (pro) | Dedicated AgentCore endpoint | Shared DDB/S3 | $82 |
| **Silo** (enterprise) | Dedicated everything (VPC, Runtime, DDB, S3) | Isolated DDB/S3 | $326 |

**Critical pattern: GSI queries must filter by tenantId**

```typescript
// ❌ WRONG: GSI query without FilterExpression leaks data across tenants
const result = await ddb.query({
  IndexName: 'GSI2',
  KeyConditionExpression: 'status = :status',
  ExpressionAttributeValues: { ':status': 'ACTIVE' }
});

// ✅ CORRECT: Always add FilterExpression for tenantId
const result = await ddb.query({
  IndexName: 'GSI2',
  KeyConditionExpression: 'status = :status',
  FilterExpression: 'tenantId = :tid',
  ExpressionAttributeValues: {
    ':status': 'ACTIVE',
    ':tid': tenantId  // <-- CRITICAL
  }
});
```

---

## Package Structure

```
chimera/
├── packages/
│   ├── shared/              # @chimera/shared
│   │   ├── src/types/       # TypeScript types (Tenant, Session, Skill, etc.)
│   │   ├── src/utils/       # Shared utilities
│   │   └── src/constants/   # Constants, enums
│   │
│   ├── core/                # @chimera/core
│   │   ├── src/agent.py     # Strands agent entrypoint
│   │   ├── src/runtime/     # AgentCore Runtime integration
│   │   ├── src/skills/      # Skill registry, installer, scanner
│   │   ├── src/tenant/      # Tenant, quota, rate limit, cost tracking services
│   │   ├── src/evolution/   # Self-evolution services
│   │   └── src/auth/        # Auth services
│   │
│   ├── sse-bridge/          # @chimera/sse-bridge
│   │   ├── src/bridge.ts    # AgentCore StreamEvent → Data Stream Protocol
│   │   └── src/types.ts     # Bridge types
│   │
│   └── chat-gateway/        # @chimera/chat-gateway
│       ├── src/index.ts     # Express/Fastify server
│       ├── src/adapters/    # Platform adapters (Slack, Teams, Discord, etc.)
│       └── src/bot.ts       # Bot orchestration
│
├── infra/                   # AWS CDK infrastructure
│   ├── lib/
│   │   ├── network-stack.ts              # VPC, subnets, NAT, security groups
│   │   ├── data-stack.ts                 # DynamoDB (6 tables), S3 (3 buckets)
│   │   ├── security-stack.ts             # Cognito, Cedar, WAF, KMS
│   │   ├── observability-stack.ts        # CloudWatch dashboards, X-Ray
│   │   ├── api-stack.ts                  # API Gateway (HTTP API + WebSocket)
│   │   ├── chat-stack.ts                 # Chat Gateway ECS Fargate
│   │   ├── skill-pipeline-stack.ts       # 7-stage security pipeline
│   │   ├── tenant-onboarding-stack.ts    # Per-tenant AgentCore Runtime
│   │   ├── evolution-stack.ts            # A/B testing, auto-skills, routing
│   │   ├── orchestration-stack.ts        # EventBridge cron, Step Functions
│   │   └── pipeline-stack.ts             # CI/CD (CodePipeline, CodeBuild)
│   │
│   ├── constructs/
│   │   ├── tenant-agent.ts               # L3: full tenant agent stack (15+ resources)
│   │   └── agent-observability.ts        # L3: per-tenant CloudWatch dashboard
│   │
│   └── chimera.ts           # CDK app entrypoint
│
├── skills/                  # Built-in platform skills
│   ├── code-review/
│   ├── web-search/
│   ├── file-manager/
│   └── ...
│
├── tests/
│   ├── unit/                # Fast, isolated unit tests
│   ├── integration/         # Multi-component integration tests
│   ├── e2e/                 # Full system end-to-end tests
│   └── load/                # Load testing (K6)
│
└── docs/
    ├── guide/               # Developer guides (this file!)
    ├── research/            # Research docs (30k+ lines)
    └── runbooks/            # Operational procedures
```

**Key package exports:**

- `@chimera/shared` → ~100+ types, constants, utilities used across all packages
- `@chimera/core` → Agent runtime, skills, tenant services, evolution
- `@chimera/sse-bridge` → Streaming translation layer
- `@chimera/chat-gateway` → Multi-platform chat adapters

---

## Infrastructure (CDK Stacks)

Chimera uses **11 AWS CDK stacks** following separation-of-concerns:

| Stack | Purpose | Resources |
|-------|---------|-----------|
| **NetworkStack** | Networking foundation | VPC (3 tiers: public, private, isolated), 9 VPC endpoints, NAT Gateway, Security Groups |
| **DataStack** | State storage | 6 DynamoDB tables, 3 S3 buckets (skills, data, artifacts) |
| **SecurityStack** | Identity & policies | Cognito User Pool, Cedar policy store, WAF WebACL, KMS keys |
| **ObservabilityStack** | Monitoring | CloudWatch dashboards, X-Ray tracing groups, SNS alarm topics |
| **ApiStack** | API layer | API Gateway (HTTP API + WebSocket), Cognito authorizer, Lambda integrations |
| **ChatStack** | Chat gateway | ECS Fargate (2 services), ALB, Target Groups, auto-scaling |
| **SkillPipelineStack** | Skill security | 7-stage pipeline: CodeBuild, Lambda, Step Functions |
| **TenantOnboardingStack** | Tenant provisioning | AgentCore Runtime endpoints, IAM roles, Step Functions workflow |
| **EvolutionStack** | Self-improvement | A/B testing infra, auto-skill Lambda, model routing DynamoDB tables |
| **OrchestrationStack** | Cron & workflows | EventBridge Scheduler, Step Functions, SQS queues |
| **PipelineStack** | CI/CD | CodePipeline, CodeBuild, canary deployments |

**Stack dependencies:**

```
NetworkStack (foundation)
    ↓
DataStack, SecurityStack, ObservabilityStack (parallel)
    ↓
ApiStack, ChatStack, SkillPipelineStack (parallel)
    ↓
TenantOnboardingStack, EvolutionStack, OrchestrationStack (parallel)
    ↓
PipelineStack (deployment)
```

**L3 Construct Pattern:**

Reusable multi-resource abstractions encapsulate common patterns:

```typescript
// infra/constructs/tenant-agent.ts
export class TenantAgent extends Construct {
  constructor(scope: Construct, id: string, props: TenantAgentProps) {
    super(scope, id);

    // 15+ resources: AgentCore Runtime, IAM role, S3 bucket,
    // DynamoDB items, Cedar policies, CloudWatch dashboard, etc.
    // Enforces multi-tenant isolation by default
  }
}
```

---

## Data Model (DynamoDB)

Chimera uses **6 DynamoDB tables** for multi-tenant state:

### 1. `chimera-tenants`

**Purpose:** Tenant configuration and profile data

| Key | Type | Description |
|-----|------|-------------|
| PK | `TENANT#{id}` | Partition key |
| SK | `PROFILE` \| `CONFIG#features` \| `CONFIG#models` \| `BILLING#current` \| `BILLING#history` \| `QUOTA#monthly` | Sort key (multiple items per tenant) |

**GSIs:**
- GSI1: `tier` → `tenantId` (query tenants by tier)
- GSI2: `status` → `tenantId` (query by lifecycle state: PROVISIONING, ACTIVE, SUSPENDED)

**Attributes:** `tier`, `modelId`, `allowedSkills`, `budgetLimitMonthlyUsd`, `featureFlags`, `createdAt`, `updatedAt`

---

### 2. `chimera-sessions`

**Purpose:** Active agent sessions (ephemeral, 24h TTL)

| Key | Type | Description |
|-----|------|-------------|
| PK | `TENANT#{id}` | Partition key |
| SK | `SESSION#{id}` | Sort key |
| TTL | `ttl` (Number) | Auto-delete after 24 hours |

**GSIs:**
- GSI1: `agentId` → `lastActivity` (find active sessions for an agent)
- GSI2: `userId` → `lastActivity` (find user's sessions across devices)

**Attributes:** `sessionId`, `agentId`, `state` (messages, tool_calls, memory), `channelType`, `channelUserId`, `createdAt`, `lastActivity`

---

### 3. `chimera-skills`

**Purpose:** Installed skills per tenant + marketplace catalog

| Key | Type | Description |
|-----|------|-------------|
| PK | `TENANT#{id}` \| `SKILL#{name}` | Partition key (tenant items or marketplace items) |
| SK | `SKILL#{name}` \| `VERSION#{semver}` | Sort key |

**GSIs:**
- GSI1: `skillName` → `tenantId` (find which tenants use a skill)
- GSI2: `trustLevel` → `popularity` (marketplace ranking)

**Attributes:** `skillName`, `version`, `s3Key`, `mcpEndpoint`, `trustLevel`, `signatureEd25519`, `installedAt`, `lastUsed`, `invocationCount`

---

### 4. `chimera-rate-limits`

**Purpose:** Token bucket state for rate limiting (5min TTL)

| Key | Type | Description |
|-----|------|-------------|
| PK | `TENANT#{id}` | Partition key |
| SK | `WINDOW#{timestamp}` | Sort key (1-minute window start) |
| TTL | `ttl` (Number) | Auto-delete after 5 minutes |

**Attributes:** `requestCount`, `tokenCount`, `budgetConsumedUsd`

---

### 5. `chimera-cost-tracking`

**Purpose:** Monthly cost accumulation (2yr TTL)

| Key | Type | Description |
|-----|------|-------------|
| PK | `TENANT#{id}` | Partition key |
| SK | `MONTH#{YYYY-MM}` | Sort key |

**Attributes:** `month`, `totalCostUsd`, `breakdown` (Map: agentcore, llm, dynamodb, s3), `invoiceGenerated`, `ttl`

---

### 6. `chimera-audit`

**Purpose:** Security events and compliance logs (90d-7yr TTL)

| Key | Type | Description |
|-----|------|-------------|
| PK | `TENANT#{id}` | Partition key |
| SK | `EVENT#{timestamp}#{eventId}` | Sort key |
| TTL | `ttl` (Number) | Varies by event type: 90d (INFO), 1yr (WARN), 7yr (CRITICAL) |

**Encryption:** KMS CMK (customer-managed key)

**Attributes:** `eventType`, `principal`, `action`, `resource`, `decision`, `cedarpolicyId`, `timestamp`

---

## Request Flow: User Message → Agent Response

Let's trace a Slack message through Chimera:

```
1. User sends message in Slack
   Message: "@my-bot review src/app.py for security issues"

2. Slack Events API webhook → Chat Gateway (ECS)
   POST /slack/events
   Body: { type: "message", text: "@my-bot ...", user: "U123", channel: "C456" }

3. Chat Gateway resolves tenant
   SlackAdapter extracts user ID "U123"
   DynamoDB query: chimera-tenants table
   Find tenant with Slack user mapping: "U123" → tenantId "acme"

4. Chat Gateway invokes AgentCore Runtime endpoint
   POST https://agentcore.us-west-2.amazonaws.com/invoke
   Headers: { Authorization: "Bearer <cognito-jwt>", X-Tenant-Id: "acme" }
   Body: { message: "review src/app.py ...", sessionId: "sess-789" }

5. API Gateway validates JWT → routes to AgentCore Runtime
   Cognito authorizer extracts custom:tenant_id claim
   Forwards to AgentCore Runtime with tenant context

6. AgentCore Runtime spawns MicroVM
   Pull Docker image: chimera-agent-runtime:2.1.0
   Launch Firecracker MicroVM with tenant's IAM role
   Entrypoint: packages/core/src/agent.py

7. Strands agent loads tenant configuration
   DynamoDB query: chimera-tenants PK=TENANT#acme, SK=CONFIG#features
   Load system prompt, model (claude-4-sonnet), allowed skills

8. Agent processes message
   Parse intent: "review src/app.py for security issues"
   Select tools: [read_file, code-review skill]

   Tool call 1: read_file("src/app.py")
     → AgentCore Runtime reads from S3: s3://chimera-data/tenants/acme/files/src/app.py

   Tool call 2: code-review({ file: "src/app.py", content: "..." })
     → AgentCore Gateway routes to MCP server: chimera-skills/code-review
     → Code review skill runs (Lambda or containerized MCP server)
     → Returns: { findings: [...], severity: "medium" }

9. Agent synthesizes response
   LLM call (Bedrock Claude 4): "Here are 3 security issues found..."
   AgentCore Memory stores conversation: SUMMARY strategy

10. Response streams back through SSE Bridge
    AgentCore StreamEvent → Data Stream Protocol
    SSE Bridge converts: { type: "text-delta", delta: "Here are..." }

11. Chat Gateway receives stream → posts to Slack
    SlackAdapter formats as Slack message
    POST https://slack.com/api/chat.postMessage
    Body: { channel: "C456", text: "Here are 3 security issues...", blocks: [...] }

12. User sees response in Slack thread
    Message appears with formatted findings (buttons, code blocks, etc.)
```

**Latency breakdown:**
- Chat Gateway → API Gateway: ~20ms
- API Gateway → AgentCore: ~30ms
- MicroVM cold start: <2s (warm start: ~100ms)
- Agent processing: 2-10s (depends on LLM, tool calls)
- SSE streaming: ~50ms overhead
- Total: ~3-12s end-to-end

---

## Development Workflow

### Local Development

```bash
# 1. Clone repo
git clone https://github.com/your-org/chimera.git
cd chimera

# 2. Install dependencies (Bun)
bun install

# 3. Build packages
bun run build  # Builds shared → core → sse-bridge → chat-gateway → infra

# 4. Run tests
bun test                   # Run all tests
bun run test:integration   # Integration tests only
bun run test:e2e          # End-to-end tests (requires AWS credentials)

# 5. Run local dev server (chat gateway)
cd packages/chat-gateway
bun run dev  # Hot reload enabled

# 6. Deploy to AWS
cd infra
cdk deploy --all  # Deploy all stacks
# Or deploy specific stack:
cdk deploy ChimeraDataStack
```

### Adding a New Skill

```bash
# 1. Create skill directory
mkdir -p skills/my-skill

# 2. Write SKILL.md
cat > skills/my-skill/SKILL.md << EOF
---
name: my-skill
version: 1.0.0
description: Does something useful
author: your-name
tags: [utility]
trust_level: community
permissions:
  files: read
  network: https://api.example.com
mcp_server: false
---

# My Skill

When the user asks to do X, you should...
EOF

# 3. (Optional) Add MCP server implementation
# If mcp_server: true, create skills/my-skill/server.py or server.ts

# 4. Test skill locally
bun run test:skill skills/my-skill

# 5. Deploy to S3 + register in DynamoDB
bun run deploy:skill my-skill --tenant=acme
```

### Adding a New CDK Stack

```typescript
// infra/lib/my-new-stack.ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class MyNewStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Add resources here
  }
}

// infra/chimera.ts
import { MyNewStack } from './lib/my-new-stack';

const app = new cdk.App();

// ... existing stacks ...

new MyNewStack(app, 'ChimeraMyNewStack', {
  env: { account: '123456789012', region: 'us-west-2' },
});
```

### Running Quality Gates

```bash
# Before committing:
bun test           # All tests must pass
bun run lint       # Zero ESLint errors
bun run typecheck  # No TypeScript errors

# CI/CD pipeline runs these + integration/e2e tests
```

---

## Key Patterns & Conventions

### 1. Multi-Tenant Isolation

**Always partition by tenantId:**

```typescript
// ❌ WRONG
await ddb.query({ IndexName: 'GSI1', KeyConditionExpression: 'status = :s' });

// ✅ CORRECT
await ddb.query({
  IndexName: 'GSI1',
  KeyConditionExpression: 'status = :s',
  FilterExpression: 'tenantId = :tid',  // <-- Always filter on GSI
  ExpressionAttributeValues: { ':s': 'ACTIVE', ':tid': tenantId }
});
```

**Use tenant-scoped IAM policies:**

```typescript
// AgentCore Runtime IAM role limits S3 access to tenant prefix
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject"],
  "Resource": "arn:aws:s3:::chimera-data/tenants/${aws:PrincipalTag/TenantId}/*"
}
```

---

### 2. Error Handling

**Always return structured errors:**

```typescript
// ❌ WRONG
throw new Error('Failed to load skill');

// ✅ CORRECT
throw new ChimeraError({
  code: 'SKILL_LOAD_FAILED',
  message: 'Failed to load skill code-review',
  tenantId,
  skillName: 'code-review',
  httpStatus: 500,
  retryable: true,
});
```

**Log with context:**

```typescript
logger.error('Skill load failed', {
  tenantId,
  skillName,
  errorCode: 'SKILL_LOAD_FAILED',
  s3Key: skill.s3Key,
  // CloudWatch Logs Insights can query: fields @message | filter errorCode = "SKILL_LOAD_FAILED"
});
```

---

### 3. Streaming Responses

**Always stream agent responses (never buffer):**

```typescript
// ✅ CORRECT: Stream response chunks as they arrive
const stream = await invokeAgent(tenantId, message);
for await (const chunk of stream) {
  await sendToUser(chunk);  // Send immediately, don't buffer
}

// ❌ WRONG: Buffering defeats streaming benefits
const chunks = [];
for await (const chunk of stream) {
  chunks.push(chunk);
}
await sendToUser(chunks.join(''));  // User waits for full response
```

---

### 4. Cost Tracking

**Always attribute costs to tenants:**

```typescript
// After LLM call, record cost
await costTracker.recordCost({
  tenantId,
  service: 'bedrock',
  model: 'claude-4-sonnet',
  inputTokens: 1200,
  outputTokens: 450,
  costUsd: 0.0234,
  timestamp: new Date(),
});

// DynamoDB chimera-cost-tracking accumulates monthly totals
```

---

### 5. Cedar Policy Checks

**Always check Cedar policies before privileged operations:**

```typescript
// Before allowing agent to modify infrastructure
const decision = await cedarAuthorizer.isAuthorized({
  principal: { type: 'Tenant', id: tenantId },
  action: { type: 'Action', id: 'modify_infrastructure' },
  resource: { type: 'CDKStack', id: stackName },
});

if (decision === 'Deny') {
  throw new ForbiddenError('Cedar policy denied infrastructure modification');
}
```

---

## Next Steps

- **Deploy your first agent:** Follow the [Quickstart Guide](./quickstart.md)
- **Author a skill:** See [Skill Development Guide](./skills.md)
- **Deploy to AWS:** Refer to [Deployment Guide](./deployment.md)
- **Manage tenants:** Read [Multi-Tenant Guide](./multi-tenant.md)
- **Deep dive:** Explore [Research Docs](../research/architecture-reviews/Chimera-Definitive-Architecture.md)

---

*This guide consolidates 30,000+ lines of research across 28 documents produced by 30+ agents. For architectural rationale, see the [research directory](../research/).*
