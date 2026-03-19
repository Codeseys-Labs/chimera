# ClawCore — AWS Component Blueprint

> The definitive AWS service mapping for ClawCore. Every resource, every configuration,
> every field specified. No hand-waving.

**Source documents:**
- [[ClawCore-Final-Architecture-Plan]] — Technology decisions, DynamoDB schema, phases
- [[ClawCore-Architecture-Review-Platform-IaC]] — 8-stack CDK, pipeline, GitOps, DR
- [[AWS Bedrock AgentCore and Strands Agents/06-AWS-Services-Agent-Infrastructure]] — AWS service patterns, cost models

---

## 1. AgentCore Services (9 Services)

### 1.1 AgentCore Runtime

| Field | Value |
|-------|-------|
| Deployment type | Managed MicroVM (Firecracker) — pool model for basic/pro, dedicated per enterprise tenant |
| Runtime name (pool) | `clawcore-pool` |
| Runtime name (dedicated) | `clawcore-{tenantId}` |
| Entrypoint | `main.py` (Strands Agent, Python 3.12) |
| Agent artifact | Docker image pushed to ECR `clawcore-agent-runtime:{version}` |
| Endpoints per runtime | 2: `production` (stable, pinned version), `canary` (5% traffic, latest version) |
| Env vars | `CLAWCORE_ENV` (dev/staging/prod), `CLAWCORE_TABLE` (DynamoDB table name), `CLAWCORE_BUCKET` (tenant S3 bucket), `CLAWCORE_SKILLS_BUCKET` (skills S3 bucket), `CLAWCORE_EVENT_BUS` (EventBridge bus name), `CLAWCORE_REGION` (us-west-2), `CLAWCORE_LOG_LEVEL` (INFO), `OTEL_EXPORTER_OTLP_ENDPOINT` (CloudWatch OTel endpoint) |
| Scaling | AgentCore-managed autoscaling — min 1 MicroVM (pool), max 100 concurrent sessions (pool), max 10 per dedicated runtime |
| Session timeout | 30 minutes idle, 2 hours absolute max |
| Cold start target | < 2 seconds |
| Budget per invocation | Configurable per tenant: free=$0.10, standard=$1.00, pro=$5.00, enterprise=$25.00 |

### 1.2 AgentCore Memory

| Field | Value |
|-------|-------|
| Namespace strategy | One namespace per tenant: `clawcore/{tenantId}` |
| Strategies | `SUMMARY` (default for all tiers), `SEMANTIC_MEMORY` (pro+), `USER_PREFERENCE` (pro+) |
| Short-term memory (STM) | In-session message buffer — 50 messages max, sliding window |
| Long-term memory (LTM) | Cross-session persistence — vector-indexed semantic search |
| Retention | STM: session lifetime (max 2 hours). LTM: 90 days (basic), 1 year (pro), unlimited (enterprise) |
| Session snapshots | S3 export on session end: `s3://{tenant-bucket}/tenants/{tenantId}/sessions/{sessionId}/memory.json` |
| Backup | S3 versioning on snapshots, cross-region replication for enterprise |

### 1.3 AgentCore Gateway

| Field | Value |
|-------|-------|
| Target types | `MCP_SERVER` (primary), `LAMBDA_FUNCTION`, `HTTP_ENDPOINT` |
| MCP server registrations | Platform skills registered as MCP targets: `code-review`, `web-search`, `email-reader`, `summarizer`, `file-manager`, `data-analyst`, `calendar`, `slack-bot`, `ticket-manager`, `doc-generator` |
| Tenant skill targets | Per-tenant MCP servers registered dynamically from `clawcore-skills` DynamoDB table |
| Sync config | Pull-based: Gateway polls DynamoDB skill registry every 60 seconds for changes. EventBridge trigger for immediate propagation on skill install/uninstall |
| Authentication | Gateway inherits tenant IAM role — tools scoped to tenant's S3 prefix and DynamoDB partition |
| Tool timeout | 30 seconds default, 300 seconds for long-running tools (code interpreter, web search) |
| Max concurrent tools | 5 per session (basic), 10 (pro), 25 (enterprise) |

### 1.4 AgentCore Identity

| Field | Value |
|-------|-------|
| Inbound auth (user -> agent) | Cognito JWT with `custom:tenant_id` claim. API Gateway Cognito authorizer validates on every request |
| Inbound flow | Client -> Cognito -> JWT -> API Gateway authorizer -> tenant router -> AgentCore |
| Outbound auth (agent -> external) | OAuth 2.0 (Slack, Jira, GitHub), API key (OpenAI, Anthropic, custom), IAM SigV4 (AWS services) |
| Token storage | Secrets Manager: `clawcore/{tenantId}/{service}` (e.g., `clawcore/acme/slack-oauth-token`) |
| Token refresh | Automatic rotation Lambda for OAuth tokens — 7-day rotation cycle |
| Token config | Access token TTL: 1 hour. Refresh token TTL: 30 days. Token caching via AWS SecretCache SDK |

### 1.5 AgentCore Code Interpreter

| Field | Value |
|-------|-------|
| Sandbox type | Firecracker MicroVM (OpenSandbox) |
| Supported languages | Python 3.12, JavaScript (Node 20), Bash |
| Timeout | 60 seconds (default), 300 seconds (max, enterprise only) |
| Resource limits | 1 vCPU, 512 MB memory (basic), 2 vCPU, 2 GB memory (pro/enterprise) |
| Network | Isolated by default. Enterprise: optional allowlist of HTTPS endpoints |
| File I/O | Upload: 50 MB max per file, 200 MB total per session. Download: same limits |
| Allowed Python packages | `numpy`, `pandas`, `matplotlib`, `scipy`, `scikit-learn`, `requests`, `beautifulsoup4`, `pillow`, `openpyxl`, `json`, `csv`, `re`, `datetime`, `math`, `statistics` |
| Persistence | Ephemeral — sandbox destroyed after execution. Results returned inline or to S3 |
| Billing | Per-execution-second, part of AgentCore consumption pricing |

### 1.6 AgentCore Browser

| Field | Value |
|-------|-------|
| CDP config | Chromium-based headless browser via Chrome DevTools Protocol |
| Session timeout | 5 minutes idle, 15 minutes absolute |
| Session recording | Disabled by default. Enterprise: optional HAR + screenshot recording to S3 |
| Viewport | 1280x720 (default), configurable per session |
| Network | Outbound HTTPS only. Proxy through VPC NAT for IP allowlisting |
| Max concurrent sessions | 2 (basic), 5 (pro), 20 (enterprise) |
| Allowed domains | Configurable per tenant — default: all. Enterprise: allowlist/blocklist |
| Resource limits | 2 vCPU, 2 GB memory per browser session |

### 1.7 AgentCore Observability

