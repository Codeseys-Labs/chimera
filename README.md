# AWS Chimera

> **The all-powerful, all-encompassing agentic system**
>
> Self-evolutionary. Self-optimizing. Self-expanding.
> A self-evolving, multi-tenant, AWS-native agent platform.
> Built on Bedrock AgentCore, Strands Agents, and Vercel Chat SDK.

**Chimera** — the multi-formed creature of Greek mythology. Like its namesake,
this platform is many things at once: multi-tenant, multi-agent, multi-platform,
and self-evolving. It shape-shifts to serve each tenant's needs while maintaining
a unified architecture.

📖 **[Read the Complete Vision →](docs/VISION.md)** — The authoritative vision document covering identity, heritage, AWS account intelligence, infrastructure-as-capability, autonomous problem-solving, self-evolution, and more.

## What Is Chimera?

Chimera is an **Agent-as-a-Service platform** where:

- **Tenants** deploy AI agents that chat across Slack, Teams, Discord, Telegram, WhatsApp, and Web
- **Agents** use skills, tools, memory, and subagents to accomplish tasks autonomously
- **The platform** improves itself: auto-generates skills, optimizes model routing, evolves prompts, self-modifies infrastructure
- **Everything** runs on AWS managed services with MicroVM tenant isolation

### Heritage

Chimera is an AWS-native rebuild inspired by:

