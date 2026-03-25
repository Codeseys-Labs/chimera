# CodePipeline Autonomous Deployment: Canary Orchestration with Auto-Rollback

**Status:** Research
**Version:** 1.0
**Last Updated:** 2026-03-20
**Author:** builder-infra-plumbing
**Parent:** [00-Infrastructure-Capability-Index.md](./00-Infrastructure-Capability-Index.md)

---

## Overview

When agents commit infrastructure changes to CodeCommit, **CodePipeline automatically validates, tests, and deploys** the new configuration—no human intervention required for low-risk changes.

This document explores the **multi-stage deployment pipeline** that enables agents to safely deploy infrastructure with:
- **Fast feedback** — Build + unit tests complete in <8 minutes
- **Canary validation** — 5% traffic deployment with 30-minute bake period
- **Progressive rollout** — Gradual traffic shifting (25% → 50% → 100%) with health checks
- **Automatic rollback** — CloudWatch alarms trigger instant revert on failure

The pipeline implements the **deployment orchestration** pattern from Chimera's testing strategy (docs/research/enhancement/06-Testing-Strategy.md § 10.1).

---

## Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       CodeCommit Webhook                         │
│  Trigger: Push to main (agent fast-forward merge or human PR)   │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Stage 1: Source (1 min)                       │
│  • Fetch commit from CodeCommit                                 │
│  • Extract artifact: CDK code, Dockerfiles, configs             │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Stage 2: Build (6-8 min)                       │
│  1. Install dependencies (bun install)                          │
│  2. Lint + typecheck (bun run lint && bun run typecheck)        │
│  3. Unit tests (bun test --coverage)                            │
│  4. Contract tests (bun test:contract)                          │
│  5. CDK synth + cdk-nag validation                              │
│  6. Docker build + push to ECR                                  │
│                                                                  │
│  Output: Docker image URI (e.g., 123456789012.dkr.ecr.us-       │
│          east-1.amazonaws.com/chimera-agent-runtime:a3f7e2c)    │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              Stage 3: Deploy (60 min with monitoring)            │
│                                                                  │
│  Orchestration: Step Functions State Machine                    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────┐       │
│  │ 1. Deploy Canary (5% traffic)                       │       │
│  │    └─> Update Bedrock Agent Runtime endpoint        │       │
│  ├─────────────────────────────────────────────────────┤       │
│  │ 2. Wait 30 minutes (canary bake period)             │       │
│  ├─────────────────────────────────────────────────────┤       │
│  │ 3. Validate Canary Health                           │       │
│  │    • Error rate < 5%                                │       │
│  │    • P99 latency < 2x baseline                      │       │
│  │    • Guardrail rate < 10%                           │       │
│  │    • Evaluation score >= 80                         │       │
│  ├─────────────────────────────────────────────────────┤       │
│  │ 4a. If PASS: Progressive Rollout                    │       │
│  │     • 25% traffic (wait 15 min)                     │       │
│  │     • 50% traffic (wait 15 min)                     │       │
│  │     • 100% traffic (deployment complete)            │       │
│  │                                                      │       │
│  │ 4b. If FAIL: Auto-Rollback                          │       │
│  │     • Revert to previous stable image               │       │
│  │     • Route 100% traffic to production              │       │
│  │     • Trigger SNS alarm notification                │       │
│  └─────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Stage 1: Source (CodeCommit Integration)

### Webhook Trigger

CodePipeline listens for **push events** on the `main` branch:

```typescript
// infra/lib/pipeline-stack.ts (lines 523-536)
new codepipeline_actions.CodeStarConnectionsSourceAction({
  actionName: 'GitHub_Source',
  owner: repoOwner,
  repo: repoName,
  branch: 'main',
  output: sourceOutput,
  connectionArn: `arn:aws:codestar-connections:${region}:${account}:connection/...`,
  triggerOnPush: true,  // Webhook enabled
})
```