| Field | Value |
|-------|-------|
| OTel config | OpenTelemetry SDK auto-instrumented in agent runtime. OTLP exporter to CloudWatch |
| Trace sampling | 100% in dev/staging, 10% in prod (configurable per tenant) |
| Metrics namespace | `AgentPlatform` |
| Metric dimensions | `TenantId`, `AgentType`, `Environment`, `Endpoint` (production/canary) |
| Custom metrics emitted | `InvocationDuration` (ms), `TokensUsed` (count), `ToolCalls` (count), `Errors` (count), `ActiveSessions` (gauge), `CostAccumulated` (USD), `MemoryOperations` (count) |
| Log format | Structured JSON via EMF (Embedded Metric Format) |
| Log group | `/clawcore/{env}/agent-runtime` (platform), `/clawcore/{env}/tenant/{tenantId}` (per-tenant) |
| Log retention | 30 days (dev), 90 days (staging), 1 year (prod) |
| X-Ray integration | Enabled — traces span agent -> tool -> LLM call chains |
| CloudWatch dashboards | 1 platform dashboard + 1 per tenant (auto-created by AgentObservability construct) |

### 1.8 AgentCore Policy (Cedar)

| Field | Value |
|-------|-------|
| Cedar policy store | S3: `s3://{skills-bucket}/policies/` — 3 policy files |
| Policy files | `tenant-defaults.cedar` (base permissions), `skill-access.cedar` (tool-level access), `infra-modification.cedar` (self-modifying IaC limits) |
| Evaluation point | Lambda authorizer at API Gateway + inline in agent runtime before each tool call |
| Policy update flow | Git commit -> CodePipeline -> validate -> deploy to S3 -> agent runtime reloads on next session |
| Evaluation config | Cache: 5 min TTL in memory. Audit: every evaluation logged to CloudWatch with principal, action, resource, decision |
| Example policy | `permit(principal == Tenant::"acme", action == Action::"invoke_tool", resource == Tool::"code-review")` |
| Forbidden actions (hard-coded) | `modify_iam`, `modify_network`, `modify_platform`, `delete_tenant`, `access_other_tenant` |

### 1.9 AgentCore Evaluations

| Field | Value |
|-------|-------|
| Benchmark config | Built-in benchmarks: `tool_accuracy` (% correct tool selections), `response_quality` (LLM-as-judge), `latency_p99`, `cost_per_session`, `safety_score` (Bedrock Guardrails pass rate) |
| Scoring | 0-100 scale per benchmark. Composite score = weighted average (tool_accuracy: 30%, response_quality: 30%, latency: 15%, cost: 15%, safety: 10%) |
| Schedule | Weekly automated eval run via EventBridge: `cron(0 6 ? * SUN *)` |
| Dataset storage | S3: `s3://{skills-bucket}/evaluations/datasets/{benchmark}.jsonl` |
| Results storage | S3: `s3://{skills-bucket}/evaluations/results/{date}/{benchmark}.json` |
| Canary gate | New agent version must score >= 80 composite to be promoted from canary to production |
| Per-tenant evals | Enterprise: custom eval datasets uploaded to `s3://{tenant-bucket}/tenants/{tenantId}/evaluations/` |

---

## 2. DynamoDB Tables (6 Tables)

### 2.1 `clawcore-tenants`

| Field | Value |
|-------|-------|
| PK | `TENANT#{id}` (String) |
| SK | `META` (String) |
| GSI1 | PK: `tier` (String), SK: `tenantId` (String) — query tenants by tier |
| Capacity | On-demand (PAY_PER_REQUEST) for < 100 tenants. Switch to provisioned with auto-scaling at 100+ |
| TTL | `ttl` (Number, epoch seconds) — not used for tenant records (retained indefinitely) |
| Encryption | AWS-owned key (SSE-S3) — upgrade to CMK (SSE-KMS) for enterprise |
| PITR | Enabled |
| Stream | NEW_AND_OLD_IMAGES — triggers tenant config change events to EventBridge |
| Removal policy | RETAIN |
| Attributes | `tenantId`, `tier` (basic/pro/enterprise), `modelId`, `allowedSkills` (StringSet), `budgetLimitMonthlyUsd` (Number), `featureFlags` (Map), `createdAt`, `updatedAt` |

### 2.2 `clawcore-sessions`

| Field | Value |
|-------|-------|
| PK | `TENANT#{id}` (String) |
| SK | `SESSION#{id}` (String) |
| GSI1 | PK: `agentId` (String), SK: `lastActivity` (String, ISO 8601) — find active agents |
| Capacity | On-demand |
| TTL | `ttl` (Number) — set to 24 hours after last activity |
| Encryption | AWS-owned key |
| PITR | Enabled |
| Stream | NEW_AND_OLD_IMAGES — triggers session lifecycle events |
| Removal policy | RETAIN |
| Attributes | `sessionId`, `agentId`, `state` (Map: messages, tool_calls, memory), `channelType` (slack/web/discord), `channelUserId`, `createdAt`, `lastActivity`, `ttl`, `GSI1PK`, `GSI1SK` |

### 2.3 `clawcore-skills`

| Field | Value |
|-------|-------|
| PK | `TENANT#{id}` (String) |
| SK | `SKILL#{name}` (String) |
| GSI1 | PK: `skillName` (String), SK: `tenantId` (String) — find skill usage across tenants |
| Capacity | On-demand |
| TTL | None (skills persist until uninstalled) |
| Encryption | AWS-owned key |
| PITR | Enabled |
| Stream | NEW_AND_OLD_IMAGES — triggers Gateway MCP target sync |
| Removal policy | RETAIN |
| Attributes | `skillName`, `version` (String, semver), `s3Key` (skill package location), `mcpEndpoint` (URL if running as MCP server), `trustLevel` (verified/community/custom), `signatureEd25519`, `installedAt`, `lastUsed`, `invocationCount` (Number) |

### 2.4 `clawcore-rate-limits`

| Field | Value |
|-------|-------|
| PK | `TENANT#{id}` (String) |
| SK | `WINDOW#{timestamp}` (String, 1-minute window start ISO 8601) |
| GSI | None |
| Capacity | On-demand |
| TTL | `ttl` (Number) — set to 5 minutes after window end |
| Encryption | AWS-owned key |
| PITR | Disabled (ephemeral data, not worth PITR cost) |
| Stream | None |
| Removal policy | DESTROY (can be recreated from scratch) |
| Attributes | `requestCount` (Number, atomic counter), `tokenCount` (Number), `budgetConsumedUsd` (Number), `ttl` |

### 2.5 `clawcore-cost-tracking`

| Field | Value |
|-------|-------|
| PK | `TENANT#{id}` (String) |
| SK | `PERIOD#{yyyy-mm}` (String) |
| GSI | None |
| Capacity | On-demand |
| TTL | None (cost records retained for 2 years for billing reconciliation) |
| Encryption | AWS-owned key |
| PITR | Enabled |
| Stream | NEW_AND_OLD_IMAGES — triggers budget threshold alarms via EventBridge |
| Removal policy | RETAIN |
| Attributes | `totalCostUsd` (Number, atomic increment), `llmCostUsd`, `computeCostUsd`, `storageCostUsd`, `invocationCount`, `tokenCount`, `budgetLimitUsd`, `budgetAlertSent` (Boolean), `lastUpdated` |

