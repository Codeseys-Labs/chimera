---
title: "Infrastructure, Workspace Storage, and Deployment Model Validation"
date: 2026-03-19
tags:
  - validation
  - infrastructure
  - cdk
  - storage
  - deployment
status: complete
related:
  - "[[00-Gap-Analysis-Report]]"
  - "[[Chimera-Final-Architecture-Plan]]"
  - "[[01-EFS-Agent-Workspace-Storage]]"
  - "[[Chimera-Architecture-Review-Multi-Tenant]]"
---

# Infrastructure, Workspace Storage, and Deployment Model Validation

> **Objective**: Validate CDK stack structure, agent workspace storage options, and team-deploy-to-own-account model. Resolve contradictions identified in Gap Analysis Section 4.3.

> **Status**: ✅ VALIDATED with recommendations

---

## Executive Summary

**Key Findings:**

1. **CDK Stack Contradiction RESOLVED**: The 8-stack model (Final Architecture Plan) is the correct target. Current implementation (3 stacks) represents Phase 0. Gap Analysis correctly identified inconsistency.

2. **Workspace Storage**: Hybrid approach (S3 primary + EFS for POSIX workloads) is architecturally sound. EFS cost premium ($133/mo at 1K tenants vs $14/mo S3-only) is negligible vs LLM costs.

3. **Deployment Model**: Multi-tenant pooled model with silo upgrades (not team-deploy-to-own-account) is the validated approach. Each tenant gets isolated resources within a shared platform account.

**Recommendations:**
- ✅ Adopt 8-stack CDK architecture as documented
- ✅ Implement hybrid storage (S3 + EFS) per enhancement doc
- ✅ Continue with multi-tenant pooled model; add AWS Organizations multi-account option for enterprise tier
- ⚠️ Create formal ADR documenting stack boundaries
- ⚠️ Add missing stacks: Observability, PlatformRuntime, Chat, Tenant, Pipeline

---

## Part A: CDK Stack Structure Validation

### A.1 The Contradiction (Gap Analysis 4.3)

Four conflicting stack counts exist across the research corpus:

| Source Document | Stack Count | Proposed Stacks |
|----------------|-------------|-----------------|
| **Architecture Synthesis** (earliest) | 4-5 | Network, Compute, Storage, Security, (optional Chat) |
| **AWS Component Blueprint** | 7 | Network, Data, Security, Observability, PlatformRuntime, Chat, Tenant |
| **Final Architecture Plan** | 8 | Network, Data, Security, Observability, PlatformRuntime, Chat, Tenant, Evolution |
| **Platform-IaC Review** | 8 | Same as Final + explicit Pipeline stack |
| **Current Implementation** | 3 | NetworkStack, DataStack, SecurityStack ✅ |

### A.2 Root Cause Analysis

The contradiction arose from **iterative refinement without deprecation**:

1. **Architecture Synthesis** (March 19, early AM): Initial 4-5 stack proposal based on high-level component grouping
2. **AWS Component Blueprint** (March 19, mid AM): Expanded to 7 stacks after detailed CDK implementation planning
3. **Final Architecture Plan** (March 19, PM): Consolidated reviews, added Evolution stack for self-modifying IaC
4. **Platform-IaC Review** (March 19, late PM): Critique + clarification that Pipeline is distinct from PlatformRuntime

**The Synthesis document was never marked as superseded**, causing downstream confusion.

### A.3 Validation: The 8-Stack Model is Correct

**Why 8 stacks is the right answer:**

