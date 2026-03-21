---
title: "OpenClaw + NemoClaw Deep Dive: What Chimera Must Replicate and Surpass"
version: 2.0.0
status: canonical
last_updated: 2026-03-21
task: chimera-6dd5
---

# OpenClaw + NemoClaw Deep Dive

**Purpose:** Comprehensive research covering 8 architecture areas with specific code references. Informs Chimera AWS-native reimplementation.

**Key Insight:** OpenClaw is a personal AI agent operating system; NemoClaw is an enterprise security wrapper. Chimera differentiator is being AWS-native with the agent having access to the AWS account instead of the local computer.

---

## SECTION 1: AGENT ARCHITECTURE

### OpenClaw: Hub-and-spoke with Pi Runtime

**Gateway:** Long-running Node.js daemon serving as the control hub.

**Pi (mariozechner/pi-agent-core):** Minimal coding agent SDK.

**Pi Philosophy - Radical Minimalism:**
- Four core tools only: read, write, edit, bash
- System prompt + tool defs under 1000 tokens
- No MCP built-in (OpenClaw adds via mcporter)
- No sub-agents (compose via bash)
- YOLO by default

**Core Execution Loop** (`src/agents/pi-embedded-runner/run.ts`):
```javascript
while(true) {
  attempt = runEmbeddedAttempt({sessionId, sessionKey, prompt, model, tools});
  if (success) break;
  if (contextOverflow) compactSession;
  if (authError) rotateApiKey;
}
```

**Flow:**
```
message arrives
  → Gateway routes to session
  → Lane Queue serializes
  → runEmbeddedPiAgent loads skills, resolves model, creates Pi session
  → session.prompt enters ReAct loop
  → LLM decides tool calls
  → tools execute
  → results fed back
  → loop continues
```

**Lane Queue System:** Serializes agent runs per session, prevents tool/session races. Modes: collect, steer, followup.

**Key Packages:**
- `pi-ai`: model abstraction
- `pi-agent-core`: agent loop
- `pi-coding-agent`: tools + config
- `pi-tui`: terminal UI

### NemoClaw: NOT a fork

OpenClaw plugin for NVIDIA OpenShell. Adds:
- Sandboxed execution
- Policy-controlled network egress
- Inference routing through OpenShell Gateway
- Operator approval workflows

Agent loop identical to OpenClaw. `runAgentInSandbox` in `scripts/telegram-bridge.js` runs:
```bash
openclaw agent --agent main --local -m message --session-id tg-sessionId
```

### Chimera Implication

Need:
1. Core agent loop with ReAct pattern
2. Session serialization (Lane Queue equivalent)
3. Context window management with compaction
4. Model-agnostic provider layer

**AWS equivalent of Gateway:** AgentCore Runtime + API Gateway

---

## SECTION 2: SKILL SYSTEM

### OpenClaw: SKILL.md + ClawHub Marketplace

**Skills:** Markdown-based capability definitions - directories with SKILL.md file.

**SKILL.md Format (YAML frontmatter):**
- `name` (required): skill name
- `description` (required): what it does and WHEN to use it (critical for model routing)
- `homepage`: URL for Skills UI
- `user-invocable`: boolean (default true) - expose as /command
- `disable-model-invocation`: boolean (default false) - exclude from model prompt
- `command-dispatch`: 'tool' bypasses model, dispatches to tool directly
- `command-tool`: tool name to invoke
- `command-arg-mode`: 'raw' forwards raw args
- `metadata.openclaw` fields (gating rules): always, emoji, os (darwin/linux/win32), requires.bins, requires.anyBins, requires.env, requires.config, primaryEnv, install (brew/node/go/uv/download)

**Skill Loading Precedence:**
1. Workspace skills: `<workspace>/skills` (highest)
2. Managed/local: `~/.openclaw/skills`
3. Bundled: shipped with OpenClaw (lowest)
4. Extra dirs: `skills.load.extraDirs` config
5. Plugin skills: loaded when plugin enabled

