> Parent: [[Index]]

## Hub-and-Spoke Model

OpenClaw uses a central **Gateway** as the control plane. All clients, channels, nodes,
and the agent runtime communicate through the Gateway via WebSocket RPC.

## Core Components

### Gateway Server

The central WebSocket server, typically on port `18789`. Handles:
- Configuration management (hot-reloadable Zod/TypeBox schemas)
- Agent control and session operations
- Channel management and message routing
- Node pairing and capability advertisement
- System diagnostics and health monitoring

**Key file:** `src/gateway/protocol.ts` — defines the typed RPC protocol
**Startup:** `startGatewayServer()` initializes the WS server and attaches handlers

### WebSocket RPC Protocol

All communication uses JSON frames over WebSocket. Three frame types:

```typescript
// Request (client → gateway)
{ type: "req", id: string, method: string, params: object }

// Response (gateway → client)
{ type: "res", id: string, ok: boolean, payload | error }

// Event (gateway → client, server-push)
{ type: "event", event: string, payload: object, seq?: number }
```

First frame from any client must be a `connect` request declaring role, capabilities,
protocol version, and auth credentials. Gateway responds with `hello-ok`.

Protocol schemas defined with **TypeBox** in `src/gateway/protocol/schema.ts`, which
serves as single source of truth for runtime validation, JSON Schema export, and
Swift codegen.

### Agent Runtime

The agent execution engine. Primary entry point:

```typescript
// src/agents/pi-embedded-runner/run.ts
export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams
): Promise<EmbeddedPiRunResult>
```

**RunEmbeddedPiAgentParams:**
- `sessionId` — user identifier
- `sessionKey` — routing key (e.g., `main:whatsapp:+1234567890`)
- `sessionFile` — path to session JSONL file
- `workspaceDir` — agent workspace directory
- `config` — OpenClaw configuration object
- `prompt` — the user's message
- `provider` — LLM provider name (e.g., `"anthropic"`, `"amazon-bedrock"`)
- `model` — model identifier
- `timeoutMs` — execution timeout
- `runId` — unique run identifier
- `onBlockReply` — callback for streaming responses back to channel

Runs are serialized via per-session and global queues to prevent tool/session races.

**Relationship to pi-coding-agent SDK:** OpenClaw directly imports and instantiates
`AgentSession` from the `pi-coding-agent` SDK via `createAgentSession()`. This gives
fine-grained control over the agent lifecycle, custom tool injection, system prompt
customization, and session persistence. Not a subprocess — it's embedded.

### Channel System

Connects the Gateway to messaging platforms. Each channel normalizes inbound messages
into a unified `MessageEnvelope` format (`src/channels/envelope.ts`).

Built-in channels: WhatsApp, Telegram, Discord, Signal, Slack, SMS, Web
Extension channels: npm-installable plugins

Channels are discovered at Gateway startup via `listChannelPlugins()`. Each plugin
can define its own `gatewayMethods` which extend the Gateway's RPC surface.

**Message flow:**
1. Inbound message from channel
2. Normalize to `MessageEnvelope`
3. Route to Gateway
4. Access control check
5. Session resolution
6. `runEmbeddedPiAgent()` execution
7. Response saved, formatted for channel
8. Delivered back to user

### Tool Registry

Provides capabilities to agents. Combines Pi coding tools with OpenClaw-specific tools.

**Core tools (from pi-coding-agent):** `read`, `write`, `edit`, `exec`, `process`
**OpenClaw tools:** `browser`, `canvas`, `nodes`, `cron`, `sessions`, `message`, `gateway`

Tool creation: `createOpenClawCodingTools()` in `src/tools/registry.ts`
Policy filtering: `filterToolsByPolicy()` merges global, agent, profile, provider,
group, subagent, and sandbox configs to determine the final tool set.

Tool policy supports: `allow`, `deny` for specific tools or groups.
Sandbox restrictions limit tools in containerized environments.
`tools.elevated` is an escape hatch for host-level `exec` bypassing sandbox.

### Memory System

Hybrid vector + BM25 semantic search over:
- Workspace markdown files
- Session transcripts

Managed by `MemoryIndexManager`. Supports multiple embedding providers.
In local mode: SQLite + vector DB on disk.
In AgentCore mode: managed service with per-user namespaces.

### Sandbox System

Optional Docker container isolation for tool execution.

**Modes** (`agents.defaults.sandbox.mode`):
- `"off"` — tools run on host
- `"non-main"` — only non-main sessions sandboxed
- `"all"` — every session sandboxed

**Scope** (`agents.defaults.sandbox.scope`):
- `"session"` — one container per session (default)
- `"agent"` — one container per agent
- `"shared"` — all sandboxed sessions share one container

**Workspace access** (`agents.defaults.sandbox.workspaceAccess`):
- `"none"` — sandbox-specific workspace under `~/.openclaw/sandboxes`
- `"ro"` — agent workspace mounted read-only at `/agent`
- `"rw"` — agent workspace mounted read/write at `/workspace`

### Node System

Companion devices that connect to the Gateway as peripherals, exposing
device-local capabilities (camera, screen, shell, location).

**Connect frame (capability advertisement):**
```json
{
  "type": "req", "method": "connect",
  "params": {
    "role": "node",
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "..." },
    "device": { "id": "fingerprint", "publicKey": "..." }
  }
}
```

**Pairing flow:**
1. Node connects to Gateway WS, requests pairing
2. Gateway stores pending request, emits `node.pair.requested`
3. Admin approves: `openclaw nodes approve <requestId>`
4. Gateway issues a new token
5. Node reconnects with token — now "paired"

Pending requests expire after 5 minutes. State stored in:
- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

**Remote execution:**
```bash
# Invoke a command on a paired node
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>

# Run a headless node host (Linux/Windows/macOS)
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Plugin System

npm-installable extensions. Plugins can register: tools, hooks, HTTP handlers,
channels, Gateway methods, CLI commands, services, model providers.

**Plugin structure:**
```typescript
// Export a function or object
export default (api: OpenClawPluginApi) => {
  api.registerTool({ ... });
  api.registerChannel({ ... });
  api.registerGatewayMethod({ ... });
};
// Or:
export default {
  id: "my-plugin",
  name: "My Plugin",
  configSchema: { ... },
  register(api) { ... }
};
```

**Discovery order:**
1. `plugins.load.paths` from config
2. `<workspace>/.openclaw/extensions/`
3. `~/.openclaw/extensions/`
4. `<openclaw>/extensions/*` (bundled, disabled by default)

Plugins loaded at runtime via `jiti` (supports TypeScript).
Config managed under `plugins` key in `openclaw.json`.
Each plugin can include `openclaw.plugin.json` for config validation.
