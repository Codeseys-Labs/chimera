---
title: AWS Communication Primitives for Multi-Agent Platforms
purpose: Deep dive into AWS services as building blocks for inter-agent communication
project: AWS Chimera
domain: architecture/communication
status: draft
created: 2026-03-19
---

# AWS Communication Primitives for Multi-Agent Platforms

## Introduction

Building a multi-tenant agent platform requires robust, scalable communication primitives that can handle high-volume message routing, maintain ordering guarantees, and provide tenant isolation. AWS offers a comprehensive suite of managed services that serve as foundational building blocks for inter-agent communication patterns.

This document examines the key AWS services suitable for agent-to-agent communication in the AWS Chimera platform. Each service offers unique characteristics regarding latency, throughput, ordering guarantees, and cost models. Understanding these primitives enables architects to compose effective communication patterns that balance performance, reliability, and operational complexity.

The services covered range from simple message queues (SQS) to sophisticated orchestration engines (Step Functions), each serving distinct communication needs within a distributed agent ecosystem.

## Amazon SQS (Simple Queue Service)

Amazon SQS is a fully managed message queuing service that enables decoupling and scaling of distributed systems and microservices. For multi-agent platforms, SQS provides reliable, asynchronous task distribution with at-least-once delivery guarantees.

### Standard Queues

**Overview:**
Standard queues offer unlimited throughput and best-effort ordering. They support up to 120,000 in-flight messages per queue and provide at-least-once delivery semantics.

**Agent Task Distribution:**
- **High Throughput**: No practical limit on API requests per second
- **Best-Effort Ordering**: Messages may arrive out of order
- **Deduplication**: Not guaranteed; consumers must handle duplicate messages
- **Use Cases**: Task distribution where order doesn't matter (e.g., parallel image processing, log aggregation, background job execution)

**Performance Characteristics:**
- **Latency**: Sub-second message delivery (typically <100ms)
- **Message Size**: Up to 256 KB per message (up to 2 GB with S3 extended client)
- **Retention**: 1 minute to 14 days (default 4 days)
- **Batch Operations**: Send/receive/delete up to 10 messages per API call

**Example Use Case:**
Agent workers polling for tasks from a shared queue:
```
TenantA-Agent1 → SQS Queue → [Worker1, Worker2, Worker3]
TenantA-Agent2 ↗              ↓
                         Processes tasks in parallel
```

### FIFO Queues

**Overview:**
FIFO (First-In-First-Out) queues guarantee strict ordering and exactly-once processing. They provide message group IDs for organizing messages into distinct ordered groups.

**Ordering Guarantees:**
- **Strict Sequential Processing**: Messages within a group are processed in exact order
- **No Duplicates**: Automatic deduplication within a 5-minute interval
- **Message Group IDs**: Enable parallel processing across different groups while maintaining order within each group

**Performance Characteristics:**
- **Throughput**:
  - Standard mode: 300 transactions per second (TPS) per API action
  - High-throughput mode: 3,000 messages per second per API action (up to 30,000 TPS with batching)
- **Latency**: Similar to standard queues (~100ms)
- **Queue Naming**: Must end with `.fifo` suffix

**Exactly-Once Processing:**
FIFO queues use message deduplication IDs to prevent duplicate messages within a 5-minute deduplication interval. Two methods:
1. **Content-based deduplication**: SHA-256 hash of message body
2. **Explicit deduplication ID**: Provided by producer

**When to Use FIFO:**
- Agent communication requiring strict order (e.g., session state updates, multi-step workflows)
- Financial transactions or audit log processing
- Command sequences that must execute in order

### Message Group IDs for Session Affinity

Message Group IDs are a powerful feature for organizing work while maintaining order:

**Interleaving Multiple Ordered Groups:**
- Each message group ID represents a distinct ordered group
- Multiple groups can be processed in parallel by different consumers
- Order is maintained within each group, but groups are processed concurrently

**Session-Based Routing:**
```
Session1 (GroupID: session-1) → Consumer1 processes in order
Session2 (GroupID: session-2) → Consumer2 processes in order
Session3 (GroupID: session-3) → Consumer3 processes in order
```

**Best Practices:**
- Use unique message group IDs per logical session (e.g., tenant + session ID)
- Avoid using the same group ID for unrelated messages
- For single-threaded processing of all messages, use a single group ID
- For maximum parallelism, use unique group IDs per message

**Lambda Integration:**
When Lambda processes SQS FIFO queues:
- Lambda processes one message group at a time per function instance
- Different message groups can be processed in parallel by different instances
- Scaling occurs across message groups, not within a single group

**Avoiding Backlogs:**
Using the same message group ID for a large volume of messages creates a bottleneck. Instead:
- Distribute messages across multiple group IDs based on logical boundaries
- Use group IDs that reflect natural partitioning (user ID, tenant ID, resource ID)
- Monitor queue depth per message group

### Dead Letter Queues (DLQ)

**Purpose:**
DLQs capture messages that fail processing after multiple attempts, enabling separate handling of problematic messages.

**Configuration:**
- **Maximum Receives**: Number of delivery attempts before moving to DLQ (typically 3-5)
- **Redrive Policy**: Defines which queue receives failed messages
- **Retention**: DLQ messages can be retained up to 14 days for analysis

**Error Isolation:**
- Failed messages don't block processing of subsequent messages
- Enables investigation without impacting healthy message flow
- Allows for manual intervention or automated remediation

**Monitoring and Alerting:**
- CloudWatch metrics: `ApproximateNumberOfMessagesVisible` on DLQ
- Set alarms for non-zero DLQ depth
- Automated workflows to process DLQ messages

**Retry Strategies:**
1. **Immediate Retry**: Re-send from DLQ after fixing the issue
2. **Exponential Backoff**: Wait increasing intervals between retries
3. **Manual Review**: Investigate messages that consistently fail

**Example Architecture:**
```
Primary Queue → Consumer → [Success] → Complete
              ↓ (max receives)
           Dead Letter Queue → Alert → Manual Investigation
```

### Multi-Tenant Considerations

**Queue Naming Strategies:**

1. **Dedicated Queues per Tenant:**
   ```
   chimera-tasks-tenant-{tenantId}.fifo
   chimera-events-tenant-{tenantId}
   ```
   - **Pros**: Complete isolation, per-tenant metrics, independent scaling
   - **Cons**: Management overhead, potential for many idle queues

2. **Shared Queue with Tenant Routing:**
   ```
   chimera-shared-tasks.fifo
   MessageGroupID: {tenantId}-{sessionId}
   ```
   - **Pros**: Simpler management, resource efficiency
   - **Cons**: Requires message filtering, shared throughput limits

3. **Hybrid Approach:**
   - Shared queues for standard workloads
   - Dedicated queues for high-volume or premium tenants

**IAM Policies:**
```json
{
  "Effect": "Allow",
  "Action": [
    "sqs:SendMessage",
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage"
  ],
  "Resource": "arn:aws:sqs:*:*:chimera-tasks-tenant-${aws:PrincipalTag/TenantId}*",
  "Condition": {
    "StringEquals": {
      "aws:PrincipalTag/TenantId": "${aws:RequestTag/TenantId}"
    }
  }
}
```

**Cost Allocation:**
- Use tagging to track costs per tenant
- CloudWatch metrics filtered by queue name pattern
- Cost Explorer reports grouped by tag

**Tenant Isolation Patterns:**
- **Network Isolation**: VPC endpoints for SQS
- **Encryption**: Separate KMS keys per tenant
- **Access Control**: IAM policies enforcing tenant-scoped access
- **Rate Limiting**: Separate queues prevent noisy neighbor issues

## Amazon SNS (Simple Notification Service)

Amazon SNS is a pub/sub messaging service that enables message delivery to multiple subscribers simultaneously. It supports two topic types: Standard (best-effort ordering, high throughput) and FIFO (strict ordering, exactly-once delivery).

### Pub/Sub Patterns

**Topic-Based Broadcasting:**
SNS follows the publisher-subscriber pattern where producers publish messages to topics, and subscribers receive copies of those messages.

**Supported Subscriber Types:**
- Amazon SQS queues
- AWS Lambda functions
- HTTP/HTTPS endpoints
- Email/Email-JSON
- SMS
- Mobile push notifications
- Amazon Data Firehose

