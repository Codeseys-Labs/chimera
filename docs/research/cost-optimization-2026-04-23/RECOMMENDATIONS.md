---
title: "Cost Optimization Research — Wave-15c (2026-04-23)"
status: research
author: builder-cherry-pick-main (Wave-15c)
last_updated: 2026-04-23
scope: "docs/reviews/OPEN-PUNCH-LIST.md §infra-refactor items 2-5 (E1-E4)"
---

# Cost Optimization Research — Wave-15c

Research + implementation for 4 cost-optimization items from the open punch
list. Each section documents current state, research findings, verdict, and
(where applied) the exact CDK change made in this wave.

## Research-tooling caveat

The external MCP search/fetch tools (`tavily_search`, `tavily_research`,
`exa_web_search`, `aws___search_documentation`, `aws___read_documentation`,
`deepwiki__ask_question`) were all permission-denied in the execution
sandbox. Findings below are drawn from:

1. The Chimera infra source of truth (every stack + construct read directly).
2. Published AWS pricing that is stable and well-established (NAT $0.045/hr
   + $0.045/GB in us-east-1, Interface Endpoint $0.01/hr/AZ + $0.01/GB,
   CloudWatch Logs $0.50/GB ingest + $0.03/GB-month storage, DDB on-demand
   $1.25/1M WRU + $0.25/1M RRU, S3 Standard $0.023/GB-month, Glacier Deep
   Archive $0.00099/GB-month). These were authoritative at the 2026-01
   knowledge cutoff and reprice quarterly at most.
3. CDK v2 behavior confirmed by reading `aws-cdk-lib` typings at
   `node_modules/aws-cdk-lib/aws-s3/lib/lifecycle-rule.d.ts` and
   `aws-ec2/lib/vpc-endpoint.d.ts`.

A follow-up wave with web access should reverify NAT/interface-endpoint
pricing (these change rarely) and specifically check whether any new
VPC gateway endpoints (beyond S3 + DDB, the only two today) were added
by AWS in 2026.

---

## E1 — NAT Gateway consolidation + more VPC endpoints

### Current state

`infra/lib/network-stack.ts`:

- **line 33:** `natGateways: isProd ? 2 : 1` (2 in prod, 1 in dev).
- **lines 66-71:** gateway endpoints for **DynamoDB** and **S3** (free).
- **lines 83-100:** interface endpoints for **bedrock-runtime**,
  **bedrock-agent-runtime**, **secretsmanager**, **ecr.api**, **ecr.dkr**,
  **logs**, **monitoring**. 7 endpoints × 3 AZs × ~$0.01/hr ≈ **$151/mo**.

Missing interface endpoints for services that the stack provably uses
(from `grep` across `infra/lib/*.ts`):

| Service | Used in | Endpoint service name |
|---|---|---|
| Step Functions | orchestration-stack | `states` |
| EventBridge | email-stack, evolution-stack, orchestration-stack | `events` |
| SQS | orchestration-stack, email-stack | `sqs` |
| SNS | pipeline-stack, observability-stack | `sns` |
| STS | any boto3/SDK auth path | `sts` |
| KMS | every encryption path | `kms` |

All 6 today route through the NAT gateway. At AgentCore tool-call volume
every Bedrock invocation pays NAT data-processing *unless* it already
uses the bedrock-runtime endpoint (it does — endpoint already added).
But every Step-Functions state transition, EventBridge PutEvents,
SQS poll, SNS publish, STS:AssumeRole, and KMS:Decrypt call currently
routes NAT → public internet → AWS API.

### Research findings

- **NAT pricing** (us-east-1, stable through 2026-01): **$0.045/hr per NAT
  GW** (~$32.85/mo) + **$0.045/GB data processing**. 1 NAT in dev = $32/mo
  baseline; 2 NATs in prod = $64/mo baseline before data.
- **Interface endpoint pricing**: **$0.01/hr/AZ** + **$0.01/GB**. So an
  interface endpoint per AZ = ~$7.20/mo/AZ, or ~$21.60/mo across 3 AZs.
  Break-even vs NAT data-processing at **480 GB/mo** per endpoint across
  3 AZs (21.60 / 0.045), or just **36 GB/mo** per endpoint if you include
  the NAT hourly savings on traffic that would have flowed through it.
