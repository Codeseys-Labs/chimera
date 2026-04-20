---
title: "AgentCore Gateway Migration — Operator Guide"
status: living
last_updated: 2026-04-17
---

# Gateway Migration — Operator Guide

## What this is

Phase 0/1 scaffolding for migrating Chimera off the custom `gateway_proxy.py` Lambda-fanout layer onto real AgentCore Gateway targets has landed on `main` behind feature flags that default to off. No production behavior changes until an operator explicitly flips a flag on a specific Lambda; the Python `gateway_proxy.py` path remains the sole tool-invocation mechanism until a separate cutover wave.

This document is the runbook for the operator who needs to either enable Phase 1 gateway-creation on a dev tenant, exercise Phase 2 dual-invoke in dev (try real Gateway, fall back to `gateway_proxy.py`), or roll back a mis-flipped flag. It follows the same structure as `docs/MIGRATION-registry.md`.

## Feature flags (env vars)

All flags are read by `packages/core/src/gateway/feature-flags.ts`. The skill-agent ECS task and the Python agent container are the runtime consumers once a caller wires them in.

| Name | Default | Purpose |
|------|---------|---------|
| `GATEWAY_MIGRATION_ENABLED` | unset (off) | Master switch — Phase 1+. When off, the adapter is inert and `gateway_proxy.py` handles 100% of invocations |
| `GATEWAY_PRIMARY_INVOKE` | unset (off) | Phase 2+. Prefer the real AgentCore Gateway for tool calls, fall back to `gateway_proxy.py` on any error |
| `GATEWAY_ID` | unset | Required once `GATEWAY_MIGRATION_ENABLED=true` — the gateway ID (short id or ARN) the adapter targets |
| `GATEWAY_REGION` | = `AWS_REGION` | Optional override for the AWS region the Gateway SDK client uses |

Flag truthiness: any non-empty value other than `0`, `false`, `no`, `off` is treated as on. The adapter refuses to run when `GATEWAY_MIGRATION_ENABLED=true` and `GATEWAY_ID` is unset — this is fail-closed behavior (`assertGatewayFlagsConsistent()`).

Phase ordering matters. `GATEWAY_PRIMARY_INVOKE` must never be set before `GATEWAY_MIGRATION_ENABLED` has been on long enough to confirm Gateway + target health via CloudWatch and operator smoke tests. Setting `GATEWAY_PRIMARY_INVOKE=true` against a mis-configured Gateway silently funnels every tool call through the fallback path — you'll see `GatewayFallback` spikes in CloudWatch but no user-visible break, which is the most expensive class of bug.

Flags are per-container / per-Lambda, not per-tenant. Phase 1 flips the skill-agent ECS task definition globally; Phase 2 flips the Python agent container globally. Per-tenant rollout requires separate task-definition copies or in-code tenant allowlisting, neither of which is wired up in this baseline.

## Enabling Phase 1 (gateway-up, invocations still via proxy) on dev

Pre-requisites: AWS CLI credentials for the dev account, permission to modify the skill-agent container's environment, and IAM grants on the execution role for `bedrock-agentcore-control:CreateGateway`, `bedrock-agentcore-control:CreateGatewayTarget`, `bedrock-agentcore-control:ListGatewayTargets`, and `bedrock-agentcore-control:SynchronizeGatewayTargets`. If those grants are missing, Phase 1 will emit `GatewayCreateFailure` on every boot.

1. **Create a Gateway in the dev account.** Use the AWS CLI directly; there is no CDK construct for this yet (Phase 0 is adapter-only):
   ```bash
   aws bedrock-agentcore-control create-gateway \
     --name chimera-dev-gateway \
     --description "Chimera dev Gateway for Phase 1 dual-path exercise" \
     --tags Key=Purpose,Value=gateway-phase1,Key=Environment,Value=dev \
     --authorizer-configuration '{"customJWTAuthorizer": { "...": "cognito-pool-discovery-url" }}'
   ```
   Record the returned `gatewayId` and compute the MCP endpoint URL:
   `https://<gatewayId>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp`.

2. **Register tier-1..3 Lambda targets.** Use `chimeraToolsToGatewayTargets(tier, arnMap)` from `packages/core/src/gateway/tool-to-gateway-target-mapper.ts` to compute the payloads, then hit `CreateGatewayTarget` once per target. In Phase-0 this step is manual; a CDK custom resource lands in Phase-1 alongside the real consumer wiring.

