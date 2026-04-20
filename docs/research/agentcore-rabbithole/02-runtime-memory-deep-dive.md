---
title: "AgentCore Runtime + Memory — Deep Dive"
version: 1.0.0
status: research
last_updated: 2026-04-17
research_cycle: agentcore-rabbithole/02
primary_sources:
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-service-provided.html
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html
  - https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html
  - PyPI bedrock-agentcore 1.4.7 (packages/agents/uv.lock)
---

# AgentCore Runtime + Memory — Deep Dive

## TL;DR for Chimera

Chimera's Python agent at `packages/agents/chimera_agent.py` runs on AgentCore Runtime, but the codebase still carries four classes of hand-rolled scaffolding that AgentCore now covers natively:

1. **Session management** — `packages/core/src/runtime/agentcore-runtime.ts` (370 LOC) defines a `RuntimeSession` interface, `generateSessionId()`, `createSession()`, `resumeSession()`, `terminateSession()`, and `storeMemory`/`retrieveMemory` placeholders. **All of these are already provided by AgentCore Runtime**: sessions are identified by a client-supplied `runtimeSessionId`, each runs in an isolated microVM, idle-terminate after 15 minutes, and max-terminate after 8 hours. There is no "resumeSession" semantic — a new request with the same `runtimeSessionId` after termination just starts a new microVM.
2. **Memory namespace scheme** — `packages/core/src/memory/namespace.ts` hand-rolls `tenant-{tenantId}-user-{userId}` and `tenant-{tenantId}-user-{userId}-session-{sessionId}` strings. **AgentCore's actual namespace contract is hierarchical and slash-delimited**: `/strategy/{memoryStrategyId}/actor/{actorId}/session/{sessionId}/` with a mandatory trailing slash. Chimera's flat-string format doesn't map cleanly to AgentCore's IAM condition keys (`bedrock-agentcore:namespace`, `bedrock-agentcore:actorId`, `bedrock-agentcore:sessionId`) and therefore can't use AWS-native IAM to enforce per-tenant namespace isolation — it has to rely on application-layer filtering instead.
3. **Tiered memory client** — `packages/core/src/memory/tiered-client.ts` (283 LOC) implements a SESSION/SWARM/AGENT scope abstraction with `InMemoryClient` mocks, but `createAgentCoreClient()` literally throws `'AgentCore TieredMemoryClient not yet implemented'`. AgentCore has no notion of "swarm" memory — the closest equivalent is a shared `actorId` across agents or an actor-level namespace. The SWARM tier is a Chimera invention that either needs to be built on top of AgentCore Memory's actor model or removed.
4. **Memory strategy enumeration** — Chimera's TypeScript types at `packages/core/src/memory/types.ts:13` declare `type MemoryStrategy = 'SUMMARY' | 'USER_PREFERENCE' | 'SEMANTIC'` and the Python agent at `chimera_agent.py:203` passes strings `['SUMMARY', 'USER_PREFERENCE', 'SEMANTIC_MEMORY']` to `AgentCoreMemorySessionManager`. **The actual AgentCore type identifiers are `semanticMemoryStrategy`, `userPreferenceMemoryStrategy`, `summaryStrategy`, `episodicMemoryStrategy`, and `customMemoryStrategy`**. Chimera is missing `episodicMemoryStrategy` (reflection / cross-episode pattern analysis) and `customMemoryStrategy` (self-managed via S3+SNS pipeline) from its tier configuration.

**The single biggest insight:** the entire `packages/core/src/runtime/agentcore-runtime.ts` file (370 LOC of session/memory placeholders) is dead code. The Python entrypoint in `chimera_agent.py` already delegates session lifecycle to AgentCore Runtime via the `@entrypoint` decorator. The TypeScript layer that calls `AgentCoreRuntime.createSession()` from `packages/core/src/tenant/` doesn't actually manage AgentCore sessions — AgentCore does. Delete the file, remove the callers, let AgentCore own it.

---

## Runtime

### Architecture

AgentCore Runtime executes each session inside a **dedicated Firecracker-class microVM with isolated CPU, memory, and filesystem**. Quoting [agents-tools-runtime.html](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html):

> "In AgentCore Runtime, each user session runs in a dedicated microVM with isolated CPU, memory, and filesystem resources. This helps create complete separation between user sessions, safeguarding stateful agent reasoning processes and helps prevent cross-session data contamination. After session completion, the entire microVM is terminated and memory is sanitized, delivering deterministic security even when working with non-deterministic AI processes."

**Isolation boundary is per-session, not per-tenant.** Two sessions from the same tenant run in two different microVMs. Cross-session data leakage via shared disk/memory is structurally impossible — the microVM is destroyed after the session ends.

