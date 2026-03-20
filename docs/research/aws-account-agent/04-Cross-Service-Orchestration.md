# Cross-Service Orchestration for Multi-Agent Systems

> **Research Date:** 2026-03-20
> **Task:** chimera-83f9
> **Agent:** builder-mcp-orch
> **Status:** Complete
> **Series:** AWS Account Agent Integration (Part 4 of 4)

---

## Table of Contents

- [Executive Summary](#executive-summary)
- [Orchestration Patterns](#orchestration-patterns)
- [AWS Step Functions for Structured Workflows](#aws-step-functions-for-structured-workflows)
- [EventBridge for Event-Driven Coordination](#eventbridge-for-event-driven-coordination)
- [SQS and SNS for Async Communication](#sqs-and-sns-for-async-communication)
- [DynamoDB for State Management](#dynamodb-for-state-management)
- [Lambda for Service Integration](#lambda-for-service-integration)
- [Cross-Service Workflow Patterns](#cross-service-workflow-patterns)
- [Error Handling and Resilience](#error-handling-and-resilience)
- [Observability and Tracing](#observability-and-tracing)
- [Implementation Architecture](#implementation-architecture)
- [Key Takeaways](#key-takeaways)

---

## Executive Summary

Chimera agents orchestrate complex workflows that span multiple AWS services. This research examines patterns for coordinating cross-service operations, including:

1. **Structured Workflows**: AWS Step Functions for sequential/parallel task execution
2. **Event-Driven Coordination**: EventBridge for reactive agent behaviors
3. **Async Communication**: SQS/SNS for decoupled message passing
4. **State Management**: DynamoDB for workflow state persistence
5. **Service Integration**: Lambda as glue between services

**Key Findings:**

- **Step Functions for Deterministic Workflows**: Best for multi-step processes with well-defined control flow (sequential, parallel, branching)
- **EventBridge for Reactive Patterns**: Best for event-driven coordination where agents react to AWS service events
- **Hybrid Approach**: Combine Step Functions (structured) with EventBridge (reactive) for complex agent behaviors
- **State Persistence**: DynamoDB stores workflow state, enabling resume after failures
- **Observability**: AWS X-Ray traces end-to-end across services

**Example Use Case:**

```
Agent Task: "Deploy new microservice to production"

Orchestration:
1. Step Functions coordinates deployment workflow
2. EventBridge triggers agent on CodePipeline completion
3. SQS buffers agent tasks during traffic spikes
4. DynamoDB tracks deployment state across stages
5. Lambda integrates with GitHub, Slack, PagerDuty
6. X-Ray traces entire workflow end-to-end
```

---

## Orchestration Patterns

### Pattern 1: Sequential Service Chain

**Use Case:** Multi-step process where each step depends on previous completion.

```
Step 1: Create S3 bucket
   ↓
Step 2: Deploy Lambda function (references bucket)
   ↓
Step 3: Configure API Gateway (points to Lambda)
   ↓
Step 4: Update Route53 DNS (points to API Gateway)
```

**Implementation: Step Functions State Machine**

```json
{
  "StartAt": "CreateBucket",
  "States": {
    "CreateBucket": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:CreateS3Bucket",
      "Parameters": {
        "bucketName.$": "$.bucketName",
        "region.$": "$.region"
      },
      "ResultPath": "$.bucketArn",
      "Next": "DeployLambda"
    },
    "DeployLambda": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:DeployLambdaFunction",
      "Parameters": {
        "functionName.$": "$.functionName",
        "bucketArn.$": "$.bucketArn"
      },
      "ResultPath": "$.lambdaArn",
      "Next": "ConfigureAPIGateway"
    },
    "ConfigureAPIGateway": {
      "Type": "Task",
      "Resource": "arn:aws:states:::apigateway:invoke",
      "Parameters": {
        "ApiEndpoint": "https://apigateway.amazonaws.com",
        "Method": "POST",
        "Stage": "prod",
        "Path": "/restapis",
        "RequestBody": {
          "name.$": "$.apiName",
          "endpointConfiguration": {
            "types": ["REGIONAL"]
          }
        }
      },
      "ResultPath": "$.apiGatewayId",
      "Next": "UpdateRoute53"
    },
    "UpdateRoute53": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:UpdateRoute53Record",
      "Parameters": {
        "hostedZoneId.$": "$.hostedZoneId",
        "recordName.$": "$.domainName",
        "targetEndpoint.$": "$.apiGatewayId"
      },
      "End": true
    }
  }
}
```

### Pattern 2: Parallel Fan-Out

**Use Case:** Execute multiple independent tasks concurrently.

```
                     ┌─→ Deploy to us-east-1
                     │
Start Deployment ────┼─→ Deploy to us-west-2
                     │
                     └─→ Deploy to eu-central-1
```

**Implementation: Step Functions Parallel State**

```json
{
  "StartAt": "ParallelDeploy",
  "States": {
    "ParallelDeploy": {
      "Type": "Parallel",
      "Branches": [
        {
          "StartAt": "DeployUSEast",
          "States": {
            "DeployUSEast": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:...:function:DeployToRegion",
              "Parameters": {
                "region": "us-east-1",
                "config.$": "$.config"
              },
              "End": true
            }
          }
        },
        {
          "StartAt": "DeployUSWest",
          "States": {
            "DeployUSWest": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:...:function:DeployToRegion",
              "Parameters": {
                "region": "us-west-2",
                "config.$": "$.config"
              },
              "End": true
            }
          }
        },
        {
          "StartAt": "DeployEUCentral",
          "States": {
            "DeployEUCentral": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:...:function:DeployToRegion",
              "Parameters": {
                "region": "eu-central-1",
                "config.$": "$.config"
              },
              "End": true
            }
          }
        }
      ],
      "ResultPath": "$.deploymentResults",
      "Next": "VerifyAllDeployments"
    },
    "VerifyAllDeployments": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:VerifyDeployments",
      "End": true
    }
  }
}
```

### Pattern 3: Event-Driven Reactive

**Use Case:** Agent reacts to AWS service events without explicit invocation.

```
CloudWatch Alarm (High CPU) → EventBridge → Agent → Scale ECS Service
CodePipeline (Deploy Failed) → EventBridge → Agent → Notify on-call + Rollback
S3 (File Uploaded) → EventBridge → Agent → Process data + Update DynamoDB
```

**Implementation: EventBridge Rule**

```json
{
  "EventPattern": {
    "source": ["aws.cloudwatch"],
    "detail-type": ["CloudWatch Alarm State Change"],
    "detail": {
      "alarmName": ["HighCPUAlarm"],
      "state": {
        "value": ["ALARM"]
      }
    }
  },
  "Targets": [
    {
      "Id": "InvokeScalingAgent",
      "Arn": "arn:aws:lambda:...:function:ChimeraAgentInvoker",
      "Input": "{\"agentId\": \"scaling-agent\", \"task\": \"Investigate high CPU and scale if needed\"}"
    }
  ]
}
```

### Pattern 4: Saga Pattern (Distributed Transaction)

**Use Case:** Multi-service operation with compensating actions for rollback.

```
Reserve Inventory → Charge Payment → Ship Order
     ↓ (fail)          ↓ (fail)        ↓ (fail)
Release Inventory ← Refund Payment ← Cancel Shipment
```

**Implementation: Step Functions with Catch Blocks**

```json
{
  "StartAt": "ReserveInventory",
  "States": {
    "ReserveInventory": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:ReserveInventory",
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "InventoryReservationFailed"
        }
      ],
      "Next": "ChargePayment"
    },
    "ChargePayment": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:ChargePayment",
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "ReleaseInventory"
        }
      ],
      "Next": "ShipOrder"
    },
    "ShipOrder": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:ShipOrder",
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "RefundPayment"
        }
      ],
      "End": true
    },
    "ReleaseInventory": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:ReleaseInventory",
      "Next": "OrderFailed"
    },
    "RefundPayment": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:RefundPayment",
      "Next": "ReleaseInventory"
    },
    "InventoryReservationFailed": {
      "Type": "Fail",
      "Error": "InventoryUnavailable"
    },
    "OrderFailed": {
      "Type": "Fail",
      "Error": "OrderProcessingFailed"
    }
  }
}
```

---

## AWS Step Functions for Structured Workflows

### Why Step Functions for Agent Workflows?

**Advantages:**
1. **Visual Workflow Definition**: See agent task flow in AWS console
2. **Built-in Error Handling**: Automatic retries, catch blocks, compensating actions
3. **State Persistence**: Resume workflows after failures
4. **Integration with 200+ AWS Services**: Native service integrations (no Lambda glue code)
5. **Observability**: View execution history, inspect state transitions
6. **Cost-Effective**: Pay per state transition ($0.025 per 1,000 transitions)

### Chimera Integration Pattern

**Agent-Driven Step Functions:**

```typescript
// Agent invokes Step Functions workflow
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const sfn = new SFNClient({ region: 'us-east-1' });

// Agent decides to start a deployment workflow
const command = new StartExecutionCommand({
  stateMachineArn: 'arn:aws:states:...:stateMachine:DeployMicroservice',
  input: JSON.stringify({
    serviceName: 'api-gateway',
    version: 'v1.2.3',
    targetEnv: 'production',
    deployStrategy: 'blue-green'
  }),
  name: `deploy-${Date.now()}` // Unique execution name
});

const response = await sfn.send(command);

console.log(`Workflow started: ${response.executionArn}`);

// Agent monitors workflow progress
const execution = await sfn.send(new DescribeExecutionCommand({
  executionArn: response.executionArn
}));

if (execution.status === 'FAILED') {
  // Agent handles failure, potentially triggering rollback
}
```

### Step Functions as MCP Tool

```typescript
// Expose Step Functions operations as MCP tools
@mcp.tool()
async def sfn__start_execution(
    state_machine_arn: str,
    input_data: dict,
    execution_name: str | None = None
) -> dict:
    """Start a Step Functions workflow execution."""

    import boto3
    import json

    sfn = boto3.client('stepfunctions')

    response = sfn.start_execution(
        stateMachineArn=state_machine_arn,
        input=json.dumps(input_data),
        name=execution_name or f"exec-{int(time.time())}"
    )

    return {
        "executionArn": response["executionArn"],
        "startDate": response["startDate"].isoformat()
    }

@mcp.tool()
async def sfn__describe_execution(execution_arn: str) -> dict:
    """Get status of a Step Functions execution."""

    sfn = boto3.client('stepfunctions')

    response = sfn.describe_execution(executionArn=execution_arn)

    return {
        "status": response["status"],  # RUNNING, SUCCEEDED, FAILED, TIMED_OUT, ABORTED
        "startDate": response["startDate"].isoformat(),
        "stopDate": response.get("stopDate", "").isoformat() if response.get("stopDate") else None,
        "output": json.loads(response.get("output", "{}")),
        "error": response.get("error"),
        "cause": response.get("cause")
    }
```

### Workflow Patterns for Agent Tasks

#### Pattern: Multi-Agent Collaboration Workflow

```json
{
  "Comment": "Multi-agent research workflow",
  "StartAt": "AssignResearchTasks",
  "States": {
    "AssignResearchTasks": {
      "Type": "Parallel",
      "Branches": [
        {
          "StartAt": "ResearchAgent1",
          "States": {
            "ResearchAgent1": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:...:function:InvokeAgent",
              "Parameters": {
                "agentId": "research-agent-1",
                "task": "Research AWS Step Functions best practices"
              },
              "End": true
            }
          }
        },
        {
          "StartAt": "ResearchAgent2",
          "States": {
            "ResearchAgent2": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:...:function:InvokeAgent",
              "Parameters": {
                "agentId": "research-agent-2",
                "task": "Research EventBridge integration patterns"
              },
              "End": true
            }
          }
        }
      ],
      "ResultPath": "$.researchResults",
      "Next": "SynthesizeFindings"
    },
    "SynthesizeFindings": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:InvokeAgent",
      "Parameters": {
        "agentId": "synthesis-agent",
        "task": "Synthesize research findings into comprehensive report",
        "context.$": "$.researchResults"
      },
      "End": true
    }
  }
}
```

---

## EventBridge for Event-Driven Coordination

### Event-Driven Agent Patterns

**Pattern 1: Service Event → Agent Reaction**

```
AWS Service Event → EventBridge → Lambda → Invoke Agent
```

**Example: CodePipeline Failure Handling**

```json
{
  "EventBridgeRule": {
    "Name": "CodePipelineFailureHandler",
    "EventPattern": {
      "source": ["aws.codepipeline"],
      "detail-type": ["CodePipeline Pipeline Execution State Change"],
      "detail": {
        "state": ["FAILED"]
      }
    },
    "Targets": [
      {
        "Arn": "arn:aws:lambda:...:function:InvokeFailureAgent",
        "Input": {
          "agentId": "devops-agent",
          "task": "Analyze pipeline failure and propose fixes",
          "context": {
            "pipelineName": "$.detail.pipeline",
            "executionId": "$.detail.execution-id",
            "failedAction": "$.detail.stage"
          }
        }
      }
    ]
  }
}
```

**Pattern 2: Agent Publishes Custom Events**

```typescript
// Agent publishes event after completing task
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const eventbridge = new EventBridgeClient({});

await eventbridge.send(new PutEventsCommand({
  Entries: [
    {
      Source: 'chimera.agent',
      DetailType: 'AgentTaskCompleted',
      Detail: JSON.stringify({
        agentId: 'research-agent-1',
        taskId: 'task-12345',
        result: {
          findingsCount: 15,
          confidence: 0.92,
          summary: 'Step Functions provides native error handling...'
        },
        timestamp: new Date().toISOString()
      }),
      EventBusName: 'chimera-agent-events'
    }
  ]
}));
```

**Pattern 3: Event-Driven Multi-Agent Coordination**

```
Agent A completes task → EventBridge → Agent B starts dependent task
                           ↓
                      Agent C (observer) logs to DynamoDB
```

**EventBridge Rule for Agent Coordination:**

```json
{
  "Name": "AgentTaskChain",
  "EventPattern": {
    "source": ["chimera.agent"],
    "detail-type": ["AgentTaskCompleted"],
    "detail": {
      "agentId": ["research-agent-1"]
    }
  },
  "Targets": [
    {
      "Id": "TriggerSynthesisAgent",
      "Arn": "arn:aws:lambda:...:function:InvokeAgent",
      "Input": {
        "agentId": "synthesis-agent",
        "task": "Synthesize research findings",
        "context": "$.detail.result"
      }
    },
    {
      "Id": "LogToObservability",
      "Arn": "arn:aws:lambda:...:function:LogAgentActivity",
      "InputTransformer": {
        "InputPathsMap": {
          "agentId": "$.detail.agentId",
          "taskId": "$.detail.taskId",
          "result": "$.detail.result"
        },
        "InputTemplate": "{\"event\": \"task_completed\", \"data\": <result>}"
      }
    }
  ]
}
```

### EventBridge Pipes for Stream Processing

**Use Case:** Process DynamoDB Streams or SQS messages with transformation.

```
DynamoDB Stream → EventBridge Pipe (filter/transform) → Target (Lambda, Step Functions, SQS)
```

**Example: Agent Session State Changes**

```typescript
// EventBridge Pipe configuration
{
  "Name": "AgentSessionPipe",
  "Source": "arn:aws:dynamodb:...:table/chimera-sessions/stream/...",
  "Target": "arn:aws:lambda:...:function:HandleSessionChange",
  "SourceParameters": {
    "DynamoDBStreamParameters": {
      "StartingPosition": "LATEST",
      "BatchSize": 10
    }
  },
  "Enrichment": "arn:aws:lambda:...:function:EnrichSessionData",
  "Filter": {
    "Pattern": {
      "dynamodb": {
        "NewImage": {
          "status": {
            "S": ["ACTIVE", "COMPLETED", "FAILED"]
          }
        }
      }
    }
  }
}
```

---

## SQS and SNS for Async Communication

### SQS: Queue-Based Task Distribution

**Pattern: Agent Task Queue**

```
Agent Orchestrator → SQS Queue → Worker Agents (poll queue)
```

**Implementation:**

```typescript
// Orchestrator pushes tasks to queue
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});

await sqs.send(new SendMessageCommand({
  QueueUrl: 'https://sqs.us-east-1.amazonaws.com/.../chimera-agent-tasks',
  MessageBody: JSON.stringify({
    taskId: 'task-12345',
    agentType: 'research',
    instruction: 'Research Step Functions error handling patterns',
    priority: 'high',
    timeout: 300
  }),
  MessageAttributes: {
    Priority: {
      DataType: 'Number',
      StringValue: '1'
    }
  }
}));

// Worker agent polls queue
const messages = await sqs.send(new ReceiveMessageCommand({
  QueueUrl: 'https://sqs.us-east-1.amazonaws.com/.../chimera-agent-tasks',
  MaxNumberOfMessages: 10,
  WaitTimeSeconds: 20,  // Long polling
  VisibilityTimeout: 300  // 5 minutes to process
}));

for (const message of messages.Messages || []) {
  const task = JSON.parse(message.Body);

  // Process task
  await executeAgentTask(task);

  // Delete message after successful processing
  await sqs.send(new DeleteMessageCommand({
    QueueUrl: 'https://sqs.us-east-1.amazonaws.com/.../chimera-agent-tasks',
    ReceiptHandle: message.ReceiptHandle
  }));
}
```

### SNS: Pub/Sub Notifications

**Pattern: Agent Event Broadcasting**

```
Agent Event → SNS Topic → Multiple Subscribers (agents, logs, metrics)
```

**Implementation:**

```typescript
// Agent publishes notification
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const sns = new SNSClient({});

await sns.send(new PublishCommand({
  TopicArn: 'arn:aws:sns:...:chimera-agent-notifications',
  Subject: 'Deployment Completed',
  Message: JSON.stringify({
    agentId: 'deployment-agent',
    taskId: 'deploy-12345',
    result: 'success',
    details: {
      service: 'api-gateway',
      version: 'v1.2.3',
      deployedAt: new Date().toISOString()
    }
  }),
  MessageAttributes: {
    EventType: {
      DataType: 'String',
      StringValue: 'deployment.completed'
    }
  }
}));

// Subscribers receive notification:
// - Lambda: Send Slack notification
// - SQS: Queue for analytics processing
// - Email: Notify on-call engineer
```

### Chimera Orchestration: Dual Queue Strategy

**From Mulch Expertise:**
```
Dual SQS queue strategy:
(1) Standard queue for swarm task distribution (parallel workers)
(2) FIFO queue for sequential agent coordination with exactly-once semantics
```

**Implementation:**

```typescript
// Standard Queue: Parallel task distribution
const standardQueue = 'https://sqs.us-east-1.amazonaws.com/.../chimera-tasks.fifo';

// FIFO Queue: Sequential coordination
const fifoQueue = 'https://sqs.us-east-1.amazonaws.com/.../chimera-coordination.fifo';

// Parallel tasks (order doesn't matter)
await sqs.send(new SendMessageCommand({
  QueueUrl: standardQueue,
  MessageBody: JSON.stringify({ task: 'research-doc-1' })
}));

// Sequential tasks (must process in order)
await sqs.send(new SendMessageCommand({
  QueueUrl: fifoQueue,
  MessageBody: JSON.stringify({ task: 'merge-branch-1' }),
  MessageGroupId: 'merge-workflow',  // Groups messages for ordering
  MessageDeduplicationId: 'merge-12345'  // Prevents duplicates
}));
```

---

## DynamoDB for State Management

### Workflow State Persistence

**Use Case:** Store agent workflow state for resume after failures.

**Schema Design:**

```typescript
// chimera-workflow-state table
interface WorkflowState {
  PK: string;          // "WORKFLOW#execution-123"
  SK: string;          // "STATE"
  tenantId: string;
  workflowId: string;
  executionId: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'PAUSED';
  currentStep: string;
  stepResults: Record<string, any>;
  input: Record<string, any>;
  output?: Record<string, any>;
  error?: {
    code: string;
    message: string;
    stepId: string;
  };
  startedAt: string;   // ISO timestamp
  completedAt?: string;
  TTL: number;         // 7 days after completion
}

// Step execution history
interface StepExecution {
  PK: string;          // "WORKFLOW#execution-123"
  SK: string;          // "STEP#step-1"
  stepId: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  output?: any;
  error?: any;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
}
```

**Implementation:**

```typescript
// Save workflow state after each step
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const dynamodb = new DynamoDBClient({});

async function saveWorkflowState(execution: WorkflowExecution): Promise<void> {
  await dynamodb.send(new PutItemCommand({
    TableName: 'chimera-workflow-state',
    Item: {
      PK: { S: `WORKFLOW#${execution.executionId}` },
      SK: { S: 'STATE' },
      tenantId: { S: execution.tenantId },
      workflowId: { S: execution.workflowId },
      status: { S: execution.status },
      currentStep: { S: execution.currentStep },
      stepResults: { S: JSON.stringify(execution.stepResults) },
      startedAt: { S: execution.startedAt },
      TTL: { N: String(Math.floor(Date.now() / 1000) + 7 * 24 * 3600) }
    }
  }));
}

// Resume workflow from saved state
async function resumeWorkflow(executionId: string): Promise<WorkflowExecution> {
  const response = await dynamodb.send(new GetItemCommand({
    TableName: 'chimera-workflow-state',
    Key: {
      PK: { S: `WORKFLOW#${executionId}` },
      SK: { S: 'STATE' }
    }
  }));

  if (!response.Item) {
    throw new Error(`Workflow not found: ${executionId}`);
  }

  return {
    executionId,
    workflowId: response.Item.workflowId.S,
    tenantId: response.Item.tenantId.S,
    status: response.Item.status.S as WorkflowStepStatus,
    currentStep: response.Item.currentStep.S,
    stepResults: JSON.parse(response.Item.stepResults.S),
    startedAt: response.Item.startedAt.S
  };
}
```

### DynamoDB Streams for Change Notifications

**Use Case:** Notify agents when workflow state changes.

```
DynamoDB Stream → Lambda → EventBridge → Observing Agents
```

**Implementation:**

```typescript
// Lambda function triggered by DynamoDB Stream
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const record of event.Records) {
    if (record.eventName === 'MODIFY') {
      const newImage = record.dynamodb?.NewImage;
      const oldImage = record.dynamodb?.OldImage;

      // Detect status change
      if (newImage?.status.S !== oldImage?.status.S) {
        // Publish event to EventBridge
        await eventbridge.send(new PutEventsCommand({
          Entries: [{
            Source: 'chimera.workflow',
            DetailType: 'WorkflowStatusChanged',
            Detail: JSON.stringify({
              executionId: newImage.PK.S.replace('WORKFLOW#', ''),
              oldStatus: oldImage?.status.S,
              newStatus: newImage.status.S,
              currentStep: newImage.currentStep.S
            })
          }]
        }));
      }
    }
  }
}
```

---

## Lambda for Service Integration

### Lambda as Glue Between Services

**Use Case:** Integrate services that don't have native Step Functions integrations.

**Example: GitHub + Slack Integration**

```typescript
// Lambda function: Post deployment notification to Slack
import { WebClient } from '@slack/web-api';
import { Octokit } from '@octokit/rest';

export async function handler(event: any): Promise<void> {
  const { deploymentId, serviceName, version, status } = event;

  // Fetch GitHub deployment details
  const github = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const deployment = await github.repos.getDeployment({
    owner: 'chimera-ai',
    repo: 'platform',
    deployment_id: deploymentId
  });

  // Post to Slack
  const slack = new WebClient(process.env.SLACK_TOKEN);
  await slack.chat.postMessage({
    channel: '#deployments',
    text: `🚀 Deployment ${status}: ${serviceName} v${version}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Deployment ${status}*\nService: ${serviceName}\nVersion: ${version}`
        }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Deployed by:*\n${deployment.data.creator.login}` },
          { type: 'mrkdwn', text: `*Environment:*\n${deployment.data.environment}` }
        ]
      }
    ]
  });
}
```

### Lambda MCP Server Pattern

**Use Case:** Expose Lambda functions as MCP tools for agent invocation.

```typescript
// MCP tool that invokes Lambda function
@mcp.tool()
async def lambda__invoke_function(
    function_name: str,
    payload: dict,
    invocation_type: str = "RequestResponse"
) -> dict:
    """Invoke AWS Lambda function."""

    import boto3
    import json

    lambda_client = boto3.client('lambda')

    response = lambda_client.invoke(
        FunctionName=function_name,
        InvocationType=invocation_type,  # RequestResponse, Event, DryRun
        Payload=json.dumps(payload)
    )

    if invocation_type == "RequestResponse":
        result = json.loads(response['Payload'].read())
        return {
            "statusCode": response['StatusCode'],
            "result": result
        }
    else:
        return {
            "statusCode": response['StatusCode'],
            "message": "Async invocation started"
        }
```

---

## Cross-Service Workflow Patterns

### Pattern 1: Scatter-Gather

**Use Case:** Fan out to multiple services, aggregate results.

```
              ┌─→ S3 (fetch data)
              │
Start ────────┼─→ DynamoDB (query config)
              │
              └─→ Lambda (compute metrics)
                      ↓
                  Aggregate → Agent analyzes results
```

**Step Functions Implementation:**

```json
{
  "StartAt": "ScatterPhase",
  "States": {
    "ScatterPhase": {
      "Type": "Parallel",
      "Branches": [
        {
          "StartAt": "FetchFromS3",
          "States": {
            "FetchFromS3": {
              "Type": "Task",
              "Resource": "arn:aws:states:::aws-sdk:s3:getObject",
              "Parameters": {
                "Bucket": "chimera-data",
                "Key": "input.json"
              },
              "End": true
            }
          }
        },
        {
          "StartAt": "QueryDynamoDB",
          "States": {
            "QueryDynamoDB": {
              "Type": "Task",
              "Resource": "arn:aws:states:::dynamodb:getItem",
              "Parameters": {
                "TableName": "chimera-config",
                "Key": {
                  "PK": { "S": "CONFIG#default" }
                }
              },
              "End": true
            }
          }
        },
        {
          "StartAt": "ComputeMetrics",
          "States": {
            "ComputeMetrics": {
              "Type": "Task",
              "Resource": "arn:aws:lambda:...:function:ComputeMetrics",
              "End": true
            }
          }
        }
      ],
      "Next": "GatherPhase"
    },
    "GatherPhase": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:InvokeAgent",
      "Parameters": {
        "agentId": "analysis-agent",
        "task": "Analyze aggregated data and generate insights",
        "context.$": "$"
      },
      "End": true
    }
  }
}
```

### Pattern 2: Data Pipeline

**Use Case:** ETL workflow across multiple AWS services.

```
S3 (raw data) → Lambda (transform) → DynamoDB (store) → SNS (notify) → Agent (analyze)
```

**Step Functions + EventBridge Implementation:**

```json
{
  "Comment": "Data pipeline workflow",
  "StartAt": "TransformData",
  "States": {
    "TransformData": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:TransformData",
      "Parameters": {
        "inputBucket": "chimera-raw-data",
        "inputKey.$": "$.detail.object.key"
      },
      "ResultPath": "$.transformedData",
      "Next": "StoreToDynamoDB"
    },
    "StoreToDynamoDB": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:putItem",
      "Parameters": {
        "TableName": "chimera-processed-data",
        "Item": {
          "PK": { "S.$": "$.transformedData.id" },
          "SK": { "S": "DATA" },
          "data": { "S.$": "States.JsonToString($.transformedData)" }
        }
      },
      "Next": "NotifyCompletion"
    },
    "NotifyCompletion": {
      "Type": "Task",
      "Resource": "arn:aws:states:::sns:publish",
      "Parameters": {
        "TopicArn": "arn:aws:sns:...:data-pipeline-events",
        "Subject": "Data Pipeline Completed",
        "Message.$": "$.transformedData"
      },
      "End": true
    }
  }
}

// EventBridge rule triggers agent analysis
{
  "EventPattern": {
    "source": ["aws.sns"],
    "detail-type": ["SNS Message"],
    "detail": {
      "Subject": ["Data Pipeline Completed"]
    }
  },
  "Targets": [
    {
      "Arn": "arn:aws:lambda:...:function:InvokeAnalysisAgent"
    }
  ]
}
```

### Pattern 3: Human-in-the-Loop

**Use Case:** Pause workflow for human approval before proceeding.

```
Agent proposes action → Step Functions (Wait for Callback) → Human approves → Continue workflow
```

**Step Functions with Callback:**

```json
{
  "StartAt": "AgentProposal",
  "States": {
    "AgentProposal": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:InvokeAgent",
      "Parameters": {
        "agentId": "deployment-agent",
        "task": "Analyze deployment plan and propose strategy"
      },
      "ResultPath": "$.proposal",
      "Next": "WaitForApproval"
    },
    "WaitForApproval": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
      "Parameters": {
        "FunctionName": "SendApprovalRequest",
        "Payload": {
          "taskToken.$": "$$.Task.Token",
          "proposal.$": "$.proposal",
          "approverEmail": "devops@example.com"
        }
      },
      "ResultPath": "$.approval",
      "Next": "CheckApproval"
    },
    "CheckApproval": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.approval.approved",
          "BooleanEquals": true,
          "Next": "ExecuteDeployment"
        }
      ],
      "Default": "DeploymentRejected"
    },
    "ExecuteDeployment": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:function:DeployService",
      "End": true
    },
    "DeploymentRejected": {
      "Type": "Fail",
      "Error": "ApprovalDenied"
    }
  }
}
```

---

## Error Handling and Resilience

### Retry Strategies

**Step Functions Automatic Retries:**

```json
{
  "Type": "Task",
  "Resource": "arn:aws:lambda:...:function:UnreliableService",
  "Retry": [
    {
      "ErrorEquals": ["Lambda.ServiceException", "Lambda.TooManyRequestsException"],
      "IntervalSeconds": 2,
      "MaxAttempts": 3,
      "BackoffRate": 2.0
    },
    {
      "ErrorEquals": ["States.TaskFailed"],
      "IntervalSeconds": 5,
      "MaxAttempts": 2,
      "BackoffRate": 1.5
    }
  ],
  "Catch": [
    {
      "ErrorEquals": ["States.ALL"],
      "ResultPath": "$.error",
      "Next": "HandleError"
    }
  ],
  "Next": "SuccessState"
}
```

### Dead Letter Queues (DLQ)

**Pattern:** Failed messages go to DLQ for manual inspection.

```typescript
// SQS queue with DLQ
const mainQueue = await sqs.send(new CreateQueueCommand({
  QueueName: 'chimera-agent-tasks',
  Attributes: {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: 'arn:aws:sqs:...:chimera-agent-tasks-dlq',
      maxReceiveCount: '3'  // After 3 failed processing attempts
    })
  }
}));

// Lambda processes DLQ messages for alerting
export async function handleDLQMessage(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const failedTask = JSON.parse(record.body);

    // Alert on-call engineer
    await sns.send(new PublishCommand({
      TopicArn: 'arn:aws:sns:...:critical-failures',
      Subject: 'Agent Task Failed After Retries',
      Message: `Task ${failedTask.taskId} failed after 3 attempts: ${failedTask.error}`
    }));

    // Log to observability system
    await logFailedTask(failedTask);
  }
}
```

### Circuit Breaker Pattern

**Pattern:** Stop calling failing service after threshold reached.

```typescript
// Circuit breaker for external service calls
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      // Check if cooldown period has passed
      if (Date.now() - this.lastFailureTime > 60000) {  // 1 minute
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';
        this.failures = 0;
      }
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();

      if (this.failures >= 5) {
        this.state = 'OPEN';
      }

      throw error;
    }
  }
}
```

---

## Observability and Tracing

### AWS X-Ray for End-to-End Tracing

**Pattern:** Trace workflow across Step Functions, Lambda, DynamoDB, S3, etc.

```typescript
// Enable X-Ray tracing in Lambda
import AWSXRay from 'aws-xray-sdk-core';
import AWS from 'aws-sdk';

// Wrap AWS SDK
const aws = AWSXRay.captureAWS(AWS);

// Trace custom segments
export async function handler(event: any): Promise<any> {
  const segment = AWSXRay.getSegment();

  // Add metadata
  segment.addAnnotation('tenantId', event.tenantId);
  segment.addAnnotation('workflowId', event.workflowId);

  // Trace subsegment
  const subsegment = segment.addNewSubsegment('ProcessData');
  try {
    const result = await processData(event);
    subsegment.close();
    return result;
  } catch (error) {
    subsegment.addError(error);
    subsegment.close();
    throw error;
  }
}
```

**Visualizing Cross-Service Traces:**

```
User Request
  ↓ 250ms
API Gateway
  ↓ 50ms
Lambda (InvokeAgent)
  ↓ 20ms
Step Functions (StartExecution)
  ↓ 100ms
  ├─→ Lambda (Task 1) — 80ms
  ├─→ DynamoDB (PutItem) — 15ms
  └─→ S3 (PutObject) — 30ms
```

### CloudWatch Metrics for Workflow Monitoring

```typescript
// Custom metrics for agent workflows
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const cloudwatch = new CloudWatchClient({});

async function recordWorkflowMetrics(execution: WorkflowExecution): Promise<void> {
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: 'Chimera/Workflows',
    MetricData: [
      {
        MetricName: 'WorkflowDuration',
        Value: execution.durationMs,
        Unit: 'Milliseconds',
        Dimensions: [
          { Name: 'WorkflowId', Value: execution.workflowId },
          { Name: 'TenantId', Value: execution.tenantId },
          { Name: 'Status', Value: execution.status }
        ],
        Timestamp: new Date()
      },
      {
        MetricName: 'WorkflowStepCount',
        Value: Object.keys(execution.stepResults).length,
        Unit: 'Count',
        Dimensions: [
          { Name: 'WorkflowId', Value: execution.workflowId }
        ]
      }
    ]
  }));
}
```

---

## Implementation Architecture

### Chimera Cross-Service Orchestration Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Chimera Agent Runtime (Strands)                   │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Agent Orchestration Layer                                     │ │
│  │  - Invokes Step Functions workflows                            │ │
│  │  - Publishes EventBridge events                                │ │
│  │  - Polls SQS for tasks                                         │ │
│  │  - Updates DynamoDB state                                      │ │
│  └────────────┬───────────────────────────────────────────────────┘ │
└───────────────┼─────────────────────────────────────────────────────┘
                │
    ┌───────────┼───────────┬──────────────┬──────────────┐
    │           │           │              │              │
┌───▼─────┐ ┌──▼────────┐ ┌▼────────────┐ ┌▼────────────┐ ┌▼─────────┐
│ Step    │ │EventBridge│ │ SQS/SNS     │ │ DynamoDB    │ │ Lambda   │
│Functions│ │           │ │             │ │             │ │          │
│         │ │ - Custom  │ │ - Task      │ │ - State     │ │ - Glue   │
│ - Struct│ │   events  │ │   queues    │ │   persist   │ │   code   │
│   flows │ │ - AWS     │ │ - Notif     │ │ - Streams   │ │ - Service│
│ - Retry │ │   service │ │   topics    │ │             │ │   integr │
│ - State │ │   events  │ │ - DLQ       │ │             │ │          │
└─────────┘ └───────────┘ └─────────────┘ └─────────────┘ └──────────┘
     │             │              │               │              │
     └─────────────┴──────────────┴───────────────┴──────────────┘
                                  │
                          ┌───────▼───────┐
                          │   AWS X-Ray   │
                          │ End-to-End    │
                          │ Tracing       │
                          └───────────────┘
```

---

## Key Takeaways

1. **Step Functions for Structure**: Best for deterministic workflows with sequential/parallel steps, error handling, and state persistence

2. **EventBridge for Reactivity**: Best for event-driven patterns where agents react to AWS service events or custom events

3. **Hybrid Orchestration**: Combine Step Functions (structured workflows) with EventBridge (reactive coordination) for complex agent behaviors

4. **SQS for Decoupling**: Use queues to decouple task producers from consumers, enabling async processing and load leveling

5. **SNS for Broadcasting**: Use pub/sub to notify multiple subscribers (agents, logs, metrics) of important events

6. **DynamoDB for State**: Persist workflow state in DynamoDB for resume after failures, with DynamoDB Streams for change notifications

7. **Lambda for Integration**: Use Lambda as glue code to integrate services that lack native Step Functions support

8. **Observability is Critical**: AWS X-Ray traces end-to-end, CloudWatch metrics monitor performance, DLQs capture failures

**Recommended Architecture:**
- Start workflows with Step Functions (structured control flow)
- React to events with EventBridge rules (AWS services + custom agent events)
- Use SQS for task distribution, SNS for notifications
- Persist state in DynamoDB (with TTL for cleanup)
- Trace everything with X-Ray

**Next Steps:**
- Implement Step Functions state machines for common agent workflows (deployment, research, analysis)
- Configure EventBridge rules for reactive agent behaviors
- Build Lambda MCP servers for service integrations
- Set up observability dashboards for cross-service workflows

---

## References

- [AWS Step Functions Documentation](https://docs.aws.amazon.com/step-functions/)
- [Amazon EventBridge Documentation](https://docs.aws.amazon.com/eventbridge/)
- [Amazon SQS Documentation](https://docs.aws.amazon.com/sqs/)
- [Amazon SNS Documentation](https://docs.aws.amazon.com/sns/)
- [AWS X-Ray Documentation](https://docs.aws.amazon.com/xray/)
- [Saga Pattern for Microservices](https://microservices.io/patterns/data/saga.html)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- Chimera Internal: `packages/core/src/orchestration/workflow.ts`
- Chimera Internal: `docs/research/collaboration/04-Real-Time-Async-and-Shared-Memory.md`
