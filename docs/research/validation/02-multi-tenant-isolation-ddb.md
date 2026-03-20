---
title: "Multi-Tenant Isolation & DynamoDB Schema Validation"
date: 2026-03-19
status: complete
validator: val-multi-tenant-ddb
task_id: chimera-ec1a
tags:
  - validation
  - multi-tenancy
  - dynamodb
  - isolation
  - architecture
---

# Multi-Tenant Isolation & DynamoDB Schema Validation

> **Validation Date:** 2026-03-19
> **Validator Agent:** val-multi-tenant-ddb
> **Task:** chimera-ec1a
> **Objective:** Validate multi-tenant isolation model AND resolve DynamoDB schema contradiction

---

## Executive Summary

**Status:** ✅ **VALIDATED WITH RECOMMENDATIONS**

### Multi-Tenant Isolation
The Chimera platform's 6-layer isolation model built on AgentCore Runtime MicroVMs, DynamoDB partition-key isolation, and S3 prefix policies provides **strong baseline security**. Critical gaps remain in rate limiting, tenant offboarding, and budget enforcement that must be addressed before production.

### DynamoDB Schema Resolution
**Four conflicting designs exist across documentation.** Analysis of requirements, implementation code, and DynamoDB best practices yields **RECOMMENDATION: Adopt the 6-table design** currently implemented in `infra/lib/data-stack.ts`, with modifications from the Multi-Tenant review for enhanced tenant configuration management.

---

## Part A: Multi-Tenant Isolation Model Validation

### Layer 1 — MicroVM Isolation (Compute)

**Current Design:**
AgentCore Runtime provides Firecracker MicroVM isolation per agent session. Each tenant session executes in an isolated VM with dedicated kernel, no shared memory, and sanitized on termination.

**Comparison:**
| Isolation Method | Blast Radius | Cold Start | Cost | Verdict |
|-----------------|--------------|------------|------|---------|
| **AgentCore MicroVM** | Single session | <2s | $0.0015/sec active | ✅ **OPTIMAL** |
| ECS Task (Fargate) | Task group | 30-60s | $0.04/hr minimum | ❌ Too slow |
| Lambda | Function invocation | <1s | $0.0000166/GB-sec | ✅ Good but less control |
| Firecracker (direct) | VM | <500ms | Custom | ⚠️ Complex operational burden |

**Validation:** ✅ **PASS**
AgentCore Runtime MicroVM isolation is **sufficient and appropriate** for multi-tenant agent workloads. It provides:
- Strong kernel-level isolation (comparable to EC2 instances)
- Fast startup for good UX (<2s cold start target met)
- Active-consumption billing aligns with usage patterns
- Managed service removes operational burden of direct Firecracker

**Gaps:**
1. ❌ **No noisy neighbor protection at runtime level** — MicroVMs share host resources. Need application-layer rate limiting.
2. ⚠️ **Session timeout enforcement** — 30min idle / 2hr absolute max must be enforced in code, not assumed.

---

### Layer 2 — Network Isolation

**Current Design:**
Shared VPC with subnet isolation via security groups. Private subnets for AgentCore with VPC endpoints to AWS services.

**Team-Deploy-to-Own-Account Consideration:**
The "team-deploy-to-own-account" model mentioned in the task spec implies **each tenant could deploy to their own AWS account**. This changes the isolation model:

| Deployment Model | Network Isolation | Operational Complexity | Cost Overhead |
|-----------------|-------------------|----------------------|---------------|
| **Shared VPC (current)** | Security groups | Low | None |
| **Dedicated VPC per tenant** | Full network isolation | Medium | +$32/month (NAT) |
| **Separate AWS account** | Account boundary | High | +Control Tower costs |

**Validation:** ✅ **PASS for pooled tenants**, ⚠️ **NEEDS DESIGN for account-per-tenant**

