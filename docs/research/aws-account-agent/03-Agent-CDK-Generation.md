# Agent CDK Generation

> Research: How agents autonomously generate and deploy AWS infrastructure via CDK

## Overview

AWS Chimera agents don't just answer questions — they **build and operate infrastructure**. This document explores the pattern where agents generate AWS CDK (Cloud Development Kit) code, commit it to CodeCommit, and trigger autonomous deployment pipelines.

## Architecture Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                         Agent Runtime                            │
│  ┌──────────────┐      ┌─────────────────┐                     │
│  │  InfraChange │─────▶│ CDK Code Gen    │                     │
│  │  Request     │      │ (TypeScript)    │                     │
│  └──────────────┘      └─────────────────┘                     │
│                               │                                  │
│                               ▼                                  │
│                        ┌─────────────────┐                     │
│                        │ Cedar Policy    │                     │
│                        │ Authorization   │                     │
│                        └─────────────────┘                     │
│                          │            │                         │
│                    ALLOW │            │ DENY                    │
│                          ▼            ▼                         │
│              ┌──────────────┐   ┌────────────────┐            │
│              │ Auto-merge   │   │ Create PR for  │            │
│              │ to main      │   │ Human Review   │            │
│              └──────────────┘   └────────────────┘            │
└────────────────────┬──────────────────┬──────────────────────┘
                     │                  │
                     ▼                  ▼
              ┌──────────────────────────────┐
              │      AWS CodeCommit          │
              │   Repository (IaC Store)     │
              └──────────────────────────────┘
                           │
                           ▼
              ┌──────────────────────────────┐
              │     AWS CodePipeline         │
              │  (Deploy to AWS Account)     │
              └──────────────────────────────┘
```

## Core Components

### 1. InfrastructureModifier Class

**Location:** `packages/core/src/evolution/iac-modifier.ts`

The `InfrastructureModifier` orchestrates the GitOps workflow for agent-driven infrastructure changes.

**Key Responsibilities:**
- Generate CDK TypeScript code for infrastructure changes
- Validate changes against Cedar policies
- Create branches in CodeCommit
- Auto-merge or create pull requests based on authorization
- Track rate limits and cost impacts

**Core Method:**
```typescript
async proposeInfrastructureChange(
  proposal: InfrastructureChangeProposal
): Promise<InfrastructureChangeResult>
```

### 2. CDK Code Generation

Agents generate CDK code by applying **change type templates** to tenant-specific infrastructure.

**Supported Change Types:**

| Change Type | Description | Auto-Apply Eligible? |
|-------------|-------------|----------------------|
| `scale_horizontal` | Add/remove ECS tasks or Lambda concurrency | Yes (low risk) |
| `scale_vertical` | Increase CPU/memory for ECS tasks | Yes (reversible) |
| `update_env_var` | Modify environment variables | Yes (no cost impact) |
| `rotate_secret` | Generate new secret in Secrets Manager | Yes (security positive) |
| `add_tool` | Provision new tool resources | No (requires review) |
| `update_config` | Modify SSM Parameter Store values | Yes (config change) |

**Example: Horizontal Scaling**

Agent request:
```json
{
  "tenantId": "tenant-abc123",
  "changeType": "scale_horizontal",
  "changeDescription": "Scale ECS service to handle increased load",
  "parameters": {
    "desiredCount": 4
  },
  "estimatedMonthlyCostDelta": 100
}
```

Generated CDK code:
```typescript
// Scale ECS service horizontally
const service = stack.node.findChild('EcsService') as ecs.FargateService;
service.desiredCount = 4;
```

### 3. GitOps Workflow

**Step-by-Step Process:**

1. **Validation**: Check Cedar policy allows operation
2. **Branch Creation**: `evolution/{tenantId}/{changeType}-{timestamp}`
3. **Code Commit**: Write CDK changes to `tenants/{tenantId}/config.ts`
4. **Authorization Decision**:
   - **ALLOW** → Auto-merge to main → Trigger CodePipeline
   - **DENY** → Create PR with cost estimate → Human approval required
5. **Deployment**: CodePipeline synthesizes CDK → CloudFormation change set → Deploy
6. **Feedback Loop**: Agent receives deployment status via EventBridge

## CDK Generation Patterns

### Pattern 1: Template-Based Generation

Pre-defined templates for common operations reduce generation complexity and security risk.

**Benefits:**
- Constrained to known-safe patterns
- Fast generation (no LLM calls needed)
- Predictable CloudFormation diffs
- Easy Cedar policy authoring

**Limitations:**
- Less flexible than LLM-generated code
- Requires maintaining template library
- Cannot handle novel infrastructure requests

**Implementation:**
```typescript
const changeTypeTemplates: Record<IaCChangeType, (p: any) => string> = {
  scale_horizontal: (p) =>
    `// Scale ECS service horizontally
const service = stack.node.findChild('EcsService') as ecs.FargateService;
service.desiredCount = ${p.desiredCount || 2};`,

  // ... other templates
};
```

### Pattern 2: LLM-Assisted Generation

For novel infrastructure requirements, agents use foundation models to generate CDK code.

**Workflow:**
1. Agent analyzes requirements (e.g., "Deploy video transcoding pipeline")
2. Generate CDK code via Claude Sonnet 4.6 with CDK schema in context
3. Validate generated code with `cdk synth --dry-run`
4. Estimate cost delta via AWS Pricing API
5. Submit for Cedar policy evaluation

**Safety Mechanisms:**
- Static analysis (AST parsing) before commit
- CloudFormation drift detection after deploy
- Automatic rollback on health check failures
- Rate limiting: max 5 LLM-generated changes per tenant per day

### Pattern 3: Composition from L3 Constructs

Agents compose infrastructure from pre-built L3 constructs for common patterns.

**Example: Data Lake Ingestion Pipeline**

Agent request:
```json
{
  "pattern": "data-lake-ingestion",
  "sources": ["s3://videos-bucket"],
  "processors": ["mediaconvert", "rekognition"],
  "destination": "s3://data-lake-bucket",
  "catalogFormat": "iceberg"
}
```

Generated CDK (composition):
```typescript
import { DataLakeIngestionPipeline } from '@chimera/constructs';

