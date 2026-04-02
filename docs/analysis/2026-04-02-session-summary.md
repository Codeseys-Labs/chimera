---
title: "Session Summary — 2026-03-26 to 2026-04-02"
version: 1.0.0
status: canonical
last_updated: 2026-04-02
supersedes: []
---

# Chimera Session Summary — 2026-03-26 to 2026-04-02

> **Seven days of focused development.** This document summarises all substantive work completed across 8 calendar days (March 26 – April 2), the current production state, known issues awaiting deployment, and the knowledge captured in mulch.

---

## Overview

| Metric | 2026-03-26 Baseline | 2026-04-02 Current | Delta |
|--------|--------------------|--------------------|-------|
| CDK Stacks | 12 | 15 | +3 |
| ADRs | 23 | 30 | +7 |
| CLI Commands | 10 | 16 | +6 |
| Packages | 6 | 7 | +1 (web) |
| Tests total | ~860 pass / ~82 fail | 2206 pass / 38 fail | ↑ tests, ↓ fail rate |
| TODO clusters resolved | — | 6 major stubs wired | — |

---

## Day-by-Day Work Log

### Day 1 — 2026-03-26: Frontend, L3 Constructs, ADRs, CLI Migration

**Key deliverables:**
- `packages/web` scaffolded — React + Vite + shadcn/ui frontend (ADR-027)
- L3 CDK construct library: `ChimeraTable`, `ChimeraBucket`, `ChimeraLambda`, `ChimeraQueue`
- CDK Aspects library for cross-cutting compliance (CDK Nag, ADR-025)
- `FrontendStack` added (S3 + CloudFront + OAC)
- 7 new ADRs (024–030): tier naming, CDK Nag, L3 constructs, React frontend, Amplify auth, Bun builtins, unified `chimera.toml`
- CLI modernisation: `chalk → @std/ansi`, `jest → bun:test`, `api-client` library, `--json` flag
- CDK synth verified for all 13 stacks at that time
- Tier naming standardised: `enterprise → premium`, removed `dedicated` tier
- 2026-03-26 project snapshot document created

**Builder tasks completed:** `chimera-ae82` (pipeline fix), multiple stream builders

---

### Day 2 — 2026-03-27: Gateway Phase 2, Evolution Tools, Upgrade Command

**Key deliverables:**
- `packages/agents`: `evolution_tools.py` — 5 self-evolution tools for Python agent
- `SelfEvolutionOrchestrator` — end-to-end generate→commit→deploy→register flow
- `GatewayRegistrationStack` added — 14th stack
- Gateway Phase 2: runtime tool discovery via AgentCore Gateway API
- `packages/agents/chimera_agent.py` migrated to gateway-based tool discovery
- CLI `upgrade` command modernised with Bun builtins, dry-run, rollback
- `infra/docs/deployment-architecture.md` added
- Lint and typecheck issues resolved across expanded scope

---

### Day 3 — 2026-03-28: Auth Deep Work, JWT Middleware, Cognito Fixes

**Key deliverables:**
- `chimera login`: Terminal vs Browser auth mode selection prompt
- `chimera login --browser`: opens deployed frontend URL for Cognito callback
- MFA challenge handling in CLI login flow
- Cognito WebClient updated: `USER_PASSWORD_AUTH` added to allowed auth flows
- JWT middleware wired to chat routes (was unprotected)
- `custom:tenant_id` fallback to `sub` when claim absent
- Required MFA disabled (was blocking login)
- 5 CLI bug fixes: chat auth debug, AWS profile detection, doctor region, health endpoint, `--region` flag
- Credentials format unified across `doctor` and `api-client` (TOML format)
- Chat-gateway Docker base image switched to ECR Public (avoid Docker Hub rate limits)

---

### Day 4 — 2026-03-29: S3 KMS Migration, Bedrock IAM, CLI Internals