3. **Put gatewayId + region into SSM.** For an ad-hoc dev flip, staging the value under `/chimera/dev/gateway/id` makes it discoverable and reversible without a redeploy:
   ```bash
   aws ssm put-parameter --name /chimera/dev/gateway/id --type String \
     --value "<gatewayId-from-step-1>" --overwrite
   aws ssm put-parameter --name /chimera/dev/gateway/region --type String \
     --value "us-west-2" --overwrite
   ```

4. **Set env vars on the skill-agent task definition.** In the dev stack:
   ```bash
   aws ecs update-service --cluster chimera-dev \
     --service chimera-dev-agent \
     --force-new-deployment \
     --task-definition <revision-with-GATEWAY_MIGRATION_ENABLED=true>
   ```
   The adapter uses dynamic import for `@aws-sdk/client-bedrock-agentcore*`; if those packages are not yet in `package.json`, the adapter raises `GatewayUnavailableError` at boot and the container stays on the `gateway_proxy.py` path (see "Known limitations" below). This is safe: Phase 1 is explicitly dual-path.

5. **Verify.**
   - `aws bedrock-agentcore-control list-gateway-targets --gateway-identifier <id>` returns the tier-1..3 targets.
   - The skill-agent task logs `[gateway-client] listTargets ok ctx=<id>` on cold start.
   - `gateway_proxy.py`-based invocations continue to work unchanged; `GATEWAY_PRIMARY_INVOKE` is still off.

6. **Rollback.** Unset `GATEWAY_MIGRATION_ENABLED` on the task definition and redeploy. Time-to-revert: < 5 minutes for new tasks, up to 15 minutes for all warm containers to roll. The Gateway resource itself remains; it can be left in place or deleted via `delete-gateway` + `delete-gateway-target`.

## Enabling Phase 2 (dual-invoke — Gateway primary, proxy fallback) on dev

Pre-requisites: Phase 1 has been running on the same dev account for at least 24 hours; IAM grants on the agent task role for `bedrock-agentcore:InvokeGatewayTool` scoped to the target gateway ARN. The Python agent container must also have a Strands MCP client wired in (that change is out of scope for Phase 0-1 and lives in the cutover wave — see "Known limitations").

**BLOCKED ON CUTOVER WAVE — do not enable in production.** Phase 2 production enablement is gated on the cutover work that rewires the Python agent container to consume the MCP endpoint. Until then, `GATEWAY_PRIMARY_INVOKE=true` is a no-op on the agent container (the flag lives in TypeScript but no Python consumer reads it yet).

1. **Ensure Phase 1 has been healthy for 24 hours.** Zero `GatewayCreateFailure`, zero `GatewayListTargetsError`. A flaky Phase-1 Gateway makes the Phase-2 fallback rate uninterpretable.

2. **Set env vars on the agent container.**
   ```bash
   aws ecs update-service --cluster chimera-dev \
     --service chimera-dev-agent \
     --task-definition <revision-with-GATEWAY_PRIMARY_INVOKE=true>
   ```

3. **Verify.** Exercise a representative tool call (e.g., `list_s3_buckets`) and compare timings + output to the proxy-only path. In CloudWatch:
   - `GatewayInvokeSuccess` should increment on every call that Gateway served.
   - `GatewayFallback` should stay low (< 1% of calls). A spike indicates Gateway is failing and the fallback is masking a problem.
   - `GatewayInvokeError` > 0 means the Gateway call itself is failing — investigate IAM, target configuration, or SDK wiring.

4. **Rollback.** Unset `GATEWAY_PRIMARY_INVOKE` on the task definition. Tool invocations revert to 100% proxy on the next task rotation. Time-to-revert: < 5 minutes for new tasks.

## Observability

The adapter emits metrics in the `Chimera/Gateway` CloudWatch namespace (wiring into the emitter lives in the cutover wave; Phase 0 only surfaces the error classes below via logs):

| Metric | Source | Meaning |
|--------|--------|---------|
| `GatewayCreateFailure` | skill-agent boot | Gateway creation / ListGatewayTargets failed; container stays on proxy path |
| `GatewayInvokeSuccess` | agent runtime | Gateway `invokeTool` returned a success-status result envelope |
| `GatewayFallback` | agent runtime | Gateway `invokeTool` threw and the caller fell back to `gateway_proxy.py` |
| `GatewayInvokeError` | agent runtime | Gateway call itself threw — typically IAM, auth, or SDK issue; always precedes a `GatewayFallback` |

