---
title: "Vision Gap Analysis: Does Chimera Match the Vision?"
version: 1.0.0
status: canonical
last_updated: 2026-04-01
author: builder-vision-doc
supersedes: []
related:
  - docs/analysis/chimera-feature-gap-analysis.md
  - docs/analysis/2026-04-01-review.md
  - docs/VISION.md
  - docs/ROADMAP.md
---

# Vision Gap Analysis: Does Chimera Match the Vision?

> **Purpose:** For each claim in VISION.md, assess whether it is *implemented*, *partial*, or *missing* as of 2026-04-01. Compare against OpenClaw/NemoClaw/OpenFang. Identify the critical path to a self-evolving agent that can autonomously build AWS infrastructure.
>
> **Methodology:** Codebase audit (150+ source files), test run (2,242 tests), and cross-reference against VISION.md, ROADMAP.md, and existing analysis docs. Ratings are conservative: "implemented" means code exists *and* is testable; "partial" means modules exist but TODOs remain or the integration is untested end-to-end; "missing" means no functional code exists.
>
> **As-of state:** 2026-04-01 | Tests: 2,157 pass / 75 fail / 6 error / 10 skip across 2,242 total

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Vision Claim Assessment](#2-vision-claim-assessment)
3. [OpenClaw / NemoClaw / OpenFang Comparison](#3-openclaw--nemoclaw--openfang-comparison)
4. [Critical Path to Self-Evolving Infrastructure Agent](#4-critical-path-to-self-evolving-infrastructure-agent)
5. [Undocumented Progress (since ROADMAP)](#5-undocumented-progress-since-roadmap)
6. [Verdict and Prioritized Recommendations](#6-verdict-and-prioritized-recommendations)

---

## 1. Executive Summary

Chimera's **module-level completeness** substantially matches the vision. All major subsystems exist: Python agent runtime with real Strands + AgentCore SDK imports, 15 CDK stacks, 40 AWS tools, 7 skill modules, 5 swarm modules, 8 evolution modules, 6 tenant modules. The **deployment gap** is the defining distance from vision: no stack has been deployed, no end-to-end agent session has been tested against live AWS infrastructure, and the TypeScript AgentCore integration layer is a stub with `// TODO` placeholders.

VISION.md's "Platform 85% complete" claim is accurate at the *module* level. It overstates completeness at the *operational* level by approximately 40 percentage points — the remaining work is not cosmetic polish but the integration, deployment, and end-to-end validation that converts modules into a running platform.

| Dimension | Vision Claim | Actual Status |
|-----------|-------------|---------------|
| Agent Runtime | Strands + AgentCore MicroVM | ✅ Python: real SDK imports, well-structured. TS runtime: stub returning mocks |
| Multi-tenant Data | 6-table DDB + tenant isolation | ✅ Fully implemented, tested, 24 cross-tenant isolation tests passing |
| AWS Tools | 25 tools across 4 tiers | ✅ 40 tools (19 TS + 21 Python) — exceeds vision |
| Self-evolution | Agents auto-generate skills | 🟡 Modules built, not deployed/activated in production |
| Infrastructure-as-Capability | CDK generation → CodeCommit → CodePipeline | 🟡 End-to-end chain exists in code, not validated against live AWS |
| Chat Gateway | Multi-platform (Slack, Discord, Teams, Web) | 🟡 Hono server framework ready; adapters are stubs; not deployed to ECS |
| AgentCore Memory | STM + LTM with tenant namespaces | 🟡 Python side real; TS side stub; not end-to-end tested |
| Task Decomposer | LLM-driven multi-agent swarm | 🟡 Rule-based decomposition; `// TODO: use LLM` in 3 places |
| AgentCore Evaluations | 13 built-in evaluators | ❌ No code found in codebase |
| Production Deployment | Functional platform | ❌ No stack deployed to any environment |

---

## 2. Vision Claim Assessment

### 2.1 Identity & Core Differentiator

**Claim:** "AWS-native rebuild of OpenClaw where agents operate AWS accounts instead of local computers."

| Sub-claim | Status | Evidence |
|-----------|--------|---------|
| Agents query AWS Config, invoke Lambda, modify DynamoDB | 🟡 **Partial** | 40 tools exist and are testable in isolation; no deployed agent has invoked live AWS APIs |
| Agents generate CDK, commit to CodeCommit, deploy via CodePipeline | 🟡 **Partial** | `infra-builder/cdk-generator.ts`, `codecommit-workspace.ts`, `codepipeline-deployer.ts` exist and are unit-tested with mocks; end-to-end not validated |
| Multi-tenant from day one | ✅ **Implemented** | `chimera-tenants` DDB table with per-tenant KMS, Cedar policies, 24 cross-tenant isolation tests, tenant-router JWT extraction |
| Cedar policies, audit trails | ✅ **Implemented** | `cedar-authorization.ts` with 31 tests; `chimera-audit` table in DataStack |
| AgentCore + Strands runtime | 🟡 **Partial** | Python `chimera_agent.py` uses real `bedrock_agentcore.runtime` and `strands` imports; TypeScript `agentcore-runtime.ts` returns mock sessions with `// TODO: Integrate with actual AgentCore Runtime API` |

**Assessment:** The core paradigm shift — AWS account access instead of local computer access — exists in code and is structurally sound. The agent runtime Python side is production-quality; the deployment hasn't happened.

---

### 2.2 Architecture: AgentCore + Strands

**Claim:** "Built on AWS Bedrock AgentCore (managed agent runtime) with Strands Agents framework."

| Sub-claim | Status | Evidence |
|-----------|--------|---------|
| `BedrockAgentCoreApp` + `@entrypoint` handler | ✅ **Implemented** | `packages/agents/chimera_agent.py` lines 22 and 25 |
| Strands ReAct loop with streaming | ✅ **Implemented** | `Agent.stream()` in `chimera_agent.py` line 68 |
| AgentCore Memory with tenant-scoped namespaces | ✅ **Implemented** | `AgentCoreMemorySessionManager` wired with `tenant-{id}-user-{id}` namespace pattern |
| MicroVM session isolation | 🟡 **Partial** | CDK `GatewayRegistrationStack` defines AgentCore gateway config; AgentCore Runtime is AWS-managed — we can't test this without deploying |
| 9 AgentCore services (Runtime, Memory, Gateway, Identity, Policy, Code Interpreter, Browser, Observability, Evaluations) | 🟡 **Partial** | Memory and Gateway are wired; Code Interpreter and Browser not referenced in code; Evaluations absent |
| Deployment model: Docker → ECR → AgentCore Runtime | 🟡 **Partial** | `packages/agents/Dockerfile` exists; CDK `PipelineStack` and `GatewayRegistrationStack` define the deployment; not yet executed |

**Critical gap:** The TypeScript `AgentCoreRuntime` class (370 LOC) is a type-safe interface with mock implementations throughout. Lines 141-143 confirm: `// TODO: Integrate with actual AgentCore Runtime API / For now, return a mock session`. This is not blocking the Python runtime path but represents a missing second runtime integration layer.

---

### 2.3 Multi-Tenant UTO Model

**Claim:** "Single Chimera installation serves multiple tenants with proper isolation."

| Sub-claim | Status | Evidence |
|-----------|--------|---------|
| DynamoDB with tenantId partition key + GSI FilterExpressions | ✅ **Implemented** | DataStack 6-table schema; GSI cross-tenant leakage prevention pattern recorded in mulch |
| Per-tenant KMS customer managed keys | ✅ **Implemented** | `TenantOnboardingStack` CDK (694 LOC) |
| Cedar policies for fine-grained authorization | ✅ **Implemented** | `cedar-authorization.ts` with 31 passing tests |
| IAM boundaries per tenant | ✅ **Implemented** | `TenantOnboardingStack` per-tenant IAM roles |
| 3 tiers: Basic / Advanced / Premium | ✅ **Implemented** | `chimera_agent.py` `select_model_for_tier()`, `get_memory_config_for_tier()` |
| Concurrent sessions (Basic: 2, Advanced: 10, Premium: 100) | 🟡 **Partial** | Rate limiter and quota manager exist; concurrent session enforcement needs live testing |
| Collaborative sessions via shared DynamoDB state | 🟡 **Partial** | DynamoDB state model supports it; no integration test validates concurrent collaborative sessions |
| Automated tenant onboarding via Step Function | ✅ **Implemented** | `TenantOnboardingStack` with Step Functions orchestration |

**Assessment:** Multi-tenancy is the strongest part of the implementation. The data model, isolation mechanisms, and enforcement code are all present and tested.

---

### 2.4 Skill System Compatibility

**Claim:** "Supports 3 skill formats: SKILL.md, MCP Servers, Strands @tool."

| Sub-claim | Status | Evidence |
|-----------|--------|---------|
| SKILL.md v2 parser and validator | ✅ **Implemented** | `packages/core/src/skills/parser.ts`, `validator.ts`; ADR-018 |
| MCP Gateway Client | ✅ **Implemented** | `packages/core/src/skills/mcp-gateway-client.ts` (though has stub paths for error cases) |
| 5-tier trust model (Platform, Verified, Community, Private, Experimental) | ✅ **Implemented** | `trust-engine.ts` with 50+ tests |
| 7-stage security pipeline | ✅ **Implemented** | `SkillPipelineStack` CDK (352 LOC); `packages/core/src/skills/scanners/` |
| Skill registry (DynamoDB) | ✅ **Implemented** | `packages/core/src/skills/registry.ts` |
| Skill authoring SDK | ❌ **Missing** | Noted in ROADMAP as "not blocking" |
| Security pipeline activated/deployed | ❌ **Missing** | Stack exists; not deployed |

**Assessment:** Skill ecosystem is production-quality at the module level. The pipeline is architecturally sound. The skill authoring SDK is the one genuine missing piece for third-party developers.

---

### 2.5 Self-Evolution

**Claim:** "Agents create their own skills, tools, and subagents."

| Sub-claim | Status | Evidence |
|-----------|--------|---------|
| Auto-skill generation (pattern detection → SKILL.md synthesis) | ✅ **Implemented** | `packages/core/src/evolution/auto-skill-gen.ts`; tests in `__tests__/auto-skill-gen.test.ts` |
| Evolution Safety Harness | ✅ **Implemented** | `safety-harness.ts` with rate limits (skill_creation: 5/hr, policy_changes: 2/day) and approval gates |
| Cedar policy constraints on evolution | ✅ **Implemented** | Cedar forbid rules in `cedar-authorization.ts` |
| Canary deployments (5% → 25% → 100%) | 🟡 **Partial** | `EvolutionStack` CDK (577 LOC) includes canary infrastructure; canary routing logic not found in active code paths |
| A/B test metric collection | 🟡 **Partial** | `experiment-runner.ts` and `prompt-optimizer.ts` implement the framework; live traffic collection needs deployment |
| IaC modifier: DynamoDB-driven CDK synthesis | ✅ **Implemented** | `iac-modifier.ts`; `self-modifying-iac-dynamodb-cdk` mulch convention recorded |
| Model router: latency/cost/quality tradeoff | ✅ **Implemented** | `model-router.ts`; 6 tests (currently failing — DynamoDB unavailable in test env) |
| Post-mortem template and self-reflection | ✅ **Implemented** | `self-reflection.ts`; `self-reflection` type included in evolution module exports |
| Evolution pipeline deployment | ❌ **Missing** | Modules exist; activation requires CDK deploy |

**Critical gap:** The task decomposer (`swarm/task-decomposer.ts`) has `// TODO: In production, use LLM to generate multiple decomposition paths` in 3 separate methods. The current decomposer is rule-based. This means the "Multi-Agent Swarm Coordination" described in VISION.md is not yet LLM-driven.

---

### 2.6 Infrastructure as Capability

**Claim:** "Agents generate CDK, commit to CodeCommit, deploy via CodePipeline — fully autonomous infrastructure lifecycle."

| Sub-claim | Status | Evidence |
|-----------|--------|---------|
| CDK code generator (template + LLM-assisted) | ✅ **Implemented** | `cdk-generator.ts` with both generation paths; 42 tests |
| CodeCommit workspace (commit generated CDK) | ✅ **Implemented** | `codecommit-workspace.ts` with DLQ circuit breakers |
| CodePipeline deployer (trigger pipeline, monitor execution) | ✅ **Implemented** | `codepipeline-deployer.ts` with stage monitoring |
| Drift detector | ✅ **Implemented** | `drift-detector.ts` in infra-builder module |
| Cedar provisioning (generate Cedar policies for new infra) | ✅ **Implemented** | `cedar-provisioning.ts` |
| Well-Architected review (6-pillar analysis) | ✅ **Implemented** | `well-architected/` module with 38 tests |
| Infrastructure agents can build (data lakes, CI/CD, etc.) | 🟡 **Partial** | CDK templates exist for common patterns; LLM-assisted path for novel infra not validated against real Bedrock model |
| End-to-end validated: agent → CDK → CodeCommit → pipeline → deployed stack | ❌ **Not validated** | No E2E test exercises this path against live AWS |

**Assessment:** The self-modifying IaC chain is the vision's most sophisticated claim and the most structurally complete. Every link in the chain exists. The chain has never run end-to-end against real AWS.

---

### 2.7 Multi-Modal Support

**Claim:** "Chimera handles video, audio, images, and documents without explicit instruction."

| Sub-claim | Status | Evidence |
|-----------|--------|---------|
| Bedrock Vision (image understanding) | ✅ **Implemented** | `packages/core/src/media/media-processor.ts`; Bedrock tool in TypeScript tools |
| Amazon Transcribe (audio → text) | ✅ **Implemented** | Transcribe tool in both TypeScript and Python; 21 Python tools list includes transcribe |
| Amazon Rekognition (image/video analysis) | ✅ **Implemented** | Rekognition tool in TypeScript and Python tools |
| Amazon Textract (document extraction) | ✅ **Implemented** | Textract tool in TypeScript and Python tools |
| AgentCore Browser (Playwright) | ❌ **Missing** | VISION.md claims this; no Playwright or Browser integration found in codebase |
| Auto-detection and routing (no explicit "analyze this") | ✅ **Implemented** | `media-processor.ts` handles auto-detection and routing |

**Assessment:** Multi-modal support is mostly implemented. The AgentCore Browser (Playwright) integration is absent from the codebase despite the vision claiming it.

---

### 2.8 Self-Reflection & Continuous Improvement

**Claim:** "Agents run post-mortem analysis after every task to improve future performance."

| Sub-claim | Status | Evidence |
|-----------|--------|---------|
| Post-mortem template | ✅ **Implemented** | `self-reflection.ts` in evolution module |
| Pattern extraction (3+ similar tasks → auto-generate skill) | ✅ **Implemented** | `auto-skill-gen.ts` with pattern counter logic |
| AgentCore Memory LTM USER_PREFERENCE storage | ✅ **Implemented** | Memory config in `chimera_agent.py` `get_memory_config_for_tier()` |
| AgentCore Evaluations (13 built-in evaluators) | ❌ **Missing** | Vision claims 13 evaluators (accuracy, helpfulness, safety, latency, cost, etc.); no AgentCore Evaluations integration found anywhere in codebase |

**Critical gap:** The 13-evaluator claim is prominent in VISION.md but has zero code backing. This is the most significant overstatement in the vision document.

---

### 2.9 Concurrent Execution

**Claim:** "UTO interacts while background tasks run in parallel."

| Sub-claim | Status | Evidence |
|-----------|--------|---------|
| Background task management | ✅ **Implemented** | `packages/core/src/orchestration/background-task.ts`; `packages/agents/tools/background_task_tools.py` |
| DynamoDB-backed task state | ✅ **Implemented** | Task state model in orchestration module |
| Multi-agent swarm coordination | 🟡 **Partial** | `swarm/` module exists with 5 components; task decomposer is rule-based (LLM decomposition is TODO) |
| Non-blocking streaming responses | ✅ **Implemented** | `sse-bridge` package (26 tests, ship-ready); Hono SSE in chat-gateway |

---

## 3. OpenClaw / NemoClaw / OpenFang Comparison

### 3.1 Chimera vs OpenClaw (Anthropic, ~209k GitHub stars)

| Dimension | OpenClaw | Chimera | Winner |
|-----------|---------|---------|--------|
| **Multi-tenancy** | None — single-user design | ✅ Full UTO model with DDB isolation, KMS, Cedar | **Chimera** |
| **Infrastructure access** | Local filesystem + shell | 40 AWS tools across 4 tiers | **Chimera** |
| **Security isolation** | Docker sandboxing | AgentCore MicroVM + Cedar policies + IAM boundaries | **Chimera** |
| **Skill format** | SKILL.md (originated here) | SKILL.md v2 + MCP + Strands @tool | **Chimera** |
| **Memory architecture** | MEMORY.md + SQLite vector search | AgentCore STM + LTM, 4 strategies, tenant-namespaced | **Chimera** |
| **Production maturity** | 209k stars, proven global deployment | Modules complete, not yet deployed | **OpenClaw** |
| **Community/ecosystem** | Massive (Claude Code, plugins, community skills) | Private/nascent | **OpenClaw** |
| **Local computer access** | Full (read, write, bash) | Intentionally absent | **OpenClaw** (different use case) |
| **Self-evolution** | Limited (no auto-skill generation) | `auto-skill-gen.ts` + `iac-modifier.ts` + safety harness | **Chimera** |
| **Context compaction** | ✅ Auto-summarization at 85% window | 🟡 Via AgentCore Memory (not self-managed) | **OpenClaw** |

**Summary:** Chimera wins decisively on every enterprise/cloud dimension. OpenClaw wins on maturity, community, and proven deployment. Chimera does not compete with OpenClaw for personal assistant use cases — it is designed for a different paradigm (AWS account operations, not local computer operations).

---

### 3.2 Chimera vs NemoClaw (NVIDIA)

| Dimension | NemoClaw | Chimera | Winner |
|-----------|---------|---------|--------|
| **Multi-tenancy** | Single-user (security wrapper only) | ✅ Native UTO model | **Chimera** |
| **Filesystem security** | Landlock LSM + seccomp (kernel-level) | AgentCore MicroVM (AWS-managed, untested) | **NemoClaw** (proven) |
| **Network isolation** | Deny-by-default allowlist | VPC security groups + IAM boundaries | **Tie** |
| **Human-in-the-loop** | Operator approval workflows | ✅ `hitl-gateway.ts` with DDB-backed approval chain | **Tie** |
| **Enterprise security** | Deployed, audited, hardware-attested | Designed for compliance; not yet audited | **NemoClaw** |
| **AWS account access** | None | ✅ 40 tools | **Chimera** |
| **Infrastructure operations** | None | ✅ CDK generation, CodePipeline | **Chimera** |

**Summary:** NemoClaw hardened OpenClaw at the OS level for enterprise security without redesigning the architecture. Chimera redesigned for cloud-native multi-tenancy. NemoClaw ahead on deployed security controls; Chimera ahead on cloud infrastructure capabilities.

---

### 3.3 Chimera vs OpenFang (RightNow AI)

| Dimension | OpenFang | Chimera | Winner |
|-----------|---------|---------|--------|
| **Cold start** | 180ms (WASM sandbox) | ~2-5s estimate (Python Docker in MicroVM) | **OpenFang** |
| **Security layers** | 16 layers, no shell, no network in sandbox | AgentCore MicroVM + 7 CDK security controls | **OpenFang** (more extreme) |
| **Developer experience** | Rust codebase, limited DX | Python + TypeScript, familiar ecosystem | **Chimera** |
| **Extensibility** | Limited (maintain Rust OS) | ✅ Skills, tools, swarm agents | **Chimera** |
| **AWS account access** | None | ✅ 40 tools | **Chimera** |
| **Operational burden** | Very high (custom OS) | AWS-managed (AgentCore) | **Chimera** |
| **Self-evolution** | None | ✅ Auto-skill gen, IaC modifier | **Chimera** |

**Summary:** OpenFang optimizes for maximum isolation and minimum cold start at the cost of extensibility. Chimera trades some raw performance for a dramatically richer capability surface. For AWS infrastructure operations, Chimera has no peer.

---

### 3.4 Chimera's Unique Position

Chimera is the **only system** among the four that:
1. Operates AWS accounts natively (not local computers)
2. Has a multi-tenant UTO model designed from day one
3. Can generate CDK, commit to CodeCommit, and deploy via CodePipeline autonomously
4. Supports three skill formats (SKILL.md, MCP, Strands @tool) for ecosystem compatibility
5. Has a self-evolving skill generation + canary deployment loop (in code if not yet in production)

No competing system has these properties. The question is not whether Chimera's vision is differentiated — it is. The question is whether it will be deployed before competitors build similar capabilities.

---

## 4. Critical Path to Self-Evolving Infrastructure Agent

The vision's highest-value claim is an agent that can:
1. Detect a pattern in AWS resource usage
2. Generate CDK code to address it
3. Commit to CodeCommit
4. Trigger CodePipeline
5. Monitor deployment
6. Validate and feed learnings back to memory

Every piece of this loop exists in the codebase. None of it has been executed end-to-end. Here is the minimum viable path:

### Step 1: Stabilize and deploy (estimated: Week 1)

| Action | Blocker resolved | Priority |
|--------|-----------------|----------|
| Fix 44 locally-fixable test failures (ChatMessage, ModelRouter, git-utils) | Test suite health; CI won't ship broken platform | P0 |
| Gate E2E tests behind `RUN_E2E=1` | 12 false failures disappear from CI | P0 |
| `npx cdk deploy --all --context environment=staging` | All 15 stacks live; required for everything below | P0 |
| Build and push Python agent Docker image to ECR | Required to register with AgentCore Runtime | P0 |
| Register agent runtime with AgentCore (execute `GatewayRegistrationStack`) | Unlocks live agent sessions | P0 |

### Step 2: First live agent session (estimated: Day 8-10)

| Action | Description | Dependency |
|--------|-------------|------------|
| `chimera connect` to live AgentCore endpoint | First real MicroVM session | Step 1 complete |
| Validate JWT claims extraction (tenantId, tier, userId) | Multi-tenancy requires this | Step 1 |
| Validate AgentCore Memory STM persistence across turns | Core UX claim | Step 1 |
| Test 5 discovery tools live (EC2, S3, Config, ResourceExplorer, CloudWatch) | AWS account access claim | Step 1 |

### Step 3: Close the self-evolution loop (estimated: Week 2)

| Action | Description | Dependency |
|--------|-------------|------------|
| Trigger `auto-skill-gen.ts` with 3 real pattern examples | First auto-generated skill from real usage | Step 2 |
| Run skill through 7-stage security pipeline (activate `SkillPipelineStack`) | Skill security vision | Step 1 |
| Commit generated CDK via `codecommit-workspace.ts` to real CodeCommit | IaC-as-capability vision | Steps 1-2 |
| Trigger `codepipeline-deployer.ts` against real CodePipeline | Autonomous deployment | Step 3.3 |
| Monitor CloudWatch for deployment outcome and feed back via `self-reflection.ts` | Continuous improvement loop | Step 3.4 |

### Step 4: Wire LLM into task decomposer (estimated: Day 12-15)

The current `task-decomposer.ts` has three `// TODO: use LLM` comments. Until this is resolved, the multi-agent swarm advertised in VISION.md uses hard-coded rules. Replace rule-based paths with Bedrock `InvokeModel` calls (Claude Haiku for cost efficiency at this step).

### Step 5: Deploy Web UI and observe (estimated: Week 3)

The undocumented `packages/web` React application (pages: chat, dashboard, admin, settings, login) is ready to deploy via `FrontendStack` (CloudFront + S3 OAC). This completes the user-facing product loop.

### Critical path summary

```
Fix 44 tests → cdk deploy (15 stacks) → ECR push → AgentCore register
    → live chimera session → validate multi-tenant isolation
    → auto-skill-gen live pattern → 7-stage pipeline → CodeCommit → CodePipeline
    → LLM-backed task decomposer → multi-agent swarm validated
    → Web UI deployed → product demo-ready
```

Estimated total: **3 weeks from test-fix to demo-ready**. The infrastructure is built. The remaining work is integration, not invention.

---

## 5. Undocumented Progress (since ROADMAP 2026-03-26)

ROADMAP.md reflects state as of 2026-03-26. Since then, the following has been merged and is not reflected in the roadmap:

| Addition | Package/Path | Significance |
|---------|-------------|-------------|
| **Web frontend** (`packages/web/`) | 44 TypeScript/TSX files | Chat UI, dashboard, admin, settings, login pages — full React app with Amplify auth, SSE streaming, skill management. **Not in ROADMAP.** |
| **DiscoveryStack** (`infra/lib/discovery-stack.ts`) | CDK stack | Cloud Map HTTP namespace for service discovery — 15th CDK stack, not in ROADMAP's 14-stack list |
| **Management API handlers** (`chimera-38a2` merge) | Lambda implementations | API handlers with tenant isolation in ApiStack — resolves the "Lambda scaffold" gap identified in 2026-03-25 feature gap analysis |
| **HITL Gateway** (`chimera-f5a4` merge) | `swarm/hitl-gateway.ts` | Human-in-the-loop approval gate with 33 tests and DDB-injectable interface |
| **Orchestrator stubs** | `orchestration/orchestrator.ts` | Step Functions orchestration stubs with narrow-interface DI |
| **Skill providers** | `skills/` instruction/mcp providers | SKILL.md instruction provider + MCP provider interface |
| **CLI completions** (`chimera-cherry-pick`) | `cli/src/commands/completion.ts` | `chimera completion bash|zsh|fish` — CLI DX polish |
| **Pipeline stage fix** (`chimera-1eba`, `chimera-ae82`) | CodePipeline wiring | Test stage now uses `sourceOutput` (not `buildOutput`); pipeline stage ordering corrected |

**ROADMAP and VISION.md should be updated** to reflect the 15th stack, the web package, and the lambda implementation progress.

---

## 6. Verdict and Prioritized Recommendations

### Verdict

VISION.md is **substantially accurate at the architectural level** and **overstated at the operational level**. The claims about multi-tenancy, AWS tool depth, skill ecosystem, and self-evolution architecture are backed by real code. The claims about deployed production capabilities, 13 AgentCore evaluators, Playwright Browser integration, and LLM-driven task decomposition are not yet backed.

The most important gap is not a missing feature — it is the **undeployed stack**. Every piece of the vision is within 3 weeks of being demonstrable if the team executes the critical path above.

### P0: Blocking production launch

1. **Run `cdk deploy --all`** — unblocks everything else
2. **Fix 44 locally-fixable test failures** — required for CI green gate
3. **Gate E2E tests behind `RUN_E2E=1`** — pattern already defined in mulch; apply consistently
4. **Wire LLM into `task-decomposer.ts`** — turns `// TODO` comments into the advertised multi-agent swarm

### P1: Vision completeness

5. **Update ROADMAP.md** — add web package, 15th DiscoveryStack, management API handler progress, HITL gateway completion
6. **Add AgentCore Evaluations integration** — 13-evaluator claim in VISION.md has no backing code; either implement or remove the claim
7. **Add Playwright Browser integration** — VISION.md claims AgentCore Browser capability; no code found
8. **Activate canary deployment routing** — `EvolutionStack` has the infrastructure; routing logic needs wiring

### P2: Enterprise hardening

9. **Cross-tenant isolation audit** — Cedar policies exist; penetration testing not done
10. **DynamoDB PITR + cross-region replication** — disaster recovery not configured
11. **Load test 1000+ concurrent sessions** — required before enterprise sales claims

### P3: Ecosystem expansion

12. **Skill authoring SDK (`@chimera/sdk-typescript`)** — enables third-party skill developers
13. **Complete Slack/Discord/Teams adapters** — beyond stub status
14. **Deploy Web UI** — `packages/web` is ready; `FrontendStack` is ready; just needs `cdk deploy`

---

**Chimera: where agents are forged — and where the forge needs to be lit.**

*Analysis performed by builder-vision-doc on 2026-04-01. Sources: VISION.md, ROADMAP.md, docs/analysis/chimera-feature-gap-analysis.md, docs/analysis/2026-04-01-review.md, live codebase audit (150+ files), test run (2,242 tests).*
