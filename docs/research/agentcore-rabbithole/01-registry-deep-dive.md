---
title: "AWS Bedrock AgentCore Registry — Deep-Dive Reference"
status: research
date: 2026-04-17
author: builder-cherry-pick-main
phase: rabbithole-01
supersedes: []
related:
  - docs/reviews/agent-framework-alternatives.md
  - docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md
  - docs/reviews/wave4-registry-migration-delta.md
  - docs/designs/agentcore-registry-spike.md
---

# AgentCore Registry — Deep-Dive Reference

This is the canonical Chimera reference for Amazon Bedrock AgentCore Registry.
It consolidates the verified primary-source facts from the framework
alternatives memo (`docs/reviews/agent-framework-alternatives.md` §1),
the migration delta (`docs/reviews/wave4-registry-migration-delta.md`),
and ADR-034, refreshed against the AWS devguide on 2026-04-17.

Where a fact was re-verified this session the source page is cited inline.
Where a fact is inferred or still unconfirmed it is explicitly flagged so
readers don't treat it as primary evidence.

---

## 1. Summary for Chimera

**What Registry is.** A governed, multi-type, discovery-friendly catalog
inside Amazon Bedrock AgentCore. It stores four kinds of records — MCP
servers, agents (A2A cards), agent skills, and custom JSON — behind an
approval workflow, exposes them via both an AWS API (`SearchRegistryRecords`)
and a per-registry remote MCP endpoint (`InvokeRegistryMcp`), and emits
EventBridge notifications when records are submitted for approval.
AWS confirms Registry as a first-class core service peer to Runtime,
Memory, Gateway, Identity, Code Interpreter, Browser, Observability,
Evaluations, and Policy (re-verified on `what-is-bedrock-agentcore.html`,
2026-04-17).

**Where it saves Chimera work.** Registry absorbs a sizeable slice of
what Chimera currently hand-rolls:

- The `chimera-skills` DDB table (PROFILE / CONFIG / APPROVAL items) and
  its custom state machine map directly to a Registry `AgentSkills` record
  with the DRAFT → PENDING_APPROVAL → APPROVED → DEPRECATED workflow.
- The bespoke skill-discovery API backed by GSI queries collapses into
  `SearchRegistryRecords` (hybrid semantic + keyword search).
- The planned per-tenant MCP directory work in the Orchestration stack is
  pre-empted by Registry `MCP` records with optional URL synchronization.
- The planned A2A agent directory is pre-empted by Registry `Agent`
  records, which are validated against A2A agent-card schemas.
- External MCP clients (including the Strands agent itself) can discover
  Chimera skills via the MCP protocol directly, no Chimera SDK needed.

**Where it does NOT help.** Registry is a **control plane**. It does not
replace, overlap, or touch:

- The Strands ReAct loop inside the MicroVM (runtime concern, not catalog).
- The MicroVM isolation model (AgentCore Runtime territory).
- The Skill Pipeline's 6 security-scanning stages (scan pre-publish; Registry
  is only the publish destination).
- Cedar ABAC policies (Registry's approval workflow is coarser-grained;
  Cedar stays as the publish-permission gate).
- The `@chimera/sse-bridge` event contract (stream-shape concern).

**Top 3 decisions.**

1. **Adopt behind a feature flag.** `CHIMERA_SKILL_CATALOG_BACKEND=ddb|registry|dual`.
   Default stays `ddb` until the Phase-2 spike resolves multi-tenancy.
   (ADR-034 §Decision.)
2. **Resolve the multi-tenancy question via spike before any production
   write.** Per-tenant Registry vs. shared Registry with tenant-scoped
   records is not answered by AWS documentation. The spike
   (`docs/designs/agentcore-registry-spike.md`) is the gate.
3. **Keep the 6 scanning stages; rewrite only stage 7.** The pipeline's
   publish stage re-points from a DDB write to
   `CreateRegistryRecord` + `SubmitRegistryRecordForApproval` +
   `UpdateRegistryRecordStatus`. No scanner code changes. See
   `docs/reviews/wave4-registry-migration-delta.md` for the per-file
   inventory.