**Recommendations:**
1. **Pooled tiers (Basic/Standard):** Current shared VPC with security groups is sufficient
2. **Premium tier:** Offer dedicated VPC within same account (+$32/mo)
3. **Enterprise tier:** Offer separate AWS account via AWS Organizations (+Control Tower, transit gateway)
4. Document account-per-tenant deployment pattern as separate CDK stack variant

**Gap:** ❌ Multi-account deployment pattern not documented or implemented

---

### Layer 3 — Data Isolation (DynamoDB)

**Current Design:**
6 shared tables with partition key `TENANT#{id}` + IAM condition keys enforce tenant boundaries.

**Isolation Mechanisms:**
```json
{
  "Condition": {
    "ForAllValues:StringLike": {
      "dynamodb:LeadingKeys": ["TENANT#${aws:PrincipalTag/TenantId}*"]
    }
  }
}
```

**Validation:** ✅ **PASS**
DynamoDB partition-key isolation + IAM condition expressions provide **deterministic isolation** (not vulnerable to prompt injection like FM-based authorization).

**Access Pattern Coverage:**
| Pattern | Table | Query Type | Isolated? |
|---------|-------|-----------|-----------|
| Get tenant config | tenants | GetItem | ✅ Yes |
| List tenant sessions | sessions | Query PK=TENANT#{id} | ✅ Yes |
| Cross-tenant skill search | skills | Query GSI1 | ⚠️ **LEAK RISK** |
| Monthly cost by tenant | cost-tracking | Query PK=TENANT#{id} | ✅ Yes |
| Audit logs by event type | audit | Query GSI1 | ⚠️ **LEAK RISK** |

**Critical Gap:** ❌ GSI queries on `skills` and `audit` tables **can leak cross-tenant data** if not filtered at application layer.

**Fix Required:**
```python
# WRONG: GSI query returns all tenants' skills
response = table.query(
    IndexName='GSI1-skill-usage',
    KeyConditionExpression='skillName = :name',
    ExpressionAttributeValues={':name': 'code-review'}
)

# CORRECT: Filter by tenant in application
response = table.query(
    IndexName='GSI1-skill-usage',
    KeyConditionExpression='skillName = :name',
    FilterExpression='tenantId = :tid',  # Filter in app layer
    ExpressionAttributeValues={':name': 'code-review', ':tid': tenant_id}
)
```

---

### Layer 4 — Storage Isolation (S3)

**Current Design:**
3 shared buckets with prefix-based isolation:
- `s3://chimera-tenants-*/tenants/{tenantId}/*` — tenant data
- `s3://chimera-skills-*/skills/tenant/{tenantId}/*` — tenant skills
- `s3://chimera-skills-*/skills/global/*` — shared (read-only)

**IAM Policy:**
```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject"],
  "Resource": "arn:aws:s3:::chimera-tenants-*/tenants/${aws:PrincipalTag/TenantId}/*"
}
```

**Validation:** ✅ **PASS** with prefix-based IAM

**Considerations:**
- **Shared skills:** Global skills at `skills/global/*` are read-only for all tenants ✅
- **Marketplace skills:** Skills at `skills/marketplace/*` need runtime isolation (OpenSandbox) ✅
- **Cross-region replication:** Enterprise tenants need disaster recovery ⚠️ Not configured

**Gap:** ⚠️ No explicit deny rule for other tenant prefixes (defense-in-depth)

**Recommended Additional Policy:**
```json
{
  "Effect": "Deny",
  "Action": "s3:*",
  "Resource": "arn:aws:s3:::chimera-tenants-*/tenants/*",
  "Condition": {
    "StringNotLike": {
      "s3:prefix": ["tenants/${aws:PrincipalTag/TenantId}/*"]
    }
  }
}
```

---

### Layer 5 — Memory Isolation (AgentCore Memory)

**Current Design:**
AgentCore Memory with namespace-per-tenant: `chimera/{tenantId}`

**Validation:** ✅ **PASS** — but application must enforce it

