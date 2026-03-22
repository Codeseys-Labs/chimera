# Chimera Performance Benchmark Plan

> **Document Type:** Performance Testing Strategy
> **Version:** 1.0
> **Date:** 2026-03-22
> **Status:** Draft
> **Purpose:** Systematic approach to performance benchmarking for Chimera platform

---

## Overview

This document outlines a comprehensive performance benchmarking strategy for the Chimera multi-tenant agent platform. It provides step-by-step guidance for running load tests, interpreting results, and identifying bottlenecks.

---

## Benchmark Objectives

### Primary Goals

| Goal | Target Metric | Success Criteria |
|------|---------------|------------------|
| **Validate 1000-session target** | Concurrent sessions | Handle 1000 concurrent sessions with < 10% error rate |
| **Latency under load** | p95 response time | < 10 seconds at 1000 sessions |
| **Throughput** | Requests per second | > 10 RPS sustained |
| **Cold start performance** | First invocation latency | p99 < 10 seconds |
| **Auto-scaling effectiveness** | Scale-up time | New ECS tasks online within 2 minutes |

### Secondary Goals

| Goal | Target Metric | Success Criteria |
|------|---------------|------------------|
| **Streaming performance** | Time to first token | p95 < 5 seconds |
| **Tool invocation latency** | MCP tool call duration | p95 < 20 seconds |
| **Cost per session** | AWS spend per request | < $0.05/session (with optimization) |
| **Error recovery** | Session failure rate | < 5% at peak load |

---

## Test Environment Setup

### Prerequisites

1. **Deployed Infrastructure:**
   - All 8 CDK stacks deployed to `staging` environment
   - ECS service scaled to maximum capacity (10 tasks)
   - DynamoDB in provisioned mode with auto-scaling enabled
   - API Gateway throttling limits raised to production levels

2. **Test Tenant Accounts:**
   ```bash
   # Create 100 test tenant accounts
   for i in {001..100}; do
     aws dynamodb put-item \
       --table-name chimera-tenants-staging \
       --item '{
         "PK": {"S": "TENANT#load-test-'"$i"'"},
         "SK": {"S": "META"},
         "tenantId": {"S": "load-test-'"$i"'"},
         "tier": {"S": "premium"},
         "status": {"S": "active"},
         "config": {"M": {
           "maxConcurrentSessions": {"N": "50"},
           "maxMonthlyBudgetUsd": {"N": "500"},
           "enabledModels": {"L": [
             {"S": "sonnet-4.6"},
             {"S": "haiku-4.5"}
           ]}
         }}
       }'
   done
   ```

3. **Authentication Tokens:**
   ```bash
   # Generate JWT tokens for test tenants
   export JWT_TOKEN=$(aws cognito-idp initiate-auth \
     --auth-flow USER_SRP_AUTH \
     --client-id $CLIENT_ID \
     --auth-parameters USERNAME=load-test-001@example.com,PASSWORD=$PASSWORD \
     --query 'AuthenticationResult.IdToken' \
     --output text)
   ```

4. **Monitoring Setup:**
   - CloudWatch dashboard with real-time metrics
   - Alarms temporarily disabled (or thresholds raised)
   - X-Ray tracing enabled for detailed request analysis

5. **Load Testing Tools:**
   ```bash
   # Install k6
   brew install k6

   # Or download from https://k6.io/docs/getting-started/installation/

   # Verify installation
   k6 version
   ```

---

## Benchmark Execution Workflow

### Phase 1: Baseline Tests (Low Load)

**Purpose:** Establish performance baseline without contention

#### 1.1 Single Client Performance
```bash
# Run existing Jest test suite (single-threaded)
bun test tests/load/load-test.ts --testNamePattern="single client"
```

**Expected Results:**
- p50 latency: 2-3 seconds
- p99 latency: < 10 seconds
- Success rate: > 99%

**What to Monitor:**
- ECS CPU: < 20%
- ECS Memory: < 30%
- DynamoDB consumed capacity: < 10% of provisioned
- AgentCore session creation time