**Standard Topics:**
- **Throughput**: Unlimited publishes per second
- **Ordering**: Best-effort ordering
- **Deduplication**: Not guaranteed
- **Use Cases**: Event broadcasting, alerting, notifications

**FIFO Topics:**
- **Throughput**: Up to 300 publishes/second (3,000 with batching)
- **Ordering**: Strict ordering within message groups
- **Deduplication**: Exactly-once delivery
- **Subscribers**: Only SQS FIFO queues
- **Use Cases**: Ordered event sequences, state machine transitions

**Agent Event Broadcasting Example:**
```
Agent Completion Event
        ↓
    SNS Topic
    ↙  ↓  ↘
  SQS  Lambda  HTTP
   ↓     ↓      ↓
Logger  Metrics  Webhook
```

### Fanout Architecture

**SNS-to-SQS Fan-Out:**
The most common pattern for reliable, durable message delivery to multiple consumers:

**Architecture:**
```
Producer → SNS Topic → [SQS Queue 1 → Consumer1]
                    → [SQS Queue 2 → Consumer2]
                    → [SQS Queue 3 → Consumer3]
```

**Benefits:**
1. **Decoupling**: Publishers don't know about subscribers
2. **Durability**: SQS provides message persistence
3. **Parallel Processing**: Each consumer processes independently
4. **Load Balancing**: Multiple workers per queue
5. **Failure Isolation**: One consumer failure doesn't affect others

**Use Cases for Agent Platforms:**
- **Event Distribution**: Agent completion events to multiple processors
- **Multi-Stage Pipelines**: Same event triggers multiple workflows
- **Cross-Region Replication**: Distribute events to regional processors
- **Audit and Compliance**: Fan out to logging and monitoring systems

**Configuration Best Practices:**
```json
{
  "QueueArn": "arn:aws:sqs:region:account:queue-name",
  "RawMessageDelivery": true  // Avoids SNS wrapper for cleaner messages
}
```

**Message Delivery:**
- SNS delivers to all subscriptions in parallel
- Each subscription receives an independent copy
- Delivery failures are retried per subscription
- Failed deliveries can route to subscription-specific DLQs

### Message Filtering

**Subscription Filter Policies:**
SNS allows subscribers to receive only messages matching specific criteria, reducing unnecessary message processing.

**Filter Policy Scope:**
1. **MessageAttributes**: Filter based on message attributes
2. **MessageBody**: Filter based on JSON message payload

**Filter Operators:**
- **Exact Match**: `"color": ["red", "blue"]`
- **Numeric Range**: `"price": [{"numeric": [">=", 100, "<=", 200]}]`
- **Prefix Match**: `"eventType": [{"prefix": "agent."}]`
- **Suffix Match**: `"filename": [{"suffix": ".json"}]`
- **Anything-But**: `"status": [{"anything-but": ["error"]}]`
- **Exists**: `"priority": [{"exists": true}]`
- **IP Address**: `"sourceIP": [{"cidr": "10.0.0.0/8"}]`

**Example: Tenant-Specific Routing:**
```json
{
  "tenantId": ["tenant-12345"],
  "eventType": [{"prefix": "agent.task."}],
  "priority": [{"numeric": [">=", 5]}]
}
```

**Multi-Attribute Filtering:**
```json
{
  "tenantId": ["tenant-A", "tenant-B"],
  "region": ["us-east-1"],
  "severity": [{"anything-but": ["debug", "info"]}]
}
```

**Benefits:**
- **Reduced Processing Costs**: Consumers only receive relevant messages
- **Lower Latency**: Fewer messages to process
- **Simplified Consumer Logic**: Filtering happens at infrastructure level
- **Bandwidth Optimization**: Only necessary data transmitted

**Eventual Consistency:**
Filter policy changes may take up to 15 minutes to fully take effect across all edge locations.

### Multi-Tenant Patterns

**Topic Organization Strategies:**

1. **Dedicated Topics per Tenant:**
   ```
   chimera-events-tenant-{tenantId}
   ```
   - Complete isolation
   - Independent access control
   - Per-tenant metrics and alarms
   - Management overhead for many tenants

2. **Shared Topic with Filtering:**
   ```
   chimera-shared-events
   (with filter policies per subscription)
   ```
   - Resource efficiency
   - Centralized management
   - Requires careful filter design
   - Shared throughput limits

3. **Tiered Topics:**
   ```
   chimera-premium-events  → High-priority tenants
   chimera-standard-events → Regular tenants
   ```
   - SLA differentiation
   - Cost optimization
   - Simplified scaling

**Tenant-Specific Subscriptions:**
```json
{
  "TopicArn": "arn:aws:sns:region:account:chimera-events",
  "Protocol": "sqs",
  "Endpoint": "arn:aws:sqs:region:account:tenant-A-queue",
  "Attributes": {
    "FilterPolicy": "{\"tenantId\": [\"tenant-A\"]}"
  }
}
```

**Access Control:**
```json
{
  "Effect": "Allow",
  "Principal": {"AWS": "arn:aws:iam::account:role/AgentRole"},
  "Action": "SNS:Publish",
  "Resource": "arn:aws:sns:*:*:chimera-*",
  "Condition": {
    "StringEquals": {
      "sns:MessageAttribute/tenantId": "${aws:PrincipalTag/TenantId}"
    }
  }
}
```

**Cost Allocation:**
- Tag topics with tenant identifiers
- Use message attributes to track per-tenant publish counts
- CloudWatch metrics filtered by topic name pattern

**Message Archiving and Replay (FIFO only):**
- Enable message archiving for audit and compliance
- Replay messages from specific time ranges
- Combine with filter policies to replay only relevant messages

## Amazon EventBridge

Amazon EventBridge is a serverless event bus service that enables event-driven architectures by routing events from multiple sources to multiple targets based on rules and event patterns.

### Event-Driven Communication

**Event Bus Architecture:**
EventBridge uses event buses as central routers for events. Three types:
1. **Default Event Bus**: Receives events from AWS services
2. **Custom Event Buses**: Application-specific events
3. **Partner Event Buses**: SaaS provider integrations

**Rules and Event Pattern Matching:**
Rules evaluate incoming events against defined patterns and route matches to specified targets (up to 5 per rule).

**Event Structure:**
```json
{
  "version": "0",
  "id": "unique-id",
  "detail-type": "Agent Task Completed",
  "source": "chimera.agents",
  "account": "123456789012",
  "time": "2026-03-19T10:00:00Z",
  "region": "us-east-1",
  "resources": [],
  "detail": {
    "tenantId": "tenant-A",
    "agentId": "agent-123",
    "taskId": "task-456",
    "status": "completed",
    "duration": 1500
  }
}
```

**Event Pattern Example:**
```json
{
  "source": ["chimera.agents"],
  "detail-type": ["Agent Task Completed"],
  "detail": {
    "tenantId": ["tenant-A", "tenant-B"],
    "status": ["completed"],
    "duration": [{"numeric": [">", 1000]}]
  }
}
```

**Pattern Matching Capabilities:**
- **Prefix Matching**: `{"eventType": [{"prefix": "agent."}]}`
- **Suffix Matching**: `{"filename": [{"suffix": ".json"}]}`
- **Anything-But**: `{"status": [{"anything-but": "error"}]}`
- **Exists**: `{"metadata": [{"exists": true}]}`
- **CIDR Matching**: `{"sourceIP": [{"cidr": "10.0.0.0/8"}]}`
- **Numeric Comparisons**: `{"value": [{"numeric": [">=", 100]}]}`

**Target Types:**
- Lambda functions
- Step Functions state machines
- SQS queues
- SNS topics
- Kinesis streams
- API Gateway endpoints
- EventBridge buses (cross-region, cross-account)
- EC2 actions (start/stop/terminate)
- ECS tasks
- Batch jobs

### Event Routing

**Cross-Account Event Delivery:**
EventBridge now supports **direct delivery** to targets in other accounts without intermediary event buses.

**Traditional Pattern (Pre-2025):**
```
Source Account Event Bus → Target Account Event Bus → Target
```

**New Direct Delivery Pattern (2025+):**
```
Source Account Event Bus → Target Account Target (SQS, Lambda, SNS)
```

**Benefits of Direct Delivery:**
- **Simplified Architecture**: Eliminates intermediary event bus
- **Reduced Latency**: One fewer hop in the chain
- **Lower Cost**: No charges for intermediary bus
- **Easier Management**: Fewer resources to configure

