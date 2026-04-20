---
title: "Agent Framework Alternatives — Research Memo"
status: research
author: builder-cherry-pick-main (scout / Phase 1 research)
last_updated: 2026-04-17
phase: 1
scope: "Research only — no Chimera code modified"
---

# Agent Framework Alternatives — Research Memo

## TL;DR Recommendation

**Stay on Strands for the ReAct loop; adopt AgentCore Registry (Bedrock)
now for discovery/governance; skip Hermes and Pi as runtime replacements.**
AgentCore Registry is a governed catalog for MCP servers, A2A agents,
skills, and custom resources — it covers the exact discovery, versioning,
approval-workflow, and auth surfaces Chimera is hand-rolling in
`chimera-skills` and the Skill Pipeline. Strands remains the right ReAct
loop inside MicroVMs (Python, Bedrock-native, streams the event shape the
SSE bridge already consumes). Neither candidate for "Hermes" (NousResearch
model family vs. any fringe Python framework) nor Pi (Mario Zechner's
`@mariozechner/pi-agent-core`) is an AWS-native, multi-tenant-safe
replacement for Strands — Pi is an explicitly single-user, local-first
coding agent, and NousResearch's "Hermes" is a model/dataset family,
not an agent framework. Recommended move: Phase-2 spike of AgentCore
Registry wired to the existing Skill Pipeline; defer any Strands
replacement discussion until post-v1.0.

---

## 1. AWS Agent Registry (Amazon Bedrock AgentCore Registry)

### What it is

A **centralized, governed catalog** inside Amazon Bedrock AgentCore for
discovering and managing agents, MCP servers, tools/skills, and custom
resources across an organization. Sourced directly from
`docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html` and
confirmed as a first-class AgentCore core service in
`what-is-bedrock-agentcore.html`.

Key capabilities (per AWS docs, verified this session):

| Capability | Detail |
|------------|--------|
| Record types | `MCP` (validated against official MCP registry schema), `Agent` (A2A v0.3 agent cards), `Agent Skills` (markdown + structured spec), `Custom` (any JSON) |
| Search | Hybrid **semantic + keyword** search with weighted relevance ranking, metadata filters by name/type/version |
| Governance | `DRAFT → PENDING_APPROVAL → APPROVED` workflow; curators can reject with feedback or `DEPRECATE` (terminal); optional auto-approve for dev |
| MCP-native access | Each registry exposes a **remote MCP endpoint** — any MCP client can discover resources via the MCP protocol itself, no AWS SDK required |
| Inbound auth | SigV4 (IAM, default) **or** JWT / OAuth 2.0 (Cognito, Okta, Azure Entra, Auth0, any OIDC) |
| Record sync | Auto-pull metadata from external MCP servers / A2A agents by URL (public, OAuth-protected via AgentCore Identity, or IAM-protected via SigV4) |
| Events | EventBridge notifications on record submission |
| APIs | Control plane `bedrock-agentcore-control` (create registries/records, approve); data plane `bedrock-agentcore` (`SearchRegistryRecords`, `InvokeRegistryMcp`) |
| Visibility rules | Search + MCP invoke return **APPROVED only**; `Get/ListRegistryRecords` see latest revision regardless of status |

### Release timeline + current status

- **Launch:** Registry appears in AgentCore's "Core services" table as a peer
  to Runtime/Memory/Gateway/Identity/Code Interpreter/Browser/Observability/
  Evaluations/Policy (`what-is-bedrock-agentcore.html`).
- **Dating evidence:** Schema version strings embedded in the documented
  Python examples are `schemaVersion: '2025-12-11'` for MCP server records
  and `protocolVersion: '2024-11-05'` for MCP tools. Combined with the
  fact that AgentCore itself went GA at re:Invent 2025 (the rest of the
  service family — Runtime, Memory, Gateway, Identity, Code Interpreter,
  Browser, Observability — was announced across Summit 2025 and re:Invent
  2025), Registry is almost certainly a **re:Invent 2025 launch**
  (Dec 2025) and is **generally available** as of April 2026.
