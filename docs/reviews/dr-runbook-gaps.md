# DR & Operations Runbook Gap Audit

**Audit date:** 2026-04-17
**Inventory scope:** `docs/runbooks/`
**Method:** read-only catalog + cross-reference against alarms, IaC, and security model.

## Existing runbooks inventory

| File | Status | One-line |
|------|--------|----------|
| `incident-response.md` | canonical | 629 lines — SEV1-4 definitions + failure modes F1–F10 |
| `deployment.md` | canonical | Deploy strategies, CDK stack order, rollback steps |
| `first-deployment.md` | canonical | Initial AWS setup walkthrough |
| `alarm-runbooks.md` | canonical | 11 alarms with resolution steps |
| `capacity-planning.md` | canonical | Growth projections + scaling triggers |
| `resumption-guide.md` | canonical | Post-Phase-1 state recap |

No stubs, no stale docs. The problem is **coverage**, not quality.

## Missing runbooks (prioritized)

### [CRITICAL] `ddb-pitr-restore.md`
**Why:** PITR is enabled on all 6 tables by `ChimeraTable` but no one on-call knows how to execute a restore. RTO/RPO are undefined.
**Skeleton:** pre-conditions (PITR status check); choose target timestamp (per-table vs point-in-time); `restore_table_to_point_in_time` command per table in isolation-safe order (`chimera-tenants` first so authZ works, then `chimera-audit` for forensics, then operational tables); validation queries per table (row counts, GSI sanity); GSI backfill monitoring; traffic cutover via alias swap or DNS; post-restore sanity dashboard; rollback-to-original path if restore table is corrupt. Test quarterly against a synthetic tenant.

### [CRITICAL] `security-incident-tenant-breach.md`
**Why:** We just wired WAF → CloudWatch Logs this session; Cedar audit events exist; but there is no analyst playbook.
**Skeleton:** triage questions (which tenant, what attribute of breach, when first observed); evidence-gathering order (WAF logs → CloudTrail → Cedar decision logs → `chimera-audit` table scoped to tenant); containment (revoke Cognito user tokens, pause tenant at Cedar-policy level, freeze evolution kill switch); comms template (legal + compliance notification); forensics preservation (snapshot S3 buckets with versioning, export DDB partition). 72-hour SLA for containment.

### [CRITICAL] `cdk-deploy-failure-recovery.md`
**Why:** CLI's `chimera deploy` and `chimera destroy` exist but no classification doc for "what does a CloudFormation `UPDATE_ROLLBACK_FAILED` actually mean in our topology."
**Skeleton:** failure taxonomy (synth error, transient provider throttle, drift, hard resource deletion, mid-stack IAM race); per-class recovery — rerun, manual resource patch, CloudFormation continue-rollback, manual resource deletion with `retainOnUpdate`; stack dependency order (14 stacks, which are safe to re-deploy independently); CLI commands (`chimera destroy --force` vs per-stack rollback); when to escalate to an AWS TAM.

### [HIGH] `skill-compromise-response.md`
**Why:** 7-stage skill pipeline enforces publish-time security, but an already-published skill found to be malicious has no documented pull-the-plug procedure.
**Skeleton:** detect triggers (observability alarm, user report, drift scan); immediate quarantine — flip the skill's `trust_tier` to `QUARANTINE` in `chimera-skills` (write-path must support this state — confirm in `packages/core/src/skills/registry.ts`); SSM-switch to disable new invocations platform-wide if needed; audit all past invocations via `chimera-audit` query by `skill_id`; tenant notification template; forensics on the CodeCommit commit that published the skill.

### [HIGH] `dlq-drain-procedure.md`
**Why:** DLQs exist on multiple queues in `orchestration-stack.ts` but "what to do when an alarm fires" is not written down.
**Skeleton:** pre-drain: identify which producer, why it's failing (root-cause before redrive); drain options — manual replay via AWS CLI, redrive-policy, purge (destructive); sampling strategy for large backlogs; re-enqueue with modified attributes if payload is the problem; post-drain validation; alarm-threshold tuning.

### [HIGH] `canary-rollback.md`
**Why:** `pipeline-stack.ts` references canary progression stages but no operator-facing "abort mid-canary" doc.
**Skeleton:** when to abort (SLI breach, alarm, manual call); rollback mechanics — CodeDeploy rollback, CloudFront origin swap, ECS task revision pin; per-service (chat-gateway, skill-pipeline, web frontend) specifics; post-rollback triage (gather metrics, file post-mortem).

### [MEDIUM] `agent-loop-iteration-alarm-runbook.md`
**Why:** The iteration count alarm doesn't exist yet (see cost-observability audit for the proposal). When it does, this is the response doc.
**Skeleton:** immediate triage (which tenant, which session); check whether the Phase-3 circuit breakers in `swarm_tools.py` / `evolution_tools.py` fired; manual session kill via DDB state mutation; refund path; prompt-engineering diagnosis.

### [MEDIUM] `waf-security-event-response.md`
**Why:** WAF logging just landed in `security-stack.ts`. We have the data. We don't have the response playbook.
**Skeleton:** log query templates (Athena or CloudWatch Logs Insights); common rule-trigger classifications (SQL injection attempt, rate-limit abuse, geo-blocked region); IP-block-list update procedure; false-positive tuning; report-to-legal threshold.

### [LOW / ASPIRATIONAL] `cross-region-failover.md`
**Why:** Global Tables v2 and Route53 failover are referenced in code comments (`data-stack.ts`) but not wired. Runbook is premature — list it as aspirational so future work has a target.
**Skeleton (aspirational):** health-check dashboard; failover trigger conditions; DNS TTL considerations; cross-region KMS key alignment; stateful-component gotchas (in-flight WebSocket sessions, in-progress skill pipeline runs).

## Monitoring gaps that block runbook effectiveness

| Gap | Blocks which runbook |
|-----|---------------------|
| Agent-loop iteration count metric is not emitted | agent-loop-iteration-alarm-runbook |
| Per-session cost metric absent (only monthly rollup) | tenant-breach (can't scope cost impact) |
| DLQ alarm thresholds not standardized across queues | dlq-drain-procedure |
| Bedrock throttle-rate alarm threshold undefined | incident-response SEV2 escalation |
| Cedar policy denial storm alarm missing | tenant-breach early warning |
| WAF rule-triggered metric not dashboarded | waf-security-event-response |
| Session-count anomaly alarm missing | capacity-planning real-time trigger |

## Prioritized sprint plan (2 days of on-call effort)

| Day | Runbook | Output |
|-----|---------|--------|
| 1 AM | ddb-pitr-restore.md | Written + dry-run against dev |
| 1 PM | cdk-deploy-failure-recovery.md | Written |
| 2 AM | security-incident-tenant-breach.md | Written + legal review handoff |
| 2 PM | skill-compromise-response.md + dlq-drain-procedure.md | Written |

**Quarterly thereafter:** rotate one runbook into a game day exercise.

## What makes this a short list

The existing incident-response.md is strong — it covers the generic SEV1/SEV2 structure. The missing runbooks are all *topic-specific* playbooks that the generic doc references but doesn't contain. That's a much healthier gap than "no incident response story at all," and the CRITICALs above close the highest-impact slots first.
