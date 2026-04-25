// ===========================================================================
// LogRetention — Log retention class helper
//
// Centralizes CloudWatch log retention policy across every stack so the
// drift between chat-stack (historically SIX_MONTHS in prod) and
// evolution-stack (ONE_MONTH) stops recurring. Every log group in
// `infra/lib/*.ts` now pulls its retention from `logRetentionFor(class, isProd)`.
//
// Classes (from docs/reviews/OPEN-PUNCH-LIST.md §infra-refactor #2):
//
//   * APP        — customer-facing request/response logs (API Gateway
//                  access logs, ECS task logs, ALB access logs, Lambda
//                  function logs serving user traffic, platform observability
//                  log stream). Prod 30 days, dev 7 days. 30 days is enough
//                  for most support incidents; longer-tail retention should
//                  flow to S3 via subscription filters (tracked separately in
//                  the same punch-list item).
//
//   * SECURITY   — audit-relevant network or WAF logs that a compliance
//                  review might want to replay. VPC flow logs, WAF logs,
//                  CloudTrail (not owned here). Prod 90 days, dev 7 days.
//                  Per the audit constraint, existing retention LONGER than
//                  90 days (e.g., VPC flow logs historically at 1 year) is
//                  NOT reduced by this helper — use `logRetentionFor('security',
//                  isProd, { prodMinimumDays })` with an explicit floor to
//                  preserve that.
//
//   * DEBUG      — high-volume, low-signal logs useful only near the time
//                  of a deploy or canary event: Step Functions execution
//                  logs, CodeBuild build logs, EventBridge debug logs,
//                  skill-pipeline SFN logs, evolution SFN logs. Prod 7 days,
//                  dev 3 days.
//
// Cost context: $0.50/GB-month at CW standard pricing; harmonizing the
// 6-month chat-stack log groups down to 30 days alone saves roughly
// $80-120/mo at current traffic (per punch-list estimate).
// ===========================================================================

import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export type LogRetentionClass = 'app' | 'security' | 'debug';

/**
 * Retention policy table. Kept exported so tests and cost reviews can
 * import the raw enum values rather than re-deriving them.
 */
export const LOG_RETENTION_BY_CLASS: Record<
  LogRetentionClass,
  { prod: RetentionDays; dev: RetentionDays }
> = {
  // App logs — keep enough for support incidents; S3 handles long-tail.
  app: { prod: RetentionDays.ONE_MONTH, dev: RetentionDays.ONE_WEEK },
  // Security / audit logs — 90-day compliance window; S3 archive beyond.
  security: { prod: RetentionDays.THREE_MONTHS, dev: RetentionDays.ONE_WEEK },
  // Debug / trace logs — short TTL, high volume.
  debug: { prod: RetentionDays.ONE_WEEK, dev: RetentionDays.THREE_DAYS },
};

export interface LogRetentionOptions {
  /**
   * If set, the returned prod retention is the MAX of the class default
   * and this floor. Used for log groups that must stay LONGER than the
   * class default for audit reasons (e.g. VPC flow logs at 1 year).
   *
   * Ignored in dev.
   */
  prodMinimumDays?: RetentionDays;
}

/**
 * Returns the CloudWatch retention for a given log class.
 *
 * Usage:
 *
 * ```ts
 * new logs.LogGroup(this, 'ApiAccessLogs', {
 *   logGroupName: `/aws/apigateway/chimera-api-${props.envName}`,
 *   retention: logRetentionFor('app', isProd),
 * });
 * ```
 *
 * With an audit floor:
 *
 * ```ts
 * retention: logRetentionFor('security', isProd, { prodMinimumDays: RetentionDays.ONE_YEAR }),
 * ```
 */
export function logRetentionFor(
  cls: LogRetentionClass,
  isProd: boolean,
  options: LogRetentionOptions = {}
): RetentionDays {
  const band = LOG_RETENTION_BY_CLASS[cls];
  if (!isProd) {
    return band.dev;
  }
  const baseline = band.prod;
  if (options.prodMinimumDays !== undefined) {
    // RetentionDays.INFINITE is encoded as 0 (not a large integer), so
    // Math.max(N, INFINITE) would return N and silently downgrade an
    // "infinite retention" floor into a finite one. Short-circuit first.
    if (options.prodMinimumDays === RetentionDays.INFINITE) {
      return RetentionDays.INFINITE;
    }
    // RetentionDays enum values for finite durations ARE the numeric day
    // counts themselves, so a numeric max yields the longer retention.
    return Math.max(baseline, options.prodMinimumDays) as RetentionDays;
  }
  return baseline;
}
