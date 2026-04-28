---
title: "EventBridge Scheduled Recurring Agent Tasks"
issue: chimera-2b2a
status: proposed
date: 2026-04-26
author: architect-agent
related_adrs:
  - docs/architecture/decisions/ADR-021 (CDK best practices)
  - docs/architecture/decisions/ADR-033 (tenant isolation)
---

# chimera-2b2a: EventBridge Scheduled Recurring Agent Tasks

## Summary

Add a recurring-task scheduler to AWS Chimera so tenants can configure agent
prompts to fire on rate or cron expressions without a live HTTP connection.
The design uses **EventBridge Scheduler → Lambda proxy → chat-gateway POST
/chat/stream**, storing schedule metadata in a new `chimera-schedules`
DynamoDB table managed via new REST routes mounted on the existing Hono
server.

## 1. Architecture Diagram

```
Tenant Admin (Cognito JWT)
       |
       | POST /tenants/{tenantId}/schedules
       v
Chat-Gateway (Hono / ECS Fargate)
  ├── Cedar: Schedule::Create
  ├── PUT chimera-schedules (DDB) [PK=TENANT#{id}, SK=SCHEDULE#{id}]
  └── scheduler.createSchedule(...)           [AWS SDK: EventBridge Scheduler]
            |  rate(1 day) or cron(0 9 * * ? *)
            v
  EventBridge Scheduler
  Group: chimera-agent-schedules-{env}
  Target: Lambda chimera-schedule-dispatcher-{env}
  Input: { scheduleId, tenantId, <aws.scheduler.scheduled-time> }
  Retry: maxAttempts=3, maxEventAge=1h
  DLQ: chimera-schedule-dlq-{env}
            |
            | Lambda::InvokeFunction
            v
  chimera-schedule-dispatcher Lambda
  ├── GetItem chimera-schedules[TENANT#{tenantId}#SCHEDULE#{scheduleId}]
  ├── Assert item.tenantId == event.tenantId  [cross-tenant forgery check]
  ├── Assert item.enabled == true
  ├── Assert tenant status == ACTIVE          [GetItem chimera-tenants]
  └── POST http://{ALB_INTERNAL_DNS}/chat/stream
        Headers: X-Schedule-Token: {HMAC}
        Body:    { messages:[...], sessionId, agentId }
            |
            v
  Chat-Gateway /chat/stream
  ├── authenticateScheduleToken()  [HMAC → tenantId context]
  └── ChimeraAgent.stream()
            |
            └─► sessions persistence + SCHEDRUN# run log
```

The dispatcher Lambda is the security chokepoint: it re-reads the schedule
at execution time, verifying `tenantId` matches, `enabled=true`, and tenant
status is ACTIVE.

## 2. AWS Service Selection

### EventBridge Scheduler (chosen) vs EventBridge Rules

| Dimension                 | Scheduler            | Rules               |
|---------------------------|----------------------|---------------------|
| Per-schedule payload      | ✅                    | ❌                   |
| One-time `at(...)`        | ✅                    | ❌                   |
| DLQ for failed targets    | ✅                    | ❌                   |
| Retry policy              | ✅ configurable       | ❌                   |
| IANA timezone             | ✅                    | ❌                   |

OrchestrationStack already provisions a `CfnScheduleGroup` + `schedulerRole`
at `infra/lib/orchestration-stack.ts:210-226`. This feature builds on that.

### Lambda Proxy (chosen) vs API Gateway vs ECS RunTask

Lambda proxy is preferred because:
- Chat-gateway invocation path stays identical to human-driven chat.
- Lambda can pre-check `enabled`/tenant status before any agent work starts.
- No Cognito JWT management for schedules (HMAC token instead).
- Cold start (~100-300ms) is acceptable for scheduled tasks.

### Internal HMAC Auth

The dispatcher signs: `HMAC-SHA256(SCHEDULE_SIGNING_KEY, "{tenantId}:{scheduleId}:{unixTs}")`
with a 5-minute replay window. Key lives in Secrets Manager with quarterly
rotation.

## 3. Data Model