Recommended alarms:

- **Phase 1:** `GatewayCreateFailure` > 0 in 5 minutes → page the on-call. Phase 1 only *creates* a Gateway, so every failure is actionable.
- **Phase 2:** `GatewayFallback` > 5% of `GatewayInvokeSuccess + GatewayFallback + GatewayInvokeError` over 15 minutes → investigate. Either Gateway is unhealthy, the target config is wrong, or the primary-invoke path has a bug.

Log fields the adapter emits alongside each metric:

- `tenantId` — present on every invocation (attached by the agent ReAct loop, not by the adapter).
- `toolName` — the full Gateway tool name including the `target___tool` prefix (e.g. `s3___list_buckets`).
- `op` — one of `listTargets`, `invokeTool`.
- `durationMs` — wall-clock latency of the Gateway call.
- `errorCode` / `errorMessage` — populated only on failure paths; `errorCode` is the AWS SDK error name (e.g. `ThrottlingException`, `ResourceNotFoundException`).

Filter CloudWatch Logs Insights with `fields @timestamp, op, tenantId, toolName, durationMs, errorCode | filter errorCode != ""` for a quick triage view.

## Rollback playbook (per phase)

### Phase 1 — Gateway up, proxy still authoritative

- **Trigger conditions:** `GatewayCreateFailure` > 0 sustained; CreateGatewayTarget failing for a specific tier; observed cost spike on the Gateway service.
- **Rollback procedure:** unset `GATEWAY_MIGRATION_ENABLED` on the skill-agent task definition.
- **Time-to-revert:** < 5 minutes for new tasks; < 15 minutes for the service to fully roll.
- **Post-rollback verification:** container boots without touching the Gateway SDK; `GatewayCreateFailure` drops to 0 (no Gateway calls being made); `gateway_proxy.py` invocations continue unimpeded.

### Phase 2 — Gateway primary, proxy fallback

- **Trigger conditions:** `GatewayInvokeError` > 1% of tool calls; customer-reported tool failures; `GatewayFallback` sustained > 5%.
- **Rollback procedure:** unset `GATEWAY_PRIMARY_INVOKE` on the agent task definition.
- **Time-to-revert:** < 5 minutes.
- **Post-rollback verification:** tool invocations return to 100% proxy; `GatewayInvokeSuccess` / `GatewayFallback` metrics flatline.

### Cutover wave (future — not deployed yet)

- **Trigger conditions:** a Phase-3 cutover removes the `gateway_proxy.py` fallback entirely; if Gateway goes down, tools fail hard.
- **Rollback procedure:** revert the cutover deploy. Because the proxy code is deleted in cutover, rollback is a full redeploy of the last Phase-2-compatible task definition, not a flag flip.
- **Time-to-revert:** depends on deploy pipeline; plan for 30 minutes to 2 hours.
- **Post-rollback verification:** proxy path reinstated; `GatewayFallback` metric re-appears.

## Spike prerequisites (Phase 2+)

The following open questions must close before Phase 2 production enablement. None blocks Phase-0/1 merge, but they gate the cutover wave:

- **`InvokeGatewayTool` SDK surface.** The research doc assumes the data-plane SDK exposes an `InvokeGatewayToolCommand`; the adapter has a `TODO(spike)` comment noting this. If the real SDK requires a direct MCP JSON-RPC call with SigV4 signing, the adapter's `invokeTool` implementation swaps internally but the public method signature is stable.
- **Target-level IAM policies.** Per-tenant tier enforcement currently lives in `gateway_config.py::TENANT_TIER_ACCESS`. Moving it to Gateway requires either (a) multiple gateways (one per tier) with tier-specific inbound authorizers or (b) per-target IAM policies that reference the caller's JWT claims. Option (a) is simpler but more expensive; option (b) is cheaper but depends on Gateway's claim-forwarding guarantees, which aren't documented.
- **Prompt-injection delimiter wrapping.** `gateway_proxy.py` wraps every tool result in `[TOOL RESULT BEGIN]/[END]` envelopes to defeat prompt-injection via tool output. Gateway's MCP protocol doesn't provide this. The cutover wave must reintroduce the wrapping via a Strands `on_tool_result` callback.

