---
title: "AgentCore Harness as a Simplification Substrate for Chimera — Wave-14 Recommendation"
status: research
wave: 14
date: 2026-04-22
author: wave-14-agentcore-harness-research
related:
  - docs/research/agentcore-rabbithole/00-INDEX.md
  - docs/research/agentcore-rabbithole/01-registry-deep-dive.md
  - docs/research/agentcore-rabbithole/02-runtime-memory-deep-dive.md
  - docs/research/agentcore-rabbithole/03-gateway-identity-deep-dive.md
  - docs/research/agentcore-rabbithole/04-code-interpreter-browser-deep-dive.md
  - docs/research/agentcore-rabbithole/05-observability-evaluations-deep-dive.md
  - docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md
  - docs/architecture/decisions/ADR-033-tenant-context-injection-for-python-tools.md
  - docs/architecture/decisions/ADR-007-agentcore-microvm.md
  - docs/architecture/decisions/ADR-016-agentcore-memory-strategy.md
  - docs/MIGRATION-registry.md
  - docs/MIGRATION-gateway.md
---

# AgentCore Harness — Can It Simplify Chimera?

## 1. Executive Summary

**Headline verdict: PARTIAL-ADOPT, continuing the in-flight trajectory.** AgentCore is a
real simplification lever, but the high-ROI slices are already scoped (ADR-034 Registry,
rabbithole Waves 1-6, Phase-0/1 adapters on main). The right move is not a replatform —
it's to finish the Registry pilot, add Gateway + Observability on the same "keep Strands,
keep Cedar, keep DDB" axis, fix two code bugs (dead Runtime TS file, wrong Code Interpreter
service name), and defer Runtime host-plane migration until per-tenant IAM + IaC gaps close.

Chimera's 14 stacks are **not symptomatic of over-engineering**. Most (pipeline, evolution,
orchestration, tenant-onboarding, data, frontend, email, discovery) are Chimera-specific
value, not substitutable. The substitutable portion is narrow: `GatewayRegistrationStack`,
the skills-catalog chunk of `DataStack`/`SkillPipelineStack`, ~40% of `ObservabilityStack`
widgets, the dead `agentcore-runtime.ts` (delete), and the stubbed Evaluations path in
`prompt-optimizer.ts`. Net opportunity per the rabbithole: ~1,800 LOC deleted + governance,
MCP-native discovery, real LLM-as-judge quality signal — not a rewrite.

---

## 2. Primitive-by-Primitive Analysis