### New Table: `chimera-schedules-{env}` via `ChimeraTable` L3 construct

```
PK: TENANT#{tenantId}
SK: SCHEDULE#{scheduleId}

Attributes:
  tenantId, scheduleId, name, description
  expression (rate/cron/at), timezone, enabled
  agentId, prompt, sessionId (null = new session per run)
  flexWindow, maxRetries
  createdBy, createdAt, updatedAt
  lastRunAt, lastRunStatus
  schedulerArn

GSI1 (list-by-tenant):
  GSI1PK = tenantId, GSI1SK = createdAt
  -- ALWAYS include FilterExpression='tenantId = :tid'

GSI2 (list-by-expression-type):
  GSI2PK = tenantId + "#" + expressionType
  GSI2SK = scheduleId
```

### Run Log in `chimera-sessions`

Uses existing sessions table with SK prefix `SCHEDRUN#`:

```
PK: TENANT#{tenantId}
SK: SCHEDRUN#{scheduleId}#{runId}

runId, scheduledTime, attemptNumber
startedAt, completedAt, status (RUNNING|SUCCESS|FAILED|SKIPPED)
errorMessage?, sessionId, ttl (30 days)
```

## 4. CDK Changes

### Modified Files

**`infra/lib/orchestration-stack.ts`**
1. Add `ChimeraTable` for `chimera-schedules-{env}` with GSI1/GSI2.
2. Add `ChimeraLambda` `chimera-schedule-dispatcher-{env}` (Python 3.12, 15-min timeout, 512MB).
3. Extend `schedulerRole` with `lambda:InvokeFunction` on dispatcher ARN.
4. Replace unused `events:PutEvents` statement on schedulerRole.
5. Add DLQ + CloudWatch alarm on `ApproximateNumberOfMessagesVisible > 5`.
6. Export `schedulesTableArn`, `schedulerDispatcherArn` as CfnOutputs.

**`infra/lib/chat-stack.ts`**
Add task role IAM statements:
- `dynamodb:GetItem,PutItem,UpdateItem,Query` on `chimera-schedules-*`
- `scheduler:CreateSchedule,UpdateSchedule,DeleteSchedule,GetSchedule,ListSchedules`
- `iam:PassRole` for schedulerRole (conditioned on `iam:PassedToService == scheduler.amazonaws.com`)
- `secretsmanager:GetSecretValue` on the signing key secret ARN

**`infra/bin/chimera.ts`**
Wire new props; add `chatStack.addDependency(orchestrationStack)`.

### New Files

- `infra/lambdas/schedule-dispatcher/index.py` (~275 LOC): guards + HMAC + SSE drain + run log write.
- `packages/chat-gateway/src/routes/schedules.ts`: Hono router with 5 routes.
- `packages/chat-gateway/src/middleware/schedule-token.ts`: HMAC validator.
- `packages/core/src/scheduling/schedule-service.ts`: DDB + EB Scheduler SDK wrapper.

## 5. IAM + Cedar

### Scheduler Role (existing, extended)

```typescript
schedulerRole.addToPolicy(new iam.PolicyStatement({
  actions: ['lambda:InvokeFunction'],
  resources: [dispatcherFn.functionArn],
}));
```

### Cedar Policies (append to `DEFAULT_POLICIES`)

Four new policies covering `Schedule::Create/Read/Update/Delete` with tenant
isolation and explicit cross-tenant forbid:

```typescript
{
  id: 'schedule-cross-tenant-deny',
  effect: 'forbid',
  action: ['Schedule::Create', 'Schedule::Update', 'Schedule::Delete'],
  resource: 'Schedule::*',
  conditions: ['context.tenantId != resource.tenantId'],
}
```

## 6. API Surface

Mounted under `/tenants/:tenantId/schedules` in `server.ts` with existing
`authenticateJWT` + `extractTenantContext` middleware.

