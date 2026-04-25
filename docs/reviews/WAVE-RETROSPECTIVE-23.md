---
title: "Wave 23 Retrospective — Browser validation surfaces 3 production bugs, 2 Seeds closed"
status: retrospective
date: 2026-04-25
wave: 23
previous: WAVE-RETROSPECTIVE-22.md
---

# Wave 23 Retrospective

**Dates:** 2026-04-25
**Outcome:** Playwright MCP browser validation exposed three production
bugs that unit tests had all missed. All three fixed and pushed. Backlog
reached 5 open items (down from 7). No P0/High items remain; only
P1/P2/Low FUTURE work.

## Issues closed (2)

| Seeds ID | Title | Resolution |
|----------|-------|------------|
| `chimera-9035` | CLI integration test scripts for E2E validation | ✅ `scripts/test-e2e.sh` + `bun run test:smoke` |
| `chimera-2087` | CLI E2E integration test scripts | ✅ duplicate of 9035 |

## Bugs surfaced & fixed (3 real production bugs)

### Bug 1: Wave-18 SEARCH-expression alarm was always broken

**Commit:** `50db334` — TierViolationCountAlarm watches dimensionless metric

CloudFormation rejected the Wave-18 SEARCH alarm at CREATE_FAILED:
  > `SEARCH is not supported on Metric Alarms.`

The constraint isn't in any CDK type. `cdk synth` accepts it; `cdk deploy`
rolls back the whole stack. The Wave-18 fix **never actually worked in
production** — it got past the 2026-04-22 initial deploy because the
stack was brand new and the alarm was a fresh create that never
succeeded. The stack was never re-deployed through Waves 19-22
(Wave-21 validated via curl directly, bypassing the stack path).

**Fix:** emit a second, dimensionless companion metric
(`tier_violation_count_total`) alongside the dimensional one. Alarm
watches the total; dashboards use SEARCH over the dimensional series.
Tests updated to expect 2 EMF emissions per violation.

### Bug 2: ECR IMMUTABLE + hardcoded `:latest` = silent ECS staleness

**Commit:** `de42948` — thread Docker SHA tag into ECS task def

Wave-19 M-2 made ECR repos IMMUTABLE and the buildspec stopped pushing
`:latest`. But `chat-stack.ts` still referenced
  `ecs.ContainerImage.fromEcrRepository(repo, 'latest')`
— which doesn't exist post-Wave-19. CDK saw no task-definition change
and kept ECS on task def :23 (2026-04-22 original deploy). Wave-22's
chat-gateway fixes (built, pushed, tested) never reached the running
container.

**Fix:** 3-file change:
1. `chat-stack.ts` reads `-c chatGatewayImageTag=<SHA>` with `:latest` fallback
2. `pipeline-stack.ts` Cdk_Deploy action sets env `CHAT_GATEWAY_IMAGE_TAG = #{DockerVars.IMAGE_TAG}`
3. `buildspec-docker.yml` adds `IMAGE_TAG` to `env.exported-variables` so
   the pipeline variable resolver can see it

### Bug 3 (Wave 22, shipped this session): chat-gateway silently 400'd on browser requests

**Commit:** `d2b5469` (Wave-22) — accept AI SDK v5 `parts` + use real DDB

This was surfaced by the browser test at the start of the session. Two
bugs in one commit:
- `ChatMessageSchema` only permitted v4 `content: string`. SPA sends
  v5 `parts: [{type:'text', text:'...'}]`. Zod 400'd before the adapter
  (which handles both) ran.
- `routes/tenant.ts` used a hardcoded no-op mock DynamoDB client.
  Unit tests passed (mock returns expected shape); live always 404'd
  regardless of DDB state.

## Other work

- `scripts/test-e2e.sh` (227 lines) — operator smoke test with 9 phases
  that captures the Wave-21 validation recipe. Gated CHIMERA_E2E=1.
  Wired as `bun run test:smoke`.