**Container requirement:** ARM64 only. Host `0.0.0.0`, port depends on protocol:

| Protocol | Port | Mount Path |
|----------|------|------------|
| HTTP | 8080 | `/invocations`, `/ws`, `/ping` |
| MCP | 8000 | `/mcp` |
| A2A | 9000 | `/` |
| AGUI | 8080 | `/invocations` (SSE), `/ws` |

Chimera's `packages/agents/Dockerfile` exposes 8080 and uses HTTP protocol — matches.

### Cold start + warm pool

Documentation **acknowledges cold starts** but does not quantify them and **does not expose a warm-pool API**. The only lever the agent controls is `Mcp-Session-Id` / `runtimeSessionId` stickiness:

> "Without a consistent session ID, each request may be routed to a new microVM, which may result in additional latency due to cold starts."

There is no `ProvisionedConcurrency` equivalent. If you need low p99 latency, your options are:

- Reuse the same `runtimeSessionId` across invocations (microVM stays warm during the idle window)
- Keep the session in `HealthyBusy` state via the `/ping` response (runtime keeps the microVM alive for background work)

### Session lifecycle

From the session management docs:

| State | Trigger | Duration |
|-------|---------|----------|
| **Active** | Processing a request or background work (`HealthyBusy` ping) | — |
| **Idle** | No requests; maintaining context | Up to **15 minutes** before termination |
| **Terminated** | Inactivity >15 min, max lifetime >8 hours, or unhealthy | — |

**Max total runtime: 8 hours per session.** After termination, a subsequent request with the same `runtimeSessionId` creates a **new** execution environment — there is no persistent resume. Any state you need across the 8-hour boundary must live in AgentCore Memory, DynamoDB, or S3.

**Session ID contract:** client-supplied via the `runtimeSessionId` parameter to `InvokeAgentRuntime`, or auto-generated by Runtime on first invocation if omitted. Propagated to the container via the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` HTTP header.

### Resource limits

Explicitly documented numbers (from agents-tools-runtime.html):

- **Max session lifetime:** 8 hours
- **Idle timeout:** 15 minutes
- **Max payload size:** 100 MB
- **Max async workload duration:** 8 hours

CPU/memory per microVM are **not** published as hard numbers in developer docs — they are metered via the `CPUUsed-vCPUHours` and `MemoryUsed-GBHours` vended metrics. AWS's billing page (not accessible via WebFetch in this research cycle) is the authoritative source for per-microVM sizing.

### Network modes

Two modes, selected via `networkConfiguration` on `CreateAgentRuntime`:

- **PUBLIC** — internet egress, no VPC integration
- **VPC** — specify `subnetIds` and `securityGroupIds`; runtime attaches an ENI into your VPC

Chimera already exercises the **same mechanism** in the Code Interpreter tool (`infra/lib/chat-stack.ts:270`) via `bedrock-agentcore:CreateCodeInterpreterSession`. The runtime control plane is the same service; network config is per-runtime-resource.

### Observability

AgentCore Runtime auto-emits to the **`bedrock-agentcore`** (and also `Bedrock-AgentCore`) CloudWatch metric namespace at **1-minute batching intervals**. Service-provided metrics:

| Metric | Description |
|--------|-------------|
| `Invocations` | Total Data Plane API requests |
| `Throttles` | 429 ThrottlingException count |
| `SystemErrors` | Server-side (5xx) errors |
| `UserErrors` | Client-side (4xx except 429) errors |
| `Latency` | End-to-end request time |
| `TotalErrors` | System + user, shown as % of invocations in console |
| `SessionCount` | Total agent sessions |
| `ActiveStreamingConnections` | **WebSocket only** — current open WS count |
| `InboundStreamingBytesProcessed` / `OutboundStreamingBytesProcessed` | WS throughput |

Vended resource-usage metrics (per-agent, per-endpoint):

- `CPUUsed-vCPUHours` (dimensions: Service, Resource, Name)
- `MemoryUsed-GBHours` (same dimensions)

Vended session-level logs at **1-second granularity** (`USAGE_LOGS` log type) with fields:

```
event_timestamp, resource_arn, service.name, cloud.provider, cloud.region,
account.id, region, resource.id, session.id, agent.name,
elapsed_time_seconds, agent.runtime.vcpu.hours.used,
agent.runtime.memory.gb_hours.used
```

Default log group: `/aws/bedrock-agentcore/runtimes/{agent-id}`.
Default spans log group: `aws/spans`.

Span attributes emitted for `InvokeAgentRuntime`: `aws.operation.name, aws.resource.arn, aws.request_id, aws.agent.id, aws.endpoint.name, aws.account.id, session.id, latency_ms, error_type, aws.resource.type, aws.xray.origin, aws.region`.

**Prerequisite:** one-time enablement of CloudWatch Transaction Search. Must call `UpdateTraceSegmentDestination --destination CloudWatchLogs` and grant `xray.amazonaws.com` write access to `aws/spans` and `/aws/application-signals/data` log groups.

**Custom observability:** add the AWS Distro for OpenTelemetry (ADOT) SDK — `aws-opentelemetry-distro>=0.10.0`. Container entrypoint becomes `CMD ["opentelemetry-instrument", "python", "main.py"]`. Chimera's Dockerfile currently uses `CMD ["uv", "run", "python", "-m", "bedrock_agentcore.runtime"]` — to pick up custom Strands spans in CloudWatch GenAI Observability, this needs to be wrapped in `opentelemetry-instrument`.

### Pricing

Documentation accessible in this research cycle does not quote $ amounts (the pricing page was not reachable via WebFetch in this session). The billing model, from docs, is consumption-based:

> "The service aligns CPU billing with actual active processing — typically eliminating charges during I/O wait periods when agents are primarily waiting for LLM responses — while continuously maintaining your session state."

Billing units confirmed from metrics: **vCPU-hours and GB-hours**, metered per session. I/O wait (waiting for Bedrock InvokeModel) is not billed as active CPU. This is meaningfully cheaper than ECS Fargate's "pay for the task while it exists" model for agent workloads that are mostly LLM-bound.

### Deployment

Deployment follows the **ECR → CreateAgentRuntime → versions/aliases** model (docs for `runtime-deploy.html` were not accessible in this cycle, but this is confirmed by IAM policies granting `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` to the runtime execution role).

Chimera's pipeline at `infra/lib/pipeline-stack.ts:79` already creates an ECR repository `chimera-agent-runtime-{envName}` — this is the right primitive. What's **missing** from the CDK is the actual `CfnAgentRuntime` resource (or a CustomResource invoking `CreateAgentRuntime`). Chimera has the container pipeline but not the runtime registration — the README says the agent runs on AgentCore Runtime, and the pyproject.toml + Dockerfile match, but no CDK stack in `infra/lib/` actually creates an AgentRuntime resource. This is likely done manually or via the AgentCore CLI outside CDK.

Blue/green and canary are supported via **alias routing configuration** (from training knowledge — AWS CLI examples show `create-agent-runtime-alias --routing-configuration '[{agentRuntimeVersion:3,weight:90},{agentRuntimeVersion:4,weight:10}]'`). This is the GA pattern for any AWS managed service with immutable versions + mutable aliases (Lambda, SageMaker endpoints, etc.).

### Entrypoint contract

The Python SDK contract, as used in `chimera_agent.py:22-78`:

```python
from bedrock_agentcore.runtime import BedrockAgentCoreApp, entrypoint

