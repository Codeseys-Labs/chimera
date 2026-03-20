# Chimera Capacity Planning Runbook

> Proactive capacity management and scaling guidelines

**Last Updated:** 2026-03-20
**Audience:** Platform team, engineering leadership, finance

---

## Growth Projections

| Metric | Current (10 tenants) | 6 months (50) | 12 months (200) | 18 months (500) |
|--------|---------------------|----------------|------------------|------------------|
| Active tenants | 10 | 50 | 200 | 500 |
| Sessions/day | 200 | 750 | 3,000 | 7,500 |
| Concurrent sessions | 5 | 25 | 100 | 250 |
| DynamoDB WCU (peak) | 20 | 100 | 400 | 1,000 |
| DynamoDB RCU (peak) | 80 | 400 | 1,600 | 4,000 |
| S3 storage (total) | 5 GB | 25 GB | 200 GB | 1 TB |
| LLM tokens/month | 500K | 2.5M | 10M | 25M |
| Monthly cost | ~$400 | ~$1,500 | ~$5,000 | ~$12,000 |

**Assumptions:**
- Average 20 sessions/tenant/day
- Average 2,500 tokens/session (1,500 input + 1,000 output)
- 70% Haiku, 25% Sonnet, 5% Opus
- 25% session concurrency (5 out of 20 daily sessions overlap)

---

## Scaling Triggers

When these thresholds are hit, **take action immediately**:

| Resource | Trigger | Action | Lead Time |
|----------|---------|--------|-----------|
| **DynamoDB (on-demand)** | Monthly bill >$500 | Switch to provisioned + auto-scaling | 1 day |
| **DynamoDB (provisioned)** | Throttled requests >0 for 5 min | Increase auto-scaling max capacity | Immediate |
| **Chat SDK (ECS)** | CPU >70% for 5 min | Scale out (auto-scaling policy) | Automatic |
| **Chat SDK (ECS)** | Concurrent connections >500/task | Add tasks manually | 5 min |
| **AgentCore Runtime** | Session creation latency >3s p99 | Request quota increase | 3-5 days |
| **Bedrock models** | ThrottledRequests >0 | Switch to cross-region profile | Immediate |
| **Bedrock models (sustained)** | Throttles >10/min for 1 hour | Request quota increase | 3-5 days |
| **CloudWatch metrics** | >5,000 custom metrics | Switch to EMF for high-cardinality | 1 week |
| **Secrets Manager** | >500 secrets | Evaluate SSM Parameter Store | 1 week |
| **S3** | >1 TB | Review lifecycle policies | 1 day |

---

## Service Limits Tracking

| Service | Limit Name | Default | Current | Alert At | Status |
|---------|-----------|---------|---------|----------|--------|
| AgentCore Runtime | Endpoints/account | 10 | 2 | 7 | 🟢 OK |
| AgentCore Runtime | Concurrent sessions/endpoint | 10 | 5 | 8 | 🟢 OK |
| Bedrock | Sonnet RPM (requests/min) | 100 | 30 | 70 | 🟢 OK |
| Bedrock | Sonnet TPM (tokens/min) | 200K | 50K | 150K | 🟢 OK |
| DynamoDB | Tables/region | 2,500 | 6 | 2,000 | 🟢 OK |
| API Gateway | WebSocket connections | 500 | 50 | 400 | 🟢 OK |
| ECS Fargate | Tasks/cluster | 500 | 2 | 400 | 🟢 OK |
| Cognito | User pools/region | 1,000 | 1 | 900 | 🟢 OK |
| CloudWatch | Alarms/region | 5,000 | 30 | 4,000 | 🟢 OK |
| Secrets Manager | Secrets/region | 500K | 20 | 400K | 🟢 OK |
| EventBridge | Rules/bus | 300 | 10 | 250 | 🟢 OK |
| Step Functions | Executions/month | 1M | 500 | 800K | 🟢 OK |

**Legend:**
- 🟢 OK: Below alert threshold
- 🟡 Warning: At or above alert threshold → Request increase
- 🔴 Critical: >90% of limit → Escalate immediately

---

## Capacity Review Cadence

### Daily Operations Check (5 minutes)

**Owner:** On-call engineer
**Time:** Any time, async

```bash
# Run daily capacity check
./scripts/capacity-check-daily.sh

# Check:
# 1. All CloudWatch alarms OK
# 2. Error rate <1%
# 3. P99 latency <30s
# 4. No DynamoDB throttling
# 5. ECS tasks healthy
# 6. Cost within 120% of daily average
```

### Weekly Capacity Review (30 minutes)

**Owner:** Platform team
**Time:** Monday 10:00 AM
**Agenda:**

1. Review growth trends
   - New tenants this week
   - Session volume trend
   - Token usage trend
