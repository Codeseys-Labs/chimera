---
title: "Wave-16 triage: workflow.ts stubs"
status: decision
last_updated: 2026-04-22
supersedes: []
related:
  - docs/reviews/OPEN-PUNCH-LIST.md  # §cleanup #3
  - packages/core/src/orchestration/workflow.ts
---

# Wave-16 triage: `workflow.ts` stubs

**Decision: KEEP-WITH-SIMPLIFICATION (deferred).** Keep the file, keep the three
`throw new Error('not implemented')` guards added in Wave-15a, and mark the
engine itself experimental until we decide whether Chimera orchestration should
be declarative (Step Functions) or imperative (Temporal-style). Do **not**
invest in implementing JSONPath / map / wait-for-agent inside `workflow.ts`
right now.

Rationale, research, and next actions below.

## Context

`packages/core/src/orchestration/workflow.ts` defines an in-process
`WorkflowEngine` with five step types (`task`, `parallel`, `choice`, `wait`,
`map`). Wave-15a replaced the three dishonest methods with throw-stubs
(audit finding M2). Those stubs are still present:

- `executeTaskStep` — delegation IS implemented; awaiting agent completion is
  not, so it throws after `orchestrator.delegateTask()`.
- `executeChoiceStep` — JSONPath condition evaluation is a skeleton; throws.
- `executeMapStep` — map iteration is a skeleton; throws.

