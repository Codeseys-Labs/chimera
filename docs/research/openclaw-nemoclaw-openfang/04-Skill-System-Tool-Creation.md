# Skill System & Dynamic Tool Creation

> Part of the [[OpenClaw NemoClaw OpenFang]] research series.
> Related: [[01-OpenClaw-Core-Architecture]] | [[05-Memory-Persistence-Self-Improvement]] | [[06-Multi-Agent-Orchestration]]

## Overview

OpenClaw's skill system is arguably its most consequential architectural decision. Skills are the primary mechanism for extending agent capabilities beyond the base tool set. Every skill is a self-contained package — a `SKILL.md` file with YAML frontmatter and markdown instructions — that gets injected into the agent's system prompt at runtime. The ClawHub registry (clawhub.ai) serves as the npm-style marketplace where developers publish, version, and discover skills. This open ecosystem drove explosive growth but also created a massive supply chain attack surface, culminating in the ClawHavoc incident.

## Skill Format: SKILL.md

Every OpenClaw skill is defined by a `SKILL.md` file — markdown with YAML frontmatter that declares metadata, dependencies, and permissions. When installed, the skill's instructions are injected directly into the agent's system prompt alongside `SOUL.md` and other bootstrap files.

### Anatomy of a Skill

```markdown
---
name: my-custom-skill
version: 1.2.0
description: "A skill that does X"
author: username
tags: [productivity, automation]
tools: [Bash, Read, Write, Edit]
permissions:
  - filesystem: read
  - network: outbound
dependencies:
  - cli: jq
  - npm: typescript
---

# My Custom Skill

## When to Use
Use this skill when the user asks about X or needs to do Y.

## Instructions
1. First, check the current state by running...
2. Then process the results...
3. Output in the following format...

## Examples
### Example 1: Basic usage
User: "Do X with my files"
Action: Run `jq '.key' file.json` and format the output...
```

### Key Fields

| Field | Purpose |
|-------|---------|
| `name` | Unique identifier (slug on ClawHub) |
| `version` | Semver versioning (patch/minor/major) |
| `tools` | Required tools the agent must have in its allow list |
| `permissions` | Declared capabilities (filesystem, network, shell) |
| `dependencies` | CLI tools, npm packages, or system requirements |
| `tags` | Categories for discovery on ClawHub |

### Skill Manifest (skill.yaml)

In addition to `SKILL.md`, skills can include a `skill.yaml` manifest file that provides structured configuration:

```yaml
name: my-skill
version: 1.0.0
author: username
description: "Structured skill configuration"
capabilities:
  - file_read
  - file_write
  - shell_execute
requirements:
  binaries: [jq, curl]
  env_vars: [API_KEY]
install:
  npm: ["some-package@latest"]
  brew: ["some-tool"]
```

The manifest tells OpenClaw what the skill can do, what it needs, and how to set it up. OpenClaw checks these at load time and warns if anything is missing.

### Metadata Block

The `metadata` block in YAML frontmatter declares what the skill needs: environment variables, binaries, and install commands for npm, Homebrew, or uv. OpenClaw checks these at load time and warns if anything is missing. This is the primary mechanism for dependency management — skills don't install their own dependencies, they declare them and the runtime validates.

## ClawHub: The Skill Registry

ClawHub (clawhub.ai) is the official skill marketplace for OpenClaw, created by Peter Steinberger. It functions as "npm for AI agents" — anyone with a GitHub account (at least a week old) can publish skills, and anyone can install them.

### Registry Scale (as of March 2026)

| Metric | Value |
|--------|-------|
| Total skills | 13,700+ (after cleanup; was 10,700+ pre-cleanup) |
| Curated skills (VoltAgent awesome list) | 5,490+ |
| Malicious skills removed (ClawHavoc) | 1,184+ |
| OpenClaw GitHub stars | 221,000+ |
| Supported messaging platforms | 10+ |
| Supported AI models | Claude, GPT-4o, local (Ollama) |
| License | MIT |

### Discovery: Semantic Vector Search

ClawHub uses **vector-based semantic search powered by OpenAI embeddings**, so you can find relevant skills using natural language queries rather than needing exact package names:

```bash
clawhub search "postgres backups"
clawhub search "browser automation for scraping"
clawhub search "email management outlook"
```

