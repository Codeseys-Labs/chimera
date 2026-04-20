# CDK Infrastructure Review

## Executive Summary

The Chimera CDK infrastructure demonstrates solid architectural foundation with well-designed multi-stack composition, comprehensive cross-cutting aspects (encryption, tagging, log retention), and thoughtful use of L3 constructs (ChimeraLambda, ChimeraQueue, ChimeraBucket, ChimeraTable). However, the audit identified 28 findings spanning critical bugs, high-priority gaps, and medium-priority improvements. Critical issues include: missing WAF logging, incomplete CloudWatch Logs KMS grants, overpermissioned DAX security groups, and missing DLQ visibility in several stacks. High-priority gaps include ALB access log suppression for cost, missing cross-region DR setup, incomplete backup/PITR validation, and lack of API Gateway caching misconfig safeguards.

**Top 3 Critical Findings:**
1. **DAX Security Group Overpermissioned** (infra/lib/data-stack.ts:200-209): DAX SG allows inbound on port 8111 from ANY source within the ECS SG, not scoped to specific task IPs or principals. Breach of ECS task → lateral movement to DAX possible.
2. **Missing WAF Logging** (infra/lib/security-stack.ts): WebACL created without CloudWatch logging, violating AWS best practices for attack surface visibility. No metrics on blocked requests.
3. **Incomplete KMS Policy for CloudWatch Logs** (infra/lib/security-stack.ts:48-69): KMS key policy grants CloudWatch Logs kms:CreateGrant, but platforms using this key for log group encryption (e.g., ObservabilityStack:60) may fail silently if encryption setup races ahead of policy attachment.

---

## Critical Findings

### 1. DAX Security Group Allows Any ECS Task
**Severity:** CRITICAL | **File:** infra/lib/data-stack.ts:200-209  
**Description:** DAX security group allows inbound 8111 from `ecsSecurityGroup` without scoping to specific tasks or roles. This means ANY workload attached to that SG (compromised or rogue) can access DAX. Combined with loose DAX IAM role permissions (grantReadWriteData on all 6 tables), a single ECS task compromise grants full DynamoDB access.

**Impact:** Multi-tenant data isolation bypass; unauthorized read/write of all tables (tenants, audit, cost-tracking).

**Suggested Fix:**
- Create a separate, stricter SG just for chat-gateway tasks that has DynamoDB endpoint access.
- Use principal-based IAM role restrictions instead of SG-only access.
- Consider using VPC endpoint policies to enforce least-privilege access per Lambda/ECS task role.

---

### 2. WAF WebACL Missing CloudWatch Logging
**Severity:** CRITICAL | **File:** infra/lib/security-stack.ts:279-338  
**Description:** WebACL is created with CloudWatch metrics enabled (visibilityConfig.cloudWatchMetricsEnabled = true) but no CloudWatch Logs destination configured. Blocked requests are NOT logged to CloudWatch Logs; only high-level metrics available. Violates AWS Well-Architected Framework (security pillar: logging for auditing/investigation).

**Impact:** No audit trail for WAF blocks; cannot investigate attack patterns or false positives; no forensics post-incident.

**Suggested Fix:**
```typescript
new logs.LogGroup(this, 'WafLogGroup', {
  logGroupName: `/aws/wafv2/chimera-api-${props.envName}`,
  retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
  encryptionKey: this.platformKey,
});

this.webAcl.loggingConfiguration = {
  resourceArn: wafLogGroup.logGroupArn,
  cloudWatchLogsLogDestinationConfig: { logDestination: wafLogGroup.logGroupArn },
};
```

---

### 3. KMS Key Policy May Race with CloudWatch Logs Encryption
**Severity:** CRITICAL | **File:** infra/lib/security-stack.ts:48-69 + infra/lib/observability-stack.ts:60  
**Description:** SecurityStack creates platformKey and adds CloudWatch Logs KMS policy, but ObservabilityStack (added as dependency after SecurityStack) creates a log group using that key. If the KMS policy attachment is not yet complete when the log group is created, the creation may fail silently or leave the log group unencrypted.

**Impact:** LogGroup encryption may be bypassed; audit/observability logs stored unencrypted in worst case.

