---
title: 'ADR-003: Strands over LangChain/CrewAI for Agent Framework'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-003: Strands over LangChain/CrewAI for Agent Framework

## Status

**Accepted** (2026-03-20)

## Context

AWS Chimera agents need a Python framework for:
- **LLM orchestration**: Call Bedrock, OpenAI, Anthropic with unified API
- **Tool execution**: Agents use tools (read_file, bash, etc.) to accomplish tasks
- **Memory management**: Short-term (conversation) + long-term (facts across sessions)
- **Multi-agent patterns**: Swarm (parallel), Graph (sequential), Workflow (orchestrated)
- **Streaming**: Real-time token streaming for chat UI responsiveness
- **Provider flexibility**: Swap LLM providers without changing agent code

The framework must:
- Work with **AgentCore Runtime** (MicroVM environment, no filesystem persistence)
- Support **AgentCore Memory** service for STM+LTM persistence
- Be **lightweight** (small MicroVM footprint)
- Be **AWS-aware** (Bedrock native, not OpenAI-first)

The decision is which agent framework to use.

## Decision

Use **AWS Strands** as the agent framework.

Strands is AWS's official agent framework (available via `pip install strands`), designed specifically for AgentCore Runtime. It provides a minimalist API similar to OpenClaw's simplicity but with enterprise-grade features.

**Example Strands agent:**
```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from bedrock_agentcore.memory import MemorySessionManager

agent = Agent(
    model=BedrockModel("anthropic.claude-3-5-sonnet-20241022-v2:0"),
    system_prompt="You are a helpful assistant",
    tools=[read_file, write_file, edit_file, bash],
    session_manager=MemorySessionManager(
        namespace="tenant-acme",
        strategies=["SUMMARY", "SEMANTIC_MEMORY"]
    ),
)

response = agent("What files are in the current directory?")
```

## Alternatives Considered

### Alternative 1: AWS Strands (Selected)
AWS-developed agent framework for AgentCore.

**Pros:**
- ✅ **AWS-native**: First-class Bedrock integration, no OpenAI dependency
- ✅ **AgentCore Memory integration**: Built-in MemorySessionManager for STM+LTM
- ✅ **Lightweight**: 20MB package size vs 200MB for LangChain
- ✅ **MicroVM-optimized**: Designed for ephemeral runtime (no filesystem assumptions)
- ✅ **Simple API**: Similar to OpenClaw's minimalism (4 core tools)
- ✅ **Multi-agent patterns**: Swarm, Graph, Workflow primitives built-in
- ✅ **Streaming-first**: Native SSE streaming for real-time responses
- ✅ **AWS support**: Backed by AWS with SLA and support

**Cons:**
- Smaller community vs LangChain (mitigated by AWS support)
- Fewer third-party integrations (we build our own skills anyway)

**Verdict:** Selected for AWS-native design and AgentCore integration.

### Alternative 2: LangChain
Popular open-source agent framework with large community.

**Pros:**
- Large community with many examples
- 1000+ integrations with third-party tools
- Mature ecosystem

**Cons:**
- ❌ **OpenAI-first design**: Bedrock is second-class citizen
- ❌ **Heavyweight**: 200MB package, 50+ dependencies
- ❌ **Filesystem assumptions**: Assumes persistent disk (not MicroVM-friendly)
- ❌ **No AgentCore Memory integration**: Need custom adapter
- ❌ **Complex API**: Too many abstractions (Chains, Agents, Tools, Runnables)
- ❌ **Frequent breaking changes**: v0.1 → v0.2 broke many apps

**Verdict:** Rejected due to weight and OpenAI-first design.

### Alternative 3: CrewAI
Multi-agent framework with role-based collaboration.

**Pros:**
- Great for multi-agent orchestration
- Role-based agent design (Manager, Worker, etc.)
- Built on LangChain (inherits integrations)