## Operator concerns around flag flips

- **Warm ECS tasks.** `aws ecs update-service` applies to new tasks immediately but warm tasks with the old env stay warm until their lifecycle timer rotates them. For a fast rollback, follow the env update with `aws ecs update-service --force-new-deployment` to force task replacement.
- **Partial rollouts across regions.** If Chimera is deployed in multiple regions, each region's skill-agent task definition needs its env updated. Verify with `aws ecs list-services --cluster chimera-<env>`.
- **Eventual consistency during Gateway target creation.** `CreateGatewayTarget` returns 200 immediately but the target's tool catalog isn't visible via `ListGatewayTargets` until Gateway's internal sync runs (a few seconds to a minute). Phase 1 verification should tolerate this window.
- **In-flight invocations.** Any tool call already executing at the moment of the env update completes with the OLD env. There's no graceful "drain" — flips are effectively immediate for new invocations and invisible for in-flight ones. Matches the Registry migration behavior.

## Known limitations of this baseline

- **`gateway_proxy.py` is NOT deleted.** This is deliberate. Phase 0/1 is additive scaffolding; the Python layer remains the sole invocation path until the cutover wave. Do not interpret Phase-0 merge as permission to delete the proxy.
- **No Python consumer.** The TypeScript adapter, feature flags, and mapper are all that Phase 0 provides. The Python agent container in `packages/agents/` still uses `gateway_proxy.py` unconditionally. `GATEWAY_PRIMARY_INVOKE=true` is currently a no-op from the Python side — it only affects TypeScript callers (of which there are none yet in this wave).
- **SDK packages may need adding to `package.json` before Phase 1 can actually be enabled.** The adapter at `packages/core/src/gateway/agentcore-gateway-client.ts` uses dynamic import for `@aws-sdk/client-bedrock-agentcore` and `@aws-sdk/client-bedrock-agentcore-control`. That keeps the repo buildable and mergeable without the packages installed, but Phase 1 enablement will silently degrade (and emit `GatewayCreateFailure`) until those packages are added to the relevant workspace `package.json` and the container bundle includes them.
- **Prompt-injection envelope is not ported.** `gateway_proxy.py`'s `[TOOL RESULT BEGIN]/[END]` wrapping is Chimera-specific defense-in-depth that Gateway doesn't provide. The cutover wave must reintroduce it via a Strands callback. Until then, Phase-2 primary-invoke loses that defense layer and callers must NOT enable `GATEWAY_PRIMARY_INVOKE` in prod.
- **`InvokeGatewayToolCommand` shape is assumed, not verified.** The adapter's `invokeTool` method marks the SDK shape with `TODO(spike)`. Phase 1 consumers must verify against the live SDK before relying on the current command-input structure.
- **Target-level JSON schemas are not generated.** `chimeraToolsToGatewayTargets` emits Lambda targets with no `schema` field. The per-tool JSON schemas are expected to live in each Lambda's handler code (the cutover wave confirms the pattern). Phase-0 clients call `listTargets` + then `InvokeGatewayTool`; they do not author schemas.
- **`GATEWAY_REGION` defaults to `AWS_REGION`.** Cross-region Gateway access (e.g., a container in `us-west-2` talking to a Gateway in `us-east-1`) isn't explicitly supported; the client binds to a single region per process.

## Cross-links

- **Research note:** `docs/research/agentcore-rabbithole/03-gateway-identity-deep-dive.md` — deep-dive on Gateway's API surface, target types, auth model, and the custom-layer-vs-managed tradeoffs that motivate this migration.
- **Registry migration guide:** `docs/MIGRATION-registry.md` — the precedent this doc mirrors; contains operator patterns that also apply to Gateway.
- **Current Python layer:** `packages/agents/gateway_proxy.py`, `packages/agents/gateway_config.py` — the code this migration eventually retires (NOT in Phase 0/1).
- **CDK stack:** `infra/lib/gateway-registration-stack.ts` — today provisions 4 tier Lambda handlers + 4 SSM params; Phase-1 adds a `CreateGateway` custom resource alongside.
- **Adapter source:** `packages/core/src/gateway/{feature-flags,types,agentcore-gateway-client,tool-to-gateway-target-mapper,index}.ts`.
