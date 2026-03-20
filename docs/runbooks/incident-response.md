# Chimera Incident Response Runbook

> Quick reference for responding to production incidents

**Last Updated:** 2026-03-20
**Audience:** On-call engineers, SREs, incident commanders

---

## Incident Severity Levels

| Severity | Response Time | Notification | Escalation |
|----------|--------------|-------------|------------|
| **SEV1 - Critical** | <15 minutes | PagerDuty + #chimera-incidents | VP after 30 min |
| **SEV2 - High** | <1 hour | #chimera-alerts + email | Manager after 2 hours |
| **SEV3 - Medium** | <4 hours | #chimera-alerts | Daily standup |
| **SEV4 - Low** | Next business day | #chimera-ops | Weekly review |

### SEV1 - Critical (Drop everything)

**Examples:**
- Platform completely down (zero invocations)
- Cross-tenant data leak detected
- Data exfiltration attempt
- Authentication system compromised

### SEV2 - High (Urgent)

**Examples:**
- Error rate >5% sustained
- P99 latency >60s sustained
- DynamoDB throttling affecting multiple tenants
- Guardrail surge (possible attack)

### SEV3 - Medium (Important)

**Examples:**
- Single tenant affected
- Budget approaching 90%
- Cron job failures
- High token usage spike

### SEV4 - Low (Track it)

**Examples:**
- Non-critical alarm
- Performance degradation in non-prod
- Documentation issues

---

## First 5 Minutes: Triage

**Run this script immediately when paged:**

```bash
#!/bin/bash
# chimera-triage.sh

echo "=== Chimera Platform Triage ==="
echo "Time: $(date -u)"
echo ""

# 1. Active alarms
echo "--- Active Alarms ---"
aws cloudwatch describe-alarms \
  --alarm-name-prefix "Chimera" \
  --state-value ALARM \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue,Reason:StateReason}' \
  --output table

# 2. Error rate (last 30 min)
echo "--- Error Rate (last 30 min) ---"
aws cloudwatch get-metric-statistics \
  --namespace AgentPlatform \
  --metric-name Errors \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum \
  --output table

# 3. Active sessions
echo "--- Active Sessions ---"
aws cloudwatch get-metric-statistics \
  --namespace AgentPlatform \
  --metric-name ActiveSessions \
  --start-time "$(date -u -v-10M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 60 \
  --statistics Maximum \
  --output table

# 4. ECS health
echo "--- ECS Chat SDK Tasks ---"
aws ecs describe-services \
  --cluster chimera-chat \
  --services chat-sdk \
  --query 'services[0].{Running:runningCount,Desired:desiredCount,Pending:pendingCount}' \
  --output table

# 5. Recent deployments
echo "--- Recent Deployments (last 24h) ---"
aws codepipeline list-pipeline-executions \
  --pipeline-name chimera-deploy \
  --max-items 5 \
  --query 'pipelineExecutionSummaries[].{Status:status,Time:lastUpdateTime}' \
  --output table

# 6. DynamoDB throttles
echo "--- DynamoDB Throttles (last 30 min) ---"
for table in chimera-tenants chimera-sessions chimera-skills chimera-rate-limits; do
  throttles=$(aws cloudwatch get-metric-statistics \
    --namespace AWS/DynamoDB \
    --metric-name ThrottledRequests \
    --dimensions Name=TableName,Value=$table \
    --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
    --period 300 \
    --statistics Sum \
    --query 'Datapoints[0].Sum' \
    --output text 2>/dev/null)
  echo "$table: ${throttles:-0} throttled"
done

echo ""
echo "=== Triage Complete - Determine Severity ==="
```

---

## Common Failure Modes

| ID | Failure Mode | Symptoms | Likelihood | Impact |
|----|-------------|----------|------------|--------|
| **F1** | AgentCore cold start spike | Session creation >5s | Medium | High |
| **F2** | Bedrock model throttling | 429 errors, high p99 | Medium | High |
| **F3** | DynamoDB hot partition | Elevated latency for specific tenant | Medium | Medium |
| **F4** | Chat SDK OOM | ECS restarts, dropped connections | Low | High |
| **F5** | Cedar policy misconfiguration | Unexpected DENY for legit requests | Medium | High |
| **F6** | Skill marketplace poisoning | Malicious tool behavior | Low | Critical |
| **F7** | Memory poisoning | Agent behavior drift | Low | High |
| **F8** | Cost runaway | Single tenant consuming huge budget | Medium | Medium |
| **F9** | Cognito token expiry cascade | Mass auth failures | Low | High |
| **F10** | S3 skill bucket unavailable | Skills fail to load | Very Low | High |

