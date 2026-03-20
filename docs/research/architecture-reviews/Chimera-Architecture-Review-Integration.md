---
tags:
  - architecture-review
  - chimera
  - integration
  - streaming
  - mcp
  - a2a
  - chat-sdk
  - agentcore
date: 2026-03-19
topic: Chimera Integration & Communication Architecture Review
status: complete
reviewer: integration-architect
---

# Chimera Integration & Communication Architecture Review

> **Reviewer:** Integration Architect
> **Scope:** Data flow, streaming, protocols, identity, MCP ecosystem, LLM routing, webhook patterns, and migration path from OpenClaw Gateway
> **Sources:** AWS-Native-OpenClaw-Architecture-Synthesis, 07-Vercel-AI-SDK-Chat-Layer, 02-AgentCore-APIs-SDKs-MCP, 07-Chat-Interface-Multi-Platform, 05-Strands-Advanced-Memory-MultiAgent

---

## 1. Chat SDK to AgentCore Runtime Data Flow

### 1.1 End-to-End Sequence Diagram

```
User          Chat SDK       API Gateway     Tenant        AgentCore     Strands       Bedrock
(Slack)       (ECS)          (WS+REST)       Router        Runtime       Agent         LLM
  |              |               |              |              |            |            |
  |--@mention--->|               |              |              |            |            |
  |              |--HTTP POST--->|              |              |            |            |
  |              |  (SSE stream) |              |              |            |            |
  |              |               |--JWT verify->|              |            |            |
  |              |               |              |--lookup----->|            |            |
  |              |               |              |  tenant cfg  |            |            |
  |              |               |              |<--config-----|            |            |
  |              |               |<--route------|              |            |            |
  |              |               |                             |            |            |
  |              |               |---InvokeAgentRuntime------->|            |            |
  |              |               |   (SigV4, sessionId,        |            |            |
  |              |               |    payload, userId)         |            |            |
  |              |               |                             |--entrypoint>|           |
  |              |               |                             |            |--converse->|
  |              |               |                             |            |<-stream----|
  |              |               |                             |            |            |
  |              |               |                             |  [tool call detected]   |
  |              |               |                             |            |--MCP call->|
  |              |               |                             |            |  (Gateway) |
  |              |               |                             |            |<-result----|
  |              |               |                             |            |--converse->|
  |              |               |                             |            |<-stream----|
  |              |               |                             |<-chunks----|            |
  |              |               |<-------SSE stream-----------|            |            |
  |              |<--DSP events--|               |              |            |            |
  |              |  (text-delta, |               |              |            |            |
  |              |   tool-result)|               |              |            |            |
  |<--stream-----|               |              |              |            |            |
  |  (post+edit) |               |              |              |            |            |
```

### 1.2 Data Flow Phases

**Phase 1: Ingress (Platform to Chat SDK)**

The Chat SDK receives platform-specific webhook events (Slack `event_callback`, Discord gateway event, Teams Bot Framework activity) and normalizes them into a unified `thread` + `message` object. The adapter handles:

- Platform authentication (Slack signing secret verification, Discord public key validation)
- Message normalization (attachments, mentions, thread context)
- Deduplication via `StateAdapter` (Redis/DynamoDB-backed)

**Phase 2: Tenant Resolution (Chat SDK to API Gateway)**

```typescript
// Chat SDK handler extracts tenant context
bot.onNewMention(async (thread, message) => {
  const tenantId = await resolveTenant(thread.platformId, thread.channelId);
  const agentConfig = await getTenantConfig(tenantId);

  const transport = new DefaultChatTransport({
    api: `${API_GATEWAY_URL}/tenants/${tenantId}/chat`,
    headers: () => ({
      Authorization: `Bearer ${getCognitoToken(tenantId)}`,
      'X-Platform-User-Id': message.sender.id,
      'X-Platform-Type': thread.adapter.name,
      'X-Thread-Id': thread.id,
    }),
  });

  // Stream agent response back to platform
  const result = await fetch(transport.api, {
    method: 'POST',
    headers: transport.headers(),
    body: JSON.stringify({
      messages: [{ role: 'user', content: message.text }],
      sessionId: thread.id,
    }),
  });

  // Pipe SSE stream to platform
  await thread.post(streamToText(result.body));
});
```

**Phase 3: Agent Execution (API Gateway to AgentCore)**

API Gateway validates the JWT, extracts `tenantId`, and invokes the AgentCore Runtime endpoint:

```python
# API Gateway Lambda authorizer extracts tenant context
# Then routes to the correct AgentCore Runtime

response = agentcore_data_client.invoke_agent_runtime(
    agentRuntimeArn=tenant_config['runtime_arn'],
    payload=json.dumps({
        'prompt': user_message,
        'actor_id': platform_user_id,
        'memory_id': tenant_config['memory_id'],
    }).encode(),
    contentType='application/json',
    runtimeSessionId=session_id,
)
```

**Phase 4: Response Streaming (AgentCore to Platform)**

The AgentCore Runtime streams chunks back through the API Gateway. A translation layer converts the AgentCore streaming format to the AI SDK Data Stream Protocol (SSE), which the Chat SDK consumes and delivers to the originating platform.

### 1.3 Critical Design Decision: SSE Bridge Layer

The synthesis document proposes API Gateway WebSocket + REST + SSE. However, the actual data flow requires a **streaming bridge service** because:

1. AgentCore Runtime returns a streaming HTTP response (chunked transfer encoding)
2. The AI SDK expects SSE with the `x-vercel-ai-ui-message-stream: v1` header
3. API Gateway HTTP APIs support SSE passthrough, but WebSocket APIs do not natively produce SSE

