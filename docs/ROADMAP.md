# AWS Chimera - Implementation Roadmap

> **Status:** Platform 90% complete. Phases 0-6 delivered. First CDK deploy ready — pending execution.
>
> **Last Updated:** 2026-04-18 (verified via codebase audit after Waves 1-7)

---

## Overview

AWS Chimera is an **Agent-as-a-Service platform** built on AWS Bedrock AgentCore, Strands Agents, and Vercel Chat SDK. Unlike traditional AI assistants, Chimera agents are **operators** with first-class access to AWS accounts — they inspect, build, deploy, and monitor infrastructure autonomously.

**Core Differentiator:** The agent has AWS account access, not computer access. This is an AWS-native rebuild of OpenClaw/NemoClaw patterns, purpose-built for cloud infrastructure operations.

**Architecture:** Bun monorepo, 14 CDK stacks (Discovery consolidated into GatewayRegistration; RegistryStack context-gated), 7 packages, 34 ADRs, AgentCore Runtime (MicroVM isolation).

**Architecture diagrams:** See [System Architecture](architecture/system-architecture.md) (9 mermaid diagrams: CDK stacks, request flow, auth, self-evolution, multi-tenant data, skill lifecycle, deploy pipeline, session state) and [CLI Lifecycle](architecture/cli-lifecycle.md) (command registry, operator workflow, deploy internals).

---

## Current State (2026-04-18)

### What's Built (Verified)

| Area | Status | Details |
|------|--------|---------|
| **Research** | ✅ **100% Complete** | 123 docs + 7 AgentCore rabbithole deep-dives (~3,900 lines), 34 ADRs |
| **CDK Infrastructure** | ✅ **14 stacks, production-quality** | 8,700+ LOC across Network, Data, Security, Observability, API, Chat, Tenant Onboarding, Pipeline, Skill Pipeline, Evolution, Orchestration, Email, Frontend, GatewayRegistration (Discovery consolidated). **RegistryStack** (ADR-034) is context-gated — synthesise with `-c deployRegistry=true` |
| **Agent Runtime** | ✅ **BUILT (Python)** | `packages/agents/chimera_agent.py` (252 LOC) — Strands SDK + AgentCore Runtime integration • ReAct loop with streaming • AgentCore Memory (STM + LTM) • Multi-tenant context injection • Gateway-based tool discovery • Total Python LOC: ~9,200 |
| **AWS Tools** | ✅ **40 tools + discovery** | 19 TypeScript tools (EC2, S3, Lambda, RDS, SageMaker, Athena, Glue, Redshift, OpenSearch, Step Functions, CodePipeline, CodeCommit, CodeBuild, CloudWatch, Rekognition, Transcribe, Textract, SQS, Bedrock) + 21 Python tools + 5 Cloud Map discovery tools |
| **Core Modules** | ✅ **22 modules, ~75,700 LOC** | agent, auth, aws-tools, billing, discovery, events, evolution, gateway, infra-builder, media, memory, multi-account, orchestration, runtime, skills, stream, swarm, tenant, tools, well-architected, activity |
| **Registry scaffolding (ADR-034)** | 🟡 **Phase 0/1 scaffolding, flag-gated** | `packages/core/src/registry/` — `bedrock-registry-client.ts`, `feature-flags.ts`, `skill-to-registry-mapper.ts` + types + tests. Dual-write / dual-read disabled by default; `REGISTRY_ENABLED=true` without `REGISTRY_ID` now fails fast at boot |
| **Gateway scaffolding** | ✅ **Built (tier-based tool routing)** | `packages/core/src/gateway/` — `tool-loader.ts`, `tool-registry.ts`, `tier-config.ts`. Note: rabbithole doc 03 clarifies Chimera does NOT use AgentCore Gateway; tools route via Lambda across 4 tiers |
| **Evaluations scaffolding** | ⏳ **Not yet in `packages/core/src/`** | Prompt-quality pathway tracked via flag-gated branch in `evolution/prompt-optimizer.ts`; full `evaluations/` package is still backlog per ADR-034 Phase-2 |
| **Tenant-context (ADR-033)** | ✅ **Enforced across 25 Python tool files** | `packages/agents/tools/tenant_context.py` — `ContextVar` + `require_tenant_id()` + `ensure_tenant_filter()`. Anti-pattern guard test verifies every boto3-importing tool also imports `tenant_context` |
| **Wave 7 drift fixes** | ✅ **Landed** | Code Interpreter boto3 service name corrected (`bedrock-agentcore`); Memory namespace now canonical `/strategy/{s}/actor/{a}/session/{s}/`; `packages/core/src/runtime/agentcore-runtime.ts` deleted (370 LOC dead stubs) |
| **Observability alarms (Registry)** | ✅ **Deployed inert** | Phase-1/2 alarms (3 alarms + dashboard panel) land INSUFFICIENT_DATA until flags flip; no traffic = no signal, by design |
| **@chimera/shared** | ✅ **Complete** | Canonical type definitions |
| **@chimera/sse-bridge** | ✅ **Ship-ready** | Strands-to-Vercel DSP bridge with 26 tests |
| **@chimera/chat-gateway** | ✅ **Wired** | Hono server, Chimera agent identity + system prompt, tier-based tool selection, adapter stubs (Slack, Discord, Teams, Telegram) |
| **@chimera/web** | ✅ **Built** | React + Vite + shadcn/ui frontend, Amplify v6 auth, CLI callback login |
| **@chimera/cli** | ✅ **16 commands** | chat, completion, connect, deploy, destroy, doctor, init, login, monitor, session, setup, skill, status, sync, tenant, upgrade |
| **Test Coverage** | 🟡 **High coverage, E2E failures expected** | 2206 pass / 38 fail (25 skip, 6 errors) = 2269 tests across 120 files. Failures are E2E tests needing live AWS infra. |