**Trigger scenarios:**
1. **Agent fast-forward merge** — Agent commits → Cedar ALLOW → Auto-merge → Pipeline starts
2. **Human PR merge** — Agent creates PR → Human approves → Manual merge → Pipeline starts
3. **Rollback commit** — Auto-rollback Lambda reverts commit → Pipeline redeploys previous state

**Artifact output:**
- Full repository snapshot at commit SHA
- Stored in S3 artifact bucket (versioned, encrypted, 30-day TTL)

---

## Stage 2: Build (Validation + Packaging)

The Build stage runs **six substages** in sequence (8 minutes max):

### 1. Install Dependencies (1 min)

```bash
bun install
```

**Cache enabled:** CodeBuild uses `DOCKER_LAYER` and `CUSTOM` cache modes to reuse dependencies across builds:

```yaml
cache:
  paths:
    - /root/.bun/install/cache/**/*
    - node_modules/**/*
```

**Benefit:** Cached builds complete in ~1 minute vs 3 minutes cold start.

### 2. Lint + Typecheck (1 min)

```bash
bun run lint        # ESLint (checks code style, unused imports)
bun run typecheck   # TypeScript compiler (type safety)
```

**Fail conditions:**
- ESLint errors (not warnings) → ❌ Build fails
- TypeScript errors → ❌ Build fails
- Unused imports → ⚠️ Warning only (doesn't fail build)

### 3. Unit Tests (2 min)

```bash
bun test --coverage
```

**Coverage requirements:**
- Line coverage: ≥80%
- Branch coverage: ≥75%
- Function coverage: ≥80%

**Test organization:**
```
tests/
├── unit/              # Fast, isolated tests (<1s each)
│   ├── iac-modifier.test.ts
│   ├── safety-harness.test.ts
│   └── cost-estimator.test.ts
├── integration/       # Multi-service tests (<5s each)
│   ├── codecommit-cedar.test.ts
│   └── pipeline-stepfunctions.test.ts
└── e2e/               # Full workflow tests (not run in CI)
```

**Unit test output:**
```
PASS  tests/unit/iac-modifier.test.ts
  InfrastructureModifier
    ✓ should auto-apply low-risk changes (34 ms)
    ✓ should create PR for high-cost changes (42 ms)
    ✓ should block dangerous operations (28 ms)

Test Suites: 12 passed, 12 total
Tests:       87 passed, 87 total
Coverage:    84.2% statements | 79.1% branches | 82.5% functions
```

### 4. Contract Tests (1 min)

Validates **API contracts** between services:

```bash
bun test:contract
```

**Example contract test:**

```typescript
// tests/contract/codecommit-cedar.test.ts
describe('InfrastructureModifier ↔ Cedar Policy Store', () => {
  it('should enforce cost threshold policy', async () => {
    const proposal: InfrastructureChangeProposal = {
      tenantId: 'test-tenant',
      changeType: 'scale_horizontal',
      estimatedMonthlyCostDelta: 600, // Above $500 threshold
    };

    const result = await modifier.proposeInfrastructureChange(proposal);

    expect(result.status).toBe('pr_created');  // Not auto-applied
    expect(result.cedarDecision).toBe('DENY');
  });
});
```

**Contract validation:**
- Cedar policy schema matches TypeScript types
- DynamoDB table schema matches TypeScript interfaces
- CodeCommit branch names follow `evolution/{tenant}/{type}-{timestamp}` convention

### 5. CDK Synth + Security Scan (2 min)

```bash
cd infra
npx cdk synth --all    # Generate CloudFormation templates
npx cdk-nag            # Security best practices scan
```

**cdk-nag rules enforced:**
- AwsSolutions-S3-1: S3 buckets must have server-side encryption
- AwsSolutions-IAM-4: IAM policies must not have wildcard actions
- AwsSolutions-DDB-3: DynamoDB tables must have point-in-time recovery
- AwsSolutions-L1: Lambda functions must use latest runtime version

**Blocking errors:**

```
[Error at /ChimeraDataStack/TenantBucket] AwsSolutions-S3-1:
  The S3 Bucket does not have server-side encryption enabled.
  Fix: Add 'encryption: s3.BucketEncryption.S3_MANAGED' to bucket props.
```

### 6. Docker Build + Push (2 min)

```bash
IMAGE_TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}  # Git SHA short
docker build -t $ECR_REPOSITORY:$IMAGE_TAG -f agent-code/Dockerfile agent-code/
docker push $ECR_REPOSITORY:$IMAGE_TAG
docker push $ECR_REPOSITORY:latest
```

**Multi-stage Dockerfile optimization:**

```dockerfile
# Stage 1: Build dependencies
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# Stage 2: Runtime image
FROM gcr.io/distroless/base-debian12 AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/dist ./dist
USER nonroot:nonroot
ENTRYPOINT ["/bin/node", "dist/index.js"]
```

**Benefits:**
- ✅ No build tools in runtime image (smaller size, fewer CVEs)
- ✅ Runs as non-root user (security)
- ✅ Distroless base (no shell, no package manager)

**Output artifact:**
- Docker image URI written to `image-uri.txt`
- Passed to Deploy stage via CodePipeline artifact

---

## Stage 3: Deploy (Canary Orchestration)

The Deploy stage uses **Step Functions** to orchestrate progressive rollout with automatic rollback.

### State Machine Definition

```typescript
// infra/lib/pipeline-stack.ts (lines 479-486)
const definition = deployCanaryTask
  .next(waitCanaryBake)
  .next(validateCanaryTask)
  .next(checkCanaryHealth);

rollout25Task.next(wait25Percent).next(rollout50Task);
rollout50Task.next(wait50Percent).next(rollout100Task);
rollout100Task.next(deploymentSuccess);
```

**Visualization:**

```
DeployCanary (Lambda)
    ↓
WaitCanaryBake (30 min)
    ↓
ValidateCanary (Lambda)
    ↓
CheckCanaryHealth (Choice)
    ├─ FAIL → RollbackDeployment (Lambda) → DeploymentFailed
    └─ PASS → Rollout25% (Lambda)
                  ↓
              Wait (15 min)
                  ↓
              Rollout50% (Lambda)
                  ↓
              Wait (15 min)
                  ↓
              Rollout100% (Lambda)
                  ↓
              DeploymentSuccess
```

### Lambda: Deploy Canary (5% Traffic)

```python
# Lambda: chimera-deploy-canary
def handler(event, context):
    image_uri = event['imageUri']

    # Update Bedrock Agent Runtime endpoint
    bedrock_agent_runtime.update_agent_runtime_endpoint(
        runtimeName='chimera-pool',
        endpointName='canary',
        agentRuntimeArtifact=image_uri,
        trafficAllocation={'canary': 5, 'production': 95}
    )

    return {
        'status': 'CANARY_DEPLOYED',
        'imageUri': image_uri,
        'trafficAllocation': {'canary': 5, 'production': 95},
        'deployedAt': context.aws_request_id
    }
```

**Traffic routing:**
- **5% of requests** → Canary endpoint (new Docker image)
- **95% of requests** → Production endpoint (current stable image)

**Selection algorithm:** Weighted random based on session ID hash (consistent routing per user).

### Wait State: 30-Minute Canary Bake

```typescript
const waitCanaryBake = new stepfunctions.Wait(this, 'WaitCanaryBake', {
  time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(30)),
});
```

**Why 30 minutes?**
- Accumulate **statistically significant** error rate data (>100 requests)
- Allow CloudWatch alarms to fire (5 datapoints over 5 minutes)
- Surface subtle regressions (e.g., memory leaks, connection pool exhaustion)

**Monitoring during bake:**
CloudWatch alarms evaluate metrics every 5 minutes:

| Metric | Threshold | Evaluation Window | Alarm Action |
|--------|-----------|-------------------|--------------|
| Error rate | >5% | 5 minutes | Trigger rollback |
| P99 latency | >60 seconds | 10 minutes | Trigger rollback |
| Guardrail rate | >10% | 15 minutes | Trigger rollback |
| Memory usage | >90% | 5 minutes | Warning (no rollback) |

### Lambda: Validate Canary Health

```python
# Lambda: chimera-canary-validation
def handler(event, context):
    canary_endpoint = event['canaryEndpoint']

    # Query CloudWatch metrics for canary endpoint
    error_rate = get_error_rate(canary_endpoint, period_minutes=30)
    p99_latency = get_p99_latency(canary_endpoint, period_minutes=30)
    guardrail_rate = get_guardrail_rate(canary_endpoint, period_minutes=30)
    eval_score = get_evaluation_score(canary_endpoint, period_minutes=30)

    # Validation thresholds
    passed = (
        error_rate < 5.0 and
        p99_latency < 60000 and  # 60 seconds
        guardrail_rate < 10.0 and
        eval_score >= 80
    )

    return {
        'status': 'PASS' if passed else 'FAIL',
        'metrics': {
            'errorRate': error_rate,
            'p99Latency': p99_latency,
            'guardrailRate': guardrail_rate,
            'evalScore': eval_score
        },
        'recommendation': 'PROMOTE' if passed else 'ROLLBACK'
    }
```

**Composite evaluation score formula:**

```python
eval_score = (
    0.40 * task_completion_rate +    # Did agent finish user's task?
    0.30 * (1 - error_rate) +        # No errors during execution?
    0.20 * cost_efficiency +         # Cost <= baseline?
    0.10 * (1 - guardrail_rate)      # No policy violations?
) * 100
```

**Example:**
- Task completion: 95% → 0.40 × 0.95 = 0.38
- Error rate: 2% → 0.30 × 0.98 = 0.294
- Cost efficiency: 90% of baseline → 0.20 × 0.90 = 0.18
- Guardrail rate: 5% → 0.10 × 0.95 = 0.095

**Total:** 0.38 + 0.294 + 0.18 + 0.095 = **0.949 × 100 = 94.9** ✅ PASS

### Choice State: Check Canary Health

```typescript
const checkCanaryHealth = new stepfunctions.Choice(this, 'CheckCanaryHealth')
  .when(
    stepfunctions.Condition.stringEquals('$.status', 'FAIL'),
    rollbackTask.next(deploymentFailed)
  )
  .otherwise(rollout25Task);
```

**Branching logic:**
- `status === 'FAIL'` → Execute rollback Lambda → Deployment failed
- `status === 'PASS'` → Proceed to 25% rollout

### Lambda: Progressive Rollout (25%, 50%, 100%)

```python
# Lambda: chimera-progressive-rollout
def handler(event, context):
    target_percentage = event['targetPercentage']
    image_uri = event['imageUri']

    # Update traffic allocation
    bedrock_agent_runtime.update_agent_runtime_endpoint(
        runtimeName='chimera-pool',
        endpointName='canary',
        trafficAllocation={
            'canary': target_percentage,
            'production': 100 - target_percentage
        }
    )

    return {
        'status': 'ROLLOUT_COMPLETE',
        'trafficAllocation': {
            'canary': target_percentage,
            'production': 100 - target_percentage
        },
        'targetPercentage': target_percentage
    }
```

**Traffic shift schedule:**

| Time | Canary % | Production % | Wait Duration | Health Check |
|------|----------|--------------|---------------|--------------|
| T+0  | 5%       | 95%          | 30 min        | Full validation |
| T+30 | 25%      | 75%          | 15 min        | Error rate only |
| T+45 | 50%      | 50%          | 15 min        | Error rate only |
| T+60 | 100%     | 0%           | —             | Post-deploy monitoring |

**Why progressive?**
- Minimize blast radius (25% failure affects fewer users than 100% failure)
- Detect performance degradation under increasing load (25% may pass, 50% may fail)
- Allow gradual resource scaling (ECS tasks, Lambda concurrency)

### Lambda: Auto-Rollback

```python
# Lambda: chimera-rollback
def handler(event, context):
    # Revert to previous stable image (:latest-stable tag)
    bedrock_agent_runtime.update_agent_runtime_endpoint(
        runtimeName='chimera-pool',
        endpointName='canary',
        agentRuntimeArtifact=f'{ECR_REPOSITORY}:latest-stable',
        trafficAllocation={'canary': 0, 'production': 100}
    )

    # Revert Git commit in CodeCommit
    codecommit.create_branch(
        branchName=f'rollback/{failed_commit_sha[:8]}-{int(time.time())}',
        commitId=previous_stable_commit
    )
    codecommit.merge_branches(source=rollback_branch, destination='main')

    # Send SNS notification
    sns.publish(
        TopicArn=ALARM_TOPIC_ARN,
        Subject='[SEV2] Chimera Canary Deployment Failed - Auto-Rollback Executed',
        Message=f'Deployment of {failed_commit_sha} failed validation.\n\n'
                f'Metrics:\n{json.dumps(failed_metrics, indent=2)}\n\n'
                f'Rolled back to: {previous_stable_commit}'
    )

    return {
        'status': 'ROLLBACK_COMPLETE',
        'rolledBackAt': context.aws_request_id,
        'trafficAllocation': {'canary': 0, 'production': 100}
    }
```

**Rollback triggers:**
1. **Canary validation fails** (error rate, latency, eval score)
2. **CloudWatch alarm fires** during bake period
3. **Progressive rollout stage fails** (50% traffic → error spike)

**Rollback duration:** <5 minutes (no canary bake for rollbacks)

---

## CloudWatch Alarms for Auto-Rollback

The pipeline configures **real-time alarms** that trigger rollback without waiting for 30-minute bake:

### 1. Error Rate Alarm (SEV2)

```typescript
const errorRateAlarm = new cloudwatch.Alarm(this, 'ErrorRateAlarm', {
  alarmName: `Chimera-Pipeline-ErrorRate-${envName}`,
  metric: new cloudwatch.Metric({
    namespace: 'AgentPlatform',
    metricName: 'Errors',
    statistic: 'Sum',
    period: cdk.Duration.minutes(5),
  }),
  threshold: 50,  // 50 errors in 5 minutes (~1 error/6 seconds)
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
});

errorRateAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));
```

**How it works:**
1. Canary endpoint emits `Errors` metric to CloudWatch
2. Alarm evaluates metric every 5 minutes
3. If threshold exceeded → SNS notification → EventBridge rule → Lambda stops Step Functions execution → Triggers rollback

**Threshold rationale:**
- 50 errors in 5 minutes = 0.167 errors/second
- At 100 requests/second → 0.167% error rate (acceptable)
- At 10 requests/second → 1.67% error rate (concerning)
- Scales with traffic volume

### 2. Latency Alarm (SEV2)

```typescript
const latencyAlarm = new cloudwatch.Alarm(this, 'LatencyAlarm', {
  alarmName: `Chimera-Pipeline-Latency-${envName}`,
  metric: new cloudwatch.Metric({
    namespace: 'AgentPlatform',
    metricName: 'InvocationDuration',
    statistic: 'p99',
    period: cdk.Duration.minutes(5),
  }),
  threshold: 60000,  // 60 seconds
  evaluationPeriods: 2,  // 2 consecutive periods (10 minutes total)
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
});
```

**Why P99 instead of average?**
- Average hides tail latency (99% fast, 1% very slow → looks fine on average)
- P99 catches regressions affecting a minority of users
- Agents often have bimodal latency (simple queries fast, complex workflows slow)

**Why 2 evaluation periods?**
- Single spike may be transient (cold start, AWS API throttle)
- Sustained high latency indicates systemic issue (memory leak, connection pool exhaustion)

### 3. Guardrail Alarm (SEV3)

```typescript
const guardrailAlarm = new cloudwatch.Alarm(this, 'GuardrailAlarm', {
  alarmName: `Chimera-Pipeline-Guardrails-${envName}`,
  metric: new cloudwatch.Metric({
    namespace: 'AgentPlatform',
    metricName: 'GuardrailTriggers',
    statistic: 'Sum',
    period: cdk.Duration.minutes(5),
  }),
  threshold: 10,  // 10 guardrail blocks in 5 minutes
  evaluationPeriods: 3,  // 15 minutes total
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
});
```

**Guardrail examples:**
- Agent attempts to provision $10,000/month infrastructure (cost guardrail)
- Agent tries to delete DynamoDB table (dangerous operation block)
- Agent generates code with SQL injection vulnerability (security guardrail)

**Why lower severity?**
Guardrails prevent harm—high trigger rate is annoying but not service-impacting.

---

## Approval Gates for High-Risk Changes

Some changes require **manual approval** before deployment proceeds.

### Scenario: Cost Delta >$500/month

When Cedar policy denies auto-merge and creates a PR:

```typescript
const pr = await codecommit.send(new CreatePullRequestCommand({
  title: `[Evolution] Scale OpenSearch cluster to 10 nodes`,
  description: `
**Tenant:** acme-corp
**Change type:** scale_horizontal
**Cedar decision:** DENY (requires human approval)
**Estimated cost impact:** $800/month

### Generated CDK Diff
\`\`\`diff
- desiredCount: 3
+ desiredCount: 10
\`\`\`

**Justification:** User reported slow search queries during peak hours.
Agent detected P95 latency >5 seconds and recommends horizontal scaling.

**Reviewer action:** Verify tenant has budget for $800/month increase.
  `,
  targets: [{ sourceReference: branchName, destinationReference: 'main' }],
}));
```

**Review workflow:**
1. PR created → Slack notification to #infra-approvals channel
2. Human reviewer checks:
   - Is cost estimate reasonable? (verify CDK diff matches Pricing Calculator)
   - Is tenant within quota? (query billing DynamoDB table)
   - Is this necessary? (check CloudWatch metrics for actual latency)
3. Reviewer approves → PR merged → CodePipeline triggered
4. Canary deployment proceeds as normal (with approval audit trail)

### Manual Approval Stage (Optional)

For very high-risk changes, insert **CodePipeline manual approval action**:

```typescript
{
  stageName: 'Approval',
  actions: [
    new codepipeline_actions.ManualApprovalAction({
      actionName: 'Human_Review_Required',
      notificationTopic: approvalTopic,
      additionalInformation: `
Review infrastructure change before deploying to production.
- Commit: #{SourceOutput.CommitId}
- Author: #{SourceOutput.AuthorName}
- Change type: #{BuildOutput.change-type.txt}
      `,
    }),
  ],
}
```

**Use cases:**
- First deployment of new tenant infrastructure
- Changes to shared VPC or security groups
- Multi-region failover configuration updates

---

## Rollback Strategies

Three rollback mechanisms exist based on failure timing:

### 1. Pre-Deployment Rollback (Build Failure)

If Stage 2 (Build) fails, **no deployment occurs**:

```
Build Stage: Unit tests failed (12 failing, 87 passing)
→ Pipeline stops
→ No Docker image pushed
→ SNS notification sent
→ Agent receives error response
```

**Agent response:**
```json
{
  "status": "build_failed",
  "reason": "Unit tests failed: InfrastructureModifier.proposeInfrastructureChange",
  "failedTests": [
    "should enforce cost threshold policy",
    "should block dangerous operations"
  ],
  "recommendation": "Fix failing tests before retrying"
}
```

### 2. Canary Rollback (Deployment Failure)

If canary validation fails, **automatic rollback** executes:

```python
# Step Functions invokes rollback Lambda
rollback_lambda.invoke(Payload={
    'failedCommitId': 'a3f7e2c',
    'reason': 'Canary validation failed: error rate 7.2% > 5% threshold',
    'metrics': {
        'errorRate': 7.2,
        'p99Latency': 42000,
        'evalScore': 72
    }
})

