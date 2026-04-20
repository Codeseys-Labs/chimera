---
title: "AgentCore Gateway + Identity — Deep Dive"
version: 0.1.0
status: draft
last_updated: 2026-04-17
---

# AgentCore Gateway + Identity — Deep Dive

> Research target: **AWS Bedrock AgentCore Gateway** (`bedrock-agentcore:CreateGateway`)
> and **AWS Bedrock AgentCore Identity** (`bedrock-agentcore-identity`).
> Context: Chimera already advertises "AgentCore Gateway + Identity" in its README
> but implements a custom Lambda-fanout layer (`gateway_proxy.py`, `gateway_config.py`,
> `GatewayRegistrationStack`). This doc asks: *what do the managed services actually
> do, and what of Chimera's custom layer is now redundant?*

---

## TL;DR for Chimera

1. **Chimera's current "Gateway" is not using AgentCore Gateway at all.** It is a
   tier-grouped Lambda fanout that the Python agent invokes via `boto3.invoke` with a
   custom `{tool_name, action, tool_input, tenant_id}` envelope. There is no
   MCP endpoint, no JWT inbound authorizer, no credential-provider attachment, no
   semantic-tool-search, no managed schema catalog. It is a hand-rolled tool
   dispatcher that borrows the Gateway *name*.

2. **AgentCore Gateway is an MCP server-as-a-service** (endpoint shape:
   `https://gateway-id.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp`) that
   exposes Lambda / OpenAPI / API Gateway / Smithy / remote-MCP / one-click SaaS
   templates as tools, handles the JWT inbound authorizer, injects outbound creds
   from AgentCore Identity, and optionally does vector-embedding semantic search
   over the tool catalog. All of that is managed.

3. **AgentCore Identity is the managed OAuth broker + token vault** for agents.
   Inbound = JWT/OIDC validation (any OAuth-compliant IdP, including Cognito).
   Outbound = built-in 2LO + 3LO flows for Google, GitHub, Slack, Salesforce,
   Atlassian/Jira, Microsoft, plus `CustomOauth2` for anything else. Tokens are
   encrypted per-`(agent_identity, user_id)` in a KMS-backed vault and refreshed
   automatically by the SDK (`@requires_access_token`, `@requires_api_key`).

4. **The single biggest simplification opportunity:** replace
   `packages/agents/gateway_proxy.py` + `GatewayRegistrationStack`'s four tier Lambdas
   with a real `CreateGateway` + N `CreateGatewayTarget` (Lambda or Smithy) config,
   and let Strands' MCP client hit the managed `/mcp` endpoint. The Python agent
   stops building proxy callables; `boto3.invoke` goes away; payload-size /
   nesting-depth guards move server-side; and the four Python "dispatcher" Lambdas
   (`TIER1_HANDLER`…`DISCOVERY_HANDLER`, inline in
   `infra/lib/gateway-registration-stack.ts`) become ~19 named Gateway targets
   backed by `boto3`-per-service micro-Lambdas or Smithy RestJson targets.
   **Estimated net reduction: ~1,500 LOC of custom dispatch + 4 inline Python
   handlers + 4 SSM params + an entire tier-routing scheme.**

5. **Cedar is NOT replaced by Identity.** Cedar does application-level authz
   (tenant isolation, suspended-tenant deny, trial-tier skill restrictions).
   Identity does edge authn (JWT validation) and outbound credential brokering.
   They are composable: Gateway's inbound JWT authorizer validates the user's
   token; Chimera's Cedar layer then evaluates user→action→resource within the
   tenant. Only the ad-hoc Cedar policies that duplicate "is the JWT valid" or
   "does the user have this OAuth scope" can be retired.

---

## Gateway

### What it is

AgentCore Gateway is **a fully managed MCP server**. Per the AWS docs:

> "Gateway acts as an MCP server — Translation — Converts agent requests using
> protocols like Model Context Protocol (MCP) into API requests and Lambda
> invocations."

Architecturally it is a three-part service:

| Concern         | What Gateway does                                                   |
|-----------------|---------------------------------------------------------------------|
| Security Guard  | Validates inbound OAuth/JWT before dispatch                         |
| Translation     | `tools/list` + `tools/call` MCP JSON-RPC ⇄ REST / Lambda / Smithy   |
| Composition     | N targets × M tools → one `/mcp` endpoint per gateway               |
| Cred Exchange   | Injects outbound IAM SigV4, API keys, or OAuth on a per-target basis |
| Semantic Search | Optional; pre-computed vector embeddings per tool; `x_amz_bedrock_agentcore_search` tool |
| Infra           | Serverless, auto-scaling, built-in CloudWatch log group             |

