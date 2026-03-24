---
title: "Manus AI Capabilities - Chimera Integration Research"
version: 1.0.0
status: canonical
last_updated: 2026-03-24
task_id: chimera-6e32
agent: lead-research-manus
---

# Manus AI Capabilities - Chimera Integration Research

## Executive Summary

Manus is a proprietary autonomous AI agent platform (launched March 6, 2025; acquired by Meta for $2B+ in December 2025) providing cloud VMs where agents plan, execute, and deliver tasks end-to-end.

### Key Capabilities
- Browser automation
- Sandboxed code execution
- OAuth connectors (Gmail, GitHub, Slack, Notion)
- Scheduled tasks
- Webhooks
- Web app builder

### Integration Assessment

Chimera already has AWS-native equivalents for approximately **70% of Manus capabilities**. The highest-value **new** integrations identified are:

| Priority | Integration | Value |
|----------|-------------|-------|
| 1 | SES email notifications and mail-triggered tasks | High |
| 2 | OAuth connector framework | High |
| 3 | Visual session replay | Medium |
| 4 | Scheduled recurring agent tasks via EventBridge Scheduler | Medium |
| 5 | Webhook lifecycle events | Medium |

---

## Manus Overview

### Identity

- **Type**: Proprietary SaaS
- **Compliance**: SOC2 Type 1/2, ISO 27001/27701
- **Subprocessors**: Anthropic, GCP, Azure AI Foundry, AWS
- **Pricing Model**: Credit-based

### Architecture

**Execution Model**: CodeAct - LLM writes executable Python as action mechanism (not JSON tool calls). Each task gets an isolated Ubuntu VM (Python 3.10, Node 20) with browser, filesystem, and network access.

**Data Flow**:
```
Client
  → REST API
  → Orchestrator
  → Agent Loop (one action per iteration)
  → Sandbox VM
  → Connectors
  → Persistence
  → Webhooks
```

**Models**:
- Primary: Claude 3.5 Sonnet
- Supplementary: Alibaba Qwen
- Agent profiles: `manus-1.6` and `manus-1.6-max`
- OpenAI-compatible API available

---

## Capability Inventory

### 1. Browser Automation

- **Cloud browser**: Sandboxed VM with full browser access
- **Browser Operator**: Chrome/Edge extension (launched November 2025) for local browser control
- **Technology**: `browser-use` library + YOLOv9s vision AI for page understanding
- **Use cases**: Agents use cloud browser for clean environments and local browser for authenticated sessions

### 2. Sandboxed Code Execution

- **Languages**: Python, JS/TS, Bash, HTML/CSS, SQL, PHP, Ruby, Java, C/C++, Go
- **Frameworks**: React, Vue, Angular, Express, Django, Flask
- **Execution Model**: CodeAct - LLM writes executable code, sandbox runs one action at a time
- **Package Management**: Can install packages dynamically

### 3. Email

- **Gmail Connector**: OAuth integration for scanning/summarizing/inbox management
- **Mail Manus**: Users forward emails to personal Manus address to trigger tasks (reads attachments)
- **Scheduled Digests**: Automated email summaries
- **Note**: Does **not** use AWS SES - uses OAuth to user accounts

### 4. File Management

- **Persistent Filesystem**: Files survive across tasks within sandbox lifecycle
- **Files API**: Upload via file ID, public URL, or base64 encoding
- **Artifact Retention**:
  - Free tier: 7 days before sandbox recycle
  - Pro tier: 21 days before sandbox recycle
- **Temporary Files**: Deleted on sandbox recycle

### 5. OAuth Connectors

**Supported Services**:
- Gmail
- Google Calendar
- Notion
- GitHub
- Linear
- monday.com
- Supabase/Postgres
- Slack
- Stripe
- Similarweb

**Implementation**: Each connector has a UUID for API access. Custom MCP connectors supported.

### 6. Scheduling

- **Syntax**: CRON-like (daily/weekly/monthly/custom intervals)
- **Features**: Timezone support, failure notifications, error logs
- **Use Cases**: Recurring tasks, periodic monitoring, scheduled reports

### 7. REST API and Webhooks

**REST API Endpoints**:
```
POST /v1/tasks
  - input_text: string
  - task_mode: "agent"
  - agent_profile: string

GET /v1/tasks/{id}

POST /v1/webhooks
  - url: string
  - events: array
```

**Webhook Events**:
- `task_created`
- `task_progress`
- `task_stopped` (stop_reason: "finish" or "ask")

**Authentication**: `API_KEY` header