**Setup Requirements:**
1. **Source Account**: IAM role allowing event delivery to target
2. **Target Account**: Resource policy allowing event reception

**Example Resource Policy (Target SQS Queue):**
```json
{
  "Effect": "Allow",
  "Principal": {
    "Service": "events.amazonaws.com"
  },
  "Action": "sqs:SendMessage",
  "Resource": "arn:aws:sqs:region:target-account:queue-name",
  "Condition": {
    "ArnEquals": {
      "aws:SourceArn": "arn:aws:events:region:source-account:rule/rule-name"
    }
  }
}
```

**Service-to-Service Events:**
AWS services automatically publish events to the default event bus:
- EC2 instance state changes
- ECS task state changes
- S3 object creation
- DynamoDB table updates
- CodePipeline execution changes
- Step Functions execution status

**Custom Application Events:**
Applications publish custom events using the `PutEvents` API:
```python
events = client.put_events(
    Entries=[
        {
            'Source': 'chimera.agents',
            'DetailType': 'Agent Task Completed',
            'Detail': json.dumps({
                'tenantId': 'tenant-A',
                'agentId': 'agent-123',
                'status': 'completed'
            })
        }
    ]
)
```

**EventBridge Pipes:**
For point-to-point integrations with advanced transformations:
```
Source (DynamoDB Stream, Kinesis, SQS) →
  [Filter] → [Enrich] → [Transform] →
    Target (Lambda, Step Functions, etc.)
```

### Schema Registry

**Purpose:**
Schema Registry provides a centralized repository for event schemas, enabling:
- **Validation**: Ensure events conform to expected structure
- **Versioning**: Track schema evolution over time
- **Discovery**: Browse available event types
- **Code Generation**: Auto-generate SDKs from schemas

**Schema Discovery:**
EventBridge can automatically discover schemas from events flowing through the bus.

**Schema Example:**
```json
{
  "openapi": "3.0.0",
  "info": {
    "version": "1.0.0",
    "title": "AgentTaskCompleted"
  },
  "paths": {},
  "components": {
    "schemas": {
      "AgentTaskCompleted": {
        "type": "object",
        "required": ["tenantId", "agentId", "taskId", "status"],
        "properties": {
          "tenantId": {"type": "string"},
          "agentId": {"type": "string"},
          "taskId": {"type": "string"},
          "status": {"type": "string", "enum": ["completed", "failed"]},
          "duration": {"type": "integer"}
        }
      }
    }
  }
}
```

**Versioning Strategy:**
- **Major Version**: Breaking changes (remove fields, change types)
- **Minor Version**: Backward-compatible additions (new optional fields)
- **Patch Version**: Documentation or non-functional changes

**Code Generation:**
Generate type-safe code from schemas for:
- Python
- Java
- TypeScript
- Go

### Multi-Tenant Event Isolation

**Custom Event Buses per Tenant:**
```
chimera-events-tenant-{tenantId}
```

**Advantages:**
- **Complete Isolation**: Events from one tenant never mix with another
- **Independent Rules**: Each tenant can have custom routing logic
- **Granular Monitoring**: CloudWatch metrics per tenant bus
- **Access Control**: IAM policies scoped to specific tenant buses

**Disadvantages:**
- **Management Overhead**: Multiple buses to configure and monitor
- **Quota Limits**: 100 custom event buses per account (can request increase)
- **Cost**: Charges per event bus

**Shared Event Bus with Filtering:**
```
chimera-shared-events
(Rules filter by tenantId in event detail)
```

**Rule Example:**
```json
{
  "Source": ["chimera.agents"],
  "DetailType": ["Agent Task Completed"],
  "Detail": {
    "tenantId": ["tenant-specific-value"]
  }
}
```

**Advantages:**
- **Resource Efficiency**: Single bus to manage
- **Simplified Architecture**: Fewer moving parts
- **Cost-Effective**: Lower baseline cost

**Disadvantages:**
- **Shared Throughput**: All tenants share quota limits
- **Careful Filter Design**: Must ensure proper isolation in rules
- **Complex Monitoring**: Metrics aggregated across all tenants

**Hybrid Approach:**
- **Premium Tenants**: Dedicated event buses
- **Standard Tenants**: Shared event bus with filtering
- **System Events**: Separate bus for platform-level events

**Access Control Patterns:**
```json
{
  "Effect": "Allow",
  "Principal": {"AWS": "arn:aws:iam::account:role/AgentRole"},
  "Action": "events:PutEvents",
  "Resource": "arn:aws:events:region:account:event-bus/chimera-*",
  "Condition": {
    "StringEquals": {
      "events:detail.tenantId": "${aws:PrincipalTag/TenantId}"
    }
  }
}
```

**Event Replay:**
EventBridge supports event archiving and replay:
- Archive events to S3 for long-term retention
- Replay events from specific time ranges
- Useful for disaster recovery and testing

## Amazon Kinesis

Amazon Kinesis Data Streams enables real-time collection, processing, and analysis of streaming data at scale. It's designed for high-throughput, low-latency ingestion of continuous data streams.

### Kinesis Data Streams

**Architecture:**
A Kinesis data stream consists of shards, where each shard provides a fixed unit of capacity:
- **Write**: 1,000 records/second or 1 MB/second per shard
- **Read**: 2 MB/second per shard (5 reads/second with GetRecords)
- **Enhanced Fan-Out**: 2 MB/second per consumer per shard

**Data Records:**
Each record consists of:
- **Sequence Number**: Unique identifier assigned by Kinesis
- **Partition Key**: Used to group data by shard (max 256 characters)
- **Data Blob**: The actual payload (up to 1 MB)

**Capacity Modes:**

1. **On-Demand Mode:**
   - Auto-scales based on throughput
   - Pay per GB ingested and retrieved
   - Default capacity: 4 MB/second write, 8 MB/second read
   - Scales up to accommodate traffic spikes
   - Best for unpredictable workloads

2. **Provisioned Mode:**
   - Specify number of shards upfront
   - Pay per shard-hour
   - Predictable costs
   - Manual or auto-scaling required
   - Best for steady, predictable workloads

**Ordering Guarantees:**
- Records with the same partition key go to the same shard
- Records within a shard are strictly ordered by sequence number
- Cross-shard ordering is not guaranteed

**Retention:**
- Default: 24 hours
- Extended: Up to 365 days (additional cost)
- Long-term: 365+ days with additional charges

**Producers:**
- **PutRecord**: Single record at a time
- **PutRecords**: Batch up to 500 records or 5 MB per request
- **Kinesis Producer Library (KPL)**: High-performance, asynchronous
- **Kinesis Agent**: Log file monitoring and shipping

**Consumers:**
- **Kinesis Client Library (KCL)**: Distributed consumer framework
- **Lambda**: Event source mapping with automatic batching
- **Kinesis Data Firehose**: Delivery to S3, Redshift, Elasticsearch
- **Kinesis Data Analytics**: Real-time SQL or Apache Flink processing

**Partition Key Strategy:**
Partition keys determine shard assignment via MD5 hash:
```python
shard_id = MD5(partition_key) % number_of_shards
```

**Best Practices:**
- Use high-cardinality partition keys to distribute load evenly
- Avoid hot shards by not using low-cardinality keys (e.g., single tenant ID for all records)
- Monitor shard metrics to identify hot spots

### Agent Activity Streaming

**Use Cases for Multi-Agent Platforms:**

1. **Real-Time Activity Logs:**
   - Stream all agent actions for monitoring
   - Detect anomalies in real-time
   - Feed into observability platforms

2. **Event Sourcing:**
   - Capture all state changes as immutable events
   - Rebuild agent state from event history
   - Audit trail for compliance

3. **Metrics and Analytics:**
   - Calculate real-time KPIs (throughput, latency, error rates)
   - Aggregate metrics across agents and tenants
   - Feed into dashboards and alerting systems

4. **Cross-Agent Coordination:**
   - Broadcast state changes to interested parties
   - Enable reactive workflows
   - Support complex event processing

**Architecture Example:**
```
Agent1 → PutRecords → Kinesis Stream → [Consumer1: Real-time Analytics]
Agent2 ↗                              → [Consumer2: Archival to S3]
Agent3 ↗                              → [Consumer3: Alerting System]
```

