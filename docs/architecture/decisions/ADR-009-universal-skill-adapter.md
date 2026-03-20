---
title: 'ADR-009: Universal Skill Adapter Pattern'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-009: Universal Skill Adapter Pattern

## Status

**Accepted** (2026-03-20)

## Context

AWS Chimera skills need to run in multiple environments:
- **OpenClaw**: Skills as markdown (SKILL.md) with Pi runtime
- **Claude Code**: Skills as markdown invoked via /skill command
- **MCP**: Skills as MCP servers (JSON-RPC protocol)
- **Strands**: Skills as Python functions with @tool decorator

A skill author writes one skill definition. The platform must adapt it to run in any environment.

## Decision

Use a **Universal Skill Adapter** that translates SKILL.md v2 format to any target runtime.

**SKILL.md v2** is the canonical format (enhanced from OpenClaw):
```yaml
---
name: git-commit
version: 1.0.0
description: Commit changes to git repository
permissions:
  files: write
  tools: [bash]
---

# Git Commit Skill
When asked to commit changes...
```

The adapter generates:
- **Strands tool**: Python function with @tool decorator
- **MCP server**: JSON-RPC server with tool schema
- **Claude Code hook**: PreToolUse hook with skill logic
- **AgentCore Gateway target**: Lambda function endpoint

## Alternatives Considered

### Alternative 1: Universal Adapter (Selected)
One skill format, adapters for each runtime.

**Pros:**
- ✅ **Write once, run anywhere**: Author writes SKILL.md once
- ✅ **Preserve OpenClaw compatibility**: Existing skills work with minimal changes
- ✅ **Simple for authors**: Markdown + YAML, no code generation needed
- ✅ **Security enforcement**: Permissions declared in YAML, enforced at runtime
- ✅ **Versioning**: Skills versioned independently of platform

**Cons:**
- Need adapter code for each runtime (one-time build)

**Verdict:** Selected for write-once, run-anywhere simplicity.

### Alternative 2: Native per Runtime
Author writes Python for Strands, JSON-RPC for MCP, etc.

**Cons:**
- ❌ **Code duplication**: Same skill written 4 times
- ❌ **Version skew**: Python version differs from MCP version
- ❌ **Author burden**: Need to learn 4 formats

**Verdict:** Rejected - too much duplication.

## Consequences

### Positive

- **OpenClaw compatibility**: Existing OpenClaw skills work with minor updates
- **Simple authoring**: Markdown + YAML, no complex SDKs
- **Runtime flexibility**: Can swap Strands for LangChain without changing skills
- **Security**: Permissions enforced uniformly across runtimes

### Negative

- **Adapter maintenance**: Need to update adapters when runtimes change

## Evidence

- **Research**: [docs/research/openclaw-nemoclaw-openfang/04-Skill-System-Tool-Creation.md](../../research/openclaw-nemoclaw-openfang/04-Skill-System-Tool-Creation.md)
- **Mulch record mx-8132d1**: "@chimera/shared skill types follow SKILL.md v2 spec"

## Related Decisions

- **ADR-018** (SKILL.md v2): Defines canonical skill format

## References

1. MCP protocol: https://modelcontextprotocol.io/
2. OpenClaw SKILL.md: https://docs.openclaw.ai/skills
