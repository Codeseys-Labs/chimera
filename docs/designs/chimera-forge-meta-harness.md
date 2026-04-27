---
title: "Chimera Forge — Meta-Harness for AWS-Native Agents"
status: proposed
date: 2026-04-26
author: architect
related:
  - Meta-Harness paper: https://arxiv.org/abs/2603.28052
  - Meta-Harness repo: https://github.com/stanford-iris-lab/meta-harness
  - Terminal-Bench artifact: https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact
  - ADR-040 AgentCore Observability (Wave-27/28)
---

# Chimera Forge: Meta-Harness for AWS-Native Agents

## 1. Executive Summary

Chimera already generates prompt variants, auto-skills, model-routing decisions,
and IaC changes through the existing `packages/core/src/evolution/*` modules.
The gap is **eval discipline**. The current `TestPromptVariantFunction` Lambda
scores variants by keyword overlap (bag-of-words) and falls back to a constant
0.75 when no golden dataset exists — a threshold that never passes the
Step Functions `VariantTestPassed` choice. The TypeScript
`PromptOptimizer.runTestCase()` is a length-bonus placeholder with explicit
TODO markers. Chimera can *generate* improvements faster than it can *prove*
they are better.

**Meta-Harness** (Stanford IRIS, Apr 2026) is the missing outer optimization
loop. It treats the scaffolding around a fixed base model — system prompts,
tool manifests, memory retrieval policy, environment context injection — as
the search target, governed by held-out eval suites and a Pareto frontier.

**Chimera Forge** adapts Meta-Harness's three-file control plane
(`pending_eval.json`, `frontier_val.json`, `evolution_summary.jsonl`) to
DynamoDB, wires the existing `EvolutionSafetyHarness` (Cedar + AVP) as a
hard gate between validation and benchmarking, and ports the single best
Terminal-Bench technique — **environment bootstrapping** — as an AWS-native
precomputed account snapshot.

**Phase 1 scope** (this doc): 3-4 days — interface, AWS environment bootstrap
harness, 10-task ChimeraBench v0, offline-only evaluation. No production
traffic impact.

## 2. Meta-Harness Mechanics (Verified From Source)

Confirmed from DeepWiki inspection of `stanford-iris-lab/meta-harness` and the
`meta-harness-tbench2-artifact` repo:

### 2.1 Harness Interface

- **Terminal-Bench 2**: candidates are class `AgentHarness` in
  `reference_examples/terminal_bench_2/agents/<candidate>.py`. The runner
  *normalizes* whatever class name the proposer writes to `AgentHarness`
  so the eval framework can import it uniformly. Baseline is
  `baseline_kira.py` (`class TerminusKira`). An `AgentHarness` performs
  tool-use + multi-step planning.
- **Text classification**: candidates implement an abstract `MemorySystem`
  ABC with two methods: `predict(...)` and `learn_from_batch(...)`.

The interface is *domain-specific*; the framework is domain-agnostic. You
define the boundary for your domain.

### 2.2 Environment Bootstrapping — the TB2 killer trick

Verbatim from `agent.py` `_gather_env_snapshot`:

```python
bootstrap_cmd = (
    "echo '@@PWD@@' && pwd && "
    "echo '@@LS@@' && ls -la /app/ 2>/dev/null && "
    "echo '@@LANG@@' && "
    "(python3 --version 2>&1 || echo 'python3: not found') && "
    "(gcc --version 2>&1 | head -1 || echo 'gcc: not found') && "
    "(g++ --version 2>&1 | head -1 || echo 'g++: not found') && "
    "(node --version 2>&1 || echo 'node: not found') && "
    "(java -version 2>&1 | head -1 || echo 'java: not found') && "
    "(rustc --version 2>&1 || echo 'rustc: not found') && "
    "(go version 2>&1 || echo 'go: not found') && "
    "echo '@@PKG@@' && "
    "(pip3 --version 2>&1 || echo 'pip3: not found') && "
    "(pip --version 2>&1 || echo 'pip: not found') && "
    "(apt-get --version 2>&1 | head -1 || echo 'apt-get: not found') && "
    "echo '@@MEM@@' && free -h 2>/dev/null | head -2 || true"
)
```