| Project | Inspiration |
|---------|-------------|
| [OpenClaw](https://github.com/anthropics/openclaw) | 4-tool minimalism, SKILL.md format, ClawHub marketplace, 23+ chat channels |
| [NemoClaw](https://github.com/NVIDIA/NemoClaw) | Enterprise security (Landlock LSM, seccomp), deny-by-default policies |
| [OpenFang](https://github.com/RightNowAI/OpenFang) | Rust Agent OS, 16-layer security, WASM sandbox, 180ms cold start |

### What Makes It Different

| Capability | How |
|-----------|-----|
| **AWS Account Intelligence** | Every AWS service is an agent tool • Live index across all regions • Well-Architected Framework as decision vocabulary |
| **Infrastructure as Capability** | Agents generate CDK, commit to CodeCommit, deploy via CodePipeline • Build video pipelines, data lakes, monitoring systems autonomously |
| **Autonomous Problem Solving** | Vague task → swarm decomposes → researches → builds → deploys → documents • Progressive refinement from POC to production |
| **Self-Evolution** | Auto-skill generation • Prompt A/B testing • Model routing optimization • Self-modifying IaC • ML experiment automation |
| **Multi-Tenant Isolation** | MicroVM per session • Cedar policies • DynamoDB partition isolation • Per-tenant KMS encryption |
| **Enterprise Security** | 8-layer defense-in-depth • ClawHavoc-informed skill scanning • 7-stage security pipeline |
| **Structured Documentation** | Auto-ADRs • Auto-runbooks • Real-time dashboards • Decision logs • Cost reports |
| **Multi-Account Management** | AWS Organizations • Cross-account roles • Consolidated billing • Regional constraints via SCPs |
| **Universal Skills** | Compatible with OpenClaw SKILL.md, Claude Code skills, MCP tools, Strands @tool • 5-tier trust model |
| **Multi-Platform Chat** | Vercel Chat SDK with native rendering across Slack, Teams, Discord, Telegram, WhatsApp, Web |
| **Git-Backed Workspaces** | CodeCommit repos per session • S3+EFS hybrid storage • No local filesystem dependency |

## Architecture

```
Users (Slack/Teams/Discord/Telegram/WhatsApp/Web)
         │
    Vercel Chat SDK (ECS Fargate)
         │ Data Stream Protocol
    API Gateway (HTTP API, WebSocket)
         │
    Tenant Router (Cognito JWT → DynamoDB)
         │
    ┌────┴────────────────────────────────┐
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

| Service | Role |
|---------|------|
| **AgentCore Runtime** | Agent execution (MicroVM isolation) |
| **AgentCore Memory** | Session + long-term memory |
| **AgentCore Gateway** | MCP tool routing |
| **AgentCore Identity** | Auth (inbound + outbound) |
| **AgentCore Code Interpreter** | Safe code execution (OpenSandbox) |
| **AgentCore Browser** | Web browsing (Playwright CDP) |
| **DynamoDB** | State (6 tables: tenants, sessions, skills, rate-limits, cost-tracking, audit) |
| **S3** | Storage (skills, tenant data, artifacts, workspace archives) |
| **EFS** | Agent workspaces (POSIX filesystem, ephemeral) |
| **CodeCommit** | Git-backed workspaces (version control for agent sessions) |
| **CodePipeline** | CI/CD for agent-generated infrastructure |
| **Cognito** | Tenant authentication |
| **API Gateway** | API layer (HTTP + WebSocket) |
| **ECS Fargate** | Chat gateway + SSE bridge |
| **EventBridge** | Cron scheduling |
| **Step Functions** | Workflow orchestration |
| **Cedar** | Policy engine (IAM-style authorization) |
| **KMS** | Per-tenant encryption keys |
| **AWS Organizations** | Multi-account management + consolidated billing |
| **CloudWatch + X-Ray** | Observability + distributed tracing |
| **AWS Config** | Resource discovery + compliance tracking |
| **Resource Explorer** | Fast cross-region search |

## Quick Start

```bash
# Install CLI
npm install -g @chimera/cli

# Initialize a new agent
chimera auth login
chimera agent init my-agent --template=chatbot
chimera agent run                    # Local dev with hot reload

# Add a chat channel
chimera channel add slack --token=$SLACK_TOKEN

# Deploy to AgentCore
chimera agent deploy --env=staging

# Create a skill
chimera skill create my-skill
chimera skill test
chimera skill publish
```

## Project Structure

```
chimera/
├── packages/
│   ├── core/                 # Strands agent definitions + runtime
│   ├── chat-gateway/         # Vercel Chat SDK + SSE bridge
│   ├── cli/                  # chimera CLI
│   ├── sdk-python/           # Skill authoring SDK (Python)
│   ├── sdk-typescript/       # Skill authoring SDK (TypeScript)
│   └── shared/               # Types, utils, schemas
├── infra/                    # CDK infrastructure
│   ├── bin/                  # App entry point
│   ├── lib/                  # Stack definitions
│   └── constructs/           # L3 constructs
├── skills/                   # Built-in platform skills
├── docs/                     # Documentation
│   ├── architecture/         # Architecture decision records
│   ├── research/             # Research documents
│   └── runbooks/             # Operational runbooks
└── tests/                    # Integration + E2E tests
```

## Implementation Roadmap

| Phase | Weeks | Deliverable |
|-------|-------|-------------|
| 0. Foundation | 1-2 | CDK scaffold, DynamoDB, S3, Cognito, VPC |
| 1. Single Agent | 3-4 | AgentCore Runtime + Strands + Memory + Skills |
| 2. Chat Gateway | 5-6 | Chat SDK on Fargate, SSE bridge, Slack + Web |
| 3. Skill Ecosystem | 7-8 | Registry, MCP targets, security pipeline |
| 4. Multi-Tenant | 9-10 | Tenant router, Cedar policies, cost tracking |
| 5. Cron & Orchestration | 11-12 | EventBridge scheduler, multi-agent patterns |
| 6. Self-Evolution | 13-14 | Prompt A/B testing, auto-skills, model routing |
| 7. Production | 15-16 | CI/CD pipeline, monitoring, DR, load testing |

## Documentation

### Core Documents

- **[VISION.md](docs/VISION.md)** — The authoritative Chimera vision (identity, capabilities, self-evolution)
- **[ROADMAP.md](docs/ROADMAP.md)** — Implementation roadmap and phasing
- **[CLAUDE.md](CLAUDE.md)** — Development workflow and Overstory conventions
- **[AGENTS.md](AGENTS.md)** — Mulch, Seeds, Canopy quick reference

### Research Corpus

This project is backed by **40,000+ lines** of research and architecture documentation:

- **[docs/architecture/](docs/architecture/)** — Architecture decision records (ADRs), canonical schemas
- **[docs/research/](docs/research/)** — OpenClaw/NemoClaw/OpenFang research (8 docs, 6,991 lines)
- **[docs/research/](docs/research/)** — AgentCore & Strands research (9 docs, 10,848 lines)
- **Architecture Reviews** — 6 specialist reviews
- **Enhancement Documents** — 9 new docs, ~10,000+ lines
- **CDK Scaffold Code** — 8 production-ready files

## License

Apache-2.0

---

*Chimera — where agents are forged.*