2. Check service limits
   - Run `./scripts/check-service-limits.sh`
   - Any approaching thresholds?
3. Cost review
   - Weekly spend vs budget
   - Cost per tenant
   - Cost per session
4. Action items
   - Quota increase requests
   - Scaling adjustments

### Monthly Cost Review (1 hour)

**Owner:** Platform team + finance
**Time:** First Monday of month
**Agenda:**

1. Monthly spend analysis
   - Total platform cost
   - Cost per tenant breakdown
   - Cost optimization opportunities
2. Pricing tier analysis
   - Are tiers priced correctly?
   - Should we adjust limits?
3. Budget forecast
   - Next 3-month projection
   - When do we need to increase budget?

### Quarterly Architecture Review (2 hours)

**Owner:** Full engineering team + stakeholders
**Time:** Last Friday of quarter
**Agenda:**

1. Scaling strategy
   - Are we on track with projections?
   - Do we need to re-architect anything?
2. New feature capacity impact
   - What's coming in next quarter?
   - What capacity does it need?
3. Technology refresh
   - Are we using the right AWS services?
   - Are there better alternatives?
4. Long-term planning
   - 12-month capacity forecast
   - Budget planning

---

## Requesting AWS Quota Increases

### Bedrock Model Quotas

**When:** Bedrock ThrottledRequests >10/min sustained

```bash
# 1. Document current usage
aws cloudwatch get-metric-statistics \
  --namespace AWS/Bedrock \
  --metric-name ThrottledRequests \
  --start-time "$(date -u -v-7d +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 3600 \
  --statistics Sum Average Maximum \
  --output table > /tmp/bedrock-usage.txt

# 2. Calculate requested limit
# Current: 100 RPM
# Peak observed: 85 RPM
# Requested: 200 RPM (2x current, headroom for growth)

# 3. Submit service quota increase request
aws service-quotas request-service-quota-increase \
  --service-code bedrock \
  --quota-code L-<quota-code-for-sonnet-rpm> \
  --desired-value 200 \
  --case-description "Chimera platform experiencing sustained throttling. Current limit: 100 RPM. Peak usage: 85 RPM. Requesting 200 RPM for growth headroom."

# 4. Track request
aws service-quotas list-requested-service-quota-change-history \
  --service-code bedrock

# 5. Typical approval time: 3-5 business days
```

### AgentCore Runtime Quotas

**When:** Session creation latency >3s p99 sustained

```bash
# Submit AWS Support ticket for AgentCore quota increase
# Include:
# - Current endpoint count: 2
# - Current concurrent sessions/endpoint: 10
# - Peak concurrent sessions observed: 8
# - Requested: 20 concurrent sessions/endpoint
# - Justification: Approaching 80% of limit, growth forecast shows need for 15 within 3 months
```

### DynamoDB Capacity

**When:** Auto-scaling can't keep up, sustained throttling

```bash
# Check current auto-scaling config
aws application-autoscaling describe-scalable-targets \
  --service-namespace dynamodb \
  --resource-ids table/chimera-sessions

# Increase auto-scaling max capacity
aws application-autoscaling put-scaling-policy \
  --policy-name chimera-sessions-write-scaling \
  --service-namespace dynamodb \
  --resource-id table/chimera-sessions \
  --scalable-dimension dynamodb:table:WriteCapacityUnits \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration file://scaling-config.json

# scaling-config.json:
# {
#   "TargetValue": 70.0,
#   "PredefinedMetricSpecification": {
#     "PredefinedMetricType": "DynamoDBWriteCapacityUtilization"
#   },
#   "ScaleOutCooldown": 60,
#   "ScaleInCooldown": 300
# }
```

---

## Cost Optimization Strategies

### 1. Model Routing (Save 60-70%)

**Problem:** Using Sonnet for all queries wastes money
**Solution:** Route simple queries to Haiku

```python
# Implement intelligent model routing
def select_model(query: str) -> str:
    if len(query) < 100 and not has_complex_task(query):
        return "anthropic.claude-haiku-4-5-20250929-v1:0"  # $1/MTok
    elif requires_advanced_reasoning(query):
        return "anthropic.claude-opus-4-6-20250520-v1:0"  # $15/MTok
    else:
        return "anthropic.claude-sonnet-4-6-20250520-v1:0"  # $3/MTok

# Expected savings: 60-70% of LLM costs
```

### 2. Prompt Caching (Save 30-40%)

**Problem:** Repeating long system prompts on every request
**Solution:** Enable Bedrock prompt caching

```python
# Enable prompt caching in Bedrock InvokeModel
response = bedrock.invoke_model(
    modelId="anthropic.claude-sonnet-4-6-20250520-v1:0",
    body={
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1000,
        "system": [
            {
                "type": "text",
                "text": long_system_prompt,  # This gets cached
                "cache_control": {"type": "ephemeral"}
            }
        ],
        "messages": [{"role": "user", "content": user_query}]
    }
)

# Expected savings: 30-40% of input token costs
```

