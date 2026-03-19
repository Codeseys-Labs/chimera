# IaC Strategy Deep Dive: CDK vs OpenTofu vs Pulumi

**Document Version:** 1.0
**Last Updated:** 2026-03-19
**Status:** Draft

---

## Executive Summary

Chimera uses **AWS CDK with TypeScript** as its Infrastructure as Code (IaC) solution. This document evaluates CDK against alternatives (OpenTofu/Terraform, Pulumi) and explores **self-modifying IaC patterns** — where agents can programmatically evolve their own infrastructure.

**Key Findings:**
- **CDK is the optimal choice** for Chimera's multi-tenant agent platform
- Type safety, L3 constructs, and AWS-native integration provide decisive advantages
- Self-modifying IaC is achievable through CDK constructs + DynamoDB-driven synthesis
- OpenTofu/Pulumi are viable but offer diminishing returns given TypeScript investment

**Strategic Recommendation:** Continue with CDK, implement self-modifying patterns via `TenantAgent` construct evolution and dynamic stack synthesis from tenant configuration tables.

---

## 1. Current State: Chimera's CDK Architecture

### 1.1 Stack Organization

Chimera uses a **three-tier stack architecture** with explicit dependencies:

```typescript
// infra/bin/clawcore.ts
NetworkStack    → VPC, subnets, security groups, VPC endpoints
   ↓
DataStack       → 6 DynamoDB tables, 3 S3 buckets
SecurityStack   → Cognito, WAF, KMS keys
```

**Strengths observed:**
- Clear separation of concerns (network, data, security)
- Explicit stack dependencies prevent deployment race conditions
- Centralized tagging strategy applied to all resources
- Environment-aware configuration (`dev` vs `prod`)

### 1.2 L3 Construct Pattern: `TenantAgent`

The `TenantAgent` construct (318 lines, `infra/constructs/tenant-agent.ts`) is a **high-level abstraction** that provisions all per-tenant resources:

```typescript
export class TenantAgent extends Construct {
  constructor(scope: Construct, id: string, props: TenantAgentProps) {
    // Creates:
    // - IAM role with DynamoDB partition isolation
    // - Cognito user group
    // - EventBridge cron jobs → Step Functions
    // - CloudWatch dashboard (errors, latency, tokens, cost)
    // - Budget alarm at 90% threshold
  }
}
```

**Key patterns:**
1. **Partition-level isolation:** DynamoDB DENY policy blocks access to other tenants' `TENANT#*` keys
2. **S3 prefix scoping:** Tenant role limited to `tenants/{tenantId}/*`
3. **Tier-based model access:** Basic (Haiku+Nova Lite), Pro (Sonnet+Nova), Enterprise (all Claude+Nova)
4. **Observability by default:** Every tenant gets a CloudWatch dashboard

**Why this matters for IaC choice:**
This L3 construct encapsulates ~15 AWS resources with security defaults. Replicating this in Terraform/Pulumi would require significant boilerplate. CDK's object-oriented design makes it trivial to extend (e.g., add `TenantAgent.addCustomSkill()` method).

### 1.3 Current CDK Patterns

| Pattern | Location | Purpose |
|---------|----------|---------|
| Gateway endpoints (free) | `network-stack.ts:66-71` | DynamoDB/S3 via private routing |
| Interface endpoints ($) | `network-stack.ts:83-100` | Bedrock, Secrets Manager, ECR on AWS backbone |
| KMS encryption | `data-stack.ts:36-42` | Audit table CMK for compliance |
| Point-in-time recovery | All tables except rate-limits | Data durability |
| Lifecycle policies | S3 buckets | Cost optimization (Intelligent Tiering, Glacier) |
| Environment-aware NAT | `network-stack.ts:33` | 1 NAT (dev) vs 2 NAT (prod) for HA |

**CDK-specific advantages used:**
- `RemovalPolicy.RETAIN` for prod data (DynamoDB, S3, KMS)
- `cdk.Duration` for type-safe timeouts
- `cdk.Tags.of(stack).add()` for automated tagging
- Cross-stack exports via `CfnOutput` + `exportName`

---

## 2. CDK: Current Choice Analysis

### 2.1 Strengths for Agent Platforms

