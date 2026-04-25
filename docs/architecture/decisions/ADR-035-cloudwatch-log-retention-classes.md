---
title: 'ADR-035: CloudWatch Log Retention Classes'
status: accepted
date: 2026-04-24
decision_makers: [chimera-architecture-team]
---

# ADR-035: CloudWatch Log Retention Classes

## Status

**Accepted** (2026-04-24)

## Context

Before Wave-16b, every CDK stack picked its own `retention:` value on each `LogGroup`. The result was drift: `chat-stack.ts` used `RetentionDays.SIX_MONTHS` for ECS logs while `evolution-stack.ts` used `RetentionDays.ONE_MONTH` for Step Functions logs, with no principle distinguishing the two. The Wave-16b reviewer audit (`docs/reviews/OPEN-PUNCH-LIST.md` §infra-refactor #2) enumerated 24 `LogGroup` sites across 10 stacks, found seven distinct retention values in use, and flagged the following costs:

1. **Compliance opacity.** Answering "for which log classes do we retain 90 days?" required grepping every stack.
2. **Drift over time.** Every new `LogGroup` hard-codes a retention, and reviewers cannot tell whether the value was chosen deliberately or copied from the nearest example.
3. **Cost noise.** The 6-month chat-stack log groups alone were an estimated $80–120/mo in CloudWatch standard pricing that no one had re-examined.

Logs are not all equal. Customer request logs (support window: days), security/audit logs (compliance window: 90 days), and deploy-time debug logs (useful window: hours to days) have different value curves and should pay different storage bills.

## Decision

Centralize retention in a single helper, `infra/constructs/log-retention.ts`, that maps three log **classes** to prod/dev retention bands:

| Class | Prod | Dev | Use for |
|-------|------|-----|---------|
| `app` | 30 days | 7 days | API Gateway access logs, ECS task logs, ALB access logs, user-facing Lambda logs, platform observability streams |
| `security` | 90 days | 7 days | VPC flow logs, WAF logs, audit-relevant network logs |
| `debug` | 7 days | 3 days | Step Functions execution logs, CodeBuild build logs, EventBridge debug streams |

Every `LogGroup` in `infra/lib/*.ts` gets its retention from `logRetentionFor(class, isProd)`. Log groups that must retain longer than the class default for audit reasons (e.g., VPC flow logs historically at 1 year) pass `{ prodMinimumDays: RetentionDays.ONE_YEAR }` — the helper takes the max, never reduces. New `LogGroup` instances must pick a class; there is no default.

**Commit reference:** `247e110` introduced the helper plus unit tests; `5f7c218` applied it across 10 stacks (`chat`, `email`, `evolution`, `network`, `observability`, `orchestration`, `pipeline`, `security`, `skill-pipeline`, and follow-up application to `api-stack`).

## Alternatives Considered

### Alternative 1: Per-stack retention constants

Each stack file declares a local `RETENTION` constant and uses it internally.

**Cons:** Does not prevent drift between stacks — that is the problem we are fixing. Rejected.

### Alternative 2: Per-log-group explicit values with a convention doc

Rely on reviewer discipline and a `CONVENTIONS.md` entry.

**Cons:** Conventions documented in prose are not enforced in CI. Rejected.

### Alternative 3: AWS Control Tower / Config policy for retention

Enforce retention at the organization level outside CDK.

**Cons:** (a) Chimera deploys into existing AWS accounts that may already carry Control Tower rules outside our control, (b) deploy-time indirection makes local `cdk synth` diverge from deployed behavior. Rejected.

### Alternative 4: Environment-variable-driven retention

Read retention from env vars at synth time.

**Cons:** Loses type safety, loses the ability to diff retention changes in a CDK snapshot test. Rejected.

### Alternative 5: Class-based helper with compile-time constants (Selected)

`logRetentionFor('app', isProd)` — type-safe, testable, no deploy-time indirection, one source of truth for the class→value map.

**Verdict:** Selected.

## Consequences

### Positive

- **Single source of truth.** Changing retention for every app log group across the platform is a one-line edit to `LOG_RETENTION_BY_CLASS`.
- **Type-safe classes.** `LogRetentionClass` is a union type — typos fail at `tsc` time.
- **Testable.** `infra/test/constructs/log-retention.test.ts` asserts the mapping; stack snapshot tests validate each `LogGroup` emits the expected retention.
- **Compliance auditability.** Answering "how long do we retain security logs in prod?" is a single file read.

### Negative

- **New `LogGroup` instances must pick a class** — this is intentional but adds a small friction for developers who would otherwise copy an ad-hoc value.
- **Not all log groups are owned by CDK.** AWS Config, CloudTrail, and Bedrock service logs create their own log groups outside this helper; they remain governed by service defaults or separate org-level policy.

## Evidence

- **`docs/reviews/OPEN-PUNCH-LIST.md` §infra-refactor #2** — the audit finding that enumerated the 24 drifting call sites.
- **`infra/constructs/log-retention.ts`** — helper implementation and documented class→value map.
- **`infra/test/constructs/log-retention.test.ts`** — 73-line test suite asserting the mapping and the `prodMinimumDays` floor behavior.
- **Commit `247e110`** — helper introduction.
- **Commit `5f7c218`** — application across 10 stacks (16 files, +182/−55 LOC).

## Related Decisions

- **ADR-026** (L3 construct library) — `log-retention.ts` lives alongside the L3 construct library and follows the same "convention in code, not prose" principle.
- **ADR-039** (EMF as canonical metric emission pattern) — EMF-emitted metrics are durable only for the log group's retention window, so picking a retention class is now a metric-durability decision too.

## References

1. CloudWatch Logs pricing: <https://aws.amazon.com/cloudwatch/pricing/>
2. `RetentionDays` enum: <https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_logs.RetentionDays.html>
3. Wave-16b audit: `docs/reviews/OPEN-PUNCH-LIST.md` §infra-refactor #2
4. Helper implementation: `infra/constructs/log-retention.ts`
5. Introduction commit: `247e110`
6. Rollout commit: `5f7c218`
