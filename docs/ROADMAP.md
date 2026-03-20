# AWS Chimera - Implementation Roadmap

> **Status:** Phase 0 planning complete. Monorepo setup in progress.
>
> **Last Updated:** 2026-03-19

---

## Overview

AWS Chimera is an **Agent-as-a-Service platform** built on AWS Bedrock AgentCore, Strands Agents, and Vercel Chat SDK. This roadmap tracks progress through 8 implementation phases, from foundation to production deployment.

**Total Timeline:** 16-18 weeks (4 months)

---

## Roadmap Phases

### ✅ Research & Architecture (Completed)

**Deliverables:**
- [x] OpenClaw/NemoClaw/OpenFang competitive analysis (8 docs, 6,991 lines)
- [x] AgentCore & Strands research (9 docs, 10,848 lines)
- [x] Architecture reviews (6 specialist reviews)
- [x] Enhancement documents (9 docs, ~10,000+ lines)
- [x] Canonical DynamoDB schema (6-table design)
- [x] SSE bridge package implementation
- [x] Skill format compatibility research

**Research Corpus:** 40,000+ lines of documentation

**Key Decisions:**
- 6-table DynamoDB design (multi-tenant isolation)
- 8-stack CDK architecture (separation of concerns)
- MCP protocol for tool marketplace
- Bedrock AgentCore Runtime (MicroVM isolation)
- Vercel Chat SDK (10+ chat platforms)

**Seeds Issues:** `chimera-bbb5`, `chimera-0070`, `chimera-2e8e`, `chimera-ec1a`, `chimera-efac`, `chimera-0382`, `chimera-efa3`, `chimera-4646`, `chimera-e55a`, `chimera-0079`

---

### 🚧 Phase 0: Foundation (Weeks 1-2)

**Status:** In Progress

**Goal:** Infrastructure scaffold with core AWS services

**Deliverables:**
- [ ] Monorepo setup (Bun workspaces + Turborepo)
- [ ] CDK infrastructure scaffold
  - [ ] NetworkStack (VPC, subnets, NAT gateway, security groups)
  - [ ] DataStack (DynamoDB 6 tables, S3, EFS)
  - [ ] SecurityStack (Cognito, IAM roles, Cedar policies, KMS)
  - [ ] ObservabilityStack (CloudWatch, X-Ray, alarms)
- [ ] CI/CD pipeline (CodePipeline + CodeBuild)
- [ ] Local dev environment setup

**Dependencies:** None

**Seeds Issue:** [`chimera-5a87`](../.seeds/issues.jsonl)

**Infrastructure Files:**
```
infra/
├── lib/
│   ├── network-stack.ts       # ✅ Exists
│   ├── data-stack.ts          # ✅ Exists (6 DDB tables defined)
│   ├── security-stack.ts      # ✅ Exists
│   └── observability-stack.ts # ❌ TODO
├── constructs/
│   └── tenant-agent.ts        # ❌ TODO (L3 construct)
└── bin/
    └── chimera.ts             # ❌ TODO
```

**Acceptance Criteria:**
- [ ] `cdk synth` generates valid CloudFormation
- [ ] `cdk deploy NetworkStack` provisions VPC
- [ ] `cdk deploy DataStack` creates 6 DynamoDB tables
- [ ] Local dev environment documented in README

---

### 📦 Phase 1: Single Agent (Weeks 3-6)

**Status:** Ready to start after Phase 0

**Goal:** End-to-end single-tenant agent execution

**Deliverables:**
- [ ] AgentCore Runtime integration
  - [ ] MicroVM session provisioning
  - [ ] Strands agent runtime configuration
  - [ ] AgentCore Memory (STM + LTM)
- [ ] Skill management system
  - [ ] Skill registry (DynamoDB `chimera-skills` table)
  - [ ] SKILL.md parser
  - [ ] Skill execution via AgentCore Gateway
- [ ] Basic chat interface (terminal-only MVP)
- [ ] Session lifecycle management

**Dependencies:** Phase 0

**Seeds Issue:** [`chimera-fb27`](../.seeds/issues.jsonl)

**Package Structure:**
```
packages/
├── core/
│   ├── agent-runtime/         # Strands agent config
│   ├── skill-registry/        # Skill CRUD + parser
│   └── session-manager/       # Session lifecycle
└── shared/
    ├── types/                 # TypeScript types
    └── schemas/               # Zod schemas
```

**Acceptance Criteria:**
- [ ] Agent can execute a hardcoded skill
- [ ] AgentCore Memory persists across turns
- [ ] Terminal chat interface works end-to-end
- [ ] Unit tests pass for core modules

