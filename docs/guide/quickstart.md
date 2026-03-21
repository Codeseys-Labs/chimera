# Quickstart Guide — Your First Chimera Agent

> **Goal:** Create a working AI agent, test it locally, and deploy it to AWS in 20 minutes.

This guide walks you through building a simple chatbot agent that can answer questions, execute code, and integrate with Slack — all running on AWS with multi-tenant isolation and auto-scaling.

---

## Prerequisites

Before you begin, install these tools:

### Required Tools

```bash
# Node.js 20+ (runtime for TypeScript packages)
node --version  # Should be 20.x or higher

# Bun (fast package manager + test runner)
curl -fsSL https://bun.sh/install | bash

# mise (runtime version manager, replaces nvm/rbenv/pyenv)
curl https://mise.run | sh

# AWS CLI v2 (for credential management)
aws --version  # Should be 2.x

# AWS CDK CLI (for infrastructure deployment)
npm install -g aws-cdk
cdk --version  # Should be 2.x
```

### AWS Account Setup

You'll need:

- **AWS Account** with admin access (for CDK bootstrapping)
- **AWS credentials** configured: `aws configure` or set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
- **Region** (default: `us-east-1`)

### Optional Tools

```bash
# Docker (for local AgentCore Runtime emulation)
docker --version

# Slack workspace (for chat integration testing)
# Get a bot token at https://api.slack.com/apps
```

---

## Step 1: Clone and Install

```bash
# Clone the repository
git clone https://github.com/your-org/chimera.git
cd chimera

# Install mise runtimes (reads .mise.toml for Node/Python versions)
mise install

# Install dependencies (monorepo with 4 packages)
bun install

# Verify installation
bun test  # Run all unit tests (should pass)
```

**What just happened?**

- `mise install` set up Node.js 22 and Python 3.12 based on `.mise.toml`
- `bun install` installed dependencies for all packages: `@chimera/core`, `@chimera/chat-gateway`, `@chimera/sse-bridge`, `@chimera/shared`
- `bun test` ran Jest tests to verify the setup

---

## Step 2: Create Your First Agent

Chimera agents are built on **Strands Agents** — a model-driven framework where you define:

```
Agent = Model + Tools + Prompt
```

Let's create a simple Q&A agent:

### Create Agent Definition

```bash
# Create a new agent directory
mkdir -p my-agents/hello-agent
cd my-agents/hello-agent
```

Create `agent.py`:

```python
from strands import Agent, tool
from strands.models import BedrockModel

# Define a simple tool
@tool
def get_current_time(timezone: str = "UTC") -> str:
    """Get the current time in a specific timezone.

    Args:
        timezone: IANA timezone name (e.g., 'America/New_York', 'UTC')

    Returns:
        Current time in ISO 8601 format
    """
    from datetime import datetime
    import pytz

    tz = pytz.timezone(timezone)
    now = datetime.now(tz)
    return now.isoformat()

# Create the agent
agent = Agent(
    model=BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        region="us-east-1"
    ),
    tools=[get_current_time],
    system_prompt="""You are a helpful assistant named Chimera Bot.

    When users ask for the time, use the get_current_time tool.
    Always be friendly and concise in your responses.
    """
)

if __name__ == "__main__":
    # Test the agent locally
    print("Chimera Bot ready! Ask me anything.")

    while True:
        user_input = input("\nYou: ")
        if user_input.lower() in ["exit", "quit"]:
            break

        # Invoke the agent
        result = agent.invoke(user_input)
        print(f"\nAgent: {result.content}")
```

**Key concepts:**

- **`@tool` decorator**: Converts Python functions into agent-callable tools (uses type hints + docstring for LLM schema)
- **BedrockModel**: Uses AWS Bedrock for model inference (Claude Sonnet 4.5 by default)
- **system_prompt**: Defines the agent's behavior and persona
- **agent.invoke()**: Synchronous invocation (returns `AgentResult`)

---

## Step 3: Test Locally

Run your agent:

```bash
# Set AWS credentials (if not already configured)
export AWS_REGION=us-east-1

# Run the agent
python agent.py
```

**Try these queries:**

```
You: What time is it in New York?
Agent: Let me check that for you... [uses get_current_time tool]

You: What time is it in Tokyo?
Agent: [uses get_current_time tool with timezone='Asia/Tokyo']

You: Tell me a joke
Agent: [responds without tools]
```

**How it works:**

1. Your input is sent to the Bedrock model (Claude Sonnet 4.5)
2. The model decides if it needs to call a tool
3. If yes, Strands executes `get_current_time(timezone="America/New_York")`
4. The model synthesizes the tool result into a natural language response

---

## Step 4: Add to Chimera Platform

To deploy your agent to the multi-tenant platform:

### 4.1 Register Agent in Core

Create `packages/core/src/agents/hello-agent.ts`:

```typescript
import { ChimeraAgent, AgentConfig } from '@chimera/core';
import { BedrockModel } from '@chimera/core/models';
import { getTimeToolDefinition } from './tools/time-tools';

export const helloAgentConfig: AgentConfig = {
  name: 'hello-agent',
  description: 'A friendly Q&A agent with time zone awareness',
  model: new BedrockModel({
    modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    region: 'us-east-1'
  }),
  tools: [getTimeToolDefinition],
  systemPrompt: `You are a helpful assistant named Chimera Bot.

  When users ask for the time, use the get_current_time tool.
  Always be friendly and concise in your responses.`,
  // Multi-tenant configuration
  isolation: {
    memoryNamespace: 'tenant-{tenant_id}-user-{user_id}',
    microVmEnabled: true
  }
};

export class HelloAgent extends ChimeraAgent {
  constructor(tenantId: string, sessionId?: string) {
    super(helloAgentConfig, tenantId, sessionId);
  }
}
```

### 4.2 Add Tool Implementation

Create `packages/core/src/agents/tools/time-tools.ts`:

```typescript
import { ToolDefinition } from '@chimera/shared';

export const getTimeToolDefinition: ToolDefinition = {
  name: 'get_current_time',
  description: 'Get the current time in a specific timezone',
  inputSchema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone name (e.g., America/New_York, UTC)',
        default: 'UTC'
      }
    },
    required: []
  },
  executor: async (input: { timezone?: string }) => {
    const timezone = input.timezone || 'UTC';
    const now = new Date();

    // Use Intl.DateTimeFormat for timezone conversion
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    return {
      timezone,
      time: formatter.format(now),
      iso8601: now.toISOString()
    };
  }
};
```

**Why TypeScript?**

- The Chimera platform core is TypeScript (Node.js 22 runtime)
- Python agents run inside AgentCore MicroVMs
- The `ChimeraAgent` wrapper adds multi-tenant context (tenantId, sessionId) to Strands agents

---

## Step 5: Deploy to AWS

Chimera uses **AWS CDK** for infrastructure-as-code. The platform is organized into 11 stacks:

```
1. Network            → VPC, subnets, NAT gateways, VPC endpoints, security groups
2. Data               → DynamoDB (6 tables), 3 S3 buckets
3. Security           → Cognito user pool, WAF WebACL, KMS keys
4. Observability      → CloudWatch dashboards, SNS alarm topics, X-Ray config
5. API Gateway        → REST + WebSocket APIs, JWT auth, OpenAI-compatible endpoint
6. Skill Pipeline     → 7-stage skill security scanning pipeline
7. Chat               → ECS Fargate service with ALB, SSE streaming bridge
8. Orchestration      → EventBridge event bus, SQS queues for agent communication
9. Evolution          → Self-evolution engine (A/B testing, auto-skills, model routing)
10. Tenant Onboarding → Tenant provisioning workflow with Cedar policies
11. Pipeline          → CI/CD pipeline with canary deployment
```

### 5.1 Bootstrap CDK (First Time Only)

```bash
# Bootstrap CDK in your AWS account
cd infra
cdk bootstrap
```

### 5.2 Deploy Infrastructure

```bash
# Deploy all stacks (takes ~15-20 minutes)
cdk deploy --all --require-approval never

# Or deploy incrementally:
cdk deploy Chimera-dev-Network
cdk deploy Chimera-dev-Data
cdk deploy Chimera-dev-Security
cdk deploy Chimera-dev-Observability
cdk deploy Chimera-dev-Api
cdk deploy Chimera-dev-SkillPipeline
cdk deploy Chimera-dev-Chat
cdk deploy Chimera-dev-Orchestration
cdk deploy Chimera-dev-Evolution
cdk deploy Chimera-dev-TenantOnboarding
cdk deploy Chimera-dev-Pipeline
```

**What gets deployed?**

- **AgentCore Runtime**: Managed service for running Strands agents in MicroVMs
- **DynamoDB**: 6 tables for tenants, sessions, skills, rate-limits, cost-tracking, audit
- **API Gateway**: REST API + WebSocket endpoint for chat
- **ECS Fargate**: Chat gateway with Vercel AI SDK SSE bridge
- **Cognito**: User pool for tenant authentication
- **S3 + EFS**: Storage for skills, tenant data, and agent workspaces
- **EventBridge**: Cron scheduler for background tasks

### 5.3 Get API Endpoint

After deployment:

```bash
# Get the API Gateway endpoint
aws cloudformation describe-stacks \
  --stack-name Chimera-dev-Api \
  --query 'Stacks[0].Outputs[?OutputKey==`RestApiUrl`].OutputValue' \
  --output text
```

Save this endpoint — you'll use it for testing.

---

## Step 6: Create a Tenant

Chimera is a **multi-tenant platform**. Each tenant gets:

- Isolated DynamoDB partitions
- Dedicated KMS keys for encryption
- Per-tenant IAM roles
- Cost tracking

### Create Tenant via CLI