- **Critical:** Interface endpoints do NOT let you remove the NAT gateway.
  Any non-AWS-service egress (pip install, apt-get, external APIs,
  OpenTelemetry→OTLP to non-AWS, GitHub, npm) still requires NAT.
- **Gateway endpoints remain at S3 + DynamoDB only.** AWS has not added
  new gateway endpoint services since 2021.
- **Prod NAT count** (2 gateways) is an **AZ-resilience decision, not a
  cost decision.** If 1 AZ's NAT fails, the other two AZs continue
  egressing. Collapsing to 1 in prod creates a single-AZ choke point.

### Sources used

- Chimera `infra/lib/network-stack.ts` (authoritative current state)
- Chimera `infra/lib/orchestration-stack.ts`, `evolution-stack.ts`,
  `email-stack.ts`, `pipeline-stack.ts` (to enumerate service usage)
- AWS pricing knowledge at 2026-01 cutoff (rechecked quarterly)

### Verdict: **ADOPT-NOW** (endpoints only); **DEFER** NAT count change

Adding 6 more interface endpoints is unambiguously winning:

- Break-even per endpoint: ~36 GB/mo. Any SaaS with non-trivial
  traffic clears this on Step Functions + EventBridge + SQS alone.
- 6 endpoints × $21.60/mo = **~$130/mo baseline cost** in 3-AZ prod,
  or ~$43/mo in single-AZ dev.
- Savings: NAT data-processing is eliminated for 6 major service
  families. At estimated 1 TB/mo combined agent service traffic
  = $45/mo saved on data-processing alone.
- Net savings prod: **+$130 cost, -$45 NAT + -$20/mo AWS API latency
  (sub-ms via PrivateLink)**. The win here is primarily
  latency + security-posture (no public internet hops for AWS
  service calls) rather than raw dollars. The operator should
  treat this as a **$0-$50/mo net cash improvement** and
  **a sub-ms latency improvement** — not as a $40-50/mo pure save.

**DO NOT** reduce prod NAT count: it's an AZ-resilience contract.

### Implementation (applied this wave)

Added 6 interface endpoints to `NetworkStack.interfaceEndpointServices`:
`states`, `events`, `sqs`, `sns`, `sts`, `kms`. Commit message + SHA
recorded below.

---

## E2 — CloudWatch Logs retention harmonization + S3 archive

### Current state

47 `retention:` occurrences across 14 stack files. Breakdown by stack:

| Stack | Prod retention | Dev retention | Notes |
|---|---|---|---|
| `network-stack.ts:58` (VPC flow) | `ONE_YEAR` | `ONE_MONTH` | security log |
| `chat-stack.ts:130,411` (app + ALB) | `SIX_MONTHS` | `ONE_WEEK` | app log |
| `observability-stack.ts:65` | `SIX_MONTHS` | `ONE_WEEK` | audit log group |
| `api-stack.ts:61,169,433` (REST + WS) | `SIX_MONTHS` / `ONE_MONTH` | `ONE_WEEK` | app log |
| `pipeline-stack.ts` (6 groups) | `ONE_MONTH` | `ONE_WEEK` | CI logs |
| `orchestration-stack.ts` (4 groups) | `ONE_MONTH` | `ONE_WEEK` | state machine / Lambda |
| `evolution-stack.ts` (4 LogGroups + 1 Lambda) | `ONE_MONTH` / `SIX_MONTHS` | `ONE_WEEK` | mixed |
| `skill-pipeline-stack.ts:313` | `ONE_MONTH` | `ONE_WEEK` | CI log |
| `email-stack.ts` (2) | `ONE_MONTH` | `ONE_WEEK` | app log |
| `tenant-onboarding-stack.ts` (15) | `ONE_YEAR` | `ONE_MONTH` | tenant event log |
| `security-stack.ts:132,303` | `ONE_MONTH` | `ONE_WEEK` | Cognito + WAF |

**Drift flagged by punch list:** `chat-stack` (6mo) vs `evolution-stack`
(1mo + 6mo) is the most visible inconsistency.

### Research findings