**Batching Strategy:**
```python
# Efficient batching with PutRecords
records = []
for event in agent_events:
    records.append({
        'Data': json.dumps(event),
        'PartitionKey': f"{event['tenantId']}-{event['agentId']}"
    })

    if len(records) >= 500:  # Max batch size
        response = kinesis.put_records(
            StreamName='agent-activity',
            Records=records
        )
        records = []
```

**Enhanced Fan-Out:**
For scenarios requiring multiple consumers with dedicated throughput:
- Each consumer gets 2 MB/second per shard
- No throttling between consumers
- Push-based delivery (vs. pull with GetRecords)
- Lower latency (~70ms vs ~200ms)

**Example:**
```
Stream (3 shards = 6 MB/s write) →
  Consumer1 (Enhanced): 6 MB/s read
  Consumer2 (Enhanced): 6 MB/s read
  Consumer3 (Standard): 6 MB/s shared
```

**Processing Patterns:**

1. **Real-Time Aggregation:**
   ```python
   # Windowed aggregation with KCL
   def process_records(records):
       window = defaultdict(int)
       for record in records:
           data = json.loads(record['Data'])
           key = f"{data['tenantId']}-{data['metric']}"
           window[key] += data['value']
       return window
   ```

2. **Stream Join:**
   Join multiple Kinesis streams for correlation:
   ```
   Agent Activity Stream
        +
   User Request Stream
        ↓
   Combined Analytics
   ```

3. **Replay and Recovery:**
   - Store shard iterator (sequence number)
   - Replay from specific point in time
   - Recover from consumer failures

### Multi-Tenant Sharding

**Partition Key Strategies:**

1. **Tenant-Based Partitioning:**
   ```python
   partition_key = f"{tenant_id}"
   ```
   - All events for a tenant go to the same shard
   - Good for per-tenant ordering
   - Risk: Hot tenants create hot shards

2. **Agent-Based Partitioning:**
   ```python
   partition_key = f"{tenant_id}-{agent_id}"
   ```
   - Distributes load across shards more evenly
   - Per-agent ordering maintained
   - Better load distribution

3. **Session-Based Partitioning:**
   ```python
   partition_key = f"{tenant_id}-{session_id}"
   ```
   - Groups events by user session
   - Maintains session ordering
   - Excellent load distribution

4. **Composite Key with Hash:**
   ```python
   partition_key = hashlib.md5(
       f"{tenant_id}-{agent_id}-{timestamp}".encode()
   ).hexdigest()
   ```
   - Maximum distribution
   - No ordering guarantees
   - Avoids all hot spots

**Tenant Isolation:**

**Dedicated Streams per Tenant:**
```
agent-activity-tenant-{tenantId}
```
- **Pros**: Complete isolation, independent scaling, per-tenant metrics
- **Cons**: Management overhead, minimum cost per stream

**Shared Stream with Logical Partitioning:**
```
agent-activity-shared
(partition key includes tenant_id)
```
- **Pros**: Resource efficiency, simpler management
- **Cons**: Shared capacity, requires careful partition key design

**Monitoring Hot Shards:**
CloudWatch metrics to track:
- `IncomingBytes` per shard
- `IncomingRecords` per shard
- `WriteProvisionedThroughputExceeded`
- `IteratorAgeMilliseconds` (consumer lag)

**Scaling Strategies:**

1. **Shard Splitting:**
   - Divide a hot shard into two
   - Maintains all data
   - Takes effect immediately

2. **Shard Merging:**
   - Combine two cold shards into one
   - Reduces costs
   - Use during low-traffic periods

3. **Auto-Scaling (On-Demand):**
   - Automatic capacity adjustment
   - No manual intervention
   - Pay for actual usage

**Cost Optimization:**
- Use on-demand mode for variable workloads
- Provision mode with reserved capacity for steady workloads
- Reduce retention period for non-critical streams
- Use Firehose for direct-to-S3 archival

## AWS Step Functions

AWS Step Functions is a serverless orchestration service that coordinates distributed applications and microservices using visual workflows called state machines. It's ideal for complex multi-step agent coordination.

### State Machine Orchestration

**State Machine Concepts:**
- **States**: Individual steps in the workflow
- **Transitions**: Connections between states
- **Input/Output**: Data passed between states
- **Amazon States Language (ASL)**: JSON-based workflow definition

**State Types:**

1. **Task**: Executes work (Lambda, ECS, Batch, SNS, SQS, DynamoDB, etc.)
2. **Choice**: Conditional branching based on input
3. **Parallel**: Execute multiple branches simultaneously
4. **Map**: Iterate over array items
5. **Wait**: Delay execution for specified time
6. **Pass**: Transform input without performing work
7. **Succeed/Fail**: Terminal states

**Agent Coordination Example:**
```json
{
  "Comment": "Multi-agent task coordination",
  "StartAt": "DistributeTasks",
  "States": {
    "DistributeTasks": {
      "Type": "Map",
      "ItemsPath": "$.tasks",
      "MaxConcurrency": 10,
      "Iterator": {
        "StartAt": "AssignToAgent",
        "States": {
          "AssignToAgent": {
            "Type": "Task",
            "Resource": "arn:aws:states:::sqs:sendMessage",
            "Parameters": {
              "QueueUrl": "https://sqs.region.amazonaws.com/account/agent-tasks",
              "MessageBody.$": "$"
            },
            "Next": "WaitForCompletion"
          },
          "WaitForCompletion": {
            "Type": "Task",
            "Resource": "arn:aws:states:::sqs:receiveMessage.waitForTaskToken",
            "TimeoutSeconds": 3600,
            "End": true
          }
        }
      },
      "Next": "AggregateResults"
    },
    "AggregateResults": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:region:account:function:aggregate",
      "End": true
    }
  }
}
```

**Error Handling:**
```json
{
  "Type": "Task",
  "Resource": "arn:aws:lambda:region:account:function:process",
  "Catch": [
    {
      "ErrorEquals": ["States.TaskFailed"],
      "ResultPath": "$.error",
      "Next": "HandleError"
    }
  ],
  "Retry": [
    {
      "ErrorEquals": ["States.Timeout", "Lambda.ServiceException"],
      "IntervalSeconds": 2,
      "MaxAttempts": 3,
      "BackoffRate": 2.0
    }
  ]
}
```

**Service Integrations:**

1. **Optimized Integrations** (`.sync`):
   - Run to completion before proceeding
   - Example: `arn:aws:states:::ecs:runTask.sync`

2. **Wait for Callback** (`.waitForTaskToken`):
   - Pass task token to external process
   - External process calls `SendTaskSuccess`/`SendTaskFailure`
   - Useful for human approval, long-running jobs

3. **Request/Response** (default):
   - Start task and immediately proceed
   - No waiting for completion

**Nested Workflows:**
Start child workflows for modularity:
```json
{
  "Type": "Task",
  "Resource": "arn:aws:states:::states:startExecution.sync:2",
  "Parameters": {
    "StateMachineArn": "arn:aws:states:region:account:stateMachine:child",
    "Input": {
      "tenant.$": "$.tenantId"
    }
  }
}
```

### Express vs Standard Workflows

**Standard Workflows:**

**Characteristics:**
- **Duration**: Up to 1 year
- **Execution Model**: Exactly-once
- **Pricing**: Per state transition ($0.025 per 1,000 transitions)
- **History**: Stored for 90 days (visible in console)
- **Use Cases**: Long-running workflows, auditable processes

**Features:**
- Full audit trail
- Visual execution history
- Supports all service integrations
- Automatic retry with exponential backoff
- Ideal for orchestrating non-idempotent actions

**Example Use Cases:**
- Multi-day approval workflows
- Batch processing jobs
- Data pipeline orchestration
- Order fulfillment processes

**Express Workflows:**

**Characteristics:**
- **Duration**: Up to 5 minutes
- **Execution Model**: At-least-once (async) or at-most-once (sync)
- **Pricing**: Per execution ($1.00 per million, $0.00001667 per GB-second)
- **History**: Optionally sent to CloudWatch Logs
- **Use Cases**: High-volume, event-driven processing

**Two Modes:**

1. **Synchronous Express:**
   - Wait for completion, return result
   - Invoked via API, Lambda, API Gateway
   - At-most-once execution
   - **Use Cases**: Request/response patterns, microservice orchestration