- **Caveat:** I could not fetch AWS's `what's-new` index or the launch
  blog post in this session (WebFetch sandbox denied them). The GA claim
  is inferred from the schemaVersion date and the absence of any
  "preview" language on the main AgentCore page. Recommend confirming
  via <https://aws.amazon.com/new> before adoption.
- **Pricing:** Consumption-based, per the AgentCore pricing page.
  No specifics surfaced in the devguide.

### Overlap with Chimera's current setup

Chimera currently hand-rolls a large subset of Registry's feature surface:

| Chimera today | AgentCore Registry equivalent |
|---------------|-------------------------------|
| `chimera-skills` DynamoDB table + 7-stage Skill Pipeline (Step Functions) for scanning, approval, deployment | Registry's DRAFT → PENDING_APPROVAL → APPROVED workflow with curator review and deprecation states |
| Custom skill catalog API behind API Gateway | Registry's `SearchRegistryRecords` (hybrid semantic + keyword) |
| Cedar-policy-guarded skill publishing | Registry's JWT/IAM auth with EventBridge notifications feeding into Chimera's governance |
| No MCP-native discovery endpoint for external clients | Registry exposes a remote MCP endpoint per registry — clients can discover via MCP protocol |
| Custom A2A agent directory (design phase) | Registry's `Agent` record type validated against A2A v0.3 agent card schema |
| Ad-hoc MCP server list per tenant (planned for Orchestration stack) | Registry's `MCP` records with automated sync from external MCP server URLs |

### Migration delta

**What Chimera keeps:**
- MicroVM per-session isolation (Registry is a control plane, not a runtime)
- Strands ReAct loop inside the MicroVM
- AgentCore Runtime, Memory, Gateway, Identity, Code Interpreter, Browser
- Cedar policies (Registry complements, does not replace, Chimera's Cedar layer)
- 6-table DynamoDB schema for tenant/session/rate-limit/cost/audit state
- 7-stage Skill Pipeline's **security scanning** stages — these still run
  before a skill is published to Registry

**What Chimera replaces or consolidates:**
- Replace the custom skill-catalog DDB schema (`chimera-skills` PROFILE/
  CONFIG items) with Registry records (one per skill), keyed by tenant
- Replace the bespoke skill-discovery API with `SearchRegistryRecords`
  (or better — hand the MCP endpoint to the Strands agent directly)
- Fold the Skill Pipeline's "publish" final stage into a
  `submit_registry_record_for_approval` → `update_registry_record_status`
  call rather than a custom DDB write
- Retire the planned MCP-server directory work in the Orchestration stack
  in favor of Registry `MCP` records with URL sync

**New constraints to handle:**
- Registry records must conform to the validated schemas (MCP spec,
  A2A v0.3, AgentSkills spec). Chimera's internal skill format may need
  a one-time mapping layer.
- Multi-tenancy model: unclear from docs whether one registry per tenant
  or one registry with tenant-scoped records is the recommended pattern.
  Needs validation in Phase 2 spike (see Migration Risk below).

### Verdict: **Pilot (Phase 2 spike, then adopt)**

Registry solves real problems Chimera is actively building around
(skill discovery, governance, MCP exposure, A2A agent catalog). It does
not replace the ReAct loop or the MicroVM runtime, so risk is bounded to
the catalog/control-plane layer. Spike it on a dev tenant wired to the
existing Skill Pipeline scanner output, validate multi-tenant isolation,
then migrate `chimera-skills` writes behind a feature flag.

---

## 2. Hermes Agent Framework

### Identification (which Hermes?)

**Confidence: LOW. I could not confirm an agent framework named "Hermes"
that matches the user's description of "vs custom Strands agent."** The
Chimera repo itself has zero references to "Hermes." WebFetch access to
GitHub search, HN, and the NousResearch site was denied this session.

Top two candidates for user disambiguation:

**Candidate A — NousResearch Hermes (most likely interpretation, ~70% confidence):**
- **What it is:** A **model family**, not an agent framework. Hermes 2 /
  Hermes 3 are open-weight instruction-tuned LLMs (Llama-3 based) from
  NousResearch known for strong tool-use and function-calling
  fine-tuning. Repo of note: `NousResearch/hermes-function-calling`
  (datasets and inference recipes for function-calling with Hermes
  models).
- **Why the user might say "Hermes agent framework":** Because Hermes
  models were among the first open models with robust structured
  function-calling, they're often wrapped in thin agent loops — the
  "framework" framing is community shorthand, not an official product.
- **If this is what the user meant:** The comparison isn't apples-to-apples
  with Strands. Strands is a runtime/loop; Hermes is a model. You would
  run Hermes **inside** a Strands loop (or any other agent runtime),
  not instead of it.

**Candidate B — a niche Python `hermes` agent library:**
- There are several small unaffiliated GitHub projects named `hermes`
  or `hermes-agent` (messaging-framework style, LLM-dispatcher style).
  None has meaningful traction (all sub-1k stars based on prior
  knowledge; cannot verify live this session).
- **If this is what the user meant:** Maturity is insufficient for a
  production multi-tenant platform. None have AWS-native integration,
  Bedrock support, or AgentCore compatibility out of the box.

### Capabilities vs. Strands (assuming Candidate A — Hermes models)

| Dimension | Strands Agents SDK | Hermes (model) |
|-----------|---------------------|----------------|
| Category | Agent runtime / ReAct loop | LLM model weights |
| Language | Python | N/A (model) |
| Runtime | AgentCore Runtime MicroVM | Any inference stack |
| Tool-use / function-calling | Native, Bedrock tool-spec JSON | Strong — fine-tuned for it |
| Streaming | Native StreamEvents (the format `@chimera/sse-bridge` already consumes) | Token-level from provider |
| Multi-provider | 13+ providers including Bedrock | Served by many providers |
| AWS integration | First-class (Bedrock Converse API) | Available on Bedrock Marketplace / SageMaker JumpStart |
| Multi-tenant | Chimera-enforced via MicroVM + DDB partitions | N/A (model) |
| License | Apache-2.0 | Llama-3 community license (derivative constraints) |

### Production readiness + AWS integration

- If "Hermes" = NousResearch models: they are production-viable but the
  license is **Llama-3 community**, which has commercial-use restrictions
  above 700M MAU and attribution requirements. Less permissive than
  Anthropic/Bedrock-hosted Claude or the Apache-2.0 Strands runtime.
- No managed AWS runtime exists for Hermes specifically; you would
  self-host via SageMaker or import to Bedrock Custom Model Import.
  That's strictly **worse** AWS-native fit than continuing to call
  Claude / Nova / Llama via Bedrock's managed inference.
- No first-party streaming integration with AgentCore.

### Verdict: **Skip (pending user disambiguation)**

As a model family (Candidate A), Hermes doesn't replace Strands — it
could be *added* as one more model option inside Strands's provider
matrix, at the cost of Llama-3 license constraints and losing Bedrock's
managed inference. As a hypothetical Python framework (Candidate B),
there's no production-grade Hermes agent framework I could verify.
**Please tell me which "Hermes" you mean** and I'll re-scope.

---

## 3. Pi Agent Framework

### Identification (which Pi?)

**Confidence: HIGH.** This is **Mario Zechner's `@mariozechner/pi-agent-core`**
— the minimalist coding agent that powers OpenClaw. Chimera already has
extensive internal documentation on Pi from earlier competitive research:

- `docs/research/openclaw-nemoclaw-openfang/01-OpenClaw-Core-Architecture.md`
  (lines 204–274) — canonical Pi write-up
- `docs/research/integration-enhancement/03-Competitive-Analysis.md`
  (rows "Agent Loop Architecture", "Built-in Tools", "Model Fallback")

Package set:

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-ai` | Unified model abstraction across providers |
| `@mariozechner/pi-agent-core` | Core agent loop, session management, context engine |
| `@mariozechner/pi-coding-agent` | Coding agent with tools, extensions, config |
| `@mariozechner/pi-tui` | Terminal UI with retained-mode rendering |