app = BedrockAgentCoreApp()

@entrypoint
async def handle(context) -> AsyncIterator[str]:
    tenant_id = context.auth.claims.get('tenantId')
    ...
    async for chunk in agent.stream(context.input_text):
        yield chunk
```

What `@entrypoint` does under the hood (inferred from SDK + HTTP service contract):

1. Registers an async handler at `POST /invocations` (port 8080).
2. Parses the incoming JSON body; exposes it on `context.input_text` (and the full request on `context`).
3. Extracts OAuth/JWT claims from the `Authorization` header (when runtime is configured with `authorizerConfiguration`); exposes them on `context.auth.claims`.
4. If the handler is an async generator (yields chunks), SDK serves the response as **SSE** (`Content-Type: text/event-stream`) with each `yield`ed value wrapped in `data: {...}\n\n`. Non-generator async functions get JSON response.
5. Runs a `/ping` endpoint automatically returning `Healthy` / `HealthyBusy`.
6. Propagates the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header into `context.session`.

**Chimera's current usage is correct** but doesn't take full advantage of the session header. The `tenant_id` is pulled from `context.auth.claims` (correct), but `context.session` is referenced in a comment and never read. For multi-turn conversations, Chimera should be using the Runtime session ID as the Strands session identifier, which ties into Memory's `sessionId` namespace component.

---

## Memory

### Strategies

AgentCore Memory supports **five strategy types** (only three are wired up in Chimera):

| Strategy (SDK type) | Steps | Output format | Default namespace |
|---------------------|-------|---------------|-------------------|
| `semanticMemoryStrategy` | Extraction + Consolidation | JSON facts array | `/strategy/{strategyId}/actors/{actorId}/` |
| `userPreferenceMemoryStrategy` | Extraction + Consolidation | JSON with `{context, preference, categories[]}` | `/strategy/{strategyId}/actors/{actorId}/` |
| `summaryStrategy` | Consolidation only | XML `<topic>` tags | `/strategy/{strategyId}/actor/{actorId}/session/{sessionId}/` |
| `episodicMemoryStrategy` | Extraction + Consolidation + **Reflection** | XML episodes + cross-episode reflections | `/strategy/{strategyId}/actor/{actorId}/` |
| `customMemoryStrategy` (`selfManagedConfiguration`) | User-defined | User-defined | User-defined |

Key behaviors:

- **Semantic** stores standalone factual sentences. Consolidation ops: `AddMemory`, `UpdateMemory`, `SkipMemory`.
- **UserPreference** explicitly skips PII, harmful content, and temporary states. Stores `{context, preference, categories[]}`.
- **Summary requires `sessionId`** in the namespace. Per-session chunked summaries — multiple chunks per session possible, produces both `<global_summary>` and `<delta_detailed_summary>`.
- **Episodic** waits for "episode completion" detection before emitting records. Records indexed on "intent" for episodes and "use case" for reflections. Latency is **higher and variable** — records only materialize once an episode is detected as complete.
- **Self-Managed** triggers on `messageCount`, `tokenCount`, or `idleSessionTimeout`. Delivers payload to S3, notifies via SNS. You ingest results via `BatchCreateMemoryRecords`/`BatchUpdateMemoryRecords`/`BatchDeleteMemoryRecords`. Lower storage cost than built-ins but LLM costs are billed to your account.

**If no strategies are specified, no long-term records are extracted.** Only the raw event stream (STM) is retained for `eventExpiryDuration` days.

### Namespace model

The canonical format is hierarchical and slash-delimited:

```
/strategy/{memoryStrategyId}/actor/{actorId}/session/{sessionId}/
```

Rules:

- **Must end with trailing slash** — prevents prefix collisions (`/actors/Alice/` vs `/actors/Alice-admin`).
- Granularity levels, most → least specific:
  - `/strategy/{id}/actor/{actorId}/session/{sessionId}/` — session-scoped
  - `/strategy/{id}/actor/{actorId}/` — actor-scoped (cross-session for this user)
  - `/strategy/{id}/` — strategy-scoped (all users)
  - `/` — global

**Multi-tenancy pattern** (from docs): use `actorId` as tenant identifier. Enforce isolation via IAM condition keys on `bedrock-agentcore:RetrieveMemoryRecords`:

```json
{
  "Effect": "Allow",
  "Action": ["bedrock-agentcore:RetrieveMemoryRecords"],
  "Resource": "arn:aws:bedrock-agentcore:us-east-1:111122223333:memory/{memory_id}",
  "Condition": {
    "StringLike": {
      "bedrock-agentcore:namespace": "/strategy/*/actor/tenant-xyz/*"
    }
  }
}
```

Available IAM context keys: `namespace`, `actorId`, `sessionId`.

**Chimera's current pattern** (`generateNamespace` in `packages/core/src/memory/namespace.ts`):

```
tenant-{tenantId}-user-{userId}
tenant-{tenantId}-user-{userId}-session-{sessionId}   // SESSION scope
tenant-{tenantId}-swarm-{swarmId}                      // SWARM scope
tenant-{tenantId}-agent-{agentId}                      // AGENT scope
```

This is **wrong for AgentCore**. Chimera's format:
- Has no leading or trailing slash, so IAM `StringLike` conditions on `bedrock-agentcore:namespace` won't match.
- Bakes tenant into the actorId by concatenation rather than using `actorId` as the tenant ID.
- Invents a "swarm" scope that has no AgentCore equivalent.
- Uses the strategy-less path, so requests fail to scope by strategy.

The Python agent passes this bad format directly to `AgentCoreMemorySessionManager(namespace=f"tenant-{tenant_id}-user-{user_id}")` at `chimera_agent.py:172`. The Strands integration probably silently accepts any string, but IAM-level tenant isolation will not work as expected.

### Retention + privacy

- **`eventExpiryDuration`** is set at `CreateMemory` time (docs show `--event-expiry-duration 90` in examples, valid range 1–3650 days). Controls short-term event retention.
- **Long-term record deletion APIs:**
  - `DeleteMemoryRecord` (single)
  - `BatchDeleteMemoryRecords` (bulk)
- **Automatic deletion triggers:** long-term consolidation de-duplication fires `MemoryRecordDeleted` stream events (Kinesis Data Stream, push-based).

**GDPR right-to-be-forgotten:** the deletion APIs exist (`DeleteMemory` for the whole memory, `BatchDeleteMemoryRecords` for tenant records) but **AWS does not publish a formal "right-to-erasure" workflow or SLA**. Chimera needs its own runbook: on tenant offboarding, call `BatchDeleteMemoryRecords` with the tenant's namespace prefix, then `DeleteMemory` if it's a dedicated memory resource.

### Quotas

**Not published** in the devguide content reached this cycle. Known unknowns:
- Max memory records per namespace
- Max namespaces per memory instance
- Concurrent read/write TPS
- API rate limits

These must be looked up in the AWS Service Quotas console under `Amazon Bedrock AgentCore`.

### Embedding

**Not documented which embedding model powers `RetrieveMemoryRecords` semantic search.** No BYO embedding capability is mentioned in the devguide. Built-in strategies may use **cross-region inference automatically at no additional cost** (quoted from docs), which suggests Bedrock Titan Embed or similar is used server-side but is not user-selectable.

Chimera's types file at `packages/core/src/memory/types.ts:59` declares a configurable `embeddingModel?: string` default `titan-embed-text-v2` with `vectorDimensions?: 1024`. **This is aspirational — AgentCore Memory does not expose embedding model selection.** The field is meaningless unless Chimera implements its own semantic layer on top of (or instead of) `RetrieveMemoryRecords`.

### Data plane API

**Short-term (events):**
- `CreateEvent` — write (actorId, sessionId, payload, metadata)
- `GetEvent` / `ListEvents` / `ListSessions` — read
- Metadata filtering supported: `ListEvents(filters={"destination": "Seattle"})`
- Event metadata is **not encrypted with CMK** (per docs)

**Long-term (records):**
- `GetMemoryRecord`, `ListMemoryRecords` (namespace-prefix filter)
- `RetrieveMemoryRecords` — semantic search over records
- `BatchCreateMemoryRecords` / `BatchUpdateMemoryRecords` / `BatchDeleteMemoryRecords` (used by self-managed strategy)
- `DeleteMemoryRecord` (single)

**Control plane:** `CreateMemory`, `UpdateMemory`, `DeleteMemory`.

**Streaming (Kinesis):** `MemoryRecordCreated`, `MemoryRecordUpdated`, `MemoryRecordDeleted`. Content levels: `METADATA_ONLY` or `FULL_CONTENT`.

**Consistency model:**
- Short-term events: immutable, append-only, effectively eventually consistent for downstream LTM extraction
- Long-term extraction: **asynchronous** — not immediately consistent after `CreateEvent`
- Batch APIs (self-managed): synchronous writes
- No strong consistency guarantee documented for cross-operation reads

### Cost

**Not documented in the devguide pages accessed this cycle.** Cost signals from docs:
- Built-in strategies: "Higher cost for storage"
- Built-in with overrides: "Lower cost for storage + your own LLM costs"
- Self-managed: "Lower cost for storage" (you own LLM + S3)
- Cross-region inference: no additional cost

Chimera's hand-estimated pricing in `packages/core/src/memory/types.ts:18` (`basic: ~$0.50/mo`, `advanced: ~$2/mo`, `professional: ~$8/mo`) and in `packages/core/src/runtime/agentcore-runtime.ts:366` (`basic: ~$5`, `advanced: ~$15`, `premium: ~$30`) are **both made up** — neither is sourced from the AWS pricing page. These figures should be removed from the code and confirmed against the pricing page before any customer-facing billing.

---

## What Chimera hand-rolls that AgentCore now covers

| Chimera code | LOC | AgentCore primitive | Recommendation |
|--------------|-----|---------------------|----------------|
| `packages/core/src/runtime/agentcore-runtime.ts` — `AgentCoreRuntime` class with `createSession`, `resumeSession`, `terminateSession`, `storeMemory`, `retrieveMemory`, `queryMemory`, `invokeAgent`, `getSessionHistory`, `deleteSession` | 370 | `InvokeAgentRuntime` API + microVM auto-lifecycle + Memory data plane | **Delete the file.** Every method is either a TODO placeholder or reinvents AgentCore. The Python entrypoint `chimera_agent.py` already bypasses this layer. |
| `packages/core/src/memory/tiered-client.ts` — SESSION/SWARM/AGENT scope multiplexer with `InMemoryClient` backend | 283 | AgentCore Memory namespaces + `actorId`/`sessionId` IAM conditions | **Delete or rewrite.** `createAgentCoreClient()` literally throws. Keep the InMemoryClient for local dev tests; nuke the rest and let `AgentCoreMemorySessionManager` from the Python SDK do the real work. |
| `packages/core/src/memory/namespace.ts` — flat-string namespace generator `tenant-{X}-user-{Y}` | 248 | Hierarchical `/strategy/{id}/actor/{actorId}/session/{sessionId}/` + IAM conditions | **Rewrite.** Use AgentCore's slash-delimited format. Maps `tenantId` → `actorId`, adds mandatory trailing slash. Adopt IAM policy-based tenant isolation. |
| `packages/core/src/memory/client.ts` — `MemoryClient` interface with `storeMessage`, `retrieve`, `getSession`, `updateSession`, `clearNamespace` | 124 | `CreateEvent`, `RetrieveMemoryRecords`, `ListEvents` (no session state — that's the microVM's job) | **Shrink.** Session state persistence is not Chimera's responsibility — the microVM holds it and AgentCore Memory holds the cross-session view. |
| `packages/core/src/memory/types.ts` — `MemoryStrategy = 'SUMMARY' \| 'USER_PREFERENCE' \| 'SEMANTIC'`, configurable `embeddingModel` field | 211 | Real strategies: `semanticMemoryStrategy`, `userPreferenceMemoryStrategy`, `summaryStrategy`, `episodicMemoryStrategy`, `customMemoryStrategy`. No BYO embedding. | **Align types.** Rename enum values to match SDK. Drop `embeddingModel`/`vectorDimensions`/`similarityThreshold` fields — they are ignored by AgentCore. |
| `RuntimeSession` interface and `generateSessionId()` in `packages/core/src/runtime/agentcore-runtime.ts:137,324` | — | `runtimeSessionId` header; auto-gen by Runtime if omitted | **Delete.** Clients pass `runtimeSessionId` into `InvokeAgentRuntime`; there's no need to generate it client-side in TypeScript. |
| Manual CloudWatch metric/log setup in observability stack (`infra/lib/observability-stack.ts`) for agent session metrics | ? | Vended `bedrock-agentcore` namespace metrics + `USAGE_LOGS` + `APPLICATION_LOGS` + `aws/spans` | **Replace hand-rolled dashboards with GenAI Observability.** Subscribe to the vended namespace in CloudWatch alarms. |
| `chimera_agent.py:114` `agentcore_memory_id` stored per-tenant in DynamoDB, implying one memory resource per tenant | — | One memory resource can host many actors/sessions/strategies via namespaces | **Simplify.** Use a single shared memory resource with per-tenant `actorId` scoping rather than one memory-per-tenant. Reduces control-plane cost and memory-resource quota pressure. Optional: dedicated memory per premium-tier tenant for physical isolation. |

**Session resume semantics worth naming explicitly.** Chimera's `RuntimeSession.resumeSession(sessionId)` throws "Session resumption not yet implemented". AgentCore has **no resume**. After the 15-minute idle timeout or the 8-hour max, the microVM is destroyed. Reusing the same `runtimeSessionId` just starts a new microVM with no carried-over in-memory state. Anything agents need to recover from is recovered from **Memory** (events + long-term records), not from a resumed microVM. Document this explicitly: "there is no resume — only Memory."

---

## What Chimera still needs on top

AgentCore does **not** cover:

1. **Tenant configuration storage.** The `chimera-tenants` DynamoDB table (tier, features, allowedModels, monthlyBudget) has no AgentCore equivalent. Keep `load_tenant_config()` in `chimera_agent.py:84`.
2. **Tier-based model routing.** `select_model_for_tier()` picks Nova Lite / Sonnet / Opus per tenant tier. AgentCore doesn't do model selection — your agent does. Keep it.
3. **Gateway tool proxying (`gateway_proxy.py`).** AgentCore Gateway handles MCP/Lambda/OpenAPI targets, but the per-tenant tier-gated tool selection logic and the prompt-injection delimiter envelope (`_format_tool_result`, `_format_tool_error`) are Chimera-specific. Keep.
4. **Rate limiting per tenant (`rate-limiter.ts`).** AgentCore emits `Throttles` but doesn't do per-tenant token bucket enforcement. DynamoDB-backed limiter stays.
5. **Cedar authorization (`cedar-authorization.ts`, 455 LOC).** AgentCore has IAM but not Cedar policies. Keep.
6. **Cost attribution (`cost-attribution-service.ts`, 459 LOC).** The vended `CPUUsed-vCPUHours` / `MemoryUsed-GBHours` metrics give you compute cost but not per-tenant attribution or model-invocation cost splits. Keep but cross-reference vended metrics to avoid double-counting.
7. **Self-evolution pipeline.** CDK synthesis, CodePipeline deploys, `trigger_infra_evolution` tool — entirely Chimera-specific. Keep.
8. **Budget enforcement.** `monthlyBudget` / `currentSpend` checks. Keep.
9. **SWARM memory for multi-agent collaboration.** If Chimera actually needs cross-agent shared memory for its swarm feature, build it as an actor-level namespace (`/strategy/{id}/actor/swarm-{swarmId}/`) — but be aware that the "SWARM" name has no AgentCore meaning, it's just a shared actor.
10. **Prompt-injection fencing in `system_prompt.py`.** `wrap_untrusted_content` and the `[END TRUSTED SYSTEM PROMPT]` delimiter — not something AgentCore does. Keep.

---

## Recommendations for Chimera

### 1. Delete dead code

```
rm packages/core/src/runtime/agentcore-runtime.ts   # 370 LOC of placeholders
rm packages/core/src/memory/tiered-client.ts        # 283 LOC, createAgentCoreClient throws
# Keep packages/core/src/memory/in-memory-client.ts only for local dev tests
```

The Python entrypoint at `chimera_agent.py` is the real runtime boundary. Nothing in TypeScript needs to talk to `InvokeAgentRuntime` directly — the runtime is invoked from outside (the API layer calls `InvokeAgentRuntime` via `@aws-sdk/client-bedrock-agentcore`, the container handles it, the container exits). Any remaining TS-side session tracking is bookkeeping and belongs in `tenant-service.ts`, not in a `RuntimeSession` abstraction.

### 2. Fix the namespace format

Change `generateNamespace` in `packages/core/src/memory/namespace.ts` to produce the AgentCore-canonical form:

```ts
// Before:
// tenant-{tenantId}-user-{userId}

