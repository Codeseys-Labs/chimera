---
title: "Wave-20 Backlog Audit"
date: 2026-04-25
source_commits: Wave 19 complete (v0.6.3 released)
wave: 20
---

# Wave-20 Backlog Audit

## Summary

- **Total open items:** 11 confirmed
- **By priority:** P0 (blocking production) = 3, P1 (post-first-deploy) = 4, P2 (deferred) = 4
- **By size:** quick-win (<1hr) = 2, medium (1-4hr) = 5, strategic (multi-day) = 4
- **All Wave-17 + Wave-18 security-ops findings:** ✅ Closed (Wave 19 completed)
- **Punch-list status:** 15 items tracked in `OPEN-PUNCH-LIST.md`; no new items from Waves 17-19

## Open Items

### P0 — Blocking Production (First Deploy Path)

1. **chimera-0092 — Verify chimera chat works end-to-end with system prompt + tools**
   - Source: ROADMAP.md §Immediate Priorities; Seeds tracker [blocked]
   - Status: blocked on first CDK deploy + staging agent validation
   - Estimated effort: 2hr (E2E verification)
   - Acceptance: `chimera chat "list my S3 buckets"` returns real AWS data with agent reasoning
   - Priority: CRITICAL (gates public beta)

2. **chimera-d123 — Re-push to CodeCommit after timeout fix + retrigger pipeline**
   - Source: Seeds tracker [High · task]
   - Status: in_progress
   - Estimated effort: 0.5hr
   - Notes: Code fix committed (c3c6585); needs ChatStack + FrontendStack redeployment to activate OAC + Bedrock model corrections

3. **Execute First CDK Deploy** (implicit from ROADMAP)
   - Source: ROADMAP.md §Immediate Priorities
   - Blocker: All 14 stacks synthesise cleanly; deployment pending
   - Estimated effort: 1hr execution + post-deploy validation
   - Command: `npx cdk deploy --all --context environment=dev`
   - Notes: See `docs/runbooks/resumption-guide.md` for exact deploy sequence; RegistryStack deferred behind `-c deployRegistry=true`

### P1 — Post First Deploy (Secondary Priorities)

4. **chimera-2087 — Create CLI E2E integration test scripts**
   - Source: ROADMAP.md §Secondary Priorities; Seeds tracker [Medium · task] [blocked]
   - Status: blocked on live environment with real tenant
   - Estimated effort: 4hr
   - Notes: Gate behind `RUN_E2E=1`; requires deployed chat-gateway + live agent

5. **chimera-b7af — Remove strands-agents.ts shim when package published**
   - Source: ROADMAP.md §Secondary Priorities; Seeds tracker [Medium · task]
   - Blocker: `strands-agents` npm package must publish first (external dependency)
   - Estimated effort: 1hr (grep + delete across ~30 call sites)
   - Impact: −370 LOC of temporary scaffolding
   - Notes: Imported by `packages/core/src/aws-tools/` and `packages/core/src/discovery/`; track alongside Gateway migration cutover

6. **chimera-bbbc — Configure Chimera agent: system prompt + AWS tools + tenant context**
   - Source: Seeds tracker [High · task]
   - Status: requires post-deploy validation with live Bedrock agent
   - Estimated effort: 2hr (system prompt tuning + tool discovery)
   - Notes: Part of E2E chat validation; may be combined with chimera-0092

7. **chimera-9035 — Add CLI integration test scripts for end-to-end validation**
   - Source: Seeds tracker [Medium · task]
   - Status: in_progress
   - Estimated effort: 3hr
   - Overlap: Likely duplicate/refinement of chimera-2087

### P2 — Deferred to Future Waves

8. **chimera-76b9 — Implement LLM-based task decomposer**
   - Source: ROADMAP.md §Deferred; OPEN-PUNCH-LIST.md cleanup #1; Seeds ready [Low · task]
   - Current: heuristic-only decomposition in `packages/core/src/swarm/task-decomposer.ts`
   - Estimated effort: 1-2d
   - Strategic value: improves multi-agent orchestration quality but not blocking MVP
   - Notes: LLM-based paths would use Claude to generate multiple decomposition variants