Version cited in Chimera research: `0.49.3` (pre-1.0, fast-moving).

### Capabilities vs. Strands

| Dimension | Strands Agents SDK | Pi Agent Core |
|-----------|---------------------|---------------|
| Design philosophy | Batteries-included agent runtime | **Radical minimalism** — "the model knows what bash is" |
| Built-in tools | Ecosystem via Bedrock tool-spec | Exactly 4: `read`, `write`, `edit`, `bash` |
| System prompt size | Standard | **Sub-1,000 tokens** for prompt + tool defs |
| MCP support | Via AgentCore Gateway (first-class) | None built in (OpenClaw adds via `mcporter`) |
| Sub-agents | Native (multi-agent Strands) | None (compose via `bash`) |
| Plan mode / todos | Planned | None by design ("the model plans naturally") |
| Concurrency | Session-level in Strands, unlimited via AgentCore Runtime | **1 per daemon** (single-user assumption) |
| Session storage | DDB distributed (Chimera) | File-based (local disk) |
| Language | Python | TypeScript / JavaScript |
| Cold start | ~2–3s in MicroVM | ~6s (Node.js) per Chimera's competitive analysis |
| Streaming | StreamEvents consumed by `@chimera/sse-bridge` | Assistant-delta events (would need a new bridge) |
| License | Proprietary / source-available (Mario Zechner's personal project, not an open foundation) | n/a |

### Production readiness + AWS integration

- **Production readiness:** Pi is stable for **single-user local coding
  agents** (Armin Ronacher reportedly uses it "almost exclusively"). It
  is **not designed for**, and has **no built-in primitives for**,
  multi-tenant cloud deployment. Pre-1.0 (v0.49.3), no SLA, solo
  maintainer.
- **AWS integration:** None. Pi is runtime-agnostic but expects a local
  filesystem session model (MEMORY.md, file-based transcripts). Adapting
  to MicroVM + DynamoDB sessions + Bedrock Converse streams would be a
  rewrite of the session, context, and streaming layers — essentially
  recreating what Strands already provides.
- **Multi-tenancy:** Actively hostile. Single-daemon-per-user,
  file-based state. Chimera's per-tenant MicroVM isolation, DDB
  partition-keyed sessions, and Cedar-policy-gated tool access have no
  Pi equivalent.
- **Chat-platform streaming:** The Vercel AI SDK DSP bridge
  (`packages/sse-bridge`) is built around Strands's event shape. Pi's
  event stream is structurally different and would need a new adapter.

### Verdict: **Skip**

Pi is optimized for the opposite problem — a single developer's
local-first coding agent with minimal surface area. Chimera's job is
multi-tenant SaaS. Switching would discard:

1. Strands's Bedrock-native tool-use and model-fallback
2. AgentCore Runtime integration (Pi has no managed-runtime story)
3. `@chimera/sse-bridge` (event shape mismatch)
4. DDB-distributed session model
5. Cedar policy enforcement hooks

…in exchange for a smaller system prompt and a 4-tool philosophy that
the rest of Chimera's platform (browser automation, code interpreter,
MCP gateway) actively contradicts.

