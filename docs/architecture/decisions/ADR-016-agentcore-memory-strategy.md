---
title: 'ADR-016: AgentCore Memory (STM+LTM) Strategy'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-016: AgentCore Memory (STM+LTM) Strategy

## Status

**Accepted** (2026-03-20)

## Context

Agents need memory:
- **Short-term (STM)**: Current conversation, recent messages
- **Long-term (LTM)**: User preferences, facts across sessions

AgentCore Memory service provides:
- **3 strategies**: SUMMARY (compress old messages), SEMANTIC_MEMORY (extract facts), USER_PREFERENCE (track preferences)
- **Namespace isolation**: Per-tenant memory namespaces
- **S3 persistence**: Memory stored in S3, indexed in DynamoDB

## Decision

Use **AgentCore Memory** with all 3 strategies:
- **SUMMARY**: Compress conversation > 10 messages
- **SEMANTIC_MEMORY**: Extract facts (user works at Acme, prefers Python)
- **USER_PREFERENCE**: Track preferences (notification settings, language)

**Example:**
```python
from bedrock_agentcore.memory import MemorySessionManager

memory = MemorySessionManager(
    namespace=f"tenant-{tenant_id}",
    strategies=["SUMMARY", "SEMANTIC_MEMORY", "USER_PREFERENCE"]
)
```

## Alternatives Considered

### Alternative 1: AgentCore Memory (Selected)
AWS-managed memory service with STM+LTM.

**Pros:**
- ✅ **Managed**: No infrastructure to manage
- ✅ **Multi-strategy**: SUMMARY + SEMANTIC + PREFERENCE
- ✅ **S3-backed**: Durable, cost-effective
- ✅ **Namespace isolation**: Per-tenant isolation

**Cons:**
- AWS-specific (acceptable)

**Verdict:** Selected for managed service.

### Alternative 2: Custom Memory
Build memory system on DynamoDB.

**Cons:**
- ❌ **Build time**: 4-6 weeks to build
- ❌ **Maintenance**: Need to maintain ourselves

**Verdict:** Rejected - reinventing the wheel.

## Consequences

### Positive

- **Managed service**: No memory infrastructure to build
- **Multi-strategy**: Compression, facts, preferences all handled

### Negative

- **AWS lock-in**: AgentCore Memory is AWS-only

## Evidence

- **Mulch record mx-c877d0**: "AgentCore Memory namespace template: 'tenant-{tenant_id}-user-{user_id}'"
- **Research**: [docs/research/agentcore-strands/05-Strands-Advanced-Memory-MultiAgent.md](../../research/agentcore-strands/05-Strands-Advanced-Memory-MultiAgent.md)

## Related Decisions

- **ADR-003** (Strands): MemorySessionManager integrates with Strands agents
- **ADR-007** (AgentCore MicroVM): Memory persisted to S3, not MicroVM filesystem

## References

1. AgentCore Memory: https://docs.aws.amazon.com/agentcore/latest/userguide/memory.html
