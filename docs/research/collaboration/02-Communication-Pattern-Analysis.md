---
title: Communication Pattern Analysis for Multi-Agent Systems
purpose: Analyze communication patterns and their implementation using AWS services
project: AWS Chimera
domain: architecture/communication
status: draft
created: 2026-03-19
---

# Communication Pattern Analysis for Multi-Agent Systems

## Introduction

Multi-agent systems require carefully designed communication patterns to coordinate work, share state, and react to events. The choice of communication pattern significantly impacts system characteristics including latency, scalability, reliability, and maintainability.

This document analyzes communication patterns applicable to distributed agent architectures, examining their implementations using AWS services. Each pattern addresses specific coordination challenges and comes with distinct trade-offs in complexity, performance, and operational overhead.

**Pattern Categories:**
- **Synchronous vs Asynchronous**: Blocking vs non-blocking communication
- **Request-Response**: Direct queries and replies
- **Event-Driven**: Reactive, loosely-coupled architectures
- **Message Queues**: Durable, ordered task distribution
- **Publish-Subscribe**: One-to-many event broadcasting
- **Stream Processing**: Continuous data flow and aggregation
- **Orchestration vs Choreography**: Centralized vs decentralized coordination

Understanding these patterns enables architects to compose robust, scalable multi-agent systems that meet specific requirements for ordering, consistency, latency, and fault tolerance.

## Synchronous vs Asynchronous Communication

The fundamental choice between synchronous and asynchronous communication shapes the entire architecture of a multi-agent system.

### Synchronous Patterns

**Characteristics:**
- Caller blocks waiting for response
- Direct coupling between caller and callee
- Immediate feedback on success/failure
- Response returned in same connection/session

**Implementation Approaches:**

1. **HTTP/REST APIs:**
   ```python
   # Agent calls another agent synchronously
   response = requests.post(
       'https://agent-api.example.com/process',
       json={'taskId': '123', 'tenantId': 'tenant-A'},
       timeout=30  # Must specify timeout
   )

   result = response.json()
   # Continue processing with result
   ```

2. **gRPC:**
   ```python
   import grpc
   from agent_pb2_grpc import AgentServiceStub

   channel = grpc.insecure_channel('agent:50051')
   stub = AgentServiceStub(channel)

   response = stub.ProcessTask(
       ProcessTaskRequest(task_id='123'),
       timeout=30
   )
   ```

3. **GraphQL Queries:**
   ```graphql
   query GetAgentStatus {
     agent(id: "agent-123") {
       status
       currentTask {
         id
         progress
       }
     }
   }
   ```

**AWS Services for Sync Patterns:**
- **API Gateway + Lambda**: RESTful APIs with immediate response
- **AppSync**: GraphQL queries (non-subscription)
- **ALB + ECS/Fargate**: Container-based microservices
- **Step Functions Express (Sync)**: Orchestrated workflows with response

**When to Use:**
- Need immediate confirmation (e.g., user-facing operations)
- Result required for next step in processing
- Simple request-response interactions
- Low-latency requirements (<100ms)

**Challenges:**
- **Cascading Failures**: If callee is down, caller is blocked
- **Tight Coupling**: Changes to callee may break callers
- **Resource Utilization**: Threads/connections held during wait
- **Timeout Management**: Must handle timeouts gracefully
- **Scalability**: Limited by slowest service in chain

**Best Practices:**
```python
from tenacity import retry, stop_after_attempt, wait_exponential

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10)
)
def call_agent_sync(agent_id, payload):
    try:
        response = requests.post(
            f'https://agent-{agent_id}.internal/process',
            json=payload,
            timeout=5  # Short timeout
        )
        response.raise_for_status()
        return response.json()

    except requests.Timeout:
        # Log and potentially use circuit breaker
        logger.warning(f"Agent {agent_id} timeout")
        raise

    except requests.RequestException as e:
        logger.error(f"Agent {agent_id} error: {e}")
        raise
```

### Asynchronous Patterns

**Characteristics:**
- Caller doesn't wait for response
- Decoupled via message broker or event bus
- Eventual consistency
- Fire-and-forget or callback-based

**Implementation Approaches:**

1. **Message Queue (SQS):**
   ```python
   # Agent publishes task asynchronously
   sqs.send_message(
       QueueUrl=queue_url,
       MessageBody=json.dumps({
           'taskId': '123',
           'tenantId': 'tenant-A',
           'action': 'process'
       })
   )
   # Continue without waiting

   # Consumer processes later
   messages = sqs.receive_message(QueueUrl=queue_url)
   for msg in messages.get('Messages', []):
       process_task(json.loads(msg['Body']))
       sqs.delete_message(
           QueueUrl=queue_url,
           ReceiptHandle=msg['ReceiptHandle']
       )
   ```

2. **Event Publishing (EventBridge):**
   ```python
   # Publish event without waiting for consumers
   events.put_events(
       Entries=[{
           'Source': 'chimera.agent',
           'DetailType': 'TaskCompleted',
           'Detail': json.dumps({
               'taskId': '123',
               'status': 'completed'
           })
       }]
   )
   ```

3. **Stream Publishing (Kinesis):**
   ```python
   kinesis.put_record(
       StreamName='agent-activity',
       Data=json.dumps(event),
       PartitionKey=f"{tenant_id}-{agent_id}"
   )
   ```

**AWS Services for Async Patterns:**
- **SQS**: Durable message queuing
- **SNS**: Pub/sub event distribution
- **EventBridge**: Complex event routing
- **Kinesis**: High-throughput streaming
- **Step Functions (Async Express)**: Fire-and-forget workflows

**When to Use:**
- Long-running operations (>30 seconds)
- Don't need immediate response
- Want to decouple services
- Need buffering/load leveling
- Handling variable workloads

**Benefits:**
- **Decoupling**: Services evolve independently
- **Resilience**: Failures isolated, queues provide buffering
- **Scalability**: Consumers scale independently
- **Load Leveling**: Queue absorbs traffic spikes

**Challenges:**
- **Complexity**: More moving parts to manage
- **Debugging**: Harder to trace request flow
- **Eventual Consistency**: Results available later
- **Ordering**: May need explicit sequencing
- **Error Handling**: Must handle async failures

**Callback Pattern:**
For cases needing async with eventual response:
```python
# Producer sends task with callback URL
sqs.send_message(
    QueueUrl=queue_url,
    MessageBody=json.dumps({
        'taskId': '123',
        'callbackUrl': 'https://api.example.com/callbacks/123',
        'callbackToken': 'secret-token'
    })
)

# Consumer processes and calls back
def process_with_callback(message):
    result = process_task(message['taskId'])

    # Call back with result
    requests.post(
        message['callbackUrl'],
        json={'result': result},
        headers={'Authorization': f"Bearer {message['callbackToken']}"}
    )
```

### Trade-offs

| Aspect | Synchronous | Asynchronous |
|--------|-------------|--------------|
| **Latency** | Low (immediate) | Higher (queued) |
| **Coupling** | Tight | Loose |
| **Complexity** | Lower | Higher |
| **Reliability** | Depends on all services | Isolated failures |
| **Scalability** | Limited | High |
| **Consistency** | Immediate | Eventual |
| **Debugging** | Easier (stack traces) | Harder (distributed traces) |
| **Resource Usage** | Threads held | Released immediately |
| **Error Handling** | Exceptions | DLQ, retries, monitoring |
| **Use Cases** | User-facing, queries | Background tasks, events |

**Latency Comparison:**
```
Synchronous:
User → API (10ms) → Service A (50ms) → Service B (100ms)
Total: 160ms (sequential)

Asynchronous:
User → API (10ms) → SQS (5ms) → return
Total user-facing: 15ms
Background: Service A (50ms) & Service B (100ms) in parallel
```

**Choosing the Right Approach:**

**Use Synchronous When:**
- User waiting for response
- Need strong consistency
- Simple, low-latency operations
- Transactional operations requiring immediate feedback

**Use Asynchronous When:**
- Background processing acceptable
- Long-running operations (>30s)
- Need high throughput
- Want fault isolation
- Decoupling desired

**Hybrid Approach:**
Many systems use both:
```
User Request → API (Sync) → Queue Task (Async) → Return TaskID
                             ↓
                          Worker Process (Async)
                             ↓
                          Callback/Webhook (Async)
                             or
                          Polling Endpoint (Sync)
```

## Request-Response Patterns

Request-response is a fundamental communication pattern where one party sends a request and expects a response. Implementation varies based on whether communication is synchronous or asynchronous.

### Direct Request-Response

**HTTP/REST APIs:**
The most common pattern for synchronous request-response:

**Architecture:**
```
Client → HTTP Request → Server → Process → HTTP Response → Client
```

**Implementation with API Gateway + Lambda:**
```python
# API Gateway Lambda handler
def lambda_handler(event, context):
    # Parse request
    body = json.loads(event['body'])
    tenant_id = body['tenantId']
    task = body['task']

    # Process
    result = process_task(task, tenant_id)

    # Return response
    return {
        'statusCode': 200,
        'body': json.dumps({'result': result}),
        'headers': {'Content-Type': 'application/json'}
    }
```

**Best Practices:**
- **Timeouts**: Always set client timeouts (5-30s typical)
- **Idempotency**: Use idempotency keys for retries
- **Error Codes**: Use appropriate HTTP status codes
- **Rate Limiting**: Implement per-tenant rate limits
- **Caching**: Cache responses when appropriate

**gRPC for High Performance:**
```protobuf
service AgentService {
  rpc ProcessTask (TaskRequest) returns (TaskResponse) {}
  rpc StreamTasks (TaskRequest) returns (stream TaskUpdate) {}
}

message TaskRequest {
  string task_id = 1;
  string tenant_id = 2;
  map<string, string> metadata = 3;
}

message TaskResponse {
  string status = 1;
  bytes result = 2;
}
```

**Implementation:**
```python
class AgentServicer(agent_pb2_grpc.AgentServiceServicer):
    def ProcessTask(self, request, context):
        # Validate tenant access
        if not validate_tenant(request.tenant_id, context.metadata()):
            context.abort(grpc.StatusCode.PERMISSION_DENIED, "Unauthorized")

        # Process
        result = process_task(request.task_id)

        return agent_pb2.TaskResponse(
            status='completed',
            result=result
        )
```

**When to Use:**
- Latency-critical operations (<100ms)
- User-facing APIs
- Simple query operations
- When result needed immediately

### Message-Based Request-Response

For asynchronous request-response, use message queues with correlation IDs:

**Pattern 1: Request-Reply Queues:**
```
Requester → Request Queue → Worker
             ↓              ↓
        (correlation ID)   Process
                           ↓
        Reply Queue ← Reply (with correlation ID)
             ↓
        Requester (matches correlation ID)
```

**Implementation:**
```python
import uuid

class AsyncRequestResponse:
    def __init__(self):
        self.request_queue = 'agent-requests'
        self.reply_queue = 'agent-replies'
        self.pending_requests = {}

    def send_request(self, payload):
        # Generate correlation ID
        correlation_id = str(uuid.uuid4())

        # Send request
        sqs.send_message(
            QueueUrl=self.request_queue,
            MessageBody=json.dumps(payload),
            MessageAttributes={
                'CorrelationId': {
                    'StringValue': correlation_id,
                    'DataType': 'String'
                },
                'ReplyTo': {
                    'StringValue': self.reply_queue,
                    'DataType': 'String'
                }
            }
        )

        # Track pending request
        future = asyncio.Future()
        self.pending_requests[correlation_id] = future
        return future

    async def process_replies(self):
        while True:
            messages = sqs.receive_message(
                QueueUrl=self.reply_queue,
                MessageAttributeNames=['CorrelationId']
            )

            for msg in messages.get('Messages', []):
                corr_id = msg['MessageAttributes']['CorrelationId']['StringValue']
                future = self.pending_requests.pop(corr_id, None)

                if future:
                    future.set_result(json.loads(msg['Body']))

                sqs.delete_message(
                    QueueUrl=self.reply_queue,
                    ReceiptHandle=msg['ReceiptHandle']
                )

# Worker processes requests
def worker():
    while True:
        messages = sqs.receive_message(
            QueueUrl='agent-requests',
            MessageAttributeNames=['All']
        )

        for msg in messages.get('Messages', []):
            payload = json.loads(msg['Body'])
            corr_id = msg['MessageAttributes']['CorrelationId']['StringValue']
            reply_queue = msg['MessageAttributes']['ReplyTo']['StringValue']

            # Process
            result = process_task(payload)

            # Send reply
            sqs.send_message(
                QueueUrl=reply_queue,
                MessageBody=json.dumps(result),
                MessageAttributes={
                    'CorrelationId': {
                        'StringValue': corr_id,
                        'DataType': 'String'
                    }
                }
            )

            # Delete request
            sqs.delete_message(
                QueueUrl='agent-requests',
                ReceiptHandle=msg['ReceiptHandle']
            )
```

**Pattern 2: Step Functions Callback:**
```json
{
  "Type": "Task",
  "Resource": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
  "Parameters": {
    "QueueUrl": "https://sqs.region.amazonaws.com/account/tasks",
    "MessageBody": {
      "task.$": "$.task",
      "taskToken.$": "$$.Task.Token"
    }
  },
  "TimeoutSeconds": 3600
}
```

Worker sends response:
```python
stepfunctions.send_task_success(
    taskToken=task_token,
    output=json.dumps(result)
)
```

**Pattern 3: DynamoDB as Response Store:**
```python
# Requester
request_id = str(uuid.uuid4())

# Store pending request
dynamodb.put_item(
    TableName='PendingRequests',
    Item={
        'requestId': request_id,
        'status': 'pending',
        'ttl': int(time.time()) + 3600
    }
)

# Send to queue
sqs.send_message(
    QueueUrl=queue_url,
    MessageBody=json.dumps({'requestId': request_id, 'task': task})
)

# Poll for response
while True:
    response = dynamodb.get_item(
        TableName='PendingRequests',
        Key={'requestId': request_id}
    )
    if response['Item']['status'] == 'completed':
        return response['Item']['result']
    time.sleep(1)

# Worker
def process_request(request_id, task):
    result = process(task)

    dynamodb.update_item(
        TableName='PendingRequests',
        Key={'requestId': request_id},
        UpdateExpression='SET #status = :status, #result = :result',
        ExpressionAttributeNames={
            '#status': 'status',
            '#result': 'result'
        },
        ExpressionAttributeValues={
            ':status': 'completed',
            ':result': result
        }
    )
```

### Timeout and Error Handling

**Timeout Strategies:**

1. **Client-Side Timeouts:**
   ```python
   try:
       response = requests.post(url, json=data, timeout=5)
   except requests.Timeout:
       # Handle timeout
       logger.error("Request timed out")
       # Retry or fail gracefully
   ```

2. **Server-Side Timeouts:**
   ```python
   # Lambda timeout
   def lambda_handler(event, context):
       remaining_time = context.get_remaining_time_in_millis()
       if remaining_time < 5000:  # Less than 5s left
           raise TimeoutError("Insufficient time to complete")
   ```

3. **Step Functions Timeouts:**
   ```json
   {
     "Type": "Task",
     "Resource": "arn:aws:lambda:...",
     "TimeoutSeconds": 300,
     "HeartbeatSeconds": 60
   }
   ```

**Retry Strategies:**

**Exponential Backoff:**
```python
import time
import random

def exponential_backoff_retry(func, max_attempts=5):
    for attempt in range(max_attempts):
        try:
            return func()
        except Exception as e:
            if attempt == max_attempts - 1:
                raise

            # Exponential backoff with jitter
            wait_time = (2 ** attempt) + random.uniform(0, 1)
            logger.warning(f"Attempt {attempt+1} failed, retrying in {wait_time}s")
            time.sleep(wait_time)
```

**AWS SDK Built-in Retries:**
```python
from botocore.config import Config

config = Config(
    retries={
        'max_attempts': 3,
        'mode': 'adaptive'  # or 'standard', 'legacy'
    }
)

client = boto3.client('sqs', config=config)
```

**Idempotency:**
```python
# Idempotency with DynamoDB
def idempotent_process(idempotency_key, task):
    try:
        # Try to insert idempotency record
        dynamodb.put_item(
            TableName='IdempotencyRecords',
            Item={
                'key': idempotency_key,
                'status': 'processing',
                'ttl': int(time.time()) + 86400
            },
            ConditionExpression='attribute_not_exists(#key)',
            ExpressionAttributeNames={'#key': 'key'}
        )

        # Process task
        result = process(task)

        # Update with result
        dynamodb.update_item(
            TableName='IdempotencyRecords',
            Key={'key': idempotency_key},
            UpdateExpression='SET #status = :status, #result = :result',
            ExpressionAttributeNames={
                '#status': 'status',
                '#result': 'result'
            },
            ExpressionAttributeValues={
                ':status': 'completed',
                ':result': result
            }
        )

        return result

    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            # Already processed, return cached result
            response = dynamodb.get_item(
                TableName='IdempotencyRecords',
                Key={'key': idempotency_key}
            )
            return response['Item']['result']
        raise
```