**Recommendation:** Deploy a lightweight **ECS Fargate bridge service** (Node.js or Python) that:
- Accepts SSE connections from Chat SDK / web clients
- Invokes AgentCore Runtime via boto3 streaming
- Translates AgentCore chunks to Data Stream Protocol events
- Handles session affinity via DynamoDB

```python
# Bridge service (FastAPI)
@app.post("/tenants/{tenant_id}/chat")
async def chat_endpoint(tenant_id: str, request: Request):
    body = await request.json()

    async def generate():
        yield f'data: {{"type":"start","messageId":"{msg_id}"}}\n\n'
        yield f'data: {{"type":"text-start","id":"t1"}}\n\n'

        response = agentcore_client.invoke_agent_runtime(
            agentRuntimeArn=get_runtime_arn(tenant_id),
            payload=json.dumps(body).encode(),
            runtimeSessionId=body.get('sessionId'),
        )

        for event in response['response']:
            chunk = event.get('data', b'').decode()
            if chunk:
                escaped = json.dumps(chunk)[1:-1]  # escape for JSON
                yield f'data: {{"type":"text-delta","id":"t1","delta":"{escaped}"}}\n\n'

        yield f'data: {{"type":"text-end","id":"t1"}}\n\n'
        yield f'data: {{"type":"finish","messageId":"{msg_id}","finishReason":"stop"}}\n\n'
        yield 'data: [DONE]\n\n'

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"x-vercel-ai-ui-message-stream": "v1"},
    )
```

---

## 2. Vercel Data Stream Protocol on AWS

### 2.1 Protocol Specification

The AI SDK Data Stream Protocol is SSE-based with typed JSON objects. Key event types for Chimera:

| Event Type | Purpose | When Emitted |
|-----------|---------|-------------|
| `start` | Begin new assistant message | On agent invocation start |
| `text-start` | Begin text content block | On first text token |
| `text-delta` | Incremental text chunk | Per token/chunk from LLM |
| `text-end` | Complete text block | When LLM finishes text |
| `tool-input-start` | Begin tool call | When agent invokes a tool |
| `tool-input-delta` | Tool argument streaming | For large tool inputs |
| `tool-result` | Tool execution result | After tool completes |
| `reasoning-start/delta/end` | Chain-of-thought | When reasoning is streamed |
| `source` | RAG citation | When knowledge base sources are returned |
| `data-*` | Custom typed data | For AG-UI updates (progress, status) |
| `finish` | Complete message | On agent completion |

### 2.2 AWS Implementation Architecture

```
                    Web Client               Chat SDK (Slack/Teams/Discord)
                       |                              |
                  useChat hook                 bot.onNewMention
                       |                              |
                 DefaultChatTransport          HTTP POST + SSE
                       |                              |
                       +--------- ALB ----------------+
                                  |
                          ECS Fargate Service
                          (SSE Bridge + Tenant Router)
                                  |
                    +-------------+-------------+
                    |                           |
              AgentCore Runtime           AgentCore Gateway
              (invoke_agent_runtime)      (MCP tools/list, tools/call)
                    |                           |
              Strands Agent              MCP Tool Targets
              (streaming chunks)         (Lambda, OpenAPI, MCP servers)
```

### 2.3 WebSocket to SSE Bridge Pattern

For platforms requiring persistent connections (web clients with long sessions), deploy an API Gateway WebSocket API alongside the SSE endpoint:

```typescript
// WebSocket handler (Lambda)
export async function handler(event: APIGatewayProxyEvent) {
  const { connectionId, routeKey } = event.requestContext;

  if (routeKey === '$connect') {
    // Store connection in DynamoDB
    await saveConnection(connectionId, event.queryStringParameters?.tenantId);
    return { statusCode: 200 };
  }

  if (routeKey === 'sendmessage') {
    const body = JSON.parse(event.body!);

    // Invoke AgentCore and stream back via WebSocket
    const response = await invokeAgentRuntime(body);

    for await (const chunk of response) {
      await apiGatewayManagement.postToConnection({
        ConnectionId: connectionId,
        Data: JSON.stringify({
          type: 'text-delta',
          id: 't1',
          delta: chunk,
        }),
      });
    }

    await apiGatewayManagement.postToConnection({
      ConnectionId: connectionId,
      Data: JSON.stringify({ type: 'finish', finishReason: 'stop' }),
    });
  }
}
```

### 2.4 Latency Budget

End-to-end streaming latency target: **< 500ms to first token** (user-perceived).

| Segment | Budget | Notes |
|---------|--------|-------|
| Platform webhook delivery | 50-200ms | Slack: ~100ms, Discord: ~50ms |
| Chat SDK processing | 10-30ms | Message normalization |
| ALB + ECS routing | 5-15ms | With sticky sessions |
| SSE bridge to AgentCore | 50-100ms | SigV4 signing + connection |
| AgentCore cold start | 0ms (warm) / 2-5s (cold) | MicroVM provisioning |
| Bedrock first token | 200-800ms | Model-dependent |
| Return path | 20-50ms | SSE chunk delivery |

**Optimization:** Keep AgentCore sessions warm with ping handlers returning `HEALTHY_BUSY` during active conversations. Use session affinity in the ALB to route returning users to the same bridge instance.

---

## 3. MCP Tool Ecosystem

### 3.1 Tenant MCP Tool Registration Flow