**Suggested Fix:**
- Ensure KMS key policy is added BEFORE exporting the key.
- Add explicit dependency: `observabilityStack.node.addDependency(securityStack)` in chimera.ts (already done, but worth verifying the policy is complete).
- Add CloudWatch Logs encryption in the EncryptionAspect to validate at synth time.

---

### 4. Missing DLQ Visibility for Lambda Async Invocations
**Severity:** HIGH | **File:** infra/lib/security-stack.ts:112-175  
**Description:** PostConfirmationTrigger Lambda has a DLQ created (via ChimeraLambda construct), but the trigger source (Cognito) does NOT explicitly send failed invocations to the DLQ. Cognito triggers are synchronous; failures are not retried to DLQ. If the Lambda fails, the user sign-up flow hangs without visibility into the failure.

**Impact:** Tenant onboarding can fail silently; no alerting on sign-up failures.

**Suggested Fix:**
- Add CloudWatch Logs error detection for this Lambda.
- Add explicit error handling in the Lambda to log and forward failures to an SNS topic.
- Set up CloudWatch alarm on Lambda Errors metric for post-confirmation Lambda.

---

## High-Priority Gaps

### 5. ALB Access Logs Disabled for Cost
**Severity:** HIGH | **File:** infra/cdk-nag-suppressions.ts:142-148  
**Description:** ChatStack ALB suppresses AwsSolutions-ELB2 (access logs disabled) with justification "for cost reduction in initial deployment". Access logs are crucial for security investigations, performance debugging, and compliance.

**Impact:** No visibility into ALB request/response patterns; compliance violation for PCI-DSS / SOC2.

**Suggested Fix:**
- Enable ALB access logs in prod; disable only in dev.
- Use S3 lifecycle rules to expire logs after 30 days to manage costs.
- Add Athena integration to query access logs without keeping them hot in S3.

---

### 6. No Cross-Region DR Configuration
**Severity:** HIGH | **File:** infra/bin/chimera.ts (overall)  
**Description:** All 14 stacks are single-region deployments. No multi-region table replication (Global Tables v2), no Route53 health checks, no cross-region failover for API Gateway or Chat service.

**Impact:** Regional outage = platform down; no disaster recovery path.

**Suggested Fix:**
- Add `replicaRegions` prop to DataStack and enable GlobalTable v2 for critical tables (tenants, audit, costTracking).
- Create a secondary-region deployment CDK stack (bootstrap via CDK cross-region context).
- Add Route53 health checks with failover routing policy.

---

### 7. PITR Backup Validation Missing
**Severity:** HIGH | **File:** infra/lib/observability-stack.ts:599-625  
**Description:** PITR alarms reference "AWS publishes backup metrics to CloudWatch when PITR is enabled" but this is a NOTE — no actual alarm is created to validate PITR is active. If a table's PITR is accidentally disabled, there's no alert.

**Impact:** Tables lose point-in-time recovery capability undetected; data loss risk in incident.

**Suggested Fix:**
- Use AWS Config rule `dynamodb-pitr-enabled` (managed) to continuously validate PITR status.
- Create CloudWatch composite alarm that aggregates Config compliance status.
- Add SNS alert if Config rule reports non-compliance.

---

### 8. Evolution Stack S3 Bucket Name Too Long
**Severity:** HIGH | **File:** infra/lib/evolution-stack.ts:77-82  
**Description:** Comment says "bucketName omitted to avoid access-log bucket name exceeding 63-char S3 limit". This creates a non-deterministic bucket name (auto-generated by CDK) and breaks reproducibility. Agents cannot hard-code the bucket name in configs.

**Impact:** Infrastructure as Code is not fully reproducible; bucket name discovery requires stack lookups at runtime.

**Suggested Fix:**
- Use a shorter prefix or split into environment-specific buckets.
- Create bucket name as: `chimera-evo-${account}-${region}-${envName}` (52 chars max).
- Access logs: `chimera-evo-logs-${account}-${region}` (40 chars max).

---

### 9. Missing API Gateway Caching Headers Validation
**Severity:** HIGH | **File:** infra/lib/api-stack.ts:96-100  
**Description:** API Gateway cache is enabled but no cache key validation is in place. If Lambda handlers return sensitive headers (Authorization, X-API-Key) or vary responses by tenant_id (not included in cache key), cache misses can leak tenant data.