**Circuit Breaker Pattern:**
```python
from enum import Enum
from datetime import datetime, timedelta

class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

class CircuitBreaker:
    def __init__(self, failure_threshold=5, timeout=60):
        self.failure_threshold = failure_threshold
        self.timeout = timeout
        self.failure_count = 0
        self.last_failure_time = None
        self.state = CircuitState.CLOSED

    def call(self, func):
        if self.state == CircuitState.OPEN:
            # Check if timeout expired
            if datetime.now() - self.last_failure_time > timedelta(seconds=self.timeout):
                self.state = CircuitState.HALF_OPEN
            else:
                raise Exception("Circuit breaker is OPEN")

        try:
            result = func()

            # Success - reset if half-open
            if self.state == CircuitState.HALF_OPEN:
                self.state = CircuitState.CLOSED
                self.failure_count = 0

            return result

        except Exception as e:
            self.failure_count += 1
            self.last_failure_time = datetime.now()

            if self.failure_count >= self.failure_threshold:
                self.state = CircuitState.OPEN

            raise

# Usage
breaker = CircuitBreaker(failure_threshold=3, timeout=30)

try:
    result = breaker.call(lambda: call_agent_api(agent_id))
except Exception as e:
    logger.error(f"Call failed or circuit open: {e}")
```

## Event-Driven Patterns

Event-driven architectures enable loose coupling and reactive processing. Events represent facts about what happened in the system.

### Event Notification

**Concept:**
Lightweight notifications that something happened, without carrying full state. Consumers react by querying for additional information if needed.

**Implementation:**
```python
# Publisher sends minimal event
events.put_events(
    Entries=[{
        'Source': 'chimera.agents',
        'DetailType': 'AgentTaskCompleted',
        'Detail': json.dumps({
            'agentId': 'agent-123',
            'taskId': 'task-456',
            'timestamp': datetime.utcnow().isoformat()
        })
    }]
)

# Consumer retrieves full state
def handle_task_completed(event):
    task_id = event['detail']['taskId']

    # Fetch full task details
    task = dynamodb.get_item(
        TableName='Tasks',
        Key={'taskId': task_id}
    )['Item']

    # Process with complete information
    process_completed_task(task)
```

**Benefits:**
- **Small Message Size**: Lower bandwidth and costs
- **Flexibility**: Consumers decide what data they need
- **Decoupling**: Publishers don't need to know consumer data needs

**Challenges:**
- **Additional Queries**: Consumers must fetch data
- **Consistency**: State might change between event and query
- **Network Calls**: More API calls required

**When to Use:**
- Event payload would be very large
- Different consumers need different data
- State changes frequently

### Event-Carried State Transfer

**Concept:**
Events carry complete state, eliminating need for consumers to query back. Enables complete decoupling.

**Implementation:**
```python
# Publisher sends full state
events.put_events(
    Entries=[{
        'Source': 'chimera.agents',
        'DetailType': 'AgentTaskCompleted',
        'Detail': json.dumps({
            'agentId': 'agent-123',
            'taskId': 'task-456',
            'tenantId': 'tenant-A',
            'status': 'completed',
            'duration': 1500,
            'result': {
                'outputFiles': ['s3://bucket/output1.json'],
                'metrics': {'processed': 1000, 'errors': 0}
            },
            'metadata': {
                'startTime': '2026-03-19T10:00:00Z',
                'endTime': '2026-03-19T10:25:00Z'
            }
        })
    }]
)

# Consumer has everything needed
def handle_task_completed(event):
    # No additional queries needed
    agent_id = event['detail']['agentId']
    duration = event['detail']['duration']
    result = event['detail']['result']

    # Process immediately
    update_metrics(agent_id, duration)
    archive_results(result)
```

**Benefits:**
- **No Additional Queries**: All data in event
- **Lower Latency**: No round-trips to fetch data
- **Temporal Decoupling**: Consumers work with consistent snapshot
- **Offline Processing**: Can process without source system available

**Challenges:**
- **Larger Messages**: Higher bandwidth and costs
- **Data Duplication**: Same data in multiple places
- **Schema Evolution**: Changes impact all consumers

**When to Use:**
- Want to eliminate consumer queries
- State relatively small (<256 KB)
- Need consistent snapshot of state
- Consumers are geographically distributed

### Event Sourcing

**Concept:**
Store all changes as a sequence of immutable events. Current state is derived by replaying events.

**Architecture:**
```
Commands → Event Store (Append-Only)
              ↓
         Event Handlers → Read Models / Projections
              ↓
         Query Services
```

**Implementation:**
```python
# Event store in DynamoDB
def store_event(aggregate_id, event_type, event_data):
    event_id = str(uuid.uuid4())

    dynamodb.put_item(
        TableName='EventStore',
        Item={
            'aggregateId': aggregate_id,
            'eventId': event_id,
            'eventType': event_type,
            'eventData': json.dumps(event_data),
            'timestamp': int(time.time() * 1000),
            'version': get_next_version(aggregate_id)
        }
    )

    return event_id

# Example: Agent state events
store_event('agent-123', 'AgentCreated', {
    'agentId': 'agent-123',
    'tenantId': 'tenant-A',
    'type': 'worker'
})

store_event('agent-123', 'TaskAssigned', {
    'taskId': 'task-456',
    'priority': 'high'
})

store_event('agent-123', 'TaskCompleted', {
    'taskId': 'task-456',
    'result': 'success',
    'duration': 1500
})

# Rebuild state by replaying events
def get_agent_state(agent_id):
    events = dynamodb.query(
        TableName='EventStore',
        KeyConditionExpression='aggregateId = :id',
        ExpressionAttributeValues={':id': agent_id},
        ScanIndexForward=True  # Oldest first
    )['Items']

    state = {}
    for event in events:
        state = apply_event(state, event)

    return state

def apply_event(state, event):
    event_type = event['eventType']
    event_data = json.loads(event['eventData'])

    if event_type == 'AgentCreated':
        return {
            'agentId': event_data['agentId'],
            'tenantId': event_data['tenantId'],
            'type': event_data['type'],
            'tasks': []
        }
    elif event_type == 'TaskAssigned':
        state['tasks'].append({
            'taskId': event_data['taskId'],
            'status': 'assigned'
        })
    elif event_type == 'TaskCompleted':
        for task in state['tasks']:
            if task['taskId'] == event_data['taskId']:
                task['status'] = 'completed'
                task['result'] = event_data['result']

    return state
```

**Projections/Read Models:**
```python
# Maintain denormalized view via DynamoDB Streams
def update_read_model(event_record):
    event_type = event_record['dynamodb']['NewImage']['eventType']['S']
    event_data = json.loads(event_record['dynamodb']['NewImage']['eventData']['S'])

    if event_type == 'TaskCompleted':
        # Update agent summary
        dynamodb.update_item(
            TableName='AgentSummary',
            Key={'agentId': event_data['agentId']},
            UpdateExpression='ADD completedTasks :one SET lastActivity = :time',
            ExpressionAttributeValues={
                ':one': 1,
                ':time': int(time.time())
            }
        )
```

**Benefits:**
- **Complete Audit Trail**: Every change recorded
- **Temporal Queries**: Query state at any point in time
- **Debugging**: Replay events to reproduce issues
- **Multiple Projections**: Different read models from same events
- **Analytics**: Rich history for analysis

**Challenges:**
- **Complexity**: More complex than CRUD
- **Event Schema Evolution**: Must handle schema changes
- **Performance**: Replaying many events can be slow
- **Storage**: Grows indefinitely (need archival strategy)

**When to Use:**
- Need complete audit trail
- Temporal queries required
- Complex domain with evolving requirements
- Multiple views of same data

### Domain Events

**Concept:**
Business-level events representing significant occurrences in the domain, not just technical state changes.

**Examples:**
- `TenantOnboarded` (not just `TenantCreated`)
- `SubscriptionUpgraded` (not just `SubscriptionModified`)
- `PaymentFailed` (triggers business processes)
- `SLAViolated` (requires action)