### 2.6 `clawcore-audit`

| Field | Value |
|-------|-------|
| PK | `TENANT#{id}` (String) |
| SK | `EVENT#{timestamp}#{uuid}` (String — timestamp + UUID for uniqueness) |
| GSI1 | PK: `eventType` (String), SK: `timestamp` (String) — query all events of a type |
| Capacity | On-demand |
| TTL | `ttl` (Number) — 90 days (basic), 1 year (pro), 7 years (enterprise/compliance) |
| Encryption | SSE-KMS with customer-managed key (audit logs require CMK) |
| PITR | Enabled |
| Stream | None (audit is the final destination) |
| Removal policy | RETAIN |
| Attributes | `eventType` (auth_success/auth_failure/tool_invocation/policy_denial/config_change/skill_install/budget_alert), `principal`, `action`, `resource`, `decision` (allow/deny), `sourceIp`, `sessionId`, `details` (Map), `ttl` |

---

## 3. S3 Buckets (3 Buckets)

### 3.1 `clawcore-tenants-{accountId}-{region}`

| Field | Value |
|-------|-------|
| Purpose | Tenant data — memory snapshots, agent outputs, cron outputs, documents |
| Versioning | Enabled |
| Encryption | SSE-S3 (AES-256) |
| Block public access | All 4 settings enabled |
| CORS | Disabled (no direct browser access) |
| Lifecycle rules | (1) `intelligent-tiering`: transition to Intelligent-Tiering at 30 days. (2) `glacier-archive`: prefix `archive/` transitions to Glacier at 90 days. (3) `delete-old-versions`: noncurrent versions expire after 90 days |
| Replication | Cross-region to `us-east-1` for enterprise tenants (prefix filter: `tenants/{enterprise-tenant-ids}/*`) |
| Removal policy | RETAIN |
| Prefix structure | `tenants/{tenantId}/sessions/{sessionId}/memory.json`, `tenants/{tenantId}/outputs/{cronJobName}/{date}.md`, `tenants/{tenantId}/documents/`, `tenants/{tenantId}/evaluations/` |
| Access | Tenant IAM role scoped to `tenants/{tenantId}/*` prefix only |

### 3.2 `clawcore-skills-{accountId}-{region}`

| Field | Value |
|-------|-------|
| Purpose | Skill packages (SKILL.md + code), Cedar policies, evaluation datasets/results |
| Versioning | Enabled (skill versions tracked via S3 object versions) |
| Encryption | SSE-S3 |
| Block public access | All 4 settings enabled |
| CORS | Disabled |
| Lifecycle rules | (1) `noncurrent-versions`: expire noncurrent versions after 180 days |
| Replication | None (skills are code, redeployed from Git) |
| Removal policy | RETAIN |
| Prefix structure | `skills/global/{skillName}/SKILL.md`, `skills/marketplace/{skillName}/`, `skills/tenant/{tenantId}/{skillName}/`, `policies/*.cedar`, `evaluations/datasets/`, `evaluations/results/{date}/` |
| Access | Agent runtime role: read-only. Platform pipeline role: read-write |

### 3.3 `clawcore-artifacts-{accountId}-{region}`

| Field | Value |
|-------|-------|
| Purpose | Pipeline artifacts, CDK assets, CodeBuild outputs, drift detection reports |
| Versioning | Enabled |
| Encryption | SSE-S3 |
| Block public access | All 4 settings enabled |
| CORS | Disabled |
| Lifecycle rules | (1) `expire-old-artifacts`: expire objects after 90 days. (2) `expire-noncurrent`: expire noncurrent versions after 30 days |
| Replication | None |
| Removal policy | DESTROY (artifacts are reproducible from Git) |
| Prefix structure | `cdk-assets/`, `pipeline-artifacts/`, `drift-reports/`, `cost-reports/` |
| Access | CodePipeline role: read-write. CodeBuild role: read-write |

---

## 4. IAM Roles (7 Roles)

### 4.1 `clawcore-agent-runtime-role`

| Field | Value |
|-------|-------|
| Trust policy | `bedrock.amazonaws.com` |
| Managed policies | None (least privilege via inline) |
| Inline policies | (1) DynamoDB: `GetItem`, `PutItem`, `Query`, `UpdateItem`, `DeleteItem` on all 6 tables. (2) S3: `GetObject`, `PutObject` on tenant bucket, `GetObject` on skills bucket. (3) Bedrock: `InvokeModel`, `InvokeModelWithResponseStream` on allowed model ARNs. (4) Secrets Manager: `GetSecretValue` on `clawcore/*` prefix. (5) CloudWatch: `PutMetricData`, `PutLogEvents`. (6) EventBridge: `PutEvents` on `clawcore-events` bus |
| Condition keys | DynamoDB `LeadingKeys` condition scoped per tenant at runtime (Cedar evaluates before DynamoDB call) |

### 4.2 `clawcore-tenant-{tenantId}-role`

| Field | Value |
|-------|-------|
| Trust policy | `bedrock.amazonaws.com` (assumed by AgentCore Runtime on behalf of tenant) |
| Managed policies | None |
| Inline policies | (1) DynamoDB: all CRUD on 6 tables, **condition**: `dynamodb:LeadingKeys` must match `TENANT#{tenantId}*`. (2) S3: `GetObject`, `PutObject` scoped to `tenants/{tenantId}/*` on tenant bucket. (3) S3: `GetObject` on `skills/global/*` and `skills/tenant/{tenantId}/*` on skills bucket. (4) Bedrock: `InvokeModel` on model ARNs allowed for tenant's tier. (5) Secrets Manager: `GetSecretValue` on `clawcore/{tenantId}/*` only |
| Notes | Created dynamically by TenantAgent construct. Enterprise tenants get additional policy for dedicated runtime |

### 4.3 `clawcore-chat-service-role`

| Field | Value |
|-------|-------|
| Trust policy | `ecs-tasks.amazonaws.com` |
| Managed policies | `AmazonECSTaskExecutionRolePolicy` |
| Inline policies | (1) API Gateway: `execute-api:ManageConnections` on WebSocket API. (2) DynamoDB: `GetItem`, `PutItem`, `DeleteItem` on sessions table (connection tracking). (3) Cognito: `cognito-idp:GetUser` (validate JWT). (4) ECR: `GetAuthorizationToken`, `BatchGetImage` on chat SDK repo |

### 4.4 `clawcore-pipeline-role`

| Field | Value |
|-------|-------|
| Trust policy | `codepipeline.amazonaws.com`, `codebuild.amazonaws.com` |
| Managed policies | `AWSCodePipelineFullAccess` (scoped to `clawcore-*` pipelines) |
| Inline policies | (1) CloudFormation: `*` on stacks prefixed `ClawCore-*`. (2) S3: `*` on artifacts bucket. (3) ECR: `*` on `clawcore-*` repos. (4) IAM: `PassRole` on all `clawcore-*` roles. (5) SNS: `Publish` on approval topics |