---

## Comparison Matrix

| Axis | Strands (status quo) | AgentCore Registry | Hermes (NousResearch model) | Pi Agent Core |
|------|----------------------|-------------------|-----------------------------|---------------|
| Category | Agent runtime / ReAct loop | Governed catalog / control plane | LLM model family | Local coding-agent SDK |
| AWS-native | Yes (Bedrock Converse) | **Yes (AgentCore first-party)** | Self-host via SageMaker or import | No |
| Multi-tenant | Yes (via Chimera MicroVM + DDB) | Yes (IAM/JWT per-registry auth) | N/A (model) | **No** (single-daemon) |
| Streaming | Native StreamEvents (SSE bridge ready) | N/A (control plane) | Provider-level tokens | Assistant deltas (incompatible w/ bridge) |
| Tool-use | Native tool-spec, Bedrock function-calling | MCP + A2A discovery | Strong (fine-tuned) but runtime-provided | 4 tools only, no MCP by default |
| Managed runtime | AgentCore Runtime | N/A — complements Runtime | None | None |
| License | Apache-2.0 | AWS service (commercial) | Llama-3 community | Source-available, solo maintainer |
| Maturity | GA, production-backed by AWS | GA (inferred, Dec 2025 launch) | Production models, v3 | Pre-1.0 (v0.49.3) |
| Community | AWS-backed, growing | AWS-backed | Active OSS community | Single maintainer + OpenClaw ecosystem |
| Fit for Chimera | Core runtime ✓ | **Adopt for catalog/governance** ✓ | Optional extra model | Architectural mismatch |

