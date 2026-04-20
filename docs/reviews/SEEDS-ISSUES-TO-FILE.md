---
title: "Seeds Issues To File — Waves 1-10 Infra/Architecture Follow-ups"
status: action-required
date: 2026-04-17
source: docs/reviews/OPEN-PUNCH-LIST.md
owner: coordinator
---

# Seeds Issues To File

`sd` CLI was not invokable in the session that produced this file (Bash restricted).
The three `sd create` invocations below capture the biggest open infra/architecture
follow-ups identified across waves 1-10 and should be run by the next session.

Run from the repo root (`/Users/baladita/Documents/DevBox/chimera`). Each block is
self-contained; priority uses the numeric form accepted by `sd create --priority`.

After creating the three issues, commit with:

```
git add .seeds/ docs/reviews/SEEDS-ISSUES-TO-FILE.md
git commit -m "chore(seeds): file 3 open infra/architecture follow-ups

- infra: DAX SG move to NetworkStack (unblocks Wave 7 fallback removal)
- spike: AgentCore Registry multi-tenancy decision (gates Phase 2+)
- feat(obs): AgentCore Observability onboarding

Cross-linked from docs/reviews/OPEN-PUNCH-LIST.md."
git push origin main
```

---

## Issue 1 — infra-refactor: DAX SG NetworkStack move

```bash
sd create \
  --title "infra: move chat-gateway task SG ownership to NetworkStack to unblock DAX SG narrowing" \
  --priority 2 \
  --type task \
  --labels "infra,refactor,tenant-isolation" \
  --description "Per docs/reviews/infra-review.md (Finding #1) and docs/reviews/OPEN-PUNCH-LIST.md (infra-refactor #1):

DAX Security Group narrowing from the shared ECS SG to a chat-gateway-task-scoped SG cannot land without resolving a circular dependency between ChatStack (owner of the task SG) and DataStack (owner of the DAX cluster SG rule).

Resolution: move ownership of chatGatewayTaskSecurityGroup from ChatStack to NetworkStack, exported via StackProps so DataStack can consume it for DAX inbound rules without ChatStack -> DataStack -> ChatStack cycling.

Acceptance criteria:
- NetworkStack owns chatGatewayTaskSecurityGroup (exported as a prop).
- ChatStack consumes the SG via props; ECS task definitions attach it.
- DataStack DAX cluster inbound rule narrows port 8111 from the task-scoped SG only (not the shared ECS SG).
- cdk synth produces no circular dependency errors.
- bun test + bun run typecheck pass.

Effort: ~0.5-1d.

Cross-refs:
- docs/reviews/OPEN-PUNCH-LIST.md - infra-refactor #1 (DAX SG narrowing)
- docs/reviews/infra-review.md - Finding #1 DAX Security Group Overpermissioned (infra/lib/data-stack.ts:200-209)
- Related: Wave 7 fallback removal (blocked until this lands)"
```

---

## Issue 2 — spike: AgentCore Registry multi-tenancy

```bash
sd create \
  --title "spike: validate AgentCore Registry multi-tenancy model (per-tenant vs shared with scoped records)" \
  --priority 2 \
  --type research \
  --labels "spike,agentcore-registry,adr-034" \
  --description "Per ADR-034 (AgentCore Registry adoption) and docs/designs/agentcore-registry-spike.md.

This is the single spike-blocker gating Phase 2+ of the Registry migration, the 6-phase rollout plan, cost modeling, and the approval-workflow shape. Until resolved, ADR-034 stays in 'proposed' status and chimera-skills remains catalog of record.

Open questions to answer in ~1 week on a dev tenant:

1. Multi-tenancy model: is Pattern A (one shared registry, tenant-scoped records via IAM/JWT conditions) viable, or is Pattern B (one registry per tenant) required? Any cross-tenant read in Pattern A is a blocker.
2. Auth behavior: does IAM scoping prevent cross-tenant reads for SearchRegistryRecords, GetRegistryRecord, ListRegistryRecords, InvokeRegistryMcp? Does JWT (Cognito) scoping behave identically?
3. Discovery behavior: does SearchRegistryRecords return tenant-filtered results when called from a Strands client via remote MCP?
4. EventBridge schema + delivery: is tenant identity carried in the event payload? What is P99 end-to-end latency? Spike target: <30s.
5. Per-record + per-search pricing: storage cost, control-plane API cost, data-plane search cost, EventBridge event cost — broken out separately for the 5-day window and extrapolated to expected skill volume.
6. Developer ergonomics: which pattern is cleaner for tool discovery and approval workflows?
7. Dev-account quota for Pattern B (two registries). Request quota increase on Day 1 if needed.
8. GA status confirmation via AWS What's New (precondition from ADR-034 open question #3).
9. Teardown completeness: can a single resourcegroupstaggingapi sweep (Purpose=registry-spike) cleanly remove all spike resources?
10. Exit-artifact decision: promote ADR-034 to 'accepted' with Pattern A/B recommendation, OR keep it 'proposed' with documented blockers and a 'defer' recommendation.

Effort: 1 week (5 working days). Dev account only, no production code changes.

Exit artifact: docs/reviews/registry-spike-results.md

Cross-refs:
- docs/designs/agentcore-registry-spike.md (full spike proposal)
- docs/architecture/decisions/ADR-034-agentcore-registry-adoption.md
- docs/reviews/OPEN-PUNCH-LIST.md - Spike-blocked #1
- docs/reviews/wave4-registry-migration-delta.md
- docs/reviews/agent-framework-alternatives.md (original research memo)"
```