---

### 💬 Phase 2: Chat Gateway (Weeks 7-8)

**Status:** Blocked by Phase 1

**Goal:** Multi-platform chat support with streaming

**Deliverables:**
- [ ] ECS Fargate deployment
  - [ ] Chat Gateway service
  - [ ] SSE Bridge service (Strands → Vercel DSP)
- [ ] API Gateway (HTTP API + WebSocket)
- [ ] Vercel Chat SDK integration
  - [ ] Slack channel adapter
  - [ ] Web chat UI
  - [ ] Discord channel adapter (stretch)
- [ ] Streaming response handling

**Dependencies:** Phase 1

**Seeds Issue:** [`chimera-6f0e`](../.seeds/issues.jsonl)

**Package Structure:**
```
packages/
├── chat-gateway/
│   ├── routes/                # Express.js routes
│   ├── adapters/              # Slack, Discord, Teams
│   └── websocket/             # WebSocket handler
└── sse-bridge/                # ✅ Exists (Strands → Vercel DSP)
    ├── src/
    │   ├── bridge.ts          # Core translation logic
    │   ├── stream.ts          # StreamEvent handlers
    │   └── protocol.ts        # Vercel Data Stream Protocol
    └── examples/
        └── express-server.ts
```

**Acceptance Criteria:**
- [ ] Slack bot responds to messages
- [ ] Web UI shows streaming responses
- [ ] WebSocket connection handles reconnects
- [ ] 99th percentile latency < 500ms

---

### 🧩 Phase 3: Skill Ecosystem (Weeks 9-10)

**Status:** Blocked by Phase 2

**Goal:** Public skill marketplace with security pipeline

**Deliverables:**
- [ ] Skill authoring SDKs
  - [ ] `@chimera/sdk-typescript`
  - [ ] `@chimera/sdk-python`
- [ ] MCP integration (AgentCore Gateway)
  - [ ] MCP server discovery
  - [ ] Tool routing via Gateway
- [ ] Security pipeline (learned from ClawHavoc attack)
  - [ ] Static analysis (AST scanning)
  - [ ] Dependency audit (OSV database)
  - [ ] Sandbox testing
  - [ ] Cryptographic signing
- [ ] Skill registry UI

**Dependencies:** Phase 2

**Seeds Issue:** TBD

**5-Tier Trust Model:**
```
Platform (built-in)
  ↓
Verified (Cedar policies)
  ↓
Community (sandbox)
  ↓
Private (tenant policies)
  ↓
Experimental (dev-only)
```

**Acceptance Criteria:**
- [ ] Developer can publish a skill
- [ ] Security pipeline blocks malicious skills
- [ ] MCP server tools accessible via AgentCore Gateway
- [ ] 100+ MCP servers tested

---

### 🏢 Phase 4: Multi-Tenant (Weeks 11-12)

**Status:** Blocked by Phase 3

**Goal:** Production-ready multi-tenant isolation

**Deliverables:**
- [ ] Tenant router (Cognito JWT → DynamoDB)
- [ ] Per-tenant IAM isolation
  - [ ] DynamoDB LeadingKeys policies
  - [ ] Cedar policy engine integration
  - [ ] S3 bucket-per-tenant
  - [ ] KMS CMK-per-tenant
- [ ] Rate limiting (token bucket in `chimera-rate-limits`)
- [ ] Cost tracking (per-tenant billing in `chimera-cost-tracking`)
- [ ] Tenant provisioning API

**Dependencies:** Phase 3

**Seeds Issue:** TBD

**Multi-Tenant Tiers:**
| Tier | AgentCore Runtime | Memory Strategy | Cost |
|------|-------------------|-----------------|------|
| Basic | Shared endpoint | SUMMARY only | ~$10/tenant/mo |
| Advanced | Shared endpoint | SUMMARY + USER_PREFERENCE | ~$50/tenant/mo |
| Premium | Shared endpoint | All strategies | ~$150/tenant/mo |
| Enterprise | Dedicated endpoint | Custom | Custom pricing |

**Acceptance Criteria:**
- [ ] GSI queries enforce `tenantId` FilterExpression
- [ ] Cross-tenant data leakage tests pass
- [ ] Rate limits prevent abuse
- [ ] Cost attribution per tenant accurate

---

### ⏰ Phase 5: Cron & Orchestration (Weeks 13-14)

**Status:** Blocked by Phase 4

**Goal:** Scheduled tasks and multi-agent patterns

