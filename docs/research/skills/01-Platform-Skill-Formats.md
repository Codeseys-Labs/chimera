---
title: Platform Skill Formats Survey
status: in-progress
created: 2026-03-20
task: chimera-e55a
agent: skill-formats-survey
scope: Comprehensive comparison of skill/tool formats across agent platforms
---

# Platform Skill Formats Survey

## Executive Summary

This survey compares skill and tool formats across five major agent platforms to determine how Chimera can achieve maximum compatibility while maintaining security and usability.

### Critical Findings

1. **OpenClaw's SKILL.md format is the de facto standard** - 13,700+ skills, markdown-based with YAML frontmatter, simple and accessible but security-challenged (ClawHavoc incident: 1,184 malicious skills)

2. **Strands uses Python decorators (@tool)** - 30+ community tools, type-safe and programmatic, but requires Python/TypeScript knowledge

3. **MCP provides protocol-level interoperability** - 200+ servers, JSON Schema-based tool definitions, process-isolated, enables cross-platform tool sharing

4. **No single format dominates** - Each platform optimized for different priorities: accessibility (OpenClaw), type safety (Strands), interoperability (MCP)

5. **Compatibility is technically feasible** - All formats can be translated through adapters, but runtime execution models differ significantly

### Compatibility Matrix

| Feature | OpenClaw SKILL.md | Claude Code Skills | MCP Tools | Strands @tool | Chimera Target |
|---------|-------------------|-------------------|-----------|---------------|----------------|
| **Format** | Markdown + YAML frontmatter | Markdown + YAML frontmatter | JSON Schema | Python/TS decorators | Markdown + YAML (backward-compatible) |
| **Authoring** | Write markdown | Write markdown | Write JSON | Write Python/TS code | Write markdown or code |
| **Type Safety** | ❌ (string-based) | ❌ (string-based) | ✅ (JSON Schema) | ✅ (native types) | ✅ (hybrid) |
| **Security Model** | Prompt-based (weak) | Prompt-based | Process isolation | Process isolation | Cedar policies + sandbox |
| **Discovery** | ClawHub semantic search | Local filesystem | MCP registry | Code discovery | Multi-source registry |
| **Tool Execution** | Agent interprets instructions | Agent interprets instructions | MCP protocol | Direct function call | MCP + Cedar enforcement |
| **State Management** | Skill instructions | Skill instructions | Stateless tools | Agent session state | Tenant-isolated state |
| **Versioning** | Semver in frontmatter | File-based | Server versioning | Package versioning | Semver + signatures |
| **Trust Model** | ClawHub tiers (post-incident) | Local trust | User approval | Code review | 5-tier (platform→experimental) |
| **Marketplace** | ClawHub (13,700+ skills) | Local plugins | MCP server registry | Community tools | Unified marketplace |

### Recommended Approach

**Chimera should implement a three-layer compatibility strategy:**

1. **Native Format: SKILL.md v2** (backward-compatible with OpenClaw)
   - Markdown-based for accessibility
   - Enhanced YAML frontmatter with Cedar-compatible permission declarations
   - Inline test definitions for automated validation
   - Ed25519 dual-signature (author + platform)

2. **Protocol Layer: MCP-First**
   - All tool-providing skills deploy as MCP servers
   - Native MCP servers installable as skills
   - Unified tool registry across skill and MCP sources

3. **Adapter Layer: Multi-Platform Import**
   - Import OpenClaw SKILL.md files directly
   - Wrap Strands @tool functions as MCP servers
   - Support Claude Code skill format (if compatible)

**Security must be non-negotiable:** 7-stage scanning pipeline (static analysis, dependency audit, sandbox testing, permission validation, signing, monitoring, community reporting) before any skill reaches production.

---

## 1. OpenClaw SKILL.md Format

### 1.1 Format Overview

Every OpenClaw skill is a **single `SKILL.md` file** — markdown document with YAML frontmatter that declares metadata, dependencies, and permissions. The markdown body contains natural language instructions that get injected directly into the agent's system prompt at runtime.

#### File Structure

```
~/.openclaw/skills/my-skill/
  SKILL.md              # Main skill definition (required)
  skill.yaml            # Optional structured manifest
  README.md             # Optional human-readable docs
```

The `SKILL.md` frontmatter declares what the skill needs, and the markdown body tells the agent how to use it.

#### YAML Frontmatter Fields

**Core Metadata:**
- `name`: Unique identifier (slug format, lowercase with hyphens). Example: `code-review`
- `version`: Semantic version string (MAJOR.MINOR.PATCH). Example: `1.2.0`
- `description`: One-line description (max 200 characters). Example: "Automated code review with security scanning"
- `author`: Author username or organization slug. Example: `steipete` or `acme-corp`

**Discovery & Categorization:**
- `tags`: Array of discovery tags for ClawHub search. Example: `[productivity, automation, code]`
- `category`: Primary category (optional, for marketplace organization)

**Capabilities:**
- `tools`: Array of required agent tools. Example: `[Bash, Read, Write, Edit]`
- `permissions`: Object declaring required capabilities (filesystem, network, shell)
- `dependencies`: Object declaring external requirements (CLI tools, npm packages, system binaries, env vars)

**Advanced Fields:**
- `context`: Additional context or configuration data
- `examples`: Usage examples embedded in frontmatter
- `triggers`: Pattern hints for when skill should activate (not enforced, just documentation)

### 1.2 Skill Lifecycle

#### Loading Phase

OpenClaw discovers and loads skills from multiple directories in priority order:

1. **Built-in skills** (`~/.openclaw/built-in/`) - Core skills shipped with OpenClaw
2. **Installed marketplace skills** (tracked in `.clawhub/lock.json`) - Community skills installed via `clawhub install`
3. **Local project skills** (`./skills/`) - Project-specific skills
4. **User global skills** (`~/.openclaw/skills/`) - User-specific skills

At agent startup, OpenClaw:
1. Scans these directories for `SKILL.md` files
2. Parses YAML frontmatter to extract metadata
3. Validates declared dependencies (CLI tools, packages, env vars)
4. Injects markdown content into the system prompt as additional instructions

#### Validation Phase

**Dependency Checking:**
- **CLI binaries**: OpenClaw checks `which <binary>` for each declared binary
- **npm packages**: Checks if packages are installed in node_modules
- **Environment variables**: Warns if required env vars are missing

**Schema Validation:**
- Frontmatter must be valid YAML
- Required fields: `name`, `version`, `description`
- Version must be valid semver
- Tools must be from the agent's available tool set

**Warnings (non-blocking):**
- Missing optional dependencies
- Undefined optional env vars
- Deprecated field usage

#### Execution Phase

Skills don't "execute" in the traditional sense — they're **prompt augmentation**. The agent's system prompt becomes:

```
[Base system prompt]
[SOUL.md personality]
[Skill 1 instructions]
[Skill 2 instructions]
...
[User message]
```

The LLM interprets the skill instructions and decides when/how to use tools. There's no programmatic enforcement — it's entirely prompt-based reasoning.

#### State Management

OpenClaw skills are **stateless** at the skill level. State is managed at the agent session level:
- **Session memory**: Agent maintains conversation history across turns
- **Agent memory**: Persistent storage via the `memory` MCP server (knowledge graph)
- **Skill memory**: Some skills write state to filesystem (e.g., `~/.openclaw/state/<skill-name>.json`)

No formal skill state API — skills use tools (file I/O, memory operations) to persist data.

### 1.3 Version Differences: v1 vs v2

#### OpenClaw v1 Format (Original)

The original SKILL.md format (pre-ClawHavoc):

```markdown
---
name: my-skill
version: 1.0.0
description: "Does something useful"
author: username
tags: [productivity]
tools: [Bash, Read]
---

# My Skill

When the user asks to do X, follow these steps:
1. Read the file
2. Process it
3. Output results
```

**Characteristics:**
- Minimal metadata requirements
- No explicit permission declarations
- No security scanning
- Direct ClawHub publication without review
- Tools field lists agent tools needed (but no enforcement)

#### OpenClaw v2 Enhancements (Post-ClawHavoc)

Added after the ClawHavoc supply chain attack:

```markdown
---
name: my-skill
version: 2.0.0
description: "Does something useful"
author: username
tags: [productivity]
tools: [Bash, Read]
# NEW: Explicit permission declarations
permissions:
  filesystem:
    read: ["**/*.txt"]
    write: ["/tmp/*"]
  network: false
  shell:
    allowed: ["grep", "wc"]
# NEW: Dependency manifest
dependencies:
  cli: ["jq"]
  npm: ["typescript"]
  env_vars:
    required: ["API_KEY"]
# NEW: Optional skill.yaml for structured config
---
```