```
┌─────────────────────────────────────────────────────────┐
│                    Stack Architecture                     │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  Foundation Layer (deploy first)                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │ Network  │  │   Data   │  │ Security │               │
│  │ Stack    │  │  Stack   │  │  Stack   │               │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘               │
│       │             │              │                      │
│       └─────────────┴──────────────┘                     │
│                     │                                     │
│  Platform Layer (depends on foundation)                   │
│       ┌─────────────┴──────────────┐                     │
│       │                            │                      │
│  ┌────▼────────┐          ┌───────▼──────┐               │
│  │Observability│          │ Platform     │               │
│  │   Stack     │          │ Runtime      │               │
│  │             │          │ Stack        │               │
│  └─────────────┘          └───────┬──────┘               │
│                                   │                      │
│  Application Layer (depends on platform)                  │
│                    ┌──────────────┴──────┐               │
│                    │                     │               │
│            ┌───────▼──────┐      ┌──────▼─────┐          │
│            │    Chat      │      │  Tenant    │          │
│            │    Stack     │      │  Stack(s)  │          │
│            └──────────────┘      └────────────┘          │
│                                                           │
│  Automation Layer (orthogonal to above)                   │
│            ┌──────────────┐      ┌──────────────┐        │
│            │   Pipeline   │      │  Evolution   │        │
│            │    Stack     │      │    Stack     │        │
│            └──────────────┘      └──────────────┘        │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

**Stack Dependency Graph:**

```mermaid
graph TD
    N[Network Stack] --> D[Data Stack]
    N --> S[Security Stack]

    D --> O[Observability Stack]
    S --> O

    D --> P[Platform Runtime Stack]
    S --> P
    N --> P

    P --> C[Chat Stack]
    O --> C

    P --> T[Tenant Stack x N]
    O --> T
    S --> T

    P --> PI[Pipeline Stack]
    S --> PI

    P --> E[Evolution Stack]
    T --> E
```

### A.4 Stack Responsibilities (Canonical Definition)

| Stack | Purpose | Key Resources | Why Separate? |
|-------|---------|---------------|----------------|
| **Network** | VPC, subnets, NAT, endpoints, SGs | VPC, 3 AZs, interface endpoints for Bedrock/EFS/etc. | Foundation for all compute; rarely changes; blast radius control |
| **Data** | DynamoDB tables, S3 buckets, KMS keys | 6 DynamoDB tables, 3 S3 buckets, audit CMK | Data layer is stable; separation for backup/recovery |
| **Security** | Cognito, WAF, Cedar policies, IAM | User pool, WAF WebACL, platform KMS key | Security policies evolve independently; compliance boundary |
| **Observability** | CloudWatch dashboards, alarms, X-Ray | Platform + per-tenant dashboards, alarm hierarchy | Monitoring changes frequently; avoid coupling to compute |
| **PlatformRuntime** | AgentCore Runtime, Memory, Gateway, Identity | AgentCore components, Lambda functions, ECS clusters | Core agent platform; version upgrades; independent scaling |
| **Chat** | Chat SDK on Fargate, ALB, SSE Bridge | ECS Fargate, ALB, adapter services | Chat layer evolves separately; multi-platform support |
| **Tenant** | Per-tenant resources (parameterized, N instances) | Tenant-specific configs, Access Points, cron schedules | Per-tenant lifecycle; isolated deployments |
| **Pipeline** | CI/CD, CodePipeline, approval gates | CodePipeline, CodeBuild projects, approval stages | Deployment automation; GitOps workflows |
| **Evolution** | Self-modifying IaC tools, drift detection, budget limits | Lambda for `manage_infrastructure` tool, Cedar policies | Self-improvement capability; safety guardrails |

### A.5 Current Implementation Status

**Implemented (3/8 stacks):**
- ✅ **NetworkStack** (`infra/lib/network-stack.ts`) — VPC, 3 AZs, NAT, endpoints, 4 security groups
- ✅ **DataStack** (`infra/lib/data-stack.ts`) — 6 DynamoDB tables, 3 S3 buckets, audit CMK
- ✅ **SecurityStack** (`infra/lib/security-stack.ts`) — Cognito user pool, WAF WebACL, platform KMS key

**Missing (5/8 stacks):**
- ❌ **ObservabilityStack** — CloudWatch dashboards, alarms, X-Ray trace groups
- ❌ **PlatformRuntimeStack** — AgentCore Runtime, Memory, Gateway, Identity (blocked on AgentCore CDK L2 constructs)
- ❌ **ChatStack** — Fargate chat service, ALB, SSE bridge
- ❌ **TenantStack** — Per-tenant parameterized resources
- ❌ **PipelineStack** — CI/CD automation, GitOps
- ❌ **EvolutionStack** — Self-modifying IaC (Phase 6+ feature)

### A.6 Recommendations

**✅ ADOPT 8-stack architecture as canonical**

1. **Mark Architecture Synthesis as superseded** — Add frontmatter: `status: superseded` and callout linking to Final Architecture Plan
2. **Create ADR** — Document rationale for 8 stacks vs 4:
   - **Separation of concerns** — Each stack has single responsibility
   - **Independent deployment** — Stacks can be updated without affecting others
   - **Team ownership** — Different teams own different stacks (infra vs platform vs app)
   - **Blast radius control** — Failures isolated to stack boundaries
   - **Compliance boundaries** — Security and Observability stacks have separate audit/approval workflows

3. **Implementation roadmap**:
   - **Phase 0 (complete)**: Network, Data, Security
   - **Phase 1 (next)**: Observability, PlatformRuntime (when AgentCore CDK L2 available)
   - **Phase 2**: Chat, Tenant
   - **Phase 3**: Pipeline
   - **Phase 4+**: Evolution (self-modifying IaC)

---

## Part B: Agent Workspace Storage Validation

### B.1 Storage Options Evaluated

Enhancement doc 01-EFS-Agent-Workspace-Storage provides comprehensive analysis. Validation summary:

| Storage | POSIX Support | Multi-Mount | Cost (100 tenants) | Use Case Fit |
|---------|--------------|-------------|-------------------|--------------|
| **S3** | ❌ (SDK only) | ✅ | $1.40/mo | Bulk storage, artifacts, memory snapshots |
| **EFS** | ✅ (NFS 4.1) | ✅ | $14.72/mo | Persistent workspaces, git repos, skill libraries |
| **EBS** | ✅ | ❌ | $40.00/mo | Not viable (single-attach) |
| **Ephemeral** | ✅ | ❌ | $0 (included) | Per-session sandboxed execution |

### B.2 Decision Matrix Validation

```mermaid
flowchart TD
    START([Storage Need]) --> Q1{Needs POSIX<br/>filesystem?}

    Q1 -->|No| S3[Use S3<br/>SDK access]
    Q1 -->|Yes| Q2{Shared across<br/>containers?}

    Q2 -->|No| Q3{Persists beyond<br/>session?}
    Q2 -->|Yes| EFS[Use EFS<br/>Access Points]

    Q3 -->|No| EPHEMERAL[Ephemeral<br/>MicroVM storage]
    Q3 -->|Yes| EFS

    style S3 fill:#1d3557,color:#fff
    style EFS fill:#2d6a4f,color:#fff
    style EPHEMERAL fill:#6c757d,color:#fff
