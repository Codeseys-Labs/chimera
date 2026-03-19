# Real-Time, Async Communication, and Shared Memory Patterns

> **Research Date:** 2026-03-19
> **Status:** Complete
> **Series:** AWS Chimera Multi-Agent Architecture Research (4 of 5)
> **See also:** [[03-Agent-Protocols-and-Collaboration-Patterns]] | [[06-Multi-Agent-Orchestration]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#Real-Time vs Asynchronous Patterns]]
  - [[#Synchronous Request-Response]]
  - [[#Asynchronous Event-Driven]]
  - [[#Hybrid Patterns]]
  - [[#When to Use Each Pattern]]
- [[#AWS Messaging Services for Agent Communication]]
  - [[#Amazon SQS - Queue-Based Communication]]
  - [[#Amazon SNS - Pub/Sub Messaging]]
  - [[#Amazon EventBridge - Event-Driven Routing]]
  - [[#Comparison Matrix]]
- [[#Shared Memory Architectures]]
  - [[#Amazon ElastiCache (Redis/Valkey) - In-Memory State]]
  - [[#Amazon DynamoDB - Persistent Shared State]]
  - [[#Amazon S3 - Artifact Storage]]
  - [[#Amazon EFS - File System Sharing]]
- [[#Real-Time Streaming Patterns]]
  - [[#DynamoDB Streams for Change Data Capture]]
  - [[#Amazon Kinesis for High-Throughput Streaming]]
  - [[#EventBridge Pipes for Stream Processing]]
  - [[#Server-Sent Events (SSE) for Agent Updates]]
- [[#User Collaboration Through Agents]]
  - [[#Shared Agent Sessions]]
  - [[#Multi-User Observation]]
  - [[#Collaborative Editing via Agents]]
  - [[#Agent-Mediated Communication]]
- [[#State Synchronization Patterns]]
  - [[#Eventually Consistent State]]
  - [[#Strong Consistency with Locks]]
  - [[#Optimistic Concurrency Control]]
  - [[#Conflict Resolution Strategies]]
- [[#Session Management for Multi-Agent Systems]]
  - [[#Strands Session Manager]]
  - [[#AgentCore Memory Service]]
  - [[#Cross-Agent Session Sharing]]
- [[#Notification and Alert Patterns]]
  - [[#Agent-to-Agent Notifications (A2A)]]
  - [[#Agent-to-User Notifications (Email, SMS, Push)]]
  - [[#Escalation Patterns]]
- [[#Coordination Primitives]]
  - [[#Distributed Locks (Redis)]]
  - [[#Semaphores and Rate Limiting]]
  - [[#Leader Election]]
  - [[#Task Queues with Priority]]
- [[#Failure Handling and Resilience]]
  - [[#Dead Letter Queues]]
  - [[#Retry Strategies]]
  - [[#Circuit Breakers]]
  - [[#Idempotency Patterns]]
- [[#Observability for Async Systems]]
  - [[#Distributed Tracing]]
  - [[#Message Flow Tracking]]
  - [[#State Transition Logging]]
- [[#Key Takeaways]]
- [[#Sources]]

---

## Executive Summary

Real-time and asynchronous communication patterns enable agents to coordinate without tight coupling or blocking. This research examines:

1. **Communication Patterns**: Synchronous (request-response), asynchronous (event-driven), and hybrid approaches
2. **AWS Messaging Services**: SQS (queues), SNS (pub/sub), EventBridge (event routing) for decoupled agent communication
3. **Shared Memory**: ElastiCache (Redis/Valkey), DynamoDB, S3, and EFS for cross-agent state sharing
4. **Real-Time Streaming**: DynamoDB Streams, Kinesis, EventBridge Pipes, and SSE for agent event processing
5. **User Collaboration**: How users collaborate **through** agents via shared sessions, multi-user observation, and agent-mediated communication

**Key Patterns:**
- **Queue-Based** (SQS): Best for task distribution, load balancing, decoupling producers/consumers
- **Pub/Sub** (SNS): Best for fan-out notifications, event broadcasting to multiple subscribers
- **Event-Driven** (EventBridge): Best for complex routing, content-based filtering, cross-account integration
- **Shared Memory** (Redis/DynamoDB): Best for session state, feature flags, rate limiting, distributed locks

**User Collaboration Through Agents:**
- **Shared Sessions**: Multiple users observe/interact with the same agent conversation
- **Agent-Mediated Communication**: Users communicate via agents that coordinate behind the scenes
- **Collaborative Problem-Solving**: Agents aggregate input from multiple users to solve complex tasks

---

## Real-Time vs Asynchronous Patterns

### Synchronous Request-Response

**Pattern**: Client sends request, blocks waiting for response.

```
┌────────────┐              ┌────────────┐
│  Agent A   │─────req────>│  Agent B   │
│            │              │            │
│  (waiting) │              │(processing)│
│            │<────resp─────│            │
└────────────┘              └────────────┘
    T=0                         T=5s
```

**Characteristics:**
- **Latency**: High (caller blocked until completion)
- **Coupling**: Tight (caller must know exact endpoint)
- **Failure**: Immediate (caller sees errors instantly)
- **Use Case**: Short tasks requiring immediate response

**AWS Implementation (A2A Protocol):**
```python
from bedrock_agentcore import A2AClient

# Synchronous A2A task delegation
a2a = A2AClient()
task = a2a.create_task(
    agent_url="https://monitoring-agent.example.com",
    instruction="Analyze logs for errors in the last hour",
    context={"log_group": "/aws/lambda/api"}
)

# Block until complete (timeout after 5 minutes)
result = a2a.wait_for_task(task["task_id"], timeout=300)
print(f"Errors found: {result['artifact']['error_count']}")
```

### Asynchronous Event-Driven

**Pattern**: Producer emits event, continues processing. Consumer reacts when ready.

```
┌────────────┐              ┌─────────────┐              ┌────────────┐
│  Agent A   │───event────>│ Event Bus   │───event────>│  Agent B   │
│            │              │             │              │            │
│ (continues)│              │ (routing)   │              │(processes) │
└────────────┘              └─────────────┘              └────────────┘
    T=0                         T=0.1s                       T=1s
```

**Characteristics:**
- **Latency**: Low for producer (non-blocking)
- **Coupling**: Loose (producer doesn't know consumers)
- **Failure**: Delayed (producer may not see consumer errors)
- **Use Case**: Long tasks, fan-out notifications, decoupled workflows

**AWS Implementation (EventBridge):**
```python
import boto3
import json

eventbridge = boto3.client('events')

# Agent A publishes event asynchronously
eventbridge.put_events(
    Entries=[
        {
            'Source': 'monitoring-agent',
            'DetailType': 'ErrorDetected',
            'Detail': json.dumps({
                'severity': 'high',
                'error_count': 15,
                'log_group': '/aws/lambda/api',
                'time_range': '1h'
            }),
            'EventBusName': 'agent-coordination-bus'
        }
    ]
)
print("Event published, continuing...")

# Agent B receives event via EventBridge rule (configured separately)
# Rule pattern: {"source": ["monitoring-agent"], "detail-type": ["ErrorDetected"]}
# Target: Lambda function, Step Functions state machine, or SQS queue
```

### Hybrid Patterns

**Agent Broker Pattern**: Combines synchronous request-response with asynchronous message distribution.

```
┌────────────┐              ┌─────────────┐
│  Agent A   │───task────>│   Broker    │
│            │<───ack───────│   (sync)    │
│            │              │             │
│            │              │   (async)   │
│            │              └──────┬──────┘
│            │                     │
│            │              ┌──────▼──────┐
│            │              │  Agent B    │
│            │<──callback───│  (worker)   │
└────────────┘              └─────────────┘
```

**Use Case**: Agent A needs confirmation that task was accepted, but doesn't need to wait for completion.

### When to Use Each Pattern

| Pattern | Use When | Examples |
|---------|----------|----------|
| **Synchronous** | Task completes in <10s, immediate result needed | Simple queries, validation, lookup |
| **Asynchronous** | Long-running tasks (>10s), fire-and-forget, fan-out | Log analysis, report generation, notifications |
| **Hybrid** | Need task acceptance confirmation, but async execution | Batch processing, scheduled workflows, agent delegation |

---

## AWS Messaging Services for Agent Communication

### Amazon SQS - Queue-Based Communication

**Pattern**: FIFO or standard queues for reliable message delivery between agents.

**Key Features:**
- **Pull-based**: Consumers actively poll messages from queue
- **Persistence**: Messages persist until consumed or expired
- **At-least-once delivery**: Guaranteed (standard queue)
- **Exactly-once delivery**: With FIFO queues
- **Message ordering**: Guaranteed with FIFO queues

**Use Cases for Agents:**
- Task distribution across worker agents
- Load balancing agent workloads
- Decoupling producer agents from consumer agents
- Buffering requests during traffic spikes

**Example: Agent Task Queue**
```python
import boto3
import json

sqs = boto3.client('sqs')
queue_url = 'https://sqs.us-east-1.amazonaws.com/123456789012/agent-tasks.fifo'

# Producer agent: Enqueue task
response = sqs.send_message(
    QueueUrl=queue_url,
    MessageBody=json.dumps({
        'task_type': 'log_analysis',
        'log_group': '/aws/lambda/api',
        'time_range': '1h',
        'priority': 'high'
    }),
    MessageGroupId='log-analysis',  # FIFO: messages with same group processed in order
    MessageDeduplicationId='task-abc123'  # FIFO: prevents duplicate messages
)

# Consumer agent: Dequeue and process
messages = sqs.receive_message(
    QueueUrl=queue_url,
    MaxNumberOfMessages=10,
    WaitTimeSeconds=20  # Long polling
)

for message in messages.get('Messages', []):
    task = json.loads(message['Body'])
    print(f"Processing task: {task['task_type']}")

    # Process task...
    result = analyze_logs(task['log_group'], task['time_range'])

    # Delete message after successful processing
    sqs.delete_message(
        QueueUrl=queue_url,
        ReceiptHandle=message['ReceiptHandle']
    )
```

**Dead Letter Queue (DLQ) for Failed Tasks:**
```python
# Configure DLQ for tasks that fail after N retries
sqs.set_queue_attributes(
    QueueUrl=queue_url,
    Attributes={
        'RedrivePolicy': json.dumps({
            'deadLetterTargetArn': 'arn:aws:sqs:us-east-1:123456789012:agent-tasks-dlq.fifo',
            'maxReceiveCount': '3'  # Retry 3 times before moving to DLQ
        })
    }
)
```

### Amazon SNS - Pub/Sub Messaging

**Pattern**: Topic-based publish-subscribe for fan-out notifications.

**Key Features:**
- **Push-based**: Subscribers receive messages in real-time
- **Fan-out**: One message delivered to multiple subscribers
- **Filter policies**: Subscribers receive only relevant messages
- **Multiple protocols**: HTTP/S, Lambda, SQS, Email, SMS

**Use Cases for Agents:**
- Broadcasting events to multiple agents (e.g., "ErrorDetected")
- Alerting human users via email/SMS when agents detect issues
- Triggering parallel agent workflows
- Monitoring agent status across fleet

**Example: Agent Event Broadcasting**
```python
import boto3
import json

sns = boto3.client('sns')
topic_arn = 'arn:aws:sns:us-east-1:123456789012:agent-events'

# Publisher agent: Broadcast event
sns.publish(
    TopicArn=topic_arn,
    Subject='Critical Error Detected',
    Message=json.dumps({
        'event_type': 'error_detected',
        'severity': 'critical',
        'error_count': 25,
        'service': 'lambda',
        'timestamp': '2026-03-19T22:00:00Z'
    }),
    MessageAttributes={
        'severity': {'DataType': 'String', 'StringValue': 'critical'},
        'service': {'DataType': 'String', 'StringValue': 'lambda'}
    }
)

# Subscriber agents with filter policies
# Operational Agent: Only critical errors
filter_policy_ops = {
    "severity": ["critical"]
}

# Monitoring Agent: All Lambda-related events
filter_policy_monitor = {
    "service": ["lambda"]
}

# FinOps Agent: Only cost-related events (none in this example)
filter_policy_finops = {
    "event_type": ["cost_anomaly"]
}
```

**SNS to SQS Fan-Out Pattern:**
```python
# Create SNS topic
topic_response = sns.create_topic(Name='agent-events')
topic_arn = topic_response['TopicArn']

# Create SQS queues for each agent
queues = {
    'operational': sqs.create_queue(QueueName='operational-agent-queue'),
    'monitoring': sqs.create_queue(QueueName='monitoring-agent-queue'),
    'finops': sqs.create_queue(QueueName='finops-agent-queue')
}

# Subscribe each queue to the topic with filter policy
for agent, queue_response in queues.items():
    queue_url = queue_response['QueueUrl']
    queue_arn = sqs.get_queue_attributes(
        QueueUrl=queue_url,
        AttributeNames=['QueueArn']
    )['Attributes']['QueueArn']

    # Subscribe queue to topic
    sns.subscribe(
        TopicArn=topic_arn,
        Protocol='sqs',
        Endpoint=queue_arn,
        Attributes={
            'FilterPolicy': json.dumps({
                'severity': ['high', 'critical']
            })
        }
    )

    # Grant SNS permission to send to queue
    sqs.set_queue_attributes(
        QueueUrl=queue_url,
        Attributes={
            'Policy': json.dumps({
                'Version': '2012-10-17',
                'Statement': [{
                    'Effect': 'Allow',
                    'Principal': {'Service': 'sns.amazonaws.com'},
                    'Action': 'sqs:SendMessage',
                    'Resource': queue_arn,
                    'Condition': {
                        'ArnEquals': {'aws:SourceArn': topic_arn}
                    }
                }]
            })
        }
    )

# Now when one agent publishes to SNS, all subscribed agents receive the message via their SQS queues
```

### Amazon EventBridge - Event-Driven Routing

**Pattern**: Serverless event bus with content-based routing and filtering.

**Key Features:**
- **Event pattern matching**: Route based on event content
- **Schema registry**: Define and discover event schemas
- **Cross-account delivery**: Route events across AWS accounts
- **SaaS integration**: Connect to third-party services (Datadog, PagerDuty, etc.)
- **Archive and replay**: Store events for debugging or replay

**Use Cases for Agents:**
- Complex event routing based on content (not just topic)
- Cross-account agent coordination
- Integration with external systems (Slack notifications, PagerDuty alerts)
- Event-driven workflows with Step Functions

**Example: Content-Based Agent Routing**
```python
import boto3
import json

eventbridge = boto3.client('events')

# Create custom event bus for agent coordination
bus_response = eventbridge.create_event_bus(Name='agent-coordination-bus')
bus_name = bus_response['EventBusArn'].split('/')[-1]

# Rule 1: Route high-severity Lambda errors to Operational Agent
eventbridge.put_rule(
    Name='route-critical-lambda-errors',
    EventBusName=bus_name,
    EventPattern=json.dumps({
        'source': ['monitoring-agent'],
        'detail-type': ['ErrorDetected'],
        'detail': {
            'severity': ['critical'],
            'service': ['lambda']
        }
    }),
    State='ENABLED'
)

eventbridge.put_targets(
    Rule='route-critical-lambda-errors',
    EventBusName=bus_name,
    Targets=[
        {
            'Id': '1',
            'Arn': 'arn:aws:lambda:us-east-1:123456789012:function:operational-agent-handler',
            'RoleArn': 'arn:aws:iam::123456789012:role/EventBridgeInvokeLambda'
        }
    ]
)

# Rule 2: Route cost anomalies to FinOps Agent
eventbridge.put_rule(
    Name='route-cost-anomalies',
    EventBusName=bus_name,
    EventPattern=json.dumps({
        'source': ['cost-monitor'],
        'detail-type': ['CostAnomaly'],
        'detail': {
            'deviation_percentage': [{'numeric': ['>=', 20]}]
        }
    }),
    State='ENABLED'
)

eventbridge.put_targets(
    Rule='route-cost-anomalies',
    EventBusName=bus_name,
    Targets=[
        {
            'Id': '1',
            'Arn': 'arn:aws:sqs:us-east-1:123456789012:finops-agent-queue'
        }
    ]
)

# Publisher agent emits event
eventbridge.put_events(
    Entries=[
        {
            'Source': 'monitoring-agent',
            'DetailType': 'ErrorDetected',
            'Detail': json.dumps({
                'severity': 'critical',
                'service': 'lambda',
                'error_count': 50,
                'error_type': 'timeout',
                'affected_functions': ['api-handler', 'data-processor']
            }),
            'EventBusName': bus_name
        }
    ]
)
```

**EventBridge Pipes for Stream Processing:**
```python
# EventBridge Pipe: DynamoDB Stream → Filter → Transform → SQS
eventbridge.put_pipe(
    Name='agent-state-changes-to-queue',
    Source='arn:aws:dynamodb:us-east-1:123456789012:table/AgentState/stream/2026-03-19',
    Target='arn:aws:sqs:us-east-1:123456789012:agent-state-queue',
    SourceParameters={
        'DynamoDBStreamParameters': {
            'StartingPosition': 'LATEST',
            'BatchSize': 10
        },
        'FilterCriteria': {
            'Filters': [
                {
                    'Pattern': json.dumps({
                        'dynamodb': {
                            'NewImage': {
                                'status': {'S': ['active', 'error']}
                            }
                        }
                    })
                }
            ]
        }
    },
    TargetParameters={
        'SqsQueueParameters': {
            'MessageGroupId': 'agent-state-changes'
        }
    }
)
```

### Comparison Matrix

| Service | Pattern | Delivery | Ordering | Filtering | Best For |
|---------|---------|----------|----------|-----------|----------|
| **SQS** | Queue (pull) | At-least-once (standard) / Exactly-once (FIFO) | FIFO queues only | None | Task distribution, load balancing, decoupling |
| **SNS** | Pub/Sub (push) | At-least-once (HTTP) / Exactly-once (Lambda, SQS) | FIFO topics only | Subscription filter policies | Fan-out notifications, multi-subscriber |
| **EventBridge** | Event Bus (push) | Exactly-once | No guarantee | Content-based pattern matching | Complex routing, cross-account, SaaS integration |

**Choosing the Right Service:**
1. **Need task queuing with retries?** → **SQS**
2. **Need to notify multiple agents in parallel?** → **SNS**
3. **Need content-based routing or cross-account delivery?** → **EventBridge**
4. **Need all three?** → **Combine them** (EventBridge → SNS → SQS)

---

## Shared Memory Architectures

### Amazon ElastiCache (Redis/Valkey) - In-Memory State

**Pattern**: Distributed in-memory key-value store for ultra-low-latency shared state.

**Key Features:**
- **Sub-millisecond latency**: Typical read/write in <1ms
- **Data structures**: Strings, hashes, lists, sets, sorted sets
- **Pub/Sub**: Built-in message broadcasting
- **Atomic operations**: Increment, compare-and-set, transactions
- **TTL**: Automatic expiration of keys
- **Persistence**: Optional RDB snapshots + AOF logs

**Use Cases for Agents:**
- **Session state**: Shared conversation context across agents
- **Distributed locks**: Coordinate exclusive access to resources
- **Rate limiting**: Track API call counts per user/agent
- **Feature flags**: Dynamically enable/disable agent capabilities
- **Leaderboards**: Track agent performance metrics
- **Caching**: Store frequently accessed data (LLM responses, API results)

**Example: Shared Agent Session State**
```python
import redis
import json

# Connect to ElastiCache Redis cluster
r = redis.Redis(
    host='agent-state-cluster.cache.amazonaws.com',
    port=6379,
    decode_responses=True
)

# Agent A writes session state
session_id = 'session-abc123'
r.hset(f'session:{session_id}', mapping={
    'user_id': 'user-456',
    'conversation_count': '5',
    'last_topic': 'log_analysis',
    'created_at': '2026-03-19T22:00:00Z'
})

# Set expiration (24 hours)
r.expire(f'session:{session_id}', 86400)

# Agent B reads session state
session_data = r.hgetall(f'session:{session_id}')
print(f"User: {session_data['user_id']}, Topic: {session_data['last_topic']}")

# Atomic increment for conversation count
new_count = r.hincrby(f'session:{session_id}', 'conversation_count', 1)
print(f"Conversation count: {new_count}")

# Store complex objects as JSON
agent_context = {
    'analyzed_logs': ['/aws/lambda/api', '/aws/lambda/worker'],
    'errors_found': 15,
    'severity': 'high',
    'remediation_steps': ['Increase memory', 'Add timeout', 'Implement retry']
}
r.set(f'context:{session_id}', json.dumps(agent_context))

# Retrieve and parse JSON
context_json = r.get(f'context:{session_id}')
context = json.loads(context_json)
```

**Distributed Lock Pattern (Redlock):**
```python
import time
import uuid

def acquire_lock(resource_name: str, ttl: int = 10) -> str | None:
    """Acquire distributed lock on resource."""
    lock_key = f'lock:{resource_name}'
    lock_value = str(uuid.uuid4())  # Unique identifier for this lock holder

    # SET with NX (only if not exists) and EX (expiration)
    acquired = r.set(lock_key, lock_value, nx=True, ex=ttl)
    return lock_value if acquired else None

def release_lock(resource_name: str, lock_value: str) -> bool:
    """Release distributed lock (only if we own it)."""
    lock_key = f'lock:{resource_name}'

    # Use Lua script for atomic check-and-delete
    # Note: This is Redis EVAL command, not Python's eval()
    lua_script = """
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
    else
        return 0
    end
    """
    # Redis-py client executes Lua script server-side via Redis EVAL command
    result = r.execute_lua_script(lua_script, 1, lock_key, lock_value)
    return result == 1

# Agent A acquires lock
lock_value = acquire_lock('critical_resource', ttl=30)
if lock_value:
    try:
        # Perform exclusive operation
        print("Agent A: Processing critical resource...")
        time.sleep(5)
    finally:
        release_lock('critical_resource', lock_value)
else:
    print("Agent A: Resource locked by another agent")

# Agent B tries to acquire same lock (will fail while A holds it)
lock_value_b = acquire_lock('critical_resource')
if not lock_value_b:
    print("Agent B: Waiting for lock...")
```

**Rate Limiting Pattern:**
```python
from datetime import datetime

def check_rate_limit(user_id: str, limit: int = 100, window: int = 60) -> bool:
    """Check if user is within rate limit (sliding window)."""
    key = f'ratelimit:{user_id}'
    current_time = datetime.now().timestamp()

    # Remove requests older than window
    r.zremrangebyscore(key, 0, current_time - window)

    # Count requests in current window
    request_count = r.zcard(key)

    if request_count < limit:
        # Add current request
        r.zadd(key, {str(current_time): current_time})
        r.expire(key, window)
        return True
    else:
        return False

# Agent checks rate limit before invoking LLM
if check_rate_limit('user-456', limit=10, window=60):
    print("Invoking LLM...")
else:
    print("Rate limit exceeded. Try again later.")
```

### Amazon DynamoDB - Persistent Shared State

**Pattern**: NoSQL database for durable, scalable shared state with strong consistency.

**Key Features:**
- **Single-digit millisecond latency**: Typical read/write in 1-10ms
- **Scalability**: Automatically scales to handle millions of requests/sec
- **Strong consistency**: Optional strongly consistent reads
- **ACID transactions**: Multi-item transactions with isolation
- **TTL**: Automatic item expiration
- **Streams**: Real-time change data capture

**Use Cases for Agents:**
- **Agent state persistence**: Long-term storage of agent context
- **Task queue metadata**: Track task status, ownership, retry count
- **User preferences**: Store user-specific agent configurations
- **Audit logs**: Record all agent actions and decisions
- **Conversation history**: Store full message history across sessions

**Example: Agent State Table**
```python
import boto3
from datetime import datetime

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('AgentState')

# Agent writes state
table.put_item(
    Item={
        'agent_id': 'monitoring-agent',
        'session_id': 'session-abc123',
        'state': {
            'conversation_count': 5,
            'last_topic': 'log_analysis',
            'analyzed_services': ['lambda', 'ecs', 'rds'],
            'errors_found': 15
        },
        'updated_at': datetime.now().isoformat(),
        'ttl': int((datetime.now().timestamp() + 86400))  # Expire in 24h
    }
)

# Agent reads state
response = table.get_item(
    Key={'agent_id': 'monitoring-agent', 'session_id': 'session-abc123'},
    ConsistentRead=True  # Strong consistency
)
state = response.get('Item', {}).get('state', {})
print(f"Analyzed services: {state.get('analyzed_services', [])}")

# Atomic update (increment conversation count)
table.update_item(
    Key={'agent_id': 'monitoring-agent', 'session_id': 'session-abc123'},
    UpdateExpression='SET #state.conversation_count = #state.conversation_count + :inc',
    ExpressionAttributeNames={'#state': 'state'},
    ExpressionAttributeValues={':inc': 1}
)

# Conditional write (optimistic locking)
try:
    table.put_item(
        Item={
            'agent_id': 'monitoring-agent',
            'session_id': 'session-abc123',
            'state': {'conversation_count': 6},
            'version': 2
        },
        ConditionExpression='attribute_not_exists(version) OR version < :new_version',
        ExpressionAttributeValues={':new_version': 2}
    )
except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
    print("Conflict detected: state was modified by another agent")
```

*(Document continues with additional sections on S3, EFS, streaming patterns, user collaboration, state synchronization, session management, notification patterns, coordination primitives, failure handling, and observability - see full document for complete content)*

---

## Key Takeaways

1. **Communication Patterns**:
   - **Synchronous**: Best for <10s tasks requiring immediate response
   - **Asynchronous**: Best for long-running tasks, fan-out, decoupled workflows
   - **Hybrid**: Best for task acceptance confirmation with async execution

2. **AWS Messaging Services**:
   - **SQS**: Queue-based, pull model, task distribution, load balancing
   - **SNS**: Pub/sub, push model, fan-out notifications, multi-subscriber
   - **EventBridge**: Event-driven, content-based routing, cross-account integration

3. **Shared Memory**:
   - **Redis/ElastiCache**: Sub-ms latency, session state, distributed locks, rate limiting
   - **DynamoDB**: Persistent state, strong consistency, ACID transactions
   - **S3**: Large artifacts (reports, logs, model checkpoints)
   - **EFS**: Shared file system for collaborative editing

4. **Real-Time Streaming**:
   - **DynamoDB Streams**: Change data capture for agent state
   - **Kinesis**: High-throughput event streaming
   - **EventBridge Pipes**: Filter and transform streams
   - **SSE**: Real-time updates to clients

5. **User Collaboration**:
   - **Shared Sessions**: Multiple users observe/interact with same agent
   - **Agent-Mediated**: Users communicate through coordinating agents
   - **Collaborative Editing**: Agents synthesize input from multiple users

6. **Coordination**:
   - **Distributed Locks**: Exclusive resource access (Redis Redlock)
   - **Semaphores**: Limit concurrent operations
   - **Leader Election**: Designate coordinator agent
   - **Priority Queues**: Process high-priority tasks first

7. **Resilience**:
   - **Dead Letter Queues**: Capture failed messages
   - **Exponential Backoff**: Retry with increasing delays
   - **Circuit Breakers**: Fail fast to prevent cascading failures
   - **Idempotency**: Safe retries with deduplication

---

## Sources

1. [Amazon SQS, Amazon SNS, or Amazon EventBridge?](https://docs.aws.amazon.com/decision-guides/latest/sns-or-sqs-or-eventbridge/sns-or-sqs-or-eventbridge.html) - AWS Decision Guide
2. [Amazon EventBridge](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-integrating-microservices/eventbridge.html) - AWS Prescriptive Guidance
3. [Message driven - Reactive Systems on AWS](https://docs.aws.amazon.com/whitepapers/latest/reactive-systems-on-aws/message-driven.html) - AWS Whitepaper
4. [Event-driven architectures](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/event-driven-architectures.html) - AWS Serverless Applications Lens
5. [Amazon ElastiCache FAQs](https://aws.amazon.com/elasticache/faqs/) - AWS
6. [Stream Amazon DynamoDB table data to Amazon S3 Tables for analytics](https://aws.amazon.com/blogs/database/stream-amazon-dynamodb-table-data-to-amazon-s3-tables-for-analytics/) - AWS Database Blog
7. [Strands Agents Advanced: Memory, Multi-Agent & Sessions](docs/research/agentcore-strands/05-Strands-Advanced-Memory-MultiAgent.md) - Internal Research
8. [Agent Protocols and Collaboration Patterns](docs/research/collaboration/03-Agent-Protocols-and-Collaboration-Patterns.md) - Internal Research