---

## Runbook: Platform Down (SEV1)

**Trigger:** Zero invocations for 10+ minutes

**Quick Fix:**

```bash
# 1. Check if it's a monitoring issue
aws cloudwatch get-metric-statistics \
  --namespace AgentPlatform \
  --metric-name Invocations \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum

# 2. Check ECS service
aws ecs describe-services \
  --cluster chimera-chat \
  --services chat-sdk

# 3. If ECS is down, force restart
aws ecs update-service \
  --cluster chimera-chat \
  --service chat-sdk \
  --force-new-deployment

# 4. Check AgentCore Runtime status
aws bedrock-agent-runtime describe-agent-runtime \
  --runtime-name chimera-pool

# 5. If agent runtime is unhealthy, rollback
aws bedrock-agent-runtime update-agent-runtime-endpoint \
  --runtime-name chimera-pool \
  --endpoint-name production \
  --agent-runtime-artifact "ecr://chimera-agent-runtime:latest-stable"

# 6. Check API Gateway
aws apigateway get-rest-api --rest-api-id <api-id>
```

**Root Cause Investigation:**

1. Check CloudWatch Logs: `/chimera/prod/agent-runtime`
2. Check X-Ray traces for failed requests
3. Check CloudTrail for recent API changes
4. Check recent deployments

---

## Runbook: Bedrock Model Throttling (F2)

**Trigger:** 429 errors, ThrottledRequests metric >0

**Time to Fix:** 5-10 minutes

```bash
# Step 1: Confirm throttling
aws cloudwatch get-metric-statistics \
  --namespace AWS/Bedrock \
  --metric-name ThrottledRequests \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum

# Step 2: Switch to cross-region inference profile
# This increases throughput by using multi-region capacity
aws dynamodb update-item \
  --table-name chimera-tenants \
  --key '{"PK": {"S": "TENANT#GLOBAL"}, "SK": {"S": "CONFIG#models"}}' \
  --update-expression "SET defaultModelId = :model" \
  --expression-attribute-values '{
    ":model": {"S": "us.anthropic.claude-sonnet-4-6-v1:0"}
  }'

# Step 3: Enable model routing (send simple queries to Haiku)
# Update tenant config to use intelligent model routing
aws dynamodb update-item \
  --table-name chimera-tenants \
  --key '{"PK": {"S": "TENANT#GLOBAL"}, "SK": {"S": "CONFIG#features"}}' \
  --update-expression "SET modelRouting = :enabled" \
  --expression-attribute-values '{":enabled": {"BOOL": true}}'

# Step 4: Request quota increase (longer term)
# File AWS Support ticket for Bedrock throughput increase

# Step 5: Monitor for 15 minutes
watch -n 60 'aws cloudwatch get-metric-statistics \
  --namespace AWS/Bedrock \
  --metric-name ThrottledRequests \
  --start-time "$(date -u -v-10M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum'
```

---

## Runbook: Malicious Skill Detected (F6 - SEV1)

**Trigger:** Security alarm, guardrail surge, manual report

**Time to Contain:** 10 minutes