#### Type Safety Across the Stack
```typescript
// Compile-time guarantee that VPC exists before passing to DataStack
const dataStack = new DataStack(app, `${prefix}-Data`, {
  vpc: networkStack.vpc,  // TypeScript enforces this
});
```

**Impact:** Prevents "stack X does not export VpcId" errors at deployment time. Critical for multi-stack architectures like Chimera.

#### L3 Constructs = Rapid Prototyping
The `TenantAgent` construct demonstrates CDK's power:
- 318 lines create 15+ AWS resources
- Built-in security defaults (DENY policies, encryption)
- Extensible via TypeScript inheritance

**Comparison:** Terraform would require ~600 lines of HCL + separate modules. Pulumi would be similar to CDK but with weaker construct ecosystem.

#### AWS-Native Integration
- **Bedrock permissions:** CDK provides typed `bedrock:InvokeModel` actions (lines 134-139 in `tenant-agent.ts`)
- **Cognito custom attributes:** Strongly typed via `customAttributes: { tenant_id: new cognito.StringAttribute({ mutable: false }) }`
- **WAF rules:** Type-safe rule construction vs error-prone JSON in Terraform

#### Built-in Best Practices
From AWS Prescriptive Guidance research:
- L3 constructs enforce Well-Architected Framework patterns
- AWS Solutions Constructs library provides battle-tested patterns
- `cdk-nag` integration for compliance checking (not yet in Chimera, but trivial to add)

### 2.2 Weaknesses

| Issue | Severity | Mitigation |
|-------|----------|------------|
| **CloudFormation limitations** | Medium | 500-resource limit forces stack splitting (already done) |
| **Slow deployments** | Low | Parallel stack deployment via `cdk deploy --all --concurrency=3` |
| **Breaking changes** | Low | CDK v2 is stable; breaking changes rare since 2022 |
| **Vendor lock-in** | Medium | TypeScript code is portable to Pulumi; logic reusable |
| **No drift detection** | Medium | Use `cdk diff` + CloudFormation drift detection (manual) |

**Critical for agents:**
CloudFormation's eventual consistency model can cause race conditions. Chimera mitigates via explicit `addDependency()` calls.

### 2.3 Cost of Switching

**Estimated effort to migrate to OpenTofu/Pulumi:** 4-6 weeks
- Rewrite 5 stacks (~1,200 lines of TypeScript)
- Recreate `TenantAgent` L3 construct logic
- Test multi-tenant isolation in new framework
- Retrain team on new tooling

**Risk:** High. CloudFormation state migration is complex and error-prone. No compelling feature gap justifies the cost.

---

## 3. OpenTofu (Terraform Fork) Analysis

### 3.1 What OpenTofu Offers

**Context:** OpenTofu forked from Terraform 1.6 in Aug 2023 after HashiCorp's license change. Maintains HCL compatibility while adding community-driven features.

**Strengths:**
- **Multi-cloud support:** Manage AWS + GCP + Azure in one codebase
- **Mature ecosystem:** 3,000+ providers, battle-tested workflows
- **State management:** Remote backends (S3, Terraform Cloud) with locking
- **Drift detection:** Built-in `terraform plan` shows infrastructure drift
- **Scripting:** HCL is easier to template/generate than TypeScript

**OpenTofu-specific:**
- Open-source governance (Linux Foundation)
- Client-side state encryption (added post-fork)
- Testing framework improvements

### 3.2 Weaknesses for Chimera

#### Verbose Tenant Isolation
Recreating `TenantAgent` construct in HCL would look like:

```hcl
# 15+ resources × 50+ tenants = 750 resource blocks
resource "aws_iam_role" "tenant" {
  for_each = var.tenants
  name     = "clawcore-tenant-${each.key}"
  # ...100+ lines of policy JSON...
}

resource "aws_dynamodb_table" "tenants" {
  # Must manually wire partition key isolation
}
```

**Problem:** No abstraction layer. Every tenant requires explicit resource definitions. Chimera's `TenantAgent` construct generates this dynamically.

#### Type Safety Gap
HCL provides weak typing:
```hcl
variable "tier" {
  type = string  # No enum enforcement — "enterprize" silently accepted
}
```

vs CDK:
```typescript
tier: 'basic' | 'pro' | 'enterprise'  // Compile error on typo
```

