---
title: "AWS Solutions Constructs Evaluation"
version: 1.0.0
status: canonical
last_updated: 2026-03-27
references: [ADR-025, ADR-026]
---

# AWS Solutions Constructs Evaluation

## Background

AWS Solutions Constructs are opinionated higher-level CDK patterns that combine two or more
AWS services into well-architected constructs. This document evaluates whether adopting them
makes sense for Chimera, given our existing L3 construct library (ChimeraTable, ChimeraBucket,
ChimeraLambda, ChimeraQueue) and Aspects-based compliance enforcement.

Evaluated as part of Stream 2 CDK Hardening (ADR-025, ADR-026).

---

## Summary Table

| Construct | Use Case | Chimera Compatibility | Verdict |
|-----------|----------|----------------------|---------|
| `aws-cloudfront-s3` | FrontendStack S3+CloudFront | High — pattern matches FrontendStack | **defer** |
| `aws-lambda-dynamodb` | API Lambda → DynamoDB handlers | Low — ChimeraTable/ChimeraLambda give more control | **skip** |
| `aws-sqs-lambda` | Orchestration queue processors | Low — ChimeraQueue+ChimeraLambda cover this | **skip** |

---

## 1. `aws-cloudfront-s3`

**What it does:** Creates a CloudFront distribution backed by an S3 bucket with OAI/OAC,
SSL enforcement, and best-practice security headers.

**Chimera use case:** FrontendStack (Stream 3) needs S3+CloudFront for the React SPA.
The existing `FrontendStack` already implements this pattern manually using two CachePolicy
constructs (HTML TTL 0, asset TTL 1yr).

**Compatibility analysis:**

| Factor | Assessment |
|--------|------------|
| Encryption | Uses S3-managed by default; Chimera prefers KMS via ChimeraBucket |
| Access logging | Provided, but cannot use ChimeraBucket's internal log bucket |
| Cache policies | Fixed defaults; Chimera FrontendStack uses custom dual-cache policies |
| WAF integration | Not included; Chimera attaches WAF via SecurityStack separately |
| Custom domain | Supported but requires additional configuration |

**What we'd gain:** Pre-validated CloudFront+S3 setup, reduced boilerplate, automatic OAC setup.

**What we'd lose:** KMS encryption control (ChimeraBucket default), custom dual-cache policy
configuration (HTML TTL 0 for SPA routing, asset TTL 1yr for fingerprinted files), and the
ability to integrate our existing FrontendStack lifecycle rules.

**Verdict: Defer**

The existing FrontendStack already works and is tested. Migrating to this construct in Stream 3
is worth evaluating at that time, as the dual-cache policy pattern may not map cleanly to
the construct's defaults. If adopted, it would need a ChimeraBucket-compatible encryption
wrapper.

---

## 2. `aws-lambda-dynamodb`

**What it does:** Creates a Lambda function with IAM read/write access to a DynamoDB table,
including correct stream trigger configuration.

**Chimera use case:** API Lambda handlers (chat, session management) need to query DynamoDB.

**Compatibility analysis:**

| Factor | Assessment |
|--------|------------|
| Lambda construct | Uses vanilla `lambda.Function`; Chimera uses ChimeraLambda (adds DLQ, tracing, retention) |
| DynamoDB construct | Uses `dynamodb.Table` (V1); Chimera uses ChimeraTable (TableV2/GlobalTable) |
| Grant pattern | Provides grantRead/grantReadWrite; Chimera already calls these manually |
| Encryption | S3-managed by default; incompatible with ChimeraTable KMS |
| Monitoring | No built-in CloudWatch alarms; Chimera uses ChimeraQueue alarms + Aspects |

**What we'd gain:** Minimal — the construct automates a `table.grantReadWriteData(fn)` call
that we already perform manually.

**What we'd lose:** ChimeraLambda invariants (DLQ, X-Ray tracing, structured logging, log
retention). Would require wrapping or extending, eliminating the simplicity benefit.

**Verdict: Skip**

The value proposition of `aws-lambda-dynamodb` is most useful when starting from scratch.
Chimera's ChimeraLambda and ChimeraTable already encode all the same best practices and more.
Adopting this construct would require either replacing our L3 constructs or adding complex
wrapper code. Net result: more complexity for no security or operational gain.

---

## 3. `aws-sqs-lambda`

**What it does:** Creates an SQS queue with a Lambda event source mapping, including dead-letter
queue, KMS encryption, and redrive policy configuration.

**Chimera use case:** OrchestrationStack queue processors (background task workers, swarm agents).

**Compatibility analysis:**

| Factor | Assessment |
|--------|------------|
| Queue construct | Uses vanilla `sqs.Queue`; Chimera uses ChimeraQueue (adds alarms, DLQ, KMS) |
| Lambda construct | Uses vanilla `lambda.Function`; Chimera uses ChimeraLambda |
| Event source mapping | Provides ESM with batch size, bisect-on-error; Chimera configures these manually |
| DLQ | Provided; but ChimeraQueue already creates a DLQ with CloudWatch alarms |
| KMS | Supports KMS; Chimera passes platformKey to ChimeraQueue |

**What we'd gain:** Event source mapping configuration is bundled with the queue/Lambda setup.

**What we'd lose:** ChimeraQueue's mandatory CloudWatch alarms (backlog + message age),
ChimeraLambda's mandatory DLQ and X-Ray tracing. The construct's DLQ would conflict with
ChimeraQueue's built-in DLQ, creating duplicate DLQ logic.

**Verdict: Skip**

Similar to `aws-lambda-dynamodb`: our L3 constructs already exceed what this pattern provides.
The event source mapping is the only incremental value, and it's a two-line CDK call. Adding
this construct would create DLQ duplication and force us to work around ChimeraQueue/ChimeraLambda
invariants.

---

## Recommendations

1. **Do not adopt any AWS Solutions Constructs in Stream 2.** Our ChimeraTable, ChimeraBucket,
   ChimeraLambda, and ChimeraQueue provide equivalent or superior defaults with project-specific
   invariants that Solutions Constructs cannot enforce.

2. **Re-evaluate `aws-cloudfront-s3` for Stream 3 (FrontendStack).** This is the strongest
   candidate for adoption. If Stream 3 refactors FrontendStack, evaluate whether the construct
   can accommodate our dual-cache policy and KMS encryption requirements.

3. **Track new constructs.** AWS actively adds to the Solutions Constructs library. Review
   additions against our use cases when starting major new infrastructure streams.