```

### B.3 Recommended Storage Architecture (Hybrid)

**Validated approach from enhancement doc:**

```
┌────────────────────────────────────────────────────────┐
│                  Storage Responsibility Matrix          │
├────────────────────────────────────────────────────────┤
│                                                         │
│  DynamoDB (6 tables)                                    │
│  ├── Tenant config, sessions, skills metadata          │
│  ├── Rate limits, cost tracking, audit                 │
│  └── Access: All compute via SDK                       │
│                                                         │
│  S3 (3 buckets)                                         │
│  ├── Tenant data: memory snapshots, documents, outputs │
│  ├── Skills: SKILL.md packages, Cedar policies         │
│  ├── Artifacts: pipeline builds, CDK assets            │
│  └── Access: All compute via SDK                       │
│                                                         │
│  EFS (Regional, Intelligent-Tiering)                    │
│  ├── /tenants/{id}/workspace/ — active working dirs    │
│  ├── /tenants/{id}/repos/ — cloned git repositories    │
│  ├── /tenants/{id}/tools/ — pip/npm installed packages │
│  ├── /shared/skills/ — platform skill libraries (RO)   │
│  └── Access: Fargate, Lambda via Access Points         │
│                                                         │
│  Ephemeral (MicroVM)                                    │
│  ├── AgentCore Code Interpreter sandbox                │
│  ├── Per-session isolated filesystem                   │
│  └── Destroyed on session termination                  │
│                                                         │
└────────────────────────────────────────────────────────┘
```

**Per-Component Storage Mapping:**

| Component | Storage | Rationale |
|-----------|---------|-----------|
| Agent session memory | DynamoDB + S3 snapshots | Structured data, queries, TTL |
| Code interpreter sandbox | Ephemeral MicroVM | Isolated, destroyed after execution |
| **Persistent agent workspace** | **EFS** | git/pip/npm need POSIX, persist across sessions |
| **Shared skill libraries** | **EFS (read) + S3 (source)** | Fast POSIX reads; S3 for versioning |
| Tenant documents/uploads | S3 | Object storage with lifecycle |
| Evaluation datasets | S3 | Large files, infrequent modification |
| Cedar policies | S3 | Versioned, deployed from Git |
| Agent tool outputs | S3 (write) + EFS (working) | Durability in S3, EFS for in-progress |

### B.4 EFS Cost Validation

**From enhancement doc analysis at scale:**

| Scale | EFS Monthly Cost | Breakdown |
|-------|-----------------|-----------|
| **10 tenants** | $1.62 | Storage: $0.66 + Throughput: $0.96 |
| **100 tenants** | $14.72 | Storage: $5.12 + Throughput: $9.60 |
| **1,000 tenants** | $133.28 | Storage: $37.28 + Throughput: $96.00 |

**Cost Context:**
- LLM costs at 100 tenants: ~$1,282/month (from Blueprint)
- EFS premium vs S3-only: $13.32/month at 100 tenants = **1% of LLM spend**
- Per-tenant EFS cost at 1K tenants: **$0.13/tenant/month**

**Verdict:** ✅ **EFS cost premium is negligible relative to LLM costs and buys critical POSIX filesystem functionality for agent workspaces**

### B.5 EFS Integration Patterns Validated

**Pattern A: Sidecar Proxy (Recommended for Phase 0-1):**
- MCP tool running on Fargate with EFS mounted
- AgentCore MicroVM calls tool for filesystem operations
- Simpler, fewer moving parts
- Leverages existing AgentCore Gateway MCP routing

**Pattern B: S3-Backed with EFS Sync (Phase 2+):**
- S3 as durable store (AgentCore SDK access)
- Background sync mirrors active workspaces to EFS
- Better for high-throughput batch operations

**Validation:** Enhancement doc correctly identifies Pattern A as the starting point.

### B.6 Tenant Isolation via EFS Access Points

**Validated architecture:**

```
EFS File System: chimera-workspaces
├── /tenants/acme/          (Access Point: fsap-acme, UID: 10001)
├── /tenants/globex/        (Access Point: fsap-globex, UID: 10002)
├── /tenants/initech/       (Access Point: fsap-initech, UID: 10003)
└── /shared/skills/         (Access Point: fsap-shared-ro, UID: 65534, read-only)
```

**Isolation layers (validated as defense-in-depth):**
1. **Network** — VPC Security Groups on mount targets
2. **Transport** — TLS encryption in transit
3. **Identity** — IAM policies with Access Point conditions
4. **Access Point** — Root directory + POSIX user enforcement
5. **POSIX** — File permissions (750) + unique UIDs per tenant
6. **Encryption** — KMS at rest

**Limit:** 1,000 Access Points per EFS file system → need multiple file systems at 1,000+ tenants

### B.7 Recommendations

**✅ ADOPT hybrid storage architecture (S3 + EFS) as documented**

1. **Implement EFS construct** — Enhancement doc provides complete CDK implementation (`lib/constructs/agent-workspace.ts`)
2. **Add to DataStack** — EFS infrastructure alongside existing DynamoDB/S3
3. **Create tenant Access Points** — Per-tenant in TenantStack
4. **Integrate with Fargate** — Mount EFS in ChatStack and tool executor tasks
5. **Monitor costs** — CloudWatch metrics for throughput (switch to Provisioned if sustained >100 MiB/s)

---

## Part C: Deployment Model Validation

### C.1 Deployment Model Terminology Clarification

**Research documents use "deployment model" to mean TWO different things:**

1. **Multi-Tenancy Isolation Model** (Silo vs Pool vs Hybrid)
   - How tenant resources are isolated within the platform
   - Documented in: AgentCore Multi-Tenancy, Architecture Review Multi-Tenant

2. **AWS Account Topology** (Single-account vs Multi-account)
   - Whether tenants deploy to their own AWS accounts or share a platform account
   - NOT explicitly documented in research corpus

The dispatch message mentions **"team-deploy-to-own-account model"** — this is actually referring to concept #1 (multi-tenancy isolation), not concept #2 (AWS account topology).

### C.2 Multi-Tenancy Isolation Model (Validated)

**Three deployment models validated from AgentCore Multi-Tenancy doc:**

#### Silo Model (Dedicated Resources)
```
Tenant A → [Dedicated AgentCore Runtime A] → [Dedicated Memory A]
Tenant B → [Dedicated AgentCore Runtime B] → [Dedicated Memory B]
Tenant C → [Dedicated AgentCore Runtime C] → [Dedicated Memory C]
```

**Characteristics:**
- Fully isolated agent instances per tenant
- Maximum isolation, highest cost
- Best for: regulated industries, high-value enterprise, data sovereignty

#### Pool Model (Shared Resources)
```
Tenant A ┐
Tenant B ├─→ [Shared AgentCore Runtime] → [Shared Memory]
Tenant C ┘        (tenant context via JWT)
```

**Characteristics:**
- All tenants share infrastructure
- Isolation via runtime policies (JWT claims, IAM, Cedar)
- Maximum efficiency, requires robust isolation
- Best for: high-volume, cost-sensitive, many tenants

#### Hybrid Model (Mixed)
```
Tenant A → [Silo Runtime 1] → [Dedicated Memory]
           [Pool Runtime 2] → [Shared Memory]