---

## 2. API Surface

Registry exposes a split between a **control plane** (administrative
CRUD on registries and records, approval workflow transitions) and a
**data plane** (search, MCP invocation). The `APIReference/Welcome.html`
page (verified 2026-04-17) confirms the data plane service name is
`bedrock-agentcore`. The devguide examples in `registry-searching.html`
reference the control plane as `bedrock-agentcore-control` (e.g.,
`aws bedrock-agentcore-control update-registry …`).

### 2.1 Control plane (`bedrock-agentcore-control`)

Operations (names re-verified from the devguide):

- `CreateRegistry` — provisions a new registry; enters `Creating` state,
  transitions to `Ready` when provisioned (see §7 EventBridge).
- `UpdateRegistry` — updates registry configuration including the
  `CustomJWTAuthorizerConfiguration` (discoveryUrl, allowedClients,
  allowedAudience) and auto-approval settings.
- `DeleteRegistry` — tears down a registry.
- `CreateRegistryRecord` — submits a new record in `Draft` state.
- `UpdateRegistryRecord` — edits an existing record (creates a new
  revision).
- `GetRegistryRecord` — returns the **latest revision regardless of
  approval status**. This is the only API that can read non-approved
  records.
- `ListRegistryRecords` — enumerates records; returns latest revision
  regardless of status.
- `DeleteRegistryRecord` — removes a record.
- `SubmitRegistryRecordForApproval` — DRAFT → PENDING_APPROVAL.
- `UpdateRegistryRecordStatus` — curator action for APPROVED / REJECTED /
  DEPRECATED transitions.

### 2.2 Data plane (`bedrock-agentcore`)

- `SearchRegistryRecords` — hybrid semantic + keyword search, returns
  **APPROVED records only**. Request parameters (confirmed on
  `registry-searching.html`):
  - `searchQuery` (required, 1–256 characters, natural language).
  - `registryIds` (required, **exactly one** registry ARN or ID).
  - `maxResults` (optional, 1–20, default 10).
  - `filters` (optional, metadata filter expression; see §5).
- `InvokeRegistryMcp` — MCP protocol invocation against the registry's
  remote MCP endpoint; returns APPROVED records only.

### 2.3 Example invocation (Boto3, IAM auth; verified on `registry-searching.html`)

```python
import boto3
client = boto3.client('bedrock-agentcore')
response = client.search_registry_records(
    registryIds=['<registryARN>'], searchQuery='weather', maxResults=10
)
```

Equivalent CLI is `aws bedrock-agentcore search-registry-records`.
OAuth-based registries use an HTTP POST to
`/registry-records/search` with a `Bearer <accessToken>` header against
the `bedrock-agentcore.<region>.amazonaws.com` host.

---

## 3. Record Types

