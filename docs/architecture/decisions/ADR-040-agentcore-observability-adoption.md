---
status: proposed
date: 2026-04-26
deciders: baladita
tracked-as: chimera-301e
---

# ADR-040: Adopt AgentCore Observability (via ADOT) for chat-gateway

## Context

Wave 22-25 live browser validation exposed a pattern of bugs that are
all invisible without distributed tracing on the agent request path:

- `chimera-cd16` (fixed Wave-25) — system prompt leaked `tenant_id`.
  Debug required manual CloudWatch log tailing + guessing at what
  template value the model saw.
- `chimera-5d66` (fixed Wave-25) — agent hallucinated tool use
  instead of invoking. Debug required checking ECS logs for absence
  of `tool_use` content blocks.
- `chimera-e026` (new, Wave-25) — agent has no conversation memory.
  Needs visibility into the `messages` array sent to Bedrock.
- Future: any prompt-template change (multi-region, memory
  namespace, tier-conditional instructions) risks silent regressions
  without runtime visibility.

Today we have:

- **CloudWatch Logs (stdout/stderr)** — tailed manually.
- **EMF metrics** (latency, cost, tier violations) — aggregate only.
- **No distributed traces.**
- **No GenAI semantic conventions** (`gen_ai.system_instructions`,
  `gen_ai.conversation.messages`, `gen_ai.tool.calls`).
- **No session ID correlation across turns.**

User prompt during Wave-25 triage: "since we are using agentcore
should we use agentcore observability? could that help?"

## Decision

**Yes.** Adopt Amazon Bedrock AgentCore Observability on the
chat-gateway service using the ADOT (AWS Distro for OpenTelemetry)
Node autoinstrumentation path. This delivers:

1. **CloudWatch GenAI Observability dashboard** — pre-built views for
   session count, token usage, latency, error rates, error breakdowns.
2. **Transaction trace search** — pull any user interaction by
   session_id + see full request → LLM call → tool call → memory
   read/write.
