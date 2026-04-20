---
title: "Chimera Agent Architecture"
version: 1.1.0
status: canonical
last_updated: 2026-04-17
task: chimera-29c6
---

# Chimera Agent Architecture

**Purpose:** Definitive architecture for Chimera core agent — Strands-based, AgentCore-hosted, multi-tenant AI agent treating the AWS account as its execution environment.

**Design Principles:** (1) AWS-native not computer-native, (2) Multi-tenant from day one, (3) Model-driven execution via Strands, (4) Safe self-evolution within Cedar bounds, (5) OpenClaw-compatible SKILL.md format.

**Key Insight:** OpenClaw treats local computer as execution environment. Chimera treats the AWS account as execution environment.

---

## Section 1: Agent Execution Loop

### Full Execution Flow

User Message -> [1] API Gateway WebSocket/REST -> [2] Tenant Router Lambda (extract tenantId/userId/tier from Cognito JWT, load config from DynamoDB, resolve AgentCore endpoint pool/silo, check rate limits) -> [3] AgentCore Runtime MicroVM (session hydrated, JWT claims via context.auth.claims) -> [4] Chimera Agent Entrypoint (extract tenant context, `set_tenant_context()` for the Python tool layer, load tier-gated tools + custom skills, configure canonical memory namespace `/strategy/{strategy}/actor/tenant-{id}-user-{id}/session/{sid}/`, build system prompt, create Strands Agent) -> [5] Strands ReAct Loop (FM decides respond or call tools, Cedar policy check per call, max 20 iterations) -> [6] Response Streaming SSE/WebSocket -> [7] Post-Turn async (STM persist, LTM extract, cost track, audit log) -> [8] `clear_tenant_context()` in `finally` so reused workers cannot leak context.

### Session Serialization

AgentCore Runtime guarantees concurrent invocations for same runtimeSessionId are serialized — replaces OpenClaw Lane Queue. Runtime session id comes from the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header and flows into the canonical memory namespace (see Section 6). Context: Strands max_iterations(20), AgentCore STM window (Basic=10, Advanced=50, Premium=200), LTM `summaryStrategy` compression.

---

## Section 2: AWS Account Tool System

### Fundamental Shift

OpenClaw exec -> AWS SDK calls. read/write/edit -> S3 operations. Docker sandbox -> MicroVM + Cedar. Node system -> AWS Organizations.

### Tool Tiers

Tier 1 (all tiers): EC2, Lambda, S3, DynamoDB, ECS. Tier 2 (advanced+): VPC, IAM, CloudFront, Route53, WAF. Tier 3 (advanced+): RDS, Redshift, Glue, Athena, OpenSearch. Tier 4 (premium): CodeCommit, CodePipeline, CodeBuild, Bedrock, SageMaker.

Tools are Strands @tool decorated functions wrapping boto3 SDK calls. Loading pipeline: base tools -> AWS tools (25, tier-gated) -> custom skills -> MCP tools -> Cedar filter -> schema cleanup -> budget guard.

### Permission Model

Tier gating -> Cedar policy eval -> IAM role (STS AssumeRole with ExternalId for confused deputy prevention). Tier roles: Basic=read-only T1, Advanced=read+write T1-3, Premium=full T1-4.

### Python Tenant-Context Layer (ADR-033)

Python `@tool` functions **never** accept `tenant_id` as an argument — the LLM picks tool arguments, so a user-settable `tenant_id` is a tenancy-spoofing primitive. Instead, `tenant_id` is injected once per invocation by the entrypoint and read from a module-level `ContextVar`.

