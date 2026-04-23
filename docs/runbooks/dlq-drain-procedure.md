# DLQ Drain Procedure

> Classification, replay, and cleanup playbook for any Chimera dead-letter queue alarm

**Last Updated:** 2026-04-22
**Audience:** On-call engineers, SREs
**Severity class:** SEV2 (backlog growing, active impact) / SEV3 (post-incident drain)
**SLA:** Begin triage within **60 minutes** of alarm; drain complete within **4 hours**
**Related:** [Alarm Runbooks](./alarm-runbooks.md), [Incident Response](./incident-response.md), [Registry Write Failure](./registry-write-failure.md)

---

## When to Use This Runbook

- A `*-backlog` alarm fires (e.g., `chimera-agent-tasks-${env}-dlq-backlog`) — `ApproximateNumberOfMessagesVisible > 1000` on a DLQ
- A `*-message-age` alarm fires — `ApproximateAgeOfOldestMessage > 300` seconds on a DLQ
- A ChimeraLambda function's DLQ (`<functionName>-dlq`) has accumulated messages after a Lambda invocation storm
- Post-incident: the root-cause is fixed, and the DLQ contains replay-eligible messages

**Do NOT use for:**
- A main queue (non-DLQ) backlog — that's a consumer-side capacity issue; scale consumers instead
- Messages in a DLQ that are known-poisonous — skip to Step 4 (archive + purge)
- Unknown root cause of the DLQ fills — **stop and investigate first.** Replaying messages whose failure mode is unresolved just re-fills the DLQ

---

## Chimera DLQ Inventory

All DLQs are provisioned via `ChimeraQueue` (`infra/constructs/chimera-queue.ts` lines 50–66) or `ChimeraLambda` (`infra/constructs/chimera-lambda.ts` lines 64–84). Both enforce 14-day retention + KMS encryption.

| DLQ Name | Main queue | Producer | Consumer | Replay safety |
|----------|-----------|----------|----------|---------------|
| `chimera-agent-tasks-${env}-dlq` | `chimera-agent-tasks-${env}` | EventBridge `Swarm Task Created` rule | ECS chat-gateway task workers | Mostly safe — tasks are idempotent |
| `chimera-agent-messages-${env}-dlq.fifo` | `chimera-agent-messages-${env}.fifo` | EventBridge A2A rule | Agent runtime MessageGroup consumer | **Unsafe** — FIFO ordering violated on replay |
| `chimera-<functionName>-dlq` (per Lambda) | N/A (Lambda async invocation DLQ) | Lambda async failures | Manual replay | Depends on Lambda semantics |
| `chimera-<queueName>-dlq` (orchestration `TaskFailedRule` target) | EventBridge direct | EventBridge `Agent Task Failed` rule | Human forensics only | **Never replay** — these are already-failed agent tasks |

See `infra/lib/orchestration-stack.ts` lines 80–103 for the agent queues and line 141 for the `TaskFailedRule → dlq` direct wiring.

**Evolution stack:** Every evolution Lambda (`analyzeConversationLogs`, `generatePromptVariant`, `testPromptVariant`, `detectPatterns`, `generateSkill`, `memoryGC`, `processFeedback`, `rollbackChange`) has a per-function DLQ via `ChimeraLambda`. See `infra/lib/evolution-stack.ts` line 107 comment.

---

## Step 1 — Identify the DLQ and its producer

### 1a. List DLQs with non-zero message counts

```bash
export ENV=prod

# List all DLQs in the region
aws sqs list-queues --queue-name-prefix chimera- \
  --query 'QueueUrls[?contains(@, `dlq`)]' --output text \
  | tr '\t' '\n' > /tmp/dlqs.txt

# Get depth per DLQ
while read url; do
  name=$(basename ${url})
  count=$(aws sqs get-queue-attributes --queue-url ${url} \
    --attribute-names ApproximateNumberOfMessages \
    --query 'Attributes.ApproximateNumberOfMessages' --output text)
  age=$(aws sqs get-queue-attributes --queue-url ${url} \
    --attribute-names ApproximateAgeOfOldestMessage \
    --query 'Attributes.ApproximateAgeOfOldestMessage' --output text 2>/dev/null || echo "0")
  if [ "${count}" -gt 0 ]; then
    echo "${name}: ${count} messages (oldest ${age}s)"
  fi
done < /tmp/dlqs.txt
```

