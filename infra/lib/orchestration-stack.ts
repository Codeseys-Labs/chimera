import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface OrchestrationStackProps extends cdk.StackProps {
  envName: string;
  platformKey: kms.IKey;
}

/**
 * Agent orchestration infrastructure.
 *
 * Implements Phase 5 multi-agent orchestration patterns:
 * - EventBridge custom event bus as central nervous system for agent lifecycle events
 * - SQS FIFO queues for ordered agent-to-agent communication (session-based routing)
 * - SQS Standard queues for parallel task distribution (swarm pattern)
 * - EventBridge rules for routing agent events (started, completed, failed, error)
 * - IAM roles and policies for cross-service event delivery
 *
 * Architecture patterns:
 * - Swarm: Dynamic agent pool scaling via Standard SQS queue
 * - Workflow: EventBridge orchestration with Step Functions targets
 * - Graph: Event-driven DAG execution via rule chains
 *
 * Reference: docs/research/collaboration/01-AWS-Communication-Primitives.md
 */
export class OrchestrationStack extends cdk.Stack {
  public readonly eventBus: events.EventBus;
  public readonly agentTaskQueue: sqs.Queue;
  public readonly agentMessageQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // EventBridge Custom Event Bus
    // Central nervous system for all agent lifecycle events.
    // ======================================================================

    this.eventBus = new events.EventBus(this, 'AgentEventBus', {
      eventBusName: `chimera-agents-${props.envName}`,
    });

    // Event archive for replay capability (retain 7 days in dev, 30 days in prod)
    const eventArchive = new events.Archive(this, 'EventArchive', {
      sourceEventBus: this.eventBus,
      archiveName: `chimera-agents-archive-${props.envName}`,
      description: 'Archive of all agent lifecycle events for replay and debugging',
      retention: isProd ? cdk.Duration.days(30) : cdk.Duration.days(7),
      eventPattern: {
        source: ['chimera.agents'],
      },
    });

    // CloudWatch log group for event debugging
    const eventLogGroup = new logs.LogGroup(this, 'EventBusLogGroup', {
      logGroupName: `/aws/events/chimera-agents-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      encryptionKey: props.platformKey,
    });

    // ======================================================================
    // SQS Queue: Agent Task Distribution (Standard Queue)
    // High-throughput parallel task distribution for swarm pattern.
    // Workers poll this queue and process tasks independently.
    // ======================================================================

    // Dead-letter queue for failed tasks
    const taskDlq = new sqs.Queue(this, 'AgentTaskDLQ', {
      queueName: `chimera-agent-tasks-dlq-${props.envName}`,
      retentionPeriod: cdk.Duration.days(14),
      encryptionMasterKey: props.platformKey,
    });

    this.agentTaskQueue = new sqs.Queue(this, 'AgentTaskQueue', {
      queueName: `chimera-agent-tasks-${props.envName}`,
      visibilityTimeout: cdk.Duration.minutes(15), // Timeout for agent processing
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20), // Long polling
      encryptionMasterKey: props.platformKey,
      deadLetterQueue: {
        queue: taskDlq,
        maxReceiveCount: 3, // Retry up to 3 times before DLQ
      },
    });

    // ======================================================================
    // SQS Queue: Agent-to-Agent Messages (FIFO Queue)
    // Ordered message delivery for session-based agent communication.
    // Message group ID = tenantId-sessionId for strict ordering per session.
    // ======================================================================

    // Dead-letter queue for failed messages
    const messageDlq = new sqs.Queue(this, 'AgentMessageDLQ', {
      queueName: `chimera-agent-messages-dlq-${props.envName}.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryptionMasterKey: props.platformKey,
    });

