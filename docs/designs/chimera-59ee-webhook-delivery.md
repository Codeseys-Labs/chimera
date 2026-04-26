---
title: "Webhook Delivery for Task Lifecycle Events"
issue: chimera-59ee
status: proposed
date: 2026-04-26
author: architect-agent
related_issues:
  - chimera-59ee
  - chimera-2b2a
---

# chimera-59ee: Webhook Delivery for Task Lifecycle Events

## Summary

Enable multi-tenant webhook subscriptions so external systems receive
HTTP POST callbacks when Chimera agent lifecycle events occur. Uses
**EventBridge rule → SQS standard queue → Lambda webhook sender** with
Stripe-style HMAC-SHA256 signing and per-subscription signing secrets in
Secrets Manager.

## 1. Architecture

```
chimera.agents EventBus
        │
        ▼  (EventBridge rule: source=chimera.agents)
chimera-webhook-delivery-{env}  [SQS, KMS, DLQ]
        │  (SQS event source, batchSize=1, reportBatchItemFailures=true)
        ▼
WebhookSenderFunction  [ChimeraLambda, Node 20.x]
        │
        ├─► HTTPS POST to tenant endpoint
        │       │ 2xx success  → delete message
        │       │ 4xx (non-429) → log + drop
        │       │ 5xx/429/timeout → throw → SQS retry (visibility backoff)
        │
        ▼  after maxReceiveCount=5
chimera-webhook-delivery-{env}-dlq  [CloudWatch alarm on > 5 msgs]
```

### Retry Ladder

| Attempt | Delay | Cumulative |
|---------|-------|------------|
| 1       | 0     | 0          |
| 2       | 30s   | 30s        |
| 3       | 5m    | ~5.5m      |
| 4       | 30m   | ~35.5m     |
| 5       | 2h    | ~2.5h      |
| → DLQ   |       |            |

### Why SQS buffer (not direct Lambda / not Step Functions)

- EventBridge → Lambda direct only retries on Lambda execution failures, not on
  app-level HTTP failures.
- Step Functions costs $0.025/1K state transitions — at 100K webhooks/day the
  SFN overhead is $2.50/day vs $0 for SQS.
- The existing `swarmTaskRule → agentTaskQueue` pattern in OrchestrationStack
  is the same shape.

## 2. Event Schema

### Envelope (all events)

```json
{
  "webhookId":      "wh_01J9X3KQVP...",
  "subscriptionId": "sub_01J9X3...",
  "tenantId":       "tenant42",
  "eventType":      "agent.task.completed",
  "timestamp":      "2026-04-26T14:32:11.847Z",
  "sequenceNumber": 42,
  "payload":        { ... }
}
```

### Subscribable Event Types

| Webhook `eventType`        | Source                                  |
|----------------------------|-----------------------------------------|
| `agent.task.started`       | EventBridge `Agent Task Started`        |
| `agent.task.completed`     | EventBridge `Agent Task Completed`      |
| `agent.task.failed`        | EventBridge `Agent Task Failed`         |
| `agent.error`              | EventBridge `Agent Error`               |
| `agent.message.start`      | chat-gateway SSE start (OQ-1)           |
| `agent.message.finish`     | chat-gateway SSE finish (OQ-1)          |
| `agent.tool.invoked`       | chat-gateway SSE tool-output-available  |
| `agent.swarm.created`      | EventBridge `Swarm Task Created`        |
| `agent.background.started` | EventBridge `Background Task Started`   |

## 3. DynamoDB Schema

New 7th table: `chimera-webhook-subscriptions-{env}`.

```
PK: TENANT#{tenantId}
SK: SUB#{subscriptionId}

Attributes:
  tenantId         (S, denormalized for FilterExpression)
  subscriptionId   (S, ULID)
  url              (S, HTTPS only, SSRF-validated)
  events           (SS, e.g. {"agent.task.completed"} or {"*"})
  secretArn        (S, Secrets Manager ARN — plaintext NEVER in DDB)
  enabled          (BOOL)
  createdAt, updatedAt (S, ISO-8601)
  deliveryConfig   (M, { timeoutMs, maxRetries })
  metadata         (M, tenant-supplied free-form)

GSI1-eventType (future admin: "find all subs watching X"):
  PK: eventType, SK: tenantId
```

