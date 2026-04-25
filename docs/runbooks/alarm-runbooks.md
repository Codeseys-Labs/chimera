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
| [chimera-*-registry-write-failure](#registry-write-failure-alarm) | SEV2 | 30 min | No (DDB remains canonical during Phase 1) |
| [chimera-*-registry-read-error](#registry-read-error-alarm) | SEV2 | 30 min | Yes (automatic fallback to DDB read) |
| [chimera-*-registry-fallback-rate](#registry-fallback-rate-alarm) | SEV3 | 60 min | N/A (informational during Phase 2 bake-in) |

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

## Registry (AgentCore) Migration Alarms

These three alarms cover the flag-gated Registry dual-write (Phase 1) and dual-read (Phase 2) code paths added during the AgentCore Registry migration. With `REGISTRY_ENABLED` and `REGISTRY_PRIMARY_READ` both unset (the default), no metrics emit and all three alarms remain at INSUFFICIENT_DATA — no noise, no cost.

See [Registry Migration Operator Guide](../MIGRATION-registry.md) for flag semantics and phase ordering.

### Registry Write Failure Alarm

**Alarm Name:** `chimera-{env}-registry-write-failure`

**Trigger:** Any `RegistryWriteFailure` emission in a 5-minute window (`>0`, 1 period)

**Severity:** SEV2 (DDB remains canonical during Phase 1; no user-visible impact unless sustained past Phase 3 bulk migration)

**Full runbook:** [registry-write-failure.md](./registry-write-failure.md)

Failure reasons: `SDK_LOAD_FAILED`, `REGISTRY_ID_MISSING`, `ACCESS_DENIED`, `VALIDATION`, `THROTTLING`, `INTERNAL_FAILURE`, `TIMEOUT`.

Fast rollback: unset `REGISTRY_ENABLED` on the `skill-deployment` Lambda (see runbook Option A).

---

### Registry Read Error Alarm

**Alarm Name:** `chimera-{env}-registry-read-error`

**Trigger:** `>5` errors in 5-minute window for 2 consecutive periods

**Severity:** SEV2 (automatic fallback to DDB keeps reads flowing; promote to SEV1 if fallback-rate alarm also fires or API error rate degrades)

**Full runbook:** [registry-read-error.md](./registry-read-error.md)

Fast rollback: unset `REGISTRY_PRIMARY_READ` on the `skills-api` Lambda (see runbook Option A).

---

### Registry Fallback Rate Alarm

**Alarm Name:** `chimera-{env}-registry-fallback-rate`

**Trigger:** `(RegistryReadFallback / (RegistryReadFallback + RegistryReadSuccess)) * 100 > 50%` for 3 consecutive 5-minute windows

**Severity:** SEV3 (informational during Phase 2 bake-in; promote to SEV2 past the planned cutover window)

**Full runbook:** [registry-fallback-rate.md](./registry-fallback-rate.md)

High fallback = Registry unhealthy or migration incomplete. Use the decision matrix in the full runbook to decide wait-vs-disable. Do NOT reflexively disable the flag on first firing.

---

## Queue / DLQ Alarms

All SQS queues provisioned via `ChimeraQueue` (`infra/constructs/chimera-queue.ts` lines 69–86) automatically register two alarms per queue:

### Queue Backlog Alarm

**Alarm Name:** `<queueName>-backlog` (e.g., `chimera-agent-tasks-prod-dlq-backlog`)

**Trigger:** `ApproximateNumberOfMessagesVisible > 1000` for 1 evaluation period (1 minute)

**Severity:** SEV2 on DLQ (producer accumulating failures), SEV1 on main queue (consumer can't keep up)

**Full runbook:** [dlq-drain-procedure.md](./dlq-drain-procedure.md)

### Queue Message-Age Alarm

**Alarm Name:** `<queueName>-message-age`

**Trigger:** `ApproximateAgeOfOldestMessage > 300` seconds (5 min) for 1 evaluation period

**Severity:** SEV2 (processing stalled)

**Full runbook:** [dlq-drain-procedure.md](./dlq-drain-procedure.md) — classification + replay procedure

---

## Deploy Pipeline Alarms

Defined in `infra/lib/pipeline-stack.ts` lines 1350–1383. These fire during the canary `Rollout` stage and can auto-trigger the `RollbackFunction` Lambda.

### Pipeline Error Rate Alarm

**Alarm Name:** `Chimera-Pipeline-ErrorRate-${env}`

**Trigger:** `AgentPlatform/Errors > 50` in 5-minute window, 1 evaluation period

**Severity:** SEV2 — canary deploy in distress

**Full runbook:** [canary-rollback.md](./canary-rollback.md)

### Pipeline Latency Alarm

**Alarm Name:** `Chimera-Pipeline-Latency-${env}`

**Trigger:** P99 `AgentPlatform/InvocationDuration > 60000` ms (60s) for 2 consecutive 5-minute periods

**Severity:** SEV2 — canary latency regression

**Full runbook:** [canary-rollback.md](./canary-rollback.md)

---

## Tool Instrumentation Alarms

### Tool Success Rate Low Alarm

**Alarm Name:** `chimera-{env}-tool-success-rate-low`

**Trigger Condition:**
- Metric: Metric Math `(SUM(Chimera/Tools::Success) / SAMPLE_COUNT(Chimera/Tools::Success)) * 100`
- Threshold: `< 80%` (strict `LessThanThreshold`)
- Period: 5 minutes
- Evaluation: 2 consecutive periods (10-minute sustained dip)
- `treatMissingData: NOT_BREACHING` — quiet tools stay silent
- SNS target: `highAlarmTopic` (OK action also notifies on recovery)

Defined in `infra/lib/observability-stack.ts` around line 1167. The metric is emitted by `packages/agents/tools/gateway_instrumentation.py` as EMF with the `Success` metric name; success rate is derived at query time via Metric Math (see `docs/architecture/observability.md`).

**Impact:**
- Agent tool invocations are failing at an elevated rate (>=20% failure)
- User-facing agent responses degrade: skills return errors, missing data, or generic fallbacks
- Sustained breach often masks a downstream dependency failure (Bedrock throttle, DDB throttle, MCP endpoint down, malformed tool schema after a deploy)
- Cost impact: retries inflate Bedrock/model spend without delivering value

**Investigation Commands:**

```bash
# Step 1: Pull the derived success-rate timeseries (last 1h, 5-min bins)
aws cloudwatch get-metric-data \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
  --end-time   "$(date -u       +%Y-%m-%dT%H:%M:%S)" \
  --metric-data-queries '[
    {
      "Id": "rate",
      "Expression": "(m1 / m2) * 100",
      "Period": 300,
      "Label": "Tool success rate (%)"
    },
    {
      "Id": "m1",
      "MetricStat": {
        "Metric": {"Namespace": "Chimera/Tools", "MetricName": "Success"},
        "Period": 300,
        "Stat": "Sum"
      },
      "ReturnData": false
    },
    {
      "Id": "m2",
      "MetricStat": {
        "Metric": {"Namespace": "Chimera/Tools", "MetricName": "Success"},
        "Period": 300,
        "Stat": "SampleCount"
      },
      "ReturnData": false
    }
  ]'

# Step 2: Break down failures by ToolName dimension (which tool regressed?)
aws cloudwatch list-metrics \
  --namespace Chimera/Tools \
  --metric-name Success \
  --query 'Metrics[].Dimensions[?Name==`ToolName`].Value' --output text \
  | tr '\t' '\n' | sort -u

# Then fetch Sum + SampleCount per ToolName (repeat for top suspects):
TOOL_NAME="<tool-name-from-list-above>"
aws cloudwatch get-metric-statistics \
  --namespace Chimera/Tools --metric-name Success \
  --dimensions Name=ToolName,Value=$TOOL_NAME \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
  --end-time   "$(date -u       +%Y-%m-%dT%H:%M:%S)" \
  --period 300 --statistics Sum,SampleCount

# Step 3: Pull raw gateway_instrumentation logs for the failing tool
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 1800))000 \
  --filter-pattern "{ $.event_type = \"tool_invocation\" && $.success = false && $.tool_name = \"$TOOL_NAME\" }" \
  | jq -r '.events[].message | fromjson | {tenant_id, error_type, error_message, duration_ms}' \
  | sort | uniq -c | sort -rn | head -20

# Step 4: Check for correlated upstream failures (Bedrock throttle, DDB throttle)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Bedrock --metric-name ThrottledRequests \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time   "$(date -u       +%Y-%m-%dT%H:%M:%S)" \
  --period 300 --statistics Sum
```

**Resolution Steps:**

1. **Identify the failing `ToolName`** from Step 2 above. If a single tool dominates failures, the blast radius is narrow and a targeted rollback is safe.
2. **Check for a recent deploy** of the failing tool (CodePipeline history, ECS task definition revision, Lambda version). If a deploy landed in the last 60 minutes, roll back:
   ```bash
   aws ecs update-service --cluster chimera-chat-{env} \
     --service chat-sdk \
     --task-definition chimera-chat-sdk:<last-known-good-revision> \
     --force-new-deployment
   ```
3. **If failure is Bedrock-driven** (error_type contains `ThrottlingException` or `ModelErrorException`): the platform auto-switches to the cross-region inference profile — verify the `chimera-{env}-bedrock-throttling` alarm is also firing and follow that runbook.
4. **If failure is schema-driven** (error_type contains `ValidationException` or `SchemaError`): the tool's MCP contract drifted. Quarantine the tool via the skills registry:
   ```bash
   aws dynamodb update-item --table-name chimera-skills-{env} \
     --key '{"PK":{"S":"SKILL#<id>"},"SK":{"S":"META"}}' \
     --update-expression "SET #s = :q" \
     --expression-attribute-names '{"#s":"status"}' \
     --expression-attribute-values '{":q":{"S":"QUARANTINED"}}'
   ```
5. **Monitor for recovery** — alarm auto-resolves when success rate climbs back above 80% for 2 consecutive periods. OK action re-notifies `highAlarmTopic`.
6. **If no single tool dominates** (broad regression): treat as a platform-wide incident and follow `api-error-rate` runbook in parallel.

**Related:**
- [ADR on observability Metric Math](../architecture/observability.md)
- [API Error Rate Alarm](#api-error-rate-alarm) — commonly co-fires
- [Bedrock Throttling Alarm](#bedrock-throttling-alarm) — common upstream cause
- Source: `packages/agents/tools/gateway_instrumentation.py` (EMF emitter), `infra/lib/observability-stack.ts` line 1167 (alarm definition)

---

## Cost Governance Alarms

### Tier Violation Count High Alarm

**Alarm Name:** `chimera-{env}-tier-violation-count-high`

**Trigger Condition:**
- Metric: `SUM(SEARCH('{Chimera/Agent,tenant_id,tier,model_requested} MetricName="tier_violation_count"', 'Sum', 300))` — dimension-aware rollup via `SEARCH` because EMF does not auto-publish a zero-dimension aggregate
- Threshold: `>= 5` violations per 5-minute window
- Evaluation: 2 consecutive periods (10-minute sustained window)
- `treatMissingData: NOT_BREACHING`
- SNS target: `highAlarmTopic` (OK action also notifies)

Defined in `infra/lib/observability-stack.ts` around line 1231. Emitted by `enforceTierCeiling()` in `packages/core/src/evolution/model-router.ts` whenever a tenant's requested model is rejected by the tier allowlist and downgraded to the cheapest tier-allowed fallback (e.g., Basic tier requesting Opus gets downgraded to Haiku/Sonnet).

**Impact:**
- **Cost leak prevention is working, but client misconfiguration is active.** Every emission represents a *prevented* cost leak — but frequent emissions mean real user-facing impact:
  - Tenant's client code is pinning a premium model (e.g., Opus) the tier doesn't allow
  - Agents silently receive a downgraded model, producing lower-quality output than the tenant expects
  - Tenant will eventually notice quality regression and escalate
- **Secondary signal:** could indicate a misconfigured internal service (e.g., eval harness pinning Opus for a Basic-tier scenario)
- **NOT a security issue** — tier enforcement is working as designed. The alarm exists to catch misconfigurations, not attacks.

**Investigation Commands:**

```bash
# Step 1: Pull dimension-aware breakdown — who is violating, for which model?
# The alarm uses SEARCH; to investigate we list published dimension combos.
aws cloudwatch list-metrics \
  --namespace Chimera/Agent \
  --metric-name tier_violation_count \
  --query 'Metrics[].Dimensions' --output json \
  | jq -r '.[] | map("\(.Name)=\(.Value)") | join(",")' \
  | sort | uniq -c | sort -rn | head -20

# Step 2: Get Sum per (tenant_id, tier, model_requested) combination for the
# top offender identified above.
TENANT_ID="<tenant-from-step-1>"
TIER="<tier-from-step-1>"
MODEL="<model-from-step-1>"
aws cloudwatch get-metric-statistics \
  --namespace Chimera/Agent --metric-name tier_violation_count \
  --dimensions Name=tenant_id,Value=$TENANT_ID \
               Name=tier,Value=$TIER \
               Name=model_requested,Value=$MODEL \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
  --end-time   "$(date -u       +%Y-%m-%dT%H:%M:%S)" \
  --period 300 --statistics Sum

# Step 3: Pull model-router logs showing the downgrade decisions
aws logs filter-log-events \
  --log-group-name /chimera/{env}/platform \
  --start-time $(($(date +%s) - 1800))000 \
  --filter-pattern "{ $.event_type = \"tier_ceiling_enforcement\" && $.tenant_id = \"$TENANT_ID\" }" \
  | jq -r '.events[].message | fromjson | {session_id, model_requested, model_downgraded_to, tier}'

# Step 4: Confirm tenant's configured tier (sanity check)
aws dynamodb get-item \
  --table-name chimera-tenants-{env} \
  --key '{"PK":{"S":"TENANT#'$TENANT_ID'"},"SK":{"S":"CONFIG#tier"}}' \
  --projection-expression "tier,allowedModels"
```

**Resolution Steps:**

1. **Identify the offending tenant** and the pinned model from Step 1–2 above.
2. **Determine whether the pin is legitimate:**
   - If the tenant is on a Basic/Standard tier and pinning a premium model — this is client misconfiguration. Contact the tenant's technical owner and ask them to remove the model pin (let the router pick) or upgrade their tier.
   - If the tenant has a legitimate need (e.g., is running evals or needs deterministic model choice), upgrade their tier:
     ```bash
     aws dynamodb update-item --table-name chimera-tenants-{env} \
       --key '{"PK":{"S":"TENANT#'$TENANT_ID'"},"SK":{"S":"CONFIG#tier"}}' \
       --update-expression "SET tier = :t" \
       --expression-attribute-values '{":t":{"S":"premium"}}'
     ```
3. **If the violator is an internal service** (tenant_id matches a platform component): update the service's model configuration to request a tier-compatible model by default. File a ticket to fix the hardcoded pin.
4. **Do NOT disable tier enforcement** — the alarm firing proves the guardrail works. The fix is upstream (client config or tier assignment), not at the router.
5. **Verify resolution:** alarm auto-clears when violations drop below 5/5min for 2 consecutive periods.

**Related:**
- Source: `packages/core/src/evolution/model-router.ts::enforceTierCeiling` (EMF emitter)
- `infra/lib/observability-stack.ts` line 1231 (alarm definition)
- [Cost Anomaly Alarm](#cost-anomaly-alarm) — fires when actual spend exceeds tier quota (different axis: this alarm catches *intent* before it becomes spend)
- [docs/reviews/cost-observability-audit.md](../reviews/cost-observability-audit.md) — metrics catalog for cost-governance signals
- Tenant tier config in `packages/core/src/tenant/` (see `enterprise` addition in commit `e00837c`)

---

## Compliance / Backup Alarms

### DynamoDB PITR Disabled Alarm

**Alarm Name:** `chimera-{env}-dynamodb-pitr-disabled`

**Trigger Condition:**
- Metric: `AWS/Config::ComplianceByConfigRule` with dimensions `RuleName=chimera-{env}-dynamodb-pitr-enabled, ComplianceType=NON_COMPLIANT`, statistic `Maximum`, period 15 minutes
- Threshold: `>= 1` (any non-compliant DDB table)
- Evaluation: 1 period
- `treatMissingData: NOT_BREACHING`
- SNS targets: `highAlarmTopic` + `alarmTopic` (both alarm + OK actions)
- Additional signal: `onComplianceChange` EventBridge rule fan-out to `highAlarmTopic` on every compliance transition (so operators see the *change event*, not just sustained breach)

**Gated on `-c enableConfigRules=true`** — AWS Config rules incur per-evaluation cost so they are opt-in via CDK context. If Config rules are not enabled, the alarm, managed rule, and EventBridge rule do not exist. Defined in `infra/lib/observability-stack.ts` around line 662. Uses the managed rule `DYNAMODB_PITR_ENABLED`.

**Impact:**
- **CRITICAL backup gap.** One or more DynamoDB tables is NOT covered by Point-In-Time Recovery. In a table-corruption or accidental-delete incident the RPO is whatever manual backup schedule exists (potentially 24h+ data loss).
- **Compliance risk:** violates the "all prod DDB tables must have PITR" control documented in the security baseline.
- **Composite alarm coupling (prod):** this alarm is combined with `chimera-{env}-backup-failure` into a single "backup protection compromised" signal — on-call sees one correlated alert, not two.
- Most commonly fires because a **new DDB table was added without `pointInTimeRecoverySpecification`** in its CDK construct, or because someone manually disabled PITR via console/CLI on an existing table (CloudTrail: `UpdateContinuousBackups`).

**Investigation Commands:**

```bash
# Step 1: List all non-compliant DDB resources for the Config rule
aws configservice get-compliance-details-by-config-rule \
  --config-rule-name chimera-{env}-dynamodb-pitr-enabled \
  --compliance-types NON_COMPLIANT \
  --query 'EvaluationResults[].EvaluationResultIdentifier.EvaluationResultQualifier.ResourceId' \
  --output text

# Step 2: For each offending table, confirm PITR status directly
TABLE_NAME="<table-from-step-1>"
aws dynamodb describe-continuous-backups \
  --table-name $TABLE_NAME \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription'
# Expected when compliant: PointInTimeRecoveryStatus = ENABLED

# Step 3: Find out WHO/WHEN disabled PITR (CloudTrail)
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=UpdateContinuousBackups \
  --start-time "$(date -u -v-7d +%Y-%m-%dT%H:%M:%S)" \
  --end-time   "$(date -u       +%Y-%m-%dT%H:%M:%S)" \
  --query 'Events[?Resources[?ResourceName==`'$TABLE_NAME'`]].{Time:EventTime,User:Username,Source:CloudTrailEvent}' \
  --output json | jq '.'

# Step 4: Check if data was modified during the unprotected window
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value=$TABLE_NAME \
  --start-time "<timestamp-when-PITR-was-disabled>" \
  --end-time   "$(date -u       +%Y-%m-%dT%H:%M:%S)" \
  --period 3600 --statistics Sum
```

**Resolution Steps:**

1. **Re-enable PITR immediately** on every non-compliant table:
   ```bash
   aws dynamodb update-continuous-backups \
     --table-name $TABLE_NAME \
     --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
   ```
   PITR begins accumulating from the moment it is re-enabled — there is **no backfill**. Any writes during the unprotected window are not recoverable via PITR.
2. **If data was modified while unprotected** (Step 4 showed writes during the gap): restore from the last PITR snapshot *before* PITR was disabled, if one exists. Coordinate with the data owner before overwriting — a restore creates a new table and may require downtime to cut over:
   ```bash
   aws dynamodb restore-table-to-point-in-time \
     --source-table-name $TABLE_NAME \
     --target-table-name $TABLE_NAME-restored \
     --restore-date-time "<timestamp-before-PITR-disable>"
   ```
3. **File a SEV2 ticket** with CloudTrail evidence of who disabled PITR. If it was a human action, treat as a security incident (unauthorized modification of a compliance control). If it was an IaC drift, fix the CDK definition to include `pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }` and redeploy.
4. **Verify compliance recovers.** The Config rule re-evaluates on resource change; expect the alarm to transition to OK within ~15 minutes. The `onComplianceChange` EventBridge fan-out will confirm via `highAlarmTopic`.
5. **For new tables added via CDK**, ensure `ChimeraTable` or equivalent L3 construct defaults PITR to enabled — the drift should be prevented at synth time, not caught by this alarm.

**Related:**
- [ADR: Config rules gated on `enableConfigRules` context flag](../../infra/lib/observability-stack.ts) (commit `1d7f77a` — gate AWS Config PITR rule behind context flag)
- [Disaster Recovery Guide](../guides/disaster-recovery.md) — RTO/RPO procedures and PITR restore playbook
- [Backup Failure Alarm](#queue-backlog-alarm) companion: `chimera-{env}-backup-failure` (AWS Backup job failures)
- Composite alarm: `chimera-{env}-backup-protection-compromised` (prod-only, combines this alarm with backup-failure)
- Source: `infra/lib/observability-stack.ts` line 662 (alarm + managed rule + EventBridge fan-out)

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
- [DLQ Drain Procedure](./dlq-drain-procedure.md) — Response for `*-backlog` and `*-message-age` DLQ alarms
- [Canary Rollback](./canary-rollback.md) — Response for `Chimera-Pipeline-ErrorRate` / `Chimera-Pipeline-Latency`
- [Skill Compromise Response](./skill-compromise-response.md) — Response when a skill-throttle surge is caused by a malicious skill

---

**Feedback:** Found an issue or want to add a runbook? Open a ticket with `sd create --title "Runbook: [topic]"`
