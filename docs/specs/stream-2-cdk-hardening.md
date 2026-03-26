---
title: Stream 2 — CDK Hardening
status: draft
references: [ADR-025, ADR-026]
priority: P1
estimated_effort: XL
---

## Objective

Harden the CDK infrastructure layer with automated compliance scanning (cdk-nag), reusable L3 constructs that enforce security defaults, custom Aspects that catch violations at synth time, and refactored stacks that use these constructs. After this stream, all 6 DynamoDB tables and all S3 buckets enforce encryption, retention, and tagging as invariants, not afterthoughts.

## Background (reference ADRs)

ADR-025 (pending) justifies L3 construct adoption and the security baseline requirements. ADR-026 (pending) documents the cdk-nag integration strategy and which NIST 800-53 R5 controls apply.

Key existing patterns:
- `cdk-cross-stack-kms-sqs-lambda-cycle` (mulch): Cross-stack KMS references require explicit grants in the owning stack
- `cdk-sqs-kms-cross-stack-grant-cycle` (mulch): SQS queues using KMS from another stack need Lambda grants in the owning stack
- `sfn-addcatch-pattern` (mulch): All Step Functions tasks must have `.addCatch`
- `grantReadWrite-does-not-exist-on-secret` (mulch): Use `grantRead`/`grantWrite` separately on Secrets Manager

## Detailed Changes

### 1. cdk-nag Integration

**`infra/package.json`**
```json
"dependencies": {
  "cdk-nag": "^2.x"
}
```

**`infra/bin/chimera.ts`**
Add after `const app = new cdk.App()`:
```typescript
import { Aspects } from 'aws-cdk-lib'
import { AwsSolutionsChecks, NIST80053R5Checks } from 'cdk-nag'

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
Aspects.of(app).add(new NIST80053R5Checks({ verbose: false }))
```

**`infra/cdk-nag-suppressions.ts`** (new file)
Create with documented suppressions for intentional deviations. Each suppression must have a `reason` string explaining why the deviation is acceptable:
```typescript
import { NagSuppressions } from 'cdk-nag'
import { Stack } from 'aws-cdk-lib'

export function applyNagSuppressions(stack: Stack, stackName: string) {
  // Example: S3 access logging bucket cannot log to itself
  NagSuppressions.addStackSuppressions(stack, [
    { id: 'AwsSolutions-S1', reason: 'Access log bucket does not require its own access log' },
  ])
}
```

Run `npx cdk synth 2>&1 | grep -E "^\[Error\]"` to capture all findings. Fix what can be fixed; suppress with documented reasons what cannot.

Apply suppressions per-stack in each stack's constructor file (not globally).

### 2. L3 Construct Library

Create `infra/constructs/` directory with the following files:

**`infra/constructs/chimera-table.ts`**
```typescript
export interface ChimeraTableProps {
  tableName: string
  ttlAttribute?: string
  additionalGsis?: dynamodb.GlobalSecondaryIndexPropsV2[]
}

export class ChimeraTable extends Construct {
  readonly table: dynamodb.TableV2

  constructor(scope: Construct, id: string, props: ChimeraTableProps) {
    super(scope, id)
    // Mandatory: tenantId as partition key
    // PITR enabled
    // TTL attribute if provided
    // CMK encryption (use encryptionKey prop)
    // DynamoDB Streams: StreamViewType.NEW_AND_OLD_IMAGES
    // BillingMode: PAY_PER_REQUEST
  }
}
```

Invariants enforced:
- Partition key MUST be `tenantId` (validated in constructor, throws if not)
- PITR always enabled
- KMS encryption always enabled (caller provides key or one is created)
- Streams always enabled (NEW_AND_OLD_IMAGES)

**`infra/constructs/chimera-bucket.ts`**
```typescript
export class ChimeraBucket extends Construct {
  readonly bucket: s3.Bucket

  constructor(scope: Construct, id: string, props: ChimeraBucketProps) {
    super(scope, id)
    // KMS encryption (not S3-managed AES256)
    // Versioning enabled
    // Access logging to access-log bucket (created internally or passed in)
    // Block public access: all 4 settings true
    // Lifecycle rules: noncurrent version expiry, incomplete multipart upload abort
    // Enforce SSL (bucket policy deny non-HTTPS)
  }
}
```

**`infra/constructs/chimera-lambda.ts`**
```typescript
export class ChimeraLambda extends Construct {
  readonly fn: lambda.Function

  constructor(scope: Construct, id: string, props: ChimeraLambdaProps) {
    super(scope, id)
    // X-Ray tracing: Active
    // Structured logging: LOG_LEVEL env var, JSON format
    // Log retention: 7 days (dev), 180 days (prod) — determined by props.environment
    // Retry config: maxEventAge 6h, bisectBatchOnError true
    // Dead letter queue: SQS DLQ wired automatically
    // Reserved concurrency: configurable, default undefined (no limit)
    // Function name follows convention: chimera-{name}-{env}
  }
}
```

**`infra/constructs/chimera-queue.ts`**
```typescript
export class ChimeraQueue extends Construct {
  readonly queue: sqs.Queue
  readonly dlq: sqs.Queue

  constructor(scope: Construct, id: string, props: ChimeraQueueProps) {
    super(scope, id)
    // DLQ: maxReceiveCount: 3, KMS encrypted
    // Main queue: KMS encrypted, visibility timeout 6x Lambda timeout
    // CloudWatch alarm: ApproximateAgeOfOldestMessage > 300 seconds
    // CloudWatch alarm: ApproximateNumberOfMessagesNotVisible > 1000
  }
}
```

