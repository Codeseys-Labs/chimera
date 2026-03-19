# 09 — Multi-Provider LLM Support via Bedrock & Beyond

> How agent platforms access models from multiple providers — Bedrock's catalog, Strands' provider abstraction, LiteLLM's universal proxy, OpenRouter, Vercel AI SDK, and strategies for routing, cost optimization, and prompt portability.

Related: [[04-Strands-Agents-Core]] | [[01-AgentCore-Architecture-Runtime]] | [[07-Vercel-AI-SDK-Chat-Layer]]

---

## 1. AWS Bedrock Model Catalog

Amazon Bedrock is a fully managed service providing access to foundation models from multiple providers through a single API. As of March 2026, the catalog includes:

### Providers and Model Families

| Provider | Key Models | Model ID Pattern | Notes |
|----------|-----------|-----------------|-------|
| **Anthropic** | Claude Opus 4.6, Opus 4.5, Opus 4, Sonnet 4.6, Sonnet 4.5, Haiku 4.5 | `anthropic.claude-{family}-{version}` | Most capable reasoning models; tool use, vision, extended thinking |
| **Meta** | Llama 4 Maverick 17B, Llama 4 Scout 17B, Llama 3.3 70B, Llama 3.2 (1B-90B) | `meta.llama{version}-{variant}` | Open-weight models; strong for cost-sensitive workloads |
| **Mistral AI** | Mistral 7B, Mistral Large 24.07, Pixtral Large 25.02 | `mistral.mistral-{variant}` | European provider; good multilingual performance |
| **Amazon** | Nova Pro, Nova Lite, Nova Micro, Nova Canvas, Nova 2 Omni, Titan Embeddings | `amazon.nova-{variant}` / `amazon.titan-{variant}` | First-party models; competitive pricing, multimodal |
| **Cohere** | Command R, Command R+, Embed v3/v4 | `cohere.command-{variant}` / `cohere.embed-{variant}` | Strong for RAG and embeddings |
| **AI21 Labs** | Jamba 1.5 Large, Jamba 1.5 Mini | `ai21.jamba-{variant}` | Mamba-based SSM architecture; long context |
| **DeepSeek** | DeepSeek-R1 | `deepseek.r1-v1:0` | Reasoning-focused; available in US regions |
| **Luma AI** | Video generation models | `luma.*` | Media generation |

### Pricing Examples (per 1M tokens, on-demand)

| Model | Input | Output | Cached Input | Notes |
|-------|-------|--------|-------------|-------|
| Claude Opus 4.6 | $5.00 | $25.00 | $0.50 | Via cross-region profile |
| Claude Sonnet 4.6 | $3.00 | $15.00 | $0.30 | Most popular for agents |
| Claude Haiku 4.5 | $1.00 | $5.00 | $0.10 | Fast, cost-effective |
| Claude Opus 4 | $15.00 | $75.00 | $1.50 | Highest capability |
| Meta Llama 4 Maverick 17B | $0.24 | $0.97 | — | Very cost-effective |
| Meta Llama 4 Scout 17B | $0.17 | $0.66 | — | Cheapest Llama 4 |
| Amazon Nova Pro | ~$0.80 | ~$3.20 | — | Good mid-tier option |
| Amazon Nova Micro | ~$0.035 | ~$0.14 | — | Ultra-cheap for simple tasks |

---

## 2. Bedrock Cross-Region Inference Profiles

Cross-region inference profiles allow Bedrock to route requests across multiple AWS regions for higher throughput and availability. This is critical for production agent workloads.

### Profile Types

| Prefix | Scope | Example | Behavior |
|--------|-------|---------|----------|
| `us.` | United States | `us.anthropic.claude-sonnet-4-6-v1:0` | Routes across US regions (us-east-1, us-east-2, us-west-2) |
| `eu.` | Europe | `eu.anthropic.claude-sonnet-4-6-v1:0` | Routes across EU regions (eu-central-1, eu-west-1, eu-west-3) |
| `apac.` | Asia-Pacific | `apac.anthropic.claude-haiku-4-5-20251001-v1:0` | Routes across APAC regions |
| `global.` | Global | `global.anthropic.claude-opus-4-6-v1` | Routes across all commercial regions worldwide |

### How It Works

1. **Request routing**: Bedrock automatically selects the optimal region within the profile's geography
2. **Throughput scaling**: Aggregated quotas across all regions in the profile
3. **Failover**: If one region is saturated, requests route to another
4. **No code changes**: Same API, just change the model ID prefix
5. **Data residency**: Geography-scoped profiles keep data within the specified geography

