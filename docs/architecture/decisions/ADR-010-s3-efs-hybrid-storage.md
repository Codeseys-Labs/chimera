---
title: 'ADR-010: S3 + EFS Hybrid over EFS-Only for Workspaces'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-010: S3 + EFS Hybrid over EFS-Only for Workspaces

## Status

**Accepted** (2026-03-20)

## Context

Agents need workspace storage for:
- **Code files**: Git repositories, source code
- **Artifacts**: Build outputs, generated files
- **Session state**: Active file edits, temporary data

AgentCore MicroVMs are ephemeral (no persistent filesystem). Storage must be external.

## Decision

Use **S3 as primary storage** with optional **EFS for POSIX workspaces**.

- **S3**: All workspace files (99% of use cases)
- **EFS**: Only when POSIX filesystem required (git operations, build tools)

AgentCore MicroVMs do NOT mount EFS. Workspace operations use S3 API or temporary local copy.

## Alternatives Considered

### Alternative 1: S3 + EFS Hybrid (Selected)
S3 primary, EFS for POSIX needs.

**Pros:**
- ✅ **S3 cost-effective**: $0.023/GB vs $0.30/GB for EFS
- ✅ **S3 serverless**: No provisioning, infinite scale
- ✅ **EFS available**: For tools requiring POSIX (git, make)

**Cons:**
- Complexity (two storage systems)

**Verdict:** Selected for cost and flexibility.

### Alternative 2: EFS-Only
All workspace storage on EFS.

**Cons:**
- ❌ **Expensive**: 13x more expensive than S3
- ❌ **AgentCore incompatible**: MicroVMs don't mount EFS
- ❌ **Provisioning**: Need to estimate capacity

**Verdict:** Rejected - AgentCore doesn't support EFS mounts.

## Consequences

### Positive

- **Cost**: 92% cost reduction vs EFS-only
- **AgentCore compatible**: S3 works with ephemeral MicroVMs

### Negative

- **POSIX limitations**: Git operations require EFS or local copy

## Evidence

- **Mulch record mx-e62ffe**: "Hybrid storage: S3 primary + EFS for POSIX workspaces"
- **Mulch record mx-1c2e88**: "AgentCore MicroVMs are ephemeral — no EFS mount support"

## Related Decisions

- **ADR-007** (AgentCore MicroVM): MicroVMs cannot mount EFS

## References

1. AgentCore storage: https://docs.aws.amazon.com/agentcore/latest/userguide/storage.html