```
Tenant Admin          Platform API         AgentCore          DynamoDB        S3
     |                     |               Gateway              |             |
     |--register tool----->|                  |                  |             |
     |  (name, type,       |                  |                  |             |
     |   endpoint, auth)   |                  |                  |             |
     |                     |--validate-------->|                 |             |
     |                     |  schema           |                 |             |
     |                     |                   |                 |             |
     |                     |--create_gateway-->|                 |             |
     |                     |  _target          |                 |             |
     |                     |                   |                 |             |
     |                     |  [if MCP server]  |                 |             |
     |                     |--synchronize----->|                 |             |
     |                     |  _gateway_targets |                 |             |
     |                     |                   |                 |             |
     |                     |--store config-----|---------------->|             |
     |                     |  tenant tool      |                 |             |
     |                     |  metadata         |                 |             |
     |                     |                   |                 |             |
     |                     |  [if skill with   |                 |             |
     |                     |   code artifact]  |                 |             |
     |                     |--upload-----------|-----------------|------------>|
     |                     |  skill code       |                 |             |
     |                     |                   |                 |             |
     |<--tool registered---|                   |                 |             |
     |  (tool_id, gateway  |                   |                 |             |
     |   endpoint)         |                   |                 |             |
```

### 3.2 Tool Target Types

AgentCore Gateway supports five target types, each suited to different integration patterns:

| Target Type | Best For | Auth | Latency |
|------------|---------|------|---------|
| **Lambda** | Stateless tools, event-driven | IAM | Cold: 1-3s, Warm: <100ms |
| **OpenAPI** | Existing REST APIs | OAuth2, API Key | Depends on backend |
| **MCP Server** | Existing MCP servers (Streamable HTTP) | OAuth2, None | Depends on server |
| **API Gateway** | Existing API Gateway APIs | IAM, API Key | <100ms |
| **Smithy Model** | AWS service integrations | IAM | Varies |

### 3.3 Per-Tenant Gateway Architecture

```
Tenant A Gateway                    Tenant B Gateway
(gateway-tenant-a)                  (gateway-tenant-b)
      |                                   |
+-----+-----+-----+             +--------+--------+
|     |     |     |             |        |        |
Lambda  MCP   OpenAPI          Lambda   MCP     Smithy
(CRM)  (Jira) (Stripe)        (SAP)   (GitHub) (S3)
```

Each tenant gets a dedicated AgentCore Gateway with isolated targets. The gateway URL is stored in the tenant's DynamoDB configuration:

```python
# DynamoDB tenant config
{
    "PK": "TENANT#acme",
    "SK": "CONFIG",
    "gateway_id": "gw-acme-123",
    "gateway_url": "https://bedrock-agentcore-gateway.us-east-1.amazonaws.com/gateways/gw-acme-123/mcp",
    "tools": [
        {
            "target_id": "tgt-crm",
            "name": "CRM Tools",
            "type": "LAMBDA",
            "tools": ["get_customer", "update_customer", "search_customers"]
        },
        {
            "target_id": "tgt-jira",
            "name": "Jira MCP",
            "type": "MCP_SERVER",
            "tools": ["create_issue", "search_issues", "update_issue"]
        }
    ]
}
```

### 3.4 Tool Discovery at Agent Startup

When a Strands agent starts for a tenant, it connects to the tenant's gateway and discovers available tools:

```python
from strands import Agent
from strands.tools.mcp import MCPClient

def create_tenant_agent(tenant_id: str, session_id: str) -> Agent:
    config = get_tenant_config(tenant_id)

    # Connect to tenant's MCP gateway
    mcp_client = MCPClient(
        endpoint=config['gateway_url'],
        auth_headers=get_gateway_auth_headers(tenant_id)
    )

    # Semantic search enabled: agent can discover tools by description
    tools = mcp_client.list_tools()

    return Agent(
        model=config.get('model', 'us.anthropic.claude-sonnet-4-6-v1:0'),
        system_prompt=load_system_prompt(tenant_id),
        tools=[*CORE_TOOLS, *tools],  # Core tools + tenant MCP tools
        session_manager=create_session_manager(tenant_id, session_id),
    )
```

### 3.5 Semantic Tool Search

With `searchType: "SEMANTIC"` enabled on the gateway, the built-in `x_amz_bedrock_agentcore_search` tool allows natural language discovery across hundreds of tools:

```python
# Agent can discover tools dynamically
result = agent("Find a tool that can create Jira tickets and use it to file a bug report")
# Gateway semantic search matches "create_issue" from Jira MCP target
```

This is critical for tenants with large tool catalogs (20+ tools) where listing all tools in the system prompt would consume excessive context.

---

## 4. A2A Protocol for Cross-Tenant and Cross-Service Communication

### 4.1 Architecture

```
Tenant A                              Tenant B
AgentCore Runtime                     AgentCore Runtime
  |                                      |
  Strands Agent                          Strands Agent
  |                                      |
  A2AAgent (client)  ---HTTP/A2A--->  A2AServer
  |                                      |
  "Ask Tenant B's                    "I received a request
   research agent                     from Tenant A's agent"
   for market data"
```

### 4.2 Cross-Tenant A2A Pattern

```python
# Tenant A's agent can call Tenant B's agent as a tool
from strands.agent.a2a_agent import A2AAgent

# A2A endpoint is the AgentCore Runtime with A2A protocol
remote_research = A2AAgent(
    endpoint="https://agentcore.us-east-1.amazonaws.com/runtimes/tenant-b-research/a2a",
    name="research_partner",
)

# Use in a graph with local + remote agents
builder = GraphBuilder()
builder.add_node(local_analyst, "analyze")
builder.add_node(remote_research, "research")  # Remote A2A agent
builder.add_node(report_writer, "report")

builder.add_edge("research", "analyze")
builder.add_edge("analyze", "report")
```

### 4.3 Cross-Service Agent Communication

