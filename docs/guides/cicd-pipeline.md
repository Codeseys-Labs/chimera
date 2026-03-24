# Chimera CI/CD Pipeline Guide

This guide covers the setup, activation, and operation of the Chimera CI/CD pipeline.

## Overview

The Chimera CI/CD pipeline implements a progressive deployment strategy with automated testing and canary validation. It is built using AWS CodePipeline, CodeBuild, and Step Functions.

### Pipeline Architecture

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Source  │ -> │  Build   │ -> │   Test   │ -> │  Deploy  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
  GitHub         Unit Tests     Integration     Canary 5%
  Webhook        Lint/Type      E2E Tests       30min Bake
                 CDK Synth                      Progressive
                 Docker Build                   Rollout
```

## Pipeline Stages

### Stage 1: Source

- **Action**: GitHub webhook trigger via CodeStar Connections
- **Output**: Source code artifact
- **Configuration**: Monitors the configured branch (default: `main`)

### Stage 2: Build

- **Action**: CodeBuild project using `buildspec.yml`
- **Duration**: < 8 minutes (target)
- **Steps**:
  1. Install dependencies (`bun install`)
  2. Lint (`bun run lint`)
  3. Type check (`bun run typecheck`)
  4. Unit tests with coverage (`bun test --coverage`)
  5. Contract tests (`bun test:contract`)
  6. CDK synth and validation (`bunx cdk synth --all`, `bunx cdk-nag`)
  7. Docker build and push to ECR
- **Output**: Build artifact with `image-uri.txt`, CDK templates, agent code

### Stage 3: Test

- **Action**: CodeBuild project for integration and E2E tests
- **Duration**: < 20 minutes
- **Steps**:
  1. Install test dependencies
  2. Pull Docker image from build artifacts
  3. Run integration tests (`bun test:integration`)
  4. Run E2E tests (`bun test:e2e`)
- **Reports**: JUnit XML test results published to CodeBuild
- **Output**: Test validation pass/fail

### Stage 4: Deploy

- **Action**: Step Functions orchestration for canary deployment
- **Duration**: 60-90 minutes (includes bake periods)
- **Sub-stages**:
  1. **Canary 5%**: Deploy to canary endpoint with 5% traffic
  2. **Bake**: 30-minute monitoring period
  3. **Validation**: Check metrics (error rate, latency, guardrails, eval scores)
  4. **Progressive Rollout**:
     - 25% traffic (15min wait)
     - 50% traffic (15min wait)
     - 100% traffic (full deployment)
  5. **Rollback**: Automatic if validation fails

## Deployment Orchestration

The Deploy stage uses Step Functions to orchestrate the canary deployment:

```
┌─────────────┐
│ Deploy 5%   │
│   Canary    │
└──────┬──────┘
       │
       v
┌─────────────┐
│   Wait 30   │
│   Minutes   │
└──────┬──────┘
       │
       v
┌─────────────┐     ┌─────────────┐
│  Validate   │ NO  │  Rollback   │
│   Metrics   ├────>│  & Fail     │
└──────┬──────┘     └─────────────┘
       │ YES
       v
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Rollout 25% ├────>│ Rollout 50% ├────>│ Rollout 100%│
│  (wait 15m) │     │  (wait 15m) │     │  Complete   │
└─────────────┘     └─────────────┘     └─────────────┘
```

## Rollback Triggers

The pipeline automatically rolls back if any of these conditions are met:

| Metric | Threshold | Evaluation Period |
|--------|-----------|-------------------|
| Error rate | > 5% | 5 minutes |
| P99 latency | > 2x baseline | 10 minutes |
| Guardrail trigger rate | > 10% | 15 minutes |
| Evaluation composite score | < 80 | Single check |

Rollback restores both canary and production endpoints to the `:latest-stable` ECR tag.

## Setup and Activation

### Prerequisites

1. **AWS Account** with CDK bootstrapped in target region
2. **GitHub Repository** with code
3. **ECR Repository** named `chimera-agent-runtime`
4. **CodeStar Connection** to GitHub (or GitHub token in Secrets Manager)

### Deploy the Pipeline Stack

```bash
# From the infra directory
cd infra

# Deploy to staging
bunx cdk deploy Chimera-Pipeline-staging \
  --context envName=staging \
  --context repository=your-org/chimera \
  --context branch=main

# Deploy to production
bunx cdk deploy Chimera-Pipeline-production \
  --context envName=production \
  --context repository=your-org/chimera \
  --context branch=main
```

### Configure CodeStar Connection

After deploying the pipeline stack:

1. Go to AWS Console → CodePipeline → Settings → Connections
2. Find the pending connection (status: `PENDING`)
3. Click "Update pending connection"
4. Complete GitHub OAuth flow
5. Connection status should change to `AVAILABLE`

### Activate the Pipeline

Once the CodeStar connection is active, the pipeline will automatically trigger on:

- Push to the configured branch (default: `main`)
- Manual execution via AWS Console or CLI

## Manual Pipeline Execution

### Via AWS Console

1. Go to AWS Console → CodePipeline
2. Select `chimera-deploy-<env>`
3. Click "Release change"

### Via AWS CLI

```bash
# Start pipeline execution
aws codepipeline start-pipeline-execution \
  --name chimera-deploy-production

