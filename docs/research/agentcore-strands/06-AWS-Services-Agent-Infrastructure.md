# AWS Services for Agent Infrastructure

This document maps AWS services to agent platform use cases -- the building blocks beneath [[01-AgentCore-Architecture-Runtime]] and [[03-AgentCore-Multi-Tenancy-Deployment]]. For each service: why agents need it, the architecture pattern, cost model, and a code snippet. IaC patterns are covered in [[08-IaC-Patterns-Agent-Platforms]].

---

## Compute & Execution

### Amazon ECS / AWS Fargate -- Containerized Agent Runtime

**Purpose for agents:** Long-running agent processes that exceed Lambda's 15-minute limit. Ideal for persistent agent servers, MCP tool hosts, and multi-step research agents that run for hours. AgentCore Runtime itself runs on Firecracker microVMs, but custom agent runtimes often deploy on ECS/Fargate.

**Architecture pattern:**
- ECS service with Fargate launch type -- no EC2 management
- Each task = one agent runtime container (or sidecar pattern with agent + tool containers)
- ALB or Cloud Map for service discovery between agents
- EFS mount for shared workspace/skill storage across tasks
- Auto-scaling based on SQS queue depth or custom CloudWatch metrics

**Cost model:** Per-vCPU-hour and per-GB-memory-hour. Fargate Spot saves up to 70% for interruptible workloads. No charge when tasks are stopped.

```python
# CDK: Fargate agent service with EFS
from aws_cdk import aws_ecs as ecs, aws_efs as efs

task_def = ecs.FargateTaskDefinition(self, "AgentTask",
    cpu=1024, memory_limit_mib=4096)
task_def.add_volume(name="workspace",
    efs_volume_configuration=ecs.EfsVolumeConfiguration(
        file_system_id=file_system.file_system_id))

container = task_def.add_container("agent",
    image=ecs.ContainerImage.from_registry("agent-runtime:latest"),
    logging=ecs.LogDrivers.aws_logs(stream_prefix="agent"))
container.add_mount_points(ecs.MountPoint(
    container_path="/workspace",
    source_volume="workspace",
    read_only=False))
```

### AWS Lambda -- Serverless Agent Execution

**Purpose for agents:** Event-driven agent triggers, lightweight tool execution, and short-lived agent tasks. Lambda is the default tool-execution backend for Amazon Bedrock Agents. Best for stateless, burst-heavy workloads under 15 minutes.

**Architecture pattern:**
- Agent orchestrator invokes Lambda functions as tools (Bedrock Action Groups)
- EventBridge triggers Lambda for scheduled agent runs (cron agents)
- SQS triggers Lambda for queue-based agent task processing
- Lambda Layers for shared agent dependencies (SDKs, model clients)
- Provisioned concurrency for latency-sensitive agent tools

**Cost model:** Per-request ($0.20/1M) + per-GB-second ($0.0000166667). Free tier: 1M requests + 400K GB-seconds/month. No charge when idle.

```python
# Bedrock agent tool as Lambda
import json

def handler(event, context):
    """Tool: search_knowledge_base"""
    params = event.get("parameters", [])
    query = next(p["value"] for p in params if p["name"] == "query")

    # Execute tool logic
    results = search_kb(query)

    return {
        "messageVersion": "1.0",
        "response": {
            "actionGroup": event["actionGroup"],
            "function": event["function"],
            "functionResponse": {
                "responseBody": {
                    "TEXT": {"body": json.dumps(results)}
                }
            }
        }
    }
```

### AgentCore Code Interpreter (OpenSandbox)

**Purpose for agents:** Secure execution of untrusted, LLM-generated code in an isolated sandbox. Prevents agents from running arbitrary code on production infrastructure. Supports Python, JavaScript, and shell commands with file I/O.

**Architecture pattern:**
- Each execution runs in a Firecracker microVM with strict resource limits
- Ephemeral -- sandbox destroyed after execution (no persistent state)
- File upload/download for data processing workflows
- Integrated with AgentCore Runtime sessions -- same session can reason + execute code
- Network isolation by default; optional allowlists for specific endpoints

