# AWS Chimera - Implementation Roadmap

> **Status:** Research complete. Phase 0 nearing completion. Agent runtime is the critical path.
>
> **Last Updated:** 2026-03-21

---

## Overview

AWS Chimera is an **Agent-as-a-Service platform** built on AWS Bedrock AgentCore, Strands Agents, and Vercel Chat SDK. Unlike traditional AI assistants, Chimera agents are **operators** with first-class access to AWS accounts — they inspect, build, deploy, and monitor infrastructure autonomously.

**Core Differentiator:** The agent has AWS account access, not computer access. This is an AWS-native rebuild of OpenClaw/NemoClaw patterns, purpose-built for cloud infrastructure operations.

**Architecture:** Bun monorepo, 11 CDK stacks, 5 packages, 18 ADRs, AgentCore Runtime (MicroVM isolation).

---

## Current State (2026-03-21)

### What's Done

| Area | Status | Details |
|------|--------|---------|
| Research | **100% Complete** | 118 docs, 112K+ lines, 18 ADRs |
| CDK Infrastructure | **11 stacks, production-quality** | 4,400+ LOC across Network, Data, Security, Observability, API, Chat, Tenant, Pipeline, Skill Pipeline, Evolution, Orchestration |
| @chimera/shared | **Types complete** | Canonical type definitions |
| @chimera/sse-bridge | **Ship-ready** | ~700 LOC, 26 tests, Strands-to-Vercel DSP bridge |
| @chimera/chat-gateway | **Framework done** | Express server, middleware, routes, adapter stubs |
| @chimera/core | **60% real, 40% scaffolded** | 42K LOC — AWS tools, discovery, skills, tenant, billing are real; agent runtime is placeholder |
| @chimera/cli | **Local-only** | init, deploy, skill, channel commands |
| Quality Gates | **All green** | typecheck: 0 errors, lint: 0 errors, tests: 132 pass / 4 skip / 0 fail |

### What's Not Done (Critical Gap)

**The agent runtime is entirely placeholder.** `ChimeraAgent.invoke()` returns hardcoded text. There is no Strands SDK integration, no AgentCore Runtime wiring, no working agent loop. Everything else — tools, infrastructure, types, tests — orbits an agent that doesn't exist yet.

---

## Roadmap Phases

### Phase 0: Foundation (NEARLY COMPLETE)

**Status:** ~85% complete

**What's Done:**
- [x] Monorepo setup (Bun workspaces, TypeScript project references)
- [x] CDK infrastructure scaffold — all 11 stacks implemented:
  - [x] NetworkStack (VPC, subnets, NAT gateway, security groups) — 167 LOC
  - [x] DataStack (DynamoDB 6 tables, S3, EFS) — 320 LOC
  - [x] SecurityStack (Cognito, IAM roles, Cedar policies, KMS) — 210 LOC
  - [x] ObservabilityStack (CloudWatch, X-Ray, alarms) — 406 LOC
  - [x] APIStack (HTTP API + WebSocket + authorizer) — 441 LOC
  - [x] ChatStack (ECS Fargate, SSE bridge) — 345 LOC
  - [x] TenantOnboardingStack (per-tenant isolation) — 694 LOC
  - [x] PipelineStack (CI/CD, CodePipeline, CodeBuild) — 639 LOC
  - [x] SkillPipelineStack (skill security pipeline) — 352 LOC
  - [x] EvolutionStack (self-modification infrastructure) — 577 LOC
  - [x] OrchestrationStack (Step Functions, multi-agent) — 280 LOC
- [x] Quality gates passing (typecheck, lint, tests)
- [x] Canonical DynamoDB schema (6-table design with GSI patterns)
- [x] 18 Architecture Decision Records
- [x] Shared types package (@chimera/shared)

**What Remains:**
- [ ] `cdk synth` verification — confirm all 11 stacks produce valid CloudFormation
- [ ] `cdk deploy` to staging — at least NetworkStack + DataStack
- [ ] L3 construct: `TenantAgent` (encapsulates 15+ resources per tenant)
- [ ] Local dev environment documentation

**Acceptance Criteria:**
- [ ] `cdk synth` generates valid CloudFormation for all stacks
- [ ] `cdk deploy NetworkStack` provisions VPC in staging
- [ ] Local dev environment documented in README

---

### Phase 1: Working Agent (CRITICAL PATH)

**Status:** Not started — this is the #1 priority

**Goal:** A real agent that can receive a message, reason with an LLM, use AWS tools, and return a useful response. Everything else is secondary.