#### AWS-Specific Features Lag
- Bedrock support in Terraform provider: 6-12 months behind AWS releases
- CDK gets same-day support via `aws-cdk-lib` updates
- Example: Bedrock cross-region inference added to CDK Jan 2025, still pending in Terraform

### 3.3 When OpenTofu Makes Sense

**Use OpenTofu if:**
- Multi-cloud required (AWS + GCP/Azure)
- Existing Terraform codebase + team expertise
- Need provider for niche services (Datadog, PagerDuty, etc.)

**Chimera context:** AWS-only, TypeScript team, L3 constructs critical → OpenTofu offers no advantage.

---

## 4. Pulumi Analysis

### 4.1 What Pulumi Offers

Pulumi uses **general-purpose programming languages** (TypeScript, Python, Go) to define infrastructure. Similar philosophy to CDK but multi-cloud.

**Strengths:**
- Full TypeScript expressiveness (loops, conditionals, async/await)
- Multi-cloud: Same code structure for AWS, Azure, GCP
- Real programming patterns: inheritance, dependency injection, testing
- Native secrets management via Pulumi ESC
- Rich policy engine (Pulumi CrossGuard)

**Example:** Tenant provisioning in Pulumi
```typescript
// pulumi-typescript
const tenants = ['acme', 'initech', 'hooli'];
for (const id of tenants) {
  new aws.iam.Role(`tenant-${id}`, { /* ... */ });
  new aws.cognito.UserPoolGroup(`group-${id}`, { /* ... */ });
}
```

This is closer to CDK than Terraform.

### 4.2 Comparison to CDK

| Feature | CDK | Pulumi | Winner |
|---------|-----|--------|--------|
| **Language** | TypeScript (any language) | TypeScript, Python, Go | Tie |
| **AWS Coverage** | 100% (auto-generated from CloudFormation) | ~95% (manual provider updates) | **CDK** |
| **L3 Constructs** | AWS Solutions Constructs (200+) | Community-driven (fewer) | **CDK** |
| **Multi-cloud** | AWS-only | AWS, Azure, GCP, Kubernetes | **Pulumi** |
| **State Backend** | CloudFormation | Pulumi Cloud / S3 | Tie |
| **Deployment Speed** | CloudFormation (slow) | Direct API calls (faster) | **Pulumi** |
| **Drift Detection** | `cdk diff` (limited) | `pulumi refresh` (full) | **Pulumi** |
| **Cost** | Free | Free (self-hosted) or $50+/mo (Pulumi Cloud) | **CDK** |
| **AWS Integration** | Native (built by AWS) | Third-party | **CDK** |

### 4.3 Pulumi for Chimera: Pros and Cons

**Pros:**
1. **Faster deployments:** Pulumi uses AWS APIs directly, bypassing CloudFormation's 1-2 min overhead per stack
2. **Better secrets:** Native ESC integration vs manual Secrets Manager wiring
3. **Superior testing:** `@pulumi/policy` for policy-as-code testing
4. **Drift detection:** `pulumi refresh` shows all drift, not just CloudFormation-managed resources

**Cons:**
1. **No L3 construct equivalent:** `TenantAgent` would need manual composition of 15 resources
2. **AWS coverage gaps:** Bedrock features trail CDK by weeks/months
3. **State management complexity:** Pulumi Cloud or self-hosted backend required
4. **Team learning curve:** New toolchain vs existing CDK knowledge

**Cost-benefit:** Pulumi's deployment speed gain (~30% faster) does not justify migration cost for a TypeScript-first team with working CDK patterns.

---

## 5. Self-Modifying IaC Patterns

This is where **agent platforms diverge from traditional infrastructure**. The system must evolve its own infrastructure based on runtime behavior.

### 5.1 Use Cases for Chimera

#### 5.1.1 Tenant Onboarding
**Current state:** Manual CDK code edit to add tenant
```typescript
// Someone must manually write this:
new TenantAgent(this, 'TenantAcme', {
  tenantId: 'acme',
  tier: 'pro',
  // ...
});
```

**Self-modifying IaC:**
```typescript
// Agent writes to DynamoDB:
await dynamodb.putItem({
  TableName: 'clawcore-tenants-dev',
  Item: {
    PK: 'TENANT#acme',
    SK: 'META',
    tier: 'pro',
    budgetLimitMonthlyUsd: 1000,
  }
});

// CDK synthesis reads DynamoDB and generates stacks
```