### Usage

```python
import boto3

bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")

# Single-region (limited throughput)
response = bedrock.converse(
    modelId="anthropic.claude-sonnet-4-5-20250929-v1:0",
    messages=[{"role": "user", "content": [{"text": "Hello"}]}]
)

# Cross-region US (higher throughput, same API)
response = bedrock.converse(
    modelId="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    messages=[{"role": "user", "content": [{"text": "Hello"}]}]
)

# Global (maximum throughput)
response = bedrock.converse(
    modelId="global.anthropic.claude-sonnet-4-6-v1",
    messages=[{"role": "user", "content": [{"text": "Hello"}]}]
)
```

### Application Inference Profiles

Users can also create **application inference profiles** to:
- Track costs per application or team
- Route to specific regions or cross-region profiles
- Apply guardrails and monitoring at the profile level

---

## 3. Strands Agents Model Provider System

The Strands Agents SDK provides a model-agnostic abstraction layer with **17 official model providers** (13 Python + some TypeScript) as of March 2026, plus community contributions.

### Supported Providers

| Provider | Python | TypeScript | Installation |
|----------|--------|-----------|-------------|
| **Amazon Bedrock** | Yes | Yes | Built-in (default) |
| **Amazon Nova** | Yes | — | Built-in |
| **OpenAI** | Yes | Yes | `strands-agents[openai]` |
| **Anthropic** (direct) | Yes | — | `strands-agents[anthropic]` |
| **Google Gemini** | Yes | Yes | `strands-agents[gemini]` |
| **LiteLLM** | Yes | — | `strands-agents[litellm]` |
| **llama.cpp** | Yes | — | `strands-agents[llamacpp]` |
| **LlamaAPI** | Yes | — | `strands-agents[llamaapi]` |
| **MistralAI** | Yes | — | `strands-agents[mistral]` |
| **Ollama** | Yes | — | `strands-agents[ollama]` |
| **SageMaker** | Yes | — | `strands-agents[sagemaker]` |
| **Writer** | Yes | — | `strands-agents[writer]` |
| **Cohere** | Yes | — | `strands-agents[cohere]` |
| **CLOVA Studio** | Yes | — | Community |
| **FireworksAI** | Yes | — | Community |
| **xAI** | Yes | — | Community |
| **Custom Providers** | Yes | Yes | Implement `Model` interface |

### Architecture

Strands' model provider system follows a clean abstraction:

```
Agent
  └── Model (abstract interface)
        ├── BedrockModel (default)
        ├── AnthropicModel
        ├── OpenAIModel
        ├── LiteLLMModel (meta-provider: 100+ models)
        ├── OllamaModel (local)
        ├── SageMakerModel (custom endpoints)
        └── CustomModel (user-defined)
```

The `Model` interface requires:
- `converse()` — send messages and get responses
- Tool use support (tool definitions, tool results)
- Streaming support
- Token counting / usage tracking

### Multi-Model Agent Example

```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.models.openai import OpenAIModel

# Planning agent uses Claude (strong reasoning)
planner = Agent(
    model=BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-6-v1:0",
        max_tokens=4096
    ),
    system_prompt="You are a planning agent. Break down complex tasks."
)

# Execution agent uses a cheaper model
executor = Agent(
    model=BedrockModel(
        model_id="us.meta.llama4-maverick-17b-instruct-v1:0",
        max_tokens=2048
    ),
    system_prompt="You are an execution agent. Follow the plan step by step."
)

# Summarizer uses Nova Micro (ultra-cheap)
summarizer = Agent(
    model=BedrockModel(
        model_id="amazon.nova-micro-v1:0",
        max_tokens=1024
    ),
    system_prompt="Summarize the results concisely."
)
```

### Custom Provider Pattern

For self-hosted models (e.g., on SageMaker with vLLM/SGLang), Strands supports custom providers that translate between the serving framework's OpenAI-compatible format and Bedrock's Messages API format:

```python
from strands.models import Model

class CustomSageMakerModel(Model):
    """Bridges OpenAI-compatible SageMaker endpoints to Strands."""

    def converse(self, messages, tools=None, **kwargs):
        # Translate Bedrock Messages API format to OpenAI format
        # Call SageMaker endpoint
        # Translate response back
        ...
```

---

## 4. LiteLLM — Universal LLM Proxy

