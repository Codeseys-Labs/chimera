# Skill Format Compatibility & Marketplace Research

> **Research Date:** 2026-03-19
> **Research Team:** lead-skill-compat, compat-marketplace
> **Status:** Complete
> **Purpose:** Deep research into skill formats across AI agent platforms and design of Chimera's universal compatibility layer

---

## Executive Summary

This research series investigates how different AI agent platforms define, distribute, and execute skills — the extensibility mechanism that allows agents to gain new capabilities beyond their base functionality. We analyze five major skill/tool systems:

1. **OpenClaw SKILL.md** — Community-driven skill marketplace with 13,700+ skills
2. **Claude Code Skills** — IDE-integrated agent skills with lifecycle hooks
3. **MCP (Model Context Protocol) Tools** — Standard protocol for tool interoperability
4. **AgentCore Gateway** — AWS-native tool aggregation and routing service
5. **Strands `@tool` Decorator** — Python/TypeScript function-to-tool transformation

The research reveals fundamental architectural patterns that enable Chimera to provide **universal skill compatibility** through adapter-based design, allowing agents to seamlessly use skills from any ecosystem.

---

## Research Documents

### [01-OpenClaw-SKILL-Format](./01-OpenClaw-SKILL-Format.md)
Deep dive into OpenClaw's SKILL.md format (v1 and v2), covering:
- YAML frontmatter specification
- ClawHub marketplace architecture (13,700+ skills)
- MCP server wrapping patterns
- ClawHavoc security incident analysis (1,184 malicious skills)
- OpenFang's WASM sandbox approach
- NemoClaw's enterprise security enhancements

**Key Finding:** OpenClaw proved that markdown-based skill definitions can scale to enterprise use, but require comprehensive security scanning pipelines.

---

### [02-Claude-Code-Skills-Format](./02-Claude-Code-Skills-Format.md)
Analysis of Claude Code's skill system, covering:
- Skill frontmatter schema (name, description, triggers)
- Lifecycle integration with Claude Code harness
- Skill execution model and tool access patterns
- Hot-reloading and development workflows
- Comparison with OpenClaw SKILL.md

**Key Finding:** Claude Code skills are tightly integrated with the IDE lifecycle, enabling powerful workflow automation but limiting portability.

---

### [03-Compatibility-Layer-Marketplace](./03-Compatibility-Layer-Marketplace.md)
Design of Chimera's universal skill compatibility layer:
- **ChimeraSkill** interface specification
- Adapter architecture for OpenClaw, Claude Code, MCP, Strands
- Skill lifecycle management (install, load, execute, update)
- Security model (7-stage scanning, 5-tier trust)
- Cross-platform skill marketplace design
- Semantic tool discovery via Bedrock Knowledge Bases

**Key Finding:** A thin adapter layer can normalize disparate skill formats into a unified execution model without sacrificing platform-specific features.

---

## Research Questions Answered

| Question | Document | Summary |
|----------|----------|---------|
| **Q1: OpenClaw SKILL.md format** | 01 | YAML + Markdown, 600+ line spec, ClawHub registry |
| **Q2: Claude Code skills format** | 02 | Frontmatter + instructions, IDE lifecycle hooks |
| **Q3: MCP tools as skills** | 03 | MCP servers wrap as skills via Gateway targets |
| **Q4: AgentCore Gateway as registry** | 03 | Gateway aggregates tools, semantic search enabled |
| **Q5: Strands @tool pattern** | 03 | Python decorator extracts metadata from type hints |
| **Q6: Compatibility layer design** | 03 | Adapter-based, unified ChimeraSkill interface |
| **Q7: Marketplace architecture** | 03 | DynamoDB + S3 + Bedrock KB, 7-stage security |

---

## Cross-Cutting Insights

### Security Lessons from ClawHavoc
The OpenClaw ClawHavoc incident (1,184 malicious skills, 12% of registry compromised) provides critical lessons:
- **No code review** at publish time = supply chain disaster
- **Prompt injection via SKILL.md** is a real attack vector
- **Skills need sandboxing** (WASM, Lambda, or container isolation)
- **Cryptographic signing** (Ed25519 dual-signature) establishes provenance
- **Community reporting** enables crowdsourced threat detection

