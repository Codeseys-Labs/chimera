---
title: 'AgentCore Registry — Phase 2 Spike Proposal'
status: proposed
date: 2026-04-17
owner: chimera-architecture-team
related_adr: docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md
---

# AgentCore Registry — Phase 2 Spike Proposal

## Goal

Confirm the multi-tenancy model, cost profile, and EventBridge integration behavior of AWS AgentCore Registry in **~1 week on a dev tenant**, so that ADR-034 (AgentCore Registry adoption) can move from `proposed` to `accepted` with evidence.

The framework-alternatives research memo flagged three open questions that block a production migration: (1) whether one registry per tenant or one shared registry with tenant-scoped records is the recommended pattern, (2) per-record and per-search pricing, and (3) EventBridge event schema + delivery guarantees. This spike answers all three without touching production code.

## Scope

**In scope:**

- Stand up **two** registry configurations in a dev AWS account:
  - **Pattern A — shared registry, tenant-scoped records:** one registry with records tagged by `tenant_id` and scoped by IAM conditions / JWT claims.
  - **Pattern B — per-tenant registries:** one registry per synthetic tenant, isolated by registry ARN.
- Write **one skill record** (sourced from an existing `chimera-skills` item, mapped to the `AgentSkills` schema) to each pattern via both auth modes: SigV4 (IAM) and JWT (Cognito).
- Measure:
  - **Auth behavior:** does Pattern A's IAM scoping prevent cross-tenant reads? does JWT scoping behave identically? are there known gotchas (e.g. `ListRegistryRecords` returning all records regardless of tenant tag)?
  - **Discovery behavior:** call `SearchRegistryRecords` from each tenant context; confirm results are tenant-filtered. Call the remote MCP endpoint from a Strands client and confirm tool discovery works end-to-end.
  - **EventBridge behavior:** subscribe to Registry events in both patterns; measure event latency, schema stability, and whether tenant identity is carried in the event payload.
  - **Cost:** record per-request cost via Cost Explorer tags for the 5-day window. Record storage cost, control-plane API cost, data-plane search cost, and EventBridge event cost separately.

**Out of scope:**

- Any production cutover. `chimera-skills` writes remain unchanged.
- Deletion or migration of the existing `chimera-skills` DynamoDB table.
- Wiring Registry into the Skill Pipeline's final publish stage. That happens in a follow-up task after the spike succeeds.
- Changes to the Strands ReAct loop, the MicroVM Runtime, or any Cedar policy.
- Any CDK changes to the mainline stacks; spike resources are provisioned via a disposable standalone CDK app or via the AWS CLI, tagged for teardown.

## Approach

1. **Day 1 — Setup.** Confirm Registry GA status via AWS What's New (precondition from ADR-034 open question #3). Create two synthetic tenants (`tenant-spike-alpha`, `tenant-spike-beta`) in a dev account. Provision Pattern A (one registry, two records) and Pattern B (two registries, one record each).
2. **Day 2 — Auth probe.** From each tenant's IAM role and JWT identity, attempt to read the other tenant's record. Record the outcome for `SearchRegistryRecords`, `GetRegistryRecord`, `ListRegistryRecords`, and `InvokeRegistryMcp`. Any cross-tenant read in Pattern A is a blocker for the shared-registry model.
3. **Day 3 — Discovery + MCP.** Point a Strands agent (using a dev MicroVM) at each pattern's remote MCP endpoint. Confirm that `list_tools` / `call_tool` return tenant-correct results. Compare developer ergonomics between the two patterns.
4. **Day 4 — Events + cost.** Subscribe an EventBridge rule to Registry events in both patterns. Submit, approve, and deprecate a test record; measure event latency and confirm tenant identity is extractable from the event payload. Pull cost data from Cost Explorer.
5. **Day 5 — Decision + teardown.** Write up findings in a follow-up memo under `docs/reviews/`. Recommend Pattern A or Pattern B (or "defer — Registry not ready") to the architecture team. Tear down all spike resources via a single `aws resourcegroupstaggingapi get-resources --tag-filters Key=Purpose,Values=registry-spike` sweep.

## Success Criteria

Three bullets, measured at the end of the spike week:

- **Multi-tenancy decision made.** Pattern A or Pattern B is recommended with evidence (auth probe results, discovery probe results), or the spike explicitly reports "neither pattern is viable — defer adoption" with a named reason.
- **Cost per record observed.** Storage, control-plane, data-plane, and EventBridge costs for the 5-day window are broken out and extrapolated to Chimera's expected skill volume (~N records per tenant × M tenants). This number enters ADR-034's "Negative consequences" section as a measured value, not an open question.
- **EventBridge integration confirmed.** Registry events are received on a subscribed rule, include tenant identity in the payload, and arrive within an acceptable latency bound (spike target: P99 < 30s end-to-end). If any of these fails, the integration constraint is documented and the orchestration-stack work plan adjusts accordingly.

## Rollback Story

The spike is designed to be destructive-free:

- **No production code changes.** `chimera-skills`, the Skill Pipeline, the Orchestration stack, and the Strands runtime are all untouched. The feature flag defined in ADR-034 (`CHIMERA_SKILL_CATALOG_BACKEND`) stays at its default `ddb` value throughout.
- **All spike resources are tagged `Purpose=registry-spike`.** Registries, IAM roles, Cognito user pools, EventBridge rules, CloudWatch log groups — everything. Teardown uses `aws resourcegroupstaggingapi get-resources --tag-filters Key=Purpose,Values=registry-spike` to enumerate, then `aws <service> delete-*` per resource type in a single script.
- **Dev account only.** The spike runs in a sandboxed AWS account. No IAM roles or policies in the production or staging accounts are modified.
- **If the spike fails** (either multi-tenancy model is unviable, cost is prohibitive, or EventBridge integration is broken): no-op rollback. ADR-034 stays in `proposed` status, `chimera-skills` continues as the catalog of record, the Orchestration stack's MCP-directory work proceeds as originally planned. The spike findings update ADR-034's "Open Questions" section with the new evidence.

## Risks to the Spike Itself

- **GA status still unconfirmed at kickoff.** If AWS What's New does not confirm Registry GA, the spike pauses at Day 1 and the team re-evaluates whether to run against a preview/limited-release service. No dev resources are provisioned until this is resolved.
- **Dev account quota limits.** Pattern B creates two registries; if per-account registry quotas are low or require a support ticket, the spike for Pattern B stalls. Mitigation: request quota increase on Day 1 before provisioning.
- **Cost extrapolation inaccuracy.** Five-day cost × 73 does not cleanly extrapolate to annual cost because consumption-based pricing may have volume discounts or minimums. The spike report calls out the extrapolation method explicitly and flags its assumptions.
- **EventBridge event schema could change post-GA.** Record the schema version observed and note the risk; subscribe via pattern match rather than exact match in any follow-up production integration.

## Owner + Timeline

- **Owner:** chimera-architecture-team (assigned to a single engineer + one reviewer for the decision memo).
- **Timeline:** 5 working days, target kickoff once ADR-034 open question #3 (GA confirmation) is resolved.
- **Exit artifact:** a spike-report memo at `docs/reviews/registry-spike-results.md` that either promotes ADR-034 to `accepted` with the Pattern A/B decision, or keeps it `proposed` with documented blockers.

## References

- `docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md` — the ADR this spike resolves.
- `docs/reviews/agent-framework-alternatives.md` — original research memo, Section 1 and Migration Risk table.
- `docs/reviews/SYNTHESIS.md` — Phase 2 synthesis, strategic move #1.
- AgentCore Registry devguide: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html>