For Chimera platform services that need agent intelligence:

```python
# Cron scheduler service calls an agent via A2A
from strands.multiagent.a2a import A2AServer
from bedrock_agentcore.runtime import serve_a2a

# Deploy agent as A2A server on AgentCore Runtime
agent = Agent(
    system_prompt="You process scheduled tasks.",
    tools=[email_reader, summarizer, slack_notifier],
)

# serve_a2a wraps the agent with A2A protocol
serve_a2a(StrandsA2AExecutor(agent))
```

### 4.4 A2A Security Between Tenants

Cross-tenant A2A requires explicit authorization:

```cedar
// Cedar policy: Tenant A can invoke Tenant B's research agent
permit(
    principal in Tenant::"acme",
    action == Action::"a2a_invoke",
    resource == AgentRuntime::"tenant-b-research"
) when {
    context.request_type == "research_query"
};
```

### 4.5 A2A vs Direct Agent Invocation

| Aspect | A2A Protocol | Direct InvokeAgentRuntime |
|--------|-------------|--------------------------|
| Discovery | AgentCard (name, skills, capabilities) | Must know ARN |
| Protocol | HTTP + JSON-RPC (standardized) | AWS SigV4 + binary payload |
| Streaming | Supported (async iterator) | Supported (chunked response) |
| Cross-platform | Any A2A client (Google ADK, LangGraph) | AWS SDK only |
| Auth | HTTP auth (Bearer, mTLS) | IAM SigV4 |
| Best for | Cross-organization, multi-framework | Same-account, same-framework |

**Recommendation:** Use A2A for cross-tenant and cross-service communication. Use direct `InvokeAgentRuntime` for intra-tenant operations (subagents, cron jobs).

---

## 5. AG-UI Protocol for Real-Time Agent UI Updates

### 5.1 What is AG-UI?

AG-UI (Agent-Generative UI) is a protocol for streaming structured UI updates from agents to frontends. AgentCore supports it natively via `serve_ag_ui`.

### 5.2 AG-UI in Chimera

```python
from bedrock_agentcore.runtime import serve_ag_ui

@serve_ag_ui
async def handler(request):
    agent = create_tenant_agent(request['tenant_id'], request['session_id'])

    # AG-UI events are automatically generated from agent execution
    async for event in agent.stream_async(request['prompt']):
        yield event  # Includes tool calls, text, status updates
```

### 5.3 AG-UI Event Mapping to Data Stream Protocol

AG-UI events can be translated to AI SDK Data Stream Protocol custom data parts:

| AG-UI Event | Data Stream Mapping | UI Rendering |
|------------|-------------------|-------------|
| `tool_call_start` | `data-tool-status` (transient) | "Searching CRM..." spinner |
| `tool_call_end` | `tool-result` | Tool result card |
| `agent_thinking` | `reasoning-delta` | Chain-of-thought display |
| `progress_update` | `data-progress` (transient) | Progress bar |
| `agent_handoff` | `data-handoff` (transient) | "Transferring to specialist..." |

```typescript
// Web client rendering AG-UI events via Data Stream Protocol
const { messages } = useChat({
  transport: new DefaultChatTransport({ api: '/api/chat' }),
});

// Custom data part renderer
function renderPart(part: UIMessagePart) {
  if (part.type === 'data-tool-status' && !part.transient) {
    return <ToolStatusCard tool={part.data.toolName} status={part.data.status} />;
  }
  if (part.type === 'data-progress') {
    return <ProgressBar value={part.data.progress} label={part.data.label} />;
  }
  if (part.type === 'data-handoff') {
    return <HandoffNotice from={part.data.from} to={part.data.to} />;
  }
}
```

### 5.4 AG-UI for Chat Platforms

Chat platforms cannot render arbitrary UI components. Map AG-UI events to platform-native formats:

| AG-UI Event | Slack | Discord | Teams |
|------------|-------|---------|-------|
| Progress | Emoji reactions (hourglass, checkmark) | Embed with progress | Adaptive Card |
| Tool status | Thread reply with tool name | Embed field | Card section |
| Handoff | Thread reply: "Transferring to..." | Embed with new agent name | Card update |
| Structured output | Block Kit | Embed | Adaptive Card |

---

## 6. Cross-Platform Identity Linking

### 6.1 Identity Model

```
DynamoDB: chimera-identities

PK                          SK                      Attributes
TENANT#acme                 USER#u-001              displayName, email, role, created
TENANT#acme#USER#u-001      PLATFORM#slack#U123     slackUserId, slackTeamId, linked
TENANT#acme#USER#u-001      PLATFORM#discord#D456   discordUserId, guildId, linked
TENANT#acme#USER#u-001      PLATFORM#web#w789       cognitoSub, linked
TENANT#acme#USER#u-001      PLATFORM#teams#T012     teamsUserId, tenantId, linked
```

### 6.2 Identity Resolution Flow

```
Incoming message (Slack, user U123)
        |
        v
Lookup: PK=TENANT#acme#USER#*, SK=PLATFORM#slack#U123
        |
        v
Found: unified_user_id = u-001
        |
        v
Agent invoked with actor_id = u-001
        |
        v
Memory/session keyed by u-001 (cross-platform continuity)
```

### 6.3 Identity Linking API

```typescript
// REST API for identity linking
POST /api/tenants/{tenantId}/identities
{
  "displayName": "Alice Smith",
  "email": "alice@acme.com",
  "platforms": {
    "slack": { "userId": "U123ABC", "teamId": "T456DEF" },
    "discord": { "userId": "789012345", "guildId": "567890123" },
    "web": { "cognitoSub": "abc-123-def" }
  }
}

// Auto-linking via email matching
POST /api/tenants/{tenantId}/identities/auto-link
{
  "platform": "slack",
  "platformUserId": "U123ABC",
  "email": "alice@acme.com"  // Match against existing identity
}
```

