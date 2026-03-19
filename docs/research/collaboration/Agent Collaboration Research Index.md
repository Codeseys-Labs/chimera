---
title: Agent Collaboration Research Index
task: chimera-efac
status: complete
date: 2026-03-19
---

# Agent Collaboration Research Index

## Overview

This directory contains comprehensive research on agent collaboration patterns, communication protocols, and infrastructure for the AWS Chimera platform. The research covers agent-to-agent communication, user-through-agent collaboration, messaging infrastructure, shared memory patterns, and real-time streaming capabilities.

## Research Documents

### Core Communication Protocols

#### 1. Agent-to-Agent Protocol (A2A)
**File**: `05-Agent-to-Agent-Protocol.md`

Covers direct agent-to-agent communication patterns:
- Message passing and RPC patterns
- Task delegation and handoff protocols
- Shared memory coordination
- Event-driven agent collaboration
- MCP (Model Context Protocol) integration
- Protocol comparison (A2A vs MCP vs gRPC)

**Key Topics**:
- Request/response patterns
- Pub/sub event distribution
- Task queue coordination
- Shared workspace patterns
- Performance characteristics
- When to use which protocol

---

#### 2. User-Through-Agent Collaboration
**File**: `06-User-Through-Agent-Collaboration.md`

Explores how humans collaborate with each other through agents as intermediaries:
- User-Agent-User mediation patterns
- Shared workspace collaboration
- Agent as coordinator
- Multi-user session patterns
- Permission and access control
- Conflict resolution

**Key Topics**:
- Mediated messaging
- Turn-taking with agent memory
- Parallel contribution with merge
- Real-time collaborative sessions
- Privacy and context sharing
- Notification routing
- Delegation and proxy authority

**Comparison**:
- OpenClaw Lane Queue model (sequential, gate-driven)
- Overstory Swarm/Graph model (parallel, graph-driven)
- Hybrid approach recommendations

---

### Infrastructure & Implementation

#### 3. AWS Messaging Services
**File**: `02-AWS-Messaging-Services.md`

Comprehensive comparison of AWS messaging services for agent collaboration:
- Amazon SQS (queue-based, reliable delivery)
- Amazon SNS (pub/sub, fan-out)
- Amazon EventBridge (event bus, routing rules)
- Amazon MQ (MQTT, AMQP)
- AWS IoT Core (MQTT at scale)
- AWS AppSync (GraphQL, real-time subscriptions)

**Includes**:
- Feature comparison matrix
- Latency characteristics
- Cost analysis
- Pattern-to-service mapping
- When to use which service
- Multi-service architecture patterns

---

#### 4. Shared Memory and State Patterns
**File**: `03-Shared-Memory-and-State.md`

Patterns for agents to share state and coordinate:
- Amazon DynamoDB (key-value, coordination primitives)
- Amazon S3 (object storage, large artifacts)
- Amazon ElastiCache Redis (fast shared state)
- Amazon EFS (shared file system)
- Amazon Aurora (transactional shared state)

**Key Patterns**:
- Optimistic locking (DynamoDB)
- Read-after-write consistency
- Distributed locking primitives
- Large file sharing (S3)
- Session state management (Redis)
- Transactional workflows (Aurora)

**Includes**:
- Comparison matrix
- Performance characteristics
- Cost considerations
- Consistency guarantees

---

#### 5. Real-Time Streaming
**File**: `04-Real-Time-Streaming.md`

Real-time communication patterns for agent collaboration:
- Amazon Kinesis Data Streams
- Amazon MSK (Managed Kafka)
- AWS AppSync (GraphQL subscriptions)
- WebSocket via API Gateway
- Amazon IVS (live video streaming for agent observations)

**Use Cases**:
- Live agent telemetry
- Real-time user collaboration
- Event sourcing
- Multi-agent observation sharing
- Continuous agent monitoring

---

## Quick Reference

### By Use Case