**Critical Rule:**
```python
# CORRECT: Tenant-scoped namespace
memory = MemorySessionManager(
    memory_id="chimera-memory",
    namespace=f"tenant-{tenant_id}",  # Enforced per-tenant
    strategies=["SUMMARY", "SEMANTIC_MEMORY", "USER_PREFERENCE"],
)

# WRONG: Global namespace (DANGEROUS)
memory = MemorySessionManager(
    memory_id="chimera-memory",
    namespace="global",  # ALL TENANTS SHARE MEMORY
)
```

**Gap:** ❌ No validation in code to prevent global namespace leakage

**Required:**
1. Code review for all `MemorySessionManager` instantiations
2. Runtime assertion: `assert namespace.startswith("tenant-"), "Memory namespace must be tenant-scoped"`
3. Integration test: Verify cross-tenant memory isolation

---

### Layer 6 — Identity & Authorization (Cognito + Cedar)

**Current Design:**
- Cognito JWT with `custom:tenant_id` claim
- API Gateway authorizer validates JWT
- Cedar policies enforce tenant-scoped tool/resource access

**Validation:** ✅ **PASS** — architecture is sound

**Cedar Policy Example:**
```cedar
// Deny cross-tenant file access
forbid(
    principal,
    action == Action::"file_access",
    resource
) unless {
    resource.path.startsWith("/workspace/" + principal.tenantId + "/")
};
```

**Gaps:**
1. ❌ **No Cedar policy corpus exists** — policies referenced but not implemented
2. ❌ **No budget enforcement policy** — `forbid when principal.currentMonthSpend >= principal.monthlyBudget` not implemented
3. ⚠️ **Session-to-tenant validation** — Application must verify `session_id` matches `tenant_id` on every operation

**Required Implementation:**
- Write `tenant-defaults.cedar`, `skill-access.cedar`, `infra-modification.cedar`
- Deploy to S3 `skills/policies/*.cedar`
- Implement Cedar evaluation at API Gateway Lambda authorizer
- Add inline evaluation before each tool call in agent runtime

---

## Multi-Tenant Isolation: Critical Gaps Summary

| # | Gap | Severity | Impact | Recommended Fix |
|---|-----|----------|--------|----------------|
| 1 | No rate limiting / noisy neighbor protection | **CRITICAL** | Tenant A can starve Tenant B of resources | Implement token bucket rate limiter (see Part C) |
| 2 | No tenant offboarding / data deletion pipeline | **CRITICAL** | GDPR non-compliance | Implement deletion Step Function |
| 3 | No budget enforcement at runtime | **HIGH** | Runaway costs from compromised agents | Cedar policy + Lambda budget enforcer |
| 4 | GSI cross-tenant leakage risk | **HIGH** | Skills/audit data visible across tenants | Add application-layer FilterExpression |
| 5 | No Cedar policy implementation | **HIGH** | Authorization gaps | Write and deploy 3 policy files |
| 6 | No multi-account deployment pattern | **MEDIUM** | Cannot serve highest-compliance tenants | Document AWS Organizations setup |
| 7 | No memory namespace validation | **MEDIUM** | Accidental global namespace use | Runtime assertion in code |
| 8 | No S3 explicit deny policy | **MEDIUM** | Defense-in-depth gap | Add deny rule to IAM policy |

---

## Part B: DynamoDB Schema Contradiction Resolution

### The Contradiction

**Four conflicting DynamoDB designs exist across the research corpus:**

#### Design 1: Platform IaC Review (Single-Table)
**Source:** `Chimera-Architecture-Review-Platform-IaC.md` (lines 150-161)

```
TABLE: chimera-platform
PK: TENANT#{id}
SK: SESSION# | SKILL# | CONFIG | CRON#
GSI1: Cross-tenant queries
```

**Assessment:** Classic single-table design pattern. Flexible but harder to manage tenant isolation.

