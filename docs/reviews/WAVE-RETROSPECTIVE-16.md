---
title: "Wave 16 Retrospective — backlog 19 → 15, plus 2 security hardening wins"
status: retrospective
date: 2026-04-24
wave: 16
previous: WAVE-RETROSPECTIVE-15.md
---

# Wave 16 Retrospective

**Dates:** 2026-04-24
**Outcome:** Backlog 19 → 15 open items. 2 HIGH security fixes landed (cross-tenant leak vector in tenant_context, CI GITHUB_TOKEN least-privilege). Log retention harmonized across 10 stacks with class-based helper. Observability metrics verified + alarm wired for `tier_violation_count`.

## What shipped — 13 commits

### 16a — Parallel agents (TypeScript hardening + triage)
- `5ecb88b` fix(agents): remove `CHIMERA_TENANT_ID` env-var fallback (Wave-16 H3) — 7-line security fix + 12 test updates + **30 Zod schemas + 53 round-trip tests in packages/shared**
- `eebdab8` docs: Wave-16 workflow.ts triage — KEEP-WITH-SIMPLIFICATION verdict

### 16b — Observability + log retention
- `247e110` feat(infra): add `logRetentionFor()` helper with class-based retention
- `5f7c218` refactor(infra): apply `logRetentionFor()` across 9 stacks (24 LogGroup sites migrated)

### 16c — CI + E2E
- `ed9b670` test(agents): E2E agent-loop max-iteration circuit breaker + pytest-cov for CI coverage
- `0d5f420` test(model-router): integration test for tier-fallback + EMF metric

### Concurrent review
- `79a9cfe` review: Wave-16 concurrent review — 3 H / 3 M / 2 L findings

### Main-thread direct fixes
- `fe67d70` ci(security): add least-privilege permissions block (Wave-16 H1)
- `7ee9390` fix(api): enumerate dev/staging CORS origins instead of ALL_ORIGINS (Wave-16 M2)

### Punch list reconcile
- `0391ee0` docs: reconcile OPEN-PUNCH-LIST — 19 → 10 open (later corrected to 15 after audit of what actually landed)

## Backlog burndown

| Category | Wave 15 end | Wave 16 end | Δ |
|----------|-------------|-------------|-----|
| spike-blocked | 1 | 1 | 0 |
| infra-refactor | 3 | 3 | 0 (log retention closed; NAT/DDB/DAX remain) |
| python-hardening | 0 | 0 | 0 |
| typescript-hardening | 2 | 1 | -1 (Zod shared boundary) |
| docs | 0 | 0 | 0 |
| ops-runbooks | 0 | 0 | 0 |
| observability-emitter | 3 | 3 | 0 (tier_violation_count alarm wired — verification items remain) |
| cost-reduction | 3 | 3 | 0 |
| cleanup | 7 | 4 | -3 (workflow.ts triage, E2E circuit breaker, coverage artifacts) |
| **Total** | **19** | **15** | **-4** |

Plus 3 concurrent-review findings (H1/H3/M2) fixed in-wave beyond the original backlog.

## Wave 16 security wins

### H3 — Removed cross-tenant leak vector
`tenant_context.py::get_tenant_context()` had an env-var fallback that would return a TenantContext built from `CHIMERA_TENANT_ID` when the ContextVar was unset. Because `os.environ` is process-wide, any ECS task with that env var set would leak its tenant to every uninitialised request. The anti-pattern guard test checked imports but couldn't catch this runtime fallback.

**Impact:** Any future single-tenant dev deployment or misconfigured task would have silently served cross-tenant data. The fix is a 12-line deletion + test flip.

### H1 — CI GITHUB_TOKEN least-privilege
CI workflow had no `permissions:` block. GITHUB_TOKEN defaulted to the repo-level grant (often write on contents, pull-requests, packages). Any compromised third-party action (setup-bun, setup-uv, checkout, upload-artifact) could push to main or create releases. Fix: `permissions: contents: read` at workflow level.

## Wave 16 process wins

- **Parallel 3-agent execution + 1 reviewer** kept velocity high while finding 8 new issues (the reviewer's 3 HIGH + 3 MEDIUM + 2 LOW). Two of those were fixed in the same wave.
- **Agent partial-commit pattern stabilized.** Every Wave-15/16 agent confirms they can't `git commit` but DO stage changes. Main thread commits atomically in logical groups. This is now the reliable pattern — no more time wasted retrying commits from agents.
- **Concurrent review caught a security issue prior waves missed.** The `tenant_context.py` env-var fallback predates Wave 11; 3 reviewers missed it. Wave-16 reviewer (feature-dev:code-reviewer with explicit "areas prior reviewers didn't cover" prompt) found it.

## Wave 16 process friction

- **ci.yml broke once** when `api-stack.ts` (in commit 7ee9390) used `logRetentionFor` before the construct was committed (247e110 landed two commits later). This is a cross-commit ordering hazard when multiple agents stage overlapping files. Mitigation: commit shared-module additions BEFORE the callers that import them.
- **Stale `tsconfig.tsbuildinfo` still churning.** Every wave leaves this file in a modified state. It's gitignored from CI but shows up in `git status` noise. Low-severity — skip in future git-add.

## Remaining 15 items — characterization

| Blocker type | Count |
|--------------|-------|
| Spike-blocked (1-week effort) | 1 |
| Separate PR (2+ days dedicated) | 1 |
| Needs prod traffic data (4+ weeks) | 5 |
| Research-pending (Gateway migration Q3) | 2 |
| Verification + alarm follow-ups | 3 |
| Nice-to-have cleanup | 3 |

## Deploy state

- 14/14 stacks still UPDATE/CREATE_COMPLETE in `baladita+Bedrock-Admin` (us-west-2)
- CI + Security Scan + Release green on `main`
- All 13 Wave-16 commits pushed to `origin`
- v0.6.2 is current tag; v0.6.3 will be cut when the next set of fixes is ready for a release cycle

## References

- `docs/reviews/wave16-concurrent-review.md` (3H/3M/2L audit)
- `docs/reviews/wave16-workflow-ts-triage.md` (KEEP-WITH-SIMPLIFICATION verdict)
- `docs/architecture/observability.md` (metric catalog updated in Wave-15d)
- `packages/shared/src/schemas/` (30 new Zod schemas at cross-package boundary)
- `infra/constructs/log-retention.ts` (class-based retention helper)