### 4.5 `clawcore-eventbridge-scheduler-role`

| Field | Value |
|-------|-------|
| Trust policy | `scheduler.amazonaws.com` |
| Managed policies | None |
| Inline policies | (1) Step Functions: `StartExecution` on `clawcore-*` state machines. (2) Lambda: `InvokeFunction` on `clawcore-*` functions |

### 4.6 `clawcore-observability-role`

| Field | Value |
|-------|-------|
| Trust policy | `monitoring.amazonaws.com`, `xray.amazonaws.com` |
| Managed policies | `CloudWatchReadOnlyAccess`, `AWSXRayReadOnlyAccess` |
| Inline policies | (1) SNS: `Publish` on alarm notification topics. (2) Lambda: `InvokeFunction` on `clawcore-budget-enforcer` (disables cron on budget breach) |

### 4.7 `clawcore-drift-detection-role`

| Field | Value |
|-------|-------|
| Trust policy | `codebuild.amazonaws.com` |
| Managed policies | `ReadOnlyAccess` (for `cdk diff` against deployed stacks) |
| Inline policies | (1) SNS: `Publish` on drift alert topic. (2) S3: `PutObject` on artifacts bucket `drift-reports/` prefix |

---

## 5. Networking (VPC Design)

### VPC

| Field | Value |
|-------|-------|
| CIDR | `10.0.0.0/16` (65,536 IPs) |
| Max AZs | 3 |
| NAT Gateways | 2 (HA, cost-conscious; scale to 3 for prod-critical if needed) |

### Subnets

| Name | Type | CIDR mask | Purpose |
|------|------|-----------|---------|
| `public` | PUBLIC | /24 (3 x 254 IPs) | ALB, NAT Gateway |
| `private` | PRIVATE_WITH_EGRESS | /22 (3 x 1,022 IPs) | ECS Fargate tasks, Lambda, AgentCore |
| `isolated` | PRIVATE_ISOLATED | /24 (3 x 254 IPs) | DynamoDB (via VPC endpoint), ElastiCache (future) |

### VPC Endpoints

| Endpoint | Type | Purpose |
|----------|------|---------|
| `dynamodb` | Gateway | DynamoDB access without NAT (free) |
| `s3` | Gateway | S3 access without NAT (free) |
| `bedrock-runtime` | Interface | Bedrock model invocation (private link, ~$0.01/hr/AZ) |
| `bedrock-agent-runtime` | Interface | AgentCore API calls |
| `secretsmanager` | Interface | Credential retrieval |
| `ecr.api` | Interface | ECR API for image pulls |
| `ecr.dkr` | Interface | ECR Docker registry |
| `logs` | Interface | CloudWatch Logs delivery |
| `monitoring` | Interface | CloudWatch Metrics delivery |

### Security Groups

| SG Name | Inbound | Outbound | Attached to |
|---------|---------|----------|-------------|
| `clawcore-alb-sg` | 443 from 0.0.0.0/0 | 8080 to `clawcore-ecs-sg` | ALB |
| `clawcore-ecs-sg` | 8080 from `clawcore-alb-sg` | 443 to 0.0.0.0/0 (NAT/endpoints) | ECS Fargate tasks |
| `clawcore-agent-sg` | None (initiated outbound only) | 443 to 0.0.0.0/0 (NAT/endpoints) | AgentCore MicroVMs |
| `clawcore-vpc-endpoint-sg` | 443 from `clawcore-ecs-sg`, `clawcore-agent-sg` | None | All interface VPC endpoints |

---

## 6. CDK Code — Complete Platform Stack

```typescript
// bin/clawcore.ts — CDK App Entry Point
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { SecurityStack } from '../lib/stacks/security-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';
import { PlatformRuntimeStack } from '../lib/stacks/platform-runtime-stack';
import { ChatStack } from '../lib/stacks/chat-stack';
import { PipelineStack } from '../lib/stacks/pipeline-stack';
import { TenantStack } from '../lib/stacks/tenant-stack';

const app = new cdk.App();
const envName = app.node.tryGetContext('environment') ?? 'dev';

const envConfig: cdk.Environment = {
  account: app.node.tryGetContext('account') ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: app.node.tryGetContext('region') ?? 'us-west-2',
};

const prefix = `ClawCore-${envName}`;

// --- Stack 1: Network ---
const networkStack = new NetworkStack(app, `${prefix}-Network`, {
  env: envConfig,
  description: 'VPC, subnets, NAT gateways, VPC endpoints, security groups',
});

// --- Stack 2: Data ---
const dataStack = new DataStack(app, `${prefix}-Data`, {
  env: envConfig,
  vpc: networkStack.vpc,
  description: 'DynamoDB tables (6), S3 buckets (3), EFS',
});
dataStack.addDependency(networkStack);

// --- Stack 3: Security ---
const securityStack = new SecurityStack(app, `${prefix}-Security`, {
  env: envConfig,
  description: 'Cognito user pool, WAF, KMS keys',
});
securityStack.addDependency(networkStack);

// --- Stack 4: Observability ---
const observabilityStack = new ObservabilityStack(app, `${prefix}-Observability`, {
  env: envConfig,
  description: 'CloudWatch dashboards, alarms, SNS topics, X-Ray groups',
});
observabilityStack.addDependency(dataStack);

// --- Stack 5: Platform Runtime ---
const runtimeStack = new PlatformRuntimeStack(app, `${prefix}-Runtime`, {
  env: envConfig,
  vpc: networkStack.vpc,
  tenantsTable: dataStack.tenantsTable,
  sessionsTable: dataStack.sessionsTable,
  skillsTable: dataStack.skillsTable,
  rateLimitsTable: dataStack.rateLimitsTable,
  costTrackingTable: dataStack.costTrackingTable,
  auditTable: dataStack.auditTable,
  tenantBucket: dataStack.tenantBucket,
  skillsBucket: dataStack.skillsBucket,
  cognitoUserPool: securityStack.userPool,
  description: 'AgentCore Runtime, API Gateway, EventBridge bus',
});
runtimeStack.addDependency(networkStack);
runtimeStack.addDependency(dataStack);
runtimeStack.addDependency(securityStack);

// --- Stack 6: Chat ---
const chatStack = new ChatStack(app, `${prefix}-Chat`, {
  env: envConfig,
  vpc: networkStack.vpc,
  webSocketApi: runtimeStack.webSocketApi,
  cognitoUserPool: securityStack.userPool,
  sessionsTable: dataStack.sessionsTable,
  description: 'ECS Fargate Chat SDK service, ALB, SSE Bridge',
});
chatStack.addDependency(runtimeStack);

// --- Stack 7: Pipeline ---
const pipelineStack = new PipelineStack(app, `${prefix}-Pipeline`, {
  env: envConfig,
  description: 'CodePipeline, CodeBuild, ECR repos, approval gates',
});

// --- Stack 8: Tenant Stacks (one per tenant YAML) ---
const tenantsDir = path.join(__dirname, '..', 'tenants');
if (fs.existsSync(tenantsDir)) {
  const tenantFiles = fs.readdirSync(tenantsDir).filter(f => f.endsWith('.yaml'));
  for (const file of tenantFiles) {
    const config = yaml.parse(fs.readFileSync(path.join(tenantsDir, file), 'utf8'));
    const tenantStack = new TenantStack(app, `${prefix}-Tenant-${config.tenantId}`, {
      env: envConfig,
      tenantConfig: config,
      tenantsTable: dataStack.tenantsTable,
      sessionsTable: dataStack.sessionsTable,
      skillsTable: dataStack.skillsTable,
      rateLimitsTable: dataStack.rateLimitsTable,
      costTrackingTable: dataStack.costTrackingTable,
      auditTable: dataStack.auditTable,
      tenantBucket: dataStack.tenantBucket,
      skillsBucket: dataStack.skillsBucket,
      poolRuntime: runtimeStack.agentRuntime,
      eventBus: runtimeStack.eventBus,
      alarmTopic: observabilityStack.alarmTopic,
      description: `Tenant resources for ${config.tenantId}`,
    });
    tenantStack.addDependency(runtimeStack);
    tenantStack.addDependency(observabilityStack);
    tenantStack.addDependency(securityStack);
  }
}

app.synth();
```

