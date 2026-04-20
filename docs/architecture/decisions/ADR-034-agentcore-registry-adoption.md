---
title: 'ADR-034: AWS AgentCore Registry Adoption for Skill Catalog and Discovery'
status: accepted (partial — Phase 0-1 only)
date: 2026-04-17
decision_makers: [chimera-architecture-team]
---

# ADR-034: AWS AgentCore Registry Adoption for Skill Catalog and Discovery

## Status

**Proposed** (2026-04-17)

## Context

Three waves of deep-work review (`docs/reviews/`) converged on the same recommendation for Chimera's skill-catalog layer:

1. **Wave 1 — Phase 1 framework research** (`docs/reviews/agent-framework-alternatives.md`) identified AWS AgentCore Registry as a governed catalog for MCP servers, A2A agents, and skills that covers the exact discovery, versioning, approval-workflow, and auth surfaces Chimera is hand-rolling today.
2. **Wave 2 — Phase 2 synthesis** (`docs/reviews/SYNTHESIS.md`, "Top Two Strategic Moves") named Registry adoption as strategic move #1: the high-ROI "adopt-now" action from the review.
3. **Wave 3 — review verdict** confirmed the fit is bounded to Chimera's control plane (not Runtime, not MicroVM, not the Strands ReAct loop), which keeps migration risk localized.

Chimera currently hand-rolls a meaningful slice of Registry's feature surface:

- **`chimera-skills` DynamoDB table** stores skill PROFILE/CONFIG/APPROVAL items with custom state transitions.
- **7-stage Skill Pipeline** (Step Functions) performs security scanning, then writes approved skills to `chimera-skills` via a bespoke "publish" final stage.
- **Custom skill-catalog API** behind API Gateway serves discovery to the agent runtime.
- **No MCP-native discovery endpoint** exists for external MCP clients; skills are discoverable only via Chimera's private API.
- **Planned MCP-server directory** in the Orchestration stack duplicates what Registry's `MCP` record type already provides.

AgentCore Registry (documented at `docs/aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html`, verified in the agent-framework-alternatives memo) offers:

- `DRAFT → PENDING_APPROVAL → APPROVED` workflow with curator review and `DEPRECATE` terminal state.
- Hybrid semantic + keyword search via `SearchRegistryRecords`.
- A **remote MCP endpoint per registry** — any MCP client (including the Strands agent itself) can discover resources via the MCP protocol, no AWS SDK required.
- SigV4 (IAM) or JWT / OAuth 2.0 (Cognito, Okta, Azure Entra, Auth0, any OIDC) inbound auth.
- EventBridge notifications on record submission.
- Record types for `MCP` servers, `Agent` (A2A v0.3 agent cards), `AgentSkills`, and `Custom` JSON.

**Release status caveat:** The framework memo inferred Registry is GA based on schema version strings (`2025-12-11`) and the absence of "preview" language in the devguide, but could not reach the AWS What's New feed to confirm. This ADR treats Registry as GA-likely-but-not-confirmed, and makes confirmation a precondition of the Phase-2 spike (see `docs/designs/agentcore-registry-spike.md`).

## Decision

**Pilot AgentCore Registry for the Chimera skill catalog and discovery layer, keeping the Strands ReAct loop and the Skill Pipeline's security-scanning stages intact. Migrate `chimera-skills` writes behind a feature flag after the Phase-2 spike resolves the multi-tenancy model.**

Specifically:

1. **Registry becomes the catalog of record** for skills, MCP servers, and (eventually) A2A agents. `chimera-skills` DDB writes are fronted by a dual-write adapter during migration.
2. **Strands stays as the ReAct loop.** Registry is a control-plane / discovery service; it does not replace the MicroVM-hosted Python agent runtime.
3. **Security-scanning stages of the Skill Pipeline remain.** The 7-stage pipeline's scanning logic runs pre-Registry. Only the pipeline's final "publish" stage is re-pointed from a DDB write to `submit_registry_record_for_approval` → `update_registry_record_status`.
4. **Feature-flagged migration.** A `CHIMERA_SKILL_CATALOG_BACKEND=ddb|registry|dual` environment flag lets the runtime read from either source during the migration window. Default stays `ddb` until the spike confirms multi-tenancy behavior.
5. **Cedar remains the publish-permission gate.** Registry's approval workflow is an additional control, not a replacement for Chimera's ABAC policies.
6. **MCP-native discovery is exposed to agents.** The Strands agent can call Registry's remote MCP endpoint directly for skill lookup, eliminating the need for a custom discovery API once migration completes.

## Alternatives Considered

### Alternative 1: Pilot AgentCore Registry (Selected)

Adopt Registry for catalog/discovery behind a feature flag after a Phase-2 spike.

**Pros:**
- Deletes custom code we currently maintain (DDB schema, discovery API route, planned MCP directory).
- MCP-native discovery opens the skill catalog to any MCP client, not just Chimera's runtime.
- First-party AWS service — inherits IAM, EventBridge, CloudWatch, SigV4 for free.
- Governance workflow (DRAFT → APPROVED → DEPRECATED) is stronger than the ad-hoc states in `chimera-skills` today.
- Risk is bounded to the control plane; Runtime/MicroVM/Strands are untouched.

**Cons:**
- Multi-tenancy model (one registry per tenant vs. one registry with tenant-scoped records) is not documented by AWS. Requires spike to resolve.
- Registry pricing is consumption-based per the AgentCore pricing page but no specifics surfaced in the devguide.
- Service maturity: AgentCore Registry is inferred GA as of Dec 2025 re:Invent launch, but not independently confirmed in this review.

**Verdict:** Selected — contingent on Phase-2 spike resolving multi-tenancy and confirming GA status.

### Alternative 2: Stay on custom `chimera-skills` + Skill Pipeline

Keep hand-rolling the catalog, discovery, and MCP directory.

**Pros:**
- No migration work; continues shipping against the current plan.
- Complete control over schema and workflow semantics.

**Cons:**
- ❌ Ongoing maintenance of code that duplicates a managed AWS service.
- ❌ No MCP-native discovery means external MCP clients cannot interoperate with Chimera's skill catalog without a custom adapter.
- ❌ Adds scope (planned MCP directory work in Orchestration stack) that Registry would absorb.

**Verdict:** Rejected — choosing this path knowingly duplicates AWS-managed functionality.

### Alternative 3: Adopt LangChain / LangGraph for catalog + runtime

Replace both the catalog and the Strands ReAct loop with LangChain tooling.

**Pros:**
- Large OSS ecosystem.

**Cons:**
- ❌ Out of scope for this ADR — Wave 1 framework research already ruled this out in favor of keeping Strands (AWS-native, Bedrock Converse, streams the event shape the SSE bridge already consumes).
- ❌ Does not solve the catalog problem; LangChain is runtime-focused.

**Verdict:** Rejected — conflates two unrelated concerns and contradicts the Phase 1 runtime recommendation.

## Consequences

### Positive

- **Less code to maintain.** The `chimera-skills` schema, the custom discovery API, and the planned MCP directory collapse into Registry records + a thin adapter.
- **MCP-native discovery.** Any MCP client (the Strands agent, external agents, a future A2A peer) discovers skills via the MCP protocol — no Chimera-specific integration required.
- **Governed catalog.** Registry's approval workflow makes skill promotion an auditable, curator-gated operation rather than a DDB condition expression.
- **EventBridge integration for free.** Record submission and state transitions emit EventBridge events, feeding into Chimera's existing observability + orchestration bus.
- **A2A-ready.** Registry's `Agent` record type validates against A2A v0.3 agent cards, which aligns with Chimera's future inter-tenant agent directory work.

### Negative

