---
title: "Chimera System Architecture"
version: 1.0.0
status: canonical
last_updated: 2026-03-30
task: chimera-17ef
---

# Chimera System Architecture

Comprehensive architecture diagrams for the AWS Chimera multi-tenant agent platform. Covers CDK stack topology, runtime request flows, authentication, self-evolution, multi-tenant data isolation, skill lifecycle, deployment pipeline, and agent session state.

---

## 1. System Overview — 14 CDK Stacks

The full infrastructure is expressed as 14 CloudFormation stacks synthesized under the `Chimera-{env}` prefix. Arrows represent explicit `addDependency()` edges.

```mermaid
flowchart TD
    NET[Network\nVPC · subnets · NAT\nVPC endpoints · SGs]
    DATA[Data\n6 DynamoDB tables · 3 S3 buckets\nDAX cluster]
    SEC[Security\nCognito · WAF WebACL\nKMS CMK]
    OBS[Observability\nCloudWatch · SNS alarms\nX-Ray]
    API[Api\nREST API · WebSocket\nJWT authorizer]
    PIPE[Pipeline\nCodePipeline · CodeCommit\nCodeBuild · ECR repos]
    SKILL[SkillPipeline\nStep Functions\n7-stage scanner]
    CHAT[Chat\nECS Fargate · ALB\nCloudFront OAC]
    ORCH[Orchestration\nEventBridge · SQS FIFO\nA2A queues]
    EVO[Evolution\nStep Functions engine\nDynamoDB state · S3 artifacts]
    TENANT[TenantOnboarding\nStep Functions workflow\nCedar policy store · Lambdas]
    EMAIL[Email\nSES receipt rules · S3\nParser / Sender Lambdas]
    FRONT[Frontend\nS3 + CloudFront OAC\nReact SPA]
    GW[GatewayRegistration\nAgentCore Gateway targets\nMCP endpoint registry]

    NET --> DATA
    NET --> CHAT
    DATA --> OBS
    DATA --> SKILL
    DATA --> EVO
    DATA --> TENANT
    DATA --> EMAIL
    SEC --> OBS
    SEC --> API
    SEC --> ORCH
    SEC --> TENANT
    PIPE --> CHAT
    OBS --> TENANT
    ORCH --> EMAIL
```

**Stack responsibilities at a glance:**

| Stack | Key Resources |
|-------|---------------|
| Network | VPC, public/private subnets, NAT gateways, VPC endpoints, security groups |
| Data | 6 DynamoDB tables, 3 S3 buckets, optional DAX cluster |
| Security | Cognito user pool + app client, WAF WebACL, KMS CMK |
| Observability | CloudWatch dashboards, SNS alarm topic, DDB throttle alarms |
| Api | REST API (v1 + WebSocket), JWT authorizer, webhook routes |
| Pipeline | CodePipeline, CodeCommit repo, CodeBuild project, ECR repositories |
| SkillPipeline | Step Functions 7-stage skill security scanner |
| Chat | ECS Fargate cluster + service, ALB, CloudFront OAC distribution |
| Orchestration | EventBridge bus, SQS FIFO task queues, agent-to-agent queues |
| Evolution | Step Functions evolution engine, DynamoDB state table, S3 artifacts |
| TenantOnboarding | Step Functions provisioning workflow, Cedar policy store, Lambda functions |
| Email | SES receipt rules, S3 inbound bucket, parser/sender Lambdas, SQS queue |
| Frontend | S3 bucket + CloudFront OAC, React SPA hosting |
| GatewayRegistration | AgentCore Gateway targets, MCP endpoint registry |

---

## 2. CLI Command Lifecycle

The primary happy path from a fresh machine to active chat session.

```mermaid
flowchart LR
    A([chimera init]) -->|chimera.toml created\nadmin email stored| B([chimera deploy])
    B -->|source → CodeCommit\nnpx cdk deploy Pipeline| C([chimera setup])
    C -->|provisions admin\nCognito user| D([chimera connect])
    D -->|fetches endpoints\ninto chimera.toml| E([chimera login])
    E -->|Cognito tokens\n→ ~/.chimera/credentials| F([chimera chat])
    F -->|SSE stream\nvia ALB /chat/stream| G([agent response])

    style A fill:#2d6a4f,color:#fff
    style G fill:#1d3557,color:#fff
```

