# OpenClaw SKILL.md Format — Deep Analysis

> **Research Date:** 2026-03-19
> **Status:** Complete
> **Related:** [[../openclaw-nemoclaw-openfang/04-Skill-System-Tool-Creation|OpenClaw Skill System]]

---

## Table of Contents

- [[#Overview]]
- [[#SKILL.md v1 Format]]
- [[#SKILL.md v2 Format (ClawCore Enhancement)]]
- [[#ClawHub Marketplace Architecture]]
- [[#Skill Loading and Execution]]
- [[#MCP Integration Pattern]]
- [[#Security Model and ClawHavoc]]
- [[#OpenFang WASM Sandbox]]
- [[#NemoClaw Enterprise Extensions]]
- [[#Lessons for Chimera]]

---

## Overview

OpenClaw's `SKILL.md` format is the most successful agent skill specification to date, with **13,700+ published skills** on ClawHub as of March 2026. The format combines YAML frontmatter for machine-readable metadata with markdown content for LLM-readable instructions.

### Key Characteristics

| Aspect | Value |
|--------|-------|
| **Format** | YAML frontmatter + Markdown body |
| **Ecosystem size** | 13,700+ skills |
| **License** | MIT (OpenClaw), varies per skill |
| **Execution model** | Injected into system prompt at runtime |
| **Tool implementation** | Native code + MCP server wrapping |
| **Security** | Post-hoc (ClawHavoc exposed fundamental gaps) |
| **Versioning** | Semver with pinning support |

---

## SKILL.md v1 Format

The original OpenClaw skill format, still the most common in the ecosystem.

### Complete Example

```markdown
---
name: aws-cost-analyzer
version: 1.2.0
description: "Analyze AWS costs and provide optimization recommendations"
author: acme-corp
tags: [aws, cost, optimization, cloud]
tools: [Bash, Read, Write]
permissions:
  - filesystem: read
  - network: outbound
dependencies:
  - cli: aws
  - npm: typescript
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

## Examples

### Example 1: Monthly cost report
User: "Show me my AWS costs for last month"
Action: Run ce get-cost-and-usage, format as table

### Example 2: Optimization suggestions
User: "How can I reduce my AWS costs?"
Action: Run analysis, provide recommendations with savings estimates
```

### v1 Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique slug (lowercase, hyphens) |
| `version` | semver | Yes | Semantic version (MAJOR.MINOR.PATCH) |
| `description` | string | Yes | One-line description |
| `author` | string | Yes | Author username/org |
| `tags` | array | No | Discovery tags |
| `tools` | array | No | Required agent tools (Bash, Read, Write, etc.) |
| `permissions` | object | No | Filesystem, network, shell permissions |
| `dependencies` | object | No | CLI tools, npm packages, system binaries |

### v1 Body Structure

The markdown body follows a common pattern:

1. **Purpose** — What the skill does
2. **When to Use** — Trigger conditions
3. **Instructions** — Step-by-step logic for the agent
4. **Constraints** — Safety rules and limitations
5. **Examples** — Few-shot demonstrations

---

## SKILL.md v2 Format (ClawCore Enhancement)

The ClawCore project (AWS-hosted OpenClaw alternative) enhanced the format with security and testing features. This spec is documented in `ClawCore-Skill-Ecosystem-Design.md`.

### v2 Enhancements

```markdown
---
# === Identity (same as v1) ===
name: code-review
version: 2.1.0
description: "Automated code review with security scanning"
author: acme-corp
license: MIT

# === Discovery (same as v1) ===
tags: [code-quality, security, review, developer-tools]
category: developer-tools

# === NEW: Trust & Security ===
trust_level: verified    # platform | verified | community | private | experimental
permissions:
  filesystem:
    read: ["**/*.py", "**/*.ts", "**/*.js"]
    write: ["/tmp/review-*"]
  network: false
  shell:
    allowed: ["grep", "wc", "diff", "ast-grep"]
    denied: ["curl", "wget", "nc"]
  memory:
    read: true
    write: ["user_preference", "review_pattern"]
  secrets: []

# === NEW: Dependencies ===
dependencies:
  skills: []
  mcp_servers:
    - name: code-search
      optional: false
  packages:
    pip: ["ast-grep-py>=0.1.0"]
    npm: []
  binaries: ["git"]
  env_vars:
    required: []
    optional: ["REVIEW_STYLE_GUIDE"]

# === NEW: MCP Server (if skill provides tools) ===
mcp_server:
  transport: stdio
  command: "python"
  args: ["-m", "clawcore_skill_code_review"]
  tools:
    - name: review_file
      description: "Review a single file for issues"
    - name: review_diff
      description: "Review a git diff for issues"

# === NEW: Testing ===
tests:
  model: us.anthropic.claude-sonnet-4-6-v1:0
  cases:
    - name: basic_review
      input: "Review the file at fixtures/example.py"
      expect:
        tool_calls: [review_file]
        output_contains: ["issue", "line"]
    - name: security_scan
      input: "Check fixtures/vulnerable.py for security issues"
      expect:
        output_contains: ["SQL injection", "OWASP"]
---

# Code Review

[... body same as v1 pattern ...]
```

### v2 Key Additions

| Feature | Purpose | Impact |
|---------|---------|--------|
| **Declarative permissions** | Cedar policy enforcement | Prevents undeclared access |
| **Inline tests** | Automated validation | Catches regressions before publish |
| **MCP server config** | Native tool implementation | Skills can provide actual functions, not just prompts |
| **Trust tiers** | Security isolation | Untrusted skills run in sandboxes |
| **Dependency graph** | Composite skills | Skills can depend on other skills |

### Backward Compatibility

v1 skills load in v2 runtimes with defaults:
- `trust_level: community`
- `permissions: { filesystem: { read: ["**/*"] }, network: false, shell: { allowed: ["*"] } }`
- `tests: []` (manual review required for marketplace)

---

## ClawHub Marketplace Architecture

ClawHub (clawhub.ai) is the npm-style registry for OpenClaw skills.

### Registry Scale (March 2026)

| Metric | Value |
|--------|-------|
| Total skills | 13,700+ (post-ClawHavoc cleanup) |
| Curated skills | 5,490+ (VoltAgent awesome list) |
| Total downloads | ~500M+ |
| Malicious skills removed | 1,184 (ClawHavoc) |
| Average skill size | 2-5 KB |

### Discovery: Semantic Vector Search

ClawHub uses **OpenAI embeddings** for semantic search:

```bash
# Natural language queries
clawhub search "postgres backups"
clawhub search "browser automation for scraping"
clawhub search "email management outlook"
```

The registry embeds skill descriptions and full SKILL.md content, enabling fuzzy matching beyond exact keyword search.

### ClawHub CLI Workflow

```bash
# Install
clawhub install <slug>                    # Latest version
clawhub install <slug> --version 1.2.0    # Pin version

# Publish
clawhub login                             # GitHub OAuth
clawhub publish ./my-skill \
  --slug my-skill \
  --version 1.0.0 \
  --tags "aws,cost,cloud"

# Update
clawhub update <slug>                     # Update single skill
clawhub update --all                      # Update all skills

# Management
clawhub list                              # Installed skills
clawhub search "query"                    # Semantic search
```

### Storage: Lockfile Pattern

Installed skills tracked in `.clawhub/lock.json`:

```json
{
  "skills": [
    {
      "name": "aws-cost-analyzer",
      "version": "1.2.0",
      "author": "acme-corp",
      "installed_at": "2026-03-15T10:30:00Z",
      "checksum": "sha256:abc123..."
    }
  ]
}
```

Similar to `package-lock.json` for reproducible installations.

---

## Skill Loading and Execution

### Loading Order

Skills are loaded into the agent system prompt in this order:

1. `SOUL.md` (agent core personality)
2. Built-in platform skills
3. Installed community skills (from `.clawhub/lock.json`)
4. Custom local skills (from project directory)

Later skills can override earlier ones, enabling customization.

### Execution Model

OpenClaw skills are **prompt-based**:

```
[Agent System Prompt]
  |
  +-- SOUL.md content
  +-- Built-in skill instructions
  +-- Community skill instructions (SKILL.md body)
  +-- Custom skill instructions
  |
[User Message] --> [LLM Inference] --> [Tool Selection] --> [Tool Execution]
```

The SKILL.md body is injected directly into the system prompt. When the user's request matches the skill's "When to Use" conditions, the LLM reasons over the skill's instructions and invokes appropriate tools.

### Dynamic Tool Creation

Skills can create new skills at runtime:

```bash
# Agent writes a new SKILL.md
cat > ~/.openclaw/skills/my-new-tool/SKILL.md << 'EOF'
---
name: my-new-tool
version: 0.1.0
tools: [Bash]
---
# My New Tool
When the user asks to process CSV files, use awk...
EOF

# Agent reloads registry
openclaw skills reload
```

This enables self-improving agents that learn from experience.

---

## MCP Integration Pattern

One of OpenClaw's most powerful patterns: **every ClawHub skill can wrap an MCP server**.

### Architecture

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

The SKILL.md provides:
- **Instructions** for when/how to use the tools
- **Configuration** (auth, env vars)
- **Tool descriptions** registered with the agent

The MCP server provides:
- **Actual tool implementations**
- **Protocol communication** (stdio or HTTP)
- **Authentication handling**

### mcporter: The Bridge

The **mcporter** skill (40.7k downloads) enables MCP server integration:

```bash
clawhub install mcporter
```

It allows agents to:
- List available MCP servers and tools
- Configure MCP connections (auth, endpoints)
- Call MCP tools directly from OpenClaw
- Handle OAuth flows
- Generate CLI types

Any MCP server designed for Claude, Cursor, or other clients works in OpenClaw via mcporter.

---

## Security Model and ClawHavoc

### The ClawHavoc Incident

**Timeline:**
- Jan 27, 2026: First malicious skill uploaded
- Jan 27-29: 335 malicious skills distributed
- Feb 1: Koi Security finds 341/2,857 skills malicious (~12%)
- Feb 3: CVE-2026-25253 disclosed (CVSS 8.8 — one-click RCE)
- Mar 1: 1,184 confirmed malicious skills across 10,700+ total

### Attack Vectors

1. **Social Engineering (ClickFix)**: Professional README files with "Prerequisites" urging users to run malicious commands
2. **Credential Theft**: Targeting browser credentials, SSH keys, crypto wallets, OAuth tokens
3. **Reverse Shells**: Windows reverse shells via PowerShell
4. **Category Targeting**: Crypto wallet tools, auto-updaters, browser automation

### Root Causes

| Gap | Impact |
|-----|--------|
| **No code review** | Anyone could publish without inspection |
| **SKILL.md injected into prompt** | Prompt injection attack vector |
| **Full agent permissions** | Skills inherit filesystem, shell, network access |
| **No sandboxing** | Skills run in agent's process |
| **No rate limiting** | Single attacker published 677 packages |

### Post-Incident Responses

1. **ClawHub cleanup**: Registry shrank from 10,700 to 3,498 skills
2. **Community vetting**: VoltAgent maintains curated list (5,490 skills)
3. **Skill Vetter skill**: Third-party scanner for suspicious patterns
4. **Manifest proposal** (GitHub #28360): Runtime sandbox framework (still open)

### CVEs Disclosed

| CVE | CVSS | Description |
|-----|------|-------------|
| CVE-2026-25253 | 8.8 | One-click RCE via WebSocket hijacking |
| CVE-2026-24763 | High | Command injection vulnerability |
| CVE-2026-25157 | High | Command injection vulnerability |

---

## OpenFang WASM Sandbox

The OpenFang community fork took a fundamentally different security approach.

### IronClaw: WASM-Based Isolation

Instead of markdown skills, OpenFang compiles tools to **WebAssembly**:

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

Skills are compiled Rust code:

```rust
use openclaw_sdk::tool;

#[tool]
pub fn analyze_code(file_path: String) -> Result<String, Error> {
    // Compiled, type-safe, sandboxed execution
    let content = read_file(&file_path)?;
    Ok(analyze(content))
}
```

### Trade-offs

| Aspect | OpenClaw (SKILL.md) | OpenFang (WASM) |
|--------|--------------------|--------------------|
| **Ease of creation** | Write markdown | Write and compile Rust |
| **Security** | No sandboxing | WASM sandbox with capability grants |
| **Ecosystem size** | 13,700+ | Much smaller |
| **Flexibility** | LLM interprets instructions | Compiled, deterministic |
| **Attack surface** | Large (prompt injection) | Small (WASM boundary) |

### Community Reception

Mixed. Critics noted the lack of a clear threat model — WASM sandboxing is valuable, but agents inherently need broad capabilities (filesystem, network) to be useful, so the boundary doesn't eliminate risk.

---

## NemoClaw Enterprise Extensions

NVIDIA's NemoClaw fork adds enterprise security layers on top of OpenClaw's skill system.

### OpenShell: Policy-Enforced Runtime

NVIDIA open-sourced **OpenShell** (Apache 2.0) in March 2026 — a dedicated runtime for AI agents:

**Features:**
- **Command-level policy enforcement**: Every shell command passes through policy checks
- **Allowlist/denylist patterns**: Admins define permitted operations
- **Audit logging**: Full compliance trail
- **Network policy**: Endpoint-level restrictions

### NemoClaw Security Wrapper

NemoClaw wraps OpenClaw with:
- **NeMo Guardrails**: LLM interaction guardrails
- **Skill sandboxing**: Container-based isolation
- **Policy enforcement**: Enterprise access controls
- **Audit trails**: Full logging for compliance

### Comparison

| Feature | OpenClaw | NemoClaw |
|---------|----------|----------|
| Skill format | SKILL.md (same) | SKILL.md + policy overlay |
| Execution sandbox | None | Container + OpenShell |
| Command policy | None | Allowlist/denylist |
| Network policy | None | Endpoint restrictions |
| Audit logging | Basic | Enterprise-grade |
| ClawHub compatibility | Full | Full (with policy layer) |

NemoClaw maintains backward compatibility with the ClawHub ecosystem while adding an enterprise security layer.

---

## Lessons for Chimera

### What Works

1. **Markdown format is elegant**: Human-readable, version-controllable, LLM-friendly
2. **Semantic search is powerful**: Vector search enables natural language discovery
3. **MCP wrapping enables ecosystem leverage**: Thousands of MCP servers become skills
4. **Version pinning prevents breakage**: Semver with lockfiles enables reproducibility
5. **Community curation works**: VoltAgent's 5,490-skill curated list provides trust

### What Needs Improvement

1. **Security must be built in**: ClawHavoc proved that post-hoc security fails
2. **Sandboxing is essential**: Every skill needs capability-based isolation
3. **Static analysis before publish**: Scan for malicious patterns at upload time
4. **Cryptographic signing**: Ed25519 author + platform signatures establish provenance
5. **Permission declarations must be enforced**: Cedar policies at runtime, not honor system

### Chimera's Advantage

Chimera can learn from ClawHavoc and build security from day one:

- **7-stage scanning pipeline** (static analysis, dependency audit, sandbox run, permission validation, signing, monitoring, community reporting)
- **5-tier trust model** (platform, verified, community, private, experimental)
- **MCP-first execution** (skills as MCP servers, not prompt injection)
- **AgentCore native** (Lambda isolation, IAM auth, CloudTrail audit)

---

## Summary

OpenClaw's SKILL.md format proved that:
- Markdown-based skill definitions can scale to 13,700+ skills
- Semantic vector search enables powerful discovery
- MCP integration provides a path to interoperability
- Security requires comprehensive scanning pipelines, not just community goodwill

Chimera's compatibility layer must support SKILL.md v1/v2 while addressing the security gaps exposed by ClawHavoc. The adapter pattern allows Chimera to consume OpenClaw skills while executing them in secure, sandboxed environments with declarative permission enforcement.

---

*Research document compiled 2026-03-19 by compat-marketplace agent*
*Sources: ClawHub docs, Koi Security ClawHavoc report, OpenFang IronClaw docs, NemoClaw OpenShell announcement*