- **Module:** `packages/agents/tools/tenant_context.py`. Exposes `set_tenant_context(tenant_id, tier, user_id)`, `clear_tenant_context()`, `require_tenant_id()` (raises `TenantContextError` if unset), and `ensure_tenant_filter(filter_expression, expression_values)` for DDB queries.
- **Entrypoint contract:** `chimera_agent.py::handle` calls `set_tenant_context(...)` immediately after extracting JWT claims and calls `clear_tenant_context()` in a `finally` block so a reused worker task cannot leak one tenant's context into the next invocation.
- **Tool contract:** every `@tool` function calls `require_tenant_id()` at the top before touching AWS. Declaring `tenant_id: str` on a tool signature is a review-blocking defect.
- **DDB auto-scoping:** query/scan tools route every `FilterExpression` through `ensure_tenant_filter()`, which AND-s `tenantId = :__chimera_tid` into the expression and injects the placeholder value. The placeholder name is reserved to avoid collisions with user-supplied expression values.
- **Anti-pattern guard:** `packages/agents/tests/test_tenant_context.py::test_no_tool_imports_boto3_without_tenant_context` fails CI when a tool file imports `boto3` without importing from `tenant_context`, so forgetting `require_tenant_id()` cannot land.

See [ADR-033](decisions/ADR-033-tenant-context-injection-for-python-tools.md) for the full decision record, alternatives considered, and risk analysis.

---

## Section 3: Skill Execution Runtime

### SKILL.md v2

OpenClaw-compatible fields plus: category (fixed taxonomy), permissions (Cedar), trust_level (0=system to 4=user-uploaded), sandbox_required, max_execution_seconds, cost_estimate.

Loading precedence: system -> tenant -> marketplace -> user-uploaded -> MCP external.

Registration: S3 upload -> 7-stage security pipeline (static analysis, dependency audit, policy compliance, sandbox test, resource limits, cost estimation, manual review) -> DynamoDB register -> Gateway target -> available.

Execution modes: Inline (@tool, trusted), Sandbox (Code Interpreter, untrusted), MCP (AgentCore Gateway), Lambda (compute-intensive).

---

## Section 4: Self-Evolution Engine

Six dimensions under Evolution Safety Harness: prompt optimization (A/B test, max 3/week), skill generation (pattern detection, min 3 occurrences), infra modification (allowed: scale/env/secrets vs dangerous: delete/modify-iam always human approval), model routing (Thompson sampling), subagent creation, memory evolution.

### Safety Harness (7 steps)

1. Rate limit check (10/day, 3 infra/day, 3 prompts/week)
2. Cedar policy evaluation
3. Cost impact (>$50/mo -> human approval)
4. Pre-change S3 snapshot
5. Execute change
6. Post-health check (drop >10 -> auto-rollback)
7. Audit event

---

## Section 5: UTO Access Control

User-Team-Org hierarchy. Identity: Cognito -> JWT (tenantId, tier, role) -> API Gateway -> Tenant Router -> AgentCore context.auth.claims. Cedar policies control per-user/team/org tool access. IAM: STS AssumeRole per tenant with ExternalId. Audit: chimera-audit with tenantId, action, cedarDecision, tool, cost. 90d TTL, CMK.

---

## Section 6: Memory Architecture

Three layers: STM (AgentCore sliding window, Basic=10/Advanced=50/Premium=200), LTM (3 strategies: `summaryStrategy` all tiers, `userPreferenceMemoryStrategy` advanced+, `semanticMemoryStrategy` premium), Structured State (DynamoDB: sessions 24h TTL, tenants, cost-tracking 2yr, audit 90d/1yr/7yr CMK tier-enforced).

**Strategy identifiers are the real SDK names** (`summaryStrategy`, `userPreferenceMemoryStrategy`, `semanticMemoryStrategy`), not the uppercase constants (`SUMMARY`, `USER_PREFERENCE`, `SEMANTIC_MEMORY`) Chimera previously passed. The old strings were silently accepted by the Strands integration but never matched a real strategy, so LTM extraction and IAM `strategy/{strategyId}` conditions both broke. `episodicMemoryStrategy` and `customMemoryStrategy` are available as future options; the latter is the self-managed S3+SNS pipeline escape hatch. See `docs/research/agentcore-rabbithole/02-runtime-memory-deep-dive.md` for the strategy matrix.

**Canonical namespace** (required by AgentCore — trailing slash is load-bearing):

