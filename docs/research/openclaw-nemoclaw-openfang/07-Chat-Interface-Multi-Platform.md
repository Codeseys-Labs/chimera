# Chat Interface & Multi-Platform Communication

> Research into how OpenClaw, NemoClaw, and OpenFang integrate with chat platforms, their API interfaces, streaming protocols, bot frameworks, and multi-platform communication architecture.

**Related:** [[01-OpenClaw-Core-Architecture]] | [[06-Multi-Agent-Orchestration]] | [[08-Deployment-Infrastructure-Self-Editing]]

---

## Table of Contents

- [[#1. Architectural Overview]]
- [[#2. OpenClaw Gateway — The Central Control Plane]]
- [[#3. Channel Adapter Architecture]]
- [[#4. Supported Platforms — OpenClaw]]
- [[#5. Platform-Specific Integration Details]]
- [[#6. Streaming & Real-Time Communication]]
- [[#7. API Interfaces & Protocols]]
- [[#8. Message Normalization & Routing]]
- [[#9. Access Control & Security]]
- [[#10. OpenFang — 40 Channel Adapters in Rust]]
- [[#11. NemoClaw — Privacy Router & Guardrails]]
- [[#12. Alternative Clients & Web Chat]]
- [[#13. Cross-Platform Identity & Session Continuity]]
- [[#14. Enterprise Integration Patterns]]
- [[#15. Comparison — OpenClaw vs OpenFang vs NemoClaw]]
- [[#16. Code Examples]]
- [[#17. Key Takeaways for AWS-Native Design]]
- [[#Sources]]

---

## 1. Architectural Overview

The three projects in this ecosystem share a fundamental design insight: **conversation is the primary interface to AI agents**. Rather than building dedicated UIs and asking users to come to them, they connect to messaging apps people already use.

The architecture follows a hub-and-spoke pattern:

```
+-----------------------------------------------------------+
|              Messaging Surfaces (Spokes)                  |
| WhatsApp | Telegram | Discord | Slack | Signal | Web ...  |
+----------------------------+------------------------------+
                             |
                    WebSocket / HTTP
                             |
                             v
+-----------------------------------------------------------+
|              Gateway / Kernel (Hub)                        |
| +----------+ +----------+ +----------+ +-----------+      |
| | Channel  | | Session  | | Command  | | Plugin    |      |
| | Bridges  | | Manager  | | Queue    | | System    |      |
| +----------+ +----------+ +----------+ +-----------+      |
| +----------+ +----------+ +----------+ +-----------+      |
| | Hooks    | |  Cron    | |Heartbeat | |  Auth     |      |
| | Engine   | |Scheduler | | System   | | + Trust   |      |
| +----------+ +----------+ +----------+ +-----------+      |
+----------------------------+------------------------------+
                             |
                             v
+-----------------------------------------------------------+
|                    Agent Runtime                           |
| Tool Execution | LLM Providers | Memory | Skills          |
+-----------------------------------------------------------+
```

**Key principle:** The Gateway is the only process that holds messaging sessions. Exactly one WhatsApp session per host, one Telegram bot connection, etc. This prevents session conflicts and ensures message delivery reliability.

### Design Philosophy Differences

| Aspect | OpenClaw | OpenFang | NemoClaw |
|--------|----------|----------|----------|
| Language | TypeScript (Node.js 22+) | Rust (14 crates, 137K LOC) | OpenClaw + NVIDIA OpenShell |
| Channel count | 23+ built-in, 50+ with plugins | 40 adapters built-in | Inherits OpenClaw channels |
| Architecture | Gateway daemon (single process) | Kernel-based Agent OS (single binary) | Sandboxed OpenClaw + privacy router |
| Primary interface | Chat-first, no dedicated UI | Dashboard + chat + Tauri desktop | Chat + enterprise governance |

---

## 2. OpenClaw Gateway -- The Central Control Plane

The Gateway is the heart of OpenClaw. It is a **single Node.js process** (default port `18789`) that manages all client connections, sessions, and message routing. It is not a distributed system -- one process handles channel adapters, message routing, agent runtime, and session storage.

### Gateway Components

```
Gateway (ws://127.0.0.1:18789)
|
+-- Channel Bridges        # Persistent connections to messaging platforms
+-- Session Manager         # JSONL transcripts, conversation state
+-- Command Queue           # Ordered message processing
+-- Plugin System           # Extensible capabilities
+-- Hooks Engine            # Event-driven triggers
+-- Cron Scheduler          # Proactive task execution
+-- Heartbeat System        # Agent wake-up mechanism
+-- Auth + Trust            # Token auth, device pairing
+-- Canvas                  # Visual output workspace
```

### How It Works

1. **Continuous operation**: The Gateway runs 24/7. This persistence enables proactive behavior -- there is always a process ready to initiate actions without waiting for human input.
2. **WebSocket server**: All clients (messaging platforms, CLI, web UI, mobile apps) connect via WebSocket.
3. **Message normalization**: Each channel adapter transforms platform-specific formats into a unified internal envelope.
4. **Deterministic routing**: The host configuration controls routing, not the AI model. Replies go back to the channel they came from.
5. **State management**: Sessions are stored as JSONL transcripts on local disk.

### Configuration

All channel credentials are stored in `~/.openclaw/openclaw.json` under the `channels` section, with authentication tokens in `~/.openclaw/credentials/`.

```json5
{
  gateway: {
    port: 18789,
    host: "127.0.0.1"
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: "${TELEGRAM_BOT_TOKEN}",
      dmPolicy: "pairing"
    },
    discord: {
      enabled: true,
      botToken: "${DISCORD_BOT_TOKEN}",
      allowedGuilds: ["123456789"]
    },
    slack: {
      enabled: true,
      appToken: "${SLACK_APP_TOKEN}",
      botToken: "${SLACK_BOT_TOKEN}"
    },
    whatsapp: {
      enabled: true
    },
    webchat: {
      enabled: true,
      cors: ["https://yourdomain.com"]
    }
  }
}
```

---

## 3. Channel Adapter Architecture

### The Adapter Pattern

Each messaging platform gets a standardized channel adapter that normalizes protocol-specific complexity into a consistent internal format. The adapter pattern decouples the agent logic from platform specifics entirely.

```
Platform-Specific API
       |
       v
+------------------+
| Channel Adapter  |
| - Auth handler   |
| - Message parser |
| - Media handler  |
| - Thread manager |
| - Rate limiter   |
+------------------+
       |
       v
Normalized Message Envelope
```

### The Normalized Message Format

Regardless of source platform, the agent receives this structure:

```json
{
  "channel": "telegram",
  "sender": {
    "id": "8734062810",
    "name": "Alice",
    "username": "@alice"
  },
  "body": "What's on my calendar today?",
  "attachments": [],
  "replyTo": null,
  "threadId": null,
  "metadata": {
    "chatId": "-1001234567890",
    "messageId": 42
  }
}
```

The agent code never needs to know whether a message came from WhatsApp or Discord. This abstraction is what allows one agent to serve all platforms with identical logic.

### Media Normalization

Each platform handles media differently:
- **Telegram**: sends photos as `file_id`
- **WhatsApp**: sends them as URLs
- **Slack**: sends them as attachment objects
- **Discord**: sends them as embed objects

The Channel Layer converts all of these into a common "attachment" format. Voice notes from WhatsApp get transcribed to text before reaching the model.

### Bot Framework Libraries Used

| Platform | Library | Transport |
|----------|---------|-----------|
| WhatsApp | **Baileys** (TypeScript) | WhatsApp Web WebSocket protocol |
| Telegram | **grammY** (TypeScript) | Bot API (long-polling or webhook) |
| Discord | **discord.js** | Gateway WebSocket + REST |
| Slack | **Bolt** SDK | Socket Mode or HTTP Events API |
| Signal | **signal-cli** | Signal protocol |
| iMessage | **BlueBubbles** / **imsg** (AppleScript) | macOS-native |
| Microsoft Teams | Custom extension | Bot Framework |
| Google Chat | Chat API | Workspace integration |
| Matrix | matrix-js-sdk | Client-Server API |
| IRC | irc-framework | IRC protocol |

---

## 4. Supported Platforms -- OpenClaw

OpenClaw supports 50+ integrations across multiple categories:

### Core Channels (Built-in)

| Platform | Auth Method | Difficulty | Notes |
|----------|-------------|------------|-------|
| WhatsApp | QR code via Baileys | Medium | WhatsApp Web protocol, not official API |
| Telegram | Bot token from BotFather | Easy | Most straightforward setup |
| Discord | Bot token + intents | Medium | Requires Message Content Intent |
| Slack | OAuth (App + Bot tokens) | Medium | Socket Mode or HTTP Events API |
| Signal | signal-cli | Hard | Privacy-focused |
| iMessage | BlueBubbles server | Hard | macOS only |
| WebChat | Built-in | Easy | Browser interface via Gateway WS |

### Enterprise Channels

| Platform | Auth Method | Notes |
|----------|-------------|-------|
| Microsoft Teams | App registration | Enterprise-ready |
| Google Chat | Workspace integration | Chat API |
| Mattermost | Bot token | Self-hosted Slack alternative |
| Feishu/Lark | App credentials | Chinese enterprise market |
| Webex | Bot token | Cisco collaboration |

### Community / Privacy Channels

| Platform | Notes |
|----------|-------|
| Matrix | Decentralized, open protocol |
| Nostr | Decentralized DMs via NIP-04 |
| IRC | Classic protocol |
| Tlon Messenger | P2P ownership-first |
| Nextcloud Talk | Self-hosted |
| Synology Chat | NAS-integrated |
| LINE | East Asian market |
| Zalo | Vietnamese market |
| Twitch | Streaming platform |

### Plugin Channels

Additional platforms available via `openclaw plugins install`:
- Microsoft Teams
- Matrix
- LINE
- Mattermost
- And more from the community

---

## 5. Platform-Specific Integration Details

### WhatsApp (Baileys)

WhatsApp is the most-requested channel. OpenClaw uses **Baileys**, a TypeScript library that speaks the WhatsApp Web WebSocket protocol. This means you connect an existing WhatsApp account (not a Business API account) via QR code -- just like WhatsApp Web.

**Setup flow:**
```bash
openclaw channels login whatsapp
# Scan QR code with WhatsApp app
# Session credentials stored locally
```

**Key considerations:**
- Baileys is **not** an official Meta API -- it reverse-engineers the WhatsApp Web protocol
- Session can break if WhatsApp updates their protocol
- Only one active web session per phone number
- For production: use WhatsApp Cloud API with Meta Business account instead

**Configuration:**
```json5
{
  channels: {
    whatsapp: {
      enabled: true,
      dmPolicy: "pairing",
      textChunkLimit: 4096,
      // Optional: WhatsApp Cloud API for production
      // cloudApi: { phoneNumberId: "...", accessToken: "..." }
    }
  }
}
```

### Telegram (grammY)

Telegram is "easy mode" because it has a formal Bot API. OpenClaw uses **grammY**, a popular TypeScript framework.

**Transport modes:**
- **Long polling** (default): Works behind NAT, no inbound ports needed
- **Webhook mode**: Lower latency at scale, requires HTTPS endpoint

**Key features:**
- Forum topics with per-topic agent routing
- Inline keyboards and callback buttons
- Live stream preview via `editMessageText`
- Sticker support (send, search, cache)
- Reaction notifications
- Exec approval prompts in DMs or channels

**Configuration:**
```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      streaming: "partial",           // off | partial | block | progress
      groups: {
        "*": { requireMention: true }
      },
      capabilities: {
        inlineButtons: "allowlist"    // off | dm | group | all | allowlist
      }
    }
  }
}
```

### Discord (discord.js)

Discord requires enabling **Privileged Gateway Intents** (Message Content, Server Members, Presence) in the Developer Portal.

**Key features:**
- Server, channel, and DM support
- Thread awareness (`:thread:` session keys)
- Guild-based access control
- Rich embeds for formatted output
- Reaction support

**Setup:**
```bash
openclaw channels login discord --label "my-server"
# Enter bot token from Discord Developer Portal
```

### Slack (Bolt SDK)

Slack integration supports two connection modes:

1. **Socket Mode** (recommended): No public endpoint needed. Uses WebSocket via App-Level Token (`xapp-`).
2. **HTTP Events API**: For VPS deployments with HTTPS endpoints.

**Required scopes:**
```
chat:write          # Send messages
channels:history    # Read public channel messages
app_mentions:events # Detect @mentions
im:history          # Read DM messages
```

**Unique Slack features:**
- Native streaming with `nativeStreaming` option
- Slash commands
- Interactive messages
- Thread management
- Block Kit formatting
- Channel-specific output formatting

### Signal (signal-cli)

Privacy-focused integration using `signal-cli`:

```json5
{
  channels: {
    signal: {
      enabled: true,
      // Requires signal-cli daemon running
    }
  }
}
```

### Microsoft Teams

Enterprise-ready integration requiring app registration:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      allowFrom: ["user@company.com"],
      groupAllowFrom: ["*"],
      groupPolicy: "open"
    }
  }
}
```

---

## 6. Streaming & Real-Time Communication

### WebSocket Protocol (Gateway Core)

The Gateway uses WebSocket (`ws://127.0.0.1:18789/ws`) for real-time bidirectional communication. This provides:

- **Low latency**: Sub-second message delivery
- **Bidirectional flow**: Platform to Gateway and Gateway to Platform simultaneously
- **Persistent connections**: No repeated handshakes
- **Streaming responses**: Token-by-token delivery to chat platforms

**WebSocket message format (Gateway Protocol v3):**

```json
// Client sends
{
  "method": "chat.run",
  "params": {
    "message": "Hello, AI!",
    "sessionKey": "session-123",
    "options": {
      "thinking": "medium",
      "stream": true
    }
  },
  "id": 1
}

// Gateway streaming response
{
  "type": "chat.delta",
  "data": {
    "sessionKey": "session-123",
    "delta": "Hello!",
    "runId": "run-456"
  }
}

// Completion
{
  "type": "chat.done",
  "data": {
    "sessionKey": "session-123",
    "runId": "run-456",
    "usage": {
      "promptTokens": 10,
      "completionTokens": 20,
      "totalTokens": 30
    }
  }
}
```

### Streaming Modes

OpenClaw supports four streaming modes, configurable per-channel:

| Mode | Behavior | Best For |
|------|----------|----------|
| `off` | Wait for complete response, send as one message | Platforms with strict rate limits |
| `partial` | Edit message in place as tokens arrive | Telegram, Discord (ChatGPT-like experience) |
| `block` | Send complete blocks (paragraphs/sections) | Long-form responses |
| `progress` | Show progress indicator while generating | Maps to `partial` on most platforms |

**Channel streaming support:**

| Channel | `off` | `partial` | `block` | `progress` |
|---------|-------|-----------|---------|------------|
| Telegram | Yes | Yes | Yes | maps to `partial` |
| Discord | Yes | Yes | Yes | maps to `partial` |
| Slack | Yes | Yes | Yes | Yes (native) |
| WhatsApp | Yes | No | Yes | No |
| WebChat | Yes | Yes | Yes | Yes |

### Block Streaming Architecture

```
Model output
  |
  +-- text_delta/events
       |
       +-- (blockStreamingBreak=text_end)
       |     +-- EmbeddedBlockChunker emits blocks as buffer grows
       |
       +-- (blockStreamingBreak=message_end)
             +-- Chunker flushes at message_end
             +-- Channel send (block replies)
```

**Configuration:**
```json5
{
  agents: {
    defaults: {
      blockStreamingDefault: "on",      // "on" | "off"
      blockStreamingBreak: "text_end",  // "text_end" | "message_end"
      blockStreamingChunk: {
        minChars: 100,
        maxChars: 2000,
        breakPreference: "paragraph"
      },
      blockStreamingCoalesce: {
        minChars: 50,
        maxChars: 4000,
        idleMs: 500
      }
    }
  }
}
```

### Platform-Specific Streaming Behavior

**Telegram:**
- Uses `sendMessage` + `editMessageText` for live preview
- Single preview message edited in place
- Final edit replaces preview with complete response
- `/reasoning stream` sends reasoning to live preview while generating

**Discord:**
- Similar edit-in-place pattern
- Respects 2000-character message limit with automatic chunking

**Slack:**
- Native streaming support when `nativeStreaming: true`
- Uses `chat.startStream` + `append` + `stop` for real-time delivery
- Falls back to `sendMessage` + `editMessageText` pattern

### Text Chunking

Each platform has different message length limits. OpenClaw handles chunking automatically:

| Platform | Character Limit | Chunking |
|----------|----------------|----------|
| Slack | 4,000 | Automatic |
| Discord | 2,000 | Automatic |
| Telegram | 4,096 | Automatic |
| WhatsApp | 4,096 | Automatic |

Chunk modes:
- `length` (default): Split at character limit
- `newline`: Prefer paragraph boundaries (blank lines) before length splitting

---

## 7. API Interfaces & Protocols

OpenClaw exposes three distinct API interfaces for external integration.

### 7.1 Gateway WebSocket API (Primary)

The native protocol with 96+ typed RPC methods:

```go
// From openclaw-go SDK
client := gateway.NewClient(
    gateway.WithToken("my-token"),
    gateway.WithOnEvent(func(ev protocol.Event) {
        fmt.Printf("event: %s\n", ev.EventName)
    }),
)
if err := client.Connect(ctx, "ws://localhost:18789/ws"); err != nil {
    log.Fatal(err)
}
result, err := client.ChatSend(ctx, protocol.ChatSendParams{
    SessionKey: "main",
    Message:    "Hello from Go!",
})
```

**Key RPC methods:**
- `chat.run` / `chat.send` -- Send messages and get responses
- `chat.startStream` -- Begin streaming response
- `session.list` / `session.get` -- Session management
- `agent.list` / `agent.create` -- Agent CRUD
- `config.get` / `config.patch` -- Runtime configuration
- `cron.list` / `cron.add` -- Scheduled tasks
- `approval.approve` / `approval.reject` -- Exec approvals
- `pairing.list` / `pairing.approve` -- Device pairing

### 7.2 OpenAI-Compatible Chat Completions API

Drop-in replacement for OpenAI's `/v1/chat/completions`:

```bash
curl -X POST http://localhost:18789/v1/chat/completions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openclaw:main",
    "messages": [
      {"role": "user", "content": "Hello"}
    ],
    "stream": true
  }'
```

**Streaming response (SSE):**
```
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":"!"}}]}
data: [DONE]
```

This enables any OpenAI-compatible client to talk to OpenClaw without modification.

### 7.3 OpenResponses API

OpenClaw's newer API, compatible with OpenAI's Responses API (`POST /v1/responses`):

```bash
# Non-streaming
curl -sS http://localhost:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{"model": "openclaw", "input": "hi"}'

# Streaming (SSE)
curl -N http://localhost:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{"model": "openclaw", "stream": true, "input": "hi"}'
```

**SSE event types:**
- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed`

**Supported request fields:**
- `input` -- Message content (structured items: messages, function call outputs, images)
- `instructions` -- System-level instructions
- `tools` / `tool_choice` -- Client-defined function tools
- `stream` -- Enable SSE streaming
- `max_output_tokens` -- Token limit
- `reasoning` -- Reasoning configuration
- `metadata` / `store` -- Session persistence
- `previous_response_id` -- Conversation threading
- `truncation` -- Context management

### 7.4 Tools Invoke API

Direct tool execution endpoint:

```bash
POST /tools/invoke
Content-Type: application/json
Authorization: Bearer <token>

{
  "tool": "browser.navigate",
  "params": {"url": "https://example.com"}
}
```

### 7.5 Streaming Agent Run API

```bash
POST /v1/agent/run/stream
Content-Type: application/json
Authorization: Bearer <token>

{
  "message": "Hello",
  "sessionKey": "session-123",
  "stream": true
}

# Response (SSE)
event: delta
data: {"delta": "Hello", "runId": "run-456"}

event: delta
data: {"delta": "!", "runId": "run-456"}

event: done
data: {"runId": "run-456", "finishReason": "stop"}
```

### 7.6 The OpenResponses Adapter Pattern

The OpenResponses API serves as a **universal bridge** for connecting any agent backend to OpenClaw's messaging infrastructure:

```
User (WhatsApp / Telegram / Discord)
  --> OpenClaw Gateway
    --> POST /v1/responses (with Bearer auth)
      --> Your adapter server
        --> Your agent / team / pipeline (any SDK)
      <-- OpenResponses JSON or SSE
    <-- OpenClaw
  <-- User
```

This pattern enables:
- **Framework-agnostic integration**: Connect LangChain, CrewAI, AutoGen, or custom agents
- **Language-agnostic**: Your adapter can be Python, Go, Rust, or anything with HTTP
- **One config, many channels**: OpenClaw handles webhooks, auth, and platform quirks

**Adapter server requirements:**
1. Accept `POST /v1/responses` with the OpenResponses schema
2. Read `input`, `stream`, `model` from the request
3. Return `output` and `usage` in OpenResponses format (JSON or SSE)

---

## 8. Message Normalization & Routing

### Routing Hierarchy

When a message arrives, the Gateway follows a strict hierarchy to choose the agent:

1. **Default agent**: `agents.list[].default`, else first list entry, fallback to `main`
2. **Channel match**: Any account on that channel (`accountId: "*"`)
3. **Account match**: `accountId` on the channel
4. **Team match** (Slack): via `teamId`
5. **Guild match** (Discord): via `guildId`
6. **Guild + roles match** (Discord): via `guildId` + `roles`
7. **Parent peer match**: Thread inheritance
8. **Exact peer match**: `bindings` with `peer.kind` + `peer.id`

### Session Key Shapes

Sessions are identified by structured keys:

```
# Direct messages (collapse to agent's main session)
agent:main:main

# Groups
agent:main:telegram:group:-1001234567890

# Forum topics
agent:main:telegram:group:-1001234567890:topic:42

# Discord threads
agent:main:discord:channel:123456:thread:987654

# Slack threads
agent:main:slack:channel:C0AFWV00VQE:thread:1234567890.123456
```

### Multi-Agent Routing

Route different channels/accounts/peers to isolated agents:

```json5
{
  agents: {
    list: [
      { id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" },
      { id: "dev", name: "Dev Assistant", workspace: "~/.openclaw/workspace-dev" }
    ]
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "dev" },
    { match: { channel: "discord", guildId: "456", roles: ["admin"] }, agentId: "dev" }
  ]
}
```

### Multiple Accounts Per Channel

Connect multiple accounts of the same platform to one Gateway:

```bash
openclaw channels login whatsapp --label "US Support" --accountId us-support
openclaw channels login whatsapp --label "EU Support" --accountId eu-support
```

Each account can be bound to a different agent with different memory, skills, and system prompts.

### Broadcast Groups

Send agent responses to multiple channels simultaneously:

```json5
{
  broadcast: {
    strategy: "parallel",
    "deploy-notifications": ["slack:deploy-channel", "discord:ops-channel", "telegram:-100123"]
  }
}
```

Each channel receives a platform-appropriate version (Slack gets rich blocks, Discord gets embeds, Telegram gets markdown).

---

## 9. Access Control & Security

### DM Access Policies

Each channel supports configurable DM policies:

| Policy | Behavior |
|--------|----------|
| `pairing` (default) | Unknown contacts must complete pairing handshake |
| `allowlist` | Only explicitly listed user IDs can interact |
| `open` | Anyone can message (requires `allowFrom: ["*"]`) |
| `disabled` | DMs blocked entirely |

### Pairing System

The device-pairing system issues scoped tokens to approved users:

```bash
# List pending pairing requests
openclaw pairing list telegram

# Approve a specific request
openclaw pairing approve telegram <CODE>

# Pairing codes expire after 1 hour
```

### Group Access Control

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "allowlist",
          allowFrom: ["8734062810", "745123456"],
          requireMention: true
        }
      },
      groupAllowFrom: ["*"]  // Fallback for all groups
    },
    discord: {
      allowedGuilds: ["123456789"]
    },
    webchat: {
      cors: ["https://yourdomain.com"]
    }
  }
}
```

### Localhost Binding

The Gateway defaults to `127.0.0.1` -- it only listens on the loopback interface. This prevents direct internet access. Even if an attacker knows the port, they cannot reach it from outside.

> **Warning:** In January 2026, 21,000+ exposed instances were found with Gateways mistakenly bound to `0.0.0.0` or running on cloud VPS with public IPs.

### Mention Gating

In group chats, the bot can require explicit `@mention` before responding. This prevents the agent from processing all group chatter:

```json5
{
  channels: {
    slack: {
      groups: { "*": { requireMention: true } }
    }
  }
}
```

---

## 10. OpenFang -- 40 Channel Adapters in Rust

OpenFang (by RightNow-AI) takes a different architectural approach to chat integration, building everything in Rust with its `openfang-channels` crate.

### Channel Categories

**Core (7):**
Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Email (IMAP/SMTP)

**Enterprise (6):**
Microsoft Teams, Mattermost, Google Chat, Webex, Feishu/Lark, Zulip

**Social (8):**
LINE, Viber, Facebook Messenger, Mastodon, Bluesky, Reddit, LinkedIn, Twitch

**Community (6):**
IRC, XMPP, Guilded, Revolt, Keybase, Discourse, Gitter

**Privacy (6):**
Threema, Nostr, Mumble, Nextcloud Talk, Rocket.Chat, Ntfy, Gotify

**Workplace (5):**
Pumble, Flock, Twist, DingTalk, Zalo, Webhooks

### Rust Channel Trait System

OpenFang defines channel adapters via Rust traits:

```rust
/// Core channel trait
pub trait Channel {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    fn capabilities(&self) -> ChannelCapabilities;
    async fn start(&self, ctx: ChannelContext) -> Result<()>;
    async fn stop(&self) -> Result<()>;
    async fn probe(&self) -> Result<ChannelProbe>;
}

/// Inbound message handling
pub trait ChannelInbound {
    type RawMessage;
    fn normalize(&self, raw: Self::RawMessage) -> Result<NormalizedMessage>;
    async fn acknowledge(&self, message_id: &str) -> Result<()>;
}

/// Outbound message delivery
pub trait ChannelOutbound {
    async fn send_text(&self, ctx: OutboundContext, text: &str) -> Result<()>;
    async fn send_media(&self, ctx: OutboundContext, media: &[Attachment]) -> Result<()>;
    fn delivery_mode(&self) -> DeliveryMode;
}
```

### Per-Channel Configuration

Each OpenFang adapter supports:
- **Model overrides**: Different LLM per channel
- **DM/group policies**: Fine-grained access control
- **Rate limiting**: Per-channel rate limits
- **Output formatting**: Platform-appropriate message formatting

### WhatsApp Web Gateway

OpenFang includes a built-in WhatsApp Web gateway with QR code auth:

```
POST /login/start     # Generate QR code (returns base64 PNG)
GET  /login/status    # Connection status (disconnected, qr_ready, connected)
POST /message/send    # Send message { "to": "5511999999999", "text": "Hello" }
GET  /health          # Health check
```

### OpenFang Protocol (OFP)

OpenFang introduces its own P2P protocol for agent-to-agent communication:
- **HMAC-SHA256 mutual authentication**
- **Ed25519 manifest signing**
- Part of the `openfang-wire` crate

### REST API

OpenFang exposes 140+ REST/WebSocket/SSE endpoints covering:
- Agent management
- Memory operations
- Workflow execution
- Channel management
- Model configuration
- Skill operations
- A2A communication
- Hands lifecycle

---

## 11. NemoClaw -- Privacy Router & Guardrails

NemoClaw is NVIDIA's enterprise-hardened stack built on top of OpenClaw. It does not replace OpenClaw's chat infrastructure but adds security layers around it.

### Architecture

```
+-----------------------------------------------------------+
|                    NemoClaw Stack                          |
|                                                           |
|  +-----------------------------------------------------+  |
|  |                 NVIDIA OpenShell                     |  |
|  |  +-------+ +----------+ +----------+ +-----------+  |  |
|  |  |Sandbox| | Privacy  | | Policy   | | Network   |  |  |
|  |  | (WASM)| | Router   | | Engine   | | Controls  |  |  |
|  |  +-------+ +----------+ +----------+ +-----------+  |  |
|  +-----------------------------------------------------+  |
|                          |                                 |
|  +-----------------------------------------------------+  |
|  |              OpenClaw Gateway                        |  |
|  |  (All existing channel adapters work unchanged)      |  |
|  +-----------------------------------------------------+  |
|                                                           |
|  +-----------------------------------------------------+  |
|  |           Nemotron Models (Local) +                  |  |
|  |           Frontier Models (Cloud via Privacy Router) |  |
|  +-----------------------------------------------------+  |
+-----------------------------------------------------------+
```

### Privacy Router

The key innovation for chat communication is the **Privacy Router**:

- **Model routing**: Decides whether to use local Nemotron models or cloud frontier models based on data sensitivity
- **Data isolation**: Monitors agent communication, blocks sensitive data from leaving the sandbox
- **Policy enforcement**: YAML-defined policies control which files, network connections, and cloud services the agent can access
- **Audit logging**: Every action is logged and attributable

### How NemoClaw Affects Chat

NemoClaw **inherits all OpenClaw channels** unchanged. The security layer operates between the Gateway and the agent runtime:

1. Message arrives via any channel (WhatsApp, Slack, etc.)
2. Gateway normalizes and routes as usual
3. **OpenShell intercepts** before agent execution
4. Privacy Router checks if the request/response involves sensitive data
5. Policy Engine enforces access controls
6. Agent executes within sandbox
7. Response flows back through OpenShell (filtered if needed)
8. Gateway delivers to the originating channel

### Enterprise Deployment

NemoClaw installs with a single command:

```bash
nemoclaw install
# Installs: OpenClaw + Nemotron models + OpenShell runtime
```

This makes it viable for enterprise teams that need:
- Data Loss Prevention (DLP) on agent communications
- Audit trails for compliance
- Network segmentation
- Role-based access control at the agent level

---

## 12. Alternative Clients & Web Chat

### Built-in WebChat

OpenClaw includes a built-in WebChat interface accessible via the Gateway:

```json5
{
  channels: {
    webchat: {
      enabled: true,
      cors: ["https://yourdomain.com"]
    }
  }
}
```

WebChat connects to the Gateway via WebSocket and defaults to the agent's main session. It provides cross-channel context visibility -- you can see conversations from all channels in one place.

### PinchChat (Community)

PinchChat is an open-source webchat UI with a ChatGPT-like interface:

```
Browser (PinchChat)
    |
    +-- LoginScreen (credentials)
    +-- App.tsx (router)
    +-- Chat + Sidebar
    |     |
    |     +-- Tool call visualization (colored badges, parameters, results)
    |     +-- Session switching
    |     +-- Raw JSON viewer
    |     +-- Channel icons (Discord, Telegram, cron, etc.)
    |
    +-- WebSocket --> Gateway (ws://localhost:18789)
```

**Features:**
- Live tool call visualization -- see what the agent does in real-time
- GPT-like interface with sidebar sessions
- PWA support (installable, offline caching)
- Multi-language (English, French)
- Raw JSON viewer for debugging

**Configuration:**
```env
VITE_GATEWAY_WS_URL=ws://localhost:18789
VITE_LOCALE=en
```

### Other Community Clients

- **webclaw**: Fast, minimal web client
- **clawterm**: Terminal-based client
- **PicoClaw**: Go-based, 10 MB RAM, runs on a $5 RISC-V board
- **ZeroClaw**: Rust, 3.4 MB binary, <10ms startup
- **MimiClaw**: Pure C on ESP32-S3 microcontroller

### Native Companion Apps

OpenClaw ships companion apps for deeper integration:

- **macOS menu bar app**: Quick access, node mode
- **iOS app**: Voice tab, canvas, camera, pairing
- **Android app**: Device commands (notifications, location, SMS, photos, contacts, calendar, motion)

---

## 13. Cross-Platform Identity & Session Continuity

### Identity Linking

OpenClaw supports cross-platform identity linking -- bind Telegram + Discord + WhatsApp to one identity so the agent maintains continuity across apps:

```bash
# Start conversation on WhatsApp
# Continue on Telegram
# Finish on Slack
# Same session context throughout
```

This only works if identities are bound to the same user. Without binding, OpenClaw treats messages from different platforms as separate people (which is also useful in some setups).

### Session Persistence

Session state persists as JSONL transcripts with configurable reset policies. Sessions are stored under:

```
~/.openclaw/agents/<agentId>/sessions/sessions.json
```

The Gateway and ACP session discovery scans disk-backed agent stores for session continuity.

### DM Scope Configuration

```json5
{
  session: {
    dmScope: "main"  // Direct messages share one main session
  }
}
```

When `dmScope` is `main`, OpenClaw infers a pinned owner from `allowFrom` to prevent other DMs from overwriting the main session's `lastRoute`.

---

## 14. Enterprise Integration Patterns

### Pattern A: Channel Mode

Deploy OpenClaw as a native bot on each platform. Users interact directly with the AI in their existing workflows.

```
Slack Workspace --> OpenClaw Bot --> Agent Runtime
Teams Tenant   --> OpenClaw Bot --> Agent Runtime
```

**Best for:** Embedding AI assistants into existing communication workflows.

### Pattern B: MCP Tool Mode

OpenClaw connects to platform APIs via MCP (Model Context Protocol), giving the agent the ability to **operate across platforms** proactively.

```
Agent Runtime --> MCP Tools --> Slack API
                           --> Notion API
                           --> Teams API
```

**Best for:** Cross-platform task automation (e.g., organize Slack discussions and save to Notion, send summary reports in Teams).

### Pattern C: Channel + MCP Dual Track

Combine both approaches:
- Channel Mode for real-time user interaction
- MCP Tool Mode for proactive cross-platform automation

### Four-Layer Architecture for Enterprise

```
Layer 1: Channel Layer     -- Where the AI assistant "lives" (Slack, Teams, WhatsApp)
Layer 2: Tool Layer        -- What the AI assistant "can do" (MCP tools, skills)
Layer 3: Agent Layer       -- How the AI assistant "thinks" (LLM, memory, reasoning)
Layer 4: Gateway Layer     -- How everything connects (routing, auth, sessions)
```

### Enterprise Extensions

- **Archestra**: OpenClaw for enterprise with RBAC (2.8k GitHub stars)
- **openclaw-saml**: SAML authentication integration
- **claw-audit**: Audit logging and compliance tools
- **JetPatch**: Enterprise Control Plane for NemoClaw/OpenShell

---

## 15. Comparison -- OpenClaw vs OpenFang vs NemoClaw

### Chat Interface Capabilities

| Feature | OpenClaw | OpenFang | NemoClaw |
|---------|----------|----------|----------|
| **Built-in channels** | 23+ | 40 | Inherits OpenClaw |
| **Plugin channels** | Yes (50+ total) | Built-in only | Yes |
| **Streaming modes** | 4 (off/partial/block/progress) | Configurable | Inherits OpenClaw |
| **Native apps** | macOS, iOS, Android | Tauri 2.0 desktop | None additional |
| **WebChat** | Built-in + PinchChat | REST API + dashboard | Inherits OpenClaw |
| **Voice support** | Wake words + TTS | Not primary focus | Inherits OpenClaw |

### API Compatibility

| API | OpenClaw | OpenFang | NemoClaw |
|-----|----------|----------|----------|
| WebSocket Gateway | Yes (96+ RPC methods) | Yes (140+ endpoints) | Through OpenShell |
| OpenAI Chat Completions | Yes | Yes | Yes |
| OpenResponses API | Yes | Not documented | Yes |
| MCP Protocol | Yes (client + tools) | Yes (client + server) | Yes |
| A2A Protocol | Partial | Yes (Google A2A) | Yes |
| Custom P2P | No | OFP with HMAC-SHA256 | No |

### Security for Chat

| Feature | OpenClaw | OpenFang | NemoClaw |
|---------|----------|----------|----------|
| **DM pairing** | Yes | RBAC-based | Yes + OpenShell |
| **Sandbox** | Process-level | WASM sandbox | Docker + policy YAML |
| **Privacy router** | No | No | Yes (local vs cloud routing) |
| **Audit logging** | Community plugin | Merkle hash-chain | OpenShell built-in |
| **DLP** | No | Taint tracking | Privacy router |

---

## 16. Code Examples

### Connecting a Go Client to OpenClaw Gateway

```go
package main

import (
    "context"
    "fmt"
    "io"
    "log"
    "time"

    "github.com/a3tai/openclaw-go/gateway"
    "github.com/a3tai/openclaw-go/chatcompletions"
    "github.com/a3tai/openclaw-go/protocol"
)

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // WebSocket Gateway client
    client := gateway.NewClient(
        gateway.WithToken("my-token"),
        gateway.WithOnEvent(func(ev protocol.Event) {
            fmt.Printf("event: %s\n", ev.EventName)
        }),
    )
    defer client.Close()

    if err := client.Connect(ctx, "ws://localhost:18789/ws"); err != nil {
        log.Fatal(err)
    }

    // Send a chat message
    result, err := client.ChatSend(ctx, protocol.ChatSendParams{
        SessionKey: "main",
        Message:    "Hello from Go!",
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("response: %+v\n", result)

    // Streaming via Chat Completions API
    ccClient := chatcompletions.NewClient("http://localhost:18789", "my-token")
    stream, _ := ccClient.CreateStream(ctx, chatcompletions.Request{
        Model: "openclaw:main",
        Messages: []chatcompletions.Message{
            {Role: "user", Content: "Tell me about Go"},
        },
    })
    defer stream.Close()

    for {
        chunk, err := stream.Recv()
        if err == io.EOF {
            break
        }
        fmt.Print(chunk.Choices[0].Delta.Content)
    }
}
```

### Custom Agent Backend via OpenResponses Adapter

```python
# adapter_server.py - Connect any agent framework to OpenClaw
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
import json

app = FastAPI()

@app.post("/v1/responses")
async def handle_response(request: Request):
    body = await request.json()
    user_input = body.get("input", "")
    should_stream = body.get("stream", False)

    if should_stream:
        async def generate():
            # Your agent logic here (LangChain, CrewAI, etc.)
            response_text = await your_agent.run(user_input)
            for chunk in split_into_chunks(response_text):
                event = {
                    "type": "response.output_text.delta",
                    "delta": chunk
                }
                yield f"event: response.output_text.delta\ndata: {json.dumps(event)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        response_text = await your_agent.run(user_input)
        return {
            "output": [{"type": "message", "content": [{"type": "text", "text": response_text}]}],
            "usage": {"input_tokens": 100, "output_tokens": 50}
        }
```

### OpenFang Rust Agent with Channel Adapter

```rust
use openfang::prelude::*;

#[derive(AgentDef)]
#[agent(
    name = "support-bot",
    model = "claude-sonnet-4-20250514",
    sandbox = "sandbox/support.toml"
)]
struct SupportBot {
    #[memory(episodic, capacity = 500)]
    conversation: EpisodicMemory,
    #[memory(semantic, embedding_dim = 1536)]
    knowledge: SemanticMemory,
}

#[agent_impl]
impl SupportBot {
    #[tool]
    async fn search_docs(&self, query: String) -> Result<String> {
        // Search documentation
        Ok(format!("Results for: {}", query))
    }
}

// Channel adapter receives normalized messages
// Agent logic is platform-agnostic
```

### mDNS Gateway Discovery

```go
// Discover OpenClaw gateways on the local network
import "github.com/a3tai/openclaw-go/discovery"

browser := discovery.NewBrowser()
beacons, _ := browser.Browse(ctx)
for _, b := range beacons {
    fmt.Printf("%s -> %s\n", b.DisplayName, b.WebSocketURL())
}
```

---

## 17. Key Takeaways for AWS-Native Design

### Patterns to Adopt

1. **Gateway as control plane**: The single-process Gateway pattern maps well to an ECS/Fargate task or EKS pod that manages all channel connections.

2. **Channel adapter abstraction**: The normalized message format pattern is essential. Any AWS-native version should define a `ChannelAdapter` interface that produces a standard `AgentMessage` type.

3. **Deterministic routing**: Do not let the LLM choose where to send messages. Configuration-driven routing prevents unpredictable behavior.

4. **OpenAI-compatible API**: Supporting `/v1/chat/completions` and `/v1/responses` enables integration with any OpenAI-compatible client, including Bedrock's Converse API.

5. **Streaming is mandatory**: Users expect real-time token-by-token delivery. Plan for SSE (HTTP) and WebSocket (persistent) transports.

6. **Multi-account per channel**: Enterprise deployments need separate bot accounts for different teams/agents on the same platform.

### AWS Service Mapping

| OpenClaw Component | AWS Equivalent |
|-------------------|----------------|
| Gateway process | ECS Fargate task / EKS pod |
| WebSocket server | API Gateway WebSocket + Lambda, or ALB with sticky sessions |
| Session storage (JSONL) | DynamoDB + S3 |
| Channel credentials | Secrets Manager |
| Message queue | SQS / EventBridge |
| Streaming delivery | API Gateway HTTP + SSE, or AppSync subscriptions |
| Agent runtime | Bedrock AgentCore / Lambda |
| Cron scheduler | EventBridge Scheduler |
| mDNS discovery | Cloud Map / Service Discovery |

### Security Considerations

- **Never bind Gateway to 0.0.0.0** in production
- **Use Secrets Manager** for all channel tokens and API keys
- **Implement pairing** for any channel with untrusted inbound messages
- **Rate limit** per-channel to prevent abuse
- **Audit log** all agent actions for compliance
- **Privacy router** pattern (from NemoClaw) is valuable for enterprise -- route sensitive queries to local models

---

## Sources

### Official Documentation
- OpenClaw Docs -- Streaming and Chunking: https://docs.openclaw.ai/concepts/streaming
- OpenClaw Docs -- OpenResponses API: https://docs.openclaw.ai/gateway/openresponses-http-api
- OpenClaw Docs -- Channel Routing: https://docs.openclaw.ai/channels/channel-routing
- OpenClaw Docs -- Telegram: https://docs.openclaw.ai/telegram
- OpenClaw Integrations: https://openclaw.ai/integrations
- OpenClaw GitHub: https://github.com/openclaw/openclaw
- OpenFang GitHub: https://github.com/RightNow-AI/openfang
- OpenFang Documentation: https://openfang.sh/docs/channel-adapters
- NVIDIA NemoClaw: https://www.nvidia.com/en-us/ai/nemoclaw/
- NVIDIA OpenShell Blog: https://developer.nvidia.com/blog/run-autonomous-self-evolving-agents-more-safely-with-nvidia-openshell/

### Architecture Deep Dives
- Reference Architecture: OpenClaw (Opus 4.6): https://robotpaper.ai/reference-architecture-openclaw-early-feb-2026-edition-opus-4-6/
- OpenClaw Architecture Explained (Substack): https://ppaolo.substack.com/p/openclaw-system-architecture-overview
- Deep Dive into OpenClaw Architecture (Medium): https://medium.com/@dingzhanjun/deep-dive-into-openclaw-architecture-code-ecosystem-e6180f34bd07
- OpenClaw Architecture Deep Dive (Entreconnect): https://entreconnect.substack.com/p/we-went-deep-on-openclaws-architecture
- How OpenClaw Works (Medium): https://bibek-poudel.medium.com/how-openclaw-works-understanding-ai-agents-through-a-real-architecture-5d59cc7a4764

### Integration Guides
- Slack x OpenClaw Integration (Meta Intelligence): https://www.meta-intelligence.tech/en/insight-openclaw-slack
- OpenClaw + Notion, Teams & Slack: https://www.meta-intelligence.tech/en/insight-openclaw-integrations
- Multi-Channel Setup Guide (LumaDock): https://lumadock.com/tutorials/openclaw-multi-channel-setup
- Discord Integration (dev.to): https://dev.to/lightningdev123/how-to-set-up-a-personal-ai-agent-with-openclaw-and-discor-4omp
- Slack Integration (Milvus): https://milvus.io/de/blog/stepbystep-guide-to-setting-up-openclaw-previously-clawdbotmoltbot-with-slack.md
- OpenResponses Adapter (HuggingFace): https://huggingface.co/blog/darielnoel/an-agentic-backend-openclaw-integration
- Composio Slack MCP: https://composio.dev/toolkits/slack/framework/openclaw

### SDK & API References
- openclaw-go SDK: https://github.com/a3tai/openclaw-go
- openclaw-channels Rust crate: https://docs.rs/openclaw-channels/latest/openclaw_channels/
- OpenClaw API Reference: https://lzw.me/docs/opencodedocs/openclaw/openclaw/appendix/api-reference/

### Community Clients
- PinchChat: https://github.com/MarlBurroW/pinchchat
- OpenClaw Extension Ecosystem: https://help.apiyi.com/en/openclaw-extensions-ecosystem-guide-en.html

### Enterprise & NemoClaw
- NemoClaw Enterprise Security (VentureBeat): https://venturebeat.com/technology/nvidia-lets-its-claws-out-nemoclaw-brings-security-scale-to-the-agent
- NemoClaw with Guardrails (The New Stack): https://thenewstack.io/nemoclaw-openclaw-with-guardrails/
- NemoClaw Security (SDxCentral): https://www.sdxcentral.com/news/nvidia-details-nemoclaw-security-guardrails-in-wake-of-ai-agent-concerns/
- JetPatch Enterprise Control Plane: https://www.prnewswire.com/news-releases/jetpatch-unveils-enterprise-guardrails-for-nvidia-nemoclaw-bringing-control-to-the-autonomous-agent-frontier-302717380.html

### OpenFang
- OpenFang vs OpenClaw (Medium): https://agentnativedev.medium.com/i-ignored-30-openclaw-alternatives-until-openfang-ff11851b83f1
- OpenFang Deep Dive (i-SCOOP): https://www.i-scoop.eu/openfang/
- OpenFang Benchmarks (SitePoint): https://www.sitepoint.com/openfang-rust-agent-os-performance-benchmarks/