**Implementation:**
```python
# Domain event with business meaning
class TenantOnboardedEvent:
    def __init__(self, tenant_id, plan, sales_rep):
        self.event_id = str(uuid.uuid4())
        self.event_type = 'TenantOnboarded'
        self.timestamp = datetime.utcnow()
        self.tenant_id = tenant_id
        self.plan = plan
        self.sales_rep = sales_rep

    def to_dict(self):
        return {
            'eventId': self.event_id,
            'eventType': self.event_type,
            'timestamp': self.timestamp.isoformat(),
            'tenantId': self.tenant_id,
            'plan': self.plan,
            'salesRep': self.sales_rep
        }

# Publish to EventBridge
def publish_domain_event(event):
    events.put_events(
        Entries=[{
            'Source': 'chimera.domain',
            'DetailType': event.event_type,
            'Detail': json.dumps(event.to_dict())
        }]
    )

# Multiple handlers react to business event
def on_tenant_onboarded(event):
    tenant_id = event['detail']['tenantId']
    plan = event['detail']['plan']

    # Provision resources
    provision_tenant_infrastructure(tenant_id, plan)

    # Send welcome email
    send_welcome_email(tenant_id)

    # Notify sales
    notify_sales_team(event['detail']['salesRep'], tenant_id)

    # Start trial period
    schedule_trial_end_reminder(tenant_id)
```

**Bounded Contexts:**
Events define boundaries between contexts:
```
Billing Context:
  - PaymentProcessed
  - InvoiceGenerated

Agent Execution Context:
  - TaskAssigned
  - TaskCompleted

Analytics Context:
  - MetricsCalculated
  - ReportGenerated
```

**Benefits:**
- **Business Alignment**: Events match domain language
- **Clear Boundaries**: Contexts decoupled via events
- **Workflow Triggers**: Events initiate business processes
- **Integration**: External systems subscribe to domain events

## Message Queue Patterns

Message queues provide durable, ordered delivery of messages between producers and consumers.

### Point-to-Point

**Concept:**
Each message delivered to exactly one consumer. Used for work distribution.

**Implementation:**
```python
# Producer sends tasks to queue
for task in tasks:
    sqs.send_message(
        QueueUrl=queue_url,
        MessageBody=json.dumps(task),
        MessageAttributes={
            'Priority': {
                'StringValue': task['priority'],
                'DataType': 'String'
            }
        }
    )

# Single consumer processes each message
def worker():
    while True:
        messages = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=20  # Long polling
        )

        for msg in messages.get('Messages', []):
            try:
                task = json.loads(msg['Body'])
                process_task(task)

                # Delete after successful processing
                sqs.delete_message(
                    QueueUrl=queue_url,
                    ReceiptHandle=msg['ReceiptHandle']
                )

            except Exception as e:
                logger.error(f"Task processing failed: {e}")
                # Message returns to queue after visibility timeout
```

**Use Cases:**
- Task distribution to worker pools
- Load leveling
- Background job processing

### Competing Consumers

**Concept:**
Multiple consumers read from the same queue, processing messages in parallel. Provides horizontal scaling.

**Architecture:**
```
Producer → SQS Queue → [Worker1, Worker2, Worker3, ...]
```

**Implementation:**
```python
# Scale workers based on queue depth
def auto_scale_workers():
    # Get queue depth
    attrs = sqs.get_queue_attributes(
        QueueUrl=queue_url,
        AttributeNames=['ApproximateNumberOfMessages']
    )

    queue_depth = int(attrs['Attributes']['ApproximateNumberOfMessages'])

    # Scale ECS service
    desired_count = min(max(queue_depth // 100, 1), 50)

    ecs.update_service(
        cluster='workers',
        service='task-processor',
        desiredCount=desired_count
    )
```

**With FIFO for Ordering:**
```python
# FIFO queue with message groups
sqs.send_message(
    QueueUrl=fifo_queue_url,
    MessageBody=json.dumps(task),
    MessageGroupId=f"{tenant_id}-{session_id}",  # Maintains order per group
    MessageDeduplicationId=task['taskId']
)

# Workers process different message groups in parallel
# But messages within a group are processed in order
```

**Benefits:**
- **Horizontal Scaling**: Add workers to increase throughput
- **Load Balancing**: Work distributed automatically
- **Fault Tolerance**: Failed workers don't block others

**Considerations:**
- **Visibility Timeout**: Set appropriately for processing time
- **Idempotency**: Handle potential duplicate processing
- **Ordering**: Use FIFO with message groups if order matters

### Priority Queues

**Concept:**
Process high-priority messages before low-priority ones. Important for SLA management.

**Implementation:**

**Option 1: Separate Queues:**
```python
# Route to different queues by priority
def send_task(task):
    priority = task['priority']

    if priority == 'critical':
        queue_url = critical_queue_url
    elif priority == 'high':
        queue_url = high_queue_url
    else:
        queue_url = standard_queue_url

    sqs.send_message(
        QueueUrl=queue_url,
        MessageBody=json.dumps(task)
    )

# Workers check high-priority queues first
def worker():
    while True:
        # Try critical first
        messages = sqs.receive_message(QueueUrl=critical_queue_url, MaxNumberOfMessages=1)
        if not messages.get('Messages'):
            # Then high
            messages = sqs.receive_message(QueueUrl=high_queue_url, MaxNumberOfMessages=1)
        if not messages.get('Messages'):
            # Finally standard
            messages = sqs.receive_message(QueueUrl=standard_queue_url, MaxNumberOfMessages=10)

        for msg in messages.get('Messages', []):
            process(msg)
```

**Option 2: Message Attributes with Filtering:**
```python
# Add priority as attribute
sqs.send_message(
    QueueUrl=queue_url,
    MessageBody=json.dumps(task),
    MessageAttributes={
        'Priority': {
            'StringValue': str(priority),
            'DataType': 'Number'
        }
    }
)

# Workers sort by priority
def worker():
    messages = sqs.receive_message(
        QueueUrl=queue_url,
        MaxNumberOfMessages=10,
        MessageAttributeNames=['Priority']
    )

    # Sort by priority
    sorted_msgs = sorted(
        messages.get('Messages', []),
        key=lambda m: int(m['MessageAttributes']['Priority']['StringValue']),
        reverse=True
    )

    for msg in sorted_msgs:
        process(msg)
```

**Option 3: Step Functions with Choice:**
```json
{
  "Type": "Choice",
  "Choices": [
    {
      "Variable": "$.priority",
      "StringEquals": "critical",
      "Next": "FastTrackProcessing"
    },
    {
      "Variable": "$.priority",
      "StringEquals": "high",
      "Next": "HighPriorityProcessing"
    }
  ],
  "Default": "StandardProcessing"
}
```

### Message Expiration and TTL

**Concept:**
Messages that are only relevant for a limited time should expire to avoid processing stale data.

**Implementation:**
```python
# Set message retention at queue level (1 min to 14 days)
sqs.set_queue_attributes(
    QueueUrl=queue_url,
    Attributes={
        'MessageRetentionPeriod': '3600'  # 1 hour
    }
)

# Per-message TTL with custom attribute
sqs.send_message(
    QueueUrl=queue_url,
    MessageBody=json.dumps(task),
    MessageAttributes={
        'ExpiresAt': {
            'StringValue': str(int(time.time()) + 300),  # 5 minutes
            'DataType': 'Number'
        }
    }
)

# Consumer checks expiration
def process_message(msg):
    expires_at = int(msg['MessageAttributes']['ExpiresAt']['StringValue'])

    if time.time() > expires_at:
        logger.info("Message expired, skipping")
        # Delete without processing
        sqs.delete_message(
            QueueUrl=queue_url,
            ReceiptHandle=msg['ReceiptHandle']
        )
        return

    # Process message
    process(json.loads(msg['Body']))
```

**Use Cases:**
- Time-sensitive tasks (e.g., "process within 5 minutes")
- Cache invalidation messages
- Real-time notifications (old ones not useful)

**Cleanup Strategy:**
```python
# Use DynamoDB TTL for task metadata
dynamodb.put_item(
    TableName='TaskMetadata',
    Item={
        'taskId': task_id,
        'status': 'pending',
        'ttl': int(time.time()) + 86400  # 24 hours
    }
)

# DynamoDB automatically deletes expired items
```

## Publish-Subscribe Patterns

Pub/sub enables one-to-many communication where publishers send messages to topics and subscribers receive copies.

### Topic-Based Pub/Sub

**Concept:**
Publishers send messages to named topics. Subscribers express interest in topics and receive all messages published to those topics.

**Implementation with SNS:**
```python
# Create topic
topic_response = sns.create_topic(Name='agent-events')
topic_arn = topic_response['TopicArn']

# Subscribe multiple endpoints
sns.subscribe(
    TopicArn=topic_arn,
    Protocol='sqs',
    Endpoint='arn:aws:sqs:region:account:analytics-queue'
)

sns.subscribe(
    TopicArn=topic_arn,
    Protocol='lambda',
    Endpoint='arn:aws:lambda:region:account:function:notifier'
)

sns.subscribe(
    TopicArn=topic_arn,
    Protocol='https',
    Endpoint='https://webhook.example.com/events'
)

# Publish event
sns.publish(
    TopicArn=topic_arn,
    Message=json.dumps({
        'eventType': 'TaskCompleted',
        'agentId': 'agent-123',
        'taskId': 'task-456'
    }),
    MessageAttributes={
        'eventType': {'DataType': 'String', 'StringValue': 'TaskCompleted'},
        'tenantId': {'DataType': 'String', 'StringValue': 'tenant-A'}
    }
)
```

