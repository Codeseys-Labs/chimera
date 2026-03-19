---
tags:
  - clawcore
  - llm
  - multi-provider
  - strands
  - litellm
  - bedrock
date: 2026-03-19
topic: Multi-Provider LLM Implementation Guide
status: complete
---

# 05 — Multi-Provider LLM Implementation Guide

> Detailed implementation patterns for integrating multiple LLM providers into the
> ClawCore platform using Strands Agents, LiteLLM, and direct provider SDKs.
> Covers Bedrock (primary), Anthropic direct, OpenAI/Azure OpenAI, Ollama,
> model routing algorithms, per-tenant configuration, fallback chains,
> cost tracking, and provider health monitoring.

Related: [[ClawCore-Final-Architecture-Plan]] | [[ClawCore-Self-Evolution-Engine]] | [[../AWS Bedrock AgentCore and Strands Agents/09-Multi-Provider-LLM-Support]] | [[../AWS Bedrock AgentCore and Strands Agents/04-Strands-Agents-Core]]

---

## 1. Architecture Overview

ClawCore uses a layered approach to multi-provider LLM support:

```
                          +--------------------------+
                          |    Per-Tenant Config     |
                          |    (DynamoDB)            |
                          +------------+-------------+
                                       |
                          +------------v-------------+
                          |    Model Router          |
                          |    (Bayesian MAB +       |
                          |     Task Classifier)     |
                          +----+-------+-------+-----+
                               |       |       |
                  +------------+  +----+----+  +------------+
                  |               |         |               |
          +-------v------+ +-----v----+ +--v-----------+ +-v-----------+
          | BedrockModel | | Anthropic| | OpenAIModel  | | OllamaModel|
          | (Primary)    | | Model    | | / Azure      | | (Local/Edge)|
          | Cross-region | | (Direct) | | via LiteLLM  | |             |
          +--------------+ +----------+ +--------------+ +-------------+
                  |               |       |                     |
          +-------v------+ +-----v----+ +--v-----------+ +-----v------+
          | Bedrock API  | |Anthropic | | OpenAI API / | | Ollama     |
          | (Converse)   | |Messages  | | Azure API    | | REST API   |
          +--------------+ +----------+ +--------------+ +------------+
```

### Design Principles

1. **Bedrock as default** -- cross-region inference profiles for throughput, prompt caching for cost
2. **Strands provider abstraction** -- all providers implement the same `Model` interface
3. **LiteLLM as escape hatch** -- access 100+ providers through the Strands LiteLLM provider when Bedrock is insufficient
4. **Per-tenant model configuration** -- tenants can override default models, set cost sensitivity, and pin specific providers
5. **Bayesian routing** -- Thompson Sampling learns optimal model-per-task-category over time
6. **Graceful degradation** -- fallback chains with circuit breaking ensure availability

---

## 2. Strands Agents Model Provider System

### The Model Abstract Base Class

Every Strands model provider implements the `Model` ABC defined in `strands.models.model`:

```python
from abc import ABC, abstractmethod
from typing import Any, AsyncIterable, AsyncGenerator

class Model(ABC):
    """Abstract base class for all model providers."""

    @abstractmethod
    def update_config(self, **model_config: Any) -> None:
        """Update the model's configuration."""

    @abstractmethod
    def get_config(self) -> Any:
        """Return current model configuration."""

    @abstractmethod
    def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        *,
        tool_choice: ToolChoice | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        invocation_state: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> AsyncIterable[StreamEvent]:
        """Stream conversation with the model."""

    def structured_output(
        self,
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[dict[str, T | Any], None]:
        """Generate structured output conforming to a Pydantic schema."""
```

### StreamEvent Types

Custom model providers must emit these event types in their `stream()` method:

| Event Type | Purpose | Key Fields |
|------------|---------|------------|
| `messageStart` | Beginning of model response | `role` |
| `contentBlockStart` | Start of text or tool-use block | `contentBlockIndex`, `start` |
| `contentBlockDelta` | Incremental content | `contentBlockIndex`, `delta` (text or toolUse) |
| `contentBlockStop` | End of content block | `contentBlockIndex` |
| `messageStop` | End of response | `stopReason` (end_turn, tool_use, max_tokens) |
| `metadata` | Usage metrics | `usage` (inputTokens, outputTokens), `metrics` (latencyMs) |
| `redaction` | Guardrail redaction | Redacted content details |

### Provider Installation

```bash
# Install specific providers
pip install 'strands-agents[bedrock]'     # Amazon Bedrock (default)
pip install 'strands-agents[anthropic]'   # Anthropic direct API
pip install 'strands-agents[openai]'      # OpenAI
pip install 'strands-agents[ollama]'      # Ollama local models
pip install 'strands-agents[litellm]'     # LiteLLM (100+ providers)
pip install 'strands-agents[all]'         # Everything
```

---

## 3. Bedrock as Primary Provider

Bedrock is ClawCore's default provider because it offers managed access to multiple model families through a single API, with built-in features critical for production multi-tenant platforms.

### BedrockModel Configuration

```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from botocore.config import Config as BotocoreConfig

model = BedrockModel(
    # Model ID -- use cross-region prefix for production
    model_id="us.anthropic.claude-sonnet-4-6-v1:0",

    # AWS configuration
    region_name="us-east-1",
    boto_client_config=BotocoreConfig(
        retries={"max_attempts": 3, "mode": "adaptive"},
        connect_timeout=5,
        read_timeout=120,
    ),

    # Generation parameters
    max_tokens=4096,
    temperature=0.3,
    top_p=0.9,
    stop_sequences=["</result>"],
    streaming=True,  # Default; False for batch

    # Prompt caching (75-90% savings on cached input tokens)
    cache_config={
        "cachePoint": {"type": "default"}  # Cache system prompt + tools
    },

    # Guardrails (optional, per-tenant)
    guardrail_id="clawcore-content-filter",
    guardrail_version="1",

    # Additional Bedrock-specific fields
    additional_request_fields={
        "performanceConfig": {"latency": "standard"}
    },
)

agent = Agent(
    model=model,
    system_prompt="You are a ClawCore agent.",
    tools=[...],
)
```

### Cross-Region Inference Profiles

Cross-region profiles are the primary mechanism for production throughput. They route requests across multiple AWS regions automatically.

| Profile Prefix | Scope | Regions Included | Use Case |
|----------------|-------|------------------|----------|
| `us.` | United States | us-east-1, us-east-2, us-west-2 | US-resident data workloads |
| `eu.` | Europe | eu-central-1, eu-west-1, eu-west-3 | GDPR-compliant workloads |
| `apac.` | Asia-Pacific | ap-southeast-1, ap-northeast-1, etc. | APAC customers |
| `global.` | All commercial | All commercial regions worldwide | Maximum throughput |

