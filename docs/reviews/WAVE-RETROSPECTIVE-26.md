---
title: "Wave 26 — Conversation memory fix + workspace-dist buildspec trap discovered"
status: retrospective
date: 2026-04-26
wave: 26
previous: WAVE-RETROSPECTIVE-25.md
---

# Wave 26 Retrospective

**Dates:** 2026-04-26
**Outcome:** Closed chimera-e026 (agent had no conversation memory).
Fix took 2 pipeline cycles because of a latent build trap — workspace
packages' `dist/` trees weren't rebuilt before the Docker bundle, so
every cross-package change had been silently zombie-deploying since
Wave-22. Also turned on CloudWatch Transaction Search (account-level
prereq for AgentCore Observability, chimera-301e). Backlog: 6 → 5.

## Commits this wave (3)

- `3b07736` fix(agent): pass conversation history to Bedrock on every turn
- `e8143ea` fix(pipeline): build workspace deps before bundling chat-gateway
- (retrospective commit pending)

## Issue closed

| Seeds ID | Fix |
|----------|-----|
| `chimera-e026` | `agent.stream(message, priorMessages)` + chat-gateway passes AI-SDK history + build-deps chain |

## The zombie deploy trap

This one's worth the whole write-up. Symptom:

- **Turn 1:** "My name is Robin. Reply Got it." → Agent: "Got it." ✅
- **Turn 2:** "What's my name?" → Agent: "I don't know your name" ❌

Wave-25 confirmed the system-prompt leak was fixed; the "I don't know"
reply was the remaining `chimera-e026`. Fix written:
- `packages/core/src/agent/agent.ts` — `stream(message, priorMessages = [])`
- `packages/chat-gateway/src/routes/chat.ts` — `.stream(content, priors)`

Local tests passed (`bun test packages/core` → 149/0 fail). Pushed via
`chimera deploy --source local`. Pipeline ran cleanly. ECS rolled to
task def `:33` with image `bc16b00b` (git-SHA-8 of Wave-26 commit).
Browser test: **still "I don't know your name."**

At this point the instinct is "my fix is wrong." But:

```bash
$ aws ecs describe-task-definition --task-definition chimera-chat-gateway-dev:33 \
    --query 'taskDefinition.containerDefinitions[0].image'
"...:bc16b00b"

$ aws codecommit get-branch --branch-name main --query 'branch.commitId'
"3b07736..."  # my commit
```

Deploy succeeded. Image matches commit. Still broken.

**Root cause:** `@chimera/core/package.json` declares
`main: dist/index.js`. `packages/core/dist/` is gitignored
(`packages/core/.gitignore:5`). Docker_Build consumes `sourceOutput`,
not `buildOutput`. The `buildspec-docker.yml` runs
  `bun build packages/chat-gateway/src/server.ts --target bun`
which resolves `@chimera/core` via the `main` field — to `dist/index.js`
— which either doesn't exist (bundle fails) OR is whatever stale dist
was present when the repo was last cloned (silent staleness).

Every time I edited `packages/core/src/*`, Bun bundled the OLD
compiled signature. `agent.stream(message, priorMessages)` got
bundled as `agent.stream(message)` from the stale d.ts. TypeScript's
structural subtyping silently dropped the second argument at the
bundler level. Wave-26's code reached production but its behavior
didn't.

**Why it went unnoticed since Wave-22:** Every prior fix lived
entirely inside `packages/chat-gateway/src/*`, which IS in the
bundler's source tree. Wave-26 was the first commit in a long time
that changed `packages/core/src/*` and expected chat-gateway to see
the new API.

**Fix:** `buildspec-docker.yml` build phase prepends:

```yaml
- bun run --cwd packages/shared build
- bun run --cwd packages/core build
- bun run --cwd packages/sse-bridge build
```

Next pipeline cycle: task def `:35` with fresh dist. Browser test:
**"Robin"** ✅.

Captured as a persistent memory: `workspace-dist-buildspec-trap.md`.

## AgentCore Observability prerequisite landed

