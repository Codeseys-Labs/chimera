import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { ChimeraQueue } from '../constructs/chimera-queue';
import { ChimeraLambda } from '../constructs/chimera-lambda';
import { ChimeraTable } from '../constructs/chimera-table';
import { logRetentionFor } from '../constructs/log-retention';

export interface OrchestrationStackProps extends cdk.StackProps {
  envName: string;
  platformKey: kms.IKey;
  /**
   * Internal chat-gateway URL the schedule dispatcher will POST to, including
   * the `/chat/stream` path (e.g. `http://internal-alb.example.com/chat/stream`).
   *
   * Left optional so OrchestrationStack does not create a circular dependency
   * on ChatStack: `chimera.ts` wires the concrete ALB DNS into this prop once
   * ChatStack is synthesized. When omitted a deploy-time placeholder is used
   * and the dispatcher Lambda will fail loudly if it is ever invoked.
   */
  chatGatewayInternalUrl?: string;
  /**
   * VPC to attach the schedule-dispatcher Lambda to. Required in production
   * so the Lambda can reach the internal chat-gateway ALB; optional in tests.
   * ENI-backed cold starts cost ~1–2s extra (HIGH 6) — acceptable because
   * schedule firings are not latency-sensitive.
   */
  vpc?: ec2.IVpc;
  /**
   * ALB security group owned by ChatStack/NetworkStack. When provided, the
   * dispatcher stack creates its own Lambda SG and registers an ingress rule
   * on the ALB SG for port 80 so dispatcher -> ALB traffic flows without
   * widening the ALB SG to the whole VPC.
   */
  albSecurityGroup?: ec2.ISecurityGroup;
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
 * Queues use ChimeraQueue (mandatory KMS encryption, DLQ, CloudWatch alarms).
 * Lambdas use ChimeraLambda (mandatory X-Ray, log retention, DLQ).
 *
 * Reference: docs/research/collaboration/01-AWS-Communication-Primitives.md
 */
export class OrchestrationStack extends cdk.Stack {
  public readonly eventBus: events.EventBus;
  public readonly agentTaskQueue: sqs.Queue;
  public readonly agentMessageQueue: sqs.Queue;
  public readonly schedulerGroup: scheduler.CfnScheduleGroup;
  public readonly schedulerRole: iam.Role;
  public readonly schedulesTable: dynamodb.ITable;
  public readonly scheduleDispatcher: lambda.IFunction;
  public readonly scheduleDispatcherDlq: sqs.Queue;
  public readonly scheduleSigningKeySecret: secretsmanager.ISecret;
  public readonly scheduleSigningKmsKey: kms.IKey;
  public readonly pipelineBuildStateMachine: stepfunctions.StateMachine;
  public readonly dataAnalysisStateMachine: stepfunctions.StateMachine;
  public readonly backgroundTaskStateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // EventBridge Custom Event Bus
    // ======================================================================

    this.eventBus = new events.EventBus(this, 'AgentEventBus', {
      eventBusName: `chimera-agents-${props.envName}`,
    });

    new events.Archive(this, 'EventArchive', {
      sourceEventBus: this.eventBus,
      archiveName: `chimera-agents-archive-${props.envName}`,
      description: 'Archive of all agent lifecycle events for replay and debugging',
      retention: isProd ? cdk.Duration.days(30) : cdk.Duration.days(7),
      eventPattern: {
        source: ['chimera.agents'],
      },
    });

    const eventLogGroup = new logs.LogGroup(this, 'EventBusLogGroup', {
      logGroupName: `/aws/events/chimera-agents-${props.envName}`,
      retention: logRetentionFor('debug', isProd),
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      encryptionKey: props.platformKey,
    });

    // ======================================================================
    // SQS Queue: Agent Task Distribution (Standard Queue)
    // ChimeraQueue provides DLQ, KMS encryption, and CloudWatch alarms.
    // ======================================================================

    const agentTaskChimeraQueue = new ChimeraQueue(this, 'AgentTaskQueue', {
      queueName: `chimera-agent-tasks-${props.envName}`,
      encryptionKey: props.platformKey,
      visibilityTimeout: cdk.Duration.minutes(15),
    });
    this.agentTaskQueue = agentTaskChimeraQueue.queue;

    // ======================================================================
    // SQS Queue: Agent-to-Agent Messages (FIFO Queue)
    // contentBasedDeduplication added via escape hatch (ChimeraQueue uses fifo: true).
    // ======================================================================

