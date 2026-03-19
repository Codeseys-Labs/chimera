# OpenFang: The Community-Born Agent Operating System

> **Status:** Research complete | **Date:** 2026-03-19
> **Repository:** [RightNow-AI/openfang](https://github.com/RightNow-AI/openfang)
> **Website:** [openfang.sh](https://openfang.sh/)
> **License:** Apache 2.0 (originally MIT, changed to Apache 2.0)
> **Created:** 2026-02-24 | **Latest Release:** v0.4.9 (2026-03-18)
> **Stars:** ~14,900 | **Forks:** ~1,772 | **Contributors:** 22

---

## Table of Contents

- [[#Overview]]
- [[#Origin Story and Relationship to OpenClaw]]
- [[#What Makes OpenFang Different]]
- [[#Architecture Deep Dive]]
- [[#The Hands System Core Innovation]]
- [[#Security Model 16 Layers]]
- [[#Skill System and FangHub Marketplace]]
- [[#MCP and A2A Protocol Support]]
- [[#Migration Engine from OpenClaw]]
- [[#Memory System]]
- [[#Desktop Application]]
- [[#Performance Benchmarks]]
- [[#Community and Contributor Ecosystem]]
- [[#Comparison with OpenClaw and NemoClaw]]
- [[#Ecosystem and Third-Party Projects]]
- [[#Code Examples]]
- [[#Current Limitations and Roadmap]]
- [[#Sources and References]]

---

## Overview

OpenFang is an **open-source Agent Operating System** built entirely from scratch in Rust. Unlike the vast majority of AI agent frameworks that wrap Python around an LLM API, OpenFang positions itself as a true operating system for autonomous agents -- treating long-running agents as first-class citizens with lifecycle hosting, layered security, observability, and a reusable skills/tools ecosystem.

The project compiles 137,000 lines of Rust across 14 crates into a single ~32MB binary. It ships with 7 autonomous "Hands" (pre-built capability packages), 40 messaging channel adapters, 53 built-in tools, 60 bundled skills, and support for 27 LLM providers with 123+ models.

OpenFang is **not a fork of OpenClaw** in the traditional sense (it shares no code). Rather, it was built from scratch as an independent project inspired by OpenClaw's vision but with a fundamentally different architecture and philosophy. The creator, Jaber (GitHub: `jaberjaber23`), founder of RightNow AI, has been explicit about this: *"We love OpenClaw and it inspired a lot of what we built, but we wanted something that works at the kernel level."*

**Key differentiators at a glance:**

| Metric | OpenFang | OpenClaw |
|--------|----------|----------|
| Language | Rust (88.1%) | TypeScript (88.1%) |
| Binary Size | ~32 MB | ~500 MB + Node.js |
| Memory (idle) | ~40 MB | ~394 MB |
| Cold Start | ~180 ms | ~6 s |
| Security Layers | 16 | 3 |
| Channel Adapters | 40 | 13 |
| Autonomous Hands | 7 built-in | None |
| Agent Sandbox | WASM dual-metered | None |
| Desktop App | Tauri 2.0 | None |
| Audit Trail | Merkle hash-chain | Logs |

---

## Origin Story and Relationship to OpenClaw

### The OpenClaw Phenomenon

OpenClaw (see [[01-OpenClaw-Core-Architecture]]) launched in November 2025 as "Clawdbot" by Austrian developer Peter Steinberger. It grew from 0 to 321,000+ GitHub stars in record time, surpassing React's 10-year record in just 60 days. OpenClaw demonstrated that there was massive demand for a self-hosted, always-on AI assistant that connects to messaging platforms you already use.

However, OpenClaw's architecture -- a TypeScript/Node.js gateway with file-based memory, basic sandboxing, and a reactive chat-driven model -- started showing limitations as users pushed it toward production autonomous workloads:

- **Memory footprint:** ~394 MB idle, ~500 MB install with Node.js dependency
- **Security:** Only 3 basic security layers, no WASM sandboxing, no audit trails
- **Autonomy:** Fundamentally reactive -- waits for user input rather than running autonomous scheduled tasks
- **Performance:** ~6 second cold start, TypeScript runtime overhead

### OpenFang's Genesis

OpenFang was created by **Jaber** (GitHub: [@jaberjaber23](https://github.com/jaberjaber23)), founder of [RightNow AI](https://rightnowai.co), and first released on **February 24, 2026**. The project was not born as a fork but as a **clean-room reimplementation** that took OpenClaw's concept of a personal AI assistant and reconceived it at the operating system level.

From Jaber's LinkedIn announcement:

> "We open-sourced an operating system for AI agents. 137k lines of Rust, MIT licensed. We love OpenClaw and it inspired a lot of what we built. But we wanted something that works at the kernel level. Agents run inside WASM sandboxes the same way processes run on Linux. The kernel schedules them, isolates them, meters their resources, and kills them if they go rogue."

The project has shipped at an extraordinary pace: **79 releases** between February 24 and March 18, 2026 -- nearly 3.5 releases per day over its first 22 days of existence.

### The Naming Convention

The "-Fang" in OpenFang is a deliberate callback to OpenClaw. Where OpenClaw uses the lobster claw metaphor (with its "EXFOLIATE! EXFOLIATE!" tagline), OpenFang positions itself as a more aggressive, predatory counterpart -- fangs being sharper and more decisive than claws. This naming pattern has spawned an entire ecosystem of "-Claw" and related projects: ZeroClaw, NullClaw, FastClaw, NanoClaw, LibreFang, etc.

> **Note:** There is an older, unrelated project at [anmaped/openfang](https://github.com/anmaped/openfang) -- a bootloader/kernel/toolchain for Xiaomi and Wyze security cameras using Ingenic T10/T20 SoCs. This is a completely separate project with no relation to the AI agent OS.

---

## What Makes OpenFang Different

OpenFang's fundamental thesis is that **agents should be treated like operating system processes, not chatbot sessions**. This manifests in several architectural decisions:

### 1. Agent OS vs. Agent Framework

Traditional agent frameworks (including OpenClaw) are libraries: you write code, call a flow, send a message, and wait for a result. OpenFang acts as a **system**:

- It has an **Integration Layer** (`openfang-channels`) connecting agents to 40 platforms
- It has a **Persistent Substrate** (`openfang-memory`) built on SQLite for sessions/memory/embeddings
- It has a **Runtime** (`openfang-runtime`) handling agent loops, LLM drivers, tool runners, and sandboxing
- It has a **Kernel** (`openfang-kernel`) responsible for assembling subsystems, scheduling, RBAC, metering, and budget tracking

This is a fundamentally different abstraction level. OpenClaw is more like "Super Chatbot + Skill Extensions," while OpenFang treats agents as background daemon processes.

### 2. Autonomous Hands vs. Reactive Chat

OpenClaw's agents wait for you to type something. OpenFang's Hands work for you autonomously -- running on schedules, 24/7, building knowledge graphs, monitoring targets, and reporting results to a dashboard.

### 3. Rust vs. TypeScript

The choice of Rust gives OpenFang:
- **10x lower memory footprint** (40 MB vs 394 MB)
- **33x faster cold start** (180 ms vs 6 s)
- **15x smaller binary** (32 MB vs 500 MB)
- **Memory safety guarantees** without garbage collection
- **Single binary distribution** -- no Node.js, no npm, no runtime dependencies

### 4. Security-First Design

OpenFang has 16 discrete security layers compared to OpenClaw's 3 basic layers. Every layer operates independently, and security is baked into the core rather than bolted on after the fact. See [[#Security Model 16 Layers]] for the full breakdown.

---

## Architecture Deep Dive

### 14-Crate Workspace

OpenFang's 137,728 lines of code are organized into 14 Rust crates in a Cargo workspace. Each crate has a specific responsibility, creating clean architectural boundaries:

```
openfang-kernel       Orchestration, workflows, metering, RBAC, scheduler, budget tracking
openfang-runtime      Agent loop, 3 LLM drivers, 53 tools, WASM sandbox, MCP, A2A
openfang-api          140+ REST/WS/SSE endpoints, OpenAI-compatible API, dashboard
openfang-channels     40 messaging adapters with rate limiting, DM/group policies
openfang-memory       SQLite persistence, vector embeddings, canonical sessions, compaction
openfang-types        Core types, taint tracking, Ed25519 manifest signing, model catalog
openfang-skills       60 bundled skills, SKILL.md parser, FangHub marketplace
openfang-hands        7 autonomous Hands, HAND.toml parser, lifecycle management
openfang-extensions   25 MCP templates, AES-256-GCM credential vault, OAuth2 PKCE
openfang-wire         OFP P2P protocol with HMAC-SHA256 mutual authentication
openfang-cli          CLI: daemon management, TUI dashboard, MCP server mode
openfang-desktop      Tauri 2.0 native app (system tray, notifications, global shortcuts)
openfang-migrate      OpenClaw, LangChain, AutoGPT migration engine
xtask                 Build automation
```

### Architectural Layers

The architecture follows a layered kernel design where each layer has well-defined responsibilities:

```
                    User Interactions
                         |
            +------------+-------------+
            |                          |
     openfang-cli              openfang-desktop
     (Terminal TUI)            (Tauri 2.0 GUI)
            |                          |
            +------------+-------------+
                         |
                   openfang-api
              (140+ REST/WS/SSE endpoints)
              (OpenAI-compatible API)
              (Web dashboard)
                         |
                   openfang-kernel
              (Orchestration core)
              (RBAC, metering, scheduling)
              (Workflow engine)
              (Budget tracking)
                         |
            +------+-----+------+------+
            |      |            |      |
     runtime  channels    memory   hands
     (Agent   (40 msg    (SQLite  (7 auto
      loop)    adapters)  + vec)   Hands)
            |      |            |      |
            +------+-----+------+------+
                         |
            +------+-----+------+
            |      |            |
        types   skills    extensions
        (Core  (60 skills  (25 MCP
         types) + parser)  templates)
            |      |            |
            +------+-----+------+
                         |
                   openfang-wire
              (OFP P2P protocol)
              (HMAC-SHA256 auth)
```

### LLM Provider Support

OpenFang supports 27 LLM providers via 3 native drivers (Anthropic, Gemini, OpenAI-compatible):

Anthropic, Gemini, OpenAI, Groq, DeepSeek, OpenRouter, Together, Mistral, Fireworks, Cohere, Perplexity, xAI, AI21, Cerebras, SambaNova, HuggingFace, Replicate, Ollama, vLLM, LM Studio, Qwen, MiniMax, Zhipu, Moonshot, Qianfan, Bedrock, and more.

The system includes **intelligent routing** with task complexity scoring, automatic fallback chains, cost tracking, and per-model pricing.

### OpenAI-Compatible API

OpenFang provides a **drop-in replacement** for the OpenAI API, meaning existing tools and integrations work without changes:

```bash
curl http://127.0.0.1:4200/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "researcher",
    "messages": [{"role": "user", "content": "Analyze Q4 market trends"}],
    "stream": true
  }'
```

The API exposes **140+ REST/WS/SSE endpoints** covering agents, memory, workflows, channels, models, skills, A2A, Hands, and more.

---

## The Hands System Core Innovation

Hands are OpenFang's most distinctive innovation and the primary reason it calls itself an "Agent Operating System" rather than an "Agent Framework." While OpenClaw (see [[01-OpenClaw-Core-Architecture]]) and NemoClaw (see [[02-NemoClaw-NVIDIA-Fork]]) provide tools that the user drives through conversation, Hands are autonomous agents that **work for you without prompting**.

### What is a Hand?

A Hand is a pre-built autonomous capability package that:
- Runs on a **schedule** (not triggered by user messages)
- Builds and maintains **knowledge graphs**
- Reports results to a **dashboard**
- Bundles a complete operational context:
  - `HAND.toml` manifest (tools, settings, requirements)
  - System prompt with multi-phase operational playbook
  - `SKILL.md` expert knowledge
  - Configurable settings
  - Dashboard metrics

All Hands are compiled directly into the binary at build time, ensuring consistency and reliability.

### The 7 Built-in Hands

#### 1. Clip (Content)
Turns long-form video into viral short clips:
- 8-phase pipeline: download, analyze, segment, extract, caption, thumbnail, voiceover, publish
- FFmpeg + yt-dlp integration
- 5 speech-to-text backends
- Auto-publish to Telegram and WhatsApp
- AI-generated captions and thumbnails
- Optional AI voice-overs

#### 2. Lead (Data)
Autonomous lead generation and qualification:
- Daily discovery of qualified leads matching Ideal Customer Profile (ICP)
- Web research loops for enrichment
- 0-100 ICP scoring system
- Deduplication against existing databases
- CSV/JSON/Markdown export
- Scheduled delivery to dashboard or channels

#### 3. Collector (Intelligence)
OSINT-style intelligence collection:
- Continuous monitoring of specified targets
- Change detection with diff analysis
- Sentiment tracking over time
- Knowledge graph construction
- Critical change alerts
- Multi-source correlation

#### 4. Predictor (Forecasting)
Superforecasting engine:
- Multi-source signal collection
- Calibrated reasoning chains
- Predictions with confidence intervals
- Brier score tracking for accuracy calibration
- Historical prediction evaluation
- Trend analysis across data streams

#### 5. Researcher (Research)
Deep autonomous research agent:
- Cross-references multiple sources
- CRAAP (Currency, Relevance, Authority, Accuracy, Purpose) credibility evaluation
- APA-format cited reports
- Multi-language support
- Source triangulation
- Generates comprehensive research documents

#### 6. Twitter (Social)
Autonomous X/Twitter account management:
- 7 rotating content formats
- Optimal posting time scheduling
- Automated mention responses
- Approval queue for sensitive posts
- Performance metrics tracking
- Content strategy optimization

#### 7. Browser (Automation)
Web automation agent:
- Playwright bridge for browser control
- Multi-step workflow navigation
- Form filling and button clicking
- Session persistence across runs
- CAPTCHA detection
- **Mandatory purchase approval gate** (security feature preventing unauthorized transactions)

### Hand CLI

```bash
# Activate a Hand (spawns autonomous agent)
openfang hand activate researcher

# Check Hand metrics and status
openfang hand status researcher

# Pause/resume a running Hand
openfang hand pause researcher
openfang hand resume researcher

# Deactivate (stop) a Hand
openfang hand deactivate researcher

# List all available Hands
openfang hand list
```

### Building Custom Hands

OpenFang supports building custom Hands via the `HAND.toml` format:

```toml
[hand]
name = "my-custom-hand"
version = "0.1.0"
description = "My custom autonomous capability"

[hand.tools]
required = ["web_search", "file_write"]

[hand.settings]
schedule = "0 9 * * *"  # Every day at 9 AM
model = "claude-sonnet-4-20250514"

[hand.requirements]
min_memory = "64MB"
```

Custom Hands can be published to **FangHub**, the OpenFang marketplace.

---

## Security Model 16 Layers

OpenFang's security model is one of its strongest differentiators. With 16 discrete security systems, it offers defense-in-depth that operates at the kernel level. Each layer functions independently, meaning a breach in one layer does not compromise the others.

From the project's philosophy: *"Giving an LLM tools with zero isolation is insane and we're not doing it."*

### Complete Security Layer Inventory

| # | Layer | Description |
|---|-------|-------------|
| 1 | **WASM Dual-Metered Sandbox** | Tool code executes in WebAssembly with fuel metering AND epoch interruption. Prevents runaway code from consuming resources. |
| 2 | **Merkle Hash-Chain Audit Trail** | Every action is cryptographically linked to the previous one. Tampering with any record invalidates the entire chain. |
| 3 | **Information Flow Taint Tracking** | Propagates labels through execution paths to track secrets. Prevents accidental leakage of sensitive data. |
| 4 | **Ed25519 Signed Agent Manifests** | Agent identities and capability sets are cryptographically signed. Prevents unauthorized agent impersonation. |
| 5 | **SSRF Protection** | Blocks outbound requests to private IPs, localhost, link-local addresses, and cloud metadata endpoints (169.254.169.254). |
| 6 | **Secret Zeroization** | API keys are automatically wiped from memory using `Zeroizing<String>` when no longer needed. Prevents memory scraping. |
| 7 | **OFP Mutual Authentication** | HMAC-SHA256 nonce-based authentication for P2P networking. Both sides must prove identity. |
| 8 | **Capability Gates** | RBAC requiring explicit capability grants for agent operations. Agents can only access what they're authorized to use. |
| 9 | **Security Headers** | CSP, X-Frame-Options, HSTS, X-Content-Type-Options, and other headers in all HTTP responses. |
| 10 | **Health Endpoint Redaction** | Public health checks return minimal information, preventing information leakage about internal state. |
| 11 | **Subprocess Sandbox** | Child processes have environment variables cleared with selective passthrough. Prevents credential leakage to subprocesses. |
| 12 | **Prompt Injection Scanner** | Detects override attempts, data exfiltration patterns, and shell reference injection in prompts. |
| 13 | **Loop Guard** | SHA256-based tool call loop detection with circuit breaker. Prevents infinite loops from burning API credits. |
| 14 | **Session Repair** | 7-phase message history validation with automatic recovery from corruption. Ensures session integrity. |
| 15 | **Path Traversal Prevention** | Canonicalizes file paths and prevents symlink escapes. Prevents agents from accessing unauthorized file system locations. |
| 16 | **GCRA Rate Limiter** | Cost-aware token bucket rate limiting with per-IP tracking. Generic Cell Rate Algorithm prevents abuse. |

### WASM Sandbox Deep Dive

The WASM sandbox deserves special attention as it's analogous to how Linux isolates processes:

```
+--------------------------------------------------+
|                  OpenFang Kernel                   |
|                                                    |
|  +-------------+  +-------------+  +------------+ |
|  | Agent A      |  | Agent B      |  | Agent C    | |
|  | (WASM)       |  | (WASM)       |  | (WASM)     | |
|  | fuel: 10000  |  | fuel: 5000   |  | fuel: 8000 | |
|  | epoch: 30s   |  | epoch: 15s   |  | epoch: 60s | |
|  +-------------+  +-------------+  +------------+ |
|        |                |                |         |
|  Capability Gates  Capability Gates  Cap. Gates    |
|        |                |                |         |
|  [web, file]      [web only]       [all tools]    |
+--------------------------------------------------+
```

Each agent runs in its own WASM sandbox with:
- **Fuel metering:** A budget of computation units. When exhausted, execution halts.
- **Epoch interruption:** A wall-clock timeout. Regardless of fuel, execution is interrupted after the epoch expires.
- **Capability mapping:** The agent's manifest defines which capabilities (tools, APIs, file paths) are available inside the sandbox.

---

## Skill System and FangHub Marketplace

### SKILL.md Format

OpenFang reads `SKILL.md` natively -- the same format used by [[01-OpenClaw-Core-Architecture|OpenClaw]], Claude Code, and Codex. This provides instant compatibility with the existing OpenClaw skill ecosystem.

Skills in OpenFang can be:
- **Prompt-only:** Instructions and context for the LLM
- **Executable:** Python or Node.js tools that run in the sandbox
- **MCP-based:** External tools connected via Model Context Protocol servers

### 60 Bundled Skills

OpenFang ships with 60 built-in skills covering common agent capabilities. These are compiled into the binary and available immediately.

### FangHub Marketplace

FangHub is OpenFang's native skill marketplace. It coexists with OpenClaw's ClawHub:

- OpenFang can **read and install skills from ClawHub** (OpenClaw's marketplace)
- FangHub provides additional OpenFang-specific skills and Hands
- Custom skills can be published to FangHub for community distribution

### ClawHub Compatibility

The `openfang-skills` crate includes a ClawHub client, enabling OpenFang to:
- Search for skills on ClawHub
- Install OpenClaw skills directly
- Use `SKILL.md` files without modification

This backward compatibility was a deliberate design decision to lower the migration barrier from OpenClaw.

---

## MCP and A2A Protocol Support

### Model Context Protocol (MCP)

OpenFang implements MCP as both **client and server**:

- **Client:** Connect to external MCP servers (GitHub, filesystem, databases, custom tools)
- **Server:** Expose OpenFang tools to other MCP-compatible systems

The `openfang-extensions` crate provides **25 pre-built MCP templates** for common integrations. The kernel maintains `mcp_connections` and `mcp_tools` registries for managing these integrations dynamically.

### Agent-to-Agent Protocol (A2A)

OpenFang implements Google's A2A protocol for inter-agent communication:

- **Agent Cards:** JSON descriptors defining each agent's capabilities, authentication, and endpoints
- **Task Lifecycle:** Create, update, and complete tasks between agents
- **Cross-instance communication:** Different OpenFang instances (or any A2A-compatible agent) can collaborate

The runtime includes `A2aTaskStore` for tracking task lifecycles and `a2a_external_agents` for discovered agents.

### OpenFang Protocol (OFP)

Unique to OpenFang, OFP is a **peer-to-peer agent networking protocol**:

- HMAC-SHA256 mutually authenticated JSON frame protocol
- Enables direct agent-to-agent communication without a central server
- Implemented in the `openfang-wire` crate
- Both sides must prove identity before communication begins

---

## Migration Engine from OpenClaw

One of OpenFang's most strategically important features is its one-command migration from OpenClaw. The `openfang-migrate` crate handles:

### What Gets Migrated

- **Agent configurations:** Converts `agent.yaml` to `agent.toml`
- **Conversation history:** Full message history import
- **Skills:** All `SKILL.md` files and workspace skills
- **Channel configurations:** Mapping OpenClaw channels to OpenFang adapters
- **Memory:** File-based memory converted to SQLite
- **Configuration:** Settings, API keys, preferences

### Migration Commands

```bash
# Full migration from OpenClaw
openfang migrate --from openclaw

# Migrate from a specific OpenClaw installation path
openfang migrate --from openclaw --path ~/.openclaw

# Preview what would change (safe)
openfang migrate --from openclaw --dry-run
```

### Additional Migration Sources

The migration engine also supports:
- **LangChain** projects
- **AutoGPT** configurations

This positions OpenFang as a "graduation path" for users outgrowing other frameworks.

---

## Memory System

The `openfang-memory` crate implements a production-grade persistence layer:

### Storage Backend

- **SQLite** as the primary storage engine (no external database needed)
- **Vector embeddings** for semantic search and retrieval
- **Canonical sessions** with compaction for efficient long-term storage

### Capabilities

- Session persistence across restarts
- Knowledge graph construction (used by Hands like Collector and Researcher)
- Memory compaction to prevent unbounded growth
- Vector-based semantic recall
- Agent-scoped memory isolation (agents don't see each other's memories)

### Comparison with OpenClaw

| Feature | OpenFang | OpenClaw |
|---------|----------|----------|
| Storage | SQLite + vector embeddings | File-based Markdown |
| Search | Semantic (vector) + full-text | File system scan |
| Persistence | Built-in, automatic | Manual save/load |
| Compaction | Automatic | None |
| Knowledge Graphs | Built-in | None |

---

## Desktop Application

OpenFang includes a native desktop application built with **Tauri 2.0**:

- **System tray integration** -- runs as a background process
- **Notifications** -- native OS notifications for agent events
- **Single-instance enforcement** -- prevents duplicate processes
- **Auto-start on login** -- configurable launch at system startup
- **Global shortcuts** -- keyboard shortcuts accessible from any application
- **Full dashboard** in a native window (WebView-based)
- **IPC** for communication between the frontend and the Rust backend

The desktop app launches the kernel and Axum server in background threads, providing a local management interface.

---

## Performance Benchmarks

All benchmarks from official documentation and public repositories (February-March 2026):

### Cold Start Time (lower is better)

```
ZeroClaw    10 ms
OpenFang    180 ms
LangGraph   2,500 ms
CrewAI      3,000 ms
AutoGen     4,000 ms
OpenClaw    5,980 ms
```

### Idle Memory Usage (lower is better)

```
ZeroClaw    5 MB
OpenFang    40 MB
LangGraph   180 MB
CrewAI      200 MB
AutoGen     250 MB
OpenClaw    394 MB
```

### Install Size (lower is better)

```
ZeroClaw    8.8 MB
OpenFang    32 MB
CrewAI      100 MB
LangGraph   150 MB
AutoGen     200 MB
OpenClaw    500 MB
```

### Security Systems (higher is better)

```
OpenFang    16 layers
ZeroClaw    6 layers
OpenClaw    3 layers
AutoGen     2 layers
LangGraph   2 layers
CrewAI      1 layer
```

### Channel Adapters (higher is better)

```
OpenFang    40 built-in
ZeroClaw    15 built-in
OpenClaw    13 built-in
CrewAI      0
AutoGen     0
LangGraph   0
```

### Built-in Tools

```
OpenFang    53 + MCP + A2A
OpenClaw    50+
ZeroClaw    28 native
LangGraph   15 native
CrewAI      10 native
AutoGen     8 native
```

> **Note:** These benchmarks are sourced from OpenFang's own documentation and community comparison sites. Independent third-party benchmarks are limited given the project's young age. ZeroClaw's extreme performance numbers reflect its ultra-minimalist architecture.

---

## Community and Contributor Ecosystem

### Core Team

OpenFang is primarily built and maintained by **Jaber** ([@jaberjaber23](https://github.com/jaberjaber23)), founder of RightNow AI ([rightnowai.co](https://rightnowai.co)). He goes by [@Akashi203](https://x.com/Akashi203) on X/Twitter.

From a Hacker News discussion, the development process involves orchestrating up to 10-12 parallel AI coding sessions, with the founder providing all architecture decisions, interface contracts, and integration design.

### Contributors

As of March 2026, OpenFang has **22 contributors** (20 human + dependabot + Claude). The top contributors:

| Contributor | Role/Focus |
|-------------|-----------|
| `jaberjaber23` | Founder, primary architect, majority of commits |
| `dependabot[bot]` | Automated dependency updates |
| `Fail-Safe` | Community contributor |
| `houko` | Community contributor |
| `tsubasakong` | Community contributor |
| `AL-ZiLLA` | Community contributor |
| `zdianjiang` | Community contributor |
| `QiuYi111` | Community contributor |
| `KeysiJones` | Community contributor |
| `cryptonahue` | Community contributor |
| `tbaumann` | Community contributor |
| `zvictor` | Community contributor |
| `vnz` | Community contributor |
| `tuzkier` | Community contributor |
| `mdrissel` | Community contributor |
| `skymoore` | Community contributor |
| `psumo` | Community contributor |
| `claude` | AI pair programming contributor |

### Community Engagement

- **GitHub Issues:** 50 open issues as of March 2026
- **Release cadence:** 79 releases in 22 days (~3.5/day), indicating extremely active development
- **Community PR handling:** In v0.1.3, the team closed 6 issues and "reviewed and rebuilt 4 community PR ideas in-house" -- suggesting a pattern where community ideas are validated but implementation is done by the core team for consistency
- **Security reporting:** Email-based at `jaber@rightnowai.co` with 48-hour response commitment
- **Social media:** Active on X/Twitter, YouTube videos about the project have appeared

### Community Sentiment

From Reddit discussions (r/AIDeveloperNews, r/AI_Agents, r/LocalLLaMA):

**Positive:**
- "The agents and the subagents endpoints are good and overall the architecture is promising"
- Praised for Rust-based architecture and security emphasis
- Seen as a legitimate alternative to OpenClaw for production use

**Critical:**
- "The learning curve is steeper than lightweight alternatives"
- Concerns about breaking changes pre-v1.0
- Some skepticism about AI-generated code in the codebase
- Questions about sustainability with primarily single-maintainer project

### Development Velocity

The release history shows intense development:

- **v0.1.0** (2026-02-24): First release -- core platform, LLM support, channels, security, API
- **v0.1.3** (2026-03-01): Windows ARM64 support, dashboard theme switcher, cron fixes
- **v0.3.30** (2026-03-mid): Security hardening release
- **v0.4.0 - v0.4.9** (2026-03-mid to 03-18): Bug fixes, content blocks, streaming improvements

---

## Comparison with OpenClaw and NemoClaw

### OpenFang vs OpenClaw

| Dimension | OpenClaw | OpenFang |
|-----------|----------|----------|
| **Philosophy** | Personal AI assistant, chat-driven | Agent Operating System, autonomous |
| **Language** | TypeScript + Node.js | Pure Rust, 14 crates |
| **Architecture** | Gateway + Brain + Memory + Skills | Kernel + Runtime + API + 11 subsystems |
| **Agent Model** | Reactive (responds to messages) | Autonomous (runs on schedules) |
| **Memory** | File-based Markdown | SQLite + vector embeddings |
| **Security** | 3 basic layers | 16 discrete layers |
| **Sandbox** | None | WASM dual-metered |
| **Distribution** | npm package + Node.js runtime | Single 32MB binary |
| **Desktop** | None | Tauri 2.0 native app |
| **Maturity** | 4+ months, 321K+ stars, proven | 3 weeks, 14.9K stars, pre-1.0 |
| **Ecosystem** | Massive (1,075+ contributors, ClawHub) | Growing (22 contributors, FangHub) |
| **Enterprise** | AWS Lightsail managed, NemoClaw wrapper | Self-hosted only |
| **Skill Format** | SKILL.md (originator) | SKILL.md (compatible) + HAND.toml |

**Choose OpenClaw if:**
- Interactive chat is the primary use case
- Production stability is required today
- The npm ecosystem and quick setup matter
- Enterprise integrations (NemoClaw, AWS Lightsail) are needed

**Choose OpenFang if:**
- Autonomous scheduled workflows are the goal
- Security and audit trails are critical
- Resource efficiency matters (edge, Raspberry Pi, VPS)
- A desktop-native experience is desired
- You want kernel-level agent isolation

### OpenFang vs NemoClaw

NemoClaw (see [[02-NemoClaw-NVIDIA-Fork]]) is not a competitor to OpenFang -- it is a security wrapper around OpenClaw built by NVIDIA. The comparison is architectural:

| Dimension | NemoClaw | OpenFang |
|-----------|----------|----------|
| **What it is** | Enterprise security wrapper for OpenClaw | Independent Agent Operating System |
| **Relationship to OpenClaw** | Runs OpenClaw inside a sandbox | Inspired by, no shared code |
| **Security approach** | Container-based isolation (OpenShell) | WASM-based isolation (kernel-level) |
| **LLM support** | NVIDIA Nemotron models via cloud | 27 providers, 123+ models |
| **License** | Apache 2.0 | Apache 2.0 |
| **Runtime** | Docker + k3s + OpenShell | Single binary |
| **Autonomy** | Inherits OpenClaw's reactive model | 7 built-in autonomous Hands |

OpenFang and NemoClaw solve different problems: NemoClaw makes OpenClaw safe for enterprise use; OpenFang provides a fundamentally different architecture for autonomous agent workloads.

### The Three-Project Relationship

```
                    OpenClaw (TypeScript)
                    Personal AI Assistant
                    321K+ stars, MIT license
                   /                      \
                  /                        \
     NemoClaw (NVIDIA)              OpenFang (RightNow AI)
     Enterprise Security            Agent Operating System
     Wrapper around OpenClaw        Clean-room Rust rewrite
     Container isolation            WASM kernel isolation
     4.6K stars, Apache 2.0        14.9K stars, Apache 2.0
```

- **OpenClaw** is the foundational project -- a personal AI assistant
- **NemoClaw** wraps OpenClaw in enterprise security (see [[02-NemoClaw-NVIDIA-Fork]])
- **OpenFang** reimagines the concept as an operating system (independent codebase)

---

## Ecosystem and Third-Party Projects

The OpenFang ecosystem is young but growing. Projects tagged with the `openfang` topic on GitHub:

### LibreFang
- **Repository:** [librefang/librefang](https://github.com/librefang/librefang)
- Another open-source agent OS written in Rust
- Appears to be inspired by OpenFang's architecture

### openfang-auto-clip
- **Repositories:** Multiple forks/variants exist
- AI-driven automated video clipping pipeline
- Built on top of OpenFang's Clip Hand concept

### ok-skills
- **Repository:** [mxyhi/ok-skills](https://github.com/mxyhi/ok-skills)
- Curated AI coding agent skills and AGENTS.md playbooks
- Compatible with OpenClaw, OpenFang, Cursor, Claude Code, and other SKILL.md tools

### Community Content

- **YouTube:** Multiple videos covering OpenFang, including "This AI Works While You Sleep (OpenFang Agent OS)" and "Meet OpenFang: Best Open-Source OpenClaw Alternative?"
- **Blog posts:** Coverage from SitePoint, i-SCOOP, Medium, LinkedIn, and numerous Chinese tech blogs
- **Comparison sites:** openclaw-install.com, shelldex.com, and till-freitag.com provide detailed comparisons

---

## Code Examples

### Installation

```bash
# macOS / Linux
curl -fsSL https://openfang.sh/install | sh

# Windows (PowerShell)
irm https://openfang.sh/install.ps1 | iex

# Docker (build from source)
git clone https://github.com/RightNow-AI/openfang.git
cd openfang && docker build -t openfang .
```

### Quick Start

```bash
# Initialize workspace
openfang init

# Configure LLM provider
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...

# Start daemon + dashboard
openfang start
# Dashboard: http://127.0.0.1:4200
```

### Agent Interaction

```bash
# Chat with a pre-built agent
openfang chat researcher
> "What are emerging trends in AI agents?"

# Spawn a specific agent template
openfang agent spawn --template data-analyst

# List all running agents
openfang agent list
```

### Hands Activation

```bash
# Activate the Researcher Hand
openfang hand activate researcher

# Check its status
openfang hand status researcher
# Output: Running | 47 sources analyzed | 3 reports generated | Next run: 6h

# Activate Lead generation
openfang hand activate lead

# Configure a Hand's settings
openfang hand configure lead --icp "B2B SaaS, 50-200 employees, Series A+"
```

### Migration from OpenClaw

```bash
# Dry run (preview changes)
openfang migrate --from openclaw --dry-run

# Full migration
openfang migrate --from openclaw

# Migration from specific path
openfang migrate --from openclaw --path ~/.openclaw
```

### Rust SDK Usage

```rust
// Cargo.toml
// [dependencies]
// openfang = { version = "=0.1.0", registry = "openfang-registry" }
// tokio = { version = "=1.38.0", features = ["rt-multi-thread", "macros"] }

use openfang::agent::{Agent, AgentConfig};
use openfang::runtime::Runtime;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = AgentConfig::builder()
        .name("my-agent")
        .model("claude-sonnet-4-20250514")
        .tools(vec!["web_search", "file_write"])
        .build()?;

    let runtime = Runtime::new().await?;
    let agent = runtime.spawn_agent(config).await?;

    let response = agent
        .send("Analyze the latest market trends in AI")
        .await?;

    println!("{}", response.content);
    Ok(())
}
```

### Workflow Pipelines

```bash
# Chain Hands in a workflow
# Researcher -> Predictor -> Clip -> broadcast to 40 channels
openfang workflow create \
  --name "research-to-content" \
  --steps "researcher,predictor,clip" \
  --trigger "schedule:daily:09:00"
```

### WhatsApp Integration

OpenFang supports connecting a personal WhatsApp account via QR code (similar to WhatsApp Web):

```bash
# Enable WhatsApp gateway
export WHATSAPP_WEB_GATEWAY_URL=ws://localhost:3001
export OPENFANG_URL=http://127.0.0.1:4200

# Start the gateway
openfang channel enable whatsapp
# Scan QR code with your phone
```

No Meta Business account is required -- this uses the WhatsApp Web protocol directly.

---

## Current Limitations and Roadmap

### Known Limitations

1. **Pre-1.0 stability:** Breaking changes may occur between minor versions. Pin to specific commits for production.
2. **Steep learning curve:** The OS-level abstraction is more complex than simpler frameworks.
3. **Single-maintainer risk:** Despite 22 contributors, the vast majority of code comes from a single person.
4. **No edge support:** Cannot run on extremely constrained devices (use ZeroClaw or NullClaw for that).
5. **No managed hosting:** Self-hosted only; no equivalent to AWS Lightsail managed OpenClaw.
6. **Young ecosystem:** 14.9K stars vs OpenClaw's 321K; FangHub is nascent compared to ClawHub.
7. **Benchmarks are self-reported:** Independent third-party benchmarks are limited.

### v0.2.0 Roadmap (Published)

Based on published roadmap information:
- **Distributed agent scheduling** across multiple nodes
- **GPU-accelerated WASM** for compute-intensive agent tasks
- **Expanded tool marketplace** with community contribution model
- **Improved governance model** and contribution process

### v1.0 Target

The project targets a "rock-solid v1.0 by mid-2026" with:
- Stable API surface
- Full documentation
- Production deployment guides
- Horizontal scaling support

### Community Questions (Unresolved)

From LinkedIn and HN discussions, several architectural questions remain open:

1. **Horizontal scaling:** How will multiple OpenFang instances work in unison (master/extender model)?
2. **Hand extensibility:** Currently compiling Hands into the binary -- how to support dynamic/hot-loaded Hands?
3. **Memory search:** BM25 vs vector search strategy unclear in documentation
4. **Business model:** How will RightNow AI sustain the project long-term?

---

## Sources and References

### Primary Sources

| Source | URL |
|--------|-----|
| GitHub Repository | https://github.com/RightNow-AI/openfang |
| Official Website | https://openfang.sh/ |
| Documentation | https://openfang.sh/docs |
| Alternative docs site | https://openfang.info/docs/overview |
| Alternative landing page | https://openfang.one/ |
| Alternative landing page | https://openfang.cc/ |
| Changelog | https://github.com/RightNow-AI/openfang/blob/main/CHANGELOG.md |
| Releases | https://github.com/RightNow-AI/openfang/releases |

### Analysis and Reviews

| Source | URL |
|--------|-----|
| SitePoint benchmarks | https://www.sitepoint.com/openfang-rust-agent-os-performance-benchmarks/ |
| i-SCOOP deep dive | https://www.i-scoop.eu/openfang/ |
| OpenClaw comparison (openclawai.net) | https://openclawai.net/blog/openfang-vs-openclaw |
| OpenClaw alternatives comparison | https://openclaw-install.com/alternatives/openfang |
| Till Freitag deep dive (German) | https://till-freitag.com/blog/openfang-agent-operating-system |
| Till Freitag alternatives overview | https://till-freitag.com/en/blog/openclaw-alternatives-en |
| LinkedIn architecture post | https://www.linkedin.com/pulse/openfang-autonomous-agent-operating-system-features-narayanaswamy-5v6cc |
| Shelldex FAQ | https://shelldex.com/faq/ |
| NemoClaw vs OpenClaw comparison | https://www.secondtalent.com/resources/nemoclaw-vs-openclaw/ |

### Community Discussions

| Source | URL |
|--------|-----|
| Jaber LinkedIn announcement | https://www.linkedin.com/posts/osama-jaber-osama2001_we-open-sourced-an-operating-system-for-ai-activity-7432586734468743168-INtv |
| Reddit r/AIDeveloperNews | https://www.reddit.com/r/AIDeveloperNews/comments/1rgq37a/ |
| Medium: "I Ignored 30+ Alternatives Until OpenFang" | https://agentnativedev.medium.com/i-ignored-30-openclaw-alternatives-until-openfang-ff11851b83f1 |
| YouTube: "This AI Works While You Sleep" | https://www.youtube.com/watch?v=CcnfD6GWIWQ |
| YouTube: "Meet OpenFang" | https://www.youtube.com/watch?v=JX-MbP0qMCk |

### Related Projects

| Project | URL |
|---------|-----|
| OpenClaw | https://github.com/openclaw/openclaw |
| NemoClaw | https://github.com/NVIDIA/NemoClaw |
| DeepWiki (OpenFang) | https://deepwiki.com/RightNow-AI/openfang |

---

## Related Research

- [[01-OpenClaw-Core-Architecture]] -- OpenClaw core architecture and philosophy
- [[02-NemoClaw-NVIDIA-Fork]] -- NVIDIA's enterprise security wrapper
- [[04-Skill-System-Tool-Creation]] -- Cross-platform skill systems and tool creation
