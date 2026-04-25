---
title: 'ADR-039: EMF as the Canonical Metric Emission Pattern'
status: accepted
date: 2026-04-24
decision_makers: [chimera-architecture-team]
---

# ADR-039: CloudWatch Embedded Metric Format (EMF) as the Canonical Metric Emission Pattern

## Status

**Accepted** (2026-04-24)

## Context

Wave-12 landed the first two of Chimera's per-tenant operational metrics (tier violations, agent loop iterations) and the decision of *how* to emit them surfaced the usual CloudWatch trade-off. The options were:

1. **`PutMetricData` API calls** — synchronous SDK call per metric. Requires the emitter's IAM role to grant `cloudwatch:PutMetricData`; has a per-account TPS limit (150 by default, raisable); is billed per metric value written.
2. **CloudWatch Embedded Metric Format (EMF)** — the emitter writes a JSON line to stdout; the Lambda or ECS log driver forwards it to CloudWatch Logs; CloudWatch extracts metrics asynchronously from the log stream. No IAM change (stdout → log-driver path already exists), no API call on the hot path, no TPS limit.

Chimera's internal metric emitters run inside Lambdas and ECS tasks that already have CloudWatch Logs write permission via the log driver. Adding `cloudwatch:PutMetricData` to the hot-path roles expands the blast radius of a compromised execution role, adds latency to every request that emits a metric, and introduces a new failure mode (throttling under burst).

## Decision

Use CloudWatch EMF for every **internal instrumentation emitter**. Both language runtimes ship a small helper:

- **TypeScript** — `packages/core/src/billing/cost-tracker.ts` exports `emitEmfMetric(namespace, name, value, unit, dimensions)`. A second emitter in `packages/core/src/evolution/model-router.ts` uses the same pattern. Both write a single JSON line to stdout and never throw.
- **Python** — `packages/agents/observability.py` exports `emit_emf_metric(namespace, name, value, unit, dimensions)`; re-used by `packages/agents/tools/gateway_instrumentation.py`'s `@instrument_tool` decorator.

**`PutMetricData` is reserved for agent-facing tools**, not for platform instrumentation. Specifically, the CloudWatch skill tool (`packages/core/src/aws-tools/cloudwatch-tool.ts` and `packages/agents/tools/cloudwatch_tools.py`) exposes `PutMetricData` as a capability that an agent can invoke on a tenant's behalf — that is a product surface, not an internal emitter, and it naturally carries its own IAM grant.

**Commit references:**
- `35f8073` — tool-invocation EMF emitter in `gateway_instrumentation.py` + 13 unit tests
- `c29745c` — EMF emitter in `packages/agents/observability.py` + tier-violation and loop-iteration metrics
- `e77de2b` — `tenant_hourly_cost_usd` EMF emitter in `packages/core/src/billing/cost-tracker.ts` + MathExpression wiring in the observability stack

## Alternatives Considered

### Alternative 1: `PutMetricData` everywhere

Synchronous SDK call per metric, uniform across runtimes.

**Cons:**
- ❌ IAM expansion — every emitter role gains `cloudwatch:PutMetricData`.
- ❌ Hot-path latency — the SDK call sits on the request path.
- ❌ TPS limits — a burst of requests can saturate the 150-TPS account limit.
- ❌ Billing — `PutMetricData` is billed per metric, EMF is billed via log ingestion which the fleet already pays for.

**Verdict:** Rejected.

### Alternative 2: OpenTelemetry metrics

OTEL metrics pipeline, exporting via AWS Distro for OpenTelemetry (ADOT) collector.

**Cons:** Introduces a collector dependency on every host, adds a new protocol surface. AgentCore Observability is the AWS-native OTEL story and is a separate roadmap item; we do not want two telemetry pipelines running in parallel.

**Verdict:** Deferred to the AgentCore Observability onboarding track, not rejected outright.

### Alternative 3: Client-side aggregation + batched `PutMetricData`

Buffer metrics in-process, flush every N seconds.