#### 1.2 Cold Start Measurement
```bash
# Test cold start performance
bun test tests/load/load-test.ts --testNamePattern="Cold Start"
```

**Expected Results:**
- p50 cold start: < 5 seconds
- p99 cold start: < 10 seconds

**What to Watch:**
- First vs subsequent request latency delta
- AgentCore MicroVM boot time
- ECS task health check grace period

---

### Phase 2: Moderate Load Tests (100 Sessions)

**Purpose:** Test auto-scaling and basic concurrency

#### 2.1 Concurrent Sessions Test
```bash
# Run k6 with 100 VUs
k6 run tests/load/k6-load-test.js \
  --vus 100 \
  --duration 10m \
  --env API_URL=$STAGING_API_URL \
  --env WS_URL=$STAGING_WS_URL \
  --env TENANT_ID=load-test-001 \
  --env AUTH_TOKEN=$JWT_TOKEN
```

**Expected Results:**
- HTTP success rate: > 95%
- p95 latency: < 10 seconds
- ECS auto-scaling: 2 → 4-6 tasks
- DynamoDB auto-scaling: capacity increases by 30-50%

**What to Monitor:**
```bash
# CloudWatch Insights: ECS scaling events
aws logs tail /chimera/staging/ecs/chat-gateway --since 10m --follow | grep "scaling"

# DynamoDB consumed capacity
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedReadCapacityUnits \
  --dimensions Name=TableName,Value=chimera-sessions-staging \
  --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Average,Maximum
```

**Red Flags:**
- ❌ ECS tasks failing health checks
- ❌ DynamoDB throttling (UserErrors > 0)
- ❌ API Gateway 5XX errors > 1%
- ❌ ALB unhealthy target count > 0

---

### Phase 3: High Load Tests (500 Sessions)

**Purpose:** Stress test infrastructure before full 1000-session run

#### 3.1 Sustained Load Test
```bash
k6 run tests/load/k6-load-test.js \
  --stage 5m:500,20m:500,5m:0 \
  --env API_URL=$STAGING_API_URL \
  --env WS_URL=$STAGING_WS_URL \
  --env TENANT_ID=load-test-001 \
  --env AUTH_TOKEN=$JWT_TOKEN \
  --out json=results-500vus.json
```

**Expected Results:**
- HTTP success rate: > 90%
- p95 latency: < 15 seconds
- ECS tasks: 6-8 (near max capacity)
- Requests per second: > 8

**What to Monitor:**
- ECS CPU approaching 70% threshold
- Memory consumption trend over 20 minutes
- DynamoDB hot partition detection
- NAT Gateway data transfer costs

#### 3.2 Burst Traffic Simulation
```bash
# Rapid spike: 100 → 500 in 2 minutes
k6 run tests/load/k6-load-test.js \
  --stage 2m:500,5m:500,2m:100 \
  --env API_URL=$STAGING_API_URL \
  --env WS_URL=$STAGING_WS_URL \
  --env TENANT_ID=load-test-001 \
  --env AUTH_TOKEN=$JWT_TOKEN
```

**Expected Results:**
- Initial spike: latency increases to p95 < 30 seconds
- Recovery: latency returns to < 10 seconds within 3 minutes
- ECS scales from 2 → 10 tasks in < 5 minutes

**Red Flags:**
- ❌ Scale-up takes > 5 minutes
- ❌ Error rate > 15% during spike
- ❌ Latency never recovers (sustained > 30s)

---

### Phase 4: Extreme Scale Tests (1000 Sessions)

**Purpose:** Validate 1000-session target with comprehensive monitoring

#### 4.1 Full Load Test
```bash
# Complete 50-minute test: ramp-up, sustain, burst, cool-down
k6 run tests/load/k6-load-test.js \
  --env API_URL=$STAGING_API_URL \
  --env WS_URL=$STAGING_WS_URL \
  --env TENANT_ID=load-test-001 \
  --env AUTH_TOKEN=$JWT_TOKEN \
  --out json=results-1000vus.json \
  --out cloud
```

