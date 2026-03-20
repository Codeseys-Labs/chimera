# Chimera Deployment Runbook

> Quick reference for deploying Chimera components to production

**Last Updated:** 2026-03-20
**Audience:** DevOps engineers, SREs, platform team

---

## Deployment Strategies

| Component | Strategy | Rollback Time | Risk Level |
|-----------|----------|---------------|------------|
| Agent runtime code | Canary (5% → 25% → 100%) | <1 minute | Low |
| CDK infrastructure | Blue-green with CFN rollback | <10 minutes | Medium |
| Chat SDK (ECS) | Rolling update (50% min healthy) | <5 minutes | Low |
| Cedar policies | Git-versioned, instant reload | <1 minute | Low |
| Tenant config | DynamoDB update | Instant | Low |
| Skill registry | S3 + DDB metadata | <60 seconds | Low |

---

## Pre-Deployment Checklist

Run this **every time** before deploying:

```bash
# 1. Review changes
npx cdk diff --all

# 2. Security validation
npx cdk-nag

# 3. Cost estimate
npx infracost breakdown --path .

# 4. Verify tests pass
bun test
bun run lint
bun run typecheck

# 5. Review CloudFormation changeset in console

# 6. Notify on-call
# Post in #chimera-ops: "Deploying [component] at [time]"
```

**Go/No-Go Decision:**

- ✅ All tests green
- ✅ CDK Nag clean (no security findings)
- ✅ No unexpected IAM permission changes
- ✅ Not during peak hours (12:00-18:00 UTC)
- ✅ On-call engineer aware
- ✅ Rollback procedure ready

---

## Agent Runtime Deployment

**Pipeline:** CodePipeline 5-stage canary deployment

```
┌─────────────────────────────────────────────┐
│ Stage 1: Build                              │
│   - Docker image → ECR: agent-runtime:{sha} │
│   - Unit + contract tests                   │
└──────────────┬──────────────────────────────┘
               │
               v
┌─────────────────────────────────────────────┐
│ Stage 2: Canary Deploy (5% traffic)         │
│   - 5-minute bake                           │
│   - Monitor: errors, p99, guardrails        │
└──────────────┬──────────────────────────────┘
               │
               v
┌─────────────────────────────────────────────┐
│ Stage 3: Evaluation                         │
│   - Run eval suite on canary                │
│   - Composite score must be ≥80             │
└──────────────┬──────────────────────────────┘
               │
               v
┌─────────────────────────────────────────────┐
│ Stage 4: Progressive Rollout                │
│   - 25% traffic for 15 min                  │
│   - 50% traffic for 15 min                  │
│   - 100% traffic                            │
└──────────────┬──────────────────────────────┘
               │
               v
┌─────────────────────────────────────────────┐
│ Stage 5: Post-Deploy Validation             │
│   - Synthetic canary (5-min interval)       │
│   - Cost anomaly detection (2 hours)        │
│   - Tag image as :latest-stable             │
└─────────────────────────────────────────────┘
```

### Auto-Rollback Triggers

| Metric | Threshold | Window | Action |
|--------|-----------|--------|--------|
| Error rate (canary) | >5% | 5 min | Auto-rollback |
| P99 latency (canary) | >2x baseline | 10 min | Auto-rollback |
| Guardrail trigger rate | >10% | 15 min | Auto-rollback |
| Evaluation score | <80 | Single eval | Block promotion |
| Cost per session | >3x baseline | 15 min | Alert + manual review |

### Manual Agent Runtime Deployment

```bash
# If you need to deploy manually (bypass pipeline)

# 1. Build and push image
docker build -t chimera-agent-runtime:$(git rev-parse --short HEAD) .
docker tag chimera-agent-runtime:$(git rev-parse --short HEAD) \
  123456789.dkr.ecr.us-west-2.amazonaws.com/chimera-agent-runtime:$(git rev-parse --short HEAD)
docker push 123456789.dkr.ecr.us-west-2.amazonaws.com/chimera-agent-runtime:$(git rev-parse --short HEAD)

# 2. Update canary endpoint
aws bedrock-agent-runtime update-agent-runtime-endpoint \
  --runtime-name chimera-pool \
  --endpoint-name canary \
  --agent-runtime-artifact "ecr://chimera-agent-runtime:$(git rev-parse --short HEAD)"

# 3. Monitor for 30 minutes before promoting to production
```

---

## CDK Infrastructure Deployment

### Stack Deployment Order

**CRITICAL:** Deploy stacks in this exact order to respect dependencies.

```
1. NetworkStack      (VPC, subnets, security groups)
    ↓
2. DataStack         (DynamoDB tables, S3, EFS)
    ↓
3. SecurityStack     (Cognito, IAM, KMS, Cedar)
    ↓
4. ObservabilityStack (CloudWatch, X-Ray, alarms)
    ↓
5. PlatformRuntimeStack (AgentCore, Memory)
    ↓
6. ChatStack         (ECS Fargate, API Gateway)
    ↓
7. TenantStacks      (Per-tenant resources)
```