**Benefits:**
- **Decoupling**: Publishers don't know about subscribers
- **Scalability**: Add subscribers without changing publishers
- **Parallel Processing**: All subscribers receive simultaneously
- **Reliability**: SNS handles delivery retries

**Challenges:**
- **No Guaranteed Order**: Messages may arrive out of order (use FIFO for ordering)
- **Duplicate Detection**: Subscribers must handle potential duplicates
- **Message Size**: Limited to 256 KB

**When to Use:**
- Broadcasting events to multiple consumers
- Fan-out architectures
- Loosely coupled systems

### Content-Based Routing

**Concept:**
Route messages to subscribers based on message content, not just topics. Enables fine-grained filtering.

**Implementation with SNS Filter Policies:**
```python
# Subscriber 1: Only critical errors
sns.subscribe(
    TopicArn=topic_arn,
    Protocol='email',
    Endpoint='oncall@example.com',
    Attributes={
        'FilterPolicy': json.dumps({
            'eventType': ['Error'],
            'severity': ['critical']
        })
    }
)

# Subscriber 2: Specific tenant events
sns.subscribe(
    TopicArn=topic_arn,
    Protocol='sqs',
    Endpoint='arn:aws:sqs:region:account:tenant-A-queue',
    Attributes={
        'FilterPolicy': json.dumps({
            'tenantId': ['tenant-A'],
            'eventType': [{'prefix': 'Agent'}]
        })
    }
)

# Subscriber 3: High-value transactions
sns.subscribe(
    TopicArn=topic_arn,
    Protocol='lambda',
    Endpoint='arn:aws:lambda:region:account:function:fraud-check',
    Attributes={
        'FilterPolicy': json.dumps({
            'eventType': ['PaymentProcessed'],
            'amount': [{'numeric': ['>=', 10000]}]
        })
    }
)
```

**Event Bridge Rules:**
```json
{
  "source": ["chimera.agents"],
  "detail-type": ["Agent Task Completed"],
  "detail": {
    "tenantId": ["tenant-A", "tenant-B"],
    "duration": [{"numeric": [">", 1000]}],
    "status": ["completed"]
  }
}
```

**Benefits:**
- **Reduced Processing**: Subscribers only receive relevant messages
- **Lower Costs**: Fewer messages processed and stored
- **Flexible Routing**: Change routing without code changes
- **Multi-Criteria Filtering**: Complex conditions supported

### Fanout Pattern

**Concept:**
One message is delivered to multiple independent processing pipelines in parallel.

**Architecture:**
```
Publisher → SNS Topic → [SQS Queue 1 → Lambda 1: Analytics]
                      → [SQS Queue 2 → Lambda 2: Audit Log]
                      → [SQS Queue 3 → Lambda 3: Notifications]
                      → [HTTP Endpoint: External System]
```

**Implementation:**
```python
# SNS topic with multiple SQS subscribers
for queue_name in ['analytics', 'audit', 'notifications']:
    queue_url = sqs.create_queue(QueueName=queue_name)['QueueUrl']
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
            'RawMessageDelivery': 'true'  # Deliver message directly
        }
    )

    # Allow SNS to send to SQS
    sqs.set_queue_attributes(
        QueueUrl=queue_url,
        Attributes={
            'Policy': json.dumps({
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

# Publish once, delivered to all
sns.publish(
    TopicArn=topic_arn,
    Message=json.dumps(event_data)
)
```

**Aggregation Pattern:**
Collect results from multiple parallel processes:
```python
# Use Step Functions Map with fanout
{
  "Type": "Map",
  "ItemsPath": "$.tasks",
  "MaxConcurrency": 10,
  "Iterator": {
    "StartAt": "ProcessTask",
    "States": {
      "ProcessTask": {
        "Type": "Task",
        "Resource": "arn:aws:lambda:...",
        "End": true
      }
    }
  },
  "Next": "AggregateResults"
}
```

**Benefits:**
- **Parallel Processing**: All consumers work simultaneously
- **Independent Failure**: One consumer failure doesn't affect others
- **Scalability**: Add consumers without changing producer
- **Durability**: SQS provides message persistence

## Stream Processing Patterns

Stream processing enables real-time analysis and transformation of continuous data flows.

### Event Streaming

**Concept:**
Treat data as an unbounded, ordered sequence of events. Enables real-time processing and replay.

**Implementation with Kinesis:**
```python
# Producer: Stream agent events
def stream_agent_event(event):
    kinesis.put_record(
        StreamName='agent-activity',
        Data=json.dumps(event),
        PartitionKey=f"{event['tenantId']}-{event['agentId']}"
    )

# Consumer: Process stream
def process_stream():
    shard_iterator = kinesis.get_shard_iterator(
        StreamName='agent-activity',
        ShardId='shardId-000000000000',
        ShardIteratorType='LATEST'
    )['ShardIterator']

    while True:
        response = kinesis.get_records(ShardIterator=shard_iterator)

        for record in response['Records']:
            event = json.loads(record['Data'])
            process_event(event)

        shard_iterator = response['NextShardIterator']
        time.sleep(1)
```

**Using KCL (Kinesis Client Library):**
```python
from amazon_kclpy import kcl

class RecordProcessor(kcl.RecordProcessorBase):
    def process_records(self, process_records_input):
        for record in process_records_input.records:
            data = json.loads(record.binary_data)
            # Process event
            handle_agent_event(data)

        # Checkpoint progress
        process_records_input.checkpointer.checkpoint()

# Run KCL worker
kcl_process = kcl.KCLProcess(RecordProcessor())
kcl_process.run()
```

**Replay Capability:**
```python
# Replay from specific timestamp
iterator = kinesis.get_shard_iterator(
    StreamName='agent-activity',
    ShardId='shardId-000000000000',
    ShardIteratorType='AT_TIMESTAMP',
    Timestamp=datetime(2026, 3, 19, 10, 0, 0)
)['ShardIterator']

# Replay events from that point
```

**Benefits:**
- **Ordered Processing**: Events processed in sequence per partition
- **Replay**: Reprocess historical data
- **Multiple Consumers**: Different views of same stream
- **Low Latency**: Near real-time processing

### Windowed Processing

**Concept:**
Aggregate events over time windows for analytics and monitoring.

**Window Types:**

1. **Tumbling Windows** (non-overlapping):
   ```
   [0-5s) [5-10s) [10-15s) [15-20s)
   ```

2. **Sliding Windows** (overlapping):
   ```
   [0-5s)
      [1-6s)
         [2-7s)
            [3-8s)
   ```

3. **Session Windows** (based on activity gaps):
   ```
   [active...gap...][active...gap...][active]
   ```

**Implementation with Lambda:**
```python
from collections import defaultdict
from datetime import datetime, timedelta

class WindowedAggregator:
    def __init__(self, window_size_seconds=60):
        self.window_size = window_size_seconds
        self.windows = defaultdict(lambda: defaultdict(int))

    def add_event(self, event):
        timestamp = datetime.fromisoformat(event['timestamp'])
        window_start = timestamp.replace(second=0, microsecond=0)

        tenant_id = event['tenantId']
        metric = event['metric']

        key = (tenant_id, metric, window_start)
        self.windows[key] += event['value']

    def get_window_results(self, cutoff_time):
        results = []
        expired_keys = []

        for (tenant_id, metric, window_start), value in self.windows.items():
            if window_start < cutoff_time - timedelta(seconds=self.window_size):
                results.append({
                    'tenantId': tenant_id,
                    'metric': metric,
                    'window': window_start.isoformat(),
                    'value': value
                })
                expired_keys.append((tenant_id, metric, window_start))

        # Clean up old windows
        for key in expired_keys:
            del self.windows[key]

        return results

# Lambda handler for windowed aggregation
aggregator = WindowedAggregator(window_size_seconds=60)

def lambda_handler(event, context):
    for record in event['Records']:
        data = json.loads(record['kinesis']['data'])
        aggregator.add_event(data)

    # Emit completed windows
    now = datetime.utcnow()
    results = aggregator.get_window_results(now)

    for result in results:
        # Write to DynamoDB or CloudWatch
        cloudwatch.put_metric_data(
            Namespace='AgentMetrics',
            MetricData=[{
                'MetricName': result['metric'],
                'Value': result['value'],
                'Timestamp': result['window'],
                'Dimensions': [
                    {'Name': 'TenantId', 'Value': result['tenantId']}
                ]
            }]
        )
```