**Cost model:** Consumption-based, billed per execution-second. No idle charges. Part of AgentCore pricing.

```python
# Using AgentCore Code Interpreter via Strands
from strands import Agent
from strands.tools.agentcore import code_interpreter

agent = Agent(
    tools=[code_interpreter],
    system_prompt="You can write and execute Python code to analyze data."
)

response = agent("Calculate the standard deviation of [23, 45, 12, 67, 34, 89]")
# Agent writes Python, executes in sandbox, returns result
```

### AWS CodeBuild -- Build Environments for Agent Code

**Purpose for agents:** CI/CD for agent skill packages, tool containers, and runtime images. CodeBuild provides isolated build environments for compiling, testing, and packaging agent code before deployment.

**Architecture pattern:**
- Build project per agent/skill with buildspec.yml
- ECR push for container-based agents (ECS/Fargate/AgentCore)
- S3 artifact upload for Lambda-based tools
- CodePipeline integration for GitOps-driven agent deployment
- Custom build images with pre-installed agent frameworks

**Cost model:** Per-build-minute. Linux small ($0.005/min), medium ($0.01/min), large ($0.02/min). No charge when not building.

```yaml
# buildspec.yml for agent container
version: 0.2
phases:
  install:
    runtime-versions:
      python: 3.12
  build:
    commands:
      - pip install -r requirements.txt
      - pytest tests/
      - docker build -t agent-runtime .
      - docker tag agent-runtime $ECR_REPO:$CODEBUILD_RESOLVED_SOURCE_VERSION
  post_build:
    commands:
      - docker push $ECR_REPO:$CODEBUILD_RESOLVED_SOURCE_VERSION
```

### AWS App Runner -- Simple Container Deployment

**Purpose for agents:** Fastest path from container to running agent endpoint. No load balancers, no task definitions, no cluster management. Best for simple agent HTTP servers and MCP tool endpoints.

**Architecture pattern:**
- Source: ECR image or GitHub repo
- Auto-scaling from 0 to N instances based on concurrent requests
- Built-in HTTPS endpoint with custom domain support
- VPC connector for private resource access (RDS, ElastiCache)

**Cost model:** Per-vCPU-second active + per-GB-second active + per-GB-second paused. Can scale to zero (paused billing only). Provisioned instances for guaranteed capacity.

```bash
# Deploy agent server with App Runner CLI
aws apprunner create-service \
  --service-name agent-mcp-server \
  --source-configuration '{
    "ImageRepository": {
      "ImageIdentifier": "123456789.dkr.ecr.us-east-1.amazonaws.com/agent:latest",
      "ImageRepositoryType": "ECR",
      "ImageConfiguration": {"Port": "8080"}
    }
  }' \
  --instance-configuration '{"Cpu": "1024", "Memory": "2048"}'
```

---

## Storage

### Amazon S3 -- Object Storage for Artifacts

**Purpose for agents:** Durable storage for agent artifacts, memory snapshots, skill packages, conversation logs, RAG document corpora, and evaluation datasets. S3 is the gravity well of agent data.

**Architecture pattern:**
- Bucket-per-tenant (silo) or prefix-per-tenant (pool) with IAM policies
- S3 Event Notifications trigger Lambda/EventBridge on new artifacts
- Versioning for memory snapshot rollback
- Lifecycle rules: Intelligent-Tiering for variable access, Glacier for audit logs
- Pre-signed URLs for secure client-side upload/download of agent outputs

**Cost model:** Storage: $0.023/GB/month (Standard). Requests: $0.005/1K PUT, $0.0004/1K GET. Free tier: 5GB, 20K GET, 2K PUT.

