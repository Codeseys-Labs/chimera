---
title: "Resumption Guide — First Production Deploy"
version: 1.0.0
status: canonical
last_updated: 2026-04-02
---

# Chimera Resumption Guide

> **For the next session picking up where we left off.** All code is committed to `main`. No stack has ever been deployed to AWS. This guide covers the exact steps to complete first deployment and resolve all known issues.

---

## State as of 2026-04-02

- **Branch:** `main` is clean. All fixes merged.
- **Latest commit:** `eb28262` (seeds sync after builder-s3-chat-fix merge)
- **Key fix commit:** `c3c6585` — OAC bucket policy + Bedrock model ID correction
- **CDK stacks:** 15 stacks, all synthesise cleanly
- **Tests:** 2206 pass / 38 fail (failures are E2E needing live AWS, not code bugs)

---

## Known Issues (in Priority Order)

### Issue 1: Frontend Shows 403 AccessDenied
**Symptom:** Opening the CloudFront URL returns HTTP 403 from S3.

**Root cause:** `FrontendStack` uses an SSE-KMS S3 bucket behind CloudFront OAC. AWS requires an explicit `s3:GetObject` bucket policy grant for the OAC principal when SSE-KMS is enabled. The `S3BucketOrigin.withOriginAccessControl()` L3 construct does not add this automatically for KMS-encrypted buckets.

**Code fix status:** ✅ Committed in `c3c6585` (`infra/lib/frontend-stack.ts`)

**Deploy action:**
```bash
cd infra
npx cdk deploy FrontendStack --context environment=dev

# After deploy, invalidate CloudFront cache:
aws cloudfront create-invalidation \
  --distribution-id $(aws cloudformation describe-stacks \
    --stack-name Chimera-dev-FrontendStack \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
    --output text) \
  --paths "/*"
```

**Verification:** `curl -I https://<cloudfront-domain>/` should return `200 OK`.

---

### Issue 2: Chat WebSocket Closes Immediately
**Symptom:** `chimera chat` connects but stream closes after ~1 second with no response.

**Root cause (two-part):**
1. **Bedrock model ID invalid:** ECS task was configured with model ID `claude-3-5-sonnet-20241022-v2:0` (on-demand endpoint, not an inference profile). Bedrock requires inference profile IDs for cross-region requests.
2. **DSP parser mismatch:** chat.ts and useChat.ts SSE parsers were not mapping `messageStart`/`contentBlockDelta`/`messageStop` event types from Strands DSP format.

**Code fix status:** ✅ Both committed:
- Model ID fix: `c3c6585` — corrects `BEDROCK_MODEL_ID` default to `us.anthropic.claude-sonnet-4-6-20251101-v1:0`
- DSP parser fix: `fix: fix chat SSE socket close` commit (2026-03-31)

**Deploy action:**
```bash
cd infra
npx cdk deploy ChatStack --context environment=dev
```
This creates a new ECS task definition with the correct `BEDROCK_MODEL_ID` env var. ECS will drain the old task and start the new one (blue/green via CodeDeploy or rolling update depending on config).

**Verification:**
```bash
chimera status            # Check ECS service is RUNNING
chimera chat "hello"      # Should get a response
```

---

### Issue 3: ECS Running Stale Bedrock Model ID
**Symptom:** After `cdk deploy ChatStack`, ECS service may still run old task definitions.

**Root cause:** ECS service updates are eventually consistent. New task definition is created but existing tasks continue until drained.

**Resolution:**
```bash
# Force new deployment to use latest task def
aws ecs update-service \
  --cluster chimera-cluster-dev \
  --service chimera-chat-service-dev \
  --force-new-deployment \
  --region us-east-1

# Watch rollout
chimera monitor
```

---

### Issue 4: S3 OAC Policy Missing on Data Buckets
**Symptom:** If agents try to read from S3 via CloudFront origin, they may get 403.

**Root cause:** Same as Issue 1 but for `DataStack` S3 buckets.

**Code fix status:** ✅ Committed in `c3c6585` (`infra/lib/data-stack.ts`)

**Deploy action:**
```bash
cd infra
npx cdk deploy DataStack --context environment=dev
```

---

## First Full Deployment Walkthrough

### Prerequisites

```bash
# Verify AWS credentials
aws sts get-caller-identity

# Verify CDK bootstrap (only needed once per account/region)
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1

# Install dependencies
bun install

# CDK synth to verify all stacks
cd infra
npx cdk synth --quiet 2>&1 | tail -5
# Expected: all 15 stacks listed, no errors
```

### Deploy Order (15 stacks)

Deploy in dependency order — each group can be deployed in parallel:

```bash
cd infra

# Group 1: Foundation (no dependencies)
npx cdk deploy Chimera-dev-NetworkStack --context environment=dev

# Group 2: Data plane (depends on Network)
npx cdk deploy Chimera-dev-DataStack Chimera-dev-SecurityStack --context environment=dev

# Group 3: Observability (depends on Data + Security)
npx cdk deploy Chimera-dev-ObservabilityStack --context environment=dev

# Group 4: Application layer (depends on all above)
npx cdk deploy Chimera-dev-APIStack Chimera-dev-ChatStack --context environment=dev

# Group 5: Orchestration + Evolution (depends on Data + Security)
npx cdk deploy Chimera-dev-OrchestrationStack Chimera-dev-EvolutionStack --context environment=dev

# Group 6: Tenant + Pipeline
npx cdk deploy Chimera-dev-TenantOnboardingStack Chimera-dev-PipelineStack --context environment=dev

# Group 7: Skill + Email + Discovery
npx cdk deploy Chimera-dev-SkillPipelineStack Chimera-dev-EmailStack Chimera-dev-DiscoveryStack --context environment=dev

# Group 8: Frontend + Registration (deploy last)
npx cdk deploy Chimera-dev-FrontendStack Chimera-dev-GatewayRegistrationStack --context environment=dev
```

Or deploy all at once (CDK resolves order):
```bash
cd infra
npx cdk deploy --all --context environment=dev --require-approval never 2>&1 | tee deploy.log
```

### Post-Deploy Verification

```bash
# Check CLI picks up deployed endpoints
chimera doctor

# Verify all stacks ACTIVE
chimera status

# Test authentication
chimera login

# Test chat (end-to-end validation)
chimera chat "list my S3 buckets"
```

---

## Remaining Development Work

After first deployment succeeds, the remaining backlog (from seeds):

### High Priority
- **chimera-0092:** Verify chimera chat works end-to-end with system prompt + tools. Gate on successful deployment.
- **chimera-2087:** Create CLI E2E integration test scripts (depends on live environment).

### Medium Priority
- **chimera-b7af:** Remove `packages/core/src/aws-tools/strands-agents.ts` shim once `strands-agents` publishes to npm registry.

### Deferred / Future
- **chimera-76b9:** Implement LLM-based task decomposer (current is heuristic)
- **chimera-2b2a:** EventBridge scheduled recurring agent tasks
- **chimera-59ee:** Webhook delivery for task lifecycle events
- **chimera-606c:** DGM evolution integration
- **chimera-982e:** NACL rules in network infrastructure

---

## Environment Configuration Reference

### chimera.toml (dev environment)
```toml
[aws]
region = "us-east-1"
account_id = "<your-account-id>"
environment = "dev"

[bedrock]
model_id = "us.anthropic.claude-sonnet-4-6-20251101-v1:0"
prompt_caching = true

[cognito]
user_pool_id = ""    # Output from SecurityStack
client_id = ""       # Output from SecurityStack
```

Run `chimera init` to interactively create this file. It will prompt for Bedrock model selection.

### Environment Variable Reference (ECS ChatStack)
| Variable | Required Value | Set By |
|----------|---------------|--------|
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-4-6-20251101-v1:0` | CDK env (c3c6585) |
| `AWS_ACCOUNT_ID` | `<account-id>` | CDK env (90018d4) |
| `TENANTS_TABLE` | `chimera-tenants-dev` | CDK env |
| `SESSIONS_TABLE` | `chimera-sessions-dev` | CDK env |
| `ENVIRONMENT` | `dev` | CDK env |

---

## Codebase Quick Reference

| What | Where |
|------|-------|
| CDK stacks | `infra/lib/` (15 files) |
| CLI commands | `packages/cli/src/commands/` (16 commands) |
| Core modules | `packages/core/src/` (22 modules) |
| Python agent | `packages/agents/chimera_agent.py` |
| Chat gateway | `packages/chat-gateway/src/` |
| Web frontend | `packages/web/src/` |
| Tests | `tests/` + `packages/*/src/__tests__/` |
| Architecture docs | `docs/architecture/` |
| ADRs | `docs/architecture/decisions/` (ADR-001 to ADR-030) |
| Runbooks | `docs/runbooks/` |
| Session analysis | `docs/analysis/` |

---

## Toolchain Reminders

```bash
# ✅ Always use bun for packages/scripts
bun install
bun test
bun run lint
bun run typecheck

# ✅ Always use npx for CDK (Bun breaks CDK instanceof checks)
npx cdk synth
npx cdk deploy --all

# ✅ Quality gates before any PR
bun test && bun run lint && bun run typecheck
```

---

*Generated by builder-final-docs agent — chimera-c225.*