// After:
// /strategy/{strategyId}/actor/tenant-{tenantId}-user-{userId}/session/{sessionId}/
```

Drop SWARM and AGENT scopes from the external namespace contract; if you need cross-session or cross-agent memory, use actor-level namespaces (omit `session/`). Update the Python agent to pass the new format to `AgentCoreMemorySessionManager`.

### 3. Tier the Memory strategy config against real SDK types

Current `chimera_agent.py:185-208`:

```python
configs = {
    'basic': {'strategies': ['SUMMARY'], ...},
    'advanced': {'strategies': ['SUMMARY', 'USER_PREFERENCE'], ...},
    'premium': {'strategies': ['SUMMARY', 'USER_PREFERENCE', 'SEMANTIC_MEMORY'], ...},
}
```

Problems: `SEMANTIC_MEMORY` is not the real SDK identifier (it's `semanticMemoryStrategy`), and `EPISODIC` is missing entirely from all tiers. Proposal:

```python
configs = {
    'basic':    {'strategies': ['summaryStrategy'],                                      'stm_window': 10,  'ltm_retention_days': 7},
    'advanced': {'strategies': ['summaryStrategy', 'userPreferenceMemoryStrategy'],      'stm_window': 50,  'ltm_retention_days': 30},
    'premium':  {'strategies': ['summaryStrategy', 'userPreferenceMemoryStrategy',
                                'semanticMemoryStrategy', 'episodicMemoryStrategy'],     'stm_window': 200, 'ltm_retention_days': 365},
}
```

Rationale:
- `summaryStrategy` for all tiers — cheapest and always useful.
- `userPreferenceMemoryStrategy` for advanced+ — personalization is a paid feature.
- `semanticMemoryStrategy` for premium — expensive (LLM extraction + vector index).
- `episodicMemoryStrategy` for premium — latency is variable (waits for episode completion), only worth it for users running long multi-session workflows where reflection matters.
- Self-managed (`customMemoryStrategy`) omitted — it's an escape hatch for customers who want to plug their own RAG pipeline, not a default.

### 4. Simplify `create_memory_manager` in `chimera_agent.py:155`

Current: per-tenant `agentcore_memory_id` from DynamoDB, passed to `AgentCoreMemorySessionManager`. This implies one memory resource per tenant — expensive at the control-plane and unclear if the benefit (physical isolation) justifies the cost.

Proposed: single shared memory resource, tenancy enforced via `actorId` namespace + IAM condition:

```python
def create_memory_manager(tenant_id, user_id, tier, config):
    memory_config = get_memory_config_for_tier(tier)

    # Shared memory resource ID from env; actorId scopes per tenant
    memory_id = os.environ['CHIMERA_MEMORY_ID']
    actor_id = f"tenant-{tenant_id}-user-{user_id}"

    return AgentCoreMemorySessionManager(
        memory_id=memory_id,
        actor_id=actor_id,                      # AgentCore's tenancy primitive
        strategies=memory_config['strategies'],
        conversation_window_size=memory_config['stm_window'],
    )