**Files API**:
- Upload files by ID, URL, or base64
- Retrieve file metadata and content

### 8. Web App Builder

- **Full-stack Generation**: Frontend + backend + database
- **Hosting**: Managed hosting included
- **Features**: Analytics, Stripe integration, custom domains
- **Code Export**: No vendor lock-in - export to GitHub
- **Deployment**: GitHub Actions integration

### 9. Agent Skills

- **Workflow Packaging**: Bundle multi-step workflows into reusable skills
- **Auto-generation**: Creates `SKILL.md` and bundle scripts automatically
- **Team Libraries**: Share skills across organization
- **Use Cases**: Standardize common workflows, reduce duplication

### 10. Session Replay

- **Visualization**: Side panel ("Manus computer") shows each step
- **Replayability**: Sessions can be replayed for debugging and auditing
- **Event Stream**: Logs actions and observations
- **Use Cases**: Debugging failed tasks, compliance auditing, training

### 11. Memory

- **Persistent Artifacts**: `todo.md` and other planning documents
- **Event Stream**: Full history of actions and observations
- **Context Management**: Older events summarized to fit context window
- **Use Cases**: Long-running tasks, multi-session workflows

### 12. My Computer Desktop Agent

- **Local Control**: Control user's local machine
- **Permission Model**: Explicit user approval required for terminal commands
- **Use Cases**: Local file operations, desktop app automation, system administration

---

## Chimera-Manus Capability Mapping

| Manus Capability | Chimera Equivalent | Status | Notes |
|------------------|-------------------|--------|-------|
| Browser automation | AgentCore Browser (Playwright CDP) | ✅ In architecture | Already designed |
| Code execution | AgentCore Code Interpreter | ✅ Built | Already has this |
| Multi-agent | Swarm modules + Step Functions | ✅ Built Phase 5 | More sophisticated orchestration |
| OAuth connectors | None | ❌ **GAP** | **Chimera lacks connector framework** |
| Gmail/email | None | ❌ **GAP** | **No email capability** |
| Scheduled tasks | EventBridge in OrchestrationStack | ⚠️ Built not wired | Infrastructure exists, needs wiring to agents |
| REST API | API Gateway HTTP+WebSocket | ✅ Built | Already designed |
| Webhooks | EventBridge event bus | ⚠️ Built Phase 5 | Internal only - needs external delivery mechanism |
| Web app builder | Agent CDK+CodePipeline | ✅ Built Phase 6 | Different value prop (infra not frontend) |
| Agent skills | 7-module skill ecosystem + auto-skill-gen | ✅ Built Phase 3+6 | More advanced than Manus |
| Session replay | OTEL tracing | ⚠️ Built | No visual replay UI |
| File management | S3+EFS hybrid | ✅ Built | More capable |
| Memory | AgentCore Memory STM+LTM | ✅ Built | More sophisticated |
| Desktop agent | N/A by design | N/A | Different paradigm (AWS accounts not desktops) |

### Competitive Position

**Chimera Advantages**:
- Infrastructure tooling and automation
- Multi-tenancy with tenant isolation
- Advanced skill security and validation
- Self-evolution capabilities
- AWS account access (unique capability)

**Manus Advantages**:
- Browser UX and visual automation
- Third-party connector ecosystem
- Email integration and mail-triggered tasks
- Scheduling user experience

---

## SES Email Integration Analysis

### Use Cases

#### 1. Task Completion Notifications

**Flow**:
```
Agent completes task
  → EventBridge (chimera.task.completed)
  → SNS topic
  → SES email to stakeholders
```

**Value**: Critical for non-blocking agent execution. Users don't need to poll for results.

#### 2. Agent Report Delivery

**Flow**:
```
Agent generates report
  → Store in S3
  → Generate presigned URL
  → SES email with link to stakeholders
```

**Value**: Automated delivery of analysis, logs, and artifacts.

#### 3. UTO Communication (Mail-Triggered Tasks)

**Flow**:
```
User forwards AWS alert to Chimera agent
  → SES Receiving Rule
  → SNS
  → Lambda (parse email, extract tenantId from verified domain)
  → Agent invocation
```

**Value**: Email as agent interface. Users can forward monitoring alerts, support tickets, or requests directly to Chimera agents.

#### 4. Scheduled Digest Emails

**Flow**:
```
EventBridge Schedule (daily)
  → Lambda
  → Agent health check
  → SES digest to tenant admin
```

**Value**: Proactive communication. Daily/weekly summaries of agent activity, cost, and health.