```bash
# Create tenant
chimera tenant create \
  --name "Acme Corp" \
  --tier "basic" \
  --admin-email "admin@acme.com"

# Save the tenant ID and API key
export CHIMERA_TENANT_ID="tenant-abc123"
export CHIMERA_API_KEY="sk-..."
```

**Tenant tiers:**

- **Basic**: 100k tokens/month, SUMMARY memory strategy, email support
- **Advanced**: 1M tokens/month, USER_PREFERENCE + SUMMARY memory, Slack support
- **Enterprise**: Unlimited, all memory strategies, dedicated support

---

## Step 7: Test Your Agent

### 7.1 Via API

```bash
# Create a session
curl -X POST https://your-api.execute-api.us-east-1.amazonaws.com/prod/sessions \
  -H "Authorization: Bearer ${CHIMERA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "'"${CHIMERA_TENANT_ID}"'",
    "agentName": "hello-agent"
  }'

# Save session ID
export SESSION_ID="sess-xyz789"

# Send a message
curl -X POST https://your-api.execute-api.us-east-1.amazonaws.com/prod/sessions/${SESSION_ID}/messages \
  -H "Authorization: Bearer ${CHIMERA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "What time is it in Paris?"
  }'
```

### 7.2 Via Web UI

Open the chat UI:

```bash
open https://your-api.execute-api.us-east-1.amazonaws.com/prod/chat?tenant=${CHIMERA_TENANT_ID}
```

Try these queries:

- "What time is it in London?"
- "Tell me a joke"
- "What can you do?"

---

## Step 8: Add Slack Integration

### 8.1 Create Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Name: "Chimera Bot"
4. Select your workspace

### 8.2 Configure Bot Token

1. Navigate to "OAuth & Permissions"
2. Add these scopes:
   - `app_mentions:read` — Read mentions
   - `chat:write` — Send messages
   - `im:history` — Read DMs
   - `im:write` — Send DMs
3. Install to workspace
4. Copy the "Bot User OAuth Token" (starts with `xoxb-`)

### 8.3 Add Channel to Chimera

```bash
chimera channel add slack \
  --tenant-id "${CHIMERA_TENANT_ID}" \
  --token "xoxb-your-slack-token" \
  --agent "hello-agent"
```

### 8.4 Enable Event Subscriptions

1. Go to "Event Subscriptions" in Slack App settings
2. Enable Events
3. Request URL: `https://your-api.execute-api.us-east-1.amazonaws.com/prod/slack/events`
4. Subscribe to bot events:
   - `app_mention` — When @mentioned
   - `message.im` — DMs to bot
5. Save Changes

### 8.5 Test in Slack

In your Slack workspace:

```
You: @Chimera Bot what time is it in Tokyo?
Bot: It's currently 14:23 JST in Tokyo (Asia/Tokyo timezone).

You: Tell me about AWS Chimera
Bot: I'm Chimera Bot, running on the AWS Chimera platform...
```

---

## Next Steps

Congratulations! You've:

✅ Created a Strands-based AI agent
✅ Tested it locally
✅ Deployed to AWS with multi-tenant isolation
✅ Integrated with Slack

### Where to Go From Here

1. **Add More Tools**: See [Skill Authoring Guide](./skills.md) to create custom skills
2. **Memory**: Enable long-term memory with AgentCore Memory
3. **Multi-Agent**: Use agent-to-agent collaboration for complex tasks
4. **MCP Integration**: Connect 10,000+ MCP tools via AgentCore Gateway
5. **Self-Evolution**: Enable prompt A/B testing and auto-skill generation

### Learn More

- [Architecture Overview](./architecture.md) — System design and CDK stacks
- [Skill Authoring Guide](./skills.md) — Create custom skills (Python/TypeScript)
- [Deployment Guide](./deployment.md) — Production deployment best practices
- [Multi-Tenant Guide](./multi-tenant.md) — Tenant management and cost tracking

---

## Troubleshooting

### "Bedrock model not available"

```bash
# Enable Bedrock model access in AWS Console
# Go to: Bedrock → Model access → Manage model access
# Enable: Claude 3.5 Sonnet v2 (model ID: anthropic.claude-3-5-sonnet-20241022-v2:0)
```

### "CDK bootstrap failed"

```bash
# Check AWS credentials
aws sts get-caller-identity

# Verify you have admin permissions for CDK
# Policy needed: AdministratorAccess or specific CDK permissions
```

### "Agent not responding"

```bash
# Check CloudWatch logs
aws logs tail /aws/lambda/chimera-agent-runtime --follow

# Check AgentCore Runtime status
aws bedrock-agent get-agent --agent-id your-agent-id
```

### "Slack events not working"

1. Check Event Subscriptions URL: Must be HTTPS with valid SSL
2. Verify bot token starts with `xoxb-`
3. Check CloudWatch logs: `/aws/lambda/chimera-slack-handler`
4. Ensure bot is invited to channel: `/invite @Chimera Bot`

---

**AWS Chimera** — where agents are forged.