```

If a tenant upgrades to premium and requires dedicated memory (HIPAA, sovereign data, etc.), override with a per-tenant `agentcore_memory_id` from DynamoDB — keep the current lookup as a fallback path. Don't make it the default.

### 5. Stop using `context.session` as a black box

Pass the Runtime session ID (`context.session.id` or `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header) into the Memory session ID namespace component. Right now Chimera's `SUMMARY` strategy doesn't work correctly because `summaryStrategy` **requires `sessionId`** in its namespace, and Chimera's namespace string doesn't include one.

### 6. Switch the Dockerfile entrypoint to enable ADOT

For CloudWatch GenAI Observability dashboards to show Strands framework spans, wrap the entrypoint:

```dockerfile
RUN uv pip install aws-opentelemetry-distro>=0.10.0
CMD ["uv", "run", "opentelemetry-instrument", "python", "-m", "bedrock_agentcore.runtime"]
```

This is a one-line change with high leverage — enables the per-session X-Ray trace that's otherwise not visible in CloudWatch.

### 7. Add a CDK construct for `CfnAgentRuntime`

Today the agent container is built in `pipeline-stack.ts` but the actual AgentRuntime resource is not created in CDK. This is an integration gap — the README claims AgentCore Runtime hosting but IaC doesn't provision it. Either:

