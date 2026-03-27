---
title: "Chimera Deployment Architecture"
version: 1.0.0
status: canonical
last_updated: 2026-03-27
---

# Chimera Deployment Architecture

## Overview

Chimera uses AWS CDK (TypeScript) to define and synthesize 13 CloudFormation stacks. All stacks are synthesized under the `Chimera-{envName}` prefix (default: `Chimera-dev`). The CDK app entry point is `infra/bin/chimera.ts`.

CDK commands must use `npx cdk` (Node runtime), not `bunx cdk`. Bun's module resolution breaks CDK `instanceof` checks, causing errors like `TypeError: peer.canInlineRule is not a function`.

---

## Stack Inventory

| # | Stack | Resources | Dependencies |
|---|-------|-----------|--------------|
| 1 | `Network` | VPC, subnets, NAT gateways, VPC endpoints, security groups | — |
| 2 | `Data` | 6 DynamoDB tables, 3 S3 buckets, DAX cluster | Network |
| 3 | `Security` | Cognito user pool, WAF WebACL, KMS CMK | — |
| 4 | `Observability` | CloudWatch dashboard, SNS alarm topic, DDB throttle alarms | Data, Security |
| 5 | `Api` | REST API (v1 + WebSocket), JWT authorizer, webhook routes | Security |
| 6 | `Pipeline` | CodePipeline, CodeCommit, CodeBuild, ECR repositories | — |
| 7 | `SkillPipeline` | Step Functions 7-stage skill security scanner | Data |
| 8 | `Chat` | ECS Fargate, ALB, CloudFront (OAC), chat gateway | Network, Data, Pipeline |
| 9 | `Orchestration` | EventBridge bus, SQS FIFO task queues, A2A queues | Security |
| 10 | `Evolution` | Step Functions evolution engine, DynamoDB state table, S3 artifacts | Data |
| 11 | `TenantOnboarding` | Step Functions provisioning workflow, Cedar policy store, Lambdas | Data, Security, Observability |
| 12 | `Email` | SES receipt rules, S3 inbound bucket, parser/sender Lambdas, SQS | Data, Orchestration |
| 13 | `Frontend` | S3 + CloudFront (OAC), React SPA hosting | — |

---

## Deployment Order

CloudFormation respects explicit `addDependency()` declarations. The recommended deployment sequence to minimize cross-stack reference failures:

```
1. Network
2. Data (needs Network for VPC)
3. Security (independent)
4. Pipeline (independent — ECR repos must exist before Chat)
5. Observability (needs Data, Security)
6. Api (needs Security)
7. SkillPipeline (needs Data)
8. Chat (needs Network, Data, Pipeline)
9. Orchestration (needs Security)
10. Evolution (needs Data)
11. TenantOnboarding (needs Data, Security, Observability)
12. Email (needs Data, Orchestration)
13. Frontend (independent)
```

For first deployment, use `--all` to let CDK resolve dependency order automatically:

```bash
npx cdk bootstrap --account <ACCOUNT_ID> --region us-west-2
chimera deploy --source local   # pushes source to CodeCommit, then:
npx cdk deploy --all --require-approval never
```

---

## CDK Bootstrap

CDK requires bootstrapping once per account/region before the first deploy:

```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/us-west-2
```

This creates the `CDKToolkit` stack with:
- S3 bucket for CDK assets
- ECR repository for container image assets
- IAM roles for CloudFormation execution

---

## CDK Nag Compliance

All 13 stacks are checked by the `AwsSolutionsChecks` CDK Nag pack. As of the CDK synth validation pass on 2026-03-27, all 478 initial findings have documented suppressions in `infra/cdk-nag-suppressions.ts`.

Suppressions are applied from `bin/chimera.ts` after each stack is created, using per-stack functions (`applyNetworkStackSuppressions`, `applyDataStackSuppressions`, etc.).

### Key Suppression Decisions

| Rule | Stacks | Reason |
|------|--------|--------|
| `AwsSolutions-IAM4` | All | Lambda/ECS managed policies are minimal required policies |
| `AwsSolutions-IAM5` | All | CDK-generated wildcard grants for GSIs (`/index/*`), KMS (`kms:ReEncrypt*`), S3 (`s3:GetObject*`) |
| `AwsSolutions-L1` | All | Lambda runtimes pinned for reproducibility |
| `AwsSolutions-SQS4` | All | DLQs do not need their own DLQ |
| `AwsSolutions-EC23` | Network | ALB intentionally public on 80/443 |
| `AwsSolutions-APIG4/COG4` | Api | Webhook routes use HMAC auth, not Cognito |
| `AwsSolutions-CB4` | Pipeline | CodeBuild uses default AES256; artifact bucket uses KMS |
| `AwsSolutions-CFR3/4/5` | Chat, Frontend | HTTPS redirect enforced; no geo restriction; WAF at ALB level |
| `AwsSolutions-SF1/SF2` | Evolution, TenantOnboarding | Step Functions tracing via Lambda; full logging deferred |