### 1b. Identify the alarming DLQ

The alarm name maps 1:1 to the queue name via `ChimeraQueue` (see `chimera-queue.ts` lines 69–86):

- Backlog alarm: `<queueName>-backlog`
- Age alarm: `<queueName>-message-age`

```bash
# Go from alarm name to queue URL
export DLQ_NAME=<queue-name-from-alarm>
export DLQ_URL=$(aws sqs get-queue-url --queue-name ${DLQ_NAME} --query QueueUrl --output text)

echo "DLQ URL: ${DLQ_URL}"
```

### 1c. Identify the main queue that redrives into this DLQ

```bash
# RedrivePolicy on the main queue points at the DLQ
MAIN_QUEUE_URL=$(aws sqs list-queues --queue-name-prefix chimera- \
  --query 'QueueUrls[]' --output text | tr '\t' '\n' | while read q; do
    policy=$(aws sqs get-queue-attributes --queue-url ${q} \
      --attribute-names RedrivePolicy \
      --query 'Attributes.RedrivePolicy' --output text 2>/dev/null)
    if echo "${policy}" | grep -q "${DLQ_NAME}"; then echo ${q}; fi
  done)

echo "Main queue: ${MAIN_QUEUE_URL}"
```

---

## Step 2 — Peek non-destructively (classify the root cause)

**Critical:** do not use `aws sqs receive-message` without `VisibilityTimeout=0` — the default (30s) makes messages invisible to subsequent peek attempts. The ChimeraQueue default is 180s (`chimera-queue.ts` line 60).

### 2a. Peek up to 10 messages without consuming them

```bash
aws sqs receive-message \
  --queue-url ${DLQ_URL} \
  --max-number-of-messages 10 \
  --visibility-timeout 0 \
  --attribute-names All \
  --message-attribute-names All \
  --output json > /tmp/dlq-peek.json

# Message bodies
jq -r '.Messages[] | .Body' /tmp/dlq-peek.json | head -20

# Receive counts (how many times the consumer tried)
jq -r '.Messages[] | .Attributes.ApproximateReceiveCount' /tmp/dlq-peek.json | sort | uniq -c
```

### 2b. Classify each message

Look at the message body + attributes to decide:

| Class | Signal | Action |
|-------|--------|--------|
| **Transient** | Consumer was down / throttled / timing out (receive count = `maxReceiveCount`, body well-formed) | Step 3 (replay) |
| **Permanent (poison)** | Body malformed, schema violation, references deleted tenant | Step 4 (archive) |
| **Downstream outage** | Consumer error mentions specific AWS service throttle/unavailable | Wait, then Step 3 |
| **Quota exceeded** | Tenant-scoped failure message (e.g., `RATE_LIMIT_EXCEEDED`) | Step 4 — do not replay; tenant sees it's their quota |
| **Security/abuse** | Suspicious source, malformed auth, IoC match | Escalate to [security-incident-tenant-breach.md](./security-incident-tenant-breach.md) |

### 2c. Pull the Lambda/consumer log for the same window

```bash
# For agent-task DLQ: consumer is chat-gateway ECS task
aws logs filter-log-events \
  --log-group-name /chimera/${ENV}/agent-runtime \
  --start-time $(($(date +%s) - 3600))000 \
  --filter-pattern '{ $.level = "ERROR" }' \
  --max-items 50 \
  --query 'events[].{t:timestamp,msg:message}' --output table | head -30

# For a Lambda DLQ: look at the Lambda's log group
# Lambda functions from ChimeraLambda follow naming: chimera-<functionName>-${env}
aws logs filter-log-events \
  --log-group-name /aws/lambda/chimera-<function>-${ENV} \
  --start-time $(($(date +%s) - 3600))000 \
  --filter-pattern '"ERROR"' \
  --max-items 50
```