**Key deliverables:**
- `ChimeraBucket` L3 construct: all S3 buckets migrated to customer-managed KMS
- Bedrock IAM scoped: removed overly broad `bedrock:*` permissions
- Unused `mocks` module removed from core
- AWS SDK clients moved from `peerDependencies` to `dependencies` (fixes Bun compile)
- `findProjectRoot()` extracted to `utils/project.ts`, `config.ts` deleted
- CLI metrics updated to reflect 15 CDK stacks

---

### Day 5 — 2026-03-30: Architecture Diagrams, CLI Blitz, DiscoveryStack

**Key deliverables (high-output day):**
- 9 Mermaid architecture diagrams: CDK stacks, request flow, auth, self-evolution, multi-tenant, skill lifecycle, deploy pipeline, session state, CLI lifecycle
- `monitor` CLI command: watches `chimera-deploy-${env}` CodePipeline execution stages
- `doctor`: expanded from 5 to all 11 stack checks; added TOML schema + toolchain checks
- `deploy --monitor`: zero-touch post-deploy pipeline monitoring
- `destroy`: all 15 stacks + DDB deletion protection bypass + S3 bucket emptying
- Help grouping and shell completions (`bash`/`zsh`/`fish`)
- `DiscoveryStack` added (15th stack): Cloud Map HTTP namespace for agent self-awareness
- Cloud Map discovery tools for agent self-awareness (5 tools)
- Infrastructure self-discovery guide added
- CodePipeline resource name corrected in `monitor` and `status` commands
- `--json`, `--region`, `--message` flags + skill uninstall fix + examples across commands
- CLI verbose flag, compiled version display, exit codes hardened
- Error UX hardened across `session`/`skill`/`tenant`/`api-client`
- Hardcoded `us-east-1` fallback removed from 6 CLI commands

---

### Day 6 — 2026-03-31: Chat SSE Fix, Browser Login, Pipeline Test Stage

**Key deliverables:**
- **Chat SSE socket-close fix**: deprecated Bedrock model ID (`claude-3-5-sonnet-20241022-v2:0`) replaced with inference profile; DSP parser updated to map `messageStart`/`contentBlockDelta`/`messageStop` events
- Browser login redesigned: `chimera login --browser` opens deployed frontend URL (not embedded HTML)
- `packages/web/src/login.tsx` rewritten: full Amplify v6 auth flow with `?callback=` query param support
- Pipeline `Test` stage fixed: changed from `buildOutput` to `sourceOutput` (was failing)
- Buildspec test phase updated: installs Bun, fetches `frontend_url` from SSM
- `buildspec.yml`: `source ~/.bun/env` added at start of each phase needing Bun

---

### Day 7 — 2026-04-01: Major Integration Sprint (14 builder tasks)

**Key deliverables:**

**Review & Documentation:**
- Full project review report (2026-04-01): 15 stacks, 16 CLI commands, 30 ADRs, test health analysis
- Vision gap analysis doc added

**Core Wiring (previously stub-only):**
- `agentcore-runtime.ts`: 4 new methods — `invokeAgent`, `getSessionHistory`, `deleteSession`, `updateMemory`
- `orchestrator.ts`: SQS/DDB/EventBridge stubs wired with proper injectable interfaces
- `hitl-gateway.ts`: DynamoDB persistence for HITL approval gateway (33 tests)
- Skill providers: MCP, instruction, hybrid stubs implemented
- API Lambda integrations wired for management API endpoints
- `chimera init`: Bedrock model selection wizard (inference profile prompts)

**Infrastructure Fixes:**
- `addPlaceholderMethod` → `addApiMethod` in ApiStack (was causing CDK synth failure)
- `evolution.ts` TDZ errors fixed: `ModelRouter`/`PromptOptimizer` lazy DDB init
- Canary bake duration environment-aware: dev=2min, staging=5min, prod=10min
- Frontend React build added to CI pipeline (was not being built/deployed)
- `ChatStack` ECS task: `AWS_ACCOUNT_ID` + `BEDROCK_MODEL_ID` env vars added
- `web/tsconfig.json`: `src/__tests__` excluded from production build (was breaking CodeBuild)