```python
# ClawCore model factory -- select profile based on tenant geography
def create_bedrock_model(tenant_config: dict) -> BedrockModel:
    """Create a BedrockModel with the appropriate inference profile."""
    geography = tenant_config.get("geography", "us")
    model_family = tenant_config.get("model_family", "claude-sonnet-4-6")

    PROFILE_MAP = {
        "us": "us",
        "eu": "eu",
        "apac": "apac",
        "global": "global",
    }

    MODEL_MAP = {
        "claude-sonnet-4-6": "anthropic.claude-sonnet-4-6-v1:0",
        "claude-opus-4-6": "anthropic.claude-opus-4-6-v1:0",
        "claude-haiku-4-5": "anthropic.claude-haiku-4-5-20251001-v1:0",
        "nova-pro": "amazon.nova-pro-v1:0",
        "nova-micro": "amazon.nova-micro-v1:0",
        "llama-4-maverick": "meta.llama4-maverick-17b-instruct-v1:0",
    }

    prefix = PROFILE_MAP.get(geography, "us")
    base_model = MODEL_MAP.get(model_family, MODEL_MAP["claude-sonnet-4-6"])
    model_id = f"{prefix}.{base_model}"

    return BedrockModel(
        model_id=model_id,
        region_name="us-east-1",  # Source region; routing is automatic
        max_tokens=tenant_config.get("max_tokens", 4096),
        temperature=tenant_config.get("temperature", 0.3),
        cache_config={"cachePoint": {"type": "default"}},
    )
```

### Application Inference Profiles for Cost Tracking

Application inference profiles enable per-tenant cost attribution without code changes:

```python
import boto3

def create_tenant_inference_profile(
    tenant_id: str,
    model_id: str = "us.anthropic.claude-sonnet-4-6-v1:0",
) -> str:
    """Create an application inference profile for a tenant."""
    bedrock = boto3.client("bedrock", region_name="us-east-1")

    response = bedrock.create_inference_profile(
        inferenceProfileName=f"clawcore-{tenant_id}",
        modelSource={
            "copyFrom": f"arn:aws:bedrock:us-east-1::inference-profile/{model_id}"
        },
        tags=[
            {"key": "tenant_id", "value": tenant_id},
            {"key": "platform", "value": "clawcore"},
        ],
    )

    profile_arn = response["inferenceProfileArn"]

    # Use this ARN as the model_id in BedrockModel
    # All costs are tracked to this profile
    return profile_arn
```

### IAM Policy for Cross-Region Inference

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowCrossRegionInference",
            "Effect": "Allow",
            "Action": "bedrock:InvokeModel*",
            "Resource": [
                "arn:aws:bedrock:us-east-1:ACCOUNT:inference-profile/us.*",
                "arn:aws:bedrock:us-east-1::foundation-model/*",
                "arn:aws:bedrock:us-east-2::foundation-model/*",
                "arn:aws:bedrock:us-west-2::foundation-model/*"
            ]
        },
        {
            "Sid": "AllowGlobalInference",
            "Effect": "Allow",
            "Action": "bedrock:InvokeModel*",
            "Resource": [
                "arn:aws:bedrock:us-east-1:ACCOUNT:inference-profile/global.*",
                "arn:aws:bedrock:::foundation-model/*"
            ],
            "Condition": {
                "StringEquals": {
                    "aws:RequestedRegion": "unspecified"
                }
            }
        }
    ]
}
```

---

## 4. Anthropic Direct API Integration

For workloads outside AWS or when you need features not yet in Bedrock (e.g., latest API features), use the Anthropic direct provider.

### AnthropicModel Configuration

```python
from strands import Agent
from strands.models.anthropic import AnthropicModel

model = AnthropicModel(
    model_id="claude-sonnet-4-6-20260301",
    max_tokens=4096,
    client_args={
        "api_key": "sk-ant-...",     # Or use ANTHROPIC_API_KEY env var
        "timeout": 120.0,
        "max_retries": 3,
    },
    params={
        "temperature": 0.3,
    },
)

agent = Agent(
    model=model,
    system_prompt="You are a ClawCore agent using direct Anthropic API.",
    tools=[...],
)
```

### When to Use Anthropic Direct vs Bedrock

| Criterion | Bedrock | Anthropic Direct |
|-----------|---------|-----------------|
| **AWS integration** | Native (IAM, CloudTrail, VPC) | Requires API key management |
| **Cross-region throughput** | Built-in inference profiles | Single endpoint |
| **Prompt caching** | Supported | Supported |
| **New model availability** | Days to weeks after launch | Immediate |
| **Guardrails** | Bedrock Guardrails integration | Must build custom |
| **Cost tracking** | Application inference profiles | Manual |
| **Extended thinking** | Supported | Supported |
| **Best for ClawCore** | Production (default) | Fallback, latest features |

### ClawCore Integration: Anthropic as Fallback

```python
def create_anthropic_fallback(tenant_config: dict) -> AnthropicModel:
    """Create Anthropic direct model as a Bedrock fallback."""
    import boto3

    # Retrieve API key from Secrets Manager (not env vars in multi-tenant)
    secrets = boto3.client("secretsmanager")
    api_key = secrets.get_secret_value(
        SecretId=f"clawcore/{tenant_config['tenant_id']}/anthropic-api-key"
    )["SecretString"]

    return AnthropicModel(
        model_id=tenant_config.get("anthropic_model", "claude-sonnet-4-6-20260301"),
        max_tokens=tenant_config.get("max_tokens", 4096),
        client_args={"api_key": api_key},
        params={"temperature": tenant_config.get("temperature", 0.3)},
    )
```

---

## 5. OpenAI and Azure OpenAI Integration

### OpenAI via Strands

```python
from strands import Agent
from strands.models.openai import OpenAIModel

model = OpenAIModel(
    model_id="gpt-4o",
    client_args={
        "api_key": "sk-...",  # Or OPENAI_API_KEY env var
    },
    params={
        "max_tokens": 4096,
        "temperature": 0.3,
    },
)

agent = Agent(model=model, tools=[...])
```

### Azure OpenAI via LiteLLM

Azure OpenAI requires deployment-specific endpoints. LiteLLM normalizes this:

```python
from strands import Agent
from strands.models.litellm import LiteLLMModel

# Azure OpenAI through LiteLLM
model = LiteLLMModel(
    model_id="azure/gpt-4o-deployment",
    client_args={
        "api_key": "azure-key-...",
        "api_base": "https://myinstance.openai.azure.com/",
        "api_version": "2024-12-01-preview",
    },
    params={
        "max_tokens": 4096,
        "temperature": 0.3,
    },
)

agent = Agent(model=model, tools=[...])
```

### OpenAI via LiteLLM (Recommended for Multi-Provider)

```python
from strands import Agent
from strands.models.litellm import LiteLLMModel

# OpenAI through LiteLLM -- same interface as all other providers
model = LiteLLMModel(
    model_id="openai/gpt-4o",
    client_args={"api_key": "sk-..."},
    params={"max_tokens": 4096},
)