| Method | Path                                          | Purpose                             |
|--------|-----------------------------------------------|-------------------------------------|
| POST   | `/tenants/:t/schedules`                       | Create                              |
| GET    | `/tenants/:t/schedules`                       | List (paginated, GSI1 query)        |
| GET    | `/tenants/:t/schedules/:id`                   | Get single                          |
| PATCH  | `/tenants/:t/schedules/:id`                   | Update (enabled/expression/prompt)  |
| DELETE | `/tenants/:t/schedules/:id`                   | Delete (EB first, then DDB)         |
| GET    | `/tenants/:t/schedules/:id/runs`              | Run history from sessions table     |

### POST /tenants/:tenantId/schedules Request

```json
{
  "name": "Daily standup summary",
  "expression": "cron(0 9 * * ? *)",
  "timezone": "America/New_York",
  "prompt": "Summarize Jira tickets opened in the past 24h.",
  "agentId": "jira-agent",
  "sessionId": null,
  "flexWindowMinutes": 5,
  "maxRetries": 3
}
```

All GSI queries **must** include `FilterExpression='tenantId = :tid'`
(CLAUDE.md GSI anti-pattern guard).

## 7. Test Scenarios

1. **Unit**: `ScheduleService.validateExpression` — `rate(30 seconds)` fails, `rate(1 minute)` passes, past `at()` fails.
2. **Unit**: Dispatcher raises `TenantMismatchError` when event.tenantId != DDB.tenantId.
3. **Unit**: Cedar `schedule-cross-tenant-deny` returns Deny for cross-tenant Update.
4. **Integration**: Create → invoke dispatcher → assert chat-gateway called, run log written.
5. **Integration**: `enabled=false` → dispatcher writes SKIPPED run log, no chat-gateway call.

## 8. Phased Implementation Plan

### Day 1 — Infra + dispatcher

- [ ] `chimera-schedules` table in OrchestrationStack.
- [ ] Signing-key Secrets Manager secret (rotation policy).
- [ ] Dispatcher Lambda with guards + HMAC + SSE drain + run log.
- [ ] Extend schedulerRole.
- [ ] DLQ + alarm.
- [ ] ECS task role IAM grants.
- [ ] Tests 1, 2.
- [ ] `bun test && npx cdk synth` green.

### Day 2 — API + Cedar + integration

- [ ] `schedule-service.ts` (CRUD + EB Scheduler SDK).
- [ ] `schedule-token.ts` middleware.
- [ ] `schedules.ts` routes (5 endpoints).
- [ ] Mount in server.ts.
- [ ] Add 4 Cedar policies.
- [ ] Tests 3, 4, 5.
- [ ] `bun test && bun run lint && bun run typecheck` green.

## 9. Open Questions and Recommendations

### Expression minimum interval
Enforce 1-minute server-side minimum; cap at 1 concurrent execution per
schedule via DDB conditional update on `lastRunStatus = RUNNING`.

### Concurrent execution prevention
DDB `ConditionExpression`:
`attribute_not_exists(lastRunStatus) OR lastRunStatus <> :running`
If the condition fails, write a `SKIPPED` run log and return 200 to
EventBridge (avoid spurious DLQ delivery).

### Tier-based quotas
- `basic`: 5, `advanced`: 25, `enterprise`/`premium`: 100 schedules.
- Enforce in `ScheduleService.createSchedule()` before write.

### Session mode
- **Stateless** (`sessionId=null`): new session per run. Use for independent summaries.
- **Persistent** (fixed `sessionId`): agent accumulates context across runs.

### ActionAfterCompletion
Set `DELETE` on `at(...)` one-time schedules to avoid accumulating against
the 10M account quota.

### Observability
Metric filters on dispatcher logs:
- `schedule_dispatch_success_count`, `_failure_count`, `_skipped_count`
Dashboard widget for per-tenant execution rate.

---

## Addendum (Wave-32 Phase-6 review): security + correctness amendments

The design above was reviewed during Wave-32 build. Seven findings (4 CRITICAL, 6 HIGH, 3 MED) were resolved by the following mandatory amendments. Implementation MUST follow this section where it conflicts with earlier text.

### CRITICAL-1: dispatcher tenantId derivation