### 2.1 Runtime
- **Chimera:** ECS Fargate (`chat-stack.ts`) + `packages/chat-gateway` + `packages/sse-bridge`;
  Python agent already uses `@entrypoint` correctly. `packages/core/src/runtime/agentcore-runtime.ts`
  (370 LOC) is dead (every method is a TODO or reinvents a Runtime primitive — rabbithole doc #02).
- **AgentCore:** Per-session microVM, built-in SSE, X-Amzn-Bedrock-AgentCore-Runtime-Session-Id,
  active-consumption billing ($0.0895/vCPU-hr). Retires ECS + ALB + SSE bridge (~1,450 LOC).
- **Blocker:** No `CfnAgentRuntime` in `infra/lib/`; per-tenant IAM posture unproven
  (agent-per-tenant multiplies control-plane resources by N).
- **Verdict: DEFER.** Delete dead TS today; don't migrate host plane until per-tenant IAM + IaC
  spike closes at 10/100-tenant scale.

### 2.2 Memory
- **Chimera:** Python uses `AgentCoreMemorySessionManager` but passes wrong namespace format
  (`tenant-{id}-user-{id}` flat string). `packages/core/src/memory/*` (~600 LOC) reinvents
  the model with fictional SWARM tier; `createAgentCoreClient()` throws.
- **AgentCore:** Canonical `/strategy/{id}/actor/{actorId}/session/{sessionId}/` namespace +
  five managed strategies. IAM keys (`namespace`, `actorId`, `sessionId`) give real per-tenant
  enforcement — but only if the namespace format is correct.
- **Verdict: ADOPT (fix).** Rewrite `namespace.ts`, align strategy enums to real SDK IDs
  (`semanticMemoryStrategy` etc.), delete SWARM tier, switch to shared memory resource with
  per-tenant `actorId`. Implied by ADR-016 but never executed.

### 2.3 Gateway
- **Chimera:** `gateway_proxy.py` (239) + `gateway_config.py` (767) +
  `gateway-registration-stack.ts` (435) + `packages/core/src/gateway/*` is a tier-grouped
  Lambda fanout via `boto3.invoke`, **NOT AgentCore Gateway** (rabbithole doc #03). The
  `chimera-agentcore-invoke` IAM role is provisioned but never attached.
- **AgentCore:** `CreateGateway` + `CreateGatewayTarget` (~19) behind managed `/mcp` endpoint;
  inbound `CUSTOM_JWT`, outbound SigV4 per target; optional semantic tool search.
- **Verdict: ADOPT.** Largest single-slice reduction (~1,500 LOC). Cedar + rate-limits +
  prompt-injection delimiters stay (different jobs). Already scoped in `docs/MIGRATION-gateway.md`.

### 2.4 Identity
- **Chimera:** Cognito (`security-stack.ts`) + Cedar (`cedar-authorization.ts`, 455 LOC).
  No OAuth credential vault for third-party SaaS.
- **AgentCore:** Same `CustomJWTAuthorizerConfiguration` for inbound (composes with Cognito,
  doesn't replace it). Built-in 2LO/3LO providers (Google/GitHub/Slack/Salesforce/Jira/MS/
  CustomOauth2) with KMS-backed per-`(agent_identity, user_id)` token vault.
- **Verdict: PARTIAL ADOPT.** **Cedar does NOT go away** (it does app-level tenant authz,
  not edge authn). Adopt Identity only as the outbound OAuth broker when the first
  third-party SaaS integration ships. Keep Cognito + Cedar.

### 2.5 Code Interpreter
- **Chimera:** `code_interpreter_tools.py` has a **critical bug** (doc #04 surprise #3):
  line 66 uses `boto3.client("bedrock-agentcore-runtime")` — that service does not exist.
  Every invocation raises `UnknownServiceError` and falls through to the regex validator.
  **The sandbox has never actually run in production.**
- **AgentCore:** Managed Firecracker sandbox; Python + JS + TS; PUBLIC/SANDBOX/VPC modes;
  `executeCommand` supports `npm install aws-cdk-lib && npx cdk synth`.
- **Verdict: ADOPT (fix first).** One-day fix + provision a custom PUBLIC-mode Code
  Interpreter for real CDK validation. Blocks ~30-50% of self-evolution infra failures
  per doc #04.

### 2.6 Browser
- **Chimera:** Zero integration. `fetch_url_content` is a Python `urllib` script inside
  Code Interpreter — no JS rendering, no cookies, no screenshots.
- **AgentCore:** Managed Chromium over CDP/WebSocket, Playwright/Nova Act/Strands support,
  500 concurrent sessions, persistent profiles, live-view NICE DCV stream. **Public network
  only** as of April 2026.
- **Verdict: ADOPT (new capability).** Net-new surface (customer dashboard automation,
  authed SaaS, Console scraping) — not a replacement. Tier-gate at advanced+. Deprecate
  `fetch_url_content` in favor of `navigate_and_extract`.

### 2.7 Observability
- **Chimera:** `observability-stack.ts` (~1,100 LOC), 4 dashboards, X-Ray SDK (not OTEL).
  **Eight metrics defined in dashboards have no emitters** (rabbithole surprise #5).
- **AgentCore:** OTEL-native via ADOT; `bedrock-agentcore` namespace emits 8 runtime metrics
  free; CloudWatch GenAI Observability dashboard is stock; X-Ray Transaction Search on
  `aws/spans`. **No native `tenantId` dimension** — need `baggage: tenantId=<id>` on OTEL
  spans + keep custom emitters for dimensioned metrics.
- **Verdict: ADOPT (additive).** Add ADOT to container entrypoint, enable Transaction Search,
  propagate tenant baggage. Keep `Chimera/Billing` + `Chimera/Tenant`-dimensioned emitters.
  Low risk, high leverage.

### 2.8 Registry
- **Chimera:** ADR-034 Phase 0/1 already landed on main behind flags
  (`REGISTRY_ENABLED`, `REGISTRY_PRIMARY_READ`, `DDB_WRITE_SKILLS_DISABLED`).
  `packages/core/src/registry/*` adapter + dual-write in skill pipeline stage 7
  + dual-read in discovery API. `infra/lib/registry-stack.ts` exists.
- **AgentCore:** DRAFT → PENDING_APPROVAL → APPROVED → DEPRECATED workflow, hybrid
  `SearchRegistryRecords`, per-registry MCP endpoint, EventBridge on submission. Single-
  registry search (no federation — affects multi-tenancy).
- **Verdict: ADOPT — continue.** Phase 2 is blocked on spike at
  `docs/designs/agentcore-registry-spike.md` resolving Pattern A (per-tenant registries) vs
  Pattern B (shared + tenant-scoped records). **Top priority to unblock.**

### 2.9 Evaluations
- **Chimera:** `prompt-optimizer.ts::runTestCase()` (~line 447) returns a simulated
  score — the entire quality signal in the A/B loop is stubbed (rabbithole doc #05 + #06).
- **AgentCore:** 14 built-in LLM-as-judge evaluators (`Correctness`, `GoalSuccessRate`,
  `ToolSelectionAccuracy`, etc.) + code-based Lambda evaluators; online (sampling) + on-
  demand. Consumes OTEL spans from `aws/spans`, not Runtime-specific.
- **Verdict: ADOPT (gated on Observability).** After OTEL spans land: create 3 online
  evaluators at 10% sampling, delete `runTestCase()` stub, wire an `evaluation-aggregator`
  Lambda → `recordVariantOutcome()`. ~2 weeks. Closes the self-evolution flywheel.

---

## 3. Migration Recommendation

**Do not replatform. Continue incremental substitution, in this order:**

**Sprint 1 — Correctness + dead code (1 week)**
1. Fix Code Interpreter service name at `code_interpreter_tools.py:66`
   (`bedrock-agentcore-runtime` → `bedrock-agentcore`) + API-shape fix.
2. Delete `packages/core/src/runtime/agentcore-runtime.ts` (370 LOC dead).
3. Rewrite `packages/core/src/memory/namespace.ts` to canonical AgentCore format.
4. Either start emitting the 8 stale metrics OR delete their dashboard references.

**Sprint 2 — Observability onboarding (1 week)**
5. Wrap Python agent entrypoint in `opentelemetry-instrument`; add `aws-opentelemetry-distro`.
6. Enable X-Ray Transaction Search (one-time CLI call).
7. Propagate `baggage: tenantId=<id>` at chat-stack ALB → ECS ingress.

**Sprint 3 — Registry Phase 2 (after spike)**
8. Execute `docs/designs/agentcore-registry-spike.md`; update ADR-034 with Pattern decision.
9. Flip `REGISTRY_PRIMARY_READ=true` in dev; monitor `RegistryFallback` metric.

**Sprint 4 — Gateway migration (2 weeks)**
10. CDK custom resource for `CreateGateway` + ~19 `CreateGatewayTarget`.
11. Swap `gateway_proxy.py` for Strands MCP client against managed `/mcp` endpoint.
12. Move the `[TOOL RESULT BEGIN]` delimiter wrap to a Strands `on_tool_result` hook.

**Sprint 5 — Evaluations wiring (2 weeks)**
13. Create 3 online evaluators (`Correctness` TRACE, `ToolSelectionAccuracy` TOOL_CALL,
    `GoalSuccessRate` SESSION) at 10% sampling.
14. `evaluation-aggregator` Lambda on CloudWatch Logs subscription feeds
    `promptOptimizer.recordVariantOutcome()`.
15. Delete `runTestCase()` stub.

**Deferred (not this arc):**
- Runtime host-plane migration (ECS → AgentCore Runtime) — gated on per-tenant-IAM +
  `CfnAgentRuntime` IaC spike at 10/100-tenant scale. Revisit Q3.
- Identity outbound OAuth — adopt when first third-party SaaS integration ships.
- Browser tool — adopt when product strategy calls for authed automation.

**Critical gates:** Step 8 needs the Phase-2 spike closed. Step 10 needs a tier-gating
decision (per-target IAM vs per-tier gateway). Step 13 needs Bedrock judge-model cost
confirmed (doc #05 estimate: $300-$1,500/mo at 10% of 1M sessions).

---

## 4. Non-Migration Recommendation — Why HOLD the Big Moves

**Runtime and Identity host-plane should HOLD at least 1 quarter:**

1. **Runtime IaC gap.** `infra/lib/` has no `CfnAgentRuntime` resource — Python agents
   are registered manually via AgentCore CLI outside CDK (doc #02). Migrating host plane
   before IaC is reproducible breaks environment parity and blocks CDK-nag/WAF/cross-region
   posture (ADR-025, ADR-028).

2. **Per-tenant IAM unproven.** Runtime isolation is per-session, not per-tenant. Per-
   tenant IAM requires either (a) agent-per-tenant `CreateAgentRuntime` (no documented
   quota guidance, probably fine at 10 tenants, unknown at 1,000) or (b) ADR-033
   `ContextVar` injection — which already works and doesn't strengthen by migrating.

3. **Cost model favors ECS at <10 tenants.** ECS Fargate (~2 long-lived tasks, ~$60/mo)
   amortizes across tenants. AgentCore Runtime per-vCPU-hour wins when I/O-wait dominates,
   but at small scale fixed ALB + NAT + CW overhead dwarfs compute. At 100+ tenants the
   math flips; we don't have 10 paying tenants.

4. **Cedar stays regardless.** Identity composes with Cognito's JWT issuance; Cedar's
   `cross-tenant-isolation` forbid rule has no IAM equivalent. Replacing Cognito with
   Identity deletes ADR-028 without net benefit.

5. **Vendor lock-in is already priced in.** Chimera is AWS-only by design (ADR-005,
   ADR-012). Adopting more AgentCore doesn't change lock-in posture materially.

6. **"14 CDK stacks" is a distraction.** Only `GatewayRegistrationStack`, part of
   `SkillPipelineStack`, and ~40% of `ObservabilityStack` are substitutable. The other
   11 stacks are Chimera's actual product substrate (onboarding, self-evolution,
   discovery, multi-platform chat, CI/CD) — AgentCore doesn't substitute for any.

---

## 5. Open Questions for the Main Thread

1. **Registry multi-tenancy spike.** Pattern A (per-tenant registry, quota overhead)
   or Pattern B (shared + tenant-scoped records, needs tested IAM/JWT isolation)?
   Blocks ADR-034 Phase 2.

2. **AgentCore pricing pages.** `aws.amazon.com/bedrock/agentcore/pricing/` not
   reachable in this research cycle. $0.0895/vCPU-hr + $0.00945/GB-hr for
   Runtime/Code Interpreter/Browser is from doc #04; Registry + Evaluations pricing
   remain unconfirmed. Cost projections at 10/100 tenants depend on these.

3. **Runtime per-tenant IAM pattern.** Agent-per-tenant (and what's the service quota
   for CreateAgentRuntime per account?) vs shared agent with Cedar + ContextVar? AWS
   has not documented a preferred pattern.

4. **Runtime IaC completeness.** Is `CfnAgentRuntime` available as a CDK L1 in current
   `aws-cdk-lib`? If not we need an `AwsCustomResource` wrapper. Also: blue/green
   alias-routing story in CDK?

5. **Evaluations judge-model cost at our projected traffic.** At 10% sampling, real
   Bedrock Sonnet-4.5 monthly cost?

6. **EventBridge coverage for Registry.** APPROVED/REJECTED/DEPRECATED transition
   events confirmed? Affects whether self-evolution can be fully EventBridge-driven.

7. **AgentCore Policy primitive.** Not covered in rabbithole. Requires Gateway; overlaps
   with `safety-harness.ts` (399 LOC) + Cedar. Needs Wave-15 deep-dive.

8. **Browser VPC mode ETA.** Blocks "inspect private tenant infra from agent browser."

9. **Custom Docker image for Code Interpreter.** Would drop `validate_cdk_in_sandbox`
   cold-start from ~90s to ~5s. Not yet supported per doc #04.

---

## 6. Summary Table

| Primitive        | Verdict            | Sprint    | Gate                                                    |
|------------------|--------------------|-----------|---------------------------------------------------------|
| Runtime          | DEFER              | —         | CfnAgentRuntime in CDK; per-tenant IAM spike @ 10/100t  |
| Memory           | ADOPT (fix)        | Sprint 1  | Delete dead code + rewrite namespace to canonical       |
| Gateway          | ADOPT              | Sprint 4  | Tier-gating decision (per-target IAM vs per-tier GW)    |
| Identity         | PARTIAL ADOPT      | Later     | First 3rd-party OAuth integration requirement           |
| Code Interpreter | ADOPT (fix first)  | Sprint 1  | Service-name fix + custom PUBLIC-mode CI                |
| Browser          | ADOPT (new)        | Later     | Product decision on authed automation                   |
| Observability    | ADOPT (additive)   | Sprint 2  | ADOT + Transaction Search + baggage propagation         |
| Registry         | ADOPT — continue   | Sprint 3  | Phase-2 spike closes multi-tenancy                      |
| Evaluations      | ADOPT              | Sprint 5  | Observability landed + judge-model cost confirmed       |
| Policy           | RESEARCH           | Wave-15   | Deep-dive needed; overlap with safety-harness?          |

**Net effect if the ADOPT items land:** ~1,800 LOC retired, MCP-native discovery unlocked,
real LLM-as-judge quality signal closing the self-evolution flywheel, managed Chromium
unlocks authed web automation — all without disrupting Strands, Cedar, DDB, or the 11
Chimera-specific stacks. **"Could it simplify and make our system better?" — YES, continue
the in-flight ADR-034 trajectory; do not deviate into a Runtime replatform.**
