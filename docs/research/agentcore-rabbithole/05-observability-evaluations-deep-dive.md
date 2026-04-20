---
title: "AgentCore Observability + Evaluations — Deep Dive"
version: 0.1.0
status: research
last_updated: 2026-04-17
series: agentcore-rabbithole
part: 05
---

# AgentCore Observability + Evaluations — Deep Dive

## TL;DR for Chimera

**Observability:** AgentCore ships an OTEL-native trace pipeline (`bedrock-agentcore` CloudWatch namespace, `aws/spans` log group, X-Ray Transaction Search, plus a stock **CloudWatch GenAI Observability Dashboard**). It gives us ~8 of the ~15 metrics we catalogued as gaps in `docs/reviews/cost-observability-audit.md` *for free* — `Invocations`, `Throttles`, `SystemErrors`, `UserErrors`, `Latency (p50/p90/p99)`, `SessionCount`, `CPUUsed-vCPUHours`, `MemoryUsed-GBHours`, plus gateway tool metrics (`TargetExecutionTime`, `TargetType`) and built-in tool usage counters. **What it does NOT give us:** per-tenant dimensions (no `tenantId`), token counts, per-tool-call counts at the agent level, cost/budget metrics, or our `TenantCostAnomaly` signal. Chimera's `ObservabilityStack` stays as the **tenant- and cost-attribution layer**; AgentCore's pipeline slots in underneath as the **runtime/session layer**. They compose rather than compete — but ~40% of the widgets in `chimera-platform-{env}` become redundant if we onboard to Runtime.

**Evaluations:** AgentCore Evaluations is a **quality-scoring service**, not an experiment platform. It runs 14 built-in LLM-as-judge evaluators (`GoalSuccessRate`, `Correctness`, `Faithfulness`, `ToolSelectionAccuracy`, `ToolParameterAccuracy`, `Harmfulness`, `Stereotyping`, etc.) plus code-based Lambda evaluators, over either **live traffic (online, % sampled)** or **targeted traces/spans (on-demand)**. It **replaces** Chimera's `goldenDatasetS3Key`-based `testPromptVariant()` path and Chimera's ad-hoc "LLM-as-judge would go here" TODO in `prompt-optimizer.ts:runTestCase()`. It does **not** replace Chimera's A/B traffic splitter, Thompson Sampling model router, `variantAScores.n` counter, or `completeExperiment()` winner logic — those are *bandit infrastructure*, which AgentCore Evaluations does not provide. **The flywheel Chimera wants** (evolution writes new prompt → evaluation scores it → winner promoted) requires gluing `PromptOptimizer.recordVariantOutcome()` to AgentCore's `Evaluate` API. That glue is ~1 Lambda.

**Bottom line:** onboard **Observability** before custom metric emission (it obsoletes the 8 "defined but never emitted" metrics in the audit); adopt **Evaluations** as the judge inside our existing A/B harness, not as a replacement for it. Keep `cost-tracker.ts`, `budget-monitor.ts`, `model-router.ts`, `prompt-optimizer.ts`. Delete `prompt-optimizer.ts:runTestCase()` simulation and wire `client.evaluate({ evaluatorId, evaluationTarget: { traceIds } })` in its place.

---

## Observability

### Built-in metrics

Runtime emits these automatically to the **`bedrock-agentcore`** (sometimes rendered `Bedrock-AgentCore`) CloudWatch namespace, batched at 1-minute resolution:

| Metric | Category | Stats | Chimera today |
|---|---|---|---|
| `Invocations` | Request count | Sum | Covered by `AWS/ApiGateway:Count` + custom `Chimera/Tenant:RequestCount` |
| `Throttles` | HTTP 429 | Sum | Partially (DDB throttles only) |
| `SystemErrors` | 5xx | Sum | Covered by `AWS/ApiGateway:5XXError` |
| `UserErrors` | 4xx | Sum | Covered by `AWS/ApiGateway:4XXError` |
| `Latency` | End-to-end ms | Avg/Min/Max/p50/p90/p99 | Covered by `AWS/ApiGateway:Latency` (p99 only) |
| `TotalErrors` | Composite | Sum | Hand-rolled via MathExpression in `observability-stack.ts:422` |
| `SessionCount` | Sessions | Sum | **Gap** — defined as `Chimera/Tenant:ActiveSessions` but no emitter |
| `ActiveStreamingConnections` | WebSocket | 1-min Sum | **Gap** — not tracked |
| `Inbound/OutboundStreamingBytesProcessed` | WebSocket | Sum | **Gap** |
| `CPUUsed-vCPUHours` | Resource usage | — | Covered by `AWS/ECS:CPUUtilization` (different shape) |
| `MemoryUsed-GBHours` | Resource usage | — | Covered by `AWS/ECS:MemoryUtilization` (different shape) |
| Gateway `TargetExecutionTime` | Tool latency | p50/p90/p99 | **Gap** — `Chimera/Skills:ExecutionLatency` defined, no emitter |
| Gateway `TargetType` | Tool type breakdown | Sum | **Gap** |
| Built-in tool `Invocations/Latency/Duration` | CodeInterpreter/Browser | Sum/stats | **Gap** — `Chimera/Skills:InvocationCount` defined, no emitter |

