---
title: 'ADR-026: L3 Construct Library for Chimera Conventions'
status: accepted
date: 2026-03-26
decision_makers: [chimera-architecture-team]
---

# ADR-026: L3 Construct Library for Chimera Conventions

## Status

**Accepted** (2026-03-26)

## Context

AWS Chimera's 12 CDK stacks create resources with repeated configuration patterns. For example:

**DynamoDB tables** (6 tables in data-stack.ts): Every table needs TENANT#{id} partition key, point-in-time recovery, deletion protection, and appropriate billing mode. Currently each table configures these independently, risking drift.

**S3 buckets** (4+ buckets across data-stack.ts, pipeline-stack.ts, email-stack.ts): Every bucket should use KMS encryption, versioning, access logging, and lifecycle rules. The project snapshot notes that buckets currently use S3-managed encryption instead of KMS — a gap that L3 constructs would prevent.

**Lambda functions** (20+ across 5 stacks): Every function needs X-Ray tracing, log retention, environment variables for observability, and retry configuration. skill-pipeline-stack.ts alone has 8 Lambda functions with similar configuration.

**SQS queues** (6+ across orchestration-stack.ts, email-stack.ts): Every queue needs a dead-letter queue, KMS encryption, and CloudWatch alarms on ApproximateNumberOfMessagesVisible.

The repetition creates several problems:
1. Inconsistency risk: One stack enables PITR, another forgets
2. Security gaps: Easy to miss encryption or access logging on new resources
3. Verbose stacks: 15,000 LOC of infrastructure could be significantly reduced
4. Onboarding friction: New contributors must learn every configuration knob

AWS provides a construct hierarchy: L1 (raw CloudFormation), L2 (typed wrappers with defaults), L3 (opinionated patterns). Chimera currently uses L2 constructs exclusively.

## Decision

Create an **L3 construct library** at infra/lib/constructs/ encoding Chimera conventions into reusable, opinionated constructs.

**Core constructs:**

```typescript
// infra/lib/constructs/chimera-table.ts
export class ChimeraTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ChimeraTableProps) {
    super(scope, id);
    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      pointInTimeRecovery: true,
      deletionProtection: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      ...props,
    });
  }
}

// infra/lib/constructs/chimera-bucket.ts
export class ChimeraBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ChimeraBucketProps) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.encryptionKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      ...props,
    });
  }
}

// infra/lib/constructs/chimera-lambda.ts
export class ChimeraLambda extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: ChimeraLambdaProps) {
    super(scope, id);
    this.function = new lambda.Function(this, 'Function', {
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      timeout: props.timeout ?? cdk.Duration.seconds(30),
      memorySize: props.memorySize ?? 256,
      ...props,
    });
  }
}

// infra/lib/constructs/chimera-queue.ts
export class ChimeraQueue extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: ChimeraQueueProps) {
    super(scope, id);
    this.dlq = new sqs.Queue(this, 'DLQ', {
      encryption: sqs.QueueEncryption.KMS,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.queue = new sqs.Queue(this, 'Queue', {
      encryption: sqs.QueueEncryption.KMS,
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
      ...props,
    });
  }
}
```

**CDK Aspects** for cross-cutting enforcement:

```typescript
// infra/lib/aspects/
export class EncryptionAspect implements cdk.IAspect { /* Warn on any S3 bucket without KMS */ }
export class LogRetentionAspect implements cdk.IAspect { /* Ensure all Lambda functions have log retention */ }
export class TaggingAspect implements cdk.IAspect { /* Apply chimera:stack, chimera:environment tags */ }
export class TenantIsolationAspect implements cdk.IAspect { /* Verify DynamoDB tables use TENANT# PK */ }
```

**Directory structure:**
```
infra/lib/constructs/
  chimera-table.ts, chimera-bucket.ts, chimera-lambda.ts, chimera-queue.ts, tenant-agent.ts, index.ts

infra/lib/aspects/
  encryption-aspect.ts, log-retention-aspect.ts, tagging-aspect.ts, tenant-isolation-aspect.ts, index.ts
```