#### 5. Tenant Onboarding Welcome Email

**Flow**:
```
Tenant provisioning complete
  → Lambda in TenantOnboardingStack
  → SES template
  → Welcome email to tenant admin
```

**Value**: Already specified in VISION.md. Professional onboarding experience.

### Architecture

#### Outbound Email

```
Agent/Lambda
  → SES SendEmail API
  → Recipient inbox
```

**Components**:
- SES service in SecurityStack or new CommunicationStack
- Email templates stored in DynamoDB or S3
- Verified sender domains per tenant
- Bounce/complaint handling via SNS

#### Inbound Email

```
External email
  → SES Receiving Rule
  → S3 (raw email)
  → SNS
  → Lambda (parser)
  → Agent invocation
```

**Components**:
- SES Receiving Rule Sets
- S3 bucket for raw email storage
- Lambda parser: extract sender, subject, body, attachments
- Tenant identification via verified domain
- Authorization: map sender email to tenant + permissions

### Key Considerations

1. **Per-Tenant Verified Domains**: Each tenant must verify their sending domain with SES
2. **SES Limits**: Throttling (14 emails/sec default), sandbox mode (verify all recipients), production mode (application required)
3. **Email Templates**: Store templates in DynamoDB or S3, render with tenant-specific variables
4. **Bounce/Complaint Handling**: SNS topics for feedback, DLQ for failed deliveries
5. **Per-Tenant KMS Encryption**: Encrypt email content at rest using tenant-specific KMS keys

---

## Viable Integration Opportunities

### Priority 1: SES Email Notification Service ⭐ **HIGH**

**Scope**: Add AWS SES to Chimera infrastructure for outbound email notifications

**Implementation**:
- Add SES resources to existing stacks (likely SecurityStack or new CommunicationStack)
- Create new Strands tool: `ses_send_email`
- Email template management (DynamoDB or S3)
- Bounce/complaint handling via SNS

**Use Cases**:
- Task completion notifications
- Agent report delivery
- Scheduled digest emails
- Tenant onboarding welcome emails

**Complexity**: Medium
**Value**: High - fills critical gap for asynchronous agent communication

---

### Priority 2: SES Inbound Email Agent Trigger ⭐ **HIGH**

**Scope**: Accept inbound emails at tenant-specific addresses to trigger agent tasks

**Implementation**:
- SES Receiving Rule Sets
- S3 bucket for raw email storage
- Lambda email parser
- Tenant identification via verified domain
- Agent invocation API integration

**Use Cases**:
- Forward AWS alerts to Chimera agent
- Email-triggered incident response
- Support ticket automation
- User-initiated agent tasks via email

**Complexity**: Medium-High (authorization and multi-tenancy challenges)
**Value**: High - mirrors Manus "Mail Manus" feature with AWS-native implementation

---

### Priority 3: OAuth Connector Framework ⭐ **HIGH**

**Scope**: Universal connector system for third-party services

**Implementation**:
- OAuth 2.0 flow handler (authorization code grant)
- Secrets Manager integration for token storage
- Per-tenant connector configuration
- Connector plugins for high-value services:
  - GitHub (code, issues, PRs)
  - Slack (notifications, slash commands)
  - Jira (issue tracking)
  - PagerDuty (incident management)
  - Datadog (monitoring)

**Use Cases**:
- GitHub issue creation from agent findings
- Slack notifications for critical events
- Jira ticket updates from agent actions
- PagerDuty incident routing

**Complexity**: High (requires OAuth flow, per-service SDK wrappers, token refresh logic)
**Value**: High - extends agent capabilities beyond AWS ecosystem
**Type**: **Epic** (multi-phase implementation)

---

### Priority 4: EventBridge Scheduled Agent Tasks ⚙️ **MEDIUM**

**Scope**: Wire EventBridge Scheduler to agent invocation API

**Implementation**:
- Schedule management API (CRUD operations)
- EventBridge Scheduler rules per tenant
- Lambda target for agent invocation
- Schedule configuration UI (admin dashboard)

**Use Cases**:
- Daily health checks
- Weekly cost reports
- Hourly resource compliance scans
- Scheduled cleanup tasks

**Complexity**: Medium (infrastructure exists, needs API wrapper)
**Value**: Medium - table stakes feature, improves agent autonomy

---

### Priority 5: Webhook Lifecycle Event Delivery ⚙️ **MEDIUM**

**Scope**: Formalize webhook system for external event delivery

**Implementation**:
- Webhook registration API
- EventBridge → Lambda → external HTTP POST
- HMAC signature for authentication
- Retry logic with exponential backoff
- Webhook management UI

