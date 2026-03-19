# Deployment Guide

> Parent: [[Index]]
> Repo: [aws-samples/sample-OpenClaw-on-AWS-with-Bedrock](https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock)

## Prerequisites

- AWS CLI configured (`aws configure`)
- Docker installed and running
- EC2 Key Pair in your target region
- Bedrock model access enabled in the AWS console:
  - Request **Nova 2 Lite** (routine tasks)
  - Request **Claude Sonnet 4.5** (complex reasoning)

## Option A: AgentCore Runtime (Recommended for Multi-User)

### Step 1: Build and Push the Agent Container

```bash
# Set your account ID and region
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export REGION=us-east-1

# Build the OpenClaw agent container
cd sample-OpenClaw-on-AWS-with-Bedrock
docker build -t openclaw-agent .

# Create ECR repo and push
aws ecr create-repository --repository-name openclaw-agent --region $REGION 2>/dev/null
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin \
  ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com

docker tag openclaw-agent:latest \
  ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/openclaw-agent:latest
docker push \
  ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/openclaw-agent:latest
```

### Step 2: Deploy the Full Stack via CloudFormation

```bash
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name openclaw-agentcore \
  --region $REGION \
  --parameter-overrides \
    EnableAgentCore=true \
    EnableBedrock=true \
  --capabilities CAPABILITY_IAM

# Wait for completion (~10 minutes)
aws cloudformation wait stack-create-complete \
  --stack-name openclaw-agentcore \
  --region $REGION
```

### Step 3: Access via SSM (No Public Ports)

```bash
# Get instance ID from stack outputs
INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name openclaw-agentcore \
  --region $REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)

# Start port forwarding tunnel
aws ssm start-session \
  --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["18789"],"localPortNumber":["18789"]}'
```

Open `http://localhost:18789` in your browser.

### Step 4: Connect Your Team

From the Gateway UI:
1. Add each team member as a user with their own permission scope
2. Connect WhatsApp, Telegram, or Slack channels
3. Each user's sessions automatically run in isolated microVMs

No additional configuration needed for isolation — AgentCore handles it.

## Option B: EC2-Only (Simpler, Less Isolation)

### One-Click Deploy

The repo provides a **Launch Stack** button for CloudFormation:

1. Click "Launch Stack" in the [README](https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock)
2. Select your EC2 key pair
3. Wait ~8 minutes
4. Check CloudFormation "Outputs" tab for the URL

### Instance Types

| Instance | Monthly Cost | Best For |
|----------|-------------|----------|
| t4g.small | ~$12 | Family (1-4 users, light use) |
| c7g.large | ~$35 | Team (5-10 users, moderate use) |
| c7g.xlarge | ~$70 | Heavy use, many concurrent sessions |

All Graviton ARM — 20-40% cheaper than x86 equivalents.

## Option C: Docker (Local Dev / Testing)

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Run the Docker setup script
./docker-setup.sh

# Or manually:
docker-compose up -d
```

`docker-setup.sh` handles: image build, onboarding wizard, gateway startup.

## Post-Deployment Checklist

- [ ] Verify Gateway is running: `http://localhost:18789`
- [ ] Connect at least one messaging channel (WhatsApp/Telegram/Slack)
- [ ] Add team members as users
- [ ] Configure model provider (Bedrock recommended for AWS deployment)
- [ ] Set up AgentCore Memory store for per-user persistence
- [ ] Test multi-user isolation: send messages from two different users
- [ ] Verify scheduled tasks ("heartbeats") work
- [ ] Set up CloudWatch monitoring for the Gateway EC2 instance
- [ ] Review IAM roles and permission scoping for each user type

## Monitoring

- **CloudWatch:** Gateway EC2 health, AgentCore invocation metrics
- **CloudTrail:** Every Bedrock API call audited
- **Cost Explorer:** Per-service cost breakdown
- **Gateway health:** `openclaw doctor` command for diagnostics

## Updating

Model choice changes don't require container rebuilds — just update the CloudFormation
parameter or `openclaw.json` config.

For OpenClaw version updates:
```bash
# Rebuild container with new version
docker build -t openclaw-agent .
# Push to ECR
docker push ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/openclaw-agent:latest
# AgentCore picks up new container on next session start
```