**Cons:** Adds buffer-and-flush state to otherwise-stateless Lambdas; complicates shutdown (lost buffers on timeout); still requires IAM grant; still hits TPS under burst.

**Verdict:** Rejected.

### Alternative 4: EMF for internal, `PutMetricData` exposed as agent tool (Selected)

EMF for platform emitters, `PutMetricData` only where an agent action explicitly demands it.

**Verdict:** Selected.

## Consequences

### Positive

- **Zero IAM cost on the hot path.** Emitters need log-driver access only — they already have it.
- **No TPS ceiling.** Burst of metric emissions is bounded by log-ingestion throughput, which is orders of magnitude higher than `PutMetricData`.
- **Failure isolation.** Emission failures (a malformed dimension value, a JSON encoding bug) never throw into the caller — both helpers wrap emission in a `try/except` and log at `WARNING`. Observability never breaks tools.
- **Unified shape.** Both runtimes emit the same JSON shape, so the CloudWatch side (namespaces, dimensions, alarm queries) does not need to know which language produced the metric.

### Negative

- **Retention governance.** EMF metrics are durable only as long as the log stream they were written to. A log group with `debug` retention (see ADR-035) keeps metrics for 7 days in prod; anything longer must live in a log group with a longer retention class, or be archived elsewhere. The log-retention class is now implicitly a metric-durability decision.
- **Cross-dimension aggregate alarms require MathExpression `SEARCH()`.** Standard `Metric()` alarms scope to a specific dimension set. Aggregates like "tool success rate across all tenants" use `cloudwatch.MathExpression` with a `SEARCH()` query — see `infra/lib/observability-stack.ts` for five such expressions (tool success rate, API error rate, cross-region error rate, registry fallback rate, tenant hourly cost). Wave-17 H3 documented the pattern.

### Risks

- **Log-group misconfiguration loses metrics.** If an emitter writes to a log group with very short retention, the metric is extracted but the source log is gone before an incident investigation reaches it. Mitigated by the ADR-035 retention classes — emitters of durable metrics target `app` or `security` class log groups, not `debug`.
- **JSON parsing cost in CloudWatch.** EMF is parsed log-side; very high-volume streams (millions of entries/minute) can cost more in log-ingestion bytes than the equivalent `PutMetricData` spend. Monitor per-namespace log volume; we are not near this regime.

## Evidence

- **`packages/core/src/billing/cost-tracker.ts`** — `emitEmfMetric` helper and `tenant_hourly_cost_usd` emission site.
- **`packages/core/src/evolution/model-router.ts`** — second `emitEmfMetric` helper used by the tier-ceiling violation metric.
- **`packages/agents/observability.py`** — Python `emit_emf_metric`.
- **`packages/agents/tools/gateway_instrumentation.py`** — `@instrument_tool` decorator that emits `tool_invocation_duration_ms` and `Success` metrics.
- **`infra/lib/observability-stack.ts`** — five `cloudwatch.MathExpression` call sites using `SEARCH()` for cross-dimension alarms.
- **Commits:** `35f8073`, `c29745c`, `e77de2b`.

## Related Decisions

- **ADR-035** (CloudWatch log retention classes) — co-dependent. EMF metrics live as long as their host log group, so the retention class of that log group is now a deliberate metric-durability decision.
- **ADR-012** (Well-Architected Framework as agent decision framework) — the Operational Excellence pillar's "instrument everything" guidance is why this metric pipeline exists.
- **ADR-034** (AgentCore Registry adoption) — Registry's alarms (write-failure, read-error, fallback-rate) also emit via EMF and use the same MathExpression pattern for aggregate views.

## References

1. CloudWatch Embedded Metric Format spec: <https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html>
2. CloudWatch `PutMetricData` quotas: <https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_limits.html>
3. CloudWatch MathExpression `SEARCH()` syntax: <https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/search-expression-syntax.html>
4. TS emitter: `packages/core/src/billing/cost-tracker.ts`
5. Python emitter: `packages/agents/observability.py`
6. Landing commits: `35f8073`, `c29745c`, `e77de2b`