```python
# Agent memory snapshot to S3
import boto3, json
from datetime import datetime

s3 = boto3.client("s3")

def save_memory_snapshot(tenant_id: str, session_id: str, memory: dict):
    key = f"tenants/{tenant_id}/sessions/{session_id}/memory/{datetime.utcnow().isoformat()}.json"
    s3.put_object(
        Bucket="agent-artifacts",
        Key=key,
        Body=json.dumps(memory),
        ServerSideEncryption="aws:kms",
        Metadata={"tenant-id": tenant_id, "session-id": session_id}
    )
```

### Amazon EFS -- Shared Filesystem for Agent Workspaces

**Purpose for agents:** POSIX filesystem shared across multiple agent containers. Enables agents to read/write files in a workspace that persists across task restarts and is accessible by multiple concurrent agents. Ideal for skill storage, shared tool configurations, and multi-agent collaboration on files.

**Architecture pattern:**
- One EFS filesystem per environment (dev/staging/prod)
- Access points per tenant for isolation (different root directories, UID/GID)
- Mount targets in each AZ for HA
- ECS tasks and Lambda functions mount the same filesystem
- Throughput mode: Elastic for bursty agent workloads

**Cost model:** Storage: $0.30/GB/month (Standard), $0.025/GB/month (Infrequent Access). Throughput: $0.04/GB transferred (Elastic). No provisioning required with Elastic throughput.

```python
# CDK: EFS with per-tenant access points
from aws_cdk import aws_efs as efs

file_system = efs.FileSystem(self, "AgentWorkspace",
    vpc=vpc,
    throughput_mode=efs.ThroughputMode.ELASTIC,
    performance_mode=efs.PerformanceMode.GENERAL_PURPOSE,
    encrypted=True)

# Per-tenant access point
tenant_ap = file_system.add_access_point("TenantA",
    path="/tenants/tenant-a",
    create_acl=efs.Acl(owner_uid="1001", owner_gid="1001", permissions="750"),
    posix_user=efs.PosixUser(uid="1001", gid="1001"))
```

---

## Data & State

### Amazon DynamoDB -- Session State & Tenant Config

**Purpose for agents:** Sub-millisecond key-value and document storage for agent session state, tenant configuration, skill metadata, conversation history indexes, and rate limiting counters. DynamoDB is the default backing store for agent platforms that need fast, predictable performance at any scale.

**Architecture pattern:**
- **Pool model (recommended):** Single table, partition key = `TENANT#<id>`, sort key overloaded for different entity types (`SESSION#<id>`, `SKILL#<name>`, `CONFIG`)
- **Silo model:** Table-per-tenant for strict isolation (higher operational overhead)
- TTL attribute for automatic session expiry
- DynamoDB Streams for change-data-capture (trigger downstream on state changes)
- GSI for cross-tenant queries (e.g., all active sessions, skill search)

**Cost model:** On-demand: $1.25/million WCU, $0.25/million RCU. Provisioned: ~$0.00065/WCU-hour. Free tier: 25 WCU + 25 RCU + 25 GB.

```python
# Single-table design for agent platform
import boto3
from datetime import datetime, timedelta

ddb = boto3.resource("dynamodb").Table("agent-platform")

# Store session state
ddb.put_item(Item={
    "PK": f"TENANT#{tenant_id}",
    "SK": f"SESSION#{session_id}",
    "state": {"messages": [], "tool_calls": [], "memory": {}},
    "created_at": datetime.utcnow().isoformat(),
    "ttl": int((datetime.utcnow() + timedelta(hours=24)).timestamp()),
    "GSI1PK": "ACTIVE_SESSIONS",
    "GSI1SK": datetime.utcnow().isoformat()
})

# Store tenant config
ddb.put_item(Item={
    "PK": f"TENANT#{tenant_id}",
    "SK": "CONFIG",
    "model_id": "anthropic.claude-sonnet-4-20250514",
    "max_budget_usd": 5.0,
    "allowed_tools": ["code_interpreter", "web_search"],
    "rate_limit_rpm": 60
})
```

---

## Messaging & Event-Driven

### Amazon SQS / SNS -- Message Queues for Agent Coordination