---

#### Design 2: Final Architecture Plan (6 Tables)
**Source:** `Chimera-Final-Architecture-Plan.md` (lines 100-115)

```
1. chimera-tenants:       TENANT#{id} / META
2. chimera-sessions:      TENANT#{id} / SESSION#{id}
3. chimera-skills:        TENANT#{id} / SKILL#{name}
4. chimera-rate-limits:   TENANT#{id} / WINDOW#{timestamp}
5. chimera-cost-tracking: TENANT#{id} / PERIOD#{yyyy-mm}
6. chimera-audit:         TENANT#{id} / EVENT#{timestamp}
```

**Assessment:** Multi-table design with clear separation of concerns. Matches implementation.

---

#### Design 3: AWS Component Blueprint (6 Tables, Different Attributes)
**Source:** `Chimera-AWS-Component-Blueprint.md` (lines 135-226)

```
Same 6 tables as Design 2, but with:
- Different GSI names (GSI1-tier vs tier)
- Audit table uses CMK encryption
- More detailed attribute specifications
- Sessions table has ttl attribute
```

**Assessment:** Evolution of Design 2 with operational details added.

---

#### Design 4: Multi-Tenant Review (5 Tables, Enhanced Tenant Table)
**Source:** `Chimera-Architecture-Review-Multi-Tenant.md` (lines 911-980)

```
1. chimera-tenants (enhanced):
   - TENANT#{id} / PROFILE
   - TENANT#{id} / CONFIG#features
   - TENANT#{id} / CONFIG#models
   - TENANT#{id} / CONFIG#tools
   - TENANT#{id} / CONFIG#channels
   - TENANT#{id} / BILLING#current
   - TENANT#{id} / QUOTA#{resource}

2-5. Same as Design 2 (sessions, skills, rate-limits, cost-tracking)
Note: Audit table omitted, but likely oversight not intentional change
```

**Assessment:** Most sophisticated tenant configuration model with multi-item config pattern.

---

### Schema Comparison Matrix

| Aspect | Design 1 (Single) | Design 2 (Final) | Design 3 (Blueprint) | Design 4 (Multi-Tenant) |
|--------|------------------|------------------|---------------------|------------------------|
| **Tables** | 1 | 6 | 6 | 5 (likely 6) |
| **Tenant config** | Single item | Single SK=META | Single SK=META | Multi-item pattern |
| **Isolation clarity** | Complex (SK-based) | Clear (table-based) | Clear (table-based) | Clear + enhanced |
| **GSI design** | Generic GSI1 | Named GSIs | Named GSIs + details | Named GSIs + GSI2 |
| **Audit encryption** | Not specified | Not specified | CMK required | Not specified |
| **Rate limit TTL** | Not specified | 5 min | 5 min | Specified |
| **Operational detail** | Low | Medium | High | High |
| **Implemented?** | No | **Yes** ✅ | Partially | No |

---

### Decision Analysis: Single-Table vs Multi-Table

#### Single-Table Arguments (Design 1)
**Pros:**
- Fewer tables to manage (1 vs 6)
- All data in one place for complex queries
- DynamoDB best practice for some use cases

**Cons:**
- ❌ **Harder to enforce isolation** — all tenant data in one table
- ❌ **Complex access patterns** — SK overloading makes queries harder
- ❌ **Capacity planning complexity** — one hot partition affects all concerns
- ❌ **TTL conflicts** — sessions expire in 24h, audit logs in 7 years, can't use table-level TTL
- ❌ **Encryption conflicts** — audit needs CMK, others can use AWS-managed

#### Multi-Table Arguments (Designs 2/3/4)
**Pros:**
- ✅ **Clear isolation boundaries** — table-level IAM policies
- ✅ **Independent scaling** — rate-limits table can use on-demand, others provisioned
- ✅ **Different TTL per table** — sessions 24h, audit 90d-7yr, cost 2yr
- ✅ **Different encryption** — audit CMK, others AWS-managed
- ✅ **Easier to understand** — one concern per table
- ✅ **Backup granularity** — can PITR sessions independently of tenants