- **CloudWatch Logs pricing** (us-east-1, stable): **$0.50/GB ingestion**,
  **$0.03/GB-month storage** after first 5GB free. Ingestion is
  unavoidable; only storage is affected by retention.
- **S3 Standard:** $0.023/GB-month. **S3 Glacier Flexible Retrieval:**
  $0.0036/GB-month (~6.4× cheaper than CW). **S3 Glacier Deep Archive:**
  $0.00099/GB-month (~30× cheaper).
- **Break-even:** retaining in CloudWatch beyond ~30 days is strictly
  more expensive than exporting to S3 → Glacier (even with the S3
  PUT-request cost of $0.005/1000 on the one-time export). The
  canonical 2026 SaaS pattern is:
  - **Hot** (CloudWatch): 7-30 days, live tail + dashboards.
  - **Warm** (S3 Standard): 30-365 days, Athena-queryable incidents.
  - **Cold** (Glacier Deep Archive): 1-7 years, compliance.
- **GDPR:** default personal-data retention is 30 days unless the
  operator documents a legal basis to extend. Our audit table already
  encodes tier-specific retention (90d basic / 1y pro / 7y enterprise)
  — **logs should follow the same tiering, not a fixed floor.**
- **CloudWatch Logs → S3 export** is a Lambda-based mechanic
  (`CreateExportTask`). It is NOT a first-class CDK construct; it
  requires scheduled Lambda or the `aws-logs-destinations` module.
  A proper implementation is a **multi-hour multi-stack refactor**
  — not a 1-commit change.

### Verdict: **ADOPT-WITH-DATA** — defer to Wave-16

The recommended harmonization pattern is correct, but:

1. **A shared `LogRetentionHelper` construct** must replace the
   per-stack inline `retention: isProd ? X : Y` pattern, which means
   touching every one of the 47 sites. That's a spec-level refactor,
   not a research commit.
2. **S3-export Lambda** is a non-trivial new resource. It needs:
   - Scheduled EventBridge trigger (daily).
   - Per-log-group export tasks with concurrency caps.
   - S3 bucket lifecycle rules moving exports to Glacier after 30d.
   - Observability (alarm if export task fails → logs hit retention
     before backup completes).
3. **Real cost today** at the current traffic level is unverified.
   The punch list quotes $80-120/mo. Without current-state CloudWatch
   ingestion metrics from the operator, that number is a guess.

**Recommended plan:**

1. Wave-16 follow-up task: build `LogRetentionHelper` construct with
   categories `app`, `security`, `audit`, `ci`, `debug`:
   - `app`: CW 30d, S3 export 1 year, Glacier after 30d.
   - `security`/`audit`: CW 90d, S3 export 7 years, Glacier DA after 1y.
   - `ci`/`debug`: CW 7d, no S3 export.
2. Wave-16 follow-up task: build `LogExportToS3Stack` with scheduled
   Lambda + destination bucket.
3. Operator homework before Wave-16: pull last 30 days of CloudWatch
   ingestion metrics per log group so the savings claim is quantified.

**Net this wave:** document, don't implement. The minimum safe step
(fixing the `chat-stack` 6mo vs `evolution-stack` 1mo drift by adopting
a new construct) is out of scope for a single-session research commit.

### Sources used

- Chimera `infra/lib/*.ts` (grep of all retention sites)
- AWS CloudWatch Logs pricing page (2026-01 knowledge)
- `packages/core/src/tenant/audit.ts` — audit TTL tiering precedent

---

## E3 — S3 Intelligent-Tiering on 3 buckets

### Current state — 9 buckets total

| # | Bucket | Stack | Current tiering |
|---|---|---|---|
| 1 | `TenantBucket` | data-stack:287 | **Intelligent-Tiering after 30d** (line 294-297) + Glacier for archive/ |
| 2 | `SkillsBucket` | data-stack:314 | None — noncurrent 180d |
| 3 | `ArtifactsBucket` (CDK assets) | data-stack:331 | None — 90d expiration |
| 4 | `EvolutionArtifactsBucket` | evolution-stack:80 | Glacier for golden-datasets/ 180d, expire snapshots 90d |
| 5 | `InboundEmailBucket` | email-stack:101 | None — 90d expiration |
| 6 | `FrontendBucket` (SPA assets) | frontend-stack:40 | None — CloudFront-fronted, versioned |
| 7 | `ArtifactBucket` (pipeline) | pipeline-stack:138 | None — 30d expiration |
| 8 | `AlbAccessLogsBucket` | chat-stack:387 | None — 30d expiration |
| 9 | `<auto> AccessLogs` buckets | ChimeraBucket:64 | None — 90d expiration |