- Add an L1 `CfnAgentRuntime` (if available in CDK) or a `AwsCustomResource` wrapping `CreateAgentRuntime`
- Document that runtime provisioning is a manual one-time step via the AgentCore CLI

Leaving it un-IaC'd is the worst option — makes environments non-reproducible.

### 8. Migration path (phased)

| Phase | Action | Risk |
|-------|--------|------|
| **0** | Delete `packages/core/src/runtime/agentcore-runtime.ts` + its test file | Low — dead code |
| **1** | Rewrite `namespace.ts` to AgentCore slash format + mandatory trailing slash; migrate existing data (tenants only have STM events with `eventExpiryDuration` TTL, so wait N days and old data ages out) | Medium — namespace change invalidates existing memory records. Plan for a cold-start window where premium tier users lose SEMANTIC memory for 1 session. |
| **2** | Switch to shared memory resource with per-tenant `actorId`; keep `agentcore_memory_id` DynamoDB column as override for enterprise tier | Medium — needs IAM policy update on the runtime execution role |
| **3** | Update strategy identifiers in `get_memory_config_for_tier()`; add `episodicMemoryStrategy` for premium | Low — SDK change, no data migration |
| **4** | Add ADOT wrapper to Dockerfile; wire up CloudWatch GenAI Observability dashboards | Low — additive |
| **5** | Delete `tiered-client.ts`; replace in-memory tests with direct `AgentCoreMemorySessionManager` mocks | Low — internal refactor |