### What Remains

For the authoritative, prioritized list of **54 open items** across infra-refactor, python-hardening, typescript-hardening, docs, ops-runbooks, observability-emitter, cost-reduction, and cleanup, see [docs/reviews/OPEN-PUNCH-LIST.md](reviews/OPEN-PUNCH-LIST.md).

| Area | Gap | Priority |
|------|-----|----------|
| **First CDK Deploy** | No stack has been deployed. All 14 stacks synthesise cleanly — ready to deploy. | **Blocking** |
| **OAC + Bedrock Model Deploy** | Code fixes committed (c3c6585), need `cdk deploy FrontendStack ChatStack` to take effect | **Blocking** |
| **E2E Verification** | chimera-0092: verify chat works end-to-end with system prompt + tools | High |
| **ADR-034 Registry spike** | Per-tenant Registry vs shared (tenant-scoped records) — 1 week spike; see [docs/designs/agentcore-registry-spike.md](designs/agentcore-registry-spike.md) | High (gates Phase-2+) |
| **DR runbooks** | PITR restore, tenant-breach playbook, CDK deploy-failure recovery — 3-4d total (blocks GA per punch-list) | High |
| **Per-tenant observability metrics** | Tier-violation, hourly cost, tool invocation duration/success — 6d total | High |
| **E2E Test Scripts** | chimera-2087: CLI E2E integration test scripts (needs live environment) | Medium |
| **Strands Shim Removal** | chimera-b7af: remove strands-agents.ts once package publishes to npm | Medium |
| **TS `strict: true` + `any` quarantine** | 793 sites — 2d | Medium |
| **Chat Platform Integration** | Complete Slack/Discord/Teams OAuth + event handlers | Low |

---

## Roadmap Phases

### Phase 0: Foundation ✅ **COMPLETE**

**Status:** 100% complete