---

## Issue 3 — feat(obs): AgentCore Observability onboarding

```bash
sd create \
  --title "feat(obs): onboard AgentCore Observability (OTEL instrumentation + GenAI dashboard)" \
  --priority 3 \
  --type task \
  --labels "observability,agentcore,rabbithole-05" \
  --description "Per docs/research/agentcore-rabbithole/05-observability-evaluations-deep-dive.md and docs/reviews/cost-observability-audit.md.

Onboarding AgentCore Observability (OTEL/ADOT instrumentation + CloudWatch GenAI Observability dashboard) obsoletes roughly 40% of the custom observability work currently in observability-stack.ts (~1100 LOC) and eliminates the gap where metrics are 'defined in dashboards but never emitted' (cost-observability-audit.md identifies 8 such metrics).

Scope:
- Add aws-opentelemetry-distro to Python agent runtime (packages/agents/) and Node chat-gateway runtime alongside existing X-Ray SDK, OR switch to ADOT entirely (cleaner but ~3d of ECS task-definition churn).
- Emit OTEL GenAI semantic-convention attributes on spans: gen_ai.usage.input_tokens, gen_ai.usage.output_tokens, gen_ai.request.model, etc.
- Set OTEL_RESOURCE_ATTRIBUTES=service.name=chimera-agent,tenant.id=<id> so tenant.id attaches to every span (searchable via Transaction Search; note: not auto-promoted to metric dimensions).
- Enable X-Ray Transaction Search: aws xray update-trace-segment-destination --destination CloudWatchLogs (one-time).
- Wire CloudWatch GenAI Observability dashboard into the platform runbook and delete the overlapping widgets from observability-stack.ts (Runtime-session API GW latency, 4xx/5xx, ECS CPU/Mem).
- KEEP the Chimera-specific widgets: DDB-throttle, PITR-compliance composite alarm, Backup failure alarm, cross-region health, cost-attribution dashboard, and the 5 tenant-scoped metric emitters from the observability-emitter punch-list. Memory/Gateway/Tools metrics live in standard CloudWatch, not the GenAI dashboard.
- Keep cost-tracker.ts token accounting; OTEL token attributes supplement but do not replace it (AgentCore does not emit InputTokens/OutputTokens CloudWatch metrics).

Acceptance:
- ADOT or OTEL distro shipping with agent + chat-gateway runtimes.
- gen_ai.* attributes visible in aws/spans log group via Transaction Search.
- GenAI Observability dashboard populated with live traces.
- observability-stack.ts delta-audited: duplicated widgets removed, Chimera-specific ones retained.
- Documented in docs/runbooks/ (new observability runbook).

Effort: 1-2 weeks.

Cross-refs:
- docs/research/agentcore-rabbithole/05-observability-evaluations-deep-dive.md (Observability section)
- docs/reviews/cost-observability-audit.md (8 metrics defined-but-not-emitted)
- docs/reviews/OPEN-PUNCH-LIST.md - Strategic outlook #2 (AgentCore Observability onboarding)
- Related: observability-emitter punch-list (5 tenant-scoped metrics stay custom)"
```

---

## Notes for the session that files these

- Use numeric `--priority` (2, 2, 3) as shown; `sd create --help` accepts both `P<n>` and numeric forms, numeric is unambiguous.
- `--labels` takes a comma-separated list.
- After `sd create`, confirm IDs via `sd list --label infra` / `sd list --label spike` / `sd list --label observability`.
- Then `sd sync` (or `git add .seeds/`) and commit per the header block above.
- Delete this file only after all three issues are filed and committed — it intentionally captures the exact command bodies in case of partial failure.