**Purpose for agents:** Decouple agent-to-agent communication, buffer task queues, and fan-out notifications. SQS provides reliable queue-based messaging for work distribution; SNS provides pub/sub for event broadcasting.

**Architecture pattern:**
- **SQS:** Task queue per agent type -- orchestrator enqueues, workers dequeue
- **SQS FIFO:** Ordered message processing for conversation turns (per message group = session)
- **SNS:** Fan-out agent events to multiple subscribers (e.g., "document processed" triggers indexing agent + notification agent)
- Dead-letter queues (DLQ) for failed agent tasks -- retry or human review
- SQS + Lambda for auto-scaling agent workers

**Cost model:** SQS: $0.40/million requests (Standard), $0.50/million (FIFO). SNS: $0.50/million publishes. Free tier: 1M SQS requests + 1M SNS publishes.

```python
# Agent task queue with DLQ
import boto3, json

sqs = boto3.client("sqs")

# Enqueue agent task
sqs.send_message(
    QueueUrl="https://sqs.us-east-1.amazonaws.com/123456/agent-tasks",
    MessageBody=json.dumps({
        "tenant_id": "acme-corp",
        "task_type": "research",
        "prompt": "Analyze Q3 earnings for AMZN",
        "session_id": "sess-abc123"
    }),
    MessageGroupId="acme-corp",  # FIFO: ensures tenant ordering
    MessageDeduplicationId="task-xyz789"
)
```

### Amazon EventBridge -- Event-Driven Agent Triggers

**Purpose for agents:** Central event bus for triggering agents based on events from any AWS service, SaaS integration, or custom application. EventBridge is the backbone of event-driven agent architectures -- the "nervous system" connecting perception to action.

**Architecture pattern:**
- Custom event bus per environment
- Rules match event patterns and route to agent Lambda/Step Functions/ECS
- Scheduled rules for cron-based agents (e.g., daily email digest agent)
- EventBridge Pipes for point-to-point event transformation (DynamoDB Stream -> agent)
- Schema registry for event contract management across agent teams

**Cost model:** $1.00/million events published. Free tier: included in AWS Free Tier. Scheduled rules: no additional charge.

```python
# CDK: EventBridge rule triggering agent on S3 upload
from aws_cdk import aws_events as events, aws_events_targets as targets

rule = events.Rule(self, "NewDocumentRule",
    event_pattern=events.EventPattern(
        source=["aws.s3"],
        detail_type=["Object Created"],
        detail={"bucket": {"name": ["agent-documents"]}}
    ))
rule.add_target(targets.LambdaFunction(indexing_agent_fn))

# Scheduled agent (daily at 8:30 AM ET)
events.Rule(self, "DailyDigestAgent",
    schedule=events.Schedule.cron(hour="12", minute="30", week_day="MON-FRI"),
    targets=[targets.LambdaFunction(digest_agent_fn)])
```

---

## Orchestration

### AWS Step Functions -- Workflow Orchestration for Multi-Step Agents

**Purpose for agents:** Coordinate complex, multi-step agent workflows with built-in error handling, retries, parallelism, and human-in-the-loop approval. Step Functions is the orchestration layer for agents that need deterministic workflow control around non-deterministic LLM reasoning.

**Architecture pattern:**
- **Standard workflows:** Long-running agent pipelines (up to 1 year), exactly-once execution
- **Express workflows:** High-volume, short-duration agent tool chains (up to 5 min, at-least-once)
- Map state for parallel agent execution (fan-out research across N sources)
- Choice state for routing based on agent output (confidence thresholds, tool selection)
- Wait + Callback for human approval gates
- Nested workflows for composable agent sub-routines

**Cost model:** Standard: $0.025/1K state transitions. Express: per-execution + per-GB-second. Free tier: 4K Standard transitions/month.

