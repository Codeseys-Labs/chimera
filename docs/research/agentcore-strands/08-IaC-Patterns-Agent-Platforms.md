# IaC Patterns for Agent Platforms

> CDK, OpenTofu, Pulumi -- choosing and composing Infrastructure as Code for AI agent deployment

---

## Why IaC Matters More for Agent Platforms

Traditional applications have relatively static infrastructure: a load balancer, some compute, a database. Agent platforms introduce dynamic requirements:

- **Runtime isolation** -- each agent (or tenant) needs its own execution context, secrets, and IAM boundaries
- **Rapid iteration** -- agent behavior changes faster than the infrastructure, but infrastructure must keep up with new tools, memory stores, and model endpoints
- **Multi-service composition** -- a single agent deployment touches compute (ECS/Lambda), storage (DynamoDB/S3), networking (VPC/API Gateway), AI services (Bedrock), and observability (CloudWatch/X-Ray)
- **Self-modification potential** -- agents that can propose or execute changes to their own infrastructure

IaC provides the repeatable, auditable, version-controlled foundation that makes all of this manageable. The choice of IaC tool shapes how teams build, govern, and scale their agent platforms.

See also: [[06-AWS-Services-Agent-Infrastructure]], [[03-AgentCore-Multi-Tenancy-Deployment]]

---

## AWS CDK for Agent Infrastructure

### Overview

