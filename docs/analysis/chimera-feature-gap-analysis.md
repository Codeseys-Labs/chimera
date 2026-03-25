---
title: "Chimera Feature Gap Analysis"
version: 1.0.0
status: canonical
last_updated: 2026-03-25
sources:
  - docs/analysis/session-40-user-directives.md
  - docs/ROADMAP.md
  - docs/architecture/ARCHITECTURE.md
  - docs/analysis/WELL_ARCHITECTED_ANALYSIS.md
  - docs/research/enhancement/00-Gap-Analysis-Report.md
---

# Chimera Feature Gap Analysis

> **Purpose:** Comprehensive inventory of what was planned, what was built, and what remains. Synthesizes session-40 directives, the research corpus, and a verified codebase audit into a prioritized backlog.
>
> **Last verified:** 2026-03-25 | **Platform completion:** ~85%

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Feature Inventory](#2-feature-inventory)
3. [Prioritized Backlog (P0–P3)](#3-prioritized-backlog-p0p3)
4. [Architecture Gaps](#4-architecture-gaps)
5. [Open Issues (Unresolved Decisions)](#5-open-issues-unresolved-decisions)
6. [Recommendations](#6-recommendations)

---

## 1. Executive Summary

AWS Chimera is an **Agent-as-a-Service platform** that gives AI agents first-class access to an AWS account. The vision (session-40 directive #4) is an AWS-native rebuild of OpenClaw/NemoClaw: self-evolving, multi-tenant, deployable from a single CLI command.

### Platform Health Snapshot

| Dimension | Status | Score |
|-----------|--------|-------|
| Research & Architecture | ✅ Complete | 123 docs, 18 ADRs, 118k+ lines |
| Core Infrastructure (CDK) | ✅ Complete | 11 stacks, 5,800+ LOC |
| Agent Runtime | ✅ Complete | Python Strands + AgentCore (317 LOC) |
| AWS Tools | ✅ Complete | 25 tools (19 TS + 6 Python) |
| Core Modules | ✅ Complete | 21 modules, ~48,300 LOC |
| SSE Bridge | ✅ Ship-ready | 26 tests |
| Chat Gateway | 🚧 Framework ready | Stubs, not deployed |
| CLI | ✅ Built | Deploy, tenant, session, skill, connect, status |
| Test Suite | 🚧 Partial | 860 pass / 82 fail / 20 errors |
| Production Deployment | ❌ Not done | Stacks undeployed |
| Lambda implementations | ❌ ~60% placeholder | Blocks production |
| HTTPS / TLS | ❌ Missing | ALB returns 503 |

### Top-Level Findings

1. **Platform is feature-complete at the module level but operationally blocked.** The core agent loop, multi-tenancy, skill ecosystem, orchestration, and self-evolution modules are all built and tested. Production is blocked by placeholder Lambda implementations and missing deployment infrastructure.

2. **~15 Lambda functions are empty scaffolds.** SkillPipelineStack (all 7), OrchestrationStack (all 6), PipelineStack (2), EvolutionStack (1), ChatStack (HTTPS listener) contain no real logic. These are the only hard blockers to a working production system.

3. **Error handling is absent across all Step Functions state machines** (10 state machines, 0 Catch blocks). Silent failures will cascade in production.

4. **Five planned user-facing features are unbuilt:** Web Chat UI, Chat Platform Adapters (Slack/Discord/Teams/Telegram OAuth), Group Chat, CLI Binary Compilation, Upstream Sync.

5. **Six architectural questions from session-40 remain unresolved** — see §5.

---

## 2. Feature Inventory

### 2.1 Built and Verified ✅

| Feature | Location | Evidence |
|---------|----------|---------|
| 11-stack CDK infrastructure | `infra/lib/*.ts` | 5,800+ LOC; stack map in ARCHITECTURE.md §4 |
| 6-table DynamoDB schema | `infra/lib/data-stack.ts` | ADR-001; canonical model at docs/architecture/canonical-data-model.md |
| AgentCore MicroVM runtime | `packages/agents/chimera_agent.py` | 317 LOC; BedrockAgentCoreApp entrypoint |
| Strands ReAct loop | `packages/agents/chimera_agent.py` | Bedrock Converse, max 20 iterations |
| AgentCore Memory (STM + LTM) | `packages/agents/` | Tenant-scoped namespaces; 3 tier configs |
| 25 AWS Tools | `packages/core/src/tools/`, `packages/agents/tools/` | EC2, S3, Lambda, RDS, SageMaker, Athena, Glue, Redshift, OpenSearch, Step Functions, CodePipeline, CodeCommit, CodeBuild, CloudWatch, Rekognition, Transcribe, Textract, SQS, Bedrock (TS); hello_world, s3, ec2, codecommit, codepipeline, background_task (Python) |
| AWS Account Discovery | `packages/core/src/discovery/` | 6 modules: Config, Resource Explorer, Cost, Stacks, Tags, Index |
| Well-Architected Tool | `packages/core/src/well-architected/` | 6-pillar review; 38 tests |
| SSE Bridge (Strands → Vercel DSP) | `packages/sse-bridge/` | 26 tests; ship-ready |
| Hono Chat Gateway (framework) | `packages/chat-gateway/` | Express→Hono server, middleware, routes |
| Chat adapter stubs | `packages/chat-gateway/src/adapters/` | Slack, Discord, Teams, Telegram (stubs + 41+ tests) |
| JWT / Cognito auth | `packages/core/src/auth/` | JWT validation, PKCE, token refresh |
| Cedar authorization engine | `packages/core/src/tenant/cedar-authorization.ts` | 31 tests; 5-tier trust enforcement |
| Tenant router (JWT → DDB lookup) | `packages/core/src/tenant/tenant-router.ts` | 31 tests |
| Rate limiter (token bucket) | `packages/core/src/tenant/rate-limiter.ts` | DynamoDB-native; ADR-014 |
| Quota manager | `packages/core/src/tenant/quota-manager.ts` | Per-tenant; tier-based |
| Billing module | `packages/core/src/billing/` | 24 tests |
| Cross-tenant isolation tests | `packages/chat-gateway/tests/cross-tenant-isolation.test.ts` | 24 tests |
| 7 Skill modules | `packages/core/src/skills/` | Registry, Discovery, Installer, MCP Gateway, Trust, Validator, Parser |
| SKILL.md v2 parser + validator | `packages/core/src/skills/parser.ts`, `validator.ts` | 50+ tests; ADR-018 |
| 5-tier trust model | `packages/core/src/skills/trust-engine.ts` | Platform, Verified, Community, Private, Experimental |
| SkillPipelineStack (CDK) | `infra/lib/skill-pipeline-stack.ts` | 352 LOC; 7-stage Step Functions (Lambda stubs) |
| 5 Swarm modules | `packages/core/src/swarm/` | Task Decomposer, Role Assigner, Progressive Refiner, Blocker Resolver, HITL Gateway; 33 tests |
| Multi-agent orchestration | `packages/core/src/orchestration/` | EventBridge event bus; 19 tests |
| Multi-account orchestration | `packages/core/src/multi-account/` | 36 tests |
| 7 Evolution modules | `packages/core/src/evolution/` | Auto-skill Gen, Experiment Runner, IaC Modifier, Model Router, Prompt Optimizer, Safety Harness, Types |
| Model router (toggleable) | `packages/core/src/evolution/model-router.ts` | static/auto routing modes; ADR-017 |
| DynamoDB-driven IaC modifier | `packages/core/src/evolution/iac-modifier.ts` | Self-modifying CDK; ADR-011 |
| CLI tool | `packages/cli/` | deploy, tenant, session, skill, connect, status |
| CLI deploy (CodeCommit push) | `packages/cli/src/commands/deploy.ts` | CreateCommit API; batched 5MB; GitHub release source |
| CLI destroy (with data retention) | `packages/cli/src/commands/destroy.ts` | --retain-data, --export-path |
| CLI sync + upgrade | `packages/cli/src/commands/sync.ts`, `upgrade.ts` | Pure AWS SDK v3 |
| CLI TOML config | `packages/cli/src/config/` | loadWorkspaceConfig + saveWorkspaceConfig |
| Infra builder | `packages/core/src/infra-builder/` | CDK generation; 42 tests |
| Media module (multi-modal) | `packages/core/src/media/` | auto-detect and route images, audio, video, docs |
| Activity logging | `packages/core/src/activity/` | ADR/runbook auto-generation; 16 tests |
| AGENTS.md + SOUL.md | Root + `packages/agents/` | Agent identity and priming documents |
| 18 Architecture Decision Records | `docs/architecture/decisions/ADR-001–018` | All core decisions documented |
| Session retrospective format | `docs/SESSION-RETROSPECTIVE.md` | Structured format with accomplishments |
| Performance/cost model | `docs/research/performance/benchmark-plan.md` | Benchmark methodology |

### 2.2 Built but Incomplete / Not Deployed 🚧

| Feature | Status | Gap |
|---------|--------|-----|
| Chat gateway (Hono server) | Framework only | ECS Fargate deployment not done; HTTPS listener returns 503 |
| Slack adapter | Stub only | OAuth flow + Events API handler missing |
| Discord/Teams/Telegram adapters | Stub only | OAuth flows missing |
| SkillPipeline Lambda functions | CDK defined, all placeholders | No actual scanning logic (StaticAnalysis, DependencyAudit, SandboxRun, PermissionValidation, Signing, MonitoringConfig, FailureNotification) |
| OrchestrationStack Lambdas | CDK defined, all placeholders | start-build, check-build, run-query, check-query, execute-bg-task, check-bg-task all empty |
| PipelineStack canary deploy | Placeholder | deployCanary and rollback have no actual implementation |
| EvolutionStack generateSkill | Placeholder | Skill generation logic missing |
| CDK test coverage | 4/11 stacks | Missing: ObservabilityStack, ApiStack, SkillPipelineStack, ChatStack, EvolutionStack, TenantOnboardingStack, PipelineStack |
| Step Functions error handling | 10 state machines | 0 Catch blocks; 0 retry policies; 0 DLQs |
| Test suite | 962 tests | 82 failing + 20 errors (mostly missing dependencies: js-yaml, @aws-sdk/client-transcribe) |
| Tenant tier change workflow | Missing | Upgrade/downgrade path not implemented |
| Tenant offboarding | Missing | No resource cleanup on delete |

### 2.3 Planned but Not Built ❌

| Feature | Session-40 Directive | Notes |
|---------|---------------------|-------|
| Web Chat UI | #17, #20, #27 | No frontend code; Vercel Chat SDK integration not started |
| Group chat | #65 | "Implementation or at least guidance documented" |
| CLI binary compilation | #17 | bun compile to single binary; GitHub Actions release pipeline |
| Upstream sync / upgrade flow | #65 | CLI command or agent-automatic; unresolved |
| MFA enforcement (Cognito) | Implied security requirement | MFA currently absent from SecurityStack |
| ECR image signing | Security best practice | Not implemented |
| CloudFront CDN / caching | #56, Architecture diagram | Referenced in ARCHITECTURE.md diagram but not deployed |
| DynamoDB VPC endpoint | Infrastructure | Missing from NetworkStack (all DDB traffic via NAT) |
| Per-tenant cost attribution | #56 | Cost allocation tags not applied; no tenant billing pipeline |
| OpenAI-compatible endpoint | ApiStack | Stub returning 501; no stream chunking |
| Dashboard for deployments | #56 | No visibility into deployed version, canary health, rollout |
| Disaster recovery runbooks | #56 | DR runbooks, cross-region replication, backup validation |
| HTTPS / TLS on ALB | Infrastructure | ACM certificate not wired; HTTPS returns 503 |
| Fargate Spot instances | Cost optimization | All tasks on standard Fargate; 50-70% savings unrealized |
| Parameterized stack config | Code quality | 15+ hardcoded values not in config file |
| Operational runbooks | #56, #79 | On-call procedures for DDB throttling, cost anomalies, etc. |
| API specification (OpenAPI) | Architecture gap | REST/WebSocket/SSE endpoints undocumented formally |
| Migration guide (from OpenClaw) | Research gap | Compatibility matrix + converter not built |
| Skill authoring SDK | Phase 3 remainder | @chimera/sdk-typescript not started |
| Skill registry UI | Phase 3 remainder | ClawHub marketplace frontend |
| Admin dashboard | Phase 4 remainder | Tenant provisioning/monitoring UI |
| Load testing (1000+ sessions) | Phase 7 | Not executed |
| PITR backup validation | Phase 7 | Procedure not documented or tested |
| Performance benchmarks | Research | p50/p95/p99 targets not established |

---

## 3. Prioritized Backlog (P0–P3)

### P0 — Production Blockers (must fix before any real user traffic)

| ID | Item | Effort | Impact |
|----|------|--------|--------|
| P0-01 | **Implement SkillPipelineStack Lambdas** (7 functions: StaticAnalysis via eslint/pylint, DependencyAudit via OSV, SandboxRun, PermissionValidation, Signing, MonitoringConfig, FailureNotification) | ~20h | Skill marketplace non-functional without this |
| P0-02 | **Implement OrchestrationStack Lambdas** (6 functions: start-build → CodeBuild, check-build, run-query → Athena/Redshift, check-query, execute-bg-task → EventBridge, check-bg-task) | ~15h | Agent orchestration backbone non-functional |
| P0-03 | **Fix HTTPS/TLS on ChatStack ALB** (ACM certificate + HTTPS listener + HTTP→HTTPS redirect) | ~4h | Security requirement; all traffic returns 503 without this |
| P0-04 | **Implement PipelineStack canary deploy + rollback** (weighted ALB target groups for deployCanary; S3 metadata restore for rollback) | ~8h | CI/CD pipeline cannot safely deploy |
| P0-05 | **Fix failing tests** (82 failing + 20 errors — add missing deps: js-yaml, @aws-sdk/client-transcribe) | ~6h | Quality gate requires 100% green |
| P0-06 | **Add error handling to all Step Functions** (Catch + Retry blocks in 10 state machines: SkillPipeline, Orchestration ×3, Evolution ×4, TenantOnboarding, Pipeline) | ~10h | Silent cascade failures in production |
| P0-07 | **Deploy to staging** (cdk deploy --all --context environment=staging; verify all 11 stacks provision) | ~4h | Nothing is deployed yet |

### P1 — High Priority (first sprint post-deployment)

| ID | Item | Effort | Impact |
|----|------|--------|--------|
| P1-01 | **Complete Slack adapter** (OAuth 2.0 flow, Events API handler, interactive components) | ~12h | Core chat platform; requested in directive #27 |
| P1-02 | **Complete Discord / Teams / Telegram OAuth** | ~20h total | Multi-platform coverage |
| P1-03 | **Implement EvolutionStack generateSkill** (pattern-based SKILL.md synthesis) | ~8h | Self-evolution critical path |
| P1-04 | **Per-tenant cost attribution** (apply tenantId cost allocation tags to all resources; Cost Explorer pipeline) | ~10h | Cannot charge tenants without this |
| P1-05 | **CDK test coverage for remaining 7 stacks** (ApiStack, ChatStack, EvolutionStack, TenantOnboardingStack, PipelineStack, ObservabilityStack, SkillPipelineStack) | ~12h | 4/11 stacks currently tested |
| P1-06 | **Tenant tier change workflow** (upgrade/downgrade: update IAM role, Cedar policies, DynamoDB config) | ~8h | Flagged as missing feature in TenantOnboardingStack |
| P1-07 | **Tenant offboarding workflow** (cleanup IAM roles, Cognito groups, S3 prefixes, Cedar policies on delete) | ~6h | Orphaned resources accumulate without this |

### P2 — Medium Priority (second sprint)

| ID | Item | Effort | Impact |
|----|------|--------|--------|
| P2-01 | **Web Chat UI** (Vercel AI SDK useChat() hook + Next.js frontend; Cognito login flow) | ~20h | Directive #27: web UI preferred over Slack |
| P2-02 | **CLI binary compilation** (bun compile to single binary; GitHub Actions on tagged releases; auto release notes) | ~8h | Directive #17, #95; simpler distribution |
| P2-03 | **CloudFront CDN** (origin = ALB; cache GET responses 5min; bypass POST/mutations) | ~6h | 60-80% API cost reduction; referenced in ARCHITECTURE.md diagram |
| P2-04 | **DynamoDB VPC endpoint** (add to NetworkStack; stop routing DDB traffic through NAT) | ~2h | Cost/latency reduction |
| P2-05 | **MFA enforcement** (Cognito: mfa: Mfa.OPTIONAL + SMS backup recovery) | ~3h | Security best practice; currently absent |
| P2-06 | **Parameterize stack config** (extract 15+ hardcoded values to config/stack-config.ts; per-env CDK context) | ~6h | Prevents misconfiguration; 15+ hardcoded values identified |
| P2-07 | **Load testing** (1000+ concurrent WebSocket sessions; validate auto-scaling; confirm rate limiting under load) | ~8h | Phase 7 acceptance criterion |
| P2-08 | **OpenAI-compatible endpoint** (complete /v1/chat/completions with SSE chunking; currently returns 501) | ~8h | Enables OpenAI SDK compatibility |
| P2-09 | **Deployment dashboard** (CloudWatch: which version deployed, canary health, rollout progress) | ~4h | Operational visibility |
| P2-10 | **API Gateway execution logs** (enable for debugging authorization + throttling in non-prod) | ~1h | Currently only access logs; debugging blind spot |

### P3 — Low Priority / Post-launch

| ID | Item | Effort | Impact |
|----|------|--------|--------|
| P3-01 | **Group chat implementation** (or guidance doc for EventBridge/SQS fan-out pattern) | ~12h (impl) / ~3h (doc) | Directive #65 |
| P3-02 | **Upstream sync strategy** (CLI `chimera sync` command or agent-automatic rebase from tagged releases) | ~8h | Directive #65; open question |
| P3-03 | **Disaster recovery runbooks** (PITR backup validation; cross-region replication docs; RTO/RPO targets per component) | ~8h | Phase 7 gap |
| P3-04 | **Operational runbooks** (DDB throttling, cost anomaly, skill scan failure, onboarding failure, canary rollback) | ~8h | MTTR reduction; alarms already reference runbook URL pattern |
| P3-05 | **Skill authoring SDK** (@chimera/sdk-typescript) | ~16h | DX improvement |
| P3-06 | **Fargate Spot instances** (evaluate Fargate-Spot for ChatStack; ~50-70% cost reduction) | ~4h | Cost optimization |
| P3-07 | **DynamoDB reserved capacity** (analyze 1-week usage; purchase reservation for sessionsTable + costTrackingTable) | ~4h | Estimated $600-800/month savings |
| P3-08 | **ECR image signing** (cosign + verification in CodeBuild) | ~4h | Supply chain security |
| P3-09 | **OpenAPI specification** (generate from Hono routes; document all REST/WebSocket/SSE contracts) | ~8h | Integration enablement |
| P3-10 | **Migration guide from OpenClaw** (compatibility matrix, breaking changes, data migration steps) | ~10h | User adoption |
| P3-11 | **Admin dashboard** (tenant provisioning/monitoring/configuration UI) | ~20h | Operational convenience |
| P3-12 | **Performance benchmarks** (establish p50/p95/p99 targets; create baseline benchmark suite) | ~8h | SLA foundation |

---

## 4. Architecture Gaps

### 4.1 Implementation Gaps in Deployed Code

These are gaps between the architecture as documented and the code as written.

#### Skill Security Pipeline — All 7 Stages Placeholders
- **Spec:** 7-stage Step Functions pipeline (StaticAnalysis → DependencyAudit → SandboxRun → PermissionValidation → Signing → MonitoringConfig → ScanFailureNotification)
- **Reality:** Lambda definitions in `infra/lib/skill-pipeline-stack.ts` lines 44–217 contain no scanning logic. The Step Functions state machine at lines 228–334 lacks Catch blocks and DLQs.
- **Impact:** Skill marketplace cannot enforce security. Any skill can be installed without validation.
- **Fix:** Implement each Lambda (pylint/eslint for StaticAnalysis; OSV.dev query for DependencyAudit; isolated subprocess for SandboxRun; declared-vs-actual permission comparison for PermissionValidation; Ed25519 signing; anomaly profile generation; SNS notification).

#### Orchestration Backbone — All 6 Lambdas Placeholders
- **Spec:** Three Step Functions workflows (Pipeline Build, Data Analysis, Background Task) orchestrate CodeBuild, Athena, and EventBridge respectively.
- **Reality:** All 6 Lambdas in `infra/lib/orchestration-stack.ts` lines 305–451 have empty handlers. State machines at lines 459–601 have no error handling.
- **Impact:** Agent orchestration, background tasks, and multi-agent workflows are structurally defined but non-functional.

#### HTTPS/TLS — ChatStack Blocking Issue
- **Spec:** ALB should terminate TLS; HTTPS listener required.
- **Reality:** `infra/lib/chat-stack.ts` lines 249–270 define a placeholder HTTPS listener that returns 503. No ACM certificate is managed by the stack.
- **Impact:** No HTTPS traffic possible. All production web traffic fails.

### 4.2 Missing Infrastructure Components

| Component | Where Referenced | Gap |
|-----------|-----------------|-----|
| **CloudFront distribution** | ARCHITECTURE.md diagram, §1 | Diagram shows CF → WAF → ALB; CloudFront stack/construct does not exist |
| **DynamoDB VPC endpoint** | WELL_ARCHITECTED_ANALYSIS §1 NetworkStack | All DDB traffic routes through NAT gateway (latency + cost) |
| **WAF → CloudFront association** | Architecture design | WAF is created in SecurityStack but no CloudFront to associate with |
| **HTTPS certificate (ACM)** | ChatStack, ApiStack | No ACM resource in any stack; ChatStack and ApiStack both have placeholder listeners |
| **DLQ processing** | OrchestrationStack | DLQ exists for SQS but no Lambda to process dead-lettered messages |
| **EventBridge event encryption** | OrchestrationStack | Events traverse unencrypted through EventBridge bus |

### 4.3 Error Handling Absent Across State Machines

All 10 Step Functions state machines have zero error handling:

| Stack | State Machine | Missing |
|-------|---------------|---------|
| SkillPipelineStack | 7-stage scan pipeline | Catch, Retry, DLQ |
| OrchestrationStack | Pipeline Build | Catch, Retry |
| OrchestrationStack | Data Analysis | Catch, Retry |
| OrchestrationStack | Background Task | Catch, Retry |
| EvolutionStack | Prompt Evolution | Catch, Retry |
| EvolutionStack | Skill Generation | Catch, Retry |
| EvolutionStack | Memory Evolution | Catch, Retry |
| EvolutionStack | Feedback Processor | Catch, Retry |
| TenantOnboardingStack | Onboarding Workflow | Catch, Retry, compensation logic |
| PipelineStack | Canary Orchestration | Catch, Retry |

Without Catch blocks, any Lambda timeout, throttle, or permission error causes the entire workflow to fail silently. The TenantOnboardingStack is especially risky: a mid-pipeline failure leaves orphaned IAM roles, Cognito groups, and S3 prefixes.

### 4.4 Security Gaps

| Gap | Location | Severity |
|----|----------|---------|
| **No MFA enforcement** | SecurityStack Cognito (line 74) | High — missing `mfa: Mfa.OPTIONAL` |
| **Webhook routes unauthenticated** | ApiStack lines 220–242 | High — Slack/Discord/Teams/GitHub webhooks accept any POST |
| **S3 buckets use S3-managed encryption** | DataStack lines 204–277 | Medium — should use platform KMS key |
| **ECR images unsigned** | PipelineStack | Medium — no supply-chain verification |
| **Bedrock invoke permission too broad** | ChatStack lines 87–118 | Medium — `bedrock:InvokeModel` with no resource restriction |
| **No NACL rules** | NetworkStack | Low — only security groups; no defense-in-depth |
| **VPC Flow Logs 1-hour retention** | NetworkStack line 121 | Low — too short for forensics; increase to 7 days |

### 4.5 Cost Architecture Gaps

At 100k tenants, estimated $2,300–4,000/month without optimization. Key issues:

| Driver | Current | Better |
|--------|---------|--------|
| DynamoDB (6 tables, PAY_PER_REQUEST) | Unpredictable at scale | Provisioned + reserved capacity for predictable tables |
| NAT Gateways (2 prod) | $128/month + data charges | Add DynamoDB VPC endpoint; consider NAT instance for dev |
| API Gateway REST | $3.50/M requests | CloudFront caching reduces 60-80% of requests |
| ECS Fargate (standard) | ~$144/month baseline | Evaluate Fargate-Spot (50-70% savings) |
| X-Ray Insights | $5-10/month | Disable insights; use CloudWatch Logs Insights instead |
| **No cost attribution** | Pooled costs | Cannot charge tenants; add cost allocation tags |

---

## 5. Open Issues (Unresolved Decisions)

These questions were raised in session-40 and have not been resolved by any directive, ADR, or implementation:

### OI-01: CLI Standalone Binary — Can It Package the Agent?

- **Question:** Can the `chimera` CLI binary include all agent code, or does the target AWS account need to clone the repository first?
- **Context:** Directive #65 asked this; directive #17 requested bun compile to single binary.
- **Resolution needed:** If CLI can embed agent code, the binary upload path (batched CreateCommit) covers full deployment. If not, a separate repository seeding step is needed.
- **Recommendation:** CLI should embed a compressed snapshot of the `packages/agents/` directory as a static asset; decompress and upload during `chimera deploy`.

### OI-02: Upstream Sync — Automatic or CLI?

- **Question:** When the base Chimera platform releases a new version, how does a deployed instance receive updates? Should the agent handle it autonomously, or should the user run `chimera sync`?
- **Context:** Directive #65. The agent has CodeCommit access and CI/CD via CodePipeline.
- **Resolution needed:** Decision required before designing the sync module.
- **Recommendation:** Two modes — `chimera sync` for user-initiated upgrades (safe, controlled) + optional `--auto-sync` flag for agent-autonomous updates gated by a review Cedar policy.

### OI-03: Model Router Default Pool

- **Question:** What models should be in the default pool? How should tier-based restrictions interact with the auto-router?
- **Context:** Directive #56: "expandable model router; toggleable routing."
- **Current state:** model-router.ts is built but the default pool is not documented.
- **Recommendation:** Document defaults per tier in ADR-017 or a new config file:
  - Basic: `amazon.nova-lite-v1`, `anthropic.claude-haiku-4-5`
  - Pro: adds `anthropic.claude-sonnet-4-5`
  - Enterprise: adds `anthropic.claude-opus-4-6`

### OI-04: Skill Pipeline Stages 4–7 — Specification Missing

- **Question:** Stages 1–3 (StaticAnalysis, DependencyAudit, SandboxRun) have clear semantics. Stages 4–7 (PermissionValidation, Signing, MonitoringConfig, ScanFailureNotification) need detailed specs.
- **Context:** Directive #56: "Finish 4/7 skill pipeline stages."
- **Recommendation:** Write an ADR or implementation spec for each stage:
  - Stage 4 (PermissionValidation): Compare `SKILL.md permissions:` block against actual Lambda/tool invocations observed in SandboxRun.
  - Stage 5 (Signing): Ed25519 sign the skill artifact; store public key in DynamoDB chimera-skills table.
  - Stage 6 (MonitoringConfig): Generate CloudWatch anomaly detection profile for skill execution metrics.
  - Stage 7 (ScanFailureNotification): SNS publish to Critical topic; update DDB skill status to `REJECTED`.

### OI-05: Data Retention on Destroy — Format and Reseeding Flow

- **Question:** When `chimera destroy --retain-data` is run, what format is the archive? How does `chimera deploy --reseed` consume it?
- **Context:** Directive #56: "Destroy should have optional data retention/export/archive; deploy should have optional reseeding."
- **Current state:** `--retain-data` and `--export-path` flags exist in CLI but the implementation may be partial.
- **Recommendation:** Export format = JSON Lines (one DynamoDB item per line) for easy import via BatchWriteItem. Directory structure: `$export_path/{table_name}.jsonl`. The `--reseed` flag reads and replays these files on deploy.

### OI-06: CodeCommit Without pip — npm/bun Alternative

- **Question:** Is there an npm-installable or bun-installable alternative to the Python codecommit helper? Using pip for a single helper is inconsistent with the bun-first mandate.
- **Context:** Directive #41.
- **Recommendation:** Use `@aws-sdk/client-codecommit` directly from the TypeScript CLI (already done in `sync.ts` and `upgrade.ts`). Deprecate the Python codecommit helper. Document in CLAUDE.md.

### OI-07: Group Chat — Implementation or Guidance?

- **Question:** Should group chat (multiple users in one agent session) be implemented, or just a documented architecture guidance?
- **Context:** Directive #65.
- **Recommendation:** Document as architectural guidance first (EventBridge fan-out: one user message → event → N agent sessions respond). Defer full implementation until Web Chat UI (P2-01) is built, so it can be tested end-to-end.

---

## 6. Recommendations

### 6.1 Critical Path to Production (2 weeks)

```
Week 1: Unblock the application layer
  Day 1-2: Fix failing tests (P0-05) + HTTPS/TLS (P0-03)
  Day 3-4: Implement OrchestrationStack Lambdas (P0-02)
  Day 5: Deploy to staging (P0-07) + verify all 11 stacks

Week 2: Activate skill security + CI/CD safety
  Day 1-3: Implement SkillPipelineStack Lambdas (P0-01)
  Day 4: Implement Pipeline canary/rollback (P0-04)
  Day 5: Add error handling to all state machines (P0-06)
```

### 6.2 Operational Readiness (weeks 3–4)

1. **Cost attribution before any billing.** Apply `tenantId` cost allocation tags to all resources (P1-04) before onboarding paying tenants. Revenue cannot be tracked without this.
2. **Tenant lifecycle completeness.** Tier change workflow (P1-06) and offboarding (P1-07) must exist before any user can subscribe and cancel. Orphaned resources are a compliance and cost risk.
3. **Chat adapters for user acquisition.** Complete Slack first (P1-01) — it has the broadest enterprise reach and was listed as priority in directive #27. Discord/Teams/Telegram follow.

### 6.3 Architecture Decisions Needed

The following decisions should be captured as ADRs before implementing:

| Decision | Related OI |
|----------|-----------|
| CLI binary embedding strategy (OI-01) | P3-02 |
| Upstream sync architecture (OI-02) | P3-02 |
| Model pool defaults per tier (OI-03) | Amend ADR-017 |
| Skill pipeline stages 4–7 specification (OI-04) | P0-01 |
| Destroy/reseed data format (OI-05) | Already partially implemented |
| Group chat architecture (OI-07) | P3-01 |
| CloudFront vs direct ALB routing | P2-03 |
| Fargate vs Fargate-Spot decision | P3-06 |

### 6.4 Test Strategy

Current state: 860/962 passing (89%). Target: 100% passing + 80% CDK stack coverage.

**Immediate (P0-05):** Add missing npm packages (`js-yaml`, `@aws-sdk/client-transcribe`) to fix 102 failures.

**Near-term (P1-05):** Add CDK tests for 7 untested stacks. Follow pattern in `infra/test/network-stack.test.ts`. Priority order: ApiStack → ChatStack → TenantOnboardingStack → EvolutionStack → PipelineStack → ObservabilityStack → SkillPipelineStack (last, since Lambdas are currently placeholders).

### 6.5 Documentation Gaps to Close

| Document | Priority | Notes |
|----------|----------|-------|
| Operational runbooks | P3-04 | Alarms already reference runbook URL pattern; runbooks just need to be written |
| OpenAPI specification | P3-09 | Generate from Hono route definitions |
| Migration guide (from OpenClaw) | P3-10 | 92% compatibility claimed in research; compatibility matrix needed |
| DR runbooks | P3-03 | PITR is enabled; restore procedures undocumented |
| ADRs for OI-01 through OI-07 | Medium | Capture resolved open questions as formal decisions |

---

## Appendix A: Codebase Metrics (2026-03-22 Audit)

| Metric | Value |
|--------|-------|
| Packages | 6 (core, agents, shared, sse-bridge, chat-gateway, cli) |
| CDK Stacks | 11 (5,800+ LOC) |
| TypeScript LOC | ~48,300 (packages/core/src/) |
| Python Agent Runtime | 317 LOC (chimera_agent.py) + ~1,648 total Python |
| AWS Tools | 25 (19 TypeScript + 6 Python) |
| Core Modules | 21 |
| Test Files | 64 |
| Tests Total | 962 (860 pass, 82 fail, 20 errors) |
| Test Assertions | 2,134 expect() calls |
| Research Docs | 123 docs, 118,000+ lines |
| ADRs | 18 |

## Appendix B: Well-Architected Scorecard

| Pillar | Score | Primary Gaps |
|--------|-------|-------------|
| Security | 4.1 / 5.0 | No MFA; unauthenticated webhooks; no image signing |
| Reliability | 3.5 / 5.0 | No error handling on state machines; 60% placeholder Lambdas |
| Performance Efficiency | 3.5 / 5.0 | No CloudFront; no DAX; no request batching on SQS |
| Cost Optimization | 2.8 / 5.0 | PAY_PER_REQUEST on all 6 DDB tables; no CloudFront; no reserved capacity; no tenant attribution |
| Operational Excellence | 3.5 / 5.0 | No runbooks; 7/11 stacks untested; no deployment dashboard |
| Sustainability | 3.6 / 5.0 | No resource right-sizing; no auto-shutdown for non-prod |
| **Overall** | **3.6 / 5.0** | |

*Source: docs/analysis/WELL_ARCHITECTED_ANALYSIS.md (2026-03-23)*

---

*Generated: 2026-03-25 | Sources: session-40 directives (89 directives), ROADMAP.md, ARCHITECTURE.md, WELL_ARCHITECTED_ANALYSIS.md, enhancement/00-Gap-Analysis-Report.md*