**Runtime Injection:**
- Skills NOT loaded into context by default
- System prompt includes compact list (name, description, location)
- Model reads SKILL.md only when needed - keeps base prompt small
- Skills watcher auto-refreshes on SKILL.md changes

**ClawHub Marketplace:**
- Public registry at clawhub.dev
- 13,700+ skills (March 2026)
- CLI: `clawhub search/install/publish/sync`
- Semantic versioning, changelogs, tags

**Security:**
- Skills treated as untrusted code
- **ClawHavoc incident (Jan-Mar 2026):** 1184+ malicious skills uploaded, 3 CVEs

### NemoClaw

Doesn't modify skill system. Controls what skills CAN DO through:
- Filesystem policies (write only `/sandbox` + `/tmp`)
- Network policies (explicit allowlist)
- Process policies (Landlock + seccomp + sandbox user)
- Policy in `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`

### Chimera Implication

SKILL.md v2 already extends format with SkillCategory, SkillPermission, 5-tier trust model.

Need:
1. AWS-native skill execution (Lambda/MicroVM)
2. 7-stage security pipeline
3. Tenant-scoped skill isolation

---

## SECTION 3: TOOL EXECUTION

### OpenClaw: Pipeline-based tool system

**Tools go through multi-stage pipeline** (`src/agents/pi-tools.ts: createOpenClawCodingTools`):
1. **Base Tools:** codingTools from pi-coding-agent (read, bash, edit, write)
2. **Custom Replacements:** bash replaced with exec + process tools
3. **OpenClaw Tools:** messaging, browser, canvas, sessions, cron, gateway mgmt
4. **Channel Tools:** Discord, Telegram, Slack, WhatsApp actions
5. **Policy Filtering:** by profiles, providers, agents, groups, sandbox
6. **Schema Normalization:** cleaned for LLM provider compat
7. **AbortSignal Wrapping:** graceful termination

**Built-in Tools:**
- **exec:** shell execution
  - Foreground/background
  - yieldMs auto-backgrounding (10s default)
  - Host targeting (sandbox/gateway/node)
  - Elevated mode, pty support
- **process:** background mgmt - list/poll/log/write(stdin)/kill/clear
  - Scoped per agent
- **read/write/edit:** sandbox-aware filesystem tools
- **apply_patch:** experimental multi-file edits (opt-in)

**Tool Event Flow:**
```
LLM decides tool call
  → phase:start event (toolName, toolCallId, args)
  → handleToolExecutionStart flushes pending replies
  → phase:update events (partial results)
  → phase:result (final result + isError flag)
  → result fed back to context
```

**Sandboxing (Docker):**
- **Modes:** off / non-main / all
- **Scope:** session (one container per session) / agent (one per agent) / shared
- **Workspace access:** none (default) / ro / rw
- **Elevated mode** bypasses sandbox (gated by config)

**Tool Policy System (5 layers):**
1. **Tool Profile:** `tools.profile` base allowlist
2. **Provider Tool Profile:** `tools.byProvider[provider].profile`
3. **Global/Per-Agent:** `tools.allow` / `tools.deny`
4. **Provider Policy:** per-provider allow/deny
5. **Sandbox Policy:** `tools.sandbox.tools.allow` / `deny`

**Rule:** Deny always wins. Non-empty allow blocks all others.

**MCP Integration:** Added via mcporter on top of Pi. MCP servers configured and tools exposed through OpenClaw platform layer.

### NemoClaw

Wraps all tool execution in **OpenShell**:
- **Filesystem:** write only `/sandbox` + `/tmp`
- **Network:** deny-by-default
- **Process:** Landlock + seccomp
- **Inference:** all model calls through OpenShell Gateway

### Chimera Implication

Need:
1. Tool pipeline with policy filtering
2. AWS-native sandboxing (AgentCore MicroVMs instead of Docker)
3. Tools target AWS services not local filesystem
4. Cedar policy integration for tool authorization

---

## SECTION 4: SELF-EVOLUTION

### OpenClaw: Skill Creation + Subagent Spawning