### 6.4 Session Continuity Across Platforms

When identity is linked, the same `session_id` (derived from `user_id + thread_context`) is used regardless of platform:

```python
def resolve_session_id(tenant_id: str, user_id: str, thread_id: str) -> str:
    """Generate a deterministic session ID for cross-platform continuity."""
    # Same user, same thread context = same session
    return f"{tenant_id}:{user_id}:{thread_id}"

# Slack message from U123 in thread T1 -> session "acme:u-001:T1"
# Discord message from D456 in thread T1 -> session "acme:u-001:T1" (same!)
# Web chat from w789 in chat C1 -> session "acme:u-001:C1" (different thread)
```

---

## 7. Multi-Provider LLM Routing Architecture

### 7.1 Three-Layer Routing Stack

```
Layer 1: Strands Provider Selection
  |
  +-- BedrockModel (default, 17+ models)
  +-- OpenAIModel (GPT-4o, o3)
  +-- AnthropicModel (direct API)
  +-- OllamaModel (local models)
  +-- SAGEMakerModel (custom fine-tunes)
  |
Layer 2: LiteLLM Universal Proxy (optional)
  |
  +-- 100+ providers via OpenAI-compatible API
  +-- Deployed as ECS Fargate service
  +-- Used for providers not in Strands
  |
Layer 3: Bedrock Cross-Region Inference
  |
  +-- us.anthropic.claude-sonnet-4-6-v1:0 (US routing)
  +-- eu.anthropic.claude-sonnet-4-6-v1:0 (EU routing)
  +-- global.anthropic.claude-sonnet-4-6-v1:0 (global routing)
```

### 7.2 Tenant Model Configuration

```python
# DynamoDB tenant model config
{
    "PK": "TENANT#acme",
    "SK": "MODEL_CONFIG",
    "models": {
        "default": {
            "provider": "bedrock",
            "model_id": "us.anthropic.claude-sonnet-4-6-v1:0",
        },
        "complex": {
            "provider": "bedrock",
            "model_id": "us.anthropic.claude-opus-4-6-v1:0",
        },
        "fast": {
            "provider": "bedrock",
            "model_id": "us.amazon.nova-lite-v1:0",
        },
        "local": {
            "provider": "litellm",
            "model_id": "ollama/llama3.2",
            "endpoint": "https://litellm.internal:4000",
        }
    },
    "routing_strategy": "cost_optimized",
    "fallback_chain": ["default", "fast"],
    "budget_limit_monthly_usd": 500.0
}
```

### 7.3 Model Selection at Runtime

```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.models.openai import OpenAIModel

def select_model(tenant_config: dict, task_complexity: str):
    """Select model based on tenant config and task complexity."""
    model_key = {
        'simple': 'fast',
        'moderate': 'default',
        'complex': 'complex',
    }.get(task_complexity, 'default')

    model_config = tenant_config['models'].get(model_key,
                   tenant_config['models']['default'])

    if model_config['provider'] == 'bedrock':
        return BedrockModel(model_config['model_id'])
    elif model_config['provider'] == 'litellm':
        return OpenAIModel(
            model_id=model_config['model_id'],
            base_url=model_config['endpoint'],
        )
    # ... other providers

    return BedrockModel(tenant_config['models']['default']['model_id'])
```

### 7.4 Fallback Chain

```python
async def invoke_with_fallback(tenant_config: dict, prompt: str) -> str:
    """Try models in fallback chain order."""
    for model_key in tenant_config.get('fallback_chain', ['default']):
        model_config = tenant_config['models'][model_key]
        try:
            model = create_model(model_config)
            agent = Agent(model=model, tools=tenant_tools)
            return str(agent(prompt))
        except (ThrottlingException, ServiceUnavailableException):
            continue
    raise AllModelsExhaustedError("All models in fallback chain failed")
```

### 7.5 Cost Tracking

Per-tenant model usage tracked via AgentCore observability + CloudWatch:

```python
# Custom metric emitted after each invocation
cloudwatch.put_metric_data(
    Namespace='Chimera/ModelUsage',
    MetricData=[{
        'MetricName': 'TokensConsumed',
        'Value': usage.total_tokens,
        'Unit': 'Count',
        'Dimensions': [
            {'Name': 'TenantId', 'Value': tenant_id},
            {'Name': 'ModelId', 'Value': model_id},
            {'Name': 'TaskType', 'Value': task_type},
        ],
    }]
)
```

---

## 8. Streaming Architecture

### 8.1 Full Stack Streaming Path

```
Bedrock LLM
  | (token-by-token via Bedrock Converse Stream API)
  v
Strands Agent (callback_handler or stream_async)
  | (event dict: {data, current_tool_use, result, ...})
  v
AgentCore Runtime (BedrockAgentCoreApp entrypoint)
  | (async generator yielding {event, data} dicts)
  v
AgentCore Data Plane (streaming HTTP response)
  | (chunked transfer encoding, binary chunks)
  v
SSE Bridge Service (ECS Fargate)
  | (translates to Data Stream Protocol SSE)
  v
Chat SDK / Web Client
  | (platform-specific delivery)
  v
User (Slack: native streaming / Teams: post+edit / Discord: post+edit)
```

### 8.2 Platform Streaming Capabilities