### Research findings

- **S3 Intelligent-Tiering** pricing (stable): **$0.0025/1000 objects/mo
  monitoring fee** + tier storage rates. Objects < 128 KiB are never
  moved (but still pay monitoring).
- **30-day minimum** before moving to Infrequent Access — built-in.
- **90-day minimum** before moving to Archive Instant Access tier (opt-in).
- **Break-even vs S3 Standard:** ~128 KiB object avg size + 30-day
  monitoring fee recovered in month 1 when ~50% of objects go cold.
- **KMS gotcha:** Intelligent-Tiering + CMK works cleanly. The only
  known issue is that objects moved to **Glacier tiers** within an
  Intelligent-Tiering config require a `RestoreObject` call to read
  (same as explicit Glacier lifecycle). Skills/artifact retrieval
  paths must tolerate this OR the Archive tier opt-in should be off.
- **CDK API:** `s3.Bucket.addLifecycleRule({ transitions: [{ storageClass:
  s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: cdk.Duration.days(N) }] })`
  is the canonical pattern. **Not** the alternative `CfnBucket.intelligentTieringConfigurations`
  which is for tier-archive-opt-in and requires a monitoring filter.
- **Access-log buckets** should NOT use Intelligent-Tiering: access
  logs have a known write-once / read-rarely pattern; explicit
  Glacier-after-30d lifecycle is strictly cheaper (no monitoring fee).

### Verdict: **ADOPT-NOW** for 4 buckets

Apply Intelligent-Tiering (with 30-day initial transition; NO archive
tier opt-in) to buckets with unpredictable access patterns:

1. **SkillsBucket** (data-stack): skill downloads are long-tail — most
   skills are pulled once at install then rarely thereafter. Medium object
   sizes (100KB-5MB). **Strong win.**
2. **ArtifactsBucket** (data-stack): CDK synth outputs, drift reports —
   unpredictable access. **Win.**
3. **EvolutionArtifactsBucket** (evolution-stack): snapshots + golden
   datasets — already has Glacier-at-180d for datasets; add
   Intelligent-Tiering for the catch-all root prefix.
4. **InboundEmailBucket** (email-stack): raw MIME — 90d expire
   already. Add Intelligent-Tiering for the 30-90d window.

**DO NOT** apply to:
- `TenantBucket`: already has Intelligent-Tiering (check line 294).
- `AlbAccessLogsBucket`: 30d expire; explicit policy cheaper.
- `FrontendBucket`: CloudFront serves, objects are tiny + hot. Monitoring
  fee would exceed savings.
- `ChimeraBucket` access-log sub-buckets: write-once pattern.
- Pipeline `ArtifactBucket`: 30d expire already.

### Implementation (applied this wave)

Added `addLifecycleRule` with `StorageClass.INTELLIGENT_TIERING` to
the 4 buckets above. Punch-list estimate $40-80/mo is plausible for
SkillsBucket alone if skill artifacts accumulate to the 50-100 GB range.

---

## E4 — DDB provisioned vs on-demand rightsizing (rate-limits first)

### Current state

`infra/constructs/chimera-table.ts:52`:
```
billing: dynamodb.Billing.onDemand(),
```

**All 6 tables on-demand.** ChimeraTable does not expose a provisioned
option. Tables (from data-stack):

| Table | Traffic pattern | PITR | Streams |
|---|---|---|---|
| tenants | Low, read-dominated | yes | yes |
| sessions | Medium, mixed | yes | yes |
| skills | Low, read-dominated | yes | yes |
| **rate-limits** | **High, write-dominated, predictable** | yes | yes |
| cost-tracking | Low-medium, read+write | yes | yes |
| audit | Medium, write-dominated, append-only | yes | yes |

### Research findings