**Command registry (14 commands):**
`chat` · `connect` (deprecated) · `deploy` · `destroy` · `doctor` · `init` · `login` · `session` · `setup` · `skill` · `status` · `sync` · `tenant` · `upgrade`

---

## 3. Chat Request Flow

From user keystroke to streamed token, showing every hop across components.

```mermaid
sequenceDiagram
    participant U as User (CLI / Web)
    participant CLI as chimera chat\n(ink TUI / readline)
    participant ALB as ALB\n(ECS Fargate)
    participant GW as Hono\nchat-gateway
    participant AUTH as optionalAuth\nmiddleware
    participant TC as extractTenantContext\nmiddleware
    participant RL as rateLimitMiddleware
    participant AGENT as AgentCore\nRuntime (MicroVM)
    participant STRANDS as Strands\nReAct Loop
    participant TOOLS as AWS Tools\n(40 implementations)

    U->>CLI: user types message
    CLI->>ALB: POST /chat/stream\nAuthorization: Bearer <JWT>
    ALB->>GW: HTTP request
    GW->>AUTH: optionalAuth (extracts JWT claims)
    AUTH->>TC: extractTenantContext\n(tenantId from JWT or header)
    TC->>RL: rateLimitMiddleware\n(token bucket check)
    RL->>AGENT: invoke agent\n(tenantId · userId · message)
    AGENT->>STRANDS: hydrate session\n(AgentCore Memory STM)
    loop ReAct iterations (max 20)
        STRANDS->>TOOLS: tool call (Cedar policy check)
        TOOLS-->>STRANDS: tool result
    end
    STRANDS-->>AGENT: final response
    AGENT-->>GW: SSE stream (data: {"type":"token",...})
    GW-->>ALB: chunked SSE response
    ALB-->>CLI: stream tokens
    CLI-->>U: render via ink / stdout
```

---

## 4. Authentication Flow

Terminal login path: `chimera login` → Cognito challenge loop → credentials file → API calls.

```mermaid
sequenceDiagram
    participant CLI as chimera login
    participant INQ as inquirer\nprompt
    participant COG as Cognito\nInitiateAuth
    participant CHAL as RespondToAuthChallenge
    participant CREDS as ~/.chimera/credentials\n(TOML)
    participant API as api-client.ts\n(chat requests)
    participant GW as chat-gateway\noptionalAuth

    CLI->>INQ: mode prompt (Terminal / Browser)
    INQ-->>CLI: terminal selected
    CLI->>INQ: email + password prompts
    INQ-->>CLI: credentials
    CLI->>COG: InitiateAuth\nUSER_PASSWORD_AUTH
    COG-->>CLI: ChallengeName or AuthResult

    loop Challenge chain (NEW_PASSWORD_REQUIRED · SOFTWARE_TOKEN_MFA · SMS_MFA · MFA_SETUP)
        CLI->>INQ: challenge-specific prompt
        INQ-->>CLI: response
        CLI->>CHAL: RespondToAuthChallenge
        CHAL-->>CLI: next challenge or AuthResult
    end

    CLI->>CREDS: saveCredentials()\naccess_token · id_token · refresh_token · expires_at
    Note over CREDS: ~/.chimera/credentials (TOML format)

    API->>CREDS: loadCredentials()
    API->>GW: POST /chat/stream\nAuthorization: Bearer <access_token>
    GW-->>API: SSE response
```

**Key convention:** Cognito MFA must be set to `OPTIONAL` (not `REQUIRED`) so admin CLI users without a registered MFA device can still authenticate. The challenge loop handles MFA gracefully when present.

---

## 5. Self-Evolution Flow

How the evolution engine detects patterns, generates infrastructure, and deploys it safely.