---

## Step 3 — Replay transient messages to the main queue

**Preconditions:** root cause is fixed; consumer is healthy; replay is safe (see DLQ inventory table).

### 3a. Set up a batched replay

AWS provides a managed DLQ redrive since 2022. Use it when possible (it preserves message attributes and handles batching):

```bash
# Start a redrive task (managed by SQS)
REDRIVE_TASK=$(aws sqs start-message-move-task \
  --source-arn arn:aws:sqs:us-west-2:$(aws sts get-caller-identity --query Account --output text):${DLQ_NAME} \
  --destination-arn arn:aws:sqs:us-west-2:$(aws sts get-caller-identity --query Account --output text):$(basename ${MAIN_QUEUE_URL}) \
  --max-number-of-messages-per-second 10 \
  --query 'TaskHandle' --output text)

echo "Redrive task handle: ${REDRIVE_TASK}"

# Monitor progress
while true; do
  status=$(aws sqs list-message-move-tasks \
    --source-arn arn:aws:sqs:us-west-2:$(aws sts get-caller-identity --query Account --output text):${DLQ_NAME} \
    --query 'Results[0].{Status:Status,Moved:ApproximateNumberOfMessagesMoved,Total:ApproximateNumberOfMessagesToMove}')
  echo "${status}"
  if echo "${status}" | grep -q "COMPLETED\|FAILED"; then break; fi
  sleep 30
done
```

**Rate limiting:** `--max-number-of-messages-per-second 10` keeps downstream consumers from re-overloading. Raise only if you're confident the consumer can handle the throughput.

**Cancel a runaway redrive:**

```bash
aws sqs cancel-message-move-task --task-handle ${REDRIVE_TASK}
```

### 3b. Manual replay (for small backlogs < 100 messages)

If the managed redrive fails (rare) or you need to transform messages first:

```bash
while true; do
  msgs=$(aws sqs receive-message \
    --queue-url ${DLQ_URL} \
    --max-number-of-messages 10 \
    --visibility-timeout 300 \
    --attribute-names All \
    --message-attribute-names All \
    --wait-time-seconds 5 \
    --output json)

  count=$(echo "${msgs}" | jq '.Messages | length // 0')
  [ "${count}" -eq 0 ] && { echo "Drained."; break; }

  echo "${msgs}" | jq -c '.Messages[]' | while read m; do
    body=$(echo "${m}" | jq -r '.Body')
    receipt=$(echo "${m}" | jq -r '.ReceiptHandle')

    # Transform or validate if needed (example: add replay metadata)
    new_body=$(echo "${body}" | jq -c '. + {_replay: {incidentId: "'${INCIDENT_ID:-none}'", at: "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}}')

    # Send to main queue
    aws sqs send-message \
      --queue-url ${MAIN_QUEUE_URL} \
      --message-body "${new_body}" > /dev/null

    # Delete from DLQ after successful send
    aws sqs delete-message \
      --queue-url ${DLQ_URL} \
      --receipt-handle "${receipt}"
  done
done
```

### 3c. FIFO queue replay (special case — `chimera-agent-messages-${env}.fifo`)

FIFO replay is **unsafe by default** because the DLQ drops the original `MessageGroupId` ordering. If you must replay:

```bash
# Accept that ordering will be lost — require explicit confirmation
aws sqs send-message \
  --queue-url ${MAIN_QUEUE_URL} \
  --message-body "${body}" \
  --message-group-id "dlq-replay-${INCIDENT_ID}" \
  --message-deduplication-id "$(echo "${body}" | sha256sum | cut -d' ' -f1)"
```

Post in `#chimera-incidents` with a note: "FIFO ordering invariant violated during DLQ drain — flagged in audit."

---

## Step 4 — Archive permanent messages to S3

For poison / quota-exceeded / permanently-malformed messages, preserve for post-mortem.

### 4a. Export DLQ contents to S3 (non-destructive)

