---
tags:
  - self-evolution
  - infrastructure-as-code
  - cdk
  - cedar-policies
  - self-modifying-systems
  - safety-rails
  - opa
date: 2026-03-19
topic: Self-Modifying Infrastructure with Safety Rails
status: complete
---

# Self-Modifying Infrastructure with Safety Rails

## Overview

Self-evolving agent platforms require the ability to modify their own infrastructure — adding resources, tuning configurations, and optimizing deployments without human intervention. However, unrestricted infrastructure modification is dangerous. This document covers:

1. **Self-Modifying IaC Patterns** — Agents editing CDK/Terraform/Pulumi code
2. **Cedar Policy Guardrails** — Constraining what agents can modify
3. **GitOps Safety Patterns** — Review gates and rollback mechanisms
4. **AWS CDK Self-Edit** — Concrete implementation with CDK
5. **Drift Detection** — Monitoring unauthorized changes
6. **Production Safeguards** — Kill switches, approval gates, blast radius limits

## Table of Contents

- [Why Self-Modifying Infrastructure?](#why-self-modifying-infrastructure)
- [Three Approaches](#three-approaches)
- [Cedar Policy Guardrails](#cedar-policy-guardrails)
- [CDK Self-Edit Implementation](#cdk-self-edit-implementation)
- [GitOps Safety Pattern](#gitops-safety-pattern)
- [Drift Detection](#drift-detection)
- [Approval Gates](#approval-gates)
- [Rollback Mechanisms](#rollback-mechanisms)
- [Production Examples](#production-examples)
- [Security Considerations](#security-considerations)

---

## Why Self-Modifying Infrastructure?

**Use Cases:**

1. **Auto-Scaling** — Agent detects performance bottlenecks and adds compute capacity
2. **Cost Optimization** — Agent identifies idle resources and downsizes/removes them
3. **Feature Deployment** — Agent adds new tools, APIs, or integrations based on user needs
4. **Configuration Tuning** — Agent adjusts parameters (concurrency limits, timeouts, quotas)
5. **Disaster Recovery** — Agent automatically provisions backup infrastructure on failure

**Risks:**

- **Runaway Changes** — Agent could delete critical resources or create infinite loops
- **Cost Explosion** — Unrestricted provisioning could rack up huge AWS bills
- **Security Violations** — Agent could weaken security controls or expose data
- **Service Disruption** — Bad changes could break the platform

**Solution:** Policy-bounded self-modification with safety rails.

---

## Three Approaches

### 1. Runtime-Only Modification (Riskiest)

Agent directly calls AWS APIs to modify resources:

```typescript
// ❌ DANGEROUS: No review, no rollback, no audit trail
async function addComputeCapacity() {
  await ecs.send(new UpdateServiceCommand({
    service: "agent-runtime",
    desiredCount: 20 // doubled from 10
  }));
}
```

**Pros:**
- Instant response to issues
- No deployment delay

**Cons:**
- No code review
- Hard to audit
- Difficult to rollback
- Bypasses IaC state

**When to Use:** Emergency auto-scaling within strict bounds (e.g., 2x capacity max).

### 2. Policy-Bounded Auto-Apply (Moderate Risk)

Agent modifies IaC code, policies validate changes, auto-deploy if approved:

```typescript
// ✅ BETTER: Agent edits CDK, Cedar validates, auto-deploys if safe
async function proposeInfraChange(change: InfraChange) {
  // 1. Agent generates CDK code modification
  const modifiedCode = await generateCDKChange(change);

  // 2. Validate against Cedar policies
  const policyResult = await validateAgainstPolicies(modifiedCode);

  if (!policyResult.allowed) {
    throw new Error(`Policy violation: ${policyResult.reason}`);
  }

  // 3. Auto-apply if within safe bounds
  await applyCDKChange(modifiedCode);

  // 4. Monitor deployment
  await monitorDeployment();
}
```

**Pros:**
- IaC stays as source of truth
- Policy enforcement
- Audit trail in git
- Rollback via IaC

**Cons:**
- Still no human review
- Requires robust policy framework

**When to Use:** Well-understood changes with strong policy coverage.

### 3. GitOps Propose-Review-Merge (Safest)

Agent creates PR, human reviews, merges if approved:

```typescript
// ✅ SAFEST: Agent creates PR, waits for human approval
async function proposeInfraChange(change: InfraChange) {
  // 1. Agent generates CDK code modification
  const modifiedCode = await generateCDKChange(change);

  // 2. Create git branch
  await git.checkout("-b", `agent/infra-change-${Date.now()}`);
  await git.add("lib/");
  await git.commit("-m", `Agent proposal: ${change.description}`);
  await git.push("origin", git.currentBranch());

  // 3. Open PR with explanation
  const pr = await github.createPullRequest({
    title: `[Agent] ${change.title}`,
    body: `
## Proposed Change

${change.description}

## Rationale

${change.rationale}

## Impact

- Resources affected: ${change.affectedResources.join(", ")}
- Estimated cost delta: $${change.costDelta}/month
- Risk level: ${change.riskLevel}

## Validation

- [ ] Cedar policies passed
- [ ] Cost impact acceptable
- [ ] No security regressions
- [ ] Rollback plan defined

---
🤖 Generated by self-evolution agent
    `,
    labels: ["agent-generated", "infrastructure"]
  });

  // 4. Wait for approval
  await waitForPRApproval(pr.number);

  return pr.number;
}
```

**Pros:**
- Human-in-the-loop safety
- Code review process
- Explicit approval
- Highest confidence

**Cons:**
- Slower (requires human)
- Can't auto-remediate emergencies

**When to Use:** Production changes, high-risk modifications, new patterns.

---

## Cedar Policy Guardrails

Use AWS Cedar (or OPA) to constrain agent modifications:

### Cedar Policy Schema

```cedar
// Define entity types
entity AgentPrincipal;
entity InfraResource;
entity InfraAction;

// Define resource hierarchy
entity Stack {
  environment: String,
  project: String
};

entity Service {
  stack: Stack,
  type: String
};

entity Resource {
  service: Service,
  resourceType: String
};
```

### Example Policies

**Policy 1: Agents can only scale services up to 2x capacity**

```cedar
// Permit scaling within bounds
permit(
  principal is AgentPrincipal,
  action == InfraAction::"ScaleService",
  resource is Service
)
when {
  resource.type == "ECS" &&
  context.newDesiredCount <= (context.currentDesiredCount * 2) &&
  context.newDesiredCount >= (context.currentDesiredCount / 2)
};
```

**Policy 2: Agents cannot modify production databases**

```cedar
// Forbid database changes in prod
forbid(
  principal is AgentPrincipal,
  action in [InfraAction::"ModifyDatabase", InfraAction::"DeleteDatabase"],
  resource is Resource
)
when {
  resource.resourceType == "RDS" &&
  resource.service.stack.environment == "production"
};
```

**Policy 3: Agents can add read-only resources but not write**

```cedar
// Permit adding read-only resources
permit(
  principal is AgentPrincipal,
  action == InfraAction::"CreateResource",
  resource
)
when {
  resource.permissions == "ReadOnly"
};

// Forbid adding write resources without approval
forbid(
  principal is AgentPrincipal,
  action == InfraAction::"CreateResource",
  resource
)
when {
  resource.permissions in ["Write", "Admin"] &&
  !context.hasHumanApproval
};
```

**Policy 4: Agents have cost budgets**

```cedar
// Limit cost impact
permit(
  principal is AgentPrincipal,
  action == InfraAction::"CreateResource",
  resource
)
when {
  context.estimatedMonthlyCost <= 100.00 // $100/month max
};

forbid(
  principal is AgentPrincipal,
  action,
  resource
)
when {
  context.cumulativeMonthlySpend >= principal.monthlyBudget
};
```

### Policy Enforcement in Code

```typescript
import { CedarClient, IsAuthorizedCommand } from "@aws-sdk/client-cedar";

const cedar = new CedarClient({});

async function validateAgainstPolicies(
  agent: AgentPrincipal,
  action: string,
  resource: any,
  context: Record<string, any>
): Promise<{ allowed: boolean; reason?: string }> {
  const result = await cedar.send(new IsAuthorizedCommand({
    principal: {
      entityType: "AgentPrincipal",
      entityId: agent.id
    },
    action: {
      actionType: "InfraAction",
      actionId: action
    },
    resource: {
      entityType: resource.type,
      entityId: resource.id
    },
    context: context,
    policyStoreId: process.env.POLICY_STORE_ID
  }));

  if (result.decision === "DENY") {
    return {
      allowed: false,
      reason: result.determiningPolicies?.[0]?.policyId || "Policy violation"
    };
  }

  return { allowed: true };
}

// Example usage
const validation = await validateAgainstPolicies(
  { id: "agent-123" },
  "ScaleService",
  { type: "Service", id: "ecs-service-abc" },
  {
    currentDesiredCount: 10,
    newDesiredCount: 25, // 2.5x — will be denied
    estimatedMonthlyCost: 50
  }
);

if (!validation.allowed) {
  throw new Error(`Policy denied: ${validation.reason}`);
}
```

---

## CDK Self-Edit Implementation

### Agent Analyzes Performance

```typescript
async function analyzePerformanceBottleneck(): Promise<InfraChangeProposal> {
  // Fetch CloudWatch metrics
  const metrics = await cloudwatch.send(new GetMetricStatisticsCommand({
    Namespace: "AgentPlatform/Runtime",
    MetricName: "CPUUtilization",
    StartTime: new Date(Date.now() - 3600000),
    EndTime: new Date(),
    Period: 300,
    Statistics: ["Average", "Maximum"]
  }));

  const avgCPU = metrics.Datapoints?.reduce((sum, dp) => sum + dp.Average!, 0) / metrics.Datapoints!.length;

  if (avgCPU > 80) {
    return {
      type: "scale_up",
      reason: "CPU utilization consistently >80%",
      action: "increase_task_count",
      currentValue: 10,
      proposedValue: 15,
      estimatedCostDelta: 50 // $50/month
    };
  }

  return null;
}
```

### Agent Generates CDK Code

```typescript
async function generateCDKChange(proposal: InfraChangeProposal): Promise<string> {
  const prompt = `
Generate AWS CDK TypeScript code to implement this infrastructure change:

Type: ${proposal.type}
Reason: ${proposal.reason}
Action: ${proposal.action}
Current Value: ${proposal.currentValue}
Proposed Value: ${proposal.proposedValue}

Current CDK Stack (relevant excerpt):
\`\`\`typescript
const ecsService = new ecs.FargateService(this, "AgentRuntime", {
  cluster,
  taskDefinition,
  desiredCount: 10
});
\`\`\`

Generate ONLY the modified lines of code. Use comments to explain changes.
`;

  const response = await invokeModel("anthropic.claude-opus-4-6-v1:0", {
    prompt,
    temperature: 0.3,
    maxTokens: 2048
  });

  return response.output;
}

// Agent output:
const generatedCode = `
// Increased from 10 to 15 based on CPU metrics (80%+ avg)
const ecsService = new ecs.FargateService(this, "AgentRuntime", {
  cluster,
  taskDefinition,
  desiredCount: 15, // Changed: was 10
  // Auto-scaling target updated
  minCapacity: 5,   // Changed: was 3
  maxCapacity: 30   // Changed: was 20
});
`;
```

### Apply CDK Change

```typescript
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function applyCDKChange(
  proposal: InfraChangeProposal,
  generatedCode: string
): Promise<DeploymentResult> {
  // 1. Validate policies
  const policyResult = await validateAgainstPolicies(
    { id: process.env.AGENT_ID! },
    proposal.action,
    { type: "ECSService", id: "agent-runtime" },
    {
      currentDesiredCount: proposal.currentValue,
      newDesiredCount: proposal.proposedValue,
      estimatedMonthlyCost: proposal.estimatedCostDelta
    }
  );

  if (!policyResult.allowed) {
    throw new Error(`Policy denied: ${policyResult.reason}`);
  }

  // 2. Create git branch
  await execAsync("git checkout -b agent/scale-up-runtime");

  // 3. Apply code change
  const stackFilePath = "lib/agent-runtime-stack.ts";
  const currentCode = await fs.readFile(stackFilePath, "utf-8");
  const modifiedCode = applyCodePatch(currentCode, generatedCode);
  await fs.writeFile(stackFilePath, modifiedCode);

  // 4. Commit
  await execAsync(`git add ${stackFilePath}`);
  await execAsync(`git commit -m "Agent: Scale up runtime to ${proposal.proposedValue} tasks"`);

  // 5. CDK diff (preview changes)
  const { stdout: diffOutput } = await execAsync("npx cdk diff");
  console.log("CDK Diff:", diffOutput);

  // 6. Validate diff doesn't include forbidden changes
  if (diffOutput.includes("DELETE") || diffOutput.includes("RDS")) {
    throw new Error("Diff contains forbidden operations");
  }

  // 7. Deploy
  const { stdout: deployOutput } = await execAsync("npx cdk deploy --require-approval never");

  // 8. Push to git
  await execAsync("git push origin agent/scale-up-runtime");

  return {
    success: true,
    branch: "agent/scale-up-runtime",
    deployOutput
  };
}

function applyCodePatch(original: string, patch: string): string {
  // Simple replace for demo — production would use AST transformation
  return original.replace(
    /desiredCount:\s*10/,
    "desiredCount: 15"
  ).replace(
    /maxCapacity:\s*20/,
    "maxCapacity: 30"
  );
}
```

### AST-Based Code Modification (Production-Grade)

```typescript
import * as ts from "typescript";

function modifyStackCodeAST(
  sourceFile: ts.SourceFile,
  modification: CDKModification
): string {
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    return (rootNode) => {
      function visit(node: ts.Node): ts.Node {
        // Find ECS FargateService construct
        if (ts.isNewExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "FargateService") {

          const args = node.arguments;
          if (args && args.length >= 3) {
            const config = args[2];

            if (ts.isObjectLiteralExpression(config)) {
              // Modify desiredCount property
              const newProperties = config.properties.map(prop => {
                if (ts.isPropertyAssignment(prop) &&
                    ts.isIdentifier(prop.name) &&
                    prop.name.text === "desiredCount") {

                  return ts.factory.createPropertyAssignment(
                    prop.name,
                    ts.factory.createNumericLiteral(modification.newDesiredCount)
                  );
                }
                return prop;
              });

              const newConfig = ts.factory.createObjectLiteralExpression(newProperties, true);
              return ts.factory.createNewExpression(
                node.expression,
                node.typeArguments,
                [args[0], args[1], newConfig]
              );
            }
          }
        }

        return ts.visitEachChild(node, visit, context);
      }

      return ts.visitNode(rootNode, visit);
    };
  };

  const result = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter();
  return printer.printFile(result.transformed[0]);
}
```

---

## GitOps Safety Pattern

### Pull Request Workflow

```typescript
async function createInfraPR(proposal: InfraChangeProposal): Promise<number> {
  // 1. Generate changes
  const code = await generateCDKChange(proposal);

  // 2. Create branch
  await git.checkout("-b", `agent/infra-${Date.now()}`);

  // 3. Apply changes
  await applyCDKChange(proposal, code);

  // 4. Create PR
  const pr = await octokit.pulls.create({
    owner: "your-org",
    repo: "infrastructure",
    title: `[Agent] ${proposal.type}: ${proposal.reason}`,
    head: git.currentBranch(),
    base: "main",
    body: generatePRBody(proposal)
  });

  // 5. Add reviewers
  await octokit.pulls.requestReviewers({
    owner: "your-org",
    repo: "infrastructure",
    pull_number: pr.data.number,
    reviewers: ["infra-team"]
  });

  // 6. Add checks
  await runCDKDiff(pr.data.number);
  await runPolicyValidation(pr.data.number);
  await estimateCost(pr.data.number);

  return pr.data.number;
}

function generatePRBody(proposal: InfraChangeProposal): string {
  return `
## 🤖 Agent-Proposed Infrastructure Change

### Summary
${proposal.reason}

### Proposed Action
**Type:** ${proposal.type}
**Action:** ${proposal.action}

### Impact Analysis

| Metric | Current | Proposed | Delta |
|--------|---------|----------|-------|
| Desired Count | ${proposal.currentValue} | ${proposal.proposedValue} | +${proposal.proposedValue - proposal.currentValue} |
| Est. Monthly Cost | $${proposal.currentCost || 0} | $${(proposal.currentCost || 0) + proposal.estimatedCostDelta} | +$${proposal.estimatedCostDelta} |

### Validation

- ✅ Cedar policies passed
- ✅ CDK diff reviewed
- ✅ Cost impact acceptable (<$100/month)
- ✅ No security regressions

### Rollback Plan

If this change causes issues:
1. Revert this PR
2. Redeploy previous version: \`cdk deploy\`
3. Monitor metrics for 30 minutes

### Testing

- [ ] Deploy to staging environment
- [ ] Run load tests
- [ ] Monitor for 24 hours
- [ ] Promote to production

---

**Generated by:** Agent \`${process.env.AGENT_ID}\`
**Timestamp:** ${new Date().toISOString()}
  `;
}
```

### Automated Checks on PR

```typescript
// GitHub Actions workflow
// .github/workflows/agent-pr-validation.yml

/*
name: Agent PR Validation

on:
  pull_request:
    paths:
      - 'lib/**'
    types: [opened, synchronize]

jobs:
  validate-agent-pr:
    runs-on: ubuntu-latest
    if: contains(github.event.pull_request.labels.*.name, 'agent-generated')

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: CDK Diff
        run: npx cdk diff > diff.txt

      - name: Validate Policies
        run: npm run validate-policies

      - name: Estimate Cost
        run: npm run estimate-cost > cost.txt

      - name: Check Forbidden Changes
        run: |
          if grep -q "DELETE" diff.txt; then
            echo "❌ PR contains resource deletions"
            exit 1
          fi

          if grep -q "RDS" diff.txt; then
            echo "❌ PR modifies database resources"
            exit 1
          fi

      - name: Post Results
        uses: actions/github-script@v6
        with:
          script: |
            const fs = require('fs');
            const diff = fs.readFileSync('diff.txt', 'utf8');
            const cost = fs.readFileSync('cost.txt', 'utf8');

            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `
## 🤖 Automated Validation Results

### CDK Diff
\`\`\`
${diff}
\`\`\`

### Cost Estimate
${cost}

### Checks
- ✅ No resource deletions
- ✅ No database modifications
- ✅ Policies validated
              `
            });
*/
```

---

## Drift Detection

Monitor for unauthorized changes outside IaC:

```typescript
import { CloudFormationClient, DescribeStackDriftDetectionStatusCommand, DetectStackDriftCommand } from "@aws-sdk/client-cloudformation";

async function detectInfraDrift() {
  const cfn = new CloudFormationClient({});

  // Start drift detection
  const detection = await cfn.send(new DetectStackDriftCommand({
    StackName: "AgentPlatformStack"
  }));

  // Poll for results
  let status = "IN_PROGRESS";
  while (status === "IN_PROGRESS") {
    await sleep(5000);

    const result = await cfn.send(new DescribeStackDriftDetectionStatusCommand({
      StackDriftDetectionId: detection.StackDriftDetectionId
    }));

    status = result.DetectionStatus!;
  }

  if (status === "DRIFTED") {
    // Get details
    const driftedResources = await cfn.send(new DescribeStackResourceDriftsCommand({
      StackName: "AgentPlatformStack",
      StackResourceDriftStatusFilters: ["MODIFIED", "DELETED"]
    }));

    // Alert
    await sns.send(new PublishCommand({
      TopicArn: "arn:aws:sns:us-east-1:123456789012:InfraDriftAlerts",
      Subject: "Infrastructure Drift Detected",
      Message: JSON.stringify({
        driftedResources: driftedResources.StackResourceDrifts,
        timestamp: new Date().toISOString()
      })
    }));

    // Auto-remediate if agent-initiated
    for (const drift of driftedResources.StackResourceDrifts || []) {
      if (isAgentInitiated(drift)) {
        // Revert to IaC state
        await revertDrift(drift);
      }
    }
  }
}

// Run drift detection on schedule
// EventBridge rule: cron(0 */6 * * ? *)
```

---

## Approval Gates

### Multi-Level Approval

```typescript
interface ApprovalConfig {
  lowRisk: { requireApprovers: number; approvers: string[] };
  mediumRisk: { requireApprovers: number; approvers: string[] };
  highRisk: { requireApprovers: number; approvers: string[] };
}

const approvalConfig: ApprovalConfig = {
  lowRisk: {
    requireApprovers: 0, // auto-approve
    approvers: []
  },
  mediumRisk: {
    requireApprovers: 1,
    approvers: ["infra-team"]
  },
  highRisk: {
    requireApprovers: 2,
    approvers: ["infra-team", "security-team"]
  }
};

function determineRiskLevel(proposal: InfraChangeProposal): "low" | "medium" | "high" {
  if (proposal.estimatedCostDelta > 500) return "high";
  if (proposal.affectedResources.some(r => r.includes("database"))) return "high";
  if (proposal.type === "delete") return "high";
  if (proposal.estimatedCostDelta > 100) return "medium";
  if (proposal.type === "scale_up" || proposal.type === "scale_down") return "medium";
  return "low";
}

async function requestApproval(pr: number, proposal: InfraChangeProposal) {
  const riskLevel = determineRiskLevel(proposal);
  const config = approvalConfig[riskLevel];

  if (config.requireApprovers === 0) {
    // Auto-approve
    await mergePR(pr);
    return;
  }

  // Request reviews
  await octokit.pulls.requestReviewers({
    owner: "your-org",
    repo: "infrastructure",
    pull_number: pr,
    reviewers: config.approvers.slice(0, config.requireApprovers)
  });

  // Wait for approvals
  await waitForApprovals(pr, config.requireApprovers);

  // Auto-merge
  await mergePR(pr);
}
```

---

## Rollback Mechanisms

### Automatic Rollback on Failure

```typescript
async function deployWithAutoRollback(stackName: string): Promise<DeploymentResult> {
  // Snapshot current state
  const preDeployState = await captureStackState(stackName);

  try {
    // Deploy
    const deployment = await execAsync(`npx cdk deploy ${stackName} --require-approval never`);

    // Monitor for issues
    const healthCheck = await monitorDeploymentHealth(stackName, 300); // 5 min

    if (!healthCheck.healthy) {
      throw new Error(`Health check failed: ${healthCheck.reason}`);
    }

    return {
      success: true,
      state: "deployed",
      output: deployment.stdout
    };

  } catch (error) {
    console.error("Deployment failed, rolling back:", error);

    // Rollback
    await rollbackToState(stackName, preDeployState);

    return {
      success: false,
      state: "rolled_back",
      error: error.message
    };
  }
}

async function monitorDeploymentHealth(
  stackName: string,
  durationSeconds: number
): Promise<{ healthy: boolean; reason?: string }> {
  const startTime = Date.now();
  const endTime = startTime + (durationSeconds * 1000);

  while (Date.now() < endTime) {
    // Check error rate
    const errorRate = await getErrorRate(stackName);
    if (errorRate > 5) {
      return { healthy: false, reason: `Error rate ${errorRate}% > 5%` };
    }

    // Check latency
    const p99Latency = await getP99Latency(stackName);
    if (p99Latency > 5000) {
      return { healthy: false, reason: `P99 latency ${p99Latency}ms > 5000ms` };
    }

    await sleep(30000); // check every 30s
  }

  return { healthy: true };
}

async function rollbackToState(stackName: string, state: StackState) {
  // Option 1: Redeploy previous git commit
  await execAsync(`git checkout ${state.gitCommit}`);
  await execAsync(`npx cdk deploy ${stackName} --require-approval never`);

  // Option 2: Use CloudFormation rollback
  await cfn.send(new CancelUpdateStackCommand({ StackName: stackName }));
  await cfn.send(new ContinueUpdateRollbackCommand({ StackName: stackName }));
}
```

---

## Production Examples

### Example 1: Auto-Scaling Based on Queue Depth

```typescript
async function autoScaleWorkers() {
  // Check SQS queue depth
  const queueAttributes = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/agent-tasks",
    AttributeNames: ["ApproximateNumberOfMessages"]
  }));

  const queueDepth = parseInt(queueAttributes.Attributes!.ApproximateNumberOfMessages);

  // If queue > 1000 messages, scale up workers
  if (queueDepth > 1000) {
    const proposal: InfraChangeProposal = {
      type: "scale_up",
      reason: `SQS queue depth at ${queueDepth} messages`,
      action: "increase_worker_count",
      currentValue: 10,
      proposedValue: 20,
      estimatedCostDelta: 100,
      affectedResources: ["ecs-service-workers"]
    };

    // Auto-apply (within policy bounds)
    await applyCDKChange(proposal, await generateCDKChange(proposal));
  }
}
```

### Example 2: Cost Optimization - Remove Idle Resources

```typescript
async function cleanupIdleResources() {
  // Find EC2 instances with <1% CPU for 7 days
  const idleInstances = await findIdleInstances();

  for (const instance of idleInstances) {
    const proposal: InfraChangeProposal = {
      type: "delete",
      reason: `Instance ${instance.id} idle for 7 days (<1% CPU)`,
      action: "terminate_instance",
      currentValue: 1,
      proposedValue: 0,
      estimatedCostDelta: -200, // save $200/month
      affectedResources: [instance.id]
    };

    // Create PR for human review (deletion requires approval)
    const pr = await createInfraPR(proposal);
    console.log(`Created PR #${pr} to terminate ${instance.id}`);
  }
}
```

### Example 3: Feature Deployment - Add New Tool

```typescript
async function addToolToAgents(toolName: string, toolConfig: any) {
  const proposal: InfraChangeProposal = {
    type: "add_feature",
    reason: `Users requested ${toolName} integration`,
    action: "add_tool",
    currentValue: 0,
    proposedValue: 1,
    estimatedCostDelta: 0, // no infra cost
    affectedResources: ["agent-runtime"]
  };

  // Generate CDK code to add tool
  const code = await generateCDKChange(proposal);

  // Validate policies
  const policyResult = await validateAgainstPolicies(
    { id: process.env.AGENT_ID! },
    "AddTool",
    { type: "AgentRuntime", id: "agent-runtime" },
    { toolName, toolConfig }
  );

  if (policyResult.allowed) {
    // Auto-apply
    await applyCDKChange(proposal, code);
  } else {
    // Requires approval
    await createInfraPR(proposal);
  }
}
```

---

## Security Considerations

### Principle of Least Privilege

```typescript
// IAM role for self-modifying agent (minimal permissions)
const agentRole = new iam.Role(this, "SelfModifyingAgentRole", {
  assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")
  ]
});

// Only allow specific CDK actions
agentRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    "cloudformation:DescribeStacks",
    "cloudformation:DescribeStackResources",
    "cloudformation:DetectStackDrift",
    "cloudformation:GetTemplate"
  ],
  resources: ["arn:aws:cloudformation:*:*:stack/AgentPlatform*"]
}));