**Why This Is Critical:** The entire platform exists to serve an agent. 42K lines of code (tools, discovery, billing, skills) are built around an agent that currently returns `[Placeholder]`. Phase 1 replaces the placeholder with a working Strands agent on AgentCore Runtime.

**Deliverables:**

1. **Strands Agent Integration**
   - [ ] Add `@anthropic-ai/strands` SDK dependency
   - [ ] Replace `ChimeraAgent` placeholder with real Strands agent loop
   - [ ] Wire system prompt template to Strands agent config
   - [ ] Implement streaming via Strands native streaming
   - [ ] Reference: [Integration Guide](research/agentcore-strands/10-Chimera-Integration-Guide.md)

2. **AgentCore Runtime Wiring**
   - [ ] Configure `BedrockAgentCoreApp` entry point
   - [ ] Session lifecycle: create, invoke, terminate
   - [ ] AgentCore Memory integration (STM + LTM with tenant-scoped namespaces)
   - [ ] MicroVM session provisioning
   - [ ] Reference: [AgentCore Runtime Architecture](research/agentcore-strands/)

3. **AWS Account Tools (Core Differentiator)**
   - [ ] Wire existing tools (EC2, S3, Lambda, CloudWatch — 2,400+ LOC) into Strands agent
   - [ ] Wire existing discovery modules (Config scanner, Resource Explorer, Cost analyzer, Stack inventory, Tag organizer) into agent
   - [ ] Add IAM scoping for tool execution (least-privilege per tenant)
   - [ ] Test real AWS API calls through agent
   - [ ] Reference: [AWS API Tools Research](research/aws-account-agent/01-AWS-API-First-Class-Tools.md)

4. **End-to-End Validation**
   - [ ] Agent receives message, invokes Strands, calls AWS tools, returns real response
   - [ ] Terminal chat MVP works end-to-end
   - [ ] Unit tests for agent invocation
   - [ ] Integration test: agent + real AWS SDK mock

**Dependencies:** Phase 0 (cdk synth verification)

**Key Research References:**
- [OpenClaw + NemoClaw Deep Dive](research/openclaw-nemoclaw-openfang/00-Deep-Dive-Summary.md) — patterns to replicate/surpass
- [AgentCore + Strands Integration Guide](research/agentcore-strands/10-Chimera-Integration-Guide.md) — wiring sequence
- [ADR-003: Strands Agent Framework](architecture/decisions/ADR-003-strands-agent-framework.md)
- [ADR-007: AgentCore MicroVM](architecture/decisions/ADR-007-agentcore-microvm.md)

**Acceptance Criteria:**
- [ ] `ChimeraAgent.invoke("list my S3 buckets")` returns real S3 bucket data
- [ ] Agent uses Strands agent loop (not hardcoded responses)
- [ ] AgentCore Memory persists context across turns
- [ ] Terminal chat works end-to-end with real LLM responses

---

### Phase 2: Chat Gateway and Multi-Platform

**Status:** Framework exists, needs agent integration

**Goal:** Connect the working agent to multiple chat platforms via the SSE bridge and chat gateway.

**What Already Exists:**
- @chimera/sse-bridge — ship-ready (Strands to Vercel Data Stream Protocol)
- @chimera/chat-gateway — Express server, middleware, routes
- Adapter stubs for Slack, Discord
- ChatStack CDK (ECS Fargate deployment)
- APIStack CDK (HTTP API + WebSocket)

**What Remains:**
- [ ] Wire chat gateway to working agent (from Phase 1)
- [ ] Complete Slack adapter (OAuth + Events API)
- [ ] Complete web chat UI
- [ ] WebSocket reconnection handling
- [ ] ECS Fargate deployment config
- [ ] Streaming response end-to-end (agent to SSE bridge to client)

**Dependencies:** Phase 1 (working agent)

**Acceptance Criteria:**
- [ ] Slack bot responds with real agent output
- [ ] Web UI shows streaming responses
- [ ] WebSocket handles reconnects gracefully

---

### Phase 3: Skill Ecosystem

**Status:** Scaffolded — registry, discovery, installer, trust engine exist in packages/core/src/skills/

**Goal:** Public skill marketplace with security pipeline

**What Already Exists:**
- Skill registry, discovery, installer, MCP gateway client, trust engine, validator (7 modules in packages/core/src/skills/)
- SkillPipelineStack CDK (7-stage security pipeline)
- SKILL.md v2 spec + shared types
- [ADR-009: Universal Skill Adapter](architecture/decisions/ADR-009-universal-skill-adapter.md)
- [ADR-018: SKILL.md v2](architecture/decisions/ADR-018-skill-md-v2.md)