**Deliverables:**
- [ ] EventBridge scheduler integration
- [ ] Cron session type (MicroVM for scheduled tasks)
- [ ] Multi-agent orchestration patterns
  - [ ] A2A protocol (agent-to-agent)
  - [ ] Shared memory (ElastiCache/Redis)
  - [ ] Task queuing (SQS)
- [ ] Step Functions workflow orchestration

**Dependencies:** Phase 4

**Seeds Issue:** TBD

**Orchestration Patterns:**
- User → Agent → Agent (mediation)
- User + Agent → Shared Memory ← Agent + User (collaboration)
- User → Agent A → SQS → Agent B (task delegation)

**Acceptance Criteria:**
- [ ] Cron job executes on schedule
- [ ] Multi-agent workflow completes end-to-end
- [ ] Shared memory prevents race conditions
- [ ] SQS retries failed tasks

---

### 🧬 Phase 6: Self-Evolution (Weeks 15-16)

**Status:** Blocked by Phase 5

**Goal:** Platform autonomously improves itself

**Deliverables:**
- [ ] Prompt A/B testing framework
  - [ ] Variant management (Canopy)
  - [ ] Metric collection (CloudWatch)
  - [ ] Winner detection (statistical significance)
- [ ] Auto-skill generation
  - [ ] Pattern detection from usage logs
  - [ ] SKILL.md synthesis
  - [ ] Security validation
- [ ] Model routing optimization
  - [ ] Latency/cost/quality tradeoffs
  - [ ] Dynamic model selection
- [ ] Self-modifying IaC
  - [ ] DynamoDB-driven CDK synthesis
  - [ ] Cedar policy constraints

**Dependencies:** Phase 5

**Seeds Issue:** TBD

**Evolution Guardrails:**
- Cedar policies limit infrastructure changes
- Human-in-the-loop approval for risky changes
- Rollback mechanism for failed experiments

**Acceptance Criteria:**
- [ ] Prompt A/B test declares winner
- [ ] Auto-generated skill passes security pipeline
- [ ] Model router selects optimal model per request
- [ ] Self-modified infrastructure deploys successfully

---

### 🚀 Phase 7: Production (Weeks 17-18)

**Status:** Blocked by Phase 6

**Goal:** Production-ready deployment with observability

**Deliverables:**
- [ ] CI/CD pipeline (CodePipeline)
  - [ ] Automated testing
  - [ ] CDK deployment
  - [ ] Blue/green deployments
- [ ] Monitoring dashboards
  - [ ] CloudWatch alarms
  - [ ] X-Ray tracing
  - [ ] Custom metrics
- [ ] Disaster recovery
  - [ ] PITR backups (DynamoDB)
  - [ ] Cross-region replication
- [ ] Load testing
  - [ ] 1000 concurrent sessions
  - [ ] Skill execution latency

**Dependencies:** Phase 6

**Seeds Issue:** TBD

**Observability Stack:**
```
CloudWatch
  ├── Metrics (latency, error rate, cost)
  ├── Logs (structured JSON)
  └── Alarms (PagerDuty integration)
X-Ray
  ├── Distributed tracing
  └── Service map
Custom Dashboards
  ├── Tenant health
  ├── Skill usage
  └── Cost attribution
```

**Acceptance Criteria:**
- [ ] Load test handles 1000 concurrent sessions
- [ ] 99.9% uptime over 30 days
- [ ] Mean time to recovery (MTTR) < 5 minutes
- [ ] All alarms documented in runbooks

---

## Dependency Graph

```
Phase 0 (Foundation)
  ↓
Phase 1 (Single Agent)
  ↓
Phase 2 (Chat Gateway)
  ↓
Phase 3 (Skill Ecosystem)
  ↓
Phase 4 (Multi-Tenant)
  ↓
Phase 5 (Cron & Orchestration)
  ↓
Phase 6 (Self-Evolution)
  ↓
Phase 7 (Production)
```

**Critical Path:** All phases are sequential. No parallel work until Phase 1 completes.

---

## What's Next?

### Immediate (This Week)
1. ✅ Create CLAUDE.md development workflow guide
2. ✅ Create docs/ROADMAP.md (this file)
3. ⏳ Complete monorepo setup (Bun workspaces + Turborepo)
4. ⏳ Finalize NetworkStack, DataStack, SecurityStack in CDK

### Next Sprint (Phase 0 Completion)
1. Implement ObservabilityStack (CloudWatch, X-Ray)
2. Create L3 construct: `TenantAgent`
3. Set up CI/CD pipeline (CodePipeline)
4. Deploy Phase 0 infrastructure to staging account

