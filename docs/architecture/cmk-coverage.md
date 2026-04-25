---
title: "Chimera CMK encryption coverage"
status: canonical
date: 2026-04-25
last_updated: 2026-04-25
wave: 19
---

# Chimera CMK Encryption Coverage

This document enumerates every persistent data path in the Chimera platform
and the encryption key used for each. It is the authoritative reference for
SOC-2 CC6.1 and similar controls, and it documents the three AWS-service
constraints where customer-managed key (CMK) coverage is not possible.

## Full coverage matrix

| Data path | Resource | Encryption | Key alias |
|-----------|----------|------------|-----------|
| Tenant metadata | DynamoDB `chimera-tenants-{env}` | CMK | `chimera-tenants-{env}` |
| Active sessions | DynamoDB `chimera-sessions-{env}` | CMK | `chimera-sessions-{env}` |
| Skills registry | DynamoDB `chimera-skills-{env}` | CMK | `chimera-skills-{env}` |
| Rate-limit state | DynamoDB `chimera-rate-limits-{env}` | CMK | `chimera-rate-limits-{env}` |
| Cost accumulators | DynamoDB `chimera-cost-tracking-{env}` | CMK | `chimera-cost-tracking-{env}` |
| Audit events | DynamoDB `chimera-audit-{env}` | CMK | `chimera-audit-{env}` |
| Tenant object storage | S3 `chimera-tenants-{account}-{region}-{env}` | CMK | via `ChimeraBucket` |
| Skills packages | S3 `chimera-skills-{account}-{region}-{env}` | CMK | via `ChimeraBucket` |
| Artifacts | S3 `chimera-artifacts-{account}-{region}-{env}` | CMK | via `ChimeraBucket` |
| Platform logs | CloudWatch `ChimeraApp*` log groups | CMK | `chimera-platform-{env}` |
| API Gateway access logs | CloudWatch `ApiAccessLogs` | CMK | `chimera-platform-{env}` |
| WebSocket access logs | CloudWatch `WsAccessLog` | CMK | `chimera-platform-{env}` |
| Pipeline alarm topic | SNS `chimera-pipeline-alarms-{env}` | CMK | `chimera-platform-{env}` |
| Secrets | Secrets Manager | CMK | `chimera-platform-{env}` |

## AWS-service constraints (no CMK possible)

Three data paths cannot use customer-managed keys because of AWS-service
limitations. These are enumerated here so auditors see them as deliberate,
documented exceptions rather than overlooked gaps.

### 1. DAX cluster at-rest cache

**Resource:** `infra/lib/data-stack.ts:267` — `dax.CfnCluster`.

**Constraint:** AWS Amazon DynamoDB Accelerator (DAX) does not support
customer-managed KMS keys. Per the AWS DynamoDB Encryption at Rest docs:
"When creating a new DAX cluster with encryption at rest enabled, an AWS
managed key is used." The `AWS::DAX::Cluster` CloudFormation resource
exposes only `SSESpecification.SSEEnabled: boolean` — there is no field
to specify a CMK ARN.

**Mitigation:**
- DAX is deployed inside the isolated VPC subnet tier with no internet
  route and no public endpoint.
- Security-group ingress to port 8111 is scoped to the chat-gateway
  task security group only (`chatGatewayTaskSecurityGroup`), not the
  broader ECS SG.
- The 6 underlying DynamoDB tables are still encrypted with per-table
  CMKs; a direct data exfiltration attack would target DDB, not DAX.
- AWS-owned key usage is not auditable via CloudTrail key-usage events
  (no `kms:Decrypt` audit trail), which is the main SOC-2 CC6.1 gap.
  Partially compensated by DynamoDB CMK CloudTrail events for writes.

**References:**
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/EncryptionAtRest.html
- Wave-17 security-ops review C-1 (finding accepted 2026-04-25, Wave-19)

### 2. ALB access log S3 bucket

**Resource:** `infra/lib/chat-stack.ts:388` — `s3.Bucket` used by
`applicationLoadBalancer.logAccessLogs(...)`.

**Constraint:** AWS Elastic Load Balancing's access-log delivery service
supports only `SSE-S3` or `SSE-KMS with aws-managed key`. Customer-managed
KMS keys are not supported as the destination-bucket encryption key for
ALB access logs.

**Mitigation:**
- Bucket is `BucketEncryption.KMS_MANAGED` (not plaintext / SSE-S3).
- Versioning is enabled; 30-day lifecycle rule expires old logs.
- SSL enforcement + block-public-access applied.
- Bucket owner is the platform account; no cross-account delivery.

**References:**
- https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html
- Wave-19 concurrent reviewer finding I7

### 3. CloudTrail log file (if configured)

**Resource:** not currently provisioned by Chimera — AWS-account-level
CloudTrail in `baladita+Bedrock-Admin` is configured outside this stack.

**Constraint:** CloudTrail supports CMKs, but the default account-wide
trail uses an AWS-managed key.

**Mitigation:** N/A — tenant account owner manages CloudTrail settings.

## Uniform key-rotation posture

All 9 CMKs (6 per-table + 1 platform + 1 audit [explicit via data-stack] + 1
audit table) have:

- `enableKeyRotation: true` — annual AWS-managed rotation
- `removalPolicy: RETAIN` in prod (DESTROY in dev)
- Aliases following `chimera-{scope}-{env}` pattern

Aliases are critical for IAM symbolic references and for operator
troubleshooting via the KMS console (keys are otherwise identified only
by AWS-generated UUIDs).

## Verification commands

```bash
# List all Chimera CMKs by alias
aws kms list-aliases --query 'Aliases[?starts_with(AliasName,`alias/chimera-`)].[AliasName,TargetKeyId]' --output table

# For each table, confirm CMK encryption
aws dynamodb describe-table --table-name chimera-tenants-dev \
  --query 'Table.SSEDescription.{Status:Status,KMSMasterKeyArn:KMSMasterKeyArn}'

# Confirm S3 buckets use CMK
aws s3api get-bucket-encryption --bucket chimera-tenants-{account}-{region}-dev

# Confirm CloudWatch log groups are CMK-encrypted
aws logs describe-log-groups --log-group-name-prefix /chimera \
  --query 'logGroups[].{Name:logGroupName,KmsKeyId:kmsKeyId}'
```

## Change log

- 2026-04-25 (Wave-19): Initial version. Documents C-1 acceptance
  (DAX is AWS-managed-key-only), H-1 named CMK aliases for all 6 DDB
  tables, M-1 API log CMK coverage, I7 ALB log bucket KMS_MANAGED exception.
