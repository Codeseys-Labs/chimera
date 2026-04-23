---
title: "Canonical DynamoDB Data Model"
version: 1.1.0
status: canonical
last_updated: 2026-04-17
supersedes:
  - docs/research/architecture-reviews/Chimera-Architecture-Review-Platform-IaC.md (single-table design)
  - docs/research/architecture-reviews/Chimera-Final-Architecture-Plan.md (6-table overview)
  - docs/research/architecture-reviews/Chimera-AWS-Component-Blueprint.md (6-table with details)
  - docs/research/architecture-reviews/Chimera-Architecture-Review-Multi-Tenant.md (enhanced tenant config)
authority: |
  This document is the SINGLE SOURCE OF TRUTH for all DynamoDB table schemas in the AWS Chimera platform.
  All implementation code, CDK stacks, API handlers, and documentation MUST reference this specification.
  Any conflicts between this document and other sources MUST be resolved in favor of this document.
---

# Canonical DynamoDB Data Model

> [!important] Authority
> This document supersedes all previous DynamoDB schema designs found in the research corpus. It resolves 4 conflicting designs into a single canonical specification. See [Resolution History](#resolution-history) for details.

## Table of Contents

1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [Schema Specification](#schema-specification)
4. [Access Patterns](#access-patterns)
5. [Security & Compliance](#security--compliance)
6. [Migration Path](#migration-path)
7. [Resolution History](#resolution-history)

---

## Overview

AWS Chimera uses a **6-table DynamoDB design** optimized for multi-tenant SaaS with independent scaling, encryption, and TTL policies per concern.

### Tables Summary

| Table | Purpose | Records | TTL | Encryption |
|-------|---------|---------|-----|------------|
| `chimera-tenants` | Tenant config, tier, quotas | ~5-10 items/tenant | None | AWS-managed |
| `chimera-sessions` | Active agent sessions | ~1-50 items/tenant | 24 hours | AWS-managed |
| `chimera-skills` | Installed skills, MCP endpoints | ~10-100 items/tenant | None | AWS-managed |
| `chimera-rate-limits` | Token bucket state, request counts | ~5-20 items/tenant | 5 minutes | AWS-managed |
| `chimera-cost-tracking` | Monthly cost accumulation | 1 item/tenant/month | 2 years | AWS-managed |
| `chimera-audit` | Security events, compliance audit | ~100-10K items/tenant | 90d-7yr (tier-based) | CMK (required) |

### Why Multi-Table Design?

**Rejected Alternative:** Single-table design (all data in `chimera-platform` with SK overloading)

**Multi-table advantages:**
- ✅ **Clear isolation boundaries** — table-level IAM policies
- ✅ **Independent scaling** — rate-limits uses on-demand, others provisioned
- ✅ **Different TTL per table** — sessions 24h, audit 90d-7yr, cost 2yr
- ✅ **Different encryption** — audit requires CMK, others use AWS-managed
- ✅ **Easier to understand** — one concern per table
- ✅ **Backup granularity** — PITR sessions independently of tenants

---

## Design Principles

### 1. Tenant Isolation First
- Every table uses `TENANT#{id}` as partition key
- All GSI queries MUST include `FilterExpression='tenantId = :tid'` to prevent cross-tenant leakage
- IAM policies use DynamoDB LeadingKeys condition for partition-level isolation

### 2. Enhanced Tenant Configuration Pattern
- Tenants table uses **multi-item pattern** instead of single-item
- Different SK prefixes for different config sections: `PROFILE`, `CONFIG#features`, `CONFIG#models`, `BILLING#current`, `QUOTA#{resource}`
- Enables atomic updates to config sections without rewriting entire tenant record
- Allows fine-grained IAM permissions (e.g., can update models but not billing)

### 3. Independent Operational Characteristics
- Each table has appropriate capacity mode (on-demand for spiky, provisioned for steady)
- TTL configured per-table based on data retention requirements
- Encryption based on compliance needs (CMK for audit, AWS-managed for others)
- Backup policies vary by criticality (PITR for tenants/sessions, snapshot for audit)

### 4. Query Efficiency
- GSIs designed for specific access patterns
- Avoid scans across all tenants (always partition on tenantId)
- Sort keys designed for range queries (timestamps, composite keys)

---

## Schema Specification

### Table 1: `chimera-tenants`

**Purpose:** Tenant configuration, feature flags, tier settings, quotas

#### Key Schema
```
PK: TENANT#{tenantId}
SK: PROFILE | CONFIG#features | CONFIG#models | CONFIG#tools | CONFIG#channels | BILLING#current | QUOTA#{resource}
```

#### Items Per Tenant

##### `SK=PROFILE` (Required)
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "PROFILE",
  tenantId: "org-acme-corp",
  name: "Acme Corporation",
  tier: "enterprise",  // basic | advanced | enterprise | dedicated
  status: "ACTIVE",    // ACTIVE | SUSPENDED | TRIAL | CHURNED
  adminEmail: "admin@acme.com",
  dataRegion: "us-east-1",
  createdAt: "2026-01-15T10:00:00Z",
  updatedAt: "2026-03-19T14:30:00Z"
}
```

##### `SK=CONFIG#features` (Required)
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "CONFIG#features",
  codeInterpreter: true,
  browser: true,
  cronJobs: false,
  selfEditingIac: false,  // Only for enterprise tier
  maxSubagents: 5,        // Tier-dependent: basic=1, advanced=5, enterprise=20
  allowedModelProviders: ["bedrock", "openai"],
  mcpToolsEnabled: true
}
```

##### `SK=CONFIG#models` (Required)
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "CONFIG#models",
  allowedModels: [
    "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "anthropic.claude-3-7-sonnet-20250219-v1:0",
    "gpt-4o"
  ],
  defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  modelRouting: {
    "high-priority": "anthropic.claude-3-7-sonnet-20250219-v1:0",
    "default": "anthropic.claude-3-5-sonnet-20241022-v2:0"
  },
  fallbackChain: [
    "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "gpt-4o"
  ],
  monthlyBudgetUsd: 5000,
  costAlertThreshold: 0.8  // Alert at 80% of budget
}
```

##### `SK=CONFIG#tools` (Optional)
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "CONFIG#tools",
  allowedTools: ["*"],  // or explicit list: ["bash", "read", "write"]
  deniedTools: ["eval", "exec"],
  toolRateLimits: {
    "bash": {
      "maxPerMinute": 30,
      "maxPerHour": 500
    }
  }
}
```

##### `SK=CONFIG#channels` (Optional)
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "CONFIG#channels",
  enabledChannels: ["web", "slack", "discord"],
  slack: {
    workspaceId: "T01234567",
    botTokenArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:chimera/tenant/org-acme-corp/slack-bot-token"
  },
  discord: {
    guildId: "987654321",
    botTokenArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:chimera/tenant/org-acme-corp/discord-bot-token"
  }
}
```

##### `SK=BILLING#current` (Required)
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "BILLING#current",
  monthlySpendUsd: 2847.32,
  tokenUsage: {
    "inputTokens": 12500000,
    "outputTokens": 3200000
  },
  lastInvoiceDate: "2026-03-01",
  billingCycle: "monthly",  // monthly | annual
  paymentMethod: "credit_card",
  stripeCustomerId: "cus_ABC123XYZ"
}
```

##### `SK=QUOTA#{resource}` (Multiple items, one per quota type)
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "QUOTA#api-requests",
  resource: "api-requests",
  limit: 100000,
  current: 45231,
  resetAt: "2026-04-01T00:00:00Z",
  period: "monthly"
}