**What Remains:**
- [ ] Make scaffolded skill modules functional (real DynamoDB queries, real MCP connections)
- [ ] Skill authoring SDK (@chimera/sdk-typescript)
- [ ] MCP server integration via AgentCore Gateway
- [ ] Security pipeline activation (AST scanning, dependency audit, sandbox testing, signing)
- [ ] Skill registry UI

**Dependencies:** Phase 1 (working agent to execute skills)

**Can Parallelize With:** Phase 2 (skill backend is independent of chat frontend)

**Acceptance Criteria:**
- [ ] Developer can publish a skill via SDK
- [ ] Security pipeline blocks malicious skills
- [ ] Agent can discover and use MCP server tools
- [ ] 5-tier trust model enforced (Platform, Verified, Community, Private, Experimental)

---

### Phase 4: Multi-Tenant Production

**Status:** Scaffolded — tenant modules, billing, rate limiting exist

**Goal:** Production-ready multi-tenant isolation

**What Already Exists:**
- TenantOnboardingStack CDK (694 LOC — per-tenant IAM, KMS, DynamoDB)
- Tenant service module (packages/core/src/tenant/)
- Billing module (packages/core/src/billing/)
- Rate limiting types
- [ADR-002: Cedar Policy Engine](architecture/decisions/ADR-002-cedar-policy-engine.md)
- [ADR-014: Token Bucket Rate Limiting](architecture/decisions/ADR-014-token-bucket-rate-limiting.md)

**What Remains:**
- [ ] Tenant router (Cognito JWT to DynamoDB lookup to tenant context)
- [ ] Per-tenant IAM activation (DynamoDB LeadingKeys, S3 bucket-per-tenant, KMS CMK-per-tenant)
- [ ] Cedar policy engine integration
- [ ] Rate limiting (token bucket in chimera-rate-limits table)
- [ ] Cost tracking activation (per-tenant billing in chimera-cost-tracking)
- [ ] Tenant provisioning API + self-service onboarding

**Dependencies:** Phase 1 (working agent), Phase 3 (skill isolation per tenant)

**Acceptance Criteria:**
- [ ] Cross-tenant data leakage tests pass
- [ ] GSI queries enforce tenantId FilterExpression
- [ ] Rate limits prevent abuse (token bucket with 5min TTL)
- [ ] Cost attribution accurate per tenant

---

### Phase 5: Orchestration and Scheduling

**Status:** Scaffolded — OrchestrationStack CDK, swarm module exist

**Goal:** Multi-agent workflows and scheduled tasks

**What Already Exists:**
- OrchestrationStack CDK (Step Functions, SQS, EventBridge)
- Swarm module (packages/core/src/swarm/)
- Orchestration module (packages/core/src/orchestration/)
- [ADR-008: EventBridge Nervous System](architecture/decisions/ADR-008-eventbridge-nervous-system.md)

**What Remains:**
- [ ] EventBridge scheduler integration (cron sessions)
- [ ] A2A protocol for agent-to-agent communication
- [ ] Shared memory (ElastiCache/Redis) for multi-agent coordination
- [ ] Task queuing (SQS) with retry/DLQ
- [ ] Step Functions workflow templates

**Dependencies:** Phase 4 (multi-tenant isolation for orchestrated agents)

**Can Parallelize With:** Phase 3 and Phase 4 (orchestration engine is independent of skill/tenant details)

**Acceptance Criteria:**
- [ ] Cron job executes agent on schedule
- [ ] Multi-agent workflow completes end-to-end
- [ ] Shared memory prevents race conditions

---

### Phase 6: Self-Evolution

**Status:** Scaffolded — EvolutionStack CDK, 7 evolution modules exist

**Goal:** Platform autonomously improves itself

**What Already Exists:**
- EvolutionStack CDK (577 LOC)
- 7 evolution modules: auto-skill-gen, experiment-runner, iac-modifier, model-router, prompt-optimizer, safety-harness, types
- [ADR-011: Self-Modifying IaC](architecture/decisions/ADR-011-self-modifying-iac.md)
- [ADR-017: Multi-Provider LLM](architecture/decisions/ADR-017-multi-provider-llm.md)