2. **Asynchronous Express:**
   - Fire-and-forget
   - Started by EventBridge, Lambda, SDK
   - At-least-once execution
   - **Use Cases**: Event processing, ETL, IoT data processing

**Comparison:**

| Feature | Standard | Express Sync | Express Async |
|---------|----------|--------------|---------------|
| Max Duration | 1 year | 5 minutes | 5 minutes |
| Execution Rate | 2,000/sec | 100,000+/sec | 100,000+/sec |
| Execution Model | Exactly-once | At-most-once | At-least-once |
| Pricing | Per transition | Per execution | Per execution |
| History | 90 days | CloudWatch Logs | CloudWatch Logs |
| Best For | Long workflows | High-throughput sync | High-throughput async |

**Cost Example:**
- **Standard**: 10,000 executions × 20 states = 200,000 transitions × $0.025/1000 = $5.00
- **Express**: 10,000 executions × $1.00/million = $0.01 (plus compute time)

**When to Use Each:**

**Standard:**
- Non-idempotent operations (financial transactions, state changes)
- Need for audit trail and visual debugging
- Long-running processes (hours/days)
- Complex error handling requirements

**Express:**
- Idempotent operations (data transformation, logging)
- High-volume event processing
- Short-duration tasks (<5 min)
- Cost optimization for high-throughput

**Combining Both:**
```
EventBridge → Express Workflow (validate & route)
                ↓
          Standard Workflow (process with retries)
                ↓
          Express Workflow (notify subscribers)
```

### Integration with Other Services

**Direct Service Integrations:**

1. **Lambda Functions:**
   ```json
   {
     "Type": "Task",
     "Resource": "arn:aws:lambda:region:account:function:name",
     "Parameters": {
       "Payload.$": "$"
     }
   }
   ```

2. **DynamoDB:**
   ```json
   {
     "Type": "Task",
     "Resource": "arn:aws:states:::dynamodb:putItem",
     "Parameters": {
       "TableName": "AgentState",
       "Item": {
         "agentId": {"S.$": "$.agentId"},
         "status": {"S": "processing"}
       }
     }
   }
   ```

3. **SQS:**
   ```json
   {
     "Type": "Task",
     "Resource": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
     "Parameters": {
       "QueueUrl": "https://sqs.region.amazonaws.com/account/queue",
       "MessageBody": {
         "taskToken.$": "$$.Task.Token",
         "payload.$": "$"
       }
     },
     "TimeoutSeconds": 3600
   }
   ```

4. **ECS/Fargate:**
   ```json
   {
     "Type": "Task",
     "Resource": "arn:aws:states:::ecs:runTask.sync",
     "Parameters": {
       "Cluster": "agent-cluster",
       "TaskDefinition": "process-task",
       "LaunchType": "FARGATE"
     }
   }
   ```

5. **EventBridge:**
   ```json
   {
     "Type": "Task",
     "Resource": "arn:aws:states:::events:putEvents",
     "Parameters": {
       "Entries": [{
         "Source": "chimera.workflow",
         "DetailType": "WorkflowCompleted",
         "Detail.$": "$"
       }]
     }
   }
   ```

**Callback Pattern:**
For long-running external processes:

1. State machine creates task token
2. Sends token to external system (via SQS, SNS, etc.)
3. External system processes work
4. Calls `SendTaskSuccess` with token and result
5. State machine continues with result

**Example:**
```python
# External agent receives message with task token
message = sqs.receive_message(QueueUrl=queue_url)
task_token = message['Body']['taskToken']

# Process work
result = process_task(message['Body']['payload'])

# Report completion
stepfunctions.send_task_success(
    taskToken=task_token,
    output=json.dumps(result)
)
```

**Timeouts and Heartbeats:**
```json
{
  "Type": "Task",
  "Resource": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
  "TimeoutSeconds": 3600,
  "HeartbeatSeconds": 60
}
```

External process must send heartbeats:
```python
stepfunctions.send_task_heartbeat(taskToken=token)
```

**Multi-Agent Coordination Patterns:**

1. **Parallel Execution:**
   ```json
   {
     "Type": "Parallel",
     "Branches": [
       {"StartAt": "Agent1Task", "States": {...}},
       {"StartAt": "Agent2Task", "States": {...}},
       {"StartAt": "Agent3Task", "States": {...}}
     ],
     "Next": "MergeResults"
   }
   ```

2. **Map over Agents:**
   ```json
   {
     "Type": "Map",
     "ItemsPath": "$.agents",
     "MaxConcurrency": 10,
     "Iterator": {
       "StartAt": "ProcessAgent",
       "States": {...}
     }
   }
   ```

3. **Saga Pattern (Distributed Transactions):**
   ```json
   {
     "StartAt": "ReserveInventory",
     "States": {
       "ReserveInventory": {
         "Type": "Task",
         "Resource": "arn:aws:lambda:...",
         "Catch": [{"ErrorEquals": ["States.ALL"], "Next": "CompensateAll"}],
         "Next": "ChargePayment"
       },
       "ChargePayment": {
         "Type": "Task",
         "Resource": "arn:aws:lambda:...",
         "Catch": [{"ErrorEquals": ["States.ALL"], "Next": "ReleaseInventory"}],
         "Next": "Success"
       },
       "CompensateAll": {...},
       "ReleaseInventory": {...}
     }
   }
   ```

## DynamoDB Streams

DynamoDB Streams captures item-level modifications in DynamoDB tables as a time-ordered sequence of change records. It enables reactive architectures where downstream systems respond to data changes in real-time.

### Change Data Capture

**Overview:**
DynamoDB Streams provides a 24-hour rolling window of item-level changes, enabling:
- Event-driven architectures
- Real-time replication
- Audit logging
- Data analytics pipelines

**Stream Record Contents:**
Each stream record includes:
- **Keys**: Primary key of modified item
- **NewImage**: Item state after modification
- **OldImage**: Item state before modification
- **StreamViewType**: Determines what data is written

**Stream View Types:**

1. **KEYS_ONLY**: Only key attributes
   ```json
   {
     "Keys": {
       "agentId": {"S": "agent-123"},
       "timestamp": {"N": "1679232000"}
     }
   }
   ```

2. **NEW_IMAGE**: Key + new item state
   ```json
   {
     "Keys": {...},
     "NewImage": {
       "agentId": {"S": "agent-123"},
       "status": {"S": "completed"},
       "result": {"S": "success"}
     }
   }
   ```

3. **OLD_IMAGE**: Key + old item state
4. **NEW_AND_OLD_IMAGES**: Key + both states

**Processing Patterns:**

1. **Lambda Trigger:**
   ```python
   def lambda_handler(event, context):
       for record in event['Records']:
           if record['eventName'] == 'INSERT':
               handle_insert(record['dynamodb']['NewImage'])
           elif record['eventName'] == 'MODIFY':
               handle_modify(
                   record['dynamodb']['OldImage'],
                   record['dynamodb']['NewImage']
               )
           elif record['eventName'] == 'REMOVE':
               handle_remove(record['dynamodb']['OldImage'])
   ```

2. **Kinesis Data Streams Integration:**
   - For >2 consumers (Streams supports max 2 simultaneous consumers/shard)
   - Longer retention (up to 365 days vs 24 hours)
   - Fan-out to multiple processors
   - Integration with Firehose for archival

**DynamoDB Streams vs Kinesis Data Streams:**

| Feature | DynamoDB Streams | Kinesis Integration |
|---------|------------------|---------------------|
| Retention | 24 hours | Up to 365 days |
| Consumers | 2 per shard | Unlimited (enhanced fan-out) |
| Ordering | Per item | Per partition key |
| Cost | Included | Separate charges |
| Latency | <1 second | <1 second |

**EventBridge Integration:**
For advanced routing and filtering:
```json
{
  "source": ["aws.dynamodb"],
  "detail-type": ["DynamoDB Stream Record"],
  "detail": {
    "eventName": ["MODIFY"],
    "dynamodb": {
      "NewImage": {
        "status": {"S": ["completed"]}
      }
    }
  }
}
```

**Use Cases for Agent Platforms:**

1. **Audit Trail:**
   ```
   DynamoDB (AgentState) → Stream → Lambda → S3 (Audit Logs)
   ```

2. **Real-Time Analytics:**
   ```
   DynamoDB → Stream → Lambda → CloudWatch Metrics
   ```