{
  PK: "TENANT#org-acme-corp",
  SK: "QUOTA#agent-sessions",
  resource: "agent-sessions",
  limit: 50,
  current: 12,
  resetAt: null,  // concurrent quota, no reset
  period: "concurrent"
}
```

#### Global Secondary Indexes

**GSI1: `tier-index`**
```
PK: tier (basic | advanced | enterprise | dedicated)
SK: tenantId
Attributes: status, createdAt
Projection: KEYS_ONLY
```
*Use case:* Query all tenants by tier (e.g., "get all enterprise tenants")

**GSI2: `status-index`**
```
PK: status (ACTIVE | SUSPENDED | TRIAL | CHURNED)
SK: tenantId
Attributes: tier, adminEmail
Projection: KEYS_ONLY
```
*Use case:* Query tenants by status (e.g., "find all suspended tenants")

#### Table Configuration
- **Capacity Mode:** Provisioned (low write rate, predictable)
- **Provisioned Capacity:** 5 RCU / 2 WCU (auto-scaling enabled)
- **TTL:** None (tenant config is persistent)
- **Encryption:** AWS-managed key
- **Backup:** PITR enabled (7-day retention)
- **DeletionProtection:** Enabled

---

### Table 2: `chimera-sessions`

**Purpose:** Active agent sessions, state tracking, last activity timestamps

#### Key Schema
```
PK: TENANT#{tenantId}
SK: SESSION#{sessionId}
```

#### Item Structure
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "SESSION#sess-2026-03-19-a1b2c3",
  sessionId: "sess-2026-03-19-a1b2c3",
  agentId: "agent-claude-3-5",
  userId: "user-john-doe",
  status: "active",  // active | idle | terminated
  createdAt: "2026-03-19T10:00:00Z",
  lastActivity: "2026-03-19T14:25:00Z",
  messageCount: 47,
  tokenUsage: {
    input: 125000,
    output: 32000
  },
  context: {
    workingDirectory: "/workspace/project-alpha",
    environmentVars: { "DEBUG": "true" }
  },
  ttl: 1710950400  // Unix timestamp: now + 24 hours
}
```