```bash
# Step 1: Identify skill and affected tenants
SKILL_ID="malicious-skill-name"
echo "Quarantining skill: $SKILL_ID"

# Step 2: Quarantine skill immediately
aws dynamodb update-item \
  --table-name chimera-skills \
  --key '{"PK": {"S": "SKILL#'$SKILL_ID'"}, "SK": {"S": "META"}}' \
  --update-expression "SET #status = :quarantined, quarantinedAt = :now, quarantinedBy = :oncall" \
  --expression-attribute-names '{"#status": "status"}' \
  --expression-attribute-values '{
    ":quarantined": {"S": "quarantined"},
    ":now": {"S": "'$(date -u +%Y-%m-%dT%H:%M:%S)'"},
    ":oncall": {"S": "'$USER'"}
  }'

# Step 3: Find all active sessions using the skill
aws dynamodb query \
  --table-name chimera-sessions \
  --index-name GSI2-skill-activity \
  --key-condition-expression "begins_with(skillsUsed, :skill)" \
  --filter-expression "#status = :active" \
  --expression-attribute-names '{"#status": "status"}' \
  --expression-attribute-values '{
    ":skill": {"S": "'$SKILL_ID'"},
    ":active": {"S": "ACTIVE"}
  }' \
  --projection-expression "sessionId,tenantId" \
  --output json > /tmp/affected-sessions.json

# Step 4: Terminate affected sessions
cat /tmp/affected-sessions.json | jq -r '.Items[].sessionId.S' | while read session_id; do
  echo "Terminating session: $session_id"
  aws bedrock-agent-runtime terminate-session \
    --session-id "$session_id"
done

# Step 5: Notify affected tenants
cat /tmp/affected-sessions.json | jq -r '.Items[].tenantId.S' | sort -u | while read tenant_id; do
  echo "Notifying tenant: $tenant_id"
  # Send notification via Chat SDK or email
  curl -X POST https://api.chimera.example.com/v1/admin/notify \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{
      "tenant_id": "'$tenant_id'",
      "severity": "critical",
      "message": "Security incident: Skill '$SKILL_ID' has been quarantined. All active sessions terminated."
    }'
done

# Step 6: Check for data exfiltration
echo "Checking VPC Flow Logs for unusual outbound connections..."
aws logs filter-log-events \
  --log-group-name /chimera/prod/vpc-flow-logs \
  --start-time $(($(date +%s) - 3600))000 \
  --filter-pattern '[version, account, eni, source, destination, srcport, destport, protocol, packets, bytes, start, end, action="ACCEPT", status, direction="OUTBOUND"]' \
  --query 'events[].message' \
  --output text | grep -v "10\." | grep -v "172\." | head -20

# Step 7: Check for LTM poisoning
echo "Scanning for LTM poisoning patterns..."
# Query AgentCore Memory for suspicious content
# (Implementation depends on AgentCore Memory API)

# Step 8: Block skill author
AUTHOR_ID=$(aws dynamodb get-item \
  --table-name chimera-skills \
  --key '{"PK": {"S": "SKILL#'$SKILL_ID'"}, "SK": {"S": "META"}}' \
  --projection-expression "authorId" \
  --output text --query 'Item.authorId.S')

echo "Blocking author: $AUTHOR_ID"
aws dynamodb update-item \
  --table-name chimera-tenants \
  --key '{"PK": {"S": "USER#'$AUTHOR_ID'"}, "SK": {"S": "META"}}' \
  --update-expression "SET accountStatus = :banned, bannedAt = :now" \
  --expression-attribute-values '{
    ":banned": {"S": "banned"},
    ":now": {"S": "'$(date -u +%Y-%m-%dT%H:%M:%S)'"}
  }'

# Step 9: Write incident report
echo "--- INCIDENT REPORT TEMPLATE ---"
echo "Incident: Malicious skill detected"
echo "Skill ID: $SKILL_ID"
echo "Author: $AUTHOR_ID"
echo "Affected sessions: $(cat /tmp/affected-sessions.json | jq '.Items | length')"
echo "Time to containment: [FILL IN]"
echo "Root cause: [INVESTIGATE]"
echo "Preventive measures: [PLAN]"
```

---

## Runbook: Memory Poisoning (F7 - SEV2)

**Trigger:** Anomalous agent behavior, security scan finding

**Time to Fix:** 45 minutes

