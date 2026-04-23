---
title: "Observability — Metrics, Dashboards, and CloudWatch Math"
version: 1.0.0
status: canonical
last_updated: 2026-04-22
supersedes:
  - docs/reviews/cost-observability-audit.md (metrics catalog — audit remains for gap analysis; this doc is the live reference)
authority: |
  Single source of truth for custom CloudWatch metric schemas (namespace,
  name, unit, dimensions), the emitters that produce them, and the
  CloudWatch Metric Math expressions used on dashboards/alarms. All
  changes to `Chimera/*` metrics MUST update this document.
---

# Observability — Metrics, Dashboards, and CloudWatch Math

> [!important] Authority
> Defines every custom metric Chimera emits. CDK dashboards in
> `infra/lib/observability-stack.ts` reference metric names defined here.
> Any mismatch between this doc and the emitters is a regression.

## Custom metric catalog

| Namespace              | Metric                          | Unit         | Dimensions                             | Emitter                                                                    | Status |
|------------------------|---------------------------------|--------------|----------------------------------------|----------------------------------------------------------------------------|--------|
| `Chimera/Agent`        | `tier_violation_count`          | Count        | tenant_id, tier, model_requested       | `packages/core/src/evolution/model-router.ts::enforceTierCeiling`          | live   |
| `Chimera/Agent`        | `loop_iterations`               | Count        | tenant_id, session_id                  | `packages/agents/chimera_agent.py` (ceiling emitter — see rabbithole-02)   | live\* |
| `Chimera/Tools`        | `tool_invocation_duration_ms`   | Milliseconds | Service, TenantId, Tier, ToolName      | `packages/agents/tools/gateway_instrumentation.py::instrument_tool`        | live   |
| `Chimera/Tools`        | `Success`                       | Count        | Service, TenantId, Tier, ToolName      | same — `1` on normal return, `0` on raise                                  | live   |
| `Chimera/Billing`      | `tenant_hourly_cost_usd`        | None (USD)   | tenant_id, tier, model_id, service     | `packages/core/src/billing/cost-tracker.ts::recordCost`                    | live   |
| `Chimera/Billing`      | `TotalMonthlySpend`             | None         | —                                      | `observability-stack.ts` hourly Lambda                                     | live   |
| `Chimera/Billing`      | `ActiveTenants`                 | Count        | —                                      | same Lambda                                                                | live   |
| `Chimera/Billing`      | `TenantCostAnomaly`             | None         | TenantId                               | same Lambda (ratio, threshold ≥ 1.2)                                       | live   |
| `Chimera/SkillPipeline`| `RegistryWriteFailure`          | Count        | —                                      | `skill-deployment` Lambda (flag-gated)                                     | live\*\* |
| `Chimera/Registry`     | `RegistryReadSuccess/Fallback/Error` | Count   | —                                      | `skills-api` Lambda (flag-gated)                                           | live\*\* |

\*loop_iterations emits the ceiling value (20) until Strands exposes the
real iteration counter; alarms are intentionally not wired yet.
See `TODO(rabbithole-02)` in `packages/agents/chimera_agent.py`.

\*\*Registry metrics are emitted only when `REGISTRY_ENABLED` /
`REGISTRY_PRIMARY_READ` feature flags are ON; INSUFFICIENT_DATA otherwise.

### EMF emission pattern

All Chimera custom metrics use the **CloudWatch Embedded Metric Format
(EMF)** written to stdout. The Lambda/ECS runtime auto-publishes EMF
from log output, so no `PutMetricData` IAM or API call is required.

- TypeScript emitter: `emitEmfMetric` in
  `packages/core/src/evolution/model-router.ts` (and
  `packages/core/src/billing/cost-tracker.ts` — duplicated intentionally
  to avoid a cross-directory coupling; both produce the identical
  envelope).
- Python emitter: `emit_emf_metric` in
  `packages/agents/observability.py`.
- Contract: both emitters **never raise** — metric emission is
  best-effort and must not break the caller.

## Metric Math expressions used on dashboards/alarms

CloudWatch Metric Math lets us compute derived metrics (rates, ratios,
success %) at query time from raw counters. This is the canonical pattern
for metrics like success-rate that don't need in-process rolling state.

### `tool:success_rate_percent` — derived from `Chimera/Tools::Success`

**Input metric:** `Success` (Count, 0 or 1) at namespace `Chimera/Tools`
with dimensions `{Service, TenantId, Tier, ToolName}`. Emitted by
`gateway_instrumentation.py::instrument_tool` as `1` on normal return, `0`
on raise (see commit `35f8073`, Wave-12).

**Derivation:** Given `Success` is a 0/1 counter, the success rate over a
given period is `SUM(Success) / SAMPLE_COUNT(Success) * 100`.

CloudWatch Metric Math expression:

```text
# Period: 5 minutes recommended (matches Success emitter's natural
# invocation cadence). For noisier/quieter tools, adjust up or down.
m1 = Chimera/Tools::Success (Statistic: Sum,         Period: 5m, Dimensions: as above)
m2 = Chimera/Tools::Success (Statistic: SampleCount, Period: 5m, Dimensions: as above)
e1 = (m1 / m2) * 100   # label: "Success rate (%)"
```

As a CDK `MathExpression`:

```typescript
// packages/infra/lib/observability-stack.ts — Tools dashboard panel
const toolSuccessSum = new cloudwatch.Metric({
  namespace: 'Chimera/Tools',
  metricName: 'Success',
  statistic: 'Sum',
  period: cdk.Duration.minutes(5),
});
const toolSuccessSampleCount = new cloudwatch.Metric({
  namespace: 'Chimera/Tools',
  metricName: 'Success',
  statistic: 'SampleCount',
  period: cdk.Duration.minutes(5),
});
const toolSuccessRatePercent = new cloudwatch.MathExpression({
  expression: '(m1 / m2) * 100',
  usingMetrics: { m1: toolSuccessSum, m2: toolSuccessSampleCount },
  period: cdk.Duration.minutes(5),
  label: 'Tool success rate (%)',
});
```

**Why Metric Math instead of a pre-aggregated `tool_success_rate_percent`
EMF metric?** Three reasons:

1. **No in-process state.** A rolling-window percent emitter would need
   shared state across Lambda/ECS containers (either a sidecar, a DDB
   counter, or an in-memory window that only works on long-lived
   processes). Metric Math is stateless by construction.
2. **Cheaper.** Pre-aggregating would add another custom-metric
   dimension combination for every `{Service, TenantId, Tier, ToolName}`
   tuple. Metric Math reuses the existing `Success` datapoints.
3. **More flexible.** Operators can change the window (5m → 1h → 24h)
   at query time without a code/deploy cycle. Threshold alarms can use
   `ANOMALY_DETECTION_BAND` or static thresholds against the same
   expression.

### Alarm: sustained low success rate

```typescript
// HIGH priority — success rate < 80% for 10 min (2 consecutive 5m periods)
const toolSuccessRateAlarm = new cloudwatch.Alarm(stack, 'ToolSuccessRateAlarm', {
  alarmName: `chimera-${env}-tool-success-rate-low`,
  alarmDescription:
    'Tool success rate fell below 80% for 10 minutes. Check ' +
    'gateway_instrumentation logs for the failing ToolName dimension ' +
    'and review recent tool deploys / Bedrock throttle rate.',
  metric: toolSuccessRatePercent,
  threshold: 80,
  evaluationPeriods: 2,
  comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, // no traffic != alarm
});
```

### `tenant:hourly_cost_usd` — direct `SUM` over 1-hour period

**Input metric:** `tenant_hourly_cost_usd` at `Chimera/Billing` with
dimensions `{tenant_id, tier, model_id, service}`. Emitted once per
`CostTracker.recordCost()` call with unit `None` (CloudWatch has no USD
unit). The value is the USD delta for *that single invocation*.

**Aggregation:** `SUM(tenant_hourly_cost_usd)` over a 1-hour period
yields the per-hour spend. Dimensions determine the slicing — leave them
all off for a platform-wide total, add `tenant_id` for per-tenant, etc.

```typescript
const hourlyCost = new cloudwatch.Metric({
  namespace: 'Chimera/Billing',
  metricName: 'tenant_hourly_cost_usd',
  statistic: 'Sum',
  period: cdk.Duration.hours(1),
});
```

This is the metric wired into the "Cost Attribution" dashboard in
`observability-stack.ts`.

## Dashboards

| Dashboard                        | CDK id                        | Audience       | Primary metrics                                                                                  |
|----------------------------------|-------------------------------|----------------|--------------------------------------------------------------------------------------------------|
| `chimera-platform-{env}`         | `PlatformDashboard`           | platform ops   | DDB throttles, API latency/errors, ECS CPU/mem, Registry row, load-test, **Tool success rate**   |
| `chimera-tenant-health-{env}`    | `TenantHealthDashboard`       | tenant ops     | active sessions, request rate, error rate, p99 latency (per tenant)                              |
| `chimera-skill-usage-{env}`      | `SkillUsageDashboard`         | marketplace ops| skill invocations, success vs failure, execution latency                                          |
| `chimera-cost-attribution-{env}` | `CostAttributionDashboard`    | FinOps         | hourly cost (from `tenant_hourly_cost_usd`), monthly spend, quota utilization, burn rate         |

## Changes from Wave-15d (this update)

- **`tenant_hourly_cost_usd` went live.** Previously the Cost Attribution
  dashboard referenced `Chimera/Billing::TenantSpend` which nothing emitted.
  `CostTracker.recordCost()` now emits EMF per invocation; the dashboard
  panel "Hourly Cost (USD)" uses the new metric.
- **`tool:success_rate_percent` is now operator-visible.** Rather than
  adding a separate pre-aggregated EMF metric, we document the Metric
  Math expression that derives the success rate from the existing
  `Chimera/Tools::Success` counter, and add a dashboard panel on the
  platform dashboard. See `ToolSuccessRatePanel` in
  `infra/lib/observability-stack.ts`.

## References

- Emitter (TS): `packages/core/src/billing/cost-tracker.ts`,
  `packages/core/src/evolution/model-router.ts`
- Emitter (Python): `packages/agents/observability.py`,
  `packages/agents/tools/gateway_instrumentation.py`
- CDK: `infra/lib/observability-stack.ts`
- Audit gap list: `docs/reviews/cost-observability-audit.md`
- Open punch list: `docs/reviews/OPEN-PUNCH-LIST.md` §observability-emitter