#### Global Secondary Indexes

**GSI1: `agent-activity-index`**
```
PK: agentId
SK: lastActivity (timestamp)
Attributes: status, userId, sessionId
Projection: ALL
```
*Use case:* Find all active sessions for an agent, sorted by last activity

#### Table Configuration
- **Capacity Mode:** On-demand (spiky traffic pattern)
- **TTL:** Enabled on `ttl` attribute (24 hours after last activity)
- **Encryption:** AWS-managed key
- **Backup:** PITR enabled (7-day retention)
- **Streams:** Enabled (NEW_AND_OLD_IMAGES) for session lifecycle events

---

### Table 3: `chimera-skills`

**Purpose:** Installed skills, versions, MCP server endpoints

> [!note] Registry migration in flight
> [ADR-034](decisions/ADR-034-agentcore-registry-adoption.md) proposes migrating the skill catalog to AWS AgentCore Registry. `chimera-skills` remains the canonical source of truth until the Phase-3 cutover; Phase-3 is blocked on the multi-tenancy spike (`docs/designs/agentcore-registry-spike.md`) resolving Pattern A (per-tenant registries) vs. Pattern B (shared registry with tenant-scoped records). Operator flows and flag gates are documented in [`docs/MIGRATION-registry.md`](../MIGRATION-registry.md). Phase-0/1 dual-write scaffolding (`packages/core/src/registry/`) is landed but default-off.

#### Key Schema
```
PK: TENANT#{tenantId}
SK: SKILL#{skillName}
```

#### Item Structure
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "SKILL#git-tools",
  skillName: "git-tools",
  version: "2.1.0",
  installedAt: "2026-02-10T08:00:00Z",
  installedBy: "user-admin",
  enabled: true,
  skillType: "mcp",  // mcp | builtin | custom
  mcpEndpoint: "https://mcp-registry.example.com/git-tools/v2.1.0",
  manifest: {
    description: "Git repository operations",
    tools: ["git_clone", "git_commit", "git_push"],
    permissions: ["filesystem:read", "filesystem:write", "network:outbound"]
  },
  trustLevel: "verified",  // verified | community | custom
  signature: "0x1a2b3c..."  // Ed25519 signature
}
```

#### Global Secondary Indexes

**GSI1: `skill-usage-index`**
```
PK: skillName
SK: tenantId
Attributes: version, enabled, trustLevel
Projection: ALL
```
*Use case:* Find all tenants using a specific skill (for security advisories, deprecation notices)

#### Table Configuration
- **Capacity Mode:** Provisioned (low, steady traffic)
- **Provisioned Capacity:** 5 RCU / 2 WCU
- **TTL:** None (skills persist until uninstalled)
- **Encryption:** AWS-managed key
- **Backup:** Daily snapshots (30-day retention)

---

### Table 4: `chimera-rate-limits`

**Purpose:** Token bucket state, request counts, rate limiting windows

#### Key Schema
```
PK: TENANT#{tenantId}
SK: WINDOW#{timestamp} | RATELIMIT#{resource}
```

#### Item Structures

##### Sliding Window Counter (5-minute buckets)
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "WINDOW#2026-03-19T14:25:00Z",
  windowStart: "2026-03-19T14:25:00Z",
  requestCount: 1247,
  tokenUsage: 450000,
  errorCount: 3,
  ttl: 1710859800  // 5 minutes from windowStart
}
```