---

## Migration Risk Assessment

### Adopting AgentCore Registry (Pilot)

**Risk: Medium-Low.** Scoped to control plane, does not touch the
Runtime/MicroVM/Strands path.

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Multi-tenant isolation model unclear — one registry per tenant vs. one registry with tenant-scoped records | Medium | Phase 2 spike on dev account; test IAM scoping + JWT claims both ways; if per-tenant registries are required, evaluate registry creation quotas/costs |
| Schema mapping: Chimera's internal skill format → Registry `AgentSkills` spec | Medium | Build a one-time migration script + dual-write behind feature flag |
| Skill Pipeline's custom scanning stages must stay pre-Registry | Low | Architecture already supports this — Registry is the destination after approval, not a replacement for scanning |
| Registry GA confirmation | Low | Verify via AWS What's New / launch blog before committing; worst case, wait for GA if still in preview |
| EventBridge event schema drift | Low | Subscribe via pattern match; version-tolerant consumers |
| Loss of Cedar-policy-gated publishing semantics | Medium | Registry's approval workflow + JWT auth is weaker than Cedar's fine-grained ABAC; keep Cedar as the publish-permission gate and let Registry be the storage/search layer |
| Cost of migration vs. benefit | Low | Small net code deletion once live (replaces ~2 custom API routes + DDB writes) |

### Hermes (any variant) — N/A

Skip verdict; re-assess after user confirms which "Hermes" they meant.

### Pi Agent Core — N/A

Skip verdict; adoption would require rewriting session/streaming/tenancy
layers to match Strands's current behaviour.

---

## Open Questions for User

1. **Hermes disambiguation:** NousResearch Hermes models, or a specific
   Python framework you've seen referenced? Link would help.
2. **AgentCore Registry GA confirmation:** I could not reach the AWS
   What's New feed this session. Can you confirm the launch date /
   GA status from AWS's announcement channel?
3. **Registry tenancy model preference:** One registry per tenant, or
   one shared registry with tenant-scoped records? This drives the
   Phase 2 spike scope.

---

## Sources

### Primary (verified this session)

- **AWS Bedrock AgentCore overview (GA service list includes Registry):**
  <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html>
  — verified 2026-04-17. Lists Registry as a peer of Runtime, Memory,
  Gateway, Identity, Code Interpreter, Browser, Observability,
  Evaluations, Policy.
- **AgentCore Registry detail page:**
  <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html>
  — verified 2026-04-17. Source for record types, hybrid search,
  approval workflow, MCP endpoint, schema versions (`2025-12-11` for
  MCP server records), Python SDK examples, visibility rules, URL
  synchronization.
- **AgentCore product page:**
  <https://aws.amazon.com/bedrock/agentcore/> — verified 2026-04-17
  (Registry not yet listed in the marketing features table; present in
  the devguide).

### Primary (in-repo — Chimera's own research)

- `docs/research/openclaw-nemoclaw-openfang/01-OpenClaw-Core-Architecture.md`
  lines 204–274 — canonical Pi write-up used for Section 3
- `docs/research/integration-enhancement/03-Competitive-Analysis.md`
  lines 149–337 — Pi vs. Chimera on runtime, security, multi-tenancy,
  memory, multi-provider
- `docs/research/agentcore-strands/*` — 11 files covering Strands
  runtime, AgentCore APIs, multi-tenancy, Vercel AI SDK chat layer
- `packages/sse-bridge/README.md` — confirms Strands StreamEvents is
  the bridge's input contract

### Primary (could not reach this session — sandbox denied WebFetch)

- AWS What's New feed (`https://aws.amazon.com/new/`)
- AWS blog announcement for AgentCore Registry
- NousResearch GitHub / `hermes-function-calling` repo
- `@mariozechner/pi-agent-core` npm / GitHub page (for latest version
  confirmation; Chimera research cites v0.49.3)
- GitHub repository search for any standalone "Hermes" agent framework

If the user wants stronger confirmation on Registry GA timing or a
definitive Hermes identification, those URLs should be fetched from an
environment with unrestricted web access.