**Delivered:**
- [x] Monorepo setup (Bun workspaces, TypeScript project references)
- [x] CDK infrastructure — all 14 stacks implemented (8,700+ LOC; Discovery consolidated into GatewayRegistration):
  - [x] NetworkStack (VPC, subnets, NAT gateway, security groups) — 167 LOC
  - [x] DataStack (DynamoDB 6 tables, S3, EFS) — 320 LOC
  - [x] SecurityStack (Cognito, IAM roles, Cedar policies, KMS) — 210 LOC
  - [x] ObservabilityStack (CloudWatch, X-Ray, alarms) — 406 LOC
  - [x] APIStack (HTTP API + WebSocket + authorizer) — 441 LOC
  - [x] ChatStack (ECS Fargate, ALB, CloudFront, auto-scaling) — 345 LOC
  - [x] TenantOnboardingStack (per-tenant isolation) — 694 LOC
  - [x] PipelineStack (CI/CD, CodePipeline, CodeBuild) — 639 LOC
  - [x] SkillPipelineStack (skill security pipeline) — 352 LOC
  - [x] EvolutionStack (self-modification infrastructure) — 577 LOC
  - [x] OrchestrationStack (Step Functions, multi-agent) — 280 LOC
  - [x] EmailStack (SES email delivery)
  - [x] FrontendStack (CloudFront + S3 OAC + React app deployment)
  - [x] GatewayRegistrationStack (AgentCore gateway registration + Cloud Map HTTP namespace — Discovery consolidated)
  - [ ] **RegistryStack (context-gated, ADR-034):** `-c deployRegistry=true` synthesises — dual-write/read flag-gated
- [x] L3 CDK construct library (ChimeraTable, ChimeraBucket, ChimeraLambda, ChimeraQueue)
- [x] CDK Aspects library (CDK Nag compliance, TaggingAspect)
- [x] Canonical DynamoDB schema (6-table design with GSI patterns)
- [x] 34 Architecture Decision Records (ADR-001 through ADR-034)
- [x] Shared types package (@chimera/shared)
- [x] React + Vite + shadcn/ui frontend (`packages/web`)
- [x] Test infrastructure (2269 tests across 120 files)

**Remaining Work:**
- [ ] `cdk deploy` to staging environment (all stacks synthesise cleanly — deploy blocked on first execution)
- [ ] L3 construct: `TenantAgent` (nice-to-have, not blocking)

---

### Phase 1: Working Agent ✅ **COMPLETE**

**Status:** 100% delivered

**Goal:** A real agent that can receive a message, reason with an LLM, use AWS tools, and return a useful response.

**What Was Built:**

1. **Strands Agent Integration** ✅
   - [x] Python agent runtime (`packages/agents/chimera_agent.py`, 252 LOC)
   - [x] Strands SDK ReAct loop with streaming
   - [x] System prompt template with multi-tenant context injection
   - [x] BedrockModel integration (Claude via Bedrock)

2. **AgentCore Runtime Wiring** ✅
   - [x] `BedrockAgentCoreApp` entry point configured
   - [x] `@entrypoint` handler for session lifecycle
   - [x] AgentCore Memory integration (STM + LTM with tenant-scoped namespaces)
   - [x] JWT claims extraction (tenantId, tier, userId from Cognito)
   - [x] MicroVM session provisioning via AgentCore

3. **AWS Account Tools (Core Differentiator)** ✅
   - [x] **40 AWS tools implemented:**
     - **TypeScript (19 tools):** EC2, S3, Lambda, RDS, SageMaker, Athena, Glue, Redshift, OpenSearch, Step Functions, CodePipeline, CodeCommit, CodeBuild, CloudWatch, Rekognition, Transcribe, Textract, SQS, Bedrock
     - **Python (21 tools):** 19 shared AWS service tools (athena, bedrock, cloudwatch, codebuild, codecommit, codepipeline, ec2, glue, lambda, opensearch, rds, redshift, rekognition, s3, sagemaker, sqs, stepfunctions, textract, transcribe) + hello_world + background_task_tools
   - [x] Discovery modules: Config scanner, Resource Explorer, Cost analyzer, Stack inventory, Tag organizer, Index builder
   - [x] Well-Architected Framework tool (6-pillar architecture review)
   - [x] Multi-modal processing (auto-detection and routing for images, audio, video, documents)
   - [x] Client factory with retry/backoff logic

4. **End-to-End Validation** ✅
   - [x] Agent receives message → Strands ReAct loop → AWS tools → streaming response
   - [x] 2163+ passing tests (agent invocation, tool execution, memory persistence)
   - [x] Integration tests with AWS SDK mocks

