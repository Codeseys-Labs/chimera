---
title: "Chimera First Deployment Guide"
version: 1.0.0
status: canonical
last_updated: 2026-03-27
---

# Chimera First Deployment Guide

> Step-by-step runbook for deploying Chimera to AWS for the first time.
> This runbook covers everything from account setup through a live chat test.

**Audience:** Platform engineers doing initial provisioning
**Time estimate:** 45–75 minutes (dominated by CDK Pipeline stack initial deploy ~20–30 min + CodePipeline run ~20–30 min)

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1: Initialize Workspace](#step-1-initialize-workspace)
3. [Step 2: CDK Bootstrap](#step-2-cdk-bootstrap)
4. [Step 3: Verify CDK Synthesis](#step-3-verify-cdk-synthesis)
5. [Step 4: Deploy via CLI](#step-4-deploy-via-cli)
6. [Step 5: Monitor Pipeline Deployment](#step-5-monitor-pipeline-deployment)
7. [Step 6: Fetch Endpoints](#step-6-fetch-endpoints)
8. [Step 7: Validate Deployment](#step-7-validate-deployment)
9. [Step 8: Authenticate](#step-8-authenticate)
10. [Step 9: Test Chat](#step-9-test-chat)
11. [Configuration Reference](#configuration-reference)
12. [Troubleshooting](#troubleshooting)
13. [Known Issues](#known-issues)

---

## Prerequisites

### Required Tooling

| Tool | Minimum Version | Install |
|------|-----------------|---------|
| AWS CLI | v2 | `brew install awscli` |
| Bun | 1.3+ | `curl -fsSL https://bun.sh/install \| bash` |
| Node.js | 18+ | `brew install node` |
| Git | any | built-in on macOS |

Verify:
```bash
aws --version       # aws-cli/2.x.x
bun --version       # 1.3.x or later
node --version      # v18.x or later
```

### AWS Account Requirements

The deploying IAM user/role needs the following service permissions:

| Services |
|----------|
| CloudFormation, IAM (create/attach roles), S3 (create/manage buckets) |
| DynamoDB (create tables, streams), Lambda (create functions) |
| ECS, ECR (create repos, push images), VPC (create VPC, subnets, SGs) |
| API Gateway (REST + WebSocket), Cognito (user pools, clients) |
| SES (receipt rules, verified identities), SQS, EventBridge |
| CloudFront, KMS (create/manage keys), CloudWatch (dashboards, alarms) |
| CodePipeline, CodeCommit, CodeBuild, Step Functions |
| WAF (WebACL), SNS (topics), SSM (parameters) |

> **Simplest option:** Attach the `AdministratorAccess` managed policy for initial deployment. Scope down permissions after first successful deploy if needed.

### Optional

- Custom domain name — for CloudFront frontend distribution (requires Route53 hosted zone)
- SES verified domain — for email agent channel

### CLI Installation

Install the Chimera CLI:
```bash
cd packages/cli
bun install
bun run build
# Add to PATH or use: bunx chimera <command>
```

Or from the project root:
```bash
bun install
```

---

## Step 1: Initialize Workspace

Run the interactive setup wizard to create `chimera.toml`:

```bash
chimera init
```

The wizard prompts for:
- **AWS Profile** — select an existing profile or enter credentials to create a new one
- **AWS Region** — select from common regions or enter custom (e.g., `us-east-1`, `us-west-2`)
- **Environment name** — lowercase letters/numbers/hyphens, e.g., `dev`, `prod` (default: `dev`)
- **CodeCommit repository name** — default: `chimera`

This creates `chimera.toml` in your current directory:

```toml
[aws]
profile = "chimera"
region = "us-east-1"

[workspace]
environment = "dev"
repository = "chimera"
```

> **Important:** Add `chimera.toml` to `.gitignore`. It contains your AWS profile and environment configuration and should not be committed.

### Non-interactive init (scripting)

```bash
chimera init --profile my-profile --region us-east-1 --env dev --repo chimera
```

---

## Step 2: CDK Bootstrap

Bootstrap the CDK toolkit in your target account and region. This creates an S3 bucket for CDK assets and IAM roles for deployment — required once per account/region.

```bash
cd infra
npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

Replace `ACCOUNT_ID` and `REGION` with your values:
```bash
# Get your account ID
aws sts get-caller-identity --query Account --output text

# Example
npx cdk bootstrap aws://123456789012/us-east-1
```

Expected output:
```
 ⏳  Bootstrapping environment aws://123456789012/us-east-1...
 ✅  Environment aws://123456789012/us-east-1 bootstrapped.
```

> **Bootstrap is idempotent** — safe to re-run if already bootstrapped (it upgrades the toolkit stack if needed).

---

## Step 3: Verify CDK Synthesis

Before deploying, verify all 13 stacks synthesize without errors:

```bash
cd infra
npx cdk synth --context environment=dev --context repositoryName=chimera
```

Expected: all 13 stacks synthesize successfully.

**Stack inventory** (names follow the pattern `Chimera-{env}-{Name}`):

| # | Stack Name | Description |
|---|------------|-------------|
| 1 | `Chimera-dev-Network` | VPC, subnets, NAT gateways, security groups |
| 2 | `Chimera-dev-Data` | 6 DynamoDB tables, 3 S3 buckets |
| 3 | `Chimera-dev-Security` | Cognito user pool, WAF WebACL, KMS keys |
| 4 | `Chimera-dev-Observability` | CloudWatch dashboards, SNS alarms |
| 5 | `Chimera-dev-Api` | API Gateway REST + WebSocket |
| 6 | `Chimera-dev-Pipeline` | CodePipeline CI/CD (bootstraps all other stacks) |
| 7 | `Chimera-dev-SkillPipeline` | 7-stage skill security scanning (Step Functions) |
| 8 | `Chimera-dev-Chat` | ECS Fargate chat gateway + ALB |
| 9 | `Chimera-dev-Orchestration` | EventBridge, SQS agent messaging queues |
| 10 | `Chimera-dev-Evolution` | Self-improvement engine (prompt A/B, model routing) |
| 11 | `Chimera-dev-TenantOnboarding` | Cedar policy + Step Functions provisioning |
| 12 | `Chimera-dev-Email` | SES inbound, email parser/sender Lambdas |
| 13 | `Chimera-dev-Frontend` | S3 + CloudFront React SPA |

> **CDK Nag** runs automatically during synthesis with AwsSolutions compliance rules. Warnings are advisory; errors block synthesis. Review any errors before proceeding.

If synthesis fails, see [Troubleshooting — CDK synthesis failures](#cdk-synthesis-failures).

---

## Step 4: Deploy via CLI

Run the deployment command from your project root (where `chimera.toml` is located):

```bash
chimera deploy --source local
```

This command performs the following steps automatically:

1. **Verifies AWS credentials** — calls `sts:GetCallerIdentity` to confirm credentials work
2. **Locates project root** — walks up the directory tree looking for `package.json`
3. **Creates CodeCommit repository** — creates `chimera` repo if it does not exist (idempotent)
4. **Pushes source code to CodeCommit** — uses the CreateCommit API in 5MB batches; skips binary files and files >5MB
5. **Checks Pipeline stack status** — queries CloudFormation for `Chimera-{env}-Pipeline`
6. **If Pipeline stack does not exist:** runs `npx cdk deploy Chimera-{env}-Pipeline` (15–30 minutes on first run)
7. **If Pipeline stack already exists:** CodePipeline detects the new commit and auto-deploys
8. **Saves deployment info** — writes account ID, status, timestamp, and commit IDs to `chimera.toml`

After successful deployment, `chimera.toml` gains a `[deployment]` section:
```toml
[deployment]
account_id = "123456789012"
status = "deployed"
last_deployed = "2026-03-27T10:00:00.000Z"
source_commit = "abc123"
codecommit_commit = "def456"
```

> **Note:** CDK is invoked with `npx cdk` (not `bunx cdk`). This is required because CDK relies on Node.js module resolution for `instanceof` checks. Using Bun breaks CDK peer dependency patterns.

---

## Step 5: Monitor Pipeline Deployment

After `chimera deploy` completes, the Pipeline stack automatically triggers a CodePipeline run that deploys all remaining 12 stacks. This takes 20–30 minutes.

### Monitor via CLI

```bash
chimera status --pipeline
```

This shows all `Chimera-{env}-*` stacks and the current pipeline execution status.

### Monitor via AWS Console

1. Open [AWS CodePipeline console](https://console.aws.amazon.com/codepipeline/)
2. Find the pipeline named `Chimera-{env}-Pipeline`
3. Watch stages progress: Source → Build → Test → Deploy

### Deployment order (respects CDK dependencies)

```
Layer 0 (parallel):     Network, Security, Pipeline, Frontend
Layer 1 (after L0):     Data, Api, Orchestration
Layer 2 (after deps):   Observability, SkillPipeline, Chat, Evolution, Email
Layer 3 (after L2):     TenantOnboarding
```

### Check status programmatically

```bash
# Poll every 60 seconds during deployment
watch -n 60 chimera status --json
```

Wait until `chimera status` shows all stacks as `UPDATE_COMPLETE` or `CREATE_COMPLETE`.

---

## Step 6: Fetch Endpoints

Once all stacks are deployed, fetch the API endpoints and save them to `chimera.toml`:

```bash
chimera endpoints
```

> **Note:** `chimera connect` is a deprecated alias for this command. Use `chimera endpoints`.

This queries CloudFormation stack outputs:
- From `Chimera-{env}-Api`: `ApiUrl`, `WebSocketUrl`
- From `Chimera-{env}-Security`: `UserPoolId`, `WebClientId`

On success, `chimera.toml` gains an `[endpoints]` section:
```toml
[endpoints]
api_url = "https://xxx.execute-api.us-east-1.amazonaws.com/prod"
websocket_url = "wss://xxx.execute-api.us-east-1.amazonaws.com/prod"
cognito_user_pool_id = "us-east-1_xxxxxxxxx"
cognito_client_id = "xxxxxxxxxxxxxxxxxxxxxxxxxx"
```

If this command fails with "Stack not found", confirm all stacks completed deployment via `chimera status`.

---

## Step 7: Validate Deployment

Run pre-flight checks to confirm all services are healthy:

```bash
chimera doctor
```

This runs 5 checks:

| # | Check | What it verifies |
|---|-------|-----------------|
| 1 | AWS credentials | `AWS_ACCESS_KEY_ID` env var, `AWS_ROLE_ARN`, or `~/.aws/credentials` file exists |
| 2 | Chimera auth | `~/.chimera/credentials` exists and token is not expired |
| 3 | API connectivity | `GET {api_url}/health` returns HTTP 200 within 5 seconds |
| 4 | Cognito pool config | `cognito_user_pool_id` and `cognito_client_id` set in `chimera.toml [endpoints]` |
| 5 | Stack status | Checks CloudFormation status for 5 key stacks |

> **Known limitation:** Check #5 (Stack status) uses incorrect stack names (`ChimeraNetworkStack` instead of `Chimera-{env}-Network`). This check will report NOT FOUND for all 5 stacks even when deployment is healthy. See [Known Issues](#known-issues) for details.

Expected output after successful deployment (before login):
```
Chimera Doctor — Pre-flight Checks

  ✓ AWS credentials
  ✗ Chimera auth (Not logged in. Run `chimera login`)
  ✓ API connectivity (https://xxx.execute-api.us-east-1.amazonaws.com/prod/health)
  ✓ Cognito pool config (Pool: us-east-1_xxxxxxxxx)
  ✗ Stack status (ChimeraNetworkStack: NOT FOUND, ...)

Some checks failed. Review the items above.
```

The stack status failure is expected (see Known Issues). The auth failure is expected before running `chimera login`.

---

## Step 8: Authenticate

Log in to the Chimera platform using Cognito PKCE authentication:

```bash
chimera login
```

This opens your default browser to the Cognito hosted UI and starts a local redirect listener on port 9999. After you authenticate in the browser, tokens are saved to `~/.chimera/credentials`.

**Requirements:**
- `chimera.toml` must have `[endpoints].cognito_client_id` set (populated by `chimera endpoints`)
- Either `[auth].cognito_domain` or `[endpoints].cognito_user_pool_id` must be set
- Port 9999 must be available on localhost
- The Cognito app client must have `http://localhost:9999/callback` as an allowed callback URL (configured by CDK in SecurityStack)

After successful login:
```
Chimera Login

Opening browser to authenticate...
Waiting for browser redirect...
Exchanging authorization code for tokens...
✓ Logged in successfully
  Token expires: 3/28/2026, 10:00:00 AM
```

Tokens are stored in `~/.chimera/credentials` (mode 0600, JSON format).

**Browser doesn't open automatically?**
Copy the auth URL printed to the terminal and paste it into your browser manually.

---

## Step 9: Test Chat

Start an interactive chat session to verify end-to-end connectivity:

```bash
chimera chat
```

This opens an interactive REPL that:
- Sends messages to `{api_url}/chat/stream`
- Streams SSE response tokens to stdout
- Press Ctrl+C to exit

Example session:
```
Chimera Chat
Type a message and press Enter. Press Ctrl+C to exit.

You: Hello, are you working?
Chimera: Yes, I'm operational and ready to assist you.

You: ^C

Session ended.
```

If you see authentication errors, run `chimera login` and retry.

---

## Configuration Reference

### chimera.toml sections

This table shows which CLI command reads or writes each `chimera.toml` section:

| Section | Field | `init` | `deploy` | `endpoints` | `doctor` | `login` | `chat` | `status` |
|---------|-------|--------|----------|-------------|----------|---------|--------|----------|
| `[aws]` | `profile` | **W** | R | R | — | R | — | R |
| `[aws]` | `region` | **W** | R | R | R | R | — | R |
| `[workspace]` | `environment` | **W** | R | R | — | — | — | R |
| `[workspace]` | `repository` | **W** | R | — | — | — | — | — |
| `[deployment]` | `account_id`, `status`, etc. | — | **W** | — | — | — | — | — |
| `[endpoints]` | `api_url` | — | — | **W** | R | — | R* | R* |
| `[endpoints]` | `websocket_url` | — | — | **W** | — | — | — | R* |
| `[endpoints]` | `cognito_user_pool_id` | — | — | **W** | R | R | — | — |
| `[endpoints]` | `cognito_client_id` | — | — | **W** | R | R | — | — |
| `[auth]` | `cognito_domain` | — | — | — | — | R | — | — |
| `[auth]` | `callback_url` | — | — | — | — | — | — | — |
| `[tenants]` | `default_tier`, `max_tenants` | — | — | — | — | — | — | — |

**W** = writes, **R** = reads, **R\*** = reads via api-client module

### Complete chimera.toml schema

```toml
[aws]
profile = "chimera"          # AWS credentials profile (~/.aws/credentials)
region = "us-east-1"         # AWS region for all operations

[workspace]
environment = "dev"          # Environment name: dev, staging, prod
repository = "chimera"       # CodeCommit repository name

[deployment]
# Written by 'chimera deploy' — do not edit manually
account_id = "123456789012"
status = "deployed"
last_deployed = "2026-03-27T10:00:00.000Z"
source_commit = "abc123def"
codecommit_commit = "def456abc"

[endpoints]
# Written by 'chimera endpoints' — do not edit manually
api_url = "https://xxx.execute-api.us-east-1.amazonaws.com/prod"
websocket_url = "wss://xxx.execute-api.us-east-1.amazonaws.com/prod"
cognito_user_pool_id = "us-east-1_xxxxxxxxx"
cognito_client_id = "xxxxxxxxxxxxxxxxxxxxxxxxxx"

[auth]
# Optional: explicit Cognito hosted UI domain (overrides pool-derived URL)
# Set to your Cognito domain prefix, e.g. "my-chimera"
# CLI constructs: https://my-chimera.auth.{region}.amazoncognito.com
cognito_domain = "my-chimera"
callback_url = "http://localhost:9999/callback"  # default, matches CDK config

[tenants]
# Optional tenant defaults
default_tier = "basic"
max_tenants = 100
```

### Credentials file

Auth tokens are stored separately in `~/.chimera/credentials` (JSON, mode 0600):
```json
{
  "accessToken": "eyJ...",
  "idToken": "eyJ...",
  "refreshToken": "eyJ...",
  "expiresAt": "2026-03-28T10:00:00.000Z"
}
```

This file is managed by `chimera login`. **Do not store it in version control.**

---

## Troubleshooting

### CDK bootstrap failures

**Error:** `Unable to resolve AWS account to use`
**Fix:** Ensure `AWS_PROFILE` or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are set, or that `~/.aws/credentials` has the configured profile.

**Error:** `User is not authorized to perform: cloudformation:CreateStack`
**Fix:** Attach `AdministratorAccess` or the specific CDK bootstrap IAM permissions to your deploying user.

### CDK synthesis failures

**Error:** CDK Nag rule violations blocking synthesis
**Fix:** Review the rule ID in the error message. Most AwsSolutions rules have suppressions in the stacks. If a new rule triggers, check if there's an existing suppression pattern in the relevant stack file.

**Error:** `Cannot find module 'aws-cdk-lib/...'`
**Fix:** Run `npm install` in the `infra/` directory (CDK packages require Node.js npm, not Bun).

### Pipeline stack deployment timeout

If `chimera deploy` hangs at "Deploying Pipeline stack...":

1. Open the AWS CloudFormation console
2. Find `Chimera-{env}-Pipeline`
3. Check the Events tab for failed resources
4. Common causes: Docker Hub rate limiting for ECR pull-through cache, IAM permission gaps

To resume after fixing:
```bash
chimera deploy --source local
```
Deploy is idempotent — if the Pipeline stack now exists, it triggers a CodePipeline run from the pushed commit.

### CodeCommit push failures

**Error:** `Exceeded 5MB batch size`
**Fix:** The CLI automatically batches files in 5MB chunks. If you have a single file >5MB, it is skipped. Check that large binary assets are not in the source tree.

**Error:** `RepositoryDoesNotExistException`
**Fix:** `chimera deploy` creates the repository automatically. This error typically means AWS credentials don't have `codecommit:CreateRepository` permission.

### Cognito login issues

**Error:** `Missing Cognito configuration in chimera.toml`
**Fix:** Run `chimera endpoints` first to populate `[endpoints].cognito_client_id`.

**Error:** Callback URL mismatch in browser
**Fix:** Ensure port 9999 is not already in use. Also verify the Cognito app client (created by SecurityStack) has `http://localhost:9999/callback` in its allowed callback URLs.

### `chimera doctor` stack check failures

Expected behavior — see [Known Issues](#known-issues) item 1. The stack status check uses incorrect stack names. All other doctor checks (AWS credentials, API connectivity, Cognito config) are reliable.

To check actual stack status, use:
```bash
chimera status
```

---

## Known Issues

### 1. `chimera doctor` stack name mismatch

**Issue:** `doctor.ts` checks for stacks named `ChimeraNetworkStack`, `ChimeraDataStack`, `ChimeraSecurityStack`, `ChimeraApiStack`, `ChimeraChatStack` — but actual CloudFormation stack names are `Chimera-{env}-Network`, `Chimera-{env}-Data`, etc.

**Impact:** The "Stack status" check in `chimera doctor` always reports NOT FOUND, even when all stacks are healthy.

**Workaround:** Use `chimera status` to check actual stack health. This command correctly uses `Chimera-{env}-*` prefix.

**Tracking:** Fix needed in `packages/cli/src/commands/doctor.ts` — update `CHIMERA_STACKS` constant to use environment-qualified names.

### 2. `chimera doctor` checks only 5 of 13 stacks

**Issue:** `doctor.ts` has a hardcoded list of 5 stacks: Network, Data, Security, Api, Chat. The remaining 8 stacks (Pipeline, SkillPipeline, Observability, Orchestration, Evolution, TenantOnboarding, Email, Frontend) are not checked.

**Workaround:** Use `chimera status` which queries all stacks with the `Chimera-{env}-` prefix dynamically.

### 3. GatewayRegistrationStack exists but is not deployed

**Issue:** `infra/lib/gateway-registration-stack.ts` exists but is not included in `infra/bin/chimera.ts`. This stack is not deployed as part of the standard 13-stack deployment.

**Impact:** None for standard deployments. Gateway registration functionality is not yet active.

### 4. CDK default region is `us-west-2`

**Issue:** The CDK entrypoint (`infra/bin/chimera.ts`) defaults to `us-west-2` when no region context is provided. The CLI defaults to `us-east-1`. When `chimera deploy` invokes CDK, it passes `--context environment=...` but not `--context region=...`.

**Impact:** If your `chimera.toml [aws].region` is not the CDK default (`us-west-2`), CDK may synthesize stacks targeting a different region than your CLI operations.

**Workaround:** Either use `us-west-2` as your AWS region, or pass the region explicitly:
```bash
cd infra && npx cdk deploy Chimera-dev-Pipeline \
  --require-approval never \
  --context environment=dev \
  --context region=us-east-1 \
  --context repositoryName=chimera
```