// No deletion permissions
agentRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.DENY,
  actions: [
    "cloudformation:DeleteStack",
    "ec2:TerminateInstances",
    "rds:DeleteDB*"
  ],
  resources: ["*"]
}));
```

### Audit Trail

```typescript
// Log all self-modification attempts
async function logInfraChange(proposal: InfraChangeProposal, result: DeploymentResult) {
  await dynamodb.send(new PutItemCommand({
    TableName: "InfraChangeAudit",
    Item: {
      PK: { S: `CHANGE#${Date.now()}` },
      SK: { S: "METADATA" },
      agentId: { S: process.env.AGENT_ID! },
      proposal: { S: JSON.stringify(proposal) },
      result: { S: JSON.stringify(result) },
      timestamp: { S: new Date().toISOString() },
      gitCommit: { S: await execAsync("git rev-parse HEAD").then(r => r.stdout.trim()) }
    }
  }));

  // Also send to CloudTrail/CloudWatch Logs
  await logs.send(new PutLogEventsCommand({
    logGroupName: "/agent/infra-changes",
    logStreamName: new Date().toISOString().split("T")[0],
    logEvents: [{
      timestamp: Date.now(),
      message: JSON.stringify({ proposal, result })
    }]
  }));
}
```

### Kill Switch

```typescript
// Emergency kill switch to disable self-modification
async function checkKillSwitch(): Promise<boolean> {
  const param = await ssm.send(new GetParameterCommand({
    Name: "/agent/self-modify-enabled"
  }));

  return param.Parameter?.Value === "true";
}

async function proposeChange(proposal: InfraChangeProposal) {
  // Check kill switch
  if (!await checkKillSwitch()) {
    throw new Error("Self-modification disabled by kill switch");
  }

  // Proceed...
}
```

---

## References

- [AWS CDK](https://docs.aws.amazon.com/cdk/latest/guide/home.html)
- [AWS Cedar](https://www.cedarpolicy.com/)
- [Open Policy Agent](https://www.openpolicyagent.org/)
- [GitOps Principles](https://www.gitops.tech/)
- [AWS CloudFormation Drift Detection](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html)

---

## Related Documents

- [[01-Prompt-Model-Optimization]] — A/B testing and model routing
- [[02-ML-Experiment-Autoresearch]] — Automated ML experiment loops
- [[04-Agent-Skill-Generation]] — Auto-generating skills from learnings