```bash
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export ARCHIVE_BUCKET=s3://chimera-dlq-archive-${ENV}-${ACCOUNT}

aws s3 mb ${ARCHIVE_BUCKET} --region us-west-2 2>/dev/null || true

export ARCHIVE_KEY="dlq-archive/${DLQ_NAME}/$(date -u +%Y%m%d-%H%M%S).jsonl"
: > /tmp/dlq-archive.jsonl

while true; do
  msgs=$(aws sqs receive-message \
    --queue-url ${DLQ_URL} \
    --max-number-of-messages 10 \
    --visibility-timeout 120 \
    --attribute-names All \
    --message-attribute-names All \
    --wait-time-seconds 5 \
    --output json)

  count=$(echo "${msgs}" | jq '.Messages | length // 0')
  [ "${count}" -eq 0 ] && break

  echo "${msgs}" | jq -c '.Messages[]' >> /tmp/dlq-archive.jsonl

  # Delete from DLQ after archive
  echo "${msgs}" | jq -r '.Messages[].ReceiptHandle' | while read receipt; do
    aws sqs delete-message --queue-url ${DLQ_URL} --receipt-handle "${receipt}"
  done
done

# Upload with SSE + object lock for audit integrity
aws s3 cp /tmp/dlq-archive.jsonl ${ARCHIVE_BUCKET}/${ARCHIVE_KEY} \
  --sse aws:kms \
  --content-type application/x-ndjson

echo "Archived to: ${ARCHIVE_BUCKET}/${ARCHIVE_KEY}"
wc -l /tmp/dlq-archive.jsonl
```

### 4b. Log for post-mortem

```bash
# Log the archive location to the audit table
aws dynamodb put-item \
  --table-name chimera-audit-${ENV} \
  --item "{
    \"PK\":{\"S\":\"PLATFORM\"},
    \"SK\":{\"S\":\"DLQ_DRAIN#$(date -u +%Y-%m-%dT%H:%M:%SZ)\"},
    \"eventType\":{\"S\":\"dlq_drain\"},
    \"dlqName\":{\"S\":\"${DLQ_NAME}\"},
    \"archiveS3Uri\":{\"S\":\"${ARCHIVE_BUCKET}/${ARCHIVE_KEY}\"},
    \"messageCount\":{\"N\":\"$(wc -l < /tmp/dlq-archive.jsonl)\"},
    \"operator\":{\"S\":\"$(whoami)\"}
  }"
```

---

## Step 5 — Purge only after confirming the DLQ is empty/archived

**WARNING:** `purge-queue` is irreversible and has a 60-second cooldown. Skip it if you've already drained via Step 3 or Step 4 — the queue is empty.

```bash
# Verify empty first
aws sqs get-queue-attributes \
  --queue-url ${DLQ_URL} \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages' --output text

# Only purge if messages remain AND you've intentionally decided to discard them
# (e.g., known-invalid messages from a corrupted producer, not worth archiving)
aws sqs purge-queue --queue-url ${DLQ_URL}
```

---

## Step 6 — Clear the alarm + post-drain validation

### 6a. Wait for CloudWatch to observe the empty queue

The ChimeraQueue backlog alarm evaluates 1 period. After the queue empties, the alarm transitions `ALARM → OK` within 1 minute (SQS metric publishes every minute).

```bash
# Watch the alarm state
aws cloudwatch describe-alarms \
  --alarm-names "${DLQ_NAME}-backlog" "${DLQ_NAME}-message-age" \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue,Reason:StateReason}' \
  --output table
```

### 6b. Verify main queue drain cadence

Confirm replayed messages are being consumed:

```bash
# Main queue depth should be dropping (not climbing)
aws cloudwatch get-metric-statistics \
  --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value=$(basename ${MAIN_QUEUE_URL}) \
  --start-time "$(date -u -v-15M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 60 \
  --statistics Average \
  --query 'Datapoints | sort_by(@, &Timestamp)' \
  --output table
```

If depth is climbing, **stop replay** — consumer cannot keep up.

### 6c. Spot-check consumer success rate

