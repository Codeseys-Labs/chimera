# AWS Chimera: Action Audit Trail and Structured Storage

> **Research Date:** 2026-03-20
> **Status:** Complete
> **Series:** AWS Account Agent Activity Documentation (3 of 6)
> **See also:** [[01-Activity-Logging-Architecture-Overview]] | [[02-Decision-Logs-Reasoning-Capture]] | [[04-Auto-Generated-ADRs]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#Beyond CloudTrail]]
- [[#Action Log Schema]]
- [[#Structured Storage Strategy]]
- [[#Linking Actions to Decisions]]
- [[#Resource Tagging and Tracking]]
- [[#API Call Audit Trail]]
- [[#Configuration Change Tracking]]
- [[#Cost Attribution Per Action]]
- [[#Query Patterns]]
- [[#Compliance and Retention]]
- [[#Key Takeaways]]

---

## Executive Summary

Chimera's **action audit trail** records every API call, resource creation, configuration change, and infrastructure modification in structured format. Unlike CloudTrail (which captures *what* happened), Chimera's action logs capture *why*, *who*, *what*, *when*, and *how much it cost*.

**Key Capabilities:**
- ✅ Every AWS API call logged with request/response payloads
- ✅ Actions linked to decisions via `activityId`
- ✅ Resource ARNs tracked from creation through deletion
- ✅ Configuration changes captured with before/after state
- ✅ Cost impact estimated per action
- ✅ Queryable in DynamoDB (hot) and S3/Athena (warm/cold)
- ✅ Compliance-ready retention (90 days to 7 years)

**Use Cases:**
- "Show me all resources created by agent in last 30 days"
- "What was the before/after state when agent modified this security group?"
- "Which decision led to creation of this Lambda function?"
- "Calculate total infrastructure cost created by agent this month"
- "Generate compliance report: all IAM policy changes in Q1 2026"

---

## Beyond CloudTrail

### What CloudTrail Provides

AWS CloudTrail records API calls:

```json
{
  "eventVersion": "1.08",
  "userIdentity": {
    "type": "IAMUser",
    "principalId": "AIDAI...",
    "arn": "arn:aws:iam::123456789012:user/chimera-agent",
    "accountId": "123456789012",
    "accessKeyId": "AKIAI..."
  },
  "eventTime": "2026-03-20T14:31:15Z",
  "eventSource": "dynamodb.amazonaws.com",
  "eventName": "CreateTable",
  "awsRegion": "us-west-2",
  "sourceIPAddress": "203.0.113.42",
  "userAgent": "aws-sdk-js/3.515.0",
  "requestParameters": {
    "tableName": "chimera-sessions",
    "billingMode": "PAY_PER_REQUEST",
    "keySchema": [/* ... */]
  },
  "responseElements": {
    "tableDescription": {
      "tableArn": "arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions",
      "tableStatus": "CREATING"
    }
  }
}
```

**CloudTrail Limitations:**

1. **No business context** — doesn't explain *why* table was created
2. **No decision linkage** — can't connect API call to agent's reasoning
3. **No cost attribution** — can't answer "what did this action cost?"
4. **Generic identity** — all actions from "chimera-agent" user, can't distinguish which agent/tenant
5. **Short retention** — default 90 days, expensive to keep longer
6. **Not optimized for queries** — S3 logs require Athena, slow for operational queries

### Chimera's Enhancement

Chimera action logs **augment** CloudTrail with structured business context:

```json
{
  // CloudTrail data (subset)
  "awsEventName": "CreateTable",
  "awsRequestId": "ABCD1234...",
  "awsEventTime": "2026-03-20T14:31:15Z",

  // Chimera enrichments
  "activityId": "act-2026-03-20-a1b2c3",  // Links to decision log
  "decisionId": "act-2026-03-20-db-001",  // Which decision caused this action
  "tenantId": "tenant-acme",
  "agentId": "agent-claude-3-5",
  "sessionId": "sess-2026-03-20-xyz",

  "actionType": "aws.dynamodb.create_table",
  "actionIntent": "Create multi-tenant session storage table",

  "resource": {
    "type": "DynamoDB Table",
    "name": "chimera-sessions",
    "arn": "arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions",
    "createdAt": "2026-03-20T14:31:15Z"
  },

  "costEstimate": {
    "immediate": 0.00,
    "monthly": 45.00,
    "confidence": "high"
  },

  "tags": {
    "chimera:tenant-id": "tenant-acme",
    "chimera:decision-id": "act-2026-03-20-db-001",
    "chimera:agent-id": "agent-claude-3-5",
    "chimera:purpose": "session-storage"
  }
}
```

**Benefits:**
- ✅ **Business context:** "This table supports session storage per decision db-001"
- ✅ **Decision linkage:** Query decision log to understand *why* table was created
- ✅ **Cost attribution:** Immediately know this action costs ~$45/month
- ✅ **Tenant isolation:** Filter actions by tenantId for multi-tenant audit
- ✅ **Fast operational queries:** DynamoDB query returns results in < 10ms

---

## Action Log Schema

### Core Structure

```typescript
interface ActionLog {
  // Identity
  actionId: string;          // "action-2026-03-20-x7y8z9"
  activityId: string;        // "act-2026-03-20-a1b2c3" (parent decision)
  decisionId?: string;       // Optional: explicit decision reference
  tenantId: string;
  agentId: string;
  sessionId: string;
  timestamp: string;         // ISO 8601

  // Action Classification
  actionType: string;        // "aws.dynamodb.create_table"
  actionCategory: "create" | "update" | "delete" | "read" | "config_change";
  actionIntent: string;      // Human-readable purpose

  // AWS API Details
  awsService: string;        // "DynamoDB"
  awsAction: string;         // "CreateTable"
  awsRegion: string;
  awsRequestId: string;      // AWS request ID from API response
  awsEventTime: string;

  // Resource Information
  resource: {
    type: string;            // "DynamoDB Table", "Lambda Function", etc.
    name: string;
    arn?: string;            // ARN once resource is created
    identifier?: string;     // Resource ID, table name, function name, etc.
    metadata?: Record<string, any>;
  };

  // API Call Details
  apiCall: {
    requestParameters: any;  // What was sent to AWS API
    responseElements?: any;  // What AWS API returned
    errorCode?: string;      // If action failed
    errorMessage?: string;
    durationMs: number;      // How long API call took
    retryCount: number;      // Number of retries
  };

  // State Change (for updates)
  stateChange?: {
    before: any;
    after: any;
    diff: any;               // JSONPatch format
  };

  // Cost Impact
  cost: {
    immediate: number;       // One-time cost (USD)
    estimatedMonthly: number;
    estimatedAnnual: number;
    confidence: "high" | "medium" | "low";
    source: "aws-pricing-api" | "estimate" | "actual";
  };

  // Execution Context
  executionContext: {
    traceId: string;         // X-Ray trace ID
    parentSpanId?: string;   // Parent span for nested calls
    toolName?: string;       // Which tool was used
    codeLocation?: string;   // File:line where action originated
  };

  // Tags (propagated to resource)
  tags: Record<string, string>;

  // Result
  result: "success" | "failure" | "partial";
  resultMessage?: string;
}
```

### Example: Create DynamoDB Table

```json
{
  "actionId": "action-2026-03-20-ddb-001",
  "activityId": "act-2026-03-20-a1b2c3",
  "decisionId": "act-2026-03-20-db-001",
  "tenantId": "tenant-acme",
  "agentId": "agent-claude-3-5",
  "sessionId": "sess-2026-03-20-xyz789",
  "timestamp": "2026-03-20T14:31:15.234Z",

  "actionType": "aws.dynamodb.create_table",
  "actionCategory": "create",
  "actionIntent": "Create multi-tenant session storage table with 30-day TTL",

  "awsService": "DynamoDB",
  "awsAction": "CreateTable",
  "awsRegion": "us-west-2",
  "awsRequestId": "ABCD1234EFGH5678",
  "awsEventTime": "2026-03-20T14:31:15.234Z",

  "resource": {
    "type": "DynamoDB Table",
    "name": "chimera-sessions",
    "arn": "arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions",
    "identifier": "chimera-sessions",
    "metadata": {
      "billingMode": "PAY_PER_REQUEST",
      "keySchema": [
        { "AttributeName": "PK", "KeyType": "HASH" },
        { "AttributeName": "SK", "KeyType": "RANGE" }
      ],
      "attributeDefinitions": [
        { "AttributeName": "PK", "AttributeType": "S" },
        { "AttributeName": "SK", "AttributeType": "S" }
      ],
      "ttlEnabled": true,
      "ttlAttributeName": "expiresAt"
    }
  },

  "apiCall": {
    "requestParameters": {
      "tableName": "chimera-sessions",
      "billingMode": "PAY_PER_REQUEST",
      "keySchema": [/* ... */],
      "attributeDefinitions": [/* ... */],
      "tags": [
        { "Key": "chimera:tenant-id", "Value": "tenant-acme" },
        { "Key": "chimera:decision-id", "Value": "act-2026-03-20-db-001" }
      ]
    },
    "responseElements": {
      "tableDescription": {
        "tableName": "chimera-sessions",
        "tableStatus": "CREATING",
        "tableArn": "arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions",
        "creationDateTime": "2026-03-20T14:31:15.234Z"
      }
    },
    "durationMs": 234,
    "retryCount": 0
  },

  "cost": {
    "immediate": 0.00,
    "estimatedMonthly": 45.00,
    "estimatedAnnual": 540.00,
    "confidence": "high",
    "source": "aws-pricing-api"
  },

  "executionContext": {
    "traceId": "1-5e1c6f5a-3d8e9f0a1b2c3d4e5f6a7b8c",
    "toolName": "setup_database",
    "codeLocation": "src/tools/database.ts:42"
  },

  "tags": {
    "chimera:tenant-id": "tenant-acme",
    "chimera:decision-id": "act-2026-03-20-db-001",
    "chimera:agent-id": "agent-claude-3-5",
    "chimera:purpose": "session-storage",
    "chimera:created-by": "chimera-agent",
    "chimera:created-at": "2026-03-20T14:31:15Z"
  },

  "result": "success",
  "resultMessage": "Table chimera-sessions created successfully in CREATING state"
}
```

### Example: Update Security Group (State Change)

```json
{
  "actionId": "action-2026-03-20-sg-002",
  "activityId": "act-2026-03-20-a1b2c3",
  "decisionId": "act-2026-03-20-sec-005",
  "tenantId": "tenant-acme",
  "agentId": "agent-claude-3-5",
  "timestamp": "2026-03-20T15:45:30.456Z",

  "actionType": "aws.ec2.authorize_security_group_ingress",
  "actionCategory": "update",
  "actionIntent": "Allow inbound HTTPS from Application Load Balancer",

  "awsService": "EC2",
  "awsAction": "AuthorizeSecurityGroupIngress",
  "awsRegion": "us-west-2",

  "resource": {
    "type": "Security Group",
    "name": "chimera-ecs-tasks-sg",
    "arn": "arn:aws:ec2:us-west-2:123456789012:security-group/sg-0a1b2c3d4e5f6",
    "identifier": "sg-0a1b2c3d4e5f6"
  },

  "apiCall": {
    "requestParameters": {
      "groupId": "sg-0a1b2c3d4e5f6",
      "ipPermissions": [
        {
          "ipProtocol": "tcp",
          "fromPort": 443,
          "toPort": 443,
          "userIdGroupPairs": [
            { "groupId": "sg-alb-0x9y8z7" }
          ]
        }
      ]
    },
    "responseElements": {
      "return": true,
      "securityGroupRuleSet": [
        {
          "securityGroupRuleId": "sgr-0123456789abcdef0",
          "groupId": "sg-0a1b2c3d4e5f6",
          "ipProtocol": "tcp",
          "fromPort": 443,
          "toPort": 443,
          "referencedGroupInfo": {
            "groupId": "sg-alb-0x9y8z7"
          }
        }
      ]
    },
    "durationMs": 189,
    "retryCount": 0
  },

  "stateChange": {
    "before": {
      "inboundRules": [
        {
          "ipProtocol": "tcp",
          "fromPort": 80,
          "toPort": 80,
          "cidrIp": "10.0.0.0/16"
        }
      ]
    },
    "after": {
      "inboundRules": [
        {
          "ipProtocol": "tcp",
          "fromPort": 80,
          "toPort": 80,
          "cidrIp": "10.0.0.0/16"
        },
        {
          "ipProtocol": "tcp",
          "fromPort": 443,
          "toPort": 443,
          "sourceSecurityGroupId": "sg-alb-0x9y8z7"
        }
      ]
    },
    "diff": [
      {
        "op": "add",
        "path": "/inboundRules/-",
        "value": {
          "ipProtocol": "tcp",
          "fromPort": 443,
          "toPort": 443,
          "sourceSecurityGroupId": "sg-alb-0x9y8z7"
        }
      }
    ]
  },

  "cost": {
    "immediate": 0.00,
    "estimatedMonthly": 0.00,
    "estimatedAnnual": 0.00,
    "confidence": "high",
    "source": "aws-pricing-api"
  },

  "executionContext": {
    "traceId": "1-5e1c6f5a-9876543210abcdef",
    "toolName": "configure_networking",
    "codeLocation": "src/tools/networking.ts:128"
  },

  "tags": {
    "chimera:tenant-id": "tenant-acme",
    "chimera:decision-id": "act-2026-03-20-sec-005",
    "chimera:change-type": "security-group-ingress"
  },

  "result": "success",
  "resultMessage": "Added HTTPS ingress rule from ALB security group"
}
```

---

## Structured Storage Strategy

### Three-Tier Storage

```
┌─────────────────────────────────────────────────────────┐
│  HOT: DynamoDB (0-90 days)                              │
│  • Sub-10ms operational queries                          │
│  • Full action logs with all fields                      │
│  • TTL-based expiration                                  │
│  Cost: ~$50/million actions                              │
└──────────────────┬──────────────────────────────────────┘
                   │ Archive every 5 minutes
                   ▼
┌─────────────────────────────────────────────────────────┐
│  WARM: S3 Standard + Athena (91 days - 1 year)         │
│  • SQL queries via Athena                                │
│  • Compressed NDJSON (gzip)                              │
│  • Partitioned by date                                   │
│  Cost: ~$2/million actions                               │
└──────────────────┬──────────────────────────────────────┘
                   │ Lifecycle transition at 1 year
                   ▼
┌─────────────────────────────────────────────────────────┐
│  COLD: S3 Glacier Deep Archive (1-7 years)             │
│  • Compliance retention                                  │
│  • 12-hour retrieval time                                │
│  Cost: ~$0.08/million actions                            │
└─────────────────────────────────────────────────────────┘
```

### DynamoDB Table: `chimera-activity-logs`

```typescript
{
  PK: "TENANT#{tenantId}",
  SK: "ACTION#{timestamp}#{actionId}",

  // Core fields
  actionId: string,
  activityId: string,
  actionType: string,
  actionCategory: string,
  timestamp: string,

  // Full action log
  actionLog: ActionLog,  // Nested document

  // Searchable fields
  resourceArn: string,
  resourceName: string,
  awsService: string,
  awsAction: string,

  // Cost tracking
  estimatedMonthlyCost: number,

  // TTL
  ttl: number  // Unix timestamp (90 days from creation)
}
```

**GSI1: `resource-activity-index`**
```
PK: resourceArn
SK: timestamp
Purpose: "Show me all actions for this Lambda function"
```

**GSI2: `service-action-index`**
```
PK: awsService
SK: timestamp
Purpose: "Show me all DynamoDB actions"
```

**GSI3: `cost-index`**
```
PK: tenantId
SK: estimatedMonthlyCost (descending)
Purpose: "Show me most expensive actions by tenant"
```

### S3 Bucket Structure

```
s3://chimera-activity-archive-{accountId}/
  actions/
    year=2026/
      month=03/
        day=20/
          hour=14/
            tenant-acme-actions-20260320-1400-1405.json.gz
            tenant-beta-actions-20260320-1400-1405.json.gz
            ...
```

**Object Format:** Newline-delimited JSON (NDJSON), gzipped

```json
{"actionId":"action-001","actionType":"aws.dynamodb.create_table",...}
{"actionId":"action-002","actionType":"aws.lambda.create_function",...}
{"actionId":"action-003","actionType":"aws.ec2.authorize_security_group_ingress",...}
```

**Athena Table Definition:**

```sql
CREATE EXTERNAL TABLE chimera_actions (
  actionId STRING,
  activityId STRING,
  decisionId STRING,
  tenantId STRING,
  agentId STRING,
  sessionId STRING,
  timestamp TIMESTAMP,
  actionType STRING,
  actionCategory STRING,
  actionIntent STRING,
  awsService STRING,
  awsAction STRING,
  awsRegion STRING,
  resource STRUCT<
    type: STRING,
    name: STRING,
    arn: STRING,
    identifier: STRING
  >,
  apiCall STRUCT<
    requestParameters: STRING,
    responseElements: STRING,
    errorCode: STRING,
    errorMessage: STRING,
    durationMs: INT
  >,
  cost STRUCT<
    immediate: DOUBLE,
    estimatedMonthly: DOUBLE,
    estimatedAnnual: DOUBLE
  >,
  result STRING,
  tags MAP<STRING, STRING>
)
PARTITIONED BY (
  year INT,
  month INT,
  day INT,
  hour INT
)
STORED AS PARQUET
LOCATION 's3://chimera-activity-archive-123456789012/actions/'
TBLPROPERTIES ('parquet.compression'='SNAPPY');
```

---

## Linking Actions to Decisions

Every action references the decision that caused it:

```typescript
{
  "actionId": "action-2026-03-20-ddb-001",
  "activityId": "act-2026-03-20-a1b2c3",     // Parent activity
  "decisionId": "act-2026-03-20-db-001",     // Originating decision
  ...
}
```

**Query Chain:**

1. **Find action:** `SELECT * FROM chimera_actions WHERE actionId = 'action-2026-03-20-ddb-001'`
2. **Get decision:** `SELECT * FROM chimera_activities WHERE activityId = 'act-2026-03-20-db-001' AND activityType = 'decision'`
3. **Read justification:** decision log contains `alternatives`, `selectedOption`, `justification`

**Use Case: Rollback**

```typescript
// 1. Find action that created resource
const action = await findActionByResourceArn('arn:aws:dynamodb:...:table/chimera-sessions');

// 2. Get original decision
const decision = await getDecisionById(action.decisionId);

// 3. Check if rollback plan exists in ADR
const adr = await getADRByDecisionId(action.decisionId);

// 4. Execute rollback
if (adr.rollbackPlan) {
  await executeRollback(adr.rollbackPlan);
}
```

---

## Resource Tagging and Tracking

### Automatic Tagging

Every resource created by Chimera agent is tagged:

```typescript
const tags = {
  'chimera:tenant-id': tenantId,
  'chimera:decision-id': decisionId,
  'chimera:action-id': actionId,
  'chimera:agent-id': agentId,
  'chimera:created-at': new Date().toISOString(),
  'chimera:purpose': actionIntent,
  'chimera:estimated-monthly-cost': costEstimate.monthly.toFixed(2)
};

// Propagate to AWS resource
await dynamodb.createTable({
  TableName: 'chimera-sessions',
  Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))
});
```

### Resource Lifecycle Tracking

```typescript
// Track resource from creation to deletion
const lifecycle = {
  created: {
    actionId: 'action-2026-03-20-ddb-001',
    timestamp: '2026-03-20T14:31:15Z',
    decisionId: 'act-2026-03-20-db-001'
  },
  updated: [
    {
      actionId: 'action-2026-03-21-ddb-002',
      timestamp: '2026-03-21T09:15:00Z',
      change: 'Added GSI for user queries'
    }
  ],
  deleted: {
    actionId: 'action-2026-04-15-ddb-099',
    timestamp: '2026-04-15T16:45:00Z',
    reason: 'Migration to Aurora completed'
  }
};
```

---

## API Call Audit Trail

### Pre-Action Hook

Before every AWS API call, log the intent:

```typescript
async function executeAWSAction(params: AWSActionParams) {
  // 1. Log pre-action
  const actionId = generateActionId();
  await logPreAction({
    actionId,
    activityId: params.activityId,
    decisionId: params.decisionId,
    actionType: params.actionType,
    actionIntent: params.intent,
    requestParameters: params.requestParams,
    timestamp: new Date().toISOString()
  });

  // 2. Execute AWS API call
  const startTime = Date.now();
  try {
    const response = await aws[params.service][params.action](params.requestParams);
    const durationMs = Date.now() - startTime;

    // 3. Log post-action success
    await logPostAction({
      actionId,
      result: 'success',
      responseElements: response,
      durationMs,
      resourceArn: extractArn(response)
    });

    return response;
  } catch (error) {
    const durationMs = Date.now() - startTime;

    // 4. Log post-action failure
    await logPostAction({
      actionId,
      result: 'failure',
      errorCode: error.code,
      errorMessage: error.message,
      durationMs
    });

    throw error;
  }
}
```

### Retry Tracking

```typescript
let retryCount = 0;
while (retryCount < maxRetries) {
  try {
    const response = await executeAWSAction(params);

    await updateActionLog({
      actionId,
      retryCount,
      result: 'success'
    });

    return response;
  } catch (error) {
    retryCount++;

    await updateActionLog({
      actionId,
      retryCount,
      lastError: error.message
    });

    if (retryCount >= maxRetries) throw error;
    await sleep(exponentialBackoff(retryCount));
  }
}
```

---

## Configuration Change Tracking

### Before/After State Capture

For update actions, capture before/after state:

```typescript
async function updateSecurityGroup(groupId: string, newRule: IngressRule) {
  // 1. Capture current state
  const beforeState = await ec2.describeSecurityGroups({ GroupIds: [groupId] });

  // 2. Apply change
  await ec2.authorizeSecurityGroupIngress({
    GroupId: groupId,
    IpPermissions: [newRule]
  });

  // 3. Capture new state
  const afterState = await ec2.describeSecurityGroups({ GroupIds: [groupId] });

  // 4. Calculate diff
  const diff = jsonpatch.compare(beforeState, afterState);

  // 5. Log action with state change
  await logAction({
    actionType: 'aws.ec2.authorize_security_group_ingress',
    stateChange: {
      before: beforeState,
      after: afterState,
      diff
    }
  });
}
```

### JSONPatch Format

State changes use [JSONPatch](http://jsonpatch.com/) format:

```json
{
  "stateChange": {
    "before": {
      "inboundRules": [
        { "port": 80, "source": "10.0.0.0/16" }
      ]
    },
    "after": {
      "inboundRules": [
        { "port": 80, "source": "10.0.0.0/16" },
        { "port": 443, "source": "sg-alb-123" }
      ]
    },
    "diff": [
      {
        "op": "add",
        "path": "/inboundRules/1",
        "value": { "port": 443, "source": "sg-alb-123" }
      }
    ]
  }
}
```

**Rollback:** Apply reverse patch

```typescript
const reversePatch = jsonpatch.reverse(diff);
const rolledBackState = jsonpatch.applyPatch(afterState, reversePatch);
```

---

## Cost Attribution Per Action

### Immediate Cost

One-time charges for resource creation:

```typescript
{
  "cost": {
    "immediate": 0.00,  // DynamoDB tables have no creation cost
    "source": "aws-pricing-api"
  }
}
```

### Recurring Cost

Estimated monthly/annual charges:

```typescript
async function estimateDynamoDBCost(tableName: string, config: DDBConfig): Promise<Cost> {
  const { readsPerMonth, writesPerMonth, storageGB } = config;

  // Query AWS Price List API
  const pricing = await pricingAPI.getProducts({
    ServiceCode: 'AmazonDynamoDB',
    Filters: [
      { Type: 'TERM_MATCH', Field: 'location', Value: 'US West (Oregon)' },
      { Type: 'TERM_MATCH', Field: 'group', Value: 'DDB-ReadUnits' }
    ]
  });

  const readCost = (readsPerMonth / 1000000) * 0.25;   // $0.25 per million reads
  const writeCost = (writesPerMonth / 1000000) * 1.25; // $1.25 per million writes
  const storageCost = storageGB * 0.25;                 // $0.25 per GB-month

  return {
    immediate: 0.00,
    estimatedMonthly: readCost + writeCost + storageCost,
    estimatedAnnual: (readCost + writeCost + storageCost) * 12,
    confidence: 'high',
    source: 'aws-pricing-api',
    breakdown: {
      reads: readCost,
      writes: writeCost,
      storage: storageCost
    }
  };
}
```

### Cumulative Cost Tracking

```typescript
// Update tenant cost accumulator
await ddb.updateItem({
  TableName: 'chimera-cost-tracking',
  Key: {
    PK: `TENANT#${tenantId}`,
    SK: `MONTH#2026-03`
  },
  UpdateExpression: 'ADD infrastructureCost :cost, resourceCount :one',
  ExpressionAttributeValues: {
    ':cost': costEstimate.monthly,
    ':one': 1
  }
});
```

---

## Query Patterns

### Pattern 1: "Show All Resources Created in Last 30 Days"

**DynamoDB Query:**
```typescript
const actions = await ddb.query({
  TableName: 'chimera-activity-logs',
  KeyConditionExpression: 'PK = :tenantId AND SK > :startDate',
  FilterExpression: 'actionCategory = :category',
  ExpressionAttributeValues: {
    ':tenantId': 'TENANT#acme',
    ':startDate': 'ACTION#2026-02-18T00:00:00Z',
    ':category': 'create'
  }
});

actions.Items.forEach(item => {
  console.log(`${item.actionLog.resource.type}: ${item.actionLog.resource.name}`);
  console.log(`  ARN: ${item.actionLog.resource.arn}`);
  console.log(`  Cost: $${item.actionLog.cost.estimatedMonthly}/month`);
});
```

### Pattern 2: "What Changed in This Security Group?"

**Query by Resource ARN:**
```typescript
const changes = await ddb.query({
  TableName: 'chimera-activity-logs',
  IndexName: 'resource-activity-index',
  KeyConditionExpression: 'resourceArn = :arn',
  ExpressionAttributeValues: {
    ':arn': 'arn:aws:ec2:us-west-2:123456789012:security-group/sg-0a1b2c3d'
  },
  ScanIndexForward: true  // Chronological order
});

changes.Items.forEach(item => {
  if (item.actionLog.stateChange) {
    console.log(`${item.timestamp}: ${item.actionLog.actionIntent}`);
    console.log('Diff:', JSON.stringify(item.actionLog.stateChange.diff, null, 2));
  }
});
```

### Pattern 3: "Total Infrastructure Cost Created This Month"

**Athena Aggregation:**
```sql
SELECT
  tenantId,
  COUNT(*) AS resource_count,
  SUM(cost.estimatedMonthly) AS total_monthly_cost,
  SUM(cost.estimatedAnnual) AS total_annual_cost
FROM chimera_actions
WHERE year = 2026
  AND month = 3
  AND actionCategory = 'create'
  AND result = 'success'
GROUP BY tenantId
ORDER BY total_monthly_cost DESC;
```

### Pattern 4: "Find All Failed Actions"

**DynamoDB Query with Filter:**
```typescript
const failures = await ddb.scan({
  TableName: 'chimera-activity-logs',
  FilterExpression: '#result = :failure',
  ExpressionAttributeNames: {
    '#result': 'result'
  },
  ExpressionAttributeValues: {
    ':failure': 'failure'
  }
});

failures.Items.forEach(item => {
  console.log(`${item.timestamp}: ${item.actionLog.actionType}`);
  console.log(`  Error: ${item.actionLog.apiCall.errorCode} - ${item.actionLog.apiCall.errorMessage}`);
  console.log(`  Decision: ${item.decisionId}`);
});
```

---

## Compliance and Retention

### Retention Policies by Tier

| Tier | DynamoDB TTL | S3 Standard | S3 Glacier | Total Retention |
|------|--------------|-------------|------------|-----------------|
| **Basic** | 7 days | 90 days | - | 97 days |
| **Advanced** | 30 days | 1 year | - | ~13 months |
| **Enterprise** | 90 days | 1 year | 6 years | 7 years |

### SOC2 Compliance

Action logs meet SOC2 Trust Services Criteria:

- **CC6.1 (Logical Access)** — All actions logged with actor (agentId, sessionId)
- **CC6.2 (Privileged Access)** — IAM actions logged separately with approval workflow
- **CC6.3 (Removal of Access)** — Delete actions tracked with reason and approver
- **CC7.2 (System Monitoring)** — Real-time action logging with alerting
- **CC7.3 (Evaluation of Events)** — Athena queries for anomaly detection

### HIPAA Compliance

For tenants handling PHI (Protected Health Information):

- **Encryption at rest** — DynamoDB encrypted with CMK
- **Encryption in transit** — TLS 1.2+ for all API calls
- **Access logging** — Every action includes IP address, user agent
- **Audit trail** — 6-year retention in S3 Glacier
- **Integrity controls** — S3 Object Lock prevents tampering

### Compliance Report Generation

```typescript
async function generateComplianceReport(
  tenantId: string,
  startDate: string,
  endDate: string
): Promise<ComplianceReport> {
  // Query Athena for all actions in date range
  const query = `
    SELECT
      timestamp,
      actionType,
      resource.type AS resource_type,
      resource.name AS resource_name,
      tags['chimera:decision-id'] AS decision_id,
      result
    FROM chimera_actions
    WHERE tenantId = '${tenantId}'
      AND timestamp BETWEEN '${startDate}' AND '${endDate}'
    ORDER BY timestamp ASC
  `;

  const results = await athena.executeQuery(query);

  return {
    tenantId,
    period: { start: startDate, end: endDate },
    summary: {
      totalActions: results.length,
      successfulActions: results.filter(r => r.result === 'success').length,
      failedActions: results.filter(r => r.result === 'failure').length,
      resourcesCreated: results.filter(r => r.actionType.includes('.create')).length,
      resourcesDeleted: results.filter(r => r.actionType.includes('.delete')).length
    },
    actions: results
  };
}
```

---

## Key Takeaways

1. **Augment CloudTrail, don't replace** — Chimera action logs add business context to AWS API calls

2. **Link actions to decisions** — every action references the decision that caused it, enabling "why" queries

3. **State change tracking** — capture before/after for config changes, enables precise rollback

4. **Cost attribution** — estimate cost per action, accumulate by tenant/decision/agent

5. **Three-tier storage** — hot (DynamoDB), warm (S3+Athena), cold (Glacier) balances speed and cost

6. **Compliance-ready** — structured logs meet SOC2, HIPAA, FedRAMP requirements without custom tooling

7. **Resource tagging** — automatic tagging links AWS resources to Chimera decisions

8. **Query patterns** — "show all resources created", "what changed", "total cost" are simple queries

---

**Next:** [[04-Auto-Generated-ADRs]] — How Architecture Decision Records are automatically created for infrastructure changes