**What Remains:**
- [ ] Prompt A/B testing framework (variant management, metric collection, winner detection)
- [ ] Auto-skill generation (pattern detection, SKILL.md synthesis, security validation)
- [ ] Model routing optimization (latency/cost/quality tradeoffs)
- [ ] Self-modifying IaC (DynamoDB-driven CDK synthesis with Cedar policy constraints)
- [ ] Evolution safety harness activation (rate limits, rollback, approval gates)

**Dependencies:** Phase 5 (scheduling for experiments), Phase 3 (skills for auto-generation)

**Acceptance Criteria:**
- [ ] Prompt A/B test declares winner with statistical significance
- [ ] Auto-generated skill passes security pipeline
- [ ] Self-modified infrastructure deploys successfully with rollback capability

---

### Phase 7: Production Hardening

**Status:** PipelineStack CDK exists, ObservabilityStack exists

**Goal:** Production deployment with observability and disaster recovery

**What Already Exists:**
- PipelineStack CDK (639 LOC — CodePipeline, CodeBuild, blue/green)
- ObservabilityStack CDK (406 LOC — CloudWatch, X-Ray, alarms)

**What Remains:**
- [ ] CI/CD pipeline activation and testing
- [ ] Monitoring dashboards (tenant health, skill usage, cost attribution)
- [ ] Disaster recovery (PITR backups, cross-region replication)
- [ ] Load testing (1000 concurrent sessions)
- [ ] Runbook documentation for all alarms

**Dependencies:** Phase 4 (multi-tenant production is prerequisite)

**Can Parallelize With:** Phase 5, Phase 6 (monitoring/CI-CD work is independent)

**Acceptance Criteria:**
- [ ] Load test handles 1000 concurrent sessions
- [ ] 99.9% uptime over 30 days
- [ ] MTTR < 5 minutes
- [ ] All alarms have documented runbooks

---

## Dependency Graph

```
Phase 0 (Foundation) --- ~85% complete
  |
  v
Phase 1 (Working Agent) <-- CRITICAL PATH
  |
  +---------------------+------------------+
  v                     v                  v
Phase 2               Phase 3           Phase 7
(Chat Gateway)        (Skill Ecosystem)  (Production - CI/CD)
  |                     |                  |
  +---------+-----------+                  |
            v                              |
          Phase 4                          |
          (Multi-Tenant)                   |
            |                              |
            +------------------------------+
            v
          Phase 5
          (Orchestration)
            |
            v
          Phase 6
          (Self-Evolution)
```

**Key insight:** After Phase 1, Phases 2, 3, and 7 can proceed in parallel. This cuts the critical path significantly compared to the original strictly-sequential plan.

---

## Research Corpus

### Competitive Analysis (8 docs)
- `docs/research/openclaw-nemoclaw-openfang/` — OpenClaw architecture, NemoClaw enterprise security, OpenFang agent OS, ClawHavoc supply chain analysis
- **Key takeaway:** OpenClaw is personal AI OS; Chimera differentiator is AWS-native account access

### AgentCore and Strands (10 docs)
- `docs/research/agentcore-strands/` — Runtime, Memory, Gateway, Code Interpreter, Browser, Identity, **Integration Guide**
- **Key takeaway:** `BedrockAgentCoreApp` + `StrandsAgentProvider` + `AgentCoreMemory` is the wiring sequence

### AWS Account Agent (32 docs)
- `docs/research/aws-account-agent/` — AWS tools, discovery, Well-Architected, infrastructure-as-capability, activity logging, autonomous problem-solving, self-improvement
- **Key takeaway:** 25 core AWS services prioritized across 4 tiers; discovery triad (Config + Resource Explorer + CloudFormation)

### Architecture Reviews (6 docs)
- `docs/research/architecture-reviews/` — Final architecture plan, component blueprint, multi-tenant review, security review, self-evolution engine, skill ecosystem

### Collaboration Research (6 docs)
- `docs/research/collaboration/` — Communication patterns, real-time/async, shared memory, user-through-agent

### Enhancement and Integration (16 docs)
- `docs/research/enhancement/` + `docs/research/integration-enhancement/`

### Skills Research (9 docs)
- `docs/research/skills/` — Skill format compatibility, MCP integration, OpenClaw/Claude Code/AgentCore patterns

### Architecture Decision Records (18 ADRs)
- `docs/architecture/decisions/ADR-001` through `ADR-018`
- Covers: DynamoDB schema, Cedar policies, Strands framework, Vercel AI SDK, CDK IaC, monorepo structure, AgentCore MicroVM, EventBridge, skill adapters, hybrid storage, self-modifying IaC, Well-Architected, CodeCommit/Pipeline, rate limiting, Bun/mise toolchain, memory strategy, multi-provider LLM, SKILL.md v2