**Test Stages:**
1. **Ramp-up (10 min):** 0 → 1000 VUs
2. **Sustained (30 min):** 1000 VUs steady
3. **Burst (5 min):** 1000 → 2000 VUs
4. **Cool-down (5 min):** 2000 → 0 VUs

**Expected Results:**
- HTTP success rate: > 85% (allowing for some failures at extreme load)
- p95 latency: < 15 seconds
- p99 latency: < 60 seconds
- ECS tasks: all 10 tasks active
- Requests per second: > 10 sustained

**Comprehensive Monitoring:**

```bash
# Terminal 1: k6 execution
k6 run tests/load/k6-load-test.js ...

# Terminal 2: Real-time CloudWatch tail
aws logs tail /chimera/staging/ecs/chat-gateway --since 1m --follow

# Terminal 3: ECS service metrics
watch -n 5 'aws ecs describe-services \
  --cluster chimera-chat-staging \
  --services chimera-chat-gateway-staging \
  --query "services[0].{desired:desiredCount,running:runningCount,pending:pendingCount}"'

# Terminal 4: DynamoDB consumed capacity
watch -n 10 'aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedReadCapacityUnits \
  --dimensions Name=TableName,Value=chimera-sessions-staging \
  --start-time $(date -u -d "5 minutes ago" +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Maximum'
```

**Critical Failure Indicators:**
- 🚨 Success rate drops below 80%
- 🚨 ECS tasks terminating unexpectedly
- 🚨 DynamoDB throttling > 100 events/minute
- 🚨 API Gateway 5XX errors > 5%
- 🚨 p99 latency > 120 seconds

---

## Results Analysis

### Metrics to Extract from k6 Output

```bash
# Parse k6 JSON results
cat results-1000vus.json | jq '{
  total_requests: .metrics.http_reqs.values.count,
  failed_requests: .metrics.http_req_failed.values.rate,
  requests_per_sec: .metrics.http_reqs.values.rate,
  latency_p50: .metrics.http_req_duration.values["p(50)"],
  latency_p95: .metrics.http_req_duration.values["p(95)"],
  latency_p99: .metrics.http_req_duration.values["p(99)"],
  peak_vus: .metrics.vus_max.values.max,
  iterations: .metrics.iterations.values.count
}'
```

### CloudWatch Insights Queries

#### ECS CPU Utilization Over Time
```sql
fields @timestamp, CPUUtilization
| filter ServiceName = "chimera-chat-gateway-staging"
| stats avg(CPUUtilization) as AvgCPU, max(CPUUtilization) as MaxCPU by bin(5m)
| sort @timestamp desc
```

#### API Gateway Latency Distribution
```sql
fields @timestamp, @message
| filter @message like /latency/
| parse @message "latency=*ms" as latency
| stats avg(latency) as avg, pct(latency, 50) as p50, pct(latency, 95) as p95, pct(latency, 99) as p99 by bin(5m)
```

#### DynamoDB Throttled Requests
```sql
fields @timestamp, TableName, UserErrors
| filter TableName like /chimera-/
| stats sum(UserErrors) as ThrottledRequests by TableName, bin(1m)
| filter ThrottledRequests > 0
| sort @timestamp desc
```

#### Session Creation Errors
```sql
fields @timestamp, @message
| filter @message like /session.*failed/ or @message like /error/
| stats count() as ErrorCount by bin(5m)
```

---

## Bottleneck Identification

### Common Bottlenecks and Diagnostics

| Symptom | Likely Cause | Diagnostic Command |
|---------|--------------|-------------------|
| **p95 latency > 30s** | ECS CPU saturated | Check ECS CPU > 90% |
| **Increasing error rate** | DynamoDB throttling | Check UserErrors metric |
| **Cold start spikes** | AgentCore MicroVM provisioning | Check session creation time |
| **WebSocket disconnects** | ALB connection timeout | Check ALB 5XX errors |
| **Slow scale-up** | ECS task boot time | Check ECS events log |
| **High NAT costs** | Traffic not using VPC endpoints | Check NAT Gateway bytes |
| **API Gateway 429** | Rate limit exceeded | Check throttling config |