**Changes:**
- Added `permissions` object for explicit capability declarations
- Added `dependencies` object for structured dependency management
- Introduced `skill.yaml` companion file for additional metadata
- ClawHub now requires human review for verified tier
- All skills must pass automated security scanning

**Reality check:** As of March 2026, v2 adoption is **incomplete**. Many ClawHub skills still use v1 format. OpenClaw loads both, but v2 skills get preferential treatment in search rankings.

#### Migration Path

```bash
# OpenClaw provides a migration tool (community-maintained)
openclaw skill migrate-v1 ./old-skill/SKILL.md

# Manual migration checklist:
# 1. Add permissions block based on actual tool usage
# 2. Declare dependencies explicitly
# 3. Remove any prompt injection patterns
# 4. Add test cases (if targeting verified tier)
# 5. Re-publish to ClawHub
```

No breaking changes — v1 skills continue to work. Migration is encouraged but not enforced.

### 1.4 ClawHub Registry Integration

ClawHub (clawhub.ai) is the "npm for AI agents" — a centralized marketplace where developers publish and users discover skills.

#### Discovery Mechanism

**Semantic Vector Search** (powered by OpenAI embeddings):
```bash
clawhub search "analyze AWS costs and suggest optimizations"
# Returns semantically relevant skills, not just keyword matches:
# - aws-cost-analyzer (exact match)
# - cloud-expense-reporter (related)
# - finops-advisor (related)
```

**Search capabilities:**
- Natural language queries
- Tag-based filtering
- Category browsing
- Author filtering
- Trust tier filtering

**Registry Scale (March 2026):**
- **Total skills**: 13,700+ (after ClawHavoc cleanup from 10,700+)
- **Curated subset** (VoltAgent awesome list): 5,490 vetted skills
- **Malicious skills removed**: 1,184 during ClawHavoc incident
- **New submissions per day**: ~50-100
- **Most downloaded**: Firecrawl CLI (~20K), Gog search (~18K), self-improving-agent (~15K)

#### Versioning Strategy

Skills follow **semantic versioning** (semver):

- **MAJOR**: Breaking changes (e.g., tool renamed, permissions expanded)
- **MINOR**: New features, backward-compatible (e.g., new optional tool)
- **PATCH**: Bug fixes, no new features

**Version resolution:**
```bash
# Install latest
clawhub install code-review

# Install specific version
clawhub install code-review@2.1.0

# Install with version constraint
clawhub install "code-review@^2.0.0"  # 2.x.x series
```

**Lockfile** (`.clawhub/lock.json`):
```json
{
  "skills": {
    "code-review": {
      "version": "2.1.0",
      "resolved": "https://clawhub.ai/skills/code-review/2.1.0",
      "integrity": "sha256-abc123...",
      "author": "acme-corp"
    }
  }
}
```

Installed skills are **not** auto-updated. Use `clawhub update` to pull new versions.

#### Trust & Security Model

**Pre-ClawHavoc (Original Model):**
- Anyone with GitHub account (1 week old) could publish
- No code review
- No automated scanning
- Skills ran with full agent permissions
- Result: **12% of marketplace was malicious** at peak

**Post-ClawHavoc (Current Model):**

**Three trust tiers:**

1. **Official** — Maintained by OpenClaw core team, full audit
2. **Verified** — Community skills that passed human review (VoltAgent curated list)
3. **Community** — Automated scan only, use at your own risk

**Security measures (limited):**
- GitHub account age check (1 week minimum)
- Rate limiting on publishing (10 skills/day per author)
- Community reporting (`clawhub report <skill> --reason "malicious"`)
- Auto-quarantine if 3+ reports within 24 hours

**Key security gaps still present:**
- No WASM sandboxing (unlike OpenFang)
- No runtime permission enforcement (unlike NemoClaw's OpenShell)
- Prompt injection still possible
- Supply chain attacks via dependencies still viable

**ClawHub's security is fundamentally weak** — it relies on post-incident cleanup rather than prevention. This is Chimera's opportunity to do better.

---

## 2. Claude Code Skills Format

### 2.1 Format Overview

Claude Code skills use a markdown-based format similar to OpenClaw's SKILL.md, stored as `.md` files in the `skills/` directory of the Claude Code plugin system.

#### File Structure

```
~/.claude-code/plugins/my-plugin/
  skills/
    my-skill.md         # Skill definition
    another-skill.md    # Multiple skills per plugin
```

Skills are packaged within **plugins**, which provide the container for distribution, versioning, and updates.

#### Frontmatter Schema

Claude Code skills use triple-dash (`---`) YAML frontmatter:

```markdown
---
name: code-review
description: Review code for security vulnerabilities and style issues
---

# Code Review Skill

[Skill instructions...]
```

**Required Fields:**
- `name`: Unique identifier within the plugin
- `description`: Brief description of what the skill does

**Optional Fields:**
- `trigger_patterns`: Regex or text patterns that suggest skill activation (guidance, not enforcement)
- `examples`: Usage examples showing typical invocations
- `parameters`: Structured inputs the skill expects

**Key difference from OpenClaw:** Claude Code skills are **always scoped to a plugin**. The plugin provides the security boundary, installation mechanism, and update channel. Skills don't declare dependencies or permissions independently — they inherit from the parent plugin.

### 2.2 Content Structure

#### Instruction Blocks

Claude Code skills use natural language instructions structured in markdown:

```markdown
## When to Use
Activate this skill when the user asks to review code, check for bugs, or analyze security issues.

## Instructions

### Step 1: Understand Context
First, identify what code needs review. Ask clarifying questions if needed:
- Single file or entire project?
- Specific concerns (security, performance, style)?

### Step 2: Analyze Code
Use the Read tool to examine files. Look for:
- Security vulnerabilities (SQL injection, XSS, etc.)
- Logic errors and edge cases
- Code style violations

### Step 3: Report Findings
Structure output as a table with severity, issue, and suggestion columns.
```

Instructions are **imperative** — telling Claude what steps to take, not just providing context.

#### Conditional Logic

Skills use natural language conditionals:

```markdown
**IF** the user provides a git diff:
- Focus review on changed lines only
- Highlight potential regressions

**WHEN** reviewing Python code:
- Check for common issues: mutable default arguments, bare except clauses
- Suggest type hints where missing

**UNLESS** the user specifies otherwise:
- Limit review to files under 1000 lines (summarize larger files)
```

No formal DSL — Claude interprets natural language conditions.

#### Tool Call Templates

Skills can include example tool invocations:

```markdown
To check file contents:
```
Read the file at path/to/file.py
```

To search for patterns:
```
Use Grep to find all TODO comments: grep -r "TODO" src/
```
```

These are **examples**, not executable templates. Claude decides actual tool calls based on context.

### 2.3 Execution Model

#### Skill Loading

Skills are loaded when:
1. **Plugin activation** — All skills in an active plugin are loaded at session start
2. **Dynamic loading** — Skills can be explicitly invoked mid-session

The skill's markdown content is injected into Claude's prompt context.

#### Trigger Evaluation

**Soft matching** (non-deterministic):
- Claude reads skill descriptions and `trigger_patterns`
- Based on user input, Claude decides if a skill is relevant
- Skill activation is **suggested**, not enforced

**No automatic triggering** — unlike OpenClaw which injects all skills, Claude Code uses skills more selectively based on perceived relevance.

#### Context Injection

When a skill is activated:
```
[System prompt]
[Active skill 1 instructions]
[Active skill 2 instructions]
[Conversation history]
[User message]
```

Skills are additive context, not separate execution environments.

#### Skill Chaining

Skills can reference each other:

```markdown
## Prerequisites
This skill works best when used after the `codebase-search` skill has identified relevant files.

## Instructions
1. If files haven't been identified, suggest activating `codebase-search` first
2. Once files are known, proceed with review...
```

Chaining is **explicit** and **manual** — one skill instructs Claude to use another.

### 2.4 Built-in vs User-Defined Skills

#### Built-in Skills

Claude Code ships with system skills that cover core workflows:
- **commit-commands:commit** — Create git commits with conventional commit messages
- **commit-commands:commit-push-pr** — Commit, push, and open PR
- **feature-dev:feature-dev** — Guided feature development workflow
- **code-review:code-review** — Code review workflows
- **superpowers:*** — Meta-skills for skill usage, debugging, TDD, planning

Built-in skills are maintained by the Claude Code team and updated with releases.

#### User Skills

Users can create custom skills within their projects or home directory:

```bash
# Project-specific skill
.claude/
  skills/
    project-workflow.md

# User-global skill
~/.claude/
  skills/
    personal-workflow.md
```

User skills follow the same format as plugin skills but:
- No distribution mechanism (local only)
- No versioning
- No security review
- Full trust (user trusts their own skills)

#### Plugin Skills

Plugins are the primary distribution mechanism:

```
my-plugin/
  skills/
    skill-a.md
    skill-b.md
  hooks/
    pre-tool-use.ts
  agents/
    my-agent.md
  commands/
    my-command.ts
  package.json        # Plugin metadata
```

**Plugin packaging:**
- npm-style package.json for metadata and dependencies
- Can include TypeScript code (hooks, commands, agents)
- Skills are just one component of a plugin
- Plugins distributed via npm or local filesystem

**Security model:**
- Plugins run in the same process as Claude Code (not sandboxed)
- Users explicitly install and activate plugins
- Plugin code review is user's responsibility (no marketplace vetting)

---

## 3. MCP Tools as Skills

### 3.1 MCP Protocol Overview

The Model Context Protocol (MCP) is a standardized protocol for LLMs to discover and invoke tools provided by external servers. It's the "LSP for AI agents" — analogous to how Language Server Protocol standardizes editor-to-language-server communication.

#### Tool Definition Format

MCP tools are defined using JSON Schema:

```json
{
  "name": "read_file",
  "description": "Read contents of a file",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Absolute path to the file"
      }
    },
    "required": ["path"]
  }
}
```

**Tool response format:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "File contents here..."
    }
  ]
}
```

Multi-modal responses supported (text, images, resources).

#### Server/Client Architecture

```
┌─────────────────────────────────────┐
│         Agent (MCP Client)           │
│  ┌──────────────────────────────┐   │
│  │ Discovers tools via MCP      │   │
│  │ Invokes tools via JSON-RPC   │   │
│  └──────────┬───────────────────┘   │
└─────────────┼───────────────────────┘
              │ stdio / HTTP / WebSocket
              ↓
