---
title: "DGM Evolution Integration — Composite Fitness and Lineage"
issue: chimera-606c
status: proposed
date: 2026-04-26
author: architect-agent
priority: backlog
effort: 3-5 days (MVP scope)
---

# chimera-606c: DGM Evolution Integration — Composite Fitness and Lineage

## TL;DR

**Build:** Replace the current single-metric quality score with a
`CompositeFitness` struct (taskSuccessRate, costPer1kInteractions,
p95LatencyMs, userSatisfactionRate) stored on every variant, plus a
DynamoDB adjacency-list lineage graph so you can answer "what prompt did
this winner descend from?" in a single query.

**Skip:** Full open-ended DGM population management, novelty/diversity
selection pressure, code-level self-rewriting, and OpenEvolve-style
population size > 2. These are research-org features incompatible with a
B2B SaaS cost model and Cedar policy constraints.

**Why only these two:** Composite fitness gives A/B a multi-objective
winner signal (fixes the current bug where a variant wins on keyword
overlap despite 3x cost). Lineage tracking costs ~$0/month in DDB storage
and unlocks tenant-facing "your prompt has improved 4 generations in 30
days" analytics.

## 1. DGM Primer

The Darwin Gödel Machine (Sakana AI, May 2025, arXiv 2505.22954) combines
Gödelian self-reference (agents can modify their own code) with Darwinian
population evolution. Loop: init → variation → evaluation → selection →
iteration. Variants are evaluated on composite fitness (task pass rate +
code correctness + efficiency + novelty). Survivors reproduce; losers are
archived in a lineage graph for potential future revival.

Differences vs Chimera's current A/B framework:
- **Population size > 2.** A/B tests exactly 2 variants; DGM maintains 10-50.
- **Composite fitness.** A/B uses `avg_quality_score > 0.8`; DGM uses Pareto
  fronts over multiple objectives.
- **Lineage tracking.** Full parent-child graph of every variant.
- **Code-level self-rewriting.** DGM rewrites its own tool code.
- **Novelty pressure.** Rewards behavioral diversity.

For Chimera (B2B SaaS), Gödelian self-rewriting and open-ended novelty are
out of scope. The practically extractable ideas are **composite fitness**
and **lineage**.

## 2. Gap Analysis

| Component | Current | Gap |
|---|---|---|
| A/B prompt testing | Single `avg_quality_score`, 24h window | No multi-objective winner |
| Model routing | Thompson sampling (quality, cost) | Already multi-objective but not formalized |
| `getPrimaryMetric()` | Stub: first key of metrics map | No composite computation |
| Variant storage | `TENANT#...#PROMPT#VARIANT#...` items | No `parent_variant_id`; no lineage GSI |
| Winner selection | Hardcoded `> 0.8` or `< 10% cost` | No Pareto dominance |

## 3. Recommended MVP Additions

### 3.1 CompositeFitness Type

In `packages/core/src/evolution/types.ts`:

```typescript
export interface CompositeFitness {
  taskSuccessRate: number;         // 0.0–1.0
  costPer1kInteractions: number;   // USD
  p95LatencyMs: number;
  userSatisfactionRate: number;    // 0.0–1.0, -1 if no live signal yet
  sampleSize: number;
  compositeScore: number;          // weighted scalar for ranking
  computedAt: ISOTimestamp;
}

export interface FitnessWeights {
  taskSuccessRate: number;    // default 0.40
  costEfficiency: number;     // default 0.25
  latencyEfficiency: number;  // default 0.20
  userSatisfaction: number;   // default 0.15
}

export interface LineageEdge {
  tenantId: string;
  parentVariantId: string;  // "ROOT" for generation 0
  childVariantId: string;
  generation: number;
  fitnessDelta: number;     // child.compositeScore - parent.compositeScore
  createdAt: ISOTimestamp;
  ttl?: number;
}
```

Weights configurable via SSM `/chimera/evolution/fitness-weights/{env}`.

### 3.2 DDB Lineage Adjacency List

New GSI `GSI3-lineage` on `chimera-evolution-state`:

```
GSI3-PK: lineageIndexPK = "TENANT#{tenantId}#LINEAGE"
GSI3-SK: lineageSortKey = "{parent_variant_id}#{child_variant_id}"
```

New item type (written alongside variant creation):