### 3. DynamoDB On-Demand → Provisioned

**Problem:** On-demand billing is expensive at scale
**Solution:** Switch to provisioned capacity with auto-scaling

```bash
# Cost comparison:
# On-demand: $1.25/WCU + $0.25/RCU (monthly)
# Provisioned: $0.00065/WCU + $0.00013/RCU (hourly)

# At 1,000 WCU sustained:
# On-demand: $1,250/month
# Provisioned: ~$468/month (with auto-scaling)

# Savings: ~$780/month (62%)

# Switch to provisioned
aws dynamodb update-table \
  --table-name chimera-sessions \
  --billing-mode PROVISIONED \
  --provisioned-throughput ReadCapacityUnits=500,WriteCapacityUnits=250

# Enable auto-scaling
aws application-autoscaling register-scalable-target \
  --service-namespace dynamodb \
  --resource-id table/chimera-sessions \
  --scalable-dimension dynamodb:table:WriteCapacityUnits \
  --min-capacity 100 \
  --max-capacity 1000
```

### 4. S3 Lifecycle Policies

**Problem:** Old tenant data accumulating in S3
**Solution:** Intelligent tiering and deletion

```bash
# Configure lifecycle rules
aws s3api put-bucket-lifecycle-configuration \
  --bucket chimera-tenant-data-prod \
  --lifecycle-configuration file://lifecycle.json

# lifecycle.json:
# {
#   "Rules": [
#     {
#       "Id": "archive-old-sessions",
#       "Status": "Enabled",
#       "Filter": {"Prefix": "tenants/*/sessions/"},
#       "Transitions": [
#         {"Days": 90, "StorageClass": "INTELLIGENT_TIERING"},
#         {"Days": 180, "StorageClass": "GLACIER"}
#       ],
#       "Expiration": {"Days": 730}
#     },
#     {
#       "Id": "delete-temp-artifacts",
#       "Status": "Enabled",
#       "Filter": {"Prefix": "tenants/*/tmp/"},
#       "Expiration": {"Days": 7}
#     }
#   ]
# }

# Expected savings: 50-70% on S3 storage
```

### 5. CloudWatch Log Retention

**Problem:** Retaining all logs forever is expensive
**Solution:** Tier retention by log group

```bash
# Set appropriate retention periods
aws logs put-retention-policy \
  --log-group-name /chimera/prod/agent-runtime \
  --retention-in-days 365

aws logs put-retention-policy \
  --log-group-name /chimera/prod/chat-sdk \
  --retention-in-days 90

aws logs put-retention-policy \
  --log-group-name /chimera/prod/api-gateway \
  --retention-in-days 90

# Audit logs: 7 years (compliance)
aws logs put-retention-policy \
  --log-group-name /chimera/prod/audit \
  --retention-in-days 2557

# Expected savings: 40-60% on CloudWatch Logs costs
```

---

## Scaling Decision Matrix

| Current State | Symptom | Action | Priority |
|--------------|---------|--------|----------|
| <50 tenants | Bedrock throttling | Switch to cross-region profile | High |
| 50-100 tenants | DynamoDB hot partition | Enable DAX cache | Medium |
| 100-200 tenants | Session creation slow | Request AgentCore quota increase | High |
| 200+ tenants | High cost per tenant | Implement model routing + caching | High |
| 500+ tenants | Single-table DDB limits | Migrate to shard-per-tier model | Critical |
| 1000+ tenants | All services strained | Consider multi-region architecture | Critical |

---

## Pre-Scaling Checklist

Before scaling up infrastructure:

- [ ] **Cost impact estimated** - Run `infracost breakdown`
- [ ] **Tested in staging** - Verify scaling works
- [ ] **Rollback plan ready** - Document how to revert
- [ ] **Monitoring in place** - Alarms for new resources
- [ ] **Team notified** - Post in #chimera-ops
- [ ] **Documentation updated** - Update this runbook

---

## Emergency Capacity Expansion

**Scenario:** Sudden 5x traffic spike, urgent capacity needed

```bash
# 1. Immediate actions (5 minutes)

# Scale out ECS Chat SDK
aws ecs update-service \
  --cluster chimera-chat \
  --service chat-sdk \
  --desired-count 10  # Was 2, now 10

# Increase DynamoDB provisioned capacity
aws dynamodb update-table \
  --table-name chimera-sessions \
  --provisioned-throughput ReadCapacityUnits=2000,WriteCapacityUnits=1000

# Switch to cross-region Bedrock profile
aws dynamodb update-item \
  --table-name chimera-tenants \
  --key '{"PK": {"S": "TENANT#GLOBAL"}, "SK": {"S": "CONFIG#models"}}' \
  --update-expression "SET defaultModelId = :model" \
  --expression-attribute-values '{
    ":model": {"S": "us.anthropic.claude-sonnet-4-6-v1:0"}
  }'

# 2. Monitor for 30 minutes
watch -n 60 './scripts/capacity-check-daily.sh'

# 3. If still throttling, request emergency quota increase
# File AWS Support ticket with severity: Urgent Business Impacting
```