##### Token Bucket (persistent rate limiter state)
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "RATELIMIT#api-requests",
  resource: "api-requests",
  tokens: 8543,
  capacity: 10000,
  refillRate: 100,  // tokens per second
  lastRefill: "2026-03-19T14:25:30Z"
}
```

#### Table Configuration
- **Capacity Mode:** On-demand (high read/write frequency during traffic bursts)
- **TTL:** Enabled on `ttl` attribute (5 minutes for WINDOW# items, none for RATELIMIT# items)
- **Encryption:** AWS-managed key
- **Backup:** None (ephemeral data, can be rebuilt)

---

### Table 5: `chimera-cost-tracking`

**Purpose:** Monthly cost accumulation per tenant for billing and budget alerts

#### Key Schema
```
PK: TENANT#{tenantId}
SK: PERIOD#{yyyy-mm}
```

#### Item Structure
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "PERIOD#2026-03",
  period: "2026-03",
  totalCostUsd: 2847.32,
  breakdown: {
    "bedrock-inference": 2100.50,
    "agentcore-runtime": 450.00,
    "dynamodb": 85.23,
    "s3-storage": 45.12,
    "cloudwatch": 166.47
  },
  tokenUsage: {
    "anthropic.claude-3-5-sonnet": {
      input: 12500000,
      output: 3200000,
      cost: 1850.00
    },
    "anthropic.claude-3-7-sonnet": {
      input: 2000000,
      output: 500000,
      cost: 250.50
    }
  },
  requestCount: 45231,
  sessionCount: 872,
  lastUpdated: "2026-03-19T14:30:00Z",
  ttl: 1773648000  // 2 years from period end
}
```

#### Table Configuration
- **Capacity Mode:** Provisioned (low, predictable write rate)
- **Provisioned Capacity:** 5 RCU / 5 WCU
- **TTL:** Enabled on `ttl` attribute (2 years retention for financial records)
- **Encryption:** AWS-managed key
- **Backup:** Daily snapshots (90-day retention, compliance requirement)

---

### Table 6: `chimera-audit`

**Purpose:** Security events, compliance audit trail, forensics

#### Key Schema
```
PK: TENANT#{tenantId}
SK: EVENT#{timestamp}#{uuid}
```

#### Item Structure
```typescript
{
  PK: "TENANT#org-acme-corp",
  SK: "EVENT#2026-03-19T14:25:30.123Z#a1b2c3d4",
  eventId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  eventType: "auth.login.success",
  timestamp: "2026-03-19T14:25:30.123Z",
  actor: {
    userId: "user-john-doe",
    ipAddress: "203.0.113.42",
    userAgent: "Mozilla/5.0..."
  },
  resource: {
    type: "session",
    id: "sess-2026-03-19-a1b2c3"
  },
  action: "session.create",
  result: "success",
  metadata: {
    sessionDuration: 3600,
    requestCount: 47
  },
  traceId: "1-5e1c6f5a-3d8e9f0a1b2c3d4e5f6a7b8c",  // X-Ray trace ID
  ttl: 1773648000  // Tier-dependent: basic=90d, advanced=1yr, enterprise=7yr
}
```

#### Global Secondary Indexes

**GSI1: `event-type-index`**
```
PK: eventType
SK: timestamp
Attributes: tenantId, actor, result
Projection: ALL
```
*Use case:* Query all events of a specific type across tenants (for security analysis, not accessible by tenants)