**Test Fixes:**
- E2E tests gated behind `RUN_E2E=1` env var
- 30 test failures fixed across 4 clusters
- Python rollout script: `boto3.client('elbv2')` not `'elasticloadbalancingv2'`
- `tests/package.json`: integration/e2e/load/helpers script paths corrected

**Builder tasks completed:** 14 tasks including chimera-e5bb, chimera-cc6f, chimera-0659, chimera-7d17, chimera-4586, chimera-3edb, chimera-55d7, chimera-8df8, chimera-5068, chimera-bb05, chimera-3a32, chimera-fc28, chimera-631f, chimera-1bd5, chimera-38a2, chimera-f5a4, chimera-da3e, chimera-8e75

---

### Day 8 — 2026-04-02: OAC Policy + Bedrock Model ID Final Fix

**Key deliverables:**
- `FrontendStack`: added explicit OAC bucket policy for SSE-KMS buckets (S3BucketOrigin.withOriginAccessControl requires explicit `s3:GetObject` grant)
- `ChatStack` / `infra` config: Bedrock model ID corrected to cross-region inference profile `us.anthropic.claude-sonnet-4-6-20251101-v1:0`
- Both fixes committed; **pending CDK deploy** to take effect

---

## Knowledge Captured (Mulch Records — this sprint)

All records are in `.mulch/` and tagged with their completing builder agent:

| Domain | Record ID | Summary |
|--------|-----------|---------|
| infrastructure | mx-b8e992 | CodeBuild multi-phase bun PATH: `source ~/.bun/env` at start of each phase |
| infrastructure | mx-a4f4dc | ApiStack: use `addApiMethod` not `addPlaceholderMethod` |
| infrastructure | mx-20b7a5 | CloudFront OAC + SSE-KMS: explicit S3 bucket policy required |
| development | mx-aee578 | `chimera status` always fetches + shows CodePipeline execution |
| development | mx-afa716 | CodePipeline resource is `chimera-deploy-${env}` (lowercase, hyphenated) |
| development | mx-3ddc14 | Bun binary asset embedding: use `Bun.file(new URL('./asset', import.meta.url))` |
| development | mx-d0f1f0 | chat-gateway expects OpenAI-compatible message format |
| development | mx-9baffb | Bun binary HTML static import: `import html from './foo.html' with {type:'text'}` |
| development | mx-3de083 | Chat SSE parsers must map messageStart/contentBlockDelta/messageStop |
| development | mx-096caa | Default BEDROCK_MODEL_ID must be an inference profile |
| development | mx-e1b18c | Amplify v6: `signIn()` returns `{ isSignedIn, nextStep.signInStep }` |
| development | mx-0a08c6 | Web login reads `?callback=` query param |
| development | mx-26c8ba | `chimera login --browser` uses deployed frontend URL |
| development | mx-7b583d | Pipeline Test stage must use `sourceOutput` not `buildOutput` |
| development | mx-f942aa | bun test default timeout 5s too short for CDK PipelineStack |
| development | mx-a6aac7 | Project audit 2026-04-01: 15 stacks, 16 CLI commands, 30 ADRs, 2146/2186 tests |
| development | mx-da4224 | chat-gateway uses lazy singleton GatewayToolDiscovery |
| development | mx-6c887d | DEFAULT_SYSTEM_PROMPT in packages/core/src/agent/prompt.ts |
| development | mx-468792 | E2E/integration tests must check `process.env.RUN_E2E` |
| development | mx-5aa0ae | AgentCoreRuntime 6-method API |
| development | mx-fd2f10 | `chimera init` prompts for Bedrock model (inference profile) |
| development | mx-94e2bf | chat-gateway BedrockConfig includes promptCaching field |
| development | mx-784b70 | AgentOrchestrator injectable SQS/DDB/EventBridge interfaces |
| development | mx-d239c6 | DynamoDB: `status` field requires ExpressionAttributeNames |
| development | mx-9fbabf | SQS queue creation requires two calls (CreateQueue + SetQueueAttributes for DLQ) |
| development | mx-217a75 | SkillProvider vs ToolProvider are separate interfaces |
| development | mx-9803a4 | ApiStack: optional tenantsTable/sessionsTable/skillsTable for Lambda integrations |
| development | mx-a480b1 | All management API Lambdas validate JWT `custom:tenantId` claim |
| development | mx-352d37 | HITLGateway uses narrow HITLDDBClient injectable interface |
| development | mx-282409 | Module-level AWS SDK singletons avoid TDZ errors |
| development | mx-7f399d | Code Defender git hooks break test isolation; use `GIT_CONFIG_NOSYSTEM=1` |
| development | mx-5370ae | E2E tests use `describe.if(process.env.RUN_E2E === '1')` |
| development | mx-0db231 | CodeBuild: `export PATH=$HOME/.bun/bin:$PATH` per phase |
| development | mx-01000a | Python Lambda: `boto3.client('elbv2')` not `'elasticloadbalancingv2'` |
| development | mx-9b8404 | `tests/package.json` paths must be relative to tests/ dir |
| development | mx-296700 | Canary bake: dev=2min, staging=5min, prod=10min |
| development | mx-751371 | FrontendStack requires separate pipeline action for S3 sync |
| development | mx-d3f8f5 | ChatStack ECS must include `AWS_ACCOUNT_ID` env var |
| development | mx-28e937 | `packages/web/tsconfig.json` must exclude `src/__tests__` |
| development | mx-3f2165 | Correct Sonnet 4.6 inference profile ID: `us.anthropic.claude-sonnet-4-6-20251101-v1:0` |