**Skill Auto-Generation via skill-creator bundled skill:**
1. Create directory in `~/.openclaw/workspace/skills/`
2. Define SKILL.md with YAML frontmatter + instructions
3. Optional: `scripts/`, `references/`, `assets/` directories
4. Refresh OpenClaw to discover
5. Package for distribution: `scripts/package_skill.py`

Agent can create, edit, improve, and audit skills autonomously.

**Subagent Spawning:**
- Exposed via `subagents` tool
- Run in isolated sessions
- Return summaries to main agent
- System prompt says: "If a task is more complex or takes longer, spawn a sub-agent."
- Configurable model per subagent

**Self-Modification Boundaries:**
System prompt says: "Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested."
Core params protected.

**Learning Loop:**
```
Bootstrap files injected at startup
  → memory flush before compaction saves durable memories
  → agent refines skills via skill-creator
  → session compaction summarizes older interactions
```

### NemoClaw

No additional self-evolution. Sandboxing constrains self-modification.

### Chimera Implication

Chimera goes further:
- Cedar policy constraints
- Evolution safety harness with rate limiting
- Canary deployments

**Make self-evolution safe at enterprise scale.**

---

## SECTION 5: MULTI-USER MODEL

### **CRITICAL FINDING:** OpenClaw is designed as personal assistant with ONE-USER trust model, NOT multi-tenant.

**Single-User Design:**
- Authenticated Gateway callers treated as trusted operators
- Multiple users need separate VPS/Gateway instances
- All operators on single Gateway can see each other's data (by design)

**Session Isolation (`session.dmScope`):**
- `main` (default): all DMs share main session
- `per-peer`: isolate by sender ID
- `per-channel-peer`: isolate by channel + sender (recommended)
- `per-account-channel-peer`: isolate by account + channel + sender

**Agent Isolation:**
Single Gateway hosts multiple agents with separate workspaces, state dirs, sessions, auth profiles.

**Auth Model:**
```
Authentication (token/password/trusted-proxy/none)
  → Authorization (5 operator scopes: read/write/admin/pairing/approvals + node role)
  → Rate limit: 3 control-plane writes per 60s per actor
```

Auth in `src/gateway/auth.ts` (`resolveGatewayAuth`), authorization in `src/gateway/server-methods.ts` (`authorizeGatewayMethod`).

### NemoClaw

No multi-tenancy. Sandbox-level isolation only. Multiple users = multiple sandbox instances.

### Chimera Implication

**BIGGEST DIFFERENTIATION.** OpenClaw punts on multi-tenancy.

**Chimera has:**
- DynamoDB tenant isolation with GSI FilterExpressions
- Per-tenant KMS
- IAM boundaries
- Cedar policies
- 6-table schema designed from ground up for multi-tenant

---

## SECTION 6: COMPUTER/ACCOUNT ACCESS

### OpenClaw: Host computer access via Nodes

**Direct Access:**
- `exec` tool runs shell commands
- read/write/edit for filesystem
- Sandbox controls access

**Node System:**
Companion devices (macOS/iOS/Android/headless) connect via WebSocket with `role:node`.

**Node Capabilities:**
- **macOS:** Canvas, Camera, Screen Recording
- **iOS:** Canvas, camera, screen recording, location
- **Android:** notifications, contacts, calendar, motion, photos, Canvas
- `node.invoke` tool executes device-local actions remotely

**Exec Target Options:**
- `host=sandbox` (Docker, default)
- `host=gateway` (Gateway host)
- `host=node` (paired device via system.run)

**Exec Approval System** (`~/.openclaw/exec-approvals.json`):
1. **Security:** deny / allowlist / full
2. **Ask:** off / on-miss / always
3. **Ask Fallback:** default deny when UI unavailable

Approval UI shows command, args, CWD, agent ID. Options: Allow once / Always allow / Deny.

### NemoClaw: Strict controls

- **Filesystem:** `/sandbox` + `/tmp` only
- **Network:** deny-by-default with TUI approval
- **Process:** Landlock + seccomp
- All inference through gateway

### Chimera Implication