agent = Agent(model=model, tools=[...])
```

### Provider Comparison: OpenAI Ecosystem

| Aspect | OpenAI Direct (Strands) | Azure OpenAI (LiteLLM) | OpenAI (LiteLLM) |
|--------|------------------------|------------------------|-------------------|
| **Auth** | API key | Azure AD + API key | API key |
| **Models** | GPT-4o, o3, o4-mini | Same (deployed) | Same |
| **Data residency** | US | Azure region of choice | US |
| **Enterprise compliance** | SOC 2 | Azure compliance suite | SOC 2 |
| **Tool calling** | Native | Native | Native |
| **Streaming** | Full | Full | Full |
| **ClawCore use** | Dev/testing | Enterprise tenants | General fallback |

---

## 6. Ollama for Local Development and Edge

Ollama runs LLMs locally with zero cloud dependency -- ideal for development, testing, air-gapped environments, and edge deployments.

### OllamaModel Configuration

```python
from strands import Agent
from strands.models.ollama import OllamaModel

model = OllamaModel(
    host="http://localhost:11434",
    model_id="llama3.2",
    max_tokens=2048,
    temperature=0.3,
    keep_alive="5m",  # Keep model loaded in memory
    options={
        "top_k": 40,
        "num_ctx": 8192,  # Context window
    },
)

agent = Agent(
    model=model,
    system_prompt="You are a ClawCore agent running locally.",
    tools=[...],
)
```

### Supported Models with Tool Calling

Ollama supports tool calling (function calling) with these model families as of March 2026:

| Model | Parameters | Tool Calling | Context | Best For |
|-------|-----------|-------------|---------|----------|
| Qwen 3 | 0.6B-235B | Yes (streaming) | 128K | General, multilingual |
| Llama 4 | 17B-109B | Yes | 128K-1M | General, cost-effective |
| Llama 3.3 | 70B | Yes | 128K | Strong reasoning |
| Devstral | 24B | Yes (streaming) | 128K | Code generation |
| Qwen 2.5 Coder | 1.5B-32B | Yes | 128K | Code-specific tasks |
| Mistral Small | 24B | Yes | 128K | Fast, efficient |

### ClawCore Local Development Profile

```python
# config/dev-local.py -- Development profile using Ollama
from strands import Agent
from strands.models.ollama import OllamaModel

def create_dev_agent(tools: list) -> Agent:
    """Create a local development agent -- no AWS credentials needed."""
    return Agent(
        model=OllamaModel(
            host="http://localhost:11434",
            model_id="qwen3:14b",  # Good balance of capability and speed
            max_tokens=4096,
            temperature=0.3,
        ),
        system_prompt="You are a ClawCore agent (dev mode).",
        tools=tools,
    )
```

### Ollama for Edge Deployment

For ClawCore tenants running on-premise or in air-gapped environments:

```python
# Edge deployment: Ollama on customer hardware
EDGE_CONFIG = {
    "host": "http://ollama-server.internal:11434",
    "model_id": "llama3.2:3b",  # Small model for limited hardware
    "max_tokens": 1024,
    "keep_alive": "24h",  # Keep loaded permanently
    "options": {
        "num_gpu": 1,
        "num_ctx": 4096,
    },
}
```

---

## 7. LiteLLM as Universal Proxy

LiteLLM provides access to 100+ providers through a single OpenAI-compatible interface. ClawCore uses it in two modes: as a Strands model provider (SDK) and as a standalone proxy server (gateway).

### Mode 1: LiteLLM as Strands Provider (SDK)

The `LiteLLMModel` in Strands inherits from `OpenAIModel` and adds LiteLLM's provider routing:

```python
from strands import Agent
from strands.models.litellm import LiteLLMModel

# Access ANY provider through Strands
providers = {
    "bedrock": LiteLLMModel(
        model_id="bedrock/us.anthropic.claude-sonnet-4-6-v1:0",
        params={"max_tokens": 4096},
    ),
    "anthropic": LiteLLMModel(
        model_id="anthropic/claude-sonnet-4-6-20260301",
        client_args={"api_key": "sk-ant-..."},
        params={"max_tokens": 4096},
    ),
    "openai": LiteLLMModel(
        model_id="openai/gpt-4o",
        client_args={"api_key": "sk-..."},
        params={"max_tokens": 4096},
    ),
    "azure": LiteLLMModel(
        model_id="azure/gpt-4o-deployment",
        client_args={
            "api_key": "azure-...",
            "api_base": "https://myinstance.openai.azure.com/",
            "api_version": "2024-12-01-preview",
        },
        params={"max_tokens": 4096},
    ),
    "ollama": LiteLLMModel(
        model_id="ollama/llama3.2",
        client_args={"api_base": "http://localhost:11434"},
        params={"max_tokens": 2048},
    ),
}

# Same agent code, different backend
agent = Agent(model=providers["bedrock"], tools=[...])
```

### Mode 2: LiteLLM Proxy Server (Gateway)

For centralized control, deploy LiteLLM as a proxy that all agents route through.

#### Proxy Configuration (`litellm_config.yaml`)

```yaml
# ClawCore LiteLLM Proxy Configuration
model_list:
  # === Tier 1: Complex Reasoning ===
  - model_name: "reasoning"
    litellm_params:
      model: "bedrock/global.anthropic.claude-opus-4-6-v1"
      aws_region_name: "us-east-1"
      max_tokens: 8192

  # === Tier 2: General Agent Tasks (primary + fallback) ===
  - model_name: "general"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6-v1:0"
      aws_region_name: "us-east-1"
      max_tokens: 4096

  - model_name: "general"
    litellm_params:
      model: "anthropic/claude-sonnet-4-6-20260301"
      api_key: "os.environ/ANTHROPIC_API_KEY"
      max_tokens: 4096

  # === Tier 3: Fast/Cheap Tasks ===
  - model_name: "fast"
    litellm_params:
      model: "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0"
      aws_region_name: "us-east-1"
      max_tokens: 2048

  - model_name: "fast"
    litellm_params:
      model: "bedrock/us.amazon.nova-micro-v1:0"
      aws_region_name: "us-east-1"
      max_tokens: 1024

  # === Tier 4: Ultra-Cheap (classification, routing) ===
  - model_name: "router"
    litellm_params:
      model: "bedrock/amazon.nova-micro-v1:0"
      aws_region_name: "us-east-1"
      max_tokens: 256

  # === Cost-Optimized Open-Weight ===
  - model_name: "budget"
    litellm_params:
      model: "bedrock/us.meta.llama4-maverick-17b-instruct-v1:0"
      aws_region_name: "us-east-1"
      max_tokens: 4096