### ClawHub CLI

The `clawhub` CLI tool manages the full lifecycle:

```bash
# Discovery
clawhub search "query"          # Semantic search
clawhub search "query" --limit 20

# Installation
clawhub install <slug>           # Install latest
clawhub install <slug> --version 1.2.0  # Pin version
clawhub update <slug>            # Update single skill
clawhub update --all             # Update all skills
clawhub list                     # List installed skills

# Publishing
clawhub login                    # Authenticate via GitHub
clawhub publish ./my-skill \
  --slug my-skill \
  --name "My Skill" \
  --version 1.0.0 \
  --tags latest
clawhub sync --all               # Sync local changes to registry

# Management
clawhub delete <slug> --yes
clawhub undelete <slug> --yes
clawhub whoami
```

### Storage and Lockfile

Installed skills are tracked in `.clawhub/lock.json` (similar to `package-lock.json`). The sync command scans default roots `~/openclaw/skills` and `~/.openclaw/skills`.

### Versioning

Skills follow semver. When you update a skill on ClawHub, existing installations are **not** automatically updated. Use `openclaw skills update` to pull new versions. Pin versions in production to prevent unexpected behavior changes.

## 3-Tier Skill Hierarchy

OpenClaw skills operate in three tiers:

### Tier 1: Built-in Skills
Core skills shipped with OpenClaw itself. These handle fundamental operations like file I/O, shell execution, web browsing, and basic automation. They are maintained by the OpenClaw core team and receive security patches with each release.

### Tier 2: Community Skills (ClawHub)
The bulk of the ecosystem — 13,700+ skills published by individual developers and companies on ClawHub. Quality varies dramatically. The VoltAgent community maintains a curated "awesome list" of 5,490 vetted skills. Categories include:

- **Communication**: Slack, Gmail, Himalaya (IMAP/SMTP), WhatsApp, Telegram, Discord
- **Productivity**: Obsidian, Linear, Monday, Notion, Asana
- **Developer Tools**: GitHub, Firecrawl, SQL Toolkit, Playwright MCP
- **Creative**: Nano Banana Pro (image generation via Gemini)
- **Smart Home**: Home Assistant, various IoT integrations
- **Finance**: Crypto wallets, trading tools (heavily targeted by malware)
- **macOS Native**: Apple Mail, Calendar, Reminders, Notes, Shortcuts

### Tier 3: Custom/Private Skills
Skills created by individual users or organizations for internal use. These live on the local filesystem and are never published to ClawHub. They follow the same `SKILL.md` format but are loaded from project-local or user-global skill directories.

### Loading Order

Skills are loaded into the system prompt in a defined order:
1. `SOUL.md` (core personality/behavior)
2. Built-in skills
3. Installed community skills (from `.clawhub/lock.json`)
4. Custom local skills (from project directory)

This means custom skills can override community skill behavior, and community skills can extend built-in capabilities.

## Every ClawHub Skill Is an MCP Server

One of OpenClaw's most powerful architectural decisions: **many ClawHub skills wrap MCP (Model Context Protocol) servers**. When you install an OpenClaw skill that wraps an MCP server, the framework handles connection details, authentication, and tool registration automatically.

### How It Works

```
┌─────────────────────────────────────┐
│          OpenClaw Agent             │
│  ┌──────────┐  ┌──────────────┐    │
│  │ SKILL.md │──│ MCP Server   │    │
│  │ (config) │  │ (tools)      │    │
│  └──────────┘  └──────┬───────┘    │
│                       │             │
│              MCP Protocol           │
│                       │             │
│              ┌────────┴────────┐   │
│              │ External Service │   │
│              │ (API, DB, etc.) │   │
│              └─────────────────┘   │
└─────────────────────────────────────┘
```

The `SKILL.md` provides:
- Instructions for the agent (when/how to use the tools)
- Configuration metadata (auth requirements, env vars)
- Tool descriptions that get registered with the agent

The underlying MCP server provides:
- Actual tool implementations (functions the agent can call)
- Protocol-compliant communication (stdio or HTTP)
- Authentication handling (OAuth, API keys)

### mcporter: The MCP Bridge