```
/strategy/{strategy}/actor/tenant-{tenantId}-user-{userId}/session/{sessionId}/
```

Previously Chimera emitted flat strings like `tenant-{id}-user-{id}`, which do not match `bedrock-agentcore:namespace` IAM condition keys, leaving tenancy enforced only at the application layer. The canonical format lets IAM `StringLike` conditions such as `/strategy/*/actor/tenant-{id}-*/` enforce tenancy at the service boundary. `summaryStrategy` requires the `session/{sessionId}/` segment; actor-scoped strategies ignore the extra segment harmlessly. Construction lives in `chimera_agent.py::_build_agentcore_namespace`; the runtime session id is resolved via `BedrockAgentCoreContext.get_session_id()` with an `AGENTCORE_SESSION_ID` env fallback for local/test execution.

Integration via `AgentCoreMemorySessionManager` passed as `session_manager` to the Strands `Agent`. One pre-computed namespace per enabled strategy is passed alongside the primary (summary) namespace; a follow-up task (`TODO(rabbithole-02)` in `chimera_agent.py`) will replace the flat kwargs with the SDK's `AgentCoreMemoryConfig` dataclass.

---

## Section 7: Concurrent Task Model

Foreground (interactive chat, sync ReAct, streaming) vs Background (EventBridge -> Step Functions -> Agent/Lambda). Background dispatch via start_background_task tool -> DDB record -> EventBridge. State machines: PipelineBuild, DataAnalysis, InfrastructureDeploy, SkillGeneration. Status via check_background_task. SQS FIFO per-tenant ordering. Notifications via WebSocket/Slack/email.

---

## Section 8: Self-Reflection Loop

Post-turn: tool success analysis, response quality, cost efficiency, signal routing (thumbs_down->PromptOptimizer, correction->Memory, tool failure->AutoSkillGenerator, cost overrun->ModelRouter). Monthly health score (0-100): quality 25%, completion 20%, cost 15%, corrections 15%, skill reuse 10%, memory hit 10%, rollback 5%. Error recovery: retry+fallback, model degradation, permission explain, budget read-only, self-heal.

---

## Section 9: Multi-Modal Processing

### Media Input Handling

Chimera agents natively handle video, audio, images, and documents without requiring explicit user instructions. The MediaProcessor module auto-detects input media type and routes to the appropriate AWS service.

**Auto-routing pipeline:** Input received -> Type detection (MIME type > file extension > default) -> Route to service (Transcribe | Rekognition | Textract) -> Return structured result.

### AWS Service Integration

Three AWS services provide multi-modal capabilities:

1. **AWS Transcribe** (audio/video): Speech-to-text transcription with speaker identification, language detection, timestamps. Supports formats: MP3, MP4, WAV, FLAC, OGG, WebM. Input: S3 URI required. Output: JSON transcript with confidence scores.

2. **AWS Rekognition** (images): Object/scene detection, facial analysis, text extraction (OCR), content moderation. Supports formats: JPEG, PNG, GIF, BMP, WebP. Input: S3 URI or direct bytes. Output: Labels with confidence, bounding boxes, detected text.

3. **AWS Textract** (documents): Text extraction, table detection, form field recognition, signature detection. Supports formats: PDF, TIFF, JPEG, PNG. Input: S3 URI required for multi-page. Output: Hierarchical blocks (page, line, word, table, form).

### Type Detection Strategy

MediaProcessor uses three-tier detection (priority order):

1. **Explicit type** (highest confidence): User provides `mediaType` field
2. **MIME type** (high confidence): Content-Type header or file metadata
3. **File extension** (medium confidence): Parse from URI path
4. **Default to document** (low confidence): Textract is most permissive

Example mappings: `.mp3/.wav` → audio (Transcribe), `.jpg/.png` → image (Rekognition), `.pdf/.docx` → document (Textract), `.mp4/.mov` → video (Transcribe).

### Storage Requirements

**S3 dependency:** Transcribe and Textract require S3 URIs (no direct upload). Rekognition supports both S3 and direct bytes.