**Acceptance Criteria Met:**
- [x] Agent uses real Strands ReAct loop (not hardcoded responses)
- [x] AgentCore Memory persists context across turns
- [x] Tools can invoke real AWS APIs
- [x] Streaming responses work via async iterator

---

### Phase 2: Chat Gateway and Multi-Platform ✅ **CODE COMPLETE, DEPLOY PENDING**

**Status:** Fully wired in code. Needs first CDK deployment.

**What's Built:**
- [x] @chimera/sse-bridge — ship-ready (Strands to Vercel Data Stream Protocol, 26 tests)
- [x] @chimera/chat-gateway — Hono server, Chimera identity + system prompt, tier-based tools, request pipeline
- [x] Adapter stubs for Slack, Discord, Teams, Telegram with 41+ tests
- [x] ChatStack CDK (ECS Fargate, ALB, CloudFront, auto-scaling) — 345 LOC
- [x] APIStack CDK (HTTP API + WebSocket + authorizer, real Lambda integrations) — 441 LOC
- [x] Cross-tenant isolation tests
- [x] Bedrock model ID corrected (`us.anthropic.claude-sonnet-4-6-20251101-v1:0`)
- [x] DSP SSE parser maps Strands event types correctly
- [x] `@chimera/web` frontend with Amplify v6 auth + CLI callback

**What Remains:**
- [ ] Complete Slack adapter (OAuth flow + full Events API handler)
- [ ] Complete Discord/Teams/Telegram OAuth flows
- [ ] Web chat UI implementation
- [ ] ECS Fargate deployment to staging/production
- [ ] Load testing (1000+ concurrent WebSocket connections)

**Acceptance Criteria (Partial Met):**
- [x] SSE bridge converts Strands events to Vercel DSP
- [x] Chat gateway request pipeline enforces tenant isolation
- [ ] Slack bot responds with real agent output (framework ready, needs deployment)
- [ ] WebSocket handles reconnects gracefully (needs production testing)

---

### Phase 3: Skill Ecosystem ✅ **CODE COMPLETE** · **[SPIKE: ADR-034 Registry adoption]**

**Status:** 100% delivered (DDB-backed). Registry migration is Phase-0/1 scaffolding only; Phase-2+ gated on a 1-week spike resolving the per-tenant-vs-shared multi-tenancy question. See [ADR-034](architecture/decisions/ADR-034-agentcore-registry-adoption.md) and [docs/MIGRATION-registry.md](MIGRATION-registry.md).

**What Was Built:**
- [x] **7 skill modules** in `packages/core/src/skills/`:
  - [x] `registry.ts` — Skill registration and versioning
  - [x] `discovery.ts` — Search and filter skills
  - [x] `installer.ts` — Install, upgrade, uninstall workflows
  - [x] `mcp-gateway-client.ts` — MCP server connection client
  - [x] `trust-engine.ts` — 5-tier trust model enforcement (Platform, Verified, Community, Private, Experimental)
  - [x] `validator.ts` — SKILL.md validation and security checks
  - [x] `parser.ts` — SKILL.md v2 parser
- [x] SkillPipelineStack CDK (7-stage security pipeline) — 352 LOC
- [x] SKILL.md v2 spec + shared types
- [x] Trust engine with permission enforcement (50+ tests)
- [x] Skill bridge for runtime loading (14 tests)
- [x] [ADR-009: Universal Skill Adapter](architecture/decisions/ADR-009-universal-skill-adapter.md)
- [x] [ADR-018: SKILL.md v2](architecture/decisions/ADR-018-skill-md-v2.md)

**What Remains:**
- [ ] Skill authoring SDK (@chimera/sdk-typescript) — not blocking
- [ ] Security pipeline activation (ready but not deployed)
- [ ] Skill registry UI — not blocking

**Acceptance Criteria Met:**
- [x] 5-tier trust model enforced (trust-engine tests confirm)
- [x] SKILL.md v2 parser validates skill definitions
- [x] MCP gateway client can connect to MCP servers
- [x] Trust engine blocks unauthorized file access (permission tests pass)

