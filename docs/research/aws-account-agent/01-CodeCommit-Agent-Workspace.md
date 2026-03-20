# CodeCommit as Agent Workspace: Git-Based Infrastructure Filesystem

**Status:** Research
**Version:** 1.0
**Last Updated:** 2026-03-20
**Author:** builder-infra-plumbing
**Parent:** [00-Infrastructure-Capability-Index.md](./00-Infrastructure-Capability-Index.md)

---

## Overview

Traditional agent platforms treat infrastructure code as **static configuration** written by humans. AWS Chimera inverts this: **CodeCommit is the agent's persistent filesystem** for Infrastructure-as-Code (IaC).

Agents interact with CodeCommit the same way developers do:
- **Clone** repositories to understand current infrastructure state
- **Create branches** for proposed infrastructure changes
- **Commit** generated CDK TypeScript or CloudFormation templates
- **Merge** via fast-forward or pull requests (based on Cedar policy)
- **Rollback** by reverting Git commits (full audit trail preserved)

This document explores the architectural patterns, implementation details, and safety mechanisms that make CodeCommit a safe and auditable agent workspace.

---

## Why Git for Agent-Generated Infrastructure?

### Traditional Approach: Stateless API Calls

Most agent platforms modify infrastructure via **direct API calls**:

```python
# Typical agent pseudocode
ec2.run_instances(InstanceType='t3.medium', ...)
dynamodb.update_table(BillingMode='PAY_PER_REQUEST')
lambda.update_function_code(ZipFile=code_bytes)
```

**Problems:**
- ❌ **No audit trail** — Who made the change? When? Why? (CloudTrail logs expire)
- ❌ **No review process** — Changes applied immediately without human oversight
- ❌ **Hard to rollback** — Must manually reverse each API call (error-prone)
- ❌ **No diff visibility** — Can't see what changed before applying
- ❌ **No collaboration** — Multiple agents can't coordinate on shared infrastructure

### Git-Based Approach: Agent Commits IaC

Chimera agents interact with **CodeCommit as a version-controlled filesystem**:

```typescript
// Agent generates CDK code
const iacDiff = this.generateCDKDiff(proposal);

// Create feature branch
await codecommit.send(new CreateBranchCommand({
  repositoryName: 'chimera-infrastructure',
  branchName: `evolution/${tenantId}/add-video-pipeline-${Date.now()}`,
  commitId: mainHead,
}));

// Commit IaC changes
await codecommit.send(new PutFileCommand({
  repositoryName: 'chimera-infrastructure',
  branchName: `evolution/${tenantId}/add-video-pipeline-${Date.now()}`,
  fileContent: Buffer.from(iacDiff),
  filePath: `tenants/${tenantId}/video-pipeline.ts`,
  commitMessage: `[evolution] Add video processing pipeline for tenant ${tenantId}`,
}));

// Auto-merge or create PR based on Cedar policy
if (cedarDecision === 'ALLOW') {
  await codecommit.send(new MergeBranchesByFastForwardCommand({
    sourceCommitSpecifier: branchName,
    destinationCommitSpecifier: 'main',
  }));
}
```

**Benefits:**
- ✅ **Full audit trail** — Git history shows who, what, when, why (retained forever)
- ✅ **Review gates** — Pull requests for high-risk changes (human approval workflow)
- ✅ **Easy rollback** — `git revert` to undo infrastructure changes
- ✅ **Clear diffs** — See exact IaC changes before deployment
- ✅ **Agent collaboration** — Multiple agents can work on same repository (branch isolation)

---

## Repository Structure

Chimera uses a **mono-repository** with per-tenant isolation:

```
chimera-infrastructure/
├── tenants/
│   ├── acme-corp/
│   │   ├── main-stack.ts          # Core tenant infrastructure
│   │   ├── video-pipeline.ts      # Agent-provisioned video processing
│   │   ├── search-cluster.ts      # Agent-provisioned OpenSearch
│   │   └── config.json            # Tenant-specific configuration
│   ├── globex-inc/
│   │   ├── main-stack.ts
│   │   └── data-lake.ts
│   └── ...
├── shared/
│   ├── networking/
│   │   ├── vpc-stack.ts           # Shared VPC for all tenants
│   │   └── transit-gateway.ts
│   ├── observability/
│   │   └── cloudwatch-stack.ts    # Cross-tenant monitoring
│   └── security/
│       ├── kms-keys.ts            # Per-tenant encryption keys
│       └── cedar-policies/        # Authorization policies
├── infra/
│   ├── bin/
│   │   └── app.ts                 # CDK app entry point
│   ├── lib/
│   │   ├── pipeline-stack.ts      # CI/CD infrastructure
│   │   └── tenant-stack.ts        # L3 construct for tenant isolation
│   └── cdk.json
├── .pre-commit-config.yaml        # Security scans (cdk-nag, Checkov)
└── README.md
```