3. **Cross-Region Replication:**
   ```
   DynamoDB (us-east-1) → Stream → Lambda → DynamoDB (eu-west-1)
   ```

4. **Event Sourcing:**
   ```
   DynamoDB (Event Store) → Stream → Lambda → Projections/Read Models
   ```

**Best Practices:**
- Enable streams only when needed (adds write latency)
- Use batch processing in Lambda to reduce invocations
- Implement idempotent handlers (at-least-once delivery)
- Monitor IteratorAge metric for consumer lag

### Agent State Synchronization

**Real-Time State Replication:**
When agent state changes, interested parties can react immediately:

**Architecture Example:**
```
Agent updates DynamoDB (status: "processing" → "completed")
     ↓
DynamoDB Stream record
     ↓
Lambda function
     ↓
[Notify dashboard, Update metrics, Trigger next agent]
```

**Cross-Agent Coordination:**

1. **Dependency Management:**
   ```python
   def handle_agent_completion(record):
       agent_id = record['dynamodb']['Keys']['agentId']['S']
       status = record['dynamodb']['NewImage']['status']['S']

       if status == 'completed':
           # Check if all dependencies completed
           dependencies = get_dependencies(agent_id)
           if all_completed(dependencies):
               trigger_dependent_agent(agent_id)
   ```

2. **State Machine Triggers:**
   ```
   DynamoDB → Stream → Lambda → Step Functions (StartExecution)
   ```

3. **Pub/Sub Notifications:**
   ```
   DynamoDB → Stream → Lambda → SNS → [Multiple Subscribers]
   ```

**Materialized Views:**
Maintain denormalized views for read-heavy access patterns:
```
DynamoDB (Normalized) → Stream → Lambda → DynamoDB (Denormalized View)
```

**Example:**
```python
# Source table: AgentTasks
# Target table: TenantTaskSummary

def update_summary(record):
    tenant_id = record['dynamodb']['NewImage']['tenantId']['S']

    # Aggregate task counts
    summary = {
        'tenantId': tenant_id,
        'totalTasks': get_count(tenant_id),
        'completedTasks': get_completed_count(tenant_id),
        'avgDuration': get_avg_duration(tenant_id)
    }

    dynamo db.put_item(TableName='TenantTaskSummary', Item=summary)
```

**Conflict Resolution:**
For multi-region setups, handle conflicts when same item modified in different regions:
```python
def resolve_conflict(old_image, new_image):
    # Last-write-wins based on timestamp
    old_ts = int(old_image['timestamp']['N'])
    new_ts = int(new_image['timestamp']['N'])
    return new_image if new_ts > old_ts else old_image
```

**Monitoring:**
- **IteratorAge**: Time between record write and processing (should be low)
- **TrimmedRecordCount**: Records removed due to 24-hour limit (should be zero)
- **Lambda errors**: Failed processing attempts

## AppSync and GraphQL Subscriptions

AWS AppSync provides a managed GraphQL service with built-in real-time subscriptions over WebSocket, enabling bidirectional communication between agents and clients.

### Real-Time Updates

**GraphQL Subscriptions:**
Subscriptions are triggered by mutations, allowing clients to receive real-time updates when data changes:

**Schema Definition:**
```graphql
type Mutation {
  updateAgentStatus(agentId: ID!, status: String!): Agent
    @aws_iam
    @aws_cognito_user_pools
}

type Subscription {
  onAgentStatusChanged(agentId: ID, tenantId: ID): Agent
    @aws_subscribe(mutations: ["updateAgentStatus"])
}

type Agent {
  agentId: ID!
  tenantId: ID!
  status: String!
  lastUpdated: AWSDateTime!
}
```

**Subscription Workflow:**

1. **Client Connects:**
   - Establishes WebSocket to AppSync real-time endpoint
   - Authenticates via API key, IAM, Cognito, or Lambda

2. **Subscribe:**
   ```graphql
   subscription OnAgentStatusChanged {
     onAgentStatusChanged(tenantId: "tenant-123") {
       agentId
       status
       lastUpdated
     }
   }
   ```

3. **Mutation Triggers Subscription:**
   ```graphql
   mutation UpdateStatus {
     updateAgentStatus(agentId: "agent-456", status: "completed") {
       agentId
       status
     }
   }
   ```

4. **Subscribed Clients Receive Update:**
   All clients subscribed with matching filters receive the update in real-time.

**WebSocket Connection Management:**

**Connection Initialization:**
```javascript
const client = new AWSAppSyncClient({
  url: APPSYNC_GRAPHQL_ENDPOINT,
  region: 'us-east-1',
  auth: {
    type: AUTH_TYPE.AWS_IAM,
    credentials: () => Auth.currentCredentials()
  },
  disableOffline: true
});
```

**Subscription Lifecycle:**
```javascript
const subscription = client.subscribe({
  query: gql`
    subscription OnAgentUpdate($tenantId: ID!) {
      onAgentStatusChanged(tenantId: $tenantId) {
        agentId
        status
        metadata
      }
    }
  `,
  variables: { tenantId: 'tenant-123' }
}).subscribe({
  next: (data) => {
    console.log('Agent updated:', data);
    updateUI(data);
  },
  error: (error) => {
    console.error('Subscription error:', error);
    reconnect();
  }
});
```

**Keep-Alive Messages:**
AppSync sends periodic keep-alive messages to maintain the connection. Clients should:
- Respond to keep-alive pings
- Implement reconnection logic
- Handle connection timeouts gracefully

**Message Filtering:**
Subscriptions support arguments for server-side filtering:
```graphql
type Subscription {
  onAgentStatusChanged(
    agentId: ID
    tenantId: ID!
    status: String
  ): Agent
    @aws_subscribe(mutations: ["updateAgentStatus"])
}
```

**Authorization:**
Per-subscription authorization ensures clients only receive data they're allowed to access:

**Resolver Logic:**
```vtl
## Check if user can subscribe to this tenant's updates
#if($ctx.identity.claims.get("custom:tenantId") != $ctx.args.tenantId)
  $util.unauthorized()
#end
```

**Multi-Tenant Isolation:**
```graphql
subscription OnTenantAgentUpdates($tenantId: ID!) {
  onAgentStatusChanged(tenantId: $tenantId) {
    agentId
    status
  }
}
```

**Use Cases:**

1. **Dashboard Updates:**
   ```
   Agent Status Change → Mutation → Subscription → Live Dashboard
   ```

2. **Inter-Agent Communication:**
   ```
   Agent1 completes task → Mutation → Subscription → Agent2 starts next task
   ```

3. **User Notifications:**
   ```
   Task completed → Mutation → Subscription → User's browser/mobile app
   ```

**Performance Characteristics:**
- **Latency**: <100ms for mutation to subscription delivery
- **Scale**: Millions of concurrent subscriptions
- **Connection Duration**: Long-lived (hours/days)
- **Message Size**: Up to 128 KB per message

**Private APIs:**
For internal-only access, use VPC endpoints:
```
VPC → PrivateLink → AppSync GraphQL API
                  → AppSync Realtime API
```

### Federated Queries

**Data Source Federation:**
AppSync can combine data from multiple sources in a single GraphQL query:

**Supported Data Sources:**
- DynamoDB
- Aurora Serverless
- RDS Proxy
- Lambda
- HTTP endpoints
- Elasticsearch
- OpenSearch

**Schema Stitching Example:**
```graphql
type Agent {
  agentId: ID!
  status: String!        # From DynamoDB
  metrics: Metrics!      # From Lambda
  logs: [LogEntry!]!     # From Elasticsearch
}

type Metrics {
  tasksCompleted: Int!
  avgDuration: Float!
  successRate: Float!
}

type LogEntry {
  timestamp: AWSDateTime!
  level: String!
  message: String!
}
```

**Resolver Mapping:**
```yaml
Agent.status:
  DataSource: DynamoDBAgentTable
  Type: Query
  Field: getAgent

Agent.metrics:
  DataSource: MetricsLambda
  Type: Query
  Field: getAgentMetrics

Agent.logs:
  DataSource: ElasticsearchLogs
  Type: Query
  Field: searchLogs
```

