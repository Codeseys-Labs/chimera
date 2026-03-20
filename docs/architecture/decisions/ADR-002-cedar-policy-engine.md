---
title: 'ADR-002: Cedar over OPA for Policy Engine'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-002: Cedar over OPA for Policy Engine

## Status

**Accepted** (2026-03-20)

## Context

AWS Chimera requires fine-grained authorization for:
- **Multi-tenant isolation**: Tenant A cannot access Tenant B's data
- **Self-evolution guardrails**: Agents can modify infrastructure within bounds (e.g., budget < $50/mo)
- **Skill permissions**: Skills declare required permissions (filesystem:read, network:outbound)
- **Rate limiting**: Token budget enforcement per tenant per resource
- **Compliance**: GDPR data access controls, SOC2 audit trails

Authorization decisions must be:
- **Fast**: < 5ms latency for policy evaluation
- **Auditable**: Log every policy decision for compliance
- **Declarative**: Express policies as "what is allowed" not imperative code
- **Versioned**: Policies stored in S3, versioned, with rollback capability
- **Multi-environment**: Same policy language works in Lambda, ECS, MicroVM

The decision is which policy engine to use for authorization.

## Decision

Use **AWS Cedar** as the policy engine for all authorization decisions.

Cedar is an open-source policy language developed by AWS (used in production by Amazon Verified Permissions, AWS Private CA). Policies are stored in S3, cached in ElastiCache (5min TTL), and evaluated in-memory.

**Example Cedar policy:**
```cedar
// Tenant isolation
permit(
  principal in TenantGroup::"tenant-acme",
  action in [DynamoDB::GetItem, DynamoDB::PutItem],
  resource in DynamoDB::Table::"chimera-sessions"
)
when {
  resource.partitionKey.startsWith("TENANT#tenant-acme")
};

// Self-evolution budget constraint
forbid(
  principal,
  action == Agent::CreateInfrastructure,
  resource
)
unless {
  context.estimatedMonthlyCost < 50.00
};
```

## Alternatives Considered

### Alternative 1: AWS Cedar (Selected)
AWS-developed open-source policy language with formal verification.

**Pros:**
- ✅ **AWS-native integration**: First-class support in Verified Permissions service
- ✅ **Formal verification**: Policies can be mathematically proven correct
- ✅ **Fast**: Sub-millisecond evaluation (<0.5ms typical)
- ✅ **Simple syntax**: Declarative, easier to audit than Rego
- ✅ **Type-safe**: Schema validation prevents policy errors
- ✅ **AWS-endorsed**: Used in production by AWS services (VPC Lattice, Verified Permissions)

**Cons:**
- Smaller community vs OPA (mitigated by AWS backing)
- Fewer third-party integrations (not needed for our use case)

**Verdict:** Selected for AWS-native integration and formal verification.

### Alternative 2: Open Policy Agent (OPA)
CNCF-graduated policy engine with Rego language.

**Pros:**
- Larger open-source community
- More third-party integrations (Kubernetes, Envoy, etc.)
- Mature ecosystem with tooling

**Cons:**
- ❌ **Rego is complex**: Harder to audit policies (Prolog-like logic)
- ❌ **Slower**: 5-10ms evaluation latency (vs <1ms for Cedar)
- ❌ **Not AWS-native**: Need to run OPA server ourselves
- ❌ **No formal verification**: Policies can have subtle bugs
- ❌ **Higher operational burden**: Deploy/maintain OPA cluster

**Verdict:** Rejected due to complexity and lack of AWS-native integration.

### Alternative 3: IAM Policies
Use AWS IAM policies for all authorization.

**Pros:**
- AWS-native
- No additional service to manage
- Team already familiar with IAM

**Cons:**
- ❌ **Not dynamic**: IAM policies evaluated at AWS API call, not application logic
- ❌ **Cannot enforce custom constraints**: Budget limits, skill permissions
- ❌ **Cannot version application policies**: IAM is for AWS resources, not app logic
- ❌ **No context-aware decisions**: Cannot check "estimatedMonthlyCost" in IAM

**Verdict:** Rejected - IAM is for AWS resources, Cedar is for application logic.

### Alternative 4: Custom Authorization Code
Write authorization logic in TypeScript/Python.

**Pros:**
- Full flexibility
- No new language to learn

**Cons:**
- ❌ **Not auditable**: Code changes hard to review for security
- ❌ **Error-prone**: Imperative code can have bugs (if/else spaghetti)
- ❌ **Not declarative**: Hard to understand "what is allowed"
- ❌ **No formal verification**: Cannot prove correctness
- ❌ **Harder to rollback**: Code rollbacks harder than policy rollbacks

**Verdict:** Rejected - custom code is too error-prone for security.

## Consequences

### Positive

- **Security**: Formal verification prevents policy bugs (e.g., accidentally allowing cross-tenant access)
- **Performance**: Sub-millisecond evaluation means negligible latency overhead
- **Auditability**: Every policy decision logged with context, principal, action, resource
- **Simplicity**: Cedar syntax is simple enough for non-engineers to audit
- **AWS-native**: Integrates with Verified Permissions service (optional migration path)
- **Versioning**: Policies in S3 with git-like versioning and rollback
- **Caching**: ElastiCache (5min TTL) reduces S3 reads to near-zero

### Negative

- **Learning curve**: Team needs to learn Cedar syntax (mitigated by simplicity)
- **Smaller community**: Fewer Stack Overflow answers vs OPA (AWS docs are comprehensive)
- **New service**: Need to deploy Cedar evaluator in Lambda/ECS

### Risks

- **Cedar evolution**: If AWS deprecates Cedar (unlikely - used in production services)
- **Schema drift**: Cedar schemas must match application entities (mitigated by code generation)

## Evidence

- **Research**: [docs/research/architecture-reviews/Chimera-Architecture-Review-Security.md](../../research/architecture-reviews/Chimera-Architecture-Review-Security.md) - 8-layer defense-in-depth includes Cedar policies
- **AWS Verified Permissions**: https://aws.amazon.com/verified-permissions/ - production service using Cedar
- **Cedar specification**: https://www.cedar-policy.com/ - formal language specification
- **Mulch record mx-381e52**: "Evolution research covers two dimensions: (1) self-modifying infrastructure with Cedar policy constraints"

## Related Decisions

- **ADR-001** (6-table DynamoDB): Cedar policies enforce partition key filtering for multi-tenant isolation
- **ADR-007** (AgentCore MicroVM): Each MicroVM session gets tenant-scoped Cedar policies
- **ADR-011** (Self-modifying IaC): Cedar policies constrain infrastructure changes (budget, resource types)
- **ADR-009** (Skill adapters): Skills declare permissions, Cedar enforces them at runtime

## References

1. Cedar Policy Language: https://www.cedar-policy.com/
2. AWS Verified Permissions: https://aws.amazon.com/verified-permissions/
3. Cedar vs OPA comparison: https://www.cedar-policy.com/en/faqs/opa-comparison.html
4. Formal verification paper: https://arxiv.org/abs/2201.10857
