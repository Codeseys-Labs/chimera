# AgentCore APIs, SDKs & MCP Integration

> **Series:** [[01-AgentCore-Architecture-Runtime]] | **This Document** | [[03-AgentCore-Multi-Tenancy-Deployment]] | [[04-Strands-Agents-Core]]
> **Last Updated:** 2026-03-19
> **SDK Version:** bedrock-agentcore v1.4.6 (Python), v0.2.2 (TypeScript)
> **Status:** Comprehensive reference covering APIs, SDKs, CLI tools, and MCP integration patterns

---

## Table of Contents

- [[#1. API Architecture Overview]]
- [[#2. Authentication & Authorization]]
- [[#3. Control Plane API]]
- [[#4. Data Plane API]]
- [[#5. Python SDK (bedrock-agentcore)]]
  - [[#5.1 Runtime Module]]
  - [[#5.2 Memory Module]]
  - [[#5.3 Identity Module]]
  - [[#5.4 Gateway Module]]
  - [[#5.5 Code Interpreter Module]]
  - [[#5.6 Browser Module]]
  - [[#5.7 Observability Module]]
- [[#6. TypeScript SDK (bedrock-agentcore)]]
- [[#7. Starter Toolkit CLI]]
- [[#8. MCP Integration Patterns]]
  - [[#8.1 Deploying MCP Servers on AgentCore Runtime]]
  - [[#8.2 AgentCore Gateway as MCP Front Door]]
  - [[#8.3 MCP Server Targets]]
  - [[#8.4 Gateway Tool Discovery & Semantic Search]]
- [[#9. Boto3 Client Reference]]
- [[#10. Agent Invocation & Session Management]]
- [[#11. Protocol Support (A2A, AG-UI)]]
- [[#12. Code Examples - End to End]]
- [[#13. Sources & Links]]

---

## 1. API Architecture Overview

AgentCore exposes two distinct API planes, following the standard AWS separation pattern:

```
                    +---------------------------+
                    |      AWS IAM / SigV4      |
                    +---------------------------+
                             |           |
                    +--------+--+  +-----+--------+
                    | Control    |  | Data          |
                    | Plane API  |  | Plane API     |
                    +------------+  +--------------+
                    | CRUD ops   |  | Invocations  |
                    | for all    |  | Streaming    |
                    | resources  |  | Code exec    |
                    +------------+  +--------------+
                         |                |
              bedrock-agentcore    bedrock-agentcore
              -control             (data plane)
```

### Service Endpoints

| Plane | Service Name | Boto3 Client | Endpoint Pattern |
|-------|-------------|--------------|------------------|
| Control | `bedrock-agentcore-control` | `boto3.client('bedrock-agentcore-control')` | `bedrock-agentcore-control.{region}.amazonaws.com` |
| Data | `bedrock-agentcore` | `boto3.client('bedrock-agentcore')` | `bedrock-agentcore.{region}.amazonaws.com` |

### Available Regions

- US East (N. Virginia) - `us-east-1`
- US West (Oregon) - `us-west-2`
- Asia Pacific (Sydney) - `ap-southeast-2`
- Europe (Frankfurt) - `eu-central-1`

---

## 2. Authentication & Authorization

### IAM-Based Authentication

All AgentCore APIs use standard AWS SigV4 authentication. The IAM principal calling the API must have the appropriate `bedrock-agentcore:*` permissions.

### Key IAM Actions

```
# Runtime
bedrock-agentcore:CreateAgentRuntime
bedrock-agentcore:InvokeAgentRuntime
bedrock-agentcore:ExecuteShellCommand

# Gateway
bedrock-agentcore:CreateGateway
bedrock-agentcore:CreateGatewayTarget
bedrock-agentcore:SynchronizeGatewayTargets

# Memory
bedrock-agentcore:CreateMemory

# Identity
bedrock-agentcore:CreateWorkloadIdentity
bedrock-agentcore:GetWorkloadAccessToken

# Code Interpreter
bedrock-agentcore:CreateCodeInterpreter
bedrock-agentcore:InvokeCodeInterpreter
bedrock-agentcore:StartCodeInterpreterSession

# Browser
bedrock-agentcore:CreateBrowser
bedrock-agentcore:StartBrowserSession
bedrock-agentcore:ConnectBrowserAutomationStream
bedrock-agentcore:ConnectBrowserLiveViewStream
```

### Workload Identity

AgentCore uses **workload identities** for agent-to-service authentication. When you create a Runtime or Gateway, a workload identity is automatically generated. Agents use workload access tokens (AWS-signed opaque tokens) to access first-party AgentCore services.

```python
# Workload access tokens are delivered automatically by Runtime/Gateway
# For manual retrieval:
client = boto3.client('bedrock-agentcore-control')
response = client.create_workload_identity(
    name='my-agent-identity',
    allowedResourceOauth2ReturnUrls=['https://my-callback.example.com']
)
```

### OAuth / JWT Inbound Auth

For gateway and runtime inbound authorization, AgentCore supports Custom JWT authorizers backed by any OIDC-compliant identity provider (Cognito, Auth0, Okta, Azure Entra ID).

---

## 3. Control Plane API

The control plane manages the lifecycle of all AgentCore resources. All operations use the `bedrock-agentcore-control` service.

### Complete Action List

Organized by resource type:

#### Runtime

| Action | Description |
|--------|-------------|
| `CreateAgentRuntime` | Create a new agent runtime from container or code artifact |
| `CreateAgentRuntimeEndpoint` | Create an endpoint for an existing runtime |
| `GetAgentRuntime` | Get runtime details |
| `GetAgentRuntimeEndpoint` | Get endpoint details |
| `ListAgentRuntimes` | List all runtimes in account |
| `ListAgentRuntimeEndpoints` | List endpoints for a runtime |
| `ListAgentRuntimeVersions` | List versions of a runtime |
| `UpdateAgentRuntime` | Update runtime configuration |
| `UpdateAgentRuntimeEndpoint` | Update endpoint configuration |
| `DeleteAgentRuntime` | Delete a runtime |
| `DeleteAgentRuntimeEndpoint` | Delete an endpoint |

#### Gateway

| Action | Description |
|--------|-------------|
| `CreateGateway` | Create an MCP gateway |
| `CreateGatewayTarget` | Add a target (Lambda, OpenAPI, MCP server, API Gateway, Smithy) |
| `GetGateway` | Get gateway details |
| `GetGatewayTarget` | Get target details |
| `ListGateways` | List all gateways |
| `ListGatewayTargets` | List targets for a gateway |
| `UpdateGateway` | Update gateway configuration |
| `UpdateGatewayTarget` | Update target configuration |
| `SynchronizeGatewayTargets` | Sync tool catalog from MCP server targets |
| `DeleteGateway` | Delete a gateway |
| `DeleteGatewayTarget` | Delete a target |

#### Memory

| Action | Description |
|--------|-------------|
| `CreateMemory` | Create a memory resource with strategies |
| `GetMemory` | Get memory details |
| `ListMemories` | List all memories |
| `UpdateMemory` | Update memory configuration |
| `DeleteMemory` | Delete a memory resource |

#### Identity

| Action | Description |
|--------|-------------|
| `CreateWorkloadIdentity` | Create a workload identity |
| `CreateOauth2CredentialProvider` | Create OAuth2 credential provider |
| `CreateApiKeyCredentialProvider` | Create API key credential provider |
| `GetWorkloadIdentity` | Get identity details |
| `ListWorkloadIdentities` | List identities |
| `UpdateWorkloadIdentity` | Update identity |
| `DeleteWorkloadIdentity` | Delete identity |
| `GetTokenVault` | Get token vault details |
| `SetTokenVaultCMK` | Set CMK for token encryption |

#### Code Interpreter

| Action | Description |
|--------|-------------|
| `CreateCodeInterpreter` | Create a code interpreter resource |
| `GetCodeInterpreter` | Get code interpreter details |
| `ListCodeInterpreters` | List code interpreters |
| `DeleteCodeInterpreter` | Delete a code interpreter |

#### Browser

| Action | Description |
|--------|-------------|
| `CreateBrowser` | Create a browser resource |
| `CreateBrowserProfile` | Create a reusable browser profile |
| `GetBrowser` | Get browser details |
| `GetBrowserProfile` | Get browser profile details |
| `ListBrowsers` | List browsers |
| `ListBrowserProfiles` | List browser profiles |
| `DeleteBrowser` | Delete a browser |
| `DeleteBrowserProfile` | Delete a browser profile |

#### Evaluations

| Action | Description |
|--------|-------------|
| `CreateEvaluator` | Create an evaluator |
| `CreateOnlineEvaluationConfig` | Create online evaluation configuration |
| `GetEvaluator` | Get evaluator details |
| `ListEvaluators` | List evaluators |
| `UpdateEvaluator` | Update evaluator |
| `DeleteEvaluator` | Delete evaluator |

#### Policy

| Action | Description |
|--------|-------------|
| `CreatePolicy` | Create a Cedar policy |
| `CreatePolicyEngine` | Create a policy engine |
| `GetPolicy` | Get policy details |
| `GetPolicyEngine` | Get policy engine details |
| `GetPolicyGeneration` | Get policy generation status |
| `StartPolicyGeneration` | Generate policies automatically |
| `ListPolicies` | List policies |
| `ListPolicyEngines` | List policy engines |
| `UpdatePolicy` | Update a policy |
| `UpdatePolicyEngine` | Update a policy engine |
| `DeletePolicy` | Delete a policy |
| `DeletePolicyEngine` | Delete a policy engine |

#### Resource Management

| Action | Description |
|--------|-------------|
| `TagResource` | Add tags to a resource |
| `UntagResource` | Remove tags from a resource |
| `ListTagsForResource` | List tags for a resource |
| `PutResourcePolicy` | Set resource-based policy |
| `GetResourcePolicy` | Get resource-based policy |
| `DeleteResourcePolicy` | Delete resource-based policy |

---

## 4. Data Plane API

The data plane handles runtime invocations and tool execution. All operations use the `bedrock-agentcore` service.

### InvokeAgentRuntime

The primary operation for sending requests to deployed agents.

**Request:**
```
POST /runtimes/{agentRuntimeArn}/invoke?qualifier={qualifier}

Headers:
  Content-Type: application/json
  X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: {sessionId}
  X-Amzn-Bedrock-AgentCore-MCP-Session-Id: {mcpSessionId}
  X-Amzn-Bedrock-AgentCore-MCP-Protocol-Version: {version}
  X-Amzn-Bedrock-AgentCore-Runtime-User-Id: {userId}
  X-Amzn-Bedrock-AgentCore-Trace-Id: {traceId}

Body: binary payload (up to 100 MB)
```

**Response:** Streaming response with partial results in real-time.

**Key Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agentRuntimeArn` | Yes | Full ARN or agent ID + account ID |
| `payload` | Yes | Binary request data (typically JSON-encoded) |
| `qualifier` | No | Target specific endpoint or version |
| `runtimeSessionId` | No | Session ID for conversation continuity |
| `mcpSessionId` | No | MCP protocol session tracking |
| `contentType` | No | Input content type (default: application/json) |

### ExecuteShellCommand

Execute shell commands in an active agent runtime session (for tests, git, builds).

### InvokeCodeInterpreter

Execute code within an active code interpreter session.

**Supported operations:**

| Name | Description |
|------|-------------|
| `executeCode` | Execute code in Python/JS/TS |
| `executeCommand` | Run shell commands |
| `readFiles` | Read files from sandbox |
| `writeFiles` | Write files to sandbox |
| `listFiles` | List files in sandbox |
| `removeFiles` | Remove files from sandbox |
| `startCommandExecution` | Start long-running command |
| `getTask` | Get async task status |
| `stopTask` | Stop a running task |

### Browser Data Plane

| Operation | Description |
|-----------|-------------|
| `StartBrowserSession` | Start a managed browser session |
| `StopBrowserSession` | Stop an active session |
| `ListBrowserSessions` | List active sessions |
| `GetBrowserSession` | Get session details |
| `ConnectBrowserAutomationStream` | WebSocket for Playwright/CDP |
| `ConnectBrowserLiveViewStream` | Live view WebSocket |
| `UpdateBrowserStream` | Update stream configuration |

---

## 5. Python SDK (bedrock-agentcore)

The primary SDK for AgentCore. Framework-agnostic primitives for runtime, memory, authentication, and tools.

```bash
pip install bedrock-agentcore
# Or with extras:
pip install "bedrock-agentcore[a2a]"  # A2A protocol support
```

**Package:** `bedrock-agentcore` on PyPI
**Repository:** [github.com/aws/bedrock-agentcore-sdk-python](https://github.com/aws/bedrock-agentcore-sdk-python)
**Python:** 3.10+ (3.12 recommended)
**License:** Apache 2.0

### SDK Module Map

```
bedrock_agentcore/
  runtime/          # BedrockAgentCoreApp, decorators, context
  memory/           # MemorySessionManager, MemoryClient
    integrations/
      strands/      # AgentCoreMemorySessionManager for Strands
  identity/         # IdentityClient, decorators, OAuth flows
  tools/
    code_interpreter_client.py  # CodeInterpreter, code_session
    browser_client.py           # BrowserClient, browser_session
  observability/    # OpenTelemetry integration
```

---

### 5.1 Runtime Module

The runtime module is the core deployment wrapper. It converts any request handler into an AgentCore-compatible application.

#### BedrockAgentCoreApp

Extends Starlette to provide the HTTP server that AgentCore Runtime expects. Exposes `/invocations` (POST) and `/ping` (GET) endpoints.

```python
from bedrock_agentcore import BedrockAgentCoreApp

app = BedrockAgentCoreApp()
```

#### @app.entrypoint Decorator

Registers the main request handler. The decorated function receives `request` (parsed payload) and `context` (session/request metadata).

```python
from bedrock_agentcore import BedrockAgentCoreApp
from strands import Agent

app = BedrockAgentCoreApp()
agent = Agent()

@app.entrypoint
def handler(request, context):
    prompt = request.get("prompt", "Hello")
    result = agent(prompt)
    return {"response": str(result)}
```

#### Request Context

The `context` object provides session and request metadata:

```python
@app.entrypoint
def handler(request, context):
    session_id = context.session_id       # Runtime session ID
    # Access via BedrockAgentCoreContext
    # Includes: session_id, request headers, workload access token,
    # OAuth2 callback URLs
    return {"session": session_id}
```

#### Synchronous and Asynchronous Handlers

Both sync and async handlers are supported:

```python
# Async handler
@app.entrypoint
async def async_handler(request, context):
    result = await some_async_operation(request["prompt"])
    return {"response": result}
```

#### Streaming Responses

Use async generators for streaming:

```python
@app.entrypoint
async def streaming_handler(request, context):
    for chunk in agent.stream(request["prompt"]):
        yield {"event": "message", "data": {"text": chunk}}
```

#### Async Task Management

For long-running operations (up to 8 hours):

```python
@app.entrypoint
async def long_running_handler(request, context):
    # Register async task
    task_id = app.add_async_task("processing-data")

    # Start background processing
    async def process():
        result = await heavy_computation()
        app.complete_async_task(task_id, result)

    asyncio.create_task(process())

    # Return immediately
    return {"status": "processing", "task_id": task_id}
```

#### Custom Ping Handler

Report agent health status for session management:

```python
@app.ping_handler
def health_check():
    if is_processing_background_task():
        return "HEALTHY_BUSY"  # Don't terminate session
    return "HEALTHY"           # Idle, can terminate after 15 min
```

---

### 5.2 Memory Module

Manages persistent knowledge across sessions with short-term and long-term memory strategies.

#### MemorySessionManager

The primary interface for conversational memory:

```python
from bedrock_agentcore.memory import MemorySessionManager, ConversationalMessage, MessageRole

manager = MemorySessionManager(
    memory_id="my-memory-123",
    region_name="us-east-1"
)

# Store conversation turns
manager.add_turns(
    actor_id="user-456",
    session_id="session-789",
    messages=[
        ConversationalMessage("What is AgentCore?", MessageRole.USER),
        ConversationalMessage("AgentCore is...", MessageRole.ASSISTANT)
    ]
)

# Retrieve conversation history
events = manager.list_events(
    actor_id="user-456",
    session_id="session-789"
)

# Semantic search across long-term memories
results = manager.search_long_term_memories(
    actor_id="user-456",
    query="What did we discuss about deployment?"
)

# Fork a conversation (create branch)
manager.fork_conversation(
    source_session_id="session-789",
    target_session_id="session-new",
    actor_id="user-456"
)
```

#### LLM-Assisted Turn Processing

```python
# Complete a turn with memory context automatically retrieved
response = manager.process_turn_with_llm(
    actor_id="user-456",
    session_id="session-789",
    message="Tell me more about what we discussed"
)
```

#### Legacy MemoryClient

Direct access to boto3 for both control and data plane operations:

```python
from bedrock_agentcore.memory import MemoryClient

memory_client = MemoryClient(region_name="us-east-1")
# Access control plane and data plane methods directly
```

#### Strands Integration

The `AgentCoreMemorySessionManager` integrates with Strands agents for automatic memory management:

```python
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

config = AgentCoreMemoryConfig(
    memory_id="my-memory",
    session_id="session-123",
    actor_id="user-456"
)

session_manager = AgentCoreMemorySessionManager(config)

# Use with Strands Agent
from strands import Agent
agent = Agent(session_manager=session_manager)
```

---

### 5.3 Identity Module

Manages OAuth2 flows, API keys, and workload identity tokens for agent authentication.

#### IdentityClient

```python
from bedrock_agentcore.identity import IdentityClient

identity = IdentityClient(region="us-east-1")

# Get workload access token (auto-delivered in Runtime context)
token = identity.get_workload_access_token()

# OAuth2 token retrieval
oauth_token = identity.get_token(
    provider_name="my-api-provider",
    scopes=["read", "write"],
    auth_flow="M2M"  # or "USER_FEDERATION"
)

# API key retrieval
api_key = identity.get_api_key(provider_name="my-api-key-provider")

# Create OAuth2 credential provider config
identity.create_oauth2_credential_provider(
    name="my-oauth-provider",
    # ... provider configuration
)
```

#### Authentication Decorators

Automatically inject tokens into handler functions:

```python
from bedrock_agentcore.identity import requires_access_token, requires_api_key

@app.entrypoint
@requires_access_token(
    provider_name="salesforce",
    scopes=["api", "refresh_token"],
    auth_flow="M2M"
)
def handler(request, access_token):
    # access_token is automatically fetched and injected
    response = call_salesforce_api(access_token, request["query"])
    return {"result": response}

@app.entrypoint
@requires_api_key(provider_name="stripe-key")
def payment_handler(request, api_key):
    # api_key is automatically fetched and injected
    return process_payment(api_key, request["amount"])
```

#### Local Development

When no workload token is present (local dev), the SDK automatically creates a workload identity and saves it to `.agentcore.json`.

---

### 5.4 Gateway Module

Transform APIs, Lambda functions, and existing services into MCP-compatible tools.

> Note: Gateway operations are primarily done through boto3 (`bedrock-agentcore-control`) or the starter toolkit. The SDK provides the `Runtime` class for deployment configuration.

#### Creating a Gateway (boto3)

```python
import boto3

client = boto3.client('bedrock-agentcore-control')

# Create gateway with MCP protocol and semantic search
gateway = client.create_gateway(
    name="my-gateway",
    roleArn="arn:aws:iam::123456789012:role/my-gateway-role",
    protocolType="MCP",
    authorizerType="CUSTOM_JWT",
    authorizerConfiguration={
        "customJWTAuthorizer": {
            "discoveryUrl": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xxx/.well-known/openid-configuration",
            "allowedClients": ["my-client-id"]
        }
    },
    protocolConfiguration={
        "mcp": {
            "supportedVersions": ["2025-03-26"],
            "searchType": "SEMANTIC"  # Enable semantic tool discovery
        }
    }
)

gateway_url = gateway['gatewayUrl']
print(f"MCP Endpoint: {gateway_url}")
```

#### Adding Targets

**Lambda Target:**
```python
target = client.create_gateway_target(
    gatewayIdentifier="my-gateway-id",
    name="MyLambdaTools",
    targetConfiguration={
        "mcp": {
            "lambda": {
                "lambdaArn": "arn:aws:lambda:us-east-1:123456789012:function:my-tools",
                "toolSchema": {
                    "inlinePayload": [
                        {
                            "name": "get_weather",
                            "description": "Get current weather for a location",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "city": {"type": "string", "description": "City name"}
                                },
                                "required": ["city"]
                            }
                        }
                    ]
                }
            }
        }
    }
)
```

**OpenAPI Target:**
```python
target = client.create_gateway_target(
    gatewayIdentifier="my-gateway-id",
    name="RestAPITarget",
    targetConfiguration={
        "mcp": {
            "openApiSchema": {
                "s3": {
                    "uri": "s3://my-bucket/openapi-spec.json",
                    "bucketOwnerAccountId": "123456789012"
                }
            }
        }
    },
    credentialProviderConfigurations=[{
        "credentialProviderType": "API_KEY",
        "credentialProvider": {
            "apiKeyCredentialProvider": {
                "providerArn": "arn:aws:bedrock-agentcore:...:api-key-provider/my-key"
            }
        }
    }]
)
```

**API Gateway Target:**
```python
target = client.create_gateway_target(
    gatewayIdentifier="my-gateway-id",
    name="APIGatewayTarget",
    targetConfiguration={
        "mcp": {
            "apiGateway": {
                "restApiId": "abc123def",
                "stage": "prod",
                "apiGatewayToolConfiguration": {
                    "toolFilters": [
                        {
                            "filterPath": "/products",
                            "methods": ["GET", "POST"]
                        }
                    ]
                }
            }
        }
    }
)
```

**MCP Server Target:**
```python
target = client.create_gateway_target(
    gatewayIdentifier="my-gateway-id",
    name="MyMCPServer",
    targetConfiguration={
        "mcp": {
            "mcpServer": {
                "endpoint": "https://my-mcp-server.example.com/mcp"
            }
        }
    },
    credentialProviderConfigurations=[{
        "credentialProviderType": "OAUTH",
        "credentialProvider": {
            "oauthCredentialProvider": {
                "providerArn": "arn:aws:bedrock-agentcore:...:oauth2-provider/my-oauth"
            }
        }
    }]
)

# Synchronize tool catalog from MCP server
client.synchronize_gateway_targets(
    gatewayIdentifier="my-gateway-id",
    targetIds=["target-id"]
)
```

**Smithy Model Target:**
```python
target = client.create_gateway_target(
    gatewayIdentifier="my-gateway-id",
    name="SmithyTarget",
    targetConfiguration={
        "mcp": {
            "smithyModel": {
                "s3": {
                    "uri": "s3://my-bucket/my-model.smithy"
                }
            }
        }
    }
)
```

---

### 5.5 Code Interpreter Module

Secure sandboxed code execution environment supporting Python, JavaScript, and TypeScript.

#### CodeInterpreter Client

```python
from bedrock_agentcore.tools.code_interpreter_client import CodeInterpreter, code_session

# Method 1: Context manager (recommended)
with code_session('us-east-1') as client:
    result = client.invoke('executeCode', {
        'language': 'python',
        'code': 'print("Hello from sandbox!")'
    })

# Method 2: Manual lifecycle
code_client = CodeInterpreter('us-east-1')
session_id = code_client.start(
    identifier='my-code-interpreter-id',  # Optional, uses default if omitted
    session_timeout_seconds=3600
)

# Execute Python code
result = code_client.invoke('executeCode', {
    'language': 'python',
    'code': '''
import pandas as pd
import matplotlib.pyplot as plt

data = pd.DataFrame({'x': [1,2,3,4,5], 'y': [2,4,6,8,10]})
print(data.describe())
'''
})

# Execute shell commands
result = code_client.invoke('executeCommand', {
    'command': 'pip install boto3'
})

# File operations
result = code_client.invoke('writeFiles', {
    'content': [{'path': '/tmp/data.csv', 'text': 'a,b\n1,2\n3,4'}]
})

result = code_client.invoke('readFiles', {
    'paths': ['/tmp/data.csv']
})

result = code_client.invoke('listFiles', {
    'directoryPath': '/tmp'
})

# Stop session
code_client.stop()
```

#### Supported Languages & Libraries

| Language | Pre-installed Libraries |
|----------|------------------------|
| Python 3.12 | pandas, numpy, matplotlib, scikit-learn, torch, pillow, scipy, seaborn, plotly |
| JavaScript | Standard Node.js libraries |
| TypeScript | TypeScript compiler + standard libs |

#### Limits

- Inline file upload: up to 100 MB
- S3 file upload: up to 5 GB
- Default execution timeout: 15 minutes
- Session timeout: configurable (default varies)

#### Code Interpreter as Agent Tool

```python
from bedrock_agentcore.tools.code_interpreter_client import CodeInterpreter
from strands import Agent, tool

code_client = CodeInterpreter('us-east-1')

@tool
def execute_python(code: str) -> str:
    """Execute Python code in a secure sandbox."""
    code_client.start()
    try:
        response = code_client.invoke('executeCode', {
            'language': 'python',
            'code': code
        })
        return str(response)
    finally:
        code_client.stop()

agent = Agent(tools=[execute_python])
result = agent("Calculate the first 20 Fibonacci numbers")
```

---

### 5.6 Browser Module

Managed Chrome browser instances running in isolated Firecracker microVMs. Supports Playwright, BrowserUse, and Nova Act.

#### BrowserClient

```python
from bedrock_agentcore.tools.browser_client import BrowserClient, browser_session

# Context manager (recommended)
with browser_session('us-west-2') as client:
    session_id = client.session_id

    # Get WebSocket URL for Playwright CDP connection
    ws_url, headers = client.generate_ws_headers()

    # Get live view URL (pre-signed, for monitoring)
    live_view_url = client.generate_live_view_url(expires=300)
    print(f"Live view: {live_view_url}")

    # Control flow
    client.take_control()     # Disable external automation
    client.release_control()  # Re-enable automation

# Manual lifecycle with custom viewport
browser_client = BrowserClient(region='us-west-2')
session_id = browser_client.start(
    identifier='my-browser-id',
    viewport={'width': 1920, 'height': 1080},
    session_timeout_seconds=3600
)
```

#### Playwright Integration

```python
from playwright.async_api import async_playwright, BrowserType
from bedrock_agentcore.tools.browser_client import browser_session
import asyncio

async def run():
    async with async_playwright() as playwright:
        with browser_session('us-west-2') as client:
            ws_url, headers = client.generate_ws_headers()

            # Connect to remote Chrome via CDP
            chromium: BrowserType = playwright.chromium
            browser = await chromium.connect_over_cdp(
                ws_url,
                headers=headers
            )

            page = browser.contexts[0].pages[0]
            await page.goto("https://example.com")
            title = await page.title()
            print(f"Page title: {title}")

            # Take screenshot
            screenshot = await page.screenshot()

            await browser.close()

asyncio.run(run())
```

#### Strands Browser Tool

```python
from strands import Agent
from strands_tools.browser import AgentCoreBrowser

browser_tool = AgentCoreBrowser(region="us-west-2")
agent = Agent(tools=[browser_tool.browser])
result = agent("Go to AWS documentation and find AgentCore pricing")
```

#### Session Recording

For auditing and debugging, browser sessions can be recorded to S3:

```python
import boto3

control_client = boto3.client('bedrock-agentcore-control')

browser = control_client.create_browser(
    name="recorded-browser",
    networkConfiguration={...},
    # Session recording configuration is set at session start
)
```

---

### 5.7 Observability Module

OpenTelemetry-based tracing, metrics, and logging for agent performance monitoring.

#### Auto-Instrumentation (Runtime-Hosted)

For agents deployed to AgentCore Runtime, observability is nearly automatic:

```bash
# Install instrumentation
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install
```

```python
# agent.py - observability is auto-configured by Runtime
from bedrock_agentcore import BedrockAgentCoreApp
from strands import Agent

app = BedrockAgentCoreApp()
agent = Agent()

@app.entrypoint
def handler(request, context):
    # Traces are automatically captured
    return {"response": str(agent(request["prompt"]))}
```

#### Manual Instrumentation (Non-Runtime)

For agents running outside AgentCore Runtime (EC2, EKS, Lambda):

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace.export import SimpleSpanProcessor

# Configure TracerProvider
provider = TracerProvider()
exporter = OTLPSpanExporter(
    endpoint="https://xray.us-east-1.amazonaws.com/v1/traces"
)
provider.add_span_processor(SimpleSpanProcessor(exporter))
trace.set_tracer_provider(provider)

tracer = trace.get_tracer("my-agent")

# Create custom spans
with tracer.start_as_current_span("agent-invocation") as span:
    span.set_attribute("agent.session_id", session_id)
    span.set_attribute("agent.model", "claude-sonnet-4")
    result = agent(prompt)
    span.set_attribute("agent.tokens_used", result.token_count)
```

#### Default Metrics (Emitted by AgentCore)

| Metric | Description |
|--------|-------------|
| Invocations | Number of agent invocations |
| Throttles | Throttled invocation count |
| SystemErrors | System-level errors |
| UserErrors | User-level errors |
| Latency | Request-to-first-byte latency |
| Duration | Total invocation duration |
| CPU/Memory | Resource consumption metrics |

#### CloudWatch Integration

All observability data flows to Amazon CloudWatch:
- **Transaction Search** - Required to be enabled once per account
- **GenAI Observability Dashboard** - Pre-built dashboards for traces, sessions, metrics
- **Log groups** - `/aws/bedrock-agentcore/{resource-type}/{resource-id}`

---

## 6. TypeScript SDK (bedrock-agentcore)

The TypeScript SDK provides the same core functionality with idiomatic TypeScript patterns.

```bash
npm install bedrock-agentcore @strands-agents/sdk
```

**Package:** `bedrock-agentcore` on npm (v0.2.2)
**Node.js:** 20+
**Status:** Preview (core features available, some advanced features Python-only)

### Runtime

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { Agent, BedrockModel } from '@strands-agents/sdk'
import { z } from 'zod'

const agent = new Agent({
  model: new BedrockModel({ modelId: 'global.amazon.nova-2-lite-v1:0' }),
})

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string() }),
    process: async function* (request) {
      for await (const event of agent.stream(request.prompt)) {
        if (event.type === 'modelContentBlockDeltaEvent' &&
            event.delta?.type === 'textDelta') {
          yield { event: 'message', data: { text: event.delta.text } }
        }
      }
    },
  },
})

app.run()
```

### Key Differences from Python SDK

| Feature | Python (stable) | TypeScript (preview) |
|---------|-----------------|---------------------|
| Runtime (BedrockAgentCoreApp) | Full | Full |
| Identity (withAccessToken, withApiKey) | Full | Full |
| Code Interpreter & Browser tools | Full with Strands integration | Core clients available |
| Memory | Full with Strands integration | Not yet available |
| A2A protocol | Full | Not yet available |
| AG-UI protocol | Full | Full |

### Framework Integration

The TypeScript SDK works with:
- **Strands Agents SDK** (`@strands-agents/sdk`) - First-class support
- **Vercel AI SDK** - Code Interpreter and Browser tools integrate directly
- Any framework via core clients (`CodeInterpreter`, `PlaywrightBrowser`)

---

## 7. Starter Toolkit CLI

The `agentcore` CLI simplifies deployment, testing, and management.

```bash
pip install bedrock-agentcore-starter-toolkit
agentcore --help
```

### Runtime Commands

| Command | Description |
|---------|-------------|
| `agentcore create` | Create a skeleton agent project (Python/TypeScript) |
| `agentcore configure -e agent.py` | Configure agent for deployment |
| `agentcore dev` | Start local development server |
| `agentcore launch` | Build container, push to ECR, deploy to Runtime |
| `agentcore launch -l` | Build and run container locally |
| `agentcore invoke "Hello"` | Invoke deployed agent |
| `agentcore invoke --dev "Hello"` | Invoke local dev server |
| `agentcore status` | Check deployment status |
| `agentcore stop-session` | Stop a running session |
| `agentcore destroy` | Clean up all AWS resources |

### Gateway Commands

| Command | Description |
|---------|-------------|
| `agentcore create_mcp_gateway` | Create a new MCP gateway |
| `agentcore create_mcp_gateway_target` | Add a target to a gateway |
| `agentcore list_mcp_gateways` | List all gateways |
| `agentcore get_mcp_gateway` | Get gateway details |
| `agentcore delete_mcp_gateway` | Delete a gateway |
| `agentcore delete_mcp_gateway_target` | Delete a target |

### Identity Commands

| Command | Description |
|---------|-------------|
| `agentcore setup-aws-jwt` | Set up AWS JWT federation |
| `agentcore setup-cognito` | Set up Cognito user pool |
| `agentcore create-credential-provider` | Create credential provider |
| `agentcore create-workload-identity` | Create workload identity |
| `agentcore get-cognito-inbound-token` | Get Cognito token |
| `agentcore cleanup-identity-resources` | Clean up identity resources |

### Memory Commands

| Command | Description |
|---------|-------------|
| `agentcore create-memory` | Create a memory resource |
| `agentcore get-memory` | Get memory details |
| `agentcore list-memories` | List memories |
| `agentcore delete-memory` | Delete memory |
| `agentcore memory-status` | Check memory status |

### Policy Commands

| Command | Description |
|---------|-------------|
| `agentcore create-policy-engine` | Create policy engine |
| `agentcore create-policy` | Create Cedar policy |
| `agentcore start-policy-generation` | Auto-generate policies |

### Configuration Files

The CLI generates:
- **`.bedrock_agentcore.yaml`** - Deployment configuration (agent name, ARN, ECR URI, session info)
- **`Dockerfile`** - Auto-generated container definition for ARM64 (AWS Graviton)

---

## 8. MCP Integration Patterns

MCP (Model Context Protocol) is central to AgentCore's tool integration strategy. AgentCore supports MCP in three key patterns:

### 8.1 Deploying MCP Servers on AgentCore Runtime

You can deploy MCP servers directly to AgentCore Runtime, giving them the same benefits as agent deployments (scaling, isolation, auth).

```python
# my_mcp_server.py
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("My Tools Server")

@mcp.tool()
def get_weather(city: str) -> str:
    """Get weather for a city."""
    return f"Weather in {city}: 72F, sunny"

@mcp.tool()
def search_database(query: str) -> str:
    """Search the internal database."""
    return f"Results for: {query}"

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
```

**Deployment:**
```bash
agentcore configure -e my_mcp_server.py --protocol MCP
agentcore launch
# Returns: arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_mcp_server-xyz
```

**Invocation from MCP client:**
```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client(
    url=f"https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/{encoded_arn}/mcp",
    headers=auth_headers
) as (read_stream, write_stream, _):
    async with ClientSession(read_stream, write_stream) as session:
        await session.initialize()
        tools = await session.list_tools()
        result = await session.call_tool("get_weather", {"city": "Seattle"})
```

### 8.2 AgentCore Gateway as MCP Front Door

Gateway acts as a unified MCP endpoint that routes to multiple backend target types.

```
                         MCP Client
                            |
                   +--------+--------+
                   |  AgentCore      |
                   |  Gateway        |
                   |  (MCP Endpoint) |
                   +--------+--------+
                      |    |    |    |
              +-------+ +--+--+ +---+-----+ +--------+
              |Lambda | |API  | |OpenAPI  | |MCP     |
              |Target | |GW   | |Target   | |Server  |
              +-------+ +-----+ +---------+ +--------+
```

**Supported MCP operations on Gateway:**

| Operation | Description |
|-----------|-------------|
| `tools/list` | List all available tools across all targets |
| `tools/call` | Invoke a specific tool on the appropriate target |
| `x_amz_bedrock_agentcore_search` | Semantic search across tool catalog (when enabled) |

**Supported MCP protocol versions:** `2025-03-26`, `2025-06-18`

### 8.3 MCP Server Targets

Existing MCP servers can be registered as Gateway targets:

```bash
# CLI approach
agentcore create_mcp_gateway_target \
  --gateway-arn arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/my-gw \
  --gateway-url https://gateway-url \
  --role-arn arn:aws:iam::123456789012:role/my-role \
  --name MyMCPServerTarget \
  --target-type mcp_server
```

**Synchronization:** MCP server targets require synchronization to update the tool catalog:
- **Implicit sync** - occurs during target creation and updates
- **Explicit sync** - on-demand via `SynchronizeGatewayTargets` API

```python
client.synchronize_gateway_targets(
    gatewayIdentifier="my-gateway-id",
    targetIds=["target-id-1", "target-id-2"]
)
```

**Authorization for MCP targets:**
- `noAuth` - no outbound authorization
- `OAuth2` (client credentials) - for authenticated MCP servers

### 8.4 Gateway Tool Discovery & Semantic Search

When `searchType: "SEMANTIC"` is enabled on a gateway, the built-in `x_amz_bedrock_agentcore_search` tool allows natural language queries across the entire tool catalog:

```python
# From a Strands agent using the gateway as MCP source
from strands import Agent
from strands.tools.mcp import MCPClient

mcp_client = MCPClient(
    endpoint=gateway_url,
    auth_headers=get_auth_headers()
)

agent = Agent(tools=mcp_client.list_tools())

# The agent can discover tools semantically
result = agent("Find a tool that can send email notifications")
```

This is especially valuable when gateways front dozens or hundreds of tools across multiple targets.

---

## 9. Boto3 Client Reference

### Control Plane Client

```python
import boto3

# Control plane - resource management
control = boto3.client('bedrock-agentcore-control', region_name='us-east-1')

# Key methods (all CRUD operations):
control.create_agent_runtime(...)
control.create_gateway(...)
control.create_gateway_target(...)
control.create_memory(...)
control.create_workload_identity(...)
control.create_code_interpreter(...)
control.create_browser(...)
control.create_policy_engine(...)
control.create_policy(...)
control.create_evaluator(...)
control.synchronize_gateway_targets(...)
control.start_policy_generation(...)

# Paginators available for all List* operations
paginator = control.get_paginator('list_agent_runtimes')
for page in paginator.paginate():
    for runtime in page['agentRuntimeSummaries']:
        print(runtime['agentRuntimeName'])

# Waiters available:
# - agent_runtime_ready
# - agent_runtime_endpoint_ready
```

### Data Plane Client

```python
# Data plane - invocations and tool execution
data = boto3.client('bedrock-agentcore', region_name='us-east-1')

# Invoke agent runtime (streaming)
response = data.invoke_agent_runtime(
    agentRuntimeArn='arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent',
    payload=json.dumps({'prompt': 'Hello'}).encode(),
    contentType='application/json',
    runtimeSessionId='session-uuid'
)

# Read streaming response
for event in response['response']:
    chunk = event.get('data', b'')
    print(chunk.decode(), end='')

# Invoke code interpreter
response = data.invoke_code_interpreter(
    codeInterpreterIdentifier='my-interpreter-id',
    sessionId='session-id',
    name='executeCode',
    arguments={
        'language': 'python',
        'code': 'print(sum(range(100)))'
    }
)

# Start/stop code interpreter sessions
session = data.start_code_interpreter_session(
    codeInterpreterIdentifier='my-interpreter-id',
    sessionTimeoutSeconds=3600
)

data.stop_code_interpreter_session(
    codeInterpreterIdentifier='my-interpreter-id',
    sessionId=session['sessionId']
)
```

---

## 10. Agent Invocation & Session Management

### Basic Invocation

```python
import boto3
import json

client = boto3.client('bedrock-agentcore')

response = client.invoke_agent_runtime(
    agentRuntimeArn='arn:aws:bedrock-agentcore:us-east-1:123:runtime/my-agent',
    payload=json.dumps({
        'prompt': 'Analyze the latest sales data'
    }).encode(),
    contentType='application/json'
)

# Process streaming response
for event in response['response']:
    if 'data' in event:
        print(event['data'].decode(), end='')
```

### Session Continuity

Maintain conversation context across multiple invocations:

```python
import uuid

session_id = str(uuid.uuid4())

# First turn
response1 = client.invoke_agent_runtime(
    agentRuntimeArn=agent_arn,
    payload=json.dumps({'prompt': 'My name is Alice'}).encode(),
    runtimeSessionId=session_id,
    contentType='application/json'
)

# Second turn - same session
response2 = client.invoke_agent_runtime(
    agentRuntimeArn=agent_arn,
    payload=json.dumps({'prompt': 'What is my name?'}).encode(),
    runtimeSessionId=session_id,  # Same session ID
    contentType='application/json'
)
# Agent remembers: "Your name is Alice"
```

### Multi-Modal Invocation

```python
import base64

with open('image.png', 'rb') as f:
    image_data = base64.b64encode(f.read()).decode()

response = client.invoke_agent_runtime(
    agentRuntimeArn=agent_arn,
    payload=json.dumps({
        'prompt': 'Describe this image',
        'images': [{'format': 'png', 'data': image_data}]
    }).encode(),
    contentType='application/json'
)
```

### Shell Command Execution

For deterministic operations (tests, git, builds) that shouldn't go through the LLM:

```python
response = client.execute_shell_command(
    agentRuntimeArn=agent_arn,
    runtimeSessionId=session_id,
    command='git status'
)
```

---

## 11. Protocol Support (A2A, AG-UI)

### A2A (Agent-to-Agent) Protocol

Serve agents using the A2A protocol for inter-agent communication:

```python
pip install "bedrock-agentcore[a2a]"
```

```python
from strands import Agent
from strands.a2a import StrandsA2AExecutor
from bedrock_agentcore.runtime import serve_a2a

agent = Agent(
    model="us.anthropic.claude-sonnet-4-20250514",
    system_prompt="You are a helpful assistant."
)

serve_a2a(StrandsA2AExecutor(agent))
```

Works with any framework providing an `AgentExecutor` (Strands, LangGraph, Google ADK, custom).

### AG-UI Protocol

Deploy agents using the AG-UI protocol for frontend integration:

```python
from bedrock_agentcore.runtime import serve_ag_ui

# Single entrypoint serves both SSE (POST /invocations) and WebSocket (/ws)
@serve_ag_ui
def handler(request):
    return agent(request["prompt"])
```

---

## 12. Code Examples - End to End

### Example 1: Deploy a Strands Agent with Memory

```python
# agent.py
from bedrock_agentcore import BedrockAgentCoreApp
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager
from strands import Agent
import uuid

app = BedrockAgentCoreApp()

@app.entrypoint
async def handler(payload, context):
    session_id = context.session_id or str(uuid.uuid4())
    memory_id = payload.get("memory_id", "")
    actor_id = payload.get("actor_id", "default")

    config = AgentCoreMemoryConfig(
        memory_id=memory_id,
        session_id=session_id,
        actor_id=actor_id
    )
    session_manager = AgentCoreMemorySessionManager(config)

    agent = Agent(
        model="us.anthropic.claude-sonnet-4-20250514",
        session_manager=session_manager
    )

    result = agent(payload.get("prompt", "Hello"))
    return {"response": str(result), "session_id": session_id}
```

### Example 2: Gateway + Strands Agent with MCP Tools

```python
from strands import Agent
from strands.tools.mcp import MCPClient

# Connect to AgentCore Gateway as MCP source
mcp_client = MCPClient(
    endpoint="https://bedrock-agentcore-gateway.us-east-1.amazonaws.com/gateways/my-gw/mcp",
    auth={"type": "oauth2", "token": get_token()}
)

# Create agent with gateway tools
agent = Agent(
    tools=mcp_client.list_tools(),
    system_prompt="You have access to various enterprise tools via MCP."
)

result = agent("Look up the latest sales figures and send a summary to the team")
```

### Example 3: Full Stack with Code Interpreter + Browser

```python
from bedrock_agentcore import BedrockAgentCoreApp
from bedrock_agentcore.tools.code_interpreter_client import CodeInterpreter
from bedrock_agentcore.tools.browser_client import BrowserClient
from strands import Agent, tool

app = BedrockAgentCoreApp()
code_client = CodeInterpreter('us-east-1')
browser_client = BrowserClient(region='us-east-1')

@tool
def run_code(code: str) -> str:
    """Execute Python code in a secure sandbox."""
    code_client.start()
    result = code_client.invoke('executeCode', {'language': 'python', 'code': code})
    return str(result)

@tool
def browse_web(url: str) -> str:
    """Navigate to a URL and extract page content."""
    session_id = browser_client.start()
    ws_url, headers = browser_client.generate_ws_headers()
    # ... Playwright automation ...
    browser_client.stop()
    return page_content

@app.entrypoint
def handler(request, context):
    agent = Agent(tools=[run_code, browse_web])
    result = agent(request.get("prompt", ""))
    return {"response": str(result)}
```

### Example 4: MCP Server Deployed to AgentCore Runtime

```python
# mcp_server.py
from mcp.server.fastmcp import FastMCP
import boto3

mcp = FastMCP("Enterprise Tools")

@mcp.tool()
def query_dynamodb(table_name: str, key: dict) -> dict:
    """Query a DynamoDB table."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(table_name)
    response = table.get_item(Key=key)
    return response.get('Item', {})

@mcp.tool()
def send_notification(topic_arn: str, message: str) -> str:
    """Send an SNS notification."""
    sns = boto3.client('sns')
    sns.publish(TopicArn=topic_arn, Message=message)
    return "Notification sent"

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
```

```bash
# Deploy
agentcore configure -e mcp_server.py --protocol MCP
agentcore launch
```

---

## 13. Sources & Links

### Official Documentation
- [AgentCore Developer Guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/)
- [AgentCore Control Plane API Reference](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/)
- [AgentCore Data Plane API Reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/)
- [Boto3 - bedrock-agentcore-control](https://docs.aws.amazon.com/boto3/latest/reference/services/bedrock-agentcore-control.html)
- [Boto3 - bedrock-agentcore](https://docs.aws.amazon.com/boto3/latest/reference/services/bedrock-agentcore.html)

### SDKs & Toolkits
- [Python SDK (GitHub)](https://github.com/aws/bedrock-agentcore-sdk-python) - v1.4.6, Apache 2.0
- [TypeScript SDK (npm)](https://www.npmjs.com/package/bedrock-agentcore) - v0.2.2, preview
- [Starter Toolkit (GitHub)](https://github.com/aws/bedrock-agentcore-starter-toolkit)
- [Starter Toolkit CLI Reference](https://aws.github.io/bedrock-agentcore-starter-toolkit/api-reference/cli.html)
- [Samples Repository](https://github.com/awslabs/amazon-bedrock-agentcore-samples)

### MCP Integration
- [Deploy MCP Servers in AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html)
- [AgentCore Gateway Overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html)
- [Create a Gateway (API)](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-create-api.html)
- [Gateway Target Configuration](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-api-target-config.html)
- [MCP Server Targets](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html)
- [Unite MCP Servers through Gateway (Blog)](https://aws.amazon.com/blogs/machine-learning/transform-your-mcp-architecture-unite-mcp-servers-through-agentcore-gateway/)
- [Build Long-Running MCP Servers (Blog)](https://aws.amazon.com/blogs/machine-learning/build-long-running-mcp-servers-on-amazon-bedrock-agentcore-with-strands-agents-integration/)

### Tools & Observability
- [Code Interpreter Guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html)
- [Code Interpreter Blog](https://aws.amazon.com/blogs/machine-learning/introducing-the-amazon-bedrock-agentcore-code-interpreter/)
- [Browser QuickStart (Playwright)](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-quickstart-playwright.html)
- [Browser Session Recording](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-session-recording.html)
- [AgentCore Observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html)
- [Observability Best Practices (Blog)](https://aws.amazon.com/blogs/machine-learning/build-trustworthy-ai-agents-with-amazon-bedrock-agentcore-observability/)

### Strands Integration
- [Deploy to AgentCore (Strands Docs)](https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/)
- [AgentCore Memory Session Manager](https://strandsagents.com/docs/community/session-managers/agentcore-memory/)
- [MCP Tools in Strands](https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/)

### AWS Blog Posts
- [Introducing Amazon Bedrock AgentCore (News Blog)](https://aws.amazon.com/blogs/aws/introducing-amazon-bedrock-agentcore-securely-deploy-and-operate-ai-agents-at-any-scale/)
- [Streamline Agent Tool Interactions - API Gateway to AgentCore Gateway](https://aws.amazon.com/blogs/machine-learning/streamline-ai-agent-tool-interactions-connect-api-gateway-to-agentcore-gateway-with-mcp/)
- [AgentCore Complete Guide (fp8.co)](https://fp8.co/articles/Amazon-Bedrock-AgentCore-Comprehensive-Guide)

### Community Resources
- [MCP Server on AgentCore Runtime and Gateway (dev.to)](https://dev.to/budionosan/amazon-bedrock-agentcore-mcp-server-on-agentcore-runtime-and-agentcore-gateway-el9)
- [MCPfying Tools at Scale with Gateway (dev.to)](https://dev.to/aws-builders/mcpfying-tools-securely-at-scale-with-bedrock-agentcore-gateway-e3d)
- [AgentCore Gateway Deep Dive (Towards AWS)](https://towardsaws.com/on-amazon-bedrock-agentcore-gateway-11da5a1485de)
- [Code Interpreter + Browser (Level Up Coding)](https://levelup.gitconnected.com/bedrock-agentcore-code-interpreter-browser-a-simple-nova-act-alternative-e8ab00348159)
- [AgentCore MCP Server (awslabs)](https://awslabs.github.io/mcp/servers/amazon-bedrock-agentcore-mcp-server)

### Related Documents in This Series
- [[01-AgentCore-Architecture-Runtime]] - Architecture deep dive, runtime internals, session isolation
- [[03-AgentCore-Multi-Tenancy-Deployment]] - Multi-tenant patterns, CDK deployment, scaling
- [[04-Strands-Agents-Core]] - Strands framework, agent loop, tool system