**Using Kinesis Data Analytics (Apache Flink):**
```sql
-- Tumbling window aggregation
CREATE OR REPLACE STREAM agent_metrics_1min (
    tenant_id VARCHAR(50),
    agent_id VARCHAR(50),
    task_count INTEGER,
    avg_duration DOUBLE,
    window_start TIMESTAMP
);

CREATE OR REPLACE PUMP metrics_pump AS
INSERT INTO agent_metrics_1min
SELECT STREAM
    tenant_id,
    agent_id,
    COUNT(*) as task_count,
    AVG(duration) as avg_duration,
    STEP(event_time BY INTERVAL '1' MINUTE) as window_start
FROM agent_events
GROUP BY
    tenant_id,
    agent_id,
    STEP(event_time BY INTERVAL '1' MINUTE);
```

**Use Cases:**
- Real-time metrics dashboards
- Rate limiting (requests per minute)
- Anomaly detection
- Performance monitoring

### Stream Join Patterns

**Concept:**
Correlate events from multiple streams based on keys or time windows.

**Pattern 1: Inner Join by Key:**
```python
# Join agent events with user events
class StreamJoiner:
    def __init__(self, join_window_seconds=60):
        self.agent_events = {}
        self.user_events = {}
        self.join_window = join_window_seconds

    def add_agent_event(self, event):
        session_id = event['sessionId']
        self.agent_events[session_id] = event

        # Try to join
        if session_id in self.user_events:
            self.emit_joined(
                self.agent_events[session_id],
                self.user_events[session_id]
            )

    def add_user_event(self, event):
        session_id = event['sessionId']
        self.user_events[session_id] = event

        # Try to join
        if session_id in self.agent_events:
            self.emit_joined(
                self.agent_events[session_id],
                self.user_events[session_id]
            )

    def emit_joined(self, agent_event, user_event):
        joined_event = {
            'sessionId': agent_event['sessionId'],
            'agentDuration': agent_event['duration'],
            'userId': user_event['userId'],
            'userSatisfaction': user_event['rating']
        }

        # Write to output stream or database
        kinesis.put_record(
            StreamName='joined-events',
            Data=json.dumps(joined_event),
            PartitionKey=joined_event['sessionId']
        )
```

**Pattern 2: Temporal Join (within time window):**
```python
from datetime import datetime, timedelta

class TemporalJoiner:
    def __init__(self, max_time_diff_seconds=10):
        self.max_time_diff = timedelta(seconds=max_time_diff_seconds)
        self.stream_a_events = []
        self.stream_b_events = []

    def add_event_a(self, event):
        event['timestamp'] = datetime.fromisoformat(event['timestamp'])
        self.stream_a_events.append(event)

        # Find matching events from stream B
        for event_b in self.stream_b_events:
            time_diff = abs(event['timestamp'] - event_b['timestamp'])

            if time_diff <= self.max_time_diff:
                self.emit_joined(event, event_b)

        # Clean old events
        cutoff = datetime.utcnow() - self.max_time_diff * 2
        self.stream_a_events = [
            e for e in self.stream_a_events
            if e['timestamp'] > cutoff
        ]
```

**Using Step Functions for Correlation:**
```json
{
  "Comment": "Wait for multiple events",
  "StartAt": "WaitForBothEvents",
  "States": {
    "WaitForBothEvents": {
      "Type": "Parallel",
      "Branches": [
        {
          "StartAt": "WaitForAgentEvent",
          "States": {
            "WaitForAgentEvent": {
              "Type": "Task",
              "Resource": "arn:aws:states:::sqs:receiveMessage.waitForTaskToken",
              "End": true
            }
          }
        },
        {
          "StartAt": "WaitForUserEvent",
          "States": {
            "WaitForUserEvent": {
              "Type": "Task",
              "Resource": "arn:aws:states:::sqs:receiveMessage.waitForTaskToken",
              "End": true
            }
          }
        }
      ],
      "Next": "ProcessJoinedEvents"
    },
    "ProcessJoinedEvents": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...",
      "End": true
    }
  }
}
```

**Use Cases:**
- Correlating user actions with agent responses
- Enriching events with reference data
- Detecting patterns across multiple streams
- Combining metrics from different sources

## Orchestration vs Choreography

Two fundamental approaches to coordinating distributed processes: centralized orchestration vs decentralized choreography.

### Orchestration

**Concept:**
A central coordinator (orchestrator) explicitly controls the flow, calling each participant service in sequence or parallel.

**Architecture:**
```
Orchestrator (Step Functions)
     ↓
   Service A → return
     ↓
   Service B → return
     ↓
   Service C → return
     ↓
   Complete
```

**Implementation with Step Functions:**
```json
{
  "Comment": "Orchestrated agent workflow",
  "StartAt": "ValidateRequest",
  "States": {
    "ValidateRequest": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:region:account:function:validate",
      "Next": "AssignToAgent"
    },
    "AssignToAgent": {
      "Type": "Task",
      "Resource": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
      "Parameters": {
        "QueueUrl": "https://sqs...agent-tasks",
        "MessageBody": {
          "task.$": "$",
          "taskToken.$": "$$.Task.Token"
        }
      },
      "Next": "ProcessResult"
    },
    "ProcessResult": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:region:account:function:process-result",
      "Next": "NotifyUser"
    },
    "NotifyUser": {
      "Type": "Task",
      "Resource": "arn:aws:states:::sns:publish",
      "Parameters": {
        "TopicArn": "arn:aws:sns:region:account:notifications",
        "Message.$": "$.result"
      },
      "End": true
    }
  }
}
```

**Benefits:**
- **Explicit Control Flow**: Easy to understand and visualize
- **Centralized Logic**: Business process in one place
- **Error Handling**: Coordinator manages retries and compensation
- **Monitoring**: Single place to track workflow progress
- **Debugging**: Clear execution path and history

**Challenges:**
- **Single Point of Failure**: Orchestrator must be highly available
- **Tight Coupling**: Orchestrator knows about all participants
- **Scalability**: Orchestrator can become bottleneck
- **Changes**: Modifying workflow requires orchestrator changes

**When to Use:**
- Complex workflows with branches and loops
- Need centralized monitoring and control
- Regulatory requirements for audit trails
- Workflows with compensation logic (Saga pattern)

### Choreography

**Concept:**
No central coordinator. Each service reacts to events, does its part, and publishes events for others.

**Architecture:**
```
Service A → Event Bus → [Service B, Service C, Service D]
Service B → Event Bus → [Service E, Service F]
(Each service listens and reacts independently)
```

**Implementation with EventBridge:**
```python
# Service A: Validate and publish event
def service_a_handler(request):
    # Validate
    if validate(request):
        events.put_events(
            Entries=[{
                'Source': 'chimera.service-a',
                'DetailType': 'RequestValidated',
                'Detail': json.dumps({
                    'requestId': request['id'],
                    'data': request['data']
                })
            }]
        )

# Service B: React to RequestValidated
def service_b_handler(event):
    request_id = event['detail']['requestId']

    # Process
    result = process_data(event['detail']['data'])

    # Publish next event
    events.put_events(
        Entries=[{
            'Source': 'chimera.service-b',
            'DetailType': 'DataProcessed',
            'Detail': json.dumps({
                'requestId': request_id,
                'result': result
            })
        }]
    )

# Service C: Also reacts to RequestValidated (parallel)
def service_c_handler(event):
    # Independent processing
    notify_user(event['detail']['requestId'])

# Service D: Reacts to DataProcessed
def service_d_handler(event):
    # Final step
    store_result(event['detail']['result'])
```

**Benefits:**
- **Loose Coupling**: Services don't know about each other
- **Scalability**: No central bottleneck
- **Flexibility**: Easy to add new participants
- **Resilience**: Failure of one service doesn't block others

**Challenges:**
- **Complexity**: Harder to understand overall flow
- **Debugging**: Difficult to trace request through system
- **Monitoring**: No single view of workflow state
- **Testing**: Integration testing more complex
- **Circular Dependencies**: Risk of event loops

**When to Use:**
- Simple, linear workflows
- High scalability requirements
- Services owned by different teams
- Frequent changes to participants

### Hybrid Approaches

Most real-world systems use a combination of both patterns.

