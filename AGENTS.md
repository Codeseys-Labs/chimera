# Chimera — Capability Reference

> **Your reference manual for what you can do**
>
> This document catalogs all tools, modules, and capabilities available to you as a Chimera agent. It is injected into your context at startup so you always know what's possible.

---

## Table of Contents

1. [AWS Service Tools (25)](#aws-service-tools)
2. [Discovery & Analysis Modules](#discovery--analysis-modules)
3. [Multi-Modal Media Processing](#multi-modal-media-processing)
4. [Infrastructure as Code](#infrastructure-as-code)
5. [Memory & Context](#memory--context)
6. [Skill System](#skill-system)
7. [Multi-Agent Orchestration](#multi-agent-orchestration)
8. [Self-Evolution Modules](#self-evolution-modules)
9. [Multi-Tenant Management](#multi-tenant-management)
10. [Observability & Activity Logging](#observability--activity-logging)
11. [Tiered Access Model](#tiered-access-model)

---

## AWS Service Tools

You have first-class access to 25 AWS services. Each tool includes automatic retry with exponential backoff for transient errors.

### Compute & Orchestration

| Tool | Capabilities | Status |
|------|-------------|--------|
| **EC2** | Launch/stop/terminate instances • Describe instances • Create security groups • Manage VPCs | ✅ |
| **Lambda** | Invoke functions (sync/async) • Create/update/delete functions • Get function config • List functions | ✅ |
| **Step Functions** | Start/stop executions • Describe state machines • Get execution history | ✅ |
| **ECS** | Run tasks • Describe clusters/services • Update services • Stop tasks | 🚧 |

### Data Storage & Databases

| Tool | Capabilities | Status |
|------|-------------|--------|
| **S3** | GetObject/PutObject/DeleteObject • List buckets/objects • Presigned URLs • Multipart uploads | ✅ |
| **DynamoDB** | Query/Scan/GetItem/PutItem/UpdateItem • Batch operations • GSI queries (with FilterExpression enforcement) | ✅ |
| **RDS** | Describe DB instances/clusters • Create/delete/modify instances • Create snapshots | ✅ |
| **Redshift** | Describe clusters • Execute queries • Get query results • Create/delete clusters | ✅ |
| **OpenSearch** | Search documents • Index documents • Create/delete indices • Cluster health | ✅ |

### Analytics & Data Processing

| Tool | Capabilities | Status |
|------|-------------|--------|
| **Athena** | Execute queries • Get query results • List databases/tables • Create/drop tables | ✅ |
| **Glue** | Start/stop crawlers • Get crawler status • Run jobs • List databases/tables | ✅ |
| **EMR** | Create/terminate clusters • Submit steps • Get cluster status | 🚧 |

### Machine Learning

| Tool | Capabilities | Status |
|------|-------------|--------|
| **SageMaker** | Create/delete endpoints • Invoke endpoints • Describe models • Training jobs | ✅ |
| **Bedrock** | Invoke models (Claude, Titan, Llama, Mistral) • Retrieve from knowledge bases • List foundation models | ✅ |
| **Rekognition** | Detect labels/faces/text • Analyze images • Content moderation • Celebrity recognition | ✅ |
| **Transcribe** | Start transcription jobs • Get transcription results • Speaker diarization • Vocabulary filters | ✅ |
| **Textract** | Detect/analyze document text • Extract tables • Extract forms • Expense analysis | ✅ |

### DevOps & CI/CD

| Tool | Capabilities | Status |
|------|-------------|--------|
| **CodeCommit** | Get repository info • List branches • Get file contents • Create/merge branches | ✅ |
| **CodePipeline** | Start pipeline execution • Get pipeline state • List pipelines • Get execution history | ✅ |
| **CodeBuild** | Start build • Get build status • List builds • Stop build | ✅ |

### Messaging & Eventing

| Tool | Capabilities | Status |
|------|-------------|--------|
| **SQS** | SendMessage/ReceiveMessage/DeleteMessage • Purge queues • Get queue attributes • Batch operations | ✅ |
| **SNS** | Publish messages • Create/delete topics • Subscribe/unsubscribe | 🚧 |
| **EventBridge** | Put events • Create/delete rules • List rules/targets | 🚧 |

### Monitoring & Observability

| Tool | Capabilities | Status |
|------|-------------|--------|
| **CloudWatch** | Put metric data • Get metric statistics • Describe alarms • Create/delete alarms • Query logs | ✅ |
| **X-Ray** | Get service graph • Get trace summaries • Get trace details • Distributed tracing | 🚧 |

**Legend:**
- ✅ Fully implemented and tested
- 🚧 Framework exists, needs completion
- ⏳ Planned for future release

---

## Discovery & Analysis Modules

Before making changes, you can discover what already exists in the AWS account.

### AWS Config
Query resource inventory across all regions.

**Capabilities:**
- List all resources by type (EC2, S3, Lambda, RDS, etc.)
- Get resource configuration history
- Compliance checks (encryption, public access, etc.)
- Cross-region resource search

**Usage:**
```python
from chimera_agent.discovery import ConfigDiscovery
config = ConfigDiscovery(region="us-east-1")
resources = config.list_resources(resource_type="AWS::Lambda::Function")
```

### Resource Explorer
Fast cross-region resource search with AWS Resource Explorer.

**Capabilities:**
- Search by tag, ARN, resource type
- Filter by region, account
- Aggregated view across organization

**Usage:**
```python
from chimera_agent.discovery import ResourceExplorer
explorer = ResourceExplorer()
results = explorer.search(query="tag:Environment=production")
```

### Cost Explorer
Analyze AWS spend patterns and forecast costs.

**Capabilities:**
- Get cost by service, region, tag
- Forecast future spend
- Identify cost anomalies
- Budget alerts

**Usage:**
```python
from chimera_agent.discovery import CostAnalyzer
cost = CostAnalyzer()
monthly_cost = cost.get_cost_by_service(start="2026-03-01", end="2026-03-31")
```

### Well-Architected Framework
Review architectures against AWS best practices.

**Capabilities:**
- 6-pillar assessment (Operational Excellence, Security, Reliability, Performance, Cost Optimization, Sustainability)
- Generate improvement recommendations
- Track remediation progress

**Usage:**
```python
from chimera_agent.well_architected import WellArchitectedTool
wa = WellArchitectedTool()
review = wa.create_workload_review(workload_name="MyApp", pillars=["security", "cost"])
```

---

## Multi-Modal Media Processing

The **MediaProcessor** module provides auto-detection and routing for images, audio, video, and documents.

### Supported Input Types
- **Images:** PNG, JPEG, GIF, WebP, TIFF
- **Audio:** MP3, WAV, FLAC, AAC, OGG
- **Video:** MP4, MOV, AVI, MKV
- **Documents:** PDF, DOCX, XLSX, PNG/JPG (for OCR)

### Processing Capabilities

| Media Type | Tool | Operations |
|------------|------|-----------|
| **Images** | Rekognition | Object detection, facial recognition, text detection, scene analysis, content moderation, celebrity recognition |
| **Audio** | Transcribe | Speech-to-text, speaker diarization, vocabulary filters, custom vocabularies, automatic language detection |
| **Documents** | Textract | OCR, table extraction, form data parsing, signature detection, expense analysis |
| **Video** | Rekognition Video | Object tracking, face tracking, person tracking, activity recognition, content moderation |

### Auto-Detection Pattern
The MediaProcessor automatically detects input type and routes to the appropriate service:

```python
from chimera_agent.media import MediaProcessor

processor = MediaProcessor()
result = processor.process(s3_uri="s3://bucket/image.jpg")  # Auto-detects as image, uses Rekognition
```

---

## Infrastructure as Code

You can generate and deploy AWS infrastructure autonomously using the **infra-builder** module.

### CDK Generation
Generate AWS CDK (TypeScript) from natural language requirements.

**Capabilities:**
- Parse requirements into stack definitions
- Generate construct definitions
- Apply best practices (VPC design, security groups, IAM roles)
- Multi-stack architectures

**Usage:**
```python
from chimera_agent.infra_builder import CdkGenerator

generator = CdkGenerator()
cdk_code = generator.generate_from_requirements("""
Create a serverless API with:
- API Gateway HTTP API
- Lambda function (Node.js 20)
- DynamoDB table with GSI
- CloudWatch alarms
""")
```

### CodeCommit Integration
Commit generated infrastructure to git.

**Capabilities:**
- Create branches
- Commit files with proper messages
- Create pull requests
- Merge branches

**Usage:**
```python
from chimera_agent.aws_tools import codecommit_tool

codecommit_tool.create_branch(repository="infra-repo", branch_name="feature/new-api", source_branch="main")
codecommit_tool.put_file(repository="infra-repo", branch="feature/new-api", file_path="lib/api-stack.ts", content=cdk_code)
```

### CodePipeline Deployment
Deploy infrastructure via CI/CD pipeline.

**Capabilities:**
- Start pipeline execution
- Monitor pipeline state
- Get execution details
- Stop execution on errors

**Usage:**
```python
from chimera_agent.aws_tools import codepipeline_tool

execution = codepipeline_tool.start_pipeline_execution(pipeline_name="InfraPipeline")
state = codepipeline_tool.get_pipeline_state(pipeline_name="InfraPipeline")
```

---

## Memory & Context

You have access to short-term and long-term memory via **AgentCore Memory**.

### Short-Term Memory (STM)
Session context that persists for the duration of a conversation.

**Scope:** Current session only
**TTL:** 24 hours
**Use for:** Task state, conversation context, in-progress work

### Long-Term Memory (LTM)
Persistent knowledge across sessions.

**Scope:** Cross-session
**TTL:** Configurable (default: 90 days)
**Use for:** Learned patterns, user preferences, historical decisions

### Memory Tiers

| Tier | Retention | Use Case |
|------|----------|----------|
| **Ephemeral** | Session only | Temporary calculations, draft content |
| **Short** | 24 hours | Active tasks, conversation context |
| **Medium** | 7 days | Recent patterns, pending decisions |
| **Long** | 90 days | User preferences, common workflows |
| **Permanent** | Indefinite | Core knowledge, critical patterns |

### Usage Pattern
```python
from chimera_agent.memory import MemoryClient

memory = MemoryClient(tenant_id="tenant-123", session_id="session-abc")

# Store STM
memory.store(key="current_task", value="Deploy API", tier="short")

# Retrieve
task = memory.retrieve(key="current_task")

# Store LTM
memory.store(key="user_preference_region", value="us-west-2", tier="long")
```

---

## Skill System

You can discover, install, and create skills dynamically.

### Skill Discovery
Search the skill registry for available skills.

**Capabilities:**
- Browse by category (aws, data, ml, devops, security)
- Filter by trust tier (Platform, Verified, Community, Private, Experimental)
- Search by keyword

**Usage:**
```python
from chimera_agent.skills import SkillRegistry

registry = SkillRegistry()
skills = registry.search(query="data processing", trust_tier="Verified")
```

### Skill Installation
Install skills from the registry.

**Trust Tiers:**
- **Platform** — Built by Chimera team, always available
- **Verified** — Vetted by Chimera security team
- **Community** — Public contributions, unverified
- **Private** — Tenant-specific skills
- **Experimental** — Early-stage, use with caution

**Installation Process:**
1. Skill passes 7-stage security pipeline (AST analysis, sandbox test, dependency scan, license check, behavior analysis, permission review, manual approval)
2. Skill descriptor stored in DynamoDB
3. Skill code uploaded to S3
4. Skill becomes available to agent runtime

### Skill Creation
Generate new skills from patterns you discover.

**Auto-Skill Generation:**
When you perform a task repeatedly (3+ times with similar structure), the evolution engine suggests auto-generating a skill.

**Manual Skill Creation:**
```python
from chimera_agent.skills import SkillCreator

creator = SkillCreator()
skill = creator.create(
    name="analyze-rds-performance",
    description="Analyze RDS instance performance metrics and suggest optimizations",
    parameters={"db_instance_id": "string", "time_range_hours": "number"},
    implementation=analyze_rds_code,
    trust_tier="Private"
)
```

### MCP Gateway Integration
Skills can integrate with Model Context Protocol (MCP) servers for extended capabilities.

**MCP Servers Available:**
- Playwright (browser automation)
- Context7 (documentation search)
- DeepWiki (repository documentation)
- Tavily (web search)

---

## Multi-Agent Orchestration

You can spawn sub-agents for parallel work using the **swarm** module.

### Swarm Components

| Component | Purpose | When to Use |
|-----------|---------|-------------|
| **Task Decomposer** | Break complex tasks into parallel subtasks | Large projects with independent work streams |
| **Role Assigner** | Match specialist agents to problems | Tasks requiring domain expertise |
| **Progressive Refiner** | Iteratively improve solutions | Quality-critical work needing multiple passes |
| **Blocker Resolver** | Escalate blockers to humans | When automated resolution fails |
| **HITL Gateway** | Controlled human approval | High-risk changes, budget approvals |

### Spawning Sub-Agents
```python
from chimera_agent.swarm import TaskDecomposer

decomposer = TaskDecomposer()
subtasks = decomposer.decompose("""
Deploy a 3-tier web application:
- Frontend (S3 + CloudFront)
- Backend (ECS Fargate + ALB)
- Database (RDS PostgreSQL)
""")

# Spawn agents for each subtask
for task in subtasks:
    agent_id = spawn_agent(task=task, role=task.required_role)
```

### Multi-Agent Workflows
Step Functions orchestrates multi-agent workflows with:
- Parallel execution
- Error handling and retries
- Human-in-the-loop gates
- Result aggregation

---

## Self-Evolution Modules

You can improve yourself over time via the **evolution** module.

### 7 Evolution Capabilities

| Module | Purpose | Safety Controls |
|--------|---------|----------------|
| **Auto-Skill Generator** | Codify patterns into reusable skills | 10/day rate limit, security pipeline |
| **Experiment Runner** | A/B test prompts and model configs | Staging-only, approval required |
| **IaC Modifier** | Update own infrastructure | Read-only dry-run first, HITL approval |
| **Model Router** | Select optimal LLM per task | Fallback to default on errors |
| **Prompt Optimizer** | Improve system prompts via feedback | Version control, rollback capability |
| **Behavior Analyzer** | Detect patterns in own actions | Read-only, no self-modification |
| **Safety Harness** | Enforce evolution constraints | Hard rate limits, fail-closed |

### Safety Harness Rules
1. **Rate limit:** Max 10 self-modifications per day per tenant
2. **Approval required:** All infrastructure changes need HITL approval
3. **Rollback capability:** Every change is versioned and reversible
4. **Staging first:** Test in staging environment before production
5. **Audit logging:** Every evolution action logged to CMK-encrypted audit table

### Evolution Workflow
```python
from chimera_agent.evolution import AutoSkillGenerator, SafetyHarness

# Check if allowed to evolve
harness = SafetyHarness(tenant_id="tenant-123")
if not harness.check_rate_limit(action="skill_creation"):
    raise RateLimitExceeded("Daily skill creation limit reached")

# Generate skill
generator = AutoSkillGenerator()
skill = generator.generate_from_pattern(
    pattern_name="analyze-cost-spike",
    observations=cost_spike_analyses  # List of 3+ similar analyses
)

# Request approval
harness.request_approval(
    action="install_skill",
    skill=skill,
    justification="Detected pattern: analyzing cost spikes (3 occurrences this week)"
)
```

---

## Multi-Tenant Management

You operate in a multi-tenant environment with strict isolation.

### Tenant Router
Every request is authenticated and routed to the correct tenant context.

**Authentication Flow:**
1. User presents Cognito JWT
2. JWT validated and decoded
3. Tenant ID extracted from claims
4. Cedar policies loaded for tenant
5. Request context scoped to tenant

### Authorization (Cedar Policies)
All operations are authorized via Cedar policy engine.

**Policy Structure:**
```cedar
permit(
  principal == User::"tenant-123",
  action == Action::"aws:s3:GetObject",
  resource in Bucket::"tenant-123-data"
) when {
  principal.tier == "Premium"
};
```

### Quota Management
Each tenant has resource quotas based on their tier.

| Resource | Basic | Advanced | Premium |
|----------|-------|----------|---------|
| **API calls/day** | 1,000 | 10,000 | 100,000 |
| **Agent sessions (concurrent)** | 1 | 5 | 25 |
| **Skills installed** | 10 | 50 | Unlimited |
| **Storage (S3)** | 10 GB | 100 GB | 1 TB |
| **Compute (Lambda invocations/day)** | 10,000 | 100,000 | 1,000,000 |

### Rate Limiting
Token bucket algorithm enforces per-tenant rate limits.

**Implementation:**
- State stored in DynamoDB with 5min TTL
- Fail-closed on DDB errors (deny request)
- Refill rate varies by tier

### Cost Tracking
Every operation's cost is tracked and accumulated monthly.

**Tracked Metrics:**
- AWS service costs (Lambda, S3, DynamoDB, etc.)
- Model inference costs (Bedrock, SageMaker)
- Data transfer costs
- Storage costs

**Alerts:**
- 80% of monthly quota → Warning notification
- 95% of monthly quota → Alert, throttle non-critical operations
- 100% of monthly quota → Deny new requests until next billing cycle

---

## Observability & Activity Logging

Every action you take is logged for audit and analysis.

### Activity Logger
Logs all operations with structured data.

**Logged Events:**
- AWS API calls (service, operation, parameters, result)
- Skill invocations (skill name, input, output, duration)
- Agent decisions (reasoning, selected option, alternatives considered)
- Errors (stack trace, context, resolution attempts)

**Log Destinations:**
- **CloudWatch Logs** — Real-time operational logs
- **DynamoDB audit table** — Security-critical events with CMK encryption
- **S3** — Long-term archival (7-year retention)

### ADR Auto-Generation
When you make significant architecture decisions, the system auto-generates Architecture Decision Records (ADRs).

**ADR Structure:**
```markdown
# ADR-XXX: [Decision Title]

## Status
Proposed | Accepted | Deprecated | Superseded

## Context
What problem are we solving?

## Decision
What did we decide?

## Consequences
What are the implications?

## Alternatives Considered
What other options did we evaluate?
```

### Runbook Auto-Generation
When you create CloudWatch alarms, the system generates runbooks automatically.

**Runbook Contents:**
- Symptom description
- Likely causes
- Investigation steps
- Remediation procedures
- Escalation path

**Example:**
```markdown
# Lambda Function Error Rate High

## Symptom
Lambda function error rate > 5% for 5 minutes

## Investigation
1. Check CloudWatch Logs for error messages
2. Review recent deployments
3. Check upstream service health
4. Verify IAM permissions

## Remediation
1. If recent deployment: rollback to previous version
2. If permissions issue: update IAM role
3. If upstream issue: implement retry logic or circuit breaker
```

---

## Tiered Access Model

Your capabilities vary based on the tenant's subscription tier.

### Basic Tier
**Target:** Small teams, development/testing, learning

**Capabilities:**
- ✅ 25 AWS service tools (read-only for destructive ops)
- ✅ Discovery modules (Config, Resource Explorer, Cost Explorer)
- ✅ Multi-modal processing (100 requests/day)
- ✅ Memory (STM only, 24h TTL)
- ✅ Skills (10 installed max, Platform tier only)
- ❌ Infrastructure generation (view-only)
- ❌ Self-evolution (disabled)
- ❌ Multi-agent orchestration (single agent only)

### Advanced Tier
**Target:** Production workloads, small-to-medium companies

**Capabilities:**
- ✅ All Basic capabilities
- ✅ 25 AWS service tools (full read-write access)
- ✅ Multi-modal processing (1,000 requests/day)
- ✅ Memory (STM + LTM up to 90 days)
- ✅ Skills (50 installed max, Platform + Verified tiers)
- ✅ Infrastructure generation (CDK generation + deployment)
- ✅ Self-evolution (5 actions/day, approval required)
- ✅ Multi-agent orchestration (5 concurrent agents)

### Premium Tier
**Target:** Enterprise, mission-critical workloads

**Capabilities:**
- ✅ All Advanced capabilities
- ✅ Multi-modal processing (unlimited)
- ✅ Memory (STM + LTM unlimited retention)
- ✅ Skills (unlimited installs, all trust tiers)
- ✅ Infrastructure generation (unlimited)
- ✅ Self-evolution (10 actions/day, auto-approve low-risk)
- ✅ Multi-agent orchestration (25 concurrent agents)
- ✅ Dedicated support
- ✅ Custom skill development
- ✅ SLA guarantees

---

## Quick Reference Card

### Most Common Operations

| Task | Tools to Use | Example |
|------|-------------|---------|
| **List all Lambda functions** | `lambda_tool.list_functions()` | `functions = lambda_tool.list_functions(region="us-east-1")` |
| **Query DynamoDB table** | `dynamodb.query()` | `items = dynamodb.query(table="users", key_condition="userId = :id", filter="tenantId = :tid")` |
| **Upload file to S3** | `s3_tool.put_object()` | `s3_tool.put_object(bucket="data", key="file.json", body=data)` |
| **Analyze image** | `rekognition_tool.detect_labels()` | `labels = rekognition_tool.detect_labels(image=image_bytes)` |
| **Transcribe audio** | `transcribe_tool.start_job()` | `job = transcribe_tool.start_job(job_name="call-123", media_uri="s3://audio/call.mp3")` |
| **Extract text from PDF** | `textract_tool.detect_text()` | `text = textract_tool.detect_text(document=pdf_bytes)` |
| **Deploy infrastructure** | `codepipeline_tool.start_execution()` | `exec = codepipeline_tool.start_execution(pipeline="InfraPipeline")` |
| **Search resources** | `ResourceExplorer.search()` | `resources = explorer.search(query="tag:env=prod")` |
| **Get AWS costs** | `CostAnalyzer.get_cost_by_service()` | `cost = analyzer.get_cost_by_service(start="2026-03-01", end="2026-03-31")` |
| **Spawn sub-agent** | `spawn_agent()` | `agent_id = spawn_agent(task=subtask, role="data-engineer")` |

---

## Important Constraints

### Security
1. **Always enforce tenant isolation** — Every DynamoDB GSI query MUST include `FilterExpression` for `tenantId`
2. **Never log sensitive data** — Redact credentials, PII, encryption keys from logs
3. **Fail closed** — On authorization errors, deny the request (never fail open)

### Performance
1. **Use pagination** — For large result sets, always paginate (S3 ListObjects, DynamoDB Query)
2. **Batch operations** — Use batch APIs when operating on multiple items (DynamoDB BatchGetItem, SQS SendMessageBatch)
3. **Retry with backoff** — Transient errors are retried automatically with exponential backoff

### Cost Optimization
1. **Check quotas before large operations** — Verify tenant quota allows the operation
2. **Use cost-effective services** — S3 Standard-IA for infrequent access, Glacier for archival
3. **Monitor spend** — Track operation costs in real-time via CostTracker

---

**Version:** 1.0.0
**Last Updated:** 2026-03-22
**Status:** Production-ready

---

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard-v:1 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) for structured expertise management.

**At the start of every session**, run:
```bash
mulch prime
```

This injects project-specific conventions, patterns, decisions, and other learnings into your context.
Use `mulch prime --files src/foo.ts` to load only records relevant to specific files.

**Before completing your task**, review your work for insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made — and record them:
```bash
mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Link evidence when available: `--evidence-commit <sha>`, `--evidence-bead <id>`

Run `mulch status` to check domain health and entry counts.
Run `mulch --help` for full usage.
Mulch write commands use file locking and atomic writes — multiple agents can safely record to the same domain concurrently.

### Before You Finish

1. Discover what to record:
   ```bash
   mulch learn
   ```
2. Store insights from this work session:
   ```bash
   mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
   ```
3. Validate and commit:
   ```bash
   mulch sync
   ```
<!-- mulch:end -->

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard-v:1 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->

<!-- canopy:start -->
## Prompt Management (Canopy)
<!-- canopy-onboard-v:1 -->

This project uses [Canopy](https://github.com/jayminwest/canopy) for git-native prompt management.

**At the start of every session**, run:
```
cn prime
```

This injects prompt workflow context: commands, conventions, and common workflows.

**Quick reference:**
- `cn list` — List all prompts
- `cn render <name>` — View rendered prompt (resolves inheritance)
- `cn emit --all` — Render prompts to files
- `cn update <name>` — Update a prompt (creates new version)
- `cn sync` — Stage and commit .canopy/ changes

**Do not manually edit emitted files.** Use `cn update` to modify prompts, then `cn emit` to regenerate.
<!-- canopy:end -->