| Use Case | Recommended Approach | Document Reference |
|----------|---------------------|-------------------|
| **Direct agent task delegation** | A2A request/response or SQS queue | [05-Agent-to-Agent-Protocol.md] |
| **Agent broadcasts event to many agents** | EventBridge or SNS | [02-AWS-Messaging-Services.md] |
| **Users collaborate through agents** | User-Agent-User mediation + DynamoDB state | [06-User-Through-Agent-Collaboration.md] |
| **Real-time multi-user editing** | AppSync subscriptions + OT | [04-Real-Time-Streaming.md], [06-User-Through-Agent] |
| **Large file sharing between agents** | S3 with event notification | [03-Shared-Memory-and-State.md] |
| **Agent coordination primitives** | DynamoDB with optimistic locking | [03-Shared-Memory-and-State.md] |
| **Fast shared cache** | ElastiCache Redis | [03-Shared-Memory-and-State.md] |
| **Agent event stream processing** | Kinesis Data Streams | [04-Real-Time-Streaming.md] |
| **Cross-system agent communication** | MCP protocol | [05-Agent-to-Agent-Protocol.md] |

### By AWS Service

| AWS Service | Primary Use Case | Document |
|-------------|-----------------|----------|
| **SQS** | Reliable task queues, guaranteed delivery | [02-AWS-Messaging-Services.md] |
| **SNS** | Fan-out notifications, pub/sub | [02-AWS-Messaging-Services.md] |
| **EventBridge** | Event routing, rule-based dispatch | [02-AWS-Messaging-Services.md] |
| **DynamoDB** | Shared state, coordination primitives | [03-Shared-Memory-and-State.md] |
| **S3** | Large file storage, artifact sharing | [03-Shared-Memory-and-State.md] |
| **ElastiCache Redis** | Fast shared cache, session state | [03-Shared-Memory-and-State.md] |
| **Aurora** | Transactional workflows | [03-Shared-Memory-and-State.md] |
| **EFS** | Shared file system | [03-Shared-Memory-and-State.md] |
| **Kinesis** | Real-time event streams | [04-Real-Time-Streaming.md] |
| **AppSync** | GraphQL real-time subscriptions | [04-Real-Time-Streaming.md] |
| **API Gateway WebSocket** | Bidirectional real-time comms | [04-Real-Time-Streaming.md] |

### By Pattern

| Pattern | Description | Best Implementation | Document |
|---------|-------------|-------------------|----------|
| **Request/Response** | Agent A asks Agent B to do task, waits for result | A2A direct call or SQS with reply queue | [05-Agent-to-Agent-Protocol.md] |
| **Fire-and-Forget** | Agent A tells Agent B to do task, doesn't wait | SQS or EventBridge | [02-AWS-Messaging-Services.md] |
| **Pub/Sub** | Agent publishes event, multiple agents react | SNS or EventBridge | [02-AWS-Messaging-Services.md] |
| **Shared Workspace** | Multiple agents read/write same workspace | DynamoDB + S3 + EventBridge notifications | [06-User-Through-Agent-Collaboration.md] |
| **Task Coordination** | Agent orchestrates tasks across multiple agents | SQS queues + DynamoDB state tracking | [05-Agent-to-Agent-Protocol.md] |
| **Real-Time Collaboration** | Multiple users/agents collaborate live | AppSync subscriptions + DynamoDB | [06-User-Through-Agent-Collaboration.md] |
| **Event Sourcing** | Capture all events in append-only log | Kinesis + S3 | [04-Real-Time-Streaming.md] |
| **Mediated Communication** | Agent acts as intermediary between users | User-Agent-User pattern + SQS/SNS | [06-User-Through-Agent-Collaboration.md] |

## Architecture Patterns

### 1. Simple Agent Task Queue
```
User → Agent A → SQS Queue → Agent B → Result → Agent A → User
```
**Use for**: Basic task delegation, single agent-to-agent requests
**See**: [05-Agent-to-Agent-Protocol.md]

### 2. Event-Driven Agent Swarm
```
Agent A → EventBridge → [Agent B, Agent C, Agent D] (parallel processing)
```
**Use for**: Broadcasting events to multiple agents, fan-out patterns
**See**: [02-AWS-Messaging-Services.md], [05-Agent-to-Agent-Protocol.md]