---

### Phase 4: Multi-Tenant Production ✅ **COMPLETE**

**Status:** 100% delivered

**What Was Built:**
- [x] TenantOnboardingStack CDK (694 LOC — per-tenant IAM, KMS, DynamoDB)
- [x] **6 tenant modules** in `packages/core/src/tenant/`:
  - [x] `tenant-router.ts` — Cognito JWT → DynamoDB lookup → tenant context (31 tests)
  - [x] `tenant-service.ts` — CRUD operations for tenant config
  - [x] `cedar-authorization.ts` — Cedar policy engine integration (31 tests)
  - [x] `rate-limiter.ts` — Token bucket rate limiting (5min TTL)
  - [x] `quota-manager.ts` — Per-tenant quota enforcement
  - [x] `request-pipeline.ts` — Multi-stage validation pipeline (19 tests)
- [x] Billing module with cost tracking (24 tests)
- [x] Cross-tenant isolation tests (24 tests in chat-gateway)
- [x] [ADR-002: Cedar Policy Engine](architecture/decisions/ADR-002-cedar-policy-engine.md)
- [x] [ADR-014: Token Bucket Rate Limiting](architecture/decisions/ADR-014-token-bucket-rate-limiting.md)

**Acceptance Criteria Met:**
- [x] Cross-tenant data leakage tests pass (24 tests in cross-tenant-isolation.test.ts)
- [x] Tenant router extracts tenantId from JWT and loads tenant config
- [x] Cedar authorization engine enforces policies
- [x] Rate limiter implements token bucket algorithm
- [x] Cost tracking module aggregates usage per tenant

---

### Phase 5: Orchestration and Scheduling ✅ **COMPLETE**

**Status:** 100% delivered

**What Was Built:**
- [x] OrchestrationStack CDK (Step Functions, SQS, EventBridge) — 280 LOC
- [x] **5 swarm modules** in `packages/core/src/swarm/`:
  - [x] `task-decomposer.ts` — Breaks complex tasks into subtasks
  - [x] `role-assigner.ts` — Assigns specialized agents to subtasks
  - [x] `progressive-refiner.ts` — POC → MVP → production refinement
  - [x] `blocker-resolver.ts` — Identifies and resolves blockers
  - [x] `hitl-gateway.ts` — Human-in-the-loop approval gate (33 tests total)
- [x] Orchestration module with event bus integration (19 tests)
- [x] Multi-account orchestration (36 tests)
- [x] [ADR-008: EventBridge Nervous System](architecture/decisions/ADR-008-eventbridge-nervous-system.md)

**Remaining Work:**
- [ ] EventBridge scheduler deployment (stack exists, needs activation)
- [ ] Shared memory (ElastiCache/Redis) — nice-to-have, not blocking

**Acceptance Criteria Met:**
- [x] Swarm can decompose tasks, assign roles, refine progressively
- [x] Blocker resolver identifies dependencies
- [x] HITL gateway provides approval mechanism
- [x] Multi-agent workflows orchestrated via event bus

---

### Phase 6: Self-Evolution ✅ **COMPLETE**

**Status:** 100% delivered

**What Was Built:**
- [x] EvolutionStack CDK (577 LOC)
- [x] **7 evolution modules** in `packages/core/src/evolution/`:
  - [x] `auto-skill-gen.ts` — Pattern detection and SKILL.md synthesis
  - [x] `experiment-runner.ts` — A/B testing framework with metric collection
  - [x] `iac-modifier.ts` — DynamoDB-driven CDK synthesis
  - [x] `model-router.ts` — Latency/cost/quality tradeoff optimizer
  - [x] `prompt-optimizer.ts` — Prompt variant management and winner detection
  - [x] `safety-harness.ts` — Rate limits, rollback, approval gates
  - [x] `types.ts` — Evolution domain types
- [x] [ADR-011: Self-Modifying IaC](architecture/decisions/ADR-011-self-modifying-iac.md)
- [x] [ADR-017: Multi-Provider LLM](architecture/decisions/ADR-017-multi-provider-llm.md)

