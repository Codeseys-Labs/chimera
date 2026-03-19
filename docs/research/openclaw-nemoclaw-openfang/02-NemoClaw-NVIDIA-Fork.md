# NemoClaw: NVIDIA's Enterprise Stack for OpenClaw

> **NVIDIA NemoClaw** is an open-source stack that wraps the OpenClaw agent platform
> with enterprise-grade security, privacy controls, and optimized inference through
> the NVIDIA ecosystem. Announced at GTC 2026 on March 16, NemoClaw installs NVIDIA
> OpenShell and Nemotron models in a single command, adding sandboxed execution,
> policy-based guardrails, and inference routing to make autonomous AI agents
> trustworthy and deployable in enterprise environments.

---

## Table of Contents

- [[#Overview and Strategic Context]]
- [[#Relationship to OpenClaw]]
- [[#Architecture]]
- [[#NVIDIA OpenShell Runtime]]
- [[#Inference Routing and Model Support]]
- [[#Security and Privacy Features]]
- [[#NVIDIA Agent Toolkit Integration]]
- [[#NeMo Agent Toolkit]]
- [[#Hardware Support and Deployment Targets]]
- [[#Installation and Quick Start]]
- [[#CLI Commands Reference]]
- [[#Network Policy System]]
- [[#Blueprint System]]
- [[#Plugin Architecture]]
- [[#DGX Spark Deployment]]
- [[#Enterprise Ecosystem and Partnerships]]
- [[#Community and Ecosystem]]
- [[#Comparison: NemoClaw vs OpenClaw vs NanoClaw]]
- [[#Current Status and Limitations]]
- [[#Roadmap and Future Direction]]
- [[#Key Links and Sources]]

---

## Overview and Strategic Context

NemoClaw was announced by Jensen Huang at NVIDIA's GTC 2026 conference on March 16, 2026. Huang positioned OpenClaw as "the operating system for personal AI" and compared its importance to Linux, HTTP/HTML, and Kubernetes:

> "Every company in the world today needs to have an OpenClaw strategy, an agentic
> systems strategy." -- Jensen Huang, GTC 2026 Keynote

NemoClaw is NVIDIA's answer to the enterprise adoption gap: OpenClaw had become the
fastest-growing open-source project in history but lacked the security, privacy, and
governance controls that enterprises require. NemoClaw addresses this by layering
NVIDIA's OpenShell runtime, Nemotron models, and Agent Toolkit on top of the OpenClaw
agent platform.

### Key Facts

| Attribute | Value |
|-----------|-------|
| **Official Name** | NVIDIA NemoClaw |
| **Repository** | [NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw) |
| **Stars** | ~11,000+ (as of March 2026) |
| **License** | Apache License 2.0 |
| **Languages** | JavaScript (39.7%), Shell (28.8%), TypeScript (27.2%), Python (3.4%) |
| **Documentation** | [docs.nvidia.com/nemoclaw/latest](https://docs.nvidia.com/nemoclaw/latest/) |
| **Status** | Alpha software -- early-stage, not production-ready |
| **Created** | March 15, 2026 |
| **Contributors** | 30 (ericksoa, miyoungc, jacobtomlinson, vincentkoc, kjw3, etc.) |
| **Announced** | GTC 2026, March 16, 2026 |

### Strategic Significance

NemoClaw represents a significant pivot for NVIDIA:

1. **Open-source embrace** -- Moving away from proprietary walled gardens (CUDA lock-in) toward an open platform strategy
2. **Hardware-agnostic** -- NemoClaw does not require NVIDIA GPUs, running on any dedicated platform
3. **Software moat** -- Establishing NemoClaw as the foundational operating standard for agentic AI before competitors lock in the market
4. **Enterprise hedge** -- Offering enterprise SaaS companies a controlled, secure agent framework as their products face disruption from autonomous AI workflows

---

## Relationship to OpenClaw

NemoClaw is **not a fork** of OpenClaw. It is an **OpenClaw plugin** that integrates OpenClaw into NVIDIA's agentic stack:

- NemoClaw wraps OpenClaw in a sandboxed environment managed by OpenShell
- OpenClaw runs unmodified inside the NemoClaw sandbox
- NemoClaw adds the security/privacy/inference layers that OpenClaw lacks
- Peter Steinberger (OpenClaw creator) collaborated with NVIDIA on NemoClaw

As NVIDIA's press release states:

> "NemoClaw uses NVIDIA Agent Toolkit software to optimize OpenClaw in a single
> command. It installs OpenShell to provide open models and an isolated sandbox
> that adds data privacy and security to autonomous agents."

For details on OpenClaw itself, see [[01-OpenClaw-Core-Architecture]].

### What NemoClaw Adds to OpenClaw

| Capability | OpenClaw Alone | With NemoClaw |
|------------|---------------|---------------|
| **Sandbox isolation** | None -- runs with full system access | Kernel-level isolation via Landlock LSM + seccomp |
| **Network control** | Unrestricted outbound | Policy-based egress with operator approval |
| **Filesystem access** | Full read/write | Restricted to `/sandbox` and `/tmp` |
| **Inference routing** | Direct API calls | Intercepted and routed through OpenShell gateway |
| **Privacy controls** | None | PII stripping, local/cloud model routing by policy |
| **Audit trail** | None | Full logging of agent actions and policy decisions |
| **Enterprise governance** | None | Declarative YAML-based policy enforcement |

---

## Architecture

NemoClaw employs a **three-layer architecture**:

```
Host Environment
  |
  +-- nemoclaw binary (TypeScript CLI)
  |     |
  |     +-- Plugin commands: launch, connect, status, logs
  |     +-- Blueprint orchestration: resolve, verify, plan, apply
  |
  +-- OpenShell Platform
  |     |
  |     +-- k3s-in-Docker gateway
  |     +-- Sandbox lifecycle management
  |     +-- Policy engine (network, filesystem, process)
  |     +-- Inference routing / privacy router
  |
  +-- Sandbox Environment
        |
        +-- Isolated container
        +-- OpenClaw agent + NemoClaw plugin
        +-- Policy-enforced egress and filesystem
```

### Component Roles

| Component | Role |
|-----------|------|
| **Plugin** | TypeScript CLI commands for launch, connect, status, and logs |
| **Blueprint** | Versioned Python artifact that orchestrates sandbox creation, policy, and inference setup |
| **Sandbox** | Isolated OpenShell container running OpenClaw with policy-enforced egress and filesystem |
| **Inference** | NVIDIA cloud model calls, routed through the OpenShell gateway, transparent to the agent |

### DGX Spark Architecture Detail

On DGX Spark hardware, the nesting is:

```
DGX Spark (Ubuntu 24.04, cgroup v2)
  +-- Docker (28.x, cgroupns=host)
       +-- OpenShell gateway container
            +-- k3s (embedded)
                 +-- nemoclaw sandbox pod
                      +-- OpenClaw agent + NemoClaw plugin
```

### Plugin-Blueprint Model

NemoClaw's core architectural pattern separates concerns into two layers:

1. **Plugin** (TypeScript) -- User-facing CLI and orchestration
   - Handles command-line arguments
   - Blueprint resolution and version verification
   - Subprocess management
   - Runs in-process with the OpenClaw gateway

2. **Blueprint** (Python) -- Infrastructure provisioning and policy
   - Versioned artifact (from OCI registry)
   - Logic for provisioning infrastructure
   - Applying security policies
   - Configuring inference through OpenShell CLI
   - Lifecycle: resolve -> verify -> plan -> apply -> status

This separation keeps the plugin small and stable while allowing the blueprint to evolve
on its own release cadence.

---

## NVIDIA OpenShell Runtime

OpenShell is the foundational security runtime that NemoClaw depends on. It is a
standalone open-source project (Apache 2.0) that provides sandboxed execution for
any AI agent -- not just OpenClaw.

### OpenShell Overview

OpenShell sits between the agent and the operating system, governing:
- **How the agent executes** (sandboxed isolation)
- **What the agent can see and do** (policy enforcement)
- **Where inference goes** (privacy routing)

NVIDIA describes OpenShell as using a "browser tab model" for agents -- the OS enforces
the sandbox, not the agent itself. This is out-of-process enforcement, meaning the
agent cannot bypass the security controls.

### Agent-Agnostic Design

OpenShell is explicitly agent-agnostic. It supports:
- OpenClaw
- Claude Code
- Codex
- OpenCode
- LangChain-based systems
- Any custom agent

No SDK changes or agent rewrites required -- OpenShell acts as a runtime wrapper.

### Three Core Components

1. **Sandbox** -- Kernel-level isolation via Landlock LSM and seccomp
   - Ephemeral execution environments
   - Skill verification and isolated execution
   - Live policy updates with full audit trail

2. **Policy Engine** -- Granular, declarative access control
   - Per-binary, per-destination, per-method, per-path evaluation
   - Covers filesystem, network, and process layers
   - YAML-based, version-controllable policies
   - Hot-reloadable at runtime (network and inference)
   - Locked at sandbox creation (filesystem and process)

3. **Privacy Router** -- Inference traffic control
   - Determines whether context stays on-device (local models) or routes to cloud
   - Based on organizational policy, not agent judgment
   - Leverages NVIDIA's Gretel acquisition for differential privacy / PII stripping
   - Anonymizes prompts before they reach external frontier model APIs

### OpenShell CLI

```bash
# Create a sandbox
openshell sandbox create --agent my_agent

# List sandboxes
openshell sandbox list

# Launch the TUI for monitoring and approvals
openshell term

# Manage inference routing
openshell inference set
```

### Enterprise Partnerships for OpenShell

Several major security vendors have announced integrations:

- **CrowdStrike Falcon** -- Runtime monitoring, prompt manipulation prevention
- **Cisco AI Defense** -- Behavioral verification, continuous compliance records
- **Trend Micro TrendAI** -- Governance, risk visibility, runtime enforcement
- **Cohesity** -- Data resilience, threat analysis orchestration

---

## Inference Routing and Model Support

NemoClaw provides transparent inference routing through the OpenShell gateway.
The agent code never directly accesses inference endpoints -- all requests are
intercepted and routed according to the active inference profile.

### Inference Profiles

NemoClaw ships with three inference profiles defined in `blueprint.yaml`:

| Profile | Provider | Model | Endpoint | Use Case |
|---------|----------|-------|----------|----------|
| `default` | NVIDIA Cloud | `nvidia/nemotron-3-super-120b-a12b` | `integrate.api.nvidia.com` | Production (requires NVIDIA API key) |
| `nim-local` | Local NIM | `nvidia/nemotron-3-super-120b-a12b` | `nim-service.local:8000` | On-premises NIM deployment |
| `vllm` | Local vLLM | `nvidia/nemotron-3-nano-30b-a3b` | `host.openshell.internal:8000` | Local vLLM server |

### Selecting a Profile

```bash
# At launch time
openclaw nemoclaw launch --profile nim-local

# At runtime (switch without restart)
openshell inference set
```

### Supported Models

The NVIDIA Nemotron family:

| Model | Parameters | Use Case |
|-------|-----------|----------|
| `nvidia/nemotron-3-super-120b-a12b` | 120B (12B active, MoE) | Default production model |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | 253B | High-capability tasks |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | 49B | Mid-range performance |
| `nvidia/nemotron-3-nano-30b-a3b` | 30B (3B active, MoE) | Local/edge inference |
| `nvidia/nemotron-3-nano-4b` | 4B | Jetson/constrained devices (8GB unified memory) |

### Privacy Router for Frontier Models

NemoClaw supports a hybrid local/cloud model approach via the Privacy Router:
- **Local models** (Nemotron, Ollama, vLLM) -- Better privacy, no token costs
- **Frontier models** (Claude, GPT-4, etc.) -- Accessed through the privacy router
- PII stripping via differential privacy (Gretel technology) before prompts reach cloud

The Privacy Router makes the routing decision based on organizational policy,
not agent preference.

### Local Inference Options

Local inference through Ollama and vLLM is still experimental:
- On macOS, requires OpenShell host-routing support
- On DGX Spark, Ollama with `nemotron-3-nano:4b` fits in 8GB unified memory
- LM Studio support is in active development (PR #312)
- Bitdeer and Baseten providers are community-contributed (PRs #299, #287)

### NIM Integration

NVIDIA NIM (Inference Microservices) provides optimized containers for model serving:
- Exposed as OpenAI-compatible APIs
- GPU-accelerated inference
- Supports the `nim-local` profile in NemoClaw
- Available models registered through `build.nvidia.com`

The NIM provider registers models from NVIDIA's model catalog, and the `nim-local`
profile routes to a locally running NIM service at `nim-service.local:8000`.

---

## Security and Privacy Features

Security is the primary value proposition of NemoClaw over raw OpenClaw. The system
implements defense-in-depth across four protection layers:

### Protection Layers

| Layer | What It Protects | When Applied | Reloadable? |
|-------|-----------------|--------------|-------------|
| **Network** | Blocks unauthorized outbound connections | Hot-reloadable at runtime | Yes |
| **Filesystem** | Prevents reads/writes outside `/sandbox` and `/tmp` | Locked at sandbox creation | No |
| **Process** | Blocks privilege escalation and dangerous syscalls | Locked at sandbox creation | No |
| **Inference** | Reroutes model API calls to controlled backends | Hot-reloadable at runtime | Yes |

### Network Policy Details

The network policy system is the most granular:

- **Deny-by-default** -- Agent starts with zero network permissions
- **Endpoint groups** define allowed hosts, ports, binaries, and HTTP methods/paths
- **Operator approval** -- When the agent tries to reach an unlisted host, OpenShell blocks the request and surfaces it in the TUI for operator approval
- **Policy presets** available for common services (see [[#Network Policy System]])

### Kernel-Level Isolation

```
Sandbox: my-assistant (Landlock + seccomp + netns)
```

- **Landlock LSM** -- Linux Security Module for fine-grained filesystem access control
- **seccomp** -- System call filtering to block dangerous operations
- **Network namespaces (netns)** -- Network isolation with controlled egress

### Example Policy Snippet

```yaml
# nemoclaw-blueprint/policies/openclaw-sandbox.yaml
network:
  - name: github
    endpoints:
      - host: github.com
        port: 443
      - host: api.github.com
        port: 443
    binaries:
      - git
      - curl
    rules:
      - method: GET
        path: "/**"
      - method: POST
        path: "/repos/**"
```

### Audit and Compliance

- Every agent action is logged
- Policy decisions recorded in audit trail
- YAML policies are version-controllable -- can be reviewed and audited
- Compliance teams can answer "who did what and why" with precision

---

## NVIDIA Agent Toolkit Integration

NemoClaw is part of the broader NVIDIA Agent Toolkit ecosystem:

```
NVIDIA Agent Toolkit
  |
  +-- OpenShell (Security Runtime)
  |     +-- NemoClaw (OpenClaw Plugin for OpenShell)
  |
  +-- Nemotron Models (Open AI Models)
  |     +-- Nemotron 3 Super 120B
  |     +-- Nemotron 3 Nano 30B / 4B
  |     +-- Llama-Nemotron variants
  |
  +-- NeMo Agent Toolkit (Build/Profile/Optimize)
  |
  +-- NIM (Inference Microservices)
  |
  +-- Dynamo (Distributed Inference Engine)
  |
  +-- AI-Q Blueprint (Deep Research)
  |
  +-- NeMo Guardrails (Safety Rails)
```

The Agent Toolkit provides:
- **Open models** -- Nemotron family for local and cloud inference
- **Runtimes** -- OpenShell for security, NIM for inference
- **Open skills** -- Reusable agent capabilities
- **Blueprints** -- Reference architectures for common patterns
- **Evaluation** -- Agent accuracy and performance testing

---

## NeMo Agent Toolkit

The NeMo Agent Toolkit (NAT) is the companion library for building, deploying,
evaluating, and optimizing AI agents. While NemoClaw handles security and sandboxing,
NAT handles the agent development lifecycle.

### NAT Architecture

NAT is modular with the following package structure:

- **Core** (`nvidia-nat-core`) -- Workflow engine, builder, LLM providers, middleware
- **Framework integrations** -- LangChain, LlamaIndex, CrewAI, Google ADK, AutoGen, Semantic Kernel, Strands, Agno
- **Observability** -- OpenTelemetry, Phoenix, Weave
- **Protocols** -- MCP (Model Context Protocol), A2A
- **Storage** -- MySQL, Redis, S3, Mem0, Zep
- **Advanced** -- Agent Performance Primitives, security, data flywheel

### Key NAT Capabilities

| Capability | Description |
|------------|-------------|
| **Agent Profiling** | Track tokens, timings, TTFT, ITL metrics with `@latency` decorators |
| **Evaluation** | `nat eval` validates workflows against datasets with TSQ, Accuracy, Runtime, Latency evaluators |
| **Optimization** | Genetic algorithms + Optuna for hyperparameter and prompt optimization |
| **MCP Integration** | Consume MCP tools or publish NAT workflows as MCP servers via FastMCP |
| **RL Fine-tuning** | In-situ reinforcement learning with GRPO (OpenPipe ART) and DPO (NeMo Customizer) |
| **Dynamo Integration** | Auto-infer per-request latency sensitivity, cache control, load-aware routing |

### Quick Install

```bash
pip install nvidia-nat
nat --help
nat --version
```

---

## Hardware Support and Deployment Targets

NemoClaw is designed to run on dedicated computing platforms for always-on agents:

### Supported Platforms

| Platform | GPU Memory | Notes |
|----------|-----------|-------|
| **NVIDIA GeForce RTX PCs/laptops** | Varies | Consumer-grade, local agent computing |
| **NVIDIA RTX PRO workstations** | Up to 96 GB (RTX PRO 6000 Blackwell) | Professional workstation agents |
| **NVIDIA DGX Station** | 128 GB+ | Enterprise AI supercomputer |
| **NVIDIA DGX Spark** | 128 GB unified memory | Desktop AI supercomputer |
| **NVIDIA Jetson** | 8-64 GB unified memory | Edge/robotics (community support in development) |
| **Cloud instances** | Varies | NVIDIA H200, B200, B300 via cloud providers |

### DGX Spark as Agent Computer

NVIDIA positions DGX Spark as the ideal "agent computer":
- 128 GB unified memory for large models
- Dedicated hardware for 24/7 agent operation
- Combined with OpenShell for security
- Partners: ASUS, Dell Technologies, GIGABYTE, MSI, Supermicro, HP

### Minimum Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 vCPU | 4+ vCPU |
| RAM | 8 GB | 16 GB |
| Disk | 20 GB free | 40 GB free |

The sandbox image is approximately 2.4 GB compressed. Systems with less than 8 GB
RAM may need swap configured to avoid OOM kills.

---

## Installation and Quick Start

### One-Command Install

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

The installer:
1. Installs Node.js if not present
2. Runs a guided onboarding wizard
3. Creates a sandbox
4. Configures inference providers (prompts for NVIDIA API key)
5. Applies security policies

### Post-Install Output

```
----------------------------------------------
Sandbox      my-assistant (Landlock + seccomp + netns)
Model        nvidia/nemotron-3-super-120b-a12b (NVIDIA Cloud API)
----------------------------------------------
Run:         nemoclaw my-assistant connect
Status:      nemoclaw my-assistant status
Logs:        nemoclaw my-assistant logs --follow
----------------------------------------------

[INFO]  === Installation complete ===
```

### Connect and Chat

```bash
# Connect to the sandbox
nemoclaw my-assistant connect

# Inside sandbox -- use TUI
sandbox@my-assistant:~$ openclaw tui

# Or use CLI for single messages
sandbox@my-assistant:~$ openclaw agent --agent main --local -m "hello" --session-id test
```

### Prerequisites

| Dependency | Version |
|------------|---------|
| Linux | Ubuntu 22.04 LTS or later |
| Node.js | 20 or later |
| npm | 10 or later |
| Container runtime | Docker (Linux), Colima/Docker Desktop (macOS) |
| OpenShell | Installed (auto-installed by NemoClaw) |

### Container Runtime Support

| Platform | Supported Runtimes | Notes |
|----------|-------------------|-------|
| Linux | Docker | Primary supported path |
| macOS (Apple Silicon) | Colima, Docker Desktop | Recommended for macOS |
| macOS | Podman | Not yet supported |
| Windows WSL | Docker Desktop (WSL backend) | Supported |

---

## CLI Commands Reference

### Host Commands (`nemoclaw`)

Run on the host to set up, connect to, and manage sandboxes:

| Command | Description |
|---------|-------------|
| `nemoclaw onboard` | Interactive setup wizard: gateway, providers, sandbox |
| `nemoclaw <name> connect` | Open interactive shell inside the sandbox |
| `nemoclaw <name> start` | Start sandbox and auxiliary services |
| `nemoclaw <name> stop` | Stop sandbox |
| `nemoclaw <name> status` | Show sandbox health and state |
| `nemoclaw <name> logs [--follow]` | Stream sandbox and blueprint logs |
| `nemoclaw setup-spark` | DGX Spark-specific setup (cgroup v2, Docker config) |
| `openshell term` | Launch the OpenShell TUI for monitoring and approvals |

### Plugin Commands (`openclaw nemoclaw`)

Run inside the OpenClaw CLI (under active development):

| Command | Description |
|---------|-------------|
| `openclaw nemoclaw launch [--profile ...]` | Bootstrap OpenClaw inside an OpenShell sandbox |
| `openclaw nemoclaw status` | Show sandbox health, blueprint state, and inference |
| `openclaw nemoclaw logs [-f]` | Stream blueprint execution and sandbox logs |

---

## Network Policy System

The network policy system is one of NemoClaw's most important features for enterprise
adoption. It provides fine-grained control over what external services the sandboxed
agent can reach.

### Policy File Location

```
nemoclaw-blueprint/policies/openclaw-sandbox.yaml
```

### Policy Structure

Each entry in the `network` section defines an endpoint group:

- `endpoints` -- Host and port pairs the sandbox can reach
- `binaries` -- Executables allowed to use this endpoint
- `rules` -- HTTP methods and paths that are permitted

### Official Presets (NVIDIA)

Ready-made network policy bundles for common services:

| Preset | Access Granted |
|--------|---------------|
| `discord` | Discord API, gateway, CDN |
| `docker` | Docker Hub and NVIDIA registry |
| `huggingface` | Hugging Face Hub and inference |
| `jira` | Atlassian Cloud |
| `npm` | npm and Yarn registries |
| `outlook` | Microsoft Graph and Outlook |
| `pypi` | Python package endpoints |
| `slack` | Slack API and webhooks |
| `telegram` | Telegram Bot API |

### Community Presets

| Preset | Access Granted |
|--------|---------------|
| `gitlab` | GitLab API via `/api/v4/**` |
| `notion` | Notion API via `/v1/**` |
| `linear` | Linear GraphQL via `/graphql` |
| `confluence` | Confluence and Atlassian API |
| `teams` | Microsoft Teams and Graph API |
| `zendesk` | Zendesk API with tenant scoping |
| `sentry` | Sentry API and ingestion |
| `stripe` | Stripe API via `/v1/**` |
| `cloudflare` | Cloudflare API via `/client/v4/**` |
| `google-workspace` | OAuth, Gmail, Drive, Calendar |
| `aws` | STS, S3, and Bedrock API |
| `gcp` | OAuth, Cloud Storage, Vertex AI |
| `vercel` | Vercel deployment API |
| `supabase` | Supabase REST, Auth, Storage |
| `neon` | Neon API via `/api/v2/**` |
| `airtable` | Airtable API via `/v0/**` |
| `hubspot` | HubSpot CRM and OAuth |

### Static vs Dynamic Policy Changes

**Static changes** -- Modify the baseline policy YAML and re-run setup:

```bash
# Edit the policy file
vim nemoclaw-blueprint/policies/openclaw-sandbox.yaml

# Re-apply
nemoclaw setup
```

**Dynamic changes** -- Update a running sandbox without restart:

```bash
# Add a policy preset at runtime
openshell policy-add <preset-name>

# List active policies
openshell policy-list
```

---

## Blueprint System

The blueprint is the core orchestration mechanism in NemoClaw. It is a versioned Python
artifact that contains all logic for sandbox creation, policy application, and inference
configuration.

### Blueprint Lifecycle

```
resolve -> verify -> plan -> apply -> status
```

1. **Resolve** -- Find the correct blueprint version (from OCI registry or cache)
2. **Verify** -- Check digest integrity and compatibility with OpenShell/OpenClaw versions
3. **Plan** -- Determine what resources to create/update
4. **Apply** -- Execute through OpenShell CLI commands
5. **Status** -- Report health and state

### Blueprint Manifest (`blueprint.yaml`)

The manifest defines:
- Blueprint version
- Minimum compatible OpenShell and OpenClaw versions
- Available inference profiles
- Sandbox configuration

### Blueprint Directory

```
nemoclaw-blueprint/
  +-- blueprint.yaml              # Manifest
  +-- policies/
  |     +-- openclaw-sandbox.yaml # Network/filesystem/process policies
  +-- runner.py                   # Blueprint execution logic
```

---

## Plugin Architecture

The NemoClaw plugin is a TypeScript package that integrates with the OpenClaw CLI:

```
nemoclaw/
  +-- src/
  |     +-- index.ts                    # Plugin entry -- registers all commands
  |     +-- cli.ts                      # Commander.js subcommand wiring
  |     +-- commands/
  |     |     +-- launch.ts             # Fresh install into OpenShell
  |     |     +-- connect.ts            # Interactive shell into sandbox
  |     |     +-- status.ts             # Blueprint run state + sandbox health
  |     |     +-- logs.ts               # Stream blueprint and sandbox logs
  |     |     +-- slash.ts              # /nemoclaw chat command handler
  |     +-- blueprint/
  |           +-- resolve.ts            # Version resolution, cache management
  |           +-- fetch.ts              # Download blueprint from OCI registry
  |           +-- verify.ts             # Digest verification, compatibility checks
  |           +-- exec.ts               # Subprocess execution of blueprint runner
  |           +-- state.ts              # Persistent state (run IDs)
  +-- openclaw.plugin.json              # Plugin manifest
  +-- package.json                      # Commands under openclaw.extensions
```

### Why Two Layers?

NemoClaw feels "split" because it separates:
- A **thin TypeScript plugin** for UX/CLI (stable, user-facing)
- A **blueprint execution layer** for sandbox orchestration (evolving, Python-based)

This allows the blueprint to iterate independently of the CLI interface.

---

## DGX Spark Deployment

DGX Spark is a primary deployment target for NemoClaw. It has specific setup requirements
due to its Ubuntu 24.04 / Docker 28.x / cgroup v2 environment.

### Quick Start on Spark

```bash
# Clone and install
git clone https://github.com/NVIDIA/NemoClaw.git
cd NemoClaw
sudo npm install -g .

# Spark-specific setup
nemoclaw setup-spark
```

### What `setup-spark` Handles

1. **Docker permissions** -- Adds user to `docker` group
2. **cgroup v2 compatibility** -- Sets `"default-cgroupns-mode": "host"` in Docker daemon.json
3. **Restarts Docker** -- Applies the cgroup fix
4. **Runs standard onboarding** -- Gateway, providers, sandbox

### Known DGX Spark Issues

| Issue | Status | Workaround |
|-------|--------|------------|
| cgroup v2 kills k3s in Docker | Fixed in `setup-spark` | `daemon.json` cgroupns=host |
| Docker permission denied | Fixed in `setup-spark` | `usermod -aG docker` |
| CoreDNS CrashLoop after setup | Fixed in `fix-coredns.sh` | Uses container gateway IP |
| Image pull failure | OpenShell bug | Destroy and restart gateway |
| GPU passthrough | Untested | Should work with `--gpu` flag |

---

## Enterprise Ecosystem and Partnerships

NVIDIA has been pitching NemoClaw to major enterprise software companies:

### Reported Outreach

Jensen Huang has reportedly pitched NemoClaw to:
- Salesforce
- Cisco
- Google
- Adobe
- CrowdStrike

### Announced Integrations

| Partner | Integration |
|---------|------------|
| **CrowdStrike** | Falcon platform integrated into OpenShell -- endpoint protection, cloud runtime protection, AI policy enforcement |
| **Cisco** | AI Defense with OpenShell -- behavioral verification, tool catalog enforcement, continuous compliance |
| **Trend Micro** | TrendAI -- governance, risk visibility, runtime enforcement across agent lifecycle |
| **Cohesity** | Data resilience -- threat analysis orchestration, automated incident response |
| **ibl.ai** | Higher education -- NeMo Guardrails + NIM for campus AI agents with role-based access |

### Enterprise Use Cases

- **Secure coding agents** -- Run Claude Code, OpenCode, or OpenClaw with constrained access
- **Private enterprise development** -- Route inference to self-hosted backends
- **Compliance and audit** -- YAML policies as version-controlled security controls
- **Reusable environments** -- Community sandbox images or custom containerized runtimes
- **Financial services** -- Regulated workflows with audit trails
- **Healthcare** -- PII-compliant agent operations

---

## Community and Ecosystem

### Awesome NemoClaw

The community has already created [awesome-nemoclaw](https://github.com/VoltAgent/awesome-nemoclaw),
a curated collection of presets, recipes, and playbooks:

- **Policy presets** for 20+ services (official + community)
- **Agent recipes** -- Approval-first web agent, sandbox monitoring, Telegram support bot
- **Templates** -- Baseline sandbox policy, container build structure, bootstrap scripts
- **Deployment patterns** -- Remote GPU assistant, runtime model-switching

### Active Development (as of March 2026)

The GitHub repository shows intense development activity:
- 157 open PRs
- 237 open issues
- 131 workflow runs
- Active features in development:
  - Unattended/CI install support (PR #225)
  - Non-interactive mode for CI/CD onboarding (PR #318)
  - Apple Silicon Mac support (PR #285)
  - LM Studio integration (PR #312)
  - Ollama local inference management (PR #295)
  - Jetson Nano/Orin support (PR #249)
  - GPU detection for Jetson Thor/Orin (PR #308)
  - Additional inference providers: Bitdeer (PR #299), Baseten (PR #287)

### Community Interest Areas

Looking at open issues and PRs:
- WSL2 support improvements
- macOS runtime support
- DGX Spark documentation and setup
- Security hardening (Telegram bridge, credential handling)
- Additional service presets (HeyGen, etc.)

---

## Comparison: NemoClaw vs OpenClaw vs NanoClaw

For comparison with the community-maintained NanoClaw, see [[03-OpenFang-Community-Fork]].

| Feature | OpenClaw | NemoClaw | NanoClaw |
|---------|----------|----------|----------|
| **Focus** | Full-featured agent framework | Enterprise security for OpenClaw | Lightweight sandboxed OpenClaw |
| **Codebase** | ~500K lines, 70+ deps | Plugin on top of OpenClaw | Stripped-down fork |
| **Security** | None built-in | Kernel-level isolation, policy engine | Docker container isolation |
| **Sandbox** | None | OpenShell (Landlock + seccomp + netns) | Docker Sandbox |
| **Inference** | Direct API calls | Routed through OpenShell gateway | Standard |
| **Privacy** | None | PII stripping, policy-based routing | Container isolation |
| **Hardware** | Any | Optimized for NVIDIA (hardware-agnostic) | Any |
| **Models** | Any LLM | Nemotron family + any via profiles | Any LLM |
| **Enterprise** | Limited | Full governance, audit, compliance | Limited |
| **Status** | Production | Alpha | Community |
| **License** | Apache 2.0 | Apache 2.0 | Apache 2.0 |
| **Backing** | OpenAI (acquired) | NVIDIA | Docker/Community |

### Strategic Positioning

- **OpenClaw** = The "operating system" for personal AI agents
- **NemoClaw** = The enterprise-grade distribution with security and governance
- **NanoClaw** = The lightweight, container-first approach for developers

---

## Current Status and Limitations

### Alpha Status

NVIDIA is transparent that NemoClaw is early-stage:

> "Expect rough edges. We are building toward production-ready sandbox orchestration,
> but the starting point is getting your own environment up and running.
> Interfaces, APIs, and behavior may change without notice."

### Known Limitations

1. **Linux-primary** -- Full support on Linux only; macOS and Windows WSL are secondary
2. **No Podman on macOS** -- Depends on OpenShell support for Podman
3. **Local inference experimental** -- Ollama and vLLM on macOS need host-routing support
4. **Plugin commands in flux** -- `openclaw nemoclaw` commands under active development
5. **DGX Spark quirks** -- cgroup v2, CoreDNS, and image pull issues (documented workarounds)
6. **API key exposure** -- Issue #325: NVIDIA API key visible in process list (fix in PR #330)
7. **PATH issues** -- nvm-installed Node.js may not update shell PATH (fix in PR #228)
8. **No GPU passthrough tested** on DGX Spark yet

### What NemoClaw Is Not

- **Not a standalone agent framework** -- Requires OpenClaw
- **Not a replacement for OpenClaw** -- An add-on/wrapper
- **Not production-ready** -- Alpha software
- **Not NVIDIA-exclusive** -- Hardware-agnostic, though optimized for NVIDIA platforms

---

## Roadmap and Future Direction

Based on active PRs, issues, and NVIDIA's broader strategy:

### Near-Term (Q1-Q2 2026)

- Production-ready sandbox orchestration
- Full macOS Apple Silicon support
- Jetson Nano/Orin support for edge agents
- CI/CD non-interactive installation mode
- Additional inference providers (LM Studio, Bitdeer, Baseten)
- Managed local Ollama inference
- Security hardening (credential handling, Telegram bridge)

### Mid-Term (2026)

- Integration with NeMo Guardrails for agent safety
- Improved memory interface for self-improving agents
- NVIDIA Dynamo integration for reduced LLM latency at scale
- Automatic RL fine-tuning of LLMs for specific agents
- KV-Cache optimization for improved agent throughput
- Full observability and telemetry integration

### Strategic Direction

- Establish NemoClaw/OpenShell as the standard agent runtime for enterprises
- Build ecosystem of security vendor integrations (CrowdStrike, Cisco, Trend Micro)
- Position DGX Spark as the "agent computer" for enterprise AI
- Expand from coding agents to general enterprise automation
- Create the "Kubernetes moment" for agentic AI infrastructure

---

## Key Links and Sources

### Official Resources

| Resource | URL |
|----------|-----|
| GitHub Repository | https://github.com/NVIDIA/NemoClaw |
| Developer Guide | https://docs.nvidia.com/nemoclaw/latest/ |
| NVIDIA NemoClaw Product Page | https://www.nvidia.com/en-us/ai/nemoclaw/ |
| Press Release | https://nvidianews.nvidia.com/news/nvidia-announces-nemoclaw |
| NVIDIA blog (OpenShell) | https://developer.nvidia.com/blog/run-autonomous-self-evolving-agents-more-safely-with-nvidia-openshell/ |
| NeMo Agent Toolkit | https://github.com/NVIDIA/NeMo-Agent-Toolkit |
| OpenShell Docs | https://docs.nvidia.com/openshell/latest/about/overview.html |
| NIM APIs | https://build.nvidia.com/ |

### News and Analysis

| Source | URL |
|--------|-----|
| The New Stack | https://thenewstack.io/nemoclaw-openclaw-with-guardrails/ |
| TechCrunch | https://techcrunch.com/2026/03/16/nvidias-version-of-openclaw-could-solve-its-biggest-problem-security/ |
| WIRED (pre-announcement) | https://www.wired.com/story/nvidia-planning-ai-agent-platform-launch-open-source/ |
| The Register | https://www.theregister.com/2026/03/16/nvidia_wraps_its_nemoclaw_around/ |
| Mashable | https://mashable.com/article/nvidida-nemoclaw-what-it-is-how-to-try-it |
| DEV Community Comparison | https://dev.to/mechcloud_academy/architecting-the-agentic-future-openclaw-vs-nanoclaw-vs-nvidias-nemoclaw-9f8 |

### Community Resources

| Resource | URL |
|----------|-----|
| Awesome NemoClaw | https://github.com/VoltAgent/awesome-nemoclaw |
| NemoClaw Issues | https://github.com/NVIDIA/NemoClaw/issues |
| NemoClaw PRs | https://github.com/NVIDIA/NemoClaw/pulls |

---

## Wikilinks

- [[01-OpenClaw-Core-Architecture]] -- OpenClaw core architecture and agent platform
- [[03-OpenFang-Community-Fork]] -- NanoClaw and community forks
- [[04-Skill-System-Tool-Creation]] -- OpenClaw skill system and MCP integration

---

*Research compiled March 19, 2026. NemoClaw is in active alpha development -- details
may change rapidly. Sources include NVIDIA official announcements, GitHub repository,
developer documentation, and technology press coverage from GTC 2026.*