| Platform | Native Streaming | Fallback | Perceived Latency |
|---------|-----------------|----------|-------------------|
| Web (useChat) | SSE, token-by-token | N/A | Excellent |
| Slack | `chat.startStream` + `append` | `postMessage` + `update` | Good |
| Discord | Post + edit (every 500ms) | Single message on complete | Moderate |
| Teams | Post + edit (every 1s) | Single message on complete | Moderate |
| Telegram | `sendMessage` + `editMessageText` | Single message on complete | Good |
| WhatsApp | Not supported | Single message on complete | Acceptable |

### 8.3 Streaming Mode Configuration

```typescript
// Chat SDK streaming configuration per platform
const STREAMING_CONFIG: Record<string, StreamConfig> = {
  slack: { mode: 'native', minChunkSize: 1 },
  discord: { mode: 'edit', editInterval: 500, maxLength: 2000 },
  teams: { mode: 'edit', editInterval: 1000, maxLength: 28000 },
  telegram: { mode: 'edit', editInterval: 300, maxLength: 4096 },
  whatsapp: { mode: 'buffer', maxLength: 4096 },
  web: { mode: 'sse', protocol: 'data-stream-v1' },
};
```

### 8.4 Backpressure Handling

When platform rate limits are hit during streaming:

```typescript
class RateLimitedStreamWriter {
  private buffer: string[] = [];
  private flushTimer: NodeJS.Timer | null = null;

  async write(chunk: string, thread: Thread) {
    this.buffer.push(chunk);

    if (!this.flushTimer) {
      this.flushTimer = setInterval(async () => {
        const text = this.buffer.join('');
        this.buffer = [];

        try {
          await thread.editLastMessage(text);
        } catch (e) {
          if (isRateLimited(e)) {
            // Back off, buffer will accumulate
            await sleep(e.retryAfter * 1000);
          }
        }
      }, this.config.editInterval);
    }
  }
}
```

---

## 9. Webhook and Event Integration Patterns

### 9.1 Inbound Webhook Architecture

```
Platform Webhooks                    EventBridge
(Slack, Discord, Teams, etc.)        (internal events)
        |                                  |
        v                                  v
   ALB (path-based routing)          EventBridge Rules
        |                                  |
   +----+----+----+----+            +------+------+
   |    |    |    |    |            |      |      |
  /slack /discord /teams /telegram  cron  skill   alert
   |    |    |    |    |            |    install  trigger
   v    v    v    v    v            v      v      v
   Chat SDK Webhook Handlers     Step Functions / Lambda
```

### 9.2 Outbound Event Patterns

Agents can emit events for external systems:

```python
@tool
def notify_systems(event_type: str, payload: dict) -> str:
    """Emit an event to external systems via EventBridge."""
    eventbridge.put_events(Entries=[{
        'Source': f'chimera.tenant.{tenant_id}',
        'DetailType': event_type,
        'Detail': json.dumps(payload),
        'EventBusName': 'chimera-events',
    }])
    return f"Event {event_type} emitted"
```

### 9.3 Event-Driven Agent Invocation

```python
# EventBridge rule triggers agent via Step Functions
{
    "source": ["chimera.cron", "chimera.webhook", "chimera.alert"],
    "detail-type": ["scheduled-task", "github-push", "pagerduty-alert"],
    "detail": {
        "tenant_id": ["acme"]
    }
}

# Step Function:
# 1. Load tenant config from DynamoDB
# 2. Invoke AgentCore Runtime with event payload
# 3. Route output to configured channels (Slack, email, S3)
# 4. Update job status in DynamoDB
```

### 9.4 Webhook Security

| Platform | Verification Method |
|---------|-------------------|
| Slack | HMAC-SHA256 with signing secret |
| Discord | Ed25519 public key verification |
| Teams | Bot Framework token validation |
| Telegram | Secret token in URL path |
| GitHub | HMAC-SHA256 with webhook secret |
| Generic | API key in header or HMAC |

All webhook secrets stored in AWS Secrets Manager, rotated via Lambda.

---

## 10. OpenClaw Gateway Migration

### 10.1 OpenClaw Gateway Component Mapping

OpenClaw's Gateway daemon (Node.js, port 18789) provides 23+ channel adapters, session management, streaming, and routing in a single process. Chimera replaces this with distributed AWS services:

| OpenClaw Gateway Component | Chimera Replacement | Migration Complexity |
|---------------------------|---------------------|---------------------|
| Channel Bridges (23+ adapters) | Chat SDK (8 adapters) + custom adapters | **Medium** - Chat SDK covers top 8; Signal, Matrix, iMessage need custom |
| WebSocket Server (96+ RPC methods) | API Gateway WebSocket + SSE Bridge | **High** - Protocol translation required |
| Session Manager (JSONL on disk) | DynamoDB + AgentCore Memory | **Low** - Better persistence |
| Command Queue | SQS + EventBridge | **Low** - Standard pattern |
| Hooks Engine | EventBridge Rules + Step Functions | **Medium** - Event mapping |
| Cron Scheduler | EventBridge Scheduler | **Low** - Direct replacement |
| Heartbeat System | AgentCore ping handler + CloudWatch | **Low** |
| Auth + Trust (pairing) | Cognito + DynamoDB | **Medium** - Pairing flow needs reimplementation |
| OpenAI-Compatible API | API Gateway + Lambda | **Low** - Standard REST |
| OpenResponses API | API Gateway + Lambda | **Low** - Standard REST |

### 10.2 Channel Adapter Migration Matrix