**Pre-processing:** For local files or HTTP URLs, agent must:
1. Upload to tenant's S3 bucket (`chimera-media-{tenantId}/uploads/`)
2. Generate presigned URL if needed
3. Pass S3 URI to MediaProcessor

**Output storage:** Results stored in `chimera-media-{tenantId}/results/` with 7-day TTL. Transcripts, extracted text, and analysis JSON persisted for session context.

### Integration with Agent Loop

Multi-modal processing integrated into Strands ReAct loop:

**User message with media attachment** → [1] API Gateway receives file upload + message → [2] Tenant Router uploads to S3 → [3] AgentCore Runtime receives S3 URI in context → [4] Agent calls `process_media` tool → [5] MediaProcessor auto-detects and routes → [6] Result injected into conversation context → [7] FM reasons over structured result → [8] Agent responds with insights.

**Tool definition:** `process_media(uri: str, options: dict) -> MediaProcessingResult`. Tier gating: Basic (Transcribe only), Advanced (Transcribe + Rekognition), Premium (all three).

### Async Processing Pattern

Long-running jobs (Transcribe, Textract) use async pattern:

1. **Start job** → Returns job ID immediately
2. **Poll for completion** → MediaProcessor polls every 5s (max 60 attempts)
3. **Background option** → For >5min jobs, use `start_background_task` tool → EventBridge → Step Functions → WebSocket notification

**Production optimization:** Replace polling with EventBridge + Step Functions state machine. Transcribe/Textract emit CloudWatch Events on completion → Lambda updates session state → WebSocket pushes result to frontend.

### Cost Tracking

Media processing costs tracked per service:

- **Transcribe:** $0.024/minute (Basic), $0.040/minute (Advanced with speaker labels)
- **Rekognition:** $0.001/image (labels), $0.001/image (text), $0.001/image (faces)
- **Textract:** $0.0015/page (text), $0.015/page (tables+forms)

Costs accumulated in `chimera-cost-tracking` table with `mediaService` dimension. Budget alerts at 80% monthly quota.

### Security Considerations

**S3 bucket isolation:** Each tenant gets isolated prefix (`chimera-media-{tenantId}/`) with IAM policy enforcement. Presigned URLs expire after 15 minutes.

**Cedar policies:** Media tools require `mediaProcessing` permission. Example:
```cedar
permit(
  principal in TenantRole::"premium",
  action == Action::"processMedia",
  resource in MediaBucket::"chimera-media-*"
) when {
  context.mediaType in ["audio", "video", "image", "document"]
};
```

**Content moderation:** Rekognition moderation labels checked before storing results. Policy violation triggers audit event + blocks result from session context.

---

## Section 10: AgentCore Primitives — Managed vs Custom

The AgentCore rabbithole research (`docs/research/agentcore-rabbithole/`) inventoried which Chimera responsibilities are delegated to AgentCore primitives versus which remain hand-rolled. Wave 7 deleted `packages/core/src/runtime/` session-management placeholders (`agentcore-runtime.ts` + callers); sessions are fully owned by AgentCore Runtime via the `@entrypoint` decorator in `packages/agents/chimera_agent.py`.

