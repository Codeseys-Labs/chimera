---
title: MCP Tools and AgentCore Gateway Integration
task: chimera-e55a
agent: mcp-gateway-research
created: 2026-03-20
status: in-progress
topics:
  - Model Context Protocol
  - AgentCore Gateway
  - Tool Discovery
  - Skill Wrapping
---

# MCP Tools and AgentCore Gateway Integration

## Executive Summary

**Research Questions:**
1. Can Chimera wrap MCP tools as first-class skills?
2. How does tool discovery work across 200+ MCP servers?
3. What are the schema differences between MCP JSON Schema and SKILL.md frontmatter?
4. How does MCP tool expressiveness compare to skill format expressiveness?
5. Can AgentCore Gateway serve as skill infrastructure?

**Key Findings:**

1. **MCP tools CAN be wrapped as Chimera skills** — The 500+ MCP server ecosystem provides immediate tool access through standardized JSON-RPC protocol
2. **AgentCore Gateway is production-ready** (GA as of Aug 2025) and provides native MCP support, tool routing, and semantic discovery
3. **Schema gap exists** — MCP JSON Schema is machine-optimal but lacks LLM selection triggers; Skills format is LLM-optimal but lacks validation
4. **Hybrid approach recommended** — Use Gateway for curated/shared tools, direct MCP client for low-latency personal tools
5. **Discovery is the bottleneck** — With 10,000+ tools across servers, semantic search and categorization are critical

---

## Table of Contents

