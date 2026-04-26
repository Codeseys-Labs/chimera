---
title: "Wave 25 — Prompt rewrite + admin routes; 3 closed, 3 new bugs filed"
status: retrospective
date: 2026-04-26
wave: 25
previous: wave24b-complex-browser-validation.md
---

# Wave 25 Retrospective

**Dates:** 2026-04-25 → 2026-04-26
**Outcome:** Closed 3 Medium/Low Wave-24b behavioral bugs with one
commit. Live browser re-validation confirmed the system-prompt leak
is fixed; surfaced 2 new bugs (no conversation memory + observability
gap) that were masked by the leak. Backlog: 7 → 6 open items.

## Commits this wave (2)

- `951f8d7` fix: Wave-25 behavioral bug triage — prompt rewrite + tenant admin routes
- `11059f9` chore(seeds): close chimera-cd16 / chimera-5d66 / chimera-c881 — fixed in 951f8d7

## Issues closed (3)

| Seeds ID | Title | Fix |
|----------|-------|-----|
| `chimera-cd16` | System prompt leak (tenant_id as user's name) | Moved scoping vars into `<operator-metadata>` + "never echo" directive |
| `chimera-5d66` | Agent doesn't invoke tools | Explicit "use tools; don't describe" directive in prompt |
| `chimera-c881` | Admin page `/tenants/:id/users` + `/api-keys` 404 | Added routes; `cognito-idp:ListUsers` IAM grant |

## Issues filed (3 new, 2 remain open)

| Seeds ID | Title | Status |
|----------|-------|--------|
| `chimera-e026` | Agent has no conversation memory | Open (Medium bug) |
| `chimera-301e` | Adopt AgentCore Observability via ADOT | Open (Medium task) |

(One more — `chimera-5d66` tool re-verification — moved into the
post-turn state machine check at end of wave. Result pending.)

## Live validation timeline

1. **Commit `951f8d7`** — prompt rewrite + admin routes land in git
2. **`chimera deploy --source local`** — pushed to CodeCommit, pipeline
   started processing
3. **Pipeline Build + Deploy run TWICE** — each push superseded an
   in-flight execution. Learned lesson from Wave-23: wait for
   idle-before-push. First push produced image `c354370d` but task
   def `:31` kept running the OLD image — the Wave-25 fix wasn't
   actually live yet.
4. **Wait cycle reveals task def `:32`** with image `bc16b00b`
   (matches CodeCommit HEAD, confirmed via
   `aws codebuild batch-get-builds --ids ...`)
5. **Browser re-test**:
   - "My name is Robin" → "Got it." ✅
   - "What's my name?" → "I don't know your name — you haven't told
     me yet. What is it?" ✅ for leak fix, ❌ reveals no conversation
     memory
6. **File `chimera-e026`** for the memory bug that was previously
   masked by the leak
7. **User callout:** "this is why tracing is preferred. also see what
   model the agent is using"
8. **Investigation:** agent uses Claude Sonnet 4.6. No X-Ray, no OTEL,
   no structured prompt logging — we can't answer "what system prompt
   did the model see?" without tailing CloudWatch and hoping.
9. **File `chimera-301e`** for the tracing gap
10. **User follow-up:** "since we are using agentcore should we use
    agentcore observability?"
11. **Research:** AgentCore Observability + ADOT is the right answer
    (CloudWatch GenAI Observability dashboard, per-request traces with
    `gen_ai.*` semantic conventions, session_id baggage propagation).
    Update `chimera-301e` scope to "adopt AgentCore Observability via
    ADOT" — strictly better than rolling X-Ray + structured logs
    separately.

## Cross-cutting observations

### Fixing one bug unmasks the next

Wave-22 fixing tenant-route mock-DDB unmasked `chimera-cd16`
(system prompt leak) because real DDB data suddenly flowed and the
`{{tenantId}}` substitution had real values to leak. Wave-25 fixing
the leak unmasked `chimera-e026` (no conversation memory) because
the agent's "I don't know your name" response is only observable
when it isn't substituting in `test-tenant-wave21`. Expect more bugs
to surface as each layer clears — this is healthy, not concerning.

### The real need is observability, not more prompt engineering

User's callout was precise: "this is why tracing is preferred." Every
Wave-24b and Wave-25 bug would be trivially diagnosable with GenAI
semantic-conventions traces. Without them, each bug requires:
- In-browser reproduction
- Manual CloudWatch Logs tailing
- Guessing at what the model saw based on prompt source code
- Multiple iterations because the system prompt value at runtime
  differs from the static source (template substitution, user
  context injection, etc.)

Adopting AgentCore Observability (`chimera-301e`) would cut the
debug time on the next prompt-or-memory bug by 10x.

### Prompt rewrites need lock-in tests

The prompt template drift is a continuous risk. I added
`packages/core/src/agent/__tests__/prompt.test.ts` (7 tests) that
encode the Wave-25 fix shape as regression traps:
- tenant_id appears ONLY in `<operator-metadata>`
- prompt contains "invoke" + "do not describe" directives
- prompt contains "never echo" directive
- template has EXACTLY `{tenantId, sessionId}` (no accidental new vars)

These are structural, not semantic — but they catch the shape
breakage that caused `chimera-cd16` in the first place.

## Deploy state

- ECS task def `:32` running image `bc16b00b` (Wave-25 commit)
- 14/14 stacks still live in baladita+Bedrock-Admin/us-west-2
- Frontend serving `index-BKJVxrzQ.js` (unchanged since Wave-24 —
  no web changes in Wave-25)
- `bun run test:smoke` passes (9 phases, ~10s)

## Backlog state

6 open items:

| ID | Title | Priority | Size |
|----|-------|----------|------|
| chimera-301e | Adopt AgentCore Observability via ADOT | Medium | 1 day |
| chimera-e026 | Agent has no conversation memory | Medium | 2-4h |
| chimera-b7af | strands-agents SDK migration | Medium | wait for 1.0.0 GA |
| chimera-2b2a | EventBridge scheduled tasks | Low | 2d |
| chimera-59ee | Webhook delivery | Low | 1-2d |
| chimera-606c | DGM evolution integration | Backlog | 3-5d |

## Wave 26 recommendation

Pick `chimera-301e` (AgentCore Observability) FIRST. Every other
open bug benefits from having it. The tracing dashboard will let us
see exactly what the agent's Bedrock requests look like when we
diagnose `chimera-e026` (conversation memory) — making the next
bug 10x easier to fix than without tracing.

Follow with `chimera-e026` (conversation memory). With Observability
live, the fix is literally "look at the trace, see only 1 message,
load DDB session history, re-run, see N messages."

## References

- AgentCore Observability docs:
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html
- CloudWatch GenAI Observability:
  https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/GenAI-observability.html
- Wave 24b retrospective:
  `docs/reviews/wave24b-complex-browser-validation.md`
- Seeds: chimera-cd16, chimera-5d66, chimera-c881 (closed);
  chimera-e026, chimera-301e (new)
