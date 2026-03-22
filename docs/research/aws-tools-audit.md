---
title: "AWS Tools Audit — Existing vs Missing"
status: research
last_updated: 2026-03-22
author: lead-research-tools
task: chimera-7a11
---

# AWS Tools Audit

Audit of `packages/core/src/aws-tools/` against the full 25-service target list.

## Summary

- **19 tool files** fully implemented (Tiers 1-3)
- **7 services** with client support but no tool files
- **10 target services** missing entirely

## Existing Tool Files (19)

These services have complete tool implementations in `packages/core/src/aws-tools/`:

1. **athena-tool.ts** — Query execution, catalog management
2. **bedrock-tool.ts** — Foundation model invocation
3. **cloudwatch-tool.ts** — Metrics, alarms, logs
4. **codebuild-tool.ts** — Build project management
5. **codecommit-tool.ts** — Git repository operations
6. **codepipeline-tool.ts** — CI/CD pipeline management
7. **ec2-tool.ts** — Instance management
8. **glue-tool.ts** — Data catalog and ETL
9. **lambda-tool.ts** — Function management and invocation
10. **opensearch-tool.ts** — Search cluster operations
11. **rds-tool.ts** — Relational database management
12. **redshift-tool.ts** — Data warehouse operations
13. **rekognition-tool.ts** — Image and video analysis
14. **s3-tool.ts** — Object storage operations
15. **sagemaker-tool.ts** — ML model deployment
16. **sqs-tool.ts** — Message queue operations
17. **stepfunctions-tool.ts** — Workflow orchestration
18. **textract-tool.ts** — Document analysis
19. **transcribe-tool.ts** — Speech-to-text

## Client Support Only (7)

These services have `AWSClientFactory` getter methods and retryable error constants in `tool-utils.ts`, but no tool files:

1. **ECS** — Container orchestration (`getECSClient`, `ECS_RETRYABLE_ERRORS`)
2. **DynamoDB** — NoSQL database (`getDynamoDBClient`, `DYNAMODB_RETRYABLE_ERRORS`)
3. **EFS** — File storage (`getEFSClient`, `EFS_RETRYABLE_ERRORS`)
4. **IAM** — Identity and access (`getIAMClient`, `IAM_RETRYABLE_ERRORS`)
5. **CloudFront** — CDN (`getCloudFrontClient`, `CLOUDFRONT_RETRYABLE_ERRORS`)
6. **Route53** — DNS service (`getRoute53Client`, `ROUTE53_RETRYABLE_ERRORS`)
7. **WAFv2** — Web application firewall (`getWAFv2Client`, `WAFV2_RETRYABLE_ERRORS`)

**Status:** Infrastructure ready, tools pending implementation.

## Missing Services (10)

These services have no client support or tool files:

### High Priority (from task spec)
1. **EBS** (Elastic Block Store) — Volume management for EC2
2. **Kinesis** — Real-time data streaming
3. **API Gateway** — REST/WebSocket API management
4. **EventBridge** — Event bus and routing
5. **SNS** — Pub/sub messaging
6. **CloudTrail** — Audit logging
7. **Config** — Resource compliance tracking
8. **Systems Manager (SSM)** — Parameter store, command execution
9. **X-Ray** — Distributed tracing

### Additional Gaps
10. **EBS** — Block storage (volumes, snapshots)

**Status:** Require both client factory getters and tool implementations.

## Tool Implementation Pattern

All existing tools follow the standardized pattern documented in mulch record `aws-tool-implementation-pattern` (mx-9e534b):

```typescript
// 1. Export retryable error constants
export const SERVICENAME_RETRYABLE_ERRORS = [
  'ThrottlingException',
  'ServiceUnavailable',
  // ...
];

// 2. Export tool factory function
export function createServiceNameTools(
  clientFactory: AWSClientFactory
): StrandsTool[] {
  return [
    {
      name: 'service_operation',
      description: 'Operation description',
      inputSchema: { /* JSON Schema */ },
      execute: async (input: any, context: AWSToolContext) => {
        // Implementation with retry logic
      }
    }
  ];
}
```

## Client Factory Pattern

For services with client support only, `AWSClientFactory` already provides:

- Tenant-scoped credential management via STS AssumeRole
- Client caching with TTL (default 3600s)
- Exponential backoff retry configuration
- Request timeout settings (default 30s)

Adding new services requires:

1. Import SDK client in `client-factory.ts`
2. Add to `AWSClient` union type
3. Implement `getServiceClient(context)` method
4. Export retryable error constants in `tool-utils.ts`

## Next Steps

### Phase 1: Promote Client-Ready Services (Tier 2)
Create tool files for the 7 services with existing client support:
- `ecs-tool.ts`
- `dynamodb-tool.ts`
- `efs-tool.ts`
- `iam-tool.ts`
- `cloudfront-tool.ts`
- `route53-tool.ts`
- `wafv2-tool.ts`

### Phase 2: Add Missing Tier 3 Services
Implement full stack (client + tools) for high-priority services:
- `kinesis-tool.ts`
- `apigateway-tool.ts`
- `eventbridge-tool.ts`
- `sns-tool.ts`
- `ebs-tool.ts`

### Phase 3: Observability & Governance (Tier 4)
- `cloudtrail-tool.ts`
- `config-tool.ts`
- `ssm-tool.ts`
- `xray-tool.ts`

## References

- [AWS Tool Implementation Pattern](../.mulch/records/development/mx-9e534b.md)
- [Gateway Tool Priming](../.mulch/records/integration/mx-f7fb91.md)
- [Strands Tool Definition](./packages/core/src/aws-tools/strands-agents.d.ts)