# Rollback Lambda reverts infrastructure
codecommit.create_branch('rollback/a3f7e2c-1710950400', previous_stable_commit)
codecommit.merge_branches('rollback/a3f7e2c-1710950400', 'main')

# Update agent runtime endpoint to previous image
bedrock_agent_runtime.update_agent_runtime_endpoint(
    agentRuntimeArtifact=f'{ECR_REPOSITORY}:latest-stable',
    trafficAllocation={'canary': 0, 'production': 100}
)
```

**Duration:** <5 minutes (no bake period for rollbacks)

### 3. Post-Deployment Rollback (Manual)

If issues surface **after full deployment** (e.g., 24 hours later):

```bash
# Operations team initiates rollback via API
curl -X POST https://api.chimera.aws/v1/evolution/rollback \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "tenantId": "acme-corp",
    "commitId": "a3f7e2c",
    "reason": "Users reporting intermittent 502 errors"
  }'
```

**Rollback API handler:**
1. Verify commit belongs to tenant (scope check)
2. Find previous stable commit: `git log --grep 'status: auto_applied' --before a3f7e2c -1`
3. Create rollback branch with `git revert`
4. Auto-merge (rollbacks bypass Cedar for emergency)
5. Trigger CodePipeline with `--priority emergency` (skip canary, deploy immediately)

**Duration:** <10 minutes (emergency fast-track deployment)

---

## Cost Analysis

### Infrastructure Costs (per pipeline)

| Resource | Configuration | Monthly Cost |
|----------|--------------|--------------|
| CodePipeline | Standard pipeline, ~200 executions/month | $1.00 |
| CodeBuild | Medium instance (4 vCPU, 7 GB RAM), 8 min/build | $8.00 |
| S3 Artifact Bucket | 10 GB storage, 30-day TTL | $0.23 |
| Step Functions | 200 executions × 4 state transitions | $0.10 |
| Lambda (Deploy + Validate) | 400 invocations × 256 MB × 30s avg | $0.05 |
| CloudWatch Logs | 5 GB ingested, 7-day retention | $2.50 |
| CloudWatch Alarms | 3 alarms × $0.10/alarm | $0.30 |
| ECR Storage | 50 images × 500 MB average | $2.50 |
| **Total** | | **$14.68/month** |

**Cost per deployment:** $0.07

**Multi-tenant scaling:**
- 100 tenants → 100 pipelines → $1,468/month
- Optimization: Single pipeline with dynamic CDK synthesis (per-tenant stacks)
- Optimized cost: $14.68 + ($0.50 × 100 tenants) = $64.68/month

### Deployment Velocity

| Metric | Value |
|--------|-------|
| Time to canary | 9 minutes (1 min source + 8 min build) |
| Time to 25% | 39 minutes (9 + 30 min bake) |
| Time to 100% | 69 minutes (39 + 15 + 15 min rollout) |
| Rollback time | <5 minutes (emergency fast-track) |
| Daily capacity | 20 deployments (assuming 1-hour average) |

**Bottleneck:** Canary bake period (30 minutes)

**Optimization strategies:**
1. **Risk-based bake duration:** Low-risk changes (env var) → 5 min bake, High-risk (DB schema) → 60 min bake
2. **Parallel tenant deployments:** Deploy 10 tenants concurrently (shared Step Functions, isolated endpoints)
3. **Blue-green instead of canary:** For off-peak hours, skip canary (instant cutover)

---

## Comparison with Other Deployment Strategies

| Strategy | Chimera (Canary) | Blue-Green | Rolling Update | Recreate |
|----------|------------------|------------|----------------|----------|
| **Downtime** | 0 seconds | 0 seconds | 0 seconds | 30-60 seconds |
| **Rollback speed** | <5 min | Instant (DNS flip) | 10-20 min | Must redeploy |
| **Risk** | Very low (5% blast radius) | Low (50% capacity during transition) | Medium (partial fleet at risk) | High (100% down) |
| **Cost** | Medium (dual endpoints) | Medium (2× resources during cutover) | Low (rolling in-place) | Low (single resource set) |
| **Validation** | 30-min bake + progressive rollout | Manual testing window | No validation gate | No validation gate |
| **Best for** | Production SaaS (multi-tenant) | Stateless apps | Kubernetes clusters | Development/staging |

**Chimera advantages:**
- ✅ Automatic rollback (no human needed)
- ✅ Progressive risk (5% → 25% → 50% → 100%)
- ✅ CloudWatch alarm integration (real-time monitoring)

**Trade-offs:**
- ⚠️ Slower deployment (69 min vs <5 min blue-green)
- ⚠️ More complex orchestration (Step Functions + multiple Lambdas)

---

## Future Enhancements

### 1. Dynamic Bake Duration

Adjust canary bake period based on **change risk score**:

```python
risk_score = (
    change_type_risk[proposal.changeType] +  # 0-10 scale
    0.1 * proposal.estimatedMonthlyCostDelta +
    (5 if modifies_shared_resources else 0)
)