**Impact:** Cross-tenant data leakage via API Gateway cache.

**Suggested Fix:**
```typescript
cacheKeyParameters: {
  headers: ['Authorization', 'Accept-Language'],
  queryStrings: ['tenant_id'],
},
```

---

### 10. Email Stack Uses Stack-Local KMS Key
**Severity:** HIGH | **File:** infra/lib/email-stack.ts:80-90 + comment on chimera.ts:245-246  
**Description:** EmailStack creates its own KMS key for SQS instead of using platformKey from SecurityStack "to avoid CDK circular dependency". This creates key management fragmentation; operators must manage N+1 KMS keys instead of centralized key policy.

**Impact:** Key rotation/access audit complexity; inconsistent encryption policies across stacks.

**Suggested Fix:**
- Pass `platformKey` as a prop to EmailStack (breaking the circular dependency requires reordering stack instantiation).
- Alternative: Create a shared encryptionContext or StackShared construct that both SecurityStack and EmailStack depend on.

---

## Medium-Priority Improvements

### 11. DAX Role Grants Too Broad
**Severity:** MEDIUM | **File:** infra/lib/data-stack.ts:233-235  
**Description:** DAX role is granted `grantReadWriteData` on all 6 tables without restriction. In a multi-tenant system, DAX should only cache tables that support full scans (sessions, skills). Tenants table (partitioned by tenantId) and audit table should NOT be cached at the DAX layer.

**Impact:** Performance optimization is applied indiscriminately; audit data caching violates immutability principles.

**Suggested Fix:**
- Scope DAX role to only: sessionsTable, skillsTable, rateLimitsTable.
- Remove DAX read/write grants from: tenantsTable, auditTable, costTrackingTable.

---

### 12. Network Stack: ECS Outbound Allowed to Internet
**Severity:** MEDIUM | **File:** infra/lib/network-stack.ts:120  
**Description:** ECS security group has `allowAllOutbound: true` without restrictions. ECS tasks can reach any IPv4 on the internet (including malicious hosts). Best practice: whitelist outbound to Bedrock, Secrets Manager, CloudWatch endpoints (via VPC endpoints, not NAT).

**Impact:** Compromised ECS task can exfiltrate data to external attacker infrastructure.

**Suggested Fix:**
```typescript
ecsSecurityGroup.addEgressRule(
  this.endpointSecurityGroup,
  ec2.Port.tcp(443),
  'ECS to VPC endpoints (Bedrock, Secrets Manager)'
);
// No wildcard 0.0.0.0/0 egress
```

---

### 13. Observability Stack: API Latency Alarm Missing Baseline
**Severity:** MEDIUM | **File:** infra/lib/observability-stack.ts:300-309  
**Description:** API Gateway p99 latency metric is graphed but no alarm is created for p99 > threshold. If baseline is 200ms and spike occurs, there's no alert. Only 5xx errors and throttles are alarmed.

**Impact:** Latency degradation goes unnoticed until customers complain.

**Suggested Fix:**
```typescript
const apiLatencyAlarm = new cloudwatch.Alarm(this, 'ApiLatencyAlarm', {
  metric: apiLatencyP99,
  threshold: 2000, // 2 second p99 is degraded
  evaluationPeriods: 3,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
```

---

### 14. No Lambda Reserved Concurrency for Critical Paths
**Severity:** MEDIUM | **File:** infra/lib/security-stack.ts:112-175 (PostConfirmationTrigger), others  
**Description:** Lambda functions that are part of critical user flows (sign-up, chat, tenant provisioning) don't reserve concurrency. If the account hits Lambda limits, these functions throttle first.

**Impact:** Sign-ups fail under load; user experience degrades unpredictably.

**Suggested Fix:**
- PostConfirmationTrigger: reserved concurrency 100
- ChatGateway Lambdas: reserved concurrency 500
- TenantOnboarding Lambdas: reserved concurrency 50

---

### 15. CloudWatch Dashboard Widgets Missing Error Context
**Severity:** MEDIUM | **File:** infra/lib/observability-stack.ts:156-286  
**Description:** Platform dashboard shows metrics (read/write throttles, latency, errors) but no drilldown links to CloudWatch Logs Insights or runbooks. Dashboard is read-only; operators must manually jump to logs to investigate.

