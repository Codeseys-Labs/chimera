# Disaggregation Patterns

> Parent: [[Index]]

OpenClaw's hub-and-spoke architecture has well-defined seams that allow components to
run independently. Here are the patterns, from simplest to most scalable.

## Pattern 1: Remote Gateway

**What:** Gateway runs on a server; clients connect from anywhere via WebSocket.

**How:**
```bash
# On server
openclaw gateway --bind 0.0.0.0 --port 18789

# Clients configure remote gateway URL
# CLI, WebUI, macOS app all support this natively
```

**Access methods:** Tailscale, SSH tunnel, or SSM port forwarding (recommended for AWS).

**Use case:** Multi-device personal use. One gateway, access from laptop + phone.

---

## Pattern 2: Docker Compose (Gateway + CLI as Separate Containers)

**What:** Already supported in OpenClaw's `docker-compose.yml`.

**How:**
```yaml
services:
  openclaw-gateway:
    image: openclaw:local
    volumes:
      - ~/.openclaw:/root/.openclaw
      - ~/.openclaw/workspace:/root/.openclaw/workspace
    ports:
      - "18789:18789"
    command: node dist/index.js gateway --bind 0.0.0.0 --port 18789

  openclaw-cli:
    image: openclaw:local
    volumes:
      - ~/.openclaw:/root/.openclaw
      - ~/.openclaw/workspace:/root/.openclaw/workspace
    entrypoint: node dist/index.js
```

**Use case:** Local dev isolation. Gateway and interactive CLI in separate containers.

---

## Pattern 3: Multiple Isolated Gateways on One Host

**What:** Each gateway has its own config, state, workspace, and port.

**How:**
```bash
# Team 1 gateway
OPENCLAW_STATE_DIR=~/.openclaw-team1 openclaw gateway --port 18789

# Team 2 gateway
OPENCLAW_STATE_DIR=~/.openclaw-team2 openclaw gateway --port 18790
```

Each instance gets:
- Isolated configuration
- Isolated state directory
- Isolated workspace
- Unique port

**Use case:** Multi-tenant on a single machine. Cheap but no compute isolation.

---

## Pattern 4: Headless Nodes as Remote Execution Endpoints

**What:** Gateway forwards `exec` calls to remote nodes instead of running locally.

**How:**
```bash
# On the execution machine (any OS)
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

The node advertises capabilities (`system.run`, `system.which`) and the Gateway can
route tool execution to it. Execution guarded by exec approvals and per-agent allowlists.

**Use case:** Agent runs on cloud but executes commands on a local build machine.
Or: separate "safe" and "dangerous" execution environments.

---

## Pattern 5: AgentCore Runtime (The Production Answer)

**What:** Gateway on EC2 handles routing. Agent execution moves to serverless microVMs.
Each user session gets its own isolated microVM with dedicated IAM credentials.

**Architecture:**

| Component | Where | Cost | Role |
|-----------|-------|------|------|
| Gateway | EC2 (c7g.large) | ~$35/mo | Message routing only |
| Agent Runtime | AgentCore microVMs | Pay-per-use | Agent execution, per-user |
| Memory | AgentCore Memory | Managed | Long-term semantic memory |

**Key properties of AgentCore microVMs:**
- Sessions persist up to 8 hours
- State preserved across invocations within a session
- Idle sessions cost nothing (no compute running)
- Session termination = microVM terminated + memory sanitized
- Long-term memory survives session termination via AgentCore Memory

**This is the only pattern that provides:**
- True compute isolation between users
- IAM-scoped credentials per user
- Pay-per-use economics
- No shared memory, no shared process, no shared credentials

See [[AgentCore Deployment]] for full details.

---

## Pattern 6: Channel Plugins as Separate Services

**What:** Channel adapters are npm plugins. In theory, they could be deployed as
separate microservices that forward normalized `MessageEnvelope` events to the Gateway.

**Current state:** Channels are loaded in-process by the Gateway. Separating them would
require wrapping each channel plugin in a thin WS client that connects to the Gateway
and forwards messages. Not officially supported but architecturally feasible given the
plugin API.

**Use case:** If a single channel (e.g., WhatsApp with heavy media processing) needs
its own scaling profile.

---

## Comparison Matrix

| Pattern | Compute Isolation | Multi-User | Cost | Complexity |
|---------|-------------------|------------|------|------------|
| Remote Gateway | None | Shared process | Low | Low |
| Docker Compose | Container-level | Shared process | Low | Low |
| Multiple Gateways | Process-level | Separate instances | Medium | Medium |
| Headless Nodes | Execution-level | Shared gateway | Medium | Medium |
| **AgentCore Runtime** | **MicroVM-level** | **Per-user isolated** | **Pay-per-use** | **Low (managed)** |
| Channel Plugins | Varies | N/A | Varies | High |

## Recommendation

For multi-tenant/multi-user deployment on AWS:

**AgentCore Runtime** is the clear winner. It's the only pattern that provides true
per-user isolation without managing infrastructure. The Gateway stays thin (routing
only), agent execution scales automatically, and you get IAM-based permission scoping
for free.

For personal/dev use: Remote Gateway + Docker Compose is sufficient.