┌─────────────────────────────────────┐
│      MCP Server (Tool Provider)      │
│  ┌──────────────────────────────┐   │
│  │ Exposes tool list            │   │
│  │ Implements tool handlers     │   │
│  │ Manages external resources   │   │
│  └──────────┬───────────────────┘   │
└─────────────┼───────────────────────┘
              │
              ↓
       External Resource
    (Filesystem, API, Database)

### 3.2 MCP → Skill Mapping

#### Schema Translation

MCP tool definitions map cleanly to skill declarations:

```yaml
# SKILL.md wrapping an MCP server
---
name: filesystem-ops
version: 1.0.0
description: "File operations via MCP filesystem server"
mcp_server:
  transport: stdio
  command: "npx"
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"]
  tools:
    - name: read_file
      description: "Read file contents"
    - name: write_file
      description: "Write data to file"
---
```

The skill wraps the MCP server, making its tools available to the agent.

#### Parameter Mapping

MCP JSON Schema parameters map directly to tool call arguments:

```json
// MCP tool definition
{
  "name": "search_files",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pattern": {"type": "string"},
      "path": {"type": "string"}
    },
    "required": ["pattern"]
  }
}

// Agent tool call
{
  "tool": "search_files",
  "input": {
    "pattern": "*.py",
    "path": "/project/src"
  }
}
```

Type validation enforced by JSON Schema before invocation.

#### Result Handling

MCP servers return structured responses:

```json
{
  "content": [
    {"type": "text", "text": "Found 5 files matching *.py"},
    {"type": "resource", "uri": "file:///project/src/main.py"}
  ],
  "isError": false
}
```

The agent receives the result as a tool response and continues reasoning.

### 3.3 MCP Server Discovery

#### Static Configuration

MCP servers declared in agent configuration:

```json
// agent.yaml or similar
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "env": {"DEBUG": "true"}
    },
    "github": {
      "url": "https://mcp.company.com/github",
      "auth": {"type": "bearer", "token": "${GITHUB_TOKEN}"}
    }
  }
}
```

Servers start on-demand when the agent session begins.

#### Dynamic Discovery

MCP supports runtime discovery (experimental):
- Servers can advertise capabilities via mDNS or service discovery
- Agents can dynamically connect to discovered servers
- Useful for local development and plug-and-play tools

**Currently rare** — most deployments use static configuration.

### 3.4 Wrapping Strategy

#### Thin Wrapper Approach

**Direct pass-through:** Skill provides minimal wrapper around MCP server:

```markdown
---
name: filesystem
mcp_server:
  command: "filesystem-mcp-server"
---

# Filesystem Operations

Use the filesystem tools to read, write, and search files.
Available tools: read_file, write_file, list_directory, search_files
```

Agent discovers tools from MCP server directly. Skill just documents their existence.

#### Enriched Wrapper

**Adding documentation and guidance:**

```markdown
---
name: codebase-search
mcp_server:
  command: "filesystem-mcp-server"
---

# Codebase Search

## When to Use
When the user wants to find files, search code, or understand project structure.

## Best Practices
1. Start with `list_directory` to understand structure
2. Use `search_files` with specific patterns (*.py, *.ts)
3. Read files only after narrowing down candidates
4. Summarize findings before showing full contents

## Tools
- search_files(pattern, path) — Fast recursive search
- read_file(path) — Read file contents
```

Adds context and best practices while exposing the same MCP tools.

#### Composite Skills

**Multiple MCP servers in one skill:**

```markdown
---
name: github-workflow
mcp_server:
  primary:
    command: "github-mcp-server"
  secondary:
    command: "filesystem-mcp-server"
---

# GitHub Workflow

Combines filesystem and GitHub tools for complete PR workflows:
1. Search local code (filesystem MCP)
2. Create branch (git tool)
3. Push changes (git tool)
4. Create PR (github MCP)
```

A single skill orchestrates multiple MCP servers for complex workflows.

---

## 4. AgentCore Gateway Skill Support

### 4.1 AgentCore Architecture

#### Gateway Role

Amazon Bedrock AgentCore Gateway is the **orchestration and routing layer** for multi-tenant agent deployments:

**Core responsibilities:**
- **Session management** — Create, route, and terminate agent sessions
- **Multi-tenancy** — Isolate tenant data and enforce access controls
- **MCP integration** — Connect agents to MCP servers (tools, resources)
- **Identity federation** — Integrate with Cognito, Entra ID, Okta
- **Observability** — Collect metrics, traces, and logs

Gateway does NOT execute agent code — it coordinates between chat clients and AgentCore Runtime (isolated MicroVMs).

#### Runtime Integration

```
Chat Client → Gateway → AgentCore Runtime (MicroVM) → MCP Servers
                ↓
          Cedar Policies
          Session State
          Identity Context
```

Gateway routes requests to ephemeral MicroVMs running Strands agents. Each session gets an isolated runtime with tenant-specific configuration.

### 4.2 Skill Serving Capabilities

#### Does Gateway Support Skills?

**Not directly.** Gateway doesn't have a native "skill" concept. Instead, it supports:

1. **MCP server registration** — Tenants can configure MCP servers per session
2. **Strands agent configuration** — Deploy Strands agents with tools
3. **Custom tools via Strands** — Python @tool decorators loaded at runtime

**Skill support is achieved through Strands + MCP:**
- Skills implemented as Strands tools (Python functions with @tool decorator)
- Or skills wrapping MCP servers (filesystem, git, fetch, etc.)
- Gateway routes tool calls to appropriate MCP servers

#### Tool Registry Pattern

Gateway maintains a **per-tenant tool registry:**

```python
# Conceptual registry structure
{
  "tenant-123": {
    "mcp_servers": [
      {"name": "filesystem", "endpoint": "stdio:///path/to/server"},
      {"name": "github", "endpoint": "https://mcp.company.com/github"}
    ],
    "strands_tools": [
      {"name": "custom_analyzer", "module": "tenant_tools.analyzer"}
    ]
  }
}
```

Tools are discovered via MCP `initialize` and Strands tool loading at session start.

### 4.3 Strands Integration

#### Strands in AgentCore

**Strands is the native framework for AgentCore Runtime:**
- AgentCore Runtime MicroVMs run Strands agents
- Strands provides the agent loop, tool system, and model integration
- Gateway + Strands = complete agent platform

**Deployment model:**
```
Tenant configures agent → Gateway provisions MicroVM →
  Strands agent starts → Tools/MCP servers loaded →
    Agent handles requests
```

#### Tool Definition via Strands

Tools defined using Strands @tool decorator:

```python
from strands import tool

@tool
def analyze_data(file_path: str) -> str:
    """Analyze data in a CSV file.

    Args:
        file_path: Path to CSV file
    """
    # Implementation
    return "Analysis results..."
```

Gateway loads these tools at runtime and makes them available to the agent. This is how "skills" are implemented in the AgentCore ecosystem — as Strands tools.

---

## 5. Strands @tool Decorator Pattern