**What AgentCore does NOT emit automatically (critical for our use case):**
- **Token counts** — no `InputTokens`/`OutputTokens` metric in the bedrock-agentcore namespace. Must be captured via OTEL GenAI semantic-convention attributes (`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) on spans. Chimera needs these for `cost-tracker.ts` — so we cannot replace our token-accounting path.
- **Tool-call counts at the agent level** — only gateway-invoked tools get metrics. An agent that calls an internal Lambda without going through Gateway leaves no counter.
- **Model ID** — no dimension identifies which Bedrock foundation model was invoked.
- **Tenant ID** — see "Per-tenant dimensions" below.
- **Cost** — explicitly disclaimed: "telemetry data is for monitoring purposes only, not authoritative for billing."

### Tracing

**OpenTelemetry-native with X-Ray backend.** AgentCore ships OTEL spans over OTLP http/protobuf through the AWS Distro for OpenTelemetry (ADOT), which bytecode-instruments Python/Node agents automatically. Spans are stored in the `aws/spans` CloudWatch Logs log group and indexed by **X-Ray Transaction Search** (one-time enablement via `aws xray update-trace-segment-destination --destination CloudWatchLogs`).

**Span model is three-tier:** `Session` (conversation) → `Trace` (request/response cycle) → `Spans` (operations: parse input, retrieve context, generate response, tool call, format output).

**Runtime-provided span attributes on every `InvokeAgentRuntime`:**
- `aws.operation.name`, `aws.resource.arn`, `aws.request_id`, `aws.agent.id`, `aws.endpoint.name`, `aws.account.id`, `aws.region`
- `session.id`, `latency_ms`, `error_type`, `aws.resource.type`, `aws.xray.origin`

**Memory/Gateway spans** add operation-specific attributes: `memory.id`, `namespace`, `actor.id`, `event.id`, `throttled`, `error`, `fault` (memory); target type, execution time, AWS request ID (gateway, as paired `SERVER`/`CLIENT` spans).

**Supported instrumentation libraries:** OpenInference, Openllmetry, OpenLit, Traceloop — all auto-export GenAI semconv attributes for token counts, model IDs, tool names, etc.

**Chimera today:** `observability-stack.ts:153` creates an X-Ray `CfnGroup` named `chimera-{env}` with filter `service("chimera-*")` and `insightsEnabled: true`. ECS Fargate tasks and Lambdas use the AWS X-Ray SDK. **We do NOT use OTEL.** Onboarding AgentCore means either (a) add `aws-opentelemetry-distro` alongside X-Ray SDK, or (b) switch to ADOT entirely (cleaner, but ~3d of ECS task-definition churn).

**Custom headers Chimera already passes that AgentCore understands:** `X-Amzn-Trace-Id` (X-Ray) and `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` (session correlation). W3C `traceparent` / `tracestate` / `baggage` are additionally supported — `baggage: tenantId=<id>` is the documented mechanism for propagating tenant context.

### Logs

**Structured JSON with built-in trace correlation.** Three log types, auto-created per agent resource:

- `APPLICATION_LOGS`: `/aws/bedrock-agentcore/runtimes/<agent_id>-<endpoint>/runtime-logs` — fields include `request_id`, `session_id`, `trace_id`, `span_id`, `request_payload`, `response_payload`
- `USAGE_LOGS`: 1-second-granularity resource usage — `agent.runtime.vcpu.hours.used`, `agent.runtime.memory.gb_hours.used`, `session.id`
- `TRACES`: routed to X-Ray (see above)

All logs are destination-configurable: CloudWatch Logs, S3, or Firehose. Memory and Gateway have their own log groups under `/aws/vendedlogs/bedrock-agentcore/...`.

**Chimera today:** `observability-stack.ts:63` defines a single centralized `PlatformLogGroup` (`/chimera/{env}/platform`) for ECS, Lambda, and API Gateway, with 6-month retention in prod (1 week in dev) and KMS encryption via `platformKey`. **AgentCore log groups would be additive**, not a replacement — we'd get a separate `/aws/bedrock-agentcore/runtimes/...` tree per agent ARN. Encryption and retention would need to be configured separately per log group (there's no "all AgentCore logs go to my KMS key" switch).

### Dashboards

**Stock dashboard:** the **CloudWatch GenAI Observability Dashboard** at `console.aws.amazon.com/cloudwatch/home#gen-ai-observability`. Tabs:

- **Bedrock AgentCore** — Agents View, Sessions View, Traces View (drilldown per agent)
- **Runtime** — account-level CPU/memory aggregate
- **Built-in Tools** — CPU/memory by tool type
- **AgentCore Gateway** — policy observability

**Limitations of the stock dashboard:**
- Memory, Gateway, and Tools metrics are **not** on the GenAI Observability page — they live in standard CloudWatch only.
- No per-tenant slicing (you get per-agent-ARN).
- No cost/budget widgets at all.
- No SLA-line annotations (our `observability-stack.ts:1008` "500ms p99 SLA" red line is a Chimera-only feature).

**Chimera today ships 4 dashboards (`observability-stack.ts`):**
- `chimera-platform-{env}` — health, DDB, API GW, ECS, load test (fully custom)
- `chimera-tenant-health-{env}` — per-tenant (metrics defined but not emitted per the audit)
- `chimera-skill-usage-{env}` — per-skill (metrics defined but not emitted)
- `chimera-cost-attribution-{env}` — per-tenant spend

**Overlap:** the Runtime-session bits of `chimera-platform` (API GW latency, 4xx/5xx, ECS CPU/Mem) are ~100% duplicated by the GenAI Observability dashboard **if** we route chat traffic through Runtime. The DDB-throttle widgets, PITR-compliance composite alarm, Backup failure alarm, cross-region health, and cost-attribution dashboard are **100% Chimera-specific** — AgentCore's dashboard says nothing about any of them.

### Per-tenant dimensions

**No native `tenantId` dimension.** This is the single biggest gap between what AgentCore ships and what Chimera needs. Built-in dimensions on Runtime metrics are `Service` (`AgentCore.Runtime`), `Resource` (Agent ARN), and `Name` (`AgentName::EndpointName`). Gateway adds `Operation`, `Protocol`, `Method`, and a tool `Name`.

**Three approaches AWS documents:**

1. **Agent-per-tenant** — every tenant gets its own `AgentArn`, and `Resource` becomes an implicit tenant dimension. Matches Chimera's existing `TenantAgent` L3 construct pattern (`constructs/tenant-agent.ts`). Cost: each agent resource is a separately billed Runtime endpoint. Feasible for hundreds of tenants, probably not for tens of thousands.
2. **OTEL resource attributes** — `OTEL_RESOURCE_ATTRIBUTES=service.name=chimera-agent,tenant.id=<id>` — attaches `tenant.id` to every span. CloudWatch Metrics does NOT auto-promote span attributes to metric dimensions, so this buys you *searchable traces* but not *filterable metrics*.
3. **Custom `PutMetricData` with `TenantId` dimension** — emit your own metric stream alongside the automatic ones. This is exactly what Chimera's cost-publisher Lambda already does (`observability-stack.ts:478-600`) for `Chimera/Billing:TenantCostAnomaly` with a `TenantId` dimension. **The audit's recommended CRITICAL/HIGH metrics (lines 36-88) all need this pattern.** AgentCore's built-ins do NOT eliminate the need.

**Recommendation:** use `baggage: tenantId=<id>` on every inbound request for trace-side tenant correlation, AND keep Chimera's custom metric emitters for dimensioned CloudWatch metrics. The audit's `chimera:tool:invocation_duration_ms`, `chimera:model:tier_violation_count`, `chimera:agent:loop_iterations` still need to be hand-emitted.

### CloudWatch composition

AgentCore is **fully inside CloudWatch**, not alongside it. Everything lands in CloudWatch Logs or Metrics:

```
Runtime / Memory / Gateway / Built-in Tools
          ↓  ADOT (auto-instrumented)
CloudWatch Logs              CloudWatch Metrics (bedrock-agentcore ns)
  ├── /aws/bedrock-agentcore/...       ↓
  ├── /aws/vendedlogs/bedrock-agentcore/memory     CloudWatch Alarms → SNS
  ├── /aws/vendedlogs/bedrock-agentcore/gateway           ↓
  └── aws/spans (X-Ray Transaction Search indexed)   Chimera's critical/
                                                     high/medium topics
```

**Alarms:** `aws cloudwatch put-metric-alarm` on `bedrock-agentcore` metrics works exactly like alarms on any other namespace. We can point AgentCore alarms at our existing `CriticalAlarmTopic` / `HighAlarmTopic` / `MediumAlarmTopic` (`observability-stack.ts:95-111`) with zero changes to SNS routing.

**Escape hatch for non-AWS observability stacks:** `export DISABLE_ADOT_OBSERVABILITY=true` disables the bundled pipeline so agents can emit OTEL directly to Datadog/Honeycomb/etc. Not useful for Chimera (we want CloudWatch native) but documents that we're not locked in.

**Retention / cost:** AWS does not publish explicit retention or pricing for AgentCore Observability in the devguide. The guide says "Standard Amazon CloudWatch data retention policies apply" — which means **we pay CloudWatch Logs ingestion + storage + X-Ray segment storage as usual**. Transaction Search allows 1% of traces indexed at no cost; higher sampling rates incur standard X-Ray pricing. *This is the single cost element that could surprise us* — 100% sampling of production traffic is roughly $5/million traces plus log ingestion.

---

## Evaluations

### Eval types

AgentCore Evaluations supports three mechanisms:

1. **LLM-as-a-judge (14 built-ins, plus custom):**

   | Level | Evaluators |
   |---|---|
   | `SESSION` | `GoalSuccessRate` |
   | `TRACE` | `Coherence`, `Conciseness`, `ContextRelevance`, `Correctness`, `Faithfulness`, `Harmfulness`, `Helpfulness`, `InstructionFollowing`, `Refusal`, `ResponseRelevance`, `Stereotyping` |
   | `TOOL_CALL` | `ToolParameterAccuracy`, `ToolSelectionAccuracy` |

   Scales are evaluator-specific: Yes/No, 5-point numerical, 7-point Helpfulness, or categorical labels. Custom evaluators accept up to 20 scale definitions.

2. **Code-based (Lambda):** deterministic evaluators for regex matching, JSON validation, API-call assertions, custom business rules. Registered via `@code_based_evaluator` decorator; 300s timeout, 6 MB payload cap.

3. **Ground-truth / reference-based:** Custom evaluators consume placeholders `{expected_response}`, `{expected_tool_trajectory}`, `{assertions}`. **Constraint:** these only work on **on-demand** (offline) evaluations — they cannot run online because production traffic has no ground truth.

**Not supported:** human-in-the-loop review (no labelling UI or queue described in the docs).

### Configuration model

Three entry points, all thin wrappers over the `bedrock-agentcore-control:CreateEvaluator` API:

- **JSON config file** (source of truth):
  ```json
  {
    "llmAsAJudge": {
      "modelConfig": { "bedrockEvaluatorModelConfig": {
        "modelId": "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "inferenceConfig": { "maxTokens": 500, "temperature": 1.0 }
      }},
      "instructions": "You are evaluating... Context: {context}\nCandidate: {assistant_turn}",
      "ratingScale": { "numerical": [...] }
    }
  }
  ```
- **Python SDK:** `Evaluation().create_evaluator(name, level, config)`
- **AgentCore CLI:** `agentcore add evaluator --name X --config Y --level TRACE`

**Levels:** `TRACE`, `TOOL_CALL`, `SESSION` — drives which placeholders are available to the judge prompt.

**Placeholder reference:**

| Level | Placeholders |
|---|---|
| `SESSION` | `{context}`, `{available_tools}`, `{actual_tool_trajectory}`, `{expected_tool_trajectory}`, `{assertions}` |
| `TRACE` | `{context}`, `{assistant_turn}`, `{expected_response}` |
| `TOOL_CALL` | `{available_tools}`, `{context}`, `{tool_turn}` |

### Offline vs online

**Both are first-class modes.**

- **On-demand (offline/batch):** target specific `traceIds` or `spanIds` in a CloudWatch Transaction Search index. Runs all evaluator types including ground-truth. Entry point: `boto3.client('bedrock-agentcore').evaluate(evaluatorId=..., evaluationTarget={'traceIds': [...]})`.
- **Online (production sampling):** configure a sampling percentage or conditional filter; aggregated scores are surfaced on dashboards. Cannot use ground-truth evaluators. Controlled via `agentcore pause/resume online-eval`.

**Hard limits:**
- Max 1,000 evaluation configurations per Region
- Max 100 active simultaneously
- 1M input+output tokens/min/account throughput (large regions)

### Integrates with Runtime, not Registry

Evaluations consume traces from **CloudWatch Transaction Search**, which is populated by any OTEL/ADOT-instrumented agent — including agents **not** hosted in AgentCore Runtime (the docs explicitly confirm this). So any Strands, LangGraph, or custom agent emitting GenAI semconv spans to `aws/spans` can be evaluated.

There is **no documented integration with AgentCore Registry**. Evaluators are separate Control-Plane resources (`bedrock-agentcore-control:CreateEvaluator`), not skill manifests.

### Signals produced

- **Per-evaluation JSON result:** `{ "label": "PASS", "value": 1.0, "explanation": "..." }` or categorical equivalent
- **Aggregated dashboards:** quality trends over time, low-score session investigation, interaction flow visualization
- **Error signals (code-based only):** `{ "errorCode": "VALIDATION_FAILED", "errorMessage": "..." }`

**Not produced:**
- Regression alerts (no threshold-notification system described)
- Cost estimates
- Automatic experiment promotion / winner selection
- Statistical significance testing on A/B deltas

### Pricing

**Not published in the devguide or `aws.amazon.com/bedrock/pricing` excerpt accessible at research time.** Based on the architecture the probable cost components are:
- Bedrock judge-model inference (Sonnet 4.5 in the default config) — billed at standard Bedrock per-token rates
- Lambda invocation for code-based evaluators
- CloudWatch Logs ingestion for evaluation results
- Any additional charge for the AgentCore Evaluations control plane (unknown)

**Planning assumption:** ~$0.003-$0.015 per LLM-as-judge evaluation at typical prompt sizes (500-2000 input tokens, 500 output tokens of Sonnet 4.5 at `$3/$15 per MTok`). At 10% online sampling of 1M sessions/month that's ~$300-$1,500/mo — not trivial but tractable. **This needs real pricing data before we commit.**

---

## Chimera's current observability + evolution code

### What's duplicated vs complementary

**Observability — duplication map (vs `infra/lib/observability-stack.ts`, 1100 lines):**

| Chimera asset | AgentCore equivalent | Verdict |
|---|---|---|
| `PlatformLogGroup` (line 63) — central log group, KMS, 6-month retention | `/aws/bedrock-agentcore/runtimes/...` per-agent groups | **Complementary** — keep platform group for ECS/Lambda/non-AgentCore services |
| `XRayTracingGroup` with `service("chimera-*")` filter (line 153) | Auto-routed to `aws/spans` log group, X-Ray Transaction Search | **Replaceable** — AgentCore's trace pipeline is richer; keep Chimera's for non-Runtime services |
| API Gateway latency/4xx/5xx widgets (lines 308-404) | Runtime `Latency`, `UserErrors`, `SystemErrors` in `bedrock-agentcore` | **Replaceable** (for Runtime-served traffic only) |
| ECS CPU/Memory widgets (lines 319-337) | Runtime `CPUUsed-vCPUHours`, `MemoryUsed-GBHours` | **Partially replaceable** — different metric shape; keep both |
| DynamoDB throttle alarms ×6 (lines 232-289) | — | **Chimera-only** (AgentCore doesn't touch DDB) |
| PITR compliance alarm + composite (lines 629-722) | — | **Chimera-only** |
| Cross-region health composite (lines 924-962) | — | **Chimera-only** |
| `Chimera/Billing` namespace (TotalMonthlySpend, ActiveTenants, TenantCostAnomaly) | — | **Chimera-only** (AgentCore has no billing metrics) |
| `Chimera/Tenant` dashboard metrics (ActiveSessions, RequestCount, ErrorCount, RequestLatency) — **defined but no emitter per audit** | Partial: `SessionCount` auto-emitted (no tenant dimension) | **Keep Chimera's custom emitters for tenant dimension; drop the undimensioned metric** |
| `Chimera/Skills` dashboard metrics (InvocationCount, SuccessCount, FailureCount, ExecutionLatency) — **defined but no emitter** | Gateway `Invocations`, `TargetExecutionTime`, `TargetType` (via Gateway only) | **Use Gateway metrics if we route skills through Gateway; otherwise keep custom emitters** |
| Cost Publisher Lambda (lines 478-600) | — | **Chimera-only** — AgentCore can't see DDB cost-tracking table |
| Load test metrics + SLA annotations (lines 969-1029) | — | **Chimera-only** |

**~40% of the `chimera-platform-{env}` dashboard widgets become redundant if we onboard Runtime.** The 4 tenant/skill/cost dashboards remain 100% Chimera-owned.

**Evolution — duplication map (vs `packages/core/src/evolution/`, 4392 lines):**

| Chimera module | Evaluations covers? | Verdict |
|---|---|---|
| `prompt-optimizer.ts::testPromptVariant()` (lines 306-348) — loads golden dataset from S3, runs each test case, returns pass rate | **Yes, exactly** — on-demand Evaluate with `{expected_response}` ground-truth evaluator | **Replace** — this is the clearest win |
| `prompt-optimizer.ts::runTestCase()` (lines 447-469) — placeholder "would use Bedrock embeddings OR LLM-as-judge" | **Yes, entirely** — that's precisely what LLM-as-judge built-ins do | **Delete and replace with `client.evaluate()`** |
| `prompt-optimizer.ts::analyzeConversationLogs()` (lines 64-140) — string-matches user correction phrases ("that's wrong", "I meant") | **Partial** — `Correctness` and `InstructionFollowing` evaluators score this properly via LLM judge | **Augment, not replace** — keep the string-match for cheap continuous signal; run Evaluations on sampled sessions for high-fidelity signal |
| `prompt-optimizer.ts::createABExperiment()` + `recordVariantOutcome()` + `completeExperiment()` (lines 145-301) — traffic split, Beta-distribution outcome tracking, 5%-quality-threshold winner selection | **No** — Evaluations does not do bandit traffic management | **Keep — feed Evaluations scores IN as the `qualityScore` input** |
| `model-router.ts::ModelRouter` (660 lines) — Thompson Sampling, per-tenant DDB state, tier-ceiling enforcement | **No** — Evaluations doesn't do model routing | **Keep entirely** — this is load-bearing infrastructure |
| `experiment-runner.ts::ExperimentRunner` (433 lines) — Step Functions-orchestrated hyperparameter search, quasi-random sampling, Sobol-like exploration | **No** — Evaluations doesn't do hyperparameter search | **Keep** |
| `self-reflection.ts::calculateHealthScore()` (line 88) — 7-metric composite with tunable weights | **No** — but Evaluations feeds the `responseQuality` input to this calculation | **Keep; wire Evaluations scores into `metrics.thumbsUpRatio` and `metrics.toolSuccessRate`** |
| `self-reflection.ts::shouldThrottleEvolution()` (line 368) — circuit breaker on rollback spikes | **No** — pure Chimera safety harness | **Keep** |
| `safety-harness.ts::EvolutionSafetyHarness` (399 lines) — Cedar auth, rate limits, cost-threshold gate | **No** — Evaluations has no authorization model | **Keep** |
| `self-evolution-orchestrator.ts::SelfEvolutionOrchestrator` (529 lines) — CDK gen → validation → CodeCommit → CodePipeline → capability register | **No** — Evaluations doesn't touch IaC | **Keep** |
| `cost-tracker.ts::CostTracker` (361 lines) + `budget-monitor.ts::BudgetMonitor` (321 lines) | **No** — Evaluations doesn't do cost tracking | **Keep entirely** |

**Summary:** Evaluations replaces **~200 lines** of `prompt-optimizer.ts` (golden-dataset test harness + LLM-as-judge placeholder). The other **~4200 lines** of evolution code are Chimera-specific infrastructure that Evaluations does not and will not provide.

---

## The self-evolution flywheel

Chimera's current flywheel (per `docs/research/evolution/01-Prompt-Model-Optimization.md` and the code):

```
conversation logs → analyzeConversationLogs() → detect failure patterns
      ↓
generate improved prompt (currently manual; roadmap: LLM-assisted in self-reflection.ts)
      ↓
createABExperiment(current, improved, 10% traffic to B)
      ↓
selectPromptVariant() per-request → record to DDB
      ↓
recordVariantOutcome(quality, cost) — but quality is STUBBED
      ↓
completeExperiment() — 5% improvement threshold → promote winner
      ↓
capability registered in evolution state table
```

**The gap:** `recordVariantOutcome()` expects a `qualityScore` parameter, but no production emitter supplies one. `runTestCase()` (line 447) hard-codes a simulation. This is exactly where AgentCore Evaluations slots in.

### How AgentCore could automate the loop

**The glue is one Lambda and one EventBridge rule:**

```
Agent completes request (via ECS or Runtime)
      ↓
ADOT emits trace to aws/spans with session.id, tenant.id baggage, variantId custom attr
      ↓
ONLINE EVALUATION: AgentCore runs Correctness + ToolSelectionAccuracy + Helpfulness
   on 10% of traces automatically (sampling rate configured once)
      ↓
Evaluation result lands as structured log in CloudWatch
      ↓
EventBridge rule: CloudWatch Logs subscription filter → Lambda
      ↓
Lambda parses { variantId, traceId, scores[] }, averages into qualityScore ∈ [0,1]
      ↓
promptOptimizer.recordVariantOutcome({
  tenantId, experimentId, variant: 'b',
  qualityScore,   ← now sourced from Evaluations, not stubbed
  cost,           ← still from cost-tracker.ts
  latencyMs       ← from span duration
})
      ↓
completeExperiment() with real quality data → promote winner
      ↓
New winning prompt committed to S3; self-evolution-orchestrator deploys
      ↓
NEW TRACES flow back through Evaluations → loop closes
```

**What this buys us vs the current stubbed path:**

1. **Quality signal is no longer a placeholder.** Today, `runTestCase()` returns `0.6 + f(promptLength)` — meaningless. With Evaluations, `qualityScore` is a genuine LLM-judge score across `Correctness`, `Helpfulness`, `InstructionFollowing`.
2. **Online evaluation means no golden dataset curation.** Today, `testPromptVariant()` needs a `goldenDatasetS3Key`. With online sampling, production traffic IS the dataset (no ground truth required for the non-reference evaluators).
3. **`ToolSelectionAccuracy` closes the `chimera:tool:invocation_duration_ms` → *quality* loop.** Today's audit only measures tool latency; Evaluations measures whether the agent picked the right tool at all.
4. **Self-reflection gets a real `responseQuality` input.** `self-reflection.ts:93` reads `metrics.thumbsUpRatio`; today we have no thumbs-up collector. Evaluations' `GoalSuccessRate` is the production-grade substitute.

**What AgentCore cannot automate for us:**

- **Generating the improved prompt.** Evaluations scores prompts; it does not write them. Chimera still needs an LLM-driven prompt rewriter (currently a TODO in `self-reflection.ts`).
- **Bandit arm selection.** Thompson Sampling (`model-router.ts:sampleBeta`) is Chimera's. Evaluations provides the reward, not the sampler.
- **Cost-aware promotion.** `completeExperiment()` has a branch that promotes variant B if it's 10% cheaper at similar quality — that's a Chimera policy decision. Evaluations has no cost signal.
- **Cedar authorization on prompt changes.** `safety-harness.ts` stays.
- **IaC rollback on failed experiments.** `self-evolution-orchestrator.ts` stays.

### Concrete integration plan

1. **Observability onboarding (1 week):**
   - Add `aws-opentelemetry-distro` to ECS task definitions + Lambda layers
   - Enable Transaction Search: `aws xray update-trace-segment-destination --destination CloudWatchLogs`
   - Add `baggage: tenantId=<id>` propagation at request ingress (chat-stack ALB → ECS)
   - Keep custom `Chimera/Tenant` and `Chimera/Skills` emitters (they provide the tenant dimension AgentCore lacks)
   - Delete the "defined but never emitted" `Chimera/Tenant` and `Chimera/Skills` metric definitions from `observability-stack.ts` dashboards and replace with references to `bedrock-agentcore` metrics for aggregate counts

2. **Evaluations wiring (3 days):**
   - Create 3 online evaluators: `Correctness` (TRACE), `ToolSelectionAccuracy` (TOOL_CALL), `GoalSuccessRate` (SESSION) — use defaults
   - Set sampling to 10% (matches our existing A/B default in `prompt-optimizer.ts:161`)
   - Delete `runTestCase()` stub from `prompt-optimizer.ts`
   - Replace `testPromptVariant()` with `client.evaluate({ evaluatorId, evaluationTarget: { traceIds } })` against a span-tagged variant

3. **Flywheel glue (2 days):**
   - New Lambda `evaluation-aggregator` subscribes to evaluation-result CloudWatch Logs stream
   - Parses `{ variantId, traceId, scores }` → averages to `qualityScore` → calls `promptOptimizer.recordVariantOutcome()`
   - Tag spans with `chimera.variant.id` attribute at the point of `selectPromptVariant()` call so the aggregator can attribute scores back to experiments

4. **Self-reflection wiring (1 day):**
   - Feed Evaluations aggregate scores into `self-reflection.ts:calculateHealthScore()` via a new `getQualityMetrics()` reader
   - Keep existing `metrics.correctionRate` string-match signal (free, fast) as a cross-check

**Total effort: ~2 weeks.** Payback: eliminates the "quality score is stubbed" gap blocking the entire evolution loop from producing real signal.

---

## Sources

### AWS documentation
- `docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html` — Runtime/Memory/Gateway/Tools metrics, span attributes, log types, Transaction Search setup
- `docs.aws.amazon.com/bedrock-agentcore/latest/devguide/evaluations.html` — built-in evaluators, placeholder reference, on-demand vs online, SDK/CLI/boto3 surface
- `docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/` — `bedrock-agentcore-control` (CreateEvaluator, ListEvaluators, GetEvaluator) and `bedrock-agentcore` (Evaluate) APIs
- `aws.amazon.com/bedrock/pricing` — Bedrock FM pricing (used as baseline for judge-model cost estimate; AgentCore-specific pricing was not accessible at research time)

### Chimera source code
- `infra/lib/observability-stack.ts` — 1100 lines; 4 dashboards, 7 alarm families, Cost Publisher Lambda, PITR composite
- `packages/core/src/billing/cost-tracker.ts` (361 lines) — monthly aggregation, per-service breakdown, token tracking
- `packages/core/src/billing/budget-monitor.ts` (321 lines) — threshold alerts, burn-rate projections, health score
- `packages/core/src/evolution/prompt-optimizer.ts` (481 lines) — A/B traffic split, outcome tracking, **stubbed `runTestCase()` at line 447**
- `packages/core/src/evolution/model-router.ts` (660 lines) — Thompson Sampling, per-tier allowlist, `enforceTierCeiling`
- `packages/core/src/evolution/experiment-runner.ts` (433 lines) — Step Functions-orchestrated hyperparameter search
- `packages/core/src/evolution/self-reflection.ts` (496 lines) — health score calculation, throttle decisions, action recommendations
- `packages/core/src/evolution/safety-harness.ts` (399 lines) — Cedar + rate limits for evolution ops
- `packages/core/src/evolution/self-evolution-orchestrator.ts` (529 lines) — CDK gen → CodeCommit → CodePipeline flow
- `docs/reviews/cost-observability-audit.md` — 2026-04-17 audit enumerating 11 missing metrics, 5 cost hotspots, 4 dashboard gaps
- `docs/research/evolution/01-Prompt-Model-Optimization.md` — prior research on the evolution loop