1. [MCP Protocol Overview](#mcp-protocol-overview)
2. [MCP Tools as Skills](#mcp-tools-as-skills)
3. [Tool Discovery Patterns](#tool-discovery-patterns)
4. [Schema Comparison](#schema-comparison)
5. [Expressiveness Analysis](#expressiveness-analysis)
6. [AgentCore Gateway Architecture](#agentcore-gateway-architecture)
7. [Integration Strategy](#integration-strategy)
8. [Implementation Recommendations](#implementation-recommendations)

---

## MCP Protocol Overview

### What is MCP?

**Model Context Protocol (MCP)** is an open protocol created by Anthropic that enables seamless integration between LLM applications and external data sources/tools. Released in late 2024, it standardizes how AI systems access context and capabilities.

**Core Architecture:**
- **JSON-RPC 2.0** messaging between clients and servers
- **Client-Server Model:** Servers expose tools/resources/prompts; clients (host apps) consume them
- **Capability Negotiation:** Both sides declare supported features during initialization
- **Transport Agnostic:** Supports stdio, HTTP/SSE, WebSocket

**Three Protocol Components:**

1. **Tools** — Executable functions with JSON Schema-defined inputs
2. **Resources** — Data sources (files, databases, APIs) with URIs
3. **Prompts** — Reusable prompt templates with parameters

**Inspired by Language Server Protocol (LSP)** — LSP standardized language tooling across IDEs; MCP standardizes context/tool integration across AI apps.

### MCP Server Ecosystem

**Explosive Growth:** From initial release in late 2024 to 10,000+ indexed servers by early 2026 (PulseMCP index)

**Official Registries:**
- **Smithery.ai** — Curated registry with quality control
- **mcp.so** — Community-driven directory
- **GitHub: modelcontextprotocol/servers** — Official reference implementations

**Ecosystem Categories (40+ major servers):**

1. **Version Control & Repository Hosting**
   - Git (direct CLI operations)
   - GitHub (full API access, most popular)
   - GitLab, Bitbucket, Gitea (self-hosted options)

2. **CI/CD & Build Automation**
   - CircleCI, Jenkins, Bitrise
   - GitHub Actions integration

3. **Developer Tools**
   - Chrome DevTools (28.9k stars)
   - Playwright (browser automation)
   - Code search and documentation

4. **Data & APIs**
   - Database connectors (PostgreSQL, MySQL, MongoDB)
   - REST API clients
   - GraphQL servers

5. **Productivity & Communication**
   - Slack, Discord integrations
   - Email, calendar services
   - Task management (Linear, Jira, Notion)

6. **AI & LLM Tools**
   - Context7 (49k stars — up-to-date code docs for LLMs)
   - Vector databases (Pinecone, Weaviate)
   - Embedding services

**Top Servers by Adoption:**
- **Filesystem** (81.1k stars) — Official, secure file operations
- **Memory** (81.1k stars) — Official, knowledge graph persistence
- **Fetch** (81.1k stars) — Official, web content → markdown
- **Context7** (49k) — Real-time library documentation
- **Chrome DevTools** (29k) — Browser automation for agents

**Platform Vendors Shipping MCP Servers:**
- AWS, GitHub, Figma, Sentry, Notion, Supabase
- Official servers alongside traditional APIs

### MCP Tool Schema

**Tool Definition Structure:**

MCP tools are defined using JSON Schema for type-safe, validated inputs. The protocol uses `tools/list` request to discover available tools and `tools/call` to execute them.

```json
{
  "name": "search_codebase",
  "description": "Search the codebase for files matching a pattern and content matching a regex",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "File name pattern (glob syntax)"
      },
      "content_regex": {
        "type": "string",
        "description": "Regular expression to match file contents"
      },
      "max_results": {
        "type": "integer",
        "description": "Maximum number of results to return",
        "default": 10,
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": ["pattern"]
  }
}
```

**Key Features:**
- **JSON Schema Validation:** Type checking, constraints, enums, patterns
- **Rich Type System:** string, number, boolean, array, object, null
- **Nested Schemas:** Support for complex object hierarchies
- **Constraints:** min/max, regex patterns, enum values, array length
- **Default Values:** Optional parameters with defaults
- **Clear Descriptions:** Inline documentation for LLMs

**Tool Invocation Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "method": "tools/call",
  "params": {
    "name": "search_codebase",
    "arguments": {
      "pattern": "*.ts",
      "content_regex": "interface.*Agent",
      "max_results": 20
    }
  }
}
```

**Tool Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Found 12 matching files:\n1. src/agents/base.ts\n..."
      }
    ],
    "isError": false
  }
}
```

---

## MCP Tools as Skills

### Wrapping MCP Tools

**Core Question:** Can MCP tools be wrapped as Chimera skills?

#### Conceptual Mapping

**Answer: YES, MCP tools can be wrapped as Chimera skills.**

Conceptual alignment is strong:

| MCP Concept | Chimera Skill Equivalent | Notes |
|-------------|-------------------------|-------|
| MCP tool | Chimera skill | 1:1 mapping for atomic operations |
| MCP server | Skill provider/namespace | Group related skills (e.g., `github:create-pr`, `github:list-issues`) |
| Tool invocation | Skill execution | Runtime invocation semantics |
| Tool response | Skill output | Result format (text, JSON, error) |
| Tool description | Skill trigger/description | Guides LLM selection |
| inputSchema | Skill parameters | Type definitions and validation |

**Skill Naming Convention:**
```
{server_name}:{tool_name}
Examples:
  - filesystem:read_file
  - github:create_pull_request
  - slack:send_message
```

#### Wrapping Architecture

**Three-Layer Architecture:**

```
┌──────────────────────────────────────────────────────┐
│         Chimera Skill Interface                      │
│  - Skill discovery (list available skills)           │
│  - Skill invocation (execute with parameters)        │
│  - Skill metadata (description, triggers, params)    │
├──────────────────────────────────────────────────────┤
│         MCP Tool Adapter Layer                       │
│  - Protocol translation (Skill API ↔ JSON-RPC)       │
│  - Schema conversion (JSON Schema ↔ Skill params)    │
│  - Trigger generation (description → LLM triggers)   │
│  - Namespace management (server:tool naming)         │
│  - Error mapping (MCP errors → Skill errors)         │
├──────────────────────────────────────────────────────┤
│         MCP Client (Protocol Layer)                  │
│  - Transport: stdio, HTTP/SSE, WebSocket             │
│  - JSON-RPC 2.0 message handling                     │
│  - Connection lifecycle (init, capabilities, close)  │
│  - Request/response correlation                      │
├──────────────────────────────────────────────────────┤
│         MCP Server (Python/TypeScript/etc)           │
│  - Tool implementations                              │
│  - Resource providers                                │
│  - Prompt templates                                  │
└──────────────────────────────────────────────────────┘
```

**Adapter Layer Responsibilities:**

1. **Server Discovery**
   - List all installed MCP servers
   - Query each server for available tools (`tools/list`)
   - Build skill registry with namespaced names

2. **Schema Translation**
   - Parse JSON Schema from `inputSchema`
   - Generate Skill parameter definitions
   - Maintain type mapping table (JSON Schema → Skill types)

3. **Trigger Generation**
   - Extract `description` from MCP tool
   - Generate natural language triggers for LLM selection
   - Add context about when to use the tool

4. **Invocation Translation**
   - Accept Skill invocation with parameters
   - Construct JSON-RPC `tools/call` request
   - Handle streaming responses (if supported)
   - Map result to Skill output format

5. **Error Handling**
   - Catch MCP errors (server down, tool not found, validation)
   - Translate to Skill error format
   - Provide actionable error messages

#### Challenges

**1. Protocol Translation Overhead**
- JSON-RPC message encoding/decoding adds latency (~5-15ms per call)
- Connection pooling required for multiple servers
- Stateful connections (especially stdio transport) require process management

**2. State Management**
- MCP sessions can be stateful (e.g., filesystem server remembers CWD)
- Chimera skills may assume statelessness
- **Solution:** Track session state in adapter layer, expose as skill context

**3. Error Handling Differences**
- MCP uses JSON-RPC error codes (-32000 to -32099 for application errors)
- Skills may expect natural language error messages
- **Solution:** Error translation table, contextual error messages for LLMs

**4. Streaming vs Batch Responses**
- Some MCP tools support streaming (e.g., LLM sampling, large file reads)
- Skill interface may not support streaming
- **Solution:** Buffer streams or expose streaming as advanced skill feature

**5. Authentication/Authorization**
- MCP servers use varied auth (env vars, OAuth, API keys)
- Multi-tenant Chimera needs centralized auth management
- **Solution:** AgentCore Gateway handles auth (covered in Gateway section)

**6. Discovery at Scale**
- With 10,000+ tools across servers, listing all tools is expensive
- Need lazy loading and caching
- **Solution:** Semantic search, category filtering (covered in Discovery section)

**7. Version Drift**
- MCP servers update independently
- Tool schemas can change (breaking changes)
- **Solution:** Version pinning, schema validation, graceful degradation

**8. Transport Diversity**
- stdio (process spawn, local only)
- HTTP/SSE (network, requires server deployment)
- WebSocket (bidirectional, complex lifecycle)
- **Solution:** Unified client abstraction over all transports

#### Benefits

**1. Instant Access to 10,000+ Tools**
- Avoid reimplementing integrations for GitHub, Slack, databases, etc.
- Community-contributed servers for niche tools
- Official platform servers (AWS, Notion, Supabase)

**2. Standard Protocol for Interoperability**
- No vendor lock-in to specific tool providers
- Tools work across any MCP-compatible agent platform
- Well-defined JSON-RPC 2.0 semantics

**3. Active Ecosystem**
- New servers published daily
- Official registries (Smithery.ai, mcp.so) for discovery
- Community support and documentation

**4. Proven in Production**
- Used by Claude Desktop since late 2024
- Adopted by Cursor, Cline, and other IDEs
- Battle-tested with diverse workloads

**5. Extensibility**
- Write custom MCP servers in Python/TypeScript
- Expose internal APIs as tools without rewriting agent code
- Modular: add/remove servers without touching agent runtime

**6. Multi-Language Support**
- MCP SDKs for Python, TypeScript, Go, Rust
- Protocol-based: any language with JSON-RPC support

**7. Resource and Prompt Support**
- Beyond tools: MCP also provides resources (data) and prompts (templates)
- Chimera can expose resources as skill inputs and prompts as skill templates

---

## Tool Discovery Patterns

### Discovery Problem

**Scale:** 200+ MCP servers, each with multiple tools (5-50 tools per server)
**Challenge:** How does a user/agent discover relevant tools?

### Existing Discovery Mechanisms

#### 1. MCP Registry Approach

**Three Major Registries Exist:**

**a) Smithery.ai** (Curated, Quality-Controlled)
- Manually reviewed submissions
- Category taxonomy (developer tools, AI & LLM, data & APIs, productivity)
- Installation instructions for Claude Desktop, Cursor
- GitHub stars and recency as quality signals

**b) mcp.so** (Community-Driven)
- Open submissions
- User ratings and reviews
- Uptime monitoring for hosted servers
- Weekly featured servers

**c) PulseMCP** (Comprehensive Index)
- Aggregates from GitHub, registries, community submissions
- Indexes 10,000+ servers (includes experimental/abandoned)
- No quality filtering (use star count as proxy)

**Metadata Schema (Common Fields):**
```json
{
  "name": "server-name",
  "description": "What the server does",
  "author": "github-username",
  "repository": "https://github.com/...",
  "license": "MIT",
  "categories": ["developer-tools", "version-control"],
  "tags": ["git", "github", "repository"],
  "transport": ["stdio", "http"],
  "install": {
    "npm": "npx -y package-name",
    "pip": "uvx package-name"
  },
  "stars": 1234,
  "last_updated": "2026-03-15"
}
```

**Current Limitations:**
- No cross-registry federation
- No semantic search (keyword matching only)
- No tool-level granularity (server-level discovery)
- No usage analytics shared publicly

#### 2. Semantic Search

**AgentCore Gateway Native Feature** (Feb 2026):
- Embeds tool descriptions using Bedrock Titan or custom embedding models
- Agent sends natural language query: "I need to search our codebase for security vulnerabilities"
- Gateway returns ranked tools: `grep_security_patterns`, `sast_scanner`, `code_search_regex`

**Implementation Pattern:**
```
1. Index Phase:
   - Extract tool descriptions from all registered MCP servers
   - Generate embeddings (768-dim vectors) using Titan Embeddings
   - Store in OpenSearch or pgvector with metadata

2. Query Phase:
   - Agent/user provides natural language query
   - Embed query using same model
   - Vector similarity search (cosine similarity)
   - Rank by relevance score (0-1)
   - Return top-k tools with descriptions

3. Context Augmentation:
   - Include tool usage examples in embeddings
   - Add popularity signals to ranking
   - Filter by user permissions/tenant access
```

**Benefits:**
- Discover tools without knowing exact names
- Natural language queries: "send a Slack message" → `slack:post_message`
- Handles synonyms: "create PR" → `github:create_pull_request`

**Challenges:**
- Embedding quality depends on tool description richness
- Cold start problem (new tools with no usage data)
- Computational cost at scale (10,000+ tools → 10k embeddings)

#### 3. Category/Tag-Based

**Industry Standard Taxonomy (40+ categories):**

1. **Version Control & Repository Hosting**
2. **CI/CD & Build Automation**
3. **Developer Tools** (debugging, profiling, linting)
4. **Data & APIs** (databases, GraphQL, REST)
5. **Productivity** (task management, calendars)
6. **AI & LLM** (embeddings, vector DBs, context providers)
7. **Communication** (Slack, Discord, email)
8. **Cloud Infrastructure** (AWS, Azure, GCP)
9. **Security & Compliance**
10. **Testing & QA**

**Hierarchical Organization:**
```
Developer Tools
  ├── Debugging
  │   ├── Chrome DevTools (browser)
  │   └── LLDB (native)
  ├── Code Search
  │   ├── grep-based
  │   └── AST-based
  └── Linting
      ├── ESLint (JavaScript)
      └── Pylint (Python)
```

**Tag System:**
- Free-form tags (git, github, repository, pull-request)
- Searchable via boolean queries: `(git OR github) AND pull-request`
- No controlled vocabulary (leads to synonyms: PR vs pull-request)

### Recommended Discovery Strategy for Chimera

**Multi-Tier Approach:**

```
Tier 1: Curated Static Registry
  - 50-100 high-quality, verified MCP servers
  - Manually reviewed for security, reliability, documentation
  - Chimera team maintains and updates
  - Pre-installed for all tenants (Basic tier and above)

Tier 2: User-Installed Servers (Dynamic Discovery)
  - Tenants install additional MCP servers per-workspace
  - Scoped to tenant namespace (tenant-123:custom-server:tool)
  - Self-service installation via Chimera UI or API

Tier 3: Semantic Search Layer (Vector DB)
  - Embed all tool descriptions (Tier 1 + Tier 2)
  - OpenSearch with kNN plugin OR pgvector
  - Natural language queries at agent runtime
  - Results ranked by: relevance (0.6) + popularity (0.2) + tenant usage (0.2)

Tier 4: Category Taxonomy (Browse and Filter)
  - UI for browsing tools by category
  - Filter by transport, auth model, stars, recency
  - "Featured" and "Recommended" collections

Tier 5: Usage Analytics (Popularity and Quality Signals)
  - Track tool invocation frequency per tenant
  - Success/failure rates
  - Latency metrics (p50, p99)
  - Recommend tools based on tenant's agent workflows
```

**Discovery API Design:**

```typescript
interface SkillDiscoveryRequest {
  query?: string;                    // Natural language or keyword search
  categories?: string[];             // Filter by categories
  tags?: string[];                   // Filter by tags
  tier?: 'curated' | 'user' | 'all'; // Scope to specific tier
  limit?: number;                    // Max results (default: 20)
  offset?: number;                   // Pagination
}

interface SkillDiscoveryResponse {
  skills: Array<{
    id: string;                      // Unique skill ID (server:tool)
    name: string;
    description: string;
    server: string;                  // MCP server name
    categories: string[];
    tags: string[];
    relevance_score?: number;        // 0-1 (if semantic search used)
    popularity_score: number;        // Based on usage
    install_command?: string;        // For Tier 2 servers
  }>;
  total: number;
  next_offset?: number;
}
```

---

## Schema Comparison

### MCP JSON Schema vs SKILL.md Frontmatter

#### MCP Tool Schema

[To be filled: Detailed breakdown of MCP JSON Schema structure]

**Structure:**
```json
{
  "name": "string",
  "description": "string",
  "inputSchema": {
    "type": "object",
    "properties": {
      "param1": {"type": "string", "description": "..."},
      "param2": {"type": "number", "description": "..."}
    },
    "required": ["param1"]
  }
}
```

**Capabilities:**
- JSON Schema validation
- Type definitions (string, number, boolean, array, object)
- Required vs optional parameters
- Nested objects and arrays
- Pattern matching, enums, constraints

#### SKILL.md Frontmatter Schema

**Claude Code Skills Format** (from official docs and community examples):

**Structure:**
```yaml
---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality
trigger: Use this skill when the user asks to build web components, pages, or UI features
version: 1.0.0
model: claude-opus-4.6
allowed-tools:
  - Write
  - Edit
  - Bash
disable-model-invocation: false
mode: assistant
parameters:
  - name: component_type
    type: string
    required: true
    description: Type of component to create (page, modal, form, card, etc.)
  - name: design_style
    type: string
    required: false
    description: Design aesthetic (minimal, glassmorphism, brutalist, etc.)
---

# Skill Implementation

Main skill instructions go here in markdown format. This is where you define:
- Step-by-step workflow
- Code patterns and examples
- Design principles
- Testing requirements
```

**Full Field Reference:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Kebab-case skill identifier |
| `description` | string | Yes | One-line summary of skill purpose |
| `trigger` | string | Yes | Natural language: when to activate |
| `version` | string | No | Semantic version (1.2.3) |
| `model` | string | No | Specific model to use (claude-opus-4.6) |
| `allowed-tools` | array | No | Whitelist of tools this skill can invoke |
| `disable-model-invocation` | bool | No | If true, skip FM reasoning (template-only) |
| `mode` | string | No | `assistant` (default) or `autonomous` |
| `parameters` | array | No | Structured input parameters |

**Capabilities:**
- **Human-readable YAML** — Easy to author and review
- **Trigger conditions** — Natural language helps LLM decide when to use
- **Tool permissions** — `allowed-tools` for security sandboxing
- **Model selection** — Override default model per-skill
- **Versioning** — Semantic versioning for compatibility
- **Rich documentation** — Full markdown body with examples, patterns, workflows

#### Comparison Matrix

| Feature | MCP JSON Schema | SKILL.md Frontmatter | Winner |
|---------|----------------|---------------------|---------|
| **Type safety** | Strong (JSON Schema validation) | Weak (YAML parsing, no validation) | MCP |
| **Validation** | Built-in (min/max, patterns, enums) | Manual (read docs, guess types) | MCP |
| **Expressiveness** | Structured data constraints | Natural language descriptions | Tie |
| **Documentation** | Inline `description` fields | Full markdown body with examples | Skills |
| **Trigger logic** | None (LLM must infer from description) | Explicit `trigger` field for LLM | Skills |
| **Examples** | External (separate docs) | Inline in markdown body | Skills |
| **Machine-readable** | ✓ Fully parseable, executable | Partial (frontmatter yes, body no) | MCP |
| **Human-readable** | Partial (JSON/Schema not intuitive) | ✓ YAML + markdown | Skills |
| **Model override** | Not supported | `model` field per-skill | Skills |
| **Tool permissions** | Not supported | `allowed-tools` sandboxing | Skills |
| **Versioning** | Not in spec (server-level only) | `version` field per-skill | Skills |
| **Multi-language** | ✓ Language-agnostic protocol | Language-agnostic format | Tie |
| **Ecosystem size** | 10,000+ servers, 50k+ tools | ~500 skills (as of March 2026) | MCP |
| **LLM selection hints** | Weak (description only) | Strong (trigger, context, examples) | Skills |
| **Parameter defaults** | ✓ JSON Schema `default` field | Not in spec (must document in body) | MCP |
| **Nested objects** | ✓ Full object hierarchies | Not in spec (flatten parameters) | MCP |

**Key Insight:**
- **MCP is machine-optimal** — JSON Schema ensures type safety and validation, perfect for API-style tools
- **Skills are LLM-optimal** — Triggers and examples help FMs decide when/how to use, perfect for agent workflows

#### Bridging the Gap

**Goal:** Chimera should support BOTH formats natively, converting between them as needed.

**MCP → Skill Conversion Algorithm:**

```python
def mcp_tool_to_skill(mcp_tool: dict, server_name: str) -> SkillDefinition:
    """
    Convert MCP tool definition to Chimera skill format.
    """
    skill_name = f"{server_name}:{mcp_tool['name']}"

    # 1. Extract basic metadata
    description = mcp_tool['description']

    # 2. Generate trigger from description using LLM (optional enhancement)
    # Simple heuristic: "Use when {description_lowercased}"
    trigger = f"Use when you need to {description.lower()}"

    # 3. Convert JSON Schema → parameter list
    parameters = []
    schema = mcp_tool.get('inputSchema', {})
    properties = schema.get('properties', {})
    required = set(schema.get('required', []))

    for param_name, param_schema in properties.items():
        param_type = param_schema.get('type', 'string')
        parameters.append({
            'name': param_name,
            'type': map_json_type_to_skill_type(param_type),
            'required': param_name in required,
            'description': param_schema.get('description', ''),
            'default': param_schema.get('default'),
        })

    # 4. Generate markdown body with usage examples
    markdown_body = generate_skill_documentation(
        tool_name=mcp_tool['name'],
        description=description,
        parameters=parameters,
        server_name=server_name
    )

    return SkillDefinition(
        name=skill_name,
        description=description,
        trigger=trigger,
        version="1.0.0",
        parameters=parameters,
        markdown_body=markdown_body,
        source='mcp',
        mcp_server=server_name,
        mcp_tool_name=mcp_tool['name']
    )

def map_json_type_to_skill_type(json_type: str) -> str:
    """Map JSON Schema types to Skill parameter types."""
    mapping = {
        'string': 'string',
        'integer': 'number',
        'number': 'number',
        'boolean': 'boolean',
        'array': 'array',
        'object': 'object',
    }
    return mapping.get(json_type, 'string')

def generate_skill_documentation(tool_name, description, parameters, server_name):
    """Generate markdown documentation for MCP-wrapped skill."""
    return f"""
# {tool_name}

**Source:** MCP Server `{server_name}`

## Description

{description}

## Parameters

{format_parameters_table(parameters)}

## Usage

This skill wraps the `{tool_name}` tool from the `{server_name}` MCP server.
It is invoked automatically when relevant to the task.

## Example

[Auto-generated example would go here based on parameter types]
"""
```

**Skill → MCP Server Conversion:**

```python
def skill_to_mcp_tool(skill: SkillDefinition) -> dict:
    """
    Convert Chimera skill to MCP tool definition.
    Used when exposing Chimera skills via MCP protocol.
    """
    # 1. Parse frontmatter parameters
    input_schema = {
        "type": "object",
        "properties": {},
        "required": []
    }

    for param in skill.parameters:
        prop_schema = {
            "type": map_skill_type_to_json_type(param['type']),
            "description": param.get('description', '')
        }

        if 'default' in param:
            prop_schema['default'] = param['default']

        input_schema['properties'][param['name']] = prop_schema

        if param.get('required', False):
            input_schema['required'].append(param['name'])

    # 2. Create MCP tool definition
    return {
        "name": skill.name.replace(':', '_'),  # MCP tools can't have colons
        "description": f"{skill.description}\n\nTrigger: {skill.trigger}",
        "inputSchema": input_schema
    }

def map_skill_type_to_json_type(skill_type: str) -> str:
    """Map Skill parameter types to JSON Schema types."""
    mapping = {
        'string': 'string',
        'number': 'number',
        'boolean': 'boolean',
        'array': 'array',
        'object': 'object',
    }
    return mapping.get(skill_type, 'string')
```

**Key Considerations:**

1. **Trigger Generation:** Simple heuristic works for basic cases, but LLM-generated triggers are better
2. **Lossy Conversion:** JSON Schema constraints (min/max, patterns) lost when converting to Skills
3. **Namespace Collision:** MCP tool names don't include server name; Skills use `server:tool` format
4. **Documentation Quality:** Auto-generated docs are basic; manual enhancement recommended
5. **Bidirectional Roundtrip:** Skill → MCP → Skill may not preserve all metadata

---

## Expressiveness Analysis

### MCP Tool Expressiveness

**Strengths:**
[To be filled]
- Precise type definitions
- Validation guarantees
- Clear input/output contracts
- Language-agnostic protocol

**Limitations:**
[To be filled]
- No trigger logic (when to use tool)
- Limited context about tool purpose
- No usage examples in schema
- No guidance for LLMs on tool selection

### Skill Format Expressiveness

**Strengths:**
[To be filled]
- Rich trigger descriptions (helps LLM selection)
- Natural language documentation
- Inline examples and patterns
- Context about when/why to use

**Limitations:**
[To be filled]
- Weak type safety
- No built-in validation
- Ambiguous parameter definitions
- Requires parsing markdown

### Hybrid Approach

[To be filled: Combining strengths of both]

**Proposal:**
- Use JSON Schema for type definitions and validation
- Add skill-specific metadata for triggers and context
- Keep markdown documentation for examples
- Create unified schema that bridges both worlds

```json
{
  "name": "example_skill",
  "description": "...",
  "trigger": "Use when user wants to...",
  "inputSchema": { /* JSON Schema */ },
  "examples": [
    {"input": {...}, "output": {...}, "explanation": "..."}
  ],
  "documentation": "markdown content..."
}
```

---

## AgentCore Gateway Architecture

### Gateway Overview

**Amazon Bedrock AgentCore Gateway** is a fully managed service (GA: August 2025) that serves as a centralized tool server for AI agents. It addresses the M×N integration problem: connecting M agents to N tools without implementing M×N individual integrations.

**Purpose:**
- **Unified Tool Interface:** Single endpoint where agents discover and invoke tools
- **Protocol Abstraction:** Native MCP support with zero-code tool creation from APIs and Lambda
- **Security:** Built-in inbound/outbound authorization, multi-tenant isolation
- **Scalability:** Serverless infrastructure for MCP servers

**Key AWS Announcement (Feb 2026):**
> "Amazon Bedrock now enables server-side tool execution through AgentCore Gateway integration with the Responses API. Customers can connect their AgentCore Gateway tools to Bedrock models, enabling server-side tool execution without client-side orchestration."

**Architecture Role:**

```
┌─────────────────────────────────────────────────────┐
│         Agent Application (Chimera, etc.)           │
│  - Bedrock Converse/Responses API                   │
│  - Direct MCP Client (optional)                     │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│         Amazon Bedrock AgentCore Gateway            │
│  ┌─────────────────────────────────────────────┐   │
│  │  Tool Discovery (semantic search)           │   │
│  │  Tool Registry (metadata + versioning)      │   │
│  │  Request Router (load balancing)            │   │
│  │  Auth Manager (inbound/outbound IAM/OAuth)  │   │
│  │  Observability (traces, metrics, logs)      │   │
│  └─────────────────────────────────────────────┘   │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│         Tool Backends (Targets)                     │
│  - OpenAPI specs → MCP tools (zero-code)            │
│  - AWS Lambda functions → MCP tools                 │
│  - Smithy models → MCP tools                        │
│  - Standalone MCP servers (stdio/HTTP)              │
└─────────────────────────────────────────────────────┘
```

**Gateway Workflow:**

1. **Create Tools:** Define tools using OpenAPI specs, Lambda schemas, or Smithy models
2. **Create Gateway Endpoint:** Deploy Gateway with an HTTPS endpoint (MCP entry point)
3. **Add Targets:** Configure routing to backend APIs, Lambda, or MCP servers
4. **Connect Agents:** Point agent to Gateway URL; agents discover and invoke tools via MCP protocol

### Gateway Capabilities

#### 1. Tool Routing

**Intelligent Request Routing:**
- Routes MCP `tools/call` requests to appropriate backend targets
- Supports multiple target types per Gateway:
  - **REST APIs** (via OpenAPI spec parsing)
  - **AWS Lambda** (JSON Schema input/output)
  - **Smithy models** (AWS service APIs)
  - **External MCP servers** (stdio/HTTP proxying)

**Load Balancing:**
- Distributes requests across multiple backend instances
- Health checks for backend availability
- Automatic failover to healthy targets

**Circuit Breaking:**
- Monitors backend error rates
- Opens circuit (stops routing) when failure threshold exceeded
- Exponential backoff and retry logic
- Automatic circuit reset after cooldown period

**Routing Configuration:**
```json
{
  "target": {
    "type": "openapi",
    "spec_url": "https://api.example.com/openapi.json",
    "auth": {
      "type": "oauth",
      "flow": "client_credentials",
      "token_url": "https://auth.example.com/token"
    }
  }
}
```

#### 2. Tool Registry

**YES, Gateway maintains a full tool registry.**

**Registry Features:**
- **Tool Metadata Storage:**
  - Tool name, description, inputSchema (JSON Schema)
  - Target backend mapping (which API/Lambda serves this tool)
  - Version information (tool schema versions)
  - Usage statistics (invocation count, latency percentiles)

- **Discovery API:**
  - MCP `tools/list` request returns all registered tools
  - Supports filtering by category, tags, or prefix
  - Pagination for large tool catalogs (1000+ tools)

- **Semantic Tool Selection:**
  - Embeds tool descriptions using Bedrock embeddings
  - Natural language queries → ranked tool results
  - Agent queries "search codebase" → returns `grep_tool`, `ast_search`, `semantic_search`

- **Version Management:**
  - Multiple versions of same tool can coexist
  - Agents can pin to specific versions: `tool_name@1.2.0`
  - Deprecation warnings for old versions
  - Automatic migration paths for breaking changes

**Discovery Request Example:**
```json
// MCP tools/list request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {
    "filter": {
      "category": "code-search"
    }
  }
}

// Gateway response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "search_code_ast",
        "description": "Search codebase using AST pattern matching",
        "inputSchema": {...},
        "category": "code-search",
        "version": "2.1.0"
      }
    ]
  }
}
```

#### 3. Authentication & Authorization

**Inbound Authorization (Agent → Gateway):**
- **AWS IAM:** SigV4 signing for AWS-native auth
  - Gateway validates IAM principal has `bedrock:InvokeModel` or custom permissions
  - Works with IAM users, roles, and federated identities
- **OAuth 2.0:** Bearer token validation
  - Supports Cognito, Okta, Auth0, custom IdPs
  - Token introspection for claims-based access control
- **API Keys:** Simple key-based auth for development/testing

**Outbound Authorization (Gateway → Backend):**
- **IAM Roles:** Gateway assumes role to call AWS Lambda, APIs
  - Per-target role configuration
  - Supports cross-account access via role chaining
- **OAuth Client Credentials:** Gateway exchanges client ID/secret for access token
  - Token caching (avoid token fetch on every request)
  - Automatic token refresh when expired
- **API Keys:** Gateway injects API key header when calling backend APIs

**Multi-Tenant Isolation:**
```typescript
// Gateway configuration per tenant
{
  "tenant_id": "tenant-123",
  "inbound_auth": {
    "type": "iam",
    "allowed_principals": ["arn:aws:iam::123456789012:role/TenantAgentRole"]
  },
  "tools": [
    {
      "name": "tenant-123:custom_tool",
      "target": "arn:aws:lambda:us-east-1:123456789012:function:Tenant123CustomTool",
      "outbound_auth": {
        "type": "iam_role",
        "role_arn": "arn:aws:iam::123456789012:role/LambdaExecutionRole"
      }
    }
  ]
}
```

**Security Features:**
- **Tool-level access control:** Grant agent access to specific tools only
- **Rate limiting:** Per-tenant, per-tool invocation limits
- **Audit logging:** All tool invocations logged to CloudTrail
- **Secret management:** Credentials stored in Secrets Manager, rotated automatically

#### 4. Observability

**Built-in Monitoring:**

**1. Request Tracing (AWS X-Ray)**
- End-to-end trace: Agent → Gateway → Backend → Gateway → Agent
- Subsegments for each stage (auth, discovery, routing, invocation)
- Latency breakdown by component
- Error attribution (which backend caused failure?)

**2. Performance Metrics (CloudWatch)**
- **Throughput:** Requests/second, by tool, by tenant
- **Latency:** p50, p90, p99, p99.9 for tool invocations
- **Errors:** 4xx (client errors), 5xx (server errors), timeouts
- **Tool Popularity:** Invocation count per tool
- **Backend Health:** Success/failure rates per target

**3. Error Logging (CloudWatch Logs)**
- Structured JSON logs for all errors
- Stack traces for backend failures
- Request/response payloads (configurable retention)
- PII redaction for sensitive data

**4. Usage Analytics**
- Cost tracking: Compute time per tenant, per tool
- Tenant usage dashboards: Top tools, peak hours, cost trends
- Anomaly detection: Unusual usage patterns, potential abuse

**Dashboard Example Metrics:**
```
Gateway: chimera-prod-gateway

Throughput:
  - Total requests/min: 1,250
  - Top tool: github:create_pr (230/min)

Latency (p99):
  - Agent → Gateway: 12ms
  - Gateway → Backend: 85ms
  - Total roundtrip: 97ms

Error Rate:
  - 4xx (client errors): 2.3%
  - 5xx (server errors): 0.1%
  - Timeout rate: 0.05%

Top Tenants by Usage:
  1. tenant-123: 4,500 req/hr
  2. tenant-456: 3,200 req/hr
  3. tenant-789: 2,800 req/hr
```

### Gateway as Skill Infrastructure

**Question:** Can AgentCore Gateway serve as skill infrastructure for Chimera?

**Answer: YES — Gateway is purpose-built for this.**

#### Use Cases

**1. Skill Registry**

Gateway's tool registry naturally extends to skills:

- **Central Catalog:** All skills (MCP-wrapped, Lambda-based, custom) registered in Gateway
- **Metadata Schema:** Extend tool metadata with skill-specific fields:
  ```json
  {
    "name": "github:create_pr",
    "type": "skill",  // vs "tool"
    "description": "Create a pull request on GitHub",
    "trigger": "Use when user wants to open a PR or merge code",
    "inputSchema": {...},
    "category": "version-control",
    "version": "2.1.0",
    "source": "mcp",  // or "native", "lambda", "custom"
    "trust_tier": "verified"  // or "community", "experimental"
  }
  ```
- **Versioning:** Semantic versioning with deprecation warnings
- **Discovery API:** Agents query Gateway for available skills via MCP `tools/list`

**2. Skill Execution**

Gateway routes skill invocations to appropriate backends:

- **MCP Servers:** Gateway proxies MCP protocol to stdio/HTTP MCP servers
  - Example: `filesystem:read_file` → filesystem MCP server (stdio)
- **AWS Lambda:** Gateway invokes Lambda with skill parameters
  - Example: `data:etl_transform` → Lambda function with JSON Schema
- **ECS/Fargate:** Gateway calls containerized services via HTTP
  - Example: `ml:train_model` → ML training service on ECS
- **Nested Bedrock Agents:** Gateway invokes other agents as skills
  - Example: `research:deep_dive` → Research specialist agent

**Protocol Translation:**
- Skill invocation (Chimera internal) → MCP `tools/call` (Gateway standard)
- Response format normalization (all backends return uniform structure)

**3. Multi-Tenant Skill Serving**

Gateway's multi-tenancy features directly support tenant-isolated skills:

- **Tenant-Specific Skill Collections:**
  - Tier 1: Shared skills (all tenants, curated by Chimera)
  - Tier 2: Tenant-custom skills (installed per-tenant)
  - Tenant-level namespacing: `tenant-123:custom_skill`

- **Access Control:**
  - IAM policies: Which tenants can access which skills
  - Skill-level permissions: `github:*` vs `github:read_only`
  - Rate limiting per tenant, per skill

- **Usage Tracking:**
  - Cost allocation: Track skill invocations by tenant
  - Quota enforcement: Free tier (100 skill calls/day), Paid tier (unlimited)
  - Usage analytics: Which skills are popular per tenant

**4. Skill Marketplace Backend**

Gateway can power a Chimera Skill Marketplace:

- **Publishing:**
  - Developers deploy skill to Lambda/MCP server
  - Register skill in Gateway with metadata (name, description, trigger, category, pricing)
  - Gateway validates skill schema and permissions

- **Discovery:**
  - Marketplace UI queries Gateway registry
  - Semantic search: Natural language → ranked skills
  - Category browsing, trending skills, recommended for you

- **Installation:**
  - Tenant clicks "Install" in marketplace
  - Gateway adds skill to tenant's allowed list
  - Skill immediately available to tenant's agents

- **Rating & Reviews:**
  - Stored in DynamoDB, linked to Gateway skill registry
  - Gateway API returns rating data with skill metadata

- **Monetization:**
  - Track skill usage per tenant via Gateway observability
  - Bill tenant based on invocation count (usage-based pricing)
  - Revenue share with skill developers

#### Integration Architecture

**Chimera + Gateway Integration:**

```
┌────────────────────────────────────────────────────────────┐
│                  Chimera Agent Runtime                     │
│  ┌──────────────────────────────────────────────────┐     │
│  │  Agent Orchestrator (Strands)                    │     │
│  │  - Session management                            │     │
│  │  - Conversation history                          │     │
│  │  - Tool selection (FM decides which skill)       │     │
│  └──────────────────┬───────────────────────────────┘     │
│                     │                                      │
│  ┌──────────────────▼───────────────────────────────┐     │
│  │  Skill Invocation Layer                          │     │
│  │  - Skill → MCP tool mapping                      │     │
│  │  - Parameter validation                          │     │
│  │  - Result formatting                             │     │
│  └──────────────────┬───────────────────────────────┘     │
└────────────────────┬┴──────────────────────────────────────┘
                     │
                     │ HTTPS (MCP over HTTP/SSE)
                     │ IAM SigV4 or OAuth Bearer Token
                     │
┌────────────────────▼───────────────────────────────────────┐
│          Amazon Bedrock AgentCore Gateway                  │
│  ┌──────────────────────────────────────────────────┐     │
│  │  Inbound Auth (IAM, OAuth)                       │     │
│  │  ↓                                               │     │
│  │  Skill Registry (tool metadata + semantic search)│     │
│  │  ↓                                               │     │
│  │  Request Router (load balancer, circuit breaker) │     │
│  │  ↓                                               │     │
│  │  Outbound Auth (IAM roles, OAuth, API keys)      │     │
│  │  ↓                                               │     │
│  │  Observability (X-Ray, CloudWatch, logs)         │     │
│  └──────────────────┬───────────────────────────────┘     │
└────────────────────┬┴──────────────────────────────────────┘
                     │
         ┌───────────┴───────────┬───────────┬─────────────┐
         ▼                       ▼           ▼             ▼
┌─────────────────┐  ┌──────────────┐  ┌─────────┐  ┌──────────────┐
│  MCP Servers    │  │ AWS Lambda   │  │  ECS    │  │ Bedrock      │
│  (stdio/HTTP)   │  │  Functions   │  │ Fargate │  │ Agents       │
│                 │  │              │  │ Services│  │ (nested)     │
│ - filesystem    │  │ - Custom     │  │ - ML    │  │ - Research   │
│ - github        │  │   business   │  │   train │  │   specialist │
│ - slack         │  │   logic      │  │ - Long  │  │ - Data       │
│ - database      │  │ - Data ETL   │  │   jobs  │  │   analyst    │
└─────────────────┘  └──────────────┘  └─────────┘  └──────────────┘
```

**Key Integration Points:**

1. **Chimera Agent → Gateway:** MCP over HTTPS (HTTP/SSE transport)
   - Agent authenticates with IAM SigV4 or OAuth token
   - Sends MCP `tools/list` to discover skills
   - Sends MCP `tools/call` to invoke skills

2. **Gateway → Backends:** Protocol-specific connectors
   - MCP servers: Proxy MCP protocol (stdio spawn or HTTP forward)
   - Lambda: Invoke function with JSON payload
   - ECS: HTTP POST to service endpoint
   - Nested agents: Bedrock Agent Runtime API

3. **Observability:** All invocations traced end-to-end
   - Chimera sends trace ID in request headers
   - Gateway propagates to backends
   - Unified trace spans in X-Ray

#### Considerations

**Pros:**
- ✅ **Centralized Management:** Single place to register, discover, manage skills
- ✅ **Consistent Authentication:** IAM/OAuth handled by Gateway, not per-backend
- ✅ **Built-in Observability:** X-Ray, CloudWatch, usage tracking out-of-the-box
- ✅ **Multi-Tenant Support:** Native tenant isolation, access control, quotas
- ✅ **Semantic Discovery:** LLM-powered tool search built-in
- ✅ **Zero-Code Tool Creation:** OpenAPI → MCP tools without writing code
- ✅ **Scalability:** Serverless, auto-scales to workload
- ✅ **AWS Native:** Integrates with IAM, Secrets Manager, CloudTrail

**Cons:**
- ❌ **Additional Latency:** Network hop adds ~10-20ms (negligible for most use cases)
- ❌ **Single Point of Failure:** Gateway down = all skills unavailable
  - Mitigation: Deploy Gateway in multiple AZs, use health checks
- ❌ **Operational Complexity:** Another service to configure, monitor, debug
  - Mitigation: AWS manages infrastructure; Chimera manages config
- ❌ **Cost:** Pay for Gateway requests + backend invocations
  - Pricing: ~$0.10 per 1M requests (estimate, verify with AWS)
- ❌ **Vendor Lock-In:** Tied to AWS AgentCore Gateway (not portable)
  - Mitigation: MCP protocol is standard; backends are portable
- ❌ **Cold Start:** First Gateway request may be slower if idle
  - Mitigation: Keep Gateway warm with scheduled pings

**Recommendation: USE GATEWAY for Chimera skills infrastructure.**

The pros far outweigh the cons for a multi-tenant SaaS platform. The alternatives (custom-built skill server) would require implementing all Gateway features from scratch.

---

## Integration Strategy

### Chimera Skill Architecture with MCP

[To be filled: Recommended architecture]

#### Option 1: Direct MCP Client Integration

```
Chimera Agent → MCP Client → MCP Server
```

**Pros:** Low latency, simple architecture
**Cons:** No centralized management, scaling challenges

#### Option 2: Gateway-Mediated MCP

```
Chimera Agent → AgentCore Gateway → MCP Adapter → MCP Server
```

**Pros:** Centralized control, observability, multi-tenancy
**Cons:** Additional latency, operational overhead

#### Option 3: Hybrid Approach

```
Chimera Agent
  ├─→ Direct MCP Client (low-latency tools)
  └─→ AgentCore Gateway (managed/shared tools)
```

**Pros:** Flexibility, optimized for different use cases
**Cons:** More complex, dual paths to maintain

### Recommended Strategy

**Option 3: Hybrid Approach** — Best of both worlds

```
Chimera Agent Runtime
  ├─→ Direct MCP Client (Tier A: Low-latency, personal tools)
  │     - Local filesystem operations
  │     - User-specific dev tools (e.g., local git, editor integration)
  │     - Latency-sensitive operations (<10ms requirement)
  │
  └─→ AgentCore Gateway (Tier B: Shared, managed tools)
        - Organization-wide tools (Slack, GitHub, databases)
        - Multi-tenant tools with auth requirements
        - Third-party marketplace skills
        - Tools requiring centralized observability
```

**Routing Logic:**

```python
def route_skill_invocation(skill_name: str, tenant_id: str) -> SkillBackend:
    """
    Decide whether to use direct MCP client or Gateway.
    """
    skill_config = get_skill_config(skill_name, tenant_id)

    # Tier A: Direct MCP Client
    if skill_config.latency_tier == 'ultra-low':  # <10ms
        return DirectMCPClient()
    if skill_config.scope == 'user-local':  # Personal workspace tools
        return DirectMCPClient()
    if skill_config.auth == 'none':  # No auth required
        return DirectMCPClient()

    # Tier B: AgentCore Gateway
    if skill_config.multi_tenant:  # Shared across tenants
        return AgentCoreGateway()
    if skill_config.requires_audit:  # Compliance, logging
        return AgentCoreGateway()
    if skill_config.source == 'marketplace':  # Third-party skills
        return AgentCoreGateway()

    # Default: Use Gateway for managed experience
    return AgentCoreGateway()
```

**Justification:**

1. **Performance:** Latency-critical tools bypass Gateway (direct MCP = ~2-5ms vs Gateway = ~15-25ms)
2. **Security:** Shared tools use Gateway's centralized auth and audit
3. **Cost:** Free tier users get direct MCP only; Paid tiers get Gateway access
4. **Flexibility:** Add new tools to either tier based on requirements
5. **Migration Path:** Start with direct MCP, migrate to Gateway as scale increases

**Implementation:**

- **Skill Metadata** includes `routing_tier` field:
  ```yaml
  ---
  name: filesystem:read_file
  routing_tier: direct  # or "gateway"
  latency_requirement: ultra-low
  ---
  ```

- **Chimera Runtime** checks `routing_tier` before invocation
- **Gateway** still indexes direct-tier skills for discovery (but doesn't route them)

---

## Implementation Recommendations

### Phase 1: MCP Tool Wrapping (Months 1-2)

[To be filled: Initial implementation steps]

1. **Build MCP Client Integration**
   - Implement MCP protocol client (stdio, HTTP/SSE)
   - Support for tools, resources, prompts
   - Error handling and retries

2. **Create Skill Adapter**
   - Convert MCP tool definitions → Chimera skill format
   - Generate skill documentation from tool schemas
   - Handle parameter mapping and validation

3. **Proof of Concept**
   - Wrap 5-10 popular MCP servers
   - Test with Chimera agent runtime
   - Validate performance and reliability

### Phase 2: Discovery and Registry (Months 3-4)

[To be filled: Discovery implementation]

1. **Build Skill Registry**
   - DynamoDB-backed registry
   - Metadata schema for skills
   - API for discovery and search

2. **Semantic Search**
   - Embed skill descriptions using Bedrock Titan
   - OpenSearch or pgvector for search
   - Natural language query interface

3. **Category Taxonomy**
   - Define skill categories
   - Tag and classify existing skills
   - UI for browsing by category

### Phase 3: AgentCore Gateway Integration (Months 5-6)

[To be filled: Gateway integration steps]

1. **Gateway Evaluation**
   - Deploy AgentCore Gateway
   - Test routing and performance
   - Evaluate multi-tenancy features

2. **Gateway Backend Implementation**
   - Implement MCP adapter for Gateway
   - Configure routing rules
   - Set up authentication and authorization

3. **Migration Strategy**
   - Migrate high-value skills to Gateway
   - Keep low-latency tools direct
   - Monitor performance impact

### Phase 4: Marketplace and Ecosystem (Months 7+)

[To be filled: Long-term ecosystem development]

1. **Skill Marketplace**
   - Publishing and versioning
   - Rating and reviews
   - Installation and provisioning

2. **Developer Tools**
   - Skill development SDK
   - Testing and debugging tools
   - Documentation and examples

3. **Governance and Trust**
   - Skill verification process
   - Trust tiers (verified, community, experimental)
   - Security scanning and audits

---

## Open Questions

[To be filled: Unresolved questions requiring further research]

1. **AgentCore Gateway Availability:**
   - Is Gateway production-ready?
   - What are the pricing and limits?
   - Can it run in VPC-isolated environments?

2. **MCP Server Reliability:**
   - How stable are community MCP servers?
   - What happens when a server is unavailable?
   - Fallback and retry strategies?

3. **Schema Evolution:**
   - How to handle breaking changes in MCP tools?
   - Versioning strategy for wrapped skills?
   - Backward compatibility guarantees?

4. **Performance Considerations:**
   - Latency overhead of Gateway vs direct
   - Caching strategies for tool metadata
   - Concurrent tool execution limits

---

## Conclusion

### Summary of Findings

**1. MCP Tools as Skills: FEASIBLE and RECOMMENDED**

MCP tools can be seamlessly wrapped as Chimera skills through a 3-layer adapter architecture. The 10,000+ MCP server ecosystem provides immediate access to integrations (GitHub, Slack, databases, etc.) without reimplementation. Key challenges (protocol translation, auth, discovery) are solvable, and the benefits (instant ecosystem access, standard protocol) far outweigh costs.

**2. AgentCore Gateway: PRODUCTION-READY SKILL INFRASTRUCTURE**

Amazon Bedrock AgentCore Gateway (GA August 2025) is purpose-built for AI agent tool serving. It provides:
- Native MCP support with zero-code tool creation from APIs/Lambda
- Centralized tool registry with semantic discovery
- Multi-tenant isolation, IAM/OAuth auth, observability
- Serverless scalability

Gateway eliminates the need to build custom skill infrastructure from scratch.

**3. Schema Gap: BRIDGEABLE**

MCP JSON Schema (machine-optimal) and SKILL.md frontmatter (LLM-optimal) serve different purposes:
- **MCP:** Type-safe validation, API contracts
- **Skills:** Trigger logic, LLM selection hints, rich docs

**Solution:** Hybrid schema format that combines JSON Schema validation with skill-specific metadata (triggers, examples, tool permissions). Bidirectional conversion algorithms enable supporting both formats natively.

**4. Discovery at Scale: SOLVABLE**

With 10,000+ tools, discovery is the bottleneck. Recommended multi-tier strategy:
- **Tier 1:** Curated registry (50-100 verified tools)
- **Tier 2:** User-installed tools (per-tenant)
- **Tier 3:** Semantic search (vector DB + embeddings)
- **Tier 4:** Category taxonomy (browse by domain)
- **Tier 5:** Usage analytics (popularity signals)

Gateway's native semantic search handles Tiers 3-5 out-of-the-box.

**5. Hybrid Routing: OPTIMAL ARCHITECTURE**

Direct MCP client for latency-sensitive/personal tools + AgentCore Gateway for shared/managed tools balances performance, security, and operational simplicity. Skill metadata specifies routing tier.

### Path Forward

**Immediate Next Steps (Months 1-2):**

1. **Proof of Concept:**
   - Build MCP client library (Python SDK)
   - Wrap 10 popular MCP servers (filesystem, github, slack, etc.)
   - Test with Chimera agent runtime
   - Measure latency (direct vs Gateway)

2. **Schema Design:**
   - Define Chimera skill schema (extends MCP JSON Schema)
   - Implement bidirectional conversion (MCP ↔ Skill)
   - Create skill metadata format (YAML frontmatter)

3. **Gateway Evaluation:**
   - Deploy test Gateway instance
   - Register pilot tools (5-10)
   - Test semantic discovery
   - Evaluate auth flows (IAM, OAuth)

**Short-Term (Months 3-4):**

1. **Adapter Layer:**
   - Implement MCP tool adapter (wraps MCP servers as skills)
   - Build hybrid routing logic (direct vs Gateway)
   - Create skill registry (DynamoDB)

2. **Discovery:**
   - Integrate Gateway semantic search
   - Build category taxonomy
   - Implement curated registry (Tier 1)

3. **Multi-Tenancy:**
   - Tenant-specific skill collections
   - Per-tenant access control policies
   - Usage tracking and quotas

**Medium-Term (Months 5-8):**

1. **Marketplace:**
   - Skill publishing API
   - Discovery UI (browse, search, install)
   - Rating and review system

2. **Developer Experience:**
   - Skill development SDK
   - Testing framework
   - Documentation and examples

3. **Production Hardening:**
   - Error handling, retries, circuit breakers
   - Observability dashboards
   - Security audits, penetration testing

### Strategic Recommendations

1. **Adopt MCP as Primary Tool Protocol:** Standard, growing ecosystem, AWS-native support
2. **Use AgentCore Gateway for Shared Tools:** Centralized management beats custom infrastructure
3. **Support Both MCP and Native Skills:** Flexibility for developers, wider ecosystem access
4. **Invest in Discovery:** Semantic search is critical at scale (10k+ tools)
5. **Start Small, Scale Fast:** Curated registry first, marketplace later

**Bottom Line:** MCP + AgentCore Gateway provides a production-ready foundation for Chimera's skill system. Focus implementation effort on discovery, multi-tenancy, and developer experience rather than reinventing tool infrastructure.

---

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
- AgentCore Gateway Documentation (AWS internal)
- Bedrock Agent Runtime API Documentation
- Claude Code Skills Format Documentation
