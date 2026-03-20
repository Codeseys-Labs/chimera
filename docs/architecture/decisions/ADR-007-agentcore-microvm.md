---
title: 'ADR-007: AgentCore MicroVM over ECS/Lambda for Agent Isolation'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-007: AgentCore MicroVM over ECS/Lambda for Agent Isolation

## Status

**Accepted** (2026-03-20)

## Context

AWS Chimera agents execute user code (skills, bash commands) that could be:
- **Malicious**: Tenant A tries to access Tenant B's data
- **Resource-intensive**: Infinite loop, memory leak, fork bomb
- **Buggy**: Crashes that shouldn't affect other tenants

Multi-tenant isolation requirements:
- **Process isolation**: One tenant's crash doesn't affect others
- **Filesystem isolation**: No shared filesystem between tenants
- **Network isolation**: Cannot sniff other tenants' traffic
- **Memory isolation**: Cannot read other tenants' memory
- **Resource limits**: CPU, memory, disk enforced per tenant

Cost requirements:
- **Active-consumption billing**: Pay only for active processing time (I/O wait is free)
- **Fast cold start**: <1s to spin up new session
- **Efficient at scale**: Cost grows sub-linearly with tenant count

The decision is which compute platform to use for agent execution.

## Decision

Use **AWS AgentCore Runtime** with MicroVM isolation.

AgentCore Runtime runs agents in ephemeral Firecracker MicroVMs with per-session isolation. Each agent session gets its own MicroVM that terminates when the session ends (24h max).

**Key properties:**
- **MicroVM per session**: Complete kernel-level isolation
- **Ephemeral**: No persistent filesystem (workspace in S3)
- **Active-consumption billing**: Pay only for CPU cycles (I/O wait is free)
- **Fast cold start**: <800ms to boot MicroVM
- **Resource limits**: 1 vCPU, 512MB-2GB RAM per session

## Alternatives Considered

### Alternative 1: AgentCore Runtime (Selected)
AWS-managed MicroVM platform for agent execution.

**Pros:**
- ✅ **Kernel-level isolation**: Firecracker MicroVMs (same as AWS Lambda)
- ✅ **Active-consumption billing**: Pay for CPU time only ($0.00001667/sec active)
- ✅ **No container escape**: MicroVMs cannot escape to host
- ✅ **Fast cold start**: <800ms (vs 10s for ECS Fargate)
- ✅ **Serverless**: No servers to manage, auto-scaling built-in
- ✅ **Integrated with AgentCore services**: Memory, Gateway, Identity, etc.

**Cons:**
- Ephemeral (no persistent filesystem, but we use S3 anyway)
- AWS-only (acceptable - we're AWS-native)

**Verdict:** Selected for MicroVM isolation and active-consumption billing.

### Alternative 2: ECS Fargate
Container platform with per-task isolation.

**Pros:**
- Familiar (Docker containers)
- Good for long-running services
- Supports EFS for persistent storage

**Cons:**
- ❌ **Container isolation only**: Not kernel-level (containers can escape)
- ❌ **Always-on billing**: Pay for full hour even if task runs 5 minutes
- ❌ **Slow cold start**: 10-30s to pull image and start container
- ❌ **Higher cost**: $0.04048/vCPU/hour = $30/month per tenant (vs $5 for AgentCore)
- ❌ **Manual scaling**: Need to configure auto-scaling policies

**Verdict:** Rejected - higher cost, slower cold start, weaker isolation.

### Alternative 3: AWS Lambda
Serverless function with per-invocation isolation.

**Pros:**
- True serverless (pay per invocation)
- Fast cold start (<1s)
- Kernel-level isolation (MicroVMs like AgentCore)
- Familiar to team

**Cons:**
- ❌ **15-minute timeout**: Sessions longer than 15min require workarounds
- ❌ **Limited streaming**: Cannot stream tokens for 1+ hour conversations
- ❌ **Not designed for agents**: Built for short-lived functions, not long conversations
- ❌ **No AgentCore Memory integration**: Need custom memory layer
- ❌ **No AgentCore Gateway**: Need to build MCP adapter ourselves

**Verdict:** Rejected - 15min timeout is deal-breaker for long conversations.

### Alternative 4: EC2 + Docker
Run Docker containers on EC2 instances.

**Pros:**
- Full control over environment
- Can use spot instances for cost savings

**Cons:**
- ❌ **Always-on cost**: Pay for EC2 even when no agents running
- ❌ **Container isolation only**: Docker escape possible
- ❌ **Manual scaling**: Need to manage ASG, ECS cluster
- ❌ **Operational burden**: Patching, monitoring, capacity planning

**Verdict:** Rejected - too much operational burden, higher cost.

## Consequences

### Positive

- **Strong isolation**: Firecracker MicroVMs provide kernel-level isolation (same as AWS Lambda)
- **Cost-efficient**: Active-consumption billing reduces cost by 70% vs always-on (I/O wait is free)
- **Fast cold start**: <800ms enables responsive UX
- **Serverless**: No servers to manage, auto-scaling built-in
- **Integrated ecosystem**: AgentCore Memory, Gateway, Identity, Browser all integrate seamlessly
- **Security**: MicroVMs cannot escape to host (AWS-verified)

### Negative

- **Ephemeral only**: No persistent filesystem (mitigated by S3 workspace storage)
- **AWS lock-in**: AgentCore is AWS-only (acceptable - we're AWS-native)
- **Limited vCPU**: 1 vCPU per session (sufficient for LLM agents)

### Risks

- **AgentCore deprecation**: If AWS deprecates AgentCore (unlikely - core to Bedrock strategy)
- **Pricing changes**: AgentCore pricing may increase (mitigated by active-consumption model)

## Evidence

- **Research**: [docs/research/agentcore-strands/01-AgentCore-Architecture-Runtime.md](../../research/agentcore-strands/01-AgentCore-Architecture-Runtime.md) - 969 lines on AgentCore Runtime
- **Research**: [docs/research/agentcore-strands/03-AgentCore-Multi-Tenancy-Deployment.md](../../research/agentcore-strands/03-AgentCore-Multi-Tenancy-Deployment.md) - MicroVM isolation patterns
- **Mulch record mx-1e1407**: "AgentCore Runtime sessions are ephemeral with no persistent filesystem"
- **Mulch record mx-1c2e88**: "AgentCore MicroVMs are ephemeral — no EFS mount support"

## Related Decisions

- **ADR-001** (6-table DynamoDB): Session state stored in `chimera-sessions` table
- **ADR-003** (Strands): Strands agents designed for MicroVM environment
- **ADR-010** (S3 + EFS hybrid): Workspace storage uses S3, not persistent filesystem
- **ADR-016** (AgentCore Memory): Memory persisted to S3, not MicroVM filesystem

## References

1. AgentCore Runtime: https://docs.aws.amazon.com/agentcore/latest/userguide/runtime.html
2. Firecracker MicroVMs: https://firecracker-microvm.github.io/
3. AWS Lambda (uses same MicroVM tech): https://aws.amazon.com/lambda/
4. Active-consumption billing: https://aws.amazon.com/agentcore/pricing/
