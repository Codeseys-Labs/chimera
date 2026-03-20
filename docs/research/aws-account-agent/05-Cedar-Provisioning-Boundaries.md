# Cedar Provisioning Boundaries

> Cedar policies that define what agents can and cannot provision in AWS accounts

## Overview

AWS Chimera uses [Cedar](https://www.cedarpolicy.com/) — Amazon's open-source authorization language — to enforce fine-grained boundaries on agent infrastructure provisioning. This document explores how Cedar policies balance agent autonomy with safety guardrails.

## Cedar Authorization Model

### Core Entities

```cedar
// Entity hierarchy for agent provisioning

namespace Chimera {
  entity Tenant {
    id: String,
    tier: String,          // "basic", "advanced", "enterprise"
    costQuota: Decimal,    // Monthly AWS spend limit
    region: String,
  };

  entity Agent {
    id: String,
    tenantId: Tenant,
    capabilities: Set<String>,
  };

  entity InfrastructureChange {
    changeType: String,    // "scale_horizontal", "add_tool", etc.
    estimatedCostDelta: Decimal,
    targetResourceType: String,
    region: String,
  };
}
```

### Authorization Request Format

When an agent proposes infrastructure changes, it submits:

```json
{
  "principal": "Agent::\"tenant-abc123-agent-01\"",
  "action": "Chimera::Action::\"provision_infrastructure\"",
  "resource": "InfrastructureChange::\"scale_horizontal-1710956789\"",
  "context": {
    "changeType": "scale_horizontal",
    "estimatedMonthlyCostDelta": 50.0,
    "targetResourceType": "AWS::ECS::Service",
    "currentMonthlyCost": 450.0,
    "tenantCostQuota": 2000.0,
    "humanApproved": false,
    "tier": "advanced"
  }
}
```

Cedar evaluates policies and returns:
- **ALLOW** → Auto-deploy
- **DENY** → Require human approval

---

## Policy Categories

### 1. Cost-Based Policies

**Objective:** Prevent runaway infrastructure spending.

**Policy 1.1: Auto-Approve Small Changes**

```cedar
// Changes under $100/month are auto-approved for all tiers
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.estimatedMonthlyCostDelta < 100.0
};
```

**Policy 1.2: Tier-Based Cost Limits**

```cedar
// Basic tier: max $500/month total spend
// Advanced tier: max $2,000/month total spend
// Enterprise tier: max $10,000/month total spend

permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  (principal.tenantId.tier == "basic" &&
   context.currentMonthlyCost + context.estimatedMonthlyCostDelta < 500.0)
  ||
  (principal.tenantId.tier == "advanced" &&
   context.currentMonthlyCost + context.estimatedMonthlyCostDelta < 2000.0)
  ||
  (principal.tenantId.tier == "enterprise" &&
   context.currentMonthlyCost + context.estimatedMonthlyCostDelta < 10000.0)
};
```

**Policy 1.3: Cost Reduction Always Allowed**

```cedar
// Cost-saving changes (negative delta) are always auto-approved
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.estimatedMonthlyCostDelta <= 0.0
};
```

**Example Scenarios:**

| Scenario | Cost Delta | Tier | Current Spend | Decision |
|----------|------------|------|---------------|----------|
| Add ECS task | +$50 | Basic | $200 | ALLOW |
| Scale RDS | +$150 | Basic | $480 | DENY (would exceed $500) |
| Add Lambda | +$80 | Advanced | $1,800 | ALLOW |
| ML training | +$1,500 | Advanced | $1,900 | DENY (would exceed $2,000) |
| Delete EBS volumes | -$200 | Any | Any | ALLOW (cost reduction) |

---

### 2. Change Type Policies

**Objective:** Different change types have different risk profiles.

**Policy 2.1: Safe Operations (Auto-Approve)**

```cedar
// Low-risk operations that are easily reversible
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.changeType in [
    "update_env_var",       // Environment variable change
    "rotate_secret",        // Secret rotation (security positive)
    "update_config",        // SSM Parameter Store update
    "scale_horizontal"      // Add/remove instances (within limits)
  ]
};
```

**Policy 2.2: Vertical Scaling (Conditional)**

```cedar
// Vertical scaling allowed if not crossing instance family boundaries
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.changeType == "scale_vertical" &&
  context.targetResourceType == "AWS::ECS::TaskDefinition" &&
  context.estimatedMonthlyCostDelta < 200.0
};
```

**Policy 2.3: New Resource Provisioning (Restricted)**

```cedar
// Adding new resources (tools, databases, queues) requires approval
forbid(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.changeType in [
    "add_tool",
    "create_database",
    "create_queue",
    "create_bucket"
  ] &&
  !context.humanApproved
};
```

**Risk Matrix:**

| Change Type | Risk Level | Auto-Approve? | Reason |
|-------------|------------|---------------|--------|
| `update_env_var` | Low | Yes | Reversible, no cost |
| `rotate_secret` | Low | Yes | Security positive |
| `scale_horizontal` | Low-Medium | Yes (with limits) | Easily scalable back down |
| `scale_vertical` | Medium | Conditional | May require restart |
| `add_tool` | Medium-High | No | New external dependencies |
| `create_database` | High | No | Persistent state, high cost |
| `modify_iam_role` | High | No | Security impact |
| `modify_vpc` | Very High | No | Network isolation risk |

---

### 3. Resource Type Policies

**Objective:** Restrict which AWS resources agents can create/modify.

**Policy 3.1: Allowed Resource Types**

```cedar
// Whitelist of resources agents can provision
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.targetResourceType in [
    "AWS::Lambda::Function",
    "AWS::ECS::TaskDefinition",
    "AWS::ECS::Service",
    "AWS::S3::Bucket",
    "AWS::DynamoDB::Table",
    "AWS::SQS::Queue",
    "AWS::SNS::Topic",
    "AWS::SecretsManager::Secret",
    "AWS::SSM::Parameter"
  ]
};
```

**Policy 3.2: Forbidden Resource Types**

```cedar
// Resources that agents can NEVER provision
forbid(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.targetResourceType in [
    "AWS::IAM::Role",              // Security risk
    "AWS::IAM::Policy",            // Privilege escalation
    "AWS::EC2::VPC",               // Network isolation
    "AWS::EC2::SecurityGroup",     // Firewall rules
    "AWS::EC2::InternetGateway",   // Public internet access
    "AWS::KMS::Key",               // Encryption keys
    "AWS::RDS::DBInstance",        // Persistent databases (without approval)
    "AWS::ElastiCache::Cluster"    // Caching layer (without approval)
  ]
};
```

**Rationale:**

- **IAM roles/policies**: Agents could escalate privileges
- **VPC/Security Groups**: Network isolation is human-managed
- **KMS keys**: Encryption key management is high-risk
- **RDS/ElastiCache**: Persistent state requires careful planning

---

### 4. Rate Limiting Policies

**Objective:** Prevent agent abuse or runaway automation.

**Policy 4.1: Deployment Frequency**

```cedar
// Max 5 infrastructure changes per tenant per hour
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.deploymentsLastHour < 5
};
```

**Policy 4.2: Daily Change Limit**

```cedar
// Max 20 infrastructure changes per tenant per day
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.deploymentsLast24Hours < 20
};
```

**Policy 4.3: LLM-Generated Code Limit**

```cedar
// Max 3 LLM-generated CDK changes per day (higher risk)
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.isTemplateBasedGeneration ||
  context.llmGeneratedChangesToday < 3
};
```

**Rate Limit Tracking:**

Stored in DynamoDB `chimera-rate-limits` table:

```json
{
  "PK": "TENANT#abc123",
  "SK": "RATE_LIMIT#infra_changes",
  "hourlyCount": 2,
  "dailyCount": 8,
  "llmGeneratedToday": 1,
  "resetHourly": "2024-12-01T15:00:00Z",
  "resetDaily": "2024-12-02T00:00:00Z",
  "ttl": 1733097600
}
```

---

### 5. Emergency Self-Healing Policies

**Objective:** Allow agents to respond to critical incidents without approval delays.

**Policy 5.1: Critical Alert Response**

```cedar
// Auto-approve infrastructure changes triggered by critical CloudWatch alarms
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.triggeredByCriticalAlarm &&
  context.changeType in [
    "scale_horizontal",
    "scale_vertical",
    "restart_runtime",
    "clear_cache"
  ]
};
```

**Policy 5.2: Self-Healing Actions**

```cedar
// Emergency operations to restore service health
permit(
  principal is Agent,
  action == Chimera::Action::"execute_self_heal",
  resource is Runtime
)
when {
  context.healthStatus in ["UNHEALTHY", "DEGRADED"] &&
  context.selfHealAction in [
    "restart_runtime",
    "clear_cache",
    "reset_session"
  ]
};
```

**Policy 5.3: Rollback Always Allowed**

```cedar
// Agents can always rollback their own failed deployments
permit(
  principal is Agent,
  action == Chimera::Action::"rollback_deployment",
  resource is InfrastructureChange
)
when {
  context.isRollback
};
```

**Emergency Scenarios:**

| Alert Type | Agent Action | Cedar Policy | Human Approval? |
|------------|--------------|--------------|-----------------|
| High error rate (>5%) | Scale horizontally | ALLOW | No |
| High latency (p99 > 2x) | Scale vertically | ALLOW | No |
| Lambda memory error | Increase memory | ALLOW | No |
| DynamoDB throttling | Increase RCU/WCU | ALLOW (if < $100 delta) | Conditional |
| Database connection pool exhausted | Increase connection limit | ALLOW | No |
| Deployment failure | Rollback | ALLOW | No |

---

### 6. Regional Policies

**Objective:** Enforce compliance with data residency requirements.

**Policy 6.1: Allowed Regions**

```cedar
// Tenants specify allowed AWS regions in their config
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.region in principal.tenantId.allowedRegions
};
```

**Policy 6.2: Data Residency Compliance**

```cedar
// EU tenants can only deploy in EU regions (GDPR)
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  principal.tenantId.dataResidency == "EU" &&
  context.region in ["eu-west-1", "eu-west-2", "eu-central-1"]
};
```

**Policy 6.3: Multi-Region Replication**

```cedar
// Multi-region replication requires enterprise tier
permit(
  principal is Agent,
  action == Chimera::Action::"replicate_cross_region",
  resource is InfrastructureChange
)
when {
  principal.tenantId.tier == "enterprise" &&
  context.sourceRegion != context.targetRegion
};
```

**Example Configurations:**

| Tenant | Tier | Data Residency | Allowed Regions |
|--------|------|----------------|-----------------|
| tenant-us-startup | Basic | US | us-east-1, us-west-2 |
| tenant-eu-corp | Advanced | EU | eu-west-1, eu-central-1 |
| tenant-global-enterprise | Enterprise | None | All (except cn-*, gov-*) |
| tenant-healthcare | Advanced | US (HIPAA) | us-east-1, us-west-2 (only) |

---

### 7. Capability-Based Policies

**Objective:** Agents have different authorization levels based on assigned capabilities.

**Policy 7.1: Data Pipeline Agents**

```cedar
// Agents with "data-pipeline" capability can provision Glue/Athena resources
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  "data-pipeline" in principal.capabilities &&
  context.targetResourceType in [
    "AWS::Glue::Crawler",
    "AWS::Glue::Database",
    "AWS::Athena::WorkGroup",
    "AWS::S3::Bucket"  // For data lake storage
  ]
};
```

**Policy 7.2: ML Training Agents**

```cedar
// Agents with "ml-training" capability can provision SageMaker
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  "ml-training" in principal.capabilities &&
  context.targetResourceType in [
    "AWS::SageMaker::NotebookInstance",
    "AWS::SageMaker::TrainingJob",
    "AWS::SageMaker::Model",
    "AWS::SageMaker::EndpointConfig"
  ] &&
  context.estimatedMonthlyCostDelta < 2000.0  // ML-specific limit
};
```

**Policy 7.3: Cost Optimization Agents**

```cedar
// Agents with "cost-optimization" capability can delete unused resources
permit(
  principal is Agent,
  action == Chimera::Action::"delete_resource",
  resource is AWSResource
)
when {
  "cost-optimization" in principal.capabilities &&
  context.resourceIsUnused &&
  context.estimatedMonthlySavings > 10.0
};
```

**Capability Matrix:**

| Capability | Allowed Resources | Max Cost Delta | Special Permissions |
|------------|-------------------|----------------|---------------------|
| `data-pipeline` | Glue, Athena, S3 | $500/month | Create crawlers |
| `ml-training` | SageMaker, S3 | $2,000/month | GPU instances |
| `cost-optimization` | All (read/delete) | N/A (savings) | Delete unused resources |
| `search-infrastructure` | OpenSearch, ELB | $300/month | Modify cluster config |
| `container-orchestration` | ECS, ECR, Lambda | $500/month | Task definition updates |

---

## Policy Composition Examples

### Example 1: Safe, Low-Cost Change

**Scenario:** Agent wants to update environment variable for ECS task.

**Cedar Evaluation:**

```
Request: {
  principal: Agent::"tenant-abc123-agent-01",
  action: "provision_infrastructure",
  resource: InfrastructureChange::"update_env_var-1710956789",
  context: {
    changeType: "update_env_var",
    estimatedMonthlyCostDelta: 0.0,
    targetResourceType: "AWS::ECS::TaskDefinition",
    currentMonthlyCost: 450.0,
    tenantCostQuota: 2000.0
  }
}

Policies evaluated:
✓ Cost-Based Policy 1.1 (delta < $100) → ALLOW
✓ Change Type Policy 2.1 (safe operation) → ALLOW
✓ Resource Type Policy 3.1 (allowed type) → ALLOW
✓ Rate Limit Policy 4.1 (2 deployments this hour) → ALLOW

Final decision: ALLOW (auto-deploy)
```

### Example 2: High-Cost Change Requiring Approval

**Scenario:** Agent wants to add ML training infrastructure ($1,500/month).

**Cedar Evaluation:**

```
Request: {
  principal: Agent::"tenant-startup-555-agent-01",
  action: "provision_infrastructure",
  resource: InfrastructureChange::"ml_training-1710956790",
  context: {
    changeType: "add_tool",
    estimatedMonthlyCostDelta: 1500.0,
    targetResourceType: "AWS::SageMaker::TrainingJob",
    currentMonthlyCost: 600.0,
    tenantCostQuota: 2000.0,
    tier: "advanced"
  }
}

Policies evaluated:
✗ Cost-Based Policy 1.1 (delta = $1,500 > $100) → No match
✗ Cost-Based Policy 1.2 (600 + 1500 = 2100 > 2000) → DENY
✗ Change Type Policy 2.3 (add_tool without humanApproved) → DENY

Final decision: DENY (create PR for human review)
```

### Example 3: Emergency Self-Healing

**Scenario:** CloudWatch alarm triggers agent to scale ECS service.

**Cedar Evaluation:**

```
Request: {
  principal: Agent::"tenant-iot-999-agent-01",
  action: "provision_infrastructure",
  resource: InfrastructureChange::"scale_horizontal-1710956791",
  context: {
    changeType: "scale_horizontal",
    estimatedMonthlyCostDelta: 50.0,
    targetResourceType: "AWS::ECS::Service",
    triggeredByCriticalAlarm: true,
    healthStatus: "DEGRADED"
  }
}

Policies evaluated:
✓ Emergency Policy 5.1 (critical alarm + safe change type) → ALLOW
✓ Cost-Based Policy 1.1 (delta < $100) → ALLOW
✓ Change Type Policy 2.1 (safe operation) → ALLOW

Final decision: ALLOW (emergency auto-deploy, no rate limit)
```

---

## Policy Deployment & Versioning

### Policy Store Structure

Cedar policies stored in AWS Verified Permissions:

```
chimera-agent-provisioning-policies/
├── policy-set-v1/
│   ├── cost-based.cedar
│   ├── change-type.cedar
│   ├── resource-type.cedar
│   ├── rate-limiting.cedar
│   ├── emergency.cedar
│   ├── regional.cedar
│   └── capability.cedar
├── policy-set-v2/  (staged for testing)
└── policy-set-v3/  (development)
```

### Policy Testing

Before deploying new Cedar policies, validate against test cases:

```bash
# Run Cedar policy tests
cedar validate \
  --schema schemas/chimera.cedarschema \
  --policies policies/*.cedar

# Test specific scenario
cedar authorize \
  --schema schemas/chimera.cedarschema \
  --policies policies/*.cedar \
  --request tests/scenarios/high-cost-change.json
```

**Test Cases:**

| Test Case | Expected Decision | Rationale |
|-----------|-------------------|-----------|
| `update_env_var_basic_tier.json` | ALLOW | Safe, low-cost |
| `add_tool_no_approval.json` | DENY | Requires human review |
| `scale_exceed_quota.json` | DENY | Would exceed cost quota |
| `cost_reduction.json` | ALLOW | Always allow savings |
| `critical_alarm_scale.json` | ALLOW | Emergency self-heal |
| `create_iam_role.json` | DENY | Forbidden resource type |
| `llm_generated_4th_today.json` | DENY | Rate limit exceeded |

### Policy Rollback

If new policies cause unexpected DENYs:

```typescript
// Rollback to previous policy set
await verifiedPermissions.updatePolicyStore({
  policyStoreId: 'chimera-agent-provisioning',
  activePolicySetId: 'policy-set-v1', // Previous version
});
```

Agents automatically retry denied requests after policy rollback.

---

## Monitoring & Auditing

### Cedar Decision Logs

All authorization decisions logged to CloudWatch Logs:

```json
{
  "timestamp": "2024-12-01T14:32:15Z",
  "tenantId": "tenant-abc123",
  "agentId": "tenant-abc123-agent-01",
  "requestId": "req-1710956789",
  "action": "provision_infrastructure",
  "changeType": "scale_horizontal",
  "decision": "ALLOW",
  "policiesEvaluated": [
    "cost-based-1.1",
    "change-type-2.1",
    "resource-type-3.1",
    "rate-limit-4.1"
  ],
  "estimatedCostDelta": 50.0,
  "deploymentStatus": "IN_PROGRESS"
}
```

### CloudWatch Metrics

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `cedar_deny_rate` | % of requests denied | >10% (policies too restrictive) |
| `cedar_emergency_overrides` | Count of emergency self-heal approvals | N/A (expected) |
| `cedar_cost_limit_denials` | Requests denied due to cost limits | >5 per tenant per day |
| `cedar_rate_limit_denials` | Requests denied due to rate limits | >3 per tenant per day |

### Audit Reports

Generate monthly audit reports:

```sql
-- Athena query on Cedar decision logs
SELECT
  tenantId,
  decision,
  COUNT(*) as request_count,
  AVG(estimatedCostDelta) as avg_cost_delta
FROM cedar_authorization_logs
WHERE month = '2024-12'
GROUP BY tenantId, decision;
```

**Sample Output:**

| Tenant | ALLOW Count | DENY Count | Avg Cost Delta |
|--------|-------------|------------|----------------|
| tenant-abc123 | 142 | 8 | $47.20 |
| tenant-startup-555 | 89 | 23 | $312.50 |
| tenant-iot-999 | 201 | 12 | $28.90 |

---

## Security Considerations

### 1. Policy Tampering Prevention

Cedar policies stored in Verified Permissions with:
- **Immutable versions**: Each policy set has unique version ID
- **IAM protection**: Only infra admins can modify policies
- **CloudTrail logging**: All policy changes audited

### 2. Privilege Escalation Prevention

**Attack Vector:** Agent creates overly permissive IAM role, then assumes it.

**Mitigation:**
```cedar
forbid(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.targetResourceType in ["AWS::IAM::Role", "AWS::IAM::Policy"]
};
```

Additionally, AWS IAM Permissions Boundaries enforced on all agent-created roles.

### 3. Cross-Tenant Isolation

**Attack Vector:** Agent modifies another tenant's resources.

**Mitigation:**
```cedar
forbid(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  principal.tenantId != context.targetTenantId
};
```

All resources tagged with `TenantId`, enforced by Service Control Policies (SCPs).

### 4. Cost Bomb Prevention

**Attack Vector:** Agent deploys expensive resources repeatedly.

**Mitigation:**
- Cedar rate limits (max 5 deployments per hour)
- Cost quotas per tier (Basic: $500, Advanced: $2,000, Enterprise: $10,000)
- DynamoDB cost tracking table with alerting
- Automatic suspension if quota exceeded

---

## Policy Evolution Strategies

### Adding New Change Types

When introducing new agent capabilities:

1. **Start restrictive:**
   ```cedar
   forbid(
     principal is Agent,
     action == Chimera::Action::"provision_infrastructure",
     resource is InfrastructureChange
   )
   when {
     context.changeType == "new_capability" &&
     !context.humanApproved
   };
   ```

2. **Observe behavior:** Monitor approval requests, cost accuracy, failure rate

3. **Gradually relax:**
   ```cedar
   permit(
     principal is Agent,
     action == Chimera::Action::"provision_infrastructure",
     resource is InfrastructureChange
   )
   when {
     context.changeType == "new_capability" &&
     context.estimatedMonthlyCostDelta < 50.0  // Start with low limit
   };
   ```

4. **Increase limits:** After confidence builds, raise cost limits or remove approval gates

### A/B Testing Policies

Test new policies on subset of tenants:

```cedar
// Policy A (current): Strict cost limit
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  principal.tenantId.policyGroup == "control" &&
  context.estimatedMonthlyCostDelta < 100.0
};

// Policy B (experiment): Higher limit
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  principal.tenantId.policyGroup == "experiment" &&
  context.estimatedMonthlyCostDelta < 200.0
};
```

Measure:
- Agent autonomy (% auto-approved)
- Cost accuracy
- Tenant satisfaction

### Policy Recommendations from Agent Feedback

Agents track denied requests and propose policy changes:

```
[Agent] Detected pattern: 12 DENY decisions in last 7 days for changeType="scale_horizontal", cost delta $120-$180.
[Agent] Current policy: Auto-approve under $100.
[Agent] Recommendation: Increase limit to $200 for "scale_horizontal" (historically accurate cost estimates).
[Agent] Submitting policy change proposal to human reviewers...
```

---

## References

- **Cedar Language Spec**: https://www.cedarpolicy.com/
- **AWS Verified Permissions**: https://docs.aws.amazon.com/verifiedpermissions/
- **IAM Permissions Boundaries**: https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html
- **Service Control Policies**: https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html
- **Safety Harness Implementation**: `packages/core/src/evolution/safety-harness.ts`
- **IAC Modifier**: `packages/core/src/evolution/iac-modifier.ts`

---

**Summary:** Cedar policies enable AWS Chimera agents to operate autonomously within well-defined safety boundaries. Policies balance agent autonomy (fast infrastructure provisioning) with safety guardrails (cost limits, forbidden resources, rate limits). Over time, policies evolve based on agent behavior and tenant feedback, continuously optimizing the autonomy-safety tradeoff.