**Cons:**
- More tables to manage (6 vs 1)
- Cross-table queries require application logic

---

### Recommended Schema: Hybrid of Designs 2/3/4

**RECOMMENDATION:** Adopt **6-table design** from `infra/lib/data-stack.ts` (Design 3) with **enhanced tenant config pattern** from Design 4.

#### Table 1: `chimera-tenants` (Enhanced)

```typescript
// Multiple items per tenant for config flexibility
PK: TENANT#{id}
SK: PROFILE | CONFIG#features | CONFIG#models | CONFIG#tools | CONFIG#channels | BILLING#current | QUOTA#{resource}

GSI1: tier -> tenantId (query tenants by tier)
GSI2: status -> tenantId (query by status: ACTIVE, SUSPENDED, etc.)

Attributes:
- PROFILE: tenantId, name, tier, status, admin_email, data_region, created_at
- CONFIG#features: code_interpreter, browser, cron_jobs, self_editing_iac, max_subagents
- CONFIG#models: allowed_models, default_model, model_routing, fallback_chain, monthly_budget_usd
- CONFIG#tools: allowed_tools, denied_tools, tool_rate_limits
- CONFIG#channels: enabled_channels, bot_tokens (ref to Secrets Manager)
- BILLING#current: monthly_spend_usd, token_usage, last_invoice_date
- QUOTA#{resource}: limit, current, reset_at
```