    this.agentMessageQueue = new sqs.Queue(this, 'AgentMessageQueue', {
      queueName: `chimera-agent-messages-${props.envName}.fifo`,
      fifo: true,
      contentBasedDeduplication: true, // Automatic deduplication via SHA-256
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20), // Long polling
      encryptionMasterKey: props.platformKey,
      deadLetterQueue: {
        queue: messageDlq,
        maxReceiveCount: 3,
      },
    });

    // ======================================================================
    // EventBridge Rules: Agent Lifecycle Event Routing
    // Route agent events to appropriate targets based on event patterns.
    // ======================================================================

    // Rule 1: Agent Task Started Events → CloudWatch Logs
    const taskStartedRule = new events.Rule(this, 'TaskStartedRule', {
      ruleName: `chimera-agent-started-${props.envName}`,
      eventBus: this.eventBus,
      description: 'Route agent task started events to CloudWatch Logs',
      eventPattern: {
        source: ['chimera.agents'],
        detailType: ['Agent Task Started'],
      },
    });
    taskStartedRule.addTarget(new targets.CloudWatchLogGroup(eventLogGroup));

    // Rule 2: Agent Task Completed Events → CloudWatch Logs + Metrics
    const taskCompletedRule = new events.Rule(this, 'TaskCompletedRule', {
      ruleName: `chimera-agent-completed-${props.envName}`,
      eventBus: this.eventBus,
      description: 'Route agent task completed events to CloudWatch',
      eventPattern: {
        source: ['chimera.agents'],
        detailType: ['Agent Task Completed'],
      },
    });
    taskCompletedRule.addTarget(new targets.CloudWatchLogGroup(eventLogGroup));

    // Rule 3: Agent Task Failed Events → CloudWatch Logs + DLQ
    // Failed tasks go to both logs (for debugging) and a queue (for retry/alerting)
    const taskFailedRule = new events.Rule(this, 'TaskFailedRule', {
      ruleName: `chimera-agent-failed-${props.envName}`,
      eventBus: this.eventBus,
      description: 'Route agent task failed events to CloudWatch and DLQ',
      eventPattern: {
        source: ['chimera.agents'],
        detailType: ['Agent Task Failed'],
      },
    });
    taskFailedRule.addTarget(new targets.CloudWatchLogGroup(eventLogGroup));
    taskFailedRule.addTarget(new targets.SqsQueue(taskDlq));

    // Rule 4: Agent Error Events → CloudWatch Logs
    // Runtime errors (not task failures) go to logs for immediate investigation
    const errorRule = new events.Rule(this, 'ErrorRule', {
      ruleName: `chimera-agent-error-${props.envName}`,
      eventBus: this.eventBus,
      description: 'Route agent error events to CloudWatch',
      eventPattern: {
        source: ['chimera.agents'],
        detailType: ['Agent Error'],
      },
    });
    errorRule.addTarget(new targets.CloudWatchLogGroup(eventLogGroup));

    // Rule 5: Swarm Coordination Events → Task Queue
    // When a coordinator agent needs to spawn workers, it publishes a
    // "Swarm Task Created" event that gets routed to the task queue.
    const swarmTaskRule = new events.Rule(this, 'SwarmTaskRule', {
      ruleName: `chimera-swarm-task-${props.envName}`,
      eventBus: this.eventBus,
      description: 'Route swarm task creation events to task queue',
      eventPattern: {
        source: ['chimera.agents'],
        detailType: ['Swarm Task Created'],
      },
    });
    swarmTaskRule.addTarget(new targets.SqsQueue(this.agentTaskQueue));

    // Rule 6: Agent-to-Agent Messages → Message Queue (FIFO)
    // Direct agent-to-agent messages for ordered communication
    const a2aMessageRule = new events.Rule(this, 'A2AMessageRule', {
      ruleName: `chimera-a2a-message-${props.envName}`,
      eventBus: this.eventBus,
      description: 'Route agent-to-agent messages to FIFO queue',
      eventPattern: {
        source: ['chimera.agents'],
        detailType: ['Agent Message'],
      },
    });
    a2aMessageRule.addTarget(new targets.SqsQueue(this.agentMessageQueue, {
      // Message group ID extracted from event detail for session-based routing
      messageGroupId: events.EventField.fromPath('$.detail.sessionId'),
    }));

    // ======================================================================
    // IAM Role: EventBridge Event Publisher
    // Allows agent runtime (Lambda, ECS tasks) to publish events to the bus.
    // ======================================================================

    const eventPublisherRole = new iam.Role(this, 'EventPublisherRole', {
      roleName: `chimera-event-publisher-${props.envName}`,
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        new iam.ServicePrincipal('bedrock.amazonaws.com'),
      ),
      description: 'Allows agent runtime to publish events to EventBridge',
    });

    eventPublisherRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [this.eventBus.eventBusArn],
    }));

    // Basic Lambda execution permissions (if Lambda agents need logging)
    eventPublisherRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    // ======================================================================
    // Stack Outputs
    // ======================================================================

    new cdk.CfnOutput(this, 'EventBusName', {
      value: this.eventBus.eventBusName,
      exportName: `${this.stackName}-EventBusName`,
      description: 'Agent event bus name',
    });

    new cdk.CfnOutput(this, 'EventBusArn', {
      value: this.eventBus.eventBusArn,
      exportName: `${this.stackName}-EventBusArn`,
      description: 'Agent event bus ARN',
    });

    new cdk.CfnOutput(this, 'AgentTaskQueueUrl', {
      value: this.agentTaskQueue.queueUrl,
      exportName: `${this.stackName}-AgentTaskQueueUrl`,
      description: 'Agent task distribution queue URL (Standard)',
    });

    new cdk.CfnOutput(this, 'AgentTaskQueueArn', {
      value: this.agentTaskQueue.queueArn,
      exportName: `${this.stackName}-AgentTaskQueueArn`,
      description: 'Agent task distribution queue ARN',
    });

    new cdk.CfnOutput(this, 'AgentMessageQueueUrl', {
      value: this.agentMessageQueue.queueUrl,
      exportName: `${this.stackName}-AgentMessageQueueUrl`,
      description: 'Agent-to-agent message queue URL (FIFO)',
    });

    new cdk.CfnOutput(this, 'AgentMessageQueueArn', {
      value: this.agentMessageQueue.queueArn,
      exportName: `${this.stackName}-AgentMessageQueueArn`,
      description: 'Agent-to-agent message queue ARN',
    });

    new cdk.CfnOutput(this, 'EventPublisherRoleArn', {
      value: eventPublisherRole.roleArn,
      exportName: `${this.stackName}-EventPublisherRoleArn`,
      description: 'IAM role ARN for publishing events to the agent event bus',
    });
  }
}