User had asked "since we are using agentcore should we use agentcore
observability?" in Wave-25. ADR-040 laid out the full plan; today I
ran the one-time account-level prerequisite:

```bash
aws logs put-resource-policy --policy-name ChimeraXRayTransactionSearch ...
aws xray update-trace-segment-destination --destination CloudWatchLogs
```

CloudWatch Transaction Search is now **ACTIVE**. The remaining work
for chimera-301e:

1. `bun add @aws/aws-distro-opentelemetry-node-autoinstrumentation`
   in `packages/chat-gateway`
2. ECS env vars (`infra/lib/chat-stack.ts`):
   `AGENT_OBSERVABILITY_ENABLED=true`, `OTEL_RESOURCE_ATTRIBUTES=...`,
   `OTEL_EXPORTER_OTLP_*`, `NODE_OPTIONS=--require ...`
3. `xray:PutTraceSegments` + `xray:PutTelemetryRecords` IAM grants
4. `session.id` baggage propagation in `routes/chat.ts`

Left for Wave 27 since it requires a dependency bump + ECS redeploy.

## Cross-cutting observations

### Monorepo bundle resolution is a stealth failure mode

The Wave-26 zombie-deploy wasn't a bug in my code or in CloudFormation
or in CodeBuild itself. It was in the *interaction* between four
things:
- Monorepo structure (workspace deps)
- Bun bundler's resolution algorithm (uses `main` field → dist)
- `.gitignore` conventions (dist not committed)
- Pipeline topology (Docker_Build reads sourceOutput, not buildOutput)

Any one of those in isolation is fine. The combination is a trap.
**When the fix doesn't seem to do anything, check where the bundler's
type resolution is pointing.** Don't assume "pipeline green → fix
deployed."

### "Test the deploy, not just the code"

Wave-26 could have shipped cleaner if `bun run test:smoke` (from
Wave-23) actually exercised a multi-turn prompt. It currently only
tests SINGLE-turn. Adding a multi-turn assertion to the smoke script
would have caught the zombie deploy automatically — the pipeline
would have run, smoke would have failed, and I would have known
immediately that the deployed code was wrong.

Captured as follow-up: tests/e2e smoke should include a multi-turn
memory assertion.

### Transaction Search is free to enable

Flipping `update-trace-segment-destination` from `XRay` to
`CloudWatchLogs` costs nothing until something actually emits traces.
Turning it on proactively lets future ADOT instrumentation flow
immediately. No reason to wait.

## Deploy state

- ECS task def `:35` with image from commit `e8143ea`
- Conversation memory confirmed working via curl ("Robin" response)
- 14/14 stacks live in baladita+Bedrock-Admin/us-west-2
- X-Ray Transaction Search: ACTIVE (was: XRay)
- `packages/core/dist` now rebuilt in pipeline before Docker bundle

## Backlog state — 5 open

| ID | Title | Priority | Size |
|----|-------|----------|------|
| chimera-301e | Adopt AgentCore Observability via ADOT | Medium | 4-6h (prereq done, code left) |
| chimera-b7af | strands-agents SDK migration | Medium | wait for 1.0.0 GA |
| chimera-2b2a | EventBridge scheduled tasks | Low | 2d |
| chimera-59ee | Webhook delivery | Low | 1-2d |
| chimera-606c | DGM evolution integration | Backlog | 3-5d |

Zero High/Critical bugs. Zero User-visible regressions. All tactical
work closed.

## Wave 27 recommendation

Finish `chimera-301e` (AgentCore Observability ADOT code). The account
prereq is done. The remaining work is a ~4-6h commit: add the ADOT
dep, ECS env vars, IAM grants, session baggage. After that,
everything else — from debugging future prompt regressions to
diagnosing the next "why did my fix not land" mystery — gets
significantly easier.

## References

- ADR-040 AgentCore Observability adoption
- `docs/reviews/WAVE-RETROSPECTIVE-25.md` — Wave-25
- `docs/reviews/WAVE-RETROSPECTIVE-24.md` — Wave-24
- `~/.claude/projects/.../memory/workspace-dist-buildspec-trap.md` —
  persistent memory of the zombie-deploy trap