LiteLLM is an open-source Python SDK and proxy server providing a unified OpenAI-compatible interface to 100+ LLM providers. It has become the de facto standard for multi-provider LLM access.

### Key Capabilities

- **Unified API**: OpenAI-compatible `/chat/completions`, `/responses`, `/embeddings`, `/images`, `/audio`, `/batches`
- **100+ providers**: OpenAI, Anthropic, AWS Bedrock, Google Vertex, Azure, Mistral, Cohere, Ollama, and many more
- **Router**: Load balancing, fallbacks, retries across deployments
- **Budget management**: Per-key, per-team, per-project spend limits
- **Observability**: Integration with Langfuse, Helicone, Datadog, etc.
- **Self-hosted**: Run as a proxy server for centralized control

### Usage Modes

| Mode | Use Case | Who |
|------|---------|-----|
| **Python SDK** | Direct in-process calls | Individual developers |
| **Proxy Server** | Central LLM gateway | Platform / ML teams |

### Python SDK Example

```python
from litellm import completion

# Call Anthropic
response = completion(
    model="anthropic/claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello"}]
)

# Call OpenAI — same interface
response = completion(
    model="openai/gpt-5",
    messages=[{"role": "user", "content": "Hello"}]
)

# Call Bedrock — same interface
response = completion(
    model="bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0",
    messages=[{"role": "user", "content": "Hello"}]
)

# Call Ollama local model — same interface
response = completion(
    model="ollama/llama3.2",
    messages=[{"role": "user", "content": "Hello"}]
)
```

### Proxy Server Config (YAML)

```yaml
model_list:
  # Primary: Claude via Bedrock
  - model_name: "claude-sonnet"
    litellm_params:
      model: "bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0"
      aws_region_name: "us-east-1"

  # Fallback: Claude via Anthropic direct
  - model_name: "claude-sonnet"
    litellm_params:
      model: "anthropic/claude-sonnet-4-5-20250929"
      api_key: "sk-ant-..."

  # Cheap model for simple tasks
  - model_name: "cheap-model"
    litellm_params:
      model: "bedrock/amazon.nova-micro-v1:0"

router_settings:
  routing_strategy: "latency-based-routing"  # or cost-based, least-busy
  num_retries: 3
  fallbacks:
    - claude-sonnet: ["cheap-model"]

  set_verbose: true
```

### LiteLLM Router Strategies

| Strategy | Description |
|----------|-------------|
| `simple-shuffle` | Random selection across deployments |
| `least-busy` | Route to deployment with fewest active requests |
| `latency-based-routing` | Route to fastest deployment (historical) |
| `cost-based-routing` | Route to cheapest deployment |
| `usage-based-routing` | Distribute by token usage |
| Custom | Implement your own routing logic |

### Strands + LiteLLM Integration

Strands has a first-class LiteLLM provider, giving agents access to any model LiteLLM supports:

```python
from strands import Agent
from strands.models.litellm import LiteLLMModel
from strands_tools import calculator

model = LiteLLMModel(
    model_id="anthropic/claude-sonnet-4-5-20250929",
    client_args={"api_key": "<KEY>"},
    params={"max_tokens": 1000, "temperature": 0.7}
)

agent = Agent(model=model, tools=[calculator])
response = agent("What is the square root of 144?")
```

---

## 5. OpenRouter — Model Aggregator

OpenRouter is a managed SaaS API gateway providing access to 400+ LLMs from multiple providers through a single API endpoint.

### Key Features

- **Single API key**: Access OpenAI, Anthropic, Google, Meta, Mistral, Cohere, and many others
- **Intelligent routing**: Auto-routes to cheapest/fastest available provider
- **OpenAI-compatible**: Drop-in replacement for OpenAI SDK
- **Provider fallbacks**: Automatic failover if a provider is down
- **Model catalog**: Comprehensive registry with pricing, context lengths, capabilities
- **BYOK**: Bring Your Own Key for passthrough to specific providers

### Usage with OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key="sk-or-..."
)