### MCP as the Universal Protocol
Model Context Protocol emerged as the **de facto interoperability standard**:
- 1,000+ published MCP servers (as of March 2026)
- Supported by Claude Desktop, Cursor, Zed, Windsurf, AgentCore
- Enables skill-to-skill composition via MCP client tools
- Standardizes tool discovery (`tools/list`) and invocation (`tools/call`)

### The Marketplace Dilemma
All ecosystems face the same trade-off:
- **Open marketplace** → explosive growth, innovation, but high security risk
- **Curated marketplace** → trusted quality, but limited ecosystem velocity
- **Hybrid model** (5-tier trust) balances both by isolating untrusted skills in sandboxes while verified skills get full agent capabilities

---

## Architectural Patterns Extracted

### Pattern 1: Markdown-Based Skill Definitions
**Used by:** OpenClaw, ClawCore, Claude Code
**Why:** Human-readable, version-controllable, LLM-friendly for agent reasoning
**Trade-off:** Prompt injection risk if skill content injected into system prompts

### Pattern 2: MCP as the Execution Layer
**Used by:** OpenClaw (via mcporter), AgentCore Gateway, Strands (via MCPClient)
**Why:** Protocol standardization enables tool reuse across platforms
**Trade-off:** Requires MCP server wrapping for non-MCP tools

### Pattern 3: Decorator-Based Tool Registration
**Used by:** Strands, Python community tools
**Why:** Minimal boilerplate, automatic schema extraction from type hints
**Trade-off:** Python-specific, requires SDK dependency

### Pattern 4: Registry-as-a-Service
**Used by:** ClawHub, AgentCore Gateway
**Why:** Centralized tool catalog with semantic search, versioning, and security scanning
**Trade-off:** Single point of failure, vendor lock-in risk

---

## Implementation Roadmap for Chimera

### Phase 1: Adapter Layer (Weeks 1-2)
1. Define `ChimeraSkill` interface (TypeScript/Python)
2. Implement adapters:
   - `OpenClawSkillAdapter` (SKILL.md v1/v2 → ChimeraSkill)
   - `ClaudeCodeSkillAdapter` (Claude Code skill → ChimeraSkill)
   - `MCPServerAdapter` (MCP tool → ChimeraSkill)
   - `StrandsToolAdapter` (`@tool` → ChimeraSkill)
3. Build skill loader with hot-reloading

### Phase 2: Security Pipeline (Weeks 3-4)
1. Static analysis (AST scanning for malicious patterns)
2. Dependency audit (OSV vulnerability database)
3. Sandbox execution (OpenSandbox MicroVM)
4. Permission validation (declared vs actual)
5. Cryptographic signing (Ed25519)
6. Runtime monitoring config
7. Community reporting system

### Phase 3: Marketplace (Weeks 5-6)
1. DynamoDB schema (skills, installs, reviews)
2. S3 storage (skill bundles, signatures)
3. Bedrock Knowledge Base (semantic search)
4. API endpoints (publish, install, search, review)
5. CLI tool (`chimera skill install/publish/search`)

### Phase 4: AgentCore Integration (Week 7)
1. Deploy skill adapter as AgentCore Runtime
2. Register skill marketplace Gateway target
3. Enable semantic tool discovery in Gateway
4. Integrate with AgentCore Memory for skill usage tracking

---

## Metrics for Success

| Metric | Target | Rationale |
|--------|--------|-----------|
| **Skill compatibility rate** | 90%+ of OpenClaw skills load | Validates adapter design |
| **Installation time** | < 5 seconds for verified skills | User experience benchmark |
| **Security scan throughput** | 100 skills/hour | Marketplace scalability |
| **False positive rate** | < 5% | Security vs usability balance |
| **Semantic search relevance** | Top-3 recall > 80% | Discovery effectiveness |

---

## Related Research

- [[../openclaw-nemoclaw-openfang/04-Skill-System-Tool-Creation|OpenClaw Skill System Deep Dive]]
- [[../architecture-reviews/ClawCore-Skill-Ecosystem-Design|ClawCore Skill Ecosystem]]
- [[../agentcore-strands/02-AgentCore-APIs-SDKs-MCP|AgentCore MCP Integration]]
- [[../agentcore-strands/04-Strands-Agents-Core|Strands Tool System]]

---

*Research Index compiled 2026-03-19 by compat-marketplace agent*
*Sources: OpenClaw docs, ClawHub analysis, Claude Code specs, AWS AgentCore docs, Strands SDK source*