### Path Conventions

| Path Pattern | Ownership | Change Frequency | Example |
|--------------|-----------|------------------|---------|
| `tenants/{id}/` | Tenant-scoped agent | High (daily) | `tenants/acme-corp/video-pipeline.ts` |
| `shared/` | Platform admin only | Low (weekly) | `shared/networking/vpc-stack.ts` |
| `infra/` | Infrastructure team | Low (monthly) | `infra/lib/pipeline-stack.ts` |

**Access control:**
- Agents have **read-all, write-tenant** permissions (Cedar enforced)
- Agents can read `shared/` to understand dependencies (e.g., VPC CIDR blocks)
- Agents **cannot** modify `shared/` or `infra/` (requires human PR review)

---

## Branch Strategy

Chimera agents use **short-lived feature branches** with automated merge policies.

### Branch Naming Convention

```
evolution/{tenant-id}/{change-type}-{timestamp}
```

Examples:
- `evolution/acme-corp/scale_horizontal-1710950400000`
- `evolution/globex-inc/add_tool-1710954000000`
- `evolution/acme-corp/update_env_var-1710957600000`

**Rationale:**
- `evolution/` prefix distinguishes agent branches from human branches (`feature/`, `bugfix/`)
- `{tenant-id}` enables fast filtering (`git branch --list 'evolution/acme-corp/*'`)
- `{change-type}` communicates intent without reading commit message
- `{timestamp}` ensures uniqueness (multiple agents may work concurrently)

### Merge Strategies

Chimera uses **three merge strategies** based on Cedar policy decision:

#### 1. Fast-Forward Merge (Auto-Apply)

**When:** Cedar returns `ALLOW` (low-risk, bounded changes)

```typescript
await codecommit.send(new MergeBranchesByFastForwardCommand({
  repositoryName: 'chimera-infrastructure',
  sourceCommitSpecifier: branchName,
  destinationCommitSpecifier: 'main',
  fastForwardMode: 'FAST_FORWARD_ONLY',
}));
```

**Triggers CodePipeline immediately** via webhook.

**Use cases:**
- Scaling ECS tasks from 2 → 4 (within quota)
- Updating non-secret environment variables
- Rotating Secrets Manager credentials

#### 2. Pull Request + Human Review

**When:** Cedar returns `DENY` with `reason: "human_approval_required"`

```typescript
const pr = await codecommit.send(new CreatePullRequestCommand({
  title: `[Evolution] ${proposal.changeDescription}`,
  description: `
Auto-generated by evolution engine.

**Tenant:** ${tenantId}
**Change type:** ${proposal.changeType}
**Cedar decision:** DENY (requires human approval)
**Estimated cost impact:** $${proposal.estimatedMonthlyCostDelta}/month

### Generated CDK Diff
\`\`\`diff
${iacDiff}
\`\`\`

### Safety Checks
- [x] cdk-nag scan passed
- [x] Checkov security scan passed
- [x] No dangerous operations detected

**Reviewer:** Please verify cost estimate and tenant quota limits before approving.
  `,
  targets: [{
    repositoryName: 'chimera-infrastructure',
    sourceReference: branchName,
    destinationReference: 'main',
  }],
}));
```

**Manual merge triggers CodePipeline** after approval.

**Use cases:**
- Cost delta >$100/month
- First-time infrastructure provisioning for tenant
- Modifications to shared resources (VPC, KMS keys)

#### 3. Branch Rejected (Block)

**When:** Cedar returns `DENY` with dangerous operation detected

```typescript
// Branch created but NOT merged
// Agent receives error response
return {
  status: 'denied',
  cedarDecision: 'DENY',
  changeType: proposal.changeType,
  reason: 'Dangerous operation: delete_table (data loss risk)',
};
```

**Branch remains in repository** for audit purposes (never merged).

**Use cases:**
- Dropping DynamoDB tables
- Deleting S3 buckets with versioned data
- Modifying IAM roles (privilege escalation risk)
- Changing VPC security groups (network boundary violation)

---

## Commit Message Standards

Agent-generated commits follow **Conventional Commits** format with evolution metadata:

```
[evolution] <type>(<scope>): <description>