AWS CDK (Cloud Development Kit) uses imperative programming languages (TypeScript, Python, Java, Go, C#) to synthesize CloudFormation templates. It provides three construct levels:

| Level | Description | Agent Platform Use |
|-------|-------------|-------------------|
| **L1** | Direct CloudFormation resources | Raw `CfnResource` for bleeding-edge features |
| **L2** | Opinionated defaults with sensible security | `ecs.FargateService`, `dynamodb.Table`, `lambda.Function` |
| **L3** | High-level patterns composing multiple resources | `ecs_patterns.ApplicationLoadBalancedFargateService`, AgentCore constructs |

### CDK for Bedrock AgentCore

As of early 2026, AWS released **`@aws-cdk/aws-bedrock-agentcore-alpha`** -- L2 constructs specifically for AgentCore deployment. This is a significant development: first-class IaC support for agent runtimes.

#### Key Constructs

```typescript
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as ecr from 'aws-cdk-lib/aws-ecr';

// Option 1: Deploy from ECR image
const repository = new ecr.Repository(this, 'AgentRepo', {
  repositoryName: 'my-agent-runtime',
});

const runtime = new agentcore.Runtime(this, 'MyAgentRuntime', {
  runtimeName: 'my-agent',
  agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
    repository, 'v1.0.0'
  ),
});

// Add a production endpoint pinned to a specific version
const prodEndpoint = runtime.addEndpoint('production', {
  version: '1',
  description: 'Stable production endpoint - pinned to v1',
});
```

```typescript
// Option 2: Deploy from local Dockerfile
const runtime = new agentcore.Runtime(this, 'MyAgentRuntime', {
  runtimeName: 'my-agent',
  agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(
    path.join(__dirname, 'agent-code')
  ),
});
```

```typescript
// Option 3: Direct code deployment (S3)
const codeBucket = new s3.Bucket(this, 'AgentCode');
const runtime = new agentcore.Runtime(this, 'MyAgentRuntime', {
  runtimeName: 'my-agent',
  agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromS3(
    { bucketName: codeBucket.bucketName, objectKey: 'deployment_package.zip' },
    agentcore.AgentCoreRuntime.PYTHON_3_12,
    ['opentelemetry-instrument', 'main.py'],
  ),
});
```

#### AgentCore CDK Features (Jan/Feb 2026)

- **API Gateway Target Support** -- integrate AgentCore gateways directly with API Gateway
- **Gateway Interceptors** -- custom logic to intercept/transform requests and responses
- **Episodic Memory Strategy** -- configure memory patterns for context across interactions
- **Versioned Deployments** -- automatic version creation on runtime config updates
- **VPC & PrivateLink** -- enterprise-grade network isolation

### CDK Patterns for Broader Agent Infrastructure

Beyond AgentCore-specific constructs, CDK excels at composing the surrounding infrastructure:

```typescript
// L3 pattern: Agent API behind ALB on Fargate
const agentService = new ecs_patterns.ApplicationLoadBalancedFargateService(
  this, 'AgentService', {
    cluster,
    taskImageOptions: {
      image: ecs.ContainerImage.fromEcrRepository(agentRepo, 'latest'),
      environment: {
        BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
        DYNAMODB_TABLE: sessionsTable.tableName,
      },
    },
    desiredCount: 2,
    memoryLimitMiB: 2048,
    cpu: 1024,
  }
);

// Grant Bedrock access
agentService.taskDefinition.taskRole.addManagedPolicy(
  iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess')
);

// Grant DynamoDB access for session state
sessionsTable.grantReadWriteData(agentService.taskDefinition.taskRole);
```

### CDK Mixins (Preview, 2025)

CDK Mixins allow composable feature injection into any construct:

```typescript
// Apply observability to any construct -- L1, L2, or custom
const service = new ecs.FargateService(this, 'AgentService', { ... });
Mixin.apply(service, new ObservabilityMixin({
  tracing: true,
  metrics: true,
  alarms: { errorRate: { threshold: 5, period: Duration.minutes(5) } },
}));
```

This pattern is valuable for agent platforms where cross-cutting concerns (logging, tracing, security) must be applied consistently across many heterogeneous resources.

### CDK Strengths for Agent Platforms

- **Type safety** -- catch misconfiguration at compile time
- **Composability** -- L3 constructs and custom constructs encapsulate complex patterns
- **First-class AgentCore support** -- alpha L2 constructs available now
- **Testing** -- unit test infrastructure with standard language test frameworks
- **Asset bundling** -- automatic Docker build + ECR push, Lambda bundling

---

## OpenTofu / Terraform for Agent Platforms

### The Landscape in 2026

The IaC landscape has shifted significantly since HashiCorp's 2023 BSL license change and IBM's $6.4B acquisition:

- **OpenTofu** (Linux Foundation) -- community-driven fork maintaining MPL 2.0, growing adoption (Fidelity: 2,000 apps migrated, Talkdesk: 4,000 state files, Masterpoint: 90+ workspaces in 7 hours)
- **Terraform** (IBM/HashiCorp) -- integrating into HCP AI Ecosystem with Project Infragraph and Terraform Stacks GA
- **Terragrunt** (Gruntwork) -- orchestration layer on top of either, with Stacks for reusable infrastructure patterns

Both OpenTofu and Terraform use HCL and share the provider ecosystem. For agent platforms, the choice is mostly about licensing and governance, not technical capability.

### HCL Module Pattern for Agent Infrastructure

```hcl
# modules/agent-runtime/main.tf
# Reusable module for deploying an agent to AgentCore

variable "agent_name" {
  type        = string
  description = "Name of the agent runtime"
}

variable "ecr_image_uri" {
  type        = string
  description = "ECR image URI for the agent container"
}

variable "vpc_id" {
  type    = string
  default = null
}

variable "memory_config" {
  type = object({
    strategy = string  # "episodic" | "semantic" | "none"
    ttl_days = number
  })
  default = {
    strategy = "none"
    ttl_days = 30
  }
}

resource "aws_bedrockagentcore_runtime" "agent" {
  runtime_name = var.agent_name

  container_config {
    image_uri = var.ecr_image_uri
  }

  vpc_config {
    vpc_id = var.vpc_id
  }
}

resource "aws_bedrockagentcore_runtime_endpoint" "production" {
  runtime_id  = aws_bedrockagentcore_runtime.agent.id
  endpoint_name = "production"
  description   = "Stable production endpoint"
}

# DynamoDB table for agent session state
resource "aws_dynamodb_table" "sessions" {
  name         = "${var.agent_name}-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "session_id"

  attribute {
    name = "session_id"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}

output "runtime_arn" {
  value = aws_bedrockagentcore_runtime.agent.arn
}

output "endpoint_url" {
  value = aws_bedrockagentcore_runtime_endpoint.production.url
}
```

### State Management Considerations

Agent platforms with many tenants create state management challenges:

| Approach | Pros | Cons |
|----------|------|------|
| **Single state file** | Simple, one `tofu apply` | Blast radius, lock contention, slow plans |
| **State per environment** | Isolated dev/staging/prod | Still large per-env for multi-tenant |
| **State per tenant** | Full isolation, parallel applies | State file proliferation, orchestration complexity |
| **Terraform Stacks** | Multi-component orchestration as single unit | Terraform-only (not OpenTofu), newer feature |
| **Terragrunt Stacks** | Reusable patterns, dependency-aware orchestration | Additional tool dependency |

For agent platforms, **state per environment with module-per-tenant** is a pragmatic middle ground:

```hcl
# environments/prod/main.tf
module "agent_customer_a" {
  source     = "../../modules/agent-runtime"
  agent_name = "customer-a-agent"
  ecr_image_uri = var.agent_image_uri
  memory_config = { strategy = "episodic", ttl_days = 90 }
}

module "agent_customer_b" {
  source     = "../../modules/agent-runtime"
  agent_name = "customer-b-agent"
  ecr_image_uri = var.agent_image_uri
  memory_config = { strategy = "semantic", ttl_days = 30 }
}
```

### GitOps Patterns

GitOps for agent infrastructure follows established patterns with agent-specific considerations:

1. **Git as single source of truth** -- all infrastructure definitions in version control
2. **Pull-based reconciliation** -- CI/CD watches for changes and applies (ArgoCD, Flux for K8s; Atlantis, Spacelift, or Harness IaCM for Terraform/OpenTofu)
3. **PR-based workflow** -- infrastructure changes go through review, with plan output as PR comments
4. **Drift detection** -- scheduled `tofu plan` to detect manual changes

Agent-specific GitOps additions:
- **Model version pinning** -- track which Bedrock model version each agent uses
- **Tool manifest versioning** -- agent tools change independently of infrastructure
- **Canary deployments** -- route a percentage of traffic to new agent versions before full rollout
- **Cost impact analysis** -- AI agent infrastructure costs can be unpredictable; tools like Infracost or Harness IaCM provide pre-merge cost estimates

### OpenTofu Strengths for Agent Platforms

- **Open-source governance** -- no licensing risk for commercial agent platforms
- **Massive provider ecosystem** -- AWS, GCP, Azure, Kubernetes providers all compatible
- **Mature tooling** -- Atlantis, Spacelift, Terragrunt, Terramate all support OpenTofu
- **HCL familiarity** -- most infrastructure teams already know HCL

---

## Pulumi for Agent Platforms

### Overview

Pulumi uses general-purpose programming languages (TypeScript, Python, Go, C#, Java, YAML) for infrastructure definition. Unlike CDK (which synthesizes to CloudFormation), Pulumi has its own engine and state management, and supports any cloud provider.

### Pulumi for Bedrock AgentCore

Pulumi has published a reference architecture for deploying Strands Agents to AgentCore:

```python
import pulumi
import pulumi_aws as aws

# ECR Repository for agent container
agent_repo = aws.ecr.Repository("agent-repo",
    name="my-strands-agent",
    force_delete=True,
)

# IAM role for AgentCore runtime
agent_role = aws.iam.Role("agent-role",
    assume_role_policy=pulumi.Output.json_dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "bedrock.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }],
    }),
)

# Bedrock model access policy
aws.iam.RolePolicyAttachment("bedrock-access",
    role=agent_role.name,
    policy_arn="arn:aws:iam::aws:policy/AmazonBedrockFullAccess",
)

# AgentCore Runtime
agent_runtime = aws.bedrockagentcore.Runtime("my-agent",
    runtime_name="strands-agent",
    network_configuration={
        "network_mode": "PUBLIC",
    },
)

pulumi.export("runtime_arn", agent_runtime.arn)
```

### Pulumi Components for Reusability

Pulumi Components are analogous to CDK L3 constructs -- multi-resource abstractions authored once and consumed in any Pulumi language:

```python
import pulumi
from pulumi import ComponentResource, ResourceOptions
import pulumi_aws as aws

class AgentPlatform(ComponentResource):
    """A reusable component that provisions a complete agent platform."""

    def __init__(self, name: str, args: dict, opts=None):
        super().__init__("custom:platform:AgentPlatform", name, {}, opts)

        child_opts = ResourceOptions(parent=self)

        # ECR repository
        self.repo = aws.ecr.Repository(f"{name}-repo",
            name=f"{name}-agent",
            opts=child_opts,
        )

        # DynamoDB for sessions
        self.sessions_table = aws.dynamodb.Table(f"{name}-sessions",
            name=f"{name}-sessions",
            billing_mode="PAY_PER_REQUEST",
            hash_key="session_id",
            attributes=[{"name": "session_id", "type": "S"}],
            ttl={"attribute_name": "expires_at", "enabled": True},
            opts=child_opts,
        )

        # API Gateway for agent endpoint
        self.api = aws.apigatewayv2.Api(f"{name}-api",
            protocol_type="HTTP",
            opts=child_opts,
        )

        # AgentCore Runtime
        self.runtime = aws.bedrockagentcore.Runtime(f"{name}-runtime",
            runtime_name=name,
            opts=child_opts,
        )

        self.register_outputs({
            "repo_url": self.repo.repository_url,
            "api_endpoint": self.api.api_endpoint,
            "runtime_arn": self.runtime.arn,
        })
```

### Pulumi Neo -- AI Agent for Infrastructure

Pulumi Neo (launched 2025) is an AI agent that manages infrastructure itself:

- Understands full infrastructure context across stacks
- Respects existing policies and governance guardrails
- Executes complex infrastructure tasks end-to-end
- Maintains audit trails and compliance controls
- Werner Enterprises reduced provisioning from 3 days to 4 hours

This is a concrete example of **agents managing agent infrastructure** -- a meta-pattern where the IaC tool itself uses AI to provision and modify agent platforms.

### Pulumi + HCL + Terraform/OpenTofu (2025-2026)

Pulumi Cloud now manages Terraform/OpenTofu state with full visibility, governance, and Neo AI support. Additionally, Pulumi IaC supports HCL natively as a language, alongside Python/TypeScript/Go/etc. This means:

- Existing Terraform/OpenTofu modules can be consumed directly in Pulumi
- Teams can migrate incrementally
- Pulumi Cloud provides a unified control plane for mixed IaC estates

### Pulumi Strengths for Agent Platforms

- **True multi-cloud** -- same code deploys to AWS, GCP, Azure, K8s
- **Real programming languages** -- full IDE support, testing, type safety, package ecosystems
- **Component model** -- cross-language reusable components
- **Neo AI agent** -- AI-assisted infrastructure management
- **Unified secrets management (ESC)** -- critical for agent platforms with many API keys and model credentials

---

## CDKTF / CDK Terrain: Bridging CDK and Terraform

### What It Is

CDK for Terraform (CDKTF) -- now rebranded as **CDK Terrain** under the Open Constructs Foundation -- lets you write CDK-style imperative code that synthesizes to Terraform/OpenTofu HCL instead of CloudFormation.

### Why It Matters for Agent Platforms

| Benefit | Detail |
|---------|--------|
| **CDK developer experience** | TypeScript/Python constructs with type safety |
| **Terraform provider ecosystem** | Access to all Terraform providers, not just AWS |
| **OpenTofu compatible** | Synthesized HCL works with `tofu` CLI |
| **Existing module reuse** | Import any Terraform module as a CDKTF construct |
| **Multi-cloud agents** | Deploy agent infrastructure to AWS + GCP + Azure from one codebase |

```typescript
// CDKTF / CDK Terrain example
import { App, TerraformStack } from 'cdktf';
import { AwsProvider } from '@cdktf/provider-aws';
import { BedrockagentcoreRuntime } from '@cdktf/provider-aws/lib/bedrockagentcore-runtime';
import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';

class AgentStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, 'aws', { region: 'us-east-1' });

    const sessionsTable = new DynamodbTable(this, 'sessions', {
      name: 'agent-sessions',
      billingMode: 'PAY_PER_REQUEST',
      hashKey: 'session_id',
      attribute: [{ name: 'session_id', type: 'S' }],
    });

    new BedrockagentcoreRuntime(this, 'agent', {
      runtimeName: 'my-agent',
    });
  }
}
```

---

## Self-Modifying IaC: Agents That Edit Their Own Infrastructure

This is one of the most powerful -- and risky -- patterns emerging in the agent platform space. An agent that can modify its own infrastructure code can:

### Use Cases

1. **Auto-scaling beyond simple rules** -- agent detects latency patterns and adds capacity proactively by modifying desired count in IaC
2. **Tool provisioning** -- agent determines it needs a new database or API and creates the IaC definition for it
3. **Cost optimization** -- agent analyzes usage patterns and right-sizes infrastructure definitions
4. **Self-healing** -- agent detects persistent failures and modifies its own configuration

### Implementation Patterns

#### Pattern 1: Agent Proposes, Human Approves (GitOps)

```
Agent detects need --> Generates IaC diff --> Creates PR --> Human reviews --> CI/CD applies
```

This is the safest pattern. The agent writes infrastructure code but all changes go through standard review and approval. Tools like Pulumi Neo operate in this mode.

#### Pattern 2: Agent Applies Within Guardrails (Policy-Bounded)

```
Agent generates IaC --> Policy engine validates --> Auto-apply if within bounds --> Alert if not
```

Using Cedar policies (AgentCore Policy), OPA, or Pulumi Policies to define what infrastructure changes an agent can make without human approval:

```rego
# OPA policy: agent can only modify its own resources
allow {
    input.action == "update"
    input.resource.tags["managed-by"] == input.agent_id
    input.resource.type in {"aws_dynamodb_table", "aws_lambda_function"}
}

deny {
    input.action == "delete"
    input.resource.type == "aws_iam_role"
}
```

#### Pattern 3: Runtime Configuration Only (No IaC Mutation)

The agent modifies runtime parameters (environment variables, feature flags, model selection) without touching IaC. Infrastructure provides the envelope; the agent configures within it.

### Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Runaway cost | Budget alerts, resource quotas, policy limits on instance types/counts |
| Security escalation | IAM boundaries, deny policies on sensitive resources |
| Infinite loops | Change frequency limits, circuit breakers |
| State corruption | Separate state for agent-managed vs platform-managed resources |
| Drift from intent | Regular reconciliation, human review cadence |

---

## Per-Tenant Infrastructure Patterns

Agent platforms serving multiple customers or teams face a fundamental question: how much infrastructure isolation does each tenant get?

### Stack-Per-Tenant

```
tenant-a-stack/     --> Dedicated VPC, ECS cluster, DynamoDB tables, AgentCore runtime
tenant-b-stack/     --> Dedicated VPC, ECS cluster, DynamoDB tables, AgentCore runtime
shared-stack/       --> Shared API Gateway, DNS, monitoring
```

**Pros:** Full isolation, independent scaling, independent deployment, blast radius limited to one tenant
**Cons:** Infrastructure cost scales linearly, operational overhead per tenant, slower provisioning

**IaC implementation:**

```typescript
// CDK: Stack-per-tenant with shared configuration
class TenantAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: { tenantId: string; tier: string }) {
    super(scope, id);
    // Each tenant gets its own resources
    const runtime = new agentcore.Runtime(this, 'Runtime', {
      runtimeName: `${props.tenantId}-agent`,
      // Tier-based resource allocation
      ...(props.tier === 'enterprise' ? { memorySize: 4096 } : { memorySize: 1024 }),
    });
  }
}

// Instantiate per tenant
for (const tenant of tenants) {
  new TenantAgentStack(app, `Agent-${tenant.id}`, {
    tenantId: tenant.id,
    tier: tenant.tier,
  });
}
```

### Shared Infrastructure with Logical Isolation

```
platform-stack/     --> Shared VPC, shared ECS cluster, shared DynamoDB (partition key = tenant_id)
                        AgentCore handles session isolation per-tenant
```

**Pros:** Cost-efficient, simpler operations, faster onboarding
**Cons:** Noisy neighbor risk, shared blast radius, complex IAM

**IaC implementation:**

```hcl
# OpenTofu: Shared infrastructure with per-tenant configuration
resource "aws_dynamodb_table" "sessions" {
  name         = "agent-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenant_id"
  range_key    = "session_id"

  attribute {
    name = "tenant_id"
    type = "S"
  }
  attribute {
    name = "session_id"
    type = "S"
  }
}

# Per-tenant AgentCore runtime (logical isolation)
resource "aws_bedrockagentcore_runtime" "tenant" {
  for_each     = var.tenants
  runtime_name = "${each.key}-agent"

  tags = {
    tenant_id = each.key
    tier      = each.value.tier
  }
}
```

### Hybrid: Tiered Isolation

Most production agent platforms use a **tiered approach**:

| Tier | Isolation Level | IaC Pattern |
|------|----------------|-------------|
| **Free/Basic** | Shared compute, shared tables (partition key isolation) | Single stack, `for_each` / loop |
| **Pro** | Dedicated AgentCore runtime, shared networking | Module per tenant within shared stack |
| **Enterprise** | Dedicated stack, VPC, all resources isolated | Stack per tenant |

See [[03-AgentCore-Multi-Tenancy-Deployment]] for AgentCore-specific multi-tenancy patterns.

---

## Platform-Level vs Deployment-Level IaC Separation

A critical architectural decision is separating infrastructure into layers with different change frequencies and ownership:

### Platform Layer (Changes Rarely, Ops Team Owns)

- VPC, subnets, NAT gateways
- ECS/EKS clusters
- RDS/Aurora clusters
- Shared API Gateway
- IAM roles and policies
- Monitoring and alerting infrastructure
- CI/CD pipelines

### Deployment Layer (Changes Frequently, Dev Team Owns)

- Agent container definitions and versions
- AgentCore runtime configurations
- DynamoDB table schemas for agent-specific data
- Lambda functions for agent tools
- Model selection and configuration
- Environment variables and feature flags

### IaC Organization

```
infra/
  platform/                  # Managed by platform team
    network/                 # VPC, subnets, security groups
    compute/                 # ECS clusters, node groups
    data/                    # RDS, ElastiCache, shared DynamoDB
    observability/           # CloudWatch, X-Ray, dashboards
  agents/                    # Managed by agent dev teams
    agent-customer-support/  # One module per agent
      main.tf
      variables.tf
    agent-data-analysis/
      main.tf
      variables.tf
  shared-modules/            # Reusable modules
    agent-runtime/           # AgentCore runtime + endpoint
    agent-tools/             # Lambda-based tool infrastructure
    agent-storage/           # DynamoDB + S3 for agent state
```

This separation enables:
- **Independent deployment cadence** -- platform changes go through stricter review; agent configs deploy rapidly
- **Blast radius isolation** -- a bad agent deploy cannot break networking
- **Different permission models** -- agent devs get write access to `agents/` only
- **State file separation** -- platform and agent state files are independent

---

## Comparison: CDK vs OpenTofu vs Pulumi for Agent Platforms

| Dimension | AWS CDK | OpenTofu | Pulumi |
|-----------|---------|----------|--------|
| **Language** | TypeScript, Python, Java, Go, C# | HCL (declarative) | TypeScript, Python, Go, C#, Java, YAML |
| **Cloud support** | AWS only | Multi-cloud (via providers) | Multi-cloud (native) |
| **AgentCore constructs** | L2 alpha constructs (first-class) | CloudFormation provider resource | AWS provider resource |
| **State management** | CloudFormation (managed by AWS) | S3 + DynamoDB / Terraform Cloud / Spacelift | Pulumi Cloud / S3 / local |
| **Testing** | Jest, pytest, etc. (standard) | `terraform test` (limited) | Standard language test frameworks |
| **Reusability** | Constructs (L2/L3) | Modules (HCL) | Components (cross-language) |
| **AI assistance** | Amazon Q / Copilot | Limited | Pulumi Neo (purpose-built) |
| **License** | Apache 2.0 | MPL 2.0 | Apache 2.0 (engine), Pulumi Cloud commercial |
| **Learning curve** | Moderate (need CDK + AWS knowledge) | Low (HCL is simple) | Moderate (need language + Pulumi concepts) |
| **Multi-tenant pattern** | Stack per tenant (natural) | Workspaces / `for_each` / Terragrunt | Stacks + component resources |
| **Self-modifying IaC** | Possible via CDK CLI in agent | Possible via `tofu apply` in agent | Pulumi Neo does this natively |
| **Ecosystem maturity** | Strong for AWS | Largest provider ecosystem | Growing rapidly |
| **Best for** | AWS-only agent platforms, teams wanting first-class AgentCore support | Multi-cloud, teams with existing Terraform skills, open-source preference | Polyglot teams, multi-cloud, teams wanting AI-native IaC |

### Decision Framework

**Choose CDK when:**
- Your agent platform is AWS-only
- You want first-class AgentCore L2 constructs
- Your team prefers TypeScript/Python and values type safety
- You want CloudFormation's built-in rollback and drift detection

**Choose OpenTofu when:**
- You need multi-cloud or want to avoid vendor lock-in
- Your team already knows HCL/Terraform
- Open-source licensing is a hard requirement
- You have existing Terraform modules to reuse

**Choose Pulumi when:**
- You want true multi-cloud with real programming languages
- Your team is polyglot (Python backend, TypeScript frontend, Go infrastructure)
- You want AI-assisted infrastructure management (Neo)
- You need unified secrets management across providers
- You want to manage Terraform/OpenTofu state alongside Pulumi

**Consider CDKTF/CDK Terrain when:**
- You want CDK's developer experience with Terraform's provider ecosystem
- You need multi-cloud but prefer CDK's construct model

---

## Recommendations for Agent Platform Teams

1. **Start with CDK if AWS-only.** The AgentCore alpha constructs provide the fastest path to production. Fall back to L1 constructs for features not yet in L2.

2. **Use OpenTofu for multi-cloud foundations.** If your agent platform spans AWS + GCP (or plans to), OpenTofu's provider ecosystem is unmatched. Pair with Terragrunt for orchestration.

3. **Separate platform and deployment IaC from day one.** This is the single most impactful organizational decision. It prevents platform instability from agent experiments and enables independent team velocity.

4. **Start with shared infrastructure, add isolation as needed.** Stack-per-tenant is expensive. Use AgentCore's built-in session isolation and DynamoDB partition key isolation first. Graduate enterprise tenants to dedicated stacks.

5. **Gate self-modifying IaC behind policy.** If agents can edit infrastructure, use Cedar/OPA policies as non-negotiable guardrails. Start with "propose via PR" before allowing auto-apply.

6. **Version everything.** Pin agent container images, Bedrock model versions, and tool definitions in IaC. Use Git tags to create reproducible deployments.

7. **Invest in cost visibility.** Agent infrastructure costs are less predictable than traditional workloads. Integrate Infracost, AWS Cost Explorer tags, or Pulumi cost estimates into the PR review workflow.

---

## Related Documents

- [[01-AgentCore-Architecture-Runtime]] -- AgentCore runtime model and deployment lifecycle
- [[03-AgentCore-Multi-Tenancy-Deployment]] -- Multi-tenancy patterns and session isolation
- [[06-AWS-Services-Agent-Infrastructure]] -- AWS services that compose agent platforms

---

*Research compiled 2026-03-19. Sources: AWS CDK Community Update Jan/Feb 2026, AWS CDK AgentCore Alpha documentation, Pulumi 2025 product launches, Pulumi AgentCore blog, OpenTofu vs Terraform 2026 analysis, Terragrunt Stacks documentation, GitOps patterns for Terraform/OpenTofu.*