### NetworkStack

```typescript
// lib/stacks/network-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly albSecurityGroup: ec2.ISecurityGroup;
  public readonly ecsSecurityGroup: ec2.ISecurityGroup;
  public readonly agentSecurityGroup: ec2.ISecurityGroup;
  public readonly endpointSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 3,
      natGateways: 2,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Gateway endpoints (free)
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Security group for VPC endpoints
    this.endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSG', {
      vpc: this.vpc,
      description: 'VPC endpoint security group',
      allowAllOutbound: false,
    });

    // Interface endpoints
    const interfaceEndpoints = [
      'bedrock-runtime', 'bedrock-agent-runtime', 'secretsmanager',
      'ecr.api', 'ecr.dkr', 'logs', 'monitoring',
    ];
    for (const svc of interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint(`${svc.replace('.', '-')}-endpoint`, {
        service: new ec2.InterfaceVpcEndpointAwsService(svc),
        privateDnsEnabled: true,
        securityGroups: [this.endpointSecurityGroup],
      });
    }

    // ALB security group
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: this.vpc,
      description: 'ALB - accepts HTTPS from internet',
      allowAllOutbound: false,
    });
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');

    // ECS security group
    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSG', {
      vpc: this.vpc,
      description: 'ECS Fargate tasks',
      allowAllOutbound: true,
    });
    this.ecsSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(8080), 'ALB to ECS');

    // Agent security group
    this.agentSecurityGroup = new ec2.SecurityGroup(this, 'AgentSG', {
      vpc: this.vpc,
      description: 'AgentCore MicroVMs',
      allowAllOutbound: true,
    });

    // Allow ECS and Agent SGs to reach VPC endpoints
    this.endpointSecurityGroup.addIngressRule(this.ecsSecurityGroup, ec2.Port.tcp(443), 'ECS to endpoints');
    this.endpointSecurityGroup.addIngressRule(this.agentSecurityGroup, ec2.Port.tcp(443), 'Agent to endpoints');

    // ALB outbound to ECS only
    this.albSecurityGroup.addEgressRule(this.ecsSecurityGroup, ec2.Port.tcp(8080), 'ALB to ECS');
  }
}
```

### DataStack