router_settings:
  routing_strategy: "latency-based-routing"
  routing_strategy_args:
    ttl: 60
    lowest_latency_buffer: 0.1

  # Fallback chains
  fallbacks:
    - reasoning: ["general"]
    - general: ["fast", "budget"]
    - fast: ["budget"]

  # Retry config
  num_retries: 3
  retry_after: 1
  retry_on_status_codes: [429, 503, 529]

  # Timeouts
  timeout: 120
  stream_timeout: 180

  # Cooldown failed deployments
  cooldown_time: 60
  allowed_fails: 3

general_settings:
  master_key: "os.environ/LITELLM_MASTER_KEY"
  database_url: "os.environ/LITELLM_DB_URL"  # PostgreSQL for spend tracking

litellm_settings:
  drop_params: true  # Drop unsupported params instead of erroring
  set_verbose: false
  cache: true
  cache_params:
    type: "redis"
    host: "os.environ/REDIS_HOST"
    port: 6379
```

### When to Use Each Mode

| Criterion | Strands Provider (SDK) | LiteLLM Proxy (Gateway) |
|-----------|----------------------|------------------------|
| **Deployment** | In-process, per-agent | Centralized server |
| **Latency** | Lower (no extra hop) | Higher (+network hop) |
| **Governance** | Per-agent config | Centralized control |
| **Cost tracking** | Per-agent | Centralized, per-key/team |
| **Budget limits** | Must build custom | Built-in |
| **Caching** | Per-process | Shared across all agents |
| **Best for** | Simple setups, <10 agents | Production, multi-tenant, governance |

### ClawCore Recommendation

- **Phase 1-4:** Use Strands BedrockModel directly (simplest)
- **Phase 5+:** Add LiteLLM proxy for centralized cost tracking and budget enforcement
- **Enterprise tenants:** LiteLLM proxy with per-tenant API keys for spend isolation

---

## 8. Model Routing Strategies

### Task Classification Router

A cheap model classifies incoming requests before routing to the appropriate tier:

```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from enum import Enum


class TaskCategory(str, Enum):
    SIMPLE_QA = "simple_qa"
    CODE_GEN = "code_gen"
    ANALYSIS = "analysis"
    CREATIVE = "creative"
    COMPLEX_REASONING = "complex_reasoning"


# Classifier uses ultra-cheap model
classifier_agent = Agent(
    model=BedrockModel(
        model_id="amazon.nova-micro-v1:0",
        max_tokens=50,
        temperature=0.0,
    ),
    system_prompt="""Classify the user request into exactly one category.
Reply with ONLY the category name, nothing else.

Categories:
- simple_qa: factual questions, definitions, basic lookups
- code_gen: writing code, debugging, code review
- analysis: data analysis, comparisons, evaluations
- creative: writing, brainstorming, creative content
- complex_reasoning: multi-step logic, architecture, research""",
)


def classify_task(user_message: str) -> TaskCategory:
    """Classify a user message into a task category."""
    result = classifier_agent(user_message)
    text = result.message["content"][0]["text"].strip().lower()
    try:
        return TaskCategory(text)
    except ValueError:
        return TaskCategory.ANALYSIS  # Default to mid-tier
```

### Bayesian Multi-Armed Bandit Router

The full router from [[ClawCore-Self-Evolution-Engine#4. Model Routing Evolution]] uses Thompson Sampling to learn optimal model-per-category:

```python
import random
from dataclasses import dataclass, field
from typing import Optional
import json
import boto3