<body>

Evolution-Metadata:
- Tenant: <tenant-id>
- Agent: <agent-id>
- Change-Type: <iac-change-type>
- Cedar-Decision: <ALLOW|DENY>
- Cost-Delta: $<monthly-cost-change>
- Initiated-By: <user-id|system>
```

**Example:**

```
[evolution] feat(tenants/acme-corp): add video processing pipeline

Provisions S3 bucket, MediaConvert job template, Lambda processor,
and DynamoDB metadata table for video upload workflow.

User request: "I need to process uploaded videos: generate thumbnails,
extract audio, store metadata"

Evolution-Metadata:
- Tenant: acme-corp
- Agent: chimera-agent-runtime-7f3a
- Change-Type: add_tool
- Cedar-Decision: ALLOW
- Cost-Delta: $120.00
- Initiated-By: user-8fa2
```

**Metadata enables:**
- Cost attribution per tenant (`git log --grep "Tenant: acme-corp"`)
- Rollback automation (Cedar can auto-revert if health score drops)
- Audit compliance (SOC 2, HIPAA: "Who provisioned this RDS instance?")

---

## Pre-Commit Hooks: Security Scans

Before any merge (fast-forward or PR), **pre-commit hooks** run security validation:

### 1. cdk-nag

AWS CDK security scanner that enforces best practices:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: local
    hooks:
      - id: cdk-nag
        name: CDK Security Scan
        entry: npx cdk-nag
        language: system
        pass_filenames: false
        files: \.ts$
```

**Checks:**
- S3 buckets have encryption enabled
- DynamoDB tables use customer-managed KMS keys
- Lambda functions have VPC access (no public internet)
- IAM roles follow least-privilege principle
- Security groups don't allow 0.0.0.0/0 ingress

**Blocking errors:**
- Unencrypted S3 bucket → ❌ Merge blocked
- Lambda with wildcard IAM permissions → ❌ Merge blocked
- RDS instance without backup enabled → ❌ Merge blocked

### 2. Checkov

Static analysis for infrastructure code:

```yaml
  - repo: https://github.com/bridgecrewio/checkov
    hooks:
      - id: checkov
        args:
          - --framework=cloudformation
          - --framework=terraform
          - --skip-check=CKV_AWS_18  # Example: skip specific check
```

**Checks:**
- CloudFormation templates follow AWS Well-Architected Framework
- No hardcoded secrets or API keys
- Resource tags include required fields (`Environment`, `Owner`, `CostCenter`)

### 3. Custom Cedar Policy Validator

Chimera-specific hook that simulates Cedar evaluation:

```typescript
// .pre-commit-hooks/cedar-validator.ts
export async function validateCedarPolicy(
  tenantId: string,
  changeType: IaCChangeType,
  iacDiff: string
): Promise<{ passed: boolean; reason?: string }> {
  // Parse CDK diff to extract resource changes
  const resources = parseCDKDiff(iacDiff);

  // Count estimated cost delta
  const costDelta = estimateCostFromResources(resources);

  // Simulate Cedar evaluation (offline)
  const decision = await cedarClient.evaluate({
    principal: `TenantAgents::"${tenantId}"`,
    action: `InfraAction::"${changeType}"`,
    resource: `TenantResources::"${tenantId}"`,
    context: { estimatedMonthlyCostDelta: costDelta },
  });

  if (decision === 'DENY') {
    return {
      passed: false,
      reason: 'Cedar policy would deny this change in production',
    };
  }

  return { passed: true };
}
```

**Why simulate Cedar pre-commit?**
Catches policy violations **before** agent attempts merge, reducing failed operations.

---

## Audit Trail and Forensics

Git provides **immutable audit trail** for all infrastructure changes.

### Query Examples

#### 1. "Who provisioned this S3 bucket?"

```bash
git log --all --grep "s3://chimera-video-uploads-acme-corp" --pretty=format:"%H %an %ae %ad %s"
```

**Output:**
```
a3f7e2c Agent chimera-agent@system 2026-03-15 [evolution] feat(tenants/acme-corp): add video processing pipeline
```

#### 2. "What infrastructure changed in the last 7 days?"

```bash
git log --since="7 days ago" --pretty=oneline --grep "\[evolution\]"
```

