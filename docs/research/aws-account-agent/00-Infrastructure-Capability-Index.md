# Infrastructure-as-Capability: Agents that Build and Operate AWS Resources

**Status:** Research
**Version:** 1.0
**Last Updated:** 2026-03-20
**Author:** builder-infra-plumbing

---

## Overview

AWS Chimera agents possess **infrastructure as a first-class capability**—they don't just answer questions or generate code snippets; they autonomously **provision, modify, and operate AWS resources** within safety boundaries.

This research explores the architectural pattern where agents:
1. **Generate Infrastructure-as-Code (IaC)** — CDK TypeScript or CloudFormation templates
2. **Commit changes to CodeCommit** — Using Git as their persistent workspace
3. **Trigger deployment pipelines** — CodePipeline orchestrates validation, canary testing, and rollout
4. **Self-heal and scale** — Agents respond to CloudWatch alarms by modifying their own infrastructure

---

## Why Infrastructure-as-Capability?

Traditional agent platforms treat infrastructure as a **separate operational concern**:
- Developers write infrastructure code
- Operations teams deploy it
- Agents run on pre-provisioned resources

Chimera inverts this model: **agents control their own infrastructure lifecycle**.

### Benefits

| Capability | Traditional Model | Chimera Model |
|------------|-------------------|---------------|
| **Scaling** | Manual capacity planning | Agent scales its own ECS tasks based on queue depth |
| **Cost optimization** | Post-hoc analysis and manual tuning | Agent downgrades instance types during low-traffic periods |
| **Tool provisioning** | Request IAM permissions via ticket | Agent adds DynamoDB GSI when detecting access patterns |
| **Self-healing** | PagerDuty → human investigation → Terraform apply | Agent detects error spike → restarts runtime → commits fix |
| **Multi-tenancy** | Shared infrastructure with noisy neighbors | Agent provisions dedicated VPC, S3 buckets, KMS keys per tenant |

### Real-World Use Cases

The research includes practical examples from production Chimera deployments:

1. **Video Ingestion Pipeline** — Agent provisions S3 bucket → MediaConvert job → Lambda triggers → DynamoDB metadata table in response to user request "Process video uploads"
2. **Data Lake Cataloging** — Agent detects new S3 prefix patterns → adds Glue crawler → updates Athena views → grants Lake Formation permissions
3. **Search Infrastructure Scaling** — Agent monitors OpenSearch query latency → provisions additional data nodes → rebalances shards → notifies user
4. **ML Experiment Infrastructure** — Agent creates SageMaker notebook → attaches FSx filesystem → configures VPC endpoints → grants Bedrock access

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Decision                          │
│  "User needs video processing → I'll provision MediaConvert" │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│             InfrastructureModifier Service                   │
│  • Validate operation safety (EvolutionSafetyHarness)       │
│  • Generate CDK diff (TypeScript IaC)                       │
│  • Evaluate Cedar policy (ALLOW/DENY + reasoning)           │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┴──────────────┐
         │                            │
    ALLOW (auto-apply)           DENY (requires approval)
         │                            │
         ▼                            ▼
┌──────────────────────┐   ┌────────────────────────┐
│  CodeCommit Repo     │   │  Pull Request Created  │
│  • Create branch     │   │  • Human review UI     │
│  • Commit CDK change │   │  • Cost estimate       │
│  • Auto-merge        │   │  • Security scan       │
└──────┬───────────────┘   └────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│                    CodePipeline Trigger                      │
│  1. Source stage (CodeCommit webhook)                       │
│  2. Build stage (lint, test, CDK synth, Docker build)       │
│  3. Deploy stage (canary orchestration via Step Functions)  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│          Step Functions: Canary Orchestration                │
│  • 5% canary deployment                                      │
│  • 30-min bake (monitor CloudWatch alarms)                  │
│  • Progressive rollout: 25% → 50% → 100%                    │
│  • Auto-rollback on failure                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. InfrastructureModifier Service

Implemented in `packages/core/src/evolution/iac-modifier.ts`:

```typescript
export class InfrastructureModifier {
  async proposeInfrastructureChange(proposal: InfrastructureChangeProposal) {
    // Step 1: Validate operation safety (block dangerous ops)
    const safetyCheck = this.safetyHarness.validateInfraOperation(
      proposal.changeType
    );

    // Step 2: Generate CDK diff (TypeScript IaC templates)
    const iacDiff = await this.generateCDKDiff(proposal);

    // Step 3: Cedar policy evaluation (tenant + cost + operation)
    const authResult = await this.safetyHarness.authorize({
      tenantId: proposal.tenantId,
      action: 'create',
      eventType: 'evolution_infra',
      changeType: proposal.changeType,
      estimatedMonthlyCostDelta: proposal.estimatedMonthlyCostDelta,
    });

    // Step 4: Create Git branch and commit
    await this.codecommit.send(new CreateBranchCommand({ branchName }));
    await this.codecommit.send(new PutFileCommand({ fileContent: iacDiff }));

    // Step 5: Auto-apply or create PR based on Cedar decision
    if (authResult.decision === 'ALLOW') {
      await this.codecommit.send(new MergeBranchesByFastForwardCommand());
      return { status: 'auto_applied' };
    } else {
      await this.codecommit.send(new CreatePullRequestCommand());
      return { status: 'pr_created', prId };
    }
  }
}
```

