# Chimera Alarm Runbooks

> Alarm-specific response procedures for all CloudWatch alarms in the Chimera platform

**Last Updated:** 2026-03-21
**Audience:** On-call engineers, SREs
**Related:** [Incident Response Runbook](./incident-response.md)

---

## Alarm Index

| Alarm | Severity | Typical RCA Time | Auto-Remediation |
|-------|----------|------------------|------------------|
| [chimera-*-tenants-throttles](#tenants-table-throttle-alarm) | SEV2 | 30 min | No |
| [chimera-*-sessions-throttles](#sessions-table-throttle-alarm) | SEV1 | 15 min | No |
| [chimera-*-skills-throttles](#skills-table-throttle-alarm) | SEV2 | 20 min | No |
| [chimera-*-ratelimits-throttles](#ratelimits-table-throttle-alarm) | SEV2 | 10 min | Yes (fallback to in-memory) |
| [chimera-*-costtracking-throttles](#costtracking-table-throttle-alarm) | SEV3 | 45 min | No |
| [chimera-*-audit-throttles](#audit-table-throttle-alarm) | SEV3 | 30 min | No |
| [chimera-*-api-error-rate](#api-error-rate-alarm) | SEV1 | 20 min | No |
| [chimera-*-cost-anomaly](#cost-anomaly-alarm) | SEV3 | 30 min | Yes (throttle tenant) |
| [chimera-*-ecs-high-cpu](#ecs-high-cpu-alarm) | SEV2 | 15 min | Yes (scale out) |
| [chimera-*-ecs-high-memory](#ecs-high-memory-alarm) | SEV1 | 10 min | Yes (scale out) |
| [chimera-*-bedrock-throttling](#bedrock-throttling-alarm) | SEV2 | 10 min | Yes (switch to cross-region profile) |

---

## DynamoDB Throttle Alarms

### Tenants Table Throttle Alarm

**Alarm Name:** `chimera-{env}-tenants-throttles`

**Trigger:** ≥10 throttled requests (read + write) in 5 minutes

**Impact:**
- Tenants cannot create/update profiles
- New session creation fails
- Tenant quota checks fail

**Quick Investigation:**

```bash
# Step 1: Check current throttle count
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ThrottledRequests \
  --dimensions Name=TableName,Value=chimera-tenants-prod \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum

# Step 2: Check current capacity
aws dynamodb describe-table \
  --table-name chimera-tenants-prod \
  --query 'Table.{Mode:BillingModeSummary.BillingMode,RCU:ProvisionedThroughput.ReadCapacityUnits,WCU:ProvisionedThroughput.WriteCapacityUnits}'

# Step 3: Check consumed capacity (identify hot operation)
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedReadCapacityUnits \
  --dimensions Name=TableName,Value=chimera-tenants-prod \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum
```

**Resolution:**

**Option 1: Switch to On-Demand (Recommended for prod)**
```bash
aws dynamodb update-table \
  --table-name chimera-tenants-prod \
  --billing-mode PAY_PER_REQUEST

# Monitor for 5 minutes
sleep 300
# Confirm no throttles
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ThrottledRequests \
  --dimensions Name=TableName,Value=chimera-tenants-prod \
  --start-time "$(date -u -v-10M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum
```

**Option 2: Increase Provisioned Capacity**
```bash
# Double the current capacity
aws dynamodb update-table \
  --table-name chimera-tenants-prod \
  --provisioned-throughput ReadCapacityUnits=100,WriteCapacityUnits=50
```

**Root Cause Analysis:**
1. Check CloudWatch Logs Insights for high-volume tenant operations
2. Identify if a specific tenant is causing hot partition
3. Consider implementing DAX cache for read-heavy operations
4. Review CDK stack for proper auto-scaling configuration

**Prevention:**
- Enable DynamoDB auto-scaling in CDK
- Add DAX caching layer for tenant profile reads
- Implement tenant-tier quotas to prevent single-tenant overload

---

### Sessions Table Throttle Alarm

**Alarm Name:** `chimera-{env}-sessions-throttles`

**Trigger:** ≥10 throttled requests (read + write) in 5 minutes

**Impact:** 🔥 **CRITICAL** 🔥
- New sessions fail to create
- Active sessions cannot update state
- Message delivery blocked

**Quick Investigation:**

```bash
# Step 1: Immediate capacity check
aws dynamodb describe-table \
  --table-name chimera-sessions-prod \
  --query 'Table.{Mode:BillingModeSummary.BillingMode,RCU:ProvisionedThroughput.ReadCapacityUnits,WCU:ProvisionedThroughput.WriteCapacityUnits,Status:TableStatus}'

# Step 2: Check active sessions count
aws dynamodb scan \
  --table-name chimera-sessions-prod \
  --filter-expression "#status = :active" \
  --expression-attribute-names '{"#status": "status"}' \
  --expression-attribute-values '{":active": {"S": "ACTIVE"}}' \
  --select COUNT

# Step 3: Check GSI throttles (GSI2-skill-activity may be hot)
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ThrottledRequests \
  --dimensions Name=TableName,Value=chimera-sessions-prod Name=GlobalSecondaryIndexName,Value=GSI2-skill-activity \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum
```

**Resolution (URGENT - 15 min SLA):**

**Immediate Fix: Switch to On-Demand**
```bash
# This takes effect in ~5 minutes
aws dynamodb update-table \
  --table-name chimera-sessions-prod \
  --billing-mode PAY_PER_REQUEST

# Post in #chimera-incidents
echo "🚨 SEV1: Switching sessions table to on-demand billing. ETA: 5 min"
```

**Parallel Investigation:**
```bash
# Check for runaway session creation
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 1800))000 \
  --filter-pattern '{ $.event_type = "session_create" }' \
  | jq -r '.events[].message | fromjson | .tenant_id' \
  | sort | uniq -c | sort -rn | head -10
```

**Root Cause Analysis:**
1. Identify if a specific tenant is creating excessive sessions
2. Check for missing TTL cleanup (24h expiry)
3. Review auto-scaling settings in CDK
4. Check if GSI2 capacity is properly configured

**Prevention:**
- Enforce per-tenant session quota (max 50 concurrent sessions)
- Enable DynamoDB auto-scaling with target utilization 70%
- Add CloudWatch alarm for session count anomaly

---

### Skills Table Throttle Alarm

**Alarm Name:** `chimera-{env}-skills-throttles`

**Trigger:** ≥10 throttled requests (read + write) in 5 minutes

**Impact:**
- Skill installation fails
- Skill invocations blocked
- Marketplace unavailable

**Quick Investigation:**

```bash
# Step 1: Check for skill marketplace surge
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 1800))000 \
  --filter-pattern '{ $.event_type = "skill_install" }' \
  | jq -r '.events[].message | fromjson | .skill_id' \
  | sort | uniq -c | sort -rn | head -5

# Step 2: Check if it's a read or write throttle
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value=chimera-skills-prod \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum
```

**Resolution:**

**Option 1: Enable DAX Cache (Preferred for read-heavy)**
```bash
# Skills are read-heavy — DAX provides sub-millisecond reads
# Requires pre-deployed DAX cluster
aws dynamodb update-item \
  --table-name chimera-tenants-prod \
  --key '{"PK": {"S": "TENANT#GLOBAL"}, "SK": {"S": "CONFIG#features"}}' \
  --update-expression "SET daxSkillsEnabled = :enabled" \
  --expression-attribute-values '{":enabled": {"BOOL": true}}'

# Update ECS service to use DAX endpoint
# (Requires code change + deployment)
```

**Option 2: Increase Capacity**
```bash
aws dynamodb update-table \
  --table-name chimera-skills-prod \
  --provisioned-throughput ReadCapacityUnits=200,WriteCapacityUnits=50
```

**Root Cause Analysis:**
1. Viral skill causing surge in installations
2. Missing cache layer for popular skills
3. Skill metadata queries not optimized

**Prevention:**
- Implement Redis cache for top 100 popular skills
- Add CloudFront distribution for skill assets
- Rate-limit skill installations per tenant (10/min)

---

### RateLimits Table Throttle Alarm

**Alarm Name:** `chimera-{env}-ratelimits-throttles`

**Trigger:** ≥10 throttled requests (read + write) in 5 minutes

**Impact:**
- Rate limiting enforcement fails (security risk!)
- Potential for abuse if rate limits are bypassed
- Token bucket state inconsistent

**Auto-Remediation:** ✅ Enabled

The platform automatically falls back to in-memory rate limiting when DynamoDB throttles.

**Quick Investigation:**

```bash
# Step 1: Check if fallback mode is active
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern '"rate_limit_fallback_mode"'

# Step 2: Verify rate limit table has 5-minute TTL
aws dynamodb describe-table \
  --table-name chimera-rate-limits-prod \
  --query 'Table.TimeToLiveDescription'
```

**Resolution:**

**Verify Fallback Mode:**
```bash
# Platform should log fallback activation
aws logs tail /chimera/prod/platform --since 10m --follow \
  | grep "rate_limit_fallback_mode"

# Expected: "rate_limit_fallback_mode": "active" (in-memory token bucket)
```

**Increase Capacity (if fallback is insufficient):**
```bash
aws dynamodb update-table \
  --table-name chimera-rate-limits-prod \
  --billing-mode PAY_PER_REQUEST
```

**Root Cause Analysis:**
1. High-frequency tenant hitting rate limits aggressively
2. Token bucket writes not batched properly
3. TTL cleanup not working (old entries accumulating)

**Prevention:**
- Batch rate limit updates (write every 10 seconds, not every request)
- Increase in-memory cache TTL to 60 seconds
- Ensure TTL is properly enabled on table

---

### CostTracking Table Throttle Alarm

**Alarm Name:** `chimera-{env}-costtracking-throttles`

**Trigger:** ≥10 throttled requests (read + write) in 5 minutes

**Impact:**
- Cost attribution inaccurate
- Budget alerts may be delayed
- Billing reports incomplete

**Quick Investigation:**

```bash
# Step 1: Check write frequency
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value=chimera-cost-tracking-prod \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum

# Step 2: Check for cost spike (multiple tenants hitting budget)
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 3600))000 \
  --filter-pattern '{ $.event_type = "cost_increment" }' \
  | jq -r '.events[].message | fromjson | .tenant_id' \
  | sort | uniq -c | sort -rn | head -10
```

**Resolution:**

**Option 1: Batch Cost Writes**
```bash
# Update platform code to buffer cost increments
# Write to DDB every 60 seconds instead of per-request
# (Requires code change + deployment)
```

**Option 2: Increase Capacity**
```bash
aws dynamodb update-table \
  --table-name chimera-cost-tracking-prod \
  --provisioned-throughput ReadCapacityUnits=50,WriteCapacityUnits=100
```

**Root Cause Analysis:**
1. Cost tracking writes not batched
2. High-frequency tenants generating excessive cost events
3. Missing aggregation layer (writing raw events instead of rollups)

**Prevention:**
- Implement 60-second cost accumulation buffer
- Use DynamoDB Streams + Lambda for cost rollup
- Add monthly partitioning for cost data

---

### Audit Table Throttle Alarm

**Alarm Name:** `chimera-{env}-audit-throttles`

**Trigger:** ≥10 throttled requests (write-only) in 5 minutes

**Impact:**
- Security events not logged (compliance risk!)
- Audit trail incomplete
- Forensics compromised

**Quick Investigation:**

```bash
# Step 1: Check audit event volume
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value=chimera-audit-prod \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum

# Step 2: Identify event types causing surge
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 1800))000 \
  --filter-pattern '{ $.event_type = "audit_write" }' \
  | jq -r '.events[].message | fromjson | .audit_event_type' \
  | sort | uniq -c | sort -rn
```

**Resolution:**

**Immediate Fix: On-Demand Billing**
```bash
# Audit table should NEVER drop writes (compliance requirement)
aws dynamodb update-table \
  --table-name chimera-audit-prod \
  --billing-mode PAY_PER_REQUEST

echo "🔒 Audit table switched to on-demand (no write drops allowed)"
```

**Root Cause Analysis:**
1. Security event surge (e.g., Cedar policy denial storm)
2. Audit event batching not working
3. Write capacity underprovisioned

**Prevention:**
- Use Kinesis Data Firehose for high-volume audit events
- Buffer audit writes with SQS FIFO queue
- Set audit table to on-demand by default (compliance requirement)

---

## Application-Level Alarms

### API Error Rate Alarm

**Alarm Name:** `chimera-{env}-api-error-rate`

**Trigger:** 5xx error rate >5% for 2 consecutive 5-minute periods

**Impact:** 🔥 **CRITICAL** 🔥
- Platform degradation
- Multiple tenants affected
- Possible service outage

**Quick Investigation:**

```bash
# Step 1: Check error breakdown
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern '{ $.level = "ERROR" }' \
  | jq -r '.events[].message | fromjson | .error_type' \
  | sort | uniq -c | sort -rn | head -10

# Step 2: Check ECS task health
aws ecs describe-services \
  --cluster chimera-chat-prod \
  --services chat-sdk \
  --query 'services[0].{Running:runningCount,Desired:desiredCount,Healthy:healthCheckGracePeriodSeconds}'

# Step 3: Check recent deployments
aws codepipeline list-pipeline-executions \
  --pipeline-name chimera-deploy-prod \
  --max-items 3
```

**Resolution:**

**Option 1: Rollback Recent Deployment**
```bash
# If deployment within last 30 minutes
STABLE_VERSION="v1.2.3"  # Last known-good version
aws ecs update-service \
  --cluster chimera-chat-prod \
  --service chat-sdk \
  --task-definition chimera-chat-sdk:$STABLE_VERSION \
  --force-new-deployment
```

**Option 2: Scale Out ECS Tasks**
```bash
# If error rate due to overload
aws ecs update-service \
  --cluster chimera-chat-prod \
  --service chat-sdk \
  --desired-count 10  # Double current count
```

**Option 3: Check Dependencies**
```bash
# Bedrock throttling?
aws cloudwatch get-metric-statistics \
  --namespace AWS/Bedrock \
  --metric-name ThrottledRequests \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum

# DynamoDB errors?
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern '"ProvisionedThroughputExceededException"'
```

**Root Cause Analysis:**
1. Check X-Ray traces for slow/failed requests
2. Review CloudWatch Logs Insights for error patterns
3. Verify third-party dependencies (Bedrock, DynamoDB, S3)

**Prevention:**
- Implement circuit breaker for Bedrock API calls
- Add retry with exponential backoff
- Increase ECS auto-scaling target (CPU 60% → 50%)

---

### Cost Anomaly Alarm

**Alarm Name:** `chimera-{env}-cost-anomaly`

**Trigger:** Tenant cost exceeds tier quota by 20%

**Auto-Remediation:** ✅ Enabled (throttle to 1 req/min)

**Impact:**
- Single tenant cost runaway
- Unexpected AWS bill increase
- Potential budget exhaustion

**Quick Investigation:**

```bash
# Step 1: Identify expensive tenant
TENANT_ID=$(aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 3600))000 \
  --filter-pattern '{ $.event_type = "cost_anomaly" }' \
  | jq -r '.events[0].message | fromjson | .tenant_id')

echo "Expensive tenant: $TENANT_ID"

# Step 2: Check current month spend
aws dynamodb get-item \
  --table-name chimera-cost-tracking-prod \
  --key '{"PK": {"S": "TENANT#'$TENANT_ID'"}, "SK": {"S": "MONTH#'$(date +%Y-%m)'"}}' \
  --projection-expression "costAccumulated,tierQuota"

# Step 3: Identify cost driver
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 86400))000 \
  --filter-pattern '{ $.tenant_id = "'$TENANT_ID'" && $.cost_usd > 1 }' \
  | jq -r '.events[].message | fromjson | {session_id, cost_usd, token_count}'
```

**Auto-Remediation Status:**

```bash
# Check if throttle was applied
aws dynamodb get-item \
  --table-name chimera-tenants-prod \
  --key '{"PK": {"S": "TENANT#'$TENANT_ID'"}, "SK": {"S": "CONFIG#features"}}' \
  --projection-expression "rateLimitPerMinute,accountStatus"

# Expected: rateLimitPerMinute = 1, accountStatus = "throttled"
```

**Manual Intervention (if auto-remediation insufficient):**

```bash
# Suspend tenant completely
aws dynamodb update-item \
  --table-name chimera-tenants-prod \
  --key '{"PK": {"S": "TENANT#'$TENANT_ID'"}, "SK": {"S": "META"}}' \
  --update-expression "SET accountStatus = :suspended" \
  --expression-attribute-values '{":suspended": {"S": "suspended"}}'

# Notify tenant
curl -X POST https://api.chimera-prod.example.com/v1/admin/notify \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "tenant_id": "'$TENANT_ID'",
    "severity": "critical",
    "message": "Account suspended due to budget overrun. Contact billing."
  }'
```

**Root Cause Analysis:**
1. Check for runaway agent loops
2. Identify if cron jobs are running excessively
3. Review token usage per session
4. Check if tier quota is misconfigured

**Prevention:**
- Lower tier quotas for new tenants
- Add session-level budget caps ($1 per session)
- Implement model routing (use Haiku for simple queries)

---

## Infrastructure Alarms

### ECS High CPU Alarm

**Alarm Name:** `chimera-{env}-ecs-high-cpu`

**Trigger:** ECS service CPU utilization >80% for 2 consecutive 5-minute periods

**Auto-Remediation:** ✅ Enabled (scale out)

**Impact:**
- Increased latency
- Request timeouts
- Potential service degradation

**Quick Investigation:**

```bash
# Step 1: Check current CPU usage
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=chimera-chat-prod Name=ClusterName,Value=chimera-cluster-prod \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Average,Maximum

# Step 2: Check task count
aws ecs describe-services \
  --cluster chimera-cluster-prod \
  --services chimera-chat-prod \
  --query 'services[0].{Running:runningCount,Desired:desiredCount,Pending:pendingCount}'

# Step 3: Check auto-scaling activity
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs \
  --resource-id service/chimera-cluster-prod/chimera-chat-prod \
  --max-results 5
```

**Auto-Remediation Verification:**

```bash
# ECS Application Auto Scaling should trigger automatically
# Verify scale-out occurred
aws application-autoscaling describe-scalable-targets \
  --service-namespace ecs \
  --resource-ids service/chimera-cluster-prod/chimera-chat-prod
```

**Manual Scale-Out (if auto-scaling failed):**

```bash
aws ecs update-service \
  --cluster chimera-cluster-prod \
  --service chimera-chat-prod \
  --desired-count 10  # Increase from current count
```

**Root Cause Analysis:**
1. Traffic spike (legitimate or attack)
2. Inefficient code in new deployment
3. CPU-intensive skill invocations

**Prevention:**
- Lower auto-scaling CPU target to 70%
- Optimize CPU-heavy operations
- Profile code with AWS X-Ray

---

### ECS High Memory Alarm

**Alarm Name:** `chimera-{env}-ecs-high-memory`

**Trigger:** ECS service memory utilization >85% for 1 evaluation period

**Auto-Remediation:** ✅ Enabled (scale out + restart leaking tasks)

**Impact:** 🔥 **CRITICAL** 🔥
- Memory leaks lead to OOM kills
- Task restarts cause dropped connections
- Service instability

**Quick Investigation:**

```bash
# Step 1: Check memory usage per task
aws ecs describe-tasks \
  --cluster chimera-cluster-prod \
  --tasks $(aws ecs list-tasks --cluster chimera-cluster-prod --service-name chimera-chat-prod --query 'taskArns' --output text) \
  --query 'tasks[].{TaskArn:taskArn,Memory:memory,CPU:cpu}'

# Step 2: Check for OOM kills in logs
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 3600))000 \
  --filter-pattern '"OutOfMemoryError"'

# Step 3: Check task restart frequency
aws ecs describe-services \
  --cluster chimera-cluster-prod \
  --services chimera-chat-prod \
  --query 'services[0].events[:5]'
```

**Auto-Remediation Verification:**

```bash
# Check if scale-out occurred
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs \
  --resource-id service/chimera-cluster-prod/chimera-chat-prod \
  --max-results 5

# Check if leaking tasks were restarted
# (Auto-remediation Lambda identifies tasks with >85% memory and restarts them)
```

**Manual Intervention:**

```bash
# Force restart all tasks (rolling deployment)
aws ecs update-service \
  --cluster chimera-cluster-prod \
  --service chimera-chat-prod \
  --force-new-deployment

# If memory leak suspected, rollback
aws ecs update-service \
  --cluster chimera-cluster-prod \
  --service chimera-chat-prod \
  --task-definition chimera-chat-sdk:STABLE_VERSION
```

**Root Cause Analysis:**
1. Memory leak in application code
2. Large skill responses not garbage-collected
3. WebSocket connection accumulation

**Prevention:**
- Profile memory usage with heap dumps
- Implement connection pooling limits
- Set task memory reservation = 75% of hard limit

---

### Bedrock Throttling Alarm

**Alarm Name:** `chimera-{env}-bedrock-throttling`

**Trigger:** ≥5 Bedrock throttled requests in 5 minutes

**Auto-Remediation:** ✅ Enabled (switch to cross-region inference profile)

**Impact:**
- Increased latency (retries)
- User-facing errors
- Reduced throughput

**Quick Investigation:**

```bash
# Step 1: Check throttle count
aws cloudwatch get-metric-statistics \
  --namespace AWS/Bedrock \
  --metric-name ThrottledRequests \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum

# Step 2: Check current model configuration
aws dynamodb get-item \
  --table-name chimera-tenants-prod \
  --key '{"PK": {"S": "TENANT#GLOBAL"}, "SK": {"S": "CONFIG#models"}}' \
  --projection-expression "defaultModelId,crossRegionEnabled"

# Step 3: Check Bedrock quota
aws service-quotas get-service-quota \
  --service-code bedrock \
  --quota-code L-1234ABCD  # Bedrock on-demand throughput quota
```

**Auto-Remediation Verification:**

```bash
# Auto-remediation switches to cross-region inference profile
# us.anthropic.claude-sonnet-4-6-v1:0 (multi-region capacity)

aws dynamodb get-item \
  --table-name chimera-tenants-prod \
  --key '{"PK": {"S": "TENANT#GLOBAL"}, "SK": {"S": "CONFIG#models"}}' \
  --projection-expression "defaultModelId"

# Expected: defaultModelId = "us.anthropic.claude-sonnet-4-6-v1:0" (cross-region profile)
```

**Manual Escalation:**

```bash
# If cross-region profile still throttles, enable model routing
# (Send simple queries to Haiku instead of Sonnet)
aws dynamodb update-item \
  --table-name chimera-tenants-prod \
  --key '{"PK": {"S": "TENANT#GLOBAL"}, "SK": {"S": "CONFIG#features"}}' \
  --update-expression "SET modelRouting = :enabled" \
  --expression-attribute-values '{":enabled": {"BOOL": true}}'

# File AWS Support ticket for Bedrock quota increase
aws support create-case \
  --subject "Bedrock on-demand throughput increase" \
  --service-code bedrock \
  --severity-code urgent \
  --category-code quota \
  --communication-body "Request Claude Sonnet 4.6 quota increase to 2M TPM"
```

**Root Cause Analysis:**
1. Traffic spike exceeding Bedrock quota
2. Long-running agent loops consuming quota
3. Missing request batching

**Prevention:**
- Use cross-region inference profiles by default
- Implement model routing (Haiku for simple queries)
- Request AWS quota increase for production workload

---

## Alarm Response Checklist

When an alarm fires:

1. ☑ **Acknowledge** within SLA (SEV1: 15 min, SEV2: 60 min)
2. ☑ **Post in #chimera-incidents** with alarm name + initial assessment
3. ☑ **Run investigation commands** from relevant runbook section
4. ☑ **Check auto-remediation status** (if applicable)
5. ☑ **Apply manual fix** if auto-remediation failed
6. ☑ **Monitor for 15 minutes** to confirm resolution
7. ☑ **Update incident channel** with resolution summary
8. ☑ **Create post-incident task** for RCA within 48 hours

---

## Related Documents

- [Incident Response Runbook](./incident-response.md) — Failure mode runbooks
- [Disaster Recovery Guide](../guides/disaster-recovery.md) — RTO/RPO procedures
- [ObservabilityStack CDK](../../infra/lib/observability-stack.ts) — Alarm definitions
- [Capacity Planning Runbook](./capacity-planning.md) — Proactive scaling

---

**Feedback:** Found an issue or want to add a runbook? Open a ticket with `sd create --title "Runbook: [topic]"`