```mermaid
flowchart TD
    DETECT[Pattern Detector\nDetects ≥3 repeated tool patterns\nor feedback signals]
    HARNESS[Safety Harness\n① Rate limit check\n② Cedar policy eval\n③ Cost impact check\n④ S3 snapshot]
    HUMAN{Human approval\nrequired?}
    HITL[HITL Gateway\nWaits for approval]
    AUTOSKILL[AutoSkillGenerator\nGenerates SKILL.md v2\n+ implementation code]
    IACMOD[IaC Modifier\nGenerates CDK TypeScript\nfrom requirements]
    COMMIT[CodeCommit push\nvia pushToCodeCommit()]
    PIPELINE[CodePipeline\ntriggered automatically]
    BUILD[CodeBuild\nnpx cdk deploy]
    ECR[ECR push\n Docker image]
    ECS[ECS Fargate\nrolling update]
    REGISTER[GatewayRegistration\nnew MCP endpoint registered]
    MONITOR[Post-health check\ndrop >10% → auto-rollback]

    DETECT --> HARNESS
    HARNESS --> HUMAN
    HUMAN -- "> $50/mo or\ndelete/modify-IAM" --> HITL
    HITL --> IACMOD
    HUMAN -- "Safe change" --> AUTOSKILL
    HUMAN -- "Infra change" --> IACMOD
    AUTOSKILL --> COMMIT
    IACMOD --> COMMIT
    COMMIT --> PIPELINE
    PIPELINE --> BUILD
    BUILD --> ECR
    ECR --> ECS
    ECS --> REGISTER
    REGISTER --> MONITOR
    MONITOR -- "Healthy" --> DETECT
    MONITOR -- "Degraded" --> ROLLBACK[Auto-rollback\nrestore S3 snapshot]
```

**Safety limits:** 10 evolutions/day total · 3 infra changes/day · 3 prompt A/B tests/week

---

## 6. Multi-Tenant Data Flow

How tenant isolation is enforced from JWT extraction through to memory namespacing.

```mermaid
flowchart TD
    JWT[Cognito JWT\nclaims: tenantId · tier · role]
    GW[chat-gateway\nextractTenantContext]
    RATE[Rate limiter\ntoken bucket in\nchimera-rate-limits]
    CEDAR[Cedar policy engine\npermit / forbid decision]
    AGENT[AgentCore Runtime\nMicroVM per tenant]
    MEM[AgentCore Memory\nnamespace: tenant-X-user-Y]
    DDB[DynamoDB\nPK: tenantId#resourceId]
    GSI[GSI queries\nFilterExpression: tenantId = :tid]
    KMS[KMS CMK\nper-tenant encryption key]
    AUDIT[chimera-audit\nCMK encrypted · 90d TTL]

    JWT --> GW
    GW --> RATE
    RATE --> CEDAR
    CEDAR --> AGENT
    AGENT --> MEM
    AGENT --> DDB
    DDB --> GSI
    DDB --> KMS
    AGENT --> AUDIT

    style CEDAR fill:#c0392b,color:#fff
    style KMS fill:#8e44ad,color:#fff
```

**Critical convention:** All DynamoDB GSI queries MUST include `FilterExpression: 'tenantId = :tid'`. GSI keys do not enforce partition isolation — without the filter, a query on a shared status GSI could return rows from other tenants.

---

## 7. Skill Lifecycle

From skill upload to agent discovery and execution.

```mermaid
flowchart LR
    UPLOAD[S3 upload\nskill bundle\nSKILL.md v2 + code]
    P1[Stage 1\nStatic analysis\ncode scanning]
    P2[Stage 2\nDependency audit\nvulnerability check]
    P3[Stage 3\nCedar policy\ncompliance]
    P4[Stage 4\nSandbox test\nCode Interpreter]
    P5[Stage 5\nResource limits\ncost estimation]
    P6[Stage 6\nCost ceiling\ncheck]
    P7[Stage 7\nManual review\nfor trust < 2]
    REGISTRY[chimera-skills\nDynamoDB registry]
    GW[AgentCore Gateway\nMCP endpoint target]
    DISCO[Skill discovery\nload for session]
    EXEC[Agent execution\n@tool or Sandbox\nor Lambda]

    UPLOAD --> P1 --> P2 --> P3 --> P4 --> P5 --> P6 --> P7
    P7 --> REGISTRY
    REGISTRY --> GW
    GW --> DISCO
    DISCO --> EXEC
```

**Trust tiers:** Platform (0) · Verified (1) · Community (2) · Private (3) · Experimental (4). Manual review (Stage 7) is triggered for trust levels 3 and 4.

**Execution modes:** `inline` (@tool decorated, trusted) · `sandbox` (Code Interpreter, untrusted) · `mcp` (AgentCore Gateway) · `lambda` (compute-intensive)

---

## 8. Deploy Pipeline

`chimera deploy` orchestrates source resolution, CodeCommit push, and CDK synthesis.