Registry validates records against their respective protocol schemas and
attaches custom metadata. The devguide confirms four descriptor types:
`MCP`, `A2A` (the Agent record type's descriptor value in filters),
`SKILL` (Agent Skills), `CUSTOM`.

### 3.1 MCP records

- Validated against the **official MCP registry schema** published at
  `github.com/modelcontextprotocol/registry`. The framework-alternatives
  memo cites the schemaVersion string `2025-12-11` for MCP server
  records (could not re-fetch that GitHub repo this session — sandbox
  denied — so the version is reused from the prior verification rather
  than re-confirmed 2026-04-17).
- Registry MCP endpoint itself conforms to the MCP spec
  **`2025-11-25`** (confirmed on `registry-searching.html` under "Using
  the Registry MCP endpoint").
- Tool definitions inside an MCP record (tool name, description, input
  parameter names) feed Registry's semantic search.

### 3.2 Agent records

- Validated against the **Agent-to-Agent (A2A) agent-card** schema. The
  framework memo references A2A v0.3; this was not re-verified this
  session against a primary A2A source, so treat the version as
  "agent-card-shaped, likely v0.3" until re-confirmed.
- Metadata filter `descriptorType: { "$eq": "A2A" }` confirms A2A is the
  filter-level identifier for this type.

### 3.3 AgentSkills records

- Markdown + structured spec (skill.md v2 style). Chimera's internal
  skill format (`ADR-018`) maps onto this type.
- Name, description, and full descriptor content all contribute to search
  relevance (§5).

### 3.4 Custom records

- Arbitrary JSON. No protocol schema validation; Registry still applies
  the approval workflow, visibility rules, and search indexing.
- Filter value: `descriptorType: { "$eq": "CUSTOM" }`.

### 3.5 Shared attributes (all record types)

- `name`, `description`, `version`, `descriptorType` (filterable fields,
  confirmed on `registry-searching.html`).
- Full descriptor body (protocol-specific).
- Status: one of DRAFT, PENDING_APPROVAL, APPROVED, REJECTED, DEPRECATED
  (the framework memo spelled these as DRAFT / PENDING_APPROVAL /
  APPROVED / DEPRECATED; the search page also explicitly names
  "Rejected" as a non-returned state, so REJECTED exists as a
  fifth status distinct from deprecation).

---

## 4. Approval Workflow

```
               ┌──────────────────────────────────────────┐
               │                                          │
CreateRegistryRecord                                      │
       │                                                  │
       ▼                                                  │
    DRAFT ──SubmitRegistryRecordForApproval──▶ PENDING_APPROVAL
                                                    │
                  UpdateRegistryRecordStatus ────────┤
                                                    │
                  ┌─────────────┬───────────────────┤
                  ▼             ▼                   ▼
               APPROVED     REJECTED          (back to DRAFT on edit)
                  │
                  │ UpdateRegistryRecordStatus
                  ▼
              DEPRECATED   (terminal)
```

Key properties (from `registry.html` and `registry-searching.html`):

- **DRAFT** is the initial state of a new record.
- **PENDING_APPROVAL** is entered via `SubmitRegistryRecordForApproval`
  and is the state EventBridge fires on (see §7).
- **APPROVED** is the only status that search (`SearchRegistryRecords`)
  and the MCP endpoint (`InvokeRegistryMcp`) will return.
- **REJECTED** and **DEPRECATED** records are never returned by search
  or MCP. Curators can move records into DEPRECATED for end-of-life
  governance.
- Auto-approve is an **optional registry setting** (confirmed in the
  `registry.html` core-resources description: registries carry an
  "approval settings" configuration). Chimera's Phase-2 spike needs to
  decide whether to turn this on for dev tenants.
- The **GetRegistryRecord** API is the escape hatch: it returns the
  latest revision regardless of status, which is what the UI and the
  curator tooling need.

---

## 5. Search

### 5.1 Hybrid model

Every call to `SearchRegistryRecords` runs two searches in parallel and
merges the ranked results (verified on `registry-searching.html`):

- **Semantic search.** Query is vectorized; records are ranked by vector
  similarity across `name`, `description`, and full descriptor content.
  Intended for conceptual queries ("find a tool that can book flights"
  matches a record named `travel-reservation-service`).
- **Keyword search.** Query is matched against record text fields.
  Within keyword scoring, **name has the strongest influence**, followed
  by description and descriptor content (which contribute equally).
  Intended for exact name lookups (`weather-api-v2`).

Merged ranking favors records that score highly in **both** searches.
The devguide explicitly warns against mixing filter-like constraints
("all MCP servers") into the query text — use metadata filters for that.

### 5.2 Metadata filters

Operators and fields (verbatim from `registry-searching.html`):

- **Filterable fields:** `name`, `descriptorType`, `version`.
- **Field-level operators:** `$eq` (equals), `$ne` (not equals), `$in`
  (matches any value in a list).
- **Logical operators:** `$and`, `$or`.

Examples: `{"descriptorType":{"$eq":"MCP"}}`;
`{"$and":[{"descriptorType":{"$eq":"MCP"}},{"version":{"$eq":"1.0"}}]}`;
`{"version":{"$in":["1.0","1.1","2.0"]}}`.

Filters are applied **before** scoring, reducing the candidate set
rather than post-filtering results.

### 5.3 Visibility

- Search and the MCP endpoint return **APPROVED only**.
- `GetRegistryRecord` / `ListRegistryRecords` return the latest revision
  regardless of status.

### 5.4 Eventual consistency

The devguide warns explicitly (verified this session): indexing is
eventually consistent.

- After `UpdateRegistryRecordStatus` to APPROVED, the record "typically
  takes a few seconds to become discoverable, but in some cases it can
  take up to a few minutes."
- During that window, `SearchRegistryRecords` and `InvokeRegistryMcp`
  return empty results for that record; `GetRegistryRecord` still works.
- **AWS-recommended handling:** exponential-backoff retry on search
  after approval; confirm via `GetRegistryRecord`; in EventBridge-driven
  pipelines "add a brief delay before downstream systems query search."
- Implication for Chimera: the Skill Pipeline's final publish stage
  should not assume the record is searchable immediately after
  `UpdateRegistryRecordStatus`.

### 5.5 Latency

Not explicitly documented. The spike (`docs/designs/agentcore-registry-spike.md`)
targets p99 < 500ms for `SearchRegistryRecords` based on Chimera's
internal requirement, but **AWS has not published a latency SLA**. Treat
as a thing to measure, not a thing to assume.

---

## 6. MCP Endpoint

Each registry exposes an MCP-compatible remote endpoint that any MCP
client (Kiro, Claude Code, a Strands agent, a custom client) can hit.
Details from `registry-searching.html`:

- **URL shape:** `https://bedrock-agentcore.<region>.amazonaws.com/registry/<registryId>/mcp`
- **MCP spec version:** `2025-11-25` (per the devguide's explicit link).
- **Exposed tools:** exactly one — `search_registry_records`.
  - Parameters: `searchQuery` (required string), `maxResults` (1–20,
    default 10), `filter` (optional metadata filter object using `$eq`,
    `$ne`, `$in`, `$and`, `$or` on `name`, `descriptorType`, `version`).
- **Visibility:** same as `SearchRegistryRecords` — APPROVED records
  only, eventually consistent.

### 6.1 Auth on the MCP endpoint

Two modes, both confirmed on the same page:

**IAM (SigV4) mode** — requires `bedrock-agentcore:InvokeRegistryMcp` on
the registry ARN; full tool invocation also requires
`bedrock-agentcore:SearchRegistryRecords`. AWS provides the
[`mcp-proxy-for-aws`](https://github.com/aws/mcp-proxy-for-aws) shim for
SigV4-signing from MCP clients that don't natively speak AWS auth.

**OAuth / JWT mode** — the registry's `CustomJWTAuthorizerConfiguration`
enforces:
- `discoveryUrl` — the OIDC discovery document URL.
- `allowedClients` — a list of client IDs permitted to call the endpoint
  (pre-registered client model), OR
- `allowedAudience` — a list of valid `aud` claim values (dynamic client
  registration model).
- The endpoint advertises an `.well-known/oauth-protected-resource`
  document at
  `https://bedrock-agentcore.<region>.amazonaws.com/.well-known/oauth-protected-resource/registry/<registryId>/mcp`
  and a `WWW-Authenticate: Bearer resource_metadata="…"` header for
  discovery.
- Known gotcha: the registry does **not** currently return a scope
  challenge in the `WWW-Authenticate` header, so some MCP clients need
  explicit `oauthScopes` in their config (the devguide calls out Kiro).

### 6.2 Who can invoke

- Any principal with the required IAM permission, or any bearer of a
  JWT matching the configured authorizer.
- Strands agents inside Chimera MicroVMs can call the endpoint directly
  — no Chimera-side proxy required. This eliminates a previously planned
  proxy service from the Orchestration stack scope.

---

## 7. Auth Models

**Inbound auth** on the registry is one of:

1. **IAM (SigV4, default).** Standard AWS IAM policies on the registry
   ARN. Example action: `bedrock-agentcore:SearchRegistryRecords`.
2. **Custom JWT (OAuth 2.0 / OIDC).** Works with Cognito, Okta, Azure
   Entra, Auth0, or any OIDC provider. Configured via
   `CustomJWTAuthorizerConfiguration` on the registry.

Both modes gate **all** access paths (console, CLI, SDK, HTTP, MCP
endpoint). The AWS Console only supports IAM-authorized registries; JWT
registries must be driven via CLI / SDK / HTTP / MCP clients.

**Outbound auth** (when Registry syncs records from external MCP servers
/ A2A agents by URL) is handled through **AgentCore Identity** and
supports public, OAuth-protected (via Identity), or IAM-protected (via
SigV4) target endpoints. See §9.

---

## 8. Multi-Tenancy — THE KEY OPEN QUESTION

This is the single largest unknown blocking Chimera adoption. The
devguide pages re-fetched this session do not resolve it. Two patterns
are feasible; both are evaluated in `docs/designs/agentcore-registry-spike.md`.

### 8.1 Pattern A — one registry per tenant

- One `CreateRegistry` call per tenant; records scoped by registry ARN.
- **Pros:** Hard isolation boundary — cross-tenant access requires
  cross-account or explicit IAM resource-arn grants. Per-tenant
  approval queues, per-tenant quotas, per-tenant IAM policies fit
  naturally.
- **Cons:** Cost scales linearly with tenant count. Per-account
  registry quotas (not published in the devguide) could bottleneck at
  1000-tenant SaaS scale. Curator tooling has to iterate N registries
  for ops dashboards.

### 8.2 Pattern B — one shared registry, tenant-scoped records

- Single registry; records carry a `tenantId` custom attribute; IAM or
  JWT conditions gate which records each tenant can see.
- **Pros:** Flat cost regardless of tenant count. Single approval queue
  to curate. Simpler ops.
- **Cons:** `SearchRegistryRecords` does not (per current devguide)
  support tenant-claim filtering as a first-class primitive — this
  would depend on IAM condition keys or JWT-based record-level ABAC,
  neither of which is documented today. **Risk of cross-tenant read via
  `ListRegistryRecords` or ill-filtered search is real and must be
  probed in the spike.** Chimera's existing GSI cross-tenant pattern
  (mandatory `FilterExpression='tenantId = :tid'`) hints at how fragile
  this class of filter is in practice.

### 8.3 Confidence level

**LOW confidence** that either pattern is AWS's recommended path — the
devguide does not prescribe. **MEDIUM confidence** that Pattern A
(per-tenant registries) will pass spike auth probes; **LOWER confidence**
that Pattern B survives a thorough cross-tenant read test without
additional Chimera-layer enforcement. Chimera's default planning
assumption (until the spike runs) is Pattern A with a fallback to
Pattern B + app-layer filter if quotas or cost make A infeasible.

Cross-link: `docs/designs/agentcore-registry-spike.md` — Day 2 auth
probe resolves this with evidence.

---

## 9. URL Sync (external MCP server / A2A agent pull)

Registry can **auto-pull metadata** from external MCP server URLs or
A2A agent endpoints, keeping the Registry record in sync with the
external source of truth. Per the framework memo (not re-verified at a
sub-page this session):

- **Unauthenticated:** public URLs.
- **OAuth-protected:** auth handled through AgentCore Identity.
- **IAM-protected:** auth via SigV4.

This pre-empts Chimera's planned work in the Orchestration stack to
maintain its own per-tenant MCP server list. Open question for the
spike: sync cadence, failure-handling behavior (does a 404 deprecate
the record, or just skip?), and whether the sync source is versioned.

---

## 10. EventBridge Integration

From `registry-eventbridge.html` (verified this session):

- **Event bus:** the **default** Amazon EventBridge bus in the same
  account.
- **Source:** `aws.bedrock-agentcore`.
- **Detail types observed:**
  - `Registry Record State changed to Pending Approval` — fires when
    `SubmitRegistryRecordForApproval` is called.
  - `Registry State transitions from Creating to Ready` — fires after
    `CreateRegistry` once provisioning completes.
- Delivery / latency guarantees: **not documented** on the EventBridge
  sub-page. The spike targets P99 < 30s end-to-end as a success
  criterion, not an AWS-stated SLA.
- The full event schema is on `registry-notifications-approvals.md`
  which was not fetched this session; Chimera consumers should subscribe
  via **pattern match (source + detail-type prefix)** rather than
  exact-match to tolerate post-GA schema drift — this is a general AWS
  pattern, not a Registry-specific statement.

Implication: the approved-status transition (`APPROVED`) is **not
listed** in the two event types above. That suggests either (a) the
approval transition does NOT currently emit an EventBridge event, or
(b) it emits an event the sub-page did not enumerate. This is an open
question for the spike — Chimera's dual-write migration flow assumes
the approval transition is observable via EventBridge; if it isn't,
we need to poll or hook into the `UpdateRegistryRecordStatus` call
site inside Chimera's code path.

---

## 11. Limits, Gotchas, and Unknowns

### 11.1 Confirmed numeric limits (from devguide)

- `searchQuery`: 1–256 characters.
- `maxResults`: 1–20, default 10.
- `registryIds` on `SearchRegistryRecords`: **exactly one** registry per
  call (confirmed on `registry-searching.html`). Cross-registry federated
  search is not a first-class operation — multi-registry tenants would
  have to fan out queries.

### 11.2 Undocumented (not in fetched pages)

- Per-account registry quotas.
- Per-registry record count limits.
- Per-record size limit (descriptor body).
- Registry API rate limits (control + data plane).
- Per-region availability (the devguide does not include a region table).
- Pricing: see §12.
- Whether approval-transition events are emitted (see §10 above).

### 11.3 Gotchas verified this session

- **Eventual consistency on approval.** Retry with backoff; don't
  assume immediate discoverability (§5.4).
- **Console only works for IAM registries.** JWT registries need CLI /
  HTTP / MCP clients (`registry-searching.html`).
- **MCP scope-challenge absence.** Registry does not return a scope
  challenge in the `WWW-Authenticate` header; some MCP clients need
  explicit `oauthScopes` configuration (§6.1).
- **`ListRegistryRecords` returns latest revision regardless of status.**
  In a Pattern-B multi-tenant model, this is the single most dangerous
  API surface for cross-tenant leakage. The spike must probe it hard.
- **Name-weighted ranking.** Within keyword search, record name
  dominates ranking. Skill publishers must choose discoverable names,
  not internal-code-only identifiers.

---

## 12. Pricing

- Official statement on the AgentCore overview page (verified this
  session): **"consumption-based pricing with no upfront commitments or
  minimum fees. For more information, see AgentCore pricing."** No
  per-service breakdown on that page.
- The product page (`aws.amazon.com/bedrock/agentcore/`) could not be
  fetched this session (sandbox denied) so the published pricing table
  was not re-inspected. The framework memo notes Registry pricing is
  not itemized in the devguide.
- **Open question for Chimera:** per-record storage cost, per-search-API
  cost, per-MCP-invoke cost, EventBridge event cost. The spike's Day 4
  Cost Explorer pass produces a 5-day measurement and extrapolation
  rather than relying on a published number.

**Do not design capacity planning around an assumed pricing model until
the spike produces measured numbers.**

---

## 13. Regional Availability

- The devguide overview page does not include a regional availability
  table (verified this session).
- All code examples use `us-east-1` which suggests (weakly) initial
  launch scope. This is not a confirmed claim.
- GA vs. preview status: the framework memo inferred **GA** from
  schemaVersion dates (`2025-12-11` on MCP server records) and the
  absence of any "preview" language in the devguide. The "What's New"
  feed could not be re-fetched this session, so GA status remains
  **inferred, not confirmed**. ADR-034 open question #3 still applies.

---

## 14. Mapping to Chimera

The full per-file migration inventory lives in
**`docs/reviews/wave4-registry-migration-delta.md`**. Short summary
of the mapping:

| Chimera component | Registry primitive | Disposition |
|-------------------|--------------------|-------------|
| `chimera-skills` DDB PROFILE/CONFIG/APPROVAL | Registry `AgentSkills` records + approval workflow | REPLACE (dual-write → cutover) |
| Skill Pipeline stages 1–6 (scanners) | (none) | KEEP unchanged |
| Skill Pipeline stage 7 (publish) | `CreateRegistryRecord` + `SubmitRegistryRecordForApproval` + `UpdateRegistryRecordStatus` | REPLACE |
| Custom skill-catalog API (`/api/v1/tenants/{id}/skills` GET) | `SearchRegistryRecords` | REPLACE |
| Per-tenant MCP server directory (Orchestration stack, planned) | Registry `MCP` records + URL sync | ABSORB (delete planned work) |
| A2A agent directory (future) | Registry `Agent` records (A2A card validation) | ABSORB (delete planned work) |
| Cedar publish-permission gate | (unchanged — runs in front of Registry calls) | KEEP |
| Ed25519 signature of skill bundles | Attach as Registry record attribute | KEEP + ATTACH |
| SNS alarm on scan failure | Keep; also DEPRECATE Registry record if already published | KEEP + AUGMENT |
| `packages/core/src/skills/registry.ts` (DDB-backed) | `BedrockRegistryClient` | REWRITE |
| `packages/core/src/skills/discovery.ts` | Registry MCP client or SDK `SearchRegistryRecords` | REWRITE |
| `packages/core/src/skills/{validator,trust-engine,parser}.ts` | Pre-publish validation | KEEP |
| `seed-data/skills.json` (~50 records) | One-time bulk import to Registry | MIGRATE |

New code to write (per the delta doc): ~900 LOC / 5 engineering days.

### Multi-tenant routing sketch

- **Pattern A:** one registry per tenant; publish and query route by
  registry ARN; isolation enforced by IAM resource-arn scoping.
- **Pattern B:** one shared registry; records tagged `tenantId`; reads
  go through `SearchRegistryRecords` with a Chimera-layer post-retrieval
  `FilterExpression(tenantId=T?)`. That is the same defense-in-depth
  pattern applied to DDB GSIs across the codebase — it works, but it's
  **post-retrieval**, not a pre-retrieval authz boundary, so a bug in
  the filter logic leaks data across tenants.

---

## 15. Sources

### Re-verified 2026-04-17

- `docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html`
  — Registry listed as peer service #10 of 10 core services; pricing pointer;
  no regional table; no GA/preview label on this page.
- `docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html`
  — record types, workflow verbs (pending-approval / approved / rejected /
  deprecated), hybrid search framing, MCP endpoint framing, IAM/JWT
  auth modes, personas (Administrator / Publisher / Curator / Consumer),
  EventBridge + CloudTrail integration, access methods.
- `docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-searching.html`
  — exact request parameters for `SearchRegistryRecords`; filter operators
  `$eq`/`$ne`/`$in`/`$and`/`$or` on `name`/`descriptorType`/`version`;
  hybrid search mechanics (semantic in parallel with keyword; name
  weighting); eventual-consistency warning with AWS-recommended backoff;
  APPROVED-only visibility; MCP endpoint URL shape and spec version
  (`2025-11-25`); OAuth and IAM client setup; known MCP-client gotchas.
- `docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-eventbridge.html`
  — event source `aws.bedrock-agentcore`; two confirmed detail types
  (record pending approval, registry ready); default bus delivery.
- `docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/Welcome.html`
  — confirms the data-plane API reference page and the `bedrock-agentcore`
  service namespace (page doc date: April 18, 2026).

### Denied this session (sandbox)

- `aws.amazon.com/bedrock/agentcore/` (marketing page) — denied; framework
  memo cites it for the pricing pointer and feature list. Content
  reused from prior session verification.
- `aws.amazon.com/about-aws/whats-new/2025/` — denied; GA status remains
  **inferred**, not independently confirmed. ADR-034 open question #3.
- `github.com/modelcontextprotocol/registry` — denied; schemaVersion
  `2025-12-11` is reused from the framework memo without re-verification.

### In-repo primary sources

- `docs/reviews/agent-framework-alternatives.md` §1 — the canonical Chimera
  Registry write-up; this deep-dive expands on that section.
- `docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md` —
  decision, alternatives, risks, open questions.
- `docs/reviews/wave4-registry-migration-delta.md` — per-file inventory
  referenced in §14.
- `docs/designs/agentcore-registry-spike.md` — the Phase-2 spike that
  resolves multi-tenancy / cost / EventBridge open questions.

---

## 16. Open Questions for the Spike

Cross-linked to `docs/designs/agentcore-registry-spike.md`. All of these
must produce evidence before ADR-034 moves from `proposed` to `accepted`.

1. **Multi-tenancy pattern.** Pattern A (per-tenant registries) vs.
   Pattern B (shared registry + tenant-scoped records). Primary failure
   mode: cross-tenant read via `ListRegistryRecords` or unfiltered
   `SearchRegistryRecords` in Pattern B. Spike Day 2 auth probe.
2. **Per-account registry quota.** Blocks Pattern A at scale if the
   quota is lower than Chimera's tenant roadmap. Raise a support ticket
   early if Pattern A is leading.
3. **Pricing model per-record + per-search + per-MCP-invoke.**
   Measured via Cost Explorer across 5 spike days.
4. **GA confirmation.** Currently inferred. Required precondition on
   spike Day 1 — resolved by visiting What's New or the launch blog.
5. **EventBridge coverage of status transitions.** The devguide names
   "pending approval" + "registry ready"; the APPROVED / REJECTED /
   DEPRECATED transitions are not enumerated. Spike Day 4 subscribes
   broadly and records what fires.
6. **Registry MCP-endpoint auth from inside a MicroVM.** SigV4 from the
   VM's task role, or JWT from a tenant identity pool? Both probed.
7. **Schema mapping gaps.** skill.md v2 (ADR-018) → Registry
   `AgentSkills` spec. Any fields not expressible in the Registry
   schema need a custom-attribute fallback.
8. **Auto-approve for trusted scanner output.** Does the registry
   config support auto-approve for a specific submitter identity, or is
   approval always curator-gated? If the latter, Chimera either bypasses
   the approval flow (self-approve via `UpdateRegistryRecordStatus`) or
   routes approvals through a Chimera curator service.
9. **Rate limits on `SearchRegistryRecords` and `InvokeRegistryMcp`.**
   Not documented. Spike Day 3 runs a small load test.
10. **Degradation behavior.** What does Chimera do if Registry is
    unavailable mid-request? Fall back to `chimera-skills` (during
    dual-write phase)? Fail closed? Defined by feature flag phase.

---

## 17. What I Could NOT Verify This Session

Readers should discount claims that depend on these fetches until they
are re-verified in a less-restricted environment:

- **AWS What's New announcement** for AgentCore Registry — GA status
  remains **inferred** from the absence of "preview" language in the
  devguide, not confirmed by an AWS announcement.
- **AgentCore marketing product page** (`aws.amazon.com/bedrock/agentcore/`)
  — pricing pointer and feature list reused from the framework memo
  rather than re-verified this session.
- **MCP Registry specification on GitHub** — schemaVersion `2025-12-11`
  for MCP server records is reused from the prior session; the repo
  `github.com/modelcontextprotocol/registry` was not reachable this
  session. Chimera's Registry integration validates against whatever
  schema version AWS publishes; the exact spec version is informational
  rather than load-bearing for adoption.
- **A2A agent-card version** — cited as "v0.3" from the framework memo,
  not re-verified against the A2A spec this session.
- **APPROVED/REJECTED/DEPRECATED EventBridge coverage** — only the
  pending-approval and registry-ready events were enumerated on
  `registry-eventbridge.html`; the status-transition events are not
  explicitly named in the devguide pages fetched this session.

---

*End of deep-dive. Next in rabbithole sequence: `02-runtime-memory-deep-dive.md`.*