**Change types bounded by Cedar policies:**
- `scale_horizontal` — Add/remove ECS tasks or Lambda concurrency
- `scale_vertical` — Upgrade instance types or increase memory/CPU
- `update_env_var` — Modify environment variables (non-secret)
- `rotate_secret` — Rotate Secrets Manager credentials
- `add_tool` — Provision resources for new MCP tool (S3, DynamoDB, Lambda)
- `update_config` — Modify SSM Parameter Store configuration

**Dangerous operations (always require human approval):**
- `delete_table` — Drop DynamoDB table (data loss risk)
- `delete_bucket` — Remove S3 bucket (data loss risk)
- `modify_iam` — Change IAM roles/policies (privilege escalation risk)
- `modify_vpc` — Alter VPC/subnet/route tables (network isolation risk)
- `modify_security_group` — Open ports (security boundary violation)
- `delete_runtime` — Terminate agent runtime (service disruption)

### 2. CodeCommit as Agent Workspace

See: [01-CodeCommit-Agent-Workspace.md](./01-CodeCommit-Agent-Workspace.md)

CodeCommit serves as the **agent's persistent filesystem** for IaC:
- Each tenant gets a dedicated repository path: `tenants/{tenant-id}/`
- Agents create feature branches: `evolution/{tenant-id}/{change-type}-{timestamp}`
- Git history provides full audit trail of all infrastructure mutations
- Pre-commit hooks enforce security scans (cdk-nag, Checkov) before merge

### 3. CodePipeline for Autonomous Deployment

See: [02-CodePipeline-Autonomous-Deployment.md](./02-CodePipeline-Autonomous-Deployment.md)

CodePipeline orchestrates the deployment lifecycle with **automatic rollback**:
1. **Source Stage** — Webhook triggered by CodeCommit merge
2. **Build Stage** — Lint, typecheck, unit tests, CDK synth, Docker build (<8 min)
3. **Deploy Stage** — Step Functions canary orchestration (5% → 100% over 60 min)

**Rollback triggers:**
- Error rate >5% for 5 consecutive minutes
- P99 latency >2x baseline for 10 minutes
- Guardrail trigger rate >10% for 15 minutes
- Evaluation composite score <80

---

## Safety Mechanisms

### 1. Cedar Policy-Based Access Control (PBAC)

Every infrastructure change is evaluated against tenant-specific Cedar policies:

```cedar
// Example: Allow horizontal scaling up to 10 tasks
permit (
  principal in TenantAgents::"acme-corp",
  action == InfraAction::"scale_horizontal",
  resource in TenantResources::"acme-corp"
)
when {
  context.desiredCount <= 10 &&
  context.estimatedMonthlyCostDelta <= 500.0
};

// Deny all IAM modifications
forbid (
  principal in TenantAgents::"acme-corp",
  action == InfraAction::"modify_iam",
  resource
);
```

**Three authorization tiers:**
1. **ALLOW** → Auto-merge branch + trigger pipeline (low-risk, bounded changes)
2. **DENY + create PR** → Human approval required (medium-risk, cost >$100/month)
3. **DENY + block** → Operation rejected outright (high-risk, data loss possible)

### 2. Rate Limiting

Prevents runaway self-modification:
- **3 infrastructure changes per tenant per day** (DynamoDB token bucket)
- **5 prompt evolutions per week** (separate quota)
- **10 total evolution operations per day** (cross-category limit)

Quotas are stored in `chimera-rate-limits` DynamoDB table with 5-minute TTL:

```typescript
interface RateLimitEntry {
  tenantId: string;
  evolutionChangesToday: number;
  infraChangesToday: number;
  promptChangesThisWeek: number;
  lastResetDate: ISOTimestamp;
  ttl: number; // 5 minutes
}
```

### 3. Cost Guardrails

Each change proposal includes estimated monthly cost delta:

```typescript
estimateCostImpact(proposal: InfrastructureChangeProposal): number {
  const costEstimates: Record<IaCChangeType, number> = {
    scale_horizontal: 50,  // $50/month per additional ECS task
    scale_vertical: 30,    // $30/month for instance size upgrade
    add_tool: 10,          // $10/month for tool infrastructure
    update_env_var: 0,
    rotate_secret: 0,
    update_config: 0,
  };
  return costEstimates[proposal.changeType] || 0;
}
```

**Cost thresholds:**
- <$50/month → Auto-approve
- $50-$500/month → Requires PR approval
- >$500/month → Blocked (escalate to human)

### 4. Emergency Self-Heal Actions

Agents can execute **bounded emergency actions** without going through GitOps:

```typescript
type SelfHealAction =
  | 'restart_runtime'   // Restart ECS task (no IaC change)
  | 'clear_cache'       // Flush ElastiCache (no IaC change)
  | 'reset_session';    // Clear DynamoDB session state (no IaC change)
```