#### Table Configuration
- **Capacity Mode:** On-demand (spiky write pattern during incidents)
- **TTL:** Enabled on `ttl` attribute (tier-dependent: 90d/1yr/7yr) — **code-enforced** via `calculateAuditTTL(tenantTier)` in `packages/core/src/activity/audit-trail.ts`. `AuditTrail.logAction` rejects any caller-supplied `ttl` parameter and always computes TTL from `tenantTier`, so compliance retention is no longer merely schema-documented. Unknown tiers fall back to the strictest (basic/90d) retention.
- **Encryption:** Customer-managed KMS key (CMK) **required** for compliance
- **Backup:** Continuous backup to S3 Glacier Deep Archive (for 7-year retention beyond DynamoDB TTL)
- **Streams:** Enabled (NEW_IMAGE_ONLY) for real-time SIEM integration

---

## Access Patterns

### Pattern 1: Get Tenant Configuration
**Query:** Get all config for a tenant
```typescript
// Method 1: BatchGetItem (efficient for specific SKs)
const params = {
  RequestItems: {
    'chimera-tenants': {
      Keys: [
        { PK: 'TENANT#org-acme-corp', SK: 'PROFILE' },
        { PK: 'TENANT#org-acme-corp', SK: 'CONFIG#features' },
        { PK: 'TENANT#org-acme-corp', SK: 'CONFIG#models' }
      ]
    }
  }
};

// Method 2: Query (get all items for tenant)
const params = {
  TableName: 'chimera-tenants',
  KeyConditionExpression: 'PK = :tenantId',
  ExpressionAttributeValues: {
    ':tenantId': 'TENANT#org-acme-corp'
  }
};
```

### Pattern 2: Update Specific Config Section
**Update:** Atomic update of model config without touching other configs
```typescript
const params = {
  TableName: 'chimera-tenants',
  Key: {
    PK: 'TENANT#org-acme-corp',
    SK: 'CONFIG#models'
  },
  UpdateExpression: 'SET defaultModel = :model, updatedAt = :now',
  ExpressionAttributeValues: {
    ':model': 'anthropic.claude-3-7-sonnet-20250219-v1:0',
    ':now': new Date().toISOString()
  }
};
```

### Pattern 3: Find Active Sessions for Tenant
**Query:** Get all active sessions, sorted by last activity
```typescript
const params = {
  TableName: 'chimera-sessions',
  KeyConditionExpression: 'PK = :tenantId',
  FilterExpression: 'status = :status',
  ExpressionAttributeValues: {
    ':tenantId': 'TENANT#org-acme-corp',
    ':status': 'active'
  }
};
```

### Pattern 4: Find Sessions by Agent (Cross-Tenant Admin Query)
**Query GSI1:** Platform admin finding all sessions for a specific agent
```typescript
const params = {
  TableName: 'chimera-sessions',
  IndexName: 'agent-activity-index',
  KeyConditionExpression: 'agentId = :agentId',
  ExpressionAttributeValues: {
    ':agentId': 'agent-claude-3-5'
  },
  ScanIndexForward: false  // Most recent first
};
```

### Pattern 5: Check Rate Limit Token Bucket
**GetItem:** Check if tenant has tokens available
```typescript
const params = {
  TableName: 'chimera-rate-limits',
  Key: {
    PK: 'TENANT#org-acme-corp',
    SK: 'RATELIMIT#api-requests'
  }
};

// Then update atomically with ConditionExpression
const updateParams = {
  TableName: 'chimera-rate-limits',
  Key: {
    PK: 'TENANT#org-acme-corp',
    SK: 'RATELIMIT#api-requests'
  },
  UpdateExpression: 'SET tokens = tokens - :cost, lastRefill = :now',
  ConditionExpression: 'tokens >= :cost',  // Fail if insufficient tokens
  ExpressionAttributeValues: {
    ':cost': 1,
    ':now': new Date().toISOString()
  }
};
```

### Pattern 6: Query Tenants by Tier
**Query GSI1:** Get all enterprise tenants
```typescript
const params = {
  TableName: 'chimera-tenants',
  IndexName: 'tier-index',
  KeyConditionExpression: 'tier = :tier',
  FilterExpression: 'status = :status',  // CRITICAL: Prevent cross-tenant leakage
  ExpressionAttributeValues: {
    ':tier': 'enterprise',
    ':status': 'ACTIVE'
  }
};
```

