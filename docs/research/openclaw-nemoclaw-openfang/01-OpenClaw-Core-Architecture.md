# OpenClaw: Core Architecture & Philosophy

> **Status:** Research complete | **Updated:** 2026-03-19
> **Series:** [[02-NemoClaw-NVIDIA-Fork]] | [[03-OpenFang-Community-Fork]] | [[04-Skill-System-Tool-Creation]] | [[05-Memory-Persistence-Self-Improvement]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#Origin Story]]
- [[#Core Philosophy & Design Decisions]]
- [[#High-Level Architecture]]
- [[#The Gateway]]
- [[#Pi Agent Runtime]]
- [[#The Agent Loop]]
- [[#Tool System]]
- [[#Skill System & ClawHub]]
- [[#MCP Integration]]
- [[#Memory & Persistence]]
- [[#Identity Files SOUL.md AGENTS.md]]
- [[#Configuration & Extensibility]]
- [[#Multi-Channel Communication]]
- [[#Security Model]]
- [[#Comparison with Other AI Coding Agents]]
- [[#The Ecosystem: Forks, Alternatives & Enterprise]]
- [[#Key Statistics & Milestones]]
- [[#Sources & References]]

---

## Executive Summary

OpenClaw is an open-source, self-hosted personal AI agent framework that turns large language models into persistent, tool-using assistants with real-world integrations. Unlike chatbot wrappers that simply proxy API calls, OpenClaw implements a full agent runtime with session management, memory persistence, context window optimization, multi-channel messaging, sandboxed tool execution, and event-driven extensibility.

As of March 2026, OpenClaw has **325,000+ GitHub stars**, **62,000+ forks**, **360+ contributors**, and **68 releases**. It is written primarily in TypeScript (88%) with Swift, Kotlin, and Shell components, and is licensed under MIT. It is widely considered the fastest-growing open-source project in GitHub history.

**Key Insight:** The LLM provides intelligence; OpenClaw provides the operating system. Most agent frameworks focus on prompt engineering. OpenClaw focuses on the infrastructure problem: concurrency, security, observability, reliability, and multi-channel I/O.

**Repository:** [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
**Website:** [openclaw.ai](https://openclaw.ai/)
**Docs:** [docs.openclaw.ai](https://docs.openclaw.ai/)

---

## Origin Story

### The Creator: Peter Steinberger

Peter Steinberger is an Austrian software engineer who founded PSPDFKit, a PDF toolkit used by Apple, Dropbox, and SAP. He bootstrapped it for a decade, then sold his shares when Insight Partners invested $116M in 2021. Nearly a billion people use apps powered by his code.

After burning out post-exit, Steinberger started tinkering with AI agents. He built a side project called "WhatsApp Relay" -- it let him text an AI and have it actually do things: clear his inbox, book restaurants, check in for flights, control his smart home.

### Naming Timeline

| Date | Name | Why |
|------|------|-----|
| Nov 2025 | **Clawdbot** | Original name, derived from "Clawd" (a nod to Anthropic's Claude) |
| Jan 27, 2026 | **Moltbot** | Renamed after Anthropic trademark complaint ("Clawd" too close to "Claude"). Lobster theme: lobsters molt when they outgrow their shell |
| Jan 30, 2026 | **OpenClaw** | Steinberger found "Moltbot never quite rolled off the tongue" |

During the naming transition, crypto scammers hijacked Steinberger's briefly-available old GitHub handle and launched a fraudulent token that hit a $16M market cap. Steinberger nearly deleted the entire project. ("I was close to crying. Everything's f*cked.")

### The Explosion

- **Nov 2025:** Published on GitHub -- a weekend WhatsApp relay script
- **Late Jan 2026:** Goes viral. 9,000 to 60,000 stars in days
- **Early Feb 2026:** 180,000+ stars. 2 million visitors in a single week
- **Feb 5, 2026:** First ClawCon in SF -- 700+ attendees. Investors like Ashton Kutcher present
- **Feb 14, 2026:** Steinberger announces he is joining OpenAI. Sam Altman: "Peter Steinberger is joining OpenAI to drive the next generation of personal agents"
- **Feb 2026:** OpenClaw moves to an independent open-source foundation, supported by OpenAI
- **Mar 2026:** 325,000+ stars, surpassing React as GitHub's most-starred software project

Andrej Karpathy called the Moltbook side project "the most incredible sci-fi takeoff-adjacent thing" he had seen recently. Jensen Huang at GTC 2026: "Every company in the world today needs to have an OpenClaw strategy, an agentic system strategy. This is the new computer."

### Why It Went Viral

The key was **productization**, not raw technical capability. Steinberger turned "chatbots that respond" into "agents that act" -- a persistent assistant running on your own hardware, accessible through messaging apps you already use. The SOUL.md file, the lobster mascot, and the "just text your AI" onboarding made agentic AI tangible for non-developers.

> "TLDR: open source built a better version of Siri that Apple ($3.6 trillion company) was sleeping on for years." -- @Hesamation

---

## Core Philosophy & Design Decisions

### 1. Local-First, Own Your Data

All data -- conversations, memory, skills, configuration -- lives as plain files on your machine. No cloud dependency. No vendor lock-in. Memory files are human-readable Markdown. You can open `SOUL.md` and see exactly what instructions the agent follows.

### 2. The LLM Is Not the Hard Part

OpenClaw's core insight is architectural: the model provides intelligence, but systemic engineering around concurrency, security, observability, and reliability is what makes an autonomous agent actually work. Every message flows through a strictly defined execution pipeline.

### 3. Model Agnostic

OpenClaw works with any LLM provider: Anthropic Claude, OpenAI GPT, Google Gemini, local models via Ollama, and many more. Configuration is simple YAML/JSON. This flexibility is one of OpenClaw's biggest advantages -- you are not locked into a single provider.

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
}
```

### 4. Skills as Markdown, Not Code

The extensibility system (Skills) uses Markdown files with natural-language instructions rather than compiled plugins. This was a deliberate design choice: prompt engineering beat code for extensibility. The agent reads instructions and figures out how to execute them, rather than running pre-compiled code.

### 5. Embrace Code Execution

Both OpenClaw and Pi (the embedded agent) follow the same philosophy: LLMs are really good at writing and running code, so embrace this. If you want the agent to do something new, you don't download an extension -- you ask the agent to extend itself.

### 6. Channels Are the Interface

OpenClaw doesn't have its own chat UI as the primary interface. Instead, it plugs into the messaging apps you already use (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, and 15+ more). The product is the assistant, not the app.

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Messaging Surfaces                     │
│  WhatsApp  Telegram  Discord  Slack  Signal  iMessage    │
│  Teams  Matrix  Google Chat  IRC  WebChat  ...           │
└────────────────────────┬─────────────────────────────────┘
                         │ WebSocket / HTTP
                         v
┌──────────────────────────────────────────────────────────┐
│                    Gateway (Daemon)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Channel  │  │ Session  │  │ Command  │  │ Plugin  │ │
│  │ Bridges  │  │ Manager  │  │  Queue   │  │ System  │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │  Hooks   │  │   Cron   │  │Heartbeat │  │  Auth   │ │
│  │  Engine  │  │ Scheduler│  │  Engine   │  │ Manager │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │             Pi Agent Runtime (RPC)                   ││
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌────────┐││
│  │  │  Agent  │  │ Context │  │  Tool   │  │ Memory │││
│  │  │  Loop   │  │ Engine  │  │Executor │  │ System │││
│  │  └─────────┘  └─────────┘  └─────────┘  └────────┘││
│  └──────────────────────────────────────────────────────┘│
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │             File System (Workspace)                  ││
│  │  SOUL.md  AGENTS.md  MEMORY.md  skills/  sessions/  ││
│  └──────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

OpenClaw is structured as a **hub-and-spoke architecture** with five core components:

| Component | Role | Description |
|-----------|------|-------------|
| **Gateway** | Central Daemon | Node.js service managing state, model routing, session context |
| **Agent** | Reasoning Engine | LLM-driven core that reads Skills and executes tasks |
| **ClawHub Registry** | Skill Registry | Platform for publishing/discovering community Skills |
| **ClawHub CLI** | Command Line Tool | CLI for locally installing, searching, publishing Skills |
| **Skills (SKILL.md)** | Capability Definitions | Markdown-formatted skill files on local filesystem |

---

## The Gateway

The Gateway is a long-running Node.js daemon process -- the control plane for the entire system. It handles:

- **Channel Bridges:** Adapters for 20+ messaging platforms. Each converts platform-specific APIs into a standardized internal format
- **Session Management:** Tracks conversation state, session keys, and per-session lanes
- **Command Queue (Lane Queue):** The core reliability pattern. Serializes agent runs per session, preventing tool/session races
- **Plugin System:** Extension points for agent lifecycle, message hooks, and tool interceptors
- **Cron Scheduler:** Enables proactive behavior (heartbeats, scheduled tasks, reminders)
- **Heartbeat Engine:** Periodic wake-ups that let the agent check for changes and act autonomously
- **Auth Manager:** Handles API key rotation, provider fallback chains, and WebSocket security
- **Canvas Host:** Renders a live Canvas UI the user can interact with
- **WebSocket Control Plane:** Sessions, presence, config, webhooks, and Control UI

### Gateway Startup Flow

```
openclaw onboard --install-daemon    # First-time setup
openclaw gateway --port 18789 --verbose  # Run the daemon
```

The onboarding wizard installs the Gateway as a launchd (macOS) or systemd (Linux) service so it stays running 24/7. The gateway listens on port 18789 by default, with loopback-only `ws://` for security.

### The Lane Queue System

This is OpenClaw's core reliability pattern. When a message arrives:

1. The Gateway routes it to the correct session
2. The session's **lane queue** serializes agent runs
3. Only one agent turn runs per session at a time
4. Channels can choose queue modes: `collect`, `steer`, or `followup`

This prevents tool/session races and keeps session history consistent -- a problem most agent frameworks ignore that breaks under real-world concurrent usage.

---

## Pi Agent Runtime

At the heart of OpenClaw is **Pi** -- a minimal coding agent created by Mario Zechner. OpenClaw consumes Pi as an embedded SDK (`@mariozechner/pi-agent-core`).

### Pi's Philosophy: Radical Minimalism

Mario Zechner's design philosophy is the opposite of "kitchen sink" frameworks:

- **Four core tools only:** `read`, `write`, `edit`, `bash` -- that's it
- **No MCP support built in** (OpenClaw adds it via `mcporter`)
- **No built-in to-dos** (sessions handle task state)
- **No plan mode** (the model plans naturally)
- **No sub-agents** (compose via bash)
- **No background bash** (synchronous execution for determinism)
- **YOLO by default** -- no confirmation prompts, the agent just executes

> "All frontier models have been RL-trained up the wazoo, so they inherently understand what a coding agent is. The model knows what `bash` is. It knows how files work. Adding specialized tools just adds tokens to the system prompt without adding capability." -- Mario Zechner

Pi's system prompt and tool definitions together come in **below 1,000 tokens** -- compared to thousands for Claude Code or Codex.

### Pi Package Ecosystem

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Package | Purpose |
|---------|---------|
| `pi-ai` | Model abstraction layer -- unified API across providers |
| `pi-agent-core` | Core agent loop, session management, context engine |
| `pi-coding-agent` | The coding agent with tools, extensions, and config |
| `pi-tui` | Terminal UI with retained-mode rendering |

### How OpenClaw Uses Pi

OpenClaw imports Pi as an SDK and wraps it with the Gateway layer:

```typescript
import { AgentLoop, Context, getModel } from '@mariozechner/pi-agent-core';
import { createGateway } from './gateway';

const gateway = createGateway({
  port: 18789,
  channels: ['whatsapp', 'telegram', 'slack', 'discord']
});
```

The Gateway calls `runEmbeddedPiAgent()` which:
1. Loads the skills snapshot
2. Resolves model + thinking/verbose defaults
3. Creates a Pi session via `createAgentSession()`
4. Streams events back through the Gateway's event system

### Pi vs. OpenClaw -- Separation of Concerns

| Concern | Pi (SDK) | OpenClaw (Platform) |
|---------|----------|---------------------|
| Agent loop | Core loop, tool execution | Wraps with lifecycle events |
| Tools | read, write, edit, bash | Adds skills, MCP, browser, etc. |
| Memory | Session-based | MEMORY.md + vector search |
| Channels | None (stdin/stdout) | 20+ messaging platforms |
| Scheduling | None | Cron, heartbeats |
| Security | Minimal | Gateway auth, sandbox, policies |
| UI | Terminal TUI | WebChat, Canvas, Control UI |

Armin Ronacher (Flask creator) described Pi as the coding agent he uses "almost exclusively" and called it "the most important thing to understand if you want to understand OpenClaw."

---

## The Agent Loop

The agent loop is the core execution model. It lives in `src/agents/pi-embedded-runner/run.ts` and follows the ReAct (Reason + Act) pattern.

### Simplified Core Loop

```typescript
while (true) {
  const attempt = await runEmbeddedAttempt({
    sessionId, sessionKey, prompt, model, tools, ...
  });

  if (attempt.success) break;
  if (attempt.contextOverflow) {
    await compactSession();
    continue;
  }
  if (attempt.authError) {
    await rotateApiKey();
    continue;
  }

  break; // Other errors exit the loop
}
```

### Full Pipeline (6 Stages)

Every message flows through a strictly defined execution pipeline:

#### Stage 1: Channel Adapter (Intake)
Standardizes inputs from 20+ messaging platforms into a common internal format.

#### Stage 2: Context Assembly
- Identity files loaded: `SOUL.md`, `AGENTS.md`, `TOOLS.md`
- Skills snapshot injected (names + descriptions only -- full content loads on demand)
- Session history assembled
- Bootstrap context added
- System prompt built from base prompt + skills prompt + bootstrap + per-run overrides

#### Stage 3: Model Inference
- Model resolved from config (with provider fallback chains)
- Auth profile selected
- Token limits and compaction reserves enforced
- Prompt submitted to the LLM via Pi's model abstraction

#### Stage 4: Tool Execution
- Model returns tool calls or text
- Tools executed synchronously
- Results fed back into the loop
- Tool events streamed to the Gateway

#### Stage 5: Streaming Replies
- Assistant deltas streamed from pi-agent-core
- Emitted as `assistant` events to connected channels
- Reasoning streaming can be separate or inline

#### Stage 6: Persistence
- Session transcript updated
- Memory written if applicable
- Tool results persisted
- Auto-compaction may trigger if context is getting large

### Event Streams

The agent loop emits three event streams:

| Stream | Content |
|--------|---------|
| `lifecycle` | `phase: "start" | "end" | "error"` |
| `assistant` | Streamed text deltas from the model |
| `tool` | Tool call events (invocation, result, errors) |

### Queueing & Concurrency

- Runs are serialized per session key (session lane) and optionally through a global lane
- Messaging channels choose queue modes: `collect` (batch), `steer` (redirect), `followup` (append)
- This prevents tool/session races and keeps session history consistent

### Auto-Compaction

When the context window fills up:
1. Compaction pipeline triggers
2. Older messages are summarized
3. Tool results are condensed
4. Retry with the compacted context
5. Emits `compaction` stream events

---

## Tool System

### Pi's Four Core Tools

Pi ships with exactly four tools that handle everything:

| Tool | Description |
|------|-------------|
| `read` | Read file contents |
| `write` | Write file contents |
| `edit` | Edit file with diffs/patches |
| `bash` | Execute shell commands synchronously |

Additional read-only tools (`grep`, `find`, `ls`) are available but disabled by default. The philosophy: "These four tools are all you need for an effective coding agent."

### OpenClaw's Extended Tool Ecosystem

OpenClaw adds a rich tool layer on top of Pi's minimalist base:

- **File system** -- Read, write, search, manage files
- **Code execution** -- Run Python, JavaScript, Bash in sandboxed environments
- **Web browsing** -- Navigate pages, extract content, fill forms (via CDP-controlled Chrome/Chromium)
- **API calls** -- HTTP requests with auth handling
- **Database** -- Query SQL and NoSQL databases
- **Git** -- Commit, branch, merge, manage repositories
- **PDF analysis** -- Native Anthropic and Google PDF support with fallback extraction
- **Browser control** -- OpenClaw-managed Chrome with CDP

### Tool Definition Adapter

OpenClaw bridges Pi's tool interface to its own:

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}
```

### Tool Profiles

OpenClaw supports tool profiles that restrict which tools are available:

- `messaging` -- Safe tools for conversational use (default for new installs)
- `coding` -- Full coding tools including bash, file system
- `system` -- Everything including browser, system commands

---

## Skill System & ClawHub

Skills are the feature that drove OpenClaw's adoption. They are the framework for extending OpenClaw's capabilities with new APIs, commands, or custom workflows.

### Anatomy of a Skill

A Skill is a directory containing a `SKILL.md` file with YAML frontmatter and Markdown instructions:

```markdown
---
name: my-skill
description: "Does something useful"
version: "1.0.0"
requires:
  binaries: ["curl", "jq"]
  env: ["MY_API_KEY"]
triggers:
  - "when the user asks about weather"
  - "when the user wants to check forecasts"
---

# My Skill

## Instructions

When the user asks about weather:
1. Use the API at https://api.weather.com/...
2. Format the response as a table
3. Include temperature, humidity, wind speed

## Examples

User: "What's the weather in Vienna?"
Agent: [calls weather API, formats response]
```

### How Skills Load at Runtime

1. **Session start:** OpenClaw snapshots a compact list of eligible skills (names + descriptions only) into the system prompt
2. **During conversation:** When the LLM determines a skill is relevant to the current task, it reads that skill's `SKILL.md` on demand
3. **Token efficiency:** You can have dozens of skills installed without significantly increasing token overhead

This is a **text-driven architecture** -- skills aren't compiled code, they're instruction documents in Markdown format.

### Skill Hierarchy (Three Tiers)

1. **Workspace-level skills** (`./skills/`) -- highest priority
2. **Managed skills** (`~/.openclaw/skills/`) -- user-installed
3. **Bundled skills** -- ~50 official skills shipping with OpenClaw (github, summarize, obsidian, weather, etc.)

### ClawHub: The npm for AI Agents

ClawHub ([clawhub.ai](https://clawhub.ai)) is the official skill registry with 2,857+ skills across 11 categories:

| Category | Examples |
|----------|---------|
| AI/ML | Model routing, embeddings, fine-tuning |
| Development | GitHub, git, code review, CI/CD |
| Productivity | Calendar, email, task management |
| Web | Scraping, browser automation, search |
| Finance | Crypto, trading, expense tracking |
| Media | Image generation, video, audio |
| Social | Twitter/X, Discord bots, Telegram |
| Business | CRM, marketing, analytics |
| Utility | File conversion, data processing |
| Science | arXiv, research, citations |
| Location | Maps, travel, weather |

Installation is one command:
```bash
clawhub install github
clawhub install obsidian-direct
clawhub install playwright-mcp
```

ClawHub uses **vector-based semantic search** (OpenAI embeddings) so you find skills with natural language queries, not exact package names.

### Security Concerns: ClawHavoc

In January 2026, the **ClawHavoc** campaign was discovered: hundreds of malicious skills on ClawHub containing malware, including an Atomic Stealer payload that harvested API keys, injected keyloggers, and wrote malicious content into `MEMORY.md` and `SOUL.md` for persistent effect across sessions. Over 1,184 malicious skills were found.

Response:
- Version 2026.2.26 shipped 40+ security patches
- Partnership with **VirusTotal** for scanning all ClawHub submissions
- Dedicated security advisor (Jamieson O'Reilly, CREST Advisory Council)
- Community consensus: treat unverified skills like untrusted code

See [[04-Skill-System-Tool-Creation]] for deep dive.

---

## MCP Integration

OpenClaw is one of the largest MCP-compatible platforms. **Every skill on ClawHub is an MCP server.**

### How MCP Works in OpenClaw

MCP (Model Context Protocol) is Anthropic's open standard for AI-to-tool communication. In OpenClaw:

1. When you enable an MCP-based skill, OpenClaw connects to that MCP server
2. The server's tools become available to the agent
3. The agent can discover and call tools during conversations

### mcporter: The MCP Bridge

Since Pi itself does not support MCP natively, OpenClaw uses **mcporter** -- a bridge that exposes MCP calls via CLI interface or TypeScript bindings. This keeps Pi minimal while giving OpenClaw full MCP compatibility.

### MCP vs. Skills: Token Efficiency

A key architectural difference:

| Approach | Context Cost | Loading |
|----------|-------------|---------|
| **MCP server** (e.g., Playwright) | 21 tools, ~13,700 tokens always in context (7-9% of window) | All tools loaded at session start |
| **Skill** | Only name/description in context (~50 tokens) | Full instructions loaded on demand when triggered |

Skills are dramatically more context-efficient than raw MCP tool injection.

### Configuring MCP Servers

```json5
{
  mcpServers: {
    "my-server": {
      command: "uvx my-mcp-server",
      args: ["--port", "8080"],
      env: { "API_KEY": "..." }
    }
  }
}
```

OpenClaw supports the standard MCP server configuration format, compatible with Claude Code's `.mcp.json` pattern.

---

## Memory & Persistence

OpenClaw implements a two-layer memory system:

### Short-Term Memory (Session Context)

- Conversation history within the current session
- Managed by the context engine with auto-compaction
- Token-budget-aware: older messages summarized when context fills

### Long-Term Memory (MEMORY.md + Vector Search)

- Persistent Markdown files the agent reads and writes
- `MEMORY.md` -- core agent memory, loaded every session
- Human-readable and editable -- open in any text editor
- Vector search via embeddings for retrieval (supports OpenAI and Ollama embeddings)

```
~/.openclaw/workspace/
  MEMORY.md          # Long-term memory
  SOUL.md            # Agent identity/personality
  AGENTS.md          # Agent definitions
  sessions/          # Session transcripts
  skills/            # Installed skills
```

### Why Markdown?

The memory system is deliberately file-based and human-readable:
- You can inspect exactly what your agent remembers
- You can edit memories manually
- No database to manage, backup, or migrate
- Version-controllable with git
- Cross-compatible with Obsidian and other Markdown tools

See [[05-Memory-Persistence-Self-Improvement]] for deep dive.

---

## Identity Files: SOUL.md & AGENTS.md

### SOUL.md -- The Agent's Personality

`SOUL.md` defines who the agent is: its personality, capabilities, behavioral constraints, and communication style. It is the "constitution" for the agent.

```markdown
# Molty

You are Molty, a helpful and proactive AI assistant.

## Personality
- Friendly but professional
- Proactive: suggest actions, don't just answer questions
- Brief in messages unless asked for detail

## Constraints
- Never share API keys or credentials
- Ask before making purchases or sending messages to new contacts
- Always confirm before deleting files

## Communication Style
- Use casual language in WhatsApp/Telegram
- Use professional language in Slack/Teams
- Adapt tone to the channel
```

SOUL.md is loaded into every agent session as part of the system prompt. The community has built a registry for sharing SOULs: **onlycrabs.ai**.

### AGENTS.md -- Multi-Agent Definitions

`AGENTS.md` defines agent configurations for multi-agent setups:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4",
        fallback: "openai/gpt-4.1-mini",
        temperature: 0.5,
        maxTokens: 64000
      }
    },
    registered: {
      architect: {
        identity: ".openclaw/agents/architect/agent.md",
        model: { primary: "anthropic/claude-opus-4" },
        tools: ["file", "shell", "browser", "mcp"]
      },
      coder: {
        identity: ".openclaw/agents/coder/agent.md",
        workspace: "./src",
        tools: ["file", "shell", "git", "npm"]
      },
      reviewer: {
        identity: ".openclaw/agents/reviewer/agent.md",
        model: { temperature: 0.1 },
        tools: ["file", "git"]
      }
    }
  }
}
```

---

## Configuration & Extensibility

### openclaw.json

The primary configuration file, supporting all aspects of the system:

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
  gateway: {
    port: 18789,
    mode: "local",
  },
  browser: {
    enabled: true,
    color: "#FF4500",
  },
  tools: {
    profile: "coding",  // "messaging" | "coding" | "system"
  },
  memorySearch: {
    provider: "openai",     // or "ollama"
    fallback: "ollama",
  },
}
```

### Hook Systems

OpenClaw has two hook systems for intercepting the agent lifecycle:

#### Plugin Hooks (Agent + Gateway Lifecycle)

```
message_received / message_sending / message_sent
before_agent_start / after_agent_start
before_tool_call / after_tool_call
tool_result_persist
before_prompt / after_prompt
```

Plugins can inject `prependContext`, `systemPrompt`, `prependSystemContext`, or `appendSystemContext` before prompt submission.

#### Internal Hooks (Gateway Events)

Command hooks for `/new`, `/reset`, `/stop`, and other lifecycle events. The `agent:bootstrap` hook runs while building bootstrap files before the system prompt is finalized.

### Extension System: 20+ Lifecycle Hooks

Extensions are TypeScript modules loaded via `jiti` (runtime TypeScript loading) without pre-compilation:

```typescript
import { Extension, AgentContext } from '@mariozechner/pi-agent-core';

export default {
  name: 'my-extension',
  hooks: {
    beforePrompt: async (ctx: AgentContext) => {
      // Inject context before every prompt
    },
    afterToolCall: async (ctx: AgentContext, result: ToolResult) => {
      // Post-process tool results
    },
  }
};
```

### CLI Surface

```bash
openclaw onboard          # Interactive setup wizard
openclaw gateway          # Run the daemon
openclaw agent            # Direct agent interaction
openclaw message send     # Send a message to a contact
openclaw doctor           # Diagnose configuration issues
openclaw config set       # Set configuration values
openclaw config validate  # Validate config before startup
openclaw channels status  # Check channel connectivity
openclaw secrets          # Manage credential references
```

---

## Multi-Channel Communication

OpenClaw supports 20+ messaging platforms as first-class channels:

| Category | Platforms |
|----------|-----------|
| **Consumer Messaging** | WhatsApp, Telegram, Signal, iMessage, BlueBubbles, LINE, Zalo |
| **Team Chat** | Slack, Discord, Microsoft Teams, Google Chat, Mattermost |
| **Open Protocols** | Matrix, IRC, Nostr, Nextcloud Talk |
| **Enterprise** | Feishu (Lark), Synology Chat, Tlon |
| **Social** | Twitch |
| **Built-in** | WebChat UI, Voice (macOS/iOS/Android), Canvas |

Each channel has a dedicated adapter in `src/channels/` that converts platform-specific APIs into a standard format. The Gateway routes messages bidirectionally.

### Platform-Specific Behavior

The agent adapts its communication style per channel:
- WhatsApp/Telegram: casual, emoji-friendly, shorter messages
- Slack/Teams: professional, structured, threaded replies
- Discord: community-oriented, can manage server tasks

### Mobile and Desktop Apps

- **macOS app:** Native Swift app with menu bar integration
- **iOS app:** Connect to your gateway remotely
- **Android app:** Connect/Chat/Voice plus Canvas, Camera, Screen capture
- **Windows:** Companion suite with System Tray, PowerToys extension

---

## Security Model

### The Trust Boundary

The Gateway host IS the trust boundary. If it's compromised (or configured too openly), your assistant can be turned into a data exfiltration / automation engine.

### Security Layers

1. **Gateway Auth:** WebSocket security, loopback-only by default
2. **Tool Profiles:** Restrict available tools (`messaging` vs `coding` vs `system`)
3. **DM Policies:** Control who can interact with the agent
4. **Skill Scanning:** VirusTotal integration for ClawHub submissions
5. **SecretRef:** Credential management via environment variable references (64 targets)
6. **Sandbox Support:** Integration with NemoClaw/OpenShell for containerized execution

### Known Security Issues

OpenClaw has faced significant security challenges:

- **ClawHavoc:** 1,184 malicious skills discovered on ClawHub (Jan 2026)
- **Exposed Instances:** SecurityScorecard found 135,000+ publicly exposed instances, 50,000+ exploitable via RCE
- **Prompt Injection:** Skills can manipulate MEMORY.md and SOUL.md for persistent effect
- **Supply Chain:** The skill marketplace is an attack surface

The community consensus: **run OpenClaw in a VM on dedicated hardware with fresh accounts and treat it as untrusted software.**

See [[02-NemoClaw-NVIDIA-Fork]] for how NVIDIA addresses these with OpenShell sandboxing.

---

## Comparison with Other AI Coding Agents

### OpenClaw vs. Claude Code

| Dimension | OpenClaw | Claude Code |
|-----------|----------|-------------|
| **Primary Purpose** | Autonomous personal assistant | Developer coding assistant |
| **Interface** | Messaging apps (WhatsApp, Slack, etc.) | Terminal, IDE, browser |
| **Autonomy** | Runs 24/7, proactive (cron, heartbeats) | On-demand, human-driven |
| **Scope** | Life automation (email, calendar, web, files) | Codebase-focused |
| **Memory** | Persistent MEMORY.md + vector search | Session-scoped + CLAUDE.md |
| **Model Support** | Any provider (Anthropic, OpenAI, Ollama, etc.) | Claude models only |
| **Tool System** | Skills (Markdown) + MCP | Built-in tools + MCP |
| **Architecture** | Gateway daemon + Pi agent SDK | CLI/IDE agent |
| **Security** | Self-hosted, but significant attack surface | Sandboxed, permission modes |
| **License** | MIT (open source) | Proprietary |

**Bottom line:** Claude Code handles your codebase. OpenClaw handles your life. They are complementary, not competing.

### OpenClaw vs. Cursor / Windsurf

| Dimension | OpenClaw | Cursor | Windsurf |
|-----------|----------|--------|----------|
| **Type** | Agent framework | AI-enhanced IDE | AI-enhanced IDE |
| **Autocomplete** | No | Yes (Supermaven, fastest) | Yes (multi-line) |
| **Multi-file editing** | Via bash/skills | Composer + Agent mode | Cascade agent |
| **Context window** | Model-dependent | Model-dependent | Model-dependent |
| **Always-on** | Yes (daemon) | No (IDE session) | No (IDE session) |
| **Non-coding tasks** | Yes (50+ integrations) | No | No |
| **Self-hosted** | Yes | No (cloud-dependent) | No |
| **Price** | Free + API costs | $20/mo+ | $15/mo+ |

### OpenClaw vs. Aider

| Dimension | OpenClaw | Aider |
|-----------|----------|-------|
| **Focus** | General-purpose agent | Git-aware coding assistant |
| **Autonomy** | High (runs autonomously) | Low (interactive CLI) |
| **Git Integration** | Via skills | Native, first-class |
| **Always-on** | Yes | No |
| **Model Support** | Many providers | Many providers |
| **Messaging** | 20+ platforms | Terminal only |

### The Positioning Map

```
                    Autonomous ──────────────────── Interactive
                         │                              │
  General     OpenClaw   │                              │
  Purpose     ──────────►│                              │
              OpenFang   │                              │
                         │                              │
                         │              Aider           │
                         │              ───────────────►│
  Coding                 │    Claude Code               │
  Focused                │    ──────────────────────────►│
                         │         Cursor / Windsurf    │
                         │         ─────────────────────►│
```

---

## The Ecosystem: Forks, Alternatives & Enterprise

The OpenClaw explosion spawned an entire ecosystem within weeks:

### Major Forks & Alternatives

| Project | Focus | Language | Stars | Key Differentiator |
|---------|-------|----------|-------|-------------------|
| **NemoClaw** | Enterprise security | JS/TS/Shell | 9,900+ | NVIDIA's OpenShell sandbox, Nemotron models |
| **OpenFang** | Agent OS | Rust | 14,900+ | 30x faster cold start, 32MB binary, 16 security layers |
| **NanoClaw** | Security-first | TS | N/A | Container-isolated skill execution |
| **ZeroClaw** | Performance | Rust | 26,800+ | <10ms startup, 3.4MB binary, 22+ providers |
| **PicoClaw** | Edge/minimal | Rust | N/A | Runs on $10 RISC-V hardware |
| **Nanobot** | Learning/minimal | Python | N/A | ~4,000 LOC, full MCP support |
| **LocalClaw** | Local models | TS | N/A | Fork optimized for Ollama/small context windows |

See [[02-NemoClaw-NVIDIA-Fork]] and [[03-OpenFang-Community-Fork]] for deep dives.

### Enterprise Adoption

- **NVIDIA:** NemoClaw stack announced at GTC 2026 -- enterprise-grade security wrapper
- **OpenAI:** Acqui-hired creator, supporting foundation
- **DigitalOcean:** 1-Click Deploy with security-hardened image
- **Cloudflare:** Moltworker -- OpenClaw on Workers serverless platform
- **Kimi/Moonshot AI:** Kimi Claw -- managed OpenClaw in the cloud

---

## Key Statistics & Milestones

| Metric | Value |
|--------|-------|
| GitHub Stars | 325,000+ |
| Forks | 62,000+ |
| Contributors | 360+ |
| Releases | 68 |
| Primary Language | TypeScript (88%) |
| License | MIT |
| Created | November 24, 2025 |
| Latest Release | v2026.3.13-1 (March 14, 2026) |
| ClawHub Skills | 2,857+ |
| Supported Channels | 20+ |
| Messaging Integrations | 50+ |
| Bundled Skills | ~50 |
| Repository Organization | 18 repos under openclaw/ |

### Growth Timeline

```
Nov 2025    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░  Published as Clawdbot
Jan 2026    ████░░░░░░░░░░░░░░░░░░░░░░░░  9K → 60K stars (goes viral)
Early Feb   ████████████████░░░░░░░░░░░░░  180K stars, 2M visitors/week
Mid Feb     ████████████████████░░░░░░░░░  Steinberger joins OpenAI
Late Feb    █████████████████████████░░░░  200K+ stars, surpasses React
Mar 2026    ████████████████████████████░  325K+ stars, NVIDIA NemoClaw at GTC
```

---

## Source Code Structure

The OpenClaw monorepo is organized as follows:

```
openclaw/
  src/
    gateway/          # Core routing, sessions, WebSocket control plane
    channels/         # One adapter per messaging platform
    agent/            # Agent module: prompt building, model calls, tool exec
    skills/           # Skill loading, management, ClawHub integration
    cli/              # CLI commands: onboard, gateway, agent, doctor, config
  extensions/         # Workspace packages for plugins/extensions
  docs/               # Documentation, images, Pi config
  dist/               # Built output
  tests/              # Colocated .test.ts files
```

Key files:
- `src/agents/pi-embedded-runner/run.ts` -- The core agent loop
- `SOUL.md` -- Agent personality template
- `AGENTS.md` -- Agent definitions and coding conventions
- `TOOLS.md` -- Tool definitions injected into context

---

## Sources & References

### Official Sources
- [OpenClaw GitHub Repository](https://github.com/openclaw/openclaw) -- 325K+ stars, MIT license
- [OpenClaw Website](https://openclaw.ai/) -- Official site with quick start
- [OpenClaw Documentation](https://docs.openclaw.ai/) -- Full reference docs
- [Agent Loop Documentation](https://openclaws.io/docs/concepts/agent-loop) -- Technical loop reference
- [Pi Integration Architecture](https://docs.openclaw.ai/pi) -- How Pi SDK is embedded
- [ClawHub](https://github.com/openclaw/clawhub) -- Skill registry source code
- [NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw) -- Enterprise security stack

### Architecture Deep Dives
- [OpenClaw Architecture, Explained](https://ppaolo.substack.com/p/openclaw-system-architecture-overview) -- Paolo Perazzo, Feb 2026
- [Inside OpenClaw: How It Works Under the Hood](https://dev.to/jiade/inside-openclaw-how-the-worlds-fastest-growing-ai-agent-actually-works-under-the-hood-4p5n) -- Dev.to, Mar 2026
- [How Does OpenClaw Work? Inside the Agent Loop](https://tomaszs2.medium.com/how-does-openclaw-work-inside-the-agent-loop-that-powers-200-000-github-stars-e61db2bbfcbb) -- Tom Smykowski, Feb 2026
- [How OpenClaw Works: Understanding AI Agents](https://bibek-poudel.medium.com/how-openclaw-works-understanding-ai-agents-through-a-real-architecture-5d59cc7a4764) -- Bibek Poudel, Feb 2026
- [Lessons from OpenClaw's Architecture](https://blog.agentailor.com/posts/openclaw-architecture-lessons-for-agent-builders) -- Agentailor, Feb 2026
- [Architecture Deep Dive Gist](https://gist.github.com/royosherove/971c7b4a350a30ac8a8dad41604a95a0) -- Roy Osherove, Feb 2026

### Pi Agent
- [Pi: The Minimal Agent Within OpenClaw](https://lucumr.pocoo.org/2026/1/31/pi/) -- Armin Ronacher (Flask creator), Jan 2026
- [What I Learned Building an Opinionated Minimal Coding Agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) -- Mario Zechner (Pi creator)
- [Pi Anatomy: Minimal Coding Agent Powering OpenClaw](https://shivamagarwal7.medium.com/agentic-ai-pi-anatomy-of-a-minimal-coding-agent-powering-openclaw-5ecd4dd6b440) -- Medium
- [Syntax.fm Episode 976: Pi - The AI Harness That Powers OpenClaw](https://syntax.fm/show/976/pi-the-ai-harness-that-powers-openclaw-w-armin-ronacher-and-mario-zechner) -- With Ronacher & Zechner

### History & Creator
- [OpenClaw -- Wikipedia](https://en.wikipedia.org/wiki/OpenClaw) -- Full history and naming timeline
- [OpenClaw Creator Peter Steinberger Joins OpenAI](https://techcrunch.com/2026/02/15/openclaw-creator-peter-steinberger-joins-openai/) -- TechCrunch
- [Who is Peter Steinberger?](https://fortune.com/2026/02/19/openclaw-who-is-peter-steinberger-openai-sam-altman-anthropic-moltbook/) -- Fortune
- [OpenAI Hires OpenClaw Creator](https://www.forbes.com/sites/ronschmelzer/2026/02/16/openai-hires-openclaw-creator-peter-steinberger-and-sets-up-foundation/) -- Forbes
- [The Creator of Clawd: "I Ship Code I Don't Read"](https://newsletter.pragmaticengineer.com/p/the-creator-of-clawd-i-ship-code) -- Pragmatic Engineer
- [OpenClaw & The Acqui-Hire](https://mondaymorning.substack.com/p/openclaw-and-the-acqui-hire-that) -- Monday Morning Meeting

### Security & Ecosystem
- [OpenClaw Security: Architecture and Hardening Guide](https://nebius.com/blog/posts/openclaw-security) -- Nebius
- [AI Agent Orchestration: OpenClaw, MCP, and Security](https://codewheel.ai/blog/ai-agent-orchestration-openclaw-mcp-landscape/) -- CodeWheel AI
- [OpenClaw Architecture Deep Dive: Production-Ready Agents](https://pub.towardsai.net/openclaw-architecture-deep-dive-building-production-ready-ai-agents-from-scratch-e693c1002ae8) -- Towards AI
- [OpenClaw Alternatives Comparison](https://www.aimagicx.com/blog/openclaw-alternatives-comparison-2026) -- AIMagicX

### Comparisons
- [OpenClaw vs Claude Code](https://medium.com/data-science-in-your-pocket/openclaw-vs-claude-code-df91911759f9) -- Medium
- [OpenClaw vs Cursor vs Claude Code vs Windsurf](https://skywork.ai/blog/ai-agent/openclaw-vs-cursor-claude-code-windsurf-comparison/) -- Skywork.ai
- [15 Best OpenClaw Alternatives](https://www.taskade.com/blog/best-openclaw-alternatives) -- Taskade

### MCP Integration
- [OpenClaw + MCP Skills Guide](https://openclawlaunch.com/guides/openclaw-mcp) -- OpenClaw Launch
- [OpenClaw MCP Integration Guide 2026](https://computertech.co/openclaw-mcp-integration-guide-2026/) -- ComputerTech

---

*This document is part of the OpenClaw/NemoClaw/OpenFang research series. Continue reading:*

- [[02-NemoClaw-NVIDIA-Fork]] -- NVIDIA's enterprise security stack
- [[03-OpenFang-Community-Fork]] -- The Rust-based Agent OS alternative
- [[04-Skill-System-Tool-Creation]] -- Deep dive into Skills, ClawHub, and dynamic tool creation
- [[05-Memory-Persistence-Self-Improvement]] -- Memory systems, SOUL.md, and self-improving agents