## Alternatives Considered

### Alternative 1: Continue with L2 Constructs (Status Quo)
Keep using standard CDK L2 constructs with manual configuration.

**Pros:**
- No new abstractions to learn
- Full control over every property

**Cons:**
- Repetitive configuration across 12 stacks
- Easy to forget security defaults (encryption, logging, PITR)
- 15,000 LOC could be reduced by 30-40%
- Drift between stacks

**Verdict:** Rejected. Convention over configuration is the right trade-off.

### Alternative 2: AWS Solutions Constructs
Use @aws-solutions-constructs L3 patterns.

**Pros:**
- AWS-maintained, well-tested
- Encodes Well-Architected best practices

**Cons:**
- Generic — doesn't encode Chimera-specific conventions (TENANT# PK, tier-based config)
- Can't customize defaults without wrapping them anyway
- Limited to specific resource pairings

**Verdict:** Rejected as primary approach. Chimera needs project-specific conventions baked in.

### Alternative 3: CDK Aspects Only (No L3 Constructs)
Use CDK Aspects exclusively to enforce conventions as post-synthesis validation.

**Pros:**
- No new construct classes to create
- Aspects catch violations after the fact

**Cons:**
- Aspects validate but don't provide — stacks still repeat boilerplate
- Error messages at synthesis are harder to fix than correct-by-construction
- Doesn't reduce code volume

**Verdict:** Rejected as sole approach. Aspects complement L3 constructs.

## Consequences

### Positive

- **Correct by default**: New resources automatically get encryption, logging, PITR, tags
- **Reduced LOC**: Estimated 30-40% reduction in stack code
- **Consistency**: All DynamoDB tables share the same base configuration
- **Security gaps closed**: KMS encryption on S3 buckets, X-Ray on all Lambdas
- **cdk-nag compatibility**: Constructs can include NagSuppressions for intentional patterns

### Negative

- **Abstraction cost**: Developers must understand both L2 and L3 APIs
- **Migration effort**: 12 existing stacks need refactoring
- **Testing**: Each L3 construct needs its own unit tests

### Risks

- **Over-abstraction**: L3 constructs too opinionated may not fit future use cases (mitigated by: ...props allows overriding any default)
- **Version coupling**: L3 constructs couple to specific aws-cdk-lib versions (mitigated by: constructs live in same repo)

## Evidence

- **infra/lib/data-stack.ts:56-200**: 6 DynamoDB tables with repeated PK/SK, PITR, encryption config
- **infra/lib/data-stack.ts:272-340**: 3 S3 buckets with S3-managed encryption (should be KMS)
- **infra/lib/skill-pipeline-stack.ts:74-155**: 8 Lambda functions with repeated configuration
- **infra/lib/orchestration-stack.ts:86-140**: 4 SQS queues, each manually creating DLQ
- **infra/lib/email-stack.ts:136-200**: 2 more SQS queues with same DLQ pattern
- **No infra/lib/constructs/ directory exists** — all resources are L2 constructs

## Related Decisions

- **ADR-005** (AWS CDK): L3 constructs extend the CDK construct hierarchy
- **ADR-001** (6-table DynamoDB): ChimeraTable encodes the TENANT# partition key convention
- **ADR-025** (cdk-nag): Aspects and L3 constructs work together

## References

1. CDK Construct Library: https://docs.aws.amazon.com/cdk/v2/guide/constructs.html
2. AWS Solutions Constructs: https://docs.aws.amazon.com/solutions/latest/constructs/welcome.html
3. CDK Aspects: https://docs.aws.amazon.com/cdk/v2/guide/aspects.html
4. Data stack: infra/lib/data-stack.ts
5. Skill pipeline stack: infra/lib/skill-pipeline-stack.ts