```bash
# For chat-gateway ECS consumer: check error rate
aws logs filter-log-events \
  --log-group-name /chimera/${ENV}/agent-runtime \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern '{ $.event_type = "task_completed" }' \
  --max-items 100 \
  | jq -r '.events[].message | fromjson | .status' \
  | sort | uniq -c
```

Expected: >95% `success`. Less than that → replay too aggressive; throttle via `--max-number-of-messages-per-second`.

---

## Rollback (if replay causes downstream damage)

The only way to "un-replay" is to pause the consumer, quarantine affected sessions, and accept the damage. There is no uncommit for SQS sends.

```bash
# 1. Pause consumer (ECS)
aws ecs update-service \
  --cluster chimera-chat \
  --service chat-sdk \
  --desired-count 0

# 2. Cancel any in-progress redrive task
aws sqs cancel-message-move-task --task-handle ${REDRIVE_TASK}

# 3. Purge the main queue if replayed messages are known-bad
#    WARNING: this discards legitimate in-flight messages too
aws sqs purge-queue --queue-url ${MAIN_QUEUE_URL}

# 4. Bring consumer back once root cause of damage is addressed
aws ecs update-service \
  --cluster chimera-chat \
  --service chat-sdk \
  --desired-count <original-count>
```

**Prefer forward fix over rollback** — downstream idempotency is cheaper than a main-queue purge.

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ReceiveCount` = 1 on DLQ messages | Manual `send-message` directly to DLQ (bypass main) | Check CloudTrail for rogue writers; usually a mis-configured Lambda |
| Redrive task stuck in `RUNNING` > 1h | Source/destination queues are FIFO and dedup hit | Switch to manual replay with new `MessageDeduplicationId` |
| `InvalidMessageContents` on send to main | Body was encoded during receive | Strip SQS envelope; send only the `Body` field |
| Alarm re-fires within 5 min of clear | Root cause not actually fixed | Stop — go back to Step 2; investigate consumer logs |
| Main queue depth climbs during replay | Consumer can't keep up | Lower `--max-number-of-messages-per-second`, scale out consumer |
| `AccessDenied` on `start-message-move-task` | Role missing `sqs:StartMessageMoveTask` | Add to on-call role; see `roles/chimera-oncall-prod` |

---

## Prevention / Tuning

- **Set DLQ alarms at the right threshold.** Defaults in `chimera-queue.ts` line 72 (`> 1000` messages) are intentionally high to avoid noise but may lag. For low-volume queues, override via `ChimeraQueueProps.maxReceiveCount` and add a tighter custom alarm.
- **Use idempotency keys** in message bodies so replay is always safe. Agent runtime writes expect `idempotencyKey` in every task event.
- **Review `maxReceiveCount`** (default 3 in `chimera-queue.ts` line 64). Too low = premature DLQ; too high = consumer burns more on poison messages.
- **FIFO queues should NEVER be replayed.** If your FIFO queue has a DLQ that fills regularly, the producer is broken — fix the producer, don't drain the DLQ.
- **Set per-queue DLQ alarm actions** to the on-call SNS topic via `ChimeraQueueProps.alarmTopic` — avoid alarm blindness on shared topics.

---

## Cross-References

- [Alarm Runbooks](./alarm-runbooks.md) — Generic alarm response protocol
- [ChimeraQueue construct](../../infra/constructs/chimera-queue.ts) — DLQ, encryption, alarm definitions
- [ChimeraLambda construct](../../infra/constructs/chimera-lambda.ts) — Per-function DLQ definition (lines 64–84)
- [Orchestration Stack](../../infra/lib/orchestration-stack.ts) — Agent task + A2A queues (lines 80–103, 141)
- [Evolution Stack](../../infra/lib/evolution-stack.ts) — 8 Lambda DLQs for the self-evolution engine
- [Registry Write Failure](./registry-write-failure.md) — Specific DLQ drain for Registry dual-write failures
- [Incident Response](./incident-response.md) — Broader SEV structure if DLQ drain uncovers an incident
- [DR Runbook Gaps](../reviews/dr-runbook-gaps.md) — Why this runbook exists

---

**Owner:** Platform on-call
**Next review:** 2026-07-22 (quarterly)