const pipeline = new DataLakeIngestionPipeline(stack, 'VideoPipeline', {
  sources: [s3.Bucket.fromBucketName(this, 'Source', 'videos-bucket')],
  processors: [
    new MediaConvertProcessor(this, 'Transcode', { /* ... */ }),
    new RekognitionProcessor(this, 'Analysis', { /* ... */ }),
  ],
  destination: dataLakeBucket,
  catalog: new IcebergCatalog(this, 'Catalog', { /* ... */ }),
  tenantId: props.tenantId,
});
```

**Why L3 Constructs?**
- Encapsulate multi-tenant isolation (IAM, KMS, VPC security groups)
- Enforce best practices (encryption, logging, tagging)
- Reduce Cedar policy complexity (authorize pattern, not individual resources)
- Faster synthesis and deployment

## Cost Estimation

Agents must estimate monthly cost delta before proposing changes. This enables Cedar policies to gate expensive operations.

**Estimation Strategy:**

1. **Static Lookup**: Pre-computed cost table for template-based changes
   ```typescript
   const costEstimates: Record<IaCChangeType, number> = {
     scale_horizontal: 50,  // $50/month per additional instance
     scale_vertical: 30,    // $30/month for size upgrade
     add_tool: 10,          // $10/month average tool cost
   };
   ```

2. **CloudFormation Diff Analysis**: Parse `cdk diff` output for resource changes
   - Count new Lambda functions → $0.20/1M invocations
   - Count new ECS tasks → instance pricing × 730 hours
   - Count new S3 buckets → assume 100GB/month baseline

3. **AWS Pricing API Integration**: Real-time pricing for complex changes
   ```typescript
   const pricing = new AWS.Pricing({ region: 'us-east-1' });
   const cost = await pricing.getProductPricing({
     serviceCode: 'AmazonEC2',
     instanceType: 't3.medium',
     region: 'us-west-2',
   });
   ```

**Cedar Policy Integration:**
```cedar
permit(
  principal is Agent,
  action == "deploy_infrastructure",
  resource is TenantAccount
)
when {
  context.estimatedMonthlyCostDelta < 100  // Max $100/month auto-approve
};
```

## Repository Structure

### CodeCommit Layout

```
chimera-infrastructure/
├── main/                            # Main branch (deployed state)
│   ├── tenants/
│   │   ├── tenant-abc123/
│   │   │   ├── config.ts           # Agent-modifiable config
│   │   │   ├── stack.ts            # CDK stack definition
│   │   │   └── resources/          # Tenant-specific resources
│   │   └── tenant-xyz789/
│   │       └── ...
│   ├── shared/
│   │   ├── constructs/             # Reusable L3 constructs
│   │   ├── policies/               # Cedar policy definitions
│   │   └── monitoring/             # CloudWatch dashboards
│   └── cdk.json                    # CDK app configuration
├── evolution/tenant-abc123/        # Agent-created branches
│   └── scale_horizontal-1234567890/
└── human-review/                   # Manual changes branch
```

### Branch Naming Convention

Agent branches follow:
```
evolution/{tenantId}/{changeType}-{timestamp}
```

Examples:
- `evolution/tenant-abc123/scale_horizontal-1710956789`
- `evolution/tenant-xyz789/add_tool-1710956812`

### File Modification Scope

Agents are restricted to modifying:
- `tenants/{tenantId}/config.ts` — Tenant-specific configuration
- `tenants/{tenantId}/resources/*.ts` — Dynamically provisioned resources

Agents **CANNOT** modify:
- `shared/` directory (requires human review)
- Other tenants' files (enforced by Cedar policy)
- CDK app structure (`cdk.json`, `bin/app.ts`)

## Deployment Pipeline

### CodePipeline Stages

```
┌─────────────────────────────────────────────────────────────────┐
│  Stage 1: Source                                                 │
│  Trigger: CodeCommit main branch update                          │
│  Output: Source artifact (zip of repo)                           │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Stage 2: Build & Synth                                          │
│  - npm install                                                   │
│  - cdk synth --all                                               │
│  - Unit tests for CDK constructs                                 │
│  Output: CloudFormation templates                                │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Stage 3: Security Validation                                    │
│  - cfn-nag (CloudFormation security scan)                        │
│  - cdk-nag (CDK best practices)                                  │
│  - Cedar policy compliance check                                 │
│  Output: Validation report                                       │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Stage 4: Manual Approval (if required)                          │
│  Conditions:                                                     │
│  - estimatedMonthlyCostDelta > $100                              │
│  - New IAM role creation                                         │
│  - VPC modifications                                             │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Stage 5: Deploy                                                 │
│  - Create CloudFormation change set                              │
│  - Execute change set                                            │
│  - Monitor stack events                                          │
│  Output: Deployed resources                                      │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Stage 6: Validation & Rollback                                  │
│  - Health checks on new resources                                │
│  - Synthetic monitoring tests                                    │
│  - Auto-rollback if failure detected                             │
└─────────────────────────────────────────────────────────────────┘
```

### Deployment Approval Gates

**Automatic Deployment (No Approval):**
- Environment variable updates
- Horizontal scaling within limits (max +2 instances)
- Secret rotation
- Configuration changes (non-critical)

**Manual Approval Required:**
- New IAM roles or policies
- VPC or security group changes
- Lambda function code updates
- Cost delta > $100/month
- New data stores (RDS, DynamoDB tables)

## Feedback and Monitoring

### Agent Notification Mechanisms

**1. EventBridge Integration**

Deployment events published to custom event bus:
```json
{
  "source": "chimera.infrastructure",
  "detail-type": "DeploymentStatusChanged",
  "detail": {
    "tenantId": "tenant-abc123",
    "branch": "evolution/tenant-abc123/scale_horizontal-1710956789",
    "status": "SUCCEEDED",
    "stackName": "ChimeraTenantStack-abc123",
    "resources": [
      {
        "type": "AWS::ECS::Service",
        "id": "ChimeraAgentService",
        "status": "UPDATE_COMPLETE"
      }
    ]
  }
}
```

Agent runtime subscribes to these events and updates session context.

**2. CloudWatch Logs Streaming**

CDK synthesis and deployment logs streamed to CloudWatch Logs group:
```
/aws/codepipeline/chimera-infrastructure/{tenantId}
```

Agent can query logs via CloudWatch Logs Insights to debug failed deployments.

**3. DynamoDB State Table**

Deployment state stored in `chimera-infrastructure-state` table:
```
PK: TENANT#abc123
SK: DEPLOY#evolution/scale_horizontal-1710956789

Attributes:
- status: IN_PROGRESS | SUCCEEDED | FAILED
- startTime: ISO timestamp
- resources: [list of ARNs]
- cedarDecision: ALLOW | DENY
- approvalRequired: boolean
- costDelta: 50.00
```

Agents poll this table to track long-running deployments.

## Error Handling

### Common Failure Modes

**1. CloudFormation Stack Update Failure**

```typescript
{
  status: 'denied',
  changeType: 'scale_horizontal',
  reason: 'CloudFormation stack update failed: Resource limit exceeded',
}
```

**Agent Response:**
- Parse stack events to identify failed resource
- Propose alternative approach (e.g., scale vertically instead)
- Notify tenant with actionable error message

**2. Cedar Policy Denial**

```typescript
{
  status: 'pr_created',
  cedarDecision: 'DENY',
  reason: 'Estimated cost delta ($150) exceeds auto-approval limit ($100)',
}
```

**Agent Response:**
- Create PR with cost breakdown
- Tag relevant human operators
- Provide rationale for why change is needed

**3. CodeCommit Merge Conflict**

```typescript
{
  status: 'denied',
  reason: 'Merge conflict detected: Another agent modified tenants/abc123/config.ts',
}
```

**Agent Response:**
- Fetch latest main branch
- Regenerate CDK code with up-to-date base
- Retry merge

### Rollback Strategy

**Automatic Rollback Triggers:**
- Health check failure within 5 minutes of deployment
- Error rate spike (>1% of requests)
- Latency increase (p99 > 2x baseline)

**Rollback Mechanism:**
```typescript
await cloudformation.executeChangeSet({
  ChangeSetName: 'RollbackChangeSet',
  StackName: `ChimeraTenantStack-${tenantId}`,
});
```

Agent notified of rollback via EventBridge, can propose revised change.

## Security Considerations

### 1. IAM Role Boundaries

Agent-generated CDK code must attach `PermissionsBoundary` to all IAM roles:

```typescript
const agentRole = new iam.Role(this, 'AgentRole', {
  assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  permissionsBoundary: iam.ManagedPolicy.fromAwsManagedPolicyName(
    'ChimeraAgentBoundary'
  ),
});
```

This prevents privilege escalation attacks where agents create overly permissive roles.

### 2. Resource Tagging Enforcement

All agent-provisioned resources must be tagged:
```typescript
Tags.of(scope).add('TenantId', props.tenantId);
Tags.of(scope).add('CreatedBy', 'agent');
Tags.of(scope).add('CostCenter', props.costCenter);
```

Service Control Policies (SCPs) deny resource creation without these tags.

### 3. VPC Isolation

Agents cannot modify VPC configuration or security groups. Network topology is human-managed.

**Agent Capabilities (Allowed):**
- Choose which VPC to deploy into (from pre-approved list)
- Assign security groups (from pre-defined catalog)

**Agent Restrictions (Denied):**
- Create new VPCs
- Modify CIDR blocks
- Add security group rules with 0.0.0.0/0 ingress

### 4. Secrets Management

Agents use AWS Secrets Manager with KMS encryption. Generated secrets have:
- Automatic rotation enabled (30 days)
- Resource policy restricting access to tenant IAM roles
- CloudTrail logging for all access

Agents **NEVER** log or return secret values in plaintext.

## Performance Optimization

### CDK Synthesis Caching

CodePipeline caches CDK synthesis results. If only tenant config changes, no full re-synth needed.

**Cache Key:** Hash of:
- CDK app code (`shared/constructs/**/*.ts`)
- Node dependencies (`package-lock.json`)
- CDK version

**Benefit:** Reduces build time from 3 minutes to 20 seconds for config-only changes.

### Parallel Tenant Deployments

CodePipeline supports parallel stage execution for multi-tenant changes:

```typescript
const tenantStages = tenants.map(tenant =>
  new codepipeline.StageProps({
    stageName: `Deploy-${tenant.id}`,
    actions: [
      new codepipeline_actions.CloudFormationCreateUpdateStackAction({
        stackName: `Chimera-${tenant.id}`,
        templatePath: synthOutput.atPath(`${tenant.id}.template.json`),
      }),
    ],
  })
);
```

Deploys up to 10 tenants concurrently, reducing overall deployment time.

## Metrics and Observability

### Key Metrics

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `agent_cdk_generations_total` | Count of CDK code generation requests | N/A |
| `agent_cdk_generation_duration` | Time to generate CDK code | >5 seconds |
| `agent_auto_deploy_rate` | % of changes auto-approved by Cedar | <50% (too restrictive) |
| `cloudformation_deploy_duration` | Time from commit to deployment complete | >10 minutes |
| `cloudformation_failure_rate` | % of stack updates that fail | >5% |
| `agent_cost_estimation_error` | Difference between estimated and actual cost | >20% |

### CloudWatch Dashboard

Pre-built dashboard for infrastructure-as-capability monitoring:

- **Agent Activity Panel**: CDK generations over time (by tenant, by change type)
- **Deployment Health Panel**: Success/failure rate, rollback count
- **Cost Impact Panel**: Estimated vs actual cost delta
- **Cedar Policy Panel**: ALLOW vs DENY decisions, approval latency

## Future Enhancements

### 1. Multi-Region Deployment

Agent-driven replication of infrastructure across AWS regions:
```typescript
{
  changeType: 'replicate_region',
  targetRegions: ['us-west-2', 'eu-west-1'],
  replicaConfig: { /* ... */ }
}
```

### 2. Infrastructure Diffing

Before deployment, show agent a visual diff of infrastructure changes:
```
Resources to be added:
  + AWS::ECS::Service AgentService
  + AWS::ElasticLoadBalancingV2::TargetGroup TargetGroup