bake_duration_minutes = min(max(risk_score * 5, 5), 120)
```

**Examples:**
- Update env var (risk=2) → 10 min bake
- Scale ECS tasks (risk=5) → 25 min bake
- Modify VPC security group (risk=10) → 60 min bake

### 2. Multi-Region Canary

Deploy canary to **single AWS region** first, then roll out globally:

```
Deploy us-east-1 canary (5%) → 30 min bake
  ↓ PASS
Deploy eu-west-1 canary (5%) → 15 min bake
  ↓ PASS
Deploy ap-southeast-1 canary (5%) → 15 min bake
  ↓ PASS
Global rollout: all regions 100%
```

**Benefit:** Detect region-specific issues (e.g., API throttling, availability zone failures).

### 3. AI-Powered Anomaly Detection

Replace fixed thresholds with **ML-based anomaly detection**:

```python
# Train model on 30 days of baseline metrics
baseline_model = train_anomaly_detector(metrics_history)

# During canary bake, detect statistical anomalies
anomalies = baseline_model.detect_anomalies(canary_metrics)

if anomalies['error_rate'].score > 0.8:  # High confidence anomaly
    trigger_rollback()
```

**Benefit:** Catches subtle regressions that fixed thresholds miss (e.g., error rate increases from 0.1% → 0.5%, still <5% threshold but 5× baseline).

---

## Conclusion

CodePipeline autonomous deployment enables **agent-driven infrastructure** with:
- **Fast feedback** — Build + test in <8 minutes
- **Safe rollout** — 5% canary → 25% → 50% → 100% with health gates
- **Automatic rollback** — CloudWatch alarms trigger instant revert
- **Audit trail** — Full deployment history in CodePipeline + CloudWatch

This pattern makes Chimera the **only agent platform where AI can safely deploy infrastructure changes** without human oversight for low-risk operations.

---

**See also:**
- [00-Infrastructure-Capability-Index.md](./00-Infrastructure-Capability-Index.md) — Overview
- [01-CodeCommit-Agent-Workspace.md](./01-CodeCommit-Agent-Workspace.md) — Git workflow
- `infra/lib/pipeline-stack.ts` — Implementation (lines 1-640)
- AWS CodePipeline User Guide: https://docs.aws.amazon.com/codepipeline/
- AWS Step Functions Developer Guide: https://docs.aws.amazon.com/step-functions/