**Impact:** MTTR increases due to lack of drill-down context.

**Suggested Fix:**
- Add dashboard annotations with runbook URLs.
- Add custom widgets with CloudWatch Logs Insights queries embedded.

---

### 16. Cognito MFA Optional (Not Required)
**Severity:** MEDIUM | **File:** infra/lib/security-stack.ts:90  
**Description:** Cognito user pool has `mfa: cognito.Mfa.OPTIONAL`, allowing users to bypass MFA. For a multi-tenant agent platform, MFA should be REQUIRED for production.

**Impact:** Account takeover risk; weaker auth posture.

**Suggested Fix:**
```typescript
mfa: isProd ? cognito.Mfa.REQUIRED : cognito.Mfa.OPTIONAL,
```

---

### 17. Missing Tagging for Cost Allocation
**Severity:** MEDIUM | **File:** infra/bin/chimera.ts:334-337  
**Description:** Global tags are applied (Project, Environment, ManagedBy), but no cost allocation tags (CostCenter, Owner, Team). Billing breakdowns by team/project are not possible.

**Impact:** Cost attribution and chargeback impossible.

**Suggested Fix:**
```typescript
const projectTags: Record<string, string> = {
  Project: 'Chimera',
  Environment: envName,
  ManagedBy: 'CDK',
  CostCenter: app.node.tryGetContext('costCenter') ?? 'engineering',
  Owner: app.node.tryGetContext('ownerTeam') ?? 'platform',
};
```

---

### 18. API Stack: No Rate Limiting per Tenant
**Severity:** MEDIUM | **File:** infra/lib/api-stack.ts:80-82  
**Description:** API Gateway throttling is global (10,000 req/s prod, 1,000 dev). No per-tenant rate limiting; a single tenant can consume all quota.

**Impact:** Noisy neighbor problem; one tenant's load tests starve others.

**Suggested Fix:**
- Implement rate limiting in Lambda authorizer using DynamoDB (chimera-rate-limits table).
- Return `QuotaExceeded` for tenant that exceeds its tier quota.

---

### 19. Missing Alarm for Lambda DLQ Depth
**Severity:** MEDIUM | **File:** infra/constructs/chimera-lambda.ts  
**Description:** ChimeraLambda creates a DLQ but does not create a CloudWatch alarm for ApproximateNumberOfMessagesVisible. If messages accumulate in the DLQ, there's no alert.

**Impact:** Failed Lambda invocations are silently queued; no visibility.

**Suggested Fix:**
```typescript
const dlqDepthAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
  metric: this.dlq.metricApproximateNumberOfMessagesVisible(),
  threshold: 10,
  evaluationPeriods: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
```

---

### 20. Data Stack: PAY_PER_REQUEST Scaling May Introduce Throttles
**Severity:** MEDIUM | **File:** infra/lib/data-stack.ts:52  
**Description:** All DynamoDB tables use PAY_PER_REQUEST billing. While this is good for multi-tenant unpredictable workloads, DynamoDB has a hard limit of 40,000 RCU and 40,000 WCU per table. If traffic spikes, tables will throttle.

**Impact:** PAY_PER_REQUEST does not guarantee unlimited throughput; throttles still occur at the per-partition limit.

**Suggested Fix:**
- Add Observability monitoring for consumed capacity utilization (already done via throttle alarms).
- Document scaling limits in runbook: "Tables throttle at 40K RCU/WCU; contact AWS Support to increase soft limits."

---

## Low-Priority / Nice-to-Have

### 21. No Integration Tests for Cross-Stack Exports
**Severity:** LOW | **File:** infra/bin/chimera.ts (overall)  
**Description:** Stack outputs are exported for cross-stack consumption, but there's no automated test validating that consumers can import these exports. If an export name changes, dependent stacks silently fail at deploy time.

**Suggested Fix:**
- Add integration test that validates all exported names exist and have expected types.

---