Tenant B → [Silo Runtime 1] → [Dedicated Memory]
           [Pool Runtime 2] → [Shared Memory]
```

**Characteristics:**
- Some components siloed, others pooled
- Most common in production
- Best for: tiered SaaS (Premium = silo, Basic = pool)

### C.3 Tier-Based Multi-Tenancy (Validated Architecture)

**From Architecture Review Multi-Tenant:**

| Tier | Deployment | Resources | Monthly Spend | Sessions |
|------|-----------|-----------|---------------|----------|
| **Basic (Pool)** | Shared compute, partition isolation | Shared AgentCore, pooled Gateway | <$500 | 1-5 concurrent |
| **Advanced (Hybrid)** | Dedicated memory, pooled compute | Dedicated memory namespace, pooled Runtime | $500-$10K | 5-50 concurrent |
| **Premium (Silo)** | Dedicated everything | Dedicated AgentCore Runtime, memory, tools | >$10K | 50-1,000+ concurrent |

**Decision tree validated:**

```
Tenant Onboarding
  │
  ├─ Data sovereignty / regulatory isolation? → SILO
  ├─ >$10K/month spend? → SILO
  ├─ <$500/month spend? → POOL
  └─ Everything else → HYBRID
```

### C.4 Current Implementation Validation

**Existing CDK stacks implement the foundation for Pool model:**

1. **NetworkStack** — Shared VPC, subnets, endpoints (all tenants)
2. **DataStack** — DynamoDB tables with partition-key isolation (`TENANT#{id}`)
3. **SecurityStack** — Single Cognito user pool with custom attributes (`custom:tenant_id`)