- Gitignored `.playwright-mcp/` session artifacts.

## Commits this wave (4)

1. `d2b5469` fix(chat-gateway): accept AI SDK v5 parts + use real DDB
2. `8549512` chore: gitignore .playwright-mcp/
3. `50db334` fix(observability): TierViolationCountAlarm dimensionless metric
4. `5c74374` feat(scripts): test-e2e.sh operator smoke test
5. `de42948` fix(chat-stack): thread Docker SHA into ECS task def

## Backlog delta

| Category | Wave 22 end | Wave 23 end | Δ |
|----------|-------------|-------------|-----|
| Seeds open | 7 | 5 | -2 (9035, 2087) |
| P0 items | 0 | 0 | 0 |
| High-priority items | 0 | 0 | 0 |
| Wave-23 bugs discovered | — | 3 | +3 found, +3 fixed |

## Cross-cutting observations

### CDK synth is not CDK deploy

Three bugs in this wave were of the form "cdk synth accepts it, cdk
deploy rejects it." The CloudWatch SEARCH-in-alarm constraint is the
canonical example: there's no CDK type-level signal. Future mitigation
worth considering: run `cdk diff` + `aws cloudformation validate-template`
in CI (already free to run; catches a subset) or add a pre-commit hook
that deploys critical stacks to a personal dev account.

### Browser-based testing finds boundary leaks

Every Wave-23 bug was a boundary mismatch between unit-test assumptions
and production reality:
- Unit test mock returning `{Item: null}` vs real DDB return
- Zod schema validated against v4 shape vs real v5 client
- CDK image tag `:latest` vs real ECR IMMUTABLE policy
- CloudWatch alarm metric type vs CFN runtime validation

Playwright MCP in ~15 minutes of exploration found all four. Pattern
worth repeating: after any infrastructure change that claims to
"improve" isolation/safety, drive the live app once.

### Pipeline variable export gotcha

`env.exported-variables` in `buildspec.yml` is NOT the same as `export
VAR=...` in the build phase. The former makes the var visible to
downstream pipeline actions via `#{Namespace.VAR}`; the latter is
process-local to the CodeBuild run. Omitting from
`exported-variables` means the variable resolves to empty string in
the pipeline graph — silently. Tracked as a general CodeBuild gotcha.

## Deploy state

- Wave-22 chat-gateway fixes: COMMITTED, in ECR, blocked on ECS update
- Wave-23 observability fix: DEPLOYED successfully
- Wave-23 SHA-threading fix: pushed; pipeline re-running to exercise it
- Frontend: still serving (S3 + CloudFront healthy)
- 14/14 stacks live; ECS still on task def :23 (will roll on next
  Cdk_Deploy with `CHAT_GATEWAY_IMAGE_TAG` threaded)

## Wave 24 candidates

The 5 remaining Seeds items are all multi-day strategic work (no
tactical hardening left):

| ID | Title | Size |
|----|-------|------|
| `chimera-b7af` | Migrate shim → @strands-agents/sdk (API mismatch) | 1-2 days, wait for 1.0.0 GA |
| `chimera-76b9` | LLM-based task decomposer | 1-2 days |
| `chimera-2b2a` | EventBridge scheduled agent tasks | 2 days |
| `chimera-59ee` | Webhook delivery for task lifecycle events | 1-2 days |
| `chimera-606c` | DGM evolution integration (composite fitness, lineage) | 3-5 days |

**Recommendation:** Wave 24 should pick exactly one of these and scope
it properly. Attempting multiple in one wave recreates the Wave-18-style
"shipped but never deployed" failure mode.

## References

- `docs/reviews/WAVE-RETROSPECTIVE-22.md` — Wave 22 (browser validation)
- `docs/reviews/wave21-live-validation.md` — Wave 21 (first live E2E)
- `scripts/test-e2e.sh` — reproducible smoke test
