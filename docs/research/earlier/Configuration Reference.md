# Configuration Reference

> Parent: [[Index]]

## Model Provider Configuration

### Amazon Bedrock (Explicit)

Add to `openclaw.json`:

```json5
{
  models: {
    providers: {
      "amazon-bedrock": {
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        models: [
          {
            id: "us.anthropic.claude-opus-4-6-v1:0",
            name: "Claude Opus 4.6 (Bedrock)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
          {
            id: "us.amazon.nova-lite-v1:0",
            name: "Nova Lite",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 300000,
            maxTokens: 5120,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: "amazon-bedrock/us.amazon.nova-lite-v1:0",
        fallbacks: [
          "amazon-bedrock/us.anthropic.claude-opus-4-6-v1:0"
        ]
      },
    },
  },
}
```

### Amazon Bedrock (Implicit / Auto-Discovery)

If AWS credentials are in the environment, OpenClaw can auto-discover Bedrock models:

```json5
{
  models: {
    bedrockDiscovery: {
      enabled: true  // Requires bedrock:ListFoundationModels IAM permission
    }
  }
}
```

The `resolveImplicitBedrockProvider` function checks for:
- `AWS_REGION` or `AWS_DEFAULT_REGION`
- Valid AWS credentials (access key, profile, or instance role)

### Environment Variables for Bedrock

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"

# For EC2 with IAM roles:
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

## Model Selection and Failover

Models selected in order:
1. **Primary:** `agents.defaults.model.primary`
2. **Fallbacks:** `agents.defaults.model.fallbacks` (tried in order)

Model references use `provider/model` format: `amazon-bedrock/us.amazon.nova-lite-v1:0`

### Failover Mechanism (Two Stages)

**Stage 1: Auth Profile Rotation** (within current provider)
- Try explicit config order: `auth.order[provider]`
- Try configured profiles: `auth.profiles`
- Try stored profiles: `auth-profiles.json`
- If no explicit order: round-robin, OAuth before API keys, older `lastUsed` first
- Cooldowns applied to failing profiles

**Stage 2: Model Fallback** (if all auth profiles fail)
- Move to next model in `fallbacks` list
- Repeat stage 1 for the new model's provider

## Authentication Profiles

Stored per agent in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.

**Profile types:**
- `type: "api_key"` — stores `{ provider, key }`
- `type: "oauth"` — stores `{ provider, access, refresh, expires, email? }`

**Profile IDs:** `provider:default` or `provider:<email>` for OAuth.

**CLI management:**
```bash
openclaw models auth add                              # Add a new profile
openclaw models auth login --provider <id>            # Run provider auth flow
openclaw models auth setup-token                      # Interactive token setup
openclaw models auth paste-token                      # Paste token from elsewhere
openclaw models auth order set                        # Control rotation order
```

## Smart Model Routing (Cost Optimization)

For teams, route based on task complexity:

| Task Type | Model | Cost Impact |
|-----------|-------|-------------|
| Routine (summaries, simple Q&A) | Nova Lite | ~$0.03/conversation |
| Complex (reasoning, code review) | Claude Sonnet | ~$1.66/conversation |
| Mixed (80% Nova / 20% Sonnet) | Auto-route | ~$0.36/conversation |

For a team of 10 doing 50 conversations/day:

| Strategy | Monthly Cost |
|----------|-------------|
| All Claude Sonnet | ~$2,500 |
| All Nova Lite | ~$50 |
| Smart routing (80/20) | ~$540 |

Model choice is a one-parameter change in CloudFormation. No code changes needed.

## Sandbox Configuration

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",           // "off" | "non-main" | "all"
        scope: "session",      // "session" | "agent" | "shared"
        workspaceAccess: "ro"  // "none" | "ro" | "rw"
      }
    }
  }
}
```

## Gateway Configuration

```json5
{
  gateway: {
    bind: "0.0.0.0",
    port: 18789,
    auth: {
      // password or token-based authentication
    }
  }
}
```

For multiple gateways:
```bash
# Use --profile or OPENCLAW_STATE_DIR for isolation
OPENCLAW_STATE_DIR=~/.openclaw-team1 openclaw gateway --port 18789
OPENCLAW_STATE_DIR=~/.openclaw-team2 openclaw gateway --port 18790
```