| OpenClaw Channel | Chat SDK Adapter | Gap | Migration Path |
|-----------------|-----------------|-----|----------------|
| Slack | `@chat-adapter/slack` | None - full feature parity | Direct migration |
| Discord | `@chat-adapter/discord` | No modals (minor) | Direct migration |
| Teams | `@chat-adapter/teams` | Read-only reactions | Direct migration |
| Telegram | `@chat-adapter/telegram` | Partial card support | Direct migration, custom cards |
| WhatsApp | `@chat-adapter/whatsapp` | No streaming | Direct migration |
| Google Chat | `@chat-adapter/gchat` | No modals | Direct migration |
| GitHub | `@chat-adapter/github` | No streaming, no DMs | Direct migration |
| Linear | `@chat-adapter/linear` | No streaming | Direct migration |
| Signal | None | Full gap | Custom adapter or community |
| iMessage | None | Full gap | macOS-only, low priority |
| Matrix | None | Full gap | Custom adapter via matrix-js-sdk |
| IRC | None | Full gap | Custom adapter, low priority |
| Nostr | None | Full gap | Custom adapter, niche |
| Feishu/Lark | None | Full gap | Custom adapter for CN market |
| Webex | None | Full gap | Custom adapter |

**Coverage:** Chat SDK covers **8 of 23** OpenClaw channels natively, but these 8 represent **~95% of enterprise usage** (Slack, Teams, Discord, Telegram, WhatsApp, Google Chat, GitHub, Linear).

### 10.3 Custom Adapter Pattern

For platforms not covered by Chat SDK, implement the Chat SDK adapter interface:

```typescript
import { ChatAdapter, Thread, Message } from 'chat';

class MatrixAdapter implements ChatAdapter {
  name = 'matrix';

  constructor(private config: { homeserver: string; accessToken: string }) {}

  async start(): Promise<void> {
    // Connect to Matrix homeserver via matrix-js-sdk
    this.client = sdk.createClient({
      baseUrl: this.config.homeserver,
      accessToken: this.config.accessToken,
    });
    await this.client.startClient();
  }

  async sendMessage(thread: Thread, content: string): Promise<void> {
    await this.client.sendTextMessage(thread.channelId, content);
  }

  async editMessage(thread: Thread, messageId: string, content: string): Promise<void> {
    await this.client.sendEvent(thread.channelId, 'm.room.message', {
      body: content,
      'm.relates_to': { rel_type: 'm.replace', event_id: messageId },
    });
  }

  // ... implement remaining ChatAdapter methods
}
```

### 10.4 OpenClaw API Compatibility Layer

For clients using OpenClaw's WebSocket or REST APIs, provide a compatibility shim:

```typescript
// OpenAI-compatible endpoint (same as OpenClaw's /v1/chat/completions)
app.post('/v1/chat/completions', async (req, res) => {
  const { messages, model, stream } = req.body;
  const tenantId = extractTenantFromAuth(req);

  if (stream) {
    // Invoke AgentCore and stream as OpenAI SSE format
    const response = await invokeAgent(tenantId, messages);
    res.setHeader('Content-Type', 'text/event-stream');
    for await (const chunk of response) {
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: chunk } }]
      })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    const result = await invokeAgentSync(tenantId, messages);
    res.json({
      choices: [{ message: { role: 'assistant', content: result } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
});
```

---

## 11. Concrete API Design

### 11.1 REST API Endpoints

```
POST   /api/v1/tenants/{tenantId}/chat          # SSE streaming chat
POST   /api/v1/tenants/{tenantId}/chat/sync      # Synchronous chat
GET    /api/v1/tenants/{tenantId}/sessions        # List sessions
GET    /api/v1/tenants/{tenantId}/sessions/{id}   # Get session history
DELETE /api/v1/tenants/{tenantId}/sessions/{id}   # Delete session

POST   /api/v1/tenants/{tenantId}/tools           # Register MCP tool
GET    /api/v1/tenants/{tenantId}/tools            # List tools
DELETE /api/v1/tenants/{tenantId}/tools/{toolId}   # Remove tool

POST   /api/v1/tenants/{tenantId}/skills           # Install skill
GET    /api/v1/tenants/{tenantId}/skills            # List skills
DELETE /api/v1/tenants/{tenantId}/skills/{skillId}  # Remove skill

POST   /api/v1/tenants/{tenantId}/cron              # Create cron job
GET    /api/v1/tenants/{tenantId}/cron               # List cron jobs
PUT    /api/v1/tenants/{tenantId}/cron/{jobId}       # Update cron job
DELETE /api/v1/tenants/{tenantId}/cron/{jobId}       # Delete cron job

GET    /api/v1/tenants/{tenantId}/identities         # List linked identities
POST   /api/v1/tenants/{tenantId}/identities         # Link identity
DELETE /api/v1/tenants/{tenantId}/identities/{id}    # Unlink identity

# OpenAI-compatible (for drop-in clients)
POST   /v1/chat/completions                          # OpenAI format
POST   /v1/responses                                 # OpenResponses format

# Webhooks (platform-specific paths)
POST   /webhooks/slack                               # Slack events
POST   /webhooks/discord                             # Discord interactions
POST   /webhooks/teams                               # Teams activities
POST   /webhooks/telegram/{botToken}                 # Telegram updates
POST   /webhooks/github                              # GitHub events
POST   /webhooks/generic/{tenantId}                  # Generic webhook
```

### 11.2 WebSocket API

```
WSS  /ws/v1/tenants/{tenantId}/chat

# Client -> Server
{
  "action": "sendMessage",
  "data": {
    "sessionId": "session-001",
    "message": "Hello",
    "options": {
      "stream": true,
      "model": "default"
    }
  }
}

# Server -> Client (streaming)
{ "type": "start", "messageId": "msg-001" }
{ "type": "text-delta", "id": "t1", "delta": "Hello" }
{ "type": "text-delta", "id": "t1", "delta": " there!" }
{ "type": "tool-input-start", "id": "tool1", "toolName": "search" }
{ "type": "tool-result", "id": "tool1", "result": {...} }
{ "type": "text-end", "id": "t1" }
{ "type": "finish", "messageId": "msg-001", "finishReason": "stop" }
```