**Fundamental shift:** Agent has AWS ACCOUNT access, not local computer.

Instead of `exec/read/write` on filesystem:
- 25 core AWS service tools across 4 tiers
- Cedar policies for operation boundaries
- Per-tenant IAM roles
- AWS Organizations for multi-account

**Approval:** Cedar policy eval + human-in-the-loop for high-risk.

---

## SECTION 7: MEMORY AND PERSISTENCE

### OpenClaw: Markdown Files + SQLite Vector Search

**Memory Architecture:**
- **MEMORY.md:** curated long-term memory (decisions, preferences, facts). Only loaded in main/private session.
- **memory/YYYY-MM-DD.md:** daily append-only logs
- **sessions/{sessionKey}.jsonl:** append-only conversation transcript
- **sessions.json:** session metadata (ID, last activity, token counters)

**Memory Tools:**
- `memory_search`: semantic recall over indexed snippets
- `memory_get`: targeted read of specific file/range

**Semantic Search (Hybrid):**
1. Vector similarity via embeddings (OpenAI, Gemini, Voyage, Mistral, Ollama, local)
2. BM25 keyword relevance for exact tokens
3. Merge by union candidates + weighted score

**Persistence Backends:**
- **SQLite (default)** at `~/.openclaw/memory/<agentId>.sqlite` using sqlite-vec + FTS5
- **QMD (experimental)** local-first sidecar with BM25 + vectors + reranking

**Session Management:**
- `sessions.json` key/value map (sessionKey → SessionEntry)
- Transcripts: `<sessionId>.jsonl` append-only
- Auto maintenance: pruning, capping, rotating

**Memory Flush:**
- Triggered at compaction limit
- Silent agentic turn prompts model to write durable memories to `memory/YYYY-MM-DD.md`
- Config: `agents.defaults.compaction.memoryFlush`
- Triggers at `contextWindow - reserveTokensFloor - softThresholdTokens`
- Agent replies `NO_REPLY` if nothing to store (invisible to user)

**Context Compaction:**
- At ~85% context window
- Load transcript → run compaction model (can differ from conversation model) → LLM generates summary → replace older messages → optional post-compaction memory sync

### NemoClaw

Memory in `/sandbox` directory. No additional features. State in `~/.nemoclaw/state.json`.

### Chimera Implication

AgentCore Memory with namespace isolation (`tenant-{id}-user-{id}`):
- DynamoDB for session state (24h TTL)
- S3 for long-term storage
- Vector search via OpenSearch Serverless or Bedrock KB

**Durable multi-tenant memory vs. local-file single-user.**

---

## SECTION 8: MULTI-MODAL CAPABILITIES

### OpenClaw: Full media pipeline

Supports images, audio, video.

**Processing Flow:**
```
Collection (inbound attachments)
  → Selection (per capability, default: first)
  → Model Processing (first eligible provider/CLI)
  → Fallback
  → Output ([Image]/[Audio]/[Video] block)
```

**Providers:**
- **Image:** OpenAI, Anthropic, Google
- **Audio:** OpenAI, Groq, Deepgram, Google, whisper-cli, sherpa-onnx-offline
- **Video:** Google Gemini

**Image Handling from Channels:**
```javascript
Gateway parses attachments into images[] array
  → forwarded as multimodal user message via
  session.prompt(effectivePrompt, {images: imageResult.images})
```

**Computer Use via Nodes:**
- **macOS:** Canvas, Camera, Screen Recording
- **iOS:** Canvas, camera, screen recording, location
- **Android:** notifications, contacts, calendar, motion, photos
- `node.invoke` tool for device-local actions

### NemoClaw

Inherits OpenClaw multi-modal. Inference routed through OpenShell Gateway.

### Chimera Implication

Leverage Bedrock multi-modal models:
- Claude vision for image understanding
- Amazon Nova for multi-modal
- Amazon Transcribe for audio
- Amazon Rekognition for image analysis
- S3 for media storage with pre-signed URLs

---

## SECTION 9: CHIMERA IMPLICATIONS

### Must Replicate (Table Stakes)

