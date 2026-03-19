# Security Model

> Parent: [[Index]]

## The Problem with Single-Process Deployment

OpenClaw on a Mac Mini or single EC2 instance runs as **one process**:

- All users share the process
- All users share memory
- All users share file system access
- All users share API credentials
- ZeroLeaks security score: **2/100**
- Prompt injection success rate: **91%**
- **1,800+ exposed instances** found on the public internet

Real incident: **Asana MCP cross-tenant breach** (May 2025) — a logic flaw in session
isolation caused one organization's data to appear in another's agent responses.
Lasted 34 days, affected 1,000 organizations.

## AgentCore Security Model

### MicroVM Isolation

Each user session gets a dedicated microVM:
- **Isolated compute** — no shared CPU
- **Isolated memory** — no shared RAM
- **Isolated file system** — no shared disk
- **Isolated credentials** — no shared API keys
- **Session termination = microVM destroyed + memory sanitized**

User B's session is physically isolated from User A's. There's no shared memory to
contaminate, no shared process to crash, no shared credentials to leak.

### IAM-Scoped Credentials Per User

Each microVM gets its own IAM role with explicitly scoped permissions.

For a family:
- Kids' agent: homework help, general Q&A — no financial access, no shell access
- Parent agent: full access including financial accounts and shell execution
- The kids' agent **literally cannot** access financial accounts — not because of
  application-level checks, but because the IAM role doesn't have those permissions

### @requires_access_token Pattern

Permission enforcement at the infrastructure level:

```python
from bedrock_agentcore.identity import requires_access_token

@requires_access_token(
    provider_name="github-provider",
    scopes=["repo:read"]
)
async def review_pull_request(*, access_token: str, pr_url: str):
    # Unreachable for sessions without GitHub auth
    # Token scoped to exactly repo:read — nothing more
    ...
```

This is **structural, not procedural**. You don't write `if user.role == admin` checks.
The infrastructure enforces permissions before the code runs.

### No Public Ports

The recommended deployment exposes **zero public ports**:
- Gateway EC2 accessed via **SSM Session Manager** only
- No SSH, no HTTP endpoints on public internet
- Port forwarding via SSM for local access

### Audit Trail

- **CloudTrail** logs every Bedrock API call
- **CloudWatch** monitors Gateway health and AgentCore metrics
- **Cost Explorer** tracks per-user spending

## Comparison: Security Properties

| Property | Single Process | AgentCore |
|----------|---------------|-----------|
| User isolation | None (shared memory) | MicroVM per user |
| Credential isolation | None (shared keys) | IAM per session |
| Crash isolation | One crash kills all | Independent microVMs |
| Prompt injection scope | Can affect all users | Contained to one microVM |
| API key exposure | Plaintext in config | IAM roles, no keys |
| File system isolation | None | Per-microVM |
| Network exposure | Often public (1800+ instances) | SSM only, no public ports |
| Audit trail | Application logs only | CloudTrail + CloudWatch |
| Permission model | Application code checks | IAM infrastructure enforcement |

## The Honest Tradeoffs

**Local LLMs:** Mac Mini with Llama/Qwen3 locally gets zero API costs and zero data
leaving the device. For privacy-sensitive personal use, local wins.

**Full hardware access:** AgentCore sandboxing is a constraint. If you need deep OS-level
access (peripherals, local network devices, GUI apps), the cloud model adds friction.

**Data sovereignty:** Healthcare, finance, or government with strict data residency
requirements may not be satisfied even with VPC-isolated cloud deployment.

**Recommendation:**
- Local deployment: personal, privacy-sensitive, or local-LLM use cases
- AgentCore: team deployments, family with mixed trust levels, anything needing
  reliability + security + maintainability without a home lab

## Related Approaches

- **Cloudflare Moltworker:** Zero Trust Access + Sandboxes (similar insight, different layer)
- **AgentCore:** MicroVM isolation + IAM credentials (most complete implementation)
- These are the same insight at different layers — the infrastructure should make misuse
  structurally impossible, not rely on application-level checks