EB Scheduler `Input` must NOT carry `tenantId`. The dispatcher Lambda derives tenantId from `aws.scheduler.schedule-arn` context attribute (format `arn:aws:scheduler:*:*:schedule/chimera-agent-schedules-{env}/{tenantId}#{scheduleId}`), parses the name portion after the last `/`, splits on `#`. Cross-tenant forgery is impossible because the arn is provided by AWS, not the Input.

The DDB GetItem key uses this parsed tenantId, and the post-fetch assert (`item.tenantId == parsed`) is now non-tautological.

### CRITICAL-3: schedule-name tenant prefix

`scheduler.CreateScheduleCommand.Name` = `{tenantId}#{scheduleId}` to enforce global uniqueness within the `chimera-agent-schedules-{env}` group. DDB key remains `(TENANT#{tenantId}, SCHEDULE#{scheduleId})` — the prefix is only at the EB Scheduler layer.

### CRITICAL-5: HMAC binds body-hash

Signing payload = `{tenantId}:{scheduleId}:{unixTs}:{sha256_hex(body)}`.

Dispatcher (Python) computes `hashlib.sha256(body.encode()).hexdigest()` before calling HMAC. Middleware (TypeScript) buffers the request body and computes `crypto.createHash('sha256').update(body).digest('hex')` before verifying HMAC. 5-min timestamp tolerance preserved.

Without body-hash binding, a captured token replays arbitrary bodies within the 5-min window under the victim tenant's context — unacceptable.

### CRITICAL-2: Cedar `Schedule::Read` cross-tenant deny

Add a fifth Cedar policy (originally §5 only covered Create/Update/Delete):

```typescript
{
  id: 'schedule-read-cross-tenant-deny',
  effect: 'forbid',
  principal: 'User::*',
  action: 'Schedule::Read',
  resource: 'Schedule::*',
  conditions: ['context.tenantId != resource.tenantId'],
}
```

### HIGH amendments

- **Expression validation**: reject `rate(N second)` — EB Scheduler doesn't guarantee sub-minute fire precision. Minimum accepted rate is `rate(1 minute)`. Document the ~60s variance on `rate(1 minute)` in API response.
- **Stuck-RUNNING recovery**: DDB skip condition becomes `attribute_not_exists(lastRunStatus) OR lastRunStatus <> :running OR lastRunStartedAt < :fifteen_min_ago`. New attribute `lastRunStartedAt` (ISO) on every RUN start. Prevents permanent SKIP on Lambda crash.
- **ALB discovery**: dispatcher Lambda is VPC-attached (ALB is private-subnet). Env var `CHAT_GATEWAY_ALB_DNS` populated from CDK output. Document ~1s ENI cold-start (correcting §2's "100-300ms" claim).
- **SSE packaging**: dispatcher uses `urllib3` only (bundled with Python 3.12 Lambda runtime — no layer). Manual SSE parsing: stream is complete on HTTP close OR `data: [DONE]` sentinel (matches AI SDK v5 wire format).
- **schedulerArn clarification**: the DDB-stored `schedulerArn` is the full EB Scheduler arn, not the name. Schedule-service composes arns from known pieces on delete/update.

### MED amendments

- **`expressionType` attribute**: new DDB attribute, derived at create-time via regex prefix (`rate(`/`cron(`/`at(`). Populates GSI2PK = `${tenantId}#${expressionType}`.
- **timezone persistence**: set `ScheduleExpressionTimezone` on `CfnSchedule` AND store in DDB. Not just DDB.
- **List pagination**: `GET /tenants/:tenantId/schedules` and `GET /tenants/:tenantId/schedules/:id/runs` accept `limit` (default 20, max 100) and `nextToken` (opaque base64 of DDB `LastEvaluatedKey`).
- **Idempotency**: EB Scheduler retries (maxAttempts=3) can double-charge tokens if the first attempt completed partial agent work. Dispatcher writes `runId = aws.scheduler.execution-id` to DDB with `attribute_not_exists(SK)` condition — duplicate execution-id = 200 OK, no-op (idempotent).
- **Signing key rotation**: dual-key verify window. Middleware tries HMAC with current key first, then previous key (15-minute overlap during rotation).