### 3. Shared Workspace Collaboration
```
User A → Agent A ──┐
                   ├→ DynamoDB/S3 ←─┐
User B → Agent B ──┘                ├─ EventBridge notifications
User C → Agent C ───────────────────┘
```
**Use for**: Multi-user collaborative editing, shared documents
**See**: [06-User-Through-Agent-Collaboration.md]

### 4. Coordinator Pattern
```
User → Coordinator Agent → [Worker Agent 1, Worker Agent 2, Worker Agent 3]
                                    ↓              ↓              ↓
                            DynamoDB (state tracking)
```
**Use for**: Complex multi-step workflows, task decomposition
**See**: [06-User-Through-Agent-Collaboration.md], [05-Agent-to-Agent-Protocol.md]

### 5. Real-Time Streaming
```
Agent A → Kinesis Stream → [Agent B, Agent C] (process events in real-time)
                    ↓
              S3 (archive)
```
**Use for**: Event processing, telemetry, monitoring
**See**: [04-Real-Time-Streaming.md]

## Implementation Recommendations

### For Chimera Platform

1. **Primary Agent Communication**: Use **MCP (Model Context Protocol)** for agent-to-agent discovery and tool sharing
2. **Task Queues**: Use **Amazon SQS** with DLQ for reliable task delivery
3. **Event Broadcasting**: Use **Amazon EventBridge** with rule-based routing
4. **Shared State**: Use **DynamoDB** for coordination primitives and small state
5. **Large Artifacts**: Use **S3** with EventBridge notifications
6. **Real-Time Collaboration**: Use **AWS AppSync** with GraphQL subscriptions
7. **Fast Cache**: Use **ElastiCache Redis** for session state and hot data

### Multi-Tenant Considerations

- **Tenant Isolation**: Use separate SQS queues, EventBridge buses, DynamoDB tables per tenant
- **Cross-Tenant Communication**: Mediate through central event bus with access control
- **Shared Resources**: Use DynamoDB tenant-id partition key, S3 bucket prefixes
- **Cost Tracking**: Tag all resources with tenant ID for cost allocation

## Performance Characteristics

### Latency Comparison

| Service | Typical Latency | Use When |
|---------|----------------|----------|
| **A2A Direct** | < 10ms | Low latency, same region |
| **SQS Standard** | ~100ms | Reliable, order not critical |
| **SQS FIFO** | ~200ms | Order matters, exactly-once delivery |
| **EventBridge** | ~500ms | Event routing, many consumers |
| **SNS** | ~100ms | Fan-out, pub/sub |
| **DynamoDB** | < 10ms | Point queries, coordination primitives |
| **S3** | ~100ms | Large files, archival |
| **Redis** | < 1ms | Ultra-low latency cache |
| **Kinesis** | ~70ms (to ~200ms) | Real-time streams, event sourcing |
| **AppSync** | ~50ms | GraphQL, real-time subscriptions |

### Throughput Characteristics

| Service | Max Throughput | Scalability |
|---------|---------------|-------------|
| **SQS** | 3,000 msg/sec (FIFO) / unlimited (standard) | Auto-scales |
| **SNS** | 10,000,000 msg/sec | Auto-scales |
| **EventBridge** | 10,000 events/sec (default) | Request limit increase |
| **Kinesis** | 1,000 records/sec per shard | Add shards to scale |
| **DynamoDB** | Unlimited (on-demand) | Auto-scales |
| **S3** | 3,500 PUT/sec, 5,500 GET/sec per prefix | Use prefix sharding |
| **Redis** | 250,000 ops/sec (r7g.large) | Vertical + horizontal scaling |

## Cost Considerations

### Cost Ranking (Low to High for Typical Agent Workload)