- **Multi-tenant model not yet proven.** AWS docs don't specify whether one-registry-per-tenant or one-registry-with-tenant-scoped-records is the recommended pattern. The Phase-2 spike is required to resolve this before committing.
- **Registry pricing unknown.** The devguide says "consumption-based, per AgentCore pricing page" but no numbers surfaced. Cost per record and per `SearchRegistryRecords` call must be measured during the spike.
- **Schema mapping required.** Chimera's internal skill format maps to Registry's `AgentSkills` spec but is not identical. A one-time migration script + dual-write adapter are new code, even if the net outcome is less total code.
- **Stricter schema validation.** Registry validates `MCP` records against the official MCP registry schema and `Agent` records against A2A v0.3. Any Chimera record that drifts from those schemas will be rejected at publish time.

### Risks

- **AWS service maturity.** AgentCore launched at re:Invent 2025; Registry is the newest peer service in the AgentCore family. Early-service risks apply: API churn, quota limits, region availability. Mitigated by feature-flagging the migration and keeping `chimera-skills` as a fallback until Registry has been stable for at least one release cycle.
- **Vendor lock-in.** Registry is AWS-specific. Mitigated because Chimera already depends on Bedrock, AgentCore Runtime, AgentCore Memory, and AgentCore Gateway — Registry does not change the lock-in posture. The `chimera-skills` custom schema was similarly AWS-locked (DynamoDB).
- **Multi-tenancy leakage.** If Registry records are not partition-isolated by tenant, the catalog could leak skill metadata across tenants. The Phase-2 spike tests both IAM scoping and JWT claims to validate isolation before any production record is written. Mitigation of last resort: one registry per tenant, at the cost of quota and management overhead.
- **EventBridge event schema drift.** Registry's EventBridge events are a new dependency. Mitigated by subscribing via pattern match and building version-tolerant consumers.
- **GA confirmation outstanding.** The framework memo flagged Registry as GA-inferred, not GA-confirmed. Mitigation: verify via AWS What's New + launch blog before committing beyond the spike; if still in preview, delay migration and maintain the current custom catalog.

## Evidence

- **`docs/reviews/agent-framework-alternatives.md`** — primary research memo. Section 1 "AWS Agent Registry", the comparison matrix, and the migration risk table all feed this ADR. Flags GA status as inferred not confirmed.
- **`docs/reviews/SYNTHESIS.md`** — names Registry adoption as strategic move #1 ("Top Two Strategic Moves").
- **AWS Bedrock AgentCore overview:** <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html> — Registry listed as peer of Runtime, Memory, Gateway, Identity, Code Interpreter, Browser, Observability, Evaluations, Policy.
- **AgentCore Registry devguide page:** <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html> — source for record types, hybrid search, approval workflow, MCP endpoint, schema versions, Python SDK examples, visibility rules, URL synchronization.
- **AgentCore product page:** <https://aws.amazon.com/bedrock/agentcore/> — Registry not yet listed in the marketing features table; present in the devguide.

## Related Decisions

- **ADR-003** (Strands agent framework): Registry complements Strands — Strands remains the ReAct loop, Registry becomes the skill catalog Strands queries.
- **ADR-007** (AgentCore MicroVM): untouched — Registry is a control plane, not a runtime.
- **ADR-009** (Universal skill adapter): Registry's `AgentSkills` schema sits downstream of the adapter; the adapter still normalizes heterogeneous skill sources before publishing.
- **ADR-018** (skill.md v2): Chimera's skill.md format maps to Registry's `AgentSkills` spec; ADR-018 remains authoritative for authoring, Registry becomes the governed storage layer.
- **ADR-033** (Tenant context injection for Python tools): related because both ADRs touch multi-tenant isolation. ADR-033 enforces isolation at the Python tool layer; this ADR's spike confirms isolation at the Registry layer before any production write.

## Open Questions