### 5.1 Strands Overview

#### Framework Purpose

Strands Agents is AWS's open-source SDK for building AI agents (Apache 2.0). It's **model-driven** — trusting the LLM to handle orchestration rather than requiring complex workflow definitions.

**Key features:**
- Agent = Model + Tools + Prompt (simple)
- 30+ community tools, unlimited custom tools
- MCP native support (first-class integration)
- Multi-provider (Bedrock, OpenAI, Anthropic, Ollama, LiteLLM)
- Production deployment to AgentCore Runtime, Lambda, Fargate, EKS

**Download scale:** 14M+ downloads, powers Amazon Q Developer, AWS Glue, VPC Reachability Analyzer

#### Tool Definition Model

Tools use Python decorators that extract metadata from docstrings and type hints:

```python
from strands import tool

@tool
def search_code(query: str, file_pattern: str = "*.py") -> str:
    """Search codebase for a pattern.

    Args:
        query: Search term or regex pattern
        file_pattern: File glob pattern to limit search
    """
    # Implementation
    return "Search results..."
```

The decorator automatically generates JSON Schema from type hints and docstring.

### 5.2 @tool Decorator Anatomy

```python
from strands import tool, ToolContext

@tool(
    name="custom_name",              # Override function name
    description="Custom description", # Override docstring
    context=True,                    # Inject ToolContext
    inputSchema={...}                # Override auto-generated schema
)
def my_tool(
    required_param: str,             # Required (no default)
    optional_param: int = 10,        # Optional (has default)
    tool_context: ToolContext = None # Context injection
) -> str:                            # Return type hint
    """First line becomes description.

    Args:
        required_param: Parameter description
        optional_param: Another parameter

    Returns:
        Description of return value
    """
    pass
```

#### Decorator Parameters

| Parameter | Type | Purpose |
|-----------|------|---------|
| `name` | str | Override tool name (default: function name) |
| `description` | str | Override tool description (default: docstring first line) |
| `context` | bool | Inject ToolContext for agent/invocation state access |
| `inputSchema` | dict | Override auto-generated JSON Schema |

#### Type Annotations

Strands converts Python types to JSON Schema:

```python
str → {"type": "string"}
int → {"type": "integer"}
float → {"type": "number"}
bool → {"type": "boolean"}
list[str] → {"type": "array", "items": {"type": "string"}}
dict → {"type": "object"}
Optional[str] → {"type": "string"} (not required)
```

Enums, Pydantic models, and TypedDict also supported.

#### Return Value Handling

Tools can return:
- **Strings** — Most common, text results
- **Dicts** — Structured data
- **Generators/async generators** — Streaming results (for progress updates)

```python
@tool
async def long_operation(steps: int) -> str:
    """Process with progress updates."""
    for i in range(steps):
        yield f"Step {i} complete"  # Streamed to agent
    yield "All steps complete"      # Final result
```

### 5.3 Tool Registration

#### Automatic Discovery

Tools registered when passed to Agent:

```python
from strands import Agent, tool

@tool
def my_tool(): ...

agent = Agent(tools=[my_tool])
```

Strands extracts the ToolSpec and registers it in the agent's ToolRegistry.

**Module-based loading:**
```python
# Load all @tool functions from a module
agent = Agent(tools=["mymodule.tools"])
```

#### Tool Catalog

The ToolRegistry maintains:
- Tool name → handler function mapping
- Tool schemas (JSON Schema for LLM)
- Validation logic
- Execution wrappers

At runtime, when the LLM requests a tool, Strands:
1. Validates input against schema
2. Invokes the handler function
3. Returns result to LLM

### 5.4 Execution Model

#### Invocation Flow

```
User message → LLM reasoning → Tool request (tool_use) →
  ToolRegistry.validate(input) →
    Tool function execution →
      Result → LLM context →
        Continue reasoning or respond
```

Agent loop orchestrates this automatically.

#### Error Handling

**Tool errors don't crash the agent:**
```python
@tool
def risky_operation() -> str:
    if error_condition:
        raise ValueError("Something went wrong")
    return "Success"
```

If a tool raises an exception:
1. Strands catches it
2. Wraps it in a ToolResult with isError=true
3. Returns error message to LLM
4. LLM sees the error and can retry, adjust, or report to user

**Resilient by design** — agents recover from tool failures.

#### State Management

**Three state types:**

1. **Tool parameters** (LLM-controlled):
```python
@tool
def search(query: str) -> str:
    # LLM provides query based on reasoning
```

2. **Invocation state** (per-request config):
```python
@tool(context=True)
def api_call(endpoint: str, tool_context: ToolContext) -> dict:
    user_id = tool_context.invocation_state.get("user_id")
    # Use for authenticated requests
```

3. **Class-based state** (shared across calls):
```python
class DatabaseTools:
    def __init__(self, conn_string: str):
        self.conn = connect(conn_string)

    @tool
    def query(self, sql: str) -> str:
        return self.conn.execute(sql).fetchall()
```

---

## 6. Cross-Platform Compatibility Layer

### 6.1 Compatibility Challenges

#### Format Differences

| Aspect | OpenClaw | Claude Code | Strands | Challenge |
|--------|----------|-------------|---------|-----------|
| **Definition** | SKILL.md (markdown) | .md (markdown) | @tool decorator (code) | Markdown vs code |
| **Metadata** | YAML frontmatter | YAML frontmatter | Decorator params | Schema differences |
| **Instructions** | Natural language | Natural language | Docstrings + code | Prose vs implementation |
| **Permissions** | Optional YAML | Inherited from plugin | None (implicit) | No standard format |
| **Dependencies** | YAML declaration | Plugin-level | pip/npm packages | Resolution differences |
| **Versioning** | Semver in frontmatter | Plugin version | Package version | Granularity differs |

**Key incompatibility:** OpenClaw/Claude Code are **instruction-based** (tell agent what to do), Strands is **implementation-based** (provide functions to call).

#### Execution Model Mismatches

**OpenClaw/Claude Code:**
- Skills are **prompt augmentation**
- LLM interprets instructions and decides actions
- No programmatic enforcement
- Skill "execution" = reading instructions

**Strands:**
- Skills are **executable functions**
- LLM calls tools via function calling protocol
- Direct invocation with parameters
- Skill "execution" = running Python/TS code

**MCP:**
- Skills are **protocol-exposed tools**
- LLM calls tools via JSON-RPC over transport (stdio/HTTP)
- Process isolation
- Skill "execution" = IPC to separate process

**The mismatch:** You cannot directly run a SKILL.md in Strands without an interpreter, and you cannot load Strands @tool decorators into OpenClaw without a runtime.

#### Capability Gaps

| Capability | OpenClaw | Claude Code | Strands | MCP |
|-----------|----------|-------------|---------|-----|
| **Natural language instructions** | ✅ Native | ✅ Native | ⚠️ Docstrings only | ❌ Not supported |
| **Programmatic tools** | ❌ Via external | ❌ Via hooks | ✅ Native | ✅ Native |
| **Process isolation** | ❌ Prompt-level | ❌ Same process | ❌ Same process | ✅ Separate process |
| **Type safety** | ❌ String-based | ❌ String-based | ✅ Native types | ✅ JSON Schema |
| **State management** | ⚠️ File I/O | ⚠️ File I/O | ✅ Session state | ❌ Stateless |
| **Hot reload** | ✅ Filesystem watch | ✅ Filesystem watch | ✅ Module reload | ⚠️ Server restart |
| **Marketplace** | ✅ ClawHub | ⚠️ Local plugins | ⚠️ PyPI/npm | ⚠️ Registries exist |

**Gap analysis:** No platform has everything. Chimera must choose which gaps to fill and which to accept.

### 6.2 Unified Skill Schema

#### Abstract Skill Model

Chimera's internal representation (based on ClawCore design):

```yaml
# Chimera Skill Manifest (internal format)
skill:
  metadata:
    name: "code-review"
    version: "2.1.0"
    description: "Automated code review"
    author: "acme-corp"
    license: "MIT"
    trust_level: "verified"  # platform|verified|community|private|experimental

  capabilities:
    permissions:
      filesystem: {read: ["**/*.py"], write: ["/tmp/*"]}
      network: {allowed: false}
      shell: {allowed: ["grep", "wc"], denied: ["curl", "wget"]}
      memory: {read: true, write: ["review_patterns"]}
      secrets: []

  dependencies:
    skills: []
    mcp_servers: [{name: "code-search", optional: false}]
    packages: {pip: ["ast-grep-py>=0.1.0"]}
    binaries: ["git"]
    env_vars: {required: [], optional: ["REVIEW_STYLE_GUIDE"]}

  implementation:
    type: "mcp_server"  # or "instruction" or "hybrid"
    mcp_server:
      transport: "stdio"
      command: "python"
      args: ["-m", "chimera_skill_code_review"]
      tools: [...]
    instructions: "markdown instructions here..."

  testing:
    model: "us.anthropic.claude-sonnet-4-6-v1:0"
    cases: [...]

  provenance:
    source_platform: "openclaw"  # openclaw|claude-code|strands|mcp|native
    source_format_version: "v1"
    import_timestamp: "2026-03-20T00:00:00Z"
    signatures:
      author: "ed25519:abc123..."
      platform: "ed25519:def456..."
```