```typescript
// lib/stacks/data-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

interface DataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class DataStack extends cdk.Stack {
  public readonly tenantsTable: dynamodb.ITable;
  public readonly sessionsTable: dynamodb.ITable;
  public readonly skillsTable: dynamodb.ITable;
  public readonly rateLimitsTable: dynamodb.ITable;
  public readonly costTrackingTable: dynamodb.ITable;
  public readonly auditTable: dynamodb.ITable;
  public readonly tenantBucket: s3.IBucket;
  public readonly skillsBucket: s3.IBucket;
  public readonly artifactsBucket: s3.IBucket;
  public readonly agentWorkspace: efs.IFileSystem;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const auditKey = new kms.Key(this, 'AuditKey', {
      alias: 'clawcore-audit',
      enableKeyRotation: true,
      description: 'CMK for ClawCore audit log encryption',
    });

    // --- Table 1: Tenants ---
    this.tenantsTable = new dynamodb.Table(this, 'TenantsTable', {
      tableName: 'clawcore-tenants',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.tenantsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-tier',
      partitionKey: { name: 'tier', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Table 2: Sessions ---
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: 'clawcore-sessions',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-agent-activity',
      partitionKey: { name: 'agentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'lastActivity', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Table 3: Skills ---
    this.skillsTable = new dynamodb.Table(this, 'SkillsTable', {
      tableName: 'clawcore-skills',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.skillsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-skill-usage',
      partitionKey: { name: 'skillName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Table 4: Rate Limits ---
    this.rateLimitsTable = new dynamodb.Table(this, 'RateLimitsTable', {
      tableName: 'clawcore-rate-limits',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Table 5: Cost Tracking ---
    this.costTrackingTable = new dynamodb.Table(this, 'CostTrackingTable', {
      tableName: 'clawcore-cost-tracking',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- Table 6: Audit ---
    this.auditTable = new dynamodb.Table(this, 'AuditTable', {
      tableName: 'clawcore-audit',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: auditKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.auditTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-event-type',
      partitionKey: { name: 'eventType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- S3 Bucket 1: Tenant Data ---
    this.tenantBucket = new s3.Bucket(this, 'TenantBucket', {
      bucketName: `clawcore-tenants-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'intelligent-tiering',
          transitions: [{
            storageClass: s3.StorageClass.INTELLIGENT_TIERING,
            transitionAfter: cdk.Duration.days(30),
          }],
        },
        {
          id: 'glacier-archive',
          prefix: 'archive/',
          transitions: [{
            storageClass: s3.StorageClass.GLACIER,
            transitionAfter: cdk.Duration.days(90),
          }],
        },
        {
          id: 'delete-old-versions',
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- S3 Bucket 2: Skills ---
    this.skillsBucket = new s3.Bucket(this, 'SkillsBucket', {
      bucketName: `clawcore-skills-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{
        id: 'noncurrent-versions',
        noncurrentVersionExpiration: cdk.Duration.days(180),
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- S3 Bucket 3: Artifacts ---
    this.artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: `clawcore-artifacts-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'expire-old-artifacts',
          expiration: cdk.Duration.days(90),
        },
        {
          id: 'expire-noncurrent',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- EFS: Agent Workspaces ---
    this.agentWorkspace = new efs.FileSystem(this, 'AgentWorkspace', {
      vpc: props.vpc,
      throughputMode: efs.ThroughputMode.ELASTIC,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
    });
  }
}
```

### SecurityStack

```typescript
// lib/stacks/security-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export class SecurityStack extends cdk.Stack {
  public readonly userPool: cognito.IUserPool;
  public readonly webAcl: wafv2.CfnWebACL;
  public readonly platformKey: kms.IKey;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // KMS key for platform-level encryption
    this.platformKey = new kms.Key(this, 'PlatformKey', {
      alias: 'clawcore-platform',
      enableKeyRotation: true,
      description: 'ClawCore platform encryption key',
    });

    // Cognito User Pool (one per environment, tenants distinguished by custom claim)
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'clawcore-users',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      customAttributes: {
        tenant_id: new cognito.StringAttribute({ mutable: false }),
        tenant_tier: new cognito.StringAttribute({ mutable: true }),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.userPool = userPool;

    // App clients
    userPool.addClient('WebClient', {
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    userPool.addClient('CliClient', {
      authFlows: { userSrp: true },
      accessTokenValidity: cdk.Duration.hours(8),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // WAF Web ACL for API Gateway
    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: 'clawcore-api-waf',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'clawcore-waf',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'common-rules',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimit',
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'rate-limit',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'bad-inputs',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
  }
}
```

### ObservabilityStack

```typescript
// lib/stacks/observability-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class ObservabilityStack extends cdk.Stack {
  public readonly alarmTopic: sns.ITopic;
  public readonly platformDashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'clawcore-alarms',
      displayName: 'ClawCore Platform Alarms',
    });

    new logs.LogGroup(this, 'AgentRuntimeLogGroup', {
      logGroupName: `/clawcore/${cdk.Stack.of(this).stackName}/agent-runtime`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.platformDashboard = new cloudwatch.Dashboard(this, 'PlatformDashboard', {
      dashboardName: 'ClawCore-Platform',
    });

    const invocationDuration = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'InvocationDuration',
      statistic: 'p99',
      period: cdk.Duration.minutes(5),
    });

    const errorRate = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'Errors',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const tokenUsage = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'TokensUsed',
      statistic: 'Sum',
      period: cdk.Duration.hours(1),
    });

    const activeSessions = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'ActiveSessions',
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
    });

    this.platformDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Agent Latency (p99)',
        left: [invocationDuration],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Error Rate (5 min)',
        left: [errorRate],
        width: 12,
      }),
    );
    this.platformDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Token Usage (hourly)',
        left: [tokenUsage],
        width: 12,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Active Sessions',
        metrics: [activeSessions],
        width: 12,
      }),
    );

    // Platform error rate alarm
    new cloudwatch.Alarm(this, 'PlatformErrorRate', {
      metric: errorRate,
      threshold: 10,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Platform error rate exceeded 10 in 5min window',
    }).addAlarmAction({ bind: () => ({ alarmActionArn: this.alarmTopic.topicArn }) });

    // Platform latency alarm
    new cloudwatch.Alarm(this, 'PlatformLatency', {
      metric: invocationDuration,
      threshold: 60000,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Platform p99 latency exceeded 60s',
    }).addAlarmAction({ bind: () => ({ alarmActionArn: this.alarmTopic.topicArn }) });
  }
}
```

### PlatformRuntimeStack

```typescript
// lib/stacks/platform-runtime-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

interface PlatformRuntimeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  tenantsTable: dynamodb.ITable;
  sessionsTable: dynamodb.ITable;
  skillsTable: dynamodb.ITable;
  rateLimitsTable: dynamodb.ITable;
  costTrackingTable: dynamodb.ITable;
  auditTable: dynamodb.ITable;
  tenantBucket: s3.IBucket;
  skillsBucket: s3.IBucket;
  cognitoUserPool: cognito.IUserPool;
}

export class PlatformRuntimeStack extends cdk.Stack {
  public readonly agentRuntime: agentcore.Runtime;
  public readonly eventBus: events.IEventBus;
  public readonly webSocketApi: apigatewayv2.CfnApi;
  public readonly agentRuntimeRole: iam.IRole;