### Pattern 7: Audit Query by Event Type
**Query GSI1:** Find all failed login attempts across platform (admin only)
```typescript
const params = {
  TableName: 'chimera-audit',
  IndexName: 'event-type-index',
  KeyConditionExpression: 'eventType = :eventType AND #ts BETWEEN :start AND :end',
  ExpressionAttributeNames: {
    '#ts': 'timestamp'
  },
  ExpressionAttributeValues: {
    ':eventType': 'auth.login.failure',
    ':start': '2026-03-19T00:00:00Z',
    ':end': '2026-03-19T23:59:59Z'
  }
};
```

---

## Security & Compliance

### 1. Multi-Tenant Isolation

#### Partition Key Enforcement
All tables use `TENANT#{id}` as partition key. IAM policies MUST use DynamoDB LeadingKeys condition:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query"
      ],
      "Resource": "arn:aws:dynamodb:*:*:table/chimera-*",
      "Condition": {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["TENANT#${aws:PrincipalTag/tenantId}"]
        }
      }
    }
  ]
}
```

#### GSI Query Protection
**CRITICAL:** All GSI queries (which span multiple tenants) MUST include `FilterExpression` to prevent cross-tenant data leakage. Enforcement is defense-in-depth, layered at two code boundaries:

1. **TypeScript layer** — the shared DDB query wrappers in `packages/core/src/` inject `FilterExpression='tenantId = :tid'` on every GSI read.
2. **Python layer** ([ADR-033](decisions/ADR-033-tenant-context-injection-for-python-tools.md)) — `packages/agents/tools/tenant_context.py::ensure_tenant_filter()` AND-s `tenantId = :__chimera_tid` into every tool-emitted `FilterExpression` and reads the tenant id from a per-invocation `ContextVar` rather than accepting it as a tool argument. Tools **cannot** issue an unfiltered GSI query without tripping the anti-pattern guard test.

Neither layer replaces the other; both must hold.

```typescript
// ❌ WRONG: GSI query without tenant filter (returns data from ALL tenants)
const badQuery = {
  TableName: 'chimera-sessions',
  IndexName: 'agent-activity-index',
  KeyConditionExpression: 'agentId = :agentId',
  ExpressionAttributeValues: {
    ':agentId': 'agent-claude-3-5'
  }
};

// ✅ CORRECT: GSI query with tenant filter
const goodQuery = {
  TableName: 'chimera-sessions',
  IndexName: 'agent-activity-index',
  KeyConditionExpression: 'agentId = :agentId',
  FilterExpression: 'PK = :tenantId',  // REQUIRED
  ExpressionAttributeValues: {
    ':agentId': 'agent-claude-3-5',
    ':tenantId': 'TENANT#org-acme-corp'
  }
};
```

### 2. Encryption

| Table | Encryption | Key Rotation | Reason |
|-------|-----------|--------------|--------|
| `chimera-tenants` | AWS-managed | Automatic | Config data, not regulated |
| `chimera-sessions` | AWS-managed | Automatic | Ephemeral, 24h TTL |
| `chimera-skills` | AWS-managed | Automatic | Public skill metadata |
| `chimera-rate-limits` | AWS-managed | Automatic | Ephemeral, 5min TTL |
| `chimera-cost-tracking` | AWS-managed | Automatic | Financial data, but internal billing |
| `chimera-audit` | **CMK (required)** | Annual (manual) | Compliance requirement: GDPR, SOC2, HIPAA |

#### Audit Table CMK Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Enable audit log encryption",
      "Effect": "Allow",
      "Principal": {
        "Service": "dynamodb.amazonaws.com"
      },
      "Action": [
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:CreateGrant"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "dynamodb.us-east-1.amazonaws.com",
          "kms:CallerAccount": "123456789012"
        }
      }
    }
  ]
}
```

### 3. Audit Event Types (Standard Taxonomy)

| Category | Event Types |
|----------|-------------|
| **Authentication** | `auth.login.success`, `auth.login.failure`, `auth.logout`, `auth.token.refresh` |
| **Authorization** | `authz.access.granted`, `authz.access.denied`, `authz.permission.escalation` |
| **Session** | `session.create`, `session.terminate`, `session.timeout`, `session.hijack.attempt` |
| **Data Access** | `data.read`, `data.write`, `data.delete`, `data.export` |
| **Configuration** | `config.update`, `config.delete`, `tenant.tier.change`, `tenant.suspend` |
| **Security** | `security.mfa.enable`, `security.password.reset`, `security.key.rotation` |
| **Billing** | `billing.invoice.generated`, `billing.payment.success`, `billing.payment.failure` |