**Events**:
- `chimera.task.created`
- `chimera.task.progress`
- `chimera.task.completed`
- `chimera.task.failed`
- `chimera.cost.threshold_exceeded`

**Use Cases**:
- Integration with external workflow tools
- Real-time notifications to customer systems
- Third-party analytics and monitoring

**Complexity**: Medium
**Value**: Medium - enables ecosystem integrations

---

### Priority 6: Visual Session Replay 🔬 **LOW**

**Scope**: Visual UI for replaying agent sessions

**Implementation**:
- Event stream recording (already exists via OTEL)
- Replay API (fetch events by session ID)
- Frontend visualization component
- Step-by-step timeline UI

**Use Cases**:
- Debugging failed agent tasks
- Compliance auditing (visual proof of actions)
- Stakeholder-friendly reporting (vs raw OTEL traces)
- Training and documentation

**Complexity**: High (requires significant frontend development)
**Value**: Medium - improves observability and trust
**Note**: Research phase recommended before full implementation

---

## Non-Viable Integrations

| Manus Capability | Why Not Viable for Chimera |
|------------------|----------------------------|
| Desktop agent | Chimera operates on AWS accounts, not user desktops. Different paradigm. |
| Cloud browser VM | AgentCore Browser (Playwright CDP) already covers this use case. |
| CodeAct execution | Strands ReAct model is more structured and auditable. CodeAct less transparent. |
| Web app builder | Chimera's value prop is infrastructure automation, not frontend generation. |
| OpenAI compatibility | Chimera uses Bedrock API surface, not OpenAI-compatible endpoint. Different integration point. |
| Credit billing | Chimera already has token-based cost tracking and quota enforcement. |
| Memory (todo.md) | AgentCore Memory (STM + LTM) is more sophisticated. |
| Multi-agent orchestration | Chimera's swarm + Step Functions is more advanced than Manus task chaining. |

---

## Follow-Up Issues

The following Seeds issues should be created on the main branch for implementation planning:

### 1. SES Email Notification Service
- **Title**: Add SES email notification service for agent task completion and reports
- **Type**: task
- **Priority**: 2 (High)

### 2. SES Inbound Email Processing
- **Title**: Add SES inbound email processing for mail-triggered agent tasks
- **Type**: task
- **Priority**: 3 (Medium)

### 3. OAuth Connector Framework
- **Title**: Design and implement OAuth connector framework for third-party services
- **Type**: epic
- **Priority**: 2 (High)

### 4. EventBridge Scheduled Tasks
- **Title**: Wire EventBridge Scheduler to agent invocation for recurring tasks
- **Type**: task
- **Priority**: 3 (Medium)

### 5. Webhook Lifecycle Events
- **Title**: Add webhook delivery for agent task lifecycle events
- **Type**: task
- **Priority**: 3 (Medium)

### 6. Visual Session Replay Research
- **Title**: Research visual session replay for agent task auditing
- **Type**: research
- **Priority**: 4 (Low)

---

## Conclusion

### Key Takeaways

1. **Email is an underrated agent interface**
   SES fills a critical gap for long-running tasks where polling is impractical. Mail-triggered tasks (like Manus "Mail Manus") enable users to forward alerts, tickets, and requests directly to agents.

2. **Third-party connectors unlock significant value**
   OAuth framework extends Chimera agents beyond AWS ecosystem. GitHub, Slack, Jira, and PagerDuty integrations are high-value, high-demand features.

3. **Scheduled tasks are table stakes**
   Infrastructure (EventBridge Scheduler) already exists in OrchestrationStack. Needs minimal wiring to agent invocation API. Quick win for recurring workflows.

4. **Visual replay builds stakeholder trust**
   OTEL traces are powerful but developer-centric. A visual replay UI (step-by-step timeline) is more stakeholder-friendly and improves compliance auditing.

### Chimera's Competitive Advantage

Chimera's **unique strength** remains **AWS account access with multi-tenant isolation**. Manus operates in isolated VMs with API-based connectors. Chimera agents operate **inside** customer AWS accounts with full IAM permissions, enabling infrastructure automation that Manus cannot replicate.

The integrations identified above (SES email, OAuth connectors, scheduled tasks, webhooks) are **complementary** to Chimera's core value proposition, not replacements. They extend Chimera's reach into external systems while maintaining its AWS-native architecture advantage.

---

**Research completed by**: lead-research-manus
**Documented by**: builder-manus-doc
**Date**: 2026-03-24