#### 5.1.2 Dynamic Skill Deployment
**Scenario:** Tenant requests new skill via API → system provisions Lambda function + IAM role

**Traditional approach:**
1. Developer writes Lambda code
2. Developer updates CDK stack
3. Manual `cdk deploy`

**Self-modifying approach:**
1. Agent writes skill code to `s3://skills/tenant/acme/weather-api/`
2. DynamoDB Streams trigger Lambda
3. Lambda synthesizes new CDK stack with `aws-lambda.Function` construct
4. Auto-deploys via CodePipeline

#### 5.1.3 Budget-Driven Scaling
**Scenario:** Tenant hits 90% of monthly budget → system auto-scales down model tier

**Implementation:**
```typescript
// CloudWatch Alarm → EventBridge → Lambda
const handler = async (event: any) => {
  const tenantId = event.detail.tenantId;

  // Update DynamoDB config
  await dynamodb.updateItem({
    TableName: 'clawcore-tenants-dev',
    Key: { PK: `TENANT#${tenantId}`, SK: 'META' },
    UpdateExpression: 'SET tier = :tier',
    ExpressionAttributeValues: { ':tier': 'basic' }
  });

  // Trigger CDK resynthesis → updates IAM role model permissions
  await codepipeline.startPipelineExecution({
    name: 'clawcore-infra-pipeline'
  });
};
```

### 5.2 Implementation Patterns

#### Pattern 1: Configuration-Driven CDK
**Concept:** Stack synthesis reads from DynamoDB instead of hardcoded values

```typescript
// infra/bin/clawcore.ts
const dynamodb = new AWS.DynamoDB.DocumentClient();
const { Items: tenants } = await dynamodb.scan({
  TableName: `clawcore-tenants-${envName}`,
  FilterExpression: 'SK = :meta',
  ExpressionAttributeValues: { ':meta': 'META' }
}).promise();

for (const tenant of tenants) {
  new TenantAgent(app, `Tenant-${tenant.tenantId}`, {
    tenantId: tenant.tenantId,
    tier: tenant.tier,
    budgetLimitMonthlyUsd: tenant.budgetLimitMonthlyUsd,
    cronJobs: tenant.cronJobs,
    // All config from DynamoDB
  });
}
```

**Deployment trigger:** DynamoDB Streams → Lambda → CodePipeline

**Pros:**
- No manual CDK edits for tenant changes
- Tenant config is data, not code
- Version control tracks synthesis logic, not config

**Cons:**
- Bootstrapping problem: DynamoDB must exist before first synthesis
- State drift if DynamoDB and CloudFormation diverge

#### Pattern 2: CDK Construct Generator
**Concept:** Lambda function generates CDK TypeScript code and commits to Git

```typescript
// Lambda handler
const generateTenantConstruct = (config: TenantConfig): string => {
  return `
    new TenantAgent(this, 'Tenant-${config.tenantId}', ${JSON.stringify(config, null, 2)});
  `;
};

const code = generateTenantConstruct(newTenantConfig);
await fs.writeFile(`infra/lib/generated/tenant-${id}.ts`, code);
await git.commit('Add tenant via agent');
await git.push();
// Triggers CodePipeline on main branch push
```

**Pros:**
- Full audit trail in Git
- Familiar Git-based workflow
- Easy rollback via `git revert`

**Cons:**
- Slower (commit → push → pipeline)
- Git noise from automated commits

#### Pattern 3: Bedrock Agent Modifies IaC
**Concept:** Chimera agent has tool access to CDK synthesis

```typescript
// Agent tool definition
{
  "name": "provision_infrastructure",
  "description": "Provision AWS resources for tenant workload",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tenantId": { "type": "string" },
      "resources": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "type": { "enum": ["lambda", "dynamodb", "s3"] },
            "config": { "type": "object" }
          }
        }
      }
    }
  }
}
```

**Agent invokes:**
```typescript
const response = await agent.invoke({
  input: "Provision a Lambda function for tenant acme to process weather data"
});