**`infra/constructs/index.ts`**
```typescript
export { ChimeraTable } from './chimera-table'
export { ChimeraBucket } from './chimera-bucket'
export { ChimeraLambda } from './chimera-lambda'
export { ChimeraQueue } from './chimera-queue'
```

### 3. Custom CDK Aspects

Create `infra/aspects/` directory:

**`infra/aspects/tenant-isolation.ts`**
- Visits all `CfnTable` resources
- Verifies `keySchema` has a `HASH` key named `tenantId`
- If not found: throws an `Annotations.of(node).addError(...)` (not a runtime throw)

**`infra/aspects/encryption.ts`**
- Visits all `CfnBucket` resources
- Verifies `serverSideEncryptionConfiguration` uses `aws:kms` algorithm
- If AES256 or missing: adds error annotation

**`infra/aspects/log-retention.ts`**
- Visits all `CfnLogGroup` resources
- Verifies `retentionInDays` is set (not undefined)
- If missing: adds warning annotation

**`infra/aspects/tagging.ts`**
- Visits all taggable resources
- Ensures `Environment`, `Project=chimera`, `ManagedBy=cdk` tags are present
- Add (not replace) — preserves any existing tags

**`infra/aspects/index.ts`**
```typescript
export { TenantIsolationAspect } from './tenant-isolation'
export { EncryptionAspect } from './encryption'
export { LogRetentionAspect } from './log-retention'
export { TaggingAspect } from './tagging'
```

Apply all aspects in `infra/bin/chimera.ts` after cdk-nag:
```typescript
import * as aspects from '../aspects'
Aspects.of(app).add(new aspects.TenantIsolationAspect())
Aspects.of(app).add(new aspects.EncryptionAspect())
Aspects.of(app).add(new aspects.LogRetentionAspect())
Aspects.of(app).add(new aspects.TaggingAspect({ environment: env }))
```

### 4. Refactor Existing Stacks

**`infra/lib/data-stack.ts`**
- Replace all 6 raw `dynamodb.Table` (or `dynamodb.TableV2`) with `ChimeraTable`
- Replace all 3 raw `s3.Bucket` instances with `ChimeraBucket`
- Import from `'../constructs'`

**`infra/lib/evolution-stack.ts`**
- Replace raw `lambda.Function` instances with `ChimeraLambda`
- Verify DLQ wiring is not duplicated (ChimeraLambda creates DLQ automatically)

**`infra/lib/skill-pipeline-stack.ts`**
- Replace raw `lambda.Function` with `ChimeraLambda`
- The ESM asset pattern must be preserved (see mulch record `skill-pipeline-lambda-esm-asset-pattern`)

**`infra/lib/orchestration-stack.ts`**
- Replace raw `sqs.Queue` with `ChimeraQueue`
- Verify existing SFN `.addCatch` patterns are preserved (see mulch record `sfn-addcatch-pattern`)

### 5. AWS Solutions Constructs Evaluation

Create `docs/architecture/aws-solutions-constructs-eval.md` with a table evaluating:
- `aws-cloudfront-s3`: Evaluate for FrontendStack (Stream 3)
- `aws-lambda-dynamodb`: Evaluate for API Lambda handlers
- `aws-sqs-lambda`: Evaluate for orchestration queue processors

For each: compatibility with existing patterns, what we'd gain, what we'd lose, verdict (adopt/defer/skip).

## Acceptance Criteria

- [ ] `npx cdk synth` produces 0 cdk-nag `[Error]` messages — all findings either fixed or have a suppression with `reason` string
- [ ] All 6 DynamoDB tables in `data-stack.ts` use `ChimeraTable`
- [ ] All S3 buckets in `data-stack.ts` use `ChimeraBucket` with KMS (not AES256)
- [ ] `infra/aspects/encryption.ts` aspect catches a bucket with AES256 encryption during test
- [ ] `infra/aspects/tenant-isolation.ts` aspect catches a table without `tenantId` PK during test
- [ ] `npx cdk synth` completes without errors after refactor

## Test Requirements

**`infra/tests/constructs/chimera-table.test.ts`**
- Verify ChimeraTable creates PITR-enabled table
- Verify ChimeraTable rejects non-tenantId partition keys
- Verify encryption is KMS

**`infra/tests/constructs/chimera-bucket.test.ts`**
- Verify versioning is enabled
- Verify public access is blocked
- Verify encryption uses KMS

**`infra/tests/aspects/encryption.test.ts`**
- Verify aspect adds error annotation when bucket uses AES256
- Verify aspect passes when bucket uses KMS

**`infra/tests/aspects/tenant-isolation.test.ts`**
- Verify aspect adds error annotation when table lacks tenantId PK
- Verify aspect passes when table has tenantId PK

Use `beforeAll` for stack synthesis (see mulch record `cdk-test-beforeall-pattern`).

## Dependencies on Other Streams

- **Stream 1**: No hard dependency, but test failures from Stream 1 should be resolved before running cdk-nag in CI
- **Stream 3**: `aws-cloudfront-s3` evaluation feeds into FrontendStack design
- **Stream 5**: No dependency

## Risk Assessment

- **High**: Refactoring all 6 tables and all S3 buckets carries risk of breaking existing stack outputs — run `npx cdk diff` before and after to verify no CloudFormation resource replacements
- **High**: Cross-stack KMS references — review mulch records `cdk-cross-stack-kms-sqs-lambda-cycle` and `cdk-sqs-kms-cross-stack-grant-cycle` before wiring KMS keys
- **Medium**: cdk-nag may surface 50+ findings — budget time for suppression documentation
- **Mitigation**: Create a branch snapshot after each sub-section (constructs, aspects, refactor) to enable partial rollback
