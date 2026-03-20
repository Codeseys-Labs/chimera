---
title: 'ADR-015: Bun + Mise for Development Toolchain'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-015: Bun + Mise for Development Toolchain

## Status

**Accepted** (2026-03-20)

## Context

TypeScript monorepo requires:
- **Package manager**: Install dependencies
- **Runtime**: Execute TypeScript
- **Task runner**: Run build, test, lint
- **Version manager**: Consistent tool versions across team

Developer experience requirements:
- **Fast**: Hot reload, fast tests
- **Simple**: One command to get started
- **Consistent**: Same versions on all machines

## Decision

Use **Bun** for package manager + runtime + task runner, **Mise** for version management.

- **Bun**: Install deps, run TypeScript, execute tasks
- **Mise**: Pin versions in `.mise.toml`

```toml
# .mise.toml
[tools]
bun = "1.0.26"
node = "20.11.0"
python = "3.12.0"
```

## Alternatives Considered

### Alternative 1: Bun + Mise (Selected)
All-in-one JavaScript toolchain + version manager.

**Pros:**
- ✅ **Fast**: 10-20x faster than npm/yarn
- ✅ **Batteries included**: Package manager + runtime + test runner
- ✅ **TypeScript native**: No transpilation needed
- ✅ **Hot reload**: Built-in watch mode

**Cons:**
- Newer tool (less mature than npm)

**Verdict:** Selected for speed and simplicity.

### Alternative 2: npm + nvm
Traditional Node.js ecosystem tools.

**Cons:**
- ❌ **Slow**: npm install takes 2-3 min vs 10 sec for Bun
- ❌ **No native TypeScript**: Need ts-node or build step
- ❌ **Separate tools**: npm + nvm + jest + eslint

**Verdict:** Rejected - too slow.

## Consequences

### Positive

- **Fast iteration**: Hot reload, fast tests
- **Simple setup**: `mise install && bun install` and done

### Negative

- **Less mature**: Bun occasional bugs

## Evidence

- **Mulch record mx-f3fc6c**: "Tech stack: bun for all TypeScript tooling and runtime, mise for tool versioning"

## Related Decisions

- **ADR-006** (Monorepo): Bun workspaces enable monorepo

## References

1. Bun: https://bun.sh/
2. Mise: https://mise.jdx.dev/
