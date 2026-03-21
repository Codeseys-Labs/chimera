# Local Development Guide

This guide covers setting up and running Chimera locally for development.

## Prerequisites

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| **Bun** | 1.3+ | Package manager and TypeScript runtime |
| **Node.js** | 22+ | JavaScript runtime (for CDK CLI) |
| **AWS CDK** | 2.175+ | Infrastructure as code framework |
| **TypeScript** | 5.7+ | Type-safe development |
| **AWS CLI** | 2.x | AWS service interaction |

### AWS Account Setup

1. **AWS Account**: Active AWS account with admin access
2. **AWS Credentials**: Configured via `aws configure` or environment variables
3. **CDK Bootstrap**: Run once per account/region:
   ```bash
   npx cdk bootstrap aws://ACCOUNT-ID/REGION
   ```

## Installation

### 1. Clone and Install Dependencies

```bash
# Clone repository
git clone <repo-url>
cd chimera

# Install all workspace dependencies
bun install

# Install CDK infrastructure dependencies
cd infra
npm install  # or bun install
```

**Note**: If you see "Unsupported syntax: Operators are not allowed in JSON" during `bun install`, this is a temporary lockfile merge conflict. Bun will regenerate the lockfile automatically.

### 2. Verify Installation

```bash
# Verify CDK is available
cd infra
npx cdk --version

# Verify all stacks synthesize
npx cdk synth --quiet
```

Expected output: Successfully synthesized 11 stacks:
- Chimera-dev-Network
- Chimera-dev-Data
- Chimera-dev-Security
- Chimera-dev-Observability
- Chimera-dev-Api
- Chimera-dev-SkillPipeline
- Chimera-dev-Chat
- Chimera-dev-Orchestration
- Chimera-dev-Evolution
- Chimera-dev-TenantOnboarding
- Chimera-dev-Pipeline

## Project Structure

```
chimera/
├── infra/                       # CDK infrastructure
│   ├── bin/
│   │   └── chimera.ts          # CDK app entry point
│   ├── lib/                    # Stack definitions (11 stacks)
│   │   ├── network-stack.ts
│   │   ├── data-stack.ts
│   │   ├── security-stack.ts
│   │   ├── observability-stack.ts
│   │   ├── api-stack.ts
│   │   ├── skill-pipeline-stack.ts
│   │   ├── chat-stack.ts
│   │   ├── orchestration-stack.ts
│   │   ├── evolution-stack.ts
│   │   ├── tenant-onboarding-stack.ts
│   │   └── pipeline-stack.ts
│   ├── constructs/             # L3 constructs
│   │   └── tenant-agent.ts     # Multi-tenant isolation construct
│   ├── test/                   # CDK tests
│   └── cdk.out/                # Synthesized CloudFormation (gitignored)
├── packages/                   # Application code (future phases)
│   ├── core/                   # Agent core logic
│   ├── chat-gateway/           # Chat interface
│   ├── cli/                    # CLI tool
│   └── shared/                 # Shared types and utilities
├── skills/                     # Built-in platform skills
├── docs/                       # Documentation
│   ├── architecture/           # ADRs and design docs
│   ├── research/               # Research documents
│   ├── guides/                 # How-to guides (this file)
│   └── runbooks/               # Operational procedures
└── tests/                      # Integration tests
```

## CDK Development Workflow

### Common Commands

```bash
cd infra

# Synthesize CloudFormation templates
npm run synth              # or: npx cdk synth

# Show differences with deployed stacks
npm run diff               # or: npx cdk diff

# Deploy all stacks (caution: costs money)
npm run deploy             # or: npx cdk deploy --all

# Deploy a specific stack
npx cdk deploy Chimera-dev-Data

# Run CDK tests
npm test

# Type checking
npm run build              # Compiles TypeScript

# Watch mode for development
npm run watch
```

### Understanding the 11 Stacks

The Chimera infrastructure is organized into 11 CDK stacks following separation-of-concerns principles:

| Stack | Resources | Purpose |
|-------|-----------|---------|
| **Network** | VPC, subnets, security groups, NAT Gateway | Network isolation and connectivity |
| **Data** | 6 DynamoDB tables, S3 buckets, EFS | Persistent data storage |
| **Security** | Cognito User Pool, IAM roles, KMS keys, Cedar policies | Authentication and authorization |
| **Observability** | CloudWatch dashboards, X-Ray tracing, alarms | Monitoring and alerting |
| **Api** | API Gateway (HTTP + WebSocket) | External API layer |
| **SkillPipeline** | CodePipeline for skill validation | 7-stage skill security pipeline |
| **Chat** | ECS Fargate for chat gateway | Multi-platform chat interface |
| **Orchestration** | Step Functions, EventBridge | Workflow orchestration |
| **Evolution** | Self-modification infrastructure | Agent self-evolution capabilities |
| **TenantOnboarding** | Tenant provisioning automation | Multi-tenant setup |
| **Pipeline** | CI/CD pipeline for infrastructure | Continuous deployment |

**Stack Dependencies**: Stacks have implicit dependencies. CDK automatically deploys them in the correct order.

### Working with the TenantAgent L3 Construct

The `TenantAgent` construct (in `infra/constructs/tenant-agent.ts`) is a reusable L3 construct that provisions all per-tenant resources:

**What it creates**:
- IAM role with DynamoDB partition isolation (DENY other tenants' data)
- S3 prefix-scoped access (tenants/{tenantId}/*)
- Bedrock model access based on tier (basic/pro/enterprise)
- Cognito user group
- CloudWatch dashboard with tenant-specific metrics
- Budget alarms at 90% of monthly limit
- Cron job infrastructure (EventBridge + Step Functions)

**Usage example** (from tenant-onboarding-stack.ts):
```typescript
import { TenantAgent } from '../constructs/tenant-agent';

const tenantAgent = new TenantAgent(this, 'DemoTenant', {
  tenantId: 'demo-tenant',
  tier: 'pro',
  envName: 'dev',
  tenantsTable: dataStack.tenantsTable,
  sessionsTable: dataStack.sessionsTable,
  skillsTable: dataStack.skillsTable,
  rateLimitsTable: dataStack.rateLimitsTable,
  costTrackingTable: dataStack.costTrackingTable,
  auditTable: dataStack.auditTable,
  tenantBucket: dataStack.tenantBucket,
  skillsBucket: dataStack.skillsBucket,
  userPool: securityStack.userPool,
  eventBus: orchestrationStack.eventBus,
  alarmTopic: observabilityStack.alarmTopic,
  budgetLimitMonthlyUsd: 1000,
  cronJobs: [
    {
      name: 'daily-report',
      schedule: 'cron(0 8 ? * MON-FRI *)',
      promptKey: 'tenants/demo-tenant/prompts/daily-report.txt',
      skills: ['aws-account-agent', 'cost-analyzer'],
      maxBudgetUsd: 5,
      outputPrefix: 'reports/daily',
    }
  ],
});
```

## Testing

### Unit Tests

```bash
cd infra
npm test
```

CDK unit tests use `aws-cdk-lib/assertions` to verify infrastructure:

```typescript
import { Template } from 'aws-cdk-lib/assertions';

test('DataStack creates 6 DynamoDB tables', () => {
  const template = Template.fromStack(dataStack);
  template.resourceCountIs('AWS::DynamoDB::Table', 6);
});
```

### Integration Tests

```bash
# Run integration tests (requires AWS credentials)
cd tests
bun test
```

### Quality Gates (Required Before Merge)

All PRs must pass:
```bash
bun test              # All tests pass
bun run lint          # Zero lint errors
bun run typecheck     # No TypeScript errors
```

## Local Development Tips

### Hot Reload with CDK Watch

CDK watch mode automatically redeploys changes:

```bash
cd infra
npx cdk watch Chimera-dev-Data
```

**Note**: Watch mode is best for lambda functions and small changes. Full stack changes require `cdk deploy`.

### Cost Control

**⚠️ Deploying to AWS costs money.** To minimize costs during development:

1. **Use `cdk synth`** instead of `cdk deploy` when possible
2. **Deploy single stacks** for testing: `npx cdk deploy Chimera-dev-Data`
3. **Destroy stacks when done**: `npx cdk destroy --all`
4. **Set budget alarms**: The TenantAgent construct includes budget alarms
5. **Use AWS Free Tier**: Many services have free tiers (DynamoDB, Lambda, S3)

### Environment Naming

CDK stacks are prefixed with environment name (`dev`, `staging`, `prod`). Set via:

```typescript
// infra/bin/chimera.ts
const envName = process.env.ENV_NAME || 'dev';
```

To deploy to staging:
```bash
ENV_NAME=staging npx cdk deploy --all
```

### CDK Context and Feature Flags

CDK uses feature flags for backward compatibility. You may see warnings like:

```
70 feature flags are not configured. Run 'cdk flags --unstable=flags' to learn more.
```

These are safe to ignore during development. For production, review flags:

```bash
npx cdk flags --unstable=flags
```

### Common Deprecation Warnings

You may see warnings during `cdk synth`:
- `pointInTimeRecovery` → use `pointInTimeRecoverySpecification`
- `StateMachineProps.definition` → use `definitionBody: DefinitionBody.fromChainable()`
- `logRetention` → use `logGroup` instead

These are logged but don't block synthesis. They'll be addressed in future refactoring.

## Troubleshooting

### Issue: `bun.lock` parse error

**Error**: `Unsupported syntax: Operators are not allowed in JSON`

**Cause**: Git merge conflict in `bun.lock`

**Fix**: Bun automatically regenerates the lockfile. This is safe and expected.

### Issue: CDK synth fails with module not found

**Error**: `Cannot find module 'aws-cdk-lib'`

**Fix**: Install dependencies in the `infra/` directory:
```bash
cd infra
npm install
```

### Issue: CDK bootstrap required

**Error**: `This stack uses assets, so the toolkit stack must be deployed`

**Fix**: Bootstrap CDK in your account/region:
```bash
npx cdk bootstrap aws://ACCOUNT-ID/REGION
```

### Issue: AWS credentials not configured

**Error**: `Unable to resolve AWS account to use`

**Fix**: Configure AWS CLI:
```bash
aws configure
# Or set environment variables:
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=us-east-1
```

### Issue: TypeScript errors in IDE

**Problem**: VS Code shows TypeScript errors even after `npm install`

**Fix**:
1. Ensure `infra/tsconfig.json` exists
2. Reload VS Code: Cmd+Shift+P → "TypeScript: Restart TS Server"
3. Run `npm run build` to verify

### Issue: CDK deploy fails with "Stack already exists"

**Problem**: Trying to deploy a stack that's already deployed

**Fix**: Use `cdk diff` to see changes, then `cdk deploy` to update:
```bash
npx cdk diff Chimera-dev-Data
npx cdk deploy Chimera-dev-Data
```

## Next Steps

Once you have the local environment set up:

1. **Read the architecture docs**: [docs/architecture/](../architecture/)
2. **Review the roadmap**: [docs/ROADMAP.md](../ROADMAP.md)
3. **Understand Overstory workflow**: [CLAUDE.md](../../CLAUDE.md)
4. **Explore mulch expertise**: Run `mulch prime` to load project patterns
5. **Check Seeds issues**: Run `sd ready` to see available tasks

## Additional Resources

- **CDK Developer Guide**: https://docs.aws.amazon.com/cdk/v2/guide/home.html
- **CDK API Reference**: https://docs.aws.amazon.com/cdk/api/v2/
- **Chimera Vision Document**: [docs/VISION.md](../VISION.md)
- **Overstory Orchestration**: [CLAUDE.md](../../CLAUDE.md)

---

**Questions?** Check the project's Seeds issue tracker or ask in the team channel.