---

## Current Production State

**Status: Code complete for core platform. First CDK deploy pending.**

No stack has been deployed to a live AWS environment. All code changes are committed to `main`. The pipeline infrastructure exists and will trigger on next `cdk deploy`.

### What's Ready to Deploy

All 15 CDK stacks synthesise cleanly. Deploy order:
```
NetworkStack → DataStack → SecurityStack → ObservabilityStack
  → APIStack → ChatStack → OrchestrationStack → EvolutionStack
  → TenantOnboardingStack → PipelineStack → SkillPipelineStack
  → EmailStack → DiscoveryStack → FrontendStack → GatewayRegistrationStack
```

### Known Issues Blocking Full Production

See `docs/runbooks/resumption-guide.md` for exact steps.

| Issue | Root Cause | Fix Status | Action Needed |
|-------|-----------|------------|---------------|
| Frontend AccessDenied (403) | OAC bucket policy missing for SSE-KMS | Fixed in code (c3c6585) | `cdk deploy FrontendStack` + CloudFront invalidation |
| Chat socket closes immediately | Bedrock model ID invalid + DSP parser mismatch | Fixed in code (c3c6585, 90018d4) | `cdk deploy ChatStack` → ECS rolls out new task def |
| Bedrock model ID in ECS stale | ECS task def still has old model ID | Fixed in code | ECS rollout via `cdk deploy ChatStack` |
| S3 OAC policy missing | SSE-KMS buckets need explicit `s3:GetObject` grant | Fixed in code | `cdk deploy DataStack FrontendStack` |

---

## Open Seeds Issues

| ID | Title | Priority |
|----|-------|---------|
| chimera-0092 | Verify chimera chat works end-to-end with system prompt + tools | High |
| chimera-2087 | Create CLI E2E integration test scripts | Medium |
| chimera-b7af | Remove strands-agents.ts shim when package published | Medium |
| chimera-76b9 | Implement LLM-based task decomposer | Low |
| chimera-2b2a | FUTURE: EventBridge scheduled recurring agent tasks | Low |
| chimera-59ee | FUTURE: Webhook delivery for task lifecycle events | Low |
| chimera-606c | FUTURE: DGM evolution integration | Backlog |
| chimera-982e | No NACL rules in network infrastructure | Backlog |