The **mcporter** skill (by @steipete, 40.7k downloads) bridges the gap between MCP servers and OpenClaw's skill system:

```bash
clawhub install mcporter
```

mcporter lets agents:
- **List** available MCP servers and their tools
- **Configure** MCP server connections (auth, endpoints)
- **Call** MCP tools directly from within OpenClaw
- **Handle** OAuth flows for authenticated services
- **Generate** CLI types and configurations

This means any MCP server — whether designed for Claude, Cursor, or any other MCP-compatible client — can be used from within OpenClaw through mcporter. It effectively makes OpenClaw an MCP client that can dynamically discover and use tools at runtime.

### Pi Compatibility

mcporter also handles compatibility with OpenClaw's Raspberry Pi deployment mode, where resource constraints require lighter-weight MCP server configurations and stdio-only transports.

## Dynamic Tool Creation at Runtime

OpenClaw agents can create and register new tools dynamically during a session. This is fundamental to the "self-improving agent" pattern (see [[05-Memory-Persistence-Self-Improvement]]).

### Mechanism

1. **Agent writes a new SKILL.md** to the local skills directory
2. **Agent reloads its skill registry** to pick up the new skill
3. **New tools become available** in the current and future sessions

```bash
# Agent can create a skill on the fly:
# 1. Write the skill file
cat > ~/.openclaw/skills/my-new-tool/SKILL.md << 'EOF'
---
name: my-new-tool
version: 0.1.0
tools: [Bash]
---
# My New Tool
When the user asks to process CSV files, use this approach:
1. Read the file with `head -5` to understand structure
2. Use `awk` to process columns...
EOF

# 2. The agent picks it up on next skill scan
openclaw skills list  # Now shows my-new-tool
```

### Self-Improving Agent Pattern

The **self-improving-agent** skill on ClawHub (one of the most downloaded) formalizes this:
1. Agent encounters a task it handles poorly
2. Agent writes a SKILL.md capturing the learned approach
3. Future sessions have that skill available
4. Over time, the agent accumulates domain-specific expertise

This creates a feedback loop where the agent literally writes its own instruction manual. See [[05-Memory-Persistence-Self-Improvement]] for deep coverage.

### Runtime Tool Registration

Beyond skill files, OpenClaw supports dynamic tool registration through its gateway:

```typescript
// OpenClaw Gateway API (simplified)
gateway.registerTool({
  name: "custom_analyzer",
  description: "Analyzes data using custom logic",
  parameters: {
    input: { type: "string", description: "Data to analyze" }
  },
  handler: async (params) => {
    // Tool implementation
    return { result: "analysis output" };
  }
});
```

This allows programmatic tool creation without writing SKILL.md files — useful for integrations and automation workflows.

## Creating Custom Skills: Step by Step

Based on the `skill-creator` skill by @chindden (29,000+ downloads, 100 stars), here is the canonical process:

### Step 1: Define the Skill

Create a directory with a `SKILL.md`:

```bash
mkdir -p ~/.openclaw/skills/my-skill
```

### Step 2: Write the SKILL.md

```markdown
---
name: aws-cost-analyzer
version: 1.0.0
description: "Analyze AWS costs and provide optimization recommendations"
author: your-username
tags: [aws, cost, optimization, cloud]
tools: [Bash, Read, Write]
dependencies:
  - cli: aws
---

# AWS Cost Analyzer

## Purpose
Analyze AWS Cost Explorer data and provide actionable optimization recommendations.

## When to Use
Activate when the user asks about:
- AWS spending or costs
- Cost optimization
- Resource right-sizing
- Reserved instance recommendations

## Instructions

### Step 1: Gather Cost Data
Run `aws ce get-cost-and-usage` for the requested time period.

### Step 2: Identify Top Spenders
Group by service, sort descending by cost.

### Step 3: Generate Recommendations
For each top-spending service, check:
- Unused resources (0 CPU/network for 7+ days)
- Oversized instances (< 20% average utilization)
- Missing reservations (on-demand for steady-state workloads)

### Step 4: Output Report
Format as markdown table with columns:
| Service | Monthly Cost | Recommendation | Estimated Savings |

## Constraints
- Never modify AWS resources without explicit user confirmation
- Always show cost data before recommending changes
- Use `--dry-run` flags when available
```

