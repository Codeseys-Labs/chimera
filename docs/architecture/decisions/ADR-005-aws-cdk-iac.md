---
title: 'ADR-005: AWS CDK over OpenTofu/Pulumi for IaC'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-005: AWS CDK over OpenTofu/Pulumi for IaC

## Status

**Accepted** (2026-03-20)

## Context

AWS Chimera infrastructure includes:
- **8 CDK stacks**: Network, Data, Security, Observability, PlatformRuntime, Chat, Tenant, Pipeline
- **60+ AWS resources**: VPC, DynamoDB, S3, ECS, Lambda, API Gateway, etc.
- **Per-tenant parameterization**: Each tenant gets customized infrastructure
- **Self-modifying capability**: Agents can generate CDK code to extend infrastructure
- **TypeScript monorepo**: Existing codebase is TypeScript with Bun

Requirements for IaC tool:
- **Type-safe**: Catch errors at compile time, not deploy time
- **AWS-native**: First-class support for all AWS services
- **Composable**: Reusable L3 constructs (TenantAgent, etc.)
- **Agent-friendly**: Agents can generate IaC code programmatically
- **Testable**: Unit tests for infrastructure before deploy

The decision is which Infrastructure as Code tool to use.

## Decision

Use **AWS CDK (Cloud Development Kit)** with TypeScript.

CDK allows defining infrastructure in TypeScript, synthesizes to CloudFormation, and deploys to AWS. The monorepo already uses TypeScript, so CDK is a natural fit.

**Example CDK stack:**
```typescript
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export class DataStack extends cdk.Stack {
  public readonly tenantsTable: dynamodb.Table;

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.tenantsTable = new dynamodb.Table(this, 'TenantsTable', {
      tableName: 'chimera-tenants',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 2,
    });
  }
}
```

## Alternatives Considered

### Alternative 1: AWS CDK (Selected)
AWS-native IaC framework with TypeScript/Python/Java support.

**Pros:**
- ✅ **Type-safe**: TypeScript compiler catches errors before deploy
- ✅ **AWS-native**: New AWS services supported on day 1
- ✅ **Composable**: L3 constructs (TenantAgent, AgentObservability)
- ✅ **Testable**: Unit tests with CDK assertions library
- ✅ **Agent-friendly**: Agents generate TypeScript code easily
- ✅ **Same language**: TypeScript throughout stack (monorepo)
- ✅ **CloudFormation output**: Synthesizes to CFN (audit trail, rollback)
- ✅ **AWS-supported**: Official AWS product with SLA

**Cons:**
- AWS-only (not multi-cloud, but we're AWS-only anyway)
- CloudFormation limitations (200 resource limit per stack, mitigated by nested stacks)

**Verdict:** Selected for type safety and AWS-native design.

### Alternative 2: OpenTofu
Open-source fork of Terraform after HashiCorp license change.

**Pros:**
- Open-source (MPL 2.0 license)
- Multi-cloud (AWS, Azure, GCP)
- Large community and provider ecosystem
- HCL is declarative

**Cons:**
- ❌ **Not type-safe**: HCL errors only caught at runtime
- ❌ **Not agent-friendly**: Agents generating HCL is awkward
- ❌ **Different language**: Need HCL in TypeScript monorepo
- ❌ **AWS lag**: New AWS services take weeks/months to support
- ❌ **Not composable**: Terraform modules less ergonomic than CDK constructs
- ❌ **State management**: Need S3 + DynamoDB for state locking

**Verdict:** Rejected - not type-safe, not agent-friendly.

### Alternative 3: Pulumi
Multi-cloud IaC with real programming languages.

**Pros:**
- Type-safe (TypeScript, Python, Go)
- Multi-cloud
- Real programming languages (not DSL)
- Good composability

**Cons:**
- ❌ **Not AWS-native**: Multi-cloud means compromise on AWS features
- ❌ **Pulumi-specific**: Agents need to generate Pulumi-specific code
- ❌ **State management**: Requires Pulumi Cloud (SaaS) or self-hosted state
- ❌ **Fewer examples**: Smaller community than Terraform or CDK
- ❌ **Cost**: Pulumi Cloud pricing for team features

**Verdict:** Rejected - not AWS-native, state management overhead.

### Alternative 4: Terraform (HashiCorp)
Original IaC tool with largest community.

**Pros:**
- Largest community
- Most mature ecosystem
- Multi-cloud

**Cons:**
- ❌ **License change**: HashiCorp changed to BSL (Business Source License)
- ❌ **Same cons as OpenTofu**: Not type-safe, not agent-friendly
- ❌ **Vendor uncertainty**: BSL limits usage for competing products

**Verdict:** Rejected - license concerns, not type-safe.

### Alternative 5: CloudFormation YAML
AWS-native CloudFormation with YAML templates.

**Pros:**
- AWS-native
- No abstraction layer
- Direct CloudFormation

**Cons:**
- ❌ **Not type-safe**: YAML errors only caught at deploy time
- ❌ **Verbose**: 500 lines of YAML vs 50 lines of CDK TypeScript
- ❌ **Not composable**: No reusable constructs
- ❌ **Not agent-friendly**: Agents generating YAML is error-prone
- ❌ **No testing**: Cannot unit test YAML templates

**Verdict:** Rejected - too verbose, not composable.

## Consequences

### Positive

- **Type safety**: TypeScript catches 80% of errors before deploy
- **Composability**: L3 constructs (TenantAgent) encapsulate 15+ resources
- **Testability**: Unit tests validate stack synthesis before deploy
- **Agent generation**: Agents generate TypeScript CDK code naturally
- **Same language**: TypeScript throughout (agent code, infra, SDK, CLI)
- **AWS-native**: New AWS services (like AgentCore) supported immediately
- **Audit trail**: CloudFormation tracks all resource changes

### Negative

- **AWS lock-in**: Cannot easily migrate to Azure/GCP (acceptable - we're AWS-only)
- **CloudFormation limits**: 200 resources per stack (mitigated by nested stacks)
- **Learning curve**: Team needs to learn CDK constructs (similar to AWS SDK)

### Risks

- **CDK breaking changes**: CDK v3 may break compatibility (mitigated by pinning versions)
- **CloudFormation drift**: Manual AWS console changes create drift (mitigated by drift detection)

## Evidence

- **Research**: [docs/research/agentcore-strands/08-IaC-Patterns-Agent-Platforms.md](../../research/agentcore-strands/08-IaC-Patterns-Agent-Platforms.md) - 749 lines comparing CDK, Pulumi, Terraform
- **8-stack architecture**: [docs/architecture/canonical-data-model.md](../canonical-data-model.md) Appendix A shows CDK examples
- **Mulch record mx-23cc8f**: "8-stack CDK architecture: Network, Data, Security, Observability, PlatformRuntime, Chat, Tenant, Pipeline"
- **Implementation**: `infra/lib/` directory already uses CDK

## Related Decisions

- **ADR-001** (6-table DynamoDB): DynamoDB tables defined in CDK DataStack
- **ADR-006** (Monorepo): CDK code lives in monorepo with agent code
- **ADR-011** (Self-modifying IaC): Agents generate CDK TypeScript code to extend infrastructure
- **ADR-013** (CodeCommit + CodePipeline): CDK Pipeline Stack defines CI/CD

## References

1. AWS CDK documentation: https://docs.aws.amazon.com/cdk/
2. CDK best practices: https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html
3. CDK construct library: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-construct-library.html
4. IaC comparison: https://www.hashicorp.com/resources/what-is-infrastructure-as-code (for context)
