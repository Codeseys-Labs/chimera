# AWS Account Agent Research Series — Index

---
**Research Initiative:** AWS Account Agent Capabilities
**Date:** March 2026
**Purpose:** Enable Chimera agents to operate AWS accounts programmatically as first-class capabilities
**Status:** In Progress (2 of 6 documents complete)
---

## Overview

This research series defines **how Chimera agents interact with AWS services** as operators, not just infrastructure consumers. Agents become AWS-native automation tools, capable of managing compute, storage, databases, networking, and more through AWS APIs.

### Key Distinction

| Type | Focus | Example |
|------|-------|---------|
| **Infrastructure Audit** ([integration-enhancement/](../integration-enhancement/)) | Services Chimera *uses* | Bedrock for LLMs, KMS for encryption |
| **Account Agent Research** (this series) | Services agents *control* | Lambda deployment, EC2 management, S3 operations |

**Insight:** Infrastructure powers the platform; account agent capabilities **are the platform's tools**.

---

## Document Series

### [01-AWS-API-First-Class-Tools.md](./01-AWS-API-First-Class-Tools.md) ✅

**Status:** Complete
**Purpose:** Define which AWS APIs should be exposed as first-class agent tools

**Coverage:**
- **25 core services** across 8 categories
- Tool interface specifications (TypeScript/Python)
- Permission scoping patterns (least privilege)
- Common agent workflows per service
- 4-tier prioritization (Tier 1: Lambda, EC2, S3, ECS, CloudWatch)

**Key Findings:**
- Tier 1 (Core Compute & Storage): Lambda, EC2, ECS/Fargate, S3, CloudWatch
- Tier 2 (Database & Messaging): DynamoDB, RDS, SQS, SNS, EventBridge
- Tier 3 (Orchestration & ML): Step Functions, Bedrock, SageMaker
- Tier 4 (Security & Advanced): IAM, Route 53, Cost Explorer

**Next Steps:** Implement Lambda, S3, and EC2 tools first (Q1 2026 timeline)

---

### [02-SDK-Integration-Patterns.md](./02-SDK-Integration-Patterns.md) ✅

**Status:** Complete
**Purpose:** Implementation guide for integrating boto3, AWS SDK v3, and AWS CLI into agent runtimes

**Coverage:**
- boto3 patterns (Python): Client factory, STS AssumeRole, retry logic, pagination, cost tagging
- AWS SDK v3 patterns (TypeScript): Modular clients, middleware, async iterators
- AWS CLI wrapper patterns (Shell): Command validation, credential export, safety checks
- Multi-region operations: Cross-region replication, query aggregation
- Cost optimization: Batch operations, client-side caching
- Security best practices: Least privilege IAM, CloudTrail audit logging

**Key Patterns:**
1. **IAM Role-Based Authentication** — No hardcoded credentials
2. **Regional Client Caching** — Reuse SDK clients for performance
3. **Exponential Backoff with Jitter** — Retry transient errors
4. **Tenant Isolation via Session Tags** — STS session tags enforce multi-tenancy
5. **Cost Attribution via Request Tags** — Tag API calls with tenant ID

**Next Steps:** Implement client factory and retry middleware in `@chimera/core`

---

### 03-Cross-Service-Orchestration.md 🚧

**Status:** Planned (Not Yet Written)
**Purpose:** Patterns for multi-step workflows spanning multiple AWS services

**Planned Coverage:**
- Step Functions state machines for agent workflows
- EventBridge event-driven architectures
- SQS/SNS messaging patterns
- Lambda → Step Functions → ECS orchestration chains
- Error handling and compensating transactions
- Saga pattern for distributed workflows
- Cost-optimized orchestration (Express vs Standard workflows)

**Key Questions to Answer:**
- When should agents use Step Functions vs direct SDK calls?
- How to handle long-running workflows (>15 minutes)?
- Multi-step transactions with rollback on failure
- Cross-account orchestration for enterprise tenants

