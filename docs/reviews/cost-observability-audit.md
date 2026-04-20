# Cost & Observability Audit

**Audit date:** 2026-04-17
**Scope:** `infra/lib/observability-stack.ts`, `packages/core/src/**`, `packages/agents/**`
**Bottom line:** address CRITICAL + HIGH metrics within 2 weeks before scaling past ~100k tenant-sessions/day.

## Existing metrics catalog

| Namespace | Metric | Dimensions | Emitter |
|-----------|--------|------------|---------|
| `Chimera/Billing` | `TotalMonthlySpend` | — | `observability-stack.ts:520-534` |
| `Chimera/Billing` | `ActiveTenants` | — | `observability-stack.ts:528` |
| `Chimera/Billing` | `TenantCostAnomaly` | `TenantId` | `observability-stack.ts:536-543` (threshold ≥1.2) |
| `Chimera/Tenant` | `ActiveSessions`, `RequestCount`, `ErrorCount`, `RequestLatency` | `TenantId` | **defined for dashboard; no emitter found** |
| `Chimera/Skills` | `InvocationCount`, `SuccessCount`, `FailureCount`, `ExecutionLatency` | `SkillName` | **defined for dashboard; no emitter found** |
| `AWS/ApiGateway`, `AWS/ECS`, `AWS/Lambda`, `AWS/DynamoDB`, `AWS/Backup`, `AWS/Config` | standard | various | AWS-managed |

**Critical gap:** dashboards reference 8 custom metrics that nothing in the codebase currently emits. Cost Publisher Lambda emits only the aggregate billing metrics.

## Existing alarms catalog

| Alarm | Metric | Threshold | SNS target |
|-------|--------|-----------|------------|
| `chimera-{env}-{table}-throttles` ×6 | DDB `ThrottledRequests` | ≥10 in 5min | critical |
| `chimera-{env}-api-error-rate` | (5xx / total) × 100 | >5% | critical |
| `chimera-{env}-cost-anomaly` | `TenantCostAnomaly` | ≥1.2 | high |
| `chimera-{env}-dynamodb-pitr-disabled` | Config non-compliance | ≥1 | high |
| `chimera-{env}-backup-failure` | Backup failed jobs | ≥1 | high |
| `chimera-{env}-backup-protection-compromised` | composite (PITR ∨ Backup) | — | critical |
| `chimera-{env}-cross-region-health` (if enabled) | regional 5xx sum | >10 for 2p | critical |

SNS routing: critical → PagerDuty + email; high → Slack + email; medium → email.

## Recommended NEW metrics

### CRITICAL

**`chimera:tool:invocation_duration_ms`**
- Namespace: `Chimera/Agent`
- Dimensions: `[tenant_id, tier, tool_name, status]`
- Unit: milliseconds (histogram: p50, p99, max)
- Alarm: p99 > 30s for 3 consecutive 5-min periods → HIGH
- Emitted from: `packages/agents/gateway_proxy.py:126-140`
- Why: catch tool degradation; identify tenant abuse; Lambda timeout tuning

**`chimera:model:tier_violation_count`**
- Namespace: `Chimera/Agent`
- Dimensions: `[tenant_id, tier, model_requested]`
- Unit: count
- Alarm: > 0 in 5 min → CRITICAL (cost + security escape)
- Emitted from: `packages/core/src/evolution/model-router.ts` when a Basic tier falls through to Opus
- Why: ~$360/mo delta per 100 Basic tenants is silent today

**`chimera:agent:loop_iterations`**
- Namespace: `Chimera/Agent`
- Dimensions: `[tenant_id, session_id]`
- Unit: count
- Alarm: ≥18 (max = 20) for any session → CRITICAL + trigger session kill
- Emitted from: `packages/agents/chimera_agent.py` post-iteration hook
- Why: bound runaway loops; detect per-tenant abuse

### HIGH

**`chimera:tenant:hourly_cost_usd`**
- Namespace: `Chimera/Billing`
- Dimensions: `[tenant_id, tier, model_id]`
- Alarm: informational (drives dashboard; cost-anomaly still covers threshold)
- Emitted from: `packages/core/src/billing/budget-monitor.ts:69-95`