```
PK: TENANT#{tenant_id}#LINEAGE
SK: {parent_variant_id}#{child_variant_id}

tenant_id, parent_variant_id, child_variant_id (str)
generation (num), fitness_delta (num), created_at (str)
ttl (num, 90d)
lineageIndexPK (str), lineageSortKey (str)
```

Query patterns:
- Children of variant V: `GSI3 WHERE lineageIndexPK = "TENANT#X#LINEAGE" AND lineageSortKey BEGINS_WITH "V#"`
- Full descent: paginate `lineageIndexPK = "TENANT#X#LINEAGE"` sorted by SK
- Full ancestry: N sequential reads where N = generation depth (typically 5-10 — acceptable without graph DB)

### 3.3 New `chimera-evolution-compute-fitness` Lambda

Python Lambda chained after `TestVariant` in `PromptEvolutionPipeline`:

```python
def handler(event, context):
    # event: { tenant_id, variant_id, parent_variant_id, raw_metrics }
    # 1. Read variant item + raw metrics
    # 2. Fetch weights from SSM (5-min module cache)
    # 3. Compute CompositeFitness
    # 4. UpdateItem variant with composite_fitness map
    # 5. PutItem lineage edge
    # returns: { tenant_id, variant_id, composite_fitness, lineage_edge_written }
```

### 3.4 Pareto Dominance Winner Selection

Replace in `prompt-optimizer.ts` `completeExperiment()`:

```typescript
function paretoDominates(a: CompositeFitness, b: CompositeFitness): boolean {
  // B dominates A if B ≥ A on all objectives AND B > A on ≥1
  return (
    b.taskSuccessRate >= a.taskSuccessRate &&
    b.costPer1kInteractions <= a.costPer1kInteractions &&
    b.p95LatencyMs <= a.p95LatencyMs &&
    b.userSatisfactionRate >= a.userSatisfactionRate &&
    b.compositeScore > a.compositeScore
  );
}
```

For A/B (2 variants): B wins if it doesn't regress on any objective and
improves composite. Otherwise A (control) retained.

**Cold-start fallback**: if `sampleSize < 10` for B, fall back to
single-objective comparison (`compositeScore > baseline * 1.03`).

### 3.5 Admin Lineage API

Two new API Gateway routes, backed by new `chimera-evolution-lineage-query-{env}` Lambda (Node 20, ~100 LOC):

```
GET /admin/tenants/{tenantId}/variants/{variantId}/lineage
  Response: { variantId, generation, lineageChain: [...] }

GET /admin/tenants/{tenantId}/fitness-trajectory?days=30
  Response: { tenantId, periodDays, variants: [...], currentBestScore, generationsEvaluated, trendDirection }
```

Auth: Cognito JWT with `admin` scope. Tenant isolation via DDB query scoped
to `TENANT#{tenantId}#LINEAGE`.

## 4. Normalization for Composite Score

Cost and latency are "lower is better" — normalize against tenant-level
baselines stored in `MODEL_ROUTING`:

```
composite_score =
    w.taskSuccess   * taskSuccessRate
  + w.cost          * (1 - normalize(costPer1k, baseline_cost))
  + w.latency       * (1 - normalize(p95LatencyMs, baseline_latency))
  + w.satisfaction  * userSatisfactionRate

normalize(x, baseline) = min(x / (baseline * 2), 1.0)
```

So cost 2× baseline → 0.0, baseline → 0.5, half baseline → 1.0.

For variants with no live traffic (`userSatisfactionRate = -1`), use neutral
prior 0.5. Flag `insufficient_live_data: true` when `sampleSize < 5` so
callers can weight appropriately.

## 5. CDK Changes

### Modified

**`infra/lib/evolution-stack.ts`**
1. Add `GSI3-lineage` to `chimera-evolution-state-{env}` via `ChimeraTable` constructor.
2. Add SSM parameter `/chimera/evolution/fitness-weights/{env}`.
3. Add `chimera-evolution-compute-fitness-{env}` Lambda (Python 3.12).
4. Add `chimera-evolution-lineage-query-{env}` Lambda (Node 20).
5. Wire compute-fitness into `PromptEvolutionPipeline` after `TestVariant` step.
6. Change `VariantTestPassed` choice condition from `$.avg_quality_score > 0.8` to `$.composite_fitness.compositeScore > 0.75`.
7. IAM: `ddb:PutItem,UpdateItem` + `ssm:GetParameter`.

**`packages/core/src/evolution/types.ts`**
Add `CompositeFitness`, `LineageEdge`, `FitnessWeights`. Update `PromptVariantResult` to include `compositeFitness?`.