| Primitive | Chimera status | Notes |
|-----------|----------------|-------|
| Runtime (MicroVM, sessions) | Managed — `@entrypoint` + `BedrockAgentCoreApp` | Dead TS session-lifecycle layer removed in Wave 7; runtime session id flows from `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` into memory namespaces |
| Memory (STM events + LTM strategies) | Managed — `AgentCoreMemorySessionManager` | Namespace format now canonical (see Section 6); `TODO(rabbithole-02)` remains for `AgentCoreMemoryConfig` migration |
| Gateway (MCP/Lambda/OpenAPI targets) | **Hand-rolled** via `gateway_proxy.py` | Phase-0/1 migration scaffolding landed this session as `packages/core/src/gateway/` (tool-loader, tool-registry, tier-config) — tier gating + prompt-injection envelope stay Chimera-owned |
| Code Interpreter | **Stub (fix in progress)** | Service-name bug fixed (`bedrock-agentcore-runtime` -> `bedrock-agentcore`); three API-shape TODOs remain (see below) |
| Browser | Not integrated | `fetch_url_content` is a `urllib` script inside Code Interpreter, not the real Browser service; see `docs/research/agentcore-rabbithole/04-code-interpreter-browser-deep-dive.md` opportunity #2 |
| Registry | Phase-0/1 dual-write scaffolding | `packages/core/src/registry/`, flag-gated default-off; `chimera-skills` DDB remains canonical until Phase-2 spike closes — see [ADR-034](decisions/ADR-034-agentcore-registry-adoption.md) and `docs/MIGRATION-registry.md` |
| Observability | Mixed | Vended `bedrock-agentcore` CloudWatch namespace consumed directly; ADOT wrapper for Strands span export not yet enabled |
| Cedar authorization, rate limiting, cost attribution, self-evolution, budget enforcement, prompt-injection fencing | Hand-rolled | No AgentCore equivalent |

### Code Interpreter — current state

`packages/agents/tools/code_interpreter_tools.py` provides `validate_cdk_in_sandbox`, `execute_in_sandbox`, and `fetch_url_content`. Wave 7 fixed the boto3 service name from the non-existent `bedrock-agentcore-runtime` to the real data-plane `bedrock-agentcore`; prior to this fix every sandbox call raised `UnknownServiceError` and the tool silently fell through to the regex validator. A kill-switch env var `CODE_INTERPRETER_USE_AGENTCORE_SHIM=false` forces the regex fallback path during rollout.

Three API-shape TODOs remain (tracked at `TODO(rabbithole-04)` in `code_interpreter_tools.py`), staged deliberately so each can be verified on a dev tenant before landing:

1. Rename `create_code_interpreter_session(...)` -> `start_code_interpreter_session(...)` (the resource is "started", not "created").
2. `invoke_code_interpreter` takes `{name, arguments}` (e.g. `name="executeCode", arguments={"language": "python", "code": ...}`), not a bare `code=` kwarg.
3. Responses are a stream — `response["stream"][i]["result"]["content"]` — not `response["output"]`; the parsing in all three call sites must iterate the stream and accumulate content entries.

See `docs/research/agentcore-rabbithole/04-code-interpreter-browser-deep-dive.md` for the full API reference and opportunity ranking.

---

## Appendix A: OpenClaw to Chimera Mapping

Gateway->API GW+Router+Runtime, Pi->Strands, Lane Queue->session serialization, exec->AWS SDK tools, SKILL.md->v2, ClawHub->chimera-skills+7-stage, Docker->MicroVM, MEMORY.md->LTM, SQLite->SEMANTIC_MEMORY, exec-approvals->Cedar, Nodes->Organizations, subagents->Strands multi-agent, skill-creator->AutoSkillGenerator.

## Appendix B: Key Decisions

1. Strands SDK (ADR-003), 2. AgentCore MicroVM (ADR-007), 3. AgentCore Memory (ADR-016), 4. S3 storage (ADR-010), 5. Cedar (ADR-002), 6. DynamoDB 6-table (ADR-001), 7. EventBridge (ADR-008), 8. SKILL.md v2 (ADR-018), 9. 7-stage pipeline (ADR-009), 10. Vercel AI SDK (ADR-004), 11. Self-modifying IaC (ADR-011), 12. Multi-provider LLM (ADR-017).

## Appendix C: Code References

Agent facade: packages/core/src/agent/agent.ts (scaffold). Evolution types+harness+auto-skill+prompt-optimizer+model-router+iac-modifier: packages/core/src/evolution/ (implemented). Memory types+namespace+client: packages/core/src/memory/ (implemented). Skills registry+validator+trust+mcp+installer: packages/core/src/skills/ (implemented). AWS tools: packages/core/src/aws-tools/ (implemented). Discovery: packages/core/src/discovery/ (implemented). CDK: infra/lib/ (11 stacks).

---
Author: lead-agent-design | Task: chimera-29c6 | Status: Canonical
