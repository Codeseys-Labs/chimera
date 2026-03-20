---
title: 'ADR-017: Multi-Provider LLM Support'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-017: Multi-Provider LLM Support

## Status

**Accepted** (2026-03-20)

## Context

Customers want choice of LLM providers:
- **Bedrock**: Claude, Llama, Mistral (AWS-hosted)
- **OpenAI**: GPT-4o, o1 (OpenAI API)
- **Anthropic Direct**: Claude via Anthropic API
- **Others**: Gemini, Cohere, etc.

Requirements:
- **Unified API**: Agent code doesn't change per provider
- **Cost optimization**: Route to cheapest provider per task
- **Fallback**: If provider fails, try another
- **Compliance**: Some customers require Bedrock only

## Decision

Use **LiteLLM** as the unified LLM gateway.

LiteLLM provides single API that routes to 17+ providers. Strands agents use `BedrockModel()` by default, but can swap to `LiteLLMModel("openai/gpt-4o")`.

**Example:**
```python
from strands.models.litellm import LiteLLMModel

agent = Agent(
    model=LiteLLMModel(
        model="openai/gpt-4o",
        fallbacks=["anthropic/claude-3-5-sonnet", "bedrock/claude-3-5"]
    )
)
```

## Alternatives Considered

### Alternative 1: LiteLLM (Selected)
Unified gateway for 17+ LLM providers.

**Pros:**
- ✅ **Unified API**: One interface for all providers
- ✅ **17+ providers**: Bedrock, OpenAI, Anthropic, Gemini, etc.
- ✅ **Fallbacks**: Auto-retry with different provider
- ✅ **Cost tracking**: Track cost per provider

**Cons:**
- External dependency (mitigated by open-source)

**Verdict:** Selected for unified API.

### Alternative 2: Direct APIs
Call each provider API directly.

**Cons:**
- ❌ **Code duplication**: Different code per provider
- ❌ **No fallbacks**: Need to build ourselves

**Verdict:** Rejected - too much duplication.

## Consequences

### Positive

- **Provider flexibility**: Easy to add new providers
- **Cost optimization**: Route to cheapest provider

### Negative

- **External dependency**: LiteLLM must stay maintained

## Evidence

- **Research**: [docs/research/agentcore-strands/09-Multi-Provider-LLM-Support.md](../../research/agentcore-strands/09-Multi-Provider-LLM-Support.md)

## Related Decisions

- **ADR-003** (Strands): Strands supports multiple model providers via adapters

## References

1. LiteLLM: https://github.com/BerriAI/litellm