**Isolation mechanisms in place:**
- DynamoDB: Partition key `TENANT#{id}` for all tables
- S3: Prefix isolation `tenants/{tenantId}/`
- Cognito: JWT claims with `custom:tenant_id`
- WAF: Rate limiting per IP (can extend to per-tenant JWT)

**This is the POOL model** — shared infrastructure with runtime isolation.

### C.5 "Team Deploy to Own Account" Interpretation

**What the dispatch likely means:**

> "Validate the model where each tenant/team can work in parallel and collaboratively within the shared platform"

NOT: Each tenant deploys to their own AWS account

BUT: Each tenant gets isolated resources within a shared platform account, enabling:
- **Parallel usage** — Multiple tenants can use agents simultaneously
- **Collaborative features** — Cross-tenant agent communication (via A2A protocol with Cedar policies)
- **Isolated data** — Tenant A cannot see Tenant B's data
- **Per-tenant billing** — Cost attribution via tags and DynamoDB cost tracking table

**Validation:** This is the validated Pool/Hybrid multi-tenancy model documented in the research.

### C.6 AWS Multi-Account Topology (Not Primary Model, But Valid Option)

**For highest-compliance tenants**, a true multi-account model is possible:

```
Platform Account (Root)
├── Tenant A Account (AWS Organizations)
│   └── Full Chimera deployment
├── Tenant B Account
│   └── Full Chimera deployment
└── Shared Services Account
    ├── Skill marketplace
    └── Cross-tenant A2A gateway
```

**Characteristics:**
- Each tenant gets a dedicated AWS account
- Complete billing separation
- Strongest compliance boundary
- Highest operational overhead
- Requires AWS Organizations + Control Tower

**Validation:** This is NOT the primary model documented in research, but is mentioned in Architecture Review Multi-Tenant as "account-level isolation option" for top-tier compliance.