```mermaid
sequenceDiagram
    participant DEV as Developer
    participant CLI as chimera deploy
    participant STS as AWS STS
    participant CC as CodeCommit
    participant CFN as CloudFormation
    participant CDK as npx cdk\n(Node runtime)
    participant PIPE as CodePipeline
    participant BUILD as CodeBuild
    participant ECR as ECR
    participant ECS as ECS Fargate

    DEV->>CLI: chimera deploy --source local
    CLI->>STS: get-caller-identity (verify creds)
    STS-->>CLI: account ID
    CLI->>CLI: resolveSourcePath()\n(local / github-release / git-clone)
    CLI->>CC: ensureCodeCommitRepo()\ncreate if not exists
    CLI->>CC: pushToCodeCommit()\nbatched CreateCommit API (5 MB batches)
    CC-->>CLI: commit SHA

    alt Pipeline stack does NOT exist
        CLI->>CDK: npx cdk deploy Chimera-dev-Pipeline\n--require-approval never
        CDK->>CFN: CreateStack / UpdateStack
        CFN-->>CDK: stack outputs (ECR repo ARNs)
    else Pipeline stack already deployed
        CLI-->>DEV: "CodePipeline will handle deployment"
    end

    Note over CC,ECS: Automatic pipeline execution on each push

    CC->>PIPE: source change triggers pipeline
    PIPE->>BUILD: Source → Build stage
    BUILD->>BUILD: docker build (2-container pattern:\nbuild container + runtime container)
    BUILD->>ECR: docker push chat-gateway image
    ECR->>ECS: ECS rolling update\n(new task definition)
    ECS-->>DEV: deployment complete
```

**CDK runtime note:** All CDK commands use `npx cdk` (Node.js runtime). `bunx cdk` breaks CDK `instanceof` checks, causing `TypeError: peer.canInlineRule is not a function` in security group rules.

---

## 9. Agent Session State

State machine for a single agent session from creation to expiry.

```mermaid
stateDiagram-v2
    [*] --> Created : POST /chat/stream\n(new sessionId)

    Created --> Active : AgentCore Runtime\nsession hydrated\n(STM loaded)

    Active --> Streaming : Strands ReAct loop\nbegins

    Streaming --> Active : tool call completes\n(awaiting next iteration)

    Streaming --> Idle : [DONE] event\nfinal response sent

    Active --> Idle : max_iterations(20)\nreached

    Idle --> Active : follow-up message\n(same sessionId)

    Idle --> Expired : TTL elapsed\n(Basic=30min · Advanced=2h · Premium=24h)

    Streaming --> Error : unhandled exception\nor Cedar deny

    Error --> Idle : error response\nstreamed to client

    Expired --> [*] : DynamoDB TTL\ncleans session record

    note right of Streaming
        SSE events:
        {"type":"token","content":"..."}
        {"type":"done"}
        {"type":"error","error":"..."}
    end note
```

**Session ID format:** `tenant-{tenantId}-user-{userId}-{uuid}`

**Memory window by tier:**
- Basic: STM 10 turns
- Advanced: STM 50 turns
- Premium: STM 200 turns

LTM compression strategy: SUMMARY (all tiers), USER_PREFERENCE (Advanced+), SEMANTIC_MEMORY (Premium)

---

## Cross-Reference

| Diagram | Related Docs |
|---------|-------------|
| CDK Stacks (§1) | [deployment-architecture.md](deployment-architecture.md) |
| CLI Lifecycle (§2) | [cli-lifecycle.md](cli-lifecycle.md) |
| Request Flow (§3) | [agent-architecture.md](agent-architecture.md) §1 |
| Auth Flow (§4) | `packages/cli/src/commands/login.ts`, `packages/cli/src/auth/` |
| Self-Evolution (§5) | [agent-architecture.md](agent-architecture.md) §4 |
| Multi-Tenant (§6) | [canonical-data-model.md](canonical-data-model.md) |
| Skill Lifecycle (§7) | [agent-architecture.md](agent-architecture.md) §3 |
| Deploy Pipeline (§8) | `packages/cli/src/commands/deploy.ts` |
| Session State (§9) | [agent-architecture.md](agent-architecture.md) §1, §7 |

---

*Author: builder-arch-docs | Task: chimera-17ef | Status: Canonical*
