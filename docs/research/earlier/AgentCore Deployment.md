# AgentCore Deployment

> Parent: [[Index]]
> Source: [Builder article by @jiade](https://builder.aws.com/content/39vFiQ645qDsmGd9r77eFCuw29p)
> Repo: [aws-samples/sample-OpenClaw-on-AWS-with-Bedrock](https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock)

## The Core Idea

Split OpenClaw into two components:

1. **Gateway (EC2, always-on)** — thin message router, ~$35/mo
2. **AgentCore Runtime (serverless)** — agent execution in isolated microVMs, pay-per-use

This replaces the single-process model (where all users share one process, one memory
space, one set of credentials) with per-user microVM isolation.

## Why AgentCore for Agent Workloads

### The Utilization Problem

A typical agent session: 18 seconds of active CPU out of every 60 seconds. The rest is
waiting for LLM responses, tool execution, external APIs.

- Traditional compute charges for all 60 seconds
- AgentCore charges for 18 seconds
- For scheduled "heartbeat" tasks (email check, price monitor): 10 seconds of work,
  microVM terminates. You pay for 10 seconds, not 24h of uptime.

### Session Lifecycle

1. **Session starts** — microVM provisioned, agent code loaded
2. **Active** — agent executing, tools running (you pay for compute)
3. **Idle** — waiting for next message (no compute cost)
4. **Resume** — next message arrives, session resumes warm (no cold start)
5. **Terminate** — after up to 8 hours, microVM destroyed + sanitized

State is preserved across invocations within a session. Long-term memory survives
session termination via AgentCore Memory.

## The Integration Code

The OpenClaw agent code stays almost unchanged. You wrap it with AgentCore:

```python
# Your existing OpenClaw agent code — unchanged
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload):
    prompt = payload.get("prompt", "")
    # ... your existing agent logic ...
    return result['content'][0]['text']

if __name__ == "__main__":
    app.run()
```

Everything else — microVM provisioning, session management, IAM authentication,
CloudTrail logging, auto-scaling, health checks — is handled by the runtime.

## Multi-User Session Isolation

Each user gets their own microVM. Example morning for a 5-person team:

- Alice sends a message → AgentCore provisions MicroVM-A, loads Alice's memory
- Bob sends a message → AgentCore provisions MicroVM-B, loads Bob's memory
- Alice's and Bob's sessions are **physically isolated** (no shared memory, FS, creds)
- When Alice goes idle, MicroVM-A costs nothing
- When Alice sends a follow-up, MicroVM-A resumes warm with full context
- If Bob's session crashes, Alice's session is unaffected

Compare to single-process: if Bob's request crashes the agent, Alice's pending tasks die too.

## Permission Isolation with IAM + @requires_access_token

This is the key pattern for multi-tenant/family deployments. Permissions are
**structural** (enforced by infrastructure) not **procedural** (enforced by code).

```python
from bedrock_agentcore.identity import requires_access_token

# Only runs if the session has authorized financial access
@requires_access_token(
    provider_name="family-finance-provider",
    scopes=["accounts:read", "transactions:read"]
)
async def check_family_budget(*, access_token: str, month: str):
    # Kids' sessions never reach this function
    # Their IAM role doesn't have family-finance-provider access
    ...

# GitHub access — only for users who've authorized it
@requires_access_token(
    provider_name="github-provider",
    scopes=["repo:read"]  # Read only, not write
)
async def review_pull_request(*, access_token: str, pr_url: str):
    # This function is unreachable for sessions without GitHub auth
    # The token is scoped to exactly repo:read — nothing more
    ...

# Shell access — only for developer-role sessions
@requires_access_token(
    provider_name="shell-provider",
    scopes=["execute:sandboxed"]
)
async def run_build_command(*, access_token: str, command: str):
    # Kids' sessions, PM sessions, designer sessions never reach here
    ...

# Available to everyone — no special auth needed
async def help_with_homework(subject: str, question: str):
    # Safe for all users, all contexts
    ...
```

The IAM role attached to the microVM determines what the session can access. The code
never runs if the credentials aren't present. You don't write "if user.role == admin"
checks — the infrastructure enforces it before the code runs.

## AgentCore Memory

Bridges sessions. Managed service with per-user namespace isolation.

```python
from bedrock_agentcore.memory import MemoryClient

memory = MemoryClient(region="us-east-1")

# Create memory store with per-user namespace
memory.create_store(
    name="TeamAssistant",
    description="Team member preferences and history",
    strategy="semanticMemoryStrategy",
    namespaces=["/facts/{actorId}"]  # Per-user namespace
)

# Store a conversation turn (per-user isolation via actor_id)
memory.store(
    actor_id="alice-123",       # Per-user isolation
    session_id="session-456",
    user_msg="Can you review PR #234?",
    role="USER",
    assistant_msg="Found 2 issues: SQL injection risk...",
    assistant_role="ASSISTANT"
)

# Next session: retrieve relevant memories
results = memory.search(
    namespace="/facts/alice-123",
    query="code review preferences"
)
# Returns: "Alice prefers detailed explanations with line numbers"
# "Alice flags security issues as high priority"
```

Key properties:
- Long-term memory extraction happens **asynchronously** (no latency impact)
- Per-user namespace: Alice's memories never mix with Bob's
- Semantic search returns only memories relevant to current user + query
- Survives session termination — next session starts with full context

## Full Architecture Diagram

```
  WhatsApp  Telegram  Slack  Discord
      │        │        │       │
      └────────┼────────┼───────┘
               │
    ┌──────────▼──────────────────┐
    │    Gateway (EC2, always-on) │
    │    c7g.large Graviton ARM   │
    │    ~$35/mo                  │
    │                             │
    │    - Message routing        │
    │    - Channel management     │
    │    - No public ports        │
    │    - Access via SSM only    │
    └──────────┬──────────────────┘
               │ (triggers)
    ┌──────────▼──────────────────┐
    │   AgentCore Runtime         │
    │   (serverless, pay-per-use) │
    │                             │
    │   ┌────────┐ ┌────────┐    │
    │   │MicroVM │ │MicroVM │    │    Per-user isolation:
    │   │User A  │ │User B  │    │    - Own IAM role
    │   │        │ │        │    │    - Own memory space
    │   └───┬────┘ └───┬────┘    │    - Own file system
    │       │          │         │    - Own credentials
    └───────┼──────────┼─────────┘
            │          │
    ┌───────▼──────────▼─────────┐
    │   AgentCore Memory         │
    │   (managed, per-user NS)   │
    │                             │
    │   /facts/user-a/  ← Alice  │
    │   /facts/user-b/  ← Bob   │
    └────────────────────────────┘
            │
    ┌───────▼────────────────────┐
    │   Amazon Bedrock           │
    │   - Nova Lite (routine)    │
    │   - Claude Sonnet (complex)│
    │   - Smart routing saves $  │
    └────────────────────────────┘
```

## What AgentCore Handles Automatically

| Concern | You Handle | AgentCore Handles |
|---------|-----------|-------------------|
| MicroVM provisioning | Nothing | Per-session, on-demand |
| Session management | Nothing | 8h sessions, warm resume |
| IAM authentication | Define roles | Credential injection |
| Auto-scaling | Nothing | 1 to 1000 users, same perf |
| Health checks | Nothing | Built-in |
| CloudTrail logging | Nothing | Every API call audited |
| Memory persistence | Define schema | Async extraction + search |
| Security isolation | Nothing | MicroVM + sanitization |

## Comparison: Single Process vs. AgentCore

| Concern | Mac Mini / EC2 (single process) | AgentCore Runtime |
|---------|-------------------------------|-------------------|
| User isolation | None (shared process) | MicroVM per user |
| Credential isolation | None (shared API keys) | IAM per session |
| Crash isolation | One crash kills all | Isolated microVMs |
| Cost model | Fixed (24/7) | Pay-per-use |
| Scaling | 2-3 users max | Horizontal, unlimited |
| Security score | 2/100 (ZeroLeaks) | Enterprise-grade |
| Permission model | Application-level checks | Infrastructure-enforced |
| Memory isolation | Shared SQLite | Per-user namespaces |