```bash
# Step 1: Identify affected tenant
TENANT_ID="affected-tenant-id"
echo "Investigating memory poisoning for tenant: $TENANT_ID"

# Step 2: Freeze memory writes (prevent further poisoning)
# Update Cedar policy to deny LTM writes
aws s3 cp s3://chimera-cedar-policies-prod/policies/memory-access.cedar /tmp/
cat >> /tmp/memory-access.cedar <<EOF
// Emergency: Freeze LTM writes for tenant $TENANT_ID
forbid (
  principal == TenantAgent::"$TENANT_ID",
  action == Action::"ltm:write",
  resource
) when {
  true
};
EOF

aws s3 cp /tmp/memory-access.cedar s3://chimera-cedar-policies-prod/policies/
# Policy reloads automatically within 60 seconds

# Step 3: Export memory for analysis
aws s3 sync s3://chimera-tenant-data-prod/tenants/$TENANT_ID/memory/ \
  /tmp/$TENANT_ID-memory-export/

# Step 4: Scan for malicious patterns
echo "Scanning for shell commands..."
grep -r "bash\|/bin/sh\|exec\|eval" /tmp/$TENANT_ID-memory-export/

echo "Scanning for URLs..."
grep -rE "https?://[^\s]+" /tmp/$TENANT_ID-memory-export/

echo "Scanning for instruction overrides..."
grep -ri "ignore previous\|disregard\|forget instructions" /tmp/$TENANT_ID-memory-export/

# Step 5: Purge poisoned entries
# List files with malicious content
find /tmp/$TENANT_ID-memory-export/ -type f -exec grep -l "bash\|eval" {} \; > /tmp/poisoned-files.txt

# Delete from S3
cat /tmp/poisoned-files.txt | while read file; do
  s3_path="s3://chimera-tenant-data-prod/tenants/$TENANT_ID/memory/${file#/tmp/$TENANT_ID-memory-export/}"
  echo "Deleting: $s3_path"
  aws s3 rm "$s3_path"
done

# Step 6: Restore from backup (if extensive poisoning)
BACKUP_DATE="2026-03-15"  # Last known-good date
aws s3 sync s3://chimera-backups-prod/tenants/$TENANT_ID/$BACKUP_DATE/memory/ \
  s3://chimera-tenant-data-prod/tenants/$TENANT_ID/memory/ \
  --delete

# Step 7: Re-enable memory writes (with increased monitoring)
# Remove the emergency forbid rule from Cedar policy
aws s3 cp s3://chimera-cedar-policies-prod/policies/memory-access.cedar /tmp/
# Edit to remove the emergency rule
# aws s3 cp /tmp/memory-access.cedar s3://chimera-cedar-policies-prod/policies/

# Step 8: Root cause investigation
echo "Check recent sessions for this tenant..."
aws dynamodb query \
  --table-name chimera-sessions \
  --key-condition-expression "PK = :tenant" \
  --expression-attribute-values '{":tenant": {"S": "TENANT#'$TENANT_ID'"}}' \
  --limit 50 \
  --scan-index-forward false

echo "Check skill usage..."
aws logs filter-log-events \
  --log-group-name /chimera/prod/agent-runtime \
  --start-time $(($(date +%s) - 86400))000 \
  --filter-pattern '{ $.tenantId = "'$TENANT_ID'" && $.event_type = "skill_invocation" }'
```

---

## Runbook: Cost Runaway (F8 - SEV3)

**Trigger:** Tenant spending >3x daily average

**Time to Fix:** 10 minutes

```bash
# Step 1: Identify expensive tenant
TENANT_ID="expensive-tenant-id"
echo "Throttling tenant: $TENANT_ID"

# Step 2: Get current spend
CURRENT_SPEND=$(aws dynamodb get-item \
  --table-name chimera-cost-tracking \
  --key '{"PK": {"S": "TENANT#'$TENANT_ID'"}, "SK": {"S": "MONTH#'$(date +%Y-%m)'"}}' \
  --projection-expression "costAccumulated" \
  --query 'Item.costAccumulated.N' \
  --output text)

echo "Current monthly spend: \$$CURRENT_SPEND"

# Step 3: Reduce rate limit to 1 request/minute
aws dynamodb update-item \
  --table-name chimera-tenants \
  --key '{"PK": {"S": "TENANT#'$TENANT_ID'"}, "SK": {"S": "CONFIG#features"}}' \
  --update-expression "SET rateLimitPerMinute = :limit, accountStatus = :throttled" \
  --expression-attribute-values '{
    ":limit": {"N": "1"},
    ":throttled": {"S": "throttled"}
  }'

# Step 4: Disable all cron jobs for this tenant
aws events list-rules --name-prefix "chimera-$TENANT_ID-" \
  --query 'Rules[].Name' --output text | while read rule; do
  echo "Disabling rule: $rule"
  aws events disable-rule --name "$rule"
done

# Step 5: Notify tenant
curl -X POST https://api.chimera.example.com/v1/admin/notify \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "tenant_id": "'$TENANT_ID'",
    "severity": "high",
    "message": "Budget alert: Your account has been throttled due to unusual spending. Current: $'$CURRENT_SPEND'. Please contact support."
  }'

# Step 6: Investigate cause
echo "Checking for runaway sessions..."
aws dynamodb query \
  --table-name chimera-sessions \
  --key-condition-expression "PK = :tenant" \
  --filter-expression "#status = :active" \
  --expression-attribute-names '{"#status": "status"}' \
  --expression-attribute-values '{
    ":tenant": {"S": "TENANT#'$TENANT_ID'"},
    ":active": {"S": "ACTIVE"}
  }' \
  --projection-expression "sessionId,tokenCount,costUsd" \
  --output table

echo "Checking for expensive cron jobs..."
aws logs filter-log-events \
  --log-group-name /chimera/prod/agent-runtime \
  --start-time $(($(date +%s) - 86400))000 \
  --filter-pattern '{ $.tenantId = "'$TENANT_ID'" && $.costUsd > 2 }'

# Step 7: After investigation, restore if resolved
# aws dynamodb update-item --table-name chimera-tenants ...
# aws events enable-rule ...
```