1. **Multi-tenancy model.** One registry per tenant, or one shared registry with tenant-scoped records? AWS docs do not specify. Phase-2 spike (`docs/designs/agentcore-registry-spike.md`) resolves this on a dev tenant.
2. **Registry pricing.** Consumption-based but no per-record or per-search pricing surfaced in the devguide. Must be measured during the spike.
3. **GA confirmation.** Inferred from schema version strings (`2025-12-11`) and absence of "preview" language; not confirmed via AWS What's New. Verify before the spike begins.
4. **Cedar interop.** How does Registry's approval workflow compose with Chimera's Cedar publish-permission gate? The current plan keeps Cedar upstream of Registry, but the interop surface needs concrete design once the spike is underway.
5. **Rollback path.** If the spike fails on multi-tenancy or cost, the fallback is to keep `chimera-skills` as-is. No production code changes during the spike, and spike resources are tagged `Purpose=registry-spike` for one-sweep teardown.
6. **Spike remains the gate for Phase 2 enablement.** The Phase-0/1 scaffolding (adapters, feature flags, dual-write, dual-read) has landed behind default-off flags, but `docs/designs/agentcore-registry-spike.md` is still the mandatory precondition before `REGISTRY_PRIMARY_READ` is enabled in any production environment. Until the spike returns evidence on multi-tenancy (Pattern A vs. Pattern B), pricing, and EventBridge coverage, Phase 2 stays dev-only.

## Implementation Status (2026-04-18)

Phase 0 and Phase 1 scaffolding has landed on `main`. All new behavior is gated behind feature flags that default to off, so production behavior is unchanged.

- **Phase 0 — adapter code landed** (`packages/core/src/registry/*`). ✅ `BedrockRegistryClient` and `skill-to-registry-mapper` in place; SDK imports are dynamic so the repo still builds without the `@aws-sdk/client-bedrock-agentcore*` packages installed.
- **Phase 0 — feature flags landed** (`packages/core/src/registry/feature-flags.ts`). ✅ Central resolver for `REGISTRY_ENABLED`, `REGISTRY_PRIMARY_READ`, `DDB_WRITE_SKILLS_DISABLED`, `REGISTRY_ID`, `REGISTRY_REGION`.
- **Phase 1 — dual-write scaffolding landed** in `infra/lambdas/skill-pipeline/skill-deployment/`. ✅ (flag-gated, default off). Stage 7 of the skill pipeline writes to DDB as before and additionally calls `CreateRegistryRecord` + `SubmitRegistryRecordForApproval` when `REGISTRY_ENABLED=true`. Registry write failures emit a `Chimera/Registry/RegistryWriteFailure` metric but do not fail the Lambda.
- **Phase 2 — dual-read scaffolding landed** in `infra/lambdas/api-handlers/skills/`. ✅ (flag-gated, default off). Discovery path tries Registry first and falls back to DDB when `REGISTRY_PRIMARY_READ=true`; emits `RegistryReadSuccess` / `RegistryFallback` / `RegistryReadError` metrics.
- **Phase 2 execution BLOCKED ON:** the spike at `docs/designs/agentcore-registry-spike.md` resolving the multi-tenancy model (Pattern A vs. Pattern B). Dual-read is safe to *exercise* on a dev tenant with synthetic data, but Phase 2 cannot be enabled in production until the spike closes with an evidence-backed decision.
- **Phase 3-6 — not started.** Bulk migration (Phase 3), Registry-primary reads in prod (Phase 4), DDB write disable (Phase 5), and table teardown (Phase 6) all remain future work. They are not blocked on the spike the same way Phase 2 is, but each requires Phase 2 to land first.

Operator guide for enabling Phase 1 on dev (including rollback): `docs/MIGRATION-registry.md`.

## References

1. AgentCore Registry devguide: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html>
2. AgentCore overview: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html>
3. AgentCore product page: <https://aws.amazon.com/bedrock/agentcore/>
4. Framework alternatives research memo: `docs/reviews/agent-framework-alternatives.md`
5. Phase 2 synthesis: `docs/reviews/SYNTHESIS.md`
6. Registry spike proposal: `docs/designs/agentcore-registry-spike.md`