### Step 3: Test Locally

```bash
# Skills in ~/.openclaw/skills/ are auto-discovered
openclaw skills list  # Verify it appears
# Test by asking OpenClaw a relevant question
```

### Step 4: Publish to ClawHub

```bash
clawhub login
clawhub publish ~/.openclaw/skills/my-skill \
  --slug aws-cost-analyzer \
  --name "AWS Cost Analyzer" \
  --version 1.0.0 \
  --changelog "Initial release" \
  --tags "aws,cost,cloud"
```

### Step 5: Iterate

```bash
# After making changes:
clawhub sync --bump patch --changelog "Fixed edge case in RI recommendations"
```

## Skill Security: The ClawHavoc Incident

The most significant security event in the OpenClaw ecosystem was the **ClawHavoc** supply chain attack, which exposed fundamental weaknesses in the skill trust model.

### Timeline

| Date | Event |
|------|-------|
| **Jan 27, 2026** | First malicious skill uploaded to ClawHub |
| **Jan 27-29** | 335 malicious skills distributed via ClawHub (ClawHavoc campaign) |
| **Jan 30** | Quiet patch released by OpenClaw team |
| **Feb 1** | Koi Security publishes initial findings: 341/2,857 skills malicious (~12%) |
| **Feb 2** | The Hacker News reports hundreds of malicious ClawHub skills |
| **Feb 3** | CVE-2026-25253 (CVSS 8.8) publicly disclosed — one-click RCE via WebSocket hijacking |
| **Feb 3** | Three high-impact security advisories issued (RCE + 2 command injections) |
| **Feb 16** | Updated scan: 824 malicious skills found (registry grew to 10,700+) |
| **Mar 1** | 1,184 confirmed malicious skills across 10,700+ total packages |
| **Mar 17** | ClawSecure audit: 539 popular skills (18.7% of most-installed) contain ClawHavoc indicators |

### Attack Vectors

1. **Social Engineering (ClickFix)**: Malicious skills had professional README/SKILL.md files with "Prerequisites" sections urging users to copy-paste terminal commands or download "helper tools" from attacker-controlled sites.

2. **Credential Theft**: Skills targeted:
   - Browser credentials and keychains (macOS: Atomic macOS Stealer)
   - SSH keys and crypto wallets
   - OAuth tokens for connected services
   - Reverse shells on Windows

3. **Category Targeting**: Attackers focused on:
   - Crypto wallet/trading tools (high-value targets)
   - Auto-updater variants (335 skills from a single campaign)
   - Later expanded to: browser automation, coding agents, LinkedIn/WhatsApp integrations, PDF tools
   - In dark irony: fake security-scanning skills

4. **Scale of Attack**: 12 malicious author IDs; top uploader `hightower6eu` published 677 packages. After cleanup, 60 packages tied to `moonshine-100rze` remained accessible with 14,285 downloads.

### Root Causes

- **No code review** for published skills — anyone could publish
- **SKILL.md injected directly into system prompt** — a prompt injection vector
- **Skills run with full agent permissions** (filesystem, shell, network, OAuth tokens)
- **No rate limiting** on publishing
- **No sandboxing** of skill execution
- **GitHub account age requirement** (1 week) trivially bypassed

### Security Responses

- **ClawHub cleanup**: Registry shrank from 10,700+ to 3,498 after removing malicious packages
- **Community vetting**: VoltAgent maintains curated list of 5,490 vetted skills
- **Skill Vetter skill**: Third-party skill that scans other skills before installation
- **GitHub Issue #28360**: Proposal for `manifest.json` + runtime sandbox for secure skill installation — four-layer security framework (still open as of March 2026)

### The Fundamental Problem

As Palo Alto Networks identified, OpenClaw agents exhibit the **"Lethal Trifecta"** of agentic AI risks:
1. **Access to private data** (filesystem, credentials)
2. **Exposure to untrusted content** (community skills)
3. **Ability to execute tools** (shell, network, file I/O)

A malicious skill exploits all three simultaneously. The open skill ecosystem — OpenClaw's greatest strength — is also its greatest vulnerability.

### CVEs