**Estimated Effort:** 2-3 days research + writing

---

### 04-IAM-Scoping-Multi-Tenancy.md 🚧

**Status:** Planned (Not Yet Written)
**Purpose:** IAM patterns for least-privilege agent permissions and multi-tenant isolation

**Planned Coverage:**
- Permission boundaries for agent-created IAM roles
- Service control policies (SCPs) for tenant accounts
- Resource-based policies (S3 bucket policies, Lambda resource policies)
- Session tags for tenant isolation (STS AssumeRole)
- Conditions in IAM policies (aws:RequestTag, aws:ResourceTag)
- IAM Access Analyzer for policy validation
- Cross-account access patterns (trust relationships, external IDs)
- Audit logging with CloudTrail and AWS Config

**Key Patterns:**
1. **Permission Boundary Enforcement** — All agent roles have mandatory permission boundary
2. **Tag-Based Resource Isolation** — Agents can only access resources with matching `tenantId` tag
3. **Deny-by-Default SCP** — Explicit allow required for high-risk actions (delete, modify IAM)
4. **Time-Limited Credentials** — STS temporary credentials expire after 1 hour
5. **Regional Restrictions** — Condition keys limit operations to approved regions

**Estimated Effort:** 3-4 days research + writing

---

### 05-Multi-Region-Operations.md 🚧

**Status:** Planned (Not Yet Written)
**Purpose:** Patterns for deploying and managing AWS resources across multiple regions

**Planned Coverage:**
- Global service coordination (Route 53, CloudFront, IAM)
- Regional service replication (S3, DynamoDB, Lambda)
- Cross-region networking (VPC peering, Transit Gateway, PrivateLink)
- Multi-region disaster recovery patterns (active-active, active-passive, pilot light)
- Data residency and compliance (region restrictions, data sovereignty)
- Latency optimization (edge locations, regional endpoints)
- Cost optimization (data transfer pricing, regional pricing differences)

**Key Patterns:**
1. **Global Resources** — IAM roles, Route 53 hosted zones, CloudFront distributions
2. **Regional Resources** — Lambda functions, ECS tasks, RDS instances
3. **Cross-Region Replication** — S3 CRR, DynamoDB global tables, Aurora global database
4. **Region Selection Logic** — Agent selects region based on user location, compliance, cost
5. **Failover Automation** — Route 53 health checks trigger failover to backup region

**Use Cases:**
- Global agent deployment for low-latency worldwide
- Multi-region DR for critical workloads
- Data residency compliance (GDPR, CCPA, data localization laws)

**Estimated Effort:** 2-3 days research + writing

---

### 06-Cost-Governance-Quotas.md 🚧

**Status:** Planned (Not Yet Written)
**Purpose:** Cost controls, budget enforcement, and quota management for agent AWS operations

**Planned Coverage:**
- AWS Budgets for per-tenant spending limits
- Cost allocation tags for chargeback/showback
- Real-time cost tracking with Cost Explorer API
- Quota enforcement (Service Quotas API)
- Resource lifecycle management (auto-terminate idle resources)
- Cost optimization recommendations (Compute Optimizer, Trusted Advisor)
- Billing alerts and automated actions (SNS → Lambda → suspend agent)
- Reserved capacity planning (RI, Savings Plans)

**Key Patterns:**
1. **Pre-Flight Cost Estimation** — Agent estimates cost before executing expensive operations
2. **Budget Guardrails** — AWS Budgets with custom actions (suspend agent on 80% spend)
3. **Usage Quotas** — Service Quotas API enforces per-tenant limits (e.g., max 10 Lambda functions)
4. **Idle Resource Detection** — CloudWatch alarms trigger Lambda to terminate unused resources
5. **Cost Attribution Tagging** — All agent-created resources tagged with `tenantId` for billing

**Cost Control Matrix:**

