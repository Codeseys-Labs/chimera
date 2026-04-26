---
title: "Wave 27 — AgentCore Observability (chimera-301e) + second workspace-dist trap round"
status: retrospective
date: 2026-04-26
wave: 27
previous: WAVE-RETROSPECTIVE-26.md
---

# Wave 27 Retrospective

**Dates:** 2026-04-26
**Outcome:** Implemented ADR-040 AgentCore Observability code (ADOT
autoinstrumentation, ECS env vars, IAM grants, session.id baggage
propagation). Hit the workspace-dist buildspec trap a second time — the
Wave-26 mitigation was itself brittle. Two successive build-config
refinements converged on `tsc --build` with the project-reference graph.

## Commits this wave (4)

1. `5b2bd23` feat(observability): AgentCore Observability via ADOT (chimera-301e)
2. `2bf36d8` fix(pipeline): use bunx tsc -p <tsconfig> instead of bun run build
3. `e5f1375` fix(pipeline): use tsc --build with project references
4. (retrospective commit pending)

## chimera-301e implementation details

### ADR-040 acceptance criteria met

- [x] CloudWatch Transaction Search enabled (Wave-26, one-time)
- [x] `bun add @aws/aws-distro-opentelemetry-node-autoinstrumentation` in packages/chat-gateway
- [x] `bun add @opentelemetry/api` for baggage propagation
- [x] ECS task def env vars (infra/lib/chat-stack.ts):
      AGENT_OBSERVABILITY_ENABLED, OTEL_RESOURCE_ATTRIBUTES,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS, OTEL_EXPORTER_OTLP_PROTOCOL,
      OTEL_TRACES_EXPORTER, NODE_OPTIONS
- [x] IAM grants: xray:PutTraceSegments, PutTelemetryRecords,
      GetSamplingRules, GetSamplingTargets
- [x] Session-ID baggage in routes/chat.ts: wrapped agent.stream()
      in otelContext.with(baggageCtx, ...)
- [ ] Verified in CloudWatch GenAI Observability dashboard — pending
      final pipeline succeed

### Key design choice: baggage propagation surface

The ADOT Node autoinstrumentation intercepts `@aws-sdk/client-bedrock-runtime`
calls transparently — no code change needed in the agent loop. The only
new code is OTEL baggage propagation so multi-turn conversations
correlate under a single `session.id` in the transaction search view:

```typescript
const baggageCtx = propagation.setBaggage(
  otelContext.active(),
  propagation.createBaggage({
    'session.id': { value: resolvedSessionId },
    'tenant.id': { value: tenantContext.tenantId },
    'tenant.tier': { value: tenantContext.tier },
    'user.id': { value: tenantContext.userId || 'unknown' },
  }),
);
const agentStream = otelContext.with(baggageCtx, () =>
  agent.stream(lastMessage.content, priorMessages),
);
```

Also consolidated `sessionId` computation into a single
`resolvedSessionId` used by both OTEL baggage AND persistence SK — so
CloudWatch traces and DDB session history can be joined on equality.

## The workspace-dist buildspec trap, round 2

Wave-26 added this to buildspec-docker.yml:

```yaml
- bun run --cwd packages/shared build
- bun run --cwd packages/core build
- bun run --cwd packages/sse-bridge build
```

It validated locally. But in CodeBuild, `bun run --cwd packages/shared build`
invoked `tsc --build` which exited in 2 seconds with no output and no
dist — turning the entire Wave-27 deploy into a repeat zombie failure.

**First attempt (commit 2bf36d8):** use `bunx tsc -p <path>` per package.
This built packages/shared fine, but broke packages/core with:

  > TS6305: Output file '.../shared/dist/index.d.ts' has not been built
  > from source file '.../shared/src/index.ts'

TypeScript's `composite: true` integrity check refused to accept the
standalone-built shared dist because there was no matching `.tsbuildinfo`
linking dist to source.

**Second attempt (commit e5f1375):** single root-level `tsc --build`
invocation passing all three project tsconfigs. `--build` walks the
reference graph, emits dist + tsbuildinfo atomically per package, and
keeps the composite integrity metadata in sync. Validated locally with
a full `rm -rf dist tsbuildinfo` then rebuild.

## Cross-cutting observations

### Composite projects are a CI ergonomic tax

TypeScript's project references system is designed for incremental
local builds but requires discipline in CI. `composite: true` + CodeBuild
fresh checkouts means:
- Per-package `tsc -p` tripps the `TS6305` integrity check
- Per-package `tsc --build` silently no-ops without the right cache state
- Root `tsc --build <tsconfigs...>` is the only reliable invocation

Documented in the updated `workspace-dist-buildspec-trap.md` memory.

### The "zombie deploy" pattern has a full diagnostic chain now

Wave-26 caught it via "Wave-26 fix didn't reach production." Wave-27
caught a fresh manifestation of the same trap (build step wrong). Both
times the clue was:
1. `chimera deploy --source local` succeeds
2. Pipeline runs, but Build stage fails (or succeeds silently with no
   dist)
3. Stage-by-stage log inspection reveals which dist step silently
   produced nothing
4. Fix: adjust the build invocation; push; watch again

Next wave's `chimera-301e` validation depends on one more pipeline
completion. With tracing live, future zombies will be visible from
the CloudWatch dashboard — no more log spelunking.

## Deploy state

- Pipeline: most recent Build is post-e5f1375, running as of commit
- ECS: still on task def :35 (Wave-26) until the new Build completes
- Frontend: last deploy from task def :35's pipeline run; unchanged

## Backlog state (pending final e5f1375 build success)

If AgentCore Observability successfully deploys:

| ID | Title | Size |
|----|-------|------|
| chimera-b7af | strands-agents SDK migration | wait for 1.0.0 GA |
| chimera-2b2a | EventBridge scheduled tasks | 2d |
| chimera-59ee | Webhook delivery | 1-2d |
| chimera-606c | DGM evolution integration | 3-5d |

Down to 4 open — all multi-day strategic work. Zero tactical/bug
items. chimera-301e will close after CloudWatch shows a trace from
the deployed chat-gateway.

## Wave 28 recommendation

Verify observability in CloudWatch. Then pick ONE of the remaining 4:

- **chimera-2b2a** (EventBridge) — existing OrchestrationStack has
  the event bus; 2d of Lambda+EventBridge wiring
- **chimera-59ee** (webhooks) — pairs well with 2b2a
- **chimera-606c** (DGM evolution) — largest; needs solo focus
- **chimera-b7af** (strands-agents migration) — blocked on 1.0.0 GA

EventBridge is the cheapest; webhooks are the most user-visible.
Either is a reasonable Wave-28 pick.

## References

- ADR-040 AgentCore Observability adoption
- WAVE-RETROSPECTIVE-26.md — Wave-26 (first workspace-dist trap)
- `~/.claude/projects/.../memory/workspace-dist-buildspec-trap.md`
- `aws logs tail /aws/codebuild/chimera-docker-build-dev ...` for live
  pipeline debugging