---

## Migration Path

### Current State
6 tables exist with simple tenant config pattern:
```
PK: TENANT#{id}
SK: META
```

### Target State
6 tables with enhanced tenant config pattern:
```
PK: TENANT#{id}
SK: PROFILE | CONFIG#features | CONFIG#models | CONFIG#tools | CONFIG#channels | BILLING#current | QUOTA#{resource}
```

### Migration Strategy (Zero-Downtime)

#### Phase 1: Dual-Write (Week 1)
- Deploy code that writes to **both** `SK=META` and new `SK=CONFIG#*` items
- Reads still use `SK=META`
- No functional change, backward compatible

```typescript
// Write to both patterns
await Promise.all([
  dynamodb.putItem({ PK: tenantId, SK: 'META', ...oldFormat }),
  dynamodb.putItem({ PK: tenantId, SK: 'PROFILE', ...newFormat }),
  dynamodb.putItem({ PK: tenantId, SK: 'CONFIG#features', ...newFormat })
]);
```

#### Phase 2: Dual-Read with Fallback (Week 2)
- Deploy code that reads from new pattern, falls back to `SK=META` if missing
- Writes still go to both patterns
- Start monitoring for tenants with new pattern data

```typescript
// Read with fallback
const profile = await dynamodb.getItem({ PK: tenantId, SK: 'PROFILE' })
  || await dynamodb.getItem({ PK: tenantId, SK: 'META' });
```

#### Phase 3: Background Migration (Week 3)
- Run Lambda job to copy all `SK=META` items into new multi-item pattern
- Job is idempotent, can be re-run
- Emit CloudWatch metrics on migration progress

```typescript
// Migration job (pseudocode)
for tenant in allTenants:
  metaItem = getItem(PK=tenant, SK='META')
  if metaItem:
    splitIntoConfigItems(metaItem)  // Create CONFIG#*, BILLING#*, QUOTA#*
```

#### Phase 4: New Pattern Primary (Week 4)
- Deploy code that reads from new pattern **only** (no fallback)
- Writes still go to both patterns (safety)
- Monitor error rates, rollback plan ready

#### Phase 5: Deprecate Old Pattern Writes (Week 5)
- Deploy code that writes to new pattern only
- Stop writing `SK=META` items
- Monitor for 48 hours

#### Phase 6: Cleanup (Week 6)
- Delete all `SK=META` items (after validation)
- Remove old pattern code paths
- Update documentation

---

## Resolution History

### Conflicting Designs Found

**Problem:** Gap analysis (docs/research/enhancement/00-Gap-Analysis-Report.md) identified 4 incompatible DynamoDB schemas across the research corpus.

#### Design 1: Single-Table Pattern
- **Source:** `Chimera-Architecture-Review-Platform-IaC.md`
- **Schema:** 1 table (`chimera-platform`) with SK overloading
- **Verdict:** ❌ Rejected — TTL conflicts, encryption conflicts, harder to manage isolation

#### Design 2: 6-Table Overview
- **Source:** `Chimera-Final-Architecture-Plan.md`
- **Schema:** 6 tables with simple `SK=META` for tenant config
- **Verdict:** ✅ **Adopted as base** — clear separation of concerns, implemented in code

#### Design 3: 6-Table with Details
- **Source:** `Chimera-AWS-Component-Blueprint.md`
- **Schema:** Same 6 tables with detailed GSI specs, TTL, encryption
- **Verdict:** ✅ Merged into canonical spec (added operational details)