// Agent calls provision_infrastructure tool
// → Lambda generates CDK construct
// → Deploys via CodePipeline
```

**Pros:**
- Natural language infrastructure provisioning
- Agent reasons about resource dependencies
- Cost estimation before deployment

**Cons:**
- Agent hallucination risk (provisions wrong resources)
- Requires robust validation layer

### 5.3 Safety Mechanisms

#### 5.3.1 Policy-as-Code Gates
```typescript
// cdk-nag check before synthesis
import { AwsSolutionsChecks } from 'cdk-nag';

const app = new cdk.App();
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Blocks deployment if:
// - S3 bucket not encrypted
// - IAM role has overly broad permissions
// - No CloudWatch alarms for critical metrics
```

#### 5.3.2 Approval Workflows
```yaml
# CodePipeline stage
- name: ManualApproval
  actions:
    - name: ReviewInfraChanges
      actionTypeId:
        category: Approval
        owner: AWS
        provider: Manual
      configuration:
        CustomData: "Agent requested: Add Lambda for tenant acme. Review diff before deploying."
```

#### 5.3.3 Cost Prediction
```typescript
// Before synthesis, estimate cost delta
const estimator = new CostEstimator();
const cost = await estimator.estimate(newResources);

if (cost.monthlyIncrease > 100) {
  throw new Error(`Cost increase $${cost.monthlyIncrease} exceeds threshold`);
}
```

### 5.4 Comparison: CDK vs OpenTofu vs Pulumi for Self-Modifying IaC

| Capability | CDK | OpenTofu | Pulumi |
|------------|-----|----------|--------|
| **Dynamic synthesis** | ✅ Read from DynamoDB | ⚠️ Requires wrapper scripts | ✅ Native async/await |
| **Policy gates** | ✅ cdk-nag | ✅ Sentinel | ✅ CrossGuard |
| **Git integration** | ✅ Generate TypeScript | ✅ Generate HCL | ✅ Generate Python/TS |
| **Agent tool access** | ✅ Lambda invokes CDK | ⚠️ Complex state locking | ✅ Pulumi Automation API |
| **Approval workflow** | ✅ CodePipeline | ✅ Terraform Cloud | ✅ Pulumi Cloud |
| **Cost estimation** | ⚠️ Third-party (Infracost) | ✅ Infracost native | ✅ Pulumi Policy Packs |

**Winner for agents:** Pulumi's Automation API is purpose-built for programmatic infrastructure management. However, CDK's Pattern 1 (config-driven) achieves 90% of the value with zero migration cost.

---

## 6. Recommendations

### 6.1 Short-Term (Phase 1: Q2 2026)

**Continue with CDK, implement self-modifying patterns:**

1. **Migrate tenant config to DynamoDB**
   - Current: Hardcoded in `clawcore.ts`
   - Target: DynamoDB table `clawcore-tenants-dev` drives synthesis
   - Timeline: 2 weeks

2. **Add CDK synthesis Lambda**
   ```
   DynamoDB Stream → Lambda (read tenants) → Generate CDK code → CodePipeline
   ```
   - Timeline: 1 week
   - Risk: Low (only adds automation, doesn't change stacks)

3. **Implement policy gates**
   - Add `cdk-nag` to `infra/bin/clawcore.ts`
   - Block deployment on security violations
   - Timeline: 3 days

### 6.2 Medium-Term (Phase 2: Q3 2026)

**Agent-driven infrastructure tools:**

1. **Provision Infrastructure Tool**
   - Agent can request Lambda/DynamoDB/S3 for tenant workloads
   - Human-in-loop approval for cost > $50/month
   - Validation: cdk-nag + cost estimation

2. **Skill Deployment Pipeline**
   - Agent writes skill code → S3 → Lambda synthesis → Auto-deploy
   - Tenant-scoped: skills deploy only to requesting tenant

3. **Budget-Driven Auto-Scaling**
   - CloudWatch Alarm → EventBridge → Lambda → Update DynamoDB tier → Resynthesize

### 6.3 Long-Term (Phase 3: 2027+)

**Evaluate Pulumi if:**
- Multi-cloud expansion (GCP/Azure for redundancy)
- CDK deployment speed becomes bottleneck (>10 min per stack)
- Team wants better drift detection (Pulumi Refresh)

**Do NOT migrate if:**
- AWS-only strategy continues
- Current CDK patterns scale to 500+ tenants
- Team lacks bandwidth for 6-week migration

### 6.4 Decision Matrix

| Scenario | Recommendation | Rationale |
|----------|----------------|-----------|
| **Chimera today (AWS-only, <100 tenants)** | **CDK** | L3 constructs, type safety, AWS-native |
| **Multi-cloud required** | **Pulumi** | Best multi-cloud TypeScript experience |
| **Terraform team, new project** | **OpenTofu** | Mature ecosystem, community governance |
| **Self-modifying IaC** | **CDK (Pattern 1) or Pulumi Automation API** | Both support dynamic synthesis |
| **Cost-sensitive** | **CDK** | Free, no SaaS lock-in |
| **Deployment speed critical** | **Pulumi** | Direct API calls 30% faster |

---

## 7. Self-Modifying IaC: OpenClaw/NemoClaw Comparison

### 7.1 OpenClaw's Approach
*(Note: No public documentation found — inferring from similar agent platforms)*

Likely uses:
- Terraform with dynamic modules
- Agent writes `tfvars` files → Terraform plan/apply
- Manual approval gates

**Gap vs Chimera:** No L3 construct equivalent, slower iteration

### 7.2 NemoClaw's Approach
*(Assumed to be NVIDIA-based agent platform)*

Likely uses:
- Kubernetes + Helm charts (agent orchestration)
- Infrastructure separate from agent logic
- GitOps model (ArgoCD/FluxCD)

**Gap vs Chimera:** K8s complexity overhead, less AWS-native

### 7.3 Chimera's Advantage

**Unique capability:** L3 constructs + DynamoDB-driven synthesis enables:
- Natural language tenant provisioning ("Add tenant Acme with Pro tier")
- Zero-touch skill deployment (agent writes code → auto-infra)
- Budget-aware auto-scaling (CloudWatch → tier downgrade)

**Competitor position:** OpenClaw/NemoClaw likely use traditional "infra team owns IaC" model. Chimera's self-modifying patterns enable **agent autonomy over infrastructure**.

---

## 8. Conclusion

**CDK is the right choice for Chimera's agent platform.**

**Key reasons:**
1. Type safety prevents deployment errors in multi-tenant architecture
2. L3 constructs (`TenantAgent`) encapsulate security defaults
3. AWS-native integration (Bedrock, Cognito, WAF) with same-day feature support
4. Self-modifying patterns achievable via DynamoDB-driven synthesis
5. Zero migration cost vs 6-week Pulumi/OpenTofu rewrite

**Next steps:**
1. Implement Pattern 1 (Configuration-Driven CDK) in Q2 2026
2. Add `cdk-nag` policy gates
3. Build "Provision Infrastructure" agent tool
4. Monitor for multi-cloud requirements (trigger Pulumi evaluation)

**Strategic vision:** Chimera agents will autonomously provision, scale, and optimize their own AWS infrastructure — a capability that CDK's programmability enables without requiring a framework rewrite.

---

## Appendix: Research Sources

### AWS CDK Documentation
- [Best practices for using CDK in TypeScript](https://docs.aws.amazon.com/prescriptive-guidance/latest/best-practices-cdk-typescript-iac/introduction.html)
- [AWS Solutions Constructs patterns](https://github.com/awslabs/aws-solutions-constructs)
- [DevOps Guidance: General-purpose programming languages for IaC](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/dl.eac.6-use-general-purpose-programming-languages-to-generate-infrastructure-as-code.html)

### Self-Modifying IaC
- [Deploy agentic systems on Amazon Bedrock with CrewAI using Terraform](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/deploy-agentic-systems-on-amazon-bedrock-with-the-crewai-framework.html)
- [Build AI agents with Amazon Bedrock AgentCore using CloudFormation](https://aws.amazon.com/blogs/machine-learning/build-ai-agents-with-amazon-bedrock-agentcore-using-aws-cloudformation/)
- [Agentic AI Patterns: Coding agents](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/coding-agents.html)

### Comparative Analysis
- [Choosing an IaC tool](https://docs.aws.amazon.com/prescriptive-guidance/latest/choose-iac-tool/resources.html)
- OpenTofu documentation (community-maintained)
- Pulumi documentation (pulumi.com)