3. **Generative-AI semantic conventions** on every span:
   - `gen_ai.system.name` (model id)
   - `gen_ai.system_instructions` (system prompt as actually sent)
   - `gen_ai.conversation.messages` (full message array)
   - `gen_ai.tool.calls` (what tools were invoked, with args)
   - `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
4. **Session-ID baggage propagation** — `session.id` set in OTEL
   baggage correlates per-turn traces into a single logical session.

## Scope

- **In scope:** chat-gateway ECS service. This is where every
  user-visible chat interaction flows through (`POST /chat/stream`).
- **Out of scope (Phase 2):** Strands tool bridge, ChimeraAgent-
  internal memory ops, the Python-side agents package (separate
  instrumentation path — AgentCore Runtime native).

## Design

### Not-AgentCore-Runtime path

Chimera's chat-gateway runs on **ECS Fargate**, not AgentCore Runtime.
Per the AgentCore docs "Enabling observability for agents hosted
outside of AgentCore", this requires:

1. **Account-level one-time setup** (already run? check first):

    ```bash
    # Enable CloudWatch Transaction Search
    aws logs put-resource-policy --policy-name ChimeraXRayAccess \
      --policy-document file://xray-policy.json
    aws xray update-trace-segment-destination --destination CloudWatchLogs
    # (Optional) sample at 100% for dev, 10% for prod
    aws xray update-indexing-rule --name Default \
      --rule '{"Probabilistic":{"DesiredSamplingPercentage":100}}'
    ```

2. **Node ADOT autoinstrumentation** — add dev + runtime dep:

    ```bash
    bun add @aws/aws-distro-opentelemetry-node-autoinstrumentation
    ```

3. **ECS task definition env vars** — CDK change in
   `infra/lib/chat-stack.ts`:

    ```typescript
    environment: {
      ...,
      // AgentCore Observability (ADR-040)
      AGENT_OBSERVABILITY_ENABLED: 'true',
      OTEL_RESOURCE_ATTRIBUTES:
        `service.name=chimera-chat-gateway,service.version=${props.envName},` +
        `aws.log.group.names=/chimera/${props.envName}/ecs/chat-gateway,` +
        `cloud.resource_id=chimera-chat-gateway-${props.envName}`,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS:
        `x-aws-log-group=/chimera/${props.envName}/ecs/chat-gateway,` +
        `x-aws-log-stream=otel-logs,x-aws-metric-namespace=chimera-agent`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_TRACES_EXPORTER: 'otlp',
      NODE_OPTIONS: '--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register',
    },
    ```

4. **Session-ID propagation** — wrap agent invocation in OTEL baggage:

    ```typescript
    // packages/chat-gateway/src/routes/chat.ts
    import { context, baggage as otelBaggage } from '@opentelemetry/api';

    const bag = otelBaggage.setBaggage(
      context.active(),
      otelBaggage.createBaggage({
        'session.id': { value: sessionId },
        'tenant.id': { value: tenantContext.tenantId },
      }),
    );
    await context.with(bag, async () => {
      const agentStream = agent.stream(lastMessage.content);
      // ... existing stream plumbing
    });
    ```

5. **IAM grants** on the ECS task role — the autoinstrumentation
   already uses the task role's AWS credentials; add:

    ```typescript
    actions: [
      'xray:PutTraceSegments',
      'xray:PutTelemetryRecords',
      'logs:PutLogEvents',  // OTEL logs exporter
    ],
    resources: ['*'],
    ```

### Cost + volume

- Per-request overhead: ~5-10ms for OTEL instrumentation,
  negligible against Bedrock latency (~200-500ms first token).
- Trace volume: at 100% sampling with 10 req/s → ~25M spans/month.
  CloudWatch Logs ingest at $0.50/GB. Expect ~$10/month in dev.
- Reduce to 10% probabilistic sampling in prod once dashboards are
  dialed in.

## Consequences

### Positive

- **Debug time collapses** for prompt-engineering and memory bugs.
  `chimera-e026` goes from "tail logs and guess" to "open trace,
  see one message, fix."
- **Pre-built dashboard** — no custom-grafana effort.
- **Token cost attribution** — automatic, per session.
- **Future-ready** — when/if Chimera migrates partially to AgentCore
  Runtime (rabbithole research verdict: PARTIAL-ADOPT), the same
  Observability surface carries over.

### Negative / trade-offs

- **Adds ADOT dep** — ~50MB node_modules bloat for the chat-gateway
  Docker image. Acceptable (image was 600MB+ already).
- **Vendor lock-in** to CloudWatch GenAI Observability. Mitigation:
  OTEL spans are exportable to any OTLP-compatible backend. We could
  export to a different collector in the future without re-
  instrumenting code.
- **$10/month dev cost** — trivial vs debug time saved.

## Alternatives considered

| Option | Why not chosen |
|--------|----------------|
| X-Ray sidecar + `aws-sdk-instrumentation` | Traces distributed calls but doesn't capture `gen_ai.*` attributes. Strictly less information than ADOT. |
| Pure OpenTelemetry + self-hosted collector | Works but we'd have to build the dashboards. CloudWatch GenAI Observability gives them free. |
| Structured-log emit (log the system prompt + messages + tool calls) | Fast to implement (1-2h) but gives a flat log stream, not a trace tree. Misses parent-child relationships. Useful as an interim if ADR-040 implementation slips. |
| Do nothing | Untenable — 3 bugs in Waves 24-25 lost days of debug time that tracing would have saved. |

## References

- `docs/reviews/WAVE-RETROSPECTIVE-25.md` — drove the decision
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html
- https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/GenAI-observability.html
- OTEL GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/

## Acceptance criteria

- [ ] CloudWatch Transaction Search enabled (one-time)
- [ ] `bun add @aws/aws-distro-opentelemetry-node-autoinstrumentation` in `packages/chat-gateway`
- [ ] ECS task def env vars set (infra/lib/chat-stack.ts)
- [ ] IAM grants added to taskRole
- [ ] Session-ID baggage wiring in routes/chat.ts
- [ ] Verified in CloudWatch GenAI Observability dashboard — at
  least one trace visible per live chat turn
- [ ] `gen_ai.conversation.messages` attribute visible in
  CloudWatch Logs Insights for a chat turn
- [ ] Closes Seeds chimera-301e