---

## Cost Anomaly Detection

**Automated Lambda:** `chimera-cost-anomaly-detector` (runs hourly)

**Rules:**

| Rule | Trigger | Action |
|------|---------|--------|
| Daily spend >3x average | Anomaly detected | Send alert to #chimera-ops |
| Projected monthly >90% budget | Approaching limit | Notify platform team + finance |
| Single session >$5 | Expensive session | Log for investigation |
| Tenant >110% budget | Hard limit exceeded | Auto-throttle + notify tenant |

**Manual Check:**

```bash
# Check cost by tenant (last 7 days)
aws dynamodb query \
  --table-name chimera-cost-tracking \
  --key-condition-expression "begins_with(PK, :tenant)" \
  --filter-expression "SK >= :start" \
  --expression-attribute-values '{
    ":tenant": {"S": "TENANT#"},
    ":start": {"S": "MONTH#'$(date -u -v-7d +%Y-%m)'"}
  }' \
  --projection-expression "PK,costAccumulated" \
  | jq '.Items | group_by(.PK.S) | map({tenant: .[0].PK.S, cost: ([.[].costAccumulated.N | tonumber] | add)})'

# Check most expensive sessions today
aws logs filter-log-events \
  --log-group-name /chimera/prod/agent-runtime \
  --start-time $(($(date +%s) - 86400))000 \
  --filter-pattern '{ $.event_type = "session_end" && $.costUsd > 2 }' \
  --query 'events[].message' \
  | jq -r '.[] | fromjson | "\(.sessionId) \(.tenantId) $\(.costUsd)"' \
  | sort -k3 -rn \
  | head -10
```

---

## Capacity Planning Scripts

### Daily Capacity Check

```bash
#!/bin/bash
# scripts/capacity-check-daily.sh

echo "=== Chimera Capacity Check - $(date) ==="
echo ""

# DynamoDB throttles
echo "DynamoDB Throttles (last 24h):"
for table in chimera-tenants chimera-sessions chimera-skills chimera-rate-limits; do
  throttles=$(aws cloudwatch get-metric-statistics \
    --namespace AWS/DynamoDB \
    --metric-name ThrottledRequests \
    --dimensions Name=TableName,Value=$table \
    --start-time "$(date -u -v-24H +%Y-%m-%dT%H:%M:%S)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
    --period 86400 \
    --statistics Sum \
    --query 'Datapoints[0].Sum' \
    --output text 2>/dev/null)
  echo "  $table: ${throttles:-0}"
done

# Bedrock throttles
echo ""
echo "Bedrock Throttles (last 24h):"
bedrock_throttles=$(aws cloudwatch get-metric-statistics \
  --namespace AWS/Bedrock \
  --metric-name ThrottledRequests \
  --start-time "$(date -u -v-24H +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 86400 \
  --statistics Sum \
  --query 'Datapoints[0].Sum' \
  --output text 2>/dev/null)
echo "  Total: ${bedrock_throttles:-0}"

# Cost today
echo ""
echo "Cost (last 24h):"
cost=$(aws cloudwatch get-metric-statistics \
  --namespace AgentPlatform \
  --metric-name CostAccumulated \
  --start-time "$(date -u -v-24H +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 86400 \
  --statistics Sum \
  --query 'Datapoints[0].Sum' \
  --output text 2>/dev/null)
echo "  Total: \$${cost:-0}"

# Active tenants
echo ""
echo "Active Tenants (last 24h):"
active_tenants=$(aws dynamodb scan \
  --table-name chimera-tenants \
  --filter-expression "#status = :active" \
  --expression-attribute-names '{"#status": "accountStatus"}' \
  --expression-attribute-values '{":active": {"S": "active"}}' \
  --select COUNT \
  --output text --query 'Count')
echo "  Count: $active_tenants"

echo ""
echo "=== Check Complete ==="
```

---

## Related Documents

- [Deployment Runbook](./deployment.md)
- [Incident Response Runbook](./incident-response.md)
- [07-Operational-Runbook.md](../research/enhancement/07-Operational-Runbook.md) (comprehensive reference)
- [Chimera-Architecture-Review-Cost-Scale.md](../research/architecture-reviews/Chimera-Architecture-Review-Cost-Scale.md)
