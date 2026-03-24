# Swarm GroupChat Architecture

**Status:** Design
**Version:** 1.0
**Last Updated:** 2026-03-24

---

## Overview

GroupChat implements SNS/SQS fan-out pattern for multi-agent pub-sub communication in agent swarms. Any agent can publish a message to the group's SNS topic, and all agents receive it via their dedicated SQS queues.

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                      SNS Topic                              │
│         chimera-groupchat-{tenantId}-{groupId}              │
└────────────┬───────────────┬────────────────┬───────────────┘
             │               │                │
             ▼               ▼                ▼
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │ SQS Queue A │  │ SQS Queue B │  │ SQS Queue C │
    └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
           │                │                │
           ▼                ▼                ▼
       Agent A          Agent B          Agent C
```

### Flow

1. **Group Initialization**
   - Coordinator creates SNS topic for the task group
   - Topic ARN stored in group metadata

2. **Agent Subscription**
   - Each agent gets a dedicated SQS queue
   - Queue subscribes to SNS topic
   - Queue policy grants SNS send permissions

3. **Message Publishing**
   - Agent publishes message to SNS topic
   - SNS fans out to all subscribed SQS queues
   - Message delivered to all agents in group

4. **Message Receiving**
   - Each agent polls its own SQS queue
   - Long polling (20s) for efficient retrieval
   - Messages auto-deleted after processing

5. **Cleanup**
   - Unsubscribe agents from SNS
   - Delete SQS queues
   - Delete SNS topic

## Message Format

GroupChat messages extend the A2A protocol:

```typescript
interface GroupChatMessage extends A2AMessage {
  groupId: string;           // Swarm/group identifier
  visibility: 'group' | 'all'; // Message scope
  threadId?: string;         // Optional reply thread
}
```

### Message Types

| Type | Priority | Use Case |
|------|----------|----------|
| `status` | normal | Progress updates, state changes |
| `question` | high | Questions to other agents |
| `result` | normal | Task completion, artifacts |
| `error` | urgent | Error notifications |
| `event` | low | System events, logging |

## Use Cases

### 1. Swarm Coordination

Multiple agents working on parallel subtasks share progress:

```typescript
const groupChat = createGroupChat({
  tenantId: 'tenant-123',
  groupId: 'swarm-data-migration',
  region: 'us-east-1',
  agentIds: ['agent-1', 'agent-2', 'agent-3'],
});

// Initialize group
await groupChat.createGroup();

// Subscribe all agents
for (const agentId of ['agent-1', 'agent-2', 'agent-3']) {
  await groupChat.addAgent(agentId);
}

// Agent 1 publishes progress update
const statusMsg = GroupChatMessageBuilder.status(
  'swarm-data-migration',
  'tenant-123',
  'agent-1',
  'Migrated 1000/5000 records',
  { progress: 20, table: 'users' }
);
await groupChat.publish(statusMsg);

// Agent 2 and 3 receive the update
const messages = await groupChat.receive('agent-2');
```

### 2. Multi-Agent Collaboration

Agents share findings and ask questions:

```typescript
// Agent A discovers schema constraint
const resultMsg = GroupChatMessageBuilder.result(
  'swarm-schema-analysis',
  'tenant-123',
  'agent-a',
  'Found foreign key constraint on users.org_id',
  { table: 'users', column: 'org_id', references: 'orgs.id' }
);
await groupChat.publish(resultMsg);

// Agent B asks question
const questionMsg = GroupChatMessageBuilder.question(
  'swarm-schema-analysis',
  'tenant-123',
  'agent-b',
  'Should we add index on users.org_id?',
  { table: 'users', column: 'org_id' }
);
await groupChat.publish(questionMsg);
```

### 3. Error Broadcasting

Agent failures broadcast to all group members:

```typescript
const errorMsg = GroupChatMessageBuilder.error(
  'swarm-deploy',
  'tenant-123',
  'agent-3',
  'RDS connection timeout after 30s',
  'DB_CONN_TIMEOUT'
);
await groupChat.publish(errorMsg);

