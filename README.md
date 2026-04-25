# AWS Chimera

[![Skill Registry: Phase 0-1 (DDB) — AgentCore Registry Phase 2+ pending spike](https://img.shields.io/badge/Skill%20Registry-Phase%200--1%20DDB%20%7C%20AgentCore%20Phase%202%2B%20pending%20spike-blue)](docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md)

> **The all-powerful, all-encompassing agentic system**
>
> Self-evolutionary. Self-optimizing. Self-expanding.
> A self-evolving, multi-tenant, AWS-native agent platform.
> Built on Bedrock AgentCore, Strands Agents, and AI SDK v5 Data Stream Protocol.

**Chimera** — the multi-formed creature of Greek mythology. Like its namesake,
this platform is many things at once: multi-tenant, multi-agent, multi-platform,
and self-evolving. It shape-shifts to serve each tenant's needs while maintaining
a unified architecture.

📖 **[Read the Complete Vision →](docs/VISION.md)** — The authoritative vision document covering identity, heritage, AWS account intelligence, infrastructure-as-capability, autonomous problem-solving, self-evolution, and more.

## What Is Chimera?

Chimera is a **production-ready Agent-as-a-Service platform** where:

- **Tenants** deploy AI agents with first-class AWS account access across multiple channels
- **Agents** use 40 AWS tools, multi-modal processing, memory, and orchestration to build, deploy, and operate infrastructure autonomously
- **The platform** self-evolves: auto-generates skills, optimizes model routing, A/B tests prompts, modifies its own infrastructure
- **Everything** runs on AWS managed services with AgentCore MicroVM isolation and 14 production-grade CDK stacks

### Heritage

Chimera is an AWS-native rebuild inspired by:

| Project                                            | Inspiration                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| [OpenClaw](https://github.com/anthropics/openclaw) | 4-tool minimalism, SKILL.md format, ClawHub marketplace, 23+ chat channels |
| [NemoClaw](https://github.com/NVIDIA/NemoClaw)     | Enterprise security (Landlock LSM, seccomp), deny-by-default policies      |
| [OpenFang](https://github.com/RightNowAI/OpenFang) | Rust Agent OS, 16-layer security, WASM sandbox, 180ms cold start           |

### What Makes It Different

| Capability                       | Implementation Status                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **AWS Account Intelligence**     | ✅ **BUILT** — 40 AWS tools (19 TypeScript + 21 Python: EC2, S3, Lambda, CloudWatch, RDS, SageMaker, Athena, Step Functions, CodePipeline, etc.) • Discovery modules (Config, Resource Explorer, Cost analyzer, Stack inventory) • Well-Architected Framework tool for architecture review |
| **Infrastructure as Capability** | ✅ **BUILT** — Infra-builder module generates CDK from requirements • CodeCommit/CodePipeline tools for git-based deployment • Self-modifying IaC with safety harness                                                                                                                      |
| **Multi-Modal Processing**       | ✅ **BUILT** — Auto-detection and routing for images, audio, video, documents • Rekognition, Transcribe, Textract tools integrated                                                                                                                                                         |
| **Agent Runtime**                | ✅ **BUILT** — Python agent with Strands SDK + AgentCore Runtime • ReAct loop with streaming • MicroVM isolation • AgentCore Memory integration (STM + LTM)                                                                                                                                |
| **Autonomous Problem Solving**   | ✅ **BUILT** — Swarm orchestration (task decomposer, role assigner, progressive refiner, blocker resolver, HITL gateway) • Multi-agent workflows via Step Functions                                                                                                                        |
| **Self-Evolution**               | ✅ **BUILT** — 7 evolution modules (auto-skill generator, experiment runner, IaC modifier, model router, prompt optimizer, safety harness) • A/B testing framework • Evolution stack (577 LOC)                                                                                             |
| **Multi-Tenant Isolation**       | ✅ **BUILT** — Tenant router, Cedar authorization engine, quota manager, rate limiter (token bucket) • Per-tenant KMS encryption • DynamoDB partition isolation with GSI FilterExpression enforcement                                                                                      |
| **Enterprise Security**          | ✅ **BUILT** — 7-stage skill security pipeline • Trust engine with 5-tier model • Cross-tenant isolation tests • Audit trail with CMK encryption                                                                                                                                           |
| **Observability**                | ✅ **BUILT** — Activity logging with ADR/runbook generators • CloudWatch alarms with runbooks • X-Ray distributed tracing • Real-time cost tracking                                                                                                                                        |
| **Multi-Account Management**     | ✅ **BUILT** — Multi-account orchestration module • AWS Organizations integration • Cross-account role assumption • SCP enforcement                                                                                                                                                        |
| **Universal Skills**             | ✅ **BUILT** — Skill registry, discovery, installer, validator, MCP gateway client • SKILL.md v2 parser • 5-tier trust model (Platform, Verified, Community, Private, Experimental)                                                                                                        |
| **Multi-Platform Chat**          | ✅ **BUILT** — 5 platform adapters (Web, Slack, Discord, Teams, Telegram) • AI SDK v5 Data Stream Protocol • SSE bridge (760+ LOC) • Chimera identity + system prompt wired • Real Bedrock streaming via BedrockModel (ConverseStream) + MantleModel (OpenAI-compat)                       |
| **CLI Deploy Flow**              | ✅ **BUILT** — 21 commands: deploy, monitor, chat, doctor, login (terminal + browser), session, skill, tenant, status, sync, init, setup, destroy, upgrade, connect, completion, endpoints, config, logs, version, help                                                                    |

## Architecture

```
Platform Adapters (Web, Slack, Discord, Teams, Telegram)
         │
    Hono on ECS Fargate (chat-gateway)
         │ AI SDK v5 Data Stream Protocol
    ┌─────┴──────────────────────────┐
    │  BedrockModel (ConverseStream) │
    │  MantleModel (OpenAI-compat)   │
    └─────┬──────────────────────────┘
    API Gateway (HTTP API, WebSocket)
         │
    Tenant Router (Cognito JWT → DynamoDB)
         │
    ┌────┴────────────────────────────┐
    │       AgentCore Runtime             │
    │  ┌─────────┐ ┌─────────┐ ┌───────┐ │
    │  │Tenant A │ │Tenant B │ │ Cron  │ │
    │  │MicroVM  │ │MicroVM  │ │MicroVM│ │
    │  │(Strands)│ │(Strands)│ │       │ │
    │  └────┬────┘ └────┬────┘ └───┬───┘ │
    └───────┼────────────┼─────────┼─────┘
            │            │         │
     ┌──────┴──────┬─────┴───┬─────┴──────┐
     │             │         │            │
  AgentCore    AgentCore  AgentCore    AgentCore
  Memory       Gateway    Code Interp  Browser
  (STM+LTM)   (MCP)      (Sandbox)    (CDP)
```

## AWS Services

| Service                        | Role                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| **AgentCore Runtime**          | Agent execution (MicroVM isolation)                                            |
| **AgentCore Memory**           | Session + long-term memory                                                     |
| **AgentCore Gateway**          | MCP tool routing                                                               |
| **AgentCore Identity**         | Auth (inbound + outbound)                                                      |
| **AgentCore Code Interpreter** | Safe code execution (OpenSandbox)                                              |
| **AgentCore Browser**          | Web browsing (Playwright CDP)                                                  |
| **DynamoDB**                   | State (6 tables: tenants, sessions, skills, rate-limits, cost-tracking, audit) |
| **S3**                         | Storage (skills, tenant data, artifacts, workspace archives)                   |
| **EFS**                        | Agent workspaces (POSIX filesystem, ephemeral)                                 |
| **CodeCommit**                 | Git-backed workspaces (version control for agent sessions)                     |
| **CodePipeline**               | CI/CD for agent-generated infrastructure                                       |
| **Cognito**                    | Tenant authentication                                                          |
| **API Gateway**                | API layer (HTTP + WebSocket)                                                   |
| **ECS Fargate**                | Chat gateway + SSE bridge                                                      |
| **EventBridge**                | Cron scheduling                                                                |
| **Step Functions**             | Workflow orchestration                                                         |
| **Cedar**                      | Policy engine (IAM-style authorization)                                        |
| **KMS**                        | Per-tenant encryption keys                                                     |
| **AWS Organizations**          | Multi-account management + consolidated billing                                |
| **CloudWatch + X-Ray**         | Observability + distributed tracing                                            |
| **AWS Config**                 | Resource discovery + compliance tracking                                       |
| **Resource Explorer**          | Fast cross-region search                                                       |

## Quick Start

```bash
# Install the CLI (download from GitHub releases)
curl -L https://github.com/Codeseys-Labs/chimera/releases/latest/download/chimera-darwin-arm64.tar.gz | tar xz
chmod +x chimera-darwin-arm64
sudo mv chimera-darwin-arm64 /usr/local/bin/chimera
chimera --version   # should print v0.6.2

# Or build from source
git clone https://github.com/Codeseys-Labs/chimera.git
cd chimera
bun install
bun run compile:cli              # produces packages/cli/chimera-<platform>
sudo mv packages/cli/chimera-* /usr/local/bin/chimera

# Deploy to your AWS account
chimera init                    # Configure AWS profile + region
chimera deploy --source git \   # Deploy from GitHub
  --remote https://github.com/Codeseys-Labs/chimera.git
chimera setup                   # Create admin Cognito user
chimera endpoints                # Fetch and save all URLs

# Verify
chimera status                  # Check all 14 stack statuses
chimera doctor                  # Run health checks

# Chat with the agent
chimera chat                    # Terminal chat
# Or open the web UI at the Frontend URL from chimera.toml

# Tear down everything
chimera destroy --force
```

## Project Structure

```
chimera/
├── packages/
│   ├── core/                 # Strands agent definitions + runtime
│   ├── agents/               # Python agent runtime
│   ├── sse-bridge/           # Strands to Vercel DSP bridge
│   ├── chat-gateway/         # Vercel Chat SDK + SSE bridge
│   ├── cli/                  # chimera CLI
│   └── shared/               # Types, utils, schemas
├── infra/                    # CDK infrastructure
│   ├── bin/                  # App entry point
│   ├── lib/                  # Stack definitions
│   └── constructs/           # L3 constructs
├── docs/                     # Documentation
│   ├── architecture/         # ADRs and architecture docs
│   │   └── decisions/        # 32 Architecture Decision Records
│   ├── guide/                # Core guides
│   ├── guides/               # Operational guides
│   ├── research/             # Research documents
│   └── runbooks/             # Operational runbooks
└── tests/                    # Integration + E2E tests
```

## Current Status

**Platform: Production — v0.6.2** — All 14 CDK stacks deploy and destroy cleanly. Full lifecycle verified with the released CLI binary. Live in `baladita+Bedrock-Admin` (us-west-2).

> **First-time deploy?** See [`docs/runbooks/first-deploy-baladita.md`](docs/runbooks/first-deploy-baladita.md) for a pre-flight checklist including Bedrock model approvals, service quota requirements, and the 7 risk items a Wave-10 code review flagged in `chimera deploy`.

| Phase                  | Status          | Key Deliverables                                                                                                                                          |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Foundation**      | ✅ **COMPLETE** | 14 CDK stacks (8,700+ LOC), 6-table DynamoDB design, VPC + networking, 34 ADRs, L3 constructs                                                             |
| **1. Agent Runtime**   | ✅ **COMPLETE** | Python agent with Strands SDK + AgentCore • 40 AWS tools • Multi-modal processing • Discovery modules • Gateway-based tool discovery                      |
| **2. Chat Gateway**    | ✅ **COMPLETE** | SSE bridge ship-ready • Chimera identity + system prompt wired • Bedrock model corrected • DSP parser fixed • React frontend with Amplify auth • Deployed |
| **3. Skill Ecosystem** | ✅ **COMPLETE** | Registry, discovery, installer, validator, MCP gateway • Trust engine • 7-stage security pipeline • SKILL.md v2 parser • MCP/instruction/hybrid providers |
| **4. Multi-Tenant**    | ✅ **COMPLETE** | Tenant router • Cedar authorization • Rate limiting • Quota management • Cost tracking • Per-tenant KMS                                                   |
| **5. Orchestration**   | ✅ **COMPLETE** | Swarm modules (5 components) • HITL DDB persistence • Multi-agent workflows • SQS/DDB/EventBridge stubs wired                                             |
| **6. Self-Evolution**  | ✅ **COMPLETE** | 7 evolution modules • Prompt A/B testing • Auto-skill generation • Model routing • Self-modifying IaC with safety harness                                 |
| **7. Production**      | ✅ **COMPLETE** | Verified: deploy from public repo → 14 stacks → E2E pass → destroy → clean account                                                                        |

**Test Coverage:** ~2,500 tests across 150+ test files (1,285 core, 60 web, 43 SSE bridge, 196 orchestration, 178 chat-gateway, 11 Playwright E2E specs).

## Documentation

### Core Documents

- **[VISION.md](docs/VISION.md)** — The authoritative Chimera vision (identity, capabilities, self-evolution)
- **[ROADMAP.md](docs/ROADMAP.md)** — Implementation roadmap and phasing
- **[CLAUDE.md](CLAUDE.md)** — Development workflow and Overstory conventions
- **[AGENTS.md](AGENTS.md)** — Mulch, Seeds, Canopy quick reference

### Architecture Diagrams

- **[System Architecture](docs/architecture/system-architecture.md)** — 9 mermaid diagrams covering CDK stacks, request flows, auth, self-evolution, multi-tenant isolation, skill lifecycle, deploy pipeline, and session state
- **[CLI Lifecycle](docs/architecture/cli-lifecycle.md)** — Command registry, 7-stage operator workflow, deploy internals, Cognito challenge loop, doctor health checks
- **[Deployment Architecture](docs/architecture/deployment-architecture.md)** — 15-stack CDK topology, deployment order, CDK Nag compliance, custom aspects
- **[Agent Architecture](docs/architecture/agent-architecture.md)** — Strands ReAct loop, AWS tool tiers, skill runtime, evolution engine, memory architecture
- **[Canonical Data Model](docs/architecture/canonical-data-model.md)** — 6-table DynamoDB schema, GSI design, multi-tenant isolation patterns

### Codebase Metrics

**Production Implementation:**

| Metric                            | Count                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Packages**                      | 7 (core, agents, shared, sse-bridge, chat-gateway, cli, web)                                                                                                                                                       |
| **CDK Infrastructure Stacks**     | 14 stacks (8,700+ LOC)                                                                                                                                                                                             |
| **TypeScript LOC**                | ~91,300 lines                                                                                                                                                                                                      |
| **Python Agent Runtime**          | 252 lines (chimera_agent.py) + ~9,200 total Python LOC                                                                                                                                                             |
| **AWS Tool Implementations**      | 40 tools (19 TypeScript + 21 Python) + 5 Cloud Map discovery tools                                                                                                                                                 |
| **CLI Commands**                  | 21 (chat, completion, config, connect, deploy, destroy, doctor, endpoints, help, init, login, logs, monitor, session, setup, skill, status, sync, tenant, upgrade, version)                                        |
| **Core Modules**                  | 22 (activity, agent, auth, aws-tools, billing, discovery, events, evolution, gateway, infra-builder, media, memory, multi-account, orchestration, runtime, skills, stream, swarm, tenant, tools, well-architected) |
| **Test Coverage**                 | ~2,500 tests across 150+ test files                                                                                                                                                                                |
| **Test Assertions**               | 4,084 expect() calls                                                                                                                                                                                               |
| **Architecture Decision Records** | 34 ADRs                                                                                                                                                                                                            |
| **Research Documentation**        | 123 docs, 118,000+ lines                                                                                                                                                                                           |

**Key Components Built:**

- ✅ Agent runtime (Strands + AgentCore in Python, 252 LOC + ~9,200 total)
- ✅ 40 AWS service tools (19 TypeScript + 21 Python: EC2, S3, Lambda, RDS, SageMaker, Athena, Glue, Redshift, OpenSearch, Step Functions, CodePipeline, CodeCommit, CodeBuild, CloudWatch, Rekognition, Transcribe, Textract, SQS, Bedrock, etc.)
- ✅ Discovery triad (AWS Config, Resource Explorer, Cost Explorer)
- ✅ Multi-modal media processing (auto-detection, routing)
- ✅ Swarm orchestration (5 components: task decomposer, role assigner, progressive refiner, blocker resolver, HITL gateway)
- ✅ Self-evolution engine (7 modules: auto-skill gen, experiments, IaC modifier, model router, prompt optimizer, safety harness)
- ✅ Multi-tenant isolation (tenant router, Cedar auth, rate limiter, quota manager, cost tracker)
- ✅ Universal skill system (registry, discovery, installer, validator, MCP gateway, trust engine)
- ✅ Well-Architected Framework integration (6-pillar review tool)
- ✅ Infrastructure-as-code builder (CDK generation from requirements)
- ✅ Activity logging with ADR/runbook auto-generation
- ✅ 14 production CDK stacks (8,700+ LOC) (Network, Data, Security, Observability, API, Chat, Tenant Onboarding, Pipeline, Skill Pipeline, Evolution, Orchestration, Email, Frontend, GatewayRegistration, Destroy)

### Destroy Lifecycle

`chimera destroy --force` runs a 3-phase CodeBuild-delegated teardown that removes all 14 stacks and leaves the AWS account clean. Phase 1 destroys application stacks (Chat, API, Frontend, etc.), Phase 2 removes data and security stacks (with S3 bucket auto-emptying and Cognito cleanup), and Phase 3 tears down the network foundation. See [ADR-032](docs/architecture/decisions/032-codebuild-delegated-destroy.md) for design details.

## License

Apache-2.0

---

_Chimera — where agents are forged._
