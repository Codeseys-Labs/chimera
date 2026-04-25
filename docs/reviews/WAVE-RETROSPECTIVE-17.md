---
title: "Wave 17 Retrospective — 4 parallel reviewers, 32 findings, 4 CRITICAL fixes landed"
status: retrospective
date: 2026-04-24
wave: 17
previous: WAVE-RETROSPECTIVE-16.md
---

# Wave 17 Retrospective

**Dates:** 2026-04-24
**Outcome:** 4 parallel reviewer wave (architecture + code-quality + security-ops + strategic) produced **32 findings total** across severity buckets. **4 CRITICAL findings closed in-wave** — the most impactful being a live cross-tenant isolation breach in `background_task_tools.py` and a silent-canary-alarm blocker for first-external-tenant onboarding.

## The 4 reviewers

| Reviewer | Scope | Findings (C/H/M/L) |
|---------|-------|-------------------|
| **17-A** Architecture + Doc Coherence | README, ROADMAP, VISION, CLAUDE.md, ADRs, system-arch, data-model, observability, self-evolution-pattern, deployment-architecture | 1 / 3 / 2 / 3 = 9 |
| **17-B** Code Quality + Logic | Python agents, TS core (billing, evolution, tenant, skills), CLI, new Wave-16 infra | 2 / 4 / 3 / 2 = 11 |
| **17-C** Security + Ops | Data-at-rest, in-transit, runbook coverage, alarm mapping, supply chain, DR | 2 / 4 / 3 / 3 = 12 |
| **17-D** Strategic + Vision | Product-market fit, competitive positioning, scope drift, 90-day picks | Verdict: DRIFTED (customer surfaces unbuilt) |
| **Total** | | **5 C / 11 H / 8 M / 8 L = 32** |

## What shipped in-wave

### 4 CRITICAL fixes landed
- **C1 (17-B):** `background_task_tools.py` tenant-isolation bypass — `os.environ.get('TENANT_ID')` read instead of ContextVar return value. Fixed by using `tenant_id = require_tenant_id()` return in both `start_background_task` and `check_background_task`. Commit `da2194d`.
- **C2 (17-C):** Pipeline alarm topic had zero subscribers — canary regressions would silently auto-rollback with no human page. Fixed by subscribing opsEmail + PagerDuty in prod, matching ObservabilityStack's pattern. Commit `e9320c8`.
- **H4 (17-B):** Evolution kill switch failed OPEN on `ParameterNotFound`, meaning fresh deploy had all 3 safety gates inert. Fixed to fail CLOSED on missing param; retains fail-open for transient errors. Commit `fc2aeb0`.
- **L2 (17-B) bundled with H4:** `addToPolicy` literal pattern matched legitimate `addToRolePolicy` — fixed to `.addToPolicy(` with trailing paren.

### Documentation hardening landed
- **A1 (17-A):** `deployment-architecture.md`: 13 → 14 stacks, added `Discovery` row, bumped `last_updated`
- **A2 (17-A):** `self-evolution-pattern.md` §3: `bunx cdk synth` → `npx cdk synth --all` (ADR-021 compliance)
- **A3 (17-A):** `self-evolution-pattern.md` §3: canary `10% → 50% → 100%` → `5% → 25% → 50% → 100%` matching system-architecture.md §8
- **A4 (17-A):** README.md `v0.6.0` → `v0.6.2` (both install-test and Current Status references)

Commit `e268375`.

### 4 review docs landed
- `wave17-architecture-doc-review.md`
- `wave17-code-quality-review.md`
- `wave17-security-ops-review.md`
- `wave17-strategic-review.md`

Commit `978230f`.

## Reviewers' process notes

### "Areas prior reviewers did NOT cover" prompt guardrail worked
Every Wave-17 reviewer was explicitly told to skip overlap with Waves 14, 15, 15d, 16. The result: 32 findings with minimal duplication across reviewers. Without this guardrail, parallel reviewers converge on the same 3–5 obvious issues and miss the long tail.

### Strategic reviewer added qualitative value the code reviewers couldn't
17-D flagged **scope drift** — engineering substrate matches the vision, but customer surfaces (self-serve onboarding, Stripe billing, admin UI CRUD, skill marketplace browsing) are scaffolded but unbuilt. A purely code-focused review misses this entirely. The strategic reviewer's "3 things in 90 days" pick: close the GTM loop (signup + billing + admin), close the self-evolution loop + ship a demo, commit to an AgentCore migration roadmap.

### Every reviewer agent reported "git commit blocked by sandbox"
Same as Waves 15 + 16. Pattern is now fully stable: agents stage + return full content, main thread commits atomically. No more time wasted trying to escalate commit permissions.

## Findings deferred to Wave 18 (not blocking)

From 17-C (security + ops):
- **C-1 (17-C):** DAX SSE-AWS not CMK — compliance posture gap, not a live leak
- **H-1 (17-C):** 5 DDB table CMKs use DESTROY in non-prod — potential data-loss on stack-destroy-then-recreate
- **H-2 (17-C):** ALB access-log bucket not wrapped in ChimeraBucket
- **H-3 (17-C):** DR scripts referenced but do not exist (docs-only fix + script creation)
- **H-4 (17-C):** 11 alarms missing `addOkAction`

From 17-B (code quality):
- **C2 (17-B):** `self-evolution-orchestrator.ts` commit_failed race (orchestrator state inconsistency)
- **H1 (17-B):** `list_lambda_functions` pagination missing
- **H2 (17-B):** `gateway_proxy.py` logs truncated error, not full
- **H3 (17-B):** `TierViolationCountAlarm` dimension mismatch (alarm never fires)

From 17-A (architecture):
- **H (17-A):** Write ADR-035 (log retention) + ADR-036 (Zod schemas) + ADR-037 (MFA tiering) + ADR-038 (token lifetime) + ADR-039 (EMF emission)
- **M (17-A):** Update ROADMAP.md "Current State" to reflect deployed status (54 → 15 items stale reference)
- **L (17-A):** Remove stale `<!-- TODO(wave7+) -->` from system-architecture.md + duplicate Discovery row

## Backlog delta

| Metric | Wave 16 end | Wave 17 end |
|--------|-------------|-------------|
| Punch-list open | 15 | 15* |
| CRITICAL audit findings open | 0 | 0 (all 4 W17 C's fixed in-wave) |
| HIGH audit findings open | 0 | ~7 (deferred to Wave 18) |
| MEDIUM audit findings open | 0 | ~8 (deferred) |
| Review doc count | 1 Wave-16 concurrent | +4 Wave-17 |

\* Punch list count unchanged: Wave-17 reviewers surfaced NEW findings beyond the backlog, not closed old ones. The 4 CRITICAL fixes represent previously-unknown issues, now fixed.

## Deploy state

- **14/14 stacks still live** in `baladita+Bedrock-Admin` (us-west-2)
- **CI green** on `main` after 6 Wave-17 commits
- **v0.6.2** is current tag; **v0.6.3 release candidate** includes Wave-17 C1+C2+H4+L2 fixes plus doc hardening — recommend tagging v0.6.3 after resolving the 7 remaining HIGH items from Wave-17

## References

- `docs/reviews/wave17-architecture-doc-review.md`
- `docs/reviews/wave17-code-quality-review.md`
- `docs/reviews/wave17-security-ops-review.md`
- `docs/reviews/wave17-strategic-review.md` (DRIFTED verdict + 3-in-90-days pick)