| Tier | Daily Budget | Lambda Functions | EC2 Instances | S3 Storage | DynamoDB WCU/RCU |
|------|--------------|------------------|---------------|------------|------------------|
| **Free** | $5 | 5 | 1 (t3.micro) | 5 GB | 5 WCU / 5 RCU |
| **Standard** | $50 | 25 | 5 (up to t3.large) | 100 GB | 50 WCU / 50 RCU |
| **Enterprise** | Custom | Unlimited | Unlimited | Unlimited | Unlimited |

**Estimated Effort:** 2-3 days research + writing

---

## Research Timeline

### Phase 1: Completed (March 20, 2026)
- ✅ 01-AWS-API-First-Class-Tools.md
- ✅ 02-SDK-Integration-Patterns.md
- ✅ 00-AWS-Account-Agent-Index.md (this document)

### Phase 2: Planned (March 21-25, 2026)
- 🚧 03-Cross-Service-Orchestration.md (2-3 days)
- 🚧 04-IAM-Scoping-Multi-Tenancy.md (3-4 days)

### Phase 3: Planned (March 26-28, 2026)
- 🚧 05-Multi-Region-Operations.md (2-3 days)
- 🚧 06-Cost-Governance-Quotas.md (2-3 days)

**Total Estimated Effort:** 12-16 days (across 2 builder agents in parallel)

---

## Integration with Existing Research

### Related Research Series

This series complements the existing AWS infrastructure research:

| Series | Focus | Purpose |
|--------|-------|---------|
| **[integration-enhancement/](../integration-enhancement/)** | Infrastructure services Chimera *uses* | Platform capabilities (Bedrock, KMS, WAF, CloudFront) |
| **aws-account-agent/** (this series) | Services agents *control* | Agent tooling (Lambda, EC2, S3, DynamoDB) |

### Cross-References

**From Integration Enhancement:**
- [01-AWS-Services-Audit.md](../integration-enhancement/01-AWS-Services-Audit.md) — 89 services for platform infrastructure
- [02-OSS-Frameworks-Integration.md](../integration-enhancement/02-OSS-Frameworks-Integration.md) — OpenSandbox, Strands, Cedar integration
- [03-MCP-Ecosystem.md](../integration-enhancement/03-MCP-Ecosystem.md) — MCP server marketplace (1000+ community tools)

**Dependency Flow:**
```
Infrastructure Audit → Account Agent Tools → Orchestration Patterns → IAM Scoping
         ↓                      ↓                       ↓                    ↓
   Platform uses        Agents control         Multi-step           Multi-tenant
   Bedrock/KMS/WAF      Lambda/EC2/S3          workflows            isolation
```

---

## Key Insights

### 1. Agents as AWS Operators
Chimera agents are not just AI assistants — they're **AWS account operators** with programmatic access to cloud infrastructure. This enables:
- Infrastructure-as-Code workflows driven by natural language
- Self-healing systems that detect and remediate issues
- Cost optimization through automated resource lifecycle management

### 2. Multi-Tenancy via IAM Isolation
IAM roles + session tags + permission boundaries create **bulletproof tenant isolation**:
- Each tenant has dedicated IAM role with least-privilege permissions
- Session tags enforce runtime isolation (agent cannot access other tenants' resources)
- Permission boundaries prevent privilege escalation

### 3. Cost Transparency
Tagging every API request with `tenantId` enables **precise cost attribution**:
- AWS Cost Explorer groups spending by tenant
- Real-time cost tracking in DynamoDB table
- Automated budget enforcement (suspend agent on overspend)

### 4. Security-First Design
Every pattern prioritizes security:
- No hardcoded credentials (IAM roles only)
- CloudTrail logs every agent API call
- Resource tagging for audit trail
- Deny-by-default policies with explicit allows

---

## Implementation Priorities

### Immediate (Q1 2026)
1. **Lambda Tool** — Deploy and invoke functions (highest ROI for automation)
2. **S3 Tool** — Upload/download files (foundational storage capability)
3. **EC2 Tool** — Launch/terminate instances (IaaS management)
4. **CloudWatch Tool** — Query logs, create alarms (observability)

### Short-Term (Q2 2026)
5. **DynamoDB Tool** — CRUD operations, query, scan (stateful workflows)
6. **Step Functions Tool** — Multi-step orchestration
7. **IAM Tool** — Create roles with permission boundaries (advanced capability)
8. **Cost Explorer Tool** — Query spending, forecast costs

### Medium-Term (Q3 2026)
9. **Bedrock Tool** — Invoke LLMs as agent-to-agent capability
10. **SageMaker Tool** — Custom model deployment
11. **Multi-Region Support** — All tools support cross-region operations
12. **Quota Enforcement** — Service Quotas API integration

### Long-Term (Q4 2026)
13. **Advanced Orchestration** — EventBridge + Step Functions + SQS workflows
14. **Cost Optimization** — Automated rightsizing, idle resource detection
15. **Compliance Automation** — AWS Config rules, automated remediation
16. **Multi-Account Management** — Organizations, Control Tower integration

---

## Success Metrics

### Technical Metrics
- **Tool Coverage:** 25 AWS services exposed as agent tools (Tier 1-4)
- **API Call Success Rate:** >99.9% (with retry logic)
- **Cost Attribution:** 100% of agent API calls tagged with tenant ID
- **Security Audit:** 0 IAM policy violations, 100% CloudTrail coverage

### Business Metrics
- **Tenant Adoption:** 80% of enterprise tenants use ≥3 AWS tools
- **Cost Efficiency:** 30% reduction in manual cloud operations
- **Time to Value:** Agents deploy infrastructure in <5 minutes vs 1 hour manual
- **Incident Response:** Agents auto-remediate 70% of infrastructure issues

### Compliance Metrics
- **Least Privilege:** 100% of agent IAM roles have permission boundaries
- **Audit Coverage:** 100% of API calls logged to CloudTrail
- **Tenant Isolation:** 0 cross-tenant data leakage incidents
- **Cost Governance:** 100% of tenants within budget (auto-suspend on overspend)

---

## References

### Internal Documentation
- [Chimera Development Workflow](../../CLAUDE.md)
- [Integration Enhancement Research](../integration-enhancement/README.md)
- [AgentCore Architecture](../agentcore-strands/)
- [Canonical Data Model](../../architecture/canonical-data-model.md)

### AWS Documentation
- [AWS SDK for Python (boto3)](https://boto3.amazonaws.com/v1/documentation/api/latest/index.html)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)
- [AWS CLI Command Reference](https://awscli.amazonaws.com/v2/documentation/api/latest/index.html)
- [AWS STS AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)
- [IAM Permission Boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
- [AWS Multi-Tenant SaaS Guidance](https://aws.amazon.com/solutions/multi-tenant-saas/)

### External Resources
- [AWS Prescriptive Guidance: Agentic AI](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-serverless/)
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
- [AWS Security Best Practices](https://aws.amazon.com/security/best-practices/)

---

## Research Team

- **Lead Agent:** lead-aws-sdk
- **Builder Agent:** builder-sdk-tools (this agent)
- **Task ID:** chimera-83f9
- **Parent Task:** AWS SDK Integration Research
- **Session Date:** March 20, 2026

---

## Next Steps

1. **Review & Feedback** — Lead architect reviews 01 and 02, provides feedback
2. **Dispatch Remaining Docs** — Spawn builder agents for docs 03-06 (parallel work)
3. **Proof of Concept** — Implement Lambda tool using patterns from doc 02
4. **Security Review** — IAM team validates permission boundary patterns
5. **Cost Analysis** — Finance team reviews cost attribution and quota patterns

**Status:** 2 of 6 documents complete. Awaiting dispatch for remaining research tasks.
