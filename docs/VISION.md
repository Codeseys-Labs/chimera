# Chimera Vision

> **AWS-native rebuild of OpenClaw where agents operate AWS accounts instead of local computers**
>
> Multi-tenant. Self-evolving. Infrastructure-aware.
> Built on AWS Bedrock AgentCore with Strands framework.

---

## Table of Contents

1. [Identity & Core Differentiator](#identity--core-differentiator)
2. [Heritage: What We Learned](#heritage-what-we-learned)
3. [Architecture: AgentCore + Strands](#architecture-agentcore--strands)
4. [Multi-Tenant UTO Model](#multi-tenant-uto-model)
5. [Skill System Compatibility](#skill-system-compatibility)
6. [Self-Evolution](#self-evolution)
7. [Infrastructure as Capability](#infrastructure-as-capability)
8. [Multi-Modal Support](#multi-modal-support)
9. [Self-Reflection & Continuous Improvement](#self-reflection--continuous-improvement)
10. [Concurrent Execution](#concurrent-execution)

---

## Identity & Core Differentiator

**Chimera is an AWS-native rebuild of Anthropic's OpenClaw, where agents have access to AWS accounts instead of local computers.**

### The Fundamental Shift

```
OpenClaw:  Agent reads local files, runs shell commands, edits code
           → Operates on YOUR COMPUTER

Chimera:   Agent queries AWS Config, invokes Lambda, modifies DynamoDB
           → Operates on YOUR AWS ACCOUNT
```

This is not a minor variation. This is a **paradigm shift** in what agents can do:

| OpenClaw (Local Computer) | Chimera (AWS Account) |
|---------------------------|----------------------|
| `bash_tool("ls -la")` | `aws.resourceExplorer.search()` |
| `read_tool("/home/user/file.txt")` | `aws.s3.getObject()` |
| `write_tool("/tmp/output.json")` | `aws.dynamodb.putItem()` |
| `bash_tool("docker run")` | `aws.lambda.invoke()` |
| Edit local codebase | Generate CDK, commit to CodeCommit, deploy via CodePipeline |

**OpenClaw operates on files and processes. Chimera operates on infrastructure.**

### Why This Matters

1. **Enterprise Scale** — Multi-tenant from day one, not an afterthought
2. **Infrastructure Awareness** — Agents understand your entire AWS footprint
3. **Self-Modifying Infrastructure** — Agents generate and deploy their own tools
4. **Compliance-Ready** — Cedar policies, audit trails, per-tenant encryption
5. **Cloud-Native** — Built on AgentCore (AWS managed service), not Docker + SQLite

Chimera is what OpenClaw would be if it were designed for AWS instead of personal computers.

---

## Heritage: What We Learned

Chimera builds on proven patterns from three pioneering agent systems:

### OpenClaw (Anthropic) — 209k GitHub stars, personal assistant OS

**Architecture Lessons:**
- **Gateway + Pi Runtime** — Long-running daemon + minimal agent SDK
- **ReAct loop** — Proven agent execution pattern
- **SKILL.md format** — Markdown-based capability definitions with YAML frontmatter
- **4-tool minimalism** — Read, Write, Edit, Bash as universal primitives
- **Lane Queue** — Session serialization prevents tool/session races
- **Context compaction** — Auto-summarization at 85% context window
- **Memory architecture** — MEMORY.md + daily logs + SQLite vector search

**Critical Gap OpenClaw Doesn't Solve:**
- **NO MULTI-TENANCY** — Single-user design, all operators can see each other's data
- **Local filesystem only** — Memory stored in SQLite, sessions in JSONL files
- **Docker sandboxing** — Process-level isolation, not MicroVM
- **No infrastructure awareness** — Agent sees local computer, not cloud resources

### NemoClaw (NVIDIA) — OpenClaw with enterprise security

**What It Adds:**
- **Landlock LSM + seccomp** — Filesystem policies (write only `/sandbox` + `/tmp`)
- **Network policies** — Deny-by-default with explicit allowlist
- **OpenShell Gateway** — All inference routed through controlled gateway
- **Operator approval workflows** — Human-in-the-loop for sensitive operations

**What It Doesn't Change:**
- Still single-user, still local filesystem
- Sandboxing is a wrapper, not a redesign
- No multi-tenant isolation

### OpenFang (RightNow AI) — Rust-based agent OS

**Performance Insights:**
- **180ms cold start** — WASM sandbox, minimal runtime
- **16-layer security** — No shell access, no network in sandbox
- **Sub-200ms agent spawning** — Optimized for speed

**Trade-offs:**
- High operational burden (maintain Rust OS)
- Limited DX compared to Python/TypeScript frameworks

---

### Chimera's Contribution

**What Chimera Adds That Nobody Else Has:**

1. **Multi-Tenant from Day One**
   - DynamoDB with `tenantId` partition key + GSI FilterExpressions
   - Per-tenant KMS customer managed keys
   - Cedar policies for fine-grained authorization
   - IAM boundaries per tenant

2. **AWS Account Access Instead of Local Computer**
   - 25 core AWS services as agent tools across 4 tiers
   - AWS Config, Resource Explorer, CloudTrail for discovery
   - CodeCommit for self-modifying infrastructure
   - Well-Architected Framework as decision vocabulary

3. **AgentCore-Native Runtime**
   - MicroVM isolation (not Docker containers)
   - Managed memory with STM + LTM strategies
   - Gateway for MCP tool routing
   - Identity, Policy, Observability, Code Interpreter built-in

4. **UTO Model (User/Team/Org)**
   - Single installation, multi-tenant with access controls
   - Concurrent users within same tenant
   - Collaborative agent sessions via shared DynamoDB state

**We're not just building "OpenClaw for AWS." We're building the first multi-tenant, infrastructure-aware agent platform.**

---

## Architecture: AgentCore + Strands

Chimera is built on **AWS Bedrock AgentCore** (managed agent runtime) with **Strands Agents framework** (Python/TypeScript SDK).

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Chat Gateway (ECS)                        │
│  • Vercel AI SDK for multi-platform chat                    │
│  • Slack, Teams, Discord, Web, WhatsApp, Telegram           │
│  • WebSocket + SSE streaming                                 │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Tenant Router (Lambda)                          │
│  • Map tenantId → AgentCore endpoint ARN                    │
│  • Load tenant config from DynamoDB                          │
│  • Inject session attributes                                 │
└─────────────────────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌───────────────────────┐      ┌──────────────────────────────┐
│ Shared Endpoint       │      │ Dedicated Endpoint           │
│ (Pool: Basic/Advanced)│      │ (Silo: Premium)              │
└───────────────────────┘      └──────────────────────────────┘
          │                              │
          └──────────────┬───────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│               AgentCore Ecosystem (9 Services)               │
│  ┌──────────────┐ ┌─────────────┐ ┌────────────────────┐   │
│  │ Runtime      │ │ Memory      │ │ Gateway            │   │
│  │ (MicroVM)    │ │ (STM + LTM) │ │ (MCP routing)      │   │
│  └──────────────┘ └─────────────┘ └────────────────────┘   │
│  ┌──────────────┐ ┌─────────────┐ ┌────────────────────┐   │
│  │ Identity     │ │ Policy      │ │ Code Interpreter   │   │
│  │ (OAuth 2.0)  │ │ (Cedar)     │ │ (Python sandbox)   │   │
│  └──────────────┘ └─────────────┘ └────────────────────┘   │
│  ┌──────────────┐ ┌─────────────┐ ┌────────────────────┐   │
│  │Observability │ │ Browser     │ │ Evaluations        │   │
│  │(OTEL traces) │ │ (Playwright)│ │ (13 evaluators)    │   │
│  └──────────────┘ └─────────────┘ └────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│            Data Layer (6 DynamoDB Tables)                    │
│  • chimera-tenants      • chimera-sessions                   │
│  • chimera-skills       • chimera-rate-limits                │
│  • chimera-cost-tracking • chimera-audit                     │
└─────────────────────────────────────────────────────────────┘
```

### AgentCore Services Explained

| Service | Purpose | How Chimera Uses It |
|---------|---------|---------------------|
| **Runtime** | MicroVM-isolated agent execution | Strands agent runs in ephemeral MicroVM (15min-8hr lifetime) |
| **Memory** | STM + LTM with 4 strategies | Namespace: `tenant-{id}-user-{id}` for cross-tenant isolation |
| **Gateway** | MCP tool routing | Register skills as targets (Lambda, MCP Server, OpenAPI, Smithy) |
| **Identity** | OAuth 2.0 inbound auth | Cognito → JWT claims (tenantId, tier, userId) |
| **Policy** | Cedar policy enforcement | Tier-based tool access, resource boundaries |
| **Code Interpreter** | Python sandboxed execution | Run analysis scripts, data transformations |
| **Browser** | Playwright CDP integration | Web automation, screenshot capture, form filling |
| **Observability** | OTEL tracing | Per-tenant CloudWatch dashboards, latency/cost tracking |
| **Evaluations** | Agent quality assessment | 13 evaluators: accuracy, helpfulness, safety, latency |

### Strands Agent Framework

**Why Strands:**
- Model-driven (works with 13+ providers: Bedrock, OpenAI, Anthropic, Google, Mistral)
- Production-tested (used by AWS customers)
- Native AgentCore integration via `AgentCoreMemorySessionManager`
- Supports multi-agent patterns (supervisor, swarm, sequential, parallel)

**Example Strands agent:**
```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.tools import tool

@tool
def query_aws_resources(service: str, region: str) -> dict:
    """Query AWS resources using Resource Explorer."""
    return aws.resourceExplorer.search(query=f"service:{service} region:{region}")

agent = Agent(
    model=BedrockModel("us.anthropic.claude-sonnet-4-6-v1:0"),
    system_prompt="You are an AWS infrastructure expert",
    tools=[query_aws_resources],
    session_manager=AgentCoreMemorySessionManager(
        memory_id="chimera-memory-tenant-acme",
        namespace="tenant-acme-user-alice",
    ),
)

response = agent("What EC2 instances are running in us-east-1?")
```

### Deployment Model

Chimera agents are deployed as **Docker containers to ECR**, then referenced by AgentCore Runtime:

```typescript
// CDK: platform-runtime-stack.ts
const runtime = new agentcore.AgentRuntime(this, 'SharedRuntime', {
  name: 'chimera-shared-runtime',
  container: {
    imageUri: `${account}.dkr.ecr.${region}.amazonaws.com/chimera-agents:latest`,
  },
  lifecycle: {
    idleRuntimeSessionTimeout: Duration.minutes(15),
    maxSessionLifetime: Duration.hours(8),
  },
  network: {
    mode: NetworkMode.VPC,
    vpc: props.vpc,
  },
  authentication: {
    customJwtAuthorizer: {
      issuerUrl: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    },
  },
});
```

---

## Multi-Tenant UTO Model

**UTO = User / Team / Org**. Single Chimera installation serves multiple tenants with proper isolation.

### Tenant Tiers

| Tier | Compute | Memory | Concurrent Sessions | Monthly Cost |
|------|---------|--------|---------------------|--------------|
| **Basic** | Shared endpoint | Namespace isolation | 2 | ~$13/tenant |
| **Advanced** | Shared endpoint | Namespace isolation | 10 | ~$35/tenant |
| **Premium** | Dedicated endpoint | Dedicated memory resource | 100 | ~$97/tenant |

### Isolation Mechanisms

| Layer | Pool (Basic/Advanced) | Silo (Premium) |
|-------|-----------------------|----------------|
| **Compute** | Shared AgentCore endpoint | Dedicated endpoint per tenant |
| **Memory** | Namespace: `tenant-{id}-user-{id}` | Dedicated Memory resource |
| **Storage** | S3 prefix: `/tenants/{tenantId}/` | Dedicated S3 bucket |
| **Data** | Partition key: `PK=TENANT#{tenantId}` | Dedicated DynamoDB tables (optional) |
| **Network** | Shared VPC, per-tenant security group | Dedicated VPC (optional) |
| **Encryption** | Per-tenant KMS keys | Dedicated KMS keys |

### Concurrent & Collaborative Sessions

**Concurrent (same tenant, different users):**
```
User Alice: "Deploy a Lambda function"
User Bob:   "What's our S3 cost this month?"
```
Both run in parallel, accessing shared tenant state.

**Collaborative (same tenant, same conversation):**
```
Alice: "Start building a data lake"
  → Agent creates S3 buckets, Glue catalog, Athena tables

Bob:   "Add real-time ingestion to the data lake"
  → Agent reads Alice's infrastructure state, adds Kinesis + Firehose
```

Agents coordinate via:
- **DynamoDB state** — Cross-session reads for infrastructure discovery
- **AgentCore Memory** — Shared conversation history within tenant namespace
- **CodeCommit** — Git repository stores generated CDK

### Security Guarantees

1. **No cross-tenant data leakage**
   - All DynamoDB queries: `FilterExpression: tenantId = :tid`
   - All S3 operations: bucket policy enforces tenant prefix
   - AgentCore Memory: namespace isolation

2. **No privilege escalation**
   - Cedar policies: deny by default, allowlist per tenant
   - IAM boundaries: agents cannot assume cross-tenant roles

3. **Audit trail**
   - `chimera-audit` table logs all tenant actions (90d-7yr retention)
   - Per-tenant KMS encryption

4. **Cost attribution**
   - CloudWatch Logs → parse per-tenant token usage
   - `chimera-cost-tracking` table → monthly spend rollup

### Tenant Onboarding Flow

```
1. Create Cognito user pool group: tenant-{id}-users, tenant-{id}-admins
2. Create admin user with custom:tenantId attribute
3. Create AgentCore Memory resource (Basic/Advanced share one, Premium gets dedicated)
4. Initialize DynamoDB tenant profile (tier, features, allowedModels, monthlyBudget)
5. Set up rate limits (concurrent sessions, API calls/min)
6. Generate welcome email with login URL
```

**Automated via Step Function + Lambda.**

---

## Skill System Compatibility

Chimera supports **3 skill formats** with auto-generated adapters:

### 1. OpenClaw SKILL.md (Native Support)

```markdown
---
name: aws-cost-optimizer
description: Analyze AWS Cost Explorer and recommend savings
version: 2.1.0
user-invocable: true
---

# Instructions
You are an AWS cost optimization expert. Query Cost Explorer...
```

**Adapter:** Parse YAML frontmatter → load markdown as system prompt → expose as Strands tool

### 2. MCP Servers (via AgentCore Gateway)

```json
{
  "mcpServers": {
    "github": {
      "url": "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
      "env": { "GITHUB_TOKEN": "..." }
    }
  }
}
```

**Adapter:** Register as Gateway target (type: MCP_SERVER) → auto-discover tools → expose to agent

### 3. Strands @tool (Native)

```python
from strands.tools import tool

@tool
def analyze_s3_bucket(bucket_name: str) -> dict:
    """Analyze S3 bucket for cost optimization opportunities."""
    client = boto3.client('s3')
    # Implementation
    return {"cost": 123.45, "recommendations": [...]}
```

**No adapter needed — native Strands format.**

### 7-Stage Security Pipeline

Learned from ClawHavoc incident (1184 malicious skills, 3 CVEs):

```
1. Static Analysis    → AST scan for dangerous patterns (subprocess, eval, network)
2. Dependency Audit   → OSV database + npm audit + pip-audit
3. Signature Check    → GPG/Sigstore verification (tier 1+ only)
4. Cedar Policy Gen   → Auto-generate deny rules for unsafe operations
5. Sandbox Test       → Execute in isolated AgentCore MicroVM
6. Performance Test   → Measure token cost, latency, memory usage
7. Deployment         → Publish to DynamoDB skill registry
```

### Skill Registry (DynamoDB)

```python
# DynamoDB item: TENANT#acme / SKILL#code-review
{
    "PK": "TENANT#acme",
    "SK": "SKILL#code-review",
    "skillName": "code-review",
    "version": "2.1.0",
    "format": "mcp_server",  # or "skill_md" or "strands_tool"
    "gatewayTarget": {
        "type": "mcp_server",
        "endpoint": "https://skills.acme.com/code-review",
        "auth": "api_key"
    },
    "tier": 1,  # 0=core, 1=verified, 2=community, 3=experimental, 4=deprecated
    "securityPipeline": {
        "staticAnalysis": "passed",
        "dependencyAudit": "passed",
        "signatureCheck": "passed",
        "sandboxTest": "passed"
    }
}
```


---

## Self-Evolution

Chimera agents **create their own skills, tools, and subagents**.

### Auto-Skill Generation

When agents encounter repetitive patterns, they auto-generate skills:

```
Pattern Detection (3+ similar tasks):
- Session 1: User asks "What's our S3 cost?" → Agent manually queries Cost Explorer
- Session 2: User asks "What's our EC2 cost?" → Agent manually queries Cost Explorer
- Session 3: User asks "What's our RDS cost?" → Agent manually queries Cost Explorer

Action: Generate SKILL.md
---
name: aws-service-cost-query
description: Query AWS Cost Explorer for any service
version: 1.0.0
---

# Instructions
Query Cost Explorer for {service} in {timeRange}, return cost + trend + breakdown.

Deploy: Add to skill registry → test in sandbox → publish to tenant
```

### Evolution Safety Harness

Learned from OpenClaw's "do not copy yourself" warning:

```python
class EvolutionSafetyHarness:
    """Enforce constraints on self-modification."""

    def __init__(self):
        self.rate_limits = {
            'skill_creation': 5,  # per hour
            'policy_changes': 2,  # per day
            'infrastructure_changes': 10,  # per hour
        }
        self.approval_required = {
            'security_policy_changes': True,
            'cross_tenant_operations': True,
            'high_cost_operations': True,  # > $100
        }

    def can_evolve(self, operation: str) -> bool:
        if self.approval_required.get(operation):
            return self.human_in_the_loop_approval(operation)
        return self.check_rate_limit(operation)
```

### Cedar Policy Constraints

Agents operate within Cedar policy boundaries:

```cedar
// Policy: Agents can create skills but not modify security policies
permit(
  principal in TenantAgents,
  action == "skill:create",
  resource in Skill
) when {
  resource.tier <= 2 &&  // Community tier or lower
  resource.securityPipeline.passed == true
};

forbid(
  principal in TenantAgents,
  action == "policy:modify",
  resource in SecurityPolicy
);
```

### Canary Deployments

New skills/tools deployed via canary:

```
1. Deploy to 5% of sessions
2. Monitor: error rate, latency, cost
3. If stable after 24h → 25%
4. If stable after 48h → 100%
5. If errors detected → rollback
```

---

## Infrastructure as Capability

**Agents generate CDK, commit to CodeCommit, deploy via CodePipeline — fully autonomous infrastructure lifecycle.**

### Self-Modifying Infrastructure Flow

```
1. Agent analyzes need (e.g., "reduce S3 costs")
2. Agent queries AWS Config + Cost Explorer → identifies 50 buckets with no lifecycle policies
3. Agent generates CDK code:
   - packages/infra/lib/s3-lifecycle-stack.ts
   - Adds intelligent tiering + glacier transitions
4. Agent runs cdk synth → validates template
5. Agent runs cdk diff → shows 50 buckets will be modified
6. Agent commits to CodeCommit: feature/s3-lifecycle-optimization
7. CodePipeline triggers:
   - Stage 1: Build (bun install, bun test, bun run lint)
   - Stage 2: Manual Approval (human reviews diff)
   - Stage 3: Deploy (cdk deploy --require-approval never)
8. Agent monitors CloudWatch → verifies cost reduction
9. Agent documents: ADR + monthly cost report
```

### AWS Account Access: 25 Core Services

Agents have tools for **25 AWS services across 4 tiers**:

**Tier 1: Core Compute & Storage**
- EC2, Lambda, ECS, S3, EBS, EFS

**Tier 2: Data & Analytics**
- RDS, DynamoDB, Redshift, Athena, Glue, Kinesis

**Tier 3: Application Integration**
- API Gateway, EventBridge, Step Functions, SQS, SNS

**Tier 4: Security & Management**
- IAM, CloudWatch, X-Ray, CloudTrail, Config, Systems Manager

### Discovery Triad

Agents discover AWS resources via 3 complementary services:

| Service | Strength | Use Case |
|---------|----------|----------|
| **AWS Config** | Comprehensive history + compliance | "Show me all RDS instances created last month" |
| **Resource Explorer** | Fast cross-region search | "Find all untagged EC2 instances" |
| **CloudTrail** | API activity logs | "Who deleted the S3 bucket yesterday?" |

### Well-Architected Decision Framework

Agents use **AWS Well-Architected Framework's 6 pillars** when making infrastructure decisions:

```
User: "Deploy a web app"

Agent reasoning (explicit in response):
1. Operational Excellence → ECS Fargate (managed, auto-scaling)
2. Security → ALB + WAF + VPC isolation
3. Reliability → Multi-AZ deployment + health checks
4. Performance Efficiency → CloudFront CDN + caching
5. Cost Optimization → Spot instances for batch processing
6. Sustainability → ARM64 Graviton (60% less energy)

Decision: ECS Fargate + ALB + CloudFront + Graviton ARM64
Estimated cost: $156/month (5 tasks, 0.25 vCPU each)
```

### Infrastructure Agents Can Build

- **Data lakes** — S3 + Glue + Athena + Redshift Spectrum
- **Video pipelines** — MediaConvert + MediaLive + CloudFront
- **CI/CD pipelines** — CodePipeline + CodeBuild + CodeDeploy
- **Monitoring dashboards** — CloudWatch + X-Ray + custom metrics
- **API backends** — API Gateway + Lambda + DynamoDB
- **Real-time analytics** — Kinesis + Firehose + OpenSearch

**If it's on AWS, agents can build it.**

---

## Multi-Modal Support

Chimera handles **video, audio, images, and documents** without explicit instruction.

### AgentCore Multi-Modal Services

| Service | Capability | Example Use Case |
|---------|------------|------------------|
| **Bedrock Vision** | Image understanding (Claude Sonnet/Opus) | "Analyze this architecture diagram and suggest improvements" |
| **Amazon Transcribe** | Audio → text (30+ languages) | "Transcribe this customer support call" |
| **Amazon Rekognition** | Image/video analysis | "Find all faces in this video" |
| **Amazon Textract** | Document extraction (PDFs, forms) | "Extract invoice data from these PDFs" |
| **AgentCore Browser** | Web screenshot + automation | "Take a screenshot of this dashboard" |

### Automatic Media Processing

No explicit "analyze this image" needed:

```
User uploads screenshot of AWS Console →
Agent sees image attachment →
Auto-invokes Claude vision →
Responds: "I see you have 15 EC2 instances running in us-east-1.
          Instance i-abc123 has 2% CPU usage — consider downsizing."
```

User uploads audio file →
Agent auto-transcribes via Transcribe →
Responds with transcript + summary

User uploads PDF invoice →
Agent auto-extracts via Textract →
Stores structured data in DynamoDB

### Multi-Modal Storage

- **S3** — Raw media files (images, audio, video, PDFs)
- **DynamoDB** — Extracted metadata, transcriptions, analysis results
- **AgentCore Memory** — Conversation history including media references

---

## Self-Reflection & Continuous Improvement

Agents run **post-mortem analysis** after every task to improve future performance.

### Post-Mortem Template

```markdown
## Session Post-Mortem

**Task:** Deploy Lambda function for image resizing
**Duration:** 15 minutes
**Outcome:** Success
**Cost:** $0.03 (Bedrock API calls)

### What Went Well
- Agent correctly identified Lambda + S3 trigger pattern
- CDK generation was syntactically correct
- Deployment succeeded on first attempt

### What Could Be Improved
- Agent missed IAM permission for S3:GetObject initially
- Required 2nd iteration to fix permission error
- Could have validated IAM policy before deployment

### Learnings
- PATTERN RECORDED: Lambda + S3 trigger requires s3:GetObject + s3:PutObject
- SKILL CANDIDATE: "lambda-s3-trigger" (encountered 3+ times this month)

### Action Items
1. Update "lambda-deployment" skill to include IAM validation step
2. Create skill: "lambda-s3-trigger" for common pattern
3. Add IAM policy validation to pre-deployment checks
```

### Continuous Improvement Loop

```
1. Task completion → Generate post-mortem
2. Extract patterns (3+ similar tasks → auto-generate skill)
3. Identify failures (what caused errors? how to prevent?)
4. Update existing skills with learnings
5. Store in AgentCore Memory (LTM: USER_PREFERENCE strategy)
6. Apply learnings to next session
```

### Evaluation Metrics

AgentCore Evaluations provides **13 built-in evaluators**:

- **Accuracy** — Did the agent solve the problem correctly?
- **Helpfulness** — Did the response address the user's need?
- **Safety** — Did the agent avoid harmful actions?
- **Latency** — How long did the task take?
- **Cost** — How much did Bedrock API calls cost?
- **Tool usage efficiency** — Were tools used appropriately?

Agents review these metrics in post-mortems.

---

## Concurrent Execution

**UTO interacts while background tasks run in parallel.**

### Non-Blocking Agent Execution

Traditional chatbot:
```
User: "Analyze all S3 buckets for cost optimization"
Agent: [blocks for 5 minutes]
Agent: "Analysis complete. Here are recommendations..."
```

Chimera:
```
User: "Analyze all S3 buckets for cost optimization"
Agent: "Started analysis task-abc123. I'll notify you when complete. What else can I help with?"

User: "What Lambda functions are running in us-east-1?"
Agent: [immediately responds while analysis continues in background]

[3 minutes later]
Agent: "Task-abc123 complete. Found 15 optimization opportunities, estimated savings: $456/month."
```

### Background Task Management

```python
# Agent spawns background task
task_id = agent.spawn_background_task(
    task="analyze_all_s3_buckets",
    args={"regions": ["us-east-1", "us-west-2"]},
    notify_on_completion=True
)

# User continues chatting
# Agent handles new requests while background task runs

# Background task completes → notification sent via AgentCore Memory
```

### Multi-Agent Swarm Coordination

```
User: "Build a data lake"

Lead agent decomposes:
- Builder 1: Create S3 buckets (foundation)
- Builder 2: Set up Glue catalog (depends on S3)
- Builder 3: Configure Athena (depends on Glue)
- Builder 4: Add Kinesis ingestion (parallel with Athena)
- Builder 5: Create CloudWatch dashboards (final step)

All builders run concurrently within dependency constraints.
Lead agent streams progress updates to user.
User can ask questions while work continues.
```

### DynamoDB-Backed Task State

```python
# DynamoDB item: TENANT#acme / TASK#abc123
{
    "PK": "TENANT#acme",
    "SK": "TASK#abc123",
    "taskType": "s3_cost_analysis",
    "status": "in_progress",  # queued | in_progress | completed | failed
    "startedAt": "2026-03-20T14:30:00Z",
    "estimatedDuration": "180s",
    "progress": {
        "bucketsAnalyzed": 8,
        "totalBuckets": 15,
        "percentComplete": 53
    },
    "notifyOnCompletion": True,
    "parentSessionId": "session-xyz"
}
```

User queries task status anytime: `agent("What's the status of task-abc123?")`

---

## Conclusion

### Auto-Generated Artifacts

| Artifact | Generated When | Format |
|----------|----------------|--------|
| **ADR** (Architecture Decision Record) | Agent makes an infrastructure choice | Markdown with frontmatter |
| **Runbook** | Agent deploys a new service | Step-by-step operational guide |
| **Dashboard** | Agent creates resources | CloudWatch dashboard JSON |
| **Incident log** | Agent handles an error | Timestamped event log |
| **Cost report** | Monthly (EventBridge trigger) | PDF + Excel + web dashboard |

### Decision Logging

Every infrastructure decision is logged:

```markdown
---
title: "Use ECS Fargate over EC2 for chat gateway"
status: accepted
date: 2026-03-20
---

## Context
Need to deploy chat gateway with auto-scaling and minimal ops burden.

## Decision
Use ECS Fargate with ALB.

## Rationale
- No instance management (vs EC2)
- Built-in auto-scaling (vs manual ASG tuning)
- Pay-per-task pricing (vs paying for idle EC2)

## Alternatives Considered
1. EC2 with ASG: More control, but higher ops burden
2. Lambda: Cold start issues for WebSocket connections
3. App Runner: Limited customization

## Consequences
- Higher per-request cost than EC2 (acceptable for this workload)
- No access to underlying host (acceptable, don't need it)
```

### User Experience

**Traditional AWS experience:**
```
User: "Why is my Lambda timing out?"
→ Dig through CloudWatch logs
→ Correlate with X-Ray traces
→ Check IAM policies
→ Review VPC config
```

**Chimera experience:**
```
User: "Why is my Lambda timing out?"
→ Agent instantly shows:
   - Error log with root cause highlighted
   - Timeline of events leading to failure
   - Recommended fix (e.g., increase timeout, optimize code)
   - One-click deployment of fix
```

---

## Storage Architecture

### Git-Backed Workspaces

Every agent session gets a **CodeCommit repository**:

```
/tenants/{tenantId}/repos/{sessionId}/
  ├── workspace/        # Agent working directory
  ├── artifacts/        # Generated files
  └── history/          # Git commit log
```

**Benefits:**
- **Version control** — Every change is tracked
- **Collaboration** — Multi-agent sessions share a repo
- **Rollback** — Revert to any previous state
- **Audit** — Full history of what agents did

### S3 + EFS Hybrid

| Storage Type | Use Case | Service |
|--------------|----------|---------|
| **Hot storage** | Active agent workspaces | EFS (POSIX filesystem) |
| **Warm storage** | Session artifacts, logs | S3 Standard |
| **Cold storage** | Archived sessions, compliance | S3 Glacier |
| **Database** | Metadata, session state | DynamoDB |

**Example flow:**
```
1. Agent starts session → EFS workspace mounted to MicroVM
2. Agent generates CDK → Files written to EFS
3. Agent commits → Git push to CodeCommit
4. Session ends → EFS workspace archived to S3
5. After 90 days → S3 lifecycle policy moves to Glacier
```

### No Local Filesystem Dependency

AgentCore MicroVMs are **ephemeral** — no persistent local filesystem. Agents use:
- **S3** for file storage
- **CodeCommit** for git operations
- **EFS** for POSIX workspaces (if needed)
- **DynamoDB** for state

This enables **100% serverless** operation.

---

## Multi-Account Management

Chimera uses **AWS Organizations** for multi-account orchestration.

### Account Hierarchy

```
Root Account (Management)
  ├── Tenant A (Production)
  ├── Tenant A (Staging)
  ├── Tenant B (Production)
  ├── Tenant B (Staging)
  └── Shared Services
      ├── CI/CD
      ├── Logging
      └── Security
```

### Cross-Account Access

Agents use **cross-account IAM roles** to operate on sub-accounts:

```typescript
// Assume role in target account
const stsClient = new STSClient({});
const credentials = await stsClient.send(new AssumeRoleCommand({
  RoleArn: `arn:aws:iam::${targetAccountId}:role/ChimeraAgentRole`,
  RoleSessionName: `chimera-session-${sessionId}`
}));

// Use credentials to access target account
const ec2Client = new EC2Client({ credentials });
```

### Consolidated Billing

All sub-accounts roll up to **consolidated billing** in the management account:

```
Total AWS spend: $45,000/month
  ├── Tenant A Prod: $15,000
  ├── Tenant A Staging: $2,000
  ├── Tenant B Prod: $20,000
  ├── Tenant B Staging: $3,000
  └── Shared Services: $5,000
```

Chimera attributes costs to tenants via **cost allocation tags**:

```typescript
// Tag all resources with tenantId
await ec2Client.send(new CreateTagsCommand({
  Resources: [instanceId],
  Tags: [
    { Key: 'tenantId', Value: tenantId },
    { Key: 'project', Value: 'chimera' },
    { Key: 'environment', Value: 'production' }
  ]
}));
```

### Regional Constraints

Multi-region data residency is enforced via **IAM Service Control Policies (SCPs)**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny",
      "Action": "*",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestedRegion": ["us-east-1", "us-west-2"]
        }
      }
    }
  ]
}
```

Agents **cannot create resources** outside approved regions.

---

## Conclusion

**Chimera is an AWS-native rebuild of OpenClaw, designed for enterprise multi-tenancy from day one.**

### What Makes Chimera Different

1. **AWS account access instead of local computer** — The fundamental shift that enables infrastructure-aware agents
2. **Multi-tenant UTO model** — Single installation, multiple tenants with proper isolation
3. **AgentCore + Strands** — Built on AWS managed services, not Docker + SQLite
4. **Self-evolving with safety** — Agents create skills/tools within Cedar policy boundaries
5. **Infrastructure as capability** — Agents generate CDK, commit to CodeCommit, deploy via CodePipeline
6. **Skill compatibility** — Works with OpenClaw SKILL.md, MCP servers, Strands @tool
7. **Multi-modal** — Handles images, audio, video, documents automatically
8. **Continuous improvement** — Post-mortem analysis after every task
9. **Concurrent execution** — UTO interacts while background tasks run
10. **Built on proven patterns** — OpenClaw (universality), NemoClaw (security), OpenFang (performance)

### Status

**Research complete. Implementation underway.**

- ✅ OpenClaw/NemoClaw deep dive research (550 lines)
- ✅ AgentCore + Strands integration guide (1539 lines)
- ✅ Validation analysis confirms 85%+ alignment
- 🚧 Phase 1: AgentCore Runtime + Strands deployment (Weeks 3-4)
- 🚧 Phase 2: Multi-tenant onboarding automation (Weeks 5-6)
- 🚧 Phase 3: Observability + Policy integration (Weeks 7-8)

### Next Steps

See [ROADMAP.md](ROADMAP.md) for detailed implementation plan.

See [docs/research/agentcore-strands/10-Chimera-Integration-Guide.md](research/agentcore-strands/10-Chimera-Integration-Guide.md) for complete integration patterns.

---

**Chimera: where agents operate AWS accounts, not computers.**