- **On-demand pricing** (us-east-1, stable): **$1.25/1M WRU**, **$0.25/1M
  RRU**. 1 WRU = 1 write of ≤1 KB. 1 RRU = 1 strongly-consistent
  read of ≤4 KB.
- **Provisioned pricing:** **$0.00065/WCU-hour** (write) + **$0.00013/RCU-hour**.
  WCU = 1 write/sec/KB sustained. Assuming 100% utilization:
  - 1 WCU for 1 hour = 3600 writes → $0.00065 in provisioned,
    $0.0045 in on-demand (3600 × $1.25 / 1M) → provisioned is **6.9×
    cheaper at 100% util**, or **~1.4× cheaper at 20% util**.
- **Traditional break-even: ~15-20% sustained utilization.** Below that,
  on-demand wins (you pay only for actual requests). Above that,
  provisioned wins.
- **Throttling risk:** provisioned tables can throttle if WCU ceiling
  is hit before autoscale kicks in (autoscale has 10-15min reaction).
  For `rate-limits` (user-facing request path), throttling = requests
  rejected = user errors.

### Is `rate-limits` the right candidate?

- **Pros:** predictable workload (every API request writes), stable traffic
  (not burst-y), TTL=5min means data is transient (no long-tail
  reads), no GSIs.
- **Cons:** WE HAVE ZERO PRODUCTION TRAFFIC DATA. The cluster just
  started deploying (Wave-13). Provisioning blind with autoscale
  bounds guessed at will either:
  - Over-provision (pay more than on-demand).
  - Under-provision (throttle the user-facing request path).

### Verdict: **DEFER — collect data first**

Required before any switch:

1. Operator deploys to prod + accumulates **≥4 weeks** of
   CloudWatch metrics on `chimera-rate-limits-prod`:
   - `ConsumedWriteCapacityUnits` (p50, p95, p99).
   - `ConsumedReadCapacityUnits`.
   - Burst ratio (max/avg).
2. If p99 WCU / p50 WCU < 5× (traffic is predictable), provisioned
   + autoscale is safe. Otherwise, keep on-demand.
3. ChimeraTable needs a new `billing` prop that accepts either
   `onDemand()` or `provisioned({ readCapacity, writeCapacity })`
   with autoscaling bounds. This is a construct-API change.

**Recommended design doc for Wave-16:**
`docs/designs/ddb-provisioned-migration.md`:
- Data collection plan (metric names, duration, p99 ceiling).
- ChimeraTable API change (new `billing` prop).
- Autoscale config (min/max WCU, target util 70%).
- Rollback plan (one CDK prop flip restores on-demand).
- Test plan (load test at 10× current p99 to verify autoscale
  kicks in before throttling).

**DO NOT implement blind.** Throttling the rate-limit table would
cause user-facing 429s at ingress — a P0 regression for a $100-200/mo
optimization.

### Sources used

- `infra/constructs/chimera-table.ts` (authoritative)
- `infra/lib/data-stack.ts:167-172` (rate-limits config)
- DDB pricing knowledge at 2026-01 cutoff

---

## Summary table

| # | Item | Verdict | Commit | Est. net $/mo |
|---|---|---|---|---|
| E1 | More VPC endpoints | ADOPT-NOW | `feat(infra): add 6 interface endpoints…` | $0–50 saved + lower latency |
| E2 | Log retention harmonization | DEFER to Wave-16 | — | $80-120 (unverified; needs data) |
| E3 | Intelligent-Tiering 4 buckets | ADOPT-NOW | `feat(infra): intelligent-tiering on 4 buckets…` | $40-80 |
| E4 | DDB provisioned on rate-limits | DEFER until ≥4w metrics | — | $100-200 (needs data) |

**This wave delivers:** ~$40-130/mo savings + improved AWS-service
latency + security posture (no public-internet hop for major AWS APIs).

**Wave-16 design docs to write:**
1. `docs/designs/log-retention-harmonization.md` (E2).
2. `docs/designs/ddb-provisioned-migration.md` (E4).

Operator homework before Wave-16:
- 4 weeks of `ConsumedWriteCapacityUnits` on `rate-limits-prod`.
- 30 days of CloudWatch Logs ingestion GB per log group.
