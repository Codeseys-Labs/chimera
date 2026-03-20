---
title: 'ADR-006: Monorepo over Polyrepo'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-006: Monorepo over Polyrepo

## Status

**Accepted** (2026-03-20)

## Context

AWS Chimera codebase includes:
- **Infrastructure**: 8 CDK stacks (~15K lines of TypeScript)
- **Agent runtime**: Strands agent definitions (~5K lines Python)
- **Chat gateway**: Vercel SDK + SSE bridge (~8K lines TypeScript)
- **CLI**: chimera command-line tool (~3K lines TypeScript)
- **SDKs**: Python + TypeScript SDKs for skill authors (~10K lines)
- **Skills**: 20+ built-in platform skills (~15K lines)
- **Shared types**: Common TypeScript types and utilities

These components:
- **Share types**: e.g., TenantConfig, SessionState used by infra + chat + CLI
- **Have dependencies**: e.g., CLI depends on SDK, Chat depends on shared types
- **Release together**: New features span multiple components (e.g., skill permissions touch infra + SDK + agent)

The decision is whether to use a **monorepo** (one git repo) or **polyrepo** (separate repos per component).

## Decision

Use a **Bun monorepo** with workspace-based dependency management.

All components live in one git repository with this structure:
```
chimera/
├── infra/                  # CDK stacks
├── packages/
│   ├── core/              # Strands agents
│   ├── chat-gateway/      # Vercel SDK + SSE bridge
│   ├── cli/               # chimera CLI
│   ├── sdk-python/        # Python SDK
│   ├── sdk-typescript/    # TypeScript SDK
│   └── shared/            # Shared types
└── skills/                # Built-in skills
```

Bun workspaces handle cross-package dependencies:
```json
{
  "name": "chimera",
  "workspaces": ["infra", "packages/*", "skills"],
  "dependencies": {
    "@chimera/shared": "workspace:*",
    "@chimera/core": "workspace:*"
  }
}
```

## Alternatives Considered

### Alternative 1: Monorepo (Selected)
Single git repository with workspaces.

**Pros:**
- ✅ **Atomic commits**: Change type definition + all consumers in one commit
- ✅ **Simplified CI/CD**: One pipeline builds all components
- ✅ **Type sharing**: Import `@chimera/shared` types across packages
- ✅ **Dependency clarity**: See all inter-package dependencies in one place
- ✅ **Refactoring ease**: IDE refactors across all packages
- ✅ **Versioning simplicity**: One version number for entire platform
- ✅ **Testing**: Run integration tests across packages easily

**Cons:**
- Large repo size (mitigated by git sparse-checkout)
- All engineers see all code (acceptable - not sensitive)

**Verdict:** Selected for atomic commits and type sharing.

### Alternative 2: Polyrepo
Separate git repositories per component.

**Pros:**
- Smaller repo sizes
- Independent versioning per component
- Stricter access control per repo

**Cons:**
- ❌ **Type sync hell**: Shared types duplicated or published to npm registry
- ❌ **Breaking changes**: Type change breaks downstream repos
- ❌ **Version skew**: Chat gateway uses @chimera/shared v1.2, CLI uses v1.3
- ❌ **Complex CI/CD**: Need to coordinate releases across 6+ repos
- ❌ **Refactoring pain**: Change shared type requires PRs in 6 repos
- ❌ **Testing difficulty**: Integration tests span multiple repos

**Verdict:** Rejected - coordination overhead outweighs benefits.

### Alternative 3: Hybrid (Infra separate, packages monorepo)
Infrastructure in one repo, packages in another.

**Pros:**
- Isolates infra changes from code changes
- Infra team owns separate repo

**Cons:**
- ❌ **Type sync**: Infra needs TenantConfig type from packages
- ❌ **Artificial boundary**: Infra and code released together anyway
- ❌ **Two CI/CD pipelines**: More complexity

**Verdict:** Rejected - artificial separation, no real benefit.

## Consequences

### Positive

- **Atomic commits**: Change TenantConfig type + update infra + update CLI in one PR
- **Fast iteration**: No waiting for npm publish to test changes
- **Clear dependencies**: `package.json` shows @chimera/shared usage
- **Consistent tooling**: One .eslintrc, one tsconfig.json, one bun.lockb
- **Simplified onboarding**: Clone one repo, run `bun install`, done
- **Holistic PRs**: PR shows impact across all components

### Negative

- **Large repo**: ~60K lines of code (acceptable for team of 5-10)
- **Build time**: Building all packages takes 2-3 min (mitigated by caching)
- **Git history**: More commits (acceptable with good commit messages)

### Risks

- **Monorepo scaling**: At 500K+ lines, may need split (future problem)
- **Access control**: Cannot restrict access per component (acceptable - internal team)

## Evidence

- **Mulch record mx-d152a0**: "Bun monorepo structure: root package.json with workspaces array, TypeScript project references with composite:true"
- **Mulch record mx-172f2a**: "monorepo-cli-integration: CLI packages must be added to root package.json scripts"
- **Industry practice**: Vercel, Cloudflare, Google, Meta all use monorepos
- **Bun workspaces**: https://bun.sh/docs/install/workspaces

## Related Decisions

- **ADR-005** (AWS CDK): CDK code lives in monorepo `infra/` directory
- **ADR-015** (Bun + Mise): Bun's workspace feature enables monorepo
- **ADR-018** (SKILL.md v2): Skills live in monorepo `skills/` directory

## References

1. Monorepo advantages: https://monorepo.tools/
2. Bun workspaces: https://bun.sh/docs/install/workspaces
3. TypeScript project references: https://www.typescriptlang.org/docs/handbook/project-references.html
4. Google's monorepo: https://research.google/pubs/pub45424/ (for inspiration)