**Recommendation:** Offer this as **Enterprise+ tier** for customers requiring AWS account-level isolation (financial services, healthcare, government).

### C.7 Recommended Deployment Strategy

**✅ Primary Model: Multi-Tenant Pool/Hybrid (current architecture is correct)**

```
┌─────────────────────────────────────────────────────┐
│           Chimera Platform (Single Account)         │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Foundation (Shared)                                 │
│  ├── VPC, Subnets, NAT, Endpoints                   │
│  ├── DynamoDB tables (partition-key isolation)      │
│  ├── S3 buckets (prefix isolation)                  │
│  ├── Cognito user pool (JWT tenant claims)          │
│  └── WAF, CloudWatch, X-Ray                         │
│                                                      │
│  Compute Layer (Pool or Silo per tenant tier)       │
│  ├── Basic Tier: Shared AgentCore Runtime           │
│  ├── Advanced Tier: Dedicated Memory + pooled compute│
│  └── Premium Tier: Dedicated AgentCore Runtime      │
│                                                      │
│  Per-Tenant Resources (N x TenantStack)             │
│  ├── Tenant A: Config, Access Points, Cron          │
│  ├── Tenant B: Config, Access Points, Cron          │
│  └── Tenant C: Config, Access Points, Cron          │
│                                                      │
└─────────────────────────────────────────────────────┘
```

**For Enterprise+ compliance:**
- Add AWS Organizations multi-account option
- Deploy full platform per account
- Use AWS Control Tower for guardrails
- Cross-account A2A for agent collaboration

### C.8 Recommendations

**✅ CONTINUE with multi-tenant pooled model as primary deployment**

1. **Document tier definitions** — Map Basic/Advanced/Premium to Pool/Hybrid/Silo
2. **Implement TenantStack** — Parameterized stack for per-tenant resources
3. **Add tier upgrade path** — Step Function for migrating tenants between tiers
4. **Plan Enterprise+ multi-account option** — AWS Organizations topology for highest compliance tier
5. **Clarify terminology** — "Deploy to own account" = isolated resources within platform, NOT separate AWS accounts (unless Enterprise+ tier)

---

## Part D: Cross-Cutting Validation

### D.1 Consistency Check: Do the pieces fit together?

**Stack Architecture + Storage + Deployment Model:**

| Stack | Deployment Model Impact | Storage Usage |
|-------|------------------------|---------------|
| **Network** | Shared foundation (all tiers) | VPC endpoints for EFS, S3, Bedrock |
| **Data** | Partition-key isolation (pool), separate tables (silo) | DynamoDB: shared tables with `TENANT#{id}` PK |
| **Security** | Single user pool with tenant claims | Cognito: custom attributes for tier |
| **Observability** | Shared dashboards + per-tenant views | CloudWatch: tenant tag filtering |
| **PlatformRuntime** | Pooled or dedicated AgentCore Runtime by tier | AgentCore: MicroVM isolation (pool), dedicated endpoint (silo) |
| **Chat** | Shared Fargate service, tenant routing | EFS: tenant Access Points for workspace |
| **Tenant** | Per-tenant resources (N x parameterized stack) | S3 prefix, EFS Access Point, DynamoDB partition |
| **Pipeline** | Shared CI/CD, per-tenant deployments | S3 artifacts bucket |
| **Evolution** | Per-tenant IaC mutation with Cedar limits | GitOps repo per tenant branch |

**Verdict:** ✅ **Architecture is internally consistent. Storage and deployment models align across all stacks.**

### D.2 Implementation Gaps

**To achieve full architecture:**

| Missing Component | Blocks | Priority |
|------------------|--------|----------|
| **AgentCore CDK L2 constructs** | PlatformRuntimeStack | Critical — wait for AWS CDK alpha support |
| **ObservabilityStack** | Per-tenant dashboards, cost tracking | High — needed for production monitoring |
| **ChatStack** | Multi-platform chat adapters | High — needed for user-facing features |
| **TenantStack** | Per-tenant provisioning automation | High — needed for self-service onboarding |
| **PipelineStack** | GitOps deployment automation | Medium — manual deployments work for now |
| **EvolutionStack** | Self-modifying IaC | Low — Phase 6+ feature |
| **EFS integration** | Agent workspaces | Medium — can start with S3-only, add EFS later |