These bypass CodePipeline for **immediate remediation** during incidents (e.g., OOM crash, stuck session).

---

## Example: Agent-Provisioned Video Processing Pipeline

**User request:**
> "I need to process uploaded videos: generate thumbnails, extract audio, store metadata"

**Agent reasoning:**
1. Analyze requirements → Identify AWS services (S3, MediaConvert, Lambda, DynamoDB)
2. Check Cedar policy → Tenant allowed to provision <$200/month infrastructure
3. Generate CDK code:

```typescript
// Generated by InfrastructureModifier.generateCDKDiff()
const uploadBucket = new s3.Bucket(stack, 'VideoUploads', {
  bucketName: `chimera-video-uploads-${tenantId}`,
  encryption: s3.BucketEncryption.KMS_MANAGED,
  lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
});

const metadataTable = new dynamodb.Table(stack, 'VideoMetadata', {
  partitionKey: { name: 'videoId', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
});

const processFunction = new lambda.Function(stack, 'VideoProcessor', {
  runtime: lambda.Runtime.PYTHON_3_12,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/video-processor'),
  environment: {
    METADATA_TABLE: metadataTable.tableName,
    MEDIACONVERT_ROLE: mediaConvertRole.roleArn,
  },
});

uploadBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3_notifications.LambdaDestination(processFunction)
);
```

4. Commit to CodeCommit → `evolution/acme-corp/add_tool-1710950400000`
5. Cedar evaluation → ALLOW (cost estimate: $120/month)
6. Auto-merge → Trigger CodePipeline
7. Canary deployment → 5% traffic → 30-min bake → Progressive rollout
8. User notified: *"Video processing pipeline deployed at `s3://chimera-video-uploads-acme-corp/`"*

---

## Comparison with Existing Solutions

| Solution | Infrastructure Capability | Safety Model | Multi-Tenancy | Audit Trail |
|----------|---------------------------|--------------|---------------|-------------|
| **Chimera** | ✅ Agents provision AWS resources | Cedar PBAC + rate limits + cost gates | Per-tenant repos + IAM isolation | Full Git history + audit DynamoDB |
| **AutoGPT** | ❌ Pre-provisioned Docker only | None (human manually reviews logs) | ❌ Single-user | None |
| **LangGraph Cloud** | ❌ Fixed infrastructure | API rate limits only | ✅ Namespace isolation | CloudWatch only |
| **Vertex AI Agent Builder** | ⚠️ Limited (Firestore, Cloud Run scale) | IAM only (no policy engine) | ✅ GCP project isolation | Cloud Audit Logs |
| **AWS CDK Pipelines** | ✅ Full IaC deployment | ❌ No AI-driven policies | ❌ Not multi-tenant | CloudTrail + CodePipeline logs |

**Chimera's differentiation:**
Combines **AI agent autonomy** with **enterprise-grade governance** via Cedar policies, making it the only solution where agents can safely self-modify production infrastructure.

---

## Research Documents

This capability is explored across three documents:

1. **[00-Infrastructure-Capability-Index.md](./00-Infrastructure-Capability-Index.md)** (this document)
   Overview, architecture, safety mechanisms, examples

2. **[01-CodeCommit-Agent-Workspace.md](./01-CodeCommit-Agent-Workspace.md)**
   CodeCommit as agent filesystem, branch strategies, pre-commit hooks, audit trails

3. **[02-CodePipeline-Autonomous-Deployment.md](./02-CodePipeline-Autonomous-Deployment.md)**
   CodePipeline orchestration, canary deployments, rollback automation, approval gates

---

## Open Questions

1. **Cedar policy versioning** — How do we roll out policy updates across 1000+ tenants without breaking existing agent workflows?
2. **Cost prediction accuracy** — CDK diff analysis only estimates; actual costs may vary 20-30%. Tolerable threshold?
3. **Dependency conflicts** — If Agent A provisions Lambda with Node 18 and Agent B needs Node 20, how do we resolve without human intervention?
4. **Rollback timing** — 30-minute canary bake is aggressive for large infrastruct changes (e.g., RDS schema migrations). Dynamic bake duration based on change risk?
5. **Cross-tenant resource sharing** — If two tenants need the same public dataset (e.g., GeoIP database in S3), should agents coordinate to share infrastructure?

---

## Next Steps

- [ ] Implement Cedar policy versioning with schema validation
- [ ] Add cost prediction confidence intervals to UI
- [ ] Research agent negotiation protocols for dependency conflicts
- [ ] Prototype risk-based canary bake duration (5min for env var, 60min for database change)
- [ ] Design shared resource registry for cross-tenant optimization

---

**See also:**
- `packages/core/src/evolution/iac-modifier.ts` — Implementation
- `packages/core/src/evolution/safety-harness.ts` — Cedar + rate limits
- `infra/lib/pipeline-stack.ts` — CodePipeline + Step Functions orchestration
- `docs/architecture/canonical-data-model.md` — DynamoDB audit schema
