---
title: 'Comprehensive Architecture Review: CLI-as-Bootstrap, Self-Evolution, Multi-Tenancy'
version: 1.0.0
status: current
last_updated: 2026-04-02
reviewer: architecture-review-agent
scope: Full codebase — 14 CDK stacks, CLI, agent runtime, evolution engine, multi-tenancy
---

# Comprehensive Architecture Review

## Executive Summary

**Architecture Health Score: 6.5 / 10**

Chimera has a well-designed foundational architecture: the CLI-as-bootstrap pattern is correctly implemented, the 14-stack CDK topology is cleanly separated, multi-tenant data isolation is enforced at the DynamoDB partition key level, and the self-evolution agent tooling exists with meaningful safety rails (Cedar policies, rate limits, CDK validation, kill switch). The codebase demonstrates serious architectural thinking.

However, the system has **five critical gaps** that prevent the self-evolution vision from functioning end-to-end: (1) the ECS task role lacks IAM permissions for CodeCommit, making the agent's evolution tools produce `AccessDeniedException` at runtime; (2) there are zero EventBridge rules for CodePipeline state changes, so the agent has no way to know if its deployment succeeded; (3) the CDK validation in the Python agent path (`evolution_tools.py`) is significantly weaker than the TypeScript orchestrator, allowing IAM mutations, VPC changes, and `RemovalPolicy.DESTROY` through; (4) the `optionalAuth` middleware on `/chat/*` routes trusts the `X-Tenant-Id` header without JWT verification, creating a tenant impersonation vector; and (5) the buildspec quality gates (`|| true` on lint, typecheck, and tests) mean the pipeline deploys code regardless of quality failures.

The self-evolution flow is fire-and-forget: the agent commits CDK code to CodeCommit and returns immediately. There is no closed-loop automation for propose → commit → deploy → verify → iterate. The canary orchestration validates ECS container health but does not verify CDK infrastructure changes. No component updates the evolution capability status from `deploying` to `deployed` or `failed`.

---

## Table of Contents