### Deployment Commands

```bash
# Deploy individual stack
npx cdk deploy Chimera-prod-Network \
  --require-approval broadening \
  --rollback true \
  --change-set-name "deploy-$(date +%Y%m%d-%H%M%S)"

# Deploy all stacks in order
for stack in Network Data Security Observability Runtime Chat Tenant; do
  echo "Deploying Chimera-prod-$stack..."
  npx cdk deploy Chimera-prod-$stack \
    --require-approval broadening \
    --rollback true
done

# Monitor deployment progress
watch -n 5 'aws cloudformation describe-stacks \
  --stack-name Chimera-prod-Runtime \
  --query "Stacks[0].StackStatus"'
```

### Post-CDK Deployment Validation

```bash
# 1. Verify all stacks deployed successfully
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?starts_with(StackName, `Chimera-prod`)].{Name:StackName,Status:StackStatus}' \
  --output table

# 2. Verify DynamoDB tables exist
aws dynamodb list-tables \
  --query 'TableNames[?starts_with(@, `chimera-`)]'

# 3. Verify ECS service running
aws ecs describe-services \
  --cluster chimera-chat \
  --services chat-sdk \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount}'

# 4. Run smoke tests
bun run test:smoke
```

---

## Chat SDK (ECS) Deployment

### Rolling Update

```bash
# Force new deployment with updated task definition
aws ecs update-service \
  --cluster chimera-chat \
  --service chat-sdk \
  --force-new-deployment

# Monitor rollout
watch -n 5 'aws ecs describe-services \
  --cluster chimera-chat \
  --services chat-sdk \
  --query "services[0].{Running:runningCount,Desired:desiredCount,Pending:pendingCount}"'
```

### Blue-Green Deployment (Zero Downtime)

```bash
# 1. Create new task definition revision
aws ecs register-task-definition \
  --cli-input-json file://task-def-new.json

# 2. Create temporary service with new task def
aws ecs create-service \
  --cluster chimera-chat \
  --service-name chat-sdk-green \
  --task-definition chimera-chat-sdk:NEW_REVISION \
  --desired-count 2 \
  --load-balancers file://lb-config.json

# 3. Wait for green service to be healthy (2-3 minutes)

# 4. Verify green service
curl https://api.chimera.example.com/health

# 5. Update ALB target group to point to green service
aws elbv2 modify-target-group \
  --target-group-arn <green-tg-arn>

# 6. Drain blue service
aws ecs update-service \
  --cluster chimera-chat \
  --service chat-sdk \
  --desired-count 0

# 7. After 5 minutes, delete blue service
aws ecs delete-service \
  --cluster chimera-chat \
  --service chat-sdk \
  --force
```

---

## Rollback Procedures

### Agent Runtime Rollback (<1 min)

```bash
# Revert canary to last stable image
aws bedrock-agent-runtime update-agent-runtime-endpoint \
  --runtime-name chimera-pool \
  --endpoint-name canary \
  --agent-runtime-artifact "ecr://chimera-agent-runtime:latest-stable"

# If production affected, revert production too
aws bedrock-agent-runtime update-agent-runtime-endpoint \
  --runtime-name chimera-pool \
  --endpoint-name production \
  --agent-runtime-artifact "ecr://chimera-agent-runtime:latest-stable"

# Verify rollback
aws bedrock-agent-runtime describe-agent-runtime-endpoint \
  --runtime-name chimera-pool \
  --endpoint-name production
```

### CDK Stack Rollback (<10 min)

```bash
# Automatic rollback (happens on stack update failure)
# CloudFormation will auto-rollback if --rollback true was set

# Manual rollback to previous version
aws cloudformation rollback-stack \
  --stack-name Chimera-prod-Runtime \
  --client-request-token "rollback-$(date +%s)"

# Monitor rollback progress
aws cloudformation describe-stack-events \
  --stack-name Chimera-prod-Runtime \
  --max-items 20 \
  --query 'StackEvents[].{Time:Timestamp,Status:ResourceStatus,Reason:ResourceStatusReason}' \
  --output table
```

### Chat SDK Rollback (<5 min)

```bash
# Get previous task definition revision
PREVIOUS_REV=$(aws ecs describe-services \
  --cluster chimera-chat \
  --services chat-sdk \
  --query 'services[0].taskDefinition' \
  --output text | sed 's/:.*$//')
PREVIOUS_REV="$PREVIOUS_REV:$(($(echo $PREVIOUS_REV | cut -d: -f2) - 1))"

# Force rollback to previous revision
aws ecs update-service \
  --cluster chimera-chat \
  --service chat-sdk \
  --task-definition "$PREVIOUS_REV" \
  --force-new-deployment
```

### Cedar Policy Rollback (<1 min)

