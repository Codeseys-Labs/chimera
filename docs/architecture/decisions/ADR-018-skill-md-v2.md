---
title: 'ADR-018: SKILL.md v2 Format Specification'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-018: SKILL.md v2 Format Specification

## Status

**Accepted** (2026-03-20)

## Context

OpenClaw skills use SKILL.md format (YAML frontmatter + markdown body). Chimera needs to enhance this format while maintaining compatibility.

New requirements:
- **Permission declarations**: files:read, network:outbound, tools:[bash]
- **Dependencies**: Skill depends on other skills
- **MCP server flag**: Skill is also MCP server
- **Tests**: Expected behavior for validation

## Decision

Use **SKILL.md v2** format (enhanced from OpenClaw v1):

```yaml
---
name: git-commit
version: 1.0.0
description: Commit changes to git repository
author: platform
tags: [git, version-control]
trust_level: platform
permissions:
  files: write
  network: none
  tools: [bash, read_file]
dependencies:
  skills: [git-status]
mcp_server: false
tests:
  - input: "Commit my changes"
    expect_tools: [bash]
    expect_output_contains: "committed"
---

# Git Commit Skill
When asked to commit changes, use `git add . && git commit -m "message"`.
```

## Alternatives Considered

### Alternative 1: SKILL.md v2 (Selected)
Enhanced format with permissions, dependencies, tests.

**Pros:**
- ✅ **Backward compatible**: OpenClaw skills work with minor updates
- ✅ **Permission declarations**: Security enforced at runtime
- ✅ **Dependencies**: Skill dependencies declared explicitly
- ✅ **Testable**: Tests in frontmatter

**Cons:**
- None significant

**Verdict:** Selected for OpenClaw compatibility + enhancements.

### Alternative 2: JSON/YAML Only
Pure structured format, no markdown.

**Cons:**
- ❌ **Not backward compatible**: OpenClaw skills don't work
- ❌ **Less readable**: Markdown body is human-friendly

**Verdict:** Rejected - breaks OpenClaw compatibility.

## Consequences

### Positive

- **OpenClaw compatibility**: Existing skills work with minor updates
- **Security**: Permissions enforced uniformly
- **Testable**: Tests ensure skill correctness

### Negative

- **Migration**: OpenClaw skills need minor updates (add permissions field)

## Evidence

- **Mulch record mx-8132d1**: "@chimera/shared skill types follow SKILL.md v2 spec"
- **Research**: [docs/research/openclaw-nemoclaw-openfang/04-Skill-System-Tool-Creation.md](../../research/openclaw-nemoclaw-openfang/04-Skill-System-Tool-Creation.md)

## Related Decisions

- **ADR-009** (Universal Skill Adapter): Adapter translates SKILL.md v2 to each runtime

## References

1. OpenClaw SKILL.md: https://docs.openclaw.ai/skills
2. MCP protocol: https://modelcontextprotocol.io/
