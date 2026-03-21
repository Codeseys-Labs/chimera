# Deployment Guide

> **Audience:** Platform operators deploying Chimera infrastructure
> **Estimated Time:** 2-4 hours for full deployment
> **Prerequisites:** AWS admin access, CDK experience

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Setup](#environment-setup)
3. [Stack Deployment](#stack-deployment)
4. [Verification](#verification)
5. [Pipeline Setup](#pipeline-setup)
6. [Monitoring](#monitoring)
7. [Troubleshooting](#troubleshooting)
8. [Appendix](#appendix)

---

## Prerequisites

### AWS Account Requirements

**Required AWS account setup:**

- AWS account with **AdministratorAccess** or equivalent
- Account must be part of AWS Organization (for multi-account deployment)
- Service quotas increased for production workloads:
  - VPC Elastic IPs: minimum 5 per region
  - EC2 On-Demand instances: minimum 10 vCPUs
  - DynamoDB tables: minimum 20 per region
  - S3 buckets: minimum 10 per region
  - Bedrock AgentCore Runtimes: minimum 2 per region
  - CloudWatch log groups: minimum 50 per region

**Request quota increases:**

```bash
# Check current quotas
aws service-quotas list-service-quotas \
  --service-code dynamodb \
  --query 'Quotas[?QuotaName==`Table count`]'

# Request increase
aws service-quotas request-service-quota-increase \
  --service-code dynamodb \
  --quota-code L-F98FE922 \
  --desired-value 20
```

### Development Tools

Install required tools:

**Required versions:**

- **AWS CLI:** v2.15+ ([install guide](https://aws.amazon.com/cli/))
- **Node.js:** 20.x LTS ([install via mise](https://mise.jdx.dev/))
- **Bun:** 1.0.30+ ([install guide](https://bun.sh/docs/installation))
- **mise:** 2024.1+ ([install guide](https://mise.jdx.dev/getting-started.html))
- **AWS CDK CLI:** 2.120+ (`npm install -g aws-cdk`)
- **Docker:** 24+ (for CDK asset bundling)

**Quick install:**

```bash
# Install mise (version manager)
curl https://mise.run | sh

# Install project tools
cd chimera
mise install

# Verify installations
node --version    # Should be 20.x
bun --version     # Should be 1.0.30+
cdk --version     # Should be 2.120+
docker --version  # Should be 24+
```

---

## Environment Setup

### Clone and Configure

```bash
# Clone repository
git clone https://github.com/your-org/chimera.git
cd chimera

# Install dependencies
mise install           # Install tooling
bun install           # Install npm packages

# Navigate to infrastructure
cd infra
```

### Environment Variables

Set required environment variables for your target environment:

```bash
# Required variables
export CDK_DEFAULT_ACCOUNT="123456789012"
export CDK_DEFAULT_REGION="us-west-2"
export ENVIRONMENT="dev"  # dev, staging, or prod

# Optional: custom domain
export DOMAIN_NAME="agent.example.com"

# Optional: GitHub connection ARN (for pipeline)
export GITHUB_CONNECTION_ARN="arn:aws:codestar-connections:us-west-2:..."
```

**Recommended:** Store these in `.env.local`:

```bash
# infra/.env.local
CDK_DEFAULT_ACCOUNT=123456789012
CDK_DEFAULT_REGION=us-west-2
ENVIRONMENT=dev
DOMAIN_NAME=agent.example.com
```

Then source before deploying:

```bash
source .env.local
```

### Bootstrap CDK

First-time setup per account/region:

```bash
# Bootstrap CDK in target account/region
cdk bootstrap aws://${CDK_DEFAULT_ACCOUNT}/${CDK_DEFAULT_REGION}

# For multi-account pipeline (optional)
cdk bootstrap aws://<dev-account>/us-west-2 \
  --trust <pipeline-account> \
  --cloudformation-execution-policies "arn:aws:iam::aws:policy/AdministratorAccess"

cdk bootstrap aws://<staging-account>/us-west-2 \
  --trust <pipeline-account> \
  --cloudformation-execution-policies "arn:aws:iam::aws:policy/AdministratorAccess"

cdk bootstrap aws://<prod-account>/us-west-2 \
  --trust <pipeline-account> \
  --cloudformation-execution-policies "arn:aws:iam::aws:policy/AdministratorAccess"
```

---

## Stack Deployment

### Deployment Order

Chimera uses an **11-stack architecture** with explicit dependencies. Deploy in this order:

```
1. NetworkStack           (VPC, subnets, NAT gateways, VPC endpoints, security groups)
2. DataStack              (6 DynamoDB tables, 3 S3 buckets)
3. SecurityStack          (Cognito user pool, WAF WebACL, KMS keys)
4. ObservabilityStack     (CloudWatch dashboards, SNS alarm topics, X-Ray config)
5. ApiStack               (API Gateway REST + WebSocket, JWT authorizer, OpenAI-compatible endpoint)
6. SkillPipelineStack     (7-stage skill security scanning pipeline with Step Functions)
7. ChatStack              (ECS Fargate service with ALB, SSE streaming bridge)
8. OrchestrationStack     (EventBridge event bus, SQS queues for agent communication)
9. EvolutionStack         (Self-evolution engine: prompt A/B testing, auto-skills, model routing)
10. TenantOnboardingStack (Tenant provisioning workflow with Cedar policies)
11. PipelineStack         (CI/CD pipeline with canary deployment and auto-rollback)
```

**CDK automatically resolves dependencies,** so you can deploy all at once or individually.

### Deploy All Stacks

```bash
# Synth to verify configuration
cdk synth

# Deploy all platform stacks
cdk deploy --all --require-approval never

# Or deploy with confirmation prompts
cdk deploy --all
```

**Expected duration:**
- Dev environment: 15-20 minutes
- Staging environment: 20-30 minutes
- Prod environment: 30-45 minutes

### Deploy Individual Stacks

For targeted updates:

```bash
# Deploy just the data layer
cdk deploy Chimera-${ENVIRONMENT}-Data

# Deploy API Gateway changes only
cdk deploy Chimera-${ENVIRONMENT}-Api

# Deploy tenant onboarding workflow
cdk deploy Chimera-${ENVIRONMENT}-TenantOnboarding
```

### Stack Outputs

After deployment, CDK outputs critical values:

```bash
# View stack outputs
aws cloudformation describe-stacks \
  --stack-name Chimera-${ENVIRONMENT}-Api \
  --query 'Stacks[0].Outputs'

# Common outputs:
# - RestApiUrl: https://api.execute-api.us-west-2.amazonaws.com/prod/
# - WebSocketApiUrl: wss://ws.execute-api.us-west-2.amazonaws.com/prod/
# - ChatApiUrl: https://chat.agent.example.com/
# - TenantsTableName: chimera-tenants-dev
# - SessionsTableName: chimera-sessions-dev
```

**Save these outputs** for configuration in your application code.

### Deployment Stages (Multi-Environment)

For multi-account deployments:

```bash
# Deploy to dev (single command)
ENVIRONMENT=dev cdk deploy --all

# Deploy to staging (after dev testing)
ENVIRONMENT=staging cdk deploy --all

# Deploy to prod (requires manual approval in pipeline)
ENVIRONMENT=prod cdk deploy --all --require-approval always
```

---

## Verification

### Health Checks

Verify each stack is operational:

#### 1. Network Connectivity

```bash
# Verify VPC endpoints exist
aws ec2 describe-vpc-endpoints \
  --filters "Name=tag:Environment,Values=${ENVIRONMENT}" \
  --query 'VpcEndpoints[*].[ServiceName,State]' \
  --output table

# Expected: dynamodb, s3, bedrock-runtime, ecr.api, logs (all "available")
```

#### 2. Data Layer

```bash
# Verify DynamoDB tables
aws dynamodb list-tables \
  --query 'TableNames[?contains(@, `chimera-`)]'

# Expected output:
# [
#   "chimera-tenants-dev",
#   "chimera-sessions-dev",
#   "chimera-skills-dev",
#   "chimera-rate-limits-dev",
#   "chimera-cost-tracking-dev",
#   "chimera-audit-dev"
# ]

# Check table status
aws dynamodb describe-table \
  --table-name chimera-tenants-${ENVIRONMENT} \
  --query 'Table.[TableName,TableStatus,ItemCount]'

# Expected: ["chimera-tenants-dev", "ACTIVE", 0]
```

#### 3. Platform Runtime

```bash
# Verify AgentCore Runtime deployment
aws bedrock-agent describe-agent-runtime \
  --runtime-name chimera-${ENVIRONMENT}-pool

# Check runtime health endpoint (requires authentication)
curl -H "Authorization: Bearer ${API_TOKEN}" \
  https://${AGENT_ENDPOINT}/health

# Expected: {"status": "healthy", "version": "1.0.0"}
```

#### 4. Chat Service (ECS)

```bash
# Verify ECS service is running
aws ecs describe-services \
  --cluster chimera-${ENVIRONMENT}-chat \
  --services chimera-chat \
  --query 'services[0].[serviceName,status,runningCount,desiredCount]'

# Expected: ["chimera-chat", "ACTIVE", 2, 2]

# Check ALB target health
aws elbv2 describe-target-health \
  --target-group-arn $(aws elbv2 describe-target-groups \
    --names chimera-${ENVIRONMENT}-chat-tg \
    --query 'TargetGroups[0].TargetGroupArn' --output text) \
  --query 'TargetHealthDescriptions[*].[Target.Id,TargetHealth.State]'

# Expected: At least 1 target in "healthy" state
```

### Integration Tests

Run post-deployment integration tests:

```bash
# From repo root
bun run test:integration --env ${ENVIRONMENT}

# Expected output:
# ✓ Tenant config can be written to DynamoDB
# ✓ Agent session can be created
# ✓ Chat API returns valid response
# ✓ WebSocket connection succeeds
```

### Smoke Test (End-to-End)

```bash
# Create test tenant
chimera tenant create \
  --name "Test Tenant" \
  --tier basic \
  --admin-email test@example.com \
  --env ${ENVIRONMENT}

# Invoke agent session
chimera agent invoke \
  --tenant-id <tenant-id> \
  --prompt "Hello, what is your name?" \
  --env ${ENVIRONMENT}

# Expected: Agent responds with introduction
```

---

## Pipeline Setup

### CodePipeline Deployment

Deploy the CI/CD pipeline stack:

```bash
# Deploy pipeline (one-time setup)
cdk deploy Chimera-Pipeline

# Pipeline will auto-trigger on future pushes to main branch
```

### GitHub Connection

Set up GitHub integration for source:

```bash
# Create GitHub connection (AWS Console)
# 1. Go to CodePipeline → Settings → Connections
# 2. Create connection → GitHub → Authorize
# 3. Copy connection ARN

# Update pipeline stack with connection ARN
export GITHUB_CONNECTION_ARN="arn:aws:codestar-connections:..."
cdk deploy Chimera-Pipeline
```

### Pipeline Stages

The pipeline has 6 stages:

```
1. Source         - Fetch from GitHub main branch
2. Build          - CDK synth, run tests, Docker build
3. DeployToDev    - Deploy to dev account, run integration tests
4. DeployToStaging - Deploy to staging, canary bake (30 min)
5. ManualApproval - Platform team approval required
6. DeployToProd   - Progressive deploy to prod, smoke tests
```

### Manual Approval

Production deployments require manual approval:

```bash
# Approve via CLI
aws codepipeline put-approval-result \
  --pipeline-name chimera-deploy \
  --stage-name ManualApproval \
  --action-name ApproveProd \
  --result summary="Staging tests passed",status=Approved \
  --token <approval-token-from-SNS>

# Or approve via AWS Console:
# CodePipeline → chimera-deploy → ManualApproval → Review
```

### Rollback

If production deployment fails:

```bash
# Automatic rollback via CloudFormation
# (no action needed - CloudFormation reverts changes)

# Manual rollback if needed
aws codepipeline stop-pipeline-execution \
  --pipeline-name chimera-deploy \
  --pipeline-execution-id <execution-id> \
  --reason "Rolling back due to errors"

# Redeploy previous version
git revert HEAD
git push origin main
# Pipeline will auto-trigger with reverted code
```

---

## Monitoring

### CloudWatch Dashboards

Access operational dashboards:

```bash
# Platform dashboard URL
echo "https://console.aws.amazon.com/cloudwatch/home?region=${CDK_DEFAULT_REGION}#dashboards:name=Chimera-Platform"

# Per-tenant dashboard
echo "https://console.aws.amazon.com/cloudwatch/home?region=${CDK_DEFAULT_REGION}#dashboards:name=Chimera-Tenant-<tenant-id>"
```

**Key metrics to monitor:**

- **Agent Invocation Latency (p99):** Should be <30s
- **Agent Error Rate:** Should be <1%
- **DynamoDB Throttles:** Should be 0
- **ECS Task Health:** All tasks should be "healthy"
- **NAT Gateway ErrorPortAllocation:** Should be 0

### Alarms

Critical alarms are pre-configured:

```bash
# List active alarms
aws cloudwatch describe-alarms \
  --state-value ALARM \
  --query 'MetricAlarms[*].[AlarmName,StateReason]' \
  --output table

# Check alarm history
aws cloudwatch describe-alarm-history \
  --alarm-name ChimeraPlatformHighErrorRate \
  --max-records 10
```

### Log Access

Access logs for troubleshooting:

```bash
# Platform Runtime logs
aws logs tail /aws/agentcore/chimera-${ENVIRONMENT}-pool --follow

# ECS Chat service logs
aws logs tail /ecs/chimera-${ENVIRONMENT}-chat --follow

# API Gateway logs
aws logs tail /aws/apigateway/chimera-${ENVIRONMENT}-api --follow

# Filter for errors
aws logs filter-log-events \
  --log-group-name /aws/agentcore/chimera-${ENVIRONMENT}-pool \
  --filter-pattern "ERROR" \
  --start-time $(date -u -d '1 hour ago' +%s)000
```

### X-Ray Tracing

View distributed traces:

```bash
# Get trace summaries
aws xray get-trace-summaries \
  --start-time $(date -u -d '1 hour ago' +%s) \
  --end-time $(date -u +%s) \
  --filter-expression 'service("chimera-*")'

# Open X-Ray console
echo "https://console.aws.amazon.com/xray/home?region=${CDK_DEFAULT_REGION}#/traces"
```

---

## Troubleshooting

### Common Issues

#### Issue: CDK deploy fails with "no space left on device"

**Cause:** Docker asset bundling fills /tmp

**Fix:**

```bash
# Clear Docker build cache
docker system prune -af --volumes

# Set CDK to use alternative temp directory
export CDK_DOCKER_BUILD_ARGS="--build-arg TMPDIR=/var/tmp"
cdk deploy --all
```

#### Issue: DynamoDB table already exists

**Cause:** Previous failed deployment left resources

**Fix:**

```bash
# Delete stack completely and redeploy
cdk destroy Chimera-${ENVIRONMENT}-Data
cdk deploy Chimera-${ENVIRONMENT}-Data

# Or delete table manually
aws dynamodb delete-table --table-name chimera-tenants-${ENVIRONMENT}
```

#### Issue: VPC endpoint quota exceeded

**Cause:** AWS service quota for interface VPC endpoints reached

**Fix:**

```bash
# Request quota increase
aws service-quotas request-service-quota-increase \
  --service-code vpc \
  --quota-code L-29B6F2EB \
  --desired-value 50

# Wait 1-2 business days for approval, then retry deployment
```

#### Issue: AgentCore Runtime fails to start

**Cause:** Missing IAM permissions or invalid runtime artifact

**Fix:**

```bash
# Check CloudWatch logs for AgentCore Runtime
aws logs tail /aws/bedrock/agentcore/chimera-${ENVIRONMENT}-pool --follow

# Common causes:
# 1. IAM role missing Bedrock permissions
# 2. Runtime artifact (agent-code/) has syntax errors
# 3. DynamoDB tables not accessible from VPC

# Verify IAM role permissions
aws iam get-role-policy \
  --role-name Chimera-${ENVIRONMENT}-RuntimeRole \
  --policy-name BedrockAccess

# Test DynamoDB access from VPC
# (requires EC2 instance in same VPC)
```

#### Issue: ECS tasks stuck in "PENDING" state

**Cause:** ECR image pull failure or insufficient ENI capacity

**Fix:**

```bash
# Check ECS task stopped reason
aws ecs describe-tasks \
  --cluster chimera-${ENVIRONMENT}-chat \
  --tasks $(aws ecs list-tasks --cluster chimera-${ENVIRONMENT}-chat \
    --query 'taskArns[0]' --output text) \
  --query 'tasks[0].stoppedReason'

# Common fixes:
# 1. ECR image missing: rebuild and push Docker image
# 2. ENI limit: request EC2 service quota increase for ENIs
# 3. Security group issue: verify ECS SG allows egress to ECR
```

### Getting Help

**Internal support:**

- Slack: `#chimera-platform-support`
- Email: platform-team@example.com
- Oncall: Run `/oncall chimera-platform`

**AWS support:**

```bash
# Open AWS support case
aws support create-case \
  --subject "Chimera deployment issue" \
  --service-code "bedrock" \
  --severity-code "normal" \
  --communication-body "Description of issue..." \
  --cc-email-addresses "platform-team@example.com"
```

---

## Appendix

### Deployment Checklist

- [ ] AWS account setup with required quotas
- [ ] Development tools installed (mise, bun, CDK CLI, Docker)
- [ ] Environment variables configured
- [ ] CDK bootstrapped in target account/region
- [ ] All 11 stacks deployed successfully
- [ ] Health checks passed (Network, Data, API, Chat)
- [ ] Integration tests passed
- [ ] Smoke test completed (create tenant, invoke agent)
- [ ] Monitoring dashboards accessible
- [ ] Alarms configured and tested
- [ ] Documentation updated with stack outputs

### Stack Dependencies

```
NetworkStack
  └─> DataStack
      ├─> SecurityStack
      └─> ObservabilityStack
          └─> PlatformRuntimeStack
              ├─> ChatStack
              └─> TenantStack(s)

PipelineStack (no dependencies, deploys first)
```

### Estimated Costs

**Dev environment** (idle):
- DynamoDB (on-demand): $5-10/month
- S3: $2-5/month
- VPC (NAT Gateway): $35/month
- AgentCore Runtime (pooled): $0 (pay-per-use)
- ECS Fargate: $15-20/month
- **Total: ~$60-75/month**

**Prod environment** (100 tenants, 1M tokens/day):
- DynamoDB: $50-100/month
- S3: $10-20/month
- VPC: $105/month (3 NAT Gateways)
- AgentCore Runtime: $200-500/month
- ECS Fargate: $50-100/month
- Bedrock models: $500-2,000/month
- **Total: ~$1,000-3,000/month**

### Next Steps

- **[Multi-Tenant Management Guide](./multi-tenant.md)** - Tenant onboarding, configuration, monitoring
- **[Runbooks](../runbooks/)** - Operational procedures for common tasks
- **[Architecture Docs](../architecture/)** - Deep dive into system design

---

**Questions?** Open an issue in the repo or contact the platform team.