This is the **canonical format** all external skills are translated into.

#### Common Fields

Fields that exist across all platforms:

| Field | OpenClaw | Claude Code | Strands | MCP | Chimera |
|-------|----------|-------------|---------|-----|---------|
| **Name** | `name` | `name` | function name | tool `name` | `metadata.name` |
| **Description** | `description` | `description` | docstring | tool `description` | `metadata.description` |
| **Version** | `version` | plugin version | package version | server version | `metadata.version` |
| **Parameters** | Inferred from prose | Inferred from prose | Type hints | `inputSchema` | `implementation.tools[].inputSchema` |
| **Instructions** | Markdown body | Markdown body | Docstring | (none) | `implementation.instructions` |

#### Platform-Specific Extensions

**Extensions stored as metadata:**

```yaml
extensions:
  openclaw:
    category: "developer-tools"
    clawhub_downloads: 1247
    clawhub_rating: 4.6

  claude_code:
    plugin_name: "my-plugin"
    plugin_version: "1.0.0"

  strands:
    module_path: "mymodule.tools"
    class_name: "DatabaseTools"

  mcp:
    server_url: "https://mcp.example.com/server"
    transport: "http"
```

Extensions preserved but not required for execution.

### 6.3 Translation Layer Architecture

#### Input Translation

**OpenClaw SKILL.md → Chimera:**

```python
def import_openclaw_skill(skill_md_path: str) -> ChimeraSkill:
    # Parse frontmatter
    frontmatter = parse_yaml_frontmatter(skill_md_path)
    markdown_body = extract_markdown_body(skill_md_path)

    # Map to Chimera format
    skill = ChimeraSkill(
        metadata=SkillMetadata(
            name=frontmatter["name"],
            version=frontmatter["version"],
            description=frontmatter["description"],
            # ...
        ),
        capabilities=infer_permissions_from_tools(frontmatter.get("tools", [])),
        implementation=SkillImplementation(
            type="instruction",  # OpenClaw is instruction-based
            instructions=markdown_body
        )
    )
    return skill
```

**Strands @tool → Chimera:**

```python
def import_strands_tool(tool_func) -> ChimeraSkill:
    # Extract from decorator and docstring
    tool_spec = extract_tool_spec(tool_func)

    skill = ChimeraSkill(
        metadata=SkillMetadata(
            name=tool_spec.name,
            description=tool_spec.description,
            # ...
        ),
        implementation=SkillImplementation(
            type="mcp_server",  # Wrap Strands tool as MCP server
            mcp_server=wrap_strands_tool_as_mcp(tool_func)
        )
    )
    return skill
```

**MCP Server → Chimera:**

```python
def import_mcp_server(server_config: dict) -> list[ChimeraSkill]:
    # Connect to MCP server and discover tools
    tools = mcp_client.list_tools()

    # Create one skill per tool (or group related tools)
    skills = []
    for tool in tools:
        skill = ChimeraSkill(
            metadata=SkillMetadata(name=tool.name, ...),
            implementation=SkillImplementation(
                type="mcp_server",
                mcp_server=server_config
            )
        )
        skills.append(skill)
    return skills
```

#### Output Translation

**Chimera → MCP Server:**

All Chimera skills with `type="mcp_server"` are natively MCP-compatible. No translation needed — just start the server.

**Chimera → OpenClaw:**

```python
def export_to_openclaw(skill: ChimeraSkill) -> str:
    # Generate SKILL.md
    frontmatter = {
        "name": skill.metadata.name,
        "version": skill.metadata.version,
        "description": skill.metadata.description,
        "permissions": skill.capabilities.permissions,
        # ...
    }
    markdown = f"---\n{yaml.dump(frontmatter)}---\n\n{skill.implementation.instructions}"
    return markdown
```

**Chimera → Strands:**

```python
def export_to_strands(skill: ChimeraSkill) -> str:
    # Generate Python @tool function
    code = f'''
from strands import tool

@tool
def {skill.metadata.name}({generate_params(skill)}) -> str:
    """{skill.metadata.description}

    Args:
        {generate_arg_docs(skill)}
    """
    # Call MCP server or execute instructions
    return invoke_skill("{skill.metadata.name}", locals())
'''
    return code
```

#### Runtime Adaptation

**Instruction-based skills** (OpenClaw/Claude Code):
- Chimera injects instructions into system prompt
- LLM interprets and acts

**Implementation-based skills** (Strands/MCP):
- Chimera deploys as MCP server
- LLM calls tools via function calling

**Hybrid skills** (both):
- Instructions guide LLM on when/how to use tools
- Tools provide actual implementations

### 6.4 Implementation Strategy

#### Adapter Pattern

```python
class SkillAdapter(ABC):
    @abstractmethod
    def import_skill(self, source: Any) -> ChimeraSkill: ...

    @abstractmethod
    def export_skill(self, skill: ChimeraSkill) -> Any: ...

class OpenClawAdapter(SkillAdapter):
    def import_skill(self, skill_md_path: str) -> ChimeraSkill: ...
    def export_skill(self, skill: ChimeraSkill) -> str: ...

class StrandsAdapter(SkillAdapter):
    def import_skill(self, tool_func) -> ChimeraSkill: ...
    def export_skill(self, skill: ChimeraSkill) -> str: ...

class MCPAdapter(SkillAdapter):
    def import_skill(self, server_config: dict) -> list[ChimeraSkill]: ...
    def export_skill(self, skill: ChimeraSkill) -> dict: ...
```

Each adapter handles bidirectional translation for its platform.

#### Registry Design

```python
class ChimeraSkillRegistry:
    """Unified registry for all skill sources."""

    def __init__(self):
        self.skills: dict[str, ChimeraSkill] = {}
        self.adapters: dict[str, SkillAdapter] = {
            "openclaw": OpenClawAdapter(),
            "claude_code": ClaudeCodeAdapter(),
            "strands": StrandsAdapter(),
            "mcp": MCPAdapter(),
        }

    def import_skill(self, source_platform: str, source: Any) -> ChimeraSkill:
        adapter = self.adapters[source_platform]
        skill = adapter.import_skill(source)
        self.skills[skill.metadata.name] = skill
        return skill

    def export_skill(self, skill_name: str, target_platform: str) -> Any:
        skill = self.skills[skill_name]
        adapter = self.adapters[target_platform]
        return adapter.export_skill(skill)

    def search(self, query: str) -> list[ChimeraSkill]:
        # Semantic search across all sources
        embeddings = embed_query(query)
        return search_vector_db(embeddings)
```

**Single registry, multiple sources, unified interface.**

#### Versioning & Migration

**Skill versioning:**
- All skills follow semver regardless of source platform
- Major version changes require re-import (breaking changes)
- Minor/patch updates can be auto-applied (if trust allows)

**Format migration:**
- Adapters handle format evolution (v1 → v2)
- Old versions remain importable (backward compatibility)
- New features marked as optional (forward compatibility)

**Cross-platform sync:**
```bash
# Import OpenClaw skill
chimera skill import --source openclaw code-review@2.1.0

# Export to Strands
chimera skill export code-review --target strands --output ./my_tool.py

# Changes in source? Re-import
chimera skill update code-review --source openclaw
```

---

## 7. Skill Marketplace Architecture (ClawHub Concept)

### 7.1 Marketplace Requirements

#### Discovery

**Semantic search** (like ClawHub):
- Embed skill descriptions using Titan Embeddings V2
- Store in Bedrock Knowledge Base
- Natural language queries: "find skills for AWS cost optimization"

**Filtered browsing:**
- Category taxonomy (developer-tools, communication, data-analysis, etc.)
- Trust tier filters (platform, verified, community, private, experimental)
- Rating/popularity sorting
- Recent updates feed

**API:**
```bash
chimera skill search "review code for security issues"
chimera skill browse --category security --trust verified
chimera skill trending --period 7d
```

#### Distribution

**Bundle format:**
```
skill-bundle-{name}-{version}.tar.gz
  SKILL.md                    # Skill definition
  tools/                      # Tool implementations (if any)
    __init__.py
    main.py
  tests/
    test_skill.yaml           # Test cases
    fixtures/                 # Test data
  manifest.yaml               # Signed manifest
  scan-report.json            # Security scan results
```