---

## Codebase Metrics

| Metric | Value |
|--------|-------|
| Research documents | 118 files |
| Research lines | 112,000+ |
| Architecture Decision Records | 18 |
| CDK stacks | 11 (4,400+ LOC) |
| Packages | 5 (core, shared, sse-bridge, chat-gateway, cli) |
| Package source code | 42,000+ LOC |
| Test files | 9 (132 passing, 4 skipped) |
| Quality gates | All green (typecheck, lint, tests) |
| AWS tool implementations | 4 (EC2, S3, Lambda, CloudWatch — 2,400+ LOC) |
| Discovery modules | 7 (Config, Resource Explorer, Cost, Stacks, Tags, Index) |
| Skill modules | 7 (Registry, Discovery, Installer, MCP Gateway, Trust, Validator) |
| Evolution modules | 7 (Auto-skill, Experiments, IaC modifier, Model router, Prompt optimizer, Safety) |

---

## What's Next

### Immediate Priority
1. Verify `cdk synth` for all 11 stacks (Phase 0 completion)
2. **Begin Phase 1: Replace ChimeraAgent placeholder with real Strands agent**
3. Wire existing AWS tools into agent (EC2, S3, Lambda, CloudWatch)

### Week 1-2
1. Strands SDK integration + AgentCore Runtime wiring
2. AWS tools connected to agent loop
3. Terminal chat producing real LLM responses

### Week 3-4
1. End-to-end agent validation (message to LLM to AWS tools to response)
2. Begin Phase 2 (chat gateway wiring) and Phase 3 (skill activation) in parallel

### Week 5-8
1. Multi-platform chat (Slack, web UI)
2. Skill marketplace activation
3. CI/CD pipeline testing (Phase 7 early start)

### Week 9-12
1. Multi-tenant production (Phase 4)
2. Orchestration and scheduling (Phase 5)

### Week 13-16
1. Self-evolution activation (Phase 6)
2. Production hardening (Phase 7 completion)
3. Load testing and DR validation

---

## Progress Tracking

### Completed Work

| ID | Title | Type | Completed |
|----|-------|------|-----------|
| `chimera-bbb5` | Resolve DynamoDB schema contradictions | research | 2026-03-18 |
| `chimera-0070` | Rename ClawCore to Chimera throughout docs | task | 2026-03-18 |
| `chimera-2e8e` | Implement SSE bridge | task | 2026-03-19 |
| `chimera-ec1a` | Research: Platform Architecture and Multi-Tenancy Validation | research | 2026-03-19 |
| `chimera-efac` | Research: Agent Collaboration and Communication Layer | research | 2026-03-19 |
| `chimera-0382` | Research: Self-Evolution, ML Experiments and Advanced Capabilities | research | 2026-03-19 |
| `chimera-efa3` | Research: AWS Native and OSS Integration Enhancement | research | 2026-03-19 |
| `chimera-4646` | Improve lead agent workflow | task | 2026-03-19 |
| `chimera-e55a` | Research: Skill format compatibility | research | 2026-03-19 |
| `chimera-0079` | Apply DDB GSI2 updates to renamed Chimera docs | task | 2026-03-19 |
| `chimera-6dd5` | Research: OpenClaw + NemoClaw deep dive | research | 2026-03-21 |
| `chimera-5ec5` | Research: AgentCore + Strands integration guide | research | 2026-03-21 |
| `chimera-6a22` | Fix foundation: typecheck, lint, tests all green | task | 2026-03-21 |

### In Progress

| ID | Title | Status |
|----|-------|--------|
| `chimera-29e6` | Update ROADMAP.md with accurate status | in_progress |
| `chimera-29c6` | Design greenfield agent architecture | in_progress |

---

## Resources

- [CLAUDE.md](../CLAUDE.md) — Development workflow guide
- [VISION.md](VISION.md) — Platform vision and philosophy
- [README.md](../README.md) — Project overview
- [AGENTS.md](../AGENTS.md) — Mulch, Seeds, Canopy quick reference
- [Canonical Data Model](architecture/canonical-data-model.md) — DynamoDB schema
- [Integration Guide](research/agentcore-strands/10-Chimera-Integration-Guide.md) — AgentCore + Strands wiring
- [OpenClaw Deep Dive](research/openclaw-nemoclaw-openfang/00-Deep-Dive-Summary.md) — Competitive analysis

---

**AWS Chimera** — where agents are forged.