### 11.3 SSE Chat Endpoint Schema

**Request:**
```json
POST /api/v1/tenants/{tenantId}/chat
Content-Type: application/json
Authorization: Bearer <cognito-jwt>

{
  "messages": [
    { "role": "user", "content": "Analyze last month's sales" }
  ],
  "sessionId": "session-001",
  "options": {
    "model": "default",
    "maxBudgetUsd": 1.0,
    "tools": ["crm", "analytics"],
    "stream": true
  },
  "metadata": {
    "platform": "slack",
    "platformUserId": "U123ABC",
    "threadId": "1234567890.123456"
  }
}
```

**Response (SSE stream):**
```
HTTP/1.1 200 OK
Content-Type: text/event-stream
x-vercel-ai-ui-message-stream: v1
X-Session-Id: session-001

data: {"type":"start","messageId":"msg-abc123"}

data: {"type":"text-start","id":"text_001"}

data: {"type":"text-delta","id":"text_001","delta":"Let me "}

data: {"type":"text-delta","id":"text_001","delta":"analyze "}

data: {"type":"tool-input-start","id":"tool_001","toolName":"query_analytics"}

data: {"type":"tool-input-delta","id":"tool_001","delta":"{\"query\":\"sales last month\"}"}

data: {"type":"tool-result","id":"tool_001","result":{"totalSales":1250000,"growth":"12%"}}

data: {"type":"text-delta","id":"text_001","delta":"Sales were $1.25M, up 12%."}

data: {"type":"text-end","id":"text_001"}

data: {"type":"finish","messageId":"msg-abc123","finishReason":"stop"}

data: [DONE]
```

---

## 12. Architecture Findings and Recommendations

### 12.1 Strengths

1. **Managed service alignment** -- The synthesis correctly maps every OpenClaw component to an AWS managed equivalent, reducing operational burden significantly.

2. **Protocol-first design** -- Using the AI SDK Data Stream Protocol as the universal streaming format enables any client (web, Slack, Discord, custom) to consume agent responses through the same protocol.

3. **MCP as universal tool interface** -- AgentCore Gateway's ability to front Lambda, OpenAPI, API Gateway, and MCP servers behind a single MCP endpoint is elegant and avoids per-tool custom integration.

4. **Multi-agent composability** -- Strands' four orchestration patterns (Agents-as-Tools, Swarm, Graph, Workflow) + A2A for cross-service communication cover the full spectrum of multi-agent use cases.

### 12.2 Risks and Gaps

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **SSE bridge is a new service to build and maintain** | Medium | Keep it thin; consider Lambda streaming with response streaming for simpler deployment |
| **Chat SDK is pre-1.0 (Feb 2026)** | Medium | Pin versions, maintain adapter tests, have fallback to direct platform SDKs |
| **AgentCore cold start (2-5s)** | High for interactive chat | Keep sessions warm via ping handlers; pre-warm on EventBridge schedule |
| **Cross-tenant A2A authorization** | High (security) | Cedar policies + IAM + network isolation; no implicit cross-tenant access |
| **Platform coverage gap (15 channels missing)** | Low for enterprise | 8 Chat SDK channels cover 95% of enterprise use; custom adapters for niche channels |
| **LiteLLM as SPOF for non-Bedrock models** | Medium | Deploy LiteLLM with ECS auto-scaling + health checks; Bedrock as primary fallback |
| **Cost attribution accuracy** | Medium | AgentCore active-consumption billing helps; supplement with custom CloudWatch metrics per tenant per model |

### 12.3 Key Architectural Recommendations

1. **Deploy the SSE Bridge as a separate ECS service** rather than embedding it in the Chat SDK service. This separates the platform webhook handling (stateless) from the streaming connection management (stateful).

2. **Use API Gateway HTTP APIs (not REST APIs)** for the SSE endpoint, as HTTP APIs support streaming responses natively and cost 70% less than REST APIs.

3. **Implement the identity linking table early** -- cross-platform session continuity is a differentiator versus OpenClaw's per-platform identity model.

4. **Start with Bedrock-only LLM routing** and add LiteLLM only when tenants specifically request non-Bedrock models. Strands' native provider support covers most cases.

5. **Use AgentCore Gateway's semantic search** over tool listing in system prompts for tenants with more than 10 tools -- it scales better and reduces prompt token consumption.

6. **Implement the OpenAI-compatible `/v1/chat/completions` endpoint** from day one -- it enables integration with any OpenAI-compatible client and eases migration for existing OpenClaw users.

---

## Related Documents

- [[AWS-Native-OpenClaw-Architecture-Synthesis]] -- Full architecture synthesis
- [[AWS Bedrock AgentCore and Strands Agents/07-Vercel-AI-SDK-Chat-Layer]] -- Chat SDK deep dive
- [[AWS Bedrock AgentCore and Strands Agents/02-AgentCore-APIs-SDKs-MCP]] -- AgentCore APIs
- [[OpenClaw NemoClaw OpenFang/07-Chat-Interface-Multi-Platform]] -- OpenClaw Gateway analysis
- [[AWS Bedrock AgentCore and Strands Agents/05-Strands-Advanced-Memory-MultiAgent]] -- Multi-agent patterns

---

*Integration Architecture Review completed 2026-03-19.*