# Get execution status
aws codepipeline get-pipeline-execution \
  --pipeline-name chimera-deploy-production \
  --pipeline-execution-id <execution-id>
```

## GitHub Actions Workflow

An alternative GitHub Actions workflow is provided at `.github/workflows/deploy.yml` for environments where AWS CodePipeline is not available.

### Workflow Stages

1. **Build Images**: Build and push Docker images to ECR
2. **Deploy Infrastructure**: Deploy 11 CDK stacks in dependency order
3. **Deploy Canary**: Update canary endpoint (5% traffic)
4. **Validate Canary**: Monitor for 30 minutes
5. **Progressive Rollout**: 25% → 50% → 100%
6. **Post-Deploy Validation**: Smoke tests and cost checks
7. **Notify**: Send deployment status notification

### Triggering GitHub Actions

```bash
# Via GitHub CLI
gh workflow run deploy.yml \
  --field environment=production \
  --field skip_canary=false

# Via GitHub UI
# Go to Actions → Deploy - Canary & Production → Run workflow
```

## Monitoring

### CloudWatch Logs

- Build logs: `/aws/codebuild/chimera-build-<env>`
- Test logs: `/aws/codebuild/chimera-test-<env>`
- Orchestration logs: `/aws/states/chimera-canary-orchestration-<env>`

### CloudWatch Alarms

- **Error Rate Alarm**: SEV2 alert if error rate > 5% for 5 minutes
- **Latency Alarm**: SEV2 alert if P99 latency > 60s

### Pipeline Notifications

Subscribe to the SNS topic `chimera-pipeline-alarms-<env>` for:

- Pipeline execution failures
- Canary validation failures
- CloudWatch alarm triggers

## Troubleshooting

### Build Stage Fails

1. Check build logs in CloudWatch: `/aws/codebuild/chimera-build-<env>`
2. Common issues:
   - Dependency installation failures → Check `bun install` step
   - Lint/typecheck errors → Fix code quality issues
   - Test failures → Review test output
   - Docker build errors → Check `agent-code/Dockerfile`

### Test Stage Fails

1. Check test logs in CloudWatch: `/aws/codebuild/chimera-test-<env>`
2. Review JUnit test reports in CodeBuild console
3. Common issues:
   - Integration test failures → Check service dependencies
   - E2E test failures → Verify test environment setup

### Canary Deployment Fails

1. Check Step Functions execution in AWS Console
2. Review Lambda function logs for deployment functions
3. Common issues:
   - Bedrock Agent Runtime API errors → Verify IAM permissions
   - Image URI not found → Check build artifact output
   - Validation failures → Review CloudWatch metrics

### Rollback Occurs

1. Check canary validation metrics in Step Functions output
2. Review CloudWatch alarms that may have triggered
3. Common causes:
   - Error rate spike → Bug in new code
   - Latency increase → Performance regression
   - Guardrail triggers → Agent behavior issues
   - Low evaluation scores → Quality regression

## Best Practices

### Before Merging to Main

- Run full test suite locally: `bun test && bun test:integration`
- Verify CDK synth works: `cd infra && bunx cdk synth --all`
- Check linting and types: `bun run lint && bun run typecheck`

### Emergency Deployments

To skip canary validation (use sparingly):

**GitHub Actions:**
```bash
gh workflow run deploy.yml \
  --field environment=production \
  --field skip_canary=true
```

**CodePipeline:**
Manually approve/skip the canary validation step in the Step Functions execution.

### Monitoring Post-Deployment

- Check error rates in CloudWatch for 24 hours post-deployment
- Review synthetic canary results
- Monitor cost anomalies for unexpected spikes

## Security

### Secrets Management

- GitHub token: Stored in AWS Secrets Manager (secret name: `github-token`)
- ECR credentials: Managed via IAM roles (no static credentials)
- Pipeline IAM role: Least-privilege permissions

### Access Control

- Pipeline execution: Requires IAM permission `codepipeline:StartPipelineExecution`
- Build artifacts: Encrypted at rest in S3 with SSE-S3
- Logs: Encrypted with CloudWatch default encryption

## Cost Optimization

### Artifact Retention

- Build artifacts are automatically deleted after 30 days
- Noncurrent versions are deleted after 7 days

### Build Cache

- Docker layer caching enabled for faster builds
- Bun install cache persists between builds

### Compute Sizing

- Build project: `MEDIUM` (4 vCPU, 7GB RAM) → ~$0.10 per build
- Test project: `MEDIUM` → ~$0.20 per test run
- Step Functions: `STANDARD` → ~$0.025 per state transition

**Estimated cost per deployment**: $0.50 - $1.00 (excluding infrastructure costs)

## References

- [AWS CodePipeline Documentation](https://docs.aws.amazon.com/codepipeline/)
- [AWS CodeBuild Buildspec Reference](https://docs.aws.amazon.com/codebuild/latest/userguide/build-spec-ref.html)
- [AWS Step Functions Best Practices](https://docs.aws.amazon.com/step-functions/latest/dg/best-practices.html)
- [Chimera Testing Strategy](../research/enhancement/06-Testing-Strategy.md)
- [Chimera Operational Runbook](../research/enhancement/07-Operational-Runbook.md)