Output is delimited by `@@PWD@@`, `@@LS@@`, `@@LANG@@`, `@@PKG@@`, `@@MEM@@`
markers, parsed into an `[Environment Snapshot]` block injected into the
initial system prompt before the agent loop starts. Saves 2-5 exploration
turns per task by eliminating "what's here / what tools exist / where am I"
questions.

### 2.3 Control Plane Files

- **`pending_eval.json`** — list of candidates awaiting benchmark. Each
  entry has `name`, `import_path`, and optionally `hypothesis` + `changes`
  (the proposer's stated reason for this candidate). Written by
  `propose_claude`, consumed by `run_evolve`.
- **`frontier_val.json`** — Pareto frontier. Dict keyed by task name with
  `{best_agent, pass_rate}` per task, plus a `_best` key holding overall
  `{agent, avg_pass_rate}`. Updated by `update_frontier`.
- **`evolution_summary.jsonl`** — append-only per-candidate history. Read by
  the proposer to inform the next iteration.

### 2.4 `run_evolve` Control Flow

```
init → clear-if-fresh → Phase 0 baselines → update frontier →
  LOOP:
    propose_claude  (writes pending_eval.json)
    → normalize class names
    → validate (import check)
    → smoke_test (1 trial on SMOKE_TEST_TASK)
    → benchmark (harbor_run)
    → compute pass rates
    → update frontier_val.json
    → append evolution_summary.jsonl
  → Phase Final (optional 5-trial full eval)
```

Proposer is `claude_wrapper.run` with a domain-specific `SKILL.md` prior in
`.claude/skills/meta-harness-terminal-bench-2/`. Proposer prompt is rendered
by `render_task_prompt` with iteration number, trials-per-task, base model
(`anthropic/claude-opus-4-6`), parent agent, eval split size (89 tasks for
TB2), and log directories.

### 2.5 Overfitting Prevention

"All test sets are held out until the final evaluation." For math: 250-problem
search set, 200 held-out IMO problems for final eval. Transfer generalization
tested across five models unseen during search.

## 3. Chimera's Existing Substrate (What to Plug Into)

From the code-explorer inventory, the three plug-in points for a
`ChimeraHarness` boundary:

### PP-1: Agent construction in `chat.ts:505`

```typescript
const agent = createAgent({
  systemPrompt: createDefaultSystemPrompt(),   // ← static default
  tenantId, userId, sessionId, tier,
  loadedTools,                                 // ← tier-based, not harness-selected
  model,                                       // ← env var, not ModelRouter
});
// ...
const agentStream = otelContext.with(baggageCtx, () =>
  agent.stream(lastMessage.content, priorMessages),
);
```

A `ChimeraHarness` interposes here to decide: system prompt, tool manifest,
model, pre-invocation context (AWS account snapshot), memory retrieval policy.

### PP-2: `PromptOptimizer.runTestCase()` in `prompt-optimizer.ts:447`

```typescript
// PLACEHOLDER: length-based scoring + ±0.1 random variance.
// Does NOT invoke Bedrock.
```

This is where Meta-Harness eval replaces the bag-of-words heuristic with
real harness evaluation against held-out tasks.

### PP-3: `persistence-listener.ts` trajectory gap

`PromptOptimizer.analyzeConversationLogs()` and `AutoSkillGenerator.detect…`
query a `conversationLog` field that the chat gateway never writes. Dead
data path. A harness trajectory writer fills this — structured per-turn
records (tools called, latency, tokens, finish reason, quality score) to
`TENANT#{id}#LOGS#SESSION#{id}` for the proposer to grep over.

## 4. Chimera Forge Architecture

### 4.1 The `ChimeraHarness` Interface

In `packages/core/src/forge/harness-interface.ts` (new package):

```typescript
export interface HarnessInput {
  tenantId: string;
  userId: string | null;
  sessionId: string;
  tier: 'basic' | 'advanced' | 'enterprise';
  userMessage: string;
  priorMessages: Message[];
  isEval: boolean;        // benchmark mode vs live
  goldenTaskId?: string;  // when isEval=true
}

export interface HarnessContext {
  systemPrompt: string;
  toolManifest: ToolName[];
  memoryBundle: RetrievedMemory[];
  modelId: ModelId;
  accountSnapshot?: AwsAccountSnapshot;  // §4.3
  safetyContext: SafetyContext;
}

export interface HarnessResult {
  messageId: string;
  finalText: string;
  toolCalls: ToolCallRecord[];
  tokenUsage: { prompt: number; completion: number; total: number };
  finishReason: 'stop' | 'tool_use' | 'length' | 'error';
  durationMs: number;
  turnCount: number;
  errors: string[];
}

export interface ChimeraHarness {
  name: string;
  version: string;

  buildContext(input: HarnessInput): Promise<HarnessContext>;
  runTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessResult>;
  reflect(result: HarnessResult, input: HarnessInput): Promise<ReflectionRecord>;
}
```

Like Meta-Harness's TB2 `AgentHarness`, the framework imports the candidate
by a conventional path (`packages/core/src/forge/candidates/{name}.ts`) and
normalizes the export name to `Harness` regardless of what the proposer wrote.

### 4.2 Candidates (First 3)

| Candidate | Purpose | Parent |
|---|---|---|
| `baseline_harness` | Wraps current `chat.ts:505-568` behavior exactly. Frontier seed. | none |
| `aws_environment_bootstrap_harness` | Precomputes AWS account snapshot, injects into system prompt. | baseline |
| `skill_router_harness` | Classifies task → selects minimal tool subset before agent loop. | baseline |

Each candidate is a standalone TS file implementing `ChimeraHarness`.

### 4.3 AWS Environment Bootstrap (Chimera's `_gather_env_snapshot`)

The highest-value port from TB2. Precomputed **once per session** (not per
turn) and cached. The snapshot replaces early "what account am I in / what
resources exist" exploration:

```typescript
async function gatherAccountSnapshot(
  tenantId: string,
  tier: Tier,
): Promise<AwsAccountSnapshot> {
  const [tenant, resources, alarms, cost, deployments] = await Promise.all([
    getTenantProfile(tenantId),              // DDB chimera-tenants[PROFILE, CONFIG]
    listResourceSummary(tenantId),           // aws-tool: ResourceExplorer count per service
    listActiveAlarms(tenantId),              // CloudWatch DescribeAlarms filter INSUFFICIENT_DATA|ALARM
    getMonthlyCost(tenantId),                // Cost Explorer GetCostAndUsage, last 30d
    listRecentDeployments(tenantId, 10),     // CodePipeline recent executions
  ]);

  return {
    tenant: {
      tenantId, tier, budgetRemaining: tenant.budgetRemaining,
      allowedServices: tenant.allowedServices,
    },
    awsAccount: {
      accountId: tenant.awsAccountId,
      regionsWithResources: resources.regions,
      activeStacks: deployments.stackCount,
      recentDeployments: deployments.last10.length,
      recentAlarms: alarms.length,
    },
    resourceSummary: resources.byService,  // { lambda: {count, erroring}, s3: {count, public}, ... }
    safety: {
      iacChangeAllowed: tenant.evolutionEnabled,
      requiresApprovalAboveMonthlyDelta: 50,
      blockedOperations: ['modify_iam', 'delete_bucket', 'modify_vpc'],
    },
    computedAt: new Date().toISOString(),
  };
}
```

Injected into the system prompt as `<aws-environment-snapshot>...</aws-environment-snapshot>`
(delimited block, like TB2's `[Environment Snapshot]`). Cached in a module
Map keyed on tenantId with 5-minute TTL — the snapshot is shared across all
turns of a session and many sessions within the TTL.

**Safety**: the snapshot payload is bounded by the same 3-layer tenant
isolation as every other AWS call — `require_tenant_id()` on the Python
tool side, `FilterExpression='tenantId = :tid'` on DDB, Cedar
`Action::ReadAccountSnapshot` per tenant.

### 4.4 Control Plane in DynamoDB

Meta-Harness uses three filesystem files. Chimera Forge uses `chimera-evolution-state`
DDB items under a new `FORGE#...` prefix (no new table):

```
PK: TENANT#{tenantId}  (or GLOBAL for cross-tenant search on platform harnesses)
SK: FORGE#CANDIDATE#{candidateId}
  name, importPath, parent, hypothesis, changes[], status, createdAt

PK: TENANT#{tenantId}
SK: FORGE#PENDING_EVAL
  candidates: [candidateId]    (list reset each iteration)

PK: TENANT#{tenantId}
SK: FORGE#FRONTIER
  byTask: { taskId → { bestCandidate, passRate } }
  best: { candidateId, avgPassRate }

PK: TENANT#{tenantId}
SK: FORGE#EVOLUTION#{iteration}#{candidateId}
  iteration, candidateId, passRates, tokens, cost, durationMs, errors
  ttl: 90 days
```

`evolution_summary.jsonl` is the range-query over
`PK=TENANT#{tid} AND SK begins_with FORGE#EVOLUTION#`, sorted by SK.

### 4.5 Candidate Lifecycle

Maps Meta-Harness's implicit states to explicit ones that play well with
Chimera's `EvolutionSafetyHarness`:

```
DRAFT                     — proposer wrote the file
  ↓
IMPORT_VALIDATED          — candidate module loads, exports Harness class
  ↓
SMOKE_TEST_PASSED         — 1 trivial eval task runs without throwing
  ↓
SAFETY_GATED              — EvolutionSafetyHarness.authorize() returned PERMIT
  ↓                         (uses real AVP; blocks forbidden infra/prompt ops)
OFFLINE_BENCHMARKED       — ChimeraBench v0 (10 tasks) scored
  ↓
CANARY                    — ≤1% dev-tier tenant traffic (Phase 2+)
  ↓
PROMOTED                  — frontier winner on Pareto dominance over
                            (passRate, tokens, cost, durationMs)
  ↓
RETIRED | ROLLED_BACK     — terminal
```

The `SAFETY_GATED` stage is *new* compared to Meta-Harness. It gates on
Cedar/AVP *before* the benchmark runs, so candidates that attempt blocked
operations (self-modify IAM, bypass tenant isolation) don't consume eval
budget.

### 4.6 ChimeraBench v0 — 10 Tasks

Mirror TB2's 89-task split but start conservative. All tasks are
**offline** (mocked AWS calls via deterministic fixtures) to avoid
accidental cost or tenant-data reads:

```
chimera-bench/aws-readonly
  1. find-untagged-s3-buckets
  2. explain-lambda-timeout-spike
  3. summarize-active-alarms
  4. list-public-s3-buckets

chimera-bench/iac-generation
  5. add-s3-lifecycle-policy
  6. create-budget-alarm

chimera-bench/incident-response
  7. diagnose-ecs-deployment-failure

chimera-bench/tenant-isolation
  8. assert-no-cross-tenant-ddb-query
  9. assert-tenantid-in-gsi-filter

chimera-bench/security
  10. recommend-least-privilege-iam-policy
```

Each task has:
- `input.json`: user message + mocked AWS fixture state
- `expected.json`: required tool calls (set membership), banned operations,
  success assertion on final output
- `scoring.ts`: returns `{ pass: boolean, toolsCorrect: boolean, policyCompliant: boolean, unsafeAttempts: number }`

Aggregate metrics per candidate per task:
- `taskSuccessRate` (primary)
- `toolCorrectness` (did it call the right tools?)
- `policyCompliance` (any banned ops attempted?)
- `avgTokens`, `avgCost`, `avgDurationMs`, `avgTurnCount`

Promote only via Pareto dominance over all four primary metrics
(same approach as the chimera-606c CompositeFitness design — explicitly
reuse that struct).

## 5. CDK Additions

### New Files

- `packages/core/src/forge/harness-interface.ts` — type definitions
- `packages/core/src/forge/candidates/baseline_harness.ts` — wraps current chat flow
- `packages/core/src/forge/candidates/aws_environment_bootstrap_harness.ts`
- `packages/core/src/forge/candidates/skill_router_harness.ts`
- `packages/core/src/forge/bench/v0/*.ts` — 10 tasks with fixtures
- `packages/core/src/forge/runner/evolve.ts` — port of `run_evolve`
- `packages/core/src/forge/runner/proposer.ts` — port of `propose_claude`
  (uses Bedrock Converse as the Claude Code equivalent — same IAM pattern
  as the existing `LLMDecompositionProvider`)
- `infra/lib/forge-stack.ts` — new CDK stack

### Forge Stack (Phase 1)

```typescript
export class ForgeStack extends Stack {
  // Step Functions state machine: Propose → Validate → Smoke → Safety → Bench
  // Lambda: chimera-forge-proposer (Node 20, 512MB, 5-min timeout)
  // Lambda: chimera-forge-validator (Node 20, 256MB)
  // Lambda: chimera-forge-smoke (Node 20, 256MB)
  // Lambda: chimera-forge-benchmark (Node 20, 1GB, 15-min timeout)
  //   - loops over ChimeraBench tasks, runs candidate harness against
  //     mocked AWS fixtures, writes results to FORGE#EVOLUTION# items
  // IAM: bedrock:InvokeModel, ddb:Query/PutItem on chimera-evolution-state
  // SSM: /chimera/forge/enabled/{env}  (kill switch mirroring /chimera/evolution/self-modify-enabled)
  // EventBridge: scheduled nightly run (opt-in per tenant via tenant config flag)
}
```

Reuses: `EvolutionSafetyHarness` from `packages/core/src/evolution/safety-harness.ts`
invoked between Smoke and Benchmark. No new AVP policy store.

### Modified Files

- `infra/lib/data-stack.ts` — none (reuse `chimera-evolution-state`)
- `packages/core/src/evolution/prompt-optimizer.ts` — replace
  `runTestCase()` placeholder with call into `ForgeBenchRunner`.
  Feature-flag behind `FORGE_V0_ENABLED=true` env var.
- `infra/lib/chat-stack.ts` — (Phase 2 only) inject
  `activeHarnessId` env var into ECS task; chat route resolves
  harness by id from DDB frontier.

### Phase 1 scope does NOT touch chat-stack.ts

Chat gateway still runs the baseline behavior. Forge runs *entirely offline*
in Phase 1: scheduled Lambda evaluates candidates against fixtures, writes
frontier updates, produces reports. No live traffic sees a non-baseline
harness until Phase 2 canary.

## 6. Relationship to Other Backlog Items

| Item | Interaction |
|---|---|
| chimera-606c DGM (composite fitness + lineage) | **Reuse directly.** Forge's benchmark scoring emits the `CompositeFitness` struct from 606c. The lineage adjacency list becomes Forge's `evolution_summary`. Ship 606c first; Forge consumes it. |
| chimera-2b2a EventBridge Scheduler | Forge uses the schedule infrastructure to trigger nightly evolution runs per tenant (opt-in). |
| chimera-301e AgentCore Observability (Wave-27/28) | Benchmark runs emit `session.id` + `candidate.id` baggage so every trace is attributable to its harness. Enables debugging regressions post-promotion. |
| chimera-b7af Strands SDK migration | Parallel track. Forge's `buildContext()` signature doesn't depend on which SDK implements `runTurn()` — a migration is a single-candidate swap. |

Forge is **enabled by** 606c + 301e, **orthogonal to** 2b2a and b7af.

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Proposer generates infinite-loop candidates | Medium | High | `maxTurns=20` hard cap in runTurn, `validate` step rejects any candidate that doesn't pass smoke test in 60s |
| Candidate bypasses tenant isolation | Low | Critical | `SAFETY_GATED` stage uses real AVP; banned ops also checked at each tool-call site via `require_tenant_id()` |
| Eval set overfitting | High | Medium | Start with 10 tasks but hold back 5 tasks as never-searched final-eval set. Every iteration reports delta between search-set and holdout-set pass rate — flag when delta > 0.15 |
| Bedrock cost explosion from proposer | Medium | Medium | `MAX_CANDIDATES_PER_ITERATION=2`, `MAX_ITERATIONS_PER_DAY=10`, SSM-configurable |
| Candidate causes production regression | Low (Phase 1 offline) | High | Phase 1 is offline-only. Phase 2 canary uses `activeHarnessId` env var; automatic rollback on p95 latency >2× baseline or unsafe-op >0 |

## 8. Phased Plan

### Phase 1 — Offline Harness + ChimeraBench v0 (3-4 days)

**Day 1**
- [ ] Define `ChimeraHarness` interface in new `packages/core/src/forge/` package.
- [ ] Implement `baseline_harness.ts` (wraps current behavior; verifies interface is right).
- [ ] Write 10 ChimeraBench v0 tasks + fixtures.
- [ ] Unit tests for the harness interface and baseline.

**Day 2**
- [ ] Implement `aws_environment_bootstrap_harness.ts` with real
  Resource Explorer / Cost Explorer / CloudWatch calls, under tenant
  isolation.
- [ ] Implement `skill_router_harness.ts` (classify → prune tool manifest).
- [ ] Offline ForgeBenchRunner Lambda.
- [ ] Run all three candidates against all 10 tasks — capture baseline
  frontier_val.json-equivalent DDB item.

**Day 3**
- [ ] Port `run_evolve` control flow as Step Functions state machine.
- [ ] Port `propose_claude` using Bedrock Converse.
- [ ] Wire `EvolutionSafetyHarness` as the `SAFETY_GATED` stage.
- [ ] `frontier.json` → DDB `FORGE#FRONTIER` write path.
- [ ] Run 2-iteration test end-to-end.

**Day 4**
- [ ] Replace `PromptOptimizer.runTestCase()` with `ForgeBenchRunner`
  call (feature-flagged).
- [ ] Admin API endpoint: `GET /admin/tenants/{id}/forge/frontier`.
- [ ] Documentation, retrospective note, seeds issue close.

### Phase 2 — Canary Rollout (future issue, ≥3 days)

- `activeHarnessId` DDB per tenant (default: baseline).
- Chat route loads harness by id from frontier promotion result.
- Canary cohort: internal tenants first, then 1% of dev-tier tenants.
- Automatic rollback: p95 latency regression or safety violation.

### Phase 3 — Meta-Meta (future, weeks)

- LLM-as-judge evaluator (replaces keyword overlap in individual scoring).
- Per-domain Skill.md priors (incident-response skill, iac-generation skill,
  cost-optimization skill).
- Multi-objective Pareto frontier viz in admin dashboard.

## 9. Success Metrics for Phase 1

Not production metrics — engineering-discipline metrics:

- **Frontier observable**: after 5 iterations, `FORGE#FRONTIER` DDB item
  exists and has `best.avgPassRate > baseline.avgPassRate` by a statistically
  detectable margin.
- **AWS Environment Bootstrap wins ≥3 of 10 tasks** vs baseline (predicted
  strongest on aws-readonly + incident-response tasks).
- **Safety gate engaged ≥1 time**: at least one candidate is rejected by
  `SAFETY_GATED` during the 5 iterations — proves the gate is wired.
- **Holdout generalization**: delta between search-set and holdout-set pass
  rate is < 0.15 (< 15% gap).

If the gate never fires or holdout generalization is poor, the framework
works but the bench is too small/too narrow — expand bench before shipping
Phase 2.

## 10. Open Questions

1. **Proposer model choice.** TB2 uses `claude-opus-4-6` via Claude Code.
   Chimera Forge should use the same model via Bedrock Converse for parity,
   but may swap to a cheaper proposer (`claude-haiku-4-5`) after first
   iterations stabilize. Decision: start Opus, measure cost, consider Haiku
   downgrade for iterations 10+.
2. **Global vs per-tenant frontier.** Meta-Harness has one global frontier
   because each run is a single research project. Chimera is multi-tenant —
   should platform harnesses be searched globally (one frontier) or per
   tenant (N frontiers)? **Recommendation**: Global for platform harnesses
   (baseline, aws-bootstrap, skill-router) in Phase 1. Per-tenant later
   only if task distributions diverge meaningfully.
3. **Benchmark task set growth.** 10 tasks is too small for real statistical
   signal. Plan for a v1 expansion to 50 tasks after Phase 1 ships — the
   interface and runner are the valuable deliverables, not the initial
   bench content.

## 11. Appendix — Why This Is Not Over-Scoped

This is a legitimate scope concern. The mitigation is that **every deliverable
is useful independently:**

- The `ChimeraHarness` interface + baseline alone unlocks swappable agent
  scaffolding — the team can hand-write new candidates without the proposer.
- The AWS Environment Bootstrap harness alone is a product feature ("Chimera
  now knows about your account before you ask") independent of any search.
- ChimeraBench v0 alone gives `PromptOptimizer.runTestCase()` a real
  implementation, replacing the length-bonus placeholder — that fixes the
  broken evolution loop regardless of whether Forge ever ships.
- The Step Functions evolution pipeline alone is the missing canary/promote
  infrastructure called out in the code-explorer report.

Meta-Harness's contribution is the *glue* that makes these four pieces
improve together rather than separately.