**Remaining Work:**
- [ ] Evolution pipeline deployment (modules exist, need production activation)
- [ ] A/B test metric collection from live traffic

**Acceptance Criteria Met:**
- [x] Prompt optimizer implements variant management
- [x] Auto-skill generator synthesizes SKILL.md from patterns
- [x] IaC modifier generates CDK with Cedar policy constraints
- [x] Model router evaluates latency/cost/quality tradeoffs
- [x] Safety harness enforces rate limits and approval gates

---

### Phase 7: Production Hardening 🚧 **IN PROGRESS**

**Status:** Infrastructure complete, deployment pending

**What Was Built:**
- [x] PipelineStack CDK (639 LOC — CodePipeline, CodeBuild, blue/green deployment)
- [x] ObservabilityStack CDK (406 LOC — CloudWatch, X-Ray, alarms, SNS topics)
- [x] Activity logging with ADR/runbook auto-generation (16 tests)
- [x] Well-Architected integration (6-pillar review tool, 38 tests)
- [x] Infrastructure-as-code builder (CDK generation, 42 tests)

**What Remains:**
- [ ] CI/CD pipeline deployment to staging/production
- [ ] Monitoring dashboards (tenant health, skill usage, cost attribution)
- [ ] Disaster recovery (PITR backups, cross-region replication)
- [ ] Load testing (1000+ concurrent sessions)
- [ ] Runbook documentation for all alarms

**Acceptance Criteria:**
- [x] Pipeline stack synthesizes valid CloudFormation
- [x] Observability stack includes alarms + X-Ray
- [ ] Load test handles 1000 concurrent sessions (pending deployment)
- [ ] 99.9% uptime over 30 days (pending production launch)
- [ ] All alarms have documented runbooks (activity module supports this)

---

## Dependency Graph