---

## Custom CDK Aspects

Four project-wide aspects enforce cross-cutting invariants during synthesis. All errors are hard failures (block synth):

| Aspect | Enforcement |
|--------|-------------|
| `EncryptionAspect` | S3 buckets must use `aws:kms` SSE; warns on unencrypted SQS |
| `TenantIsolationAspect` | DynamoDB tables/GSIs must have `TenantId` partition key |
| `LogRetentionAspect` | CloudWatch Log Groups must specify explicit retention |
| `TaggingAspect` | All resources tagged with `Project`, `Environment`, `ManagedBy` |

### Bucket Encryption Decisions

All S3 buckets use KMS encryption:
- **ChimeraBucket** L3 construct: CMK (customer-managed) by default
- **Pipeline ArtifactBucket**: `KMS_MANAGED` (aws/s3 key) — CodePipeline compatible
- **Email InboundEmailBucket**: `KMS_MANAGED` (aws/s3 key) — SES compatible
- **Frontend FrontendBucket**: `KMS_MANAGED` (aws/s3 key) — requires OAC (not OAI)

CloudFront Origin Access Identity (OAI) does not support SSE-KMS encrypted S3 buckets. The FrontendStack uses **Origin Access Control (OAC)** via `S3BucketOrigin.withOriginAccessControl()`, which supports SSE-KMS.

---

## Environment Configuration

CDK context values (set via `-c key=value` or `cdk.context.json`):

| Context Key | Default | Purpose |
|-------------|---------|---------|
| `environment` | `dev` | Stack name prefix: `Chimera-{env}` |
| `account` | `CDK_DEFAULT_ACCOUNT` env var | AWS account ID |
| `region` | `us-west-2` | AWS region |
| `repositoryName` | `chimera` | CodeCommit repository name |
| `branch` | `main` | CI/CD pipeline source branch |
| `dockerHubSecretArn` | (none) | Secrets Manager ARN for DockerHub credentials |
| `emailDomain` | (none) | SES domain for inbound email receipt |
| `fromAddress` | (none) | SES `from` address for outbound email |

---

## First Deployment Checklist

- [ ] AWS credentials configured (`aws sts get-caller-identity`)
- [ ] CDK bootstrapped: `npx cdk bootstrap`
- [ ] Docker Hub credentials in Secrets Manager (required for Pipeline stack ECR pull-through cache)
- [ ] Source pushed to CodeCommit: `chimera deploy --source local`
- [ ] All stacks deployed: `npx cdk deploy --all`
- [ ] Endpoints fetched: `chimera connect`
- [ ] Services validated: `chimera doctor`
- [ ] Auth tested: `chimera login`
- [ ] Chat tested: `chimera chat`

---

## Deployment Runbook Notes

### DockerHub ECR Pull-Through Cache

The Pipeline stack uses ECR pull-through cache for `registry-1.docker.io`. A DockerHub credentials secret must exist in Secrets Manager before deploying. Provide the ARN via `dockerHubSecretArn` context.

Direct Docker Hub pulls (FROM `oven/bun:1.3-alpine`) bypass ECR cache by default. Dockerfiles must be updated to use `<account>.dkr.ecr.<region>.amazonaws.com/registry-1.docker.io/...` prefix when pull-through cache is active.

### ECS Fargate Chat Gateway

The Chat stack deploys via ECR image from the Pipeline stack's `chatGatewayEcrRepository`. The initial image must be pushed before `ChatStack` can deploy (otherwise ECS task fails to start). The Pipeline stack handles this automatically on first `chimera deploy --source local`.

### Secrets Manager / ECS Task Definition

ECS secrets reference `EcsSecret.fromSecretsManager()` with specific JSON key names. If keys in the Secrets Manager secret template don't match the `EcsSecret` references, ECS tasks fail at startup with `ResourceInitializationError: retrieved secret did not contain json key X`. Validate secret template keys against task definition before deploying Chat stack.