## 4. HMAC Signing (Stripe-Style)

Headers on every delivery POST:

```
Chimera-Signature: t=1714140731,v1=<hex-hmac>
Chimera-Webhook-Id: wh_01J9X...
Chimera-Timestamp: 1714140731
```

Signed payload:
```
signed_payload = timestamp + "." + body
hmac = HMAC-SHA256(secret, signed_payload)
```

Consumer verification uses `crypto.timingSafeEqual` and a 5-minute tolerance
window on `Chimera-Timestamp` to prevent replay attacks.

### Rotation via Secrets Manager Staging Labels

Rotate via `AWSCURRENT` → `AWSPREVIOUS` overlap. Sender Lambda tries
`AWSCURRENT` first, falls back to `AWSPREVIOUS` for 24-hour grace period.
Never uses `Secret.secretValue.unsafeUnwrap()`.

## 5. CDK Changes

### New Stack: `infra/lib/webhook-stack.ts`

- `WebhookSenderFunction` via `ChimeraLambda` (Node 20.x, 256MB, 30s timeout, reserved concurrency 20).
- `SqsEventSourceMapping` with `batchSize=1`, `reportBatchItemFailures=true`.
- IAM: `dynamodb:Query` on subs table, `secretsmanager:GetSecretValue` on `chimera/webhook/*`, `sqs:ChangeMessageVisibility`.
- CloudWatch alarms: DLQ depth > 5, Lambda errors > 10/5min, p99 duration > 20s.

### Modified Files

- `infra/lib/data-stack.ts`: add `webhookSubscriptionsTable` via `ChimeraTable`.
- `infra/lib/orchestration-stack.ts`: add `webhookDeliveryQueue` + `webhookFanoutRule` (matches all `chimera.agents` events).
- `infra/lib/api-stack.ts`: add `/v1/webhooks` REST resource + CRUD Lambda integrations.

### New Package: `packages/webhook-sender/`

```
src/index.ts          # SQS Lambda handler
src/sender.ts         # delivery logic with 4xx-drop / 5xx-throw
src/signing.ts        # HMAC-SHA256 signing
src/ssrf-guard.ts     # blocks RFC-1918, loopback, link-local, 169.254.169.254
src/secrets-cache.ts  # 15-min TTL cache over Secrets Manager
src/subscriptions.ts  # DDB query with FilterExpression='tenantId = :tid'
```

## 6. API Surface

Under `/v1/webhooks` in ApiStack with Cognito JWT authorizer.

| Method | Path                                     | Purpose                        |
|--------|------------------------------------------|--------------------------------|
| POST   | `/v1/webhooks`                           | Create (returns `signingSecret` once) |
| GET    | `/v1/webhooks`                           | List tenant's subscriptions    |
| GET    | `/v1/webhooks/{subId}`                   | Get details (no secret)        |
| PUT    | `/v1/webhooks/{subId}`                   | Update                         |
| DELETE | `/v1/webhooks/{subId}`                   | Delete (removes Secrets Manager secret) |
| POST   | `/v1/webhooks/{subId}/rotate-secret`     | Rotate + return new plaintext once |
| POST   | `/v1/webhooks/{subId}/test`              | Send synthetic `agent.task.completed` |

### Tenant Isolation (3-layer)

1. `tenantId` from Cognito JWT claim, **never** request body.
2. Cedar `Schedule::Create` → `CreateWebhookSubscription` action per-tenant.
3. Delivery Lambda DDB query always includes `FilterExpression='tenantId = :tid'`.
4. IAM condition on `secretsmanager:GetSecretValue`: `StringLike: chimera/webhook/{tenantId}/*`.

## 7. Security Controls

- **HTTPS enforcement** at subscription create + delivery time.
- **SSRF guard** blocks RFC-1918, loopback, link-local, 169.254.169.254 EC2 metadata, `localhost`. Recheck via DNS resolution at delivery time (Day 2 enhancement).
- **Per-subscription signing secrets** in Secrets Manager (one secret per subscription).
- **Rate limit**: 60 deliveries/min per subscription (module-level token bucket).
- **Replay prevention**: 5-minute tolerance window on signed timestamp.
- **Subscription cap**: 25 active subscriptions per tenant (enforced at create via `ConditionExpression`).