### 22. Pipeline ECR Repositories Not Scanned for Base Image Vulnerabilities
**Severity:** LOW | **File:** infra/lib/pipeline-stack.ts:79-98  
**Description:** ECR repositories have `imageScanOnPush: true`, but only scans pushed images, not base images in Dockerfile. Vulnerabilities in base OS layers are not caught pre-build.

**Suggested Fix:**
- Integrate a container build security tool (Trivy, Grype) into CodeBuild before Docker push.

---

### 23. CloudFront Distribution Missing Security Headers
**Severity:** LOW | **File:** infra/lib/frontend-stack.ts:89-136  
**Description:** CloudFront distribution doesn't set response headers (X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security). SPA is vulnerable to MIME-sniffing and clickjacking.

**Suggested Fix:**
```typescript
responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
  securityHeadersBehavior: {
    strictTransportSecurity: { override: true, accessControlMaxAge: cdk.Duration.days(365) },
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
  },
}),
```

---

### 24. EventBridge Archive Retention Too Short
**Severity:** LOW | **File:** infra/lib/orchestration-stack.ts:58-66  
**Description:** EventArchive retention is 30 days (prod) / 7 days (dev). For a system with agent self-modification, event replay is critical for understanding evolution decisions. 30 days is very short.

**Suggested Fix:**
```typescript
retention: isProd ? cdk.Duration.days(90) : cdk.Duration.days(14),
```

---

### 25. TenantIsolationAspect Name Misleading
**Severity:** LOW | **File:** infra/aspects/tenant-isolation.ts  
**Description:** The aspect is named TenantIsolationAspect but only validates DynamoDB tables have a partition key. It doesn't actually enforce tenant isolation (e.g., checking that all queries include tenant_id). Name is misleading.