@dataclass
class ModelArm:
    """A single model option in the multi-armed bandit."""
    model_id: str
    cost_per_1k_input: float
    cost_per_1k_output: float
    alpha: float = 1.0  # Success prior (Beta distribution)
    beta: float = 1.0   # Failure prior

    def sample(self) -> float:
        """Thompson sampling: draw from Beta distribution."""
        return random.betavariate(self.alpha, self.beta)

    def update(self, reward: float):
        """Update posterior with observed reward (0.0-1.0)."""
        self.alpha += reward
        self.beta += (1.0 - reward)

    @property
    def mean_quality(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    @property
    def observations(self) -> int:
        return int(self.alpha + self.beta - 2)


class BayesianModelRouter:
    """Per-tenant model router using Thompson Sampling."""

    # Default model pool with costs (per 1M tokens)
    DEFAULT_MODELS = {
        "us.amazon.nova-micro-v1:0": (0.035, 0.14),
        "us.anthropic.claude-haiku-4-5-20251001-v1:0": (1.0, 5.0),
        "us.anthropic.claude-sonnet-4-6-v1:0": (3.0, 15.0),
        "global.anthropic.claude-opus-4-6-v1": (5.0, 25.0),
        "us.meta.llama4-maverick-17b-instruct-v1:0": (0.24, 0.97),
    }

    def __init__(
        self,
        tenant_id: str,
        cost_sensitivity: float = 0.3,
        models: Optional[dict] = None,
    ):
        self.tenant_id = tenant_id
        self.cost_sensitivity = cost_sensitivity
        self.arms: dict[str, dict[str, ModelArm]] = {}

        model_pool = models or self.DEFAULT_MODELS
        self._model_costs = model_pool

    def select_model(self, task_category: str) -> str:
        """Select optimal model for a task category."""
        if task_category not in self.arms:
            self.arms[task_category] = {
                mid: ModelArm(
                    model_id=mid,
                    cost_per_1k_input=costs[0],
                    cost_per_1k_output=costs[1],
                )
                for mid, costs in self._model_costs.items()
            }

        arms = self.arms[task_category]
        max_cost = max(
            a.cost_per_1k_input + a.cost_per_1k_output
            for a in arms.values()
        )

        best_model = None
        best_score = -1.0

        for model_id, arm in arms.items():
            quality_sample = arm.sample()
            total_cost = arm.cost_per_1k_input + arm.cost_per_1k_output
            cost_efficiency = 1.0 - (total_cost / max_cost)

            score = (
                (1 - self.cost_sensitivity) * quality_sample
                + self.cost_sensitivity * cost_efficiency
            )
            if score > best_score:
                best_score = score
                best_model = model_id

        return best_model

    def record_outcome(
        self,
        task_category: str,
        model_id: str,
        quality_score: float,
    ):
        """Record reward (0.0 = failure, 1.0 = perfect)."""
        if task_category in self.arms and model_id in self.arms[task_category]:
            self.arms[task_category][model_id].update(quality_score)

    def save_state(self):
        """Persist routing state to DynamoDB."""
        dynamodb = boto3.resource("dynamodb")
        table = dynamodb.Table("clawcore-evolution-state")

        state = {}
        for cat, arms in self.arms.items():
            state[cat] = {
                mid: {"alpha": arm.alpha, "beta": arm.beta}
                for mid, arm in arms.items()
            }

        table.put_item(Item={
            "PK": f"TENANT#{self.tenant_id}",
            "SK": "MODEL_ROUTING",
            "routing_state": state,
            "cost_sensitivity": str(self.cost_sensitivity),
        })

    @classmethod
    def load_state(cls, tenant_id: str) -> "BayesianModelRouter":
        """Load routing state from DynamoDB."""
        dynamodb = boto3.resource("dynamodb")
        table = dynamodb.Table("clawcore-evolution-state")

        item = table.get_item(
            Key={"PK": f"TENANT#{tenant_id}", "SK": "MODEL_ROUTING"}
        ).get("Item", {})

        router = cls(
            tenant_id=tenant_id,
            cost_sensitivity=float(item.get("cost_sensitivity", "0.3")),
        )

        for cat, models in item.get("routing_state", {}).items():
            router.arms[cat] = {
                mid: ModelArm(
                    model_id=mid,
                    cost_per_1k_input=cls.DEFAULT_MODELS.get(mid, (0.01, 0.01))[0],
                    cost_per_1k_output=cls.DEFAULT_MODELS.get(mid, (0.01, 0.01))[1],
                    alpha=float(params["alpha"]),
                    beta=float(params["beta"]),
                )
                for mid, params in models.items()
            }

        return router
```

### Integrated Router Agent

Combining classification + Bayesian routing + Strands agents:

```python
from strands import Agent
from strands.models.bedrock import BedrockModel


class ClawCoreModelRouter:
    """Full model routing pipeline for ClawCore."""

    def __init__(self, tenant_id: str):
        self.tenant_id = tenant_id
        self.bayesian_router = BayesianModelRouter.load_state(tenant_id)
        self._agents_cache: dict[str, Agent] = {}

    def _get_or_create_agent(
        self,
        model_id: str,
        system_prompt: str,
        tools: list,
    ) -> Agent:
        if model_id not in self._agents_cache:
            self._agents_cache[model_id] = Agent(
                model=BedrockModel(model_id=model_id, max_tokens=4096),
                system_prompt=system_prompt,
                tools=tools,
            )
        return self._agents_cache[model_id]

    def route_and_execute(
        self,
        user_message: str,
        system_prompt: str,
        tools: list,
    ) -> dict:
        """Classify, route, execute, and record outcome."""
        # Step 1: Classify task
        task_category = classify_task(user_message)

        # Step 2: Select model via Bayesian routing
        model_id = self.bayesian_router.select_model(task_category.value)

        # Step 3: Execute
        agent = self._get_or_create_agent(model_id, system_prompt, tools)
        result = agent(user_message)

        # Step 4: Record outcome (quality proxy: did the agent complete?)
        quality = 1.0 if result.stop_reason == "end_turn" else 0.3
        self.bayesian_router.record_outcome(
            task_category.value, model_id, quality
        )

        return {
            "result": result,
            "task_category": task_category.value,
            "model_used": model_id,
            "routing_weights": self.bayesian_router.arms.get(
                task_category.value, {}
            ),
        }
```

---

## 9. Per-Tenant Model Configuration

### DynamoDB Schema

```
Table: clawcore-tenants
PK: TENANT#{tenant_id}
SK: MODEL_CONFIG

Attributes:
  default_model:           str   # e.g., "us.anthropic.claude-sonnet-4-6-v1:0"
  allowed_models:          list  # Models this tenant can use
  blocked_models:          list  # Models explicitly blocked
  cost_sensitivity:        num   # 0.0 (quality) to 1.0 (cost), default 0.3
  max_tokens_per_request:  num   # Hard cap per request
  monthly_token_budget:    num   # Monthly budget in tokens
  monthly_cost_budget:     num   # Monthly budget in USD
  geography:               str   # us | eu | apac | global
  model_overrides:         map   # Per-task-category model pinning
  temperature:             num   # Default temperature
  fallback_chain:          list  # Ordered fallback models
  provider_api_keys:       map   # Encrypted refs to Secrets Manager ARNs
  enable_litellm_proxy:    bool  # Route through LiteLLM proxy
  inference_profile_arn:   str   # Application inference profile for cost tracking

Example model_overrides:
  {
    "complex_reasoning": "global.anthropic.claude-opus-4-6-v1",
    "simple_qa": "us.amazon.nova-micro-v1:0",
    "code_gen": "us.anthropic.claude-sonnet-4-6-v1:0"
  }
```

### Tenant Model Configuration Loader

```python
import boto3
from strands.models.bedrock import BedrockModel
from strands.models.anthropic import AnthropicModel
from strands.models.ollama import OllamaModel
from strands.models.litellm import LiteLLMModel
from strands.models.model import Model


def load_tenant_model(
    tenant_id: str,
    task_category: str | None = None,
) -> Model:
    """Load the appropriate model for a tenant, optionally per task."""
    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table("clawcore-tenants")

    item = table.get_item(
        Key={"PK": f"TENANT#{tenant_id}", "SK": "MODEL_CONFIG"}
    ).get("Item", {})

    # Check for task-specific override
    overrides = item.get("model_overrides", {})
    if task_category and task_category in overrides:
        model_id = overrides[task_category]
    else:
        model_id = item.get(
            "default_model", "us.anthropic.claude-sonnet-4-6-v1:0"
        )

    max_tokens = item.get("max_tokens_per_request", 4096)
    temperature = float(item.get("temperature", 0.3))

    # Route to appropriate provider
    if model_id.startswith(("us.", "eu.", "apac.", "global.", "amazon.", "anthropic.", "meta.", "mistral.", "cohere.", "ai21.", "deepseek.")):
        # Bedrock model
        return BedrockModel(
            model_id=model_id,
            max_tokens=max_tokens,
            temperature=temperature,
            cache_config={"cachePoint": {"type": "default"}},
        )
    elif model_id.startswith("claude-"):
        # Anthropic direct
        api_key_arn = item.get("provider_api_keys", {}).get("anthropic")
        api_key = _get_secret(api_key_arn) if api_key_arn else None
        return AnthropicModel(
            model_id=model_id,
            max_tokens=max_tokens,
            client_args={"api_key": api_key} if api_key else {},
            params={"temperature": temperature},
        )
    elif model_id.startswith("ollama/"):
        # Ollama local
        return OllamaModel(
            host=item.get("ollama_host", "http://localhost:11434"),
            model_id=model_id.replace("ollama/", ""),
            max_tokens=max_tokens,
            temperature=temperature,
        )
    else:
        # Everything else via LiteLLM
        return LiteLLMModel(
            model_id=model_id,
            params={"max_tokens": max_tokens, "temperature": temperature},
        )


def _get_secret(arn: str) -> str:
    """Retrieve a secret from Secrets Manager."""
    secrets = boto3.client("secretsmanager")
    return secrets.get_secret_value(SecretId=arn)["SecretString"]
```

---

## 10. Fallback Chains with Circuit Breaking

### Fallback Chain Architecture

```
Primary Model (Bedrock Claude Sonnet)
    |
    +--> [429/503/timeout] --> Circuit Breaker Check
                                    |
                          [Open] ---+--> [Closed/Half-Open]
                            |                    |
                      Skip primary          Try primary
                            |                    |
                            v                    v
                    Fallback 1 (Bedrock Haiku)
                            |
                    +--> [429/503/timeout]
                            |
                            v
                    Fallback 2 (Anthropic Direct)
                            |
                    +--> [429/503/timeout]
                            |
                            v
                    Fallback 3 (Nova Micro -- degraded mode)
                            |
                    +--> [all fail]
                            |
                            v
                    Error Response + Alert
```

### Circuit Breaker Implementation

```python
import time
from dataclasses import dataclass
from enum import Enum
from strands.models.model import Model
from strands.models.bedrock import BedrockModel


class CircuitState(Enum):
    CLOSED = "closed"       # Normal operation
    OPEN = "open"           # Failing, skip this provider
    HALF_OPEN = "half_open" # Testing if provider recovered


@dataclass
class CircuitBreaker:
    """Per-provider circuit breaker."""
    failure_threshold: int = 3
    recovery_timeout: float = 60.0  # Seconds before trying again
    half_open_max_calls: int = 1

    state: CircuitState = CircuitState.CLOSED
    failure_count: int = 0
    last_failure_time: float = 0.0
    half_open_calls: int = 0

    def can_execute(self) -> bool:
        if self.state == CircuitState.CLOSED:
            return True
        if self.state == CircuitState.OPEN:
            if time.time() - self.last_failure_time > self.recovery_timeout:
                self.state = CircuitState.HALF_OPEN
                self.half_open_calls = 0
                return True
            return False
        if self.state == CircuitState.HALF_OPEN:
            return self.half_open_calls < self.half_open_max_calls

        return False

    def record_success(self):
        if self.state == CircuitState.HALF_OPEN:
            self.state = CircuitState.CLOSED
        self.failure_count = 0

    def record_failure(self):
        self.failure_count += 1
        self.last_failure_time = time.time()
        if self.state == CircuitState.HALF_OPEN:
            self.state = CircuitState.OPEN
        elif self.failure_count >= self.failure_threshold:
            self.state = CircuitState.OPEN


class FallbackChain:
    """Model fallback chain with circuit breaking."""

    def __init__(self, models: list[tuple[str, Model]]):
        """
        Args:
            models: List of (name, Model) tuples in priority order.
        """
        self.models = models
        self.breakers: dict[str, CircuitBreaker] = {
            name: CircuitBreaker() for name, _ in models
        }

    def execute(self, messages, system_prompt, tools, **kwargs):
        """Try each model in order, respecting circuit breakers."""
        last_error = None

        for name, model in self.models:
            breaker = self.breakers[name]

            if not breaker.can_execute():
                continue

            try:
                # Attempt model call
                events = list(model.stream(
                    messages=messages,
                    system_prompt=system_prompt,
                    tool_specs=tools,
                    **kwargs,
                ))
                breaker.record_success()
                return {"events": events, "model_used": name}

            except Exception as e:
                breaker.record_failure()
                last_error = e
                continue

        raise RuntimeError(
            f"All models in fallback chain failed. Last error: {last_error}"
        )

    def get_status(self) -> dict:
        """Get circuit breaker status for monitoring."""
        return {
            name: {
                "state": breaker.state.value,
                "failure_count": breaker.failure_count,
            }
            for name, breaker in self.breakers.items()
        }


# ClawCore default fallback chain
def create_default_fallback_chain(tenant_config: dict) -> FallbackChain:
    """Create a fallback chain based on tenant configuration."""
    chain_config = tenant_config.get("fallback_chain", [
        "us.anthropic.claude-sonnet-4-6-v1:0",
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "us.amazon.nova-micro-v1:0",
    ])

    models = []
    for model_id in chain_config:
        models.append((
            model_id,
            BedrockModel(
                model_id=model_id,
                max_tokens=tenant_config.get("max_tokens", 4096),
            ),
        ))

    return FallbackChain(models)
```

---

## 11. Token Counting and Cost Tracking

### Token Usage from Strands

All Strands model providers report token usage via the `metadata` StreamEvent:

```python
from strands import Agent
from strands.models.bedrock import BedrockModel

agent = Agent(model=BedrockModel(model_id="us.anthropic.claude-sonnet-4-6-v1:0"))
result = agent("Hello, world!")

# Access usage metrics
usage = result.metrics
print(f"Input tokens:  {usage.get('inputTokens', 0)}")
print(f"Output tokens: {usage.get('outputTokens', 0)}")
print(f"Total tokens:  {usage.get('totalTokens', 0)}")
print(f"Latency:       {usage.get('latencyMs', 0)}ms")
```

### Cost Tracking Service

```python
from decimal import Decimal
from datetime import datetime
import boto3


# Cost per 1M tokens (input, output) -- March 2026 pricing
MODEL_PRICING = {
    "anthropic.claude-opus-4-6": (5.0, 25.0),
    "anthropic.claude-sonnet-4-6": (3.0, 15.0),
    "anthropic.claude-haiku-4-5": (1.0, 5.0),
    "amazon.nova-pro": (0.80, 3.20),
    "amazon.nova-micro": (0.035, 0.14),
    "meta.llama4-maverick-17b": (0.24, 0.97),
    "meta.llama4-scout-17b": (0.17, 0.66),
}


def extract_model_family(model_id: str) -> str:
    """Extract model family from full model ID for pricing lookup."""
    # Strip region prefix and version suffix
    clean = model_id
    for prefix in ("us.", "eu.", "apac.", "global."):
        if clean.startswith(prefix):
            clean = clean[len(prefix):]
    # Strip version suffix (e.g., -v1:0)
    if "-v" in clean:
        clean = clean[:clean.rfind("-v")]
    # Strip date suffix (e.g., -20251001)
    parts = clean.split("-")
    family_parts = []
    for p in parts:
        if p.isdigit() and len(p) == 8:
            break
        family_parts.append(p)
    return "-".join(family_parts)


def compute_cost(
    model_id: str,
    input_tokens: int,
    output_tokens: int,
) -> float:
    """Compute cost in USD for a model invocation."""
    family = extract_model_family(model_id)
    pricing = MODEL_PRICING.get(family, (3.0, 15.0))  # Default to Sonnet
    input_cost = (input_tokens / 1_000_000) * pricing[0]
    output_cost = (output_tokens / 1_000_000) * pricing[1]
    return round(input_cost + output_cost, 8)


def record_usage(
    tenant_id: str,
    model_id: str,
    input_tokens: int,
    output_tokens: int,
    session_id: str,
):
    """Record token usage and cost to DynamoDB."""
    cost = compute_cost(model_id, input_tokens, output_tokens)
    now = datetime.utcnow()
    period = now.strftime("%Y-%m")

    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table("clawcore-cost-tracking")

    # Atomic increment of monthly totals
    table.update_item(
        Key={
            "PK": f"TENANT#{tenant_id}",
            "SK": f"PERIOD#{period}",
        },
        UpdateExpression="""
            ADD total_input_tokens :inp,
                total_output_tokens :out,
                total_cost :cost,
                request_count :one
            SET last_updated = :now,
                #model_breakdown.#mid = if_not_exists(#model_breakdown.#mid, :zero) + :cost
        """,
        ExpressionAttributeNames={
            "#model_breakdown": "model_breakdown",
            "#mid": extract_model_family(model_id),
        },
        ExpressionAttributeValues={
            ":inp": input_tokens,
            ":out": output_tokens,
            ":cost": Decimal(str(cost)),
            ":one": 1,
            ":now": now.isoformat(),
            ":zero": Decimal("0"),
        },
    )

    return cost
```

### Budget Enforcement

```python
def check_budget(tenant_id: str) -> dict:
    """Check if a tenant is within budget before model invocation."""
    dynamodb = boto3.resource("dynamodb")
    tenants_table = dynamodb.Table("clawcore-tenants")
    cost_table = dynamodb.Table("clawcore-cost-tracking")

    now = datetime.utcnow()
    period = now.strftime("%Y-%m")

    # Load budget config
    config = tenants_table.get_item(
        Key={"PK": f"TENANT#{tenant_id}", "SK": "MODEL_CONFIG"}
    ).get("Item", {})

    monthly_budget = float(config.get("monthly_cost_budget", 1000.0))

    # Load current spend
    spend = cost_table.get_item(
        Key={"PK": f"TENANT#{tenant_id}", "SK": f"PERIOD#{period}"}
    ).get("Item", {})

    current_cost = float(spend.get("total_cost", 0))

    return {
        "within_budget": current_cost < monthly_budget,
        "current_spend": current_cost,
        "monthly_budget": monthly_budget,
        "utilization_pct": round((current_cost / monthly_budget) * 100, 1),
        "remaining": monthly_budget - current_cost,
    }
```

### LiteLLM Cost Tracking (Proxy Mode)

When using the LiteLLM proxy, cost tracking is built-in:

```python
from litellm import completion, completion_cost

response = completion(
    model="bedrock/us.anthropic.claude-sonnet-4-6-v1:0",
    messages=[{"role": "user", "content": "Hello"}],
)

# Automatic cost calculation
cost = completion_cost(completion_response=response)
print(f"Cost: ${cost:.6f}")

# Also available in response metadata
print(f"Response cost: ${response._hidden_params['response_cost']:.6f}")
```

LiteLLM proxy provides REST APIs for spend analytics:

```bash
# Get spend by date
curl -s "$LITELLM_PROXY/spend/report" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -d '{"start_date": "2026-03-01", "end_date": "2026-03-31"}'

# Get spend by team
curl -s "$LITELLM_PROXY/team/info?team_id=tenant-123" \
  -H "Authorization: Bearer $MASTER_KEY"
```

---

## 12. Streaming Compatibility Matrix

| Provider | Text Streaming | Tool Call Streaming | Structured Output | Extended Thinking |
|----------|---------------|-------------------|-------------------|------------------|
| **Bedrock (Claude)** | Full | Full | Yes | Yes |
| **Bedrock (Nova)** | Full | Full | Yes | No |
| **Bedrock (Llama 4)** | Full | Full | Yes | No |
| **Anthropic Direct** | Full | Full | Yes | Yes |
| **OpenAI (Strands)** | Full | Full | Yes | N/A |
| **Azure OpenAI (LiteLLM)** | Full | Full | Yes | N/A |
| **Ollama** | Full | Full (since May 2025) | Partial | No |
| **LiteLLM (SDK)** | Full | Depends on backend | Yes | Depends on backend |
| **LiteLLM (Proxy)** | Full | Full | Yes | Depends on backend |

### Streaming Notes

- **Bedrock** uses `converse_stream` API; when `streaming=False`, `BedrockModel` converts to streaming events internally
- **Ollama** added streaming tool call support in May 2025 for Qwen 3, Llama 4, Devstral
- **LiteLLM** respects the underlying provider's streaming capability; set `stream=True` in params
- All Strands providers normalize streaming into the same `StreamEvent` interface, so agent code is provider-agnostic

---

## 13. Provider Health Monitoring

### Health Check Implementation

```python
import time
import asyncio
from dataclasses import dataclass, field
from datetime import datetime
import boto3


@dataclass
class ProviderHealth:
    """Track health metrics for a model provider."""
    provider_name: str
    model_id: str
    consecutive_failures: int = 0
    total_requests: int = 0
    total_failures: int = 0
    avg_latency_ms: float = 0.0
    p99_latency_ms: float = 0.0
    last_success: datetime | None = None
    last_failure: datetime | None = None
    last_error: str | None = None
    latency_samples: list[float] = field(default_factory=list)

    @property
    def success_rate(self) -> float:
        if self.total_requests == 0:
            return 1.0
        return (self.total_requests - self.total_failures) / self.total_requests

    @property
    def is_healthy(self) -> bool:
        return self.consecutive_failures < 3 and self.success_rate > 0.9

    def record_success(self, latency_ms: float):
        self.total_requests += 1
        self.consecutive_failures = 0
        self.last_success = datetime.utcnow()
        self._update_latency(latency_ms)

    def record_failure(self, error: str):
        self.total_requests += 1
        self.total_failures += 1
        self.consecutive_failures += 1
        self.last_failure = datetime.utcnow()
        self.last_error = error

    def _update_latency(self, latency_ms: float):
        self.latency_samples.append(latency_ms)
        if len(self.latency_samples) > 100:
            self.latency_samples = self.latency_samples[-100:]
        self.avg_latency_ms = sum(self.latency_samples) / len(self.latency_samples)
        sorted_samples = sorted(self.latency_samples)
        p99_idx = int(len(sorted_samples) * 0.99)
        self.p99_latency_ms = sorted_samples[min(p99_idx, len(sorted_samples) - 1)]


class ProviderHealthMonitor:
    """Monitor health across all configured providers."""

    def __init__(self):
        self.providers: dict[str, ProviderHealth] = {}

    def get_or_create(self, provider_name: str, model_id: str) -> ProviderHealth:
        key = f"{provider_name}:{model_id}"
        if key not in self.providers:
            self.providers[key] = ProviderHealth(
                provider_name=provider_name,
                model_id=model_id,
            )
        return self.providers[key]

    def get_healthy_providers(self) -> list[ProviderHealth]:
        return [p for p in self.providers.values() if p.is_healthy]

    def publish_metrics(self):
        """Publish health metrics to CloudWatch."""
        cloudwatch = boto3.client("cloudwatch")

        for key, health in self.providers.items():
            cloudwatch.put_metric_data(
                Namespace="ClawCore/ProviderHealth",
                MetricData=[
                    {
                        "MetricName": "SuccessRate",
                        "Dimensions": [
                            {"Name": "Provider", "Value": health.provider_name},
                            {"Name": "Model", "Value": health.model_id},
                        ],
                        "Value": health.success_rate,
                        "Unit": "None",
                    },
                    {
                        "MetricName": "AvgLatencyMs",
                        "Dimensions": [
                            {"Name": "Provider", "Value": health.provider_name},
                            {"Name": "Model", "Value": health.model_id},
                        ],
                        "Value": health.avg_latency_ms,
                        "Unit": "Milliseconds",
                    },
                    {
                        "MetricName": "ConsecutiveFailures",
                        "Dimensions": [
                            {"Name": "Provider", "Value": health.provider_name},
                            {"Name": "Model", "Value": health.model_id},
                        ],
                        "Value": health.consecutive_failures,
                        "Unit": "Count",
                    },
                ],
            )

    def get_dashboard_data(self) -> list[dict]:
        """Get summary data for all providers."""
        return [
            {
                "provider": h.provider_name,
                "model": h.model_id,
                "healthy": h.is_healthy,
                "success_rate": round(h.success_rate, 4),
                "avg_latency_ms": round(h.avg_latency_ms, 1),
                "p99_latency_ms": round(h.p99_latency_ms, 1),
                "total_requests": h.total_requests,
                "consecutive_failures": h.consecutive_failures,
                "last_error": h.last_error,
            }
            for h in self.providers.values()
        ]
```

### CloudWatch Alarms

```python
import aws_cdk as cdk
from aws_cdk import aws_cloudwatch as cw


def create_provider_alarms(stack: cdk.Stack):
    """Create CloudWatch alarms for provider health."""

    # Alarm: Provider success rate drops below 90%
    cw.Alarm(
        stack, "ProviderSuccessRateAlarm",
        metric=cw.Metric(
            namespace="ClawCore/ProviderHealth",
            metric_name="SuccessRate",
            statistic="Average",
            period=cdk.Duration.minutes(5),
        ),
        threshold=0.9,
        evaluation_periods=3,
        comparison_operator=cw.ComparisonOperator.LESS_THAN_THRESHOLD,
        alarm_description="Provider success rate below 90% for 15 minutes",
    )

    # Alarm: P99 latency exceeds 10 seconds
    cw.Alarm(
        stack, "ProviderLatencyAlarm",
        metric=cw.Metric(
            namespace="ClawCore/ProviderHealth",
            metric_name="AvgLatencyMs",
            statistic="p99",
            period=cdk.Duration.minutes(5),
        ),
        threshold=10000,
        evaluation_periods=2,
        comparison_operator=cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarm_description="Provider P99 latency exceeds 10s",
    )
```

---

## 14. Putting It All Together

### Complete Request Flow

```
1. User sends message via Chat SDK
2. API Gateway routes to tenant's AgentCore runtime
3. Strands Agent receives the message
4. ClawCoreModelRouter:
   a. classify_task() → task_category (via Nova Micro, ~$0.001)
   b. check_budget() → verify tenant within budget
   c. bayesian_router.select_model() → optimal model for category
   d. load_tenant_model() → Strands Model instance with tenant config
5. Agent executes with selected model
   a. Streaming events flow back through SSE Bridge
   b. If model fails → FallbackChain tries next provider
   c. CircuitBreaker tracks failures per provider
6. On completion:
   a. record_usage() → DynamoDB cost tracking
   b. bayesian_router.record_outcome() → update routing weights
   c. ProviderHealthMonitor.record_success/failure()
7. Periodically:
   a. bayesian_router.save_state() → persist routing state
   b. ProviderHealthMonitor.publish_metrics() → CloudWatch
```

### Provider Selection Decision Tree

```
Is the tenant configured for a specific provider?
├── Yes → Use tenant's configured provider
└── No → Is this a Bedrock-available model?
    ├── Yes → Use BedrockModel with cross-region profile
    └── No → Is the tenant on the LiteLLM proxy?
        ├── Yes → Route through LiteLLM proxy
        └── No → Use Strands LiteLLMModel (SDK mode)

Is the environment local development?
├── Yes → Use OllamaModel with local models
└── No → Follow production flow above

Did the primary model fail?
├── Yes → Check CircuitBreaker state
│   ├── Open → Skip to next in fallback chain
│   └── Closed → Try primary (failure increments counter)
└── No → Return result
```

### Cost Optimization Summary

| Strategy | Savings | Implementation |
|----------|---------|---------------|
| **Prompt caching** (Bedrock) | 75-90% on cached input | `cache_config` on BedrockModel |
| **Task-based routing** | 60-90% on simple tasks | Nova Micro classifier + routing |
| **Cross-region profiles** | Avoids throttle retries | `us.`/`global.` prefix on model ID |
| **Bayesian model selection** | 20-40% over static routing | Thompson Sampling learns over time |
| **Budget enforcement** | Prevents overruns | DynamoDB budget checks pre-request |
| **Batch inference** (Bedrock) | ~50% for async workloads | Bedrock batch API for non-real-time |
| **Open-weight models** | 90%+ vs Claude Sonnet | Llama 4 Maverick at $0.24/M input |

---

## 15. Implementation Phases for ClawCore

| Phase | What | Models | Routing |
|-------|------|--------|---------|
| **Phase 1** (Single tenant) | BedrockModel only | Claude Sonnet 4.6 | Static, single model |
| **Phase 2** (Chat gateway) | Add streaming | Same | Same |
| **Phase 4** (Multi-tenant) | Per-tenant model config | Sonnet + Haiku + Nova | DynamoDB config lookup |
| **Phase 5** (Cron/Orchestration) | Bayesian routing + fallbacks | All Bedrock models | Task classification + MAB |
| **Phase 6** (Self-improving) | Full multi-provider | Bedrock + Anthropic + LiteLLM | Self-evolving routing weights |
| **Phase 7** (Production) | Health monitoring + circuit breaking | All + Ollama for edge | Full fallback chains |

---

## Related Documents

- [[ClawCore-Final-Architecture-Plan]] -- Overall architecture and phases
- [[ClawCore-Self-Evolution-Engine]] -- Model routing evolution with Bayesian optimization
- [[../AWS Bedrock AgentCore and Strands Agents/09-Multi-Provider-LLM-Support]] -- Research on all provider options
- [[../AWS Bedrock AgentCore and Strands Agents/04-Strands-Agents-Core]] -- Strands framework deep dive
- [[ClawCore-Architecture-Review-Cost-Scale]] -- Cost model and pricing analysis

---

*Multi-provider LLM implementation guide written 2026-03-19. Covers Strands Agents provider
system, Bedrock cross-region inference, Anthropic direct, OpenAI/Azure OpenAI, Ollama,
LiteLLM proxy, Bayesian model routing, per-tenant configuration, fallback chains with
circuit breaking, token counting, cost tracking, and provider health monitoring.*