---

## Runbook: DynamoDB Hot Partition (F3 - SEV2)

**Trigger:** Elevated latency for specific tenant, throttling

**Time to Fix:** 30 minutes

```bash
# Step 1: Identify hot partition
TENANT_ID="high-traffic-tenant"
echo "Investigating hot partition for tenant: $TENANT_ID"

# Step 2: Check throttles
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ThrottledRequests \
  --dimensions Name=TableName,Value=chimera-sessions \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 \
  --statistics Sum

# Step 3: Enable DAX caching for this tenant
# (Assumes DAX cluster already deployed)
aws dynamodb update-item \
  --table-name chimera-tenants \
  --key '{"PK": {"S": "TENANT#'$TENANT_ID'"}, "SK": {"S": "CONFIG#features"}}' \
  --update-expression "SET daxEnabled = :enabled" \
  --expression-attribute-values '{":enabled": {"BOOL": true}}'

# Step 4: If throttling persists, evaluate silo model
# Enterprise tenants may need dedicated table or on-demand billing
echo "Consider upgrading tenant to dedicated table (silo model)"
echo "Current tenant tier: $(aws dynamodb get-item \
  --table-name chimera-tenants \
  --key '{"PK": {"S": "TENANT#'$TENANT_ID'"}, "SK": {"S": "META"}}' \
  --projection-expression "tier" --output text --query 'Item.tier.S')"

# Step 5: Temporary mitigation: increase provisioned capacity
aws dynamodb update-table \
  --table-name chimera-sessions \
  --provisioned-throughput ReadCapacityUnits=500,WriteCapacityUnits=250
```

---

## Incident Response Checklist

| # | Step | Action |
|---|------|--------|
| 1 | **Detect** | Alarm fires or manual report |
| 2 | **Assess** | Run `chimera-triage.sh` → Determine SEV1-4 |
| 3 | **Communicate** | Post in #chimera-incidents with severity |
| 4 | **Contain** | Rollback, throttle, or quarantine |
| 5 | **Investigate** | Logs, X-Ray, CloudTrail, VPC Flow Logs |
| 6 | **Remediate** | Fix root cause, deploy via canary |
| 7 | **Verify** | Run test suite, confirm alarms clear |
| 8 | **Communicate** | Post resolution in incident channel |
| 9 | **Report** | Write incident report within 48 hours |
| 10 | **Improve** | Create tasks for preventive measures |

---

## Escalation Path

```
┌─────────────────────────────────────┐
│ L1: On-call Engineer                │
│ Response: 15 min (SEV1)             │
│ Cannot resolve in 30 min? Escalate  │
└─────────────┬───────────────────────┘
              │
              v
┌─────────────────────────────────────┐
│ L2: Platform Team Lead               │
│ Cannot resolve in 1 hour? Escalate  │
└─────────────┬───────────────────────┘
              │
              v
┌─────────────────────────────────────┐
│ L3: VP Engineering + AWS TAM         │
│ (For AWS service-level issues)      │
└─────────────────────────────────────┘
```

---

## Useful CloudWatch Logs Insights Queries

```
# Top 10 errors in last hour
fields @timestamp, @message, tenant_id, error_type
| filter level = "ERROR"
| stats count(*) as error_count by error_type, tenant_id
| sort error_count desc
| limit 10

# Slow agent invocations (>30s)
fields @timestamp, tenant_id, session_id, duration_ms
| filter duration_ms > 30000
| sort duration_ms desc
| limit 20

# Cedar policy denials
fields @timestamp, principal, action, resource, decision
| filter decision = "DENY"
| stats count(*) as denial_count by action, principal
| sort denial_count desc

# Top spending tenants today
fields @timestamp, tenant_id, cost_usd
| filter event_type = "cost_increment"
| stats sum(cost_usd) as total_cost by tenant_id
| sort total_cost desc
| limit 10
```

---

## Related Documents

- [Deployment Runbook](./deployment.md)
- [Capacity Planning Runbook](./capacity-planning.md)
- [07-Operational-Runbook.md](../research/enhancement/07-Operational-Runbook.md) (comprehensive reference)