    const agentMessageChimeraQueue = new ChimeraQueue(this, 'AgentMessageQueue', {
      queueName: `chimera-agent-messages-${props.envName}`,
      encryptionKey: props.platformKey,
      fifo: true,
      visibilityTimeout: cdk.Duration.minutes(5),
    });
    // Enable content-based deduplication (SHA-256 of message body)
    (agentMessageChimeraQueue.queue.node.defaultChild as sqs.CfnQueue).addPropertyOverride(
      'ContentBasedDeduplication',
      true
    );
    this.agentMessageQueue = agentMessageChimeraQueue.queue;

    // ======================================================================
    // EventBridge Rules: Agent Lifecycle Event Routing
    // ======================================================================

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
    taskFailedRule.addTarget(new targets.SqsQueue(agentTaskChimeraQueue.dlq));

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

    const a2aMessageRule = new events.Rule(this, 'A2AMessageRule', {
      ruleName: `chimera-a2a-message-${props.envName}`,
      eventBus: this.eventBus,
      description: 'Route agent-to-agent messages to FIFO queue',
      eventPattern: {
        source: ['chimera.agents'],
        detailType: ['Agent Message'],
      },
    });
    a2aMessageRule.addTarget(
      new targets.SqsQueue(this.agentMessageQueue, {
        messageGroupId: events.EventField.fromPath('$.detail.sessionId'),
      })
    );

    // ======================================================================
    // IAM Role: EventBridge Event Publisher
    // ======================================================================

    const eventPublisherRole = new iam.Role(this, 'EventPublisherRole', {
      roleName: `chimera-event-publisher-${props.envName}`,
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        new iam.ServicePrincipal('bedrock.amazonaws.com')
      ),
      description: 'Allows agent runtime to publish events to EventBridge',
    });

    eventPublisherRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [this.eventBus.eventBusArn],
      })
    );

    eventPublisherRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // ======================================================================
    // EventBridge Scheduler: Cron-based Agent Tasks
    // ======================================================================

    this.schedulerGroup = new scheduler.CfnScheduleGroup(this, 'AgentSchedulerGroup', {
      name: `chimera-agent-schedules-${props.envName}`,
    });

    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `chimera-scheduler-${props.envName}`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Allows EventBridge Scheduler to invoke the chimera schedule dispatcher Lambda',
    });
    const schedulerRole = this.schedulerRole;

    // ----------------------------------------------------------------------
    // chimera-2b2a: schedules table + dispatcher Lambda + signing-key secret
    // ----------------------------------------------------------------------
    // 7th ChimeraTable. Backs `packages/core/src/scheduling/schedule-service.ts`.
    // GSI1: list-by-tenant (sorted by createdAt).
    // GSI2: list-by-expression-type within a tenant (e.g. all cron schedules).
    // All GSI queries MUST include FilterExpression='tenantId = :tid' per the
    // project's tenant-isolation convention (CLAUDE.md).
    const schedulesChimera = new ChimeraTable(this, 'SchedulesTable', {
      tableName: `chimera-schedules-${props.envName}`,
      encryptionKey: props.platformKey,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1-tenant-created',
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
        {
          indexName: 'GSI2-tenant-expr-type',
          partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.schedulesTable = schedulesChimera.table;

    // HMAC signing key shared between the dispatcher Lambda and the
    // chat-gateway /chat/stream endpoint. Quarterly rotation is managed
    // out-of-band (Secrets Manager rotation-via-Lambda would itself need
    // auth coordination, so we intentionally defer automated rotation to a
    // separate rotation-runbook tool — see docs/runbooks/ once available).
    // The consumer validates the secret in chat-gateway's schedule-token
    // middleware (Workstream B).
    // Stack-local CMK for the schedule-signing secret. Using platformKey
    // (SecurityStack-owned) would cause grantRead() to attach the dispatcher
    // Lambda role ARN to platformKey's key policy, creating a
    // Security -> Orchestration DependencyCycle. ChatStack reads the secret
    // via a separate IAM policy that also requires kms:Decrypt on its key —
    // grant both here so ChatStack's identity policy remains sufficient.
    const scheduleSigningKmsKey = new kms.Key(this, 'ScheduleSigningKmsKey', {
      alias: `alias/chimera-schedule-signing-${props.envName}`,
      description: 'CMK for the chimera schedule-signing Secrets Manager secret',
      enableKeyRotation: true,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.scheduleSigningKmsKey = scheduleSigningKmsKey;

    this.scheduleSigningKeySecret = new secretsmanager.Secret(this, 'ScheduleSigningKey', {
      secretName: `chimera/schedule-signing-key-${props.envName}`,
      description: 'HMAC-SHA256 key used to authenticate scheduler -> chat-gateway invocations',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ kid: `chimera-schedule-${props.envName}-v1` }),
        generateStringKey: 'signingKey',
        excludePunctuation: false,
        passwordLength: 64,
      },
      encryptionKey: scheduleSigningKmsKey,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Dispatcher SG — dedicated SG so the ALB SG can narrowly ingress-allow
    // only dispatcher Lambdas, instead of widening to the whole VPC. Created
    // only when a VPC is supplied; in region-agnostic tests we skip VPC
    // wiring and the Lambda runs outside a VPC against the placeholder URL
    // (HIGH 6 — real deployments MUST pass `props.vpc` + `props.albSecurityGroup`).
    let dispatcherLambdaSg: ec2.SecurityGroup | undefined;
    if (props.vpc) {
      dispatcherLambdaSg = new ec2.SecurityGroup(this, 'ScheduleDispatcherSG', {
        vpc: props.vpc,
        securityGroupName: `chimera-schedule-dispatcher-${props.envName}`,
        description:
          'Egress-only SG for the chimera schedule dispatcher Lambda -> internal chat-gateway ALB',
        allowAllOutbound: true,
      });
      if (props.albSecurityGroup) {
        // Use L1 CfnSecurityGroupIngress in Orchestration scope so the rule
        // lives in this stack. Using albSg.addIngressRule() would put the
        // rule in Network stack (which owns albSg) and reference the
        // Orchestration-owned dispatcherLambdaSg, creating a
        // Network -> Orchestration dependency that conflicts with this
        // stack's Orchestration -> Network dependency (DependencyCycle).
        new ec2.CfnSecurityGroupIngress(this, 'AlbIngressFromDispatcherHttp', {
          groupId: props.albSecurityGroup.securityGroupId,
          ipProtocol: 'tcp',
          fromPort: 80,
          toPort: 80,
          sourceSecurityGroupId: dispatcherLambdaSg.securityGroupId,
          description: 'Schedule dispatcher Lambda -> chat-gateway ALB (HTTP)',
        });
        new ec2.CfnSecurityGroupIngress(this, 'AlbIngressFromDispatcherHttps', {
          groupId: props.albSecurityGroup.securityGroupId,
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          sourceSecurityGroupId: dispatcherLambdaSg.securityGroupId,
          description: 'Schedule dispatcher Lambda -> chat-gateway ALB (HTTPS)',
        });
      }
    }

    // Dispatcher Lambda — the security chokepoint between EventBridge
    // Scheduler and the chat-gateway. Reads the schedule row, re-validates
    // the tenant, signs an HMAC token, POSTs to /chat/stream, drains the
    // SSE response, and writes a SCHEDRUN# log entry to chimera-sessions.
    const scheduleDispatcher = new ChimeraLambda(this, 'ScheduleDispatcherFunction', {
      functionName: `chimera-schedule-dispatcher-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/schedule-dispatcher')),
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      // Intentionally omit encryptionKey so ChimeraLambda auto-provisions a
      // stack-local CMK for the DLQ. Passing platformKey here causes CDK to
      // append the Lambda's role ARN to the platformKey's key policy, which
      // adds a Security -> Orchestration reference and creates a
      // DependencyCycle (Orchestration already depends on Security). Same
      // pattern as EmailStack's SQS KMS (see chimera.ts:284-285).
      vpc: props.vpc,
      vpcSubnets: props.vpc
        ? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
        : undefined,
      securityGroups: dispatcherLambdaSg ? [dispatcherLambdaSg] : undefined,
      environment: {
        SCHEDULES_TABLE: this.schedulesTable.tableName,
        TENANTS_TABLE: `chimera-tenants-${props.envName}`,
        SESSIONS_TABLE: `chimera-sessions-${props.envName}`,
        SIGNING_KEY_SECRET_ARN: this.scheduleSigningKeySecret.secretArn,
        CHAT_GATEWAY_URL:
          props.chatGatewayInternalUrl ??
          `http://chimera-chat-${props.envName}.internal.invalid/chat/stream`,
      },
    });
    this.scheduleDispatcher = scheduleDispatcher.fn;
    this.scheduleDispatcherDlq = scheduleDispatcher.dlq;

    // DDB access: read schedules + tenants, write session run logs.
    scheduleDispatcher.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [this.schedulesTable.tableArn],
      })
    );
    scheduleDispatcher.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/chimera-tenants-${props.envName}`,
        ],
      })
    );
    scheduleDispatcher.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/chimera-sessions-${props.envName}`,
        ],
      })
    );
    this.scheduleSigningKeySecret.grantRead(scheduleDispatcher.fn);
    // Decrypt secret payload + DDB table KMS.
    scheduleDispatcher.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [props.platformKey.keyArn],
      })
    );

    // Scheduler role may invoke the dispatcher Lambda for targets under the
    // chimera-agent-schedules-{env} group. Replaces the unused events:PutEvents
    // statement — EventBridge Scheduler targets Lambda directly, not EventBus.
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [scheduleDispatcher.fn.functionArn],
      })
    );

    // DLQ circuit breaker alarm — ChimeraLambda already provisioned the DLQ
    // (scheduleDispatcher.dlq). Alarm fires when >=5 messages accumulate,
    // matching the project-wide DLQ convention (ADR-021).
    new cloudwatch.Alarm(this, 'ScheduleDispatcherDLQAlarm', {
      alarmName: `chimera-schedule-dispatcher-dlq-${props.envName}`,
      alarmDescription:
        'Circuit breaker: schedule dispatcher Lambda DLQ depth exceeds threshold',
      metric: scheduleDispatcher.dlq.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.AVERAGE,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ======================================================================
    // Per-Tenant FIFO Queues (Dynamic Creation Pattern)
    // ======================================================================

    const queueProvisionerRole = new iam.Role(this, 'QueueProvisionerRole', {
      roleName: `chimera-queue-provisioner-${props.envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Allows Lambda to create per-tenant SQS FIFO queues on demand',
    });

    queueProvisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'sqs:CreateQueue',
          'sqs:SetQueueAttributes',
          'sqs:TagQueue',
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
        ],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:chimera-tenant-*-tasks-${props.envName}.fifo`,
        ],
      })
    );

    queueProvisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [props.platformKey.keyArn],
      })
    );

    queueProvisionerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // ======================================================================
    // GroupChat Provisioner: SNS Topic + SQS Subscription Creation
    // ======================================================================

    const groupChatProvisionerRole = new iam.Role(this, 'GroupChatProvisionerRole', {
      roleName: `chimera-groupchat-provisioner-${props.envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Allows Lambda to create SNS topics and SQS subscriptions for agent groupchat',
    });

    groupChatProvisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'sns:CreateTopic',
          'sns:SetTopicAttributes',
          'sns:TagResource',
          'sns:GetTopicAttributes',
          'sns:Subscribe',
          'sns:ListSubscriptionsByTopic',
          'sns:Unsubscribe',
          'sns:DeleteTopic',
        ],
        resources: [
          `arn:aws:sns:${this.region}:${this.account}:chimera-groupchat-*-${props.envName}`,
        ],
      })
    );

    groupChatProvisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'sqs:CreateQueue',
          'sqs:SetQueueAttributes',
          'sqs:TagQueue',
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
          'sqs:DeleteQueue',
        ],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:chimera-groupchat-*-${props.envName}`,
        ],
      })
    );

    groupChatProvisionerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
        resources: [props.platformKey.keyArn],
      })
    );

    groupChatProvisionerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // ======================================================================
    // Lambda Functions for Workflow Steps (ChimeraLambda)
    // ======================================================================

    // Pipeline Build: Start build job
    const startBuildChimera = new ChimeraLambda(this, 'StartBuildFunction', {
      functionName: `chimera-workflow-start-build-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3, os
cb = boto3.client('codebuild')
def handler(event, context):
    project = event.get('project_name', os.environ['CODEBUILD_PROJECT'])
    params = {'projectName': project}
    if event.get('branch'):
        params['sourceVersion'] = event['branch']
    if event.get('build_spec'):
        params['buildspecOverride'] = event['build_spec']
    envs = []
    for k in ('tenant_id', 'repository'):
        if event.get(k):
            envs.append({'name': k.upper(), 'value': event[k], 'type': 'PLAINTEXT'})
    if envs:
        params['environmentVariablesOverride'] = envs
    b = cb.start_build(**params)['build']
    return {'build_id': b['id'], 'status': b['buildStatus'], 'started_at': b['startTime'].isoformat()}
`),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        CODEBUILD_PROJECT: `chimera-build-${props.envName}`,
      },
    });
    startBuildChimera.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild'],
        resources: [`arn:aws:codebuild:${this.region}:${this.account}:project/chimera-*`],
      })
    );

    // Pipeline Build: Check build status
    const checkBuildStatusChimera = new ChimeraLambda(this, 'CheckBuildStatusFunction', {
      functionName: `chimera-workflow-check-build-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3
cb = boto3.client('codebuild')
def handler(event, context):
    build_id = event['build_id']
    resp = cb.batch_get_builds(ids=[build_id])
    if not resp['builds']:
        raise Exception(f'Build not found: {build_id}')
    b = resp['builds'][0]
    phases = b.get('phases', [])
    done = sum(1 for p in phases if p.get('phaseStatus') == 'SUCCEEDED')
    total = max(len(phases), 1)
    region = b['arn'].split(':')[3]
    acct = b['arn'].split(':')[4]
    logs_url = f'https://{region}.console.aws.amazon.com/codesuite/codebuild/{acct}/projects/{b["projectName"]}/build/{build_id}'
    return {'build_id': build_id, 'status': b['buildStatus'], 'progress': int(done / total * 100), 'logs_url': logs_url}
`),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });
    checkBuildStatusChimera.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:BatchGetBuilds'],
        resources: [`arn:aws:codebuild:${this.region}:${this.account}:project/chimera-*`],
      })
    );

    // Data Analysis: Run query
    const runDataQueryChimera = new ChimeraLambda(this, 'RunDataQueryFunction', {
      functionName: `chimera-workflow-run-query-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3, os
athena = boto3.client('athena')
def handler(event, context):
    query = event['query']
    workgroup = event.get('workgroup', os.environ.get('ATHENA_WORKGROUP', 'primary'))
    output_loc = os.environ.get('ATHENA_OUTPUT', f"s3://chimera-artifacts-{os.environ['ENV_NAME']}/athena-results/")
    params = {
        'QueryString': query,
        'WorkGroup': workgroup,
        'ResultConfiguration': {'OutputLocation': output_loc},
    }
    if event.get('database'):
        params['QueryExecutionContext'] = {'Database': event['database']}
    resp = athena.start_query_execution(**params)
    return {'query_id': resp['QueryExecutionId'], 'status': 'RUNNING', 'row_count': 0}
`),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ENV_NAME: props.envName,
        ATHENA_WORKGROUP: `chimera-${props.envName}`,
        ATHENA_OUTPUT: `s3://chimera-artifacts-${props.envName}/athena-results/`,
      },
    });
    runDataQueryChimera.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution'],
        resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/*`],
      })
    );
    runDataQueryChimera.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetBucketLocation', 's3:GetObject', 's3:ListBucket', 's3:PutObject'],
        resources: [
          `arn:aws:s3:::chimera-artifacts-${props.envName}`,
          `arn:aws:s3:::chimera-artifacts-${props.envName}/*`,
        ],
      })
    );
    runDataQueryChimera.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['glue:GetTable', 'glue:GetPartitions', 'glue:GetDatabase'],
        resources: ['*'],
      })
    );

    // Data Analysis: Check query status
    const checkQueryStatusChimera = new ChimeraLambda(this, 'CheckQueryStatusFunction', {
      functionName: `chimera-workflow-check-query-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3
athena = boto3.client('athena')
STATE_MAP = {'QUEUED': 'RUNNING', 'RUNNING': 'RUNNING', 'SUCCEEDED': 'COMPLETED', 'FAILED': 'FAILED', 'CANCELLED': 'FAILED'}
def handler(event, context):
    qid = event['query_id']
    resp = athena.get_query_execution(QueryExecutionId=qid)
    exe = resp['QueryExecution']
    status = STATE_MAP.get(exe['Status']['State'], 'RUNNING')
    result = {'query_id': qid, 'status': status, 'row_count': 0, 'result_location': ''}
    if status == 'COMPLETED':
        result['result_location'] = exe['ResultConfiguration']['OutputLocation']
        result['row_count'] = exe.get('Statistics', {}).get('DataScannedInBytes', 0)
    return result
`),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });
    checkQueryStatusChimera.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['athena:GetQueryExecution', 'athena:GetQueryResults'],
        resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/*`],
      })
    );

    // Background Task: Execute generic background task
    const executeBackgroundTaskChimera = new ChimeraLambda(this, 'ExecuteBackgroundTaskFunction', {
      functionName: `chimera-workflow-execute-bg-task-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3, os, json
from datetime import datetime, timezone
ddb = boto3.resource('dynamodb')
eb = boto3.client('events')
def handler(event, context):
    table = ddb.Table(os.environ['SESSIONS_TABLE'])
    task_id = event['task_id']
    tenant_id = event.get('tenant_id', 'system')
    now = datetime.now(timezone.utc).isoformat()
    table.put_item(Item={
        'PK': 'TASK#' + task_id, 'SK': 'META',
        'tenantId': tenant_id, 'taskId': task_id,
        'status': 'RUNNING', 'instruction': event.get('instruction', ''),
        'targetAgentId': event.get('target_agent_id', ''),
        'context': json.dumps(event.get('context', {})),
        'startedAt': now, 'updatedAt': now,
        'ttl': int(datetime.now(timezone.utc).timestamp()) + 86400,
    })
    eb.put_events(Entries=[{
        'Source': 'chimera.agents',
        'DetailType': 'Background Task Executing',
        'Detail': json.dumps({'task_id': task_id, 'tenant_id': tenant_id, 'started_at': now}),
        'EventBusName': os.environ['EVENT_BUS_NAME'],
    }])
    return {'task_id': task_id, 'status': 'RUNNING', 'result': {}}
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        SESSIONS_TABLE: `chimera-sessions-${props.envName}`,
        EVENT_BUS_NAME: `chimera-agents-${props.envName}`,
        ENV_NAME: props.envName,
      },
    });
    executeBackgroundTaskChimera.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/chimera-sessions-${props.envName}`,
        ],
      })
    );
    executeBackgroundTaskChimera.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [this.eventBus.eventBusArn],
      })
    );

    // Background Task: Check task status
    const checkBackgroundTaskStatusChimera = new ChimeraLambda(
      this,
      'CheckBackgroundTaskStatusFunction',
      {
        functionName: `chimera-workflow-check-bg-task-${props.envName}`,
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`
import boto3, os, json
ddb = boto3.resource('dynamodb')
def handler(event, context):
    table = ddb.Table(os.environ['SESSIONS_TABLE'])
    task_id = event['task_id']
    resp = table.get_item(Key={'PK': 'TASK#' + task_id, 'SK': 'META'})
    item = resp.get('Item')
    if not item:
        raise Exception('Task not found: ' + task_id)
    result = item.get('result', '{}')
    if isinstance(result, str):
        result = json.loads(result)
    return {'task_id': task_id, 'status': item.get('status', 'RUNNING'), 'result': result}
`),
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          SESSIONS_TABLE: `chimera-sessions-${props.envName}`,
        },
      }
    );
    checkBackgroundTaskStatusChimera.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/chimera-sessions-${props.envName}`,
        ],
      })
    );

    // ======================================================================
    // Step Functions: Pipeline Build Workflow
    // ======================================================================

    const startBuildTask = new tasks.LambdaInvoke(this, 'StartBuildTask', {
      lambdaFunction: startBuildChimera.fn,
      outputPath: '$.Payload',
    });
    startBuildTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const checkBuildTask = new tasks.LambdaInvoke(this, 'CheckBuildTask', {
      lambdaFunction: checkBuildStatusChimera.fn,
      outputPath: '$.Payload',
    });
    checkBuildTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const buildWait = new stepfunctions.Wait(this, 'BuildWait', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const buildSucceeded = new stepfunctions.Succeed(this, 'BuildSucceeded');
    const buildFailed = new stepfunctions.Fail(this, 'BuildFailed', {
      cause: 'Build job failed',
      error: 'BuildError',
    });

    startBuildTask.addCatch(buildFailed, { errors: ['States.ALL'], resultPath: '$.error' });
    checkBuildTask.addCatch(buildFailed, { errors: ['States.ALL'], resultPath: '$.error' });

    const checkBuildChoice = new stepfunctions.Choice(this, 'BuildComplete?')
      .when(stepfunctions.Condition.stringEquals('$.status', 'SUCCEEDED'), buildSucceeded)
      .when(stepfunctions.Condition.stringEquals('$.status', 'FAILED'), buildFailed)
      .otherwise(buildWait);

    buildWait.next(checkBuildTask);
    checkBuildTask.next(checkBuildChoice);

    const pipelineBuildDefinition = startBuildTask.next(buildWait);

    this.pipelineBuildStateMachine = new stepfunctions.StateMachine(
      this,
      'PipelineBuildStateMachine',
      {
        stateMachineName: `chimera-pipeline-build-${props.envName}`,
        definitionBody: stepfunctions.DefinitionBody.fromChainable(pipelineBuildDefinition),
        timeout: cdk.Duration.minutes(30),
        logs: {
          destination: new logs.LogGroup(this, 'PipelineBuildLogGroup', {
            logGroupName: `/aws/vendedlogs/states/chimera-pipeline-build-${props.envName}`,
            retention: logRetentionFor('debug', isProd),
            removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
          }),
          level: stepfunctions.LogLevel.ALL,
        },
      }
    );

    // ======================================================================
    // Step Functions: Data Analysis Workflow
    // ======================================================================

    const runQueryTask = new tasks.LambdaInvoke(this, 'RunQueryTask', {
      lambdaFunction: runDataQueryChimera.fn,
      outputPath: '$.Payload',
    });
    runQueryTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const checkQueryTask = new tasks.LambdaInvoke(this, 'CheckQueryTask', {
      lambdaFunction: checkQueryStatusChimera.fn,
      outputPath: '$.Payload',
    });
    checkQueryTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const queryWait = new stepfunctions.Wait(this, 'QueryWait', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const querySucceeded = new stepfunctions.Succeed(this, 'QuerySucceeded');
    const queryFailed = new stepfunctions.Fail(this, 'QueryFailed', {
      cause: 'Query execution failed',
      error: 'QueryError',
    });

    runQueryTask.addCatch(queryFailed, { errors: ['States.ALL'], resultPath: '$.error' });
    checkQueryTask.addCatch(queryFailed, { errors: ['States.ALL'], resultPath: '$.error' });

    const checkQueryChoice = new stepfunctions.Choice(this, 'QueryComplete?')
      .when(stepfunctions.Condition.stringEquals('$.status', 'COMPLETED'), querySucceeded)
      .when(stepfunctions.Condition.stringEquals('$.status', 'FAILED'), queryFailed)
      .otherwise(queryWait);

    queryWait.next(checkQueryTask);
    checkQueryTask.next(checkQueryChoice);

    const dataAnalysisDefinition = runQueryTask.next(queryWait);

    this.dataAnalysisStateMachine = new stepfunctions.StateMachine(
      this,
      'DataAnalysisStateMachine',
      {
        stateMachineName: `chimera-data-analysis-${props.envName}`,
        definitionBody: stepfunctions.DefinitionBody.fromChainable(dataAnalysisDefinition),
        timeout: cdk.Duration.minutes(15),
        logs: {
          destination: new logs.LogGroup(this, 'DataAnalysisLogGroup', {
            logGroupName: `/aws/vendedlogs/states/chimera-data-analysis-${props.envName}`,
            retention: logRetentionFor('debug', isProd),
            removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
          }),
          level: stepfunctions.LogLevel.ALL,
        },
      }
    );

    // ======================================================================
    // Step Functions: Background Task Workflow
    // ======================================================================

    const executeTaskStep = new tasks.LambdaInvoke(this, 'ExecuteBackgroundTaskStep', {
      lambdaFunction: executeBackgroundTaskChimera.fn,
      outputPath: '$.Payload',
    });
    executeTaskStep.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const checkTaskStep = new tasks.LambdaInvoke(this, 'CheckBackgroundTaskStep', {
      lambdaFunction: checkBackgroundTaskStatusChimera.fn,
      outputPath: '$.Payload',
    });
    checkTaskStep.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const taskWait = new stepfunctions.Wait(this, 'BackgroundTaskWait', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const taskSucceeded = new stepfunctions.Succeed(this, 'BackgroundTaskSucceeded');
    const taskFailed = new stepfunctions.Fail(this, 'BackgroundTaskFailed', {
      cause: 'Background task execution failed',
      error: 'BackgroundTaskError',
    });

    executeTaskStep.addCatch(taskFailed, { errors: ['States.ALL'], resultPath: '$.error' });
    checkTaskStep.addCatch(taskFailed, { errors: ['States.ALL'], resultPath: '$.error' });

    const checkTaskChoice = new stepfunctions.Choice(this, 'BackgroundTaskComplete?')
      .when(stepfunctions.Condition.stringEquals('$.status', 'COMPLETED'), taskSucceeded)
      .when(stepfunctions.Condition.stringEquals('$.status', 'FAILED'), taskFailed)
      .otherwise(taskWait);

    taskWait.next(checkTaskStep);
    checkTaskStep.next(checkTaskChoice);

    const backgroundTaskDefinition = executeTaskStep.next(taskWait);

    this.backgroundTaskStateMachine = new stepfunctions.StateMachine(
      this,
      'BackgroundTaskStateMachine',
      {
        stateMachineName: `chimera-background-task-${props.envName}`,
        definitionBody: stepfunctions.DefinitionBody.fromChainable(backgroundTaskDefinition),
        timeout: cdk.Duration.minutes(10),
        logs: {
          destination: new logs.LogGroup(this, 'BackgroundTaskLogGroup', {
            logGroupName: `/aws/vendedlogs/states/chimera-background-task-${props.envName}`,
            retention: logRetentionFor('debug', isProd),
            removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
          }),
          level: stepfunctions.LogLevel.ALL,
        },
      }
    );

    this.pipelineBuildStateMachine.grantStartExecution(eventPublisherRole);
    this.dataAnalysisStateMachine.grantStartExecution(eventPublisherRole);
    this.backgroundTaskStateMachine.grantStartExecution(eventPublisherRole);

    // ======================================================================
    // EventBridge Rule: Background Task Started → Step Functions
    // ======================================================================

    const backgroundTaskRule = new events.Rule(this, 'BackgroundTaskStartedRule', {
      ruleName: `chimera-background-task-started-${props.envName}`,
      eventBus: this.eventBus,
      description: 'Route background task started events to Step Functions',
      eventPattern: {
        source: ['chimera.agents'],
        detailType: ['Background Task Started'],
      },
    });

    const stepFunctionsInvokeRole = new iam.Role(this, 'StepFunctionsInvokeRole', {
      roleName: `chimera-sfn-invoke-${props.envName}`,
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
      description: 'Allows EventBridge to invoke Step Functions state machines',
    });

    this.backgroundTaskStateMachine.grantStartExecution(stepFunctionsInvokeRole);

    backgroundTaskRule.addTarget(
      new targets.SfnStateMachine(this.backgroundTaskStateMachine, {
        role: stepFunctionsInvokeRole,
        input: events.RuleTargetInput.fromEventPath('$.detail'),
      })
    );

    // ======================================================================
    // EventBridge Rule: Swarm Execution Started → Step Functions + CloudWatch
    // Routes swarm execution requests to the background task state machine
    // for DynamoDB tracking, and logs to CloudWatch for debugging.
    // ======================================================================

    const swarmExecutionRule = new events.Rule(this, 'SwarmExecutionStartedRule', {
      ruleName: `chimera-swarm-execution-${props.envName}`,
      eventBus: this.eventBus,
      description: 'Routes swarm execution requests to the background task state machine',
      eventPattern: {
        source: ['chimera.agents'],
        detailType: ['Swarm Execution Started'],
      },
    });
    swarmExecutionRule.addTarget(
      new targets.SfnStateMachine(this.backgroundTaskStateMachine, {
        role: stepFunctionsInvokeRole,
        input: events.RuleTargetInput.fromEventPath('$.detail'),
      })
    );
    swarmExecutionRule.addTarget(new targets.CloudWatchLogGroup(eventLogGroup));

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

    new cdk.CfnOutput(this, 'SchedulerGroupName', {
      value: this.schedulerGroup.name || `chimera-agent-schedules-${props.envName}`,
      exportName: `${this.stackName}-SchedulerGroupName`,
      description: 'EventBridge Scheduler group name for agent cron tasks',
    });

    new cdk.CfnOutput(this, 'PipelineBuildStateMachineArn', {
      value: this.pipelineBuildStateMachine.stateMachineArn,
      exportName: `${this.stackName}-PipelineBuildStateMachineArn`,
      description: 'Step Functions state machine ARN for pipeline build workflow',
    });

    new cdk.CfnOutput(this, 'DataAnalysisStateMachineArn', {
      value: this.dataAnalysisStateMachine.stateMachineArn,
      exportName: `${this.stackName}-DataAnalysisStateMachineArn`,
      description: 'Step Functions state machine ARN for data analysis workflow',
    });

    new cdk.CfnOutput(this, 'BackgroundTaskStateMachineArn', {
      value: this.backgroundTaskStateMachine.stateMachineArn,
      exportName: `${this.stackName}-BackgroundTaskStateMachineArn`,
      description: 'Step Functions state machine ARN for background task execution',
    });

    new cdk.CfnOutput(this, 'QueueProvisionerRoleArn', {
      value: queueProvisionerRole.roleArn,
      exportName: `${this.stackName}-QueueProvisionerRoleArn`,
      description: 'IAM role ARN for provisioning per-tenant FIFO queues',
    });

    new cdk.CfnOutput(this, 'GroupChatProvisionerRoleArn', {
      value: groupChatProvisionerRole.roleArn,
      exportName: `${this.stackName}-GroupChatProvisionerRoleArn`,
      description:
        'IAM role ARN for provisioning SNS topics and SQS subscriptions for agent groupchat',
    });

    // chimera-2b2a outputs ---------------------------------------------------
    new cdk.CfnOutput(this, 'SchedulesTableName', {
      value: this.schedulesTable.tableName,
      exportName: `${this.stackName}-SchedulesTableName`,
      description: 'chimera-schedules DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'SchedulesTableArn', {
      value: this.schedulesTable.tableArn,
      exportName: `${this.stackName}-SchedulesTableArn`,
      description: 'chimera-schedules DynamoDB table ARN',
    });

    new cdk.CfnOutput(this, 'ScheduleDispatcherArn', {
      value: this.scheduleDispatcher.functionArn,
      exportName: `${this.stackName}-ScheduleDispatcherArn`,
      description: 'chimera-schedule-dispatcher Lambda ARN',
    });

    new cdk.CfnOutput(this, 'ScheduleDispatcherDlqArn', {
      value: this.scheduleDispatcherDlq.queueArn,
      exportName: `${this.stackName}-ScheduleDispatcherDlqArn`,
      description: 'DLQ ARN for the schedule dispatcher Lambda',
    });

    new cdk.CfnOutput(this, 'ScheduleSigningKeySecretArn', {
      value: this.scheduleSigningKeySecret.secretArn,
      exportName: `${this.stackName}-ScheduleSigningKeySecretArn`,
      description: 'Secrets Manager ARN for the HMAC schedule signing key',
    });

    new cdk.CfnOutput(this, 'SchedulerRoleArn', {
      value: this.schedulerRole.roleArn,
      exportName: `${this.stackName}-SchedulerRoleArn`,
      description:
        'IAM role ARN that EventBridge Scheduler assumes to invoke the dispatcher Lambda',
    });
  }
}