**Pattern 1: Orchestrated Choreography:**
```
Step Functions (Orchestrator)
   ↓
Launch parallel choreographed workflows
   ↓
[Service A → Events → Service B]
[Service C → Events → Service D]
   ↓
Wait for completion signals
   ↓
Aggregate results
```

**Implementation:**
```json
{
  "Type": "Parallel",
  "Branches": [
    {
      "StartAt": "TriggerWorkflowA",
      "States": {
        "TriggerWorkflowA": {
          "Type": "Task",
          "Resource": "arn:aws:states:::events:putEvents.waitForTaskToken",
          "Parameters": {
            "Entries": [{
              "Source": "orchestrator",
              "DetailType": "StartWorkflowA",
              "Detail": {"taskToken.$": "$$.Task.Token"}
            }]
          },
          "End": true
        }
      }
    },
    {
      "StartAt": "TriggerWorkflowB",
      "States": {
        "TriggerWorkflowB": {
          "Type": "Task",
          "Resource": "arn:aws:states:::events:putEvents.waitForTaskToken",
          "Parameters": {
            "Entries": [{
              "Source": "orchestrator",
              "DetailType": "StartWorkflowB",
              "Detail": {"taskToken.$": "$$.Task.Token"}
            }]
          },
          "End": true
        }
      }
    }
  ],
  "Next": "AggregateResults"
}
```

**Pattern 2: Saga with Choreography:**
```
Each service:
1. Processes its step
2. Publishes success event OR
3. Publishes failure event (triggers compensations)

Services listen for failure events and execute compensating transactions
```

**Decision Framework:**

| Aspect | Use Orchestration | Use Choreography |
|--------|------------------|------------------|
| **Complexity** | High (many steps, branches) | Low (few linear steps) |
| **Ownership** | Single team | Multiple teams |
| **Changes** | Frequent workflow changes | Stable workflow |
| **Monitoring** | Need centralized visibility | Distributed OK |
| **Scalability** | Moderate volume | High volume |
| **Coupling** | Acceptable | Must minimize |

**Hybrid Example:**
```
User Request
   ↓
API Gateway → Step Functions (Orchestrator)
   ↓
Parallel Branch 1: Orchestrated multi-step workflow
   → Service A
   → Service B
   → Service C

Parallel Branch 2: Choreographed event chain
   → Publish Event
   → [Service D, Service E, Service F] react independently

   ↓
Aggregate and return
```

## Multi-Tenant Isolation Patterns

Multi-tenant systems require careful isolation to ensure security, performance, and cost allocation.

### Physical Isolation (Silo Model)

**Concept:**
Each tenant gets dedicated AWS resources. Complete isolation at infrastructure level.

**Implementation:**
```
Tenant A: SQS Queue A, SNS Topic A, Lambda A, DynamoDB Table A
Tenant B: SQS Queue B, SNS Topic B, Lambda B, DynamoDB Table B
Tenant C: SQS Queue C, SNS Topic C, Lambda C, DynamoDB Table C
```

**CloudFormation per Tenant:**
```yaml
Resources:
  TenantQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub 'chimera-tasks-${TenantId}'
      Tags:
        - Key: TenantId
          Value: !Ref TenantId

  TenantTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: !Sub 'chimera-events-${TenantId}'
      Tags:
        - Key: TenantId
          Value: !Ref TenantId
```

**Benefits:**
- **Complete Isolation**: No noisy neighbor issues
- **Security**: Physical separation
- **Per-Tenant Customization**: Different configurations per tenant
- **Clear Cost Attribution**: Resources tagged by tenant

**Challenges:**
- **Management Overhead**: Many resources to manage
- **Cost**: Higher baseline cost per tenant
- **Scaling**: Can hit AWS account limits
- **Deployment Complexity**: Stack per tenant

**When to Use:**
- Enterprise/premium tenants
- Regulatory requirements mandate isolation
- Tenants with very different SLAs
- High-value customers justify cost

### Logical Isolation (Pool Model)

**Concept:**
Shared resources with tenant identification in data/messages. Isolation enforced via IAM and application logic.

**Implementation:**
```
All Tenants → Shared SQS Queue (with tenantId in message)
           → Shared Lambda (filters by tenantId)
           → Shared DynamoDB (partition key includes tenantId)
```

**IAM Policy for Tenant Isolation:**
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "sqs:SendMessage",
      "sqs:ReceiveMessage"
    ],
    "Resource": "arn:aws:sqs:*:*:shared-queue",
    "Condition": {
      "StringEquals": {
        "sqs:MessageAttribute/tenantId": "${aws:PrincipalTag/TenantId}"
      }
    }
  }]
}
```

**Application-Level Filtering:**
```python
def lambda_handler(event, context):
    # Get tenant from caller identity
    caller_tenant = get_caller_tenant(context)

    for record in event['Records']:
        message = json.loads(record['body'])
        message_tenant = message['tenantId']

        # Enforce tenant isolation
        if message_tenant != caller_tenant:
            logger.error(f"Tenant mismatch: {caller_tenant} vs {message_tenant}")
            continue

        process_message(message)
```

**DynamoDB with Tenant Partition:**
```python
# Partition key includes tenant ID
dynamodb.put_item(
    TableName='SharedTasksTable',
    Item={
        'pk': f"TENANT#{tenant_id}#TASK#{task_id}",
        'sk': f"TASK#{task_id}",
        'tenantId': tenant_id,
        'data': task_data
    }
)

# Query by tenant
response = dynamodb.query(
    TableName='SharedTasksTable',
    KeyConditionExpression='pk = :pk',
    ExpressionAttributeValues={
        ':pk': f"TENANT#{tenant_id}#TASK"
    }
)
```

**Benefits:**
- **Cost Efficiency**: Shared resources lower per-tenant cost
- **Simple Management**: Fewer resources to manage
- **Efficient Resource Utilization**: Better capacity usage
- **Easy Onboarding**: No infrastructure provisioning per tenant

**Challenges:**
- **Noisy Neighbor**: One tenant can impact others
- **Security**: Must carefully enforce isolation
- **Monitoring**: Per-tenant metrics require filtering
- **Scaling**: Must handle aggregate load

**When to Use:**
- Standard/basic tier tenants
- High tenant count
- Similar tenant profiles
- Cost-sensitive deployments

### Silo, Bridge, and Pool Models

**Hybrid Deployment Strategy:**

**Tier-Based Approach:**
```
Premium Tier → Silo (dedicated resources)
Business Tier → Bridge (dedicated compute, shared data)
Standard Tier → Pool (fully shared)
```

**Bridge Model Implementation:**
```
Tenant-Specific:
- Lambda functions (dedicated concurrency)
- API Gateway stages
- CloudFront distributions

Shared:
- DynamoDB tables (with tenant partitioning)
- S3 buckets (with IAM prefix policies)
- Event buses
```

**Benefits:**
- **Flexibility**: Match isolation level to tenant needs
- **Cost Optimization**: Pay for isolation where needed
- **Migration Path**: Easy to promote tenants between tiers

### Message-Level Tenant Identification

**Best Practices:**

1. **Always Include Tenant ID:**
```python
# SQS
sqs.send_message(
    QueueUrl=queue_url,
    MessageBody=json.dumps(data),
    MessageAttributes={
        'tenantId': {'DataType': 'String', 'StringValue': tenant_id}
    }
)

# SNS
sns.publish(
    TopicArn=topic_arn,
    Message=json.dumps(data),
    MessageAttributes={
        'tenantId': {'DataType': 'String', 'StringValue': tenant_id}
    }
)

# EventBridge
events.put_events(
    Entries=[{
        'Source': 'app',
        'DetailType': 'Event',
        'Detail': json.dumps({'tenantId': tenant_id, 'data': data})
    }]
)
```

2. **Filter by Tenant:**
```json
// SNS Subscription Filter
{
  "tenantId": ["tenant-A"]
}

// EventBridge Rule
{
  "detail": {
    "tenantId": ["tenant-A", "tenant-B"]
  }
}
```

3. **Validate Tenant Access:**
```python
def validate_tenant_access(message_tenant, caller_tenant):
    if message_tenant != caller_tenant:
        raise PermissionError(f"Tenant {caller_tenant} cannot access {message_tenant} data")
```

4. **Tenant-Specific Routing:**
```python
# Route to tenant-specific resources if they exist
def get_queue_for_tenant(tenant_id):
    # Check if tenant has dedicated queue
    try:
        queue_url = sqs.get_queue_url(
            QueueName=f'tenant-{tenant_id}-tasks'
        )['QueueUrl']
        return queue_url
    except ClientError:
        # Fall back to shared queue
        return shared_queue_url