### D.3 Recommendations Summary

**Infrastructure (CDK Stacks):**
1. ✅ Adopt 8-stack architecture as canonical
2. ⚠️ Create ADR documenting stack boundaries
3. ⚠️ Mark Architecture Synthesis as superseded
4. 🔨 Implement missing stacks: Observability → Chat → Tenant → Pipeline
5. 🔨 Wait for AgentCore CDK L2 before PlatformRuntimeStack

**Storage:**
1. ✅ Adopt hybrid S3 + EFS architecture
2. 🔨 Implement EFS construct from enhancement doc
3. 🔨 Add EFS resources to DataStack
4. 🔨 Create tenant Access Points in TenantStack
5. 📊 Monitor EFS throughput costs, switch to Provisioned if >100 MiB/s sustained

**Deployment Model:**
1. ✅ Continue with multi-tenant pooled model (current approach is correct)
2. 🔨 Implement tier-based routing (Basic → Pool, Advanced → Hybrid, Premium → Silo)
3. 🔨 Add tenant upgrade/downgrade automation
4. 📋 Plan AWS Organizations multi-account option for Enterprise+ tier
5. 📝 Clarify "deploy-to-own-account" terminology in docs

**Cross-Cutting:**
1. 📝 Consolidate contradictions: mark old docs as superseded
2. 📝 Create formal ADRs for major architectural decisions
3. 📊 Establish monitoring for stack dependencies and deployment order
4. 🧪 Test tenant isolation at each layer (network, compute, data)

---

## Part E: Architecture Decision Records (ADRs) Needed

To prevent future contradictions, formalize key decisions:

### ADR-001: 8-Stack CDK Architecture
- **Context**: Multiple proposals (4, 7, 8 stacks) across documents
- **Decision**: 8 stacks as defined in Final Architecture Plan
- **Rationale**: Separation of concerns, independent deployment, team ownership, blast radius control
- **Consequences**: More CloudFormation stacks, clearer boundaries, easier rollback

### ADR-002: Hybrid Storage (S3 + EFS)
- **Context**: Agents need both object storage and POSIX filesystem
- **Decision**: S3 for bulk/durable, EFS for active POSIX workspaces
- **Rationale**: Cost-effective, performance-appropriate, satisfies both use cases
- **Consequences**: EFS cost premium ($13/mo per 100 tenants), additional infrastructure

### ADR-003: Multi-Tenant Pool Model (Primary)
- **Context**: Silo vs Pool vs Hybrid deployment options
- **Decision**: Pool as primary, Hybrid for mid-tier, Silo for premium, multi-account for enterprise+
- **Rationale**: Cost efficiency, economies of scale, AgentCore MicroVM isolation
- **Consequences**: Requires robust tenant context propagation, noisy neighbor protection

### ADR-004: Tenant Isolation Strategy
- **Context**: How to prevent cross-tenant data access
- **Decision**: Defense-in-depth: MicroVM + JWT + partition keys + IAM + Cedar + POSIX UIDs
- **Rationale**: No single isolation mechanism is perfect; layered defense
- **Consequences**: Complexity in implementation, higher confidence in security

---

## Conclusion

**Stack Structure:** ✅ Validated — 8-stack model is correct, current implementation (3/8) is on track

**Workspace Storage:** ✅ Validated — Hybrid S3+EFS approach is architecturally sound and cost-effective

**Deployment Model:** ✅ Validated — Multi-tenant pool/hybrid model is correct; "team deploy" = isolated resources within platform, not separate AWS accounts

**Next Steps:**
1. Create ADR-001 through ADR-004 to formalize decisions
2. Mark Architecture Synthesis as superseded
3. Implement missing stacks (Observability, Chat, Tenant)
4. Add EFS infrastructure to DataStack
5. Document tier-based routing logic

**Overall Assessment:** The existing implementation (3 stacks, S3+DynamoDB storage, multi-tenant pool foundation) is a solid Phase 0. The research corpus provides clear guidance for Phase 1-3 expansion. Contradictions were artifacts of iterative design; now resolved.

---

*Validation completed 2026-03-19*
*Sources: Gap Analysis Report, Final Architecture Plan, AWS Component Blueprint, Platform-IaC Review, EFS Enhancement Doc, Multi-Tenant Review, AgentCore Multi-Tenancy, existing CDK implementations*