1. **SQS**: $0.40 per million requests (extremely cheap)
2. **SNS**: $0.50 per million publishes (very cheap)
3. **EventBridge**: $1.00 per million events (cheap)
4. **DynamoDB**: Pay per RCU/WCU or on-demand (moderate, depends on traffic)
5. **S3**: $0.023 per GB + $0.005 per 1,000 GET (cheap for storage, moderate for requests)
6. **ElastiCache Redis**: ~$50/month for cache.t4g.small (fixed cost)
7. **Kinesis**: $0.015 per shard-hour + $0.014 per million PUT requests (moderate)
8. **AppSync**: $4.00 per million operations (moderate)
9. **Aurora Serverless**: ~$0.10 per million requests + storage (moderate to high)

**Cost Optimization Tips**:
- Use **SQS** for high-volume, low-latency-tolerant messaging
- Use **EventBridge** for rule-based routing instead of multiple SNS topics
- Use **DynamoDB on-demand** for unpredictable workloads, provisioned for steady state
- Use **S3 Intelligent-Tiering** for agent artifacts
- Use **Redis** only for hot data, offload cold data to DynamoDB
- Batch operations where possible to reduce request counts

## Security Considerations

### Access Control

- **IAM Policies**: Use least-privilege IAM roles for agent service accounts
- **Resource Policies**: Use SQS/SNS/EventBridge resource policies for cross-account access
- **Encryption**: Enable encryption at rest (SQS SSE, S3 SSE, DynamoDB encryption)
- **Transit Encryption**: Use TLS for all service communication
- **VPC Endpoints**: Use VPC endpoints to avoid internet egress for internal agent communication

### Audit & Compliance

- **CloudTrail**: Enable for all API calls (agent actions)
- **CloudWatch Logs**: Log all agent messages for debugging/audit
- **EventBridge Archives**: Archive events for compliance/replay
- **DynamoDB Streams**: Capture state changes for audit trail
- **S3 Access Logging**: Track artifact access

## Monitoring & Observability

### Key Metrics

**SQS**:
- `ApproximateNumberOfMessagesVisible` (queue depth)
- `ApproximateAgeOfOldestMessage` (latency indicator)
- `NumberOfMessagesSent/Received` (throughput)

**EventBridge**:
- `Invocations` (rule executions)
- `FailedInvocations` (delivery failures)
- `ThrottledRules` (rate limiting)

**DynamoDB**:
- `ConsumedReadCapacityUnits/WriteCapacityUnits` (usage)
- `ThrottledRequests` (capacity issues)
- `SystemErrors` (service problems)

**Agent Health**:
- Task completion rate
- Error rate per agent
- Average task duration
- Queue wait time

### Alerting

- **Queue Depth**: Alert if SQS queue depth > threshold (agents not keeping up)
- **DLQ Messages**: Alert on any messages in dead-letter queue
- **Agent Errors**: Alert on error rate > threshold
- **Latency**: Alert if p99 latency exceeds SLA

## Future Research Areas

1. **Agent Learning from Collaboration**: Can agents improve coordination over time?
2. **Cross-Platform Agent Communication**: Interop with non-AWS agent systems
3. **Agent Reputation Systems**: Track agent reliability, route tasks accordingly
4. **Conflict-Free Replicated Data Types (CRDTs)**: Better shared state without coordination
5. **Federated Agent Networks**: Multiple Chimera instances collaborating
6. **Agent Simulation**: Testing collaboration patterns before production
7. **Cost-Aware Routing**: Route tasks based on cost vs. latency tradeoffs

## Contributing

When adding new research:
1. Create new document in this directory
2. Follow naming convention: `##-Topic-Name.md`
3. Include frontmatter with task ID and status
4. Update this index with summary and cross-references
5. Add entry to Quick Reference tables
6. Include code examples and architecture diagrams where applicable

## Document Change Log

| Date | Document | Change |
|------|----------|--------|
| 2026-03-19 | All | Initial research phase for chimera-efac task |
| 2026-03-19 | 06-User-Through-Agent-Collaboration.md | Created comprehensive user collaboration patterns |
| 2026-03-19 | Agent Collaboration Research Index.md | Created index and quick reference guide |

---

**Note**: This research is part of the AWS Chimera project (task chimera-efac). All patterns and recommendations are designed for multi-tenant, self-evolving agent platforms with focus on AWS native services.