## 8. Observability

### CloudWatch Metrics (namespace `Chimera/Webhooks`)

`DeliveryAttempts`, `DeliverySuccess`, `DeliveryFailurePermanent`,
`DeliveryFailureTransient`, `DeliveryLatencyMs`, `DlqDepth`, `RateLimitHit`,
`SecretCacheMiss` — all dimensioned by `{TenantId, SubscriptionId}`.

### Alarms

- `WebhookDlqDepth` > 5 msgs → alarmTopic.
- `WebhookDeliveryErrors` > 10/5min → alarmTopic.
- `WebhookDeliveryP99Latency` > 20s → alarmTopic.

### X-Ray

`ChimeraLambda` enables X-Ray ACTIVE. Annotate segments with `tenantId`,
`subscriptionId`, `eventType`, `httpStatusCode`, `retryAttempt`. Attach
`session.id` + `tenant.id` baggage (ADR-040) for correlation back to source
session.

## 9. Test Scenarios

1. **Happy path**: Mock 200 → delivery success, message deleted, metric emitted.
2. **HTTP 500 retry**: 500→500→200 over SQS re-enqueues → eventual success + 2 transient-failure metrics.
3. **HTTP 400 drop**: 400 → logged warning, message deleted, no DLQ.
4. **HMAC consumer verify**: valid-within-window / outside-window / tampered-body / timing-safe-compare.
5. **Tenant isolation**: Event for tenant42 → only tenant42 subs queried; `FilterExpression='tenantId = :tid'` asserted.
6. **SSRF rejection**: `http://` / RFC-1918 / 169.254.169.254 / localhost all raise.

## 10. Phased Plan

### Day 1 — Infra + Delivery Lambda

- [ ] `packages/webhook-sender/` scaffold + signing/ssrf-guard/secrets-cache/sender.
- [ ] Unit tests 1-6.
- [ ] `webhookSubscriptionsTable` in DataStack.
- [ ] `webhookDeliveryQueue` + `webhookFanoutRule` in OrchestrationStack.
- [ ] `ChimeraWebhookStack` with sender Lambda, event source mapping, alarms.
- [ ] `bun test && bun run lint && bun run typecheck && npx cdk synth` green.

### Day 2 — Management API + Integration Tests

- [ ] `packages/webhook-management/` CRUD handler.
- [ ] Cedar actions (`CreateWebhookSubscription`, etc.) in TenantOnboardingStack default policy.
- [ ] `/v1/webhooks` resource + 7 Lambda integrations in ApiStack.
- [ ] Integration test: create → publish EventBridge event → mock HTTPS receives signed POST.
- [ ] Integration test: tenant isolation (other tenant's sub not triggered).
- [ ] Update `docs/ROADMAP.md`; close chimera-59ee.

## 11. Open Questions

### OQ-1: SSE lifecycle events require EventBridgeDestination

`agent.message.start`, `agent.message.finish`, `agent.tool.invoked` originate
in chat-gateway SSE — not published to EventBridge today. Fix: add an
`EventBridgeDestination` to `packages/chat-gateway/src/multi-destination.ts`
alongside the existing DynamoDB persistence listener. ~4 hours extra scope
for Day 1, or defer these event types to a follow-up.

### OQ-2: Fan-out to N subs per event per tenant

Current batch-size-1 sequential delivery: if one of N sub deliveries fails,
the whole SQS message re-enqueues (duplicate deliveries to already-succeeded
subs). Day-2 fix: write one SQS message per (event, subscriptionId) tuple at
fan-out. Until then, instruct consumers to idempotency-key on
`(subscriptionId, eventType, payload.taskId|messageId)` — not on `webhookId`.

### OQ-3: Cost estimate

10 subscriptions × 1K tasks/day: ~$0.01/day per tenant. SQS + Lambda + Secrets
Manager all well within per-tenant economic viability.