**Pipeline Resolvers:**
Chain multiple data sources in sequence:
```javascript
// Step 1: Get agent from DynamoDB
const agent = await getDynamoDBAgent(agentId);

// Step 2: Enrich with metrics from Lambda
const metrics = await getMetrics(agentId);

// Step 3: Add logs from Elasticsearch
const logs = await searchLogs(agentId);

// Step 4: Combine and return
return { ...agent, metrics, logs };
```

**Batch Resolvers:**
Optimize N+1 query problems with DataLoader pattern:
```javascript
const batchGetAgents = async (agentIds) => {
  const result = await dynamodb.batchGetItem({
    RequestItems: {
      'Agents': {
        Keys: agentIds.map(id => ({ agentId: id }))
      }
    }
  });
  return result.Responses.Agents;
};
```

**Caching:**
AppSync supports caching at resolver level:
```yaml
Agent:
  DataSource: DynamoDBAgentTable
  Caching:
    ttl: 300  # 5 minutes
    keys:
      - $context.arguments.agentId
```

**Multi-Tenant Data Isolation:**
Resolvers enforce tenant boundaries:
```vtl
## Verify tenant access before querying
#set($tenantId = $ctx.identity.claims.get("custom:tenantId"))
#if($ctx.arguments.agentId.startsWith($tenantId))
  ## Query allowed
  $util.dynamodb.get($tableName, { agentId: $ctx.arguments.agentId })
#else
  ## Unauthorized access attempt
  $util.unauthorized()
#end
```

**Example Query:**
```graphql
query GetAgentDetails {
  agent(agentId: "tenant-A-agent-123") {
    agentId
    status
    metrics {
      tasksCompleted
      avgDuration
    }
    logs(limit: 10) {
      timestamp
      message
    }
  }
}
```

**Benefits of Federation:**
- **Single API**: Clients query one endpoint
- **Reduced Roundtrips**: Fetch related data in one request
- **Type Safety**: Strong typing across all data sources
- **Optimized**: Batch requests and caching

## Comparison Matrix

| Service | Latency | Throughput | Ordering | Cost Model | Multi-Tenant Strategy | Best For |
|---------|---------|------------|----------|------------|----------------------|----------|
| **SQS Standard** | <100ms | Unlimited | Best-effort | $0.40/million requests | Dedicated or shared queues with filtering | Async task distribution, decoupling services |
| **SQS FIFO** | <100ms | 3,000 msg/sec (300 TPS) | Strict per group | $0.50/million requests | Group ID per tenant+session | Ordered processing, exactly-once delivery |
| **SNS Standard** | <100ms | Unlimited | Best-effort | $0.50/million publishes | Topic per tenant or shared with filtering | Event broadcasting, fanout |
| **SNS FIFO** | <100ms | 3,000 msg/sec | Strict per group | $0.60/million publishes | Group ID per tenant | Ordered broadcast to SQS FIFO queues |
| **EventBridge** | <500ms | Unlimited | None | $1.00/million events | Custom bus per tenant or shared with rules | Complex event routing, cross-account |
| **Kinesis** | <200ms | 1 MB/sec per shard | Strict per partition key | $0.015/shard-hour + data | Partition key includes tenant ID | High-throughput streaming, analytics |
| **Step Functions Std** | Variable | 2,000/sec | Workflow defined | $0.025/1K transitions | Separate executions per tenant | Long-running orchestration, audit trails |
| **Step Functions Exp** | <100ms | 100,000+/sec | Workflow defined | $1.00/million executions | Separate executions per tenant | High-volume event processing, ETL |
| **DynamoDB Streams** | <1sec | Linked to table WCU | Per item | Included with table | Filter by tenant ID in stream | Real-time reactions to data changes |
| **AppSync** | <100ms | Millions of connections | Per subscription | $4.00/million ops | Filter in resolver/subscription | Real-time bidirectional updates |

### Detailed Cost Comparison

**Example Scenario**: 10 million agent messages/month

| Service | Monthly Cost | Notes |
|---------|--------------|-------|
| SQS Standard | $4.00 | $0.40/million requests (send + receive) |
| SQS FIFO | $5.00 | $0.50/million requests |
| SNS | $5.00 | $0.50/million publishes (plus delivery costs) |
| SNS + SQS Fan-out | $9.00 | SNS publish + SQS receive |
| EventBridge | $10.00 | $1.00/million events |
| Kinesis (10 shards) | $108 | $0.015/shard-hour × 10 × 24 × 30 |
| Step Functions Std (10 steps/exec) | $2,500 | $0.025/1K transitions × 10 steps × 10M |
| Step Functions Exp | $10 | $1.00/million executions |
| AppSync | $40 | $4.00/million operations |

### Throughput Scaling Comparison

| Service | Scaling Method | Limits | Time to Scale |
|---------|----------------|--------|---------------|
| SQS | Automatic | Virtually unlimited | Instant |
| SNS | Automatic | Virtually unlimited | Instant |
| EventBridge | Automatic | Soft limit ~2,400/sec (can increase) | Instant |
| Kinesis | Manual shard split/merge or on-demand | 500 shards per stream (soft limit) | Minutes |
| Step Functions | Automatic | Account-level quotas | Instant |
| DynamoDB Streams | Linked to table capacity | Scales with table | Instant |
| AppSync | Automatic | Millions of subscriptions | Instant |

## Recommendations

### When to Use Each Service

**Task Distribution & Work Queues:**
- **SQS Standard**: When order doesn't matter, need high throughput, and can handle duplicates
- **SQS FIFO**: When strict ordering required per session/tenant, exactly-once processing critical
- **Use Case**: Distributing agent tasks to worker pools, background job processing

**Event Broadcasting:**
- **SNS**: When multiple subscribers need same event immediately, simple pub/sub needed
- **SNS + SQS Fan-out**: When subscribers need durable delivery and independent processing
- **Use Case**: Agent completion notifications, system-wide alerts

**Complex Event Routing:**
- **EventBridge**: When need content-based routing, cross-account delivery, or integration with AWS services
- **Use Case**: Multi-tenant event routing, cross-region replication, AWS service integrations

**High-Throughput Streaming:**
- **Kinesis**: When need ordered, high-throughput data ingestion with multiple consumers and replay capability
- **Use Case**: Agent activity logs, metrics aggregation, real-time analytics

**Workflow Orchestration:**
- **Step Functions Standard**: Long-running workflows (hours/days), need audit trail, non-idempotent operations
- **Step Functions Express**: Short, high-volume (5 min), idempotent transformations
- **Use Case**: Multi-step agent coordination, data pipelines, saga patterns

**Change Data Capture:**
- **DynamoDB Streams**: When need to react to database changes, materialize views, or replicate data
- **Use Case**: Keeping caches in sync, triggering workflows on data changes

**Real-Time Bidirectional Communication:**
- **AppSync**: When clients need real-time updates via WebSocket, GraphQL API desired
- **Use Case**: Live dashboards, agent status updates, collaborative features

### Hybrid Patterns

**Pattern 1: Event-Driven Task Distribution**
```
Agent Completion Event
  → EventBridge (routing rules)
    → SQS FIFO Queues (per tenant)
      → Worker Agents (ordered processing)
```

**Benefits:**
- EventBridge handles complex routing
- SQS FIFO ensures ordered processing
- Decoupled producers and consumers

**Pattern 2: Reliable Fanout with Durability**
```
Agent Event
  → SNS Topic (immediate broadcast)
    → [SQS Queue 1 → Analytics]
    → [SQS Queue 2 → Audit Log]
    → [SQS Queue 3 → User Notifications]
```

**Benefits:**
- SNS provides instant fanout
- SQS provides durable queuing
- Independent failure domains

**Pattern 3: Stream Processing Pipeline**
```
Agents → Kinesis Stream
           ↓
    [Consumer 1: Real-time metrics → CloudWatch]
    [Consumer 2: Enrichment → Kinesis Stream 2]
    [Consumer 3: Archival → S3 via Firehose]
```

**Benefits:**
- Multiple consumers process in parallel
- Ordered processing maintained
- Replay capability for recovery

**Pattern 4: Orchestrated Multi-Agent Workflow**
```
User Request
  → API Gateway
    → Step Functions (Express)
      → [SQS] → Agent 1 → [Callback] →
      → [SQS] → Agent 2 → [Callback] →
      → Aggregate Results
```

**Benefits:**
- Step Functions coordinates workflow
- SQS decouples execution
- Callbacks enable long-running tasks