**`chimera:tool:success_rate_percent`**
- Namespace: `Chimera/Agent`
- Dimensions: `[tenant_id, tier, tool_name]`
- Alarm: < 80% for 10 min → HIGH
- Emitted from: `gateway_proxy.py` error/success paths

**`chimera:bedrock:throttle_percent`**
- Namespace: `Chimera/Agent`
- Dimensions: `[tenant_id, tier, model_id]`
- Alarm: > 5% for 5 min → HIGH
- Emitted from: `chimera_agent.py` on ThrottlingException

**`chimera:model:selection_count`**
- Namespace: `Chimera/Agent`
- Dimensions: `[model_id, tier, task_category]`
- Emitted from: `model-router.ts` post-select
- Why: validate Thompson Sampling, audit tier compliance

### MEDIUM

**`chimera:session:cost_usd`**
- Namespace: `Chimera/Billing`
- Dimensions: `[session_id, tenant_id, tier]`
- Emitted from: session completion path in `chimera_agent.py`
- Why: real-time per-session billing at < 5 min lag (currently only monthly)

## Cost-hotspot punch list

| Resource | Current est. | Action | Savings/mo | Priority |
|----------|-------------|--------|-----------|----------|
| NAT Gateway (3 × prod + dev) | $96 + $50-200 data | 1 per region + VPC endpoints for AWS APIs | $40-50 | HIGH |
| CloudWatch log retention drift | $150-200 | Standardize 30d + S3 lifecycle archive | $80-120 | HIGH |
| DAX cluster (3 × r5.large) | $2,880 | Right-size to 2 × r5.xlarge OR audit hit rate | $1,200-1,500 | MEDIUM |
| S3 without intelligent-tiering | $1.50/TB baseline | Enable on tenant-data / skills / artifacts | $0.30-0.50/TB | MEDIUM |
| DDB on-demand for low-traffic tables | $300-500 | Switch rate-limits to PROVISIONED (5-10 RCU) | $100-200 | MEDIUM |
| Model router default (Opus fallback) | $450/100 Basic tenants | Tier-ceiling gate at invoke time | **$360/mo per 100 sessions** | **CRITICAL** |
| **1-month total potential** | ~$4,500-5,000 | combined | **$2,000-2,500** | — |

Cost model basis: DAX r5.large $0.24/h × 3 × 730h = $2,880/mo; logs 10GB/day × 30d × $0.50/GB = $150/mo → S3 $23/mo; Nova Lite $0.06/MTok vs Opus $15/MTok; 100 Basic × 100k tokens/session.

## Dashboard gaps

**Defined dashboards:**
- `chimera-platform-{env}` — health, throttles, API, ECS, load
- `chimera-tenant-health-{env}` — per-tenant (metrics undefined)
- `chimera-skill-usage-{env}` — skill stats (metrics undefined)
- `chimera-cost-attribution-{env}` — reads cost-tracking table

**React frontend** (`packages/web/src/pages/dashboard.tsx`) — static monthly cost, no per-session breakdown, no error boundary (now addressed by the web-UX wave-3 agent).

**Missing panels:**
- Real-time per-tenant cost (only monthly aggregate)
- Skill trust indicator
- Agent-loop runaway CRITICAL
- Per-session cost model
- Tenant-facing billing dashboard (currently all ops-perspective)

**Recommendation:** split by audience:
- Ops: platform + tenant-health + skill-usage (once emitters land)
- Tenant: new dashboard — session list + per-session cost + billing alerts
- Admin: cost-attribution + runbook index + incident commander

## Top 5 fixes that pay back within one month

| # | Fix | Effort | Saves/mo |
|---|-----|--------|----------|
| 1 | Enforce per-tier model ceiling (model-router gate) | 1d | $360 |
| 2 | Emit per-tenant hourly cost metric | 2d | $80-120 |
| 3 | Fix log retention drift | 1d | $80-120 |
| 4 | Enable S3 Intelligent-Tiering on 3 buckets | 0.5d | $40-80 |
| 5 | Emit tool invocation metrics | 2d | $50 ops + future MTTR |

**1-month ROI:** ~$1,800-1,900/mo for ~6.5d engineering (~$280/day value).