**Installation:**
```bash
chimera skill install code-review
# → Download bundle from S3
# → Verify signatures (author + platform Ed25519)
# → Extract to ~/.chimera/skills/code-review@2.1.0
# → Register with tenant skill registry
# → Start MCP server (if applicable)
```

**Storage:**
- Skills bundles in S3 (versioned, signed)
- Metadata in DynamoDB (searchable)
- Embeddings in Bedrock Knowledge Base (semantic search)

#### Versioning

**Semver enforcement:**
```
2.1.0 → 2.1.1 (patch)    # Auto-update safe
2.1.0 → 2.2.0 (minor)    # Backward-compatible, opt-in update
2.1.0 → 3.0.0 (major)    # Breaking changes, manual update
```

**Lockfile** (`.chimera/skills.lock`):
```yaml
skills:
  code-review:
    version: "2.1.0"
    source: "marketplace"
    bundle_sha256: "abc123..."
    author_signature: "ed25519:..."
    platform_signature: "ed25519:..."
    installed_at: "2026-03-20T00:00:00Z"
    auto_update: false
```

**Version constraints:**
```bash
chimera skill install "code-review@^2.0.0"  # 2.x.x series
chimera skill install "code-review@~2.1.0"  # 2.1.x patches only
chimera skill pin code-review@2.1.0         # Freeze version
```

#### Trust & Security

**7-stage security pipeline** (learned from ClawHavoc):

1. **Static analysis** — AST parsing for dangerous patterns
2. **Dependency audit** — Check against OSV vulnerability DB
3. **Sandbox testing** — Run tests in OpenSandbox MicroVM
4. **Permission validation** — Compare declared vs actual permissions
5. **Cryptographic signing** — Ed25519 dual-signature (author + platform)
6. **Runtime monitoring config** — Set anomaly detection thresholds
7. **Community reporting** — Post-publication monitoring

**Trust tiers:**
- **Platform** (Tier 0) — Chimera-maintained, full access
- **Verified** (Tier 1) — Human-reviewed, declared permissions enforced
- **Community** (Tier 2) — Automated scan only, sandboxed
- **Private** (Tier 3) — Tenant-owned, tenant's Cedar policies
- **Experimental** (Tier 4) — New/unreviewed, strictest sandbox

**Cedar policy enforcement** at runtime prevents permission violations.

### 7.2 ClawHub Design Principles

#### Decentralized vs Centralized

**Chimera marketplace: Hybrid model**

**Centralized registry** (like npm):
- Single source of truth for skill metadata
- Curated trust tiers (platform review)
- Hosted on AWS infrastructure

**Decentralized sources** (like git):
- Tenants can add private skill repositories
- Organization-level skill sharing
- Direct imports from git URLs

```bash
# Public marketplace
chimera skill install code-review

# Private registry
chimera skill install acme-internal --registry https://skills.acme.com

# Direct git import
chimera skill import https://github.com/user/skill.git
```

#### Multi-Format Support

**Native support:**
- Chimera SKILL.md v2 (native)
- OpenClaw SKILL.md v1/v2 (import via adapter)
- Strands @tool (wrap as MCP server)
- MCP servers (register directly)

**Import flow:**
```bash
chimera skill import code-review.skill.md --source openclaw
# → Adapter translates to Chimera format
# → Security scan runs
# → Stored in unified registry
```

Skills from any platform coexist in the same marketplace.

#### Quality Tiers

