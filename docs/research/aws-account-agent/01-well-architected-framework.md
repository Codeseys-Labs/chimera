# AWS Well-Architected Framework: Agent-Driven Decision Framework

> **Research Date:** 2026-03-20
> **Status:** Complete
> **Series:** AWS Account Agent Research (1 of N)
> **See also:** [[Chimera-Architecture-Review-Security]] | [[Chimera-AWS-Component-Blueprint]] | [[AgentCore-Architecture-Runtime]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#What is the AWS Well-Architected Framework?]]
- [[#The Six Pillars]]
- [[#Well-Architected Framework in Chimera]]
- [[#Pillar 1: Operational Excellence]]
- [[#Pillar 2: Security]]
- [[#Pillar 3: Reliability]]
- [[#Pillar 4: Performance Efficiency]]
- [[#Pillar 5: Cost Optimization]]
- [[#Pillar 6: Sustainability]]
- [[#Agent Decision Framework Integration]]
- [[#AWS Well-Architected Tool API]]
- [[#Collaborative Agent + User Workflows]]
- [[#Autonomous Agent Workflows]]
- [[#Implementation Roadmap]]
- [[#Gaps and Recommendations]]
- [[#Key Takeaways]]
- [[#Sources]]

---

## Executive Summary

The **AWS Well-Architected Framework** provides a systematic, proven methodology for evaluating cloud architectures against six foundational pillars: **Operational Excellence**, **Security**, **Reliability**, **Performance Efficiency**, **Cost Optimization**, and **Sustainability**. These pillars form a comprehensive decision-making framework that AWS customers have used for over a decade to build resilient, secure, and efficient systems.

**Chimera's existing architecture already embodies Well-Architected principles:**

| Pillar | Chimera Implementation | Evidence |
|--------|------------------------|----------|
| **Operational Excellence** | EventBridge-driven orchestration, OTEL observability, GitOps-gated IaC, runbooks | `docs/research/architecture-reviews/Chimera-Final-Architecture-Plan.md` |
| **Security** | MicroVM isolation, Cedar policies, JWT validation, IAM partition keys, skill verification | `docs/research/architecture-reviews/Chimera-Architecture-Review-Security.md` |
| **Reliability** | Multi-AZ DynamoDB, S3 cross-region replication, Lambda retries, EventBridge DLQ | `docs/research/architecture-reviews/Chimera-AWS-Component-Blueprint.md` |
| **Performance Efficiency** | AgentCore MicroVM autoscaling, consumption-based compute, DynamoDB GSI optimization | `docs/research/agentcore-strands/01-AgentCore-Architecture-Runtime.md` |
| **Cost Optimization** | Tiered pricing, active-consumption billing, S3 lifecycle policies, DynamoDB TTL | `docs/research/architecture-reviews/Chimera-Architecture-Review-Cost-Scale.md` |
| **Sustainability** | Serverless-first (Lambda, Fargate), consumption-based pricing eliminates idle resources | Implicit in architecture choices |

**Key Finding:** Chimera does not need to adopt Well-Architected principles — it already uses them. The opportunity is to **make these principles explicit and agent-accessible** so agents can:

1. **Evaluate infrastructure decisions** against the six pillars before proposing changes
2. **Collaborate with users** by presenting trade-offs in Well-Architected terms (e.g., "increasing retention improves Reliability but reduces Cost Optimization")
3. **Autonomously improve** by running periodic Well-Architected reviews and proposing optimizations
4. **Generate compliance artifacts** for enterprise customers requiring Well-Architected attestation

**Three integration paths:**

1. **Codified knowledge** — encode Well-Architected best practices as Cedar policies and decision trees
2. **API-driven reviews** — integrate AWS Well-Architected Tool API for automated workload assessments
3. **Agent-native workflows** — create `well-architected-reviewer` and `well-architected-optimizer` agents that operate autonomously

**No conflicts identified.** Chimera's architecture aligns with Well-Architected principles by design. The framework provides a **structured vocabulary** for agents to reason about architecture decisions, not a set of constraints to impose.

---

## What is the AWS Well-Architected Framework?

The AWS Well-Architected Framework is AWS's **opinionated guidance** for designing and operating reliable, secure, efficient, cost-effective, and sustainable systems in the cloud. It is the distillation of over a decade of AWS architectural experience, codified into a systematic evaluation methodology.

### Core Components

| Component | Description |
|-----------|-------------|
| **Six Pillars** | Operational Excellence, Security, Reliability, Performance Efficiency, Cost Optimization, Sustainability |
| **Design Principles** | High-level guidance for each pillar (e.g., "implement observability", "automate security best practices") |
| **Best Practices** | Specific recommendations organized as questions (e.g., "How do you manage workload and operations events?") |
| **AWS Well-Architected Tool** | Free service for conducting architecture reviews, generating reports, and tracking improvement plans |
| **Well-Architected Lenses** | Specialized guidance for specific workloads (Serverless, SaaS, Machine Learning, IoT, etc.) |

### How It Works

```
Workload Definition
    |
    v
[Six-Pillar Evaluation]
    |
    +-- Operational Excellence Questions (9)
    +-- Security Questions (14)
    +-- Reliability Questions (13)
    +-- Performance Efficiency Questions (8)
    +-- Cost Optimization Questions (8)
    +-- Sustainability Questions (6)
    |
    v
[Risk Assessment]
    |
    +-- High Risk Issues (RED)
    +-- Medium Risk Issues (YELLOW)
    +-- No Issues (GREEN)
    |
    v
[Improvement Plan]
    |
    +-- Prioritized action items
    +-- AWS resources and best practices
    +-- Milestones and tracking
```

### Value Propositions

1. **Consistent evaluation methodology** — same criteria across teams, projects, and AWS accounts
2. **Proactive risk identification** — find issues before they cause production incidents
3. **Prioritized improvement plans** — focus on high-risk gaps first
4. **Shared language** — architects, engineers, and business stakeholders use the same vocabulary
5. **Compliance and governance** — many enterprises require Well-Architected reviews for critical workloads

---

## The Six Pillars

### Pillar Overview

| Pillar | Focus | Key Question |
|--------|-------|--------------|
| **Operational Excellence** | Run and monitor systems, deliver business value, improve processes | How do we ensure our workloads run reliably and can be continuously improved? |
| **Security** | Protect data, systems, and assets | How do we protect information, systems, and assets while delivering business value? |
| **Reliability** | Recover from failures, meet demand, prevent outages | How do we ensure a workload performs its intended function correctly and consistently? |
| **Performance Efficiency** | Use resources efficiently, adapt to changing requirements | How do we use computing resources efficiently to meet requirements and maintain efficiency as demand changes? |
| **Cost Optimization** | Avoid unnecessary costs, understand spending | How do we achieve business outcomes at the lowest price point? |
| **Sustainability** | Minimize environmental impact of cloud workloads | How do we minimize the environmental impacts of running cloud workloads? |

### Design Principles Summary

Each pillar has 4-6 design principles. Here is a selection of the most relevant for Chimera:

#### Operational Excellence
- Perform operations as code (IaC, GitOps)
- Make frequent, small, reversible changes
- Anticipate failure
- Learn from operational events

#### Security
- Implement a strong identity foundation (IAM, least privilege)
- Enable traceability (logging, monitoring, auditing)
- Apply security at all layers (defense-in-depth)
- Automate security best practices
- Protect data in transit and at rest

#### Reliability
- Automatically recover from failure
- Test recovery procedures
- Scale horizontally for resilience
- Manage change through automation

#### Performance Efficiency
- Democratize advanced technologies (use managed services)
- Go global in minutes
- Use serverless architectures
- Experiment more often

#### Cost Optimization
- Implement cloud financial management
- Adopt a consumption model (pay only for what you use)
- Measure overall efficiency
- Stop spending money on undifferentiated heavy lifting

#### Sustainability
- Understand your impact (carbon footprint)
- Maximize utilization (avoid idle resources)
- Use managed services (AWS optimizes infrastructure efficiency)
- Reduce downstream impact (efficient data transfer, caching)

---

## Well-Architected Framework in Chimera

Chimera's architecture was not explicitly designed using the Well-Architected Framework, but a **retrospective analysis reveals strong alignment** across all six pillars.

### Alignment Analysis

#### Operational Excellence ✅

| Best Practice | Chimera Implementation |
|---------------|------------------------|
| Perform operations as code | 8-stack CDK architecture, GitOps deployment pipeline |
| Implement observability | OTEL + CloudWatch tracing, metrics per tenant, custom dashboards |
| Automate responses to events | EventBridge orchestration, Lambda DLQ processing, auto-remediation |
| Learn from failures | Mulch failure records, post-incident playbooks in `docs/runbooks/` |
| Evolve operations procedures | Self-modifying IaC with Cedar policy guardrails |

**Evidence:** `docs/research/architecture-reviews/Chimera-Architecture-Review-Platform-IaC.md` (8-stack CDK, CodePipeline), `docs/research/agentcore-strands/01-AgentCore-Architecture-Runtime.md` (OTEL observability)

#### Security ✅

| Best Practice | Chimera Implementation |
|---------------|------------------------|
| Implement strong identity | Cognito JWT with `custom:tenant_id` claim, IAM roles per tenant |
| Enable traceability | CloudTrail API logging, CloudWatch trace retention, audit DynamoDB table |
| Apply security at all layers | MicroVM isolation, VPC, security groups, Cedar policies, skill sandboxing |
| Automate security practices | 7-stage skill verification pipeline, IAM partition key enforcement via CDK |
| Protect data in transit/rest | TLS 1.3 for all APIs, KMS encryption for DynamoDB/S3 (per-tenant keys) |

**Evidence:** `docs/research/architecture-reviews/Chimera-Architecture-Review-Security.md` (STRIDE analysis, threat model, defense-in-depth)

#### Reliability ✅

| Best Practice | Chimera Implementation |
|---------------|------------------------|
| Automatically recover from failure | Lambda retries (3x), DynamoDB point-in-time recovery, S3 versioning |
| Test recovery procedures | Disaster recovery runbooks in `docs/runbooks/disaster-recovery.md` |
| Scale horizontally | AgentCore MicroVM autoscaling, DynamoDB on-demand mode, ALB across AZs |
| Manage change through automation | GitOps pipeline with staging/canary deployment, rollback via CDK versioning |
| Monitor all layers | CloudWatch alarms for DynamoDB throttling, Lambda errors, API Gateway 5xx |

**Evidence:** `docs/research/architecture-reviews/Chimera-AWS-Component-Blueprint.md` (multi-AZ, cross-region replication)

#### Performance Efficiency ✅

| Best Practice | Chimera Implementation |
|---------------|------------------------|
| Use advanced technologies | Amazon Bedrock for multi-model support, AgentCore for serverless agents |
| Go global | Multi-region deployment (us-west-2 primary, us-east-1 DR) |
| Use serverless architectures | Lambda for API layer, Fargate for chat, AgentCore Runtime for agents |
| Experiment often | Canary deployments (5% traffic), A/B testing for model routing |
| Monitor performance | Active-consumption billing reveals I/O wait inefficiencies |

**Evidence:** `docs/research/agentcore-strands/01-AgentCore-Architecture-Runtime.md` (8-hour workloads, consumption-based pricing)

#### Cost Optimization ✅

| Best Practice | Chimera Implementation |
|---------------|------------------------|
| Adopt consumption model | AgentCore active-consumption (I/O wait is free), DynamoDB on-demand |
| Measure overall efficiency | DynamoDB `chimera-cost-tracking` table, per-tenant cost attribution |
| Stop paying for idle resources | DynamoDB TTL for ephemeral data, S3 lifecycle policies (90d -> Glacier) |
| Analyze spending patterns | Monthly cost dashboards, budget alerts per tenant tier |
| Use managed services | AgentCore, Bedrock, DynamoDB, S3 — no EC2 management overhead |

**Evidence:** `docs/research/architecture-reviews/Chimera-Architecture-Review-Cost-Scale.md` (tiered pricing, cost tracking)

#### Sustainability ✅ (Implicit)

| Best Practice | Chimera Implementation |
|---------------|------------------------|
| Maximize utilization | Consumption-based pricing means no idle compute, ephemeral MicroVMs |
| Use managed services | AWS optimizes datacenter efficiency for Bedrock, DynamoDB, AgentCore |
| Reduce data movement | Regional affinity (sessions stay in one region), S3 Transfer Acceleration |
| Optimize software | Active-consumption billing incentivizes efficient code (reduce CPU time) |
| Use efficient hardware | AgentCore MicroVMs on Graviton (more energy-efficient than x86) |

**Evidence:** Implicit in serverless-first architecture — no dedicated servers, no idle capacity

### Verdict

**Chimera already implements Well-Architected best practices.** The framework does not impose new constraints — it provides a **vocabulary** for agents to reason about trade-offs and communicate decisions to users.

---

## Pillar 1: Operational Excellence

### Definition

> Run and monitor systems to deliver business value, and continually improve supporting processes and procedures.

### Key Concepts for Agents

| Concept | Agent Application |
|---------|-------------------|
| **Operations as Code** | Agents propose infrastructure changes via CDK, not manual console clicks |
| **Frequent Small Changes** | Agents prefer incremental updates over large rewrites (smaller blast radius) |
| **Anticipate Failure** | Agents evaluate "what could go wrong?" before deploying (pre-mortem analysis) |
| **Learn from Failures** | Agents record learnings in Mulch after incidents, update runbooks |
| **Observability** | Agents check CloudWatch metrics before proposing scaling changes |

### Operational Excellence Questions (Subset)

1. **How do you determine what your priorities are?**
   - Chimera: Tenant tier determines priorities (enterprise > pro > basic)
   - Agent decision: "This change impacts enterprise tenants → high priority"

2. **How do you design your workload so you can understand its state?**
   - Chimera: OTEL tracing, CloudWatch dashboards, per-tenant metrics
   - Agent decision: "Add trace span to new tool invocation for debugging"

3. **How do you manage workload and operations events?**
   - Chimera: EventBridge orchestration, Lambda DLQ, automated alerts
   - Agent decision: "EventBridge rule failed → check DLQ, propose remediation"

4. **How do you evolve operations?**
   - Chimera: Self-modifying IaC with Cedar policy enforcement
   - Agent decision: "Observed pattern of manual scaling → propose auto-scaling CDK change"

### Agent-Driven Operational Excellence

Agents can improve operational excellence by:

1. **Automated runbook execution** — `ops-agent` responds to alerts by following documented playbooks
2. **Proactive capacity planning** — agents analyze trends and propose scaling before limits are hit
3. **Continuous documentation** — agents update runbooks after each incident resolution
4. **Cost-benefit analysis** — agents evaluate operational overhead vs. benefit for new features

**Example workflow:**

```
CloudWatch Alarm: DynamoDB ThrottledRequests
    |
    v
EventBridge Trigger
    |
    v
ops-agent invoked
    |
    v
Agent evaluates:
  - Current capacity: 100 RCU
  - Throttle rate: 15% of requests
  - Cost impact: +$50/month to scale to 150 RCU
  - Business impact: Tier analysis shows 80% throttles are enterprise tenants
    |
    v
Decision: Scale to 150 RCU (enterprise SLA breach > cost)
    |
    v
Agent proposes CDK change, sends for approval
    |
    v
GitOps pipeline deploys change
    |
    v
Agent records learning: "Throttling during peak hours (9-11am PT) for enterprise → preemptive scaling recommended"
```

---

## Pillar 2: Security

### Definition

> Protect information, systems, and assets while delivering business value through risk assessments and mitigation strategies.

### Key Concepts for Agents

| Concept | Agent Application |
|---------|-------------------|
| **Least Privilege** | Agents request minimal IAM permissions for each operation |
| **Defense in Depth** | Agents evaluate security at multiple layers (network, IAM, data) |
| **Traceability** | All agent actions logged to CloudTrail and audit DynamoDB table |
| **Automated Security** | Agents enforce security policies via Cedar, not manual reviews |
| **Data Protection** | Agents use KMS encryption for all sensitive data writes |

### Security Questions (Subset)

1. **How do you securely operate your workload?**
   - Chimera: IAM roles per tenant, MicroVM isolation, Cedar policy enforcement
   - Agent decision: "Skill requests S3 write → check tenant IAM policy allows this prefix"

2. **How do you detect and investigate security events?**
   - Chimera: CloudTrail, GuardDuty, audit table with 90d-7yr retention
   - Agent decision: "Anomalous API call pattern detected → escalate to security team"

3. **How do you protect your data at rest?**
   - Chimera: KMS per-tenant keys, S3 bucket encryption, DynamoDB encryption
   - Agent decision: "New tenant onboarding → create dedicated KMS key"

4. **How do you protect your data in transit?**
   - Chimera: TLS 1.3 for all APIs, VPC PrivateLink for AgentCore
   - Agent decision: "Skill attempts HTTP connection → block, require HTTPS"

### Agent-Driven Security

Agents can improve security by:

1. **Threat modeling** — agents evaluate new features against STRIDE model
2. **Policy enforcement** — agents reject operations that violate Cedar policies
3. **Anomaly detection** — agents identify unusual access patterns and alert
4. **Compliance reporting** — agents generate SOC 2 / HIPAA compliance artifacts

**Example workflow:**

```
User: "Install skill: data-exporter"
    |
    v
skill-installer-agent evaluates skill
    |
    v
Skill analysis:
  - Requests: S3 read, external HTTPS POST
  - Risk: Data exfiltration to external endpoint
    |
    v
Agent checks Cedar policy:
  - Policy: "Skills with external network access require enterprise tier + explicit approval"
  - Tenant tier: Pro (not enterprise)
    |
    v
Decision: Block installation
    |
    v
Agent response: "This skill requires external network access, which is only allowed for enterprise tier. Upgrade to enterprise or choose a different skill."
```

---

## Pillar 3: Reliability

### Definition

> Ensure a workload performs its intended function correctly and consistently, including the ability to operate and test the workload through its total lifecycle.

### Key Concepts for Agents

| Concept | Agent Application |
|---------|-------------------|
| **Automatic Recovery** | Agents retry failed operations (Lambda 3x, exponential backoff) |
| **Horizontal Scaling** | Agents add capacity by scaling out, not up (AgentCore MicroVMs) |
| **Test Recovery** | Agents simulate failure scenarios (chaos engineering) |
| **Change Management** | Agents use canary deployments to limit blast radius |
| **Monitor Everything** | Agents check all dependencies before declaring "healthy" |

### Reliability Questions (Subset)

1. **How do you manage service quotas and constraints?**
   - Chimera: Tier-based quotas, rate limiting via DynamoDB token bucket
   - Agent decision: "Tenant approaching quota → send warning, offer upgrade"

2. **How do you plan your network topology?**
   - Chimera: Multi-AZ VPC, public/private subnets, NAT gateway redundancy
   - Agent decision: "New service needs internet → add NAT gateway to private subnet"

3. **How do you design your workload to adapt to changes in demand?**
   - Chimera: AgentCore autoscaling, DynamoDB on-demand, Lambda concurrency
   - Agent decision: "Observed 3x traffic spike on Black Friday → pre-scale next year"

4. **How do you implement change?**
   - Chimera: GitOps with staging → canary (5%) → production rollout
   - Agent decision: "High-risk change → require manual approval gate"

### Agent-Driven Reliability

Agents can improve reliability by:

1. **Proactive failure detection** — agents identify degraded services before users complain
2. **Automated recovery** — agents execute runbooks to restore service
3. **Capacity forecasting** — agents predict resource needs based on historical trends
4. **Chaos engineering** — agents periodically inject failures to test resilience

**Example workflow:**

```
reliability-agent monitors DynamoDB metrics
    |
    v
Observed: Read latency p99 increasing from 5ms to 50ms over 3 days
    |
    v
Agent hypothesis: Hot partition due to uneven key distribution
    |
    v
Agent checks:
  - GSI usage patterns
  - Partition key cardinality
    |
    v
Root cause: 80% of reads hitting one tenant (large customer spike)
    |
    v
Agent recommendation: Add GSI or refactor partition key
    |
    v
Agent proposes CDK change, sends to architect for review
```

---

## Pillar 4: Performance Efficiency

### Definition

> Use computing resources efficiently to meet system requirements and maintain that efficiency as demand changes and technologies evolve.

### Key Concepts for Agents

| Concept | Agent Application |
|---------|-------------------|
| **Right-Sizing** | Agents analyze actual usage and recommend optimal resource allocation |
| **Experimentation** | Agents A/B test different configurations (models, instance types) |
| **Monitoring** | Agents track performance metrics and identify bottlenecks |
| **Technology Evolution** | Agents evaluate new AWS services (e.g., Graviton vs. x86) |
| **Serverless** | Agents prefer serverless (Lambda, Fargate) to eliminate capacity planning |

### Performance Efficiency Questions (Subset)

1. **How do you select the best performing architecture?**
   - Chimera: AgentCore MicroVMs (serverless), Bedrock (managed inference)
   - Agent decision: "Compare Nova Lite vs. Claude Haiku latency → choose faster for chat"

2. **How do you select your compute solution?**
   - Chimera: Lambda for API, Fargate for chat, AgentCore Runtime for agents
   - Agent decision: "New workload: long-running → use AgentCore (8h) not Lambda (15m)"

3. **How do you select your storage solution?**
   - Chimera: DynamoDB for structured data, S3 for blobs, EFS for POSIX workspaces
   - Agent decision: "Skill needs filesystem → mount EFS, not S3"

4. **How do you use metrics to improve performance?**
   - Chimera: CloudWatch metrics per tenant, active-consumption billing data
   - Agent decision: "Observed: 60% I/O wait → optimize API calls to reduce latency"

### Agent-Driven Performance Efficiency

Agents can improve performance by:

1. **Continuous optimization** — agents identify inefficiencies and propose fixes
2. **A/B testing** — agents compare alternatives and select the best performer
3. **Anomaly detection** — agents flag performance regressions
4. **Technology recommendations** — agents stay current with new AWS features

**Example workflow:**

```
performance-agent analyzes AgentCore Runtime metrics
    |
    v
Observed: Average I/O wait: 65% (typical: 30-40%)
    |
    v
Agent hypothesis: Excessive LLM API calls due to poor prompt design
    |
    v
Agent checks:
  - Bedrock API latency: 2.5s average
  - Tool calls per session: 12 (typical: 4-6)
    |
    v
Root cause: Agent invoking multiple small LLM calls instead of batching
    |
    v
Agent recommendation: Refactor prompt to reduce round-trips
    |
    v
Agent proposes prompt optimization, estimates 40% cost reduction
```

---

## Pillar 5: Cost Optimization

### Definition

> Run systems to deliver business value at the lowest price point, avoiding unnecessary costs and maximizing return on investment.

### Key Concepts for Agents

| Concept | Agent Application |
|---------|-------------------|
| **Consumption Model** | Agents track usage-based costs (AgentCore, DynamoDB, S3) |
| **Cost Attribution** | Agents tag resources by tenant for accurate cost tracking |
| **Right-Sizing** | Agents identify over-provisioned resources and recommend downsizing |
| **Data Lifecycle** | Agents move data to cheaper storage tiers (S3 → Glacier) |
| **Waste Elimination** | Agents identify unused resources (old snapshots, unattached volumes) |

### Cost Optimization Questions (Subset)

1. **How do you govern usage?**
   - Chimera: Tiered pricing (basic/pro/enterprise), per-tenant quotas
   - Agent decision: "Tenant exceeds free tier usage → notify, suggest upgrade"

2. **How do you monitor usage and cost?**
   - Chimera: DynamoDB `chimera-cost-tracking` table, CloudWatch dashboards
   - Agent decision: "Monthly cost spike for tenant → investigate root cause"

3. **How do you decommission resources?**
   - Chimera: DynamoDB TTL for ephemeral data, S3 lifecycle policies
   - Agent decision: "Session ended 90 days ago → delete S3 session snapshot"

4. **How do you evaluate cost when selecting services?**
   - Chimera: AgentCore active-consumption vs. Lambda vs. Fargate comparison
   - Agent decision: "Long-running workload → AgentCore cheaper than Fargate"

### Agent-Driven Cost Optimization

Agents can optimize costs by:

1. **Automated cleanup** — agents delete unused resources (old Lambda versions, snapshots)
2. **Right-sizing recommendations** — agents analyze usage and suggest cheaper alternatives
3. **Reserved capacity planning** — agents predict steady-state usage and recommend RIs/SPs
4. **Cost anomaly detection** — agents alert on unexpected spending spikes

**Example workflow:**

```
cost-optimizer-agent reviews monthly spending
    |
    v
Observed: S3 storage cost increased 200% month-over-month
    |
    v
Agent investigates:
  - S3 bucket: chimera-tenants-us-west-2
  - Growth: 500 GB → 1.5 TB
  - Primary contributor: session snapshots (not lifecycle-managed)
    |
    v
Root cause: Lifecycle policy misconfigured (not applied to /sessions/ prefix)
    |
    v
Agent recommendation: Apply lifecycle policy
  - 30d: Standard → Infrequent Access
  - 90d: Infrequent Access → Glacier
  - 365d: Delete
    |
    v
Agent proposes CDK change, estimates $400/month savings
```

---

## Pillar 6: Sustainability

### Definition

> Minimize the environmental impacts of running cloud workloads, including energy consumption and resource efficiency.

### Key Concepts for Agents

| Concept | Agent Application |
|---------|-------------------|
| **Maximize Utilization** | Agents eliminate idle resources (consumption-based pricing) |
| **Right-Sizing** | Agents ensure resources are not over-provisioned |
| **Efficient Software** | Agents optimize code to reduce CPU time (fewer carbon emissions) |
| **Data Reduction** | Agents compress data, deduplicate, and minimize transfers |
| **Managed Services** | Agents prefer AWS-managed services (AWS optimizes datacenter efficiency) |

### Sustainability Questions (Subset)

1. **How do you select Regions for your workload?**
   - Chimera: us-west-2 (Oregon) primary — AWS uses renewable energy
   - Agent decision: "New region needed → prioritize renewable energy regions"

2. **How do you take advantage of software and architecture patterns?**
   - Chimera: Serverless, consumption-based pricing, ephemeral compute
   - Agent decision: "Use AgentCore MicroVMs (auto-terminate) vs. ECS (always-on)"

3. **How do you optimize data access and storage?**
   - Chimera: S3 lifecycle policies, DynamoDB TTL, compression
   - Agent decision: "Old logs → compress and move to Glacier"

4. **How do you take advantage of hardware patterns?**
   - Chimera: AgentCore on Graviton (more energy-efficient than x86)
   - Agent decision: "Lambda function → migrate to arm64 for 20% efficiency gain"

### Agent-Driven Sustainability

Agents can improve sustainability by:

1. **Idle resource elimination** — agents identify and delete unused resources
2. **Efficiency optimization** — agents refactor code to reduce CPU time
3. **Data minimization** — agents compress, deduplicate, and delete unnecessary data
4. **Renewable energy** — agents prioritize regions with high renewable energy usage

**Example workflow:**

```
sustainability-agent audits Lambda functions
    |
    v
Observed: 120 Lambda functions across all tenants
    |
    v
Agent checks:
  - Architecture: x86 (80%), arm64 (20%)
  - Graviton-compatible: 95 functions (79%)
    |
    v
Agent recommendation: Migrate x86 → arm64 where possible
  - Estimated energy reduction: 20% (Graviton is more efficient)
  - Estimated cost reduction: 20% (Graviton is cheaper)
    |
    v
Agent proposes CDK changes for all compatible functions
```

---

## Agent Decision Framework Integration

### How Agents Use Well-Architected Principles

Agents can integrate Well-Architected principles into decision-making in three ways:

#### 1. Pre-Decision Evaluation

Before proposing infrastructure changes, agents evaluate the change against all six pillars:

```python
# Agent decision logic
proposed_change = {
    "action": "increase_dynamodb_capacity",
    "from": "100 RCU",
    "to": "200 RCU",
}

evaluation = evaluate_against_pillars(proposed_change)

# Example output:
{
    "operational_excellence": {
        "score": "POSITIVE",
        "rationale": "Reduces operational burden by preventing throttling alerts"
    },
    "security": {
        "score": "NEUTRAL",
        "rationale": "No security impact"
    },
    "reliability": {
        "score": "POSITIVE",
        "rationale": "Eliminates throttling, improves availability"
    },
    "performance_efficiency": {
        "score": "POSITIVE",
        "rationale": "Reduces read latency by eliminating throttling"
    },
    "cost_optimization": {
        "score": "NEGATIVE",
        "rationale": "Increases monthly cost by $50 (100 RCU → 200 RCU)"
    },
    "sustainability": {
        "score": "NEGATIVE",
        "rationale": "Increased capacity may lead to idle resources during low traffic"
    }
}

# Agent presents trade-offs to user
agent_message = """
I recommend increasing DynamoDB capacity from 100 RCU to 200 RCU.

**Benefits:**
- ✅ Reliability: Eliminates throttling (currently 15% of requests)
- ✅ Performance: Reduces p99 read latency from 50ms to 5ms
- ✅ Operational Excellence: Reduces on-call burden (no more throttling alerts)

**Trade-offs:**
- ⚠️ Cost Optimization: +$50/month (+50% increase)
- ⚠️ Sustainability: May lead to idle capacity during off-peak hours

**Recommendation:** Proceed with scaling. The reliability and performance benefits outweigh the cost increase for enterprise tier tenants (80% of throttled requests are from enterprise customers with SLA requirements).
"""
```

#### 2. Collaborative Trade-Off Presentation

Agents present decisions in Well-Architected terms so users understand implications:

| Agent Capability | User Benefit |
|------------------|--------------|
| **Transparent reasoning** | Users see WHY the agent recommends a decision |
| **Trade-off clarity** | Users understand pros/cons across all six pillars |
| **Pillar alignment** | Users can override based on their priorities (e.g., "cost is more important than performance for this workload") |
| **Shared vocabulary** | Agents and users communicate using Well-Architected terms |

#### 3. Autonomous Optimization

Agents periodically run Well-Architected reviews and propose improvements:

```
well-architected-reviewer-agent schedule:
  - Daily: Cost anomaly detection (spike > 20% → investigate)
  - Weekly: Performance regression analysis (latency trends)
  - Monthly: Security posture review (new CVEs, policy violations)
  - Quarterly: Full six-pillar review (generate Well-Architected report)
```

---

## AWS Well-Architected Tool API

The **AWS Well-Architected Tool** provides an API for programmatic workload reviews. Agents can integrate with this API to:

1. **Create workloads** — define Chimera as a workload in the Well-Architected Tool
2. **Answer questions** — agents answer the 58 questions across six pillars
3. **Generate reports** — agents produce Well-Architected Review reports for compliance
4. **Track improvements** — agents monitor risk remediation over time

### API Operations

| API | Purpose | Agent Use Case |
|-----|---------|----------------|
| `CreateWorkload` | Define a workload for review | Agent creates "Chimera Multi-Tenant Platform" workload |
| `UpdateWorkload` | Modify workload definition | Agent updates architecture description after changes |
| `GetWorkload` | Retrieve workload details | Agent checks current risk profile |
| `ListWorkloads` | List all workloads | Agent audits all tenant-specific workloads |
| `UpdateAnswer` | Answer pillar questions | Agent answers "How do you detect security events?" → "CloudTrail + GuardDuty" |
| `GetAnswer` | Retrieve answer details | Agent checks if answer is marked as "HIGH_RISK" |
| `GetLensReview` | Retrieve pillar review summary | Agent generates monthly security pillar report |
| `CreateMilestone` | Snapshot current state | Agent creates milestone after major architecture change |
| `ListMilestones` | Track improvement history | Agent shows risk reduction over time |

### Integration Architecture

```
well-architected-agent
    |
    v
[AWS Well-Architected Tool API]
    |
    +-- CreateWorkload: "Chimera Platform"
    +-- UpdateAnswer (58 questions across 6 pillars)
    +-- GetLensReview (retrieve risk scores)
    +-- CreateMilestone (snapshot after improvements)
    |
    v
[Well-Architected Report]
    |
    +-- High-Risk Issues: 3
    +-- Medium-Risk Issues: 8
    +-- Answered Questions: 58/58
    +-- Improvement Plan: [prioritized actions]
    |
    v
Agents execute improvement plan autonomously
```

### Example: Automated Well-Architected Review

```python
import boto3

# Initialize Well-Architected client
wa_client = boto3.client('wellarchitected')

# Create Chimera workload
workload = wa_client.create_workload(
    WorkloadName='Chimera Multi-Tenant Agent Platform',
    Description='AWS Bedrock AgentCore-based multi-tenant AI agent platform',
    Environment='PRODUCTION',
    AccountIds=['123456789012'],
    AwsRegions=['us-west-2', 'us-east-1'],
    Lenses=['wellarchitected'],  # Use standard Well-Architected lens
)

workload_id = workload['WorkloadId']

# Answer Security Pillar questions
wa_client.update_answer(
    WorkloadId=workload_id,
    LensAlias='wellarchitected',
    QuestionId='sec-1',  # "How do you securely operate your workload?"
    SelectedChoices=[
        'sec_1_perform_root_user_tasks',
        'sec_1_use_programmatic_access',
        'sec_1_use_multi_factor_authentication',
    ],
    Notes='Chimera uses Cognito for user auth, IAM roles per tenant, MFA enforced for admin access.',
)

# Retrieve lens review (risk summary)
review = wa_client.get_lens_review(
    WorkloadId=workload_id,
    LensAlias='wellarchitected',
)

print(f"High Risk Issues: {review['LensReview']['RiskCounts']['HIGH']}")
print(f"Medium Risk Issues: {review['LensReview']['RiskCounts']['MEDIUM']}")

# Create milestone (snapshot current state)
wa_client.create_milestone(
    WorkloadId=workload_id,
    MilestoneName='Q1 2026 Review',
)
```

### Agent Workflow: Monthly Well-Architected Review

```
[Scheduled EventBridge Rule: Monthly]
    |
    v
well-architected-reviewer-agent invoked
    |
    v
Agent fetches workload: "Chimera Platform"
    |
    v
Agent answers 58 questions using:
  - CloudFormation stack introspection
  - DynamoDB table configuration
  - IAM policy analysis
  - CloudWatch metrics
  - Security Hub findings
    |
    v
Agent generates report:
  - High-Risk Issues: 2
    1. "No automated backup testing for DynamoDB" (Reliability)
    2. "Session timeout > 30 minutes" (Security)
  - Medium-Risk Issues: 5
    |
    v
Agent creates Improvement Plan:
  - Priority 1: Implement monthly DR drill
  - Priority 2: Reduce session timeout to 15 minutes
  - Priority 3: Migrate Lambda x86 → arm64 (Sustainability)
    |
    v
Agent sends report to Slack + email
Agent creates tasks in Seeds issue tracker
```

---

## Collaborative Agent + User Workflows

### Scenario 1: Infrastructure Change Proposal

**User request:** "Increase DynamoDB read capacity to handle higher traffic."

**Agent workflow:**

1. **Analyze current state:**
   - Current: 100 RCU, 15% throttling during peak hours
   - Proposed: 200 RCU

2. **Evaluate against Well-Architected pillars:**
   - ✅ **Reliability:** Eliminates throttling
   - ✅ **Performance:** Reduces read latency
   - ⚠️ **Cost:** +$50/month
   - ⚠️ **Sustainability:** Potential idle capacity

3. **Present trade-offs to user:**

```
Agent: I recommend scaling DynamoDB from 100 RCU to 200 RCU.

**Well-Architected Analysis:**

✅ **Reliability** — Eliminates 15% throttling rate, improving availability
✅ **Performance Efficiency** — Reduces p99 read latency from 50ms to 5ms
✅ **Operational Excellence** — Reduces on-call burden (no throttling alerts)
⚠️ **Cost Optimization** — Increases monthly cost by $50 (100 → 200 RCU)
⚠️ **Sustainability** — May lead to idle resources during off-peak hours (consider auto-scaling instead)
✔️ **Security** — No security impact

**Alternative:** Enable DynamoDB auto-scaling (50-200 RCU) for same reliability with 30% lower cost.

Do you want to proceed with fixed 200 RCU or enable auto-scaling?
```

4. **User decides:** "Enable auto-scaling."

5. **Agent implements:** Proposes CDK change to add auto-scaling policy, sends to GitOps pipeline.

### Scenario 2: Cost Spike Investigation

**Alert:** Monthly AWS bill increased 50%.

**Agent workflow:**

1. **Cost Optimization pillar:** Agent identifies cost anomaly
2. **Investigates root cause:**
   - S3 storage: +200% (session snapshots not lifecycle-managed)
3. **Proposes solution:**
   - Apply S3 lifecycle policy (30d → IA, 90d → Glacier, 365d → delete)
   - Estimated savings: $400/month
4. **Evaluates against pillars:**
   - ✅ **Cost Optimization:** Reduces S3 costs by 70%
   - ✅ **Sustainability:** Reduces storage footprint
   - ⚠️ **Operational Excellence:** Requires monitoring to ensure lifecycle doesn't delete active sessions
5. **Presents to user:** "I found the root cause of the cost spike and recommend applying a lifecycle policy. This will save $400/month with minimal operational overhead."

### Scenario 3: Security Posture Review

**Compliance requirement:** SOC 2 audit requires Well-Architected Security pillar attestation.

**Agent workflow:**

1. **Security pillar:** Agent conducts automated security review
2. **Answers 14 security questions** using:
   - CloudFormation introspection
   - IAM policy analysis
   - GuardDuty findings
   - CloudTrail logs
3. **Generates findings:**
   - ✅ 10 questions: No issues
   - ⚠️ 3 questions: Medium risk (no automated vulnerability scanning for Lambda)
   - ❌ 1 question: High risk (session timeout > 30 minutes)
4. **Creates improvement plan:**
   - Priority 1: Reduce session timeout to 15 minutes
   - Priority 2: Enable Amazon Inspector for Lambda scanning
5. **Generates SOC 2 report:** Agent produces Well-Architected Security Review PDF for auditors

---

## Autonomous Agent Workflows

### Workflow 1: Continuous Cost Optimization

**Agent:** `cost-optimizer-agent`

**Schedule:** Daily

**Workflow:**

1. **Query cost tracking table:** `chimera-cost-tracking`
2. **Identify anomalies:** Cost spikes > 20% day-over-day
3. **Investigate root cause:** S3, DynamoDB, Lambda, AgentCore Runtime
4. **Evaluate solutions:**
   - Lifecycle policies
   - Right-sizing
   - Reserved capacity
5. **Propose changes:** CDK updates, send to GitOps pipeline
6. **Track savings:** Record in Mulch with `--outcome-status success`

**Example output:**

```
cost-optimizer-agent detected anomaly:
  - S3 storage: +40% in 7 days
  - Root cause: Session snapshots (no lifecycle policy)
  - Solution: Apply lifecycle policy (30d → IA, 90d → Glacier)
  - Estimated savings: $150/month
  - Proposal: PR #1234 (CDK change)
```

### Workflow 2: Reliability Monitoring

**Agent:** `reliability-agent`

**Schedule:** Continuous (EventBridge triggers on CloudWatch alarms)

**Workflow:**

1. **Monitor CloudWatch metrics:**
   - DynamoDB throttling
   - Lambda errors
   - API Gateway 5xx
2. **Detect degradation:** p99 latency > threshold
3. **Execute runbook:** Follow documented recovery procedures
4. **Evaluate impact:**
   - Reliability: Restored service
   - Cost: Emergency scaling cost
5. **Record learning:** Update Mulch with root cause and fix
6. **Update runbook:** Improve documentation for next incident

**Example output:**

```
reliability-agent detected DynamoDB throttling:
  - Table: chimera-sessions
  - Throttle rate: 15%
  - Impact: Enterprise tier tenants (SLA breach)
  - Action: Emergency scaling (100 RCU → 200 RCU)
  - Result: Throttling eliminated within 30 seconds
  - Cost impact: +$50/month (acceptable for SLA compliance)
  - Learning recorded: "Peak traffic pattern 9-11am PT → pre-scale next month"
```

### Workflow 3: Security Posture Drift Detection

**Agent:** `security-agent`

**Schedule:** Weekly

**Workflow:**

1. **Run Security pillar review:** Answer 14 security questions
2. **Compare to baseline:** Check for new high-risk findings
3. **Detect drift:** IAM policy changes, new CVEs, GuardDuty findings
4. **Evaluate risk:**
   - Security: New vulnerability detected
   - Operational Excellence: Requires patching
5. **Propose remediation:** Update Lambda runtime, apply security patch
6. **Track compliance:** Generate weekly security report

**Example output:**

```
security-agent detected security drift:
  - Finding: Lambda function using Python 3.9 (EOL in 30 days)
  - Risk: HIGH (unsupported runtime)
  - Recommendation: Upgrade to Python 3.12
  - Action: PR #1235 (Lambda runtime upgrade)
  - Compliance: Required for SOC 2 certification
```

---

## Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)

**Goal:** Codify Well-Architected principles as agent knowledge

| Task | Owner | Deliverable |
|------|-------|-------------|
| Document current architecture against six pillars | `builder-wa-doc` | This document |
| Create Cedar policies for Well-Architected constraints | `builder-security` | `infra/lib/cedar-policies/well-architected.cedar` |
| Add pillar evaluation to agent decision logic | `builder-agent-core` | `packages/core/src/agents/decision-framework.ts` |

**Outcome:** Agents can evaluate decisions against six pillars

### Phase 2: AWS Well-Architected Tool Integration (Weeks 3-4)

**Goal:** Automate Well-Architected reviews

| Task | Owner | Deliverable |
|------|-------|-------------|
| Create "Chimera Platform" workload in Well-Architected Tool | `builder-ops` | Workload ID, baseline answers |
| Build `well-architected-reviewer-agent` | `builder-agent` | Agent that answers 58 questions programmatically |
| Implement monthly review workflow | `builder-ops` | EventBridge schedule → agent → Slack report |

**Outcome:** Automated monthly Well-Architected reviews

### Phase 3: Collaborative Workflows (Weeks 5-6)

**Goal:** Agent + user collaboration on trade-off decisions

| Task | Owner | Deliverable |
|------|-------|-------------|
| Add pillar trade-off presentation to UI | `builder-frontend` | Chat UI shows ✅/⚠️/❌ for each pillar |
| Build pillar-override workflow | `builder-agent` | User can override agent decision (e.g., "prioritize cost over performance") |
| User feedback loop | `builder-agent` | Agent learns user preferences over time |

**Outcome:** Users understand trade-offs and can guide agent decisions

### Phase 4: Autonomous Optimization (Weeks 7-8)

**Goal:** Agents proactively improve architecture

| Task | Owner | Deliverable |
|------|-------|-------------|
| Build `cost-optimizer-agent` | `builder-agent` | Daily cost anomaly detection + remediation |
| Build `reliability-agent` | `builder-agent` | Continuous monitoring + auto-recovery |
| Build `security-agent` | `builder-agent` | Weekly security posture review |
| Build `sustainability-agent` | `builder-agent` | Monthly efficiency optimization |

**Outcome:** Agents autonomously improve architecture without human intervention

---

## Gaps and Recommendations

### Identified Gaps

| Gap | Current State | Desired State | Priority |
|-----|---------------|---------------|----------|
| **Automated Well-Architected reviews** | Manual, ad-hoc | Scheduled monthly reviews via API | HIGH |
| **Pillar trade-off presentation** | Agents don't explain decisions in Well-Architected terms | Agents present ✅/⚠️/❌ for each pillar | MEDIUM |
| **Sustainability metrics** | Not explicitly tracked | Carbon footprint dashboard, efficiency metrics | LOW |
| **Compliance automation** | Manual SOC 2 artifact generation | Agent-generated Well-Architected reports | MEDIUM |
| **User preference learning** | Agents don't remember user priorities | Agent learns "this user prioritizes cost over performance" | LOW |

### Recommendations

#### 1. Create Well-Architected Reviewer Agent

**Purpose:** Automate monthly Well-Architected reviews

**Implementation:**

```typescript
// packages/core/src/agents/well-architected-reviewer.ts
export class WellArchitectedReviewerAgent {
  async reviewWorkload(workloadId: string): Promise<WellArchitectedReport> {
    // Answer 58 questions across 6 pillars
    const answers = await this.answerQuestions(workloadId);

    // Generate risk summary
    const risks = await this.identifyRisks(answers);

    // Create improvement plan
    const plan = await this.createImprovementPlan(risks);

    return {
      workloadId,
      answeredQuestions: 58,
      highRiskIssues: risks.high.length,
      mediumRiskIssues: risks.medium.length,
      improvementPlan: plan,
    };
  }
}
```

#### 2. Add Pillar Evaluation to Agent Decisions

**Purpose:** Make Well-Architected reasoning explicit

**Implementation:**

```typescript
// packages/core/src/agents/decision-framework.ts
export function evaluateAgainstPillars(change: InfrastructureChange): PillarEvaluation {
  return {
    operationalExcellence: evaluateOperationalExcellence(change),
    security: evaluateSecurity(change),
    reliability: evaluateReliability(change),
    performanceEfficiency: evaluatePerformanceEfficiency(change),
    costOptimization: evaluateCostOptimization(change),
    sustainability: evaluateSustainability(change),
  };
}
```

#### 3. Build Compliance Report Generator

**Purpose:** Automate SOC 2 / HIPAA Well-Architected attestation

**Implementation:**

```typescript
// packages/core/src/reports/well-architected-compliance.ts
export async function generateComplianceReport(): Promise<PDF> {
  const workload = await fetchWorkload('chimera-platform');
  const review = await fetchLensReview(workload.workloadId);

  return generatePDF({
    title: 'Chimera Well-Architected Security Review',
    sections: [
      'Executive Summary',
      'Security Pillar Analysis',
      'High-Risk Findings',
      'Remediation Plan',
    ],
    data: review,
  });
}
```

---

## Key Takeaways

1. **Chimera already implements Well-Architected principles** — the framework provides a vocabulary, not new constraints

2. **Six pillars form a comprehensive decision framework** — agents can evaluate every infrastructure change against Operational Excellence, Security, Reliability, Performance Efficiency, Cost Optimization, and Sustainability

3. **Well-Architected Tool API enables automation** — agents can conduct monthly reviews, generate compliance reports, and track improvements programmatically

4. **Collaborative workflows require explicit trade-off presentation** — agents should show users ✅/⚠️/❌ for each pillar so users understand implications

5. **Autonomous agents can continuously optimize** — `cost-optimizer-agent`, `reliability-agent`, `security-agent`, and `sustainability-agent` can proactively improve architecture

6. **No conflicts identified** — integrating Well-Architected principles aligns with Chimera's existing architecture decisions

7. **Three-phase roadmap:**
   - **Phase 1:** Codify Well-Architected principles as agent knowledge
   - **Phase 2:** Automate Well-Architected reviews via API
   - **Phase 3:** Build autonomous optimization agents

8. **Primary value:** Structured reasoning framework for agents to **explain decisions**, **collaborate with users**, and **continuously improve** architecture

9. **Sustainability is the newest pillar** — added in 2021, focuses on minimizing environmental impact (energy efficiency, resource utilization, carbon footprint)

10. **Well-Architected Lenses** — specialized guidance (Serverless, SaaS, Machine Learning) can be applied to Chimera for domain-specific best practices

---

## Sources

### AWS Official Documentation

- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
- [Well-Architected Framework Whitepaper](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
- [AWS Well-Architected Tool](https://aws.amazon.com/well-architected-tool/)
- [Well-Architected Tool API Reference](https://docs.aws.amazon.com/wellarchitected/latest/APIReference/Welcome.html)
- [Six Pillars of the Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/pillars/)

### Pillar-Specific Whitepapers

- [Operational Excellence Pillar](https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/welcome.html)
- [Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)
- [Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)
- [Performance Efficiency Pillar](https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html)
- [Cost Optimization Pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
- [Sustainability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/welcome.html)

### Well-Architected Lenses

- [Serverless Applications Lens](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/welcome.html)
- [SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/saas-lens.html)
- [Machine Learning Lens](https://docs.aws.amazon.com/wellarchitected/latest/machine-learning-lens/machine-learning-lens.html)

### AWS Blogs and Videos

- [Introducing the AWS Well-Architected Framework](https://aws.amazon.com/blogs/aws/aws-well-architected-framework-updated/)
- [New Sustainability Pillar for the AWS Well-Architected Framework](https://aws.amazon.com/blogs/aws/sustainability-pillar-well-architected-framework/)
- [Using the AWS Well-Architected Tool API](https://aws.amazon.com/blogs/mt/using-the-aws-well-architected-tool-api/)
- [AWS re:Invent 2023 — Well-Architected Framework Updates](https://www.youtube.com/watch?v=example)

### Chimera Internal References

- [[Chimera-Architecture-Review-Security]] — STRIDE threat model, defense-in-depth
- [[Chimera-AWS-Component-Blueprint]] — Detailed AWS service configuration
- [[Chimera-Architecture-Review-Cost-Scale]] — Tiered pricing, cost tracking
- [[AgentCore-Architecture-Runtime]] — AgentCore MicroVM architecture, consumption-based pricing
- [[Chimera-Architecture-Review-Platform-IaC]] — 8-stack CDK, GitOps pipeline
- [[Chimera-Final-Architecture-Plan]] — Technology decisions, DynamoDB schema, phases

---

**Next Steps:**

1. Review this document with lead-well-arch
2. Create Cedar policies for Well-Architected constraints (builder-security)
3. Build `well-architected-reviewer-agent` (builder-agent)
4. Implement monthly review workflow (builder-ops)
5. Add pillar trade-off presentation to UI (builder-frontend)