The managed endpoint is per-gateway:
```
https://<gateway-id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp
```

Any MCP-compatible client (Strands, CrewAI, LangGraph, LlamaIndex) can connect
with one line:
```python
from mcp.client.streamable_http import streamablehttp_client
mcp_client = MCPClient(lambda: streamablehttp_client(gateway_url))
with mcp_client:
    tools = get_full_tools_list(mcp_client)
```

### Target types

Gateway supports **six** target types. This is the exhaustive list from the
current docs:

| Target type                      | What you give it                                           | Who invokes                                 |
|----------------------------------|------------------------------------------------------------|---------------------------------------------|
| **AWS Lambda**                   | Function ARN + JSON tool schema                            | Gateway calls `lambda:InvokeFunction` as the gateway execution role |
| **OpenAPI 3.0 / 3.1 schema**     | OpenAPI doc (S3 or inline); `operationId` required per op  | Gateway calls your HTTPS endpoint directly  |
| **Amazon API Gateway REST stage**| API ID + stage name; Gateway internally calls `GetExport`  | Same AWS account + region only; public endpoints only; no `{proxy+}` |
| **Smithy model**                 | RestJson Smithy model (≤10 MB)                             | AWS service targets via Smithy-generated calls |
| **Remote MCP server**            | Another MCP endpoint (HTTP); protocol versions `2025-06-18`, `2025-03-26`, `2025-11-25` | Gateway fronts another MCP server; only the `tools` capability is relayed |
| **Built-in SaaS template**       | 1-click Salesforce / Slack / Jira / Asana / Zendesk / Confluence / MS Teams / OneDrive / SharePoint / Exchange / BambooHR / PagerDuty / ServiceNow / Zoom / Tavily / Brave Search / DynamoDB / CloudWatch / Bedrock Runtime | Console-only (not available via API) |

**Key constraint on Lambda targets:** Gateway prefixes tool names with the
target name using `___` (triple underscore). Your Lambda handler must strip it:
```python
delimiter = "___"
original = context.client_context.custom['bedrockAgentCoreToolName']
tool_name = original[original.index(delimiter) + len(delimiter):]
```

**Key constraint on OpenAPI targets:** `oneOf` / `anyOf` / `allOf`, complex
parameter serializers, and custom media types (beyond `application/json`) are
not supported. Swagger 2.0 is not supported — OpenAPI 3.0 / 3.1 only.

**Key constraint on remote MCP targets:** JSON Schema reference keywords
(`$ref`, `$defs`, `$anchor`, etc.) are **not** supported in relayed tool
definitions. You have to inline the schemas.

