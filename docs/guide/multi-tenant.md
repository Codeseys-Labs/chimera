# Multi-Tenant Management Guide

> **Audience:** Platform operators managing tenant lifecycle and isolation
> **Last Updated:** 2026-03-20
> **Related:** [Deployment Guide](./deployment.md) | [Architecture Docs](../architecture/canonical-data-model.md)

---

## Table of Contents

1. [Tenant Lifecycle](#tenant-lifecycle)
2. [Tenant Onboarding](#tenant-onboarding)
3. [Tenant Configuration](#tenant-configuration)
4. [Tier Management](#tier-management)
5. [Data Isolation](#data-isolation)
6. [Monitoring & Quotas](#monitoring--quotas)
7. [Offboarding](#offboarding)

---

## Tenant Lifecycle

### Overview

A tenant progresses through distinct states from creation to deletion:

```
PROVISIONING → ACTIVE → SUSPENDED → DELETING → DELETED
                  ↓
              SUSPENDED (temporary suspension, can reactivate)
```

### State Definitions

| State | Description | API Access | Data Retention |
|-------|-------------|------------|----------------|
| **PROVISIONING** | Resources being created (onboarding in progress) | No | N/A |
| **ACTIVE** | Operational, all features enabled | Yes | Full |
| **SUSPENDED** | Temporary suspension (non-payment, policy violation) | No | Full (grace period) |
| **DELETING** | Offboarding in progress, data deletion active | No | Being deleted |
| **DELETED** | Tenant removed, tombstone record only | No | Tombstone only |

### State Transitions

**Activate a tenant:**

```bash
chimera tenant activate --tenant-id acme-corp

# Or via API
curl -X POST https://api.chimera.example.com/v1/tenants/acme-corp/activate \
  -H "Authorization: Bearer ${ADMIN_TOKEN}"
```

**Suspend a tenant:**

```bash
chimera tenant suspend \
  --tenant-id acme-corp \
  --reason "Payment overdue"

# Tenant API key immediately revoked, sessions terminated
```

**Reactivate from suspension:**

```bash
chimera tenant reactivate \
  --tenant-id acme-corp \
  --reason "Payment received"

# Restores API access, cron jobs, all features
```

### Lifecycle Automation

Tenants transition automatically based on triggers:

```python
# Auto-suspend on budget exceeded
if tenant.monthly_spend >= tenant.budget_limit * 1.1:
    tenant.suspend(reason="Budget exceeded by 10%", notify=True)

# Auto-delete after 30 days suspended (voluntary churn)
if tenant.state == "SUSPENDED" and days_since_suspension >= 30:
    tenant.delete(reason="Grace period expired")

# Auto-provision on payment confirmed (self-service)
if payment.status == "succeeded":
    tenant.activate(notify=True, send_welcome=True)
```

---

## Tenant Onboarding

### Self-Service Portal

Tenants can onboard via web portal at `https://portal.chimera.example.com`:

1. **Sign up:** Email + OAuth (Google/GitHub)
2. **Select tier:** Basic ($50/mo) | Advanced ($500/mo) | Premium (custom)
3. **Configure:** Model selection, channels (Slack, web, API)
4. **Provision:** Automated (30s-10min depending on tier)
5. **Receive:** API key, SDK config, quickstart guide

### CLI Onboarding (Platform Operators)

```bash
# Create tenant manually
chimera tenant create \
  --name "Acme Corp" \
  --tier advanced \
  --admin-email admin@acme.com \
  --models us.anthropic.claude-sonnet-4-6-v1:0,us.amazon.nova-pro-v1:0 \
  --channels slack,web,api \
  --region us-east-1

# Output:
# Tenant ID:       acme-corp
# API Key:         cc_live_sk_abc123...
# Status:          PROVISIONING → ACTIVE (estimated: 90 seconds)
# Agent Endpoint:  https://api.chimera.example.com/v1
# Dashboard:       https://portal.chimera.example.com/tenants/acme-corp
```

### GitOps Onboarding (Infrastructure as Code)

For reproducible onboarding:

```yaml
# tenants/acme-corp.yaml
tenantId: acme-corp
tenantName: Acme Corp
tier: advanced
adminEmail: admin@acme.com

config:
  models:
    default: us.anthropic.claude-sonnet-4-6-v1:0
    complex: us.anthropic.claude-opus-4-6-v1:0
    fast: us.amazon.nova-lite-v1:0

  channels:
    - slack
    - web
    - api

  features:
    codeInterpreter: true
    browser: false
    cronJobs: true
    selfEditingIac: false

  dataRegion: us-east-1

  budgetLimitMonthlyUsd: 500

skills:
  - code-review
  - email-reader
  - summarizer

memoryStrategies:
  - SUMMARY
  - SEMANTIC_MEMORY
  - USER_PREFERENCE

cronJobs:
  - name: daily-digest
    schedule: "cron(0 8 ? * MON-FRI *)"
    promptKey: prompts/digest.md
    skills: [email-reader, summarizer]
    maxBudgetUsd: 2.0
    outputPrefix: outputs/digests/
    notifications:
      slackChannel: "#daily-digest"
```

**Deploy tenant via GitOps:**

```bash
# Commit tenant config
git add tenants/acme-corp.yaml
git commit -m "feat: onboard Acme Corp tenant"
git push origin main

# Pipeline auto-deploys tenant stack
# CDK reads YAML, creates TenantStack with resources
```

### Onboarding Checklist

Automated onboarding completes these tasks:

- [ ] Create Cognito user pool group for tenant
- [ ] Generate tenant API key and store in Secrets Manager
- [ ] Write tenant config to `chimera-tenants` DynamoDB table
- [ ] Create S3 prefix: `s3://chimera-tenants/<tenant-id>/`
- [ ] Initialize AgentCore Memory namespace: `tenant-{tenant_id}-user-*`
- [ ] Setup rate limits in `chimera-rate-limits` table
- [ ] Install default skills from marketplace
- [ ] Configure routing (pool vs silo endpoint)
- [ ] Send welcome email with API key and docs
- [ ] Create CloudWatch dashboard for tenant metrics

**Expected time:**
- Basic tier: <30 seconds
- Advanced tier: 1-2 minutes
- Premium tier (dedicated resources): 5-10 minutes

---

## Tenant Configuration

### Configuration Storage

Tenant config is stored in DynamoDB `chimera-tenants` table:

```javascript
// Primary partition
{
  "PK": "TENANT#acme-corp",
  "SK": "PROFILE",
  "tenantId": "acme-corp",
  "tenantName": "Acme Corp",
  "tier": "advanced",
  "status": "ACTIVE",
  "adminEmail": "admin@acme.com",
  "createdAt": "2026-03-20T10:00:00Z",
  "billingStartDate": "2026-03-20"
}

// Config partition
{
  "PK": "TENANT#acme-corp",
  "SK": "CONFIG",
  "models": {
    "default": "us.anthropic.claude-sonnet-4-6-v1:0",
    "complex": "us.anthropic.claude-opus-4-6-v1:0",
    "fast": "us.amazon.nova-lite-v1:0"
  },
  "channels": ["slack", "web", "api"],
  "features": {
    "codeInterpreter": true,
    "browser": false,
    "cronJobs": true,
    "selfEditingIac": false
  }
}

// Budget partition
{
  "PK": "TENANT#acme-corp",
  "SK": "BUDGET",
  "monthlyLimitUsd": 500,
  "currentMonthSpend": 127.45,
  "lastUpdated": "2026-03-20T14:30:00Z"
}
```

### Update Configuration

**Via CLI:**

```bash
# Update model preferences
chimera tenant update-config acme-corp \
  --set models.default=us.anthropic.claude-sonnet-4-6-v1:0

# Enable/disable features
chimera tenant update-config acme-corp \
  --set features.browser=true

# Update budget limit
chimera tenant update-config acme-corp \
  --set budgetLimitMonthlyUsd=1000
```

**Via API:**

```bash
curl -X PATCH https://api.chimera.example.com/v1/tenants/acme-corp/config \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "models": {
      "default": "us.anthropic.claude-sonnet-4-6-v1:0"
    },
    "features": {
      "browser": true
    }
  }'
```

### Skill Management

**List installed skills:**

```bash
chimera tenant skills list acme-corp

# Output:
# - code-review (v1.2.0)
# - email-reader (v1.0.5)
# - summarizer (v2.1.0)
```

**Install skill from marketplace:**

```bash
chimera tenant skills install acme-corp \
  --skill data-analyst \
  --version latest

# Skill is downloaded to S3 and registered in chimera-skills table
```

**Uninstall skill:**

```bash
chimera tenant skills uninstall acme-corp \
  --skill email-reader

# Skill removed from tenant's S3 prefix and skill registry
```

---

## Tier Management

### Tier Comparison

| Feature | Basic ($50/mo) | Advanced ($500/mo) | Premium (custom) |
|---------|----------------|-------------------|------------------|
| **Compute** | Shared pool | Shared pool | Dedicated runtime |
| **Concurrent sessions** | 2 | 10 | 100+ |
| **Monthly budget** | $50 | $500 | $10,000+ |
| **Models** | Nova Lite, Haiku | +Sonnet, Nova Pro | +Opus, fine-tuned |
| **Memory storage** | 100 MB | 1 GB | 10 GB |
| **Cron jobs** | 5 max | 20 max | Unlimited |
| **API rate limit** | 10 req/min | 100 req/min | 1,000 req/min |
| **SLA** | 99.5% | 99.9% | 99.95% |
| **Support** | Community | Business hours | 24/7 dedicated |
| **Data residency** | Shared region | Shared region | Dedicated region |

### Upgrade Tenant Tier

**Process:**

1. Update tenant config with new tier
2. For Premium tier: Deploy dedicated `TenantStack` with isolated resources
3. Migrate data (if needed)
4. Update routing to new endpoint
5. Notify tenant of upgrade

```bash
# Upgrade to Advanced tier (no infrastructure changes needed)
chimera tenant upgrade acme-corp \
  --to-tier advanced \
  --effective-date 2026-04-01

# Upgrade to Premium tier (deploys dedicated resources)
chimera tenant upgrade acme-corp \
  --to-tier premium \
  --effective-date 2026-04-01

# This triggers:
# 1. Deploy dedicated AgentCore Runtime
# 2. Migrate memory namespace to dedicated storage
# 3. Update API routing to dedicated endpoint
# 4. Apply new rate limits and quotas
```

**Migration time:**
- Basic → Advanced: <1 minute (config update only)
- Advanced → Premium: 10-15 minutes (deploys dedicated CDK stack)

### Downgrade Tenant Tier

**Warning:** Downgrading may lose features (e.g., Premium → Advanced loses dedicated resources).

```bash
chimera tenant downgrade acme-corp \
  --to-tier basic \
  --confirm

# Prompts:
# - Confirm data migration from dedicated to shared storage
# - Confirm loss of cron jobs exceeding Basic tier limit (5 max)
# - Confirm loss of models not available in Basic tier
```

---

## Data Isolation

### Isolation Guarantees

Chimera enforces multi-tenant data isolation at multiple layers:

| Layer | Isolation Method | Enforcement |
|-------|-----------------|-------------|
| **Compute** | AgentCore MicroVMs | Kernel-level isolation (Firecracker) |
| **API** | Cognito JWT claims | API Gateway JWT authorizer validates `custom:tenant_id` |
| **DynamoDB** | Partition key prefix | IAM condition: `dynamodb:LeadingKeys` must start with `TENANT#{id}` |
| **S3** | Prefix isolation | IAM policy restricts access to `tenants/{tenant_id}/*` |
| **Memory** | Namespace isolation | AgentCore Memory API scopes to `tenant-{id}-user-*` |
| **Logs** | CloudWatch log streams | Log stream per tenant: `/chimera/{tenant_id}/*` |

### Prevent Cross-Tenant Leakage

**Critical:** Never rely on application logic for authorization. Enforce at the IAM layer.

**IAM Policy Example (Tenant-Scoped DynamoDB Access):**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:*:*:table/chimera-tenants",
        "arn:aws:dynamodb:*:*:table/chimera-sessions",
        "arn:aws:dynamodb:*:*:table/chimera-skills"
      ],
      "Condition": {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["TENANT#${aws:userid}*"]
        }
      }
    },
    {
      "Effect": "Deny",
      "Action": "dynamodb:*",
      "Resource": "*",
      "Condition": {
        "ForAllValues:StringNotLike": {
          "dynamodb:LeadingKeys": ["TENANT#${aws:userid}*"]
        }
      }
    }
  ]
}
```

### GSI Query Isolation

**Problem:** DynamoDB Global Secondary Indexes can leak data across tenants.

**Solution:** Always add `FilterExpression` with `tenantId` on GSI queries:

```javascript
// ❌ WRONG: GSI query without tenant filter (leaks data!)
const result = await ddb.query({
  TableName: 'chimera-sessions',
  IndexName: 'GSI1-agent-activity',
  KeyConditionExpression: 'agentId = :agentId',
  ExpressionAttributeValues: {
    ':agentId': 'claude-agent-123'
  }
});

// ✅ CORRECT: GSI query with tenant filter
const result = await ddb.query({
  TableName: 'chimera-sessions',
  IndexName: 'GSI1-agent-activity',
  KeyConditionExpression: 'agentId = :agentId',
  FilterExpression: 'tenantId = :tenantId',  // <-- CRITICAL
  ExpressionAttributeValues: {
    ':agentId': 'claude-agent-123',
    ':tenantId': 'acme-corp'
  }
});
```

### Audit Cross-Tenant Access Attempts

All DynamoDB operations log to `chimera-audit` table:

```javascript
{
  "PK": "TENANT#acme-corp",
  "SK": "AUDIT#2026-03-20T14:30:00.123Z",
  "eventType": "UNAUTHORIZED_ACCESS_ATTEMPT",
  "requestedResource": "TENANT#globex-corp/sessions/xyz",
  "deniedBy": "IAM_POLICY",
  "sourceIp": "10.0.1.50",
  "userAgent": "ChimeraSDK/1.0.0",
  "severity": "HIGH"
}
```

**Alert on unauthorized access attempts:**

```bash
# CloudWatch Logs Insights query
fields @timestamp, tenantId, requestedResource, sourceIp
| filter eventType = "UNAUTHORIZED_ACCESS_ATTEMPT"
| sort @timestamp desc
```

---

## Monitoring & Quotas

### Tenant Dashboards

Each tenant has a dedicated CloudWatch dashboard:

```bash
# View tenant dashboard
echo "https://console.aws.amazon.com/cloudwatch/home?region=us-west-2#dashboards:name=Chimera-Tenant-acme-corp"

# Key metrics:
# - Invocations per hour
# - Average latency (p50, p95, p99)
# - Error rate
# - Token usage (input/output)
# - Budget consumption (current month)
```

### Rate Limiting

Rate limits are enforced via token bucket (stored in `chimera-rate-limits` table):

```bash
# Check tenant rate limit status
aws dynamodb get-item \
  --table-name chimera-rate-limits \
  --key '{"PK": {"S": "TENANT#acme-corp"}, "SK": {"S": "RATELIMIT#api_requests"}}'

# Response shows remaining tokens:
# {
#   "tokens": 87,        # Remaining tokens
#   "maxTokens": 100,    # Bucket capacity
#   "refillRate": 1.67,  # Tokens per second (100/min)
#   "lastRefill": 1679325000
# }
```

### Budget Monitoring

```bash
# Check current month spend
chimera tenant budget acme-corp

# Output:
# Monthly Limit:  $500.00
# Current Spend:  $127.45 (25.5%)
# Projected EOH:  $480.00 (96.0%) — Warning threshold
# Days Remaining: 11

# Alerts triggered:
# - 50% spent: Slack notification
# - 80% spent: Email to admin
# - 90% spent: Disable non-essential cron jobs
# - 100% spent: Suspend tenant (configurable)
```

### Quota Enforcement

Quotas are enforced at multiple layers:

```bash
# List tenant quotas
chimera tenant quotas acme-corp

# Output:
# API Requests:       100 req/min (current: 45 req/min)
# Concurrent Sessions: 10 (current: 3)
# Token Input/Hour:   500,000 (current: 123,450)
# Token Output/Hour:  250,000 (current: 67,890)
# Memory Storage:     1 GB (current: 340 MB)
# Cron Jobs:          20 max (current: 7)
```

**Adjust quotas (requires approval):**

```bash
chimera tenant quotas update acme-corp \
  --set api_requests_per_min=200 \
  --reason "High-volume integration approved by sales"
```

---

## Offboarding

### Voluntary Offboarding

Tenant requests account deletion via portal or API:

```bash
chimera tenant delete acme-corp \
  --reason "Voluntary cancellation" \
  --grace-period 30days \
  --export-data
```

**Process:**

1. **Suspend immediately:** API access revoked, cron jobs stopped
2. **Grace period (30 days):** Tenant can reactivate, data retained
3. **Data export:** Generate tenant data archive (if requested)
4. **Delete data:** After grace period, execute full deletion
5. **Issue certificate:** GDPR deletion certificate emailed to admin

### GDPR Right to Erasure

For GDPR Article 17 erasure requests:

```bash
chimera tenant delete acme-corp \
  --reason "GDPR erasure request" \
  --grace-period 0days \
  --confirm

# Triggers immediate deletion (no grace period)
```

**Deletion timeline:**

- **< 24 hours:** Acknowledge request
- **< 48 hours:** Suspend tenant access
- **< 30 days:** Complete data deletion (GDPR maximum)
- **< 72 hours after deletion:** Verify + issue deletion certificate

### Data Deletion Checklist

Offboarding deletes tenant data from all stores:

- [ ] DynamoDB: All items with `PK=TENANT#{id}` (6 tables)
- [ ] S3: All objects under `tenants/{tenant_id}/` prefix
- [ ] AgentCore Memory: All namespaces matching `tenant-{id}-*`
- [ ] Cognito: User pool group and associated users
- [ ] EventBridge: Cron job rules with tenant tag
- [ ] CloudWatch: Log groups with tenant prefix
- [ ] Cedar: Tenant-scoped policy statements
- [ ] (Premium tier only) Dedicated CDK stack destroyed

### Deletion Verification

After deletion, verify no residual data:

```bash
chimera tenant verify-deletion acme-corp

# Checks all data stores, returns:
# DynamoDB (chimera-tenants):       0 items
# DynamoDB (chimera-sessions):      0 items
# DynamoDB (chimera-skills):        0 items
# DynamoDB (chimera-rate-limits):   0 items
# DynamoDB (chimera-cost-tracking): 0 items
# DynamoDB (chimera-audit):         0 items (tombstone only)
# S3 (chimera-tenants):             0 objects
# AgentCore Memory:                 0 namespaces
# Cognito:                          0 groups
# EventBridge:                      0 rules
# CloudWatch:                       0 log groups

# ✅ Deletion verified. Certificate generated: acme-corp-deletion-cert.pdf
```

### Tombstone Record

A minimal tombstone record is retained for audit purposes:

```javascript
{
  "PK": "TENANT#acme-corp",
  "SK": "TOMBSTONE",
  "tenantId": "acme-corp",
  "status": "DELETED",
  "deletedAt": "2026-04-20T10:00:00Z",
  "deletionReason": "GDPR erasure request",
  "certificateIssued": true,
  "retentionExpiry": "2033-04-20T10:00:00Z"  // 7 years for compliance
}
```

**No PII is stored in tombstone.** Only tenant ID and deletion metadata.

---

## Best Practices

### Security

- ✅ Never rely on application-layer authorization—enforce at IAM layer
- ✅ Always include `FilterExpression` for `tenantId` on GSI queries
- ✅ Rotate tenant API keys every 90 days (automated)
- ✅ Audit unauthorized access attempts weekly

### Operations

- ✅ Monitor budget consumption daily (automated alerts at 80%/90%/100%)
- ✅ Review rate limit violations weekly
- ✅ Test tenant onboarding in staging before production rollout
- ✅ Document tier upgrade procedures with rollback plan

### Compliance

- ✅ Maintain audit logs for 7 years (financial services requirement)
- ✅ Respond to GDPR erasure requests within 30 days
- ✅ Issue deletion certificates within 72 hours of verification
- ✅ Encrypt all tenant data at rest (KMS) and in transit (TLS)

---

## Additional Resources

- **[Deployment Guide](./deployment.md)** - Infrastructure deployment procedures
- **[Canonical Data Model](../architecture/canonical-data-model.md)** - DynamoDB schema reference
- **[Security Architecture](../architecture/security-model.md)** - Authorization patterns
- **[Runbooks](../runbooks/)** - Operational procedures

**Questions?** Contact platform team at `platform-team@example.com` or Slack `#chimera-support`