### Phase 1 Kickoff (Week 3)
1. Integrate AgentCore Runtime SDK
2. Build Strands agent configuration
3. Implement skill registry (DynamoDB CRUD)
4. Create terminal-based chat MVP

---

## Progress Tracking

### Completed Work

| ID | Title | Type | Completed |
|----|-------|------|-----------|
| `chimera-bbb5` | Resolve DynamoDB schema contradictions | research | 2026-03-18 |
| `chimera-0070` | Rename Chimera → Chimera throughout docs | task | 2026-03-18 |
| `chimera-2e8e` | Implement SSE bridge | task | 2026-03-19 |
| `chimera-ec1a` | Research: Platform Architecture & Multi-Tenancy Validation | research | 2026-03-19 |
| `chimera-efac` | Research: Agent Collaboration & Communication Layer | research | 2026-03-19 |
| `chimera-0382` | Research: Self-Evolution, ML Experiments & Advanced Capabilities | research | 2026-03-19 |
| `chimera-efa3` | Research: AWS Native & OSS Integration Enhancement | research | 2026-03-19 |
| `chimera-4646` | Improve lead agent workflow | task | 2026-03-19 |
| `chimera-e55a` | Research: Skill format compatibility | research | 2026-03-19 |
| `chimera-0079` | Apply DDB GSI2 updates to renamed Chimera docs | task | 2026-03-19 |

### Open Issues

| ID | Title | Status | Phase |
|----|-------|--------|-------|
| `chimera-5a87` | Phase 0: Foundation | open | 0 |
| `chimera-fb27` | Phase 1: Single Agent | open | 1 |
| `chimera-6f0e` | Phase 2: Chat Gateway | open | 2 |
| `chimera-9580` | Update lead agent hooks | open | infrastructure |

---

## Research Documents

### Competitive Analysis
- `docs/research/openclaw-nemoclaw-openfang/` (8 docs, 6,991 lines)
  - OpenClaw Framework Research
  - NemoClaw Enterprise Security
  - OpenFang Agent OS Research
  - Competitive Analysis (12 dimensions)
  - ClawHavoc Supply Chain Attack Analysis

### AgentCore & Strands
- `docs/research/agentcore-strands/` (9 docs, 10,848 lines)
  - AgentCore Runtime Architecture
  - Strands Agent Framework
  - AgentCore Memory (STM + LTM)
  - AgentCore Gateway (MCP)
  - AgentCore Code Interpreter
  - AgentCore Browser (CDP)

### Architecture Reviews
- `docs/research/architecture-reviews/` (6 docs)
  - Chimera-Final-Architecture-Plan.md
  - Chimera-AWS-Component-Blueprint.md
  - Chimera-Architecture-Review-Multi-Tenant.md
  - Chimera-Architecture-Review-Security.md
  - Chimera-Self-Evolution-Engine.md
  - Chimera-Skill-Ecosystem-Design.md

### Canonical Schema
- `docs/architecture/canonical-data-model.md` (29,784 bytes)
  - **Authority:** Single source of truth for DynamoDB schema
  - 6-table design with GSI patterns
  - Enhanced multi-item tenant configuration
  - Cross-tenant isolation patterns

### Collaboration
- `docs/research/collaboration/` (6 docs)
  - Agent Collaboration Research Index
  - Communication Pattern Analysis
  - Real-Time/Async and Shared Memory
  - User-Through-Agent Collaboration

### Enhancement Documents
- `docs/research/enhancement/` (9 docs, ~10,000 lines)
- `docs/research/integration-enhancement/` (7 docs)
- `docs/research/skills/` (9 docs)

---

## Key Metrics

### Research Phase (Completed)
- **Documents:** 60+ research documents
- **Lines:** 40,000+ lines of documentation
- **Issues Closed:** 10 major research/architecture tasks
- **Duration:** ~4 weeks

### Implementation Phase (Weeks 1-18)
- **Phases:** 8 sequential phases
- **Duration:** 16-18 weeks (4 months)
- **Team Size:** TBD (Overstory agent swarm)
- **Deployment Target:** AWS multi-account setup

---

## Resources

- [CLAUDE.md](../CLAUDE.md) — Development workflow guide
- [README.md](../README.md) — Project overview
- [AGENTS.md](../AGENTS.md) — Mulch, Seeds, Canopy quick reference
- [docs/architecture/canonical-data-model.md](architecture/canonical-data-model.md) — DynamoDB schema
- [packages/sse-bridge/README.md](../packages/sse-bridge/README.md) — SSE bridge documentation

---

**AWS Chimera** — where agents are forged.