```

## Error Handling and Resilience

### Retry Strategies
[Exponential backoff, jitter, idempotency]

### Dead Letter Queues
[Poison message handling, manual intervention, alerting]

### Circuit Breaker Pattern
[Preventing cascading failures, fallback strategies]

### Saga Pattern
[Distributed transactions, compensation, eventual consistency]

## Monitoring and Observability

### Distributed Tracing
[X-Ray integration, trace IDs, end-to-end visibility]

### Metrics and Alarms
[CloudWatch metrics, custom metrics, SLA monitoring]

### Logging Strategies
[Structured logging, correlation IDs, centralized aggregation]

### Message Tracking
[Tracking messages through the system, debugging, audit]

## Performance Considerations

### Latency Requirements
[Choosing patterns based on latency needs]

### Throughput Scaling
[Horizontal scaling, partitioning, batching]

### Cost vs Performance Trade-offs
[Balancing cost and performance, right-sizing]

## Security Patterns

### Authentication and Authorization
[IAM roles, resource policies, token-based auth]

### Encryption
[At-rest and in-transit encryption, KMS integration]

### Message Validation
[Schema validation, input sanitization, preventing injection]

## Pattern Selection Guide

### Decision Matrix

| Requirement | Recommended Pattern | AWS Service | Rationale |
|-------------|---------------------|-------------|-----------|
| Task distribution with order | SQS FIFO + Message Groups | SQS FIFO | Strict ordering per session/tenant |
| Task distribution without order | Point-to-Point Queue | SQS Standard | Simplest, highest throughput |
| Event broadcasting | Pub/Sub Fanout | SNS + SQS | Reliable, durable delivery |
| Complex event routing | Content-Based Router | EventBridge | Flexible filtering and routing |
| Real-time streaming | Event Streaming | Kinesis | Ordered, replay capability |
| Long workflow (>5 min) | Orchestration | Step Functions Standard | Audit trail, error handling |
| High-volume workflow (<5 min) | Orchestration | Step Functions Express | Cost-effective at scale |
| Loosely coupled processes | Choreography | EventBridge | Decentralized, flexible |
| Request-response (sync) | Direct API | API Gateway + Lambda | Low latency, immediate feedback |
| Request-response (async) | Message-based | SQS + Correlation ID | Decoupled, durable |
| Real-time bidirectional | WebSocket | AppSync Subscriptions | Push updates to clients |
| State change reactions | Change Data Capture | DynamoDB Streams | React to database changes |
| Aggregate metrics | Windowed Processing | Kinesis + Lambda | Real-time analytics |
| Cross-service correlation | Stream Join | Kinesis + KCL | Combine multiple data sources |
| Multi-step transaction | Saga Pattern | Step Functions + Events | Distributed transactions |

### Common Scenarios

**Scenario 1: Task Distribution System**
```
Requirements:
- Distribute tasks to worker pool
- Maintain order per tenant session
- Handle failures gracefully
- Scale workers independently

Solution:
SQS FIFO Queue with Message Group IDs
- Message Group ID: {tenantId}-{sessionId}
- Dead Letter Queue for failed tasks
- CloudWatch alarms on queue depth
- Auto-scaling workers based on queue metrics
```

**Scenario 2: Event Broadcasting**
```
Requirements:
- Notify multiple systems of agent completion
- Each system needs durable delivery
- Systems process independently
- Add new subscribers without code changes

Solution:
SNS Topic + SQS Queues (Fanout)
- SNS topic: agent-events
- SQS queues: analytics, audit, notifications
- Each queue processes at own pace
- RawMessageDelivery for cleaner messages
```

**Scenario 3: Real-Time Dashboard**
```
Requirements:
- Push agent status updates to web clients
- Low latency (<100ms)
- Millions of concurrent connections
- Filter updates by tenant

Solution:
AppSync GraphQL Subscriptions
- Subscription filters by tenantId
- Mutations trigger subscriptions
- WebSocket for bidirectional communication
- IAM/Cognito for auth
```

**Scenario 4: Multi-Agent Workflow**
```
Requirements:
- Coordinate 3-5 agents in sequence
- Handle agent failures with retries
- Audit trail for compliance
- Workflows run for hours

Solution:
Step Functions Standard Workflow
- Each agent as separate state
- Error handling with retries
- Callback pattern for long-running agents
- 90-day execution history
```

### Anti-Patterns

**Anti-Pattern 1: Polling for Changes**
❌ **Bad:**
```python
while True:
    status = get_task_status(task_id)
    if status == 'completed':
        break
    time.sleep(5)  # Wasteful polling
```

✅ **Better:**
```python
# Use DynamoDB Streams or EventBridge
# React when status changes, no polling
```

**Anti-Pattern 2: Synchronous Chains**
❌ **Bad:**
```
API → ServiceA (waits) → ServiceB (waits) → ServiceC
Total latency: sum of all services
```

✅ **Better:**
```
API → Queue → return immediately
Background: ServiceA → ServiceB → ServiceC (async)
```

**Anti-Pattern 3: Shared Database as Message Bus**
❌ **Bad:**
```python
# Service A writes status to DB
db.update('tasks', task_id, status='ready')

# Service B polls DB for status changes
while True:
    tasks = db.query('tasks', status='ready')
    # Process...
```

✅ **Better:**
```python
# Use actual message queue
sqs.send_message(queue_url, task_data)
```

**Anti-Pattern 4: HTTP Webhooks Without Retries**
❌ **Bad:**
```python
requests.post(webhook_url, json=data)
# If fails, data lost
```

✅ **Better:**
```python
# Use SNS + HTTPS subscription with retries
sns.publish(topic_arn, json.dumps(data))
# SNS handles retries and DLQ
```

**Anti-Pattern 5: Unbounded Queues**
❌ **Bad:**
```
No monitoring, queue grows indefinitely
```

✅ **Better:**
```
- Set CloudWatch alarms on queue depth
- Auto-scale consumers
- Implement backpressure mechanisms
- Set appropriate message retention
```

## Implementation Examples

### Example 1: Task Distribution System
[Using SQS FIFO for ordered task processing]

### Example 2: Event Broadcasting
[Using SNS/EventBridge for system-wide notifications]

### Example 3: Stream Processing Pipeline
[Using Kinesis for real-time agent activity processing]

### Example 4: Orchestrated Workflow
[Using Step Functions for complex multi-agent workflows]

## Recommendations

### Pattern Composition
[Combining patterns for complex scenarios]

### Evolution Strategy
[Starting simple, scaling up, migration paths]

### Testing Strategies
[Unit testing, integration testing, chaos engineering]

## References

### AWS Documentation

**Messaging Services:**
- [Amazon SQS Best Practices](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-best-practices.html)
- [Amazon SNS Message Filtering](https://docs.aws.amazon.com/sns/latest/dg/sns-message-filtering.html)
- [EventBridge Event Patterns](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html)
- [Kinesis Data Streams Best Practices](https://docs.aws.amazon.com/streams/latest/dev/best-practices.html)

**Orchestration:**
- [Step Functions Workflows](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)
- [Saga Pattern with Step Functions](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-data-persistence/saga-pattern.html)

**Architecture Patterns:**
- [AWS Prescriptive Guidance - Cloud Design Patterns](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/)
- [Circuit Breaker Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/circuit-breaker.html)
- [Event Sourcing Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-data-persistence/event-sourcing.html)

### Academic Papers & Books

**Distributed Systems:**
- "Designing Data-Intensive Applications" by Martin Kleppmann
- "Enterprise Integration Patterns" by Gregor Hohpe and Bobby Woolf
- "Building Microservices" by Sam Newman
- "Release It!" by Michael Nygard (Circuit Breaker Pattern)

**Event-Driven Architecture:**
- "Event Streams in Action" by Alexander Dean and Valentin Crettaz
- "Reactive Messaging Patterns with the Actor Model" by Vaughn Vernon

### Pattern Catalogs

**Enterprise Integration Patterns:**
- http://www.enterpriseintegrationpatterns.com/
- Canonical patterns for messaging and integration

**Cloud Patterns:**
- [Azure Architecture Patterns](https://docs.microsoft.com/en-us/azure/architecture/patterns/)
- [AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/)

### Multi-Tenant Architecture

- [SaaS Multi-Tenant Architecture Patterns](https://aws.amazon.com/blogs/apn/tag/saas/)
- [Building Multi-Tenant Solutions on AWS](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals-aws/)

### Additional Resources

- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
- [Serverless Land Patterns](https://serverlessland.com/patterns)
- [AWS Samples on GitHub](https://github.com/aws-samples)