9. **chimera-2b2a — EventBridge scheduled recurring agent tasks**
   - Source: ROADMAP.md §Deferred; Seeds ready [Low · task]
   - Scope: Cron job agent triggering via EventBridge Scheduler
   - Estimated effort: 2d
   - Notes: Infrastructure (OrchestrationStack) exists; needs Lambda+EventBridge wiring

10. **chimera-59ee — Webhook delivery for task lifecycle events**
    - Source: ROADMAP.md §Deferred; Seeds ready [Low · task]
    - Scope: Task state-change webhooks (created, running, completed, failed)
    - Estimated effort: 1-2d
    - Notes: Pairs with event bus / Step Functions patterns

11. **chimera-606c — DGM evolution integration (composite fitness, lineage)**
    - Source: OPEN-PUNCH-LIST.md cleanup / strategic; Seeds ready [Backlog · task]
    - Scope: Deep genealogy mapping for skill/prompt variant evolution
    - Estimated effort: 3-5d (research + implementation)
    - Notes: Enhancement to `packages/core/src/evolution/experiment-runner.ts`

## Backlog Sources Reconciliation

### 1. ROADMAP.md (docs/ROADMAP.md)

**Immediate Priorities (P0):**
- Execute First CDK Deploy [items above: #3]
- Resolve Known Post-Deploy Issues (OAC + Bedrock model) [implicit in #2]
- End-to-End Chat Validation (chimera-0092) [#1]

**Secondary Priorities (P1):**
- E2E Test Scripts (chimera-2087) [#4]
- Remove Strands Shim (chimera-b7af) [#5]

**Deferred (P2):**
- LLM-Based Task Decomposer (chimera-76b9) [#8]
- EventBridge Scheduled Tasks (chimera-2b2a) [#9]
- Webhook Delivery (chimera-59ee) [#10]
- Disaster Recovery (mentioned; runbooks already completed in Wave-18)
- Chat Platform OAuth (Slack/Discord/Teams) [not in seeds; low priority]

### 2. Seeds Tracker

**Open + In Progress:** 3 items
- chimera-d123 (Re-push to CodeCommit) — in_progress [#2]
- chimera-9035 (CLI E2E integration test scripts) — in_progress [#7]
- chimera-bbbc (Configure agent system prompt) — High [#6]

**Ready:** 8 items
- chimera-2b2a (EventBridge scheduled tasks) [#9]
- chimera-59ee (Webhook delivery) [#10]
- chimera-606c (DGM evolution integration) [#11]
- chimera-982e (No NACL rules in network) [not in other sources; BACKLOG tier; low risk]
- chimera-b7af (Remove strands-agents shim) [#5]
- chimera-76b9 (LLM-based task decomposer) [#8]
- chimera-2087 (CLI E2E integration) — blocked [#4]
- chimera-0092 (E2E chat validation) — blocked [#1]

### 3. Wave Retrospectives (12-19)

**Wave 19 (completed 2026-04-25):**
- All Wave-17 security-ops findings (C-1, H-1, H-2, M-1, M-2): ✅ CLOSED
- All Wave-18 carryovers (I1, I4): ✅ CLOSED
- Wave 19 candidates for Wave 20: [sourced items #1-7 above]

**Wave 18:**
- 6 HIGH findings identified; 4 fixed in-wave; 2 carried to Wave 19 (now closed)
- Punch-list items: 15 open (unchanged by Wave-18 implementation)

**Earlier Waves (12-17):**
- All sprint-specific deferred items are now either closed or categorized in punch-list
- No unresolved "deferred to Wave N+1" items found

### 4. Wave Review Findings (HIGH/MEDIUM not addressed)

**Verified:** No open HIGH findings from previous waves; all addressed by:
- Wave-18 security ops (closed 12 tactical items)
- Wave-19 security ops (closed remaining 5 findings)

### 5. Code TODOs (grep results)

**Verified TODOs (not blocking Wave 20):**
- `TODO(rabbithole-02)`: AgentCore Memory iteration_count shape issue (3 sites in chimera_agent.py, code_interpreter_tools.py) — **architectural limitation, not Wave-20 work**
- `TODO(rabbithole-04)`: Code Interpreter API-shape fixes (code_interpreter_tools.py:99) — **staged verification, not Wave-20 critical path**
- `TODO: Remove` (strands-agents.ts): captured as #5 above
- Generic TODOs in task-decomposer.ts (lines 255, 304, 392): LLM-based variants [#8]
- Generic TODOs in skill-registry.ts: persistence implementation [punch-list cleanup #2]
- Generic TODOs in media-processor.ts: S3 download via @aws-sdk/client-s3 [non-critical]

**None are P0 blockers.**

### 6. ADRs with `status: proposed`

**Verified:** All 38 ADRs are `status: accepted` or `status: accepted (partial — Phase 0-1 only)` [ADR-034 Registry].
- ADR-034 remains `accepted (partial)` — Phase 0/1 scaffolding in place; Phase-2+ gated on 1-week spike (not Wave-20 scope)

### 7. CDK Nag Suppressions (infra/cdk-nag-suppressions.ts)

**Verified:** All suppressions are documented with design rationale. No suppressions reference "TODO", "future", "temporary", or "defer" except:
- `AwsSolutions-COG3`: "will be re-evaluated before GA launch" [non-critical, known decision]
- `AwsSolutions-SF1/SF2`: "will be enabled after observability baseline" [non-critical, post-deploy)
- **Verdict:** No backlog items surfaced.

### 8. Architecture Docs (Deferred Items)

**Verified grep results:**
- `TODO(wave7+)` in system-architecture.md: diagram update (13→14 stacks note) [doc-only, non-critical]
- `TODO(rabbithole-02)` in agent-architecture.md: `AgentCoreMemoryConfig` migration [architectural, not Wave-20]
- Various "future" references (RDS, CustomMemoryStrategy, etc.) are design options, not open issues

## Quick-Win Candidates for Wave 20

**Recommended for single working session (each <2hr):**

1. **chimera-d123 — Re-push to CodeCommit** (0.5hr)
   - Current: Already in_progress; just needs re-trigger + verification
   - Impact: Unblocks OAC + Bedrock model fixes that broke chat in Wave 19
   - Effort: 1 `git push` + pipeline run + validate ChatStack deployment
   - *Rank 1 — highest impact, minimal effort*

2. **chimera-0092 — E2E chat validation** (2hr)
   - Current: Blocked on first CDK deploy
   - Impact: Confirms end-to-end agent loop works with real AWS tools
   - Effort: Deploy infrastructure + run `chimera chat "list my S3 buckets"` + verify agent reasoning
   - *Rank 2 — critical acceptance gate, enables Wave-20 feature work*

3. **chimera-bbbc — Configure agent system prompt** (1-2hr)
   - Current: Requires post-deploy agent validation
   - Impact: Improves agent instruction clarity + tool discovery UX
   - Effort: Tune system prompt in `packages/agents/chimera_agent.py` based on E2E chat results
   - *Rank 3 — pairs with chimera-0092*

## Strategic Items Requiring Multi-Wave Investment

These should NOT be attempted in Wave 20; schedule for Wave 21+:

1. **Close the GTM loop** (multi-week)
   - Scope: Signup flow, Stripe integration, admin UI tenant/user/key/skill management
   - Blocker: Requires product/GTM decision before engineering work
   - Wave 20 suggestion: Scope & plan only (no code)

2. **AgentCore Registry multi-tenancy spike + migration** (1 week spike + 3-4 weeks implementation)
   - Scope: Resolve per-tenant vs shared registry question; implement 6-phase rollout
   - Blocker: ADR-034 open question #1; gating Phase-2+ evolution work
   - Wave 20 suggestion: Schedule spike, do NOT start implementation

3. **LLM-based task decomposer** (1-2d engineering)
   - Scope: Replace heuristic decomposition with Claude-powered multi-variant generation
   - Current: Heuristic only; works but suboptimal for complex tasks
   - Wave 20 recommendation: defer (P2 priority)

4. **EventBridge + scheduled agent tasks + webhooks** (multi-task, 2-3d total)
   - Scope: 3 interconnected features (recurring jobs, lifecycle webhooks, event routing)
   - Dependencies: Infrastructure built; wiring remains
   - Wave 20 recommendation: defer until GTM loop is scoped

## Items to Close Without Code

**These only need doc update or verbal confirmation:**

1. **Runbook completeness** (Wave 18 I4 — already closed in Wave 19)
   - Status: v0.6.3 released with alarm runbooks in `docs/runbooks/alarm-runbooks.md`
   - Action: Verify doc published; no code change needed

2. **DR runbooks** (mentioned in ROADMAP)
   - Status: Already complete (Wave-18c: 4 DR scripts + 1 new runbook)
   - Action: Link from ROADMAP to `scripts/dr/` and `docs/runbooks/cdk-deploy-failure-recovery.md`

3. **Test coverage targets** (Wave-16c completed)
   - Status: Code-coverage artifacts now emitted (`coverage-typescript-lcov` + `coverage-python-cobertura`)
   - Action: Provision Codecov token when ready; no other work needed

4. **Strands shim adoption readiness** (awaiting external npm publish)
   - Status: Waiting on `strands-agents` npm package publish
   - Action: Monitor external package; trigger Wave-20 or 21 removal once published

## Open Punch-List Items (Non-Blocking Inventory)

From `docs/reviews/OPEN-PUNCH-LIST.md`, these are tracked but not Wave-20 critical:

| Category | Count | Notes |
|----------|-------|-------|
| spike-blocked | 1 | ADR-034 Registry multi-tenancy decision (1 week spike) |
| infra-refactor | 3 | DAX SG narrowing (0.5-1d), DDB sizing (1-2d), log retention (already closed Wave-16b) |
| python-hardening | 0 | All closed in Wave-15d |
| typescript-hardening | 1 | Global `strict: true` + `any` quarantine (793 sites, 2d) |
| docs | 0 | All closed |
| ops-runbooks | 0 | All critical + high closed |
| observability-emitter | 3 | 2 verification items; 1 additional metrics from audit |
| cost-reduction | 3 | DAX monitoring, model-router verification (closed), region audit |
| cleanup | 4 | Task decomposer LLM, skill-registry persistence, workflow.ts (closed), strands-agents removal |

## Recommendation for Wave 20

**Primary track:** Execute first CDK deploy + E2E chat validation (P0 items #1-3)
- **Time commitment:** 4-6 hours end-to-end
- **Blocker removal:** Unblocks P1 work (E2E test scripts, system prompt tuning)
- **Success criteria:** `chimera chat` works with live S3 bucket listing; agent reasons correctly

**Secondary track (if time permits):** Begin scoping "close GTM loop" initiative
- **Effort:** 4-8 hours discovery + planning (no code)
- **Outcome:** Detailed spec for Wave 21 GTM work

**Do NOT start in Wave 20:**
- Registry migration spike (schedule for post-Wave-20)
- Multi-tenant features without first deployment success
- Cost optimization until after 4+ weeks of prod metrics

## References

- `docs/ROADMAP.md` — Platform roadmap (sections: Immediate Priorities, Secondary Priorities, Deferred)
- `docs/reviews/OPEN-PUNCH-LIST.md` — Living consolidated backlog (54 items across 7 waves)
- `docs/reviews/WAVE-RETROSPECTIVE-19.md` — Wave 19 completion + Wave 20 candidates
- `docs/reviews/WAVE-RETROSPECTIVE-18.md` — Wave 18 security-ops + findings
- `docs/runbooks/resumption-guide.md` — First deployment checklist
- `docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md` — Registry spike scope