**Cons:**
- ❌ **Built on LangChain**: Inherits all LangChain cons (weight, OpenAI-first)
- ❌ **Opinionated**: Forces specific multi-agent patterns (roles, hierarchies)
- ❌ **No Bedrock native support**
- ❌ **Overkill for simple agents**: Most Chimera agents are single-agent

**Verdict:** Rejected - too opinionated, not AWS-native.

### Alternative 4: Custom Agent Framework
Build our own agent loop in Python.

**Pros:**
- Full control over implementation
- No external dependencies
- Lightweight

**Cons:**
- ❌ **Reinventing the wheel**: Agent loop, tool calling, streaming already solved
- ❌ **Maintenance burden**: Need to keep up with new LLM APIs (JSON mode, structured output)
- ❌ **No multi-agent patterns**: Need to build Swarm/Graph/Workflow ourselves
- ❌ **No memory strategies**: Need to build STM+LTM ourselves
- ❌ **Time to market**: 4-6 weeks to build what Strands provides

**Verdict:** Rejected - not worth reinventing agent framework.

### Alternative 5: AutoGen (Microsoft)
Multi-agent framework from Microsoft Research.

**Pros:**
- Research-backed (Microsoft Research)
- Good for complex multi-agent conversations

**Cons:**
- ❌ **Not production-ready**: Research project, not enterprise-supported
- ❌ **Heavy dependencies**: Requires OpenAI SDK even for other providers
- ❌ **No AWS integration**: Azure-first design

**Verdict:** Rejected - research project, not production-ready.

## Consequences

### Positive

- **Fast onboarding**: Strands API is simple (similar to OpenClaw), engineers productive in hours
- **Lightweight MicroVMs**: 20MB package keeps MicroVM cold start < 1s
- **Bedrock-native**: No adapter code needed for Bedrock API
- **Memory integration**: MemorySessionManager handles STM+LTM automatically
- **Multi-agent primitives**: Swarm/Graph/Workflow patterns built-in, no custom orchestration
- **Streaming**: Native SSE streaming for real-time chat UI updates
- **AWS support**: Enterprise SLA and support channel

### Negative

- **Vendor lock-in**: Strands is AWS-specific (mitigated by clean abstractions)
- **Smaller community**: Fewer Stack Overflow answers vs LangChain (AWS docs compensate)
- **Fewer integrations**: Need to build MCP adapters ourselves (already planned)

### Risks

- **Strands deprecation**: If AWS deprecates Strands (unlikely - core to AgentCore)
- **API breaking changes**: Future Strands versions may break compatibility (mitigated by pinning versions)

## Evidence

- **Research**: [docs/research/agentcore-strands/04-Strands-Agents-Core.md](../../research/agentcore-strands/04-Strands-Agents-Core.md) - 1351 lines on Strands capabilities
- **Research**: [docs/research/agentcore-strands/05-Strands-Advanced-Memory-MultiAgent.md](../../research/agentcore-strands/05-Strands-Advanced-Memory-MultiAgent.md) - Multi-agent patterns
- **Mulch record mx-23cc8f**: "8-stack CDK architecture includes AgentCore Runtime with Strands"
- **Definitive Architecture**: [docs/research/architecture-reviews/Chimera-Definitive-Architecture.md](../../research/architecture-reviews/Chimera-Definitive-Architecture.md) lines 98-132

## Related Decisions

- **ADR-007** (AgentCore MicroVM): Strands designed for MicroVM environment
- **ADR-009** (Skill adapters): Strands tools are skills (read_file, bash, etc.)
- **ADR-016** (AgentCore Memory): MemorySessionManager integrates with AgentCore Memory service
- **ADR-017** (Multi-provider LLM): Strands supports 17 LLM providers via adapters

## References

1. Strands documentation: https://docs.aws.amazon.com/agentcore/latest/userguide/strands.html
2. Strands GitHub: https://github.com/aws/strands (if open-sourced)
3. AgentCore Runtime: https://docs.aws.amazon.com/agentcore/latest/userguide/runtime.html
4. LangChain comparison: https://www.langchain.com/ (for contrast)