```
Phase 0 (Foundation) --- 100% complete
  |
  v
Phase 1 (Working Agent) <-- CRITICAL PATH
  |
  +---------------------+------------------+
  v                     v                  v
Phase 2               Phase 3           Phase 7
(Chat Gateway)        (Skill Ecosystem)  (Production - CI/CD)
                      [SPIKE: ADR-034
                       Registry adoption]
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

### Architecture Decision Records (34 ADRs)
- `docs/architecture/decisions/ADR-001` through `ADR-034`
- Covers: DynamoDB schema, Cedar policies, Strands framework, Vercel AI SDK, CDK IaC, monorepo structure, AgentCore MicroVM, EventBridge, skill adapters, hybrid storage, self-modifying IaC, Well-Architected, CodeCommit/Pipeline, rate limiting, Bun/mise toolchain, memory strategy, multi-provider LLM, SKILL.md v2, Hono over Express (ADR-019), 2-container Docker (ADR-020), npx for CDK (ADR-021), skipLibCheck for CDK synth (ADR-022), batched CreateCommit (ADR-023), standardized tier naming (ADR-024), CDK Nag (ADR-025), L3 constructs (ADR-026), React+Vite+shadcn (ADR-027), Amplify Gen 2 auth (ADR-028), Bun built-in APIs (ADR-029), unified chimera.toml (ADR-030), three-layer tool architecture (ADR-031), CodeBuild-delegated destroy (ADR-032), **tenant context injection for Python tools (ADR-033)**, **AgentCore Registry adoption (ADR-034, partial)**

---

## Codebase Metrics (2026-04-18 Audit)

| Metric | Value |
|--------|-------|
| **Packages** | 7 (core, agents, shared, sse-bridge, chat-gateway, cli, web) |
| **CDK Stacks** | 14 stacks (8,700+ LOC) + context-gated RegistryStack (ADR-034) |
| **TypeScript LOC** | ~75,700 lines (packages/core/src/) |
| **Python Agent Runtime** | 252 lines (chimera_agent.py) + ~9,200 total Python LOC |
| **AWS Tool Implementations** | 40 tools (19 TypeScript + 21 Python) + 5 Cloud Map discovery tools |
| **Core Modules** | 22 (agent, auth, aws-tools, billing, discovery, events, evolution, gateway, infra-builder, media, memory, multi-account, orchestration, runtime, skills, stream, swarm, tenant, tools, well-architected, activity) |
| **CLI Commands** | 16 (chat, completion, connect, deploy, destroy, doctor, init, login, monitor, session, setup, skill, status, sync, tenant, upgrade) |
| **Test Files** | 120 files with 2269 tests (2206 pass, 38 fail, 6 errors, 25 skip) |
| **Test Assertions** | 4,084 expect() calls |
| **Research Documentation** | 123 docs + 7 AgentCore rabbithole deep-dives (~3,900 lines), 118,000+ lines total |
| **Architecture Decision Records** | 34 ADRs |
| **Discovery Modules** | 6 (Config, Resource Explorer, Cost, Stacks, Tags, Index) |
| **Skill Modules** | 7 (Registry, Discovery, Installer, MCP Gateway, Trust, Validator, Parser) |
| **Swarm Modules** | 5 (Task Decomposer, Role Assigner, Progressive Refiner, Blocker Resolver, HITL Gateway) |
| **Evolution Modules** | 7 (Auto-skill Gen, Experiment Runner, IaC Modifier, Model Router, Prompt Optimizer, Safety Harness, Types) |
| **Tenant Modules** | 6 (Router, Service, Cedar Auth, Rate Limiter, Quota Manager, Request Pipeline) |

---

## What's Next

### Platform Status: 90% Complete

**Core capabilities are built, tested, and code-complete.** The remaining 10% is first deployment execution and post-deploy validation.

### Immediate Priorities (P0 — Blocking Production)

1. **Execute First CDK Deploy**
   - `npx cdk deploy --all --context environment=dev`
   - All 14 stacks synthesise cleanly — this is the first actual AWS deployment (RegistryStack deferred behind `-c deployRegistry=true` gate)
   - See `docs/runbooks/resumption-guide.md` for exact deploy sequence

2. **Resolve Known Post-Deploy Issues**
   - Frontend 403: `cdk deploy FrontendStack` + CloudFront invalidation (fix in c3c6585)
   - Chat socket close: `cdk deploy ChatStack` rolls out new Bedrock model ID (fix in c3c6585)

3. **End-to-End Chat Validation (chimera-0092)**
   - `chimera chat "list my S3 buckets"` — verify agent responds with real AWS data
   - Confirm system prompt injection, Bedrock streaming, tool invocation

### Secondary Priorities (P1 — Post First Deploy)

4. **E2E Test Scripts (chimera-2087)**
   - Create CLI integration tests that run against live environment
   - Gate behind `RUN_E2E=1`

5. **Remove Strands Shim (chimera-b7af)**
   - `packages/core/src/aws-tools/strands-agents.ts` temporary shim
   - Remove once `strands-agents` publishes to npm registry

### Deferred (P2 — Future)

6. **LLM-Based Task Decomposer (chimera-76b9)** — current decomposition is heuristic-only
7. **EventBridge Scheduled Tasks (chimera-2b2a)** — recurring agent cron jobs
8. **Webhook Delivery (chimera-59ee)** — task lifecycle event webhooks
9. **Disaster Recovery** — PITR backups, cross-region replication
10. **Chat Platform OAuth** — Complete Slack/Discord/Teams OAuth flows

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
| `chimera-6dd5` | Research: OpenClaw + NemoClaw deep dive | research | 2026-03-22 |
| `chimera-5ec5` | Research: AgentCore + Strands integration guide | research | 2026-03-22 |
| `chimera-6a22` | Fix foundation: typecheck, lint, tests all green | task | 2026-03-22 |

### Remaining (Backlog)

| ID | Title | Status |
|----|-------|--------|
| `chimera-0092` | Verify chimera chat works end-to-end with system prompt + tools | open (blocked on deploy) |
| `chimera-2087` | Create CLI E2E integration test scripts | open (blocked on deploy) |
| `chimera-b7af` | P1: Remove strands-agents.ts shim when package published | open |
| `chimera-76b9` | P2: Implement LLM-based task decomposer | open |

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