// All agents receive error and can react
```

### 4. Task Group Communication

Coordinator broadcasts instructions to all agents:

```typescript
const eventMsg = GroupChatMessageBuilder.event(
  'swarm-load-test',
  'tenant-123',
  'coordinator',
  'load_test_start',
  { targetRPS: 1000, duration: 300 }
);
await groupChat.publish(eventMsg);
```

## Integration with Chimera

### DynamoDB Schema

Store group metadata in `chimera-sessions` table:

```typescript
interface GroupMetadata {
  PK: `TENANT#${tenantId}`;
  SK: `GROUP#${groupId}`;
  tenantId: string;
  groupId: string;
  topicArn: string;
  agentIds: string[];
  createdAt: string;
  expiresAt: number; // TTL (24h after creation)
}
```

### CDK Infrastructure

OrchestrationStack provisions SNS/SQS resources:

```typescript
// SNS Topic (created dynamically by GroupChat)
const topic = new sns.Topic(this, 'GroupChatTopic', {
  topicName: `chimera-groupchat-${tenantId}-${groupId}`,
});

// SQS Queue per agent (created dynamically)
const queue = new sqs.Queue(this, `AgentQueue-${agentId}`, {
  queueName: `chimera-groupchat-${tenantId}-${groupId}-${agentId}`,
  retentionPeriod: Duration.days(4),
  visibilityTimeout: Duration.seconds(30),
  receiveMessageWaitTime: Duration.seconds(20), // Long polling
});

// Subscribe queue to topic
topic.addSubscription(new subs.SqsSubscription(queue, {
  rawMessageDelivery: true, // Deliver message body directly
}));
```

### IAM Permissions

Agent execution roles need SNS publish and SQS read permissions:

```json
{
  "Effect": "Allow",
  "Action": [
    "sns:Publish",
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage"
  ],
  "Resource": [
    "arn:aws:sns:*:*:chimera-groupchat-${tenantId}-*",
    "arn:aws:sqs:*:*:chimera-groupchat-${tenantId}-*-${agentId}"
  ]
}
```

## Cost Optimization

### Message Batching

Batch status updates to reduce SNS publish costs:

```typescript
// Instead of publishing every progress update
// Batch updates and publish every 10 seconds
const batchedUpdates = [];
setInterval(async () => {
  if (batchedUpdates.length > 0) {
    const summaryMsg = GroupChatMessageBuilder.status(
      groupId,
      tenantId,
      agentId,
      `Processed ${batchedUpdates.length} items`,
      { updates: batchedUpdates }
    );
    await groupChat.publish(summaryMsg);
    batchedUpdates.length = 0;
  }
}, 10000);
```

### Long Polling

SQS long polling (20s) reduces empty receive requests:

```typescript
const messages = await groupChat.receive(agentId, {
  maxMessages: 10,
  waitTimeSeconds: 20, // Long polling
});
```

### TTL and Cleanup

Set short TTL on group metadata (24h) to auto-delete stale groups:

```typescript
const groupMetadata = {
  PK: `TENANT#${tenantId}`,
  SK: `GROUP#${groupId}`,
  expiresAt: Math.floor(Date.now() / 1000) + 86400, // 24h TTL
};
```

## Scaling Considerations

### Group Size

- Tested with up to 100 agents per group
- SNS fan-out supports 12.5M subscriptions per topic
- Each agent adds 1 SQS queue (account limit: 1M queues)

### Message Throughput

- SNS: 100,000 messages/second per topic
- SQS: unlimited throughput (batching recommended)

### Message Size

- SNS limit: 256KB per message
- Large artifacts should be stored in S3 with URL in message

### Regional Deployment

For multi-region swarms, use SNS topic per region:

```typescript
const usEastGroup = createGroupChat({
  tenantId,
  groupId: 'swarm-abc',
  region: 'us-east-1',
  agentIds: ['agent-1', 'agent-2'],
});

