---
title: 'ADR-008: EventBridge as Central Nervous System'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-008: EventBridge as Central Nervous System

## Status

**Accepted** (2026-03-20)

## Context

AWS Chimera agents need to:
- **Schedule cron jobs**: Run agents at specific times (daily reports, data sync)
- **React to events**: Trigger agents on S3 upload, DynamoDB stream, SQS message
- **Coordinate workflows**: Multi-agent orchestration across sessions
- **Publish platform events**: session.started, skill.installed, cost.threshold.exceeded

Requirements:
- **Serverless**: No servers to manage
- **Event-driven**: Agents react to events, not poll
- **Filtered routing**: Route events to specific tenants/agents
- **Audit trail**: Log all events for debugging
- **Fan-out**: One event triggers multiple consumers

The decision is which event bus to use as the platform's central nervous system.

## Decision

Use **Amazon EventBridge** as the event routing backbone.

All platform events (agent events, cron triggers, AWS service events) flow through EventBridge. Rules route events to Lambda, Step Functions, or AgentCore Runtime based on content filtering.

**Example rule:**
```json
{
  "source": ["chimera.agent"],
  "detail-type": ["cost.threshold.exceeded"],
  "detail": {
    "tenantId": ["tenant-acme"],
    "costPercentage": [{ "numeric": [">=", 80] }]
  }
}
```

## Alternatives Considered

### Alternative 1: EventBridge (Selected)
AWS-managed event bus with content-based routing.

**Pros:**
- ✅ **Serverless**: No infrastructure to manage
- ✅ **Content filtering**: Route based on event fields, not just topic
- ✅ **Cron scheduling**: Built-in scheduler with cron expressions
- ✅ **AWS integrations**: 90+ targets (Lambda, StepFunctions, SQS, SNS, etc.)
- ✅ **Schema registry**: Define event schemas, enforce at publish time
- ✅ **Archive/replay**: Archive events for 7 days, replay for testing

**Cons:**
- AWS-only (acceptable - we're AWS-native)

**Verdict:** Selected for serverless and content-based routing.

### Alternative 2: SNS + SQS
Traditional pub/sub with SNS topics and SQS queues.

**Pros:**
- Mature, battle-tested
- Familiar to team
- Lower cost than EventBridge

**Cons:**
- ❌ **Topic-based only**: Cannot filter by event content
- ❌ **No cron**: Need separate CloudWatch Events for scheduling
- ❌ **Manual wiring**: Need to create SQS queue per subscriber
- ❌ **No schema registry**: No enforcement of event format

**Verdict:** Rejected - topic-based routing too limiting.

### Alternative 3: Kafka (Amazon MSK)
Distributed event streaming platform.

**Pros:**
- High throughput (100K+ events/sec)
- Event replay (retain events for days/weeks)
- Industry standard

**Cons:**
- ❌ **Always-on cost**: $200/month minimum for MSK cluster
- ❌ **Operational burden**: Need to manage brokers, partitions
- ❌ **Overkill**: Chimera needs 1K events/day, not 100K/sec
- ❌ **No cron**: Need separate scheduler

**Verdict:** Rejected - overkill, too expensive.

### Alternative 4: Custom Event Store
Build custom event bus on DynamoDB + DynamoDB Streams.

**Pros:**
- Full control
- Cost-effective

**Cons:**
- ❌ **Build time**: 4-6 weeks to build what EventBridge provides
- ❌ **Maintenance**: Need to maintain event routing logic
- ❌ **No cron**: Need to build scheduler ourselves
- ❌ **No schema registry**: Need to build ourselves

**Verdict:** Rejected - reinventing the wheel.

## Consequences

### Positive

- **Decoupled architecture**: Components communicate via events, not direct calls
- **Easy to add features**: New event consumers don't affect existing system
- **Cron built-in**: No separate scheduler service needed
- **Audit trail**: All events logged to CloudWatch Logs
- **Testing**: Archive/replay for integration testing

### Negative

- **Eventually consistent**: Events delivered at-least-once (mitigated by idempotency)
- **Cost**: $1/million events (low for our scale)

### Risks

- **Event storms**: Misconfigured rule creates infinite loop (mitigated by circuit breakers)
- **Ordering**: No guaranteed order (mitigated by timestamps)

## Evidence

- **Definitive Architecture**: Lines 262 show EventBridge for cron scheduling
- **Mulch record mx-78e5ff**: "8-stack CDK architecture includes EventBridge nervous system"

## Related Decisions

- **ADR-007** (AgentCore MicroVM): EventBridge triggers AgentCore sessions
- **ADR-013** (CodePipeline): Pipeline publishes deploy events to EventBridge

## References

1. EventBridge docs: https://docs.aws.amazon.com/eventbridge/
2. Content filtering: https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html