```json
{
  "Comment": "Multi-step research agent workflow",
  "StartAt": "PlanResearch",
  "States": {
    "PlanResearch": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:us-east-1:123:function:plan-agent",
      "Next": "ParallelResearch"
    },
    "ParallelResearch": {
      "Type": "Map",
      "ItemsPath": "$.research_tasks",
      "MaxConcurrency": 5,
      "Iterator": {
        "StartAt": "ExecuteResearch",
        "States": {
          "ExecuteResearch": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:us-east-1:123:function:research-agent",
            "Retry": [{"ErrorEquals": ["States.TaskFailed"], "MaxAttempts": 2}],
            "End": true
          }
        }
      },
      "Next": "SynthesizeResults"
    },
    "SynthesizeResults": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:us-east-1:123:function:synthesis-agent",
      "Next": "HumanReview"
    },
    "HumanReview": {
      "Type": "Task",
      "Resource": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
      "Parameters": {
        "QueueUrl": "https://sqs.us-east-1.amazonaws.com/123/review-queue",
        "MessageBody": {"taskToken.$": "$$.Task.Token", "results.$": "$.synthesis"}
      },
      "End": true
    }
  }
}
```

---

## API & Communication

### Amazon API Gateway -- WebSocket for Real-Time Agent Communication

**Purpose for agents:** WebSocket APIs for bidirectional, real-time streaming between clients and agents. REST APIs for synchronous tool invocation. HTTP APIs for lightweight, low-latency agent endpoints.

**Architecture pattern:**
- **WebSocket API:** Client connects, sends prompts, receives streaming agent responses in real-time
- Route keys: `$connect`, `$disconnect`, `sendMessage`, `agentResponse`
- DynamoDB connection table tracks active sessions
- Lambda integration for message routing to agent backend
- **REST API:** Request/response for tool endpoints, with request validation and API keys
- Usage plans + API keys for per-tenant rate limiting and throttling

**Cost model:** WebSocket: $1.00/million connection-minutes + $1.00/million messages. REST: $3.50/million requests. HTTP: $1.00/million requests. Free tier: 1M REST calls + 1M HTTP calls.

```python
# WebSocket handler for agent streaming
import boto3, json

apigw = boto3.client("apigatewaymanagementapi",
    endpoint_url="https://abc123.execute-api.us-east-1.amazonaws.com/prod")

def handle_message(event, context):
    connection_id = event["requestContext"]["connectionId"]
    body = json.loads(event["body"])

    # Stream agent response back to client
    for chunk in run_agent(body["prompt"]):
        apigw.post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps({"type": "chunk", "content": chunk}).encode())

    apigw.post_to_connection(
        ConnectionId=connection_id,
        Data=json.dumps({"type": "done"}).encode())

    return {"statusCode": 200}
```

---

## Security & Identity

### Amazon Cognito -- Tenant Authentication & User Pools

**Purpose for agents:** Authenticate end users and tenants before they interact with agents. Cognito provides user pools (username/password, social, SAML, OIDC), app clients, and JWT tokens that downstream services validate. Essential for multi-tenant agent platforms.

**Architecture pattern:**
- User pool per environment (not per tenant) -- tenants distinguished by custom claims
- Custom attribute `custom:tenant_id` on user profile
- Pre-token-generation Lambda to inject tenant claims into JWT
- App client per frontend (web, mobile, CLI)
- Cognito groups for role-based access (admin, user, agent-operator)
- API Gateway Cognito authorizer validates JWT on every request

**Cost model:** $0.0055/MAU (first 50K), decreasing tiers after. SAML/OIDC federation: $0.015/MAU. Free tier: 50K MAU (with Cognito user pool sign-in).

```python
# Validate Cognito JWT and extract tenant context
import jwt
from functools import wraps

def require_tenant(handler):
    @wraps(handler)
    def wrapper(event, context):
        token = event["headers"].get("Authorization", "").replace("Bearer ", "")
        claims = jwt.decode(token, options={"verify_signature": False})  # Validate properly in prod
        tenant_id = claims.get("custom:tenant_id")
        if not tenant_id:
            return {"statusCode": 403, "body": "Missing tenant context"}
        event["tenant_id"] = tenant_id
        return handler(event, context)
    return wrapper
```