response = client.chat.completions.create(
    model="anthropic/claude-sonnet-4.5",
    messages=[{"role": "user", "content": "Hello"}]
)
```

### OpenRouter vs LiteLLM

| Aspect | OpenRouter | LiteLLM |
|--------|-----------|---------|
| **Deployment** | Managed SaaS | Self-hosted or SDK |
| **Model count** | 400-500+ | 100+ providers |
| **Routing** | Auto-router (NotDiamond) + provider filters | Multiple strategies (weighted, latency, cost, custom) |
| **Privacy** | Metadata-only storage; opt-in logging | Full control (self-hosted) |
| **Cost** | Markup on provider prices | Free (open-source) |
| **Best for** | Quick experimentation, broad access | Production, governance, self-hosted control |

---

## 6. Vercel AI SDK Provider System

The Vercel AI SDK provides a TypeScript-first framework with a pluggable provider system for multi-model applications. Relevant for web-based agent UIs (see [[07-Vercel-AI-SDK-Chat-Layer]]).

### Official Providers (15+)

| Provider | Package | Models |
|----------|---------|--------|
| OpenAI | `@ai-sdk/openai` | GPT-5, GPT-4o, o3, o4-mini |
| Anthropic | `@ai-sdk/anthropic` | Claude 4.x family |
| Google | `@ai-sdk/google` | Gemini 2.5 Pro/Flash |
| Amazon Bedrock | `@ai-sdk/amazon-bedrock` | All Bedrock models |
| Mistral | `@ai-sdk/mistral` | Mistral Large, Pixtral |
| Cohere | `@ai-sdk/cohere` | Command R+ |
| Azure OpenAI | `@ai-sdk/azure` | Azure-hosted OpenAI models |
| Google Vertex AI | `@ai-sdk/google-vertex` | Vertex-hosted models |
| xAI | `@ai-sdk/xai` | Grok models |
| Groq | `@ai-sdk/groq` | Fast inference |
| **OpenRouter** | `@openrouter/ai-sdk-provider` | 300+ models via OpenRouter |

### Multi-Provider Example (TypeScript)

```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { bedrock } from '@ai-sdk/amazon-bedrock';

// Use different models for different tasks
const plan = await generateText({
  model: anthropic('claude-sonnet-4-5-20250929'),
  prompt: 'Create a plan for...'
});

const code = await generateText({
  model: openai('gpt-5'),
  prompt: `Implement this plan: ${plan.text}`
});

// Or use Bedrock for AWS-integrated workloads
const analysis = await generateText({
  model: bedrock('us.anthropic.claude-sonnet-4-6-v1:0'),
  prompt: 'Analyze this code...'
});
```

### Vercel AI Gateway

Vercel also offers an **AI Gateway** — a managed routing layer that sits between your app and providers:
- Unified billing across providers
- Automatic retries and fallbacks
- Compatible with LiteLLM proxy (LiteLLM can route through Vercel AI Gateway)
- Usage tracking and cost monitoring

---

## 7. Model Routing Strategies

Effective multi-provider architectures need intelligent routing. Here are the primary strategies:

### Cost-Based Routing

Route to the cheapest model that meets quality requirements:

```python
# LiteLLM cost-based routing example
from litellm import Router

router = Router(
    model_list=[
        {"model_name": "smart", "litellm_params": {"model": "anthropic/claude-sonnet-4-5"}},
        {"model_name": "smart", "litellm_params": {"model": "openai/gpt-4o"}},
    ],
    routing_strategy="cost-based-routing"
)

response = router.completion(
    model="smart",
    messages=[{"role": "user", "content": "Hello"}]
)
```

### Quality Tiering

Use different quality tiers for different tasks:

| Tier | Models | Use Cases | Approx Cost |
|------|--------|-----------|-------------|
| **Tier 1 — Reasoning** | Claude Opus 4.5/4.6, GPT-5 | Complex planning, code gen, analysis | $5-25/M tokens |
| **Tier 2 — General** | Claude Sonnet 4.5/4.6, GPT-4o | General agent tasks, tool use | $3-15/M tokens |
| **Tier 3 — Fast** | Claude Haiku 4.5, GPT-4o-mini | Classification, extraction, routing | $0.10-5/M tokens |
| **Tier 4 — Cheap** | Nova Micro, Llama 4 Scout | Simple tasks, summaries, formatting | $0.03-0.66/M tokens |

### Fallback Chains

If the primary model fails (rate limit, outage), fall back to alternatives:

```yaml
# LiteLLM fallback config
router_settings:
  fallbacks:
    - claude-sonnet: ["gpt-4o", "gemini-pro"]
    - gpt-4o: ["claude-sonnet", "mistral-large"]

  # Retry on specific errors
  retry_on_status_codes: [429, 503, 529]
  num_retries: 3
  retry_after: 1  # seconds
