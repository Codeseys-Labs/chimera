# Claude Code Skills Format — Analysis

> **Research Date:** 2026-03-19
> **Status:** Complete
> **Context:** Claude Code is Anthropic's official CLI for Claude, with an extensible skill system for workflow automation

---

## Table of Contents

- [[#Overview]]
- [[#Skill File Structure]]
- [[#Frontmatter Specification]]
- [[#Skill Body and Instructions]]
- [[#Skill Invocation Model]]
- [[#Lifecycle Integration]]
- [[#Hot-Reloading and Development]]
- [[#Tool Access and Permissions]]
- [[#Comparison with OpenClaw]]
- [[#Portability Challenges]]
- [[#Lessons for Chimera]]

---

## Overview

Claude Code skills are specialized workflow automation instructions that extend the capabilities of the Claude Code IDE agent. Unlike OpenClaw's community-driven marketplace model, Claude Code skills are typically:

- **IDE-integrated**: Tightly coupled with Claude Code's harness lifecycle
- **User-invocable**: Triggered via `/skill-name` command syntax
- **Hook-enabled**: Can intercept tool execution and lifecycle events
- **Plugin-bundled**: Distributed as part of Claude Code plugins

### Key Characteristics

| Aspect | Value |
|--------|-------|
| **Format** | YAML frontmatter + Markdown body |
| **Distribution** | Plugin ecosystem, not centralized marketplace |
| **Invocation** | `/skill-name` shorthand or `Skill` tool |
| **Execution model** | Expanded into agent prompt at invocation time |
| **Lifecycle** | Integrated with Claude Code harness hooks |
| **Security** | Sandboxed within Claude Code's permission model |

---

## Skill File Structure

Claude Code skills follow a similar markdown + frontmatter pattern to OpenClaw, but with IDE-specific metadata.

### Complete Example

```markdown
---
name: code-review
description: Review code for bugs, security issues, and style violations with comprehensive analysis
when: |
  Use when the user asks to:
  - Review code or pull requests
  - Check for bugs or security vulnerabilities
  - Analyze code quality
  - Get improvement suggestions
triggers:
  - review
  - analyze code
  - check for bugs
---

# Code Review Skill

You are performing a comprehensive code review. Follow this systematic approach:

## Phase 1: Understanding
1. Read the file(s) to review
2. Understand the context and purpose
3. Identify the programming language and framework

## Phase 2: Analysis
Examine the code for:

### Security
- SQL injection, XSS, command injection risks
- Hardcoded secrets or credentials
- Unsafe deserialization
- OWASP Top 10 vulnerabilities

### Bugs
- Null/undefined references
- Off-by-one errors
- Race conditions
- Resource leaks
- Error handling gaps

### Style & Maintainability
- Naming conventions
- Function length and complexity
- Code duplication
- Missing documentation

### Performance
- N+1 query patterns
- Unnecessary allocations
- Missing indexes
- Inefficient algorithms

## Phase 3: Reporting
Output findings as a table:

| File | Line | Severity | Category | Issue | Suggestion |
|------|------|----------|----------|-------|------------|

Group by severity: Critical > High > Medium > Low

## Constraints
- Never modify files without explicit user confirmation
- Flag but don't auto-fix security issues (user must verify)
- Limit review to files the user specified
- If reviewing > 10 files, summarize first and ask if user wants detail

## Examples

### Example 1: Single file
User: "Review src/auth.py"
You: Read the file, analyze, output findings table

### Example 2: Pull request
User: "Review my latest PR"
You: Use git diff to see changes, review each changed file
```

### File Location

Skills are typically stored in:
- **User plugins**: `~/.claude/plugins/<plugin-name>/skills/<skill-name>.skill.md`
- **Project plugins**: `.claude/plugins/<plugin-name>/skills/<skill-name>.skill.md`
- **Built-in plugins**: Shipped with Claude Code installation

---

## Frontmatter Specification

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique identifier (slug format, becomes `/skill-name`) |
| `description` | string | One-line summary (shown in skill list) |

### Optional Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `when` | string | Multi-line description of when to use | "Use when the user asks to review code..." |
| `triggers` | array | Keywords that suggest this skill | `["review", "analyze", "check"]` |
| `tags` | array | Categorization tags | `["code-quality", "security"]` |
| `version` | semver | Skill version | `"1.0.0"` |
| `author` | string | Skill author | `"acme-corp"` |

### Claude Code-Specific Extensions

Claude Code skills can include additional metadata for IDE integration:

```yaml
---
name: commit-and-pr
description: Commit changes and create a pull request
when: Use when completing a feature and ready to merge
triggers: [commit, pr, pull request, merge]
requires_confirmation: true    # Prompt user before execution
tools_allowed: [Bash, Read, Write, Edit]
max_iterations: 5              # Limit agent loops
---
```

---

## Skill Body and Instructions

The markdown body contains the actual instructions that guide the agent's behavior when the skill is invoked.

### Best Practices for Skill Bodies

1. **Structured phases**: Break complex workflows into numbered phases
2. **Explicit constraints**: List what the skill should NOT do
3. **Few-shot examples**: Show expected input/output patterns
4. **Tool guidance**: Suggest which tools to use for specific steps
5. **Error handling**: Describe how to recover from failures

### Instruction Style

Claude Code skills use **imperative instructions** rather than declarative descriptions:

```markdown
# Good (Imperative)
## Step 1: Analyze the codebase
Read all TypeScript files in the src/ directory using the Glob tool.
For each file, extract function signatures and count lines of code.

# Less effective (Declarative)
## Step 1: Codebase analysis
The codebase should be analyzed for TypeScript files.
```

### Contextual Awareness

Skills can reference the Claude Code environment:

```markdown
## Prerequisites
Before running this skill:
- Ensure you are in a git repository (check with `git status`)
- Verify tests pass (run `bun test` or `npm test`)
- Check that there are unstaged changes (use git status)
```

---

## Skill Invocation Model

### User-Initiated Invocation

Skills are invoked via the `/` command shorthand:

```
User: /code-review
Agent: [Skill expanded] Performing comprehensive code review...
```

The skill name in frontmatter becomes the command:

```yaml
name: code-review   →   /code-review
name: commit-push-pr   →   /commit-push-pr
```

### Agent-Initiated Invocation

Claude Code agents can invoke skills programmatically using the `Skill` tool:

```python
# Agent reasoning process
User asked to review code →
  Check available skills →
    Find "code-review" skill →
      Invoke via Skill tool →
        Skill content expanded into prompt →
          Agent follows skill instructions
```

### Skill Expansion

When invoked, the skill's body is **expanded** into the agent's context:

```
[Agent System Prompt]
  |
  +-- Base Claude Code instructions
  +-- Active plugin hooks
  +-- [SKILL EXPANDED HERE]
  |    |
  |    +-- Skill body (full markdown content)
  |
[User Message]
```

The agent then processes the user's message with the skill instructions in context.

---

## Lifecycle Integration

Claude Code skills integrate with the harness lifecycle through hooks.

### Hook Integration

Skills can define hooks that intercept tool execution:

```markdown
---
name: safe-delete
description: Confirm before deleting files
hook_type: PreToolUse
applies_to: [Bash]
---

# Safe Delete Confirmation

When the user's command includes `rm` or `del`, ask for confirmation before proceeding:

1. Check if the tool call is Bash
2. Check if the command contains `rm`, `del`, or `rmdir`
3. If yes, ask the user: "You're about to delete files. Confirm? [y/n]"
4. Wait for user response
5. If "n", cancel the tool call
6. If "y", allow the tool call to proceed
```

### Available Hook Points

| Hook | Timing | Use Case |
|------|--------|----------|
| `PreToolUse` | Before tool execution | Validation, confirmation, input modification |
| `PostToolUse` | After tool execution | Result processing, cleanup, logging |
| `Stop` | When agent finishes | Final validation, summary generation |

### Skill Chaining

Skills can invoke other skills:

```markdown
---
name: full-workflow
description: Complete feature development workflow
---

# Full Development Workflow

Execute these skills in sequence:

1. `/brainstorming` — Plan the feature
2. `/tdd` — Write tests first
3. Implement the feature (no skill, direct agent work)
4. `/code-review` — Review the implementation
5. `/commit-push-pr` — Commit and create PR
```

---

## Hot-Reloading and Development

Claude Code supports hot-reloading of skills during development.

### Development Workflow

1. **Create skill file**: `~/.claude/plugins/my-plugin/skills/my-skill.skill.md`
2. **Edit skill**: Modify frontmatter or body
3. **Test skill**: Invoke via `/my-skill`
4. **Iterate**: Changes are picked up on next invocation (no restart required)

### Debugging Skills

Debug output can be added to skill instructions:

```markdown
## Debug Mode
If the user passes `--debug`, output:
- Which files were analyzed
- What patterns were detected
- Why recommendations were generated
```

### Version Control

Skills are version-controlled as part of plugin repositories:

```
.claude/plugins/my-plugin/
  plugin.json
  skills/
    feature-dev.skill.md
    code-review.skill.md
    commit-push-pr.skill.md
  hooks/
    pre-tool-use.ts
  commands/
    custom-command.ts
```

---

## Tool Access and Permissions

Skills operate within Claude Code's permission model.

### Available Tools

Skills can use any tool the agent has access to:

| Tool | Purpose | Skill Usage |
|------|---------|-------------|
| `Read` | Read files | Load source files for analysis |
| `Write` | Create files | Generate reports, configs |
| `Edit` | Modify files | Apply code fixes |
| `Glob` | Find files | Discover files matching patterns |
| `Grep` | Search content | Find specific code patterns |
| `Bash` | Execute commands | Run tests, git operations |
| `Skill` | Invoke skills | Chain skills together |

### Permission Constraints

Unlike OpenClaw, Claude Code skills don't declare permissions in frontmatter. Instead, they inherit the agent's permissions, which are controlled by:

- User-granted permissions in settings
- Permission mode (auto-allow, prompt, deny)
- Tool-specific allowlists/denylists

### Skill Isolation

Skills don't run in separate sandboxes — they execute as part of the agent's context. Security relies on:

- User trust (skills are typically user-installed plugins)
- Tool permission prompts (user approves destructive operations)
- Audit logs (tool execution is logged)

---

## Comparison with OpenClaw

| Aspect | Claude Code Skills | OpenClaw SKILL.md |
|--------|-------------------|-------------------|
| **Distribution** | Plugin ecosystem | ClawHub marketplace (13,700+ skills) |
| **Invocation** | `/skill-name` or `Skill` tool | Auto-loaded into system prompt |
| **Lifecycle** | IDE-integrated hooks | Prompt-based, no hooks |
| **Security model** | User trust + permission prompts | Post-hoc scanning (ClawHavoc exposed gaps) |
| **MCP integration** | Via MCP tool usage | Native via mcporter skill |
| **Versioning** | Plugin-level versioning | Semver with lockfile |
| **Hot-reload** | Yes | Requires restart/reload command |
| **Ecosystem size** | Dozens of built-in skills | 13,700+ community skills |
| **Portability** | IDE-specific | Platform-agnostic markdown |

### Strengths of Claude Code Skills

1. **IDE integration**: Deep integration with Claude Code features (git, testing, debugging)
2. **Workflow automation**: Powerful for multi-step development tasks
3. **Hook system**: Can intercept and modify tool execution
4. **User-invocable**: Explicit `/skill-name` syntax provides clarity

### Strengths of OpenClaw Skills

1. **Ecosystem scale**: 13,700+ skills vs dozens
2. **Platform-agnostic**: Markdown format works anywhere
3. **MCP wrapping**: Skills can expose real tools, not just prompts
4. **Semantic discovery**: Vector search enables natural language queries

---

## Portability Challenges

Claude Code skills face portability challenges when adapting to other platforms:

### IDE-Specific Assumptions

```markdown
# Claude Code-specific
Check git status using the Bash tool

# Platform-agnostic
Check git status (use available git tool or shell command)
```

### Tool Naming Differences

| Claude Code | OpenClaw | Strands | Generic |
|-------------|----------|---------|---------|
| `Read` | `Read` | `read_file` tool | File read |
| `Bash` | `Bash` / `Shell` | `execute_command` | Shell exec |
| `Glob` | N/A (use `find`) | `list_files` | File search |

### Hook Portability

Claude Code hooks (PreToolUse, PostToolUse) are IDE-specific. Other platforms need equivalents:

- **Strands**: `BeforeToolCallEvent`, `AfterToolCallEvent` hooks
- **OpenClaw**: No native hook system (feature request)
- **AgentCore**: Hook plugins via Lambda extensions

---

## Lessons for Chimera

### What Works

1. **User-invocable pattern**: Explicit `/skill-name` provides discoverability
2. **IDE lifecycle integration**: Skills that hook into development workflows are powerful
3. **Hot-reloading**: Instant feedback loop for skill development
4. **Imperative instructions**: Clear, step-by-step guidance works better than declarative

### What Limits Portability

1. **IDE coupling**: Skills assume Claude Code environment (git status, file paths)
2. **No permission declarations**: Skills inherit agent permissions without declaring needs
3. **Tool name assumptions**: Hardcoded tool names (Bash, Read) don't translate
4. **No MCP wrapping**: Skills are pure prompts, not tool implementations

### Chimera's Approach

Chimera's compatibility layer should:

1. **Map tool names**: `Read` → `read_file`, `Bash` → `execute_command`
2. **Extract triggers**: Use `triggers` field for semantic matching
3. **Synthesize permissions**: Infer from skill body (e.g., mentions of file operations)
4. **Hook translation**: Map Claude Code hooks to Strands/AgentCore equivalents
5. **Environment normalization**: Abstract IDE-specific assumptions (git available, etc.)

---

## Summary

Claude Code skills prioritize **IDE integration** over **ecosystem scale**. They are powerful for development workflows but lack the portability and marketplace infrastructure of OpenClaw SKILL.md. Key insights:

- Skills are tightly coupled to Claude Code lifecycle
- No centralized marketplace (distributed as plugin bundles)
- Hot-reloading enables rapid iteration
- Hook system provides interception points
- Portability requires tool name mapping and environment abstraction

Chimera's compatibility layer can consume Claude Code skills by:
- Parsing frontmatter and body (same markdown format)
- Mapping tool names to platform-native equivalents
- Translating hooks to target platform event systems
- Synthesizing permission declarations from skill content

---

*Research document compiled 2026-03-19 by compat-marketplace agent*
*Sources: Claude Code skill specifications, plugin ecosystem analysis, Anthropic documentation*