| OpenClaw/NemoClaw | Chimera Equivalent |
|-------------------|-------------------|
| ReAct agent loop | Strands Agents event loop |
| Lane Queue serialization | DynamoDB-backed session locking |
| SKILL.md format | SKILL.md v2 (already designed) |
| Context compaction | AgentCore context management |
| Memory search | Amazon OpenSearch / Bedrock KB |
| Subagent spawning | AgentCore multi-agent |
| Exec approval | Cedar policy + human-in-the-loop |
| Multi-modal processing | Bedrock + AWS media services |

### Must Surpass (Differentiators)

| OpenClaw Gap | Chimera Advantage |
|--------------|-------------------|
| No multi-tenancy | 6-table DynamoDB with tenant isolation, per-tenant KMS, IAM |
| Local filesystem only | S3 + DynamoDB + AgentCore Memory with namespaces |
| Docker sandboxing | AgentCore MicroVMs with Cedar policies |
| ClawHub trust issues | 7-stage skill security pipeline |
| Primitive self-evolution | Evolution Safety Harness with rate limits, canary deployments |
| Computer access = local OS | AWS Account access = 25 core services across 4 tiers |
| Memory = local SQLite | Distributed memory with cross-tenant isolation |
| No infrastructure awareness | Self-modifying IaC with DynamoDB-driven CDK synthesis |

### Key Architecture Decisions

1. **Session Mgmt:** DynamoDB sessions table 24h TTL replaces local JSONL. Need Lane Queue equivalent.
2. **Tool System:** Replace filesystem tools with AWS SDK tools. Keep pipeline pattern.
3. **Skill Compat:** Adapter layer for OpenClaw SKILL.md (per mulch mx-d7acdb).
4. **Security:** Enterprise zero-trust via Cedar replaces exec-approvals.json.
5. **Memory:** AgentCore Memory namespace `tenant-{id}-user-{id}` replaces SQLite.
6. **Multi-Modal:** Route through Bedrock not direct provider APIs.

---

## APPENDIX: KEY CODE REFERENCES

### OpenClaw

**Core Runtime:**
- `src/agents/pi-embedded-runner/run.ts`: core agent loop
- `src/agents/pi-tools.ts`: createOpenClawCodingTools tool pipeline
- `src/gateway/auth.ts`: resolveGatewayAuth
- `src/gateway/server-methods.ts`: authorizeGatewayMethod

**Documentation:**
- `docs/tools/exec-approvals.md`
- `docs/concepts/session-pruning.md`
- `docs/nodes/media-understanding.md`

**Config/State:**
- `~/.openclaw/openclaw.json`
- `~/.openclaw/memory/<agentId>.sqlite`
- `~/.openclaw/agents/<agentId>/sessions/`

### NemoClaw

**Security:**
- `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`: baseline policy
- `nemoclaw-blueprint/blueprint.yaml`: manifest

**Runtime:**
- `nemoclaw/src/index.ts`: NVIDIA NIM provider registration
- `scripts/telegram-bridge.js`: runAgentInSandbox
- `scripts/walkthrough.sh`: split-screen demo

**Setup:**
- `bin/lib/onboard.js`: provider setup
- `bin/lib/policies.js`: policy presets

---

## Conclusion

**OpenClaw** is a breakthrough in personal AI assistants with 209k stars proving product-market fit. Its Gateway architecture, skill system, and tool execution pipeline are architecturally sound.

**NemoClaw** addresses security through sandboxing but doesn't fundamentally change the architecture—it's a wrapper, not a reimplementation.

**Chimera** must take OpenClaw's proven patterns and make them enterprise-ready:
- Multi-tenant from day one
- AWS-native (account access instead of computer access)
- 7-stage skill security pipeline
- Evolution Safety Harness for controlled self-modification
- Cedar policy constraints
- DynamoDB + S3 persistence instead of local SQLite

**The critical insight:** OpenClaw treats the local computer as the execution environment. Chimera treats the AWS account as the execution environment. This fundamental shift enables enterprise capabilities OpenClaw can never achieve.