**Suggested Fix:**
- Rename to `PartitionKeyValidationAspect` or add logic to check partition key naming conventions (e.g., must start with TENANT#).

---

### 26. No Gradual Canary Traffic Increase in Pipeline
**Severity:** LOW | **File:** infra/lib/pipeline-stack.ts:38-62  
**Description:** Comment references "Progressive Rollout: 25% → 50% → 100%" but the CDK doesn't implement traffic shifting. Pipeline stages are either manual or Lambda-triggered, not gradual.

**Suggested Fix:**
- Use AWS CodeDeploy with LINEAR traffic shift policy (10% every minute).
- Integrate with Lambda canary evaluation to auto-rollback if error rate > 5%.

---

### 27. Missing Health Check for DAX Cluster
**Severity:** LOW | **File:** infra/lib/data-stack.ts:241-254  
**Description:** DAX cluster is created but no health check alarm is configured. If the cluster becomes unhealthy, queries silently bypass DAX and hit DynamoDB directly.

**Suggested Fix:**
- Add CloudWatch alarm for DAX cluster "NodeFailureCount" metric.

---

### 28. Unused Gateway Registration Stack in chimera.ts
**Severity:** LOW | **File:** infra/bin/chimera.ts (GatewayRegistrationStack is defined but NOT instantiated)  
**Description:** GatewayRegistrationStack is imported and defined in codebase but never instantiated in chimera.ts. The stack is dead code.

**Suggested Fix:**
- Either instantiate the stack or remove from imports.
- If intentional (WIP), add a comment explaining why.

---

## Stack-by-Stack Notes

### NetworkStack
- **Good:** Proper NAT gateway HA (2 in prod, 1 in dev); VPC Flow Logs for audit.
- **Issue:** ECS and Agent SGs allow `allowAllOutbound: true`. Should be restricted to VPC endpoints and NAT.

### DataStack
- **Good:** All tables use ChimeraTable (PITR, KMS, streams, deletion protection).
- **Issue:** DAX security group overpermissioned; DAX role grants too broad.
- **Issue:** Evolution Stack bucket name auto-generated due to length limits.

### SecurityStack
- **Good:** Strong Cognito password policy; post-confirmation trigger for tenant onboarding.
- **Issue:** MFA is optional (should be required in prod).
- **Issue:** WAF missing CloudWatch Logs destination.
- **Issue:** KMS policy may race with log group encryption.

### ObservabilityStack
- **Good:** Comprehensive dashboards (Platform, Tenant Health, Skill Usage, Cost Attribution).
- **Issue:** PITR backup validation is a comment, not implemented.
- **Issue:** Missing latency p99 alarm.
- **Issue:** Widgets lack drill-down links to logs/runbooks.

### ApiStack
- **Good:** WAF WebACL attached; access log destination configured; cache policies for assets.
- **Issue:** Cache key does not include tenant_id; cross-tenant cache leakage risk.
- **Issue:** No per-tenant rate limiting.
- **Issue:** Webhook endpoints use HMAC verification (good security pattern, but requires operator setup).

### ChatStack
- **Good:** ECS task role grants only necessary DynamoDB/Bedrock permissions.
- **Issue:** ALB access logs disabled for cost.

### PipelineStack
- **Good:** ECR image scan on push; lifecycle rules keep last 30 images.
- **Issue:** No base image vulnerability scanning.
- **Issue:** Canary traffic shift is manual, not gradual.

### OrchestrationStack
- **Good:** FIFO queue for ordered agent-to-agent messages; EventBridge archive for replay.
- **Issue:** Archive retention is only 30 days in prod; should be 90+ for self-modification audit.

### TenantOnboardingStack
- **Good:** Cedar policy infrastructure; multi-step Lambda workflow.
- **Issue:** No reserved concurrency for critical sign-up flow.

### EmailStack
- **Good:** Full inbound/outbound SES setup; parsing and sender Lambdas.
- **Issue:** Stack-local KMS key instead of platformKey (fragmented key management).

### FrontendStack
- **Good:** Proper SPA routing (403/404 → index.html); long asset cache (365d for Vite-hashed).
- **Issue:** Missing security headers (X-Frame-Options, Strict-Transport-Security).
- **Issue:** CloudFront OAC/KMS grant logic is complex; comments explain but could be simplified.

### EvolutionStack
- **Good:** S3 lifecycle rules for snapshots and golden datasets.
- **Issue:** Bucket name non-deterministic due to length limits; impacts reproducibility.

### DiscoveryStack
- **Good:** Cloud Map HTTP namespace for agent self-awareness.
- **Issue:** No validation that service registrations match actual deployed resources.

### GatewayRegistrationStack
- **Good:** Tier-based tool gateway Lambda functions.
- **Issue:** Not instantiated in chimera.ts; dead code or WIP.

---

## Cross-cutting Themes

1. **Fragmented KMS Key Management:** SecurityStack has platformKey; DataStack has auditKey; EmailStack has a local key. Consolidate to a key store pattern or shared encryptionContext.

2. **Missing Reserved Concurrency:** Lambda functions in critical paths (sign-up, chat, onboarding) don't reserve concurrency, risking throttles under load.

3. **Incomplete Backup/DR:** No cross-region tables, no multi-region failover setup, no PITR validation alarms.

4. **Incomplete Security Observability:** WAF missing logs; no latency alarms; dashboard widgets lack drill-down.

5. **Cost Optimization Trades:** ALB access logs disabled; API caching not scoped per tenant; DAX role overpermissioned. Need to revisit cost vs. security trade-offs.

6. **Aspect Naming vs. Implementation Mismatch:** TenantIsolationAspect only checks partition key existence, not actual isolation logic.

7. **Circular Dependency Workarounds:** EmailStack uses local KMS key to avoid circular dependency with SecurityStack. Suggests stack boundaries need refinement.

---

## Recommendations (Priority Order)

**IMMEDIATE (before prod launch):**
1. Fix DAX security group to restrict inbound to specific task roles.
2. Add WAF CloudWatch Logs destination.
3. Add KMS policy race condition guard (verify policy attached before exporting key).
4. Enable ALB access logs in prod.
5. Add PITR validation CloudWatch alarm.

**SOON (next sprint):**
6. Implement per-tenant rate limiting in API Gateway.
7. Add MFA required for Cognito in prod.
8. Add latency p99 CloudWatch alarm.
9. Fix Evolution Stack bucket naming to be deterministic.
10. Add security headers to CloudFront distribution.

**FUTURE (backlog):**
11. Set up cross-region Global Tables v2 for DR.
12. Implement canary traffic gradual shift (CodeDeploy).
13. Add health check alarms for DAX cluster.
14. Consolidate fragmented KMS key management.
15. Add cost allocation tags (CostCenter, Owner, Team).