**Output:**
```
a3f7e2c [evolution] feat(tenants/acme-corp): add video processing pipeline
8d4f1b9 [evolution] feat(tenants/globex-inc): scale OpenSearch cluster to 3 nodes
2c9e5a7 [evolution] chore(tenants/acme-corp): rotate RDS master password
```

#### 3. "Show cost breakdown by tenant for March 2026"

```bash
git log --since="2026-03-01" --until="2026-03-31" --grep "Tenant:" --grep "Cost-Delta:" |
  awk '/Tenant:/ {tenant=$2} /Cost-Delta:/ {print tenant, $2}' |
  awk '{sum[$1]+=$2} END {for (t in sum) print t, sum[t]}'
```

**Output:**
```
acme-corp $450.00
globex-inc $320.00
initech $180.00
```

#### 4. "Which changes were auto-applied vs human-reviewed?"

```bash
git log --grep "Cedar-Decision:" --pretty=format:"%s %b" |
  grep -A1 "Cedar-Decision" |
  awk '/ALLOW/ {auto++} /DENY/ {manual++} END {print "Auto:", auto, "Manual:", manual}'
```

**Output:**
```
Auto: 47 Manual: 12
```

---

## Rollback Strategies

Git-based infrastructure enables **three rollback mechanisms**.

### 1. Automatic Rollback (CloudWatch Alarms)

When canary deployment triggers alarms (error rate >5%, latency >2x baseline), **Step Functions invokes rollback Lambda**:

```python
# Lambda: rollback-infrastructure
def handler(event, context):
    repo = 'chimera-infrastructure'
    failed_commit = event['failedCommitId']

    # Find the commit that deployed the failed change
    git.checkout('main')
    git.revert(failed_commit, no_commit=True)

    # Create rollback branch
    branch = f"rollback/{failed_commit[:8]}-{int(time.time())}"
    git.checkout('-b', branch)
    git.commit('-m', f'[rollback] Revert {failed_commit} due to canary failure')

    # Auto-merge rollback (always ALLOW)
    git.push('origin', branch)
    codecommit.merge_branches(source=branch, destination='main')

    return {'status': 'ROLLBACK_COMPLETE'}
```

**Triggers:**
- Canary bake validation fails
- Progressive rollout stage exceeds error threshold
- Post-deployment synthetic monitoring detects regressions

### 2. Manual Rollback (Human-Initiated)

Operations team can rollback via **evolution API**:

```bash
curl -X POST https://api.chimera.aws/v1/evolution/rollback \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "tenantId": "acme-corp",
    "commitId": "a3f7e2c",
    "reason": "Video pipeline causing S3 PutObject rate limit errors"
  }'
```

**API handler:**
1. Verify caller has `evolution:rollback` permission (IAM)
2. Check commit is in `tenants/{tenant-id}/` path (scope validation)
3. Create rollback branch with `git revert`
4. Auto-merge (rollbacks always bypass Cedar for emergency remediation)
5. Trigger CodePipeline with `--skip-canary` flag (immediate deployment)

### 3. Time-Travel Rollback (Full State Restore)

For catastrophic failures, restore **entire tenant infrastructure** to known-good commit:

```bash
# Checkout tenant directory at specific commit
git checkout a3f7e2c -- tenants/acme-corp/

# Commit restored state
git commit -m "[rollback] Restore acme-corp to commit a3f7e2c"

# Deploy via pipeline
git push origin main
```

**Use case:** Agent provisioned conflicting resources causing cascading failures.

---

## Collaboration Between Multiple Agents

When **multiple agents** propose infrastructure changes concurrently, CodeCommit handles coordination via **branch isolation + merge conflicts**.

### Scenario: Two Agents Scale the Same ECS Service

**Agent A:** Scale from 2 → 4 tasks (branch: `evolution/acme/scale-17109504000000`)
**Agent B:** Scale from 2 → 6 tasks (branch: `evolution/acme/scale-17109504001000`)

#### Without Coordination (Merge Conflict)

```
Agent A commits:
  desiredCount: 4

Agent B commits:
  desiredCount: 6

Agent A merges first → main has desiredCount: 4
Agent B attempts merge → CONFLICT
```

**Resolution:** Agent B's merge fails with:
```
MergeBranchesByFastForwardException:
  "Cannot fast-forward: branch evolution/acme/scale-17109504001000
   diverged from main"
```

Agent B must **rebase on main** and regenerate CDK diff:

```typescript
// Agent B detects merge failure
catch (MergeBranchesByFastForwardException e) {
  // Fetch latest main
  const latestMain = await codecommit.getBranch('main');

  // Regenerate CDK diff based on new baseline (desiredCount: 4 → 6)
  const updatedDiff = this.generateCDKDiff({
    ...proposal,
    currentDesiredCount: 4, // not 2
  });

  // Create new branch from latest main
  const newBranch = `evolution/acme/scale-${Date.now()}`;
  await codecommit.createBranch(newBranch, latestMain.commitId);
  await codecommit.putFile(newBranch, updatedDiff);

  // Retry merge
  await codecommit.mergeBranches(newBranch, 'main');
}
```

**Result:** Final state has `desiredCount: 6` (Agent B's desired outcome preserved).

### Scenario: Two Agents Add Different Tools

**Agent A:** Adds video pipeline (branch: `evolution/acme/add-video-17109504000000`)
**Agent B:** Adds search cluster (branch: `evolution/acme/add-search-17109504001000`)

#### Parallel Merge (No Conflict)

```
Agent A commits: tenants/acme-corp/video-pipeline.ts (new file)
Agent B commits: tenants/acme-corp/search-cluster.ts (new file)
```

**Both agents merge successfully** because files don't overlap:

```
main (after Agent A merge):
  tenants/acme-corp/
    ├── main-stack.ts
    └── video-pipeline.ts  ← new

main (after Agent B merge):
  tenants/acme-corp/
    ├── main-stack.ts
    ├── video-pipeline.ts
    └── search-cluster.ts  ← new
```

**No coordination required** — Git handles parallel non-conflicting changes automatically.

---

## Comparison with Other Agent Platforms

| Platform | Agent Workspace | Version Control | Rollback | Audit Trail |
|----------|----------------|------------------|----------|-------------|
| **Chimera** | CodeCommit (Git) | ✅ Full Git history | ✅ `git revert` + auto-rollback | ✅ Immutable commit log |
| **LangGraph Cloud** | Ephemeral container filesystem | ❌ None | ❌ Must redeploy previous image | ⚠️ CloudWatch logs only (90d TTL) |
| **AutoGPT** | Local `.auto-gpt/workspace/` | ❌ None | ❌ Manual file restore | ❌ None |
| **Vertex AI Agent Builder** | Firestore documents | ⚠️ Document history (if enabled) | ⚠️ Restore previous document | ⚠️ Cloud Audit Logs (400d retention) |
| **Terraform Cloud (Runs API)** | VCS integration (GitHub, GitLab) | ✅ Full Git history | ✅ `terraform destroy` + plan rollback | ✅ API audit logs |

**Chimera advantage:** Only platform where **agents commit directly to Git** (not just humans triggering runs via VCS webhooks).

---

## Security Considerations

### 1. Branch Protection Rules

CodeCommit enforces **protected branch rules** on `main`:

```yaml
# Protected branch: main
rules:
  - RequireSignedCommits: true
  - RequirePullRequestReviews:
      RequiredApprovingReviewCount: 1  # For DENY changes only
  - RestrictPushes:
      AllowedPrincipals:
        - arn:aws:iam::123456789012:role/ChimeraEvolutionRole
  - PreventForcePush: true
  - PreventDeletion: true
```

**Agents cannot:**
- Force-push to overwrite history
- Delete `main` branch
- Push unsigned commits (KMS-signed via IAM role)

### 2. IAM Least-Privilege

Evolution service uses **scoped IAM permissions**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "codecommit:GetBranch",
        "codecommit:CreateBranch",
        "codecommit:PutFile",
        "codecommit:MergeBranchesByFastForward",
        "codecommit:CreatePullRequest"
      ],
      "Resource": "arn:aws:codecommit:us-east-1:123456789012:chimera-infrastructure",
      "Condition": {
        "StringLike": {
          "codecommit:References": [
            "refs/heads/evolution/*",
            "refs/heads/main"
          ]
        }
      }
    },
    {
      "Effect": "Deny",
      "Action": [
        "codecommit:DeleteBranch",
        "codecommit:DeleteRepository"
      ],
      "Resource": "*"
    }
  ]
}
```

**Key restrictions:**
- Can only create branches under `evolution/*` prefix
- Cannot delete branches or repository
- Cannot push to `shared/` or `infra/` paths (enforced by CodeCommit path-based permissions)

### 3. Secrets Management

Agents **never commit secrets** to Git:

```typescript
// ❌ WRONG: Hardcoded secret
const dbPassword = 'super-secret-123';

// ✅ CORRECT: Reference Secrets Manager
const dbPasswordSecret = secretsmanager.Secret.fromSecretNameV2(
  stack,
  'DBPassword',
  `chimera/${tenantId}/db-password`
);
```

Pre-commit hook detects hardcoded secrets:

```yaml
  - repo: https://github.com/trufflesecurity/trufflehog
    hooks:
      - id: trufflehog
        args: ['git', 'file://']
```

**Blocking patterns:**
- AWS access keys (`AKIA...`)
- API keys (regex: `api[_-]?key\s*[:=]\s*['"][^'"]+['"]`)
- Private keys (`-----BEGIN RSA PRIVATE KEY-----`)

---

## Performance Considerations

### CodeCommit API Rate Limits

| Operation | Rate Limit | Burst Capacity |
|-----------|------------|----------------|
| GetBranch | 60 TPS | 120 |
| CreateBranch | 10 TPS | 20 |
| PutFile | 10 TPS | 20 |
| MergeBranches | 5 TPS | 10 |
| CreatePullRequest | 5 TPS | 10 |

**Mitigation:**
- **Batch commits** — Multiple file changes in single `PutFile` call (up to 6 MB)
- **Queue agent requests** — SQS FIFO queue throttles merge attempts to <5 TPS
- **Exponential backoff** — Retry failed merges with jitter (AWS SDK default)

### Large Repository Size

After 12 months, `chimera-infrastructure` may grow to **10 GB** (1000 tenants × 10 MB average).

**Optimization:**
- **Shallow clones** — Agents clone `--depth=1` (skip full history)
- **Sparse checkouts** — Only fetch `tenants/{tenant-id}/` path:

```bash
git clone --depth=1 --no-checkout https://git-codecommit.us-east-1.amazonaws.com/v1/repos/chimera-infrastructure
git sparse-checkout set tenants/acme-corp/
git checkout main
```

- **LFS for large files** — Store CDK `.zip` artifacts (Lambda code) in Git LFS (not inline)

---

## Future Enhancements

### 1. Agent-to-Agent Code Review

Enable agents to **review each other's PRs** before human approval:

```
Agent A creates PR → Agent B reviews IaC diff → Agent B comments:
  "WARNING: S3 bucket lacks lifecycle policy. Estimated cost: $500/month for 1 TB/month."

Agent A updates PR → Adds lifecycle rule → Agent B approves → Human reviews → Merge
```

**Implementation:** Wire GitHub/CodeCommit webhook to Bedrock Agent → Agent analyzes diff → Comments via API.

### 2. Infrastructure Diffing UI

Visual diff viewer for non-technical stakeholders:

```
Before (baseline):          After (proposed):
┌───────────────────┐      ┌───────────────────┐
│ ECS Service       │      │ ECS Service       │
│ - Tasks: 2        │  ->  │ - Tasks: 4        │
│ - CPU: 512        │      │ - CPU: 512        │
└───────────────────┘      └───────────────────┘

Estimated cost change: +$60/month
```

**Implementation:** Parse CDK diff output → Render React UI → Embed in CodeCommit PR view.

### 3. Multi-Repo Support

Large enterprises may want **per-tenant repositories** (not mono-repo):

```
chimera-infrastructure-acme-corp/
chimera-infrastructure-globex-inc/
chimera-infrastructure-initech/
```

**Trade-offs:**
- ✅ Stronger isolation (separate IAM policies, audit logs)
- ✅ Smaller repo size (faster clones)
- ❌ Cross-tenant shared resources harder to manage
- ❌ More CodePipeline pipelines (higher cost)

---

## Conclusion

CodeCommit as agent workspace provides **Git-native infrastructure management** with:
- **Full audit trail** via immutable commit history
- **Review gates** for high-risk changes (Cedar policy + pull requests)
- **Easy rollback** via `git revert` or time-travel restore
- **Agent collaboration** through branch isolation and merge conflict resolution

This pattern makes Chimera the **only agent platform where infrastructure is treated as version-controlled code** by both humans and AI agents.

---

**See also:**
- [00-Infrastructure-Capability-Index.md](./00-Infrastructure-Capability-Index.md) — Overview
- [02-CodePipeline-Autonomous-Deployment.md](./02-CodePipeline-Autonomous-Deployment.md) — Deployment orchestration
- `packages/core/src/evolution/iac-modifier.ts` — Implementation
- AWS CodeCommit User Guide: https://docs.aws.amazon.com/codecommit/