**Pattern 5: Event Sourcing + CQRS**
```
Command → DynamoDB (Write Model)
            ↓
      DynamoDB Streams
            ↓
    [Lambda → DynamoDB (Read Model 1)]
    [Lambda → DynamoDB (Read Model 2)]
    [Lambda → Kinesis → Analytics]
```

**Benefits:**
- Single source of truth
- Optimized read models
- Complete audit trail

**Pattern 6: Cross-Region Event Replication**
```
Region A: Agent → EventBridge
                    ↓ (cross-region rule)
Region B: EventBridge → Lambda → Process
```

**Benefits:**
- Low-latency local processing
- Geographic distribution
- Disaster recovery

### Cost Optimization

**Batching Strategies:**

1. **SQS Batch Operations:**
   ```python
   # Send up to 10 messages in one API call
   sqs.send_message_batch(
       QueueUrl=queue_url,
       Entries=[
           {'Id': str(i), 'MessageBody': json.dumps(msg)}
           for i, msg in enumerate(messages[:10])
       ]
   )
   ```

2. **Kinesis Batch Puts:**
   ```python
   # Put up to 500 records in one call
   kinesis.put_records(
       StreamName='stream',
       Records=[
           {'Data': json.dumps(record), 'PartitionKey': key}
           for record in batch[:500]
       ]
   )
   ```

3. **EventBridge Batch Events:**
   ```python
   # Put up to 10 events per call
   events.put_events(
       Entries=[
           {'Source': 'app', 'DetailType': 'event', 'Detail': json.dumps(e)}
           for e in events[:10]
       ]
   )
   ```

**Right-Sizing:**

- **SQS**: Use standard queues when FIFO not required ($0.10 savings per million)
- **Step Functions**: Use Express for high-volume, short workflows (up to 99% cost reduction)
- **Kinesis**: Use on-demand mode for variable workloads; provisioned for steady state
- **EventBridge**: Filter events early to reduce downstream processing costs

**Message Size Optimization:**

- **Use S3 for Large Payloads:**
  ```python
  # Store large data in S3, reference in message
  s3_key = f"messages/{uuid.uuid4()}.json"
  s3.put_object(Bucket=bucket, Key=s3_key, Body=json.dumps(large_data))

  sqs.send_message(
      QueueUrl=queue_url,
      MessageBody=json.dumps({'s3Bucket': bucket, 's3Key': s3_key})
  )
  ```

- **Compress Data:**
  ```python
  import gzip
  compressed = gzip.compress(json.dumps(data).encode())
  ```

**Reduce Redundant Processing:**

- **Use SNS message filtering** to avoid sending messages consumers will ignore
- **Use EventBridge patterns** to route events only to relevant targets
- **Use SQS visibility timeout** appropriately to avoid re-processing

**Reserved Capacity:**

- **Kinesis**: Purchase reserved capacity for steady-state workloads (up to 65% savings)
- **DynamoDB**: Reserved capacity for predictable throughput needs

### Monitoring and Observability

**CloudWatch Metrics to Monitor:**

**SQS:**
- `ApproximateNumberOfMessagesVisible`: Queue depth
- `ApproximateAgeOfOldestMessage`: Processing lag
- `NumberOfMessagesReceived`: Throughput
- `NumberOfMessagesSent`: Ingestion rate

**SNS:**
- `NumberOfMessagesPublished`: Messages sent
- `NumberOfNotificationsDelivered`: Successful deliveries
- `NumberOfNotificationsFailed`: Failed deliveries

**EventBridge:**
- `Invocations`: Rules triggered
- `FailedInvocations`: Failed rule executions
- `ThrottledRules`: Rules hitting limits

**Kinesis:**
- `IncomingBytes` / `IncomingRecords`: Write throughput
- `GetRecords.IteratorAgeMilliseconds`: Consumer lag
- `WriteProvisionedThroughputExceeded`: Throttling
- `ReadProvisionedThroughputExceeded`: Read throttling

**Step Functions:**
- `ExecutionsStarted`: New executions
- `ExecutionsFailed`: Failed workflows
- `ExecutionTime`: Duration distribution

**DynamoDB Streams:**
- `IteratorAge`: Processing lag
- `TrimmedDataAccessAttemptsCount`: Missed records

**Distributed Tracing:**

**AWS X-Ray Integration:**
```python
from aws_xray_sdk.core import xray_recorder
from aws_xray_sdk.core import patch_all

patch_all()  # Patch AWS SDK calls

@xray_recorder.capture('process_message')
def process_message(message):
    # Add metadata
    xray_recorder.current_segment().put_metadata('tenantId', message['tenantId'])

    # Add annotations (indexed)
    xray_recorder.current_segment().put_annotation('messageType', message['type'])

    # Process...
```

**Trace ID Propagation:**
Pass trace IDs through messaging:
```python
trace_id = os.environ.get('_X_AMZN_TRACE_ID')

sqs.send_message(
    QueueUrl=queue_url,
    MessageBody=json.dumps(message),
    MessageAttributes={
        'TraceId': {'StringValue': trace_id, 'DataType': 'String'}
    }
)
```

**Structured Logging:**
```python
import json
import logging

logger = logging.getLogger()

def log_event(event_type, tenant_id, **kwargs):
    log_entry = {
        'timestamp': datetime.utcnow().isoformat(),
        'eventType': event_type,
        'tenantId': tenant_id,
        **kwargs
    }
    logger.info(json.dumps(log_entry))
```

**Alerting Strategy:**

**Critical Alerts (PagerDuty/SNS):**
- SQS DLQ depth > 0
- Kinesis IteratorAge > 60 seconds
- Step Functions failure rate > 5%
- EventBridge throttling

**Warning Alerts (Email/Slack):**
- SQS queue depth > 1000 messages
- Processing latency > P95 threshold
- Cost anomalies (>20% over baseline)

**Dashboard Metrics:**
- Real-time throughput graphs
- Error rate trends
- Latency percentiles (P50, P95, P99)
- Per-tenant metrics breakdown

## References

### AWS Documentation

**SQS:**
- [Amazon SQS Developer Guide](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/)
- [SQS FIFO Queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues.html)
- [Using Message Group IDs](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagegroupid-property.html)

**SNS:**
- [Amazon SNS Developer Guide](https://docs.aws.amazon.com/sns/latest/dg/)
- [Message Filtering](https://docs.aws.amazon.com/sns/latest/dg/sns-message-filtering.html)
- [SNS FIFO Topics](https://docs.aws.amazon.com/sns/latest/dg/fifo-topics.html)

**EventBridge:**
- [Amazon EventBridge User Guide](https://docs.aws.amazon.com/eventbridge/latest/userguide/)
- [Event Patterns](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html)
- [Cross-Account Event Delivery](https://aws.amazon.com/blogs/compute/introducing-cross-account-targets-for-amazon-eventbridge-event-buses/)

**Kinesis:**
- [Amazon Kinesis Data Streams Developer Guide](https://docs.aws.amazon.com/streams/latest/dev/)
- [Kinesis Data Streams Concepts](https://docs.aws.amazon.com/streams/latest/dev/key-concepts.html)

**Step Functions:**
- [AWS Step Functions Developer Guide](https://docs.aws.amazon.com/step-functions/latest/dg/)
- [Choosing Workflow Type](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)
- [Service Integrations](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-service-integrations.html)

**DynamoDB Streams:**
- [DynamoDB Streams](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html)
- [Kinesis Data Streams Integration](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/kds.html)

**AppSync:**
- [AWS AppSync Developer Guide](https://docs.aws.amazon.com/appsync/latest/devguide/)
- [Real-Time Data](https://docs.aws.amazon.com/appsync/latest/devguide/aws-appsync-real-time-data.html)
- [WebSocket Client](https://docs.aws.amazon.com/appsync/latest/devguide/real-time-websocket-client.html)

### AWS Prescriptive Guidance

- [Saga Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-data-persistence/saga-pattern.html)
- [Circuit Breaker Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/circuit-breaker.html)
- [Workflow Orchestration Agents](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/workflow-orchestration-agents.html)

### AWS Architecture Blog Posts

- [Event-Driven Architecture Patterns](https://aws.amazon.com/event-driven-architecture/)
- [Microservices Messaging Patterns](https://aws.amazon.com/blogs/compute/)
- [Multi-Tenant SaaS Architecture](https://aws.amazon.com/blogs/apn/tag/saas/)