#### Design 4: Enhanced Tenant Config
- **Source:** `Chimera-Architecture-Review-Multi-Tenant.md`
- **Schema:** 6 tables with multi-item tenant config pattern (CONFIG#*, BILLING#*, QUOTA#*)
- **Verdict:** ✅ Merged into canonical spec (enhanced pattern for atomicity and IAM granularity)

### Resolution Decision

**Adopted Schema:** Hybrid of Designs 2, 3, and 4
- **Base structure:** 6 tables from Design 2 (matches implementation)
- **Operational details:** GSI names, TTL, encryption from Design 3
- **Tenant config pattern:** Enhanced multi-item pattern from Design 4

**Rationale:**
1. Design 2 is already partially implemented (low migration risk)
2. Design 3's operational details are non-breaking additions
3. Design 4's enhanced pattern enables future features (atomic config updates, fine-grained IAM) with clear migration path

### Cross-References

This canonical specification supersedes and resolves contradictions in:
- ✅ `docs/research/architecture-reviews/Chimera-Final-Architecture-Plan.md` (Section 3, lines 100-115)
- ✅ `docs/research/architecture-reviews/Chimera-AWS-Component-Blueprint.md` (lines 135-226)
- ✅ `docs/research/architecture-reviews/Chimera-Architecture-Review-Multi-Tenant.md` (lines 911-980)
- ✅ `docs/research/architecture-reviews/Chimera-Architecture-Review-Platform-IaC.md` (lines 150-161)
- ✅ `docs/research/validation/02-multi-tenant-isolation-ddb.md` (Part B, lines 263-453)

**Authority:** All future architecture documents, CDK code, API handlers, and SDKs MUST reference this document as the single source of truth for DynamoDB schemas.

---

## Appendix

### A. CDK Table Definition Template

```typescript
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';

// Example: chimera-tenants table
const tenantsTable = new dynamodb.Table(this, 'TenantsTable', {
  tableName: 'chimera-tenants',
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PROVISIONED,
  readCapacity: 5,
  writeCapacity: 2,
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  pointInTimeRecovery: true,
  deletionProtection: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN
});

tenantsTable.addGlobalSecondaryIndex({
  indexName: 'tier-index',
  partitionKey: { name: 'tier', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.KEYS_ONLY
});

tenantsTable.addGlobalSecondaryIndex({
  indexName: 'status-index',
  partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.KEYS_ONLY
});

// Example: chimera-audit table with CMK
const auditKey = new kms.Key(this, 'AuditKey', {
  enableKeyRotation: true,
  description: 'CMK for chimera-audit table encryption'
});

const auditTable = new dynamodb.Table(this, 'AuditTable', {
  tableName: 'chimera-audit',
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.ON_DEMAND,
  encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
  encryptionKey: auditKey,
  timeToLiveAttribute: 'ttl',
  stream: dynamodb.StreamViewType.NEW_IMAGE,
  pointInTimeRecovery: true
});

auditTable.addGlobalSecondaryIndex({
  indexName: 'event-type-index',
  partitionKey: { name: 'eventType', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL
});
```

### B. Capacity Planning Guidelines

| Table | Expected QPS | RCU (eventual) | WCU | Cost/month |
|-------|--------------|----------------|-----|------------|
| `chimera-tenants` | 50 | 5 | 2 | $3.50 |
| `chimera-sessions` | 500 (on-demand) | N/A | N/A | ~$25 |
| `chimera-skills` | 20 | 5 | 2 | $3.50 |
| `chimera-rate-limits` | 1000 (on-demand) | N/A | N/A | ~$75 |
| `chimera-cost-tracking` | 10 | 5 | 5 | $5 |
| `chimera-audit` | 100 (on-demand) | N/A | N/A | ~$15 |
| **Total** | | | | **~$127/month** |

*Assumes 1000 tenants, moderate usage. Scales with tenant count and session activity.*

### C. Testing Checklist

- [ ] Unit tests for tenant config read (all SK patterns)
- [ ] Unit tests for atomic config updates (single SK)
- [ ] Integration test for GSI cross-tenant leakage prevention
- [ ] Load test for rate-limits table (1000 QPS burst)
- [ ] Chaos test for session TTL expiration
- [ ] Compliance test for audit table CMK encryption
- [ ] Migration test for META → CONFIG#* pattern (with rollback)
- [ ] IAM policy test for LeadingKeys condition enforcement

---

**Version:** 1.1.0
**Last Updated:** 2026-04-17
**Status:** Canonical (authoritative)
**Owner:** AWS Chimera Platform Team
**Review Cycle:** Quarterly or on major schema change proposals
