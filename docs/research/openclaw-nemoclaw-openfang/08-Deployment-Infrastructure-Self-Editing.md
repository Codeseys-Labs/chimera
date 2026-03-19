# OpenClaw Deployment, Infrastructure & Self-Editing

> **Research Date:** 2026-03-19
> **Status:** Complete
> **Related:** [[01-OpenClaw-Core-Architecture]] | [[05-Memory-Persistence-Self-Improvement]] | [[07-Chat-Interface-Multi-Platform]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#Deployment Architectures Overview]]
- [[#Docker and Container Deployment]]
- [[#Self-Hosting Requirements and Options]]
- [[#Cloud Deployment Patterns]]
- [[#Gateway Daemon and Service Management]]
- [[#Configuration Management]]
- [[#Self-Editing Mechanisms]]
- [[#Skill Creation and Hot-Reloading]]
- [[#Auto-Update and Version Management]]
- [[#NemoClaw and OpenShell — Enterprise Deployment]]
- [[#Kubernetes Deployment]]
- [[#Security Hardening for Production]]
- [[#Infrastructure Sizing and Performance]]
- [[#Monitoring and Observability]]
- [[#Migration and Backup]]
- [[#Deployment Decision Matrix]]
- [[#Sources and References]]

---

## Executive Summary

OpenClaw is designed as a self-hosted AI agent platform with flexible deployment options spanning local machines, Docker containers, VPS instances, PaaS platforms, and Kubernetes clusters. The project ships with first-class Docker support (`docker-setup.sh`, `docker-compose.yml`), native OS service integration (launchd on macOS, systemd on Linux), and a comprehensive CLI for lifecycle management.

What distinguishes OpenClaw from typical AI frameworks is its **self-editing architecture**: agents can modify their own personality files (`SOUL.md`, `MEMORY.md`, `IDENTITY.md`, `AGENTS.md`), create new skills at runtime via the skill-creator skill, and persist changes across sessions through plain-text Markdown files in the workspace. This creates a feedback loop where the agent continuously evolves its own capabilities.

NVIDIA's **NemoClaw** stack (announced at GTC 2026) wraps OpenClaw with enterprise-grade security through the **OpenShell** runtime — adding sandboxed execution, a policy engine for filesystem/network/process control, and a privacy router for inference routing decisions.

---

## Deployment Architectures Overview

OpenClaw supports four primary deployment patterns, each with distinct trade-offs:

### Architecture Comparison

| Pattern | Complexity | Isolation | Persistence | Best For |
|---------|-----------|-----------|-------------|----------|
| **Bare-metal / Direct Install** | Low | None (host access) | Host filesystem | Personal use, development |
| **Docker Compose** | Medium | Container-level | Bind mounts / named volumes | Most self-hosting scenarios |
| **Ansible + systemd** | Medium-High | Process-level + Docker sandbox | Host filesystem | Production servers |
| **Kubernetes** | High | Pod/namespace-level | PVCs | Multi-agent enterprise |
| **NemoClaw/OpenShell** | Medium | Micro-VM / Landlock | Sandbox volumes | Enterprise with policy governance |

### Three-Layer Reference Architecture

All production deployments should think in three layers:

```
Layer 3: Channel Adapters
  +-- Telegram, Discord, Slack, WhatsApp, iMessage
  +-- Webhook endpoints
  +-- Control UI (port 18789)

Layer 2: Agent Core
  +-- OpenClaw Gateway (WebSocket control plane)
  +-- Agent sessions, routing, cron
  +-- Skills + memory + personality files
  +-- Model provider connections (Anthropic, OpenAI, Ollama, etc.)

Layer 1: State & Observability
  +-- ~/.openclaw/ (config, credentials, agent state)
  +-- ~/.openclaw/workspace/ (agent files, memory, skills)
  +-- Structured logging (request ID tracing)
  +-- Metrics, backups, alerting
```

This separation allows changing prompts and skills without redeploying the gateway, and swapping channel adapters without touching agent logic.

---

## Docker and Container Deployment

Docker is the recommended deployment method for most self-hosting scenarios. OpenClaw ships official Docker support directly in the repository.

### Quick Start: One-Command Setup

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
./docker-setup.sh
```

The `docker-setup.sh` script performs the following in sequence:

1. Builds the Docker image locally from the Dockerfile (or pulls a remote image if `OPENCLAW_IMAGE` is set)
2. Runs the interactive onboarding wizard (model provider, channels, bind mode)
3. Generates a 64-character gateway token via `openssl rand -hex 32`
4. Starts the gateway via Docker Compose
5. Writes configuration to `.env`
6. Prints the dashboard URL for Control UI access

### Docker Compose Architecture

The `docker-compose.yml` defines two services:

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE:-openclaw:local}
    container_name: openclaw
    restart: unless-stopped
    environment:
      HOME: /home/node
      TERM: xterm-256color
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      - "${OPENCLAW_GATEWAY_PORT:-18789}:18789"   # Gateway / Control UI
      - "${OPENCLAW_BRIDGE_PORT:-18790}:18790"     # Device bridge
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:18789/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3

  openclaw-cli:
    image: ${OPENCLAW_IMAGE:-openclaw:local}
    network_mode: "service:openclaw-gateway"
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - NET_RAW
      - NET_ADMIN
```

**Key design decisions:**

- **`openclaw-gateway`** is the long-running process — the Gateway WebSocket control plane handling sessions, routing, channels, cron, and the Control UI
- **`openclaw-cli`** shares the gateway's network namespace (`network_mode: "service:openclaw-gateway"`) so CLI commands reach the gateway over `127.0.0.1`
- Security hardening on the CLI service: drops `NET_RAW`/`NET_ADMIN` capabilities, enables `no-new-privileges`
- The base image is `node:24-bookworm` (previously `node:22-bookworm`) with OCI annotations
- The container runs as the `node` user (uid 1000), not root

### Host Volume Mounts

Two directories persist outside Docker:

| Host Path | Container Path | Purpose |
|-----------|---------------|---------|
| `~/.openclaw/` | `/home/node/.openclaw` | Config, credentials, agent state, identity |
| `~/.openclaw/workspace/` | `/home/node/.openclaw/workspace` | Agent files — SOUL.md, MEMORY.md, skills, created files |

These bind mounts ensure data survives container restarts and rebuilds.

### Using Pre-Built Images

Skip the local build (saves 30+ minutes) by using the official GitHub Container Registry image:

```bash
export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
./docker-setup.sh
```

Pin to a specific version for reproducibility:

```bash
export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:2026.2.26"
./docker-setup.sh
```

> **Warning:** Only use `ghcr.io/openclaw/openclaw` — similarly named Docker Hub images may be unofficial or malicious.

### Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_IMAGE` | `openclaw:local` | Docker image to use |
| `OPENCLAW_GATEWAY_TOKEN` | (generated) | Auth token for dashboard/API |
| `OPENCLAW_GATEWAY_PORT` | `18789` | Host port for web dashboard |
| `OPENCLAW_BRIDGE_PORT` | `18790` | Host port for device bridge |
| `OPENCLAW_GATEWAY_BIND` | `lan` | Bind mode: `lan`, `loopback` |
| `OPENCLAW_CONFIG_DIR` | `~/.openclaw` | Host path for config |
| `OPENCLAW_WORKSPACE_DIR` | `~/.openclaw/workspace` | Host path for workspace |
| `OPENCLAW_SANDBOX` | (empty) | Set to `1` to enable agent sandboxing |
| `OPENCLAW_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket for sandbox |
| `OPENCLAW_DOCKER_APT_PACKAGES` | (empty) | Extra apt packages to install |
| `OPENCLAW_EXTENSIONS` | (empty) | Extensions to include |
| `OPENCLAW_EXTRA_MOUNTS` | (empty) | Additional bind mounts (comma-separated) |
| `OPENCLAW_HOME_VOLUME` | (empty) | Named volume for `/home/node` |

### Extra Host Mounts

Give the agent access to additional directories:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/projects:/home/node/projects:rw,$HOME/.codex:/home/node/.codex:ro"
./docker-setup.sh
```

This generates `docker-compose.extra.yml` automatically. When running Compose manually:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml up -d
```

### Enabling Agent Sandboxing in Docker

Agent sandboxing runs tool execution inside isolated sub-containers (Docker-in-Docker):

```bash
export OPENCLAW_SANDBOX=1
./docker-setup.sh
```

For rootless Docker:

```bash
export OPENCLAW_SANDBOX=1
export OPENCLAW_DOCKER_SOCKET=/run/user/1000/docker.sock
./docker-setup.sh
```

When sandboxing is active:
- **Available tools in sandbox:** `exec`, `process`, `fs`, `web_search`, `memory_search`
- **Host-only tools (unavailable):** `browser`, `canvas`, `node.*`, `cron`, `gateway`
- Each agent session gets its own isolated container (configurable scope)

### Docker Desktop Sandboxes (Micro VMs)

Docker Desktop offers a dedicated "Sandboxes" feature that runs OpenClaw in micro VMs with stronger isolation:

```bash
# Pull a model via Docker Model Runner
docker model pull ai/llama3

# Create and run the sandbox
docker sandbox create --name openclaw-agent --from openclaw
```

Key advantages:
- API keys are injected via the network proxy — the agent never sees them directly
- Network proxy is configurable to deny connections to arbitrary hosts
- The sandbox can be saved as a reusable image and pushed to a registry

### Custom Multi-Stage Dockerfile

For production builds with full control:

```dockerfile
FROM node:22-bookworm AS builder
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm ui:build && pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

RUN useradd -m -u 1000 node && chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 18789 18790
CMD ["node", "dist/index.js", "gateway", "--allow-unconfigured"]
```

### Production Docker Compose

A complete production-ready stack with reverse proxy, resource limits, and secrets:

```yaml
version: '3.8'

services:
  openclaw-gateway:
    image: ghcr.io/openclaw/openclaw:latest
    container_name: openclaw-gateway
    restart: unless-stopped
    ports:
      - "127.0.0.1:18789:18789"   # Localhost only; nginx handles external
    volumes:
      - openclaw-home:/home/node/.openclaw
      - openclaw-workspace:/home/node/workspace
    environment:
      - NODE_ENV=production
      - OPENCLAW_HOME=/home/node/.openclaw
    secrets:
      - anthropic_key
      - telegram_token
    command: openclaw gateway
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:18789/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"

  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    depends_on:
      openclaw-gateway:
        condition: service_healthy

volumes:
  openclaw-home:
  openclaw-workspace:

secrets:
  anthropic_key:
    file: ./secrets/anthropic_key.txt
  telegram_token:
    file: ./secrets/telegram_token.txt
```

### Common Docker Operations

```bash
# Status check
docker compose ps
docker compose run --rm openclaw-cli gateway probe

# Follow logs
docker compose logs -f openclaw-gateway

# Restart after config changes
docker compose restart openclaw-gateway

# Update to latest image
docker compose down
docker compose pull
docker compose up -d

# Health check endpoints
curl -fsS http://127.0.0.1:18789/healthz
curl -fsS http://127.0.0.1:18789/readyz

# Access shell as root (install extra packages)
docker compose exec -u root openclaw-gateway bash
apt-get update && apt-get install -y ripgrep fd-find

# Run CLI commands
docker compose run --rm openclaw-cli status
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
```

### ClawDock Shell Helpers

For easier day-to-day Docker management:

```bash
# Install ClawDock helpers
source <(openclaw docker helpers)

# Available commands
clawdock-start      # Start the gateway
clawdock-stop       # Stop the gateway
clawdock-dashboard  # Open the Control UI
clawdock-help       # List all commands
```

---

## Self-Hosting Requirements and Options

### Minimum Hardware Requirements

| Resource | Minimum | Recommended | Notes |
|----------|---------|-------------|-------|
| **CPU** | 2 cores | 4 cores | More cores help with concurrent agent sessions |
| **RAM** | 2 GB | 4 GB | 2 GB minimum; `pnpm install` may OOM on 1 GB (exit 137) |
| **Disk** | 10 GB | 20 GB | For images, logs, workspace data |
| **Swap** | None | 3 GB | Helps prevent OOM during builds |
| **Network** | Outbound HTTPS | Outbound HTTPS | To AI provider APIs; no inbound ports needed unless using webhooks |

### Software Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | >= 22 | The installer handles this |
| **Docker** | Engine 20.10+ | Optional; for containerized deployment |
| **Docker Compose** | v2 | Included with Docker Desktop |
| **OS** | Linux (Ubuntu 22.04+), macOS, Windows (WSL2) | Native Windows not supported |
| **Ansible** | 2.14+ | For automated server deployments |

### Deployment Method Comparison

#### 1. Direct Install (npm/pnpm)

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

- Simplest path; installer handles Node.js, dependencies, daemon setup
- Gateway runs as a native OS service (launchd/systemd)
- Full host access — suitable for personal trusted environments
- One-line installer: `curl -fsSL https://openclaw.ai/install | bash`

#### 2. Docker Compose

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw && ./docker-setup.sh
```

- Containerized isolation with bind-mounted persistence
- Reproducible across machines
- Easy cleanup: remove container, spin up fresh
- Recommended for most self-hosting scenarios

#### 3. Ansible (Production Servers)

- Automated installation with security hardening
- Tailscale VPN integration for remote access
- UFW firewall configuration
- Docker installed for agent sandboxing (but Gateway runs on host, not in Docker)
- systemd integration for service management

#### 4. PaaS Deployment

Several PaaS providers offer one-click or simplified OpenClaw deployment:

| Provider | Method | Notes |
|----------|--------|-------|
| **Sevalla** | Docker image deployment | Use `manishmshiva/openclaw` image; add API key as env var |
| **Zeabur** | Template or custom Docker | Firewall management for dedicated servers |
| **ClawCloud** | Managed OpenClaw | Pre-configured, deploy in under a minute |
| **Railway** | Docker wrapper repo | Uses `openclaw-railway` template |
| **Tencent Cloud Lighthouse** | Application template | Select "OpenClaw (Clawdbot)" under AI Agent |
| **ClawPod.cloud** | Full managed stack | First agent in 60 seconds |
| **DoneClaw** | Production-grade managed | Handles Docker, servers, security, updates |

#### 5. Podman (Rootless)

```bash
podman run -d --name openclaw \
  -v ~/.openclaw:/home/node/.openclaw \
  -v ~/openclaw/workspace:/home/node/.openclaw/workspace \
  -p 18789:18789 \
  ghcr.io/openclaw/openclaw:latest
```

- Rootless container execution
- With `--quadlet` option, installs as a systemd user service
- Same image as Docker; no modifications needed

#### 6. Raspberry Pi

OpenClaw runs on Raspberry Pi 4 (4GB+ RAM). The ARM64 image is available:

```bash
docker pull ghcr.io/openclaw/openclaw:latest
docker compose up -d
```

Performance notes: startup is slower; steady-state operation is fine for personal use.

---

## Cloud Deployment Patterns

### VPS Deployment (Hetzner, DigitalOcean, GCP, AWS)

The most common production deployment pattern:

```bash
# SSH into your VPS
ssh root@your-server-ip

# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone and deploy
git clone https://github.com/openclaw/openclaw.git
cd openclaw
export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
./docker-setup.sh
```

**Best practices for VPS deployment:**
- Keep the Gateway bound to loopback (`127.0.0.1`)
- Access via SSH tunnel: `ssh -L 18789:127.0.0.1:18789 user@server`
- Or use Tailscale Serve/Funnel for secure remote access
- Set up a reverse proxy (nginx/Caddy) with TLS for any external exposure

### Reverse Proxy with TLS (nginx)

```nginx
server {
    listen 443 ssl;
    server_name openclaw.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/openclaw.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openclaw.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Tailscale Integration

OpenClaw has built-in Tailscale support:

```json5
{
  gateway: {
    tailscale: {
      mode: "serve"    // tailnet-only HTTPS
      // or: "funnel"  // public HTTPS via Tailscale Funnel
    }
  }
}
```

- **`serve`**: tailnet-only HTTPS via `tailscale serve` (uses Tailscale identity headers)
- **`funnel`**: public HTTPS via Tailscale Funnel (no VPN needed for clients)
- Gateway stays bound to loopback; Tailscale handles the secure tunnel

### Bare-Metal / Colocation Economics

For high-utilization workloads, bare-metal avoids cloud GPU pricing:

| Metric | Cloud (A10G/L4) | Bare-Metal |
|--------|-----------------|------------|
| Monthly cost | ~$2,800+ | ~$500-800 (amortized) |
| Network latency | Variable | <2ms (same facility) |
| Scaling | Elastic | Fixed capacity |
| Management | Managed | Self-managed |

From the SitePoint production case study (4 weeks, 5-9 agents):
- Tasks processed grew from 8,400/week to 14,800/week (+76%)
- Uptime improved from 94.2% to 99.6%
- Cost per 1,000 tasks dropped from $168 to $78 (-54%)
- Total 30-day infrastructure spend: $4,920
- Total tasks processed: 47,200

---

## Gateway Daemon and Service Management

The OpenClaw Gateway is designed to run as a persistent background service.

### macOS (launchd)

Installed as a `LaunchAgent` (`ai.openclaw.gateway`):

```bash
openclaw onboard --install-daemon
# or directly:
openclaw gateway install
```

Management:
```bash
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway status
```

### Linux (systemd)

Installed as a systemd user service (`openclaw-gateway.service`):

```bash
openclaw onboard --install-daemon
```

Management:
```bash
systemctl --user start openclaw-gateway
systemctl --user stop openclaw-gateway
systemctl --user status openclaw-gateway
journalctl --user -u openclaw-gateway -f
```

**Important:** On Linux, ensure systemd user lingering so the Gateway survives logout:
```bash
loginctl enable-linger $USER
```

`openclaw doctor` checks for this and fixes it automatically.

### Podman Quadlet

With the `--quadlet` option, installs as a systemd user service for the `openclaw` user:

```bash
openclaw gateway install --quadlet
systemctl --user start openclaw-gateway
```

### Gateway Configuration

The Gateway is the WebSocket control plane. Key configuration in `openclaw.json`:

```json5
{
  gateway: {
    port: 18789,          // Default port
    bind: "127.0.0.1",    // Loopback only (default)
    auth: {
      mode: "token",      // or "password"
      token: "your-token"
    },
    tailscale: {
      mode: "serve"       // Optional: serve or funnel
    }
  }
}
```

---

## Configuration Management

### Configuration File Location and Format

OpenClaw stores its configuration in `~/.openclaw/openclaw.json` (JSON5 format, allowing comments and trailing commas). Legacy path `~/.clawdbot/moltbot.json` is still supported.

The Gateway watches this file for changes and applies them automatically. Reload modes:
- **`hybrid`** (default): hot-reload most settings, restart for structural changes
- **`hot`**: hot-reload everything possible
- **`restart`**: always restart on config change
- **`off`**: manual restart required

### Minimal Configuration

The smallest valid config is just a model identifier:

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
}
```

Everything else falls back to defaults.

### Full Configuration Structure

Top-level keys in `openclaw.json`:

```json5
{
  // Authentication profiles for model providers
  auth: {
    profiles: {
      anthropic: { apiKey: "sk-ant-..." },
      openai: { apiKey: "sk-..." },
      ollama: { baseUrl: "http://localhost:11434" }
    }
  },

  // Model provider configuration
  models: {
    default: "anthropic/claude-opus-4-6",
    fallbacks: ["openai/gpt-4o", "ollama/llama3"]
  },

  // Agent configuration
  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace",
      sandbox: {
        mode: "off",       // "off", "non-main", "all"
        scope: "session",  // "session", "agent", "shared"
        workspaceAccess: "full"
      }
    },
    list: [
      {
        name: "architect",
        model: "anthropic/claude-opus-4-6",
        workspace: "~/projects/my-app",
        permissions: {
          blocklist: ["file:write", "file:delete"]
        }
      }
    ]
  },

  // Tool policies (deny always takes precedence)
  tools: {
    profile: "standard",
    deny: ["browser"],
    allow: []
  },

  // Channel configuration
  channels: {
    telegram: { token: "..." },
    discord: { token: "..." },
    slack: { token: "..." }
  },

  // Gateway configuration
  gateway: {
    port: 18789,
    bind: "127.0.0.1",
    auth: { mode: "token", token: "..." },
    tailscale: { mode: "serve" }
  },

  // Auto-update configuration
  update: {
    channel: "stable",
    checkOnStart: true,
    auto: {
      mode: "notify-only",  // "notify-only", "confirm", "silent"
      schedule: "0 3 * * *"
    }
  }
}
```

### Per-Agent Configuration

Each agent can have isolated configuration:

```bash
openclaw agents add architect \
  --model claude-opus-4-6 \
  --workspace ~/projects/my-app \
  --description "System architect"

openclaw agents add reviewer \
  --model claude-opus-4-6 \
  --workspace ~/projects/my-app \
  --description "Code reviewer"

# Restrict reviewer from modifying code
openclaw config set agents.reviewer.permissions.blocklist \
  '["file:write", "file:delete", "shell:rm"]'
```

### Nix Mode (Declarative Configuration)

For NixOS/Home Manager users, OpenClaw supports a fully declarative configuration mode:

```bash
export OPENCLAW_NIX_MODE=1
```

In Nix mode:
- Automatic installation and self-modification processes are disabled
- Configuration is treated as read-only
- Missing dependencies show Nix-specific error messages
- `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` should point to Nix-managed locations

The recommended approach is `nix-openclaw`, a Home Manager module.

### Security-Relevant Configuration

```json5
{
  // DM and group policies
  channels: {
    telegram: {
      dmPolicy: "allowlist",     // "pairing", "allowlist", "open", "disabled"
      groupPolicy: "disabled"    // "allowlist", "open", "disabled"
    }
  },

  // Sandbox configuration
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",      // Sandbox non-main sessions
        scope: "session",      // One container per session
        workspaceAccess: "read-only"
      }
    }
  },

  // Tool policies (deny always takes precedence)
  tools: {
    deny: ["browser", "gateway"],
    allow: ["exec", "fs", "memory_search"]
  }
}
```

---

## Self-Editing Mechanisms

OpenClaw's self-editing architecture is one of its most distinctive and consequential features. Unlike most AI frameworks where configuration is static, OpenClaw agents can read and write their own configuration, personality, and memory files at runtime. This creates what researchers call a "self-expanding tool loop."

### The Eight Identity Files

OpenClaw defines an agent's identity through eight editable plain-text Markdown files:

| File | Purpose | Agent Can Modify? |
|------|---------|-------------------|
| `AGENTS.md` | Operating instructions, behavioral rules | Yes |
| `SOUL.md` | Personality, tone, boundaries | Yes |
| `IDENTITY.md` | Name, vibe, emoji, self-concept | Yes |
| `USER.md` | Human context — who the user is | Yes |
| `TOOLS.md` | Tool usage notes and preferences | Yes |
| `HEARTBEAT.md` | Periodic/proactive task definitions | Yes |
| `MEMORY.md` | Long-term curated memory | Yes |
| `BOOTSTRAP.md` | First-run setup instructions | Yes (once) |

These files are loaded in a specific order at the start of each session, forming the agent's system prompt:

```
AGENTS.md -> SOUL.md -> IDENTITY.md -> USER.md -> TOOLS.md -> HEARTBEAT.md -> MEMORY.md
```

> **Key insight:** OpenClaw doesn't have a traditional "system prompt." It has eight Markdown files that together form something closer to a personality specification. And crucially, the agent has write access to all of them.

### How Self-Modification Works

Because OpenClaw embeds a coding agent with full filesystem access (read, write, exec), the agent can modify its own personality files using standard file operations:

```
1. Agent reads MEMORY.md to recall context
2. Agent learns something new during a session
3. Agent writes updated content to MEMORY.md
4. On next session load, the updated memory is injected into context
```

Example `MEMORY.md` content an agent might write:

```markdown
## Things I've Learned
- User prefers TypeScript over Python
- The staging server is at 192.168.1.42
- Deploy scripts are in ~/deploy/
- User's timezone is PST; don't schedule before 9 AM
```

### Self-Modification Propagation

Changes to identity files propagate differently:

| Change Type | When It Takes Effect | Mechanism |
|-------------|---------------------|-----------|
| `MEMORY.md` update | Next session load | File re-read at session start |
| `SOUL.md` personality change | Next session load | File re-read at session start |
| Skill creation/edit | Within current session | Hot-reload via skills watcher |
| `AGENTS.md` rule change | Next session load | File re-read at session start |

### Self-Modification Safety

OpenClaw protects certain aspects of identity:

- `IDENTITY.md` establishes a core identity that the agent is encouraged to maintain
- `AGENTS.md` contains meta-instructions about how the agent should handle self-modification
- The "bootstrap ritual" creates initial identity files and is typically a one-time event
- Daily memory notes are stored in `memory/YYYY-MM-DD.md` files, keeping `MEMORY.md` for curated long-term knowledge

### Implications and Risks

As noted by Starkslab's analysis:

> "An agent that rewrites its own personality, creates its own tools, and persists its own memory across sessions while protecting its identity from external manipulation — that's not a chatbot feature. That's the beginning of something else."

Risks of self-editing include:
- **Personality drift**: The agent gradually changes its behavior in unintended ways
- **Memory corruption**: Bad data in MEMORY.md persists across all future sessions
- **Instruction injection**: Malicious inputs could trick the agent into modifying AGENTS.md
- **Unbounded skill creation**: The agent might create tools that exceed intended permissions

See [[05-Memory-Persistence-Self-Improvement]] for deeper analysis of memory architecture and self-improvement patterns.

---

## Skill Creation and Hot-Reloading

### Skill Architecture

Skills are packaged capability modules that extend what an agent can do. Each skill is a directory:

```
skill-name/
+-- SKILL.md          # Metadata + LLM instructions (required)
+-- scripts/          # Executable code
+-- references/       # Reference materials
+-- assets/           # Images, templates, etc.
```

The `SKILL.md` file uses YAML frontmatter for metadata and Markdown for instructions:

```markdown
---
name: my-custom-skill
description: "Does something useful when the user asks for X"
version: 1.0.0
---

# My Custom Skill

Instructions for the agent on how to use this skill...
```

The `name` and `description` fields are crucial — OpenClaw uses them to determine when to activate the skill.

### Skill-Creator Skill (Self-Expanding Tool Loop)

OpenClaw includes a built-in `skill-creator` skill that enables agents to design, package, and install new capabilities for themselves. The process:

1. **Understanding**: Agent analyzes concrete examples of how the skill will be used
2. **Planning**: Identifies necessary scripts, references, and assets
3. **Initializing**: Uses `init_skill.py` to generate a new template skill directory
4. **Editing**: Customizes `SKILL.md` and adds resources
5. **Packaging**: Bundles the skill for distribution (via `package_skill.py`)
6. **Iterating**: Refines based on real usage feedback

This creates a powerful feedback loop: the agent encounters a recurring task, creates a skill for it, and from then on has that capability permanently.

### Hot-Reloading

OpenClaw supports hot-reloading of skills — changes to `SKILL.md` files take effect during an active session without a gateway restart:

1. A "skills watcher" monitors skill folders for file modifications
2. When a `SKILL.md` changes, the skills snapshot is updated
3. The refreshed skill list is used in the next agent turn
4. No restart of the gateway is needed

This means an agent can:
- Create a new skill
- The skill is immediately available
- Test and iterate on the skill
- All within a single session

### Skill Marketplace Warning

The community maintains `awesome-openclaw-skills` with hundreds of skills across categories like coding agents, calendar management, content automation, data analysis, and security auditing.

> **Security warning:** Research has found that up to 20% of skills on the ClawHub marketplace contain malicious payloads including credential theft, data exfiltration, and backdoors. Always vet skills by reading source code before installing.

---

## Auto-Update and Version Management

### Update Channels

OpenClaw provides three update channels:

| Channel | Behavior | Use Case |
|---------|----------|----------|
| **`stable`** | Waits `stableDelayHours`, then applies with jitter (spread rollout) | Production |
| **`beta`** | Checks on `betaCheckIntervalHours` cadence (default: hourly) | Early adopters |
| **`dev`** | No auto-apply; manual `openclaw update` only | Contributors |

### Update Methods

#### Universal Installer (Recommended)

```bash
curl -fsSL https://openclaw.ai/install | bash
```

Detects existing installation, upgrades in place, runs `openclaw doctor` automatically. Add `--no-onboard` to skip the wizard.

#### npm/pnpm Global Install

```bash
npm install -g openclaw@latest
openclaw doctor --fix
openclaw gateway restart
```

#### Source Install

```bash
openclaw update --channel stable
# or target a specific version:
openclaw update --tag 2026.3.13
```

Preview before applying:
```bash
openclaw update --dry-run
```

#### Docker Update

```bash
docker compose down
docker compose pull
docker compose up -d
```

Or use Watchtower for automatic updates:

```yaml
services:
  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_CLEANUP=true
      - WATCHTOWER_SCHEDULE=0 0 3 * * *
```

### Core Auto-Updater

Configure in `openclaw.json`:

```json5
{
  update: {
    channel: "stable",
    checkOnStart: true,
    auto: {
      mode: "notify-only",   // "notify-only", "confirm", "silent"
      schedule: "0 3 * * *"  // Cron expression
    }
  }
}
```

Modes:
- **`notify-only`**: Alerts the configured channel when an update is available
- **`confirm`**: Asks for confirmation before applying
- **`silent`**: Applies automatically

### `openclaw doctor` — The Safe Update Command

Always run after any update:

```bash
openclaw doctor
```

What it does:
- Migrates deprecated config keys and legacy file locations
- Audits DM policies for risky "open" settings
- Checks Gateway health and offers to restart
- Detects and migrates older gateway services (launchd/systemd/schtasks)
- On Linux, ensures systemd user lingering
- Normalizes config schema to match current version
- Auto-runs on Gateway startup when it detects legacy config

For automation:
```bash
openclaw doctor --yes          # Accept defaults
openclaw doctor --repair       # Apply recommended repairs
openclaw doctor --repair --force  # Aggressive repairs (overwrites custom configs)
```

### Rollback / Version Pinning

```bash
# Pin npm install
npm install -g openclaw@2026.3.1

# Pin source install by tag
openclaw update --tag 2026.3.1

# Pin Docker
export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:2026.3.1"
```

---

## NemoClaw and OpenShell — Enterprise Deployment

### Overview

NVIDIA announced NemoClaw at GTC 2026 (March 16, 2026). Built in consultation with OpenClaw creator Peter Steinberger, it wraps OpenClaw with enterprise-grade security through the OpenShell runtime.

> "Mac and Windows are the operating systems for the personal computer. OpenClaw is the operating system for personal AI." — Jensen Huang, NVIDIA CEO

NemoClaw is the OpenClaw plugin for NVIDIA OpenShell. It moves OpenClaw into a sandboxed environment where every network request, file access, and inference call is governed by declarative policy.

### Architecture

```
+---------------------------------------------------+
|                  NemoClaw Stack                    |
|                                                   |
|  +-------------+  +----------------------------+  |
|  |  Nemotron   |  |     OpenShell Runtime      |  |
|  |  Models     |  |                            |  |
|  |  (local     |  |  +----------------------+  |  |
|  |  inference) |  |  |     Sandbox          |  |  |
|  |             |  |  |  (Landlock+seccomp   |  |  |
|  |             |  |  |   +namespace)        |  |  |
|  +-------------+  |  +----------------------+  |  |
|                    |  +----------------------+  |  |
|                    |  |   Policy Engine      |  |  |
|                    |  |  (filesystem,        |  |  |
|                    |  |   network, process)  |  |  |
|                    |  +----------------------+  |  |
|                    |  +----------------------+  |  |
|                    |  |  Privacy Router      |  |  |
|                    |  |  (local vs cloud     |  |  |
|                    |  |   inference)         |  |  |
|                    |  +----------------------+  |  |
|                    +----------------------------+  |
|                                                   |
|  +-----------------------------------------------+|
|  |          OpenClaw Agent Runtime                ||
|  |  (Gateway + Sessions + Skills + Channels)      ||
|  +-----------------------------------------------+|
+---------------------------------------------------+
```

### Three Core Components

#### 1. Sandbox (Isolated Execution)

- Uses Landlock LSM, seccomp, and network namespace isolation
- No access granted by default — everything must be explicitly allowed
- Agents can develop and test skills inside the sandbox without touching the host
- Filesystem access confined to `/sandbox` and `/tmp` (read-write); system paths are read-only
- Container image: `ghcr.io/nvidia/openshell-community/sandboxes/openclaw`

#### 2. Policy Engine (Fine-Grained Control)

- Evaluates every action at the binary, destination, and method level
- Controls filesystem access, network connections, and process execution
- Policies defined in YAML (`openclaw-sandbox.yaml`)
- **Out-of-process enforcement**: policies are enforced outside the agent process, so the agent cannot override them even if compromised
- Unknown hosts are blocked and surfaced to the operator for approval

#### 3. Privacy Router (Inference Routing)

- Routes inference requests based on policy, not the agent's preferences
- Sensitive workloads route to local Nemotron models
- Higher-capability requests route to frontier cloud models
- Agent inference calls never leave the sandbox directly — OpenShell intercepts and routes

```
Agent (sandbox) --> OpenShell Gateway --> NVIDIA Cloud (build.nvidia.com)
                                     +-> Local Nemotron (on-device)
```

Default: routes through `nvidia/nemotron-3-super-120b-a12b` via cloud. Local inference via Ollama and vLLM is experimental but available.

### Single-Command Deployment

```bash
openshell sandbox create --remote spark --from openclaw
```

This works with zero code changes. Any claw or coding agent (OpenClaw, Claude Code, Codex) can run unmodified inside OpenShell.

### NemoClaw Blueprint Lifecycle

The blueprint is a versioned Python artifact:

```
nemoclaw-blueprint/
+-- blueprint.yaml                  # Manifest — version, profiles, compatibility
+-- orchestrator/
|   +-- runner.py                   # CLI runner — plan / apply / status
+-- policies/
    +-- openclaw-sandbox.yaml       # Strict baseline network + filesystem policy
```

Lifecycle stages:
1. **Resolve**: Locate blueprint artifact, check version constraints (`min_openshell_version`, `min_openclaw_version`)
2. **Verify**: Check artifact digest against expected value
3. **Plan**: Determine what OpenShell resources to create or update (gateway, providers, sandbox, inference route, policy)
4. **Apply**: Execute the plan via `openshell` CLI commands
5. **Status**: Report current state

### NemoClaw Capabilities

| Capability | Description |
|-----------|-------------|
| Sandbox OpenClaw | Creates an OpenShell sandbox pre-configured for OpenClaw with strict policies |
| Route inference | Configures inference routing through cloud-hosted Nemotron or local models |
| Manage lifecycle | Handles blueprint versioning, digest verification, and sandbox setup |
| Declarative network policy | Egress rules in YAML; unknown hosts blocked by default |
| Single CLI | `nemoclaw` command orchestrates full stack |

### Target Hardware

| Hardware | Use Case |
|----------|----------|
| NVIDIA GeForce RTX PCs/Laptops | Personal/developer use |
| NVIDIA RTX PRO Workstations | Professional/team use |
| NVIDIA DGX Spark | Edge/department AI |
| NVIDIA DGX Station | Enterprise on-premise |

---

## Kubernetes Deployment

For multi-agent enterprise deployments, OpenClaw can be deployed to Kubernetes.

### Deployment Manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openclaw-gateway
  labels:
    app: openclaw
spec:
  replicas: 1
  selector:
    matchLabels:
      app: openclaw
  template:
    metadata:
      labels:
        app: openclaw
    spec:
      containers:
        - name: openclaw
          image: ghcr.io/openclaw/openclaw:latest
          ports:
            - containerPort: 18789
              name: gateway
            - containerPort: 18790
              name: bridge
          env:
            - name: NODE_ENV
              value: "production"
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: openclaw-secrets
                  key: anthropic-api-key
          volumeMounts:
            - name: openclaw-config
              mountPath: /home/node/.openclaw
            - name: openclaw-workspace
              mountPath: /home/node/.openclaw/workspace
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2000m"
              memory: "2Gi"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 18789
            initialDelaySeconds: 30
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /readyz
              port: 18789
            initialDelaySeconds: 10
            periodSeconds: 10
      volumes:
        - name: openclaw-config
          persistentVolumeClaim:
            claimName: openclaw-config-pvc
        - name: openclaw-workspace
          persistentVolumeClaim:
            claimName: openclaw-workspace-pvc
```

### Secrets and Persistent Volumes

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: openclaw-secrets
type: Opaque
stringData:
  anthropic-api-key: "sk-ant-..."
  telegram-token: "..."
  gateway-token: "..."

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: openclaw-config-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: openclaw-workspace-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 20Gi
```

### Multi-Agent Resource Limits

```yaml
# Per-agent resource constraints
services:
  agent-alex:
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
```

Multi-agent setups can use 500MB-1GB RAM per agent. Plan accordingly.

---

## Security Hardening for Production

### Security Model

OpenClaw operates on a "single trusted operator" model:
- The Gateway owner is trusted
- Inbound content and third-party code are NOT trusted
- DMs from messaging platforms should be treated as untrusted input

### Critical Security Practices

1. **Never run OpenClaw on a machine with sensitive data** — use a dedicated VPS or container
2. **Containerization is strongly recommended** — limit blast radius of any compromise
3. **Bind to localhost** — never expose port 18789 directly to the internet
4. **Use reverse proxy with TLS** — nginx/Caddy with Let's Encrypt for any external access
5. **Enable authentication** — token or password auth on the Gateway
6. **Restrict DM policies** — use `allowlist` or `pairing`, never `open` in production
7. **Enable sandboxing for non-main sessions** — `agents.defaults.sandbox.mode: "non-main"`
8. **Set API billing alerts** — at $25, $50, and $100 before deploying
9. **Vet all skills** — read source code before installing
10. **Monitor outbound network** — use a firewall (Little Snitch, UFW) to control egress

### Known Vulnerabilities (as of early 2026)

- **CVE-2026-25253** (CVSS 8.8): Remote code execution vulnerability
- Over 40,000 exposed OpenClaw instances identified on the public internet, many without authentication
- ClawHub skill marketplace compromise: credential theft, data exfiltration, backdoor payloads

### Docker Security Hardening

```yaml
volumes:
  - ~/.openclaw:/root/.openclaw:rw
  - ~/openclaw/workspace:/root/workspace:rw
  # Do NOT mount entire home directory

# Network isolation for agents that don't need local network
networks:
  openclaw-net:
    internal: true  # No external access

# Resource limits
deploy:
  resources:
    limits:
      cpus: '2.0'
      memory: 2G
```

### Secrets Hygiene

- Never store secrets in shell history or Docker image layers
- Use Docker Compose secrets or environment files (not inline env vars)
- Never bake API keys into images or repos
- Use `openssl rand -hex 32` for generating tokens
- Make tool actions idempotent — do not assume retries are harmless

---

## Infrastructure Sizing and Performance

### Resource Planning

| Setup | RAM | CPU | Disk | Notes |
|-------|-----|-----|------|-------|
| Single agent (personal) | 1-2 GB | 1-2 cores | 2-3 GB | Steady state |
| Single agent (with build) | 2-4 GB | 2 cores | 10 GB | `pnpm install` needs RAM |
| Multi-agent (5 agents) | 4-8 GB | 4 cores | 20 GB | ~512MB-1GB per agent |
| Multi-agent (9 agents) | 8-16 GB | 8 cores | 40 GB | Production-tested |
| With Ollama (local model) | 8-32 GB | 4+ cores | 50+ GB | Model size dependent |
| NemoClaw (with sandbox) | 8+ GB | 4+ cores | 20+ GB | Sandbox image ~2.4 GB |

### Performance Benchmarks (SitePoint Case Study)

From a 4-week production deployment with 5-9 agents on bare metal:

| Metric | Week 1 | Week 4 | Change |
|--------|--------|--------|--------|
| Tasks processed (weekly) | 8,400 | 14,800 | +76% |
| Uptime | 94.2% | 99.6% | +5.4pp |
| Median latency (seconds) | 3.2 | 1.9 | -41% |
| Cost per 1,000 tasks | $168 | $78 | -54% |
| Peak concurrent agents | 5 | 9 | +80% |
| Total infrastructure spend (30 days) | | $4,920 | |
| Total tasks processed (30 days) | | 47,200 | |

Key insight: self-hosted agents get dramatically better with tuning, but the first two weeks are expensive and unstable. Budget for the ramp-up period.

---

## Monitoring and Observability

### Built-in Monitoring Stack

Enable with the monitoring profile:

```bash
docker compose --profile monitoring up -d
```

### Health Check Endpoints

```bash
curl -fsS http://127.0.0.1:18789/healthz   # Liveness
curl -fsS http://127.0.0.1:18789/readyz     # Readiness
```

### Structured Logging

OpenClaw supports structured logging with request ID tracing:

```json5
{
  logging: {
    level: "info"    // "debug", "info", "warn", "error"
  }
}
```

Best practice: structure logs by request ID; do not rely on a single log file. Ensure time synchronization — drifting clocks corrupt debugging.

### Operational Checklist

- Predictable restarts: process restarts should be intentional and fast
- Stable persistence: state lives outside the container/process
- Secrets hygiene: API keys never baked into images
- Auditability: you can trace tool calls and outcomes
- Latency budget: you know where your time goes (model, retrieval, tools)
- Rollback path: previous image/tag/config readily available

---

## Migration and Backup

### What to Migrate

The entire `~/.openclaw/` directory is the migration target:

| Path | Contents |
|------|----------|
| `~/.openclaw/openclaw.json` | Main gateway configuration |
| `~/.openclaw/credentials/` | Provider auth state |
| `~/.openclaw/agents/` | Per-agent state |
| `~/.openclaw/workspace/` | Agent files — SOUL.md, MEMORY.md, skills |
| `~/.openclaw/skills/` | Installed skills |
| `~/.openclaw/identity/` | Agent identity files |

### Backup

```bash
# Stop the gateway
openclaw gateway stop

# Create backup
tar czf openclaw-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C ~ .openclaw/

# Optional: encrypt
gpg --symmetric openclaw-backup-*.tar.gz
```

### Restore

```bash
openclaw gateway stop
mv ~/.openclaw ~/.openclaw.broken
tar xzf openclaw-backup-*.tar.gz -C ~/
npm install -g openclaw@<same-version>
openclaw doctor
openclaw gateway start
```

The version pin is important — restoring old config against a new version can cause problems.

### Migration to New Server

```bash
# On old server:
openclaw gateway stop
tar czf openclaw-migration.tar.gz -C ~ .openclaw/
scp openclaw-migration.tar.gz user@new-server:~/

# On new server:
tar xzf openclaw-migration.tar.gz -C ~/
npm install -g openclaw@latest
openclaw doctor
openclaw gateway start
```

### Common Migration Pitfalls

1. **Copying only `openclaw.json`**: Not enough — many providers store state under `credentials/`, `agents/`
2. **Permission/ownership mismatch**: Ensure state dir + workspace are owned by the user running the gateway
3. **Version mismatch**: Pin to the same version first, verify, then upgrade
4. **Secrets in backups**: Encrypt backup files; they contain API keys and credentials
5. **Profile/state-dir mismatch**: Run the gateway with the same profile/state dir you migrated

---

## Deployment Decision Matrix

### Choose Your Path

| If you want... | Use... |
|----------------|--------|
| Fastest setup | `curl -fsSL https://openclaw.ai/install \| bash` |
| Container isolation | `./docker-setup.sh` with Docker Compose |
| Pre-built image (skip build) | `OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest" ./docker-setup.sh` |
| Production VPS | Ansible playbook + systemd + Tailscale |
| PaaS simplicity | Sevalla, Zeabur, ClawCloud, Railway |
| Enterprise security | NemoClaw + OpenShell |
| Declarative config | Nix mode with Home Manager |
| Kubernetes scale | K8s manifests with PVCs and secrets |
| Raspberry Pi | ARM64 Docker image |
| Full privacy (no cloud) | Local models via Ollama + Docker |
| Self-editing agent | OpenClaw (full tool access) |
| Controlled self-editing | NemoClaw (policy-enforced sandbox) |

### Who Should (and Shouldn't) Self-Host

**Self-host if:**
- You need full system access for the agent (filesystem, shell, email, calendar)
- Data privacy is a hard requirement
- You want to customize agent behavior without vendor constraints
- You have operational experience managing services

**Don't self-host if:**
- You're not comfortable with basic server administration
- You don't have a process for security updates
- You need SLA guarantees
- You don't want to manage API keys and billing

---

## Sources and References

### Official Documentation
- OpenClaw Docs — Docker: https://docs.openclaw.ai/install/docker
- OpenClaw Docs — Updating: https://docs.openclaw.ai/install/updating
- OpenClaw Docs — Migration: https://docs.openclaw.ai/install/migrating
- OpenClaw Docs — Doctor: https://docs.openclaw.ai/gateway/doctor
- OpenClaw GitHub: https://github.com/openclaw/openclaw

### NemoClaw / OpenShell
- NVIDIA NemoClaw Overview: https://www.nvidia.com/en-us/ai/nemoclaw/
- NVIDIA NemoClaw Developer Guide — Architecture: https://docs.nvidia.com/nemoclaw/latest/reference/architecture.html
- NVIDIA Developer Blog — OpenShell: https://developer.nvidia.com/blog/run-autonomous-self-evolving-agents-more-safely-with-nvidia-openshell/
- NVIDIA Newsroom Announcement: https://nvidianews.nvidia.com/news/nvidia-announces-nemoclaw
- Penligent — NemoClaw Security Analysis: https://www.penligent.ai/hackinglabs/nvidia-openclaw-security-what-nemoclaw-changes-and-what-it-still-cannot-fix/
- CIO — NemoClaw Security: https://www.cio.com/article/4146545/nvidia-nemoclaw-promises-to-run-openclaw-agents-securely.html
- VentureBeat — NemoClaw Enterprise: https://venturebeat.com/technology/nvidia-lets-its-claws-out-nemoclaw-brings-security-scale-to-the-agent
- CrewAI Blog — Orchestrating with NemoClaw: https://blog.crewai.com/orchestrating-self-evolving-agents-with-crewai-and-nvidia-nemoclaw/
- DEV Community — NemoClaw Stack: https://dev.to/arshtechpro/nemoclaw-nvidias-open-source-stack-for-running-ai-agents-you-can-actually-trust-50gl

### Deployment Guides
- xTom — How to Self-Host OpenClaw: https://xtom.com/blog/how-to-self-host-openclaw/
- freeCodeCamp — Deploy 24x7 AI Agent: https://www.freecodecamp.org/news/how-to-deploy-your-own-24x7-ai-agent-using-openclaw/
- SitePoint — 4 Weeks Production Lessons: https://www.sitepoint.com/openclaw-production-lessons-4-weeks-self-hosted-ai/
- IONOS — Install and Run with Docker: https://www.ionos.com/digitalguide/server/configuration/openclaw-docker/
- Docker Blog — Run in Docker Sandboxes: https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/
- Simon Willison — Running in Docker: https://til.simonwillison.net/llms/openclaw-docker
- Hivelocity — Self-Hosting Complete Guide: https://www.hivelocity.net/kb/self-hosting-openclaw-guide/
- DEV Community — Self-Hosting Complete Guide: https://dev.to/miso_clawpod/self-hosting-openclaw-complete-guide-15hn
- LumaDock — Docker and Kubernetes: https://lumadock.com/tutorials/openclaw-docker-kubernetes
- LumaDock — Upgrade Safely: https://lumadock.com/tutorials/openclaw-upgrade-maintenance
- Runcell — Deploy OpenClaw on Zeabur: https://www.runcell.dev/blog/deploy-openclaw
- LinkedIn — Self-Hosting Complete Guide: https://www.linkedin.com/pulse/self-hosting-your-own-ai-agent-openclaw-complete-setup-baburaj-r-rosyc
- Tencent Cloud — Docker Deployment: https://www.tencentcloud.com/techpedia/140024
- SimpleOpenClaw — Self-Hosting Guide: https://www.simpleopenclaw.com/blog/self-hosting-complete-guide
- OpenClaw Configuration Guide: https://openclaw-ai.online/configuration/

### Self-Editing and Architecture Analysis
- Starkslab — OpenClaw Self-Modification: https://starkslab.com/notes/openclaw-self-modification-how-agents-rewrite-themselves
- Medium — Understanding OpenClaw on Cloud Infrastructure: https://medium.com/@alexrozdolskiy/understanding-openclaw-self-hosted-ai-agents-on-cloud-infrastructure-28d28e4078f3
- Medium — OpenClaw Changed Automation in 2026: https://medium.com/@kanerika/openclaw-how-a-self-hosted-ai-agent-changed-automation-in-2026-6ba728345d53
- DeepWiki — OpenClaw Repository Documentation: https://deepwiki.com/openclaw/openclaw

### Security
- PacGenesis — Security Risks & Best Practices: https://pacgenesis.com/openclaw-security-risks-what-security-teams-need-to-know-about-ai-agents-like-openclaw-in-2026/
- sapt.ai — Architecture, Security, Best Practices: https://sapt.ai/insights/openclaw-architecture-security-agentic-ai-best-practices

### Update and Version Management
- OpenClaw GitHub Issue #12855 — Built-in Auto-Update: https://github.com/openclaw/openclaw/issues/12855
- AllThings.how — Update Guide: https://allthings.how/how-to-update-openclaw-every-install-method-covered/