**`packages/core/src/evolution/prompt-optimizer.ts`**
- Replace winner detection with Pareto logic.
- Add `computeCompositeFitness(rawMetrics, weights)` + `writeLineageEdge(...)`.

**`packages/core/src/evolution/experiment-runner.ts`**
Replace `getPrimaryMetric()` stub with `getCompositeFitnessScore()` reading `composite_fitness.compositeScore` from trial metrics.

### New Files

- `infra/lambdas/evolution/compute-fitness/index.py`
- `infra/lambdas/evolution/lineage-query/index.mjs`

## 6. Test Scenarios

1. **Unit — composite fitness computation.** Given raw metrics + baseline, assert `compositeScore` matches expected within tolerance 0.001.
2. **Unit — Pareto winner.** B better on taskSuccess + cost, slightly worse on latency → B wins. B regresses on taskSuccess → A retained.
3. **Integration — lineage edge write.** Mock event → assert lineage edge in DDB with correct `lineageIndexPK`/`lineageSortKey`, `parent_variant_id` on variant item.
4. **Integration — GSI3 query.** 3 generations of edges → query returns chain in order with accurate `fitnessDelta`.
5. **E2E — fitness trajectory API.** 5 variants over 30 days → `GET /fitness-trajectory?days=30` returns correct `trendDirection`, `currentBestScore`.

## 7. Out of Scope (with rationale)

| Feature | Rejected Because |
|---|---|
| **Population > 2** | Each variant consumes real tenant traffic. Cedar policy caps prompt changes at 5/week — 10-variant pop exhausts budget in one cycle. |
| **Novelty/diversity bonuses** | Rewards behavioral divergence. Appropriate for research; harmful in SaaS where agents should converge to correct behavior. |
| **Code-level self-rewriting (Gödelian)** | Blocked by Cedar (`forbid apply_infra_change` on IAM/VPC). Attack surface risk. The existing IaC modifier + auto-skill generator cover the practical 80%. |
| **OpenEvolve-style multi-task benchmark** | Requires hundreds of parallel task evaluations. Chimera golden datasets are tenant-specific (20 cases max in test-prompt Lambda). |
| **AlphaEvolve program synthesis** | Chimera agents are prompt-based, not program-synthesis targets. |
| **LLM-as-judge variant generation** | Tracked separately as chimera-76b9 (LLM-based task decomposer). Conflating bloats scope. |
| **Graph DB for lineage (Neptune)** | DDB adjacency list covers 90% of queries (linear ancestry). Full arbitrary-traversal is a dashboarding feature, not operational. |
| **Cross-tenant lineage aggregation** | Multi-tenant isolation model + Cedar policies require opt-in. Out of scope. |

## 8. Phased Plan

### Day 1-2 — Composite Fitness

- [ ] `types.ts`: `CompositeFitness`, `LineageEdge`, `FitnessWeights`.
- [ ] `prompt-optimizer.ts`: `computeCompositeFitness()` + Pareto winner.
- [ ] `experiment-runner.ts`: replace `getPrimaryMetric()` stub.
- [ ] SSM parameter for fitness weights.
- [ ] Unit tests 1, 2.
- [ ] `bun test && bun run typecheck` green.

### Day 3-4 — Lineage Graph

- [ ] `GSI3-lineage` on evolution-state table.
- [ ] `compute-fitness` Python Lambda inline in evolution-stack.ts.
- [ ] Wire into Step Functions after `TestVariant`; update `VariantTestPassed` choice.
- [ ] `writeLineageEdge()` in prompt-optimizer.
- [ ] Integration tests 3, 4.
- [ ] `bun test && bun run lint && bun run typecheck` green.

### Day 5 — Admin API + E2E

- [ ] `lineage-query` Node Lambda + 2 API Gateway routes.
- [ ] E2E test 5.
- [ ] `npx cdk synth EvolutionStack` clean.
- [ ] Full quality gates pass.

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `userSatisfactionRate = -1` in dev | High | Low | Neutral prior 0.5 when `sampleSize < 5` |
| GSI3 hot partition on LINEAGE PK | Low | Medium | Writes are once per variant creation, far below DDB limits |
| Pareto always picks A (control) on thin data | Medium | Low | `sampleSize < 10` triggers single-objective fallback |
| Breaking VariantTestPassed choice condition | Medium | High | Two-step deploy: ship compute-fitness Lambda first (adds field), then update SFN choice |
