# ClawCore Architecture Review: Multi-Tenant & Data Isolation

> **Review Date:** 2026-03-19
> **Reviewer:** Multi-Tenant Specialist
> **Status:** Complete
> **Sources:** [[AWS-Native-OpenClaw-Architecture-Synthesis]], [[03-AgentCore-Multi-Tenancy-Deployment]], [[01-AgentCore-Architecture-Runtime]]
> **Scope:** Silo/Pool/Hybrid decision framework, noisy neighbor protection, tenant lifecycle, data isolation, compliance, DynamoDB schemas, IAM policies

---

## Executive Assessment

The ClawCore synthesis document lays a strong architectural foundation for multi-tenancy by leveraging AgentCore's MicroVM isolation and consumption-based billing. However, the current design leaves several critical areas underspecified: tenant lifecycle state management, noisy neighbor throttling mechanics, GDPR data deletion workflows, cross-tenant resource sharing boundaries, and tenant migration paths. This review fills those gaps with concrete designs, schemas, and policy examples.

**Overall Rating: B+** -- Strong isolation primitives from AgentCore, but needs hardening at the application layer for production-grade multi-tenancy.

---

## Table of Contents

- [[#1. Silo/Pool/Hybrid Decision Framework]]
- [[#2. Noisy Neighbor Protection]]
- [[#3. Tenant Onboarding Automation]]
- [[#4. Tenant Offboarding and Data Deletion]]
- [[#5. Data Isolation Guarantees by Layer]]
- [[#6. Cross-Tenant Resource Sharing]]
- [[#7. Tenant Configuration Management]]
- [[#8. Compliance: SOC2, GDPR, Audit Logging]]
- [[#9. Tenant Health Monitoring and SLA Tracking]]
- [[#10. Tenant Migration Between Tiers]]
- [[#11. DynamoDB Table Design for Tenant Management]]
- [[#12. IAM Policy Examples]]
- [[#13. Tenant Lifecycle State Machine]]
- [[#14. Gaps and Recommendations]]

---

## 1. Silo/Pool/Hybrid Decision Framework

### Decision Tree with Concrete Thresholds

The synthesis document identifies silo, pool, and hybrid models but lacks quantitative thresholds for choosing between them. Here is a concrete decision framework:

```
START: New Tenant Onboarding
  |
  +-- Is tenant subject to data sovereignty / regulatory isolation?
  |   (HIPAA BAA, FedRAMP, financial services ring-fencing)
  |   YES --> SILO (full isolation, dedicated resources)
  |
  +-- Does tenant require >$10K/month spend or >100 concurrent sessions?
  |   YES --> SILO (dedicated AgentCore Runtime endpoint)
  |
  +-- Does tenant require custom model fine-tuning or private endpoints?
  |   YES --> SILO (dedicated model endpoints, VPC isolation)
  |
  +-- Does tenant require <5 concurrent sessions and <$500/month?
  |   YES --> POOL (shared compute, partition-key isolation)
  |
  +-- Everything else:
      --> HYBRID (shared compute, dedicated memory namespace,
          dedicated S3 prefix, pooled Gateway)
```

### Quantitative Tier Thresholds

| Dimension | Pool (Basic) | Hybrid (Advanced) | Silo (Premium) |
|-----------|-------------|-------------------|-----------------|
| Monthly spend | <$500 | $500-$10,000 | >$10,000 |
| Concurrent sessions | 1-5 | 5-50 | 50-1,000+ |
| Data residency | Shared region | Shared region, dedicated prefix | Dedicated region/account |
| SLA target | 99.5% | 99.9% | 99.95% |
| Model access | Nova Lite, Haiku | Sonnet, Nova Pro | Opus, custom fine-tuned |
| Memory storage | 100 MB | 1 GB | 10 GB+ |
| Support | Community | Business hours | 24/7 dedicated |

### What the Synthesis Gets Right

- MicroVM isolation at the session level provides strong compute isolation even in the pool model
- Cognito JWT routing to silo vs. pool endpoints is clean and standards-based
- S3 prefix + DynamoDB partition isolation is the correct pattern for pooled data

### What the Synthesis Misses

1. **No tier upgrade/downgrade path.** A tenant starting on Pool cannot move to Silo without manual intervention. See [[#10. Tenant Migration Between Tiers]].
2. **No account-level isolation option.** For the highest-compliance tenants, separate AWS accounts (via AWS Organizations + Control Tower) should be the top tier above Silo.
3. **No per-agent isolation granularity.** The hybrid model should allow per-agent isolation decisions (e.g., compliance agent in silo, general chat agent in pool) within the same tenant.

---

## 2. Noisy Neighbor Protection

### The Problem

The synthesis mentions "noisy neighbor" only in passing. In a pooled AgentCore deployment, a single tenant running expensive multi-agent workflows (e.g., 50 concurrent Opus sessions with Code Interpreter) can starve other tenants of:

1. **AgentCore Runtime session slots** (service quota is shared)
2. **Bedrock model throughput** (tokens per minute per model per account)
3. **DynamoDB read/write capacity** (even on-demand has burst limits)
4. **Gateway tool invocation capacity**
5. **Memory service event throughput**

### Multi-Layer Throttling Architecture

```
Layer 1: API Gateway (entry point)
+------------------------------------------+
| WAF rate limiting per tenant IP/JWT      |
| - Basic: 10 req/min                     |
| - Advanced: 100 req/min                 |
| - Premium: 1,000 req/min                |
+------------------------------------------+
           |
Layer 2: Tenant Router (Lambda + DynamoDB)
+------------------------------------------+
| Token bucket per tenant (DynamoDB)       |
| - Check concurrent session count         |
| - Check daily token budget remaining     |
| - Check monthly cost budget remaining    |
| REJECT if any limit exceeded             |
+------------------------------------------+
           |
Layer 3: AgentCore Runtime
+------------------------------------------+
| Per-session resource limits:             |
| - Max session duration (tier-based)      |
| - Max tool calls per session             |
| - Max tokens per session                 |
+------------------------------------------+
           |
Layer 4: Model Access (Bedrock)
+------------------------------------------+
| Per-tenant provisioned throughput or     |
| token budget enforcement via wrapper     |
+------------------------------------------+
           |
Layer 5: Data Access (DynamoDB/S3)
+------------------------------------------+
| DynamoDB on-demand capacity partitioned  |
| S3 request rate per prefix               |
+------------------------------------------+
```

### Token Bucket Implementation (DynamoDB)

```python
import time
import boto3
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('clawcore-rate-limits')

def check_and_consume_token(tenant_id: str, resource: str, cost: int = 1) -> bool:
    """
    Token bucket rate limiter backed by DynamoDB.
    Returns True if request is allowed, False if throttled.
    """
    now = Decimal(str(time.time()))

    try:
        response = table.update_item(
            Key={'PK': f'TENANT#{tenant_id}', 'SK': f'RATELIMIT#{resource}'},
            UpdateExpression="""
                SET tokens = if_not_exists(tokens, max_tokens) -
                    :cost + ((:now - if_not_exists(last_refill, :now))
                    * refill_rate),
                last_refill = :now
            """,
            ConditionExpression='tokens >= :cost',
            ExpressionAttributeValues={
                ':cost': cost,
                ':now': now,
            },
            ReturnValues='ALL_NEW'
        )
        return True
    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        return False  # Throttled
```

### Tier-Based Rate Limits (Concrete Values)

| Resource | Basic | Advanced | Premium |
|----------|-------|----------|---------|
| API requests/min | 10 | 100 | 1,000 |
| Concurrent sessions | 2 | 10 | 100 |
| Tokens/hour (input) | 50,000 | 500,000 | 5,000,000 |
| Tokens/hour (output) | 25,000 | 250,000 | 2,500,000 |
| Tool calls/session | 10 | 50 | Unlimited |
| Tool calls/hour (total) | 100 | 1,000 | 10,000 |
| Session max duration | 15 min | 1 hour | 8 hours |
| Memory events/day | 1,000 | 10,000 | 100,000 |
| Memory storage | 100 MB | 1 GB | 10 GB |
| Monthly budget cap | $50 | $500 | $10,000 |
| Models allowed | Nova Lite, Haiku | +Sonnet, Nova Pro | +Opus, custom |

### Burst Handling

For legitimate traffic bursts (e.g., a batch processing job), implement a **burst credit** system:

```python
# Burst credit config per tier (stored in tenant config)
BURST_CONFIG = {
    'basic':    {'burst_multiplier': 2,  'burst_duration_sec': 60},
    'advanced': {'burst_multiplier': 5,  'burst_duration_sec': 300},
    'premium':  {'burst_multiplier': 10, 'burst_duration_sec': 600},
}
```

### Gap in Synthesis

The synthesis document has zero detail on rate limiting implementation. It mentions "noisy neighbor risk at tool/API layer" in the scaling table but provides no mitigation strategy. This is a **critical gap** for any production multi-tenant deployment.

---

## 3. Tenant Onboarding Automation

### The Problem

The synthesis shows a simple Mermaid diagram for onboarding but lacks implementation detail for automated, API-driven provisioning.

### Tenant Onboarding API

```python
# POST /api/v1/tenants
{
    "tenant_name": "Acme Corp",
    "tier": "advanced",
    "admin_email": "admin@acme.com",
    "config": {
        "enabled_models": ["us.anthropic.claude-sonnet-4-6-v1:0", "us.amazon.nova-pro-v1:0"],
        "enabled_channels": ["slack", "web"],
        "default_model": "us.anthropic.claude-sonnet-4-6-v1:0",
        "data_region": "us-east-1",
        "features": {
            "code_interpreter": true,
            "browser": false,
            "cron_jobs": true,
            "self_editing_iac": false
        }
    }
}
```

### Onboarding Step Function (State Machine)

```json
{
  "Comment": "Tenant Onboarding Workflow",
  "StartAt": "ValidateRequest",
  "States": {
    "ValidateRequest": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:*:*:function:validate-tenant-request",
      "Next": "CreateIdentity"
    },
    "CreateIdentity": {
      "Type": "Parallel",
      "Branches": [
        {
          "StartAt": "CreateCognitoGroup",
          "States": {
            "CreateCognitoGroup": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:*:*:function:create-cognito-group",
              "End": true
            }
          }
        },
        {
          "StartAt": "CreateAPIKey",
          "States": {
            "CreateAPIKey": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:*:*:function:create-api-key",
              "End": true
            }
          }
        }
      ],
      "Next": "ProvisionResources"
    },
    "ProvisionResources": {
      "Type": "Parallel",
      "Branches": [
        {
          "StartAt": "WriteTenantConfig",
          "States": {
            "WriteTenantConfig": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:*:*:function:write-tenant-config",
              "End": true
            }
          }
        },
        {
          "StartAt": "CreateS3Prefix",
          "States": {
            "CreateS3Prefix": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:*:*:function:create-s3-prefix",
              "End": true
            }
          }
        },
        {
          "StartAt": "CreateMemoryNamespace",
          "States": {
            "CreateMemoryNamespace": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:*:*:function:create-memory-namespace",
              "End": true
            }
          }
        },
        {
          "StartAt": "SetupRateLimits",
          "States": {
            "SetupRateLimits": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:*:*:function:setup-rate-limits",
              "End": true
            }
          }
        }
      ],
      "Next": "IsSiloTier"
    },
    "IsSiloTier": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.tier",
          "StringEquals": "premium",
          "Next": "DeploySiloInfra"
        }
      ],
      "Default": "ConfigurePoolRouting"
    },
    "DeploySiloInfra": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:*:*:function:deploy-silo-cdk-stack",
      "TimeoutSeconds": 600,
      "Next": "InstallDefaultSkills"
    },
    "ConfigurePoolRouting": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:*:*:function:configure-pool-routing",
      "Next": "InstallDefaultSkills"
    },
    "InstallDefaultSkills": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:*:*:function:install-default-skills",
      "Next": "SendWelcome"
    },
    "SendWelcome": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:*:*:function:send-welcome-notification",
      "Next": "ActivateTenant"
    },
    "ActivateTenant": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:*:*:function:activate-tenant",
      "End": true
    }
  }
}
```

### Target Onboarding Times

| Tier | Target Time | Bottleneck |
|------|-------------|------------|
| Pool (Basic) | <30 seconds | DynamoDB writes + Cognito group creation |
| Hybrid (Advanced) | <2 minutes | + Memory namespace + S3 prefix setup |
| Silo (Premium) | <10 minutes | + CDK stack deployment (dedicated Runtime endpoint) |

### Self-Service Portal

For self-service onboarding, expose a web portal backed by this Step Function:

1. Admin signs up with email + OAuth (Cognito Hosted UI)
2. Selects tier and configuration options
3. Step Function executes provisioning
4. Admin receives API key + SDK configuration + quickstart guide
5. Tenant status visible in portal dashboard

### CLI Onboarding

```bash
# CLI for platform operators
clawcore tenant create \
  --name "Acme Corp" \
  --tier advanced \
  --admin-email admin@acme.com \
  --models claude-sonnet,nova-pro \
  --channels slack,web \
  --region us-east-1

# Output:
# Tenant ID: tenant-acme-a1b2c3d4
# API Key:   cc_live_sk_...
# Endpoint:  https://api.clawcore.example.com/v1
# Status:    PROVISIONING -> ACTIVE (estimated: 90 seconds)
```

---

## 4. Tenant Offboarding and Data Deletion

### The Problem

The synthesis document has **zero mention** of tenant offboarding, data deletion, or GDPR right to erasure. This is a critical gap for any multi-tenant SaaS platform.

### Offboarding Triggers

1. **Voluntary churn** -- Tenant requests account deletion
2. **Involuntary churn** -- Non-payment, ToS violation
3. **GDPR Article 17** -- Right to erasure request
4. **Contract expiration** -- Enterprise contract ends without renewal

### Data Deletion Inventory

Every piece of tenant data must be catalogued and deletable:

| Data Store | Data Type | Location | Deletion Method |
|------------|-----------|----------|----------------|
| DynamoDB | Tenant config | `clawcore-tenants` table, PK=`TENANT#{id}` | BatchWriteItem delete |
| DynamoDB | Session history | `clawcore-sessions` table, PK=`TENANT#{id}` | BatchWriteItem delete with pagination |
| DynamoDB | Rate limit state | `clawcore-rate-limits` table, PK=`TENANT#{id}` | BatchWriteItem delete |
| DynamoDB | Cost attribution | `clawcore-cost-tracking` table, PK=`TENANT#{id}` | BatchWriteItem delete |
| DynamoDB | Skill metadata | `clawcore-skills` table, PK=`TENANT#{id}` | BatchWriteItem delete |
| S3 | Skills, memory, outputs | `s3://clawcore-tenants/{tenant_id}/` | DeleteObjects (recursive) |
| S3 | Skill packages | `s3://clawcore-skills/tenants/{tenant_id}/` | DeleteObjects (recursive) |
| AgentCore Memory | STM + LTM | Namespace `{tenant_id}` | AgentCore Memory API delete |
| Cognito | User pool group | Group `tenant-{id}` | DeleteGroup + remove users |
| EventBridge | Cron schedules | Rules with tenant tag | DeleteRule |
| CloudWatch | Logs | Log groups with tenant prefix | DeleteLogGroup |
| Cedar | Policies | Tenant-scoped policies | Delete policy statements |

### Offboarding Step Function

```
START: OffboardTenant
  |
  +-> SuspendTenant (set status=SUSPENDING, disable API key)
  |
  +-> GracePeriod (30 days for voluntary, 0 for GDPR erasure)
  |     |
  |     +-> Can tenant reactivate? YES -> ReactivateTenant
  |
  +-> ExportData (if requested: generate tenant data export to S3)
  |
  +-> DeleteData (parallel):
  |     +-> Delete DynamoDB items (all tables, paginated)
  |     +-> Delete S3 objects (recursive prefix delete)
  |     +-> Delete AgentCore Memory namespace
  |     +-> Delete Cognito group + users
  |     +-> Delete EventBridge rules
  |     +-> Delete CloudWatch log groups
  |     +-> Delete Cedar policies
  |     +-> (Silo only) Destroy CDK stack
  |
  +-> VerifyDeletion (audit: confirm zero items remain)
  |
  +-> GenerateDeletionCertificate (GDPR compliance artifact)
  |
  +-> ArchiveTenantRecord (tombstone with deletion timestamp, no PII)
  |
  END
```

### GDPR Right to Erasure Timeline

| Phase | Duration | Actions |
|-------|----------|---------|
| Acknowledgment | <24 hours | Confirm receipt of erasure request |
| Suspension | <48 hours | Disable tenant access, stop data processing |
| Deletion | <30 days (GDPR maximum) | Execute full data deletion pipeline |
| Verification | <72 hours after deletion | Confirm no residual data, generate certificate |
| Certificate | Same day as verification | Issue deletion certificate to data subject |

### Deletion Verification Query

```python
def verify_tenant_deletion(tenant_id: str) -> dict:
    """Post-deletion audit: verify no residual tenant data exists."""
    results = {}

    # Check DynamoDB tables
    for table_name in TENANT_TABLES:
        response = dynamodb.query(
            TableName=table_name,
            KeyConditionExpression='PK = :pk',
            ExpressionAttributeValues={':pk': {'S': f'TENANT#{tenant_id}'}},
            Limit=1
        )
        results[f'dynamodb:{table_name}'] = len(response['Items']) == 0

    # Check S3 prefixes
    for prefix in [f'tenants/{tenant_id}/', f'skills/tenants/{tenant_id}/']:
        response = s3.list_objects_v2(
            Bucket='clawcore-tenants', Prefix=prefix, MaxKeys=1
        )
        results[f's3:{prefix}'] = response['KeyCount'] == 0

    # Check Cognito
    try:
        cognito.get_group(GroupName=f'tenant-{tenant_id}', UserPoolId=USER_POOL_ID)
        results['cognito:group'] = False
    except cognito.exceptions.ResourceNotFoundException:
        results['cognito:group'] = True

    all_clean = all(results.values())
    return {'tenant_id': tenant_id, 'all_deleted': all_clean, 'details': results}
```

---

## 5. Data Isolation Guarantees by Layer

### Isolation Matrix

| Layer | Pool Model | Hybrid Model | Silo Model |
|-------|-----------|-------------|------------|
| **Compute** | Shared AgentCore Runtime, MicroVM per session | Shared Runtime, MicroVM per session | Dedicated Runtime endpoint |
| **Network** | Shared VPC, shared subnets | Shared VPC, tenant security groups | Dedicated VPC or VPC endpoint |
| **Storage (S3)** | Shared bucket, prefix isolation + IAM | Shared bucket, prefix isolation + IAM | Dedicated bucket |
| **Database (DynamoDB)** | Shared table, partition key isolation + IAM | Shared table, partition key + IAM | Dedicated table |
| **Memory (AgentCore)** | Shared service, namespace isolation | Shared service, namespace isolation | Dedicated memory instance |
| **Identity (Cognito)** | Shared user pool, group-based | Shared user pool, group-based | Dedicated user pool |
| **Models (Bedrock)** | Shared model endpoints | Shared + provisioned throughput | Dedicated provisioned throughput |
| **Secrets** | Shared Secrets Manager, resource policy | Shared, resource policy | Dedicated secrets |
| **Logs** | Shared log group, tenant-tagged | Dedicated log streams | Dedicated log group |
| **In-memory (MicroVM)** | Sanitized on session termination | Sanitized on session termination | Sanitized on session termination |

### Critical Isolation Rule

> **Tenant context must NEVER pass through LLM reasoning for authorization decisions.** FMs are susceptible to prompt injection and cannot be trusted to preserve tenant context integrity. All isolation enforcement must be deterministic: IAM policies, Cedar policies, DynamoDB condition expressions, S3 bucket policies.

This rule from the AWS Prescriptive Guidance (03-AgentCore-Multi-Tenancy-Deployment, Section 4.1) is correctly reflected in the synthesis design but deserves explicit callout.

### Memory Isolation Deep Dive

AgentCore Memory provides namespace-level isolation, but the application must enforce it:

```python
# CORRECT: Namespace scoped to tenant
memory = MemorySessionManager(
    memory_id="clawcore-memory",
    namespace=f"tenant-{tenant_id}",  # Tenant-scoped namespace
    strategies=["SUMMARY", "SEMANTIC_MEMORY", "USER_PREFERENCE"],
)

# WRONG: Global namespace (cross-tenant leakage risk)
memory = MemorySessionManager(
    memory_id="clawcore-memory",
    namespace="global",  # DANGER: all tenants share memory
)
```

### Session ID Isolation

AgentCore does NOT enforce session-to-tenant mappings. The application must:

```python
# Session ID must encode tenant ownership for audit trail
session_id = f"tenant-{tenant_id}-user-{user_id}-{uuid.uuid4()}"

# Validation before any session operation
def validate_session_ownership(session_id: str, tenant_id: str) -> bool:
    """Verify session belongs to requesting tenant."""
    return session_id.startswith(f"tenant-{tenant_id}-")
```

---

## 6. Cross-Tenant Resource Sharing

### Shared Skills Marketplace

The synthesis correctly identifies a three-tier skill storage model (global, marketplace, tenant). The sharing boundaries need explicit rules:

| Skill Source | Who Can Use | Who Can Modify | Isolation |
|-------------|-------------|---------------|-----------|
| Global (`global/`) | All tenants | Platform operators only | Read-only access |
| Marketplace (`marketplace/`) | Tenants who install | Original author | Runs in OpenSandbox per tenant |
| Tenant (`tenants/{id}/`) | Only owning tenant | Only owning tenant | Full isolation |

### Shared Model Endpoints

Bedrock model endpoints are inherently shared (on-demand). For isolation:

1. **On-demand inference** (pool): Shared, rate-limited per tenant via application layer
2. **Provisioned throughput** (silo): Dedicated model throughput per tenant, billed directly
3. **Cross-region inference profiles**: Can be tenant-specific for premium tiers

### What Should NEVER Be Shared

| Resource | Reason |
|----------|--------|
| Tenant memory (STM/LTM) | Core privacy guarantee |
| Tenant credentials/secrets | Security boundary |
| Tenant session state | Data contamination risk |
| Tenant-specific skills | Intellectual property |
| Tenant audit logs | Compliance requirement |
| Tenant cost data | Business confidentiality |

---

## 7. Tenant Configuration Management

### Feature Flags per Tenant

```python
# DynamoDB item: TENANT#acme / CONFIG#features
{
    "PK": "TENANT#acme",
    "SK": "CONFIG#features",
    "code_interpreter": True,
    "browser": False,
    "cron_jobs": True,
    "self_editing_iac": False,
    "multi_agent": True,
    "skill_marketplace": True,
    "a2a_protocol": False,
    "max_subagents": 5,
    "custom_system_prompt": True,
    "updated_at": "2026-03-19T12:00:00Z",
    "updated_by": "platform-admin"
}
```

### Model Access Control per Tenant

```python
# DynamoDB item: TENANT#acme / CONFIG#models
{
    "PK": "TENANT#acme",
    "SK": "CONFIG#models",
    "allowed_models": [
        "us.anthropic.claude-sonnet-4-6-v1:0",
        "us.amazon.nova-pro-v1:0",
        "us.amazon.nova-lite-v1:0"
    ],
    "default_model": "us.anthropic.claude-sonnet-4-6-v1:0",
    "model_routing": "cost_optimized",
    "fallback_chain": ["us.anthropic.claude-sonnet-4-6-v1:0", "us.amazon.nova-lite-v1:0"],
    "monthly_budget_usd": 500,
    "current_month_spend_usd": 127.43
}
```

### Tool Permission Matrix

```python
# DynamoDB item: TENANT#acme / CONFIG#tools
{
    "PK": "TENANT#acme",
    "SK": "CONFIG#tools",
    "allowed_tools": [
        "read_file", "write_file", "edit_file", "shell",
        "web_search", "code_interpreter"
    ],
    "denied_tools": [
        "manage_infrastructure",  # Not enabled for this tier
        "admin_console"
    ],
    "tool_rate_limits": {
        "shell": {"max_per_session": 20, "max_per_hour": 100},
        "web_search": {"max_per_session": 10, "max_per_hour": 50},
        "code_interpreter": {"max_per_session": 5, "max_per_hour": 20}
    }
}
```

### Configuration Propagation

Configuration changes must propagate to active sessions. Two strategies:

1. **Lazy propagation** (recommended for most configs): Check DynamoDB on each request. DynamoDB single-digit-ms reads are fast enough. Cache with 60-second TTL in session.
2. **Eager propagation** (for security-critical changes like tool revocation): Publish to EventBridge, active sessions subscribe and update immediately.

---

## 8. Compliance: SOC2, GDPR, Audit Logging

### SOC2 Controls Mapping

| SOC2 Control | ClawCore Implementation |
|-------------|------------------------|
| **CC6.1** Logical access security | Cognito JWT + IAM + Cedar policies |
| **CC6.2** User authentication | Cognito MFA + OAuth 2.0 |
| **CC6.3** Access authorization | Cedar policies per tenant/tier + Gateway interceptors |
| **CC6.6** Restricting access to data at rest | S3 SSE-KMS (per-tenant KMS keys for silo), DynamoDB encryption |
| **CC6.7** Restricting transmission | TLS 1.2+ everywhere, VPC PrivateLink for silo |
| **CC7.1** Monitoring infrastructure | AgentCore Observability + CloudWatch + X-Ray |
| **CC7.2** Monitoring for anomalies | CloudWatch Anomaly Detection on per-tenant metrics |
| **CC7.3** Evaluating security events | EventBridge rules + Security Hub integration |
| **CC8.1** Change management | CDK GitOps pipeline, PR review, immutable versioning |
| **A1.2** Recovery objectives | S3 versioning, DynamoDB point-in-time recovery, multi-AZ |

### GDPR Data Residency

| Requirement | Implementation |
|------------|----------------|
| Data residency | Deploy AgentCore in EU regions (eu-central-1, eu-west-1) |
| Data processing agreement | Platform-level DPA covering all tenant data |
| Right to access (Art. 15) | Tenant data export API (S3 presigned URLs) |
| Right to erasure (Art. 17) | Offboarding pipeline (see [[#4. Tenant Offboarding and Data Deletion]]) |
| Data portability (Art. 20) | Export in machine-readable format (JSON/CSV) |
| Consent management | Cognito custom attributes for consent flags |
| Cross-border transfers | Use Bedrock cross-region inference profiles within same jurisdiction |

### Audit Log Schema

Every tenant-affecting operation must be logged:

```python
# CloudWatch Logs / DynamoDB audit trail
{
    "timestamp": "2026-03-19T12:34:56.789Z",
    "event_type": "AGENT_INVOCATION",
    "tenant_id": "acme",
    "user_id": "user-123",
    "session_id": "tenant-acme-user-123-uuid",
    "action": "invoke_tool",
    "tool_name": "shell",
    "tool_input_hash": "sha256:abc123...",  # Hash, not content (privacy)
    "model_id": "us.anthropic.claude-sonnet-4-6-v1:0",
    "tokens_input": 1523,
    "tokens_output": 847,
    "latency_ms": 3200,
    "status": "SUCCESS",
    "ip_address": "203.0.113.42",
    "user_agent": "clawcore-sdk/1.0",
    "cedar_policy_evaluated": "tenant-acme-tool-access",
    "cedar_decision": "ALLOW"
}
```

### Audit Log Retention

| Log Type | Retention | Storage |
|----------|-----------|---------|
| Security events | 7 years | S3 Glacier Deep Archive |
| Agent invocations | 90 days hot, 1 year archive | CloudWatch + S3 |
| Configuration changes | 7 years | DynamoDB + S3 |
| Cost attribution | 2 years | DynamoDB + S3 |
| GDPR deletion certificates | Indefinite | S3 (metadata only, no PII) |

---

## 9. Tenant Health Monitoring and SLA Tracking

### Per-Tenant Health Dashboard

```sql
-- CloudWatch Logs Insights: Tenant health scorecard (last 24h)
fields tenant_id,
  count(*) as total_requests,
  avg(latency_ms) as avg_latency,
  pct(latency_ms, 99) as p99_latency,
  sum(case when status = 'ERROR' then 1 else 0 end) / count(*) * 100 as error_rate,
  sum(tokens_input + tokens_output) as total_tokens
| filter @timestamp > ago(24h)
| stats by tenant_id
| sort total_requests desc
```

### SLA Metrics per Tier

| Metric | Basic SLA | Advanced SLA | Premium SLA |
|--------|-----------|-------------|-------------|
| Availability | 99.5% | 99.9% | 99.95% |
| P99 latency (first token) | <10s | <5s | <3s |
| Error rate | <5% | <1% | <0.1% |
| Onboarding time | <5 min | <2 min | <10 min |
| Support response | 48h | 4h | 1h |

### CloudWatch Alarms per Tenant

```python
# Create per-tenant alarms for SLA tracking
def create_tenant_alarms(tenant_id: str, tier: str):
    thresholds = TIER_SLA_THRESHOLDS[tier]

    cloudwatch.put_metric_alarm(
        AlarmName=f'clawcore-{tenant_id}-error-rate',
        Namespace='ClawCore/Tenants',
        MetricName='ErrorRate',
        Dimensions=[{'Name': 'TenantId', 'Value': tenant_id}],
        Threshold=thresholds['max_error_rate'],
        ComparisonOperator='GreaterThanThreshold',
        EvaluationPeriods=3,
        Period=300,  # 5 minutes
        Statistic='Average',
        AlarmActions=[SNS_TOPIC_ARN],
        TreatMissingData='notBreaching',
    )

    cloudwatch.put_metric_alarm(
        AlarmName=f'clawcore-{tenant_id}-p99-latency',
        Namespace='ClawCore/Tenants',
        MetricName='Latency',
        Dimensions=[{'Name': 'TenantId', 'Value': tenant_id}],
        ExtendedStatistic='p99',
        Threshold=thresholds['max_p99_latency_ms'],
        ComparisonOperator='GreaterThanThreshold',
        EvaluationPeriods=3,
        Period=300,
        AlarmActions=[SNS_TOPIC_ARN],
        TreatMissingData='notBreaching',
    )
```

---

## 10. Tenant Migration Between Tiers

### The Problem

The synthesis has no migration path. A tenant that starts on Basic and grows must be able to upgrade to Advanced or Premium without downtime or data loss.

### Migration State Machine

```
CURRENT_TIER ── UpgradeRequested ──> MIGRATING
                                        |
                    +-------------------+-------------------+
                    |                   |                   |
              Pool->Hybrid        Hybrid->Silo        Pool->Silo
              (fast, <2min)       (slow, <10min)      (slow, <15min)
                    |                   |                   |
                    v                   v                   v
              UpdateConfig        DeploySiloStack     DeploySiloStack
              UpdateLimits        MigrateData         MigrateData
              UpdateRouting       UpdateRouting        MigrateMemory
                    |             MigrateMemory        UpdateRouting
                    |                   |                   |
                    +-------------------+-------------------+
                                        |
                                   VerifyMigration
                                        |
                                   NEW_TIER (active)
```

### Pool to Hybrid Migration (fast path)

1. Update tier in DynamoDB tenant config
2. Update rate limits to new tier thresholds
3. Create dedicated memory namespace (if not existing)
4. Update Cedar policies for expanded tool access
5. Enable new model access
6. Total time: <2 minutes, zero downtime

### Hybrid to Silo Migration (requires data movement)

1. Deploy dedicated CDK stack (AgentCore Runtime endpoint)
2. Copy S3 data from shared bucket to dedicated bucket
3. Migrate DynamoDB items from shared table to dedicated table
4. Migrate AgentCore Memory to dedicated namespace/instance
5. Update routing to point to dedicated endpoint
6. Verify: run health check against new endpoint
7. Cutover: atomic DNS/routing switch
8. Cleanup: remove items from shared tables after 24h grace period
9. Total time: <10 minutes, brief routing switch

### Downgrade Path

Downgrading (Silo to Pool) is more complex:

1. Validate current usage fits within new tier limits
2. Migrate data from dedicated resources back to shared
3. Destroy dedicated CDK stack
4. Update routing, limits, policies
5. **Warning**: Must enforce new rate limits, which may break existing workflows

### Data Migration Safety

```python
def migrate_dynamodb_items(source_table: str, target_table: str,
                           tenant_id: str) -> dict:
    """Migrate all items for a tenant between tables."""
    migrated = 0
    errors = 0

    paginator = dynamodb.get_paginator('query')
    for page in paginator.paginate(
        TableName=source_table,
        KeyConditionExpression='PK = :pk',
        ExpressionAttributeValues={':pk': {'S': f'TENANT#{tenant_id}'}}
    ):
        with dynamodb.Table(target_table).batch_writer() as batch:
            for item in page['Items']:
                try:
                    batch.put_item(Item=item)
                    migrated += 1
                except Exception as e:
                    errors += 1
                    log.error(f"Migration error: {e}")

    return {'migrated': migrated, 'errors': errors}
```

---

## 11. DynamoDB Table Design for Tenant Management

### Core Tenant Table: `clawcore-tenants`

**Access patterns:**
1. Get tenant by ID
2. List all tenants by status
3. Get tenant configuration (features, models, tools)
4. Get tenant rate limits
5. Update tenant status
6. List tenants by tier

| PK | SK | Attributes | Access Pattern |
|----|-----|------------|---------------|
| `TENANT#{id}` | `PROFILE` | name, tier, status, created_at, admin_email, data_region | Get tenant profile |
| `TENANT#{id}` | `CONFIG#features` | feature flags (code_interpreter, browser, etc.) | Get feature config |
| `TENANT#{id}` | `CONFIG#models` | allowed_models, default_model, budget, routing | Get model config |
| `TENANT#{id}` | `CONFIG#tools` | allowed_tools, denied_tools, tool_rate_limits | Get tool config |
| `TENANT#{id}` | `CONFIG#channels` | enabled_channels, bot_tokens, webhook_urls | Get channel config |
| `TENANT#{id}` | `BILLING#current` | monthly_spend, token_usage, last_invoice | Get billing status |
| `TENANT#{id}` | `QUOTA#{resource}` | limit, current, reset_at | Check quota |

**GSI1** (for listing/filtering):
- GSI1PK: `STATUS#{status}` (e.g., `STATUS#ACTIVE`)
- GSI1SK: `TIER#{tier}#TENANT#{id}`

**GSI2** (for tier-based queries):
- GSI2PK: `TIER#{tier}`
- GSI2SK: `TENANT#{id}`

### Rate Limits Table: `clawcore-rate-limits`

| PK | SK | Attributes |
|----|-----|------------|
| `TENANT#{id}` | `RATELIMIT#requests_per_min` | tokens, max_tokens, refill_rate, last_refill |
| `TENANT#{id}` | `RATELIMIT#tokens_per_hour` | tokens, max_tokens, refill_rate, last_refill |
| `TENANT#{id}` | `RATELIMIT#sessions_concurrent` | current_count, max_count |
| `TENANT#{id}` | `RATELIMIT#tool_calls_per_hour` | tokens, max_tokens, refill_rate, last_refill |
| `TENANT#{id}` | `BUDGET#monthly` | limit_usd, current_usd, reset_date |

### Sessions Table: `clawcore-sessions`

| PK | SK | Attributes |
|----|-----|------------|
| `TENANT#{id}` | `SESSION#{session_id}` | user_id, status, created_at, last_active, model_id, tokens_used |

**GSI**: `USER#{user_id}` / `SESSION#{session_id}` (for user-scoped session lookups)

### Cost Attribution Table: `clawcore-cost-tracking`

| PK | SK | Attributes |
|----|-----|------------|
| `TENANT#{id}` | `COST#{timestamp}` | user_id, model_id, input_tokens, output_tokens, tools_used, latency_ms, estimated_cost_usd |

**GSI**: `TENANT#{id}` / `MONTH#{yyyy-mm}` (for monthly aggregation)

### Skill Metadata Table: `clawcore-skills`

| PK | SK | Attributes |
|----|-----|------------|
| `TENANT#{id}` | `SKILL#{name}` | version, author, tags, mcp_endpoint, trust_level, s3_path |
| `GLOBAL` | `SKILL#{name}` | version, author, tags, mcp_endpoint, trust_level | (platform-provided) |
| `MARKETPLACE` | `SKILL#{name}` | version, author, tags, download_count, verified |

### Audit Log Table: `clawcore-audit`

| PK | SK | Attributes |
|----|-----|------------|
| `TENANT#{id}` | `AUDIT#{timestamp}#{event_id}` | event_type, user_id, action, resource, status, ip_address, details |

**TTL**: Set `ttl` attribute for automatic expiration (90 days for hot, archive to S3 before expiry).

---

## 12. IAM Policy Examples

### Pool Model: Tenant-Scoped DynamoDB Access

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "TenantScopedDynamoDBAccess",
            "Effect": "Allow",
            "Action": [
                "dynamodb:GetItem",
                "dynamodb:Query",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:DeleteItem",
                "dynamodb:BatchGetItem",
                "dynamodb:BatchWriteItem"
            ],
            "Resource": [
                "arn:aws:dynamodb:*:*:table/clawcore-tenants",
                "arn:aws:dynamodb:*:*:table/clawcore-sessions",
                "arn:aws:dynamodb:*:*:table/clawcore-skills",
                "arn:aws:dynamodb:*:*:table/clawcore-tenants/index/*",
                "arn:aws:dynamodb:*:*:table/clawcore-sessions/index/*"
            ],
            "Condition": {
                "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": ["TENANT#${aws:PrincipalTag/TenantId}"]
                }
            }
        }
    ]
}
```

### Pool Model: Tenant-Scoped S3 Access

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "TenantScopedS3Access",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::clawcore-tenants/tenants/${aws:PrincipalTag/TenantId}/*",
                "arn:aws:s3:::clawcore-skills/tenants/${aws:PrincipalTag/TenantId}/*"
            ]
        },
        {
            "Sid": "TenantReadGlobalSkills",
            "Effect": "Allow",
            "Action": ["s3:GetObject"],
            "Resource": [
                "arn:aws:s3:::clawcore-skills/global/*",
                "arn:aws:s3:::clawcore-skills/marketplace/*"
            ]
        },
        {
            "Sid": "DenyOtherTenantPrefixes",
            "Effect": "Deny",
            "Action": "s3:*",
            "Resource": "arn:aws:s3:::clawcore-tenants/tenants/*",
            "Condition": {
                "StringNotLike": {
                    "s3:prefix": ["tenants/${aws:PrincipalTag/TenantId}/*"]
                }
            }
        }
    ]
}
```

### STS AssumeRole for Tenant-Scoped Credentials

```python
def get_tenant_scoped_credentials(tenant_id: str, user_id: str) -> dict:
    """Generate short-lived, tenant-scoped credentials via STS."""
    sts = boto3.client('sts')

    response = sts.assume_role(
        RoleArn='arn:aws:iam::123456789012:role/ClawCoreTenantRole',
        RoleSessionName=f'tenant-{tenant_id}-{user_id}',
        DurationSeconds=3600,
        Tags=[
            {'Key': 'TenantId', 'Value': tenant_id},
            {'Key': 'UserId', 'Value': user_id},
        ],
        TransitiveTagKeys=['TenantId']  # Propagates to chained calls
    )

    return response['Credentials']
```

### Cedar Policy: Tier-Based Tool Access

```cedar
// Basic tier: read-only tools only
permit(
    principal in TenantGroup::"basic",
    action == Action::"invoke_tool",
    resource in ToolGroup::"read-only-tools"
);

// Advanced tier: read-only + write tools
permit(
    principal in TenantGroup::"advanced",
    action == Action::"invoke_tool",
    resource in ToolGroup::"read-write-tools"
);

// Premium tier: all tools including admin
permit(
    principal in TenantGroup::"premium",
    action == Action::"invoke_tool",
    resource
);

// Deny shell access for basic tier (explicit deny)
forbid(
    principal in TenantGroup::"basic",
    action == Action::"invoke_tool",
    resource == Tool::"shell"
);

// Deny cross-tenant file access
forbid(
    principal,
    action == Action::"file_access",
    resource
) unless {
    resource.path.startsWith(
        "/workspace/" + principal.tenantId + "/"
    )
};

// Budget enforcement: deny if monthly budget exceeded
forbid(
    principal,
    action == Action::"invoke_model",
    resource
) when {
    principal.currentMonthSpend >= principal.monthlyBudget
};
```

---

## 13. Tenant Lifecycle State Machine

### States

```
                    +---> SUSPENDED ----+
                    |    (payment/ToS)  |
                    |                   v
PROVISIONING --> ACTIVE <---------  REACTIVATING
     |              |
     |              +---> UPGRADING/DOWNGRADING --> ACTIVE
     |              |
     v              +---> OFFBOARDING --> DELETING --> DELETED
  FAILED                   (30-day grace)
```

### State Definitions

| State | Description | Allowed Transitions | API Access |
|-------|-------------|--------------------|-----------|
| `PROVISIONING` | Resources being created | -> `ACTIVE`, -> `FAILED` | None |
| `ACTIVE` | Normal operation | -> `SUSPENDED`, -> `UPGRADING`, -> `DOWNGRADING`, -> `OFFBOARDING` | Full |
| `SUSPENDED` | Temporarily disabled | -> `REACTIVATING`, -> `OFFBOARDING` | Read-only |
| `REACTIVATING` | Resuming from suspension | -> `ACTIVE`, -> `FAILED` | Read-only |
| `UPGRADING` | Tier upgrade in progress | -> `ACTIVE` | Full (old tier limits) |
| `DOWNGRADING` | Tier downgrade in progress | -> `ACTIVE` | Full (old tier limits) |
| `OFFBOARDING` | Grace period before deletion | -> `REACTIVATING`, -> `DELETING` | Data export only |
| `DELETING` | Data deletion in progress | -> `DELETED` | None |
| `DELETED` | Tombstone record (no PII) | Terminal | None |
| `FAILED` | Provisioning/migration failure | -> `PROVISIONING` (retry) | None |

### State Transition Enforcement

```python
VALID_TRANSITIONS = {
    'PROVISIONING':  {'ACTIVE', 'FAILED'},
    'ACTIVE':        {'SUSPENDED', 'UPGRADING', 'DOWNGRADING', 'OFFBOARDING'},
    'SUSPENDED':     {'REACTIVATING', 'OFFBOARDING'},
    'REACTIVATING':  {'ACTIVE', 'FAILED'},
    'UPGRADING':     {'ACTIVE'},
    'DOWNGRADING':   {'ACTIVE'},
    'OFFBOARDING':   {'REACTIVATING', 'DELETING'},
    'DELETING':      {'DELETED'},
    'DELETED':       set(),  # Terminal
    'FAILED':        {'PROVISIONING'},
}

def transition_tenant_state(tenant_id: str, new_state: str) -> bool:
    """Atomically transition tenant to new state with validation."""
    tenant = get_tenant(tenant_id)
    current_state = tenant['status']

    if new_state not in VALID_TRANSITIONS.get(current_state, set()):
        raise InvalidStateTransition(
            f"Cannot transition from {current_state} to {new_state}"
        )

    # Atomic update with condition expression
    table.update_item(
        Key={'PK': f'TENANT#{tenant_id}', 'SK': 'PROFILE'},
        UpdateExpression='SET #s = :new, previous_status = :old, status_changed_at = :now',
        ConditionExpression='#s = :expected',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={
            ':new': new_state,
            ':old': current_state,
            ':expected': current_state,
            ':now': datetime.utcnow().isoformat(),
        }
    )
    return True
```

---

## 14. Gaps and Recommendations

### Critical Gaps (Must Fix Before Production)

| # | Gap | Risk | Recommendation |
|---|-----|------|---------------|
| 1 | **No tenant offboarding/data deletion** | GDPR non-compliance, data retention liability | Implement deletion pipeline from [[#4. Tenant Offboarding and Data Deletion]] |
| 2 | **No rate limiting design** | Noisy neighbor can starve other tenants | Implement token bucket per [[#2. Noisy Neighbor Protection]] |
| 3 | **No tenant lifecycle state machine** | Inconsistent tenant states, orphaned resources | Implement state machine from [[#13. Tenant Lifecycle State Machine]] |
| 4 | **No migration path between tiers** | Tenants locked into initial tier choice | Implement migration from [[#10. Tenant Migration Between Tiers]] |
| 5 | **No budget enforcement** | Runaway costs from compromised or misconfigured agents | Implement budget limits in Cedar policies and rate limit table |

### Important Gaps (Fix Before Scale)

| # | Gap | Risk | Recommendation |
|---|-----|------|---------------|
| 6 | **No audit logging schema** | SOC2 audit failure | Implement audit table from [[#11. DynamoDB Table Design for Tenant Management]] |
| 7 | **Tenant config propagation undefined** | Stale configs in active sessions | Implement lazy + eager propagation from [[#7. Tenant Configuration Management]] |
| 8 | **No per-tenant health monitoring** | SLA violations undetected | Implement CloudWatch alarms from [[#9. Tenant Health Monitoring and SLA Tracking]] |
| 9 | **Cross-tenant sharing rules unclear** | Accidental data leakage via shared skills | Define explicit sharing boundaries from [[#6. Cross-Tenant Resource Sharing]] |
| 10 | **No account-level isolation tier** | Cannot serve highest-compliance tenants | Add AWS Organizations multi-account tier above Silo |

### Nice-to-Have (Future Iterations)

| # | Enhancement | Benefit |
|---|------------|---------|
| 11 | Tenant self-service portal with real-time usage dashboard | Reduces platform operator burden |
| 12 | Automated tier recommendation based on usage patterns | Upsell opportunity, better tenant fit |
| 13 | Cross-region tenant deployment for disaster recovery | Higher availability for premium tenants |
| 14 | Tenant-specific model fine-tuning pipeline | Differentiated offering for enterprise |
| 15 | A/B testing framework for per-tenant agent behavior | Data-driven agent improvement |

---

## Summary

The ClawCore architecture has strong bones: AgentCore MicroVM isolation, consumption-based billing, Cedar policy enforcement, and the hybrid silo/pool model are all architecturally sound. The primary work needed is at the **application layer** -- tenant lifecycle management, rate limiting, offboarding, compliance logging, and migration tooling. These are standard SaaS engineering problems with well-understood solutions, and the DynamoDB schemas and IAM policies in this review provide a concrete starting point.

The most urgent action items are:
1. Implement the tenant lifecycle state machine (prevents orphaned resources)
2. Build the rate limiting layer (prevents noisy neighbor incidents)
3. Design the data deletion pipeline (GDPR compliance)
4. Deploy per-tenant CloudWatch alarms (SLA visibility)

With these additions, ClawCore would be production-ready for multi-tenant deployment.