### Diagnostic Workflow

1. **Identify latency source:**
   ```bash
   # Enable X-Ray tracing
   aws xray get-trace-summaries \
     --start-time $(date -u -d '1 hour ago' +%s) \
     --end-time $(date -u +%s) \
     --filter-expression 'duration > 10'
   ```

2. **Check ECS task health:**
   ```bash
   # Get task IDs
   TASKS=$(aws ecs list-tasks --cluster chimera-chat-staging \
     --service-name chimera-chat-gateway-staging \
     --query 'taskArns[*]' --output text)

   # Describe each task
   for task in $TASKS; do
     aws ecs describe-tasks --cluster chimera-chat-staging --tasks $task
   done
   ```

3. **Analyze DynamoDB performance:**
   ```bash
   # Check consumed vs provisioned capacity
   aws cloudwatch get-metric-statistics \
     --namespace AWS/DynamoDB \
     --metric-name ConsumedReadCapacityUnits \
     --dimensions Name=TableName,Value=chimera-sessions-staging \
     --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
     --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
     --period 300 \
     --statistics Maximum,Average
   ```

4. **Review application logs:**
   ```bash
   # Search for errors in last hour
   aws logs filter-log-events \
     --log-group-name /chimera/staging/ecs/chat-gateway \
     --start-time $(date -u -d '1 hour ago' +%s)000 \
     --filter-pattern "ERROR" \
     --limit 100
   ```

---

## Cost Tracking During Tests

### Real-Time Cost Estimation

```bash
# Approximate cost of load test based on metrics
cat > estimate-test-cost.sh << 'EOF'
#!/bin/bash

# Inputs from k6 results
TOTAL_REQUESTS=$(cat results-1000vus.json | jq '.metrics.http_reqs.values.count')
TEST_DURATION_HOURS=$(cat results-1000vus.json | jq '.state.testRunDurationMs / 3600000')

# ECS cost
ECS_TASKS=10
ECS_COST=$(echo "$ECS_TASKS * $TEST_DURATION_HOURS * (1 * 0.04048 + 2 * 0.004445)" | bc -l)

# DynamoDB cost (on-demand estimate)
DYNAMODB_WRITES=$(echo "$TOTAL_REQUESTS * 10" | bc) # Assume 10 writes per request
DYNAMODB_COST=$(echo "$DYNAMODB_WRITES / 1000000 * 1.25" | bc -l)

# API Gateway cost
API_GW_COST=$(echo "$TOTAL_REQUESTS / 1000000 * 3.50" | bc -l)

# LLM cost (assume 4K input, 2K output, Sonnet mix)
LLM_COST=$(echo "$TOTAL_REQUESTS * (4000 * 3 + 2000 * 15) / 1000000" | bc -l)

# Total estimated cost
TOTAL_COST=$(echo "$ECS_COST + $DYNAMODB_COST + $API_GW_COST + $LLM_COST" | bc -l)

printf "Load Test Cost Estimate:\n"
printf "  ECS Fargate:    \$%.2f\n" $ECS_COST
printf "  DynamoDB:       \$%.2f\n" $DYNAMODB_COST
printf "  API Gateway:    \$%.2f\n" $API_GW_COST
printf "  LLM Tokens:     \$%.2f\n" $LLM_COST
printf "  TOTAL:          \$%.2f\n" $TOTAL_COST
EOF

chmod +x estimate-test-cost.sh
./estimate-test-cost.sh
```

### Post-Test Cost Analysis

```bash
# Query AWS Cost Explorer for actual costs (next day)
aws ce get-cost-and-usage \
  --time-period Start=$(date -u -d '1 day ago' +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY \
  --metrics UnblendedCost \
  --group-by Type=SERVICE \
  --filter file://cost-filter.json

# cost-filter.json:
# {
#   "Tags": {
#     "Key": "Environment",
#     "Values": ["staging"]
#   }
# }
```