**5-tier system** (more granular than ClawHub's 3):

| Tier | Review | Permissions | Sandbox | Use Case |
|------|--------|-------------|---------|----------|
| Platform | Full audit | Unrestricted | None | Core functionality |
| Verified | Human + automated | Cedar-enforced | MicroVM | Trusted 3rd party |
| Community | Automated only | Strict sandbox | OpenSandbox | General use |
| Private | None (tenant trust) | Tenant Cedar | Per tenant | Internal tools |
| Experimental | None | Ultra-strict | Isolated MicroVM | Testing only |

### 7.3 Registry Schema

#### Skill Metadata

**DynamoDB schema** (simplified):
```
PK: SKILL#{name}
SK: VERSION#{semver}

Attributes:
- name, version, description, author
- category, tags
- trust_level
- permissions_hash (SHA256 of declared permissions)
- bundle_s3_key, bundle_sha256
- author_signature, platform_signature
- download_count, rating_avg, rating_count
- scan_status, scan_timestamp
- created_at, updated_at
- deprecated (bool), deprecated_message
```

**GSIs:**
- Author index (PK: AUTHOR#{author}, SK: SKILL#{name})
- Category index (PK: CATEGORY#{category}, SK: DOWNLOADS#{count})
- Trust tier index (PK: TRUST#{tier}, SK: UPDATED#{timestamp})

#### Search & Discovery API

```graphql
query SearchSkills($query: String!, $filters: SkillFilters) {
  skills(query: $query, filters: $filters) {
    name
    version
    description
    author
    trust_level
    category
    tags
    rating_avg
    download_count
  }
}

type SkillFilters {
  category: String
  trust_levels: [TrustLevel!]
  min_rating: Float
  tags: [String!]
}
```

**REST API:**
```
GET /api/v1/skills?q=code+review&category=developer-tools&trust=verified
GET /api/v1/skills/{name}
GET /api/v1/skills/{name}/versions/{version}
POST /api/v1/skills  # Publish new skill
```

#### Version Resolution

**Dependency graph:**
```yaml
skill: my-workflow
dependencies:
  - name: code-review
    constraint: "^2.0.0"
  - name: github-integration
    constraint: "~1.3.0"
```

**Resolution algorithm:**
1. Fetch latest versions matching constraints
2. Check for conflicts (e.g., skill A wants code-review@2.x, skill B wants @3.x → error)
3. Build dependency tree
4. Download bundles
5. Verify signatures
6. Install in order (dependencies first)

### 7.4 Integration with Chimera

#### Chimera as Skill Consumer

**Tenant installs from marketplace:**
```bash
chimera skill install code-review
# → Searches marketplace registry
# → Verifies trust tier and signatures
# → Downloads bundle
# → Runs security scan (if community tier)
# → Registers with tenant's agent config
# → MCP server starts on next session
```

**Agent uses skill:**
- Skill instructions injected into system prompt
- Skill tools available via MCP
- Cedar policies enforce declared permissions
- Usage tracked for billing/analytics

#### Chimera as Skill Provider

**Tenant publishes skill:**
```bash
chimera skill publish ./my-skill/
# → Validates SKILL.md format
# → Runs 7-stage security pipeline
# → Signs with tenant's author key
# → Platform co-signs if approved
# → Uploads bundle to S3
# → Registers in marketplace
# → Available to other tenants
```

**Revenue sharing** (optional):
```yaml
publishing:
  pricing:
    model: paid
    price_usd_monthly: 9.99
  revenue_share:
    author: 70%
    platform: 30%
```

#### Cross-Platform Bridge

**Chimera skills exported to other platforms:**

```bash
# Export to OpenClaw format
chimera skill export my-skill --target openclaw --output ./SKILL.md

# Export to Strands
chimera skill export my-skill --target strands --output ./my_tool.py

# Export as standalone MCP server
chimera skill export my-skill --target mcp --output ./mcp-server/
```

**Benefits:**
- Skills authored in Chimera work in OpenClaw/Claude Code
- Chimera marketplace becomes a source for other platforms
- Network effects: larger skill ecosystem benefits all

---

## 8. Comparative Analysis

### 8.1 Feature Comparison Matrix

| Feature | OpenClaw | Claude Code | MCP | Strands | Chimera Target |
|---------|----------|-------------|-----|---------|----------------|
| Format | | | | | |
| Frontmatter | | | | | |
| Parameter Schema | | | | | |
| Execution Model | | | | | |
| State Management | | | | | |
| Discovery | | | | | |
| Versioning | | | | | |
| Composition | | | | | |

### 8.2 Strengths & Weaknesses

#### OpenClaw

**Strengths:**
- ✅ **Huge ecosystem** — 13,700+ skills, largest marketplace
- ✅ **Simple authoring** — Write markdown, no coding required
- ✅ **Semantic discovery** — ClawHub's vector search is excellent
- ✅ **Cross-platform** — SKILL.md works in OpenFang, Cursor, others

**Weaknesses:**
- ❌ **Security disaster** — ClawHavoc proved prompt-based security fails
- ❌ **No type safety** — Instructions are strings, no validation
- ❌ **Prompt injection** — Skills can override agent behavior
- ❌ **No sandboxing** — Skills run with full agent permissions
- ❌ **Quality variance** — 12% malicious at peak, even "verified" skills dubious

#### Claude Code

**Strengths:**
- ✅ **Plugin ecosystem** — Skills packaged with hooks, agents, commands
- ✅ **Well-integrated** — Skills work seamlessly with Claude Code workflows
- ✅ **User-focused** — Skills designed for interactive use (not API agents)

**Weaknesses:**
- ❌ **Limited distribution** — No centralized marketplace
- ❌ **Same process execution** — No isolation, plugins can break Claude Code
- ❌ **Small ecosystem** — Far fewer skills than OpenClaw
- ❌ **Same security issues** — Prompt-based, no sandboxing

#### MCP

**Strengths:**
- ✅ **Process isolation** — Each server is a separate process
- ✅ **Type safety** — JSON Schema for all tool parameters
- ✅ **Protocol standard** — Works across Claude, Cursor, OpenClaw, etc.
- ✅ **Broad ecosystem** — 200+ servers covering many use cases
- ✅ **Security boundary** — Servers can't access agent internals

**Weaknesses:**
- ❌ **No instructions** — MCP is tools-only, no guidance for agents
- ❌ **Stateless** — No session state management
- ❌ **Setup complexity** — Requires server installation/configuration
- ❌ **Performance overhead** — IPC costs for every tool call

#### Strands

**Strengths:**
- ✅ **Type-safe** — Native Python/TS types, compile-time checking
- ✅ **Production-ready** — Powers Q Developer, AWS Glue
- ✅ **MCP-native** — First-class MCP client integration
- ✅ **AWS integration** — Native Bedrock/AgentCore deployment

**Weaknesses:**
- ❌ **Requires coding** — Must write Python/TS, no markdown-only option
- ❌ **Small tool ecosystem** — 30+ community tools vs 13,700 OpenClaw skills
- ❌ **Learning curve** — Decorator syntax, async patterns
- ❌ **No marketplace** — Tools distributed via PyPI/npm

### 8.3 Compatibility Feasibility

#### Can Chimera Support All Formats?

**Yes, with adapters and tradeoffs:**

**Technical feasibility:**
| Format | Import | Export | Fidelity | Performance Impact |
|--------|--------|--------|----------|-------------------|
| OpenClaw SKILL.md | ✅ Native | ✅ Native | 95% | Low (markdown parsing) |
| Claude Code skills | ✅ Same as OpenClaw | ✅ Same as OpenClaw | 95% | Low (same format) |
| Strands @tool | ✅ Wrap as MCP | ⚠️ Generate code | 80% | Medium (Python runtime) |
| MCP servers | ✅ Native | ✅ Native | 100% | Medium (IPC overhead) |

**Fidelity losses:**
- **OpenClaw → Chimera**: Prompt injection patterns must be sanitized
- **Strands → Chimera**: Stateful class-based tools lose state
- **MCP → OpenClaw**: Instructions must be manually written

#### Performance Implications

**Instruction-based skills** (OpenClaw/Claude Code):
- **Overhead**: Token cost (instructions added to every prompt)
- **Latency**: Negligible (just text injection)
- **Scaling**: Linear with skill count (more skills = bigger prompts)

**MCP-based skills**:
- **Overhead**: Process startup (stdio) or HTTP request (remote)
- **Latency**: 5-20ms (local stdio), 20-50ms (HTTP same AZ)
- **Scaling**: Constant per tool call (doesn't grow with skill count)

**Hybrid strategy** (Chimera's approach):
- **Instructions** for guidance → added to prompt (token cost)
- **MCP tools** for execution → separate process (latency cost)
- **Best of both worlds** but highest resource usage

**Optimization:**
- Cache MCP client connections (connection pooling)
- Batch tool calls where possible
- Use instruction-only skills for simple guidance
- Reserve MCP for compute-intensive tools

#### Developer Experience

**Skill authoring difficulty** (easiest to hardest):

1. **OpenClaw-style markdown** (easiest)
   - Write instructions in natural language
   - No coding required
   - Risk: security vulnerabilities

2. **Chimera SKILL.md v2** (moderate)
   - Same markdown format
   - + Explicit permission declarations
   - + Test cases (optional but recommended)

3. **MCP server** (moderate-hard)
   - Write JSON Schema for tools
   - Implement handlers (Python/TS/Go/etc.)
   - Deploy as process or HTTP service

4. **Strands @tool** (hard)
   - Write Python/TypeScript code
   - Understand decorators and type hints
   - Requires programming expertise

**Chimera should support all four** to balance accessibility with security.

---

## 9. Recommendations for Chimera

### 9.1 Native Skill Format

#### Proposed Schema

**Chimera SKILL.md v2** (backward-compatible with OpenClaw v1):

```markdown
---
# === Core Metadata ===
name: code-review
version: 2.1.0
description: "Automated code review with security scanning"
author: acme-corp
license: MIT
tags: [code-quality, security, developer-tools]
category: developer-tools

# === Security (NEW) ===
permissions:
  filesystem:
    read: ["**/*.py", "**/*.ts", "**/*.js"]
    write: ["/tmp/review-*"]
  network: false
  shell:
    allowed: ["grep", "wc", "diff"]
    denied: ["curl", "wget"]
  memory:
    read: true
    write: ["review_patterns"]
  secrets: []

# === Dependencies ===
dependencies:
  skills: []
  mcp_servers:
    - name: code-search
      optional: false
  packages:
    pip: ["ast-grep-py>=0.1.0"]
  binaries: ["git"]

# === Implementation (NEW) ===
mcp_server:
  transport: stdio
  command: "python"
  args: ["-m", "chimera_skill_code_review"]
  tools:
    - name: review_file
    - name: check_security

# === Testing (NEW) ===
tests:
  model: "us.anthropic.claude-sonnet-4-6-v1:0"
  cases:
    - name: basic_review
      input: "Review fixtures/example.py"
      expect:
        tool_calls: [review_file]
        output_contains: ["issue"]
---

# Code Review

[Natural language instructions here...]
```

#### Rationale

**Why this format:**

1. **Backward-compatible** — OpenClaw v1 skills work without modification
2. **Security-first** — Explicit permission declarations (Cedar-enforceable)
3. **Testable** — Inline test definitions enable automated validation
4. **Hybrid** — Supports both instructions (markdown) and implementations (MCP)
5. **Simple** — Non-technical users can write instruction-only skills
6. **Flexible** — Developers can add MCP servers for complex tools

**Key improvements over OpenClaw:**
- Mandatory permission declarations (preventing ClawHavoc-style attacks)
- Built-in testing framework (quality assurance)
- MCP-first tool implementation (process isolation)
- Ed25519 signing (provenance verification)

### 9.2 Compatibility Layer Priority

#### Phase 1: Essential Support (Q1 2026)

**Priority 1:**
- ✅ **Chimera SKILL.md v2** — Native format (define spec, implement parser)
- ✅ **OpenClaw v1 import** — Adapter for existing 13,700+ skills
- ✅ **MCP server wrapping** — Register MCP servers as skills

**Deliverables:**
- SKILL.md v2 specification document
- Skill parser and validator
- OpenClaw adapter (import SKILL.md → Chimera format)
- MCP adapter (register server → skill registry)
- Basic CLI: `chimera skill import`, `chimera skill install`

**Success metric:** Import 100 popular OpenClaw skills, 10 MCP servers

#### Phase 2: Extended Compatibility (Q2 2026)

**Priority 2:**
- ✅ **Strands @tool import** — Wrap Python tools as MCP servers
- ✅ **Claude Code skill import** — Same as OpenClaw (format compatible)
- ✅ **Security pipeline** — Implement 7-stage scanning (static analysis, sandbox, signing)

**Deliverables:**
- Strands adapter (Python @tool → MCP server → skill)
- Security scanning Step Functions workflow
- OpenSandbox integration for skill testing
- Cedar policy generation from permissions
- Ed25519 signing service

**Success metric:** 500 imported skills passing security scan, 50 Strands tools wrapped

#### Phase 3: Full Ecosystem (Q3-Q4 2026)

**Priority 3:**
- ✅ **Marketplace MVP** — Searchable registry, tenant installation
- ✅ **Export adapters** — Chimera → OpenClaw, Chimera → Strands
- ✅ **Auto-skill generation** — Pattern detection, skill proposals
- ✅ **Cross-tenant sharing** — Publish skills to marketplace

**Deliverables:**
- DynamoDB skill registry
- Bedrock Knowledge Base for semantic search
- Web UI for marketplace browsing
- Export adapters (reverse translation)
- Self-evolution integration (auto-generate skills from patterns)

**Success metric:** 1,000 skills in marketplace, 100 tenants publishing, 10K installs

### 9.3 Implementation Roadmap

#### Milestone 1: Core Format (Month 1)

**Goal:** Define and implement Chimera SKILL.md v2 format

**Tasks:**
1. Finalize SKILL.md v2 specification
2. Implement YAML parser with schema validation
3. Build skill metadata extractor
4. Create sample skills (5 examples covering all features)
5. Write format documentation

**Output:** `chimera-skill-format-v2.md` spec document

#### Milestone 2: OpenClaw Adapter (Month 2)

**Goal:** Import OpenClaw skills into Chimera

**Tasks:**
1. Build OpenClaw SKILL.md → Chimera translator
2. Handle v1 vs v2 format differences
3. Infer permissions from `tools` field (v1 compatibility)
4. Test with 100 popular OpenClaw skills
5. CLI: `chimera skill import ./openclaw-skill/SKILL.md`

**Output:** 100 OpenClaw skills successfully imported and executable

#### Milestone 3: Claude Code Bridge (Month 2)

**Goal:** Import Claude Code skills

**Tasks:**
1. Verify format compatibility with OpenClaw
2. Handle plugin-scoped metadata (extract from package.json)
3. Test with Claude Code plugin skills

**Output:** Claude Code skills importable via same adapter

#### Milestone 4: MCP Integration (Month 3)

**Goal:** MCP servers as first-class skills

**Tasks:**
1. Build MCP adapter (server config → skill manifest)
2. Implement MCP client lifecycle (start/stop servers)
3. Tool discovery via MCP `initialize` protocol
4. Test with 10 official MCP servers (filesystem, git, fetch, etc.)
5. CLI: `chimera skill import-mcp --server filesystem --path /workspace`

**Output:** 10 MCP servers registered as skills

#### Milestone 5: Marketplace (Months 4-6)

**Goal:** Launch skill marketplace with security scanning

**Tasks:**
1. DynamoDB schema for skill registry
2. S3 bucket for skill bundles
3. Bedrock Knowledge Base for semantic search
4. Security scanning pipeline (Step Functions)
5. Ed25519 signing service (KMS-backed)
6. CLI: `chimera skill publish`, `chimera skill search`, `chimera skill install`
7. Web UI for browsing/installing skills

**Output:** Marketplace live with 1,000 skills, semantic search, security scanning

---

## 10. Appendices

### Appendix A: Format Examples

#### OpenClaw SKILL.md Example (v1)

```markdown
---
name: aws-cost-analyzer
version: 1.0.0
description: "Analyze AWS costs and provide optimization recommendations"
author: steipete
tags: [aws, cost, cloud, optimization]
tools: [Bash, Read, Write]
dependencies:
  - cli: aws
---

# AWS Cost Analyzer

## When to Use
Activate when the user asks about AWS spending, cost optimization, or resource right-sizing.

## Instructions

### Step 1: Gather Cost Data
Run `aws ce get-cost-and-usage` for the requested time period.

### Step 2: Identify Top Spenders
Group by service, sort descending by cost.

### Step 3: Generate Recommendations
For each top-spending service, check for:
- Unused resources (0 CPU/network for 7+ days)
- Oversized instances (< 20% average utilization)
- Missing reservations (on-demand for steady-state workloads)

### Step 4: Output Report
Format as markdown table:

| Service | Monthly Cost | Recommendation | Estimated Savings |
|---------|--------------|----------------|-------------------|
```

#### Claude Code Skill Example

```markdown
---
name: pr-reviewer
description: Review pull requests for code quality, security, and best practices
---

# PR Reviewer

## When to Use
Activate when the user asks to review a PR, check code quality, or analyze changes.

## Instructions

### Step 1: Get PR Context
Ask the user for the PR URL or use git to check the current branch's changes.

### Step 2: Analyze Changes
- Read the diff using Read or git diff tools
- Focus on changed lines (don't review unchanged code)
- Look for security issues, logic errors, style violations

### Step 3: Provide Feedback
Structure feedback as:
- **Critical**: Security vulnerabilities, logic errors
- **Important**: Performance issues, maintainability concerns
- **Minor**: Style suggestions, code quality improvements

Always be constructive and explain WHY each issue matters.
```

#### MCP Tool Schema Example

```json
{
  "name": "search_files",
  "description": "Search for files matching a pattern",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "Glob pattern to match (e.g., **/*.py)"
      },
      "path": {
        "type": "string",
        "description": "Directory to search in",
        "default": "."
      },
      "max_results": {
        "type": "integer",
        "description": "Maximum number of results to return",
        "default": 100
      }
    },
    "required": ["pattern"]
  }
}
```

#### Strands @tool Example

```python
from strands import tool
from typing import Optional

@tool
def analyze_csv(
    file_path: str,
    columns: Optional[list[str]] = None
) -> str:
    """Analyze a CSV file and provide statistical summary.

    Args:
        file_path: Path to the CSV file
        columns: Optional list of specific columns to analyze
    """
    import pandas as pd

    # Read CSV
    df = pd.read_csv(file_path)

    # Select columns if specified
    if columns:
        df = df[columns]

    # Generate summary
    summary = {
        "row_count": len(df),
        "columns": list(df.columns),
        "summary_stats": df.describe().to_dict(),
        "null_counts": df.isnull().sum().to_dict()
    }

    return f"CSV Analysis Results:\n{json.dumps(summary, indent=2)}"
```

### Appendix B: Reference Documentation

#### OpenClaw Documentation

- **ClawHub**: https://clawhub.ai — Skill marketplace
- **OpenClaw GitHub**: https://github.com/openclaw/openclaw
- **SKILL.md Format**: Community-maintained specification
- **ClawHavoc Incident Reports**:
  - Koi Security: "12% of ClawHub Malicious" (Feb 2026)
  - CVE-2026-25253: WebSocket hijacking RCE (CVSS 8.8)
  - VoltAgent Curated List: 5,490 vetted skills

#### Claude Code Skills Guide

- **Claude Code Documentation**: Available in-app via `/help`
- **Plugin Development**: GitHub repo (anthropics/claude-code-plugins)
- **Skills within Plugins**: Part of plugin package structure

#### MCP Specification

- **MCP Specification**: https://spec.modelcontextprotocol.io/
- **MCP Servers Repository**: https://github.com/modelcontextprotocol/servers
- **MCP SDK Documentation**: https://modelcontextprotocol.io/sdk
- **Official Servers**: filesystem, git, fetch, memory, time, sequential-thinking

#### Strands Documentation

- **Strands Agents Website**: https://strandsagents.com
- **GitHub (Python)**: https://github.com/strands-agents/sdk-python
- **GitHub (TypeScript)**: https://github.com/strands-agents/sdk-typescript
- **AWS Blog**: "Introducing Strands Agents" (May 2025)
- **Community Tools**: 30+ in strands-agents/tools repo

### Appendix C: Glossary

**Skill:** A self-contained capability package that extends agent behavior through instructions, tool definitions, or both. Can be instruction-based (markdown), implementation-based (code), or hybrid.

**Tool:** A specific function an agent can invoke. Tools take parameters and return results. Defined via @tool decorators (Strands), JSON Schema (MCP), or prose descriptions (OpenClaw).

**Adapter:** A translation layer that converts skills from one format (e.g., OpenClaw SKILL.md) to another (e.g., Chimera internal format). Handles schema mapping, permission inference, and format normalization.

**Registry:** A centralized or federated database of skill metadata enabling discovery, versioning, and installation. Examples: ClawHub (centralized), npm (centralized), git (federated).

**Compatibility Layer:** The software infrastructure enabling Chimera to import, execute, and export skills across multiple platform formats (OpenClaw, Claude Code, Strands, MCP).

**Trust Tier:** A security classification assigned to skills based on review rigor and isolation level. Chimera uses 5 tiers: platform, verified, community, private, experimental.

**MCP Server:** A process that exposes tools via the Model Context Protocol. Can run locally (stdio transport) or remotely (HTTP/SSE transport). Provides process isolation from the agent.

**Cedar Policy:** A declarative authorization policy (using Amazon Cedar language) that enforces skill permissions at runtime. Maps declared capabilities to allowed operations.

**Ed25519 Signature:** A cryptographic signature using the Ed25519 elliptic curve algorithm. Used for skill provenance verification (author signature + platform co-signature).

**OpenSandbox:** An isolated MicroVM environment for testing skills without risk to the host system. Enforces network, filesystem, and memory limits.

**ClawHavoc:** A supply chain attack on the OpenClaw ecosystem (Jan-Mar 2026) where 1,184 malicious skills were published to ClawHub, compromising 12% of the marketplace at peak.

---

**Research Period:** 2026-03-20
**Agent:** skill-formats-survey
**Task:** chimera-e55a
**Status:** In Progress