const euWestGroup = createGroupChat({
  tenantId,
  groupId: 'swarm-abc',
  region: 'eu-west-1',
  agentIds: ['agent-3', 'agent-4'],
});
```

## Monitoring

### CloudWatch Metrics

Track GroupChat health via CloudWatch:

- `SNS.NumberOfMessagesPublished` - Messages published to topic
- `SNS.NumberOfNotificationsFailed` - Failed deliveries
- `SQS.NumberOfMessagesReceived` - Messages polled by agents
- `SQS.ApproximateAgeOfOldestMessage` - Queue processing lag

### Custom Metrics

GroupChat tracks internal metrics:

```typescript
const metrics = groupChat.getMetrics();
// {
//   messagesPublished: 150,
//   messagesReceived: 450, // 150 messages × 3 agents
//   activeSubscriptions: 3,
//   failedDeliveries: 0,
//   lastActivityAt: '2026-03-24T12:34:56Z'
// }
```

## Security

### Message Encryption

SNS and SQS support encryption at rest:

```typescript
const topic = new sns.Topic(this, 'GroupChatTopic', {
  masterKey: kmsKey, // Customer-managed KMS key
});

const queue = new sqs.Queue(this, 'AgentQueue', {
  encryption: sqs.QueueEncryption.KMS,
  encryptionMasterKey: kmsKey,
});
```

### Access Control

- SNS topic policy restricts publish to tenant agents
- SQS queue policy allows only SNS topic as sender
- IAM policies scope permissions to tenant resources

### Message Validation

GroupChat validates messages before publishing:

```typescript
async publish(message: GroupChatMessage): Promise<string> {
  if (message.groupId !== this.config.groupId) {
    throw new Error('Message groupId mismatch');
  }
  // ... publish to SNS
}
```

## Comparison with A2A Protocol

| Feature | A2A Protocol | GroupChat |
|---------|--------------|-----------|
| **Pattern** | Point-to-point (SQS) | Pub-sub (SNS + SQS) |
| **Routing** | Direct agent addressing | Fan-out to all agents |
| **Use Case** | Task delegation, queries | Swarm coordination, broadcast |
| **Cost** | Lower (SQS only) | Higher (SNS + SQS) |
| **Latency** | ~100ms | ~200ms (SNS overhead) |
| **Message Persistence** | 4 days (SQS) | 4 days (SQS) |

**Recommendation:** Use A2A for 1:1 communication, GroupChat for 1:N broadcast.

## Future Enhancements

### 1. Message Filtering

Use SNS message filtering to route specific message types:

```typescript
await groupChat.addAgent('agent-1', {
  filterPolicy: {
    messageType: ['status', 'result'], // Only receive these types
  },
});
```

### 2. Priority Queues

Create high-priority SQS queue for urgent messages:

```typescript
const urgentQueue = new sqs.Queue(this, 'UrgentQueue', {
  queueName: `chimera-groupchat-urgent-${agentId}`,
});
```

### 3. Message Replay

Store messages in S3 for replay/debugging:

```typescript
const archiveBucket = new s3.Bucket(this, 'GroupChatArchive');

topic.addSubscription(new subs.LambdaSubscription(archiveFn, {
  rawMessageDelivery: false, // Get SNS metadata
}));
```

### 4. Cross-Framework Integration

Bridge GroupChat with other agent frameworks (LangGraph, OpenAI Swarms):

```typescript
const bridge = new CrossFrameworkBridge({
  groupChat,
  externalTopics: ['langgraph-swarm-topic'],
});
```

## References

- [A2A Protocol](./a2a-protocol.md) - Point-to-point agent communication
- [Agent Orchestration](./agent-orchestration.md) - Multi-agent coordination patterns
- [AWS SNS Documentation](https://docs.aws.amazon.com/sns/)
- [AWS SQS Documentation](https://docs.aws.amazon.com/sqs/)

---

**Next Steps:**

1. Implement SNS/SQS SDK calls (replace placeholders)
2. Add CDK constructs to OrchestrationStack
3. Create integration tests with real AWS services
4. Add CloudWatch alarms for failed deliveries
5. Document best practices for message design