### AWS Secrets Manager -- Credential Management Per Tenant

**Purpose for agents:** Secure storage and rotation of API keys, database credentials, OAuth tokens, and third-party service credentials that agents need per tenant. Agents often invoke external APIs -- each tenant may have their own API keys.

**Architecture pattern:**
- Secret naming: `agent-platform/<tenant_id>/<service>` (e.g., `agent-platform/acme/openai-key`)
- Automatic rotation with Lambda rotation functions
- Resource policy for cross-account access (tenant-owned secrets)
- Caching with AWS SDK SecretCache to reduce API calls and latency
- IAM policy scoped to tenant prefix: `arn:aws:secretsmanager:*:*:secret:agent-platform/<tenant_id>/*`

**Cost model:** $0.40/secret/month + $0.05/10K API calls. No free tier.

```python
# Agent credential retrieval with caching
from aws_secretsmanager_caching import SecretCache
import botocore.session

client = botocore.session.get_session().create_client("secretsmanager")
cache = SecretCache(client=client)

def get_tenant_credential(tenant_id: str, service: str) -> str:
    secret_id = f"agent-platform/{tenant_id}/{service}"
    return cache.get_secret_string(secret_id)

# Usage in agent tool
api_key = get_tenant_credential("acme-corp", "jira-api-key")
```

---

## Observability

### Amazon CloudWatch -- Metrics, Logs, and Alarms

**Purpose for agents:** Centralized observability for agent platforms. Custom metrics for agent performance (latency, token usage, tool call success rates), structured logs for debugging agent reasoning, and alarms for operational health.

**Architecture pattern:**
- **Metrics:** EMF (Embedded Metric Format) for high-cardinality agent metrics without custom metric API calls
- **Logs:** Structured JSON logs with tenant_id, session_id, agent_id dimensions
- **Log Insights:** Query across agent logs for debugging (e.g., "show all tool failures for tenant X")
- **Alarms:** Composite alarms for agent health (error rate + latency + token budget)
- **Dashboards:** Per-tenant and platform-wide agent operational dashboards
- **X-Ray / Distro for OpenTelemetry:** Distributed tracing across agent -> tool -> LLM call chains

**Cost model:** Metrics: $0.30/metric/month (first 10K). Logs: $0.50/GB ingested + $0.03/GB stored. Alarms: $0.10/alarm/month. Free tier: 10 metrics, 5GB logs, 10 alarms.

```python
# Embedded Metric Format for agent observability
import json, time

def emit_agent_metrics(tenant_id, session_id, duration_ms, tokens_used, tool_calls, success):
    print(json.dumps({
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [{
                "Namespace": "AgentPlatform",
                "Dimensions": [["TenantId"], ["TenantId", "AgentType"]],
                "Metrics": [
                    {"Name": "InvocationDuration", "Unit": "Milliseconds"},
                    {"Name": "TokensUsed", "Unit": "Count"},
                    {"Name": "ToolCalls", "Unit": "Count"},
                    {"Name": "Errors", "Unit": "Count"}
                ]
            }]
        },
        "TenantId": tenant_id,
        "AgentType": "research",
        "SessionId": session_id,
        "InvocationDuration": duration_ms,
        "TokensUsed": tokens_used,
        "ToolCalls": tool_calls,
        "Errors": 0 if success else 1
    }))
```

---

## Service Selection Matrix

| Requirement | Primary Service | Alternative |
|-------------|----------------|-------------|
| Short-lived tool execution (<15 min) | **Lambda** | App Runner |
| Long-running agent (hours) | **ECS/Fargate** | AgentCore Runtime |
| Untrusted code execution | **AgentCore Code Interpreter** | Lambda with tight IAM |
| Session state (fast K/V) | **DynamoDB** | ElastiCache |
| Artifact storage (files, blobs) | **S3** | EFS (if POSIX needed) |
| Shared filesystem | **EFS** | S3 + FUSE mount |
| Agent-to-agent messaging | **SQS** | EventBridge |
| Event-driven triggers | **EventBridge** | SNS + Lambda |
| Multi-step workflow orchestration | **Step Functions** | Strands multi-agent |
| Real-time streaming to client | **API Gateway WebSocket** | AppSync subscriptions |
| Tenant authentication | **Cognito** | Custom OIDC provider |
| Secret management | **Secrets Manager** | SSM Parameter Store (SecureString) |
| Agent observability | **CloudWatch + X-Ray** | Datadog, Grafana |
| Container CI/CD | **CodeBuild** | GitHub Actions |
| Simple container hosting | **App Runner** | ECS/Fargate |