| CVE | CVSS | Description |
|-----|------|-------------|
| CVE-2026-25253 | 8.8 | One-click RCE via WebSocket hijacking and token exfiltration |
| CVE-2026-24763 | High | Command injection vulnerability |
| CVE-2026-25157 | High | Command injection vulnerability |

## OpenClaw Ecosystem Architecture

The skill system sits within a broader hub-and-spoke architecture:

| Component | Role | Description |
|-----------|------|-------------|
| **OpenClaw Gateway** | Central Daemon | Node.js service — state persistence, model routing, session context |
| **OpenClaw Agent** | Reasoning Engine | LLM-driven core that reads skills and executes tasks |
| **ClawHub Registry** | Skill Registry | clawhub.ai — publishing and discovering community skills |
| **ClawHub CLI** | Command Line Tool | Locally install, search, and publish skills |
| **Skills (SKILL.md)** | Capability Definitions | Markdown-formatted skill files on local filesystem |

## OpenFang's Skill System: Rust Crates & WASM Sandbox

OpenFang (the community fork) took a fundamentally different approach to skills, prioritizing security over ecosystem openness. See [[01-OpenClaw-Core-Architecture]] for OpenFang's broader architecture.

### IronClaw: WASM-Sandboxed Tools

The **IronClaw** project (Rust-based) runs tools in isolated **WebAssembly (WASM) sandboxes**:

- Each tool/skill runs in its own WASM sandbox
- Sandboxes have explicit capability grants (filesystem paths, network endpoints)
- No ambient authority — tools can only access what's explicitly permitted
- Memory isolation between tools prevents cross-tool data leakage

```
┌─────────────────────────────────┐
│         OpenFang Agent          │
│  ┌───────┐  ┌───────┐          │
│  │ Tool A│  │ Tool B│          │
│  │ (WASM)│  │ (WASM)│          │
│  └───┬───┘  └───┬───┘          │
│      │          │               │
│  ┌───┴───┐  ┌───┴───┐          │
│  │Sandbox│  │Sandbox│          │
│  │ caps: │  │ caps: │          │
│  │ fs:/a │  │ net:* │          │
│  └───────┘  └───────┘          │
└─────────────────────────────────┘
```

### Rust Crate-Based Skills

Instead of markdown files, OpenFang skills can be compiled Rust crates:

- **Type-safe**: Skills are compiled code, not prompt instructions
- **Sandboxed**: Run in WASM with explicit capability boundaries
- **Auditable**: Binary reproducibility and static analysis possible
- **Performance**: Native-speed execution vs. LLM interpretation of markdown

### Trade-offs vs. OpenClaw

| Aspect | OpenClaw (SKILL.md) | OpenFang (Rust/WASM) |
|--------|--------------------|--------------------|
| **Ease of creation** | Write markdown | Write and compile Rust |
| **Security** | No sandboxing (prompt injection risk) | WASM sandbox with capability grants |
| **Ecosystem size** | 13,700+ skills | Much smaller |
| **Flexibility** | LLM interprets instructions | Compiled, deterministic |
| **Update model** | Edit markdown, republish | Recompile, redistribute |
| **Attack surface** | Large (prompt injection, credential theft) | Small (WASM boundary) |

### Community Reception

The HN discussion on IronClaw was mixed — critics noted the design lacked a clear threat model ("What is sandboxed from what?") and questioned whether the WASM boundary provides meaningful security given that agents inherently need broad capabilities to be useful.

## NemoClaw's Skill Additions

NVIDIA's NemoClaw fork (see [[01-OpenClaw-Core-Architecture]]) adds enterprise-focused security layers on top of OpenClaw's skill system:

### OpenShell: Policy-Enforced Runtime

NVIDIA open-sourced **OpenShell** (Apache 2.0) in March 2026 — a dedicated runtime environment designed to address the security risks of autonomous AI agents:

- **Command-level policy enforcement**: Every shell command executed by a skill passes through policy checks
- **Allowlist/denylist patterns**: Administrators define what commands/paths/operations are permitted
- **Audit logging**: Every tool invocation is logged for compliance
- **Network policy**: Skills can be restricted to specific network endpoints

### NemoClaw Security Wrapper

NemoClaw is described as "OpenClaw with guardrails" — it wraps the OpenClaw skill system with:

1. **NeMo Guardrails**: NVIDIA's guardrail framework for LLM interactions
2. **Skill sandboxing**: Container-based isolation for skill execution
3. **Policy enforcement**: Enterprise-grade access controls
4. **Audit trails**: Full logging of skill actions for compliance

### NemoClaw vs OpenClaw Skill Security

| Feature | OpenClaw | NemoClaw |
|---------|----------|----------|
| Skill format | SKILL.md (same) | SKILL.md (same) + policy overlay |
| Execution sandbox | None | Container-based + OpenShell |
| Command policy | None | Allowlist/denylist enforcement |
| Network policy | None | Endpoint-level restrictions |
| Audit logging | Basic | Enterprise-grade |
| ClawHub compatibility | Full | Full (with policy layer) |

NemoClaw maintains full compatibility with the ClawHub ecosystem but adds a security layer that can block or modify skill behavior based on enterprise policy.

## Top ClawHub Skills by Downloads (March 2026)

| Skill | Category | Downloads | Purpose |
|-------|----------|-----------|---------|
| Firecrawl CLI | Web Scraping | ~20K+ | Web data toolkit — scraping, searching, browsing |
| Gog | Search | ~18K+ | Web search integration |
| self-improving-agent | Meta | ~15K+ | Agent self-improvement framework |
| Nano Banana Pro | Creative | 13.4K | Image gen/edit via Gemini 3 Pro |
| API Gateway | Development | 13K | Managed OAuth to 100+ APIs |
| Obsidian | Knowledge | 12.4K | Local-first Obsidian vault integration |
| OpenAI Whisper | Media | 11.5K | Local speech-to-text |
| mcporter | Development | 11.1K | MCP server management from inside OpenClaw |
| Himalaya | Communication | 9.2K | IMAP/SMTP email (any provider) |
| Slack | Communication | 8.8K | Slack workspace integration |

## Implications for AWS-Native Architecture

When designing an AWS-hosted agent platform inspired by OpenClaw's skill system, several lessons apply:

1. **Skill-as-MCP-Server is the right abstraction**: OpenClaw proved that wrapping MCP servers as installable skills is powerful. An AWS-native equivalent could use Bedrock AgentCore's MCP support natively.

2. **Security must be built in, not bolted on**: ClawHavoc showed that an open marketplace without sandboxing is a supply chain disaster. Any skill registry needs:
   - Code review / static analysis before publishing
   - Runtime sandboxing (Lambda, Fargate, or WASM)
   - Capability-based permissions (IAM-style)
   - Audit logging (CloudTrail)

3. **Semantic discovery is valuable**: ClawHub's vector search for skills is genuinely useful. An internal skill registry could use Amazon Bedrock Knowledge Bases for semantic search.

4. **Version pinning is essential**: Skills should be pinnable like package versions, with automated vulnerability scanning (similar to Dependabot for npm).

5. **The markdown skill format is surprisingly effective**: Despite security concerns, `SKILL.md` as a format for packaging agent instructions is elegant and accessible. The format could be enhanced with IAM-style permission declarations for an AWS context.

## Key Takeaways

- OpenClaw's skill system (`SKILL.md` + ClawHub) created the largest AI agent skill ecosystem (13,700+ skills)
- The format is elegant: YAML frontmatter for metadata, markdown for agent instructions
- ClawHub uses semantic vector search for skill discovery
- Every skill can wrap an MCP server; mcporter bridges any MCP server into OpenClaw
- Dynamic tool creation at runtime enables self-improving agents
- The ClawHavoc incident (1,184+ malicious skills, 12% of registry compromised) exposed fundamental supply chain risks
- OpenFang's WASM sandbox approach trades ecosystem openness for security
- NemoClaw adds enterprise guardrails (OpenShell, container sandboxing) while maintaining ClawHub compatibility
- For an AWS-native design, the skill-as-MCP-server pattern combined with Lambda/Fargate sandboxing and IAM-style permissions would address the security gaps

---

*Research conducted: 2026-03-19*
*Sources: ClawHub docs, DataCamp guide, Firecrawl analysis, Koi Security ClawHavoc report, Reco security analysis, eSecurity Planet, The New Stack (NemoClaw), HN (IronClaw), OpenClaw GitHub issues, multiple community guides*