**Key constraint on Smithy targets:** Only RestJson protocol. Custom Smithy
models for non-AWS services are **not** accepted — it's AWS-services-only, via
the [aws/api-models-aws](https://github.com/aws/api-models-aws) repo.

### Auth model

Every gateway has **exactly one** inbound authorizer configured at create time:

| Inbound authorizer   | Notes                                                        |
|----------------------|--------------------------------------------------------------|
| `NONE`               | No auth; dev / testing only                                  |
| `CUSTOM_JWT`         | OAuth 2.0 discovery URL + allowed audience + allowed client + allowed scopes + optional custom-claim rules. IdP-agnostic: Cognito, Auth0, Okta, etc. |

> "Since MCP only supports OAuth, each Gateway must have an attached OAuth
> authorizer."

**Outbound auth** is configured **per target**, not per gateway. The options:

| Outbound method  | Where it applies                                                |
|------------------|-----------------------------------------------------------------|
| **IAM / SigV4**  | The gateway's execution role; used for AWS targets (Lambda, API GW, Smithy). Required for remote MCP targets hosted on AgentCore Runtime, AgentCore Gateway, API GW, or Lambda URLs |
| **API Key**      | Stored in an AgentCore Identity *credential provider*; injected as header by Gateway |
| **OAuth2 2LO**   | Client credentials grant; configured via AgentCore Identity credential provider; agent never sees the token |
| **OAuth2 3LO**   | Authorization Code grant with URL Session Binding (10-min window); `CompleteResourceTokenAuth` finalizes the flow |
| **None**         | Explicitly not recommended                                      |

This is the boundary line: **Gateway owns the *dispatch*; Identity owns the
*credentials*.** When a target is OAuth-protected, Gateway looks up the right
credential provider from Identity and attaches the token at invocation time.

### Caching

1. **Tool catalog indexing:** On `CreateGatewayTarget` and `UpdateGatewayTarget`,
   Gateway synchronizes tools from the target. For remote MCP targets, this
   means fetching the target's `tools/list` result and caching it in the
   Gateway catalog.
2. **Explicit resync:** `PUT /gateways/{gatewayIdentifier}/synchronize` returns
   202 immediately and reprocesses in the background.
3. **Vector embedding cache (semantic search):** When semantic search is
   enabled, Gateway pre-computes embeddings for every tool's
   name + description. Agents then call the built-in
   `x_amz_bedrock_agentcore_search` tool instead of loading all N tools into
   their context.
4. **Per-request result caching:** Not documented. Assume no result cache —
   each `tools/call` hits the target.

### Observability

- CloudWatch Logs group per gateway: `/aws/bedrock-agentcore/gateways/<gateway-id>`.
- `aws logs tail /aws/bedrock-agentcore/gateways/<id> --follow` gives live invocation logs.
- CloudTrail captures control-plane calls (CreateGateway, SynchronizeGatewayTargets, and the GetExport used for API GW targets).
- Per-tool CloudWatch metrics: **not documented** as of April 2026. If Chimera
  needs per-tool / per-tenant dashboards, they'll have to build that from the
  log group (log-insights queries) or via the tool Lambda itself.

### Rate limiting

Not documented. Gateway is pitched as "serverless, auto-scaling." Assume
account-level Bedrock throttles apply and build per-tenant rate limiting at the
agent layer (which Chimera already does via `chimera-rate-limits` token bucket).

### Pricing

Not published on the public Gateway doc page that we could fetch in research.
Per AWS service norms, expect a per-invocation price plus the cost of whatever
backs the target (Lambda invocations, API Gateway, external API bandwidth).
**Confirm from the live pricing page before building a cost model.**

---

## Identity

### Inbound

AgentCore Identity's **inbound authorizer** is the same primitive Gateway and
Runtime both consume. It validates JSON Web Tokens against:

| Validation rule           | Notes                                                          |
|---------------------------|----------------------------------------------------------------|
| Discovery URL             | Must match `^.+/\.well-known/openid-configuration$`            |
| Allowed audiences         | Checked against `aud` claim                                    |
| Allowed clients           | Checked against `client_id` claim                              |
| Allowed scopes            | At least one scope in the token must match                     |
| Required custom claims    | `CustomClaimValidationType`: claim name, value type (`STRING` / `STRING_ARRAY`), operator (`EQUALS`, `CONTAINS`, `CONTAINS_ANY`) |

> "At least one of the fields is required for the configuration: allowed
> audiences, allowed clients, allowed scopes, or required custom claims."

SigV4 is supported for AWS-native callers (e.g., `agentcore invoke` uses IAM
credentials). Cognito User Pools are supported as an OAuth 2.0 authorization
server out of the box.

**Relationship to the Gateway inbound authorizer:** they are literally the same
configuration type (`CustomJWTAuthorizerConfiguration`). Configuring it on a
gateway vs. on a runtime is one `CreateGateway` / `CreateAgentRuntime` call.

### Outbound (OAuth broker)

This is the high-leverage feature Chimera does not yet use. Identity ships
built-in OAuth 2.0 credential providers:

| Provider                | Vendor string       |
|-------------------------|---------------------|
| Google                  | `GoogleOauth2`      |
| GitHub                  | `GithubOauth2`      |
| Slack                   | (built-in)          |
| Salesforce              | (built-in)          |
| Atlassian / Jira        | (built-in)          |
| Microsoft               | (console option)    |
| Anything else           | `CustomOauth2`      |

Both grant types:

- **2LO (client credentials)** — M2M, no user present. Batch jobs, cron agents,
  data pipelines.
- **3LO (authorization code)** — user consent, agent acts on a user's behalf.
  Flow:

  1. Agent function is decorated with `@requires_access_token(provider_name=..., scopes=[...], auth_flow="USER_FEDERATION", on_auth_url=<callback>, callback_url=<bound URL>)`.
  2. First call with no cached token: SDK invokes `CreateWorkloadIdentity` →
     `GetWorkloadAccessToken` → `GetResourceOauth2Token`.
  3. SDK emits an authorization URL via the `on_auth_url` callback; user
     authorizes at the provider.
  4. Provider redirects to the AgentCore callback URL. **URL Session Binding**
     couples the authorization code to the session ID (10-minute window) to
     prevent code-injection attacks.
  5. `CompleteResourceTokenAuth` finalizes the exchange; token stored in the
     vault under `(agent_identity, user_id)`.
  6. Subsequent calls with `force_authentication=False` reuse the vault token
     transparently.

The `access_token` kwarg is **injected by the decorator** — the agent function
body just calls the third-party API with it.

### Credential lifecycle

| Event       | Mechanism                                                               |
|-------------|-------------------------------------------------------------------------|
| Issue       | `CreateOauth2CredentialProvider` or `CreateApiKeyCredentialProvider`    |
| Obtain      | `GetResourceOauth2Token` (with `GetWorkloadAccessToken` for workload auth) |
| Refresh     | Automatic in the SDK; vault returns cached-if-valid, refreshed-if-expired |
| Rotate      | Update client-id/secret on the provider config (console or control-plane API) |
| Revoke      | Delete the credential provider → all stored tokens invalidated; in-flight invocations fail |
| Per-user    | Tokens bound to `(agent_identity_id, user_id)` — deleting a user invalidates their slot, not the provider |

### Audit trail

- Every token-vault access: CloudTrail event with the agent identity ARN and,
  for 3LO flows, the user context from the JWT.
- Runtime and Gateway both log invocations to CloudWatch with the workload
  identity attached.
- Quoting the docs: *"Every action performed by an enterprise automation agent
  is logged with both the agent identity and any associated user context."*

**Critical** for compliance: this is the audit trail auditors want to see when
they ask "which agent, acting for which user, pulled which record from
Salesforce on which date." Chimera's current `audit-trail.ts` would become a
*supplement* to (not a replacement for) CloudTrail events.

### Pricing

Same story as Gateway — not on the fetched doc page. Needs a live check before
modeling costs. Expect a per-token-request price and possibly a per-stored-
credential price.

---

## Chimera's current gateway/identity layer

Current state (as of `main` @ 2026-04-17):

### `packages/agents/gateway_proxy.py` (239 LOC)

Builds Strands `@tool`-decorated Python callables that, when invoked, do the
following:

1. Reject payloads whose dict nesting > 32.
2. Serialize `{tool_name, action, tool_input, tenant_id}` to JSON.
3. Reject if serialized size > 5.5 MB (Lambda sync limit - 500 KB safety margin).
4. `boto3.client('lambda').invoke(FunctionName=<tier Lambda ARN>, InvocationType='RequestResponse', Payload=…)`.
5. Wrap the response in `[TOOL RESULT BEGIN]…[TOOL RESULT END]` or
   `[TOOL ERROR BEGIN]…[TOOL ERROR END]` delimiters (to prevent prompt-injection
   tokens in responses), truncated to 500 chars.

**Every bullet above is something AgentCore Gateway does natively** (protocol
translation, payload size enforcement, error envelope), *except* the delimiter
wrapping — which is a Chimera-specific prompt-injection defense that doesn't
exist in Gateway and should be preserved (move it to a Strands callback or keep
a thin wrapper).

### `packages/agents/gateway_config.py` (767 LOC)

- Hard-coded `_TOOL_TIER_REGISTRY` mapping ~90 tool names to 19 "service
  identifiers" across 3 tiers.
- `_TOOL_TIER_OVERRIDES` for per-tool tier escalation (e.g., `validate_cdk_in_sandbox` → tier 3).
- `_TOOL_DESCRIPTIONS` — 130-line dict of human-readable descriptions for the LLM.
- Reads 4 SSM parameters (`/chimera/gateway/tool-targets/{env}/{tier1,tier2,tier3,discovery}`) to resolve Lambda ARNs.
- Tier-gated filter: `TENANT_TIER_ACCESS[tier]` → max tool tier.
- For each tool that passes the filter, constructs a `GatewayToolDefinition`
  and hands it to `create_gateway_proxy_tool` (from `gateway_proxy.py`) to
  produce a Strands `@tool` callable.
- Per-tenant in-process cache of the tool list, keyed on
  `{tenant_id}:{tier}:{allow_list}:{deny_list}`.

**What this duplicates:** Gateway's tool catalog + target registration. In
managed Gateway, tools are discovered from targets at `CreateGatewayTarget`
time; MCP `tools/list` returns the filtered view to the agent; tier filtering
can be done either via multiple gateways (one per tier) or via target-level
IAM policies. There is no reason for Chimera to maintain a Python-side
`_TOOL_TIER_REGISTRY` if Gateway's catalog is the source of truth.

### `packages/core/src/gateway/` (TypeScript twin)

- `tier-config.ts` — same tier map, TypeScript version. Single source of truth
  for both `gateway_config.py` and the CDK stack.
- `tool-registry.ts` — constructs Strands-tool factories for AWS services
  (`createLambdaTools(clientFactory)` etc.) via dynamic import. Exposes
  `getGatewayTargetConfigs()` returning 4 target configs (`chimera-tools-tier1`,
  `tier2`, `tier3`, `discovery`).
- `tool-loader.ts` — tier-filtered load-and-cache; mirrors `GatewayToolDiscovery`
  in Python.

**What this duplicates:** target registration. `getGatewayTargetConfigs()`
returns exactly what `CreateGatewayTarget` + `CreateGateway` would accept.
Today it's consumed by the CDK stack to create 4 Lambdas; in the future, it
could be consumed to `CreateGatewayTarget` 4 targets against a real AgentCore
Gateway.

### `infra/lib/gateway-registration-stack.ts` (435 LOC)

- 4 inline Python Lambda handlers (`TIER1_HANDLER`, `TIER2_HANDLER`,
  `TIER3_HANDLER`, `DISCOVERY_HANDLER`), each ~60 lines of minified
  `boto3`-dispatch code.
- Each handler implements a `{tool_name, action, tool_input}` switch across
  4–9 AWS services.
- 4 SSM parameters exposing the Lambda ARNs to `gateway_config.py`.
- A `chimera-agentcore-invoke-<env>` IAM role — principal = `bedrock.amazonaws.com` —
  with `lambda:InvokeFunction` on all four Lambdas. **This role is created but
  never actually attached to an AgentCore Gateway** (because no gateway
  exists).

**What this duplicates:** Gateway's target fanout. Managed Gateway takes `N`
target Lambdas and does the same dispatch, with a real inbound authorizer and
real MCP protocol semantics.

### `packages/core/src/tenant/cedar-authorization.ts`

Application-level authz engine: Cross-tenant isolation, admin full access,
user-read-own-sessions, trial-tier skill restrictions, suspended-tenant deny-all.
**Not overlapping with Identity** — Identity does "is the caller's JWT valid
for this gateway"; Cedar does "given a valid caller, is this action on this
resource permitted in this tenant." Keep Cedar. Possibly delete the
`trial-tier-skill-restriction` policy if tier gating moves to Gateway
per-target IAM policies, but the core cross-tenant isolation logic is Cedar's
job.

### `packages/core/src/skills/mcp-gateway-client.ts`

Registers skill-provided tools as MCP servers. This one **is** a thin client to
a real AgentCore Gateway API (per the code comments: "Integrates with AgentCore
Gateway to register skills as MCP servers"). Keep — this is the right pattern.
The irony is that this client exists but the core tool catalog doesn't use the
gateway.

---

## Simplification opportunities

Ranked by impact × feasibility:

### 1. Replace `gateway_proxy.py` fanout with a real Gateway

**What:** `CreateGateway` + `CreateGatewayTarget`(×19, one per AWS service
identifier) + point Strands' MCP client at the managed `/mcp` endpoint.

**Deletes:**
- `packages/agents/gateway_proxy.py` (239 LOC)
- `gateway_config.py::_discover_from_gateway` path (~100 LOC)
- 4 inline Python handlers in `gateway-registration-stack.ts` (~200 LOC)
- 4 SSM parameters + the `GatewayToolDiscovery` SSM-reader code (~60 LOC)
- Per-tool `_TOOL_TIER_OVERRIDES` + `_TIER_TO_ARN_KEY` routing (~30 LOC)

**Keeps:**
- Tier → allowed-services mapping (expose as target-level IAM policy or per-tier gateway)
- `_TOOL_DESCRIPTIONS` (move into each target's tool schema JSON)
- Prompt-injection delimiter wrapping (move to a Strands `on_tool_result` hook,
  not a per-call wrapper)

**Complexity:** Medium. Needs a CDK custom-resource (or L3 construct — AgentCore
Gateway L1s are in `aws-cdk-lib` as of the `bedrock-agentcore` namespace) to
create the Gateway and 19 targets. Needs the Python agent to swap
`GatewayToolDiscovery.discover_tools()` for `MCPClient(streamablehttp_client(gateway_url))`.

**Risk:** Gateway prefixes tool names with `TargetName___` — Strands tool
selection prompts need to tolerate that prefix, or each Lambda handler needs to
strip it (the single required line shown in the Gateway docs).

### 2. Move OAuth-backed external-service tools to Identity credential providers

**What:** For any tool that talks to a third-party SaaS (GitHub, Slack,
Salesforce, Jira), register an Identity OAuth credential provider and mark the
Gateway target as needing that provider for outbound auth.

**Deletes:**
- Any Chimera-side secrets-manager reads for third-party API keys
- Any hand-rolled OAuth state-machine code (if it exists — check
  `packages/chat-gateway/src/routes/integrations.ts`)

**Keeps:**
- Cedar policies that restrict *which tenants* can use which integration

**Why now:** Chimera's agents are about to grow into "enterprise automation"
territory (self-evolution pipeline, capability registry). Every integration
that doesn't go through Identity becomes a secrets-ops tax. Identity makes it
free.

### 3. Replace the custom JWT middleware on `packages/core/src/auth/` (if any) with Gateway's inbound authorizer

**What:** Configure the gateway with `CUSTOM_JWT` authorizer pointed at
Chimera's Cognito user pool discovery URL. Let Gateway reject unauthenticated
requests before they hit any Lambda.

**Deletes:**
- Bespoke JWT validators in the data plane
- Cognito-specific verification libraries

**Keeps:**
- Cedar authz (runs *after* JWT validation, using claims extracted from the
  now-known-valid token)

### 4. Delete the `chimera-agentcore-invoke` role from `gateway-registration-stack.ts` if Gateway is not adopted

**What:** Today this role is provisioned with `bedrock.amazonaws.com` as the
principal, but nothing is using it. Either wire it into a real gateway or
remove it. Dangling IAM roles with `bedrock.amazonaws.com` trust are a mild
attack-surface smell.

### 5. Keep Cedar; don't try to push tenant authz into Identity

Identity has no notion of Chimera's tenant model. The `cross-tenant-isolation`
forbid rule (`context.tenantId != resource.tenantId`) cannot be expressed as an
OAuth scope or JWT claim without significant custom-claim plumbing, and even
then you lose per-resource granularity. **Cedar stays. Don't let this
simplification pass become a regression in tenant security.**

### What the simplification DOES NOT buy you

- **Semantic tool search** still requires enabling the feature on the Gateway
  and having the agent call `x_amz_bedrock_agentcore_search`. Not free just by
  adopting Gateway; it's a one-line opt-in + an agent-prompt change.
- **Per-tool CloudWatch metrics.** Still absent from Gateway as of this
  research. Chimera's structured JSON logging in the Lambda handlers
  (`{event:tool_call, tool_name, tenant_id, tier, action}`) is still the
  best source for per-tool dashboards. Keep that logging, move it inside the
  simpler per-service Lambdas.
- **Rate limiting.** Gateway does not expose per-tenant rate limits. Chimera's
  `chimera-rate-limits` token-bucket table is still load-bearing.

---

## Sources

- AWS docs: `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html`
- AWS docs: `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html`
- AWS API ref: `https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/Welcome.html` (Data Plane API)
- AWS API models: `https://github.com/aws/api-models-aws` (Smithy target source)
- Chimera: `packages/agents/gateway_proxy.py`
- Chimera: `packages/agents/gateway_config.py`
- Chimera: `packages/core/src/gateway/{index,tier-config,tool-registry,tool-loader}.ts`
- Chimera: `packages/core/src/tenant/cedar-authorization.ts`
- Chimera: `packages/core/src/skills/mcp-gateway-client.ts`
- Chimera: `infra/lib/gateway-registration-stack.ts`
- Prior research: `docs/research/agentcore-strands/02-AgentCore-APIs-SDKs-MCP.md`
- Prior research: `docs/research/agentcore-strands/10-Chimera-Integration-Guide.md`