```bash
# Policies are Git-versioned; rollback via Git
cd infra/cedar-policies/
git log --oneline | head -5  # Find last good commit

# Revert to previous version
git checkout <previous-commit-sha> -- policies/

# Redeploy policies
aws s3 sync policies/ s3://chimera-cedar-policies-prod/ \
  --delete

# Policies hot-reload automatically (no restart needed)
```

---

## Post-Deployment Validation

Run these checks **immediately** after any deployment:

```bash
#!/bin/bash
# post-deploy-validation.sh

echo "=== Post-Deployment Validation ==="
echo ""

# 1. Check all alarms are OK
echo "--- CloudWatch Alarms ---"
ALARMS=$(aws cloudwatch describe-alarms \
  --alarm-name-prefix "Chimera" \
  --state-value ALARM \
  --query 'length(MetricAlarms)')
echo "Active alarms: $ALARMS (expect 0)"

# 2. Check error rate
echo ""
echo "--- Error Rate (last 5 min) ---"
aws cloudwatch get-metric-statistics \
  --namespace AgentPlatform \
  --metric-name Errors \
  --start-time "$(date -u -v-5M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum \
  --query 'Datapoints[0].Sum'

# 3. Check P99 latency
echo ""
echo "--- P99 Latency (last 5 min) ---"
aws cloudwatch get-metric-statistics \
  --namespace AgentPlatform \
  --metric-name InvocationDuration \
  --start-time "$(date -u -v-5M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics 'p99' \
  --query 'Datapoints[0].ExtendedStatistics."p99"'

# 4. Run synthetic test
echo ""
echo "--- Synthetic Canary Test ---"
curl -s -X POST https://api.chimera.example.com/v1/chat \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","tenant_id":"test"}' | jq '.response'

# 5. Check ECS health
echo ""
echo "--- ECS Service Health ---"
aws ecs describe-services \
  --cluster chimera-chat \
  --services chat-sdk \
  --query 'services[0].{Running:runningCount,Desired:desiredCount}' \
  --output table

echo ""
echo "=== Validation Complete ==="
```

**Expected Results:**

- ✅ 0 active alarms
- ✅ Error count <5 in last 5 minutes
- ✅ P99 latency <30 seconds
- ✅ Synthetic test returns valid response
- ✅ ECS running count = desired count

---

## Emergency Deployment

If there's a **critical security fix** or **production-down scenario**:

```bash
# 1. Skip canary bake (DANGEROUS - use only in emergencies)
export CANARY_BAKE_MINUTES=5  # Reduce from 30 to 5

# 2. Deploy immediately
git tag emergency-$(date +%Y%m%d-%H%M%S)
git push --tags
# CodePipeline auto-triggers

# 3. Monitor closely
watch -n 10 './post-deploy-validation.sh'

# 4. Be ready to rollback
# Keep rollback commands ready in terminal
```

**Emergency Deployment Authorization:**

- SEV1 incident: No approval needed
- SEV2 incident: Platform lead approval
- Non-incident: **DO NOT USE**

---

## Troubleshooting

### Deployment Stuck

```bash
# Check CloudFormation stack events
aws cloudformation describe-stack-events \
  --stack-name Chimera-prod-Runtime \
  --max-items 20 \
  --output table

# Check if stuck on resource creation
aws cloudformation describe-stack-resources \
  --stack-name Chimera-prod-Runtime \
  --query 'StackResources[?ResourceStatus==`CREATE_IN_PROGRESS`]'
```

### Agent Runtime Not Starting

```bash
# Check ECS task logs
aws logs tail /chimera/prod/agent-runtime --follow

# Check ECR image exists
aws ecr describe-images \
  --repository-name chimera-agent-runtime \
  --image-ids imageTag=$(git rev-parse --short HEAD)
```

### Canary Pipeline Failed

```bash
# Get pipeline execution details
aws codepipeline get-pipeline-execution \
  --pipeline-name chimera-deploy \
  --pipeline-execution-id <execution-id>

# Check specific stage failure
aws codepipeline get-pipeline-state \
  --name chimera-deploy \
  --query 'stageStates[?latestExecution.status==`Failed`]'
```

---

## Maintenance Windows

| Task | Schedule | Impact |
|------|----------|--------|
| CDK stack updates | Tue/Thu 08:00-10:00 UTC | None (rolling) |
| Agent runtime deploy | Any time | None (canary) |
| Cedar policy updates | Any time | None (instant) |
| Emergency patches | Immediate | <5 min (canary bake) |

**Peak Hours (avoid deployments):**
- 12:00-18:00 UTC (US business hours)
- 21:00-03:00 UTC (Asia business hours)

---

## Related Documents

- [Incident Response Runbook](./incident-response.md)
- [Capacity Planning Runbook](./capacity-planning.md)
- [07-Operational-Runbook.md](../research/enhancement/07-Operational-Runbook.md) (comprehensive reference)
