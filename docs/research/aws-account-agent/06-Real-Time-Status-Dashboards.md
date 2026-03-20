# AWS Chimera: Real-Time Status Dashboards

> **Research Date:** 2026-03-20
> **Status:** Complete
> **Series:** AWS Account Agent Activity Documentation (6 of 6)
> **See also:** [[01-Activity-Logging-Architecture-Overview]] | [[02-Decision-Logs-Reasoning-Capture]] | [[03-Action-Audit-Trail-Structured-Storage]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#Why Real-Time Visibility Matters]]
- [[#Dashboard Architecture]]
- [[#Activity Feed View]]
- [[#Resource Map View]]
- [[#Cost Tracker View]]
- [[#Health Indicators View]]
- [[#Decision Timeline View]]
- [[#WebSocket Real-Time Updates]]
- [[#CloudWatch Integration]]
- [[#QuickSight Analytics]]
- [[#Code Examples]]
- [[#Key Takeaways]]

---

## Executive Summary

Chimera provides **real-time dashboards** that show what AI agents are doing as they work:

- **Activity Feed** — scrolling log of decisions + actions with timestamps
- **Resource Map** — visual graph showing what agent built and dependencies
- **Cost Tracker** — live cumulative spend with breakdown by resource type
- **Health Indicators** — success rate, error rate, latency, throttles
- **Decision Timeline** — chronological view of architectural choices

**Key Innovation:** Dashboards update in real-time via EventBridge + WebSocket, not polling. Operators see agent thinking and acting as it happens.

**Benefits:**
- ✅ **No post-mortem archaeology** — watch agent work in real-time
- ✅ **Early error detection** — spot problems as they occur, not hours later
- ✅ **Cost awareness** — see spend accumulate before it becomes a problem
- ✅ **Confidence building** — stakeholders can watch agent without interrupting
- ✅ **Demo-ready** — dashboards are polished enough to show executives

---

## Why Real-Time Visibility Matters

### The Black Box Problem

Traditional AI agent systems are opaque:

```
User: "Set up production infrastructure"
Agent: [working... working... working...]
[30 minutes later]
Agent: "Done! Created 47 resources."
User: "What did you create? How much will it cost? Did anything fail?"
Agent: [no visibility during execution]
```

**Problems:**
1. **No progress indication** — is agent stuck or working?
2. **No error visibility** — did agent hit errors and retry?
3. **No cost awareness** — how much has been spent so far?
4. **No confidence** — stakeholders can't trust what they can't see

### Chimera's Solution: Real-Time Dashboards

```
User: "Set up production infrastructure"
[Dashboard updates in real-time]

14:30:00 | Decision: Database selection (DynamoDB selected, $45/mo)
14:30:15 | Action: Created table chimera-sessions
14:30:30 | Decision: Compute platform (Lambda selected, $120/mo)
14:30:45 | Action: Created function SessionHandler
14:31:00 | ERROR: Lambda deployment failed (timeout)
14:31:15 | Action: Retry #1 - Increased timeout to 30s
14:31:30 | Action: Lambda deployed successfully
14:32:00 | Cost so far: $165/month estimated

[Visual resource map shows DynamoDB → Lambda → API Gateway]
```

**Operator experience:**
- ✅ Sees progress every 15-30 seconds
- ✅ Spots timeout error immediately
- ✅ Watches agent self-correct
- ✅ Knows cumulative cost in real-time

---

## Dashboard Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Agent Runtime                                              │
│    ├─ Decision logged → EventBridge event                  │
│    └─ Action executed → EventBridge event                  │
└──────────────┬──────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│  EventBridge Custom Bus (chimera-activity-bus)             │
│    ├─ Event: DecisionMade                                  │
│    ├─ Event: ActionExecuted                                │
│    ├─ Event: ResourceCreated                               │
│    └─ Event: ErrorOccurred                                 │
└──────────┬──────────┬──────────┬───────────────────────────┘
           │          │          │
           ▼          ▼          ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐
│  Lambda     │  │  Lambda     │  │  Lambda                 │
│  (publish   │  │  (update    │  │  (aggregate metrics)    │
│  WebSocket) │  │  DDB cache) │  │                         │
└──────┬──────┘  └─────────────┘  └─────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  API Gateway WebSocket API                                  │
│    └─ Connected clients receive real-time updates          │
└──────────────┬──────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│  Browser Dashboard (React)                                  │
│    ├─ Activity Feed (live)                                  │
│    ├─ Resource Map (updates on create/delete)              │
│    ├─ Cost Tracker (accumulates)                           │
│    └─ Health Indicators (success/error rates)              │
└─────────────────────────────────────────────────────────────┘
```

### Tech Stack

- **Frontend:** React + TypeScript + Tailwind CSS
- **Real-time:** API Gateway WebSocket + EventBridge
- **State:** DynamoDB cache for activity logs (last 24 hours)
- **Charts:** Recharts for metrics, D3.js for resource graph
- **Deployment:** CloudFront + S3 (static hosting)

---

## Activity Feed View

### Design

```
┌────────────────────────────────────────────────────────────┐
│  Activity Feed                                Live         │
├────────────────────────────────────────────────────────────┤
│  [●] Real-time updates enabled                             │
│                                                            │
│  14:32:45  🚀  Action: Lambda function deployed            │
│            arn:aws:lambda:...:function:SessionHandler      │
│            Cost: $120/mo   Duration: 234ms                 │
│            [View Details]                                  │
│                                                            │
│  14:32:30  ⚠️  Error: Lambda deployment timeout            │
│            Error: ResourceInitializationError              │
│            Retry: #1 (increasing timeout to 30s)           │
│            [View Logs]                                     │
│                                                            │
│  14:32:00  🧠  Decision: Compute platform selection        │
│            Selected: AWS Lambda                            │
│            Alternatives: ECS Fargate (8.5), EC2 (7.0)      │
│            Confidence: 92%    Cost: $120/mo               │
│            [View Decision Log]                             │
│                                                            │
│  14:31:30  🗄️  Action: DynamoDB table created             │
│            chimera-sessions                                │
│            Cost: $45/mo    Items: 0                       │
│            [View Table]                                    │
│                                                            │
│  14:31:00  🧠  Decision: Database selection                │
│            Selected: DynamoDB                              │
│            Alternatives: RDS (8.5), Redis (7.0)            │
│            Confidence: 92%    Cost: $45/mo                │
│            [View Decision Log]                             │
│                                                            │
│  [Load More] [Pause Updates] [Export Feed]                │
└────────────────────────────────────────────────────────────┘
```

### Event Types

**Decision:**
```tsx
<ActivityItem type="decision">
  <Icon>🧠</Icon>
  <Timestamp>14:31:00</Timestamp>
  <Title>Decision: Database selection</Title>
  <Details>
    Selected: DynamoDB<br/>
    Alternatives: RDS (8.5), Redis (7.0)<br/>
    Confidence: 92% | Cost: $45/mo
  </Details>
  <Actions>
    <Button href={`/decisions/${decisionId}`}>View Decision Log</Button>
  </Actions>
</ActivityItem>
```

**Action (Success):**
```tsx
<ActivityItem type="action-success">
  <Icon>🚀</Icon>
  <Timestamp>14:31:30</Timestamp>
  <Title>Action: DynamoDB table created</Title>
  <Details>
    chimera-sessions<br/>
    ARN: arn:aws:dynamodb:...:table/chimera-sessions<br/>
    Cost: $45/mo | Items: 0
  </Details>
  <Actions>
    <Button href={`/resources/${arn}`}>View Table</Button>
  </Actions>
</ActivityItem>
```

**Action (Error):**
```tsx
<ActivityItem type="action-error">
  <Icon>⚠️</Icon>
  <Timestamp>14:32:30</Timestamp>
  <Title>Error: Lambda deployment timeout</Title>
  <Details>
    Error: ResourceInitializationError<br/>
    Message: Function took longer than 3s to initialize<br/>
    Retry: #1 (increasing timeout to 30s)
  </Details>
  <Actions>
    <Button href={`/logs/${traceId}`}>View Logs</Button>
  </Actions>
</ActivityItem>
```

---

## Resource Map View

### Design

```
┌────────────────────────────────────────────────────────────┐
│  Resource Map                                              │
├────────────────────────────────────────────────────────────┤
│  Graph view:                                               │
│                                                            │
│    ┌──────────────┐                                       │
│    │  API Gateway │                                       │
│    │  /sessions   │                                       │
│    └───────┬──────┘                                       │
│            │                                              │
│            ▼                                              │
│    ┌──────────────┐                                       │
│    │  Lambda      │                                       │
│    │  SessionHndlr│  Cost: $120/mo                       │
│    └───────┬──────┘  Status: Active                      │
│            │                                              │
│      ┌─────┴─────┐                                       │
│      ▼           ▼                                       │
│  ┌────────┐  ┌────────┐                                 │
│  │DynamoDB│  │S3      │                                 │
│  │sessions│  │backups │                                 │
│  └────────┘  └────────┘                                 │
│  $45/mo      $5/mo                                       │
│                                                            │
│  [Filters]                                                 │
│  ☑ DynamoDB  ☑ Lambda  ☑ API Gateway  ☐ S3              │
│                                                            │
│  [Legend]                                                  │
│  ● Active  ● Creating  ● Error  ● Deleting               │
└────────────────────────────────────────────────────────────┘
```

### Interactive Features

- **Click resource** → Show details panel
- **Hover** → Tooltip with cost, status, created time
- **Filter** → Show only specific resource types
- **Search** → Find resource by name or ARN
- **Export** → Download as PNG or Mermaid diagram

### Resource Graph Data

```typescript
interface ResourceNode {
  id: string;              // ARN
  type: string;            // "Lambda", "DynamoDB", "API Gateway"
  name: string;
  status: "active" | "creating" | "error" | "deleting";
  cost: {
    monthly: number;
    currency: "USD";
  };
  createdAt: string;
  createdBy: string;       // Agent ID
  decisionId: string;      // Decision that led to this resource
}

interface ResourceEdge {
  source: string;          // Source ARN
  target: string;          // Target ARN
  relationship: "invokes" | "reads" | "writes" | "depends-on";
}

const graph: ResourceGraph = {
  nodes: [
    {
      id: "arn:aws:lambda:...:function:SessionHandler",
      type: "Lambda",
      name: "SessionHandler",
      status: "active",
      cost: { monthly: 120, currency: "USD" },
      createdAt: "2026-03-20T14:32:45Z",
      createdBy: "agent-claude-3-5",
      decisionId: "act-2026-03-20-compute-001"
    },
    {
      id: "arn:aws:dynamodb:...:table/chimera-sessions",
      type: "DynamoDB",
      name: "chimera-sessions",
      status: "active",
      cost: { monthly: 45, currency: "USD" },
      createdAt: "2026-03-20T14:31:30Z",
      createdBy: "agent-claude-3-5",
      decisionId: "act-2026-03-20-db-001"
    }
  ],
  edges: [
    {
      source: "arn:aws:lambda:...:function:SessionHandler",
      target: "arn:aws:dynamodb:...:table/chimera-sessions",
      relationship: "reads"
    }
  ]
};
```

---

## Cost Tracker View

### Design

```
┌────────────────────────────────────────────────────────────┐
│  Cost Tracker                                              │
├────────────────────────────────────────────────────────────┤
│  Current Month: March 2026                                 │
│                                                            │
│  ┌────────────────────────────────────────────────────┐   │
│  │  Total Estimated Monthly Cost                       │   │
│  │  $165.00                                            │   │
│  │  ▲ +$165 from last month                           │   │
│  └────────────────────────────────────────────────────┘   │
│                                                            │
│  Breakdown by Service:                                     │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  Lambda           $120.00  ████████████████░░░  73% │ │
│  │  DynamoDB         $ 45.00  ██████░░░░░░░░░░░  27% │ │
│  │  S3               $  5.00  █░░░░░░░░░░░░░░░░   3% │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  Recent Changes:                                           │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  14:32:45  Lambda function created    +$120.00/mo   │ │
│  │  14:31:30  DynamoDB table created     +$ 45.00/mo   │ │
│  │  14:30:00  S3 backup bucket created   +$  5.00/mo   │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  Cost Trends:                                              │
│  [Line chart showing cumulative cost over time]            │
│                                                            │
│  [Export Report] [Set Budget Alert]                       │
└────────────────────────────────────────────────────────────┘
```

### Real-Time Cost Updates

Every resource creation triggers cost update:

```typescript
// EventBridge event
{
  "detail-type": "ResourceCreated",
  "detail": {
    "actionId": "action-2026-03-20-lambda-001",
    "resourceArn": "arn:aws:lambda:...:function:SessionHandler",
    "cost": {
      "immediate": 0.00,
      "estimatedMonthly": 120.00
    }
  }
}

// WebSocket message to dashboard
{
  "type": "cost-update",
  "payload": {
    "totalMonthlyCost": 165.00,
    "delta": 120.00,
    "breakdown": [
      { "service": "Lambda", "cost": 120.00, "percentage": 73 },
      { "service": "DynamoDB", "cost": 45.00, "percentage": 27 }
    ]
  }
}
```

---

## Health Indicators View

### Design

```
┌────────────────────────────────────────────────────────────┐
│  Health Indicators                         Last 5 minutes  │
├────────────────────────────────────────────────────────────┤
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐ │
│  │  Success Rate  │  │  Error Rate    │  │  Latency     │ │
│  │     98.5%      │  │     1.5%       │  │    234ms     │ │
│  │  ████████████  │  │  █░░░░░░░░░░░  │  │  ████████░░  │ │
│  │  ✓ Healthy     │  │  ⚠ Warning     │  │  ✓ Normal    │ │
│  └────────────────┘  └────────────────┘  └──────────────┘ │
│                                                            │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐ │
│  │  Actions/min   │  │  Decisions/min │  │  Throttles   │ │
│  │      12        │  │       3        │  │      0       │ │
│  │  ████████░░░░  │  │  ███░░░░░░░░░  │  │  ░░░░░░░░░░  │ │
│  │  ✓ Normal      │  │  ✓ Normal      │  │  ✓ Healthy   │ │
│  └────────────────┘  └────────────────┘  └──────────────┘ │
│                                                            │
│  Recent Errors:                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  14:32:30  Lambda deployment timeout (recovered)     │ │
│  │  14:20:15  DynamoDB throttle (resolved)              │ │
│  └──────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

### Metric Calculations

```typescript
// Calculate success rate from last N actions
const recentActions = await getRecentActions(tenantId, last5Minutes);
const successCount = recentActions.filter(a => a.result === 'success').length;
const successRate = (successCount / recentActions.length) * 100;

// Calculate error rate
const errorRate = 100 - successRate;

// Calculate average latency
const avgLatency = recentActions.reduce((sum, a) => sum + a.apiCall.durationMs, 0) / recentActions.length;

// Count throttles
const throttleCount = recentActions.filter(a =>
  a.apiCall.errorCode === 'ThrottlingException' ||
  a.apiCall.errorCode === 'ProvisionedThroughputExceededException'
).length;
```

---

## Decision Timeline View

### Design

```
┌────────────────────────────────────────────────────────────┐
│  Decision Timeline                                         │
├────────────────────────────────────────────────────────────┤
│  March 20, 2026                                            │
│                                                            │
│  14:32:00  ◉────────────────────────────────────────────  │
│            Decision: Compute platform                      │
│            Selected: Lambda (9.2/10)                       │
│            Cost: $120/mo | Confidence: 92%                │
│            [View Details]                                  │
│                                                            │
│  14:31:00  ◉────────────────────────────────────────────  │
│            Decision: Database engine                       │
│            Selected: DynamoDB (9.2/10)                     │
│            Cost: $45/mo | Confidence: 92%                 │
│            [View Details]                                  │
│                                                            │
│  14:30:00  ◉────────────────────────────────────────────  │
│            Decision: Backup strategy                       │
│            Selected: S3 snapshots (8.5/10)                 │
│            Cost: $5/mo | Confidence: 88%                  │
│            [View Details]                                  │
│                                                            │
│  [Filter by Confidence] [Filter by Cost] [Export]         │
└────────────────────────────────────────────────────────────┘
```

---

## WebSocket Real-Time Updates

### Connection Flow

```typescript
// Client connects to WebSocket API
const ws = new WebSocket('wss://api.chimera.aws/ws');

// Authenticate
ws.send(JSON.stringify({
  action: 'auth',
  token: userToken
}));

// Subscribe to tenant activity
ws.send(JSON.stringify({
  action: 'subscribe',
  tenantId: 'tenant-acme'
}));

// Receive real-time updates
ws.onmessage = (event) => {
  const update = JSON.parse(event.data);

  switch (update.type) {
    case 'decision-made':
      addToActivityFeed(update.payload);
      updateCostTracker(update.payload.cost);
      break;

    case 'action-executed':
      addToActivityFeed(update.payload);
      updateResourceMap(update.payload.resource);
      break;

    case 'error-occurred':
      addToActivityFeed(update.payload);
      incrementErrorCount();
      break;
  }
};
```

### EventBridge Integration

```typescript
// Lambda function triggered by EventBridge
export async function publishWebSocketUpdate(event: EventBridgeEvent) {
  const { tenantId, eventType, payload } = event.detail;

  // Get all connected clients for this tenant
  const connections = await getConnectionsByTenant(tenantId);

  // Publish to all clients
  for (const connectionId of connections) {
    await apiGatewayManagementApi.postToConnection({
      ConnectionId: connectionId,
      Data: JSON.stringify({
        type: eventType,
        payload,
        timestamp: new Date().toISOString()
      })
    });
  }
}
```

---

## CloudWatch Integration

### Auto-Generated Dashboards

Chimera creates CloudWatch dashboard per tenant:

```typescript
await cloudwatch.putDashboard({
  DashboardName: `Chimera-${tenantId}`,
  DashboardBody: JSON.stringify({
    widgets: [
      {
        type: 'metric',
        properties: {
          metrics: [
            ['Chimera/Activity', 'DecisionsMade', { stat: 'Sum', label: 'Decisions' }],
            ['...', 'ActionsExecuted', { stat: 'Sum', label: 'Actions' }]
          ],
          period: 300,
          stat: 'Sum',
          region: 'us-west-2',
          title: 'Agent Activity'
        }
      },
      {
        type: 'metric',
        properties: {
          metrics: [
            ['Chimera/Activity', 'EstimatedCostImpact', { stat: 'Sum' }]
          ],
          period: 3600,
          stat: 'Sum',
          region: 'us-west-2',
          title: 'Cost Impact (Hourly)'
        }
      }
    ]
  })
});
```

---

## QuickSight Analytics

### Dashboard Templates

Pre-built QuickSight dashboards for:

1. **Activity Summary**
   - Decisions per day
   - Actions per day
   - Success/error rates

2. **Cost Analysis**
   - Cost by service
   - Cost by decision
   - Cost trends over time

3. **Performance Metrics**
   - API call latency
   - Retry rates
   - Throttle frequency

### Data Source

QuickSight connects to Athena:

```sql
-- Daily activity summary
SELECT
  DATE(timestamp) AS activity_date,
  COUNT(DISTINCT CASE WHEN activityType = 'decision' THEN activityId END) AS decisions,
  COUNT(DISTINCT CASE WHEN activityType = 'action' THEN activityId END) AS actions,
  SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS success_rate,
  SUM(cost.estimatedMonthly) AS total_cost
FROM chimera_activities
WHERE tenantId = 'tenant-acme'
  AND year = 2026
  AND month = 3
GROUP BY DATE(timestamp)
ORDER BY activity_date DESC;
```

---

## Code Examples

### Dashboard Backend (WebSocket Handler)

```typescript
import { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';

const ddb = new DynamoDBClient({});
const apigw = new ApiGatewayManagementApiClient({});

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const { connectionId, routeKey } = event.requestContext;

  switch (routeKey) {
    case '$connect':
      return { statusCode: 200 };

    case '$disconnect':
      await removeConnection(connectionId);
      return { statusCode: 200 };

    case 'subscribe':
      const { tenantId } = JSON.parse(event.body);
      await saveConnection(connectionId, tenantId);
      return { statusCode: 200 };

    default:
      return { statusCode: 400 };
  }
};

async function saveConnection(connectionId: string, tenantId: string) {
  await ddb.putItem({
    TableName: 'chimera-websocket-connections',
    Item: {
      connectionId: { S: connectionId },
      tenantId: { S: tenantId },
      connectedAt: { N: Date.now().toString() }
    }
  });
}
```

### Dashboard Frontend (React Component)

```tsx
import React, { useEffect, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';

export const ActivityFeed: React.FC = () => {
  const [activities, setActivities] = useState<Activity[]>([]);
  const ws = useWebSocket('wss://api.chimera.aws/ws');

  useEffect(() => {
    ws.subscribe('tenant-acme');

    ws.on('decision-made', (payload) => {
      setActivities(prev => [
        { type: 'decision', ...payload, timestamp: new Date() },
        ...prev
      ]);
    });

    ws.on('action-executed', (payload) => {
      setActivities(prev => [
        { type: 'action', ...payload, timestamp: new Date() },
        ...prev
      ]);
    });
  }, [ws]);

  return (
    <div className="activity-feed">
      {activities.map(activity => (
        <ActivityItem key={activity.activityId} activity={activity} />
      ))}
    </div>
  );
};
```

---

## Key Takeaways

1. **Real-time visibility** — dashboards update as agent works, not after completion

2. **WebSocket updates** — sub-second latency from decision → dashboard via EventBridge

3. **Multiple views** — activity feed, resource map, cost tracker, health indicators

4. **Interactive** — click resources for details, export graphs, set alerts

5. **Cost awareness** — cumulative spend visible in real-time, not days later in Cost Explorer

6. **Error detection** — failures visible immediately, not buried in CloudWatch logs

7. **Stakeholder confidence** — non-technical users can watch agent work without fear

8. **CloudWatch integration** — auto-generated dashboards complement custom UI

---

**Series Complete:** All 6 documents in AWS Account Agent Activity Documentation series now available.

**Summary:**
1. [[01-Activity-Logging-Architecture-Overview]] — System architecture
2. [[02-Decision-Logs-Reasoning-Capture]] — Decision documentation
3. [[03-Action-Audit-Trail-Structured-Storage]] — Action logging
4. [[04-Auto-Generated-ADRs]] — Architecture decision records
5. [[05-Runbook-Auto-Generation]] — Operational documentation
6. [[06-Real-Time-Status-Dashboards]] — Live visibility (this document)