Resources to be modified:
  ~ AWS::ECS::TaskDefinition TaskDef
    - cpu: 256
    + cpu: 512
```

Agent can review and approve/reject based on diff.

### 3. Cost Optimization Recommendations

Agent analyzes deployed infrastructure and proposes cost-saving changes:
- "Switch to Spot instances for non-critical workloads (save $120/month)"
- "Enable S3 Intelligent-Tiering on data-lake bucket (save $50/month)"

### 4. Compliance-as-Code Integration

Agent verifies infrastructure changes against compliance frameworks:
- **SOC 2**: Encryption at rest, audit logging enabled
- **HIPAA**: PHI data isolation, access controls
- **PCI DSS**: Network segmentation, key rotation

Deployment blocked if compliance checks fail.

## References

- **Implementation**: `packages/core/src/evolution/iac-modifier.ts`
- **Safety Harness**: `packages/core/src/evolution/safety-harness.ts`
- **Cedar Policies**: `infra/policies/agent-provisioning.cedar`
- **CDK Constructs**: `infra/lib/constructs/`
- **AWS CDK Docs**: https://docs.aws.amazon.com/cdk/
- **AWS CodePipeline**: https://docs.aws.amazon.com/codepipeline/
- **Cedar Language**: https://www.cedarpolicy.com/

---

**Next:** [04-Use-Case-Catalog.md](./04-Use-Case-Catalog.md) — Real-world examples of agent-built infrastructure