```

### Latency-Based Routing

Route to the fastest responding deployment — useful for real-time chat:

```python
router = Router(
    model_list=[...],
    routing_strategy="latency-based-routing",
    routing_strategy_args={
        "ttl": 60,  # Cache latency measurements for 60s
        "lowest_latency_buffer": 0.1  # 10% buffer
    }
)
```

---

## 8. Cost Optimization Across Providers

### Strategies

1. **Prompt caching**: Anthropic and Bedrock support prompt caching (75-90% cost reduction on cached tokens). Reuse system prompts and long contexts.
2. **Tiered models**: Use expensive models only for complex reasoning; route simple tasks to cheap models.
3. **Batch inference**: Bedrock batch inference offers ~50% discount for non-real-time workloads.
4. **Cross-region profiles**: Use `global.*` profiles to avoid throttling (which wastes retries and adds latency).
5. **Open-weight models**: Llama 4 Maverick at $0.24/M input is 12x cheaper than Claude Sonnet at $3.00/M.
6. **Self-hosted**: Run Llama/Mistral on SageMaker or EC2 for predictable costs at scale.

### Cost Comparison Matrix

| Task Type | Best Model | Input Cost | Output Cost | Rationale |
|-----------|-----------|-----------|------------|-----------|
| Complex reasoning | Claude Opus 4.5 | $5.00/M | $25.00/M | Best quality |
| General agent tasks | Claude Sonnet 4.6 | $3.00/M | $15.00/M | Quality/cost balance |
| Simple extraction | Llama 4 Maverick | $0.24/M | $0.97/M | 90% cheaper than Sonnet |
| Routing/classification | Nova Micro | $0.035/M | $0.14/M | Near-zero cost |
| Embeddings | Cohere Embed v4 | $0.12/M | Free | Best embedding quality |

---

## 9. Prompt Portability Across Models

### The Challenge

Different models have different:
- System prompt formats and best practices
- Tool calling schemas (Bedrock Converse vs OpenAI function calling)
- Context window sizes (8K to 2M tokens)
- Strengths (reasoning, code, multilingual, speed)
- Output formatting tendencies

### Portability Strategies

1. **Use abstraction layers**: Strands, LiteLLM, and Vercel AI SDK all normalize tool calling and message formats across providers.

2. **Bedrock Converse API**: AWS Bedrock's Converse API provides a unified interface across all Bedrock models — same tool definitions, same message format, regardless of underlying provider.

3. **Test across models**: Maintain a prompt evaluation suite that tests critical prompts against multiple models.

4. **Avoid model-specific tricks**: XML tags (Claude), markdown headers (GPT), etc. reduce portability. Use clear natural language instructions.

5. **Model-specific prompt adapters**: When optimization matters, maintain per-model prompt variants:

```python
SYSTEM_PROMPTS = {
    "anthropic": "You are a helpful assistant. Use <thinking> tags for reasoning.",
    "openai": "You are a helpful assistant. Think step by step.",
    "meta": "You are a helpful assistant. Be concise and direct.",
}

def get_prompt(provider: str) -> str:
    return SYSTEM_PROMPTS.get(provider, SYSTEM_PROMPTS["openai"])
```

---

## 10. Multi-Provider in a Single Agent

The most powerful pattern: use different models for different subtasks within a single agent workflow.

### Architecture Pattern

```
User Request
    │
    ▼
┌─────────────────┐
│  Router Model    │  ← Nova Micro ($0.035/M) classifies the request
│  (classification)│
└────────┬────────┘
         │
    ┌────┴────┬──────────┐
    ▼         ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│ Simple │ │General │ │Complex │
│  Task  │ │  Task  │ │  Task  │
│ Llama 4│ │Sonnet  │ │ Opus   │
│ Scout  │ │  4.6   │ │  4.5   │
│$0.17/M │ │ $3/M   │ │  $5/M  │
└────────┘ └────────┘ └────────┘
```

### Strands Multi-Agent with Different Models

```python
from strands import Agent
from strands.models.bedrock import BedrockModel

# Router: cheapest model classifies intent
router_agent = Agent(
    model=BedrockModel(model_id="amazon.nova-micro-v1:0"),
    system_prompt="""Classify the user request as:
    - SIMPLE: factual questions, formatting, basic math
    - GENERAL: analysis, writing, code review
    - COMPLEX: multi-step reasoning, architecture, research
    Reply with only the classification word."""
)