1. [What Is Working Correctly](#1-what-is-working-correctly)
2. [Critical Gaps by Category](#2-critical-gaps-by-category)
3. [Doctor Command Audit](#3-doctor-command-audit)
4. [Self-Evolution Deep Assessment](#4-self-evolution-deep-assessment)
5. [Multi-Tenancy Assessment](#5-multi-tenancy-assessment)
6. [EventBridge Self-Verification Assessment](#6-eventbridge-self-verification-assessment)
7. [Gap Analysis: Chimera vs OpenClaw Vision](#7-gap-analysis-chimera-vs-openclaw-vision)
8. [Prioritized Recommendation Backlog](#8-prioritized-recommendation-backlog)
9. [Minimal Path to Self-Evolution Demo](#9-minimal-path-to-self-evolution-demo)
10. [Architecture Evolution Roadmap](#10-architecture-evolution-roadmap)

---

## 1. What Is Working Correctly

### CLI-as-Bootstrap Pattern ✅

The `chimera deploy` command faithfully targets only the Pipeline stack (`deployCdkStacks()` at `packages/cli/src/commands/deploy.ts:361-366`). On subsequent runs, it pushes code to CodeCommit and trusts CodePipeline to deploy all stacks. The CodePipeline Deploy stage runs `npx cdk deploy --all --require-approval never --concurrency 3` (`infra/lib/pipeline-stack.ts:316`), correctly deploying all 14 stacks in dependency order.

**Evidence:**

- `deploy.ts:361-366` — targets `Chimera-${safeEnv}-Pipeline` only
- `deploy.ts:329-340` — checks if Pipeline stack exists, skips CDK deploy if yes
- `pipeline-stack.ts:1236` — `CodeCommitTrigger.EVENTS` auto-triggers on push
- `pipeline-stack.ts:1225` — `restartExecutionOnUpdate: false` prevents infinite loops

### Multi-Tenant Data Isolation ✅

5 of 6 DynamoDB tables use `TENANT#{id}` as the partition key (`infra/lib/data-stack.ts:57-191`). The `ChimeraTable` L3 construct (`infra/constructs/chimera-table.ts:35-61`) enforces PITR, PAY_PER_REQUEST, deletion protection, and CMK encryption as non-overridable defaults. GSI FilterExpression enforcement is tested (`packages/core/src/skills/__tests__/registry.test.ts:373`).

### Cognito Configuration ✅

The Cognito User Pool (`infra/lib/security-stack.ts:73-164`) has immutable `custom:tenant_id` attributes, tenant tier claims, proper password policy (12 chars, all types), optional TOTP MFA, self-signup disabled, and authorization code grant with PKCE. Three groups (admin, tenant-admin, user) provide role-based access.

### Self-Evolution Safety Rails ✅

The agent's `trigger_infra_evolution` tool (`packages/agents/tools/evolution_tools.py:55-149`) implements five layered safety controls:

1. SSM Parameter kill switch (`/chimera/evolution/self-modify-enabled/{env}`) — lines 354-366
2. Cedar policy authorization via AWS Verified Permissions — lines 369-409
3. DynamoDB rate limiting (5/day/tenant, atomic increment) — lines 412-465
4. CDK code validation (size, stack class, forbidden patterns) — lines 468-498
5. Full audit trail with 90-day TTL — lines 571-609

Evolution tools are gated to premium tier only (`packages/agents/gateway_config.py:132-135`, tier 3).

### Chat Session Tenant Isolation ✅

The `AsyncStreamManager` (`packages/chat-gateway/src/stream-manager.ts:31-58`) stores `tenantId` per stream and enforces tenant-checked retrieval via `getForTenant()`. Cross-tenant stream access returns `undefined`. The SSE bridge (`packages/sse-bridge/src/strands-to-dsp.ts`) maintains per-instance state with no shared mutable state between streams.

### Canary Deployment ✅

The 5-stage pipeline includes a canary orchestration state machine (`pipeline-stack.ts:1057-1204`) with environment-aware bake durations (dev: 2min, staging: 10min, prod: 30min), progressive rollout (5% → 25% → 50% → 100%), and auto-rollback on metric threshold violations (error rate <5%, P99 latency <30s).

### Destroy Command Safety ✅

`chimera destroy` (`packages/cli/src/commands/destroy.ts`) handles proper teardown ordering (14 tiers, leaf stacks first, Network last), S3 bucket emptying, DynamoDB deletion protection disabling, optional data archival (`--retain-data`), and confirmation prompts.

### Frontend Stack ✅

The CloudFront distribution (`infra/lib/frontend-stack.ts:80-136`) uses OAC (not OAI) for SSE-KMS compatibility, separate cache policies for HTML (TTL=0) and assets (TTL=365d with Gzip+Brotli), SPA fallback routing, HTTP/2+3, IPv6, and optional custom domain support.

---

## 2. Critical Gaps by Category

### Self-Evolution

| #    | Gap                                                                     | Severity        | File                                                                 | Status  |
| ---- | ----------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------- | ------- |
| SE-1 | ECS task role lacks CodeCommit IAM permissions                          | **P0 Blocker**  | `infra/lib/chat-stack.ts:99-164`                                     | MISSING |
| SE-2 | No EventBridge rules for CodePipeline state changes                     | **P0 Blocker**  | All infra/ stacks                                                    | MISSING |
| SE-3 | Python CDK validation is weaker than TypeScript orchstrator             | **P0 Security** | `packages/agents/tools/evolution_tools.py:468-498`                   | PARTIAL |
| SE-4 | No closed-loop propose→deploy→verify→iterate                            | **P1**          | Evolution engine                                                     | MISSING |
| SE-5 | Capability status never updated from `deploying` to `deployed`/`failed` | **P1**          | `packages/core/src/evolution/self-evolution-orchestrator.ts:417-446` | MISSING |
| SE-6 | No CodeCommit commit revert tool                                        | **P1**          | Agent tools                                                          | MISSING |
| SE-7 | CodeCommit repo name not registered in Cloud Map                        | **P2**          | `infra/lib/discovery-stack.ts`                                       | MISSING |
| SE-8 | `deleteFiles` not propagated to CodeCommit in push                      | **P2**          | `packages/cli/src/utils/codecommit.ts`                               | MISSING |

### Multi-Tenancy

| #    | Gap                                                                        | Severity        | File                                                     | Status      |
| ---- | -------------------------------------------------------------------------- | --------------- | -------------------------------------------------------- | ----------- |
| MT-1 | `optionalAuth` on `/chat/*` trusts `X-Tenant-Id` header without JWT        | **P0 Security** | `packages/chat-gateway/src/server.ts:61`                 | PARTIAL     |
| MT-2 | `extractTenantContextWithValidation` exists but not wired in               | **P1**          | `packages/chat-gateway/src/middleware/tenant.ts:116-177` | PARTIAL     |
| MT-3 | JWT claim ≠ path parameter enforcement missing in API GW handlers          | **P1**          | `infra/lib/api-stack.ts:130-132`                         | MISSING     |
| MT-4 | No per-tenant rate limiting at API Gateway level                           | **P2**          | `infra/lib/api-stack.ts`                                 | MISSING     |
| MT-5 | Lambda API handlers not implemented (empty `/infra/lambdas/api-handlers/`) | **P1**          | `infra/lambdas/api-handlers/`                            | MISSING     |
| MT-6 | In-memory stream storage not horizontally scalable                         | **P2**          | `packages/chat-gateway/src/stream-manager.ts:67`         | Operational |
| MT-7 | Dead `/auth/register` endpoint (Cognito rejects, but endpoint exists)      | **P3**          | `packages/chat-gateway/src/routes/auth.ts:252`           | Cleanup     |

### Safety & Guardrails

| #    | Gap                                                        | Severity | File                                       | Status        |
| ---- | ---------------------------------------------------------- | -------- | ------------------------------------------ | ------------- |
| SG-1 | Buildspec `\|\| true` on lint/typecheck/tests              | **P0**   | `buildspec.yml:20-22`                      | Present (bad) |
| SG-2 | CDK validation wildcard bypass is trivially circumventable | **P1**   | `evolution_tools.py:40-44`                 | PARTIAL       |
| SG-3 | No branch protection for agent commits to main             | **P1**   | CodeCommit config                          | MISSING       |
| SG-4 | No `cdk synth` validation before commit                    | **P2**   | `evolution_tools.py`                       | MISSING       |
| SG-5 | `redeploy` command bypasses bootstrap pattern              | **P2**   | `packages/cli/src/commands/destroy.ts:646` | Design debt   |

### Developer Experience

| #    | Gap                                                                    | Severity | File                                  | Status  |
| ---- | ---------------------------------------------------------------------- | -------- | ------------------------------------- | ------- |
| DX-1 | Doctor missing 5/8 critical checks                                     | **P1**   | `packages/cli/src/commands/doctor.ts` | PARTIAL |
| DX-2 | No `chimera diff` command                                              | **P2**   | CLI                                   | MISSING |
| DX-3 | No `chimera trigger` command                                           | **P2**   | CLI                                   | MISSING |
| DX-4 | Sync is naive overwrite with no merge/diff                             | **P2**   | `packages/cli/src/commands/sync.ts`   | PARTIAL |
| DX-5 | `GatewayRegistration` in destroy order but not defined in `chimera.ts` | **P3**   | `destroy.ts:218-233`                  | Stale   |

### Observability

| #    | Gap                                                           | Severity | File                               | Status  |
| ---- | ------------------------------------------------------------- | -------- | ---------------------------------- | ------- |
| OB-1 | No CloudWatch alarms for CloudFormation/CodePipeline failures | **P1**   | `infra/lib/observability-stack.ts` | MISSING |
| OB-2 | No alarms connected to agent runtime (all route to SNS/email) | **P2**   | All alarm stacks                   | MISSING |
| OB-3 | Canary rollback limited to ECS/ALB — no CDK stack rollback    | **P1**   | `pipeline-stack.ts:896-1010`       | PARTIAL |

---

## 3. Doctor Command Audit

**File:** `packages/cli/src/commands/doctor.ts` (294 lines)

### Current Checks (7 implemented)

| Check                      | Function                 | Lines   | Adequacy                             |
| -------------------------- | ------------------------ | ------- | ------------------------------------ |
| AWS credentials (presence) | `checkAwsCredentials()`  | 36-50   | ⚠️ Presence only — no STS validation |
| Chimera auth token         | `checkChimeraAuth()`     | 52-79   | ✅ Checks expiry                     |
| API connectivity           | `checkApiConnectivity()` | 81-99   | ✅ Health endpoint check             |
| Cognito config             | `checkCognitoConfig()`   | 101-128 | ✅ Validates IDs present             |
| Stack status               | `checkStackStatus()`     | 139-180 | ⚠️ No Pipeline-specific intelligence |
| chimera.toml schema        | `checkTomlSchema()`      | 182-203 | ✅ Region + environment check        |
| Toolchain (bun, npx, aws)  | `checkToolchain()`       | 205-227 | ⚠️ Missing node, cdk, isengardcli    |

### Missing Checks (5 critical)

| Check                                       | Priority | What It Should Do                                                             |
| ------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| AWS credential validation (actual STS call) | **P1**   | Call `STS.GetCallerIdentity`, report account/principal, detect expired tokens |
| CDK bootstrap (`CDKToolkit` stack)          | **P1**   | `DescribeStacks({ StackName: 'CDKToolkit' })`, verify version                 |
| Node.js / `npx cdk` resolution              | **P1**   | Run `node --version` and `npx cdk --version` with timeout                     |
| CodeCommit repo existence                   | **P2**   | `GetRepository({ repositoryName })`, report branch count                      |
| Local vs CodeCommit drift                   | **P2**   | Compare file manifests (building blocks exist in `utils/codecommit.ts`)       |

### Missing Checks (3 valuable)

| Check                                | Priority | What It Should Do                                            |
| ------------------------------------ | -------- | ------------------------------------------------------------ |
| IAM permissions validation           | **P2**   | `SimulatePrincipalPolicy` for minimum required actions       |
| `isengardcli` (environment-specific) | **P3**   | Warn-level check for Amazon environments                     |
| Pipeline execution status            | **P2**   | Last pipeline execution state (succeeded/failed/in-progress) |

---

## 4. Self-Evolution Deep Assessment

### End-to-End Flow Status

```
User asks for new capability
    ↓
Agent designs CDK code              ← PRESENT (LLM generates code)
    ↓
CDK validation                      ← PARTIAL (weak validation in Python path)
    ↓
Safety harness (Cedar + rate limit) ← PRESENT (5 controls)
    ↓
Commit to CodeCommit                ← PRESENT (but IAM blocked at runtime!)
    ↓
Pipeline auto-triggers              ← PRESENT (EventBridge on push)
    ↓
Build + Deploy all stacks           ← PRESENT (cdk deploy --all)
    ↓
Verify deployment succeeded         ← MISSING (no EventBridge rule for pipeline state)
    ↓
Run targeted health checks          ← MISSING (canary only checks ECS metrics)
    ↓
Update capability status            ← MISSING (stays stuck at 'deploying')
    ↓
Notify agent of result              ← MISSING (no push notification)
    ↓
Debug failures in a loop            ← MISSING (no automated retry)
    ↓
Rollback bad changes                ← MISSING (no CodeCommit revert tool)
    ↓
Report success to user              ← MISSING (no feedback channel)
```

### Critical Validation Divergence

Two separate validation layers exist with incompatible coverage:

| Pattern                      | `evolution_tools.py` (Python, **AGENT PATH**) | `self-evolution-orchestrator.ts` (TypeScript) |
| ---------------------------- | --------------------------------------------- | --------------------------------------------- |
| `RemovalPolicy.DESTROY`      | ❌ Not checked                                | ✅ Blocked                                    |
| `addToPolicy` / `grantAdmin` | ❌ Not checked                                | ✅ Blocked                                    |
| `ec2.Vpc` / `SecurityGroup`  | ❌ Not checked                                | ✅ Blocked                                    |
| DynamoDB/S3 deletion         | ❌ Not checked                                | ✅ Blocked                                    |
| `AdministratorAccess`        | ✅ Blocked                                    | ❌ Not checked                                |
| Bare wildcard `"*"`          | ✅ Blocked (bypassable)                       | ❌ Not checked                                |
| Size limit                   | 100KB                                         | 64KB                                          |

The Python path (`evolution_tools.py:_validate_cdk_code`) is what agents actually invoke. The TypeScript orchestrator (`self-evolution-orchestrator.ts:validateCDKCode`) appears to be an independent implementation not called from the agent flow. **The weaker validator is the one that runs.**

### IAM Permission Blocker

`infra/lib/chat-stack.ts:99-164` grants the ECS task role:

- DynamoDB (read/write on 6 tables)
- Bedrock (InvokeModel)
- Secrets Manager (read)
- S3 (read/write on data buckets)
- CloudWatch (put metrics, logs)
- Cloud Map (discover instances)

**Not granted:** `codecommit:*`, `codepipeline:*`, `cloudformation:DescribeStacks`. The agent's `trigger_infra_evolution()` will produce `AccessDeniedException` when calling `codecommit.create_commit()`.

---

## 5. Multi-Tenancy Assessment

### Authentication Vulnerability

**`packages/chat-gateway/src/server.ts:61-63`** applies this middleware chain to `/chat/*`:

```typescript
app.use('/chat/*', optionalAuth, extractTenantContext, rateLimitMiddleware);
```

`optionalAuth` (`middleware/auth.ts:163-196`) validates the JWT **only if present**. Without a JWT, it passes through with no auth context. `extractTenantContext` (`middleware/tenant.ts:66-108`) then reads `tenantId` from the `X-Tenant-Id` header, trusting it without verification.

**Attack vector:** An unauthenticated client sends `POST /chat/stream` with header `X-Tenant-Id: target-tenant-id`. The request is processed with full tenant context, allowing access to the target tenant's agent, tools, and data.

**Fix:** Replace `optionalAuth` with `authenticateJWT` on `/chat/*` routes, or wire in `extractTenantContextWithValidation()` (which already exists at `tenant.ts:116-177` but is not imported by `server.ts`).

### DynamoDB GSI Cross-Tenant Risk

Sessions table GSIs use non-tenant-scoped partition keys:

- `GSI1-agent-activity`: PK = `agentId` (not prefixed with tenantId)
- `GSI2-user-sessions`: PK = `userId` (not prefixed with tenantId)

Without `FilterExpression` on every query, these GSIs can return sessions from any tenant. Application-level enforcement exists in `packages/core/` with test coverage, but it's defense-in-depth at the app layer, not the schema layer.

### API Gateway Lambda Handlers Not Implemented

The API Gateway management routes (`/api/v1/tenants/{tenantId}/*`) reference Lambda handlers in `infra/lambdas/api-handlers/`, but those directories contain no code. All management API endpoints are wired in CDK but have no implementations. This means:

- JWT claim ↔ path parameter enforcement defined in the API stack comment (`api-stack.ts:130-132`) cannot be implemented
- Tenant management operations (CRUD, quota management) are non-functional

---

## 6. EventBridge Self-Verification Assessment

### Complete EventBridge Rule Inventory

| #   | Stack         | Rule                       | Source           | Target         | Deployment-related? |
| --- | ------------- | -------------------------- | ---------------- | -------------- | ------------------- |
| 1   | Orchestration | Agent Task Started         | `chimera.agents` | CW Logs        | No                  |
| 2   | Orchestration | Agent Task Completed       | `chimera.agents` | CW Logs        | No                  |
| 3   | Orchestration | Agent Task Failed          | `chimera.agents` | CW Logs + DLQ  | No                  |
| 4   | Orchestration | Agent Error                | `chimera.agents` | CW Logs        | No                  |
| 5   | Orchestration | Swarm Task Created         | `chimera.agents` | SQS            | No                  |
| 6   | Orchestration | Agent Message              | `chimera.agents` | SQS FIFO       | No                  |
| 7   | Orchestration | Background Task Started    | `chimera.agents` | Step Functions | No                  |
| 8   | Evolution     | Daily Prompt Evolution     | cron (2am)       | Step Functions | No                  |
| 9   | Evolution     | Weekly Skill Generation    | cron (Sun 3am)   | Step Functions | No                  |
| 10  | Evolution     | Daily Memory Evolution     | cron (4am)       | Step Functions | No                  |
| 11  | Evolution     | Hourly Feedback Processing | cron (hourly)    | Step Functions | No                  |
| 12  | Email         | Email Send Request         | `chimera.email`  | SQS            | No                  |

**Zero rules listen for `aws.codepipeline` or `aws.cloudformation` events.** All rules are on the custom `chimera-agents-{env}` event bus; CodePipeline/CloudFormation events are published to the default event bus.

### ADR Contradiction

ADR-008 (`docs/architecture/decisions/`) states: _"ADR-013 (CodePipeline): Pipeline publishes deploy events to EventBridge"_ — this was **never implemented**. The documented intent exists but the codebase does not fulfill it.

### What Would Be Needed

1. **EventBridge rule on default bus** matching `source: ["aws.codepipeline"]`, `detail-type: ["CodePipeline Pipeline Execution State Change"]`, filtered by pipeline name
2. **Target: Lambda function** that:
   - Writes pipeline result (succeeded/failed/stages) to DynamoDB evolution state table
   - Updates any pending capability from `deploying` → `deployed` or `failed`
   - Publishes `chimera.agents/Evolution Deployment Complete` event to custom bus
3. **Target: SQS message** to agent task queue with deployment context (which stacks changed, new endpoints)
4. **Step Functions state machine** for post-deploy CDK resource verification (verify tables, queues, Lambda functions are reachable)

---

## 7. Gap Analysis: Chimera vs OpenClaw Vision

The vision: _"User asks Chimera to build a media ingestion pipeline → agent designs CDK → commits to CodeCommit → pipeline deploys → EventBridge triggers self-verification → agent debugs failures → confirms capability → reports to user"_

| Step                                   | OpenClaw Equivalent | Chimera Status | Evidence                                                   | Gap Classification |
| -------------------------------------- | ------------------- | -------------- | ---------------------------------------------------------- | ------------------ |
| 1. User request via chat               | User interaction    | **PRESENT**    | Chat gateway, SSE streaming, TUI/REPL                      | —                  |
| 2. Agent understands request           | LLM reasoning       | **PRESENT**    | Strands ReAct loop, 20 iterations max                      | —                  |
| 3. Agent designs CDK code              | Code generation     | **PRESENT**    | LLM generates TypeScript CDK code                          | —                  |
| 4. CDK code validation                 | Safety checks       | **PARTIAL**    | `_validate_cdk_code()` exists but weak (SE-3)              | PARTIAL            |
| 5. Safety harness (Cedar + rate limit) | Permission check    | **PRESENT**    | 5-layer safety in `evolution_tools.py:55-149`              | —                  |
| 6. Commit to CodeCommit                | Source push         | **PRESENT**    | `_commit_to_codecommit()` at `evolution_tools.py:501-540`  | —                  |
| 7. IAM allows commit                   | Runtime permissions | **MISSING**    | ECS task role lacks `codecommit:*` (SE-1)                  | **MISSING**        |
| 8. Pipeline auto-triggers              | CI/CD trigger       | **PRESENT**    | `CodeCommitTrigger.EVENTS` at `pipeline-stack.ts:1236`     | —                  |
| 9. Pipeline builds + deploys           | CI/CD deploy        | **PRESENT**    | `cdk deploy --all` at `pipeline-stack.ts:316`              | —                  |
| 10. Quality gates catch bad code       | Build validation    | **BROKEN**     | `\|\| true` on lint/typecheck/tests (SG-1)                 | **BROKEN**         |
| 11. Pipeline completion event          | Deploy notification | **MISSING**    | Zero EventBridge rules for `aws.codepipeline` (SE-2)       | **MISSING**        |
| 12. Agent learns deploy result         | Feedback loop       | **MISSING**    | No push notification; only polling via `waitForPipeline()` | **MISSING**        |
| 13. Post-deploy health check           | Verification        | **MISSING**    | Canary checks ECS only, not CDK resources                  | **MISSING**        |
| 14. Capability status updated          | State tracking      | **MISSING**    | Status stays `deploying` forever (SE-5)                    | **MISSING**        |
| 15. Debug failures in loop             | Self-healing        | **MISSING**    | No automated retry/debug cycle                             | **MISSING**        |
| 16. Rollback bad changes               | Recovery            | **MISSING**    | No CodeCommit revert tool (SE-6)                           | **MISSING**        |
| 17. Report success to user             | User notification   | **MISSING**    | No channel from pipeline → agent → user chat               | **MISSING**        |

**Summary:** Steps 1-6 and 8-9 are implemented. Steps 7 and 10 are broken. Steps 11-17 are entirely missing. The chain breaks at step 7 (IAM permissions) and produces no signal after step 9 (deployment).

**Of the 17 steps in the full self-evolution loop, 7 are present, 2 are broken, 1 is partial, and 7 are missing.**

---

## 8. Prioritized Recommendation Backlog

### P0 — Blockers (Must fix before any self-evolution demo)

**P0-1: Grant CodeCommit/CodePipeline IAM to ECS Task Role**

- **File:** `infra/lib/chat-stack.ts` (after line 164)
- **Action:** Add IAM policy statements:
  ```typescript
  taskRole.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        'codecommit:CreateCommit',
        'codecommit:GetBranch',
        'codecommit:GetRepository',
        'codecommit:GetFile',
        'codecommit:GetFolder',
      ],
      resources: [`arn:aws:codecommit:${this.region}:${this.account}:chimera`],
    })
  );
  taskRole.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        'codepipeline:GetPipelineState',
        'codepipeline:GetPipelineExecution',
        'codepipeline:StartPipelineExecution',
      ],
      resources: [`arn:aws:codepipeline:${this.region}:${this.account}:Chimera-*`],
    })
  );
  taskRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/Chimera-*/*`],
    })
  );
  ```

**P0-2: Fix Buildspec Quality Gates**

- **File:** `buildspec.yml:20-22`
- **Action:** Remove `|| true` from lint, typecheck, and test commands:
  ```yaml
  - bun run lint
  - bun run typecheck
  - bun test --coverage
  ```

**P0-3: Fix `optionalAuth` Tenant Impersonation**

- **File:** `packages/chat-gateway/src/server.ts:61`
- **Action:** Replace `optionalAuth` with `authenticateJWT` on `/chat/*` routes:
  ```typescript
  app.use('/chat/*', authenticateJWT, extractTenantContext, rateLimitMiddleware);
  ```
  Or for development flexibility, use `extractTenantContextWithValidation` (already implemented at `middleware/tenant.ts:116-177`).

**P0-4: Unify CDK Validation Between Python and TypeScript**

- **File:** `packages/agents/tools/evolution_tools.py:468-498`
- **Action:** Add all patterns from `self-evolution-orchestrator.ts:119-126` to `_FORBIDDEN_CDK_PATTERNS`:
  ```python
  _FORBIDDEN_CDK_PATTERNS = [
      ('AdministratorAccess', 'AdministratorAccess policy is forbidden'),
      ('"*"', 'Bare wildcard resource string is forbidden'),
      ("'*'", 'Bare wildcard resource string is forbidden'),
      ('RemovalPolicy.DESTROY', 'RemovalPolicy.DESTROY is forbidden in evolution code'),
      ('addToPolicy', 'IAM policy mutations are forbidden in evolution code'),
      ('grantAdmin', 'IAM admin grants are forbidden in evolution code'),
      ('ec2.Vpc', 'VPC modifications are forbidden in evolution code'),
      ('ec2.CfnVPC', 'VPC modifications are forbidden in evolution code'),
      ('ec2.SecurityGroup', 'Security group modifications are forbidden in evolution code'),
      ('addIngressRule', 'Security group rule modifications are forbidden in evolution code'),
      ('.deleteTable', 'DynamoDB table deletion is forbidden in evolution code'),
      ('.deleteBucket', 'S3 bucket deletion is forbidden in evolution code'),
  ]
  ```
  Also fix the wildcard bypass by removing the `\n` suffix requirement.

### P1 — High Value (Required for functional self-evolution)

**P1-1: Add EventBridge Rule for Pipeline Completion**

- **Stack:** `infra/lib/orchestration-stack.ts` or `infra/lib/evolution-stack.ts`
- **Action:** Create a rule on the **default** event bus:
  ```typescript
  const pipelineRule = new events.Rule(this, 'PipelineCompletionRule', {
    eventPattern: {
      source: ['aws.codepipeline'],
      detailType: ['CodePipeline Pipeline Execution State Change'],
      detail: { pipeline: [props.pipelineName], state: ['SUCCEEDED', 'FAILED'] },
    },
  });
  pipelineRule.addTarget(new targets.LambdaFunction(evolutionNotifierLambda));
  ```
  The Lambda target should:
  - Update DynamoDB evolution record status from `deploying` → `deployed`/`failed`
  - Publish `chimera.agents/Evolution Deployment Complete` event to custom bus

**P1-2: Implement Post-Deploy CDK Verification Lambda**

- **Action:** Create a Lambda that, on pipeline success, verifies:
  - All expected CloudFormation stacks are in `*_COMPLETE` status
  - Key resources are reachable (DynamoDB table describe, SQS queue attributes, Lambda invoke dry-run)
  - Cloud Map service instances are registered
- **Trigger:** EventBridge rule from P1-1

**P1-3: Implement `waitForPipeline` Integration in Agent Flow**

- **File:** `packages/agents/tools/evolution_tools.py`
- **Action:** Add a `wait_for_evolution_deployment` tool that:
  - Accepts an evolution ID
  - Polls DynamoDB evolution record status (updated by P1-1 Lambda)
  - Returns deployment result with stack statuses
  - Has configurable timeout (default 15 minutes)

**P1-4: Add Doctor Checks for CDK Bootstrap + Credential Validation**

- **File:** `packages/cli/src/commands/doctor.ts`
- **Action:** Add:
  - `checkAwsCredentialValidity()` — `STS.GetCallerIdentity` call
  - `checkCdkBootstrap()` — `DescribeStacks({ StackName: 'CDKToolkit' })`
  - `checkNodeResolution()` — `node --version` + `npx cdk --version`
  - `checkCodeCommitRepo()` — `GetRepository` for configured repo name

**P1-5: Add Branch Protection for Agent Commits**

- **Action:** Modify `trigger_infra_evolution` to commit to `agent/evolution-{timestamp}` branch instead of `main`. Create a Lambda-backed approval gate that validates the commit before merging to `main`.
- **Alternative (simpler):** Add a CodePipeline manual approval step before the Deploy stage, triggered only when the commit author is `Chimera Self-Evolution Agent`.

**P1-6: Implement `chimera diff` Command**

- **Action:** New CLI command that fetches CodeCommit files via `getFilesFromCodeCommit()` (already in `utils/codecommit.ts`), compares with local filesystem, and displays a unified diff.
- **Building blocks exist:** `collectFiles()` and `getFilesFromCodeCommit()` in `utils/codecommit.ts`.

### P2 — Improvements

| #     | Recommendation                                    | File                     | Action                                             |
| ----- | ------------------------------------------------- | ------------------------ | -------------------------------------------------- |
| P2-1  | Add CodeCommit repo name to Cloud Map             | `discovery-stack.ts`     | Add `repositoryName` attribute to pipeline service |
| P2-2  | `chimera trigger` command                         | CLI                      | Call `StartPipelineExecution` for manual re-runs   |
| P2-3  | Fix sync to show diffs before overwrite           | `sync.ts`                | Compute file diff before confirmation prompt       |
| P2-4  | Add `deleteFiles` support to CodeCommit push      | `codecommit.ts`          | Track deleted files, include in `CreateCommit`     |
| P2-5  | CloudWatch alarm for pipeline execution failures  | `observability-stack.ts` | `codepipeline:ExecutionFailed` metric alarm        |
| P2-6  | Per-tenant API Gateway rate limiting              | `api-stack.ts`           | Usage plans with API keys per tenant tier          |
| P2-7  | Remove dead `/auth/register` endpoint             | `auth.ts:252`            | Delete or add explicit 501 response                |
| P2-8  | Add `bun install --frozen-lockfile` to test stage | `pipeline-stack.ts:477`  | Prevent dependency drift during test               |
| P2-9  | Remove `GatewayRegistration` from destroy order   | `destroy.ts:218-233`     | Align with actual stack set in `chimera.ts`        |
| P2-10 | Align status command stack list with chimera.ts   | `status.ts:62`           | Add Frontend, Email, Discovery to sort order       |

---

## 9. Minimal Path to Self-Evolution Demo

**Goal:** Demonstrate "user asks Chimera to set up a media ingestion pipeline → Chimera designs CDK, deploys it, verifies it works, and reports back."

### Phase 1: Unblock the Chain (estimated: 2-3 days)

1. **Fix P0-1:** Grant CodeCommit + CodePipeline IAM permissions to ECS task role in `chat-stack.ts`
2. **Fix P0-2:** Remove `|| true` from `buildspec.yml`
3. **Fix P0-4:** Unify CDK validation patterns in `evolution_tools.py`
4. **Deploy the fix:** Push to CodeCommit → Pipeline deploys updated Chat stack with new IAM permissions

### Phase 2: Close the Feedback Loop (estimated: 3-5 days)

5. **Implement P1-1:** EventBridge rule on default bus for pipeline completion → Lambda that updates DynamoDB evolution record status
6. **Implement P1-3:** `wait_for_evolution_deployment` tool that polls evolution record status
7. **Add basic post-deploy verification:** Lambda checks CloudFormation stack statuses after deployment completes

### Phase 3: Wire the Demo (estimated: 2-3 days)

8. **Create a demo prompt:** System prompt that teaches the agent to:
   - Parse a capability request (e.g., "media ingestion pipeline")
   - Generate CDK code for the capability (S3 bucket + Lambda + SQS queue + EventBridge rule)
   - Call `trigger_infra_evolution` with the generated code
   - Call `wait_for_evolution_deployment` to wait for deployment
   - Check stack status via `check_evolution_status`
   - Report result to user

9. **Test end-to-end:** User sends "set up a media ingestion pipeline" via `chimera chat` → agent generates CDK for S3 + Lambda + SQS → commits to CodeCommit → pipeline deploys → agent confirms deployment → reports to user.

**Minimum viable items for the demo: P0-1, P0-2, P0-4, P1-1, P1-3.** Total estimated effort: 7-11 days.

---

## 10. Architecture Evolution Roadmap

### Phase 1: Foundation Fixes (Weeks 1-2)

| Item                                 | Priority | Effort  | Description                                                |
| ------------------------------------ | -------- | ------- | ---------------------------------------------------------- |
| ECS IAM permissions                  | P0       | 0.5 day | Grant CodeCommit/CodePipeline access to task role          |
| Buildspec quality gates              | P0       | 0.5 day | Remove `\|\| true`, fail builds on quality issues          |
| Chat auth fix                        | P0       | 0.5 day | Replace `optionalAuth` with `authenticateJWT` on `/chat/*` |
| CDK validation unification           | P0       | 1 day   | Merge all forbidden patterns, fix wildcard bypass          |
| Doctor command enhancement           | P1       | 2 days  | Add STS validation, CDK bootstrap, CodeCommit, node checks |
| Pipeline completion EventBridge rule | P1       | 2 days  | Rule on default bus → Lambda → DynamoDB status update      |

### Phase 2: Self-Evolution MVP (Weeks 3-5)

| Item                                 | Priority | Effort | Description                                       |
| ------------------------------------ | -------- | ------ | ------------------------------------------------- |
| `wait_for_evolution_deployment` tool | P1       | 2 days | Polls evolution record, returns deploy result     |
| Post-deploy CDK verification Lambda  | P1       | 3 days | Verifies stacks, resources, Cloud Map entries     |
| Agent commit branch protection       | P1       | 3 days | `agent/evolution-*` branches with validation gate |
| `chimera diff` command               | P1       | 2 days | CodeCommit vs local diff (building blocks exist)  |
| Capability status lifecycle          | P1       | 1 day  | `deploying` → `deployed`/`failed` transition      |
| CodeCommit revert tool               | P1       | 2 days | Revert a commit by SHA                            |
| `chimera trigger` command            | P2       | 1 day  | Manual pipeline execution trigger                 |

### Phase 3: Production Hardening (Weeks 6-8)

| Item                                 | Priority | Effort | Description                                                                    |
| ------------------------------------ | -------- | ------ | ------------------------------------------------------------------------------ |
| Pipeline failure alarms              | P2       | 1 day  | CloudWatch alarms for execution failures                                       |
| Agent notification via SSE           | P2       | 3 days | EventBridge → SQS → agent → SSE push to user                                   |
| Sync command with diff/merge         | P2       | 3 days | Show diffs, detect conflicts, selective sync                                   |
| Per-tenant API Gateway rate limiting | P2       | 2 days | Usage plans with tier-based throttling                                         |
| Lambda API handlers                  | P1       | 5 days | Implement management API for tenants, sessions, skills                         |
| CDK synth validation before commit   | P2       | 2 days | Run `cdk synth` in sandbox before committing                                   |
| Self-evolution debug loop            | P2       | 5 days | Step Functions: deploy → verify → retry on failure → rollback after 3 attempts |
| Horizontal stream scalability        | P2       | 3 days | Move StreamManager to Redis/DynamoDB for multi-task ECS                        |

**Total estimated effort to reach full self-evolution capability: 10-12 weeks.**

---

## Appendix: Files Referenced

| File                                                         | Lines           | Key Content                                |
| ------------------------------------------------------------ | --------------- | ------------------------------------------ |
| `infra/lib/chat-stack.ts`                                    | 99-164          | ECS task role (missing CodeCommit IAM)     |
| `infra/lib/pipeline-stack.ts`                                | 316, 1225, 1236 | Deploy stage, self-update, trigger         |
| `infra/lib/evolution-stack.ts`                               | 1-1273          | 7 Lambdas, 4 Step Functions, 4 cron rules  |
| `infra/lib/discovery-stack.ts`                               | 158-168         | Pipeline name in Cloud Map                 |
| `infra/lib/orchestration-stack.ts`                           | 107-713         | 7 EventBridge rules (agent lifecycle only) |
| `infra/lib/security-stack.ts`                                | 73-164          | Cognito User Pool configuration            |
| `infra/lib/data-stack.ts`                                    | 57-191          | 6 DynamoDB tables with tenant-scoped PKs   |
| `infra/lib/api-stack.ts`                                     | 130-399         | JWT authorizer, WAF, tenant routes         |
| `infra/lib/frontend-stack.ts`                                | 40-184          | CloudFront + S3 SPA hosting                |
| `infra/lib/observability-stack.ts`                           | 253-748         | Alarms (no deployment-specific)            |
| `packages/agents/tools/evolution_tools.py`                   | 40-609          | Self-evolution tools (weak validation)     |
| `packages/agents/tools/codecommit_tools.py`                  | 15-306          | CodeCommit SDK tools                       |
| `packages/agents/tools/codepipeline_tools.py`                | 96-248          | Pipeline status/trigger tools              |
| `packages/agents/gateway_config.py`                          | 31-135          | Tier-gated tool registry                   |
| `packages/core/src/evolution/self-evolution-orchestrator.ts` | 162-526         | TypeScript orchestrator (disconnected)     |
| `packages/chat-gateway/src/server.ts`                        | 61-63           | `optionalAuth` vulnerability               |
| `packages/chat-gateway/src/middleware/auth.ts`               | 57-196          | JWT + optional auth                        |
| `packages/chat-gateway/src/middleware/tenant.ts`             | 66-177          | Tenant context extraction                  |
| `packages/chat-gateway/src/stream-manager.ts`                | 31-67           | Tenant-scoped SSE streams                  |
| `packages/cli/src/commands/doctor.ts`                        | 1-294           | Health checks (5/8 missing)                |
| `packages/cli/src/commands/deploy.ts`                        | 329-366         | Bootstrap deploy (Pipeline only)           |
| `packages/cli/src/commands/destroy.ts`                       | 218-646         | Destroy order + redeploy                   |
| `packages/cli/src/commands/sync.ts`                          | —               | Naive bidirectional sync                   |
| `packages/cli/src/utils/codecommit.ts`                       | 47-255          | Push/pull utilities                        |
| `buildspec.yml`                                              | 20-22           | `\|\| true` quality gate bypass            |
| `docs/architecture/system-architecture.md`                   | 173-209         | Self-evolution vision diagram              |
| `docs/architecture/cli-lifecycle.md`                         | 65-118          | Bootstrap workflow documentation           |

---

_Review completed: 2026-04-02 | Reviewer: architecture-review-agent | Scope: Full codebase_