  constructor(scope: Construct, id: string, props: PlatformRuntimeStackProps) {
    super(scope, id, props);

    // IAM Role for agent runtime
    this.agentRuntimeRole = new iam.Role(this, 'AgentRuntimeRole', {
      roleName: 'clawcore-agent-runtime-role',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });

    // DynamoDB permissions on all 6 tables
    const tables = [
      props.tenantsTable, props.sessionsTable, props.skillsTable,
      props.rateLimitsTable, props.costTrackingTable, props.auditTable,
    ];
    for (const table of tables) {
      table.grantReadWriteData(this.agentRuntimeRole);
    }

    // S3 permissions
    props.tenantBucket.grantReadWrite(this.agentRuntimeRole);
    props.skillsBucket.grantRead(this.agentRuntimeRole);

    // Bedrock model invocation
    (this.agentRuntimeRole as iam.Role).addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-sonnet-*`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-opus-*`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-haiku-*`,
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.nova-*`,
      ],
    }));

    // Secrets Manager access
    (this.agentRuntimeRole as iam.Role).addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:clawcore/*`],
    }));

    // CloudWatch metrics and logs
    (this.agentRuntimeRole as iam.Role).addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'AgentPlatform' } },
    }));
    (this.agentRuntimeRole as iam.Role).addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/clawcore/*`],
    }));

    // AgentCore Runtime (pool)
    this.agentRuntime = new agentcore.Runtime(this, 'PoolRuntime', {
      runtimeName: 'clawcore-pool',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset('./agent-code'),
    });

    this.agentRuntime.addEndpoint('production', {
      description: 'Stable production endpoint for pooled tenants',
    });
    this.agentRuntime.addEndpoint('canary', {
      description: 'Canary endpoint - 5% traffic for validation',
    });

    // EventBridge custom bus
    this.eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: 'clawcore-events',
    });

    // Grant runtime to put events
    (this.agentRuntimeRole as iam.Role).addToPolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [this.eventBus.eventBusArn],
    }));

    // WebSocket API for real-time streaming
    this.webSocketApi = new apigatewayv2.CfnApi(this, 'WebSocketApi', {
      name: 'clawcore-websocket',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });
  }
}
```

### ChatStack

```typescript
// lib/stacks/chat-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

interface ChatStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  webSocketApi: apigatewayv2.CfnApi;
  cognitoUserPool: cognito.IUserPool;
  sessionsTable: dynamodb.ITable;
}

export class ChatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ChatStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, 'ChatCluster', {
      vpc: props.vpc,
      clusterName: 'clawcore-chat',
      containerInsights: true,
    });

    const chatService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'ChatService', {
      cluster,
      serviceName: 'chat-sdk',
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 2,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset('./chat-service'),
        containerPort: 8080,
        environment: {
          WEBSOCKET_API_ID: props.webSocketApi.ref,
          COGNITO_USER_POOL_ID: props.cognitoUserPool.userPoolId,
          SESSIONS_TABLE: 'clawcore-sessions',
          NODE_ENV: 'production',
        },
      },
      publicLoadBalancer: true,
      assignPublicIp: false,
    });

    // Auto-scaling
    const scaling = chatService.service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 20,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });
    scaling.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 1000,
      targetGroup: chatService.targetGroup,
    });

    // Grant DynamoDB access for connection tracking
    props.sessionsTable.grantReadWriteData(chatService.taskDefinition.taskRole);
  }
}
```

### TenantStack

```typescript
// lib/stacks/tenant-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

interface TenantConfig {
  tenantId: string;
  tier: 'basic' | 'pro' | 'enterprise';
  models?: { default?: string; complex?: string; fast?: string };
  skills?: string[];
  cronJobs?: Array<{
    name: string;
    schedule: string;
    promptKey: string;
    skills: string[];
    maxBudgetUsd: number;
    outputPrefix: string;
    notifications?: { slackChannel?: string; email?: string };
  }>;
  memoryStrategies?: string[];
  budgetLimitMonthlyUsd?: number;
}

interface TenantStackProps extends cdk.StackProps {
  tenantConfig: TenantConfig;
  tenantsTable: dynamodb.ITable;
  sessionsTable: dynamodb.ITable;
  skillsTable: dynamodb.ITable;
  rateLimitsTable: dynamodb.ITable;
  costTrackingTable: dynamodb.ITable;
  auditTable: dynamodb.ITable;
  tenantBucket: s3.IBucket;
  skillsBucket: s3.IBucket;
  poolRuntime: agentcore.Runtime;
  eventBus: events.IEventBus;
  alarmTopic: sns.ITopic;
}

export class TenantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TenantStackProps) {
    super(scope, id, props);

    const { tenantConfig: tc } = props;

    // --- Scoped IAM Role ---
    const tenantRole = new iam.Role(this, 'TenantRole', {
      roleName: `clawcore-tenant-${tc.tenantId}-role`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });

    // DynamoDB: all tables, but scoped to tenant partition
    const tables = [
      props.tenantsTable, props.sessionsTable, props.skillsTable,
      props.rateLimitsTable, props.costTrackingTable, props.auditTable,
    ];
    for (const table of tables) {
      table.grantReadWriteData(tenantRole);
    }
    // Deny access to other tenants' partitions
    tenantRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['dynamodb:*'],
      resources: tables.map(t => t.tableArn),
      conditions: {
        'ForAllValues:StringNotLike': {
          'dynamodb:LeadingKeys': [`TENANT#${tc.tenantId}*`],
        },
      },
    }));

    // S3: tenant prefix only
    props.tenantBucket.grantReadWrite(tenantRole, `tenants/${tc.tenantId}/*`);
    props.skillsBucket.grantRead(tenantRole, `skills/global/*`);
    props.skillsBucket.grantRead(tenantRole, `skills/tenant/${tc.tenantId}/*`);

    // Bedrock model access based on tier
    const modelPatterns = tc.tier === 'basic'
      ? ['anthropic.claude-haiku-*', 'amazon.nova-lite-*']
      : tc.tier === 'pro'
        ? ['anthropic.claude-sonnet-*', 'anthropic.claude-haiku-*', 'amazon.nova-*']
        : ['anthropic.claude-*', 'amazon.nova-*'];

    tenantRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: modelPatterns.map(p => `arn:aws:bedrock:${this.region}::foundation-model/${p}`),
    }));

    // Secrets Manager: tenant prefix only
    tenantRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:clawcore/${tc.tenantId}/*`],
    }));

    // --- Enterprise: Dedicated Runtime ---
    if (tc.tier === 'enterprise') {
      const dedicatedRuntime = new agentcore.Runtime(this, 'DedicatedRuntime', {
        runtimeName: `clawcore-${tc.tenantId}`,
        agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset('./agent-code'),
      });
      dedicatedRuntime.addEndpoint('production', {
        description: `Dedicated endpoint for ${tc.tenantId}`,
      });
    }

    // --- Cron Jobs (EventBridge + Step Functions) ---
    for (const job of tc.cronJobs ?? []) {
      const definition = new sfn.Pass(this, `${job.name}-Start`, {
        parameters: {
          'tenantId': tc.tenantId,
          'jobName': job.name,
          'promptKey': job.promptKey,
          'skills': job.skills,
          'maxBudgetUsd': job.maxBudgetUsd,
          'outputPrefix': job.outputPrefix,
        },
      });
      // In production: chain LoadPrompt -> InvokeAgent -> WriteOutput -> Notify

      const stateMachine = new sfn.StateMachine(this, `${job.name}-SM`, {
        stateMachineName: `clawcore-${tc.tenantId}-${job.name}`,
        definitionBody: sfn.DefinitionBody.fromChainable(definition),
        timeout: cdk.Duration.minutes(30),
      });

      new events.Rule(this, `${job.name}-Schedule`, {
        ruleName: `clawcore-${tc.tenantId}-${job.name}`,
        schedule: events.Schedule.expression(job.schedule),
        targets: [new targets.SfnStateMachine(stateMachine)],
      });
    }

    // --- Per-Tenant Observability ---
    const dashboard = new cloudwatch.Dashboard(this, 'TenantDashboard', {
      dashboardName: `ClawCore-Tenant-${tc.tenantId}`,
    });

    const tenantErrors = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'Errors',
      dimensionsMap: { TenantId: tc.tenantId },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const tenantLatency = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'InvocationDuration',
      dimensionsMap: { TenantId: tc.tenantId },
      statistic: 'p99',
      period: cdk.Duration.minutes(5),
    });

    const tenantTokens = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'TokensUsed',
      dimensionsMap: { TenantId: tc.tenantId },
      statistic: 'Sum',
      period: cdk.Duration.hours(1),
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Errors', left: [tenantErrors], width: 8 }),
      new cloudwatch.GraphWidget({ title: 'Latency (p99)', left: [tenantLatency], width: 8 }),
      new cloudwatch.GraphWidget({ title: 'Tokens/hr', left: [tenantTokens], width: 8 }),
    );

    // Budget alarm
    if (tc.budgetLimitMonthlyUsd) {
      const budgetMetric = new cloudwatch.Metric({
        namespace: 'AgentPlatform',
        metricName: 'CostAccumulated',
        dimensionsMap: { TenantId: tc.tenantId },
        statistic: 'Maximum',
        period: cdk.Duration.hours(1),
      });

      new cloudwatch.Alarm(this, 'BudgetAlarm', {
        metric: budgetMetric,
        threshold: tc.budgetLimitMonthlyUsd * 0.9,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: `Tenant ${tc.tenantId} at 90% of $${tc.budgetLimitMonthlyUsd} monthly budget`,
      }).addAlarmAction({ bind: () => ({ alarmActionArn: props.alarmTopic.topicArn }) });
    }
  }
}
```

---

## 7. CloudFormation Outputs

Exported by platform stacks for tenant stacks to import:

| Stack | Export Name | Value | Consumer |
|-------|------------|-------|----------|
| NetworkStack | `ClawCore-{env}-VpcId` | VPC ID | DataStack, ChatStack, TenantStack |
| NetworkStack | `ClawCore-{env}-PrivateSubnetIds` | Comma-separated subnet IDs | ChatStack |
| NetworkStack | `ClawCore-{env}-AgentSGId` | Agent security group ID | PlatformRuntimeStack |
| DataStack | `ClawCore-{env}-TenantsTableArn` | DynamoDB table ARN | PlatformRuntimeStack, TenantStack |
| DataStack | `ClawCore-{env}-SessionsTableArn` | DynamoDB table ARN | PlatformRuntimeStack, ChatStack, TenantStack |
| DataStack | `ClawCore-{env}-SkillsTableArn` | DynamoDB table ARN | PlatformRuntimeStack, TenantStack |
| DataStack | `ClawCore-{env}-RateLimitsTableArn` | DynamoDB table ARN | PlatformRuntimeStack, TenantStack |
| DataStack | `ClawCore-{env}-CostTrackingTableArn` | DynamoDB table ARN | PlatformRuntimeStack, TenantStack |
| DataStack | `ClawCore-{env}-AuditTableArn` | DynamoDB table ARN | PlatformRuntimeStack, TenantStack |
| DataStack | `ClawCore-{env}-TenantBucketArn` | S3 bucket ARN | PlatformRuntimeStack, TenantStack |
| DataStack | `ClawCore-{env}-SkillsBucketArn` | S3 bucket ARN | PlatformRuntimeStack, TenantStack |
| SecurityStack | `ClawCore-{env}-UserPoolId` | Cognito user pool ID | PlatformRuntimeStack, ChatStack |
| SecurityStack | `ClawCore-{env}-UserPoolArn` | Cognito user pool ARN | PlatformRuntimeStack |
| SecurityStack | `ClawCore-{env}-WebAclArn` | WAF Web ACL ARN | PlatformRuntimeStack (API GW association) |
| ObservabilityStack | `ClawCore-{env}-AlarmTopicArn` | SNS topic ARN | TenantStack |
| PlatformRuntimeStack | `ClawCore-{env}-PoolRuntimeArn` | AgentCore Runtime ARN | TenantStack |
| PlatformRuntimeStack | `ClawCore-{env}-EventBusArn` | EventBridge bus ARN | TenantStack |
| PlatformRuntimeStack | `ClawCore-{env}-WebSocketApiId` | API Gateway WebSocket API ID | ChatStack |

---

## 8. Cost Estimate — 100 Tenants (Monthly)

### Platform Fixed Costs (shared infrastructure)

| Resource | Configuration | Monthly Cost |
|----------|--------------|-------------|
| VPC NAT Gateways (x2) | ~100 GB data processed each | $90 ($45/gateway) + $9 data |
| VPC Interface Endpoints (x7) | 7 endpoints x 3 AZs | $152 ($0.01/hr/AZ) |
| ECS Fargate (Chat SDK) | 2 tasks x 0.5 vCPU x 1 GB, 24/7 | $29 |
| ALB | 1 ALB, ~100K requests/day | $22 |
| CloudWatch Dashboards | 2 platform dashboards | $6 |
| CloudWatch Alarms | ~20 platform alarms | $2 |
| CloudWatch Logs | ~50 GB/month ingested | $25 |
| SNS (alarm notifications) | ~1K messages/month | $0.01 |
| KMS (audit key) | 1 CMK + ~10K requests | $1.10 |
| S3 (artifacts bucket) | ~10 GB | $0.23 |
| CodePipeline | 1 pipeline | $1 |
| CodeBuild | ~30 builds/month x 10 min | $3 |
| EventBridge | ~500K events/month | $0.50 |
| EFS | ~5 GB Standard + Elastic throughput | $1.70 |
| **Platform subtotal** | | **~$343** |

### Per-Tenant Variable Costs (at moderate usage)

| Resource | Basic (50 tenants) | Pro (40 tenants) | Enterprise (10 tenants) | Total |
|----------|--------------------|------------------|------------------------|-------|
| AgentCore Runtime | $0.15 x 50 = $7.50 | $1.50 x 40 = $60 | $30 x 10 = $300 | $367.50 |
| LLM tokens (Bedrock) | $1.35 x 50 = $67.50 | $13.50 x 40 = $540 | $67.50 x 10 = $675 | $1,282.50 |
| DynamoDB (6 tables, on-demand) | $0.05 x 50 = $2.50 | $0.50 x 40 = $20 | $2.50 x 10 = $25 | $47.50 |
| S3 (tenant bucket) | $0.01 x 50 = $0.50 | $0.05 x 40 = $2 | $0.25 x 10 = $2.50 | $5 |
| Secrets Manager | $0 (no custom secrets) | $0.40 x 2 x 40 = $32 | $0.40 x 5 x 10 = $20 | $52 |
| CloudWatch (per-tenant) | $0.05 x 50 = $2.50 | $0.25 x 40 = $10 | $1.25 x 10 = $12.50 | $25 |
| Step Functions (cron) | $0 (no cron) | $0.10 x 40 = $4 | $0.50 x 10 = $5 | $9 |
| Cognito MAU | $0.0055 x 50 = $0.28 | $0.0055 x 40 = $0.22 | $0.015 x 10 = $0.15 | $0.65 |
| Dedicated runtime (enterprise) | - | - | $45 x 10 = $450 | $450 |
| **Per-tenant subtotal** | **$80.78** | **$668.22** | **$1,490.15** | **$2,239.15** |

### Total Monthly Cost at 100 Tenants

| Category | Cost |
|----------|------|
| Platform fixed | $343 |
| Tenant variable | $2,239 |
| **Grand total** | **~$2,582/month** |
| **Per-tenant average** | **~$25.82/month** |

### Cost Optimization Levers

| Optimization | Savings | When to Apply |
|-------------|---------|---------------|
| Prompt caching (Bedrock native) | 67% on input tokens (~$860/mo) | Always — enable day one |
| Model routing (Nova Lite for simple queries) | 40% on LLM costs (~$513/mo) | After classifier trained |
| DynamoDB provisioned + reserved | 60-70% on DDB (~$30/mo) | At 100+ tenants with stable patterns |
| NAT Gateway savings (VPC endpoints cover most) | Already applied | Already in design |
| Savings Plans (Fargate) | 20% on ECS ($6/mo) | After 6+ months steady state |
| S3 Intelligent-Tiering | 30-50% on cold data | Already in lifecycle rules |

---

*Blueprint authored 2026-03-19. Reconciled from Final Architecture Plan, Platform IaC Review, and AWS Services Infrastructure research.*