The OPEN-PUNCH-LIST (§cleanup #3) asked us to decide whether these stubs are
worth implementing or whether the API surface should be trimmed.

## Research summary

Three canonical orchestration frameworks were surveyed for how they handle
choice / map / wait-for-agent primitives:

| Framework | Choice branching | Map iteration | Wait-for-agent | Programming model |
|-----------|------------------|----------------|----------------|-------------------|
| **AWS Step Functions** | `Choice` state with 30+ JSONPath operators (`StringEquals`, `NumericGreaterThan`, `StringMatches`, `And/Or/Not`, type checks) | `Map` state with Inline (≤40 concurrent, 256 KiB payload) or Distributed (≤10 000 child execs, reads from S3) | `.waitForTaskToken` / `SendTaskSuccess` callbacks with heartbeats | Declarative JSON state machine |
| **Temporal** | Native `if/else` in workflow code | Native loops/`Promise.all` | `workflow.await()` signals + timers | Imperative TS/Go/Java — you write normal code, Temporal replays it |
| **Amazon Bedrock AgentCore** | ❌ not native — AWS guidance is "use Step Functions in front of AgentCore" | ❌ not native — same guidance | ❌ not native — same guidance (`.waitForTaskToken` against AgentCore runtime ARN) | Supervisor/subagent pattern via tool-calls; orchestration logic lives in the agent's reasoning, not a state machine |

Key takeaways:

1. **Every mature framework either delegates to a JSON DSL (Step Functions)
   or makes orchestration be plain code (Temporal).** Nobody builds a
   bespoke in-process JSONPath+Map evaluator for TypeScript; the DSL is the
   product. Reinventing JSONPath-against-step-results inside
   `WorkflowEngine` would recreate a decade of Step Functions' spec work for
   a single-project audience.

2. **AgentCore itself does not ship orchestration primitives.** AWS's
   explicit recommendation for multi-step AgentCore workflows is to put
   Step Functions in front and call the agent via
   `arn:aws:states:::bedrock:invokeAgent.waitForTaskToken`.

3. **Choice + Map + wait-for-agent is *exactly* the bundle Step Functions
   provides**, with JSONPath evaluation, SDK-based branching semantics,
   concurrency caps, and durable state all handled by the managed service.

4. **Chimera already has the SDK access for the Step Functions path.**
   `sfn` VPC interface endpoint was added in Wave-15c (commit `b3cabec`)
   explicitly to support this direction.

## Current usage in Chimera

`WorkflowEngine` has **zero non-test callers** in the repo:

```
$ grep -rn "WorkflowEngine\|createWorkflowEngine\|WorkflowPatterns" \
    packages infra --include='*.ts' | grep -v '/dist/' | grep -v workflow
packages/core/src/orchestration/index.ts — re-exports
packages/core/src/orchestration/__tests__/workflow-engine.test.ts — unit tests
packages/core/src/index.ts — re-exports
```

Nothing in `chat-gateway`, `sse-bridge`, `cli`, or any CDK stack instantiates
it. It is an internal prototype whose only confirmed users today are its own
unit tests.

## Options considered

### Option A: DELETE `workflow.ts` entirely

- **Pros:** Removes ~540 LOC of half-implemented surface. Forces the
  Step-Functions-vs-Temporal decision to be made explicitly before anyone
  ships real multi-step orchestration. Simplifies `@chimera/core` public
  API.
- **Cons:** Throws away genuinely-useful scaffolding (`WorkflowDefinition`,
  `WorkflowExecution`, `RetryConfig`, `WorkflowPatterns.sequential/parallel`).
  Forces us to re-derive those types if Chimera ever needs in-process
  orchestration again (even as a thin adapter over Step Functions
  `StartExecution`).
- **Risk:** none — zero external callers.

### Option B: IMPLEMENT JSONPath + map + wait-for-agent inside `workflow.ts`

- **Pros:** Makes the engine actually work in-process, no network hop per
  state transition, no Step Functions bill.
- **Cons (disqualifying):**
  1. We would be reimplementing the JSONPath comparison operator matrix
     (30+ operators, `*Path` variants, timestamp rules, numeric-range
     corner cases). This is where Step Functions' value lives.
  2. Durability / resumability / audit trail would all be on us. An
     in-process engine cannot survive a Lambda cold start mid-workflow;
     a Standard Step Functions execution survives for up to 1 year.
  3. `executeTaskStep` needs a polling/callback loop to await an agent
     running asynchronously in AgentCore Runtime — that is literally what
     `.waitForTaskToken` does. Rebuilding it over SQS+DDB adds
     operational surface for no new capability.
  4. Tier separation: the team already committed to Step Functions for
     tenant onboarding (`tenant-onboarding-stack.ts`) and the skill
     pipeline (`skill-pipeline-stack.ts`). A second in-house engine
     creates a tech-stack split.
- **Estimated effort:** 5-10 days for a correct-ish implementation, plus
  ongoing maintenance.

### Option C: KEEP-WITH-SIMPLIFICATION (selected)

Keep the file, keep the Wave-15a throw-stubs (they correctly fail loudly
rather than silently returning fake success), but:

1. Treat `WorkflowEngine` as **experimental / unsupported** — annotate the
   class with a `@deprecated` / `@experimental` JSDoc tag and a pointer
   to this triage doc, plus a note that the `choice` / `map` / `task`
   (await-completion) step types are unimplemented by design.
2. Preserve the **types** (`WorkflowDefinition`, `WorkflowStep`,
   `RetryConfig`, `StepExecutionResult`) — they are a clean shape for
   any future orchestrator (in-house or Step Functions-backed).
3. Preserve `WorkflowPatterns.sequential` / `WorkflowPatterns.parallel`
   as helper constructors — both are fully implemented and working.
4. **When Chimera actually needs multi-agent orchestration with branching
   or iteration, build it as a Step Functions adapter, not by filling in
   these stubs.** The adapter would accept a `WorkflowDefinition`,
   synthesise it to ASL, call `StartExecution`, and either return the
   `executionArn` (fire-and-forget) or poll `DescribeExecution`
   (await-completion) — the same three patterns documented in
   `sfn-integrate-sdk`.

## Next actions (out of scope for Wave-16)

Filed under future-wave cleanup:

- [ ] Annotate `WorkflowEngine` with `@experimental` JSDoc + link to this
      doc. (~5 min)
- [ ] When the Step Functions adapter is written, either (a) back
      `WorkflowEngine` with it and remove the throw-stubs, or (b) delete
      the engine and keep only the type definitions.
- [ ] Decide between Step Functions (AWS-native, durable, the official
      AgentCore orchestration story) and a Temporal-style imperative model
      — likely Step Functions given the 11-stack CDK architecture and
      existing usage in `tenant-onboarding-stack.ts` /
      `skill-pipeline-stack.ts`.

## Punch-list update

`docs/reviews/OPEN-PUNCH-LIST.md` §cleanup #3 is updated to link this
triage and reclassify the work as "decision landed, implementation
deferred to Step Functions adapter wave."