---

## Regression Testing

### Baseline Comparison

After first successful 1000-session test, save results as baseline:

```bash
# Save baseline metrics
cp results-1000vus.json baseline-2026-03-22.json

# Compare future tests
diff <(cat baseline-2026-03-22.json | jq '.metrics.http_req_duration.values') \
     <(cat results-1000vus-new.json | jq '.metrics.http_req_duration.values')
```

### Automated Regression Detection

```bash
# Script: detect-regression.sh
#!/bin/bash

BASELINE="baseline-2026-03-22.json"
CURRENT="results-1000vus.json"

BASELINE_P95=$(cat $BASELINE | jq '.metrics.http_req_duration.values["p(95)"]')
CURRENT_P95=$(cat $CURRENT | jq '.metrics.http_req_duration.values["p(95)"]')

REGRESSION_THRESHOLD=1.2 # 20% degradation

if (( $(echo "$CURRENT_P95 > $BASELINE_P95 * $REGRESSION_THRESHOLD" | bc -l) )); then
  echo "⚠️  REGRESSION DETECTED"
  echo "Baseline p95: ${BASELINE_P95}ms"
  echo "Current p95:  ${CURRENT_P95}ms"
  echo "Increase:     $(echo "scale=1; ($CURRENT_P95 / $BASELINE_P95 - 1) * 100" | bc -l)%"
  exit 1
else
  echo "✓ No regression detected"
  exit 0
fi
```

---

## Benchmark Schedule

### Pre-Deployment Testing

Run before each major deployment:

| Test | Frequency | Duration | Purpose |
|------|-----------|----------|---------|
| Baseline (10 VUs) | Every deploy | 5 min | Sanity check |
| Moderate (100 VUs) | Every deploy | 15 min | Basic concurrency |
| High Load (500 VUs) | Major releases | 30 min | Stress test |
| Full Scale (1000 VUs) | Quarterly | 50 min | Capacity validation |

### Continuous Monitoring

| Metric | Threshold | Alert Channel |
|--------|-----------|---------------|
| p95 latency | > 15s for 5 min | PagerDuty |
| Error rate | > 5% for 3 min | Slack #ops |
| ECS CPU | > 85% for 10 min | Slack #ops |
| DynamoDB throttling | > 0 events | Email |

---

## Appendix A: Pre-Flight Checklist

**Before running 1000-session test:**

- [ ] All CDK stacks deployed successfully
- [ ] ECS service manually scaled to max capacity (10 tasks)
- [ ] DynamoDB switched to provisioned mode
- [ ] API Gateway throttling limits raised
- [ ] 100 test tenant accounts created
- [ ] JWT tokens generated and validated
- [ ] CloudWatch dashboard created
- [ ] Alarms temporarily disabled or thresholds raised
- [ ] X-Ray tracing enabled
- [ ] k6 installed and tested with 10 VUs
- [ ] Cost estimation script prepared
- [ ] Runbook for handling failures ready

**Stakeholder notifications:**

- [ ] Eng team notified 24h in advance
- [ ] Ops team on standby during test
- [ ] Finance team aware of estimated $50-100 test cost

---

## Appendix B: Emergency Stop Procedure

If test causes production-impacting issues:

1. **Stop k6 immediately:** `Ctrl+C`
2. **Scale down ECS:** `aws ecs update-service --cluster chimera-chat-staging --service chimera-chat-gateway-staging --desired-count 2`
3. **Enable API Gateway throttling:** Lower burst/rate limits to normal
4. **Check for stuck sessions:** Query DynamoDB for sessions created in last hour, manually clean up
5. **Review CloudWatch alarms:** Re-enable alarms, investigate triggered alarms
6. **Post-mortem:** Document what went wrong, update benchmark plan

---

**Document Version:** 1.0
**Last Updated:** 2026-03-22
**Next Review:** After first full 1000-session test execution