---

## Cost Optimization Patterns

### 1. Right-size compute by agent tier

```
Free/trial tenants  -> Lambda (pay-per-invocation, scale to zero)
Standard tenants    -> Fargate Spot (70% savings, interruptible OK for async)
Enterprise tenants  -> Fargate on-demand + provisioned concurrency Lambda
```

### 2. Tiered storage lifecycle

```
Hot (0-7 days)    -> S3 Standard + DynamoDB on-demand
Warm (7-30 days)  -> S3 Intelligent-Tiering + DynamoDB Infrequent Access
Cold (30+ days)   -> S3 Glacier Instant Retrieval
Archive (1+ year) -> S3 Glacier Deep Archive ($0.00099/GB/month)
```

### 3. Minimize API Gateway costs for internal traffic

Use Cloud Map (service discovery) + VPC-internal ALB for agent-to-agent communication instead of API Gateway. Reserve API Gateway for external-facing endpoints.

### 4. DynamoDB on-demand vs provisioned

- On-demand for unpredictable agent workloads (most multi-tenant platforms)
- Provisioned with auto-scaling for steady-state workloads (saves ~20-30%)
- Reserved capacity for committed base load (saves up to 77%)

---

## Reference Architecture: Full Agent Platform Stack

```
Client (Web/Mobile)
  |
  v
API Gateway (WebSocket + REST)
  |
  +-- Cognito (JWT auth, tenant context)
  |
  v
Lambda (API handlers, routing)
  |
  +-- Step Functions (multi-step orchestration)
  |     |
  |     +-- Lambda (planning agent)
  |     +-- ECS/Fargate (research agents, long-running)
  |     +-- Lambda (synthesis agent)
  |
  +-- EventBridge (event routing)
  |     |
  |     +-- SQS (task queues per agent type)
  |     +-- SNS (notifications, fan-out)
  |
  +-- DynamoDB (session state, tenant config, skill metadata)
  +-- S3 (artifacts, memory snapshots, documents)
  +-- EFS (shared agent workspaces)
  +-- Secrets Manager (per-tenant credentials)
  +-- CloudWatch + X-Ray (observability)
  +-- CodeBuild + ECR (CI/CD for agent containers)
```

This maps cleanly to the [[03-AgentCore-Multi-Tenancy-Deployment]] patterns -- AgentCore provides the agent runtime layer on top of these foundational services, while [[01-AgentCore-Architecture-Runtime]] describes how AgentCore itself uses microVMs for session isolation.

---

## Further Reading

- [AWS Prescriptive Guidance: Building Serverless Architectures for Agentic AI](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-serverless/introduction.html)
- [AWS Prescriptive Guidance: Designing Agentic Workflows on AWS](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/designing-agentic-workflows-on-aws.html)
- [AWS Prescriptive Guidance: Resources for Operationalizing Agentic AI](https://docs.aws.amazon.com/prescriptive-guidance/latest/strategy-operationalizing-agentic-ai/resources.html)
- [DynamoDB Multi-Tenancy Data Modeling (3-part series)](https://aws.amazon.com/blogs/database/amazon-dynamodb-data-modeling-for-multi-tenancy-part-2/)
- [SaaS Storage Strategies Whitepaper](https://docs.aws.amazon.com/whitepapers/latest/multi-tenant-saas-storage-strategies/multi-tenant-saas-storage-strategies.html)
- [AgentCore Runtime Documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html)