**Why Enhanced Pattern:**
- Atomic updates to individual config sections (e.g., change model config without rewriting tool config)
- Flexible schema evolution (add new CONFIG# types without schema migration)
- Fine-grained IAM permissions (some roles can update CONFIG#models but not BILLING#current)

#### Tables 2-6: As Implemented

```typescript
// Table 2: Sessions (as-is)
PK: TENANT#{id}, SK: SESSION#{id}
GSI1: agentId -> lastActivity
TTL: ttl (24 hours)

// Table 3: Skills (as-is)
PK: TENANT#{id}, SK: SKILL#{name}
GSI1: skillName -> tenantId

// Table 4: Rate Limits (as-is)
PK: TENANT#{id}, SK: WINDOW#{timestamp} or RATELIMIT#{resource}
TTL: ttl (5 minutes for windows, none for token buckets)

// Table 5: Cost Tracking (as-is)
PK: TENANT#{id}, SK: PERIOD#{yyyy-mm}
No TTL (retained 2 years)

// Table 6: Audit (as-is)
PK: TENANT#{id}, SK: EVENT#{timestamp}#{uuid}
GSI1: eventType -> timestamp
TTL: tier-dependent (90d, 1yr, 7yr)
Encryption: CMK
```

---

### Migration Path from Current Implementation

**Current State:** 6 tables with simple tenant config (PK=TENANT#{id}, SK=META)

**Target State:** 6 tables with enhanced tenant config (multi-item pattern)

**Migration Steps:**
1. **Week 1:** Add new SK types (CONFIG#features, CONFIG#models, etc.) alongside existing META item
2. **Week 2:** Update application code to read from new SK pattern, fallback to META for missing
3. **Week 3:** Background job to copy META data into structured CONFIG# items
4. **Week 4:** Switch all writes to new pattern
5. **Week 5:** Deprecate META reads, all code uses CONFIG# pattern
6. **Week 6:** Delete META items (after verification)

**Zero-downtime:** Application reads from both patterns during migration.

---

## Part C: Rate Limiting Implementation (Critical Gap)

**Gap:** No rate limiting design to prevent noisy neighbor.

**Recommended Implementation:**

### Token Bucket Rate Limiter (DynamoDB-Backed)

```python
import time
import boto3
from decimal import Decimal
from typing import Dict, Optional

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('chimera-rate-limits')

class TokenBucketRateLimiter:
    """
    Multi-resource token bucket rate limiter backed by DynamoDB.
    Provides per-tenant rate limits for requests, tokens, tool calls, etc.
    """

    def __init__(self, tenant_id: str):
        self.tenant_id = tenant_id
        self.limits = self._get_tenant_limits()

    def _get_tenant_limits(self) -> Dict:
        """Load tenant-specific rate limits from tenants table."""
        response = table.get_item(
            Key={'PK': f'TENANT#{self.tenant_id}', 'SK': 'CONFIG#limits'}
        )
        return response.get('Item', self._default_limits())

    def _default_limits(self) -> Dict:
        """Default rate limits for basic tier."""
        return {
            'requests_per_minute': {'max': 10, 'refill': 10/60},
            'tokens_per_hour': {'max': 50000, 'refill': 50000/3600},
            'tool_calls_per_hour': {'max': 100, 'refill': 100/3600},
            'concurrent_sessions': {'max': 2},
        }

    def check_and_consume(self, resource: str, cost: int = 1) -> bool:
        """
        Check if resource is available and consume tokens.
        Returns True if allowed, False if throttled.
        """
        if resource not in self.limits:
            return True  # No limit defined, allow

        config = self.limits[resource]
        max_tokens = config['max']
        refill_rate = config['refill']  # tokens per second

        now = Decimal(str(time.time()))

        try:
            response = table.update_item(
                Key={'PK': f'TENANT#{self.tenant_id}', 'SK': f'RATELIMIT#{resource}'},
                UpdateExpression="""
                    SET
                        tokens = if_not_exists(tokens, :max) - :cost + ((:now - if_not_exists(last_refill, :now)) * :rate),
                        last_refill = :now,
                        max_tokens = :max,
                        refill_rate = :rate
                """,
                ConditionExpression='(if_not_exists(tokens, :max) + ((:now - if_not_exists(last_refill, :now)) * :rate)) >= :cost',
                ExpressionAttributeValues={
                    ':cost': Decimal(str(cost)),
                    ':now': now,
                    ':max': Decimal(str(max_tokens)),
                    ':rate': Decimal(str(refill_rate)),
                },
                ReturnValues='ALL_NEW'
            )
            return True  # Allowed
        except table.meta.client.exceptions.ConditionalCheckFailedException:
            # Not enough tokens
            return False  # Throttled
```

### Tier-Based Rate Limit Configuration

```python
TIER_LIMITS = {
    'basic': {
        'requests_per_minute': {'max': 10, 'refill': 10/60},
        'tokens_per_hour': {'max': 50_000, 'refill': 50_000/3600},
        'tool_calls_per_hour': {'max': 100, 'refill': 100/3600},
        'concurrent_sessions': {'max': 2},
        'session_max_duration_sec': 900,  # 15 minutes
    },
    'standard': {
        'requests_per_minute': {'max': 100, 'refill': 100/60},
        'tokens_per_hour': {'max': 500_000, 'refill': 500_000/3600},
        'tool_calls_per_hour': {'max': 1_000, 'refill': 1_000/3600},
        'concurrent_sessions': {'max': 10},
        'session_max_duration_sec': 3600,  # 1 hour
    },
    'premium': {
        'requests_per_minute': {'max': 1_000, 'refill': 1_000/60},
        'tokens_per_hour': {'max': 5_000_000, 'refill': 5_000_000/3600},
        'tool_calls_per_hour': {'max': 10_000, 'refill': 10_000/3600},
        'concurrent_sessions': {'max': 100},
        'session_max_duration_sec': 28800,  # 8 hours
    },
}
```

---

## Recommendations Summary

### Immediate Actions (Week 1-2)

1. **✅ DynamoDB Schema:** Adopt 6-table design with enhanced tenant config pattern
2. **🔴 Rate Limiting:** Implement token bucket rate limiter using DynamoDB
3. **🔴 Cedar Policies:** Write and deploy 3 policy files (tenant-defaults, skill-access, infra-modification)
4. **🔴 GSI Leakage:** Add FilterExpression to all GSI queries on skills and audit tables
5. **⚠️ Memory Namespace:** Add runtime assertion to enforce tenant-scoped namespaces

### Short-Term (Week 3-6)

6. **🔴 Tenant Offboarding:** Implement deletion Step Function with GDPR compliance
7. **⚠️ Budget Enforcement:** Add Cedar policy + Lambda enforcer for monthly budget limits
8. **⚠️ S3 Deny Policy:** Add explicit deny rule for cross-tenant S3 prefix access
9. **📋 Multi-Account Pattern:** Document AWS Organizations setup for enterprise tier
10. **📋 Migration Testing:** Validate tenant config migration from simple to enhanced pattern

### Medium-Term (Month 2-3)

11. **📋 Tenant Lifecycle:** Implement full state machine (PROVISIONING -> ACTIVE -> SUSPENDED -> DELETING)
12. **📋 Health Monitoring:** Deploy per-tenant CloudWatch alarms for SLA tracking
13. **📋 Tier Migration:** Implement upgrade/downgrade path between tiers
14. **📋 Audit Logging:** Implement comprehensive audit event schema with SOC2 controls
15. **📋 Compliance:** GDPR data export API, retention policies, deletion certificates

---

## Validation Verdict

| Component | Status | Confidence | Notes |
|-----------|--------|----------|-------|
| **MicroVM Isolation** | ✅ PASS | High | AgentCore Runtime provides strong isolation |
| **Network Isolation** | ⚠️ PASS WITH GAPS | Medium | Needs multi-account pattern |
| **Data Isolation (DynamoDB)** | ⚠️ PASS WITH GAPS | Medium | GSI leakage risk, needs filters |
| **Storage Isolation (S3)** | ✅ PASS | High | Prefix-based IAM is sound |
| **Memory Isolation** | ⚠️ PASS WITH GAPS | Medium | Needs validation code |
| **Identity/Authorization** | ⚠️ PASS WITH GAPS | Low | Cedar policies not implemented |
| **DynamoDB Schema** | ✅ RESOLVED | High | 6-table design recommended |
| **Rate Limiting** | 🔴 FAIL | Low | Not implemented, critical gap |
| **Tenant Offboarding** | 🔴 FAIL | Low | Not implemented, GDPR risk |

**Overall Assessment:** Multi-tenant architecture is **sound but incomplete**. Core isolation primitives (MicroVM, IAM, partition keys) are strong. Application-layer enforcement (rate limiting, budget controls, Cedar policies, offboarding) is missing and must be built before production.

---

## Appendix: Access Pattern Validation

### DynamoDB Access Patterns (6-Table Design)

| Access Pattern | Table | Query Type | Isolation | Performance |
|---------------|-------|-----------|-----------|------------|
| Get tenant config | tenants | GetItem | ✅ PK-based | O(1) |
| List tenant sessions | sessions | Query PK | ✅ Partition-isolated | O(n) within tenant |
| Get active agents | sessions | Query GSI1 | ⚠️ Filter in app | O(n) all tenants |
| Find skill by name | skills | Query GSI1 | ⚠️ Filter in app | O(n) all tenants |
| Tenant monthly cost | cost-tracking | Query PK | ✅ Partition-isolated | O(1) |
| Audit by event type | audit | Query GSI1 | ⚠️ Filter in app | O(n) all tenants |
| Rate limit check | rate-limits | GetItem + UpdateItem | ✅ Atomic | O(1) |
| Check concurrent sessions | sessions | Query PK (count) | ✅ Partition-isolated | O(n) within tenant |

**Validated:** 6-table design supports all required access patterns. GSI queries need application-layer filtering for tenant isolation.

---

**End of Validation Report**