---

## Sources (with dates)

| Source | URL | Accessed |
|--------|-----|----------|
| AgentCore Runtime service contract | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html | 2026-04-17 |
| AgentCore agents-tools-runtime (session limits: 8h max, 15 min idle, 100 MB payload) | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html | 2026-04-17 |
| AgentCore Memory (strategies, namespaces, APIs, Kinesis streaming) | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html | 2026-04-17 |
| AgentCore observability service-provided data (metrics, logs, spans) | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-service-provided.html | 2026-04-17 |
| AgentCore observability configuration (ADOT, Transaction Search, vended logs) | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html | 2026-04-17 |
| AgentCore Runtime IAM permissions (execution role, trust policy) | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html | 2026-04-17 |
| Python SDK: `bedrock-agentcore` 1.4.7 (uv.lock pin, published 2026-03-18) | https://pypi.org/project/bedrock-agentcore/1.4.7/ | 2026-04-17 (via packages/agents/uv.lock) |
| Chimera agent entrypoint | `packages/agents/chimera_agent.py` | Repo HEAD 2026-04-17 |
| Chimera agent Dockerfile | `packages/agents/Dockerfile` | Repo HEAD 2026-04-17 |
| Chimera TypeScript runtime/memory layer | `packages/core/src/runtime/`, `packages/core/src/memory/` | Repo HEAD 2026-04-17 |
| Chimera gateway proxy | `packages/agents/gateway_proxy.py` | Repo HEAD 2026-04-17 |
| Prior research cycle (Chimera background) | `docs/research/agentcore-strands/01-AgentCore-Architecture-Runtime.md` et al. | 2026-04-17 |

### Gaps not resolved in this cycle

- **Pricing page content** (`aws.amazon.com/bedrock/agentcore/pricing/`) was not accessible via WebFetch; specific $ per vCPU-hour and per GB-hour not quoted.
- **Service quotas page** (`runtime-quotas.html`) returned empty content; specific concurrent-session, TPS, and records-per-namespace limits remain open.
- **PyPI `bedrock-agentcore` package page** was blocked by permission; the exact `@entrypoint` decorator signature and `context` object shape were inferred from usage in `chimera_agent.py` + the HTTP service contract docs.
- **`CreateAgentRuntime` API reference page** was blocked; the ECR+version+alias deployment model is inferred from IAM policies and training knowledge.

These should be targeted in a follow-up research cycle (`03-pricing-and-quotas.md`) before any production capacity planning.