# Task-specific agents
agents = {
    "SIMPLE": Agent(
        model=BedrockModel(model_id="us.meta.llama4-scout-17b-instruct-v1:0"),
        system_prompt="Answer directly and concisely."
    ),
    "GENERAL": Agent(
        model=BedrockModel(model_id="us.anthropic.claude-sonnet-4-6-v1:0"),
        system_prompt="Provide thorough analysis with tool use."
    ),
    "COMPLEX": Agent(
        model=BedrockModel(model_id="global.anthropic.claude-opus-4-5-20251101-v1:0"),
        system_prompt="Think deeply. Use extended thinking for complex problems."
    ),
}

def route_request(user_input: str):
    classification = str(router_agent(user_input)).strip()
    agent = agents.get(classification, agents["GENERAL"])
    return agent(user_input)
```

### LiteLLM Config for Multi-Tier Routing

```yaml
model_list:
  # Tier 1: Complex reasoning
  - model_name: "reasoning"
    litellm_params:
      model: "bedrock/global.anthropic.claude-opus-4-5-20251101-v1:0"

  # Tier 2: General tasks (with fallback)
  - model_name: "general"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6-v1:0"
  - model_name: "general"
    litellm_params:
      model: "anthropic/claude-sonnet-4-6"  # Direct API fallback

  # Tier 3: Fast/cheap tasks
  - model_name: "fast"
    litellm_params:
      model: "bedrock/amazon.nova-micro-v1:0"
  - model_name: "fast"
    litellm_params:
      model: "bedrock/us.meta.llama4-scout-17b-instruct-v1:0"

router_settings:
  routing_strategy: "latency-based-routing"
  fallbacks:
    - reasoning: ["general"]
    - general: ["fast"]
```

---

## 11. Comparison of Multi-Provider Approaches

| Approach | Providers | Deployment | Best For | Limitations |
|----------|----------|-----------|---------|-------------|
| **Bedrock (direct)** | ~8 via AWS | AWS-managed | AWS-native apps, compliance | AWS-only, fewer raw providers |
| **Strands Agents** | 17 built-in | SDK (Python/TS) | Agent frameworks on AWS | Agent-specific, not a gateway |
| **LiteLLM** | 100+ | Self-hosted / SDK | Production gateways, governance | Requires infrastructure |
| **OpenRouter** | 400+ | Managed SaaS | Experimentation, broad access | No self-hosting, markup pricing |
| **Vercel AI SDK** | 15+ | SDK (TypeScript) | Web app frontends | TypeScript-only, frontend-focused |
| **Bedrock + LiteLLM** | 100+ (via LiteLLM) | Hybrid | Best of both — AWS + everything else | More complex setup |
| **Strands + LiteLLM** | 100+ (via LiteLLM) | SDK | Agent with any model | Python-only for LiteLLM provider |

---

## 12. Recommendations for Agent Platforms

### For AWS-Native Agent Platforms

1. **Default to Bedrock** with cross-region inference profiles for throughput
2. Use **Strands Agents** as the agent framework — native Bedrock integration, 17 providers
3. Add **LiteLLM as a Strands provider** when you need models outside Bedrock
4. Use **tiered routing** — classify requests and route to appropriate cost/quality tier

### For Multi-Cloud or Provider-Agnostic

1. Deploy **LiteLLM Proxy** as a central gateway
2. Use **Strands Agents** with the LiteLLM provider for model-agnostic agents
3. Implement **fallback chains** across providers for resilience
4. Track costs per-team/per-project through LiteLLM's budget system

### For Web Applications

1. Use **Vercel AI SDK** for the frontend chat layer
2. Add the **OpenRouter provider** for broad model access
3. Or use **@ai-sdk/amazon-bedrock** for AWS-integrated backends
4. Implement **streaming** for responsive UIs across all providers

---

## Sources

- [AWS Bedrock Supported Models](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html)
- [AWS Bedrock Cross-Region Inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
- [Strands Agents Model Providers](https://strandsagents.com/docs/user-guide/concepts/model-providers/)
- [Strands + LiteLLM Integration](https://strandsagents.com/latest/documentation/docs/user-guide/concepts/model-providers/litellm/)
- [LiteLLM Documentation](https://docs.litellm.ai/)
- [OpenRouter](https://openrouter.ai/)
- [Vercel AI SDK Providers](https://vercel.com/docs/ai)
- [Portkey Bedrock Model Directory](https://portkey.ai/models/bedrock)
- [Building Custom Strands Model Providers (AWS Blog)](https://aws.amazon.com/blogs/machine-learning/building-custom-model-provider-for-strands-agents-with-llms-hosted-on-sagemaker-ai-endpoints/)
