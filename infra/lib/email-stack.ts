import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface EmailStackProps extends cdk.StackProps {
  envName: string;
  /** The chimera-sessions DynamoDB table for storing email thread records */
  sessionsTable: dynamodb.ITable;
  /** EventBridge event bus from OrchestrationStack for receiving email.send requests */
  agentEventBus: events.IEventBus;
  /**
   * Email domain for receiving inbound email (e.g. "mail.chimera.example.com").
   * An MX record pointing to inbound-smtp.<region>.amazonaws.com must exist.
   * If omitted, the receipt rule will match all recipients (useful for dev).
   */
  emailDomain?: string;
  /**
   * From address for outbound replies (e.g. "Chimera Agent <agent@mail.chimera.example.com>").
   * Must be a SES-verified identity.
   */
  fromAddress?: string;
}

/**
 * Email agent communication channel.
 *
 * Implements full inbound/outbound email for agent communication:
 * - SES Classic Receipt Rule: receives email → writes raw MIME to S3
 * - S3 Event Notification → SQS → EmailParserLambda
 *   - Parses MIME headers and body
 *   - Writes email record to chimera-sessions DynamoDB table
 *   - Emits email.received to chimera-orchestration EventBridge bus
 * - EventBridge rule: "Email Send Request" → SQS → EmailSenderLambda
 *   - Fetches original email metadata for threading (In-Reply-To, References)
 *   - Sends reply via SES v2 SendEmail API
 *   - Updates DDB record status to REPLIED
 *
 * Domain setup (manual, outside CDK):
 * 1. Add MX record: <emailDomain> → 10 inbound-smtp.<region>.amazonaws.com
 * 2. Verify domain in SES console (Easy DKIM + SPF TXT record)
 * 3. Request SES production access (sandbox blocks outbound to unverified addresses)
 *
 * Reference: docs/research/ses-mail-manager-architecture.md
 */
export class EmailStack extends cdk.Stack {
  /** S3 bucket storing raw inbound MIME emails */
  public readonly inboundEmailBucket: s3.Bucket;
  /** SQS queue feeding the email parser Lambda */
  public readonly emailParserQueue: sqs.Queue;
  /** SQS queue feeding the email sender Lambda */
  public readonly emailSenderQueue: sqs.Queue;
  /** Lambda that parses inbound MIME emails */
  public readonly emailParserFunction: lambda.Function;
  /** Lambda that sends outbound SES replies */
  public readonly emailSenderFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: EmailStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';
    const fromAddress = props.fromAddress ?? `Chimera Agent <agent@${props.emailDomain ?? 'chimera.example.com'}>`;

    // ======================================================================
    // KMS: Email-local encryption key for SQS queues
    // Using a stack-local key avoids a CDK circular dependency: if we used
    // SecurityStack's platformKey, CDK's auto-grant mechanism inside
    // addEventSource() would add a key policy grant referencing Lambda role
    // ARNs from this stack, creating SecurityStack → EmailStack back-edge
    // while EmailStack → SecurityStack already exists.
    // ======================================================================
    const emailKey = new kms.Key(this, 'EmailKey', {
      alias: `chimera-email-${props.envName}`,
      enableKeyRotation: true,
      description: 'Email stack SQS queue encryption key',
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ======================================================================
    // S3 Bucket: Inbound Email Storage
    // SES writes raw MIME emails here. Lambda fetches and parses them.
    // ======================================================================

    this.inboundEmailBucket = new s3.Bucket(this, 'InboundEmailBucket', {
      bucketName: `chimera-inbound-email-${props.envName}-${this.account}`,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Retain in prod, destroy in dev
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      // Lifecycle: delete raw MIME after 90 days (parsed content lives in DDB)
      lifecycleRules: [{
        id: 'expire-raw-email',
        expiration: cdk.Duration.days(90),
        prefix: 'inbound/',
      }],
      // Enable EventBridge notifications so S3 events flow to the SES receipt target
      eventBridgeEnabled: false, // We use direct SQS notifications below
    });

    // SES requires a bucket policy allowing ses.amazonaws.com to write to this bucket
    this.inboundEmailBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowSESPut',
      principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [`${this.inboundEmailBucket.bucketArn}/inbound/*`],
      conditions: {
        StringEquals: {
          'aws:Referer': this.account,
        },
      },
    }));

    // ======================================================================
    // SQS: Email Parser Queue (Standard)
    // S3 event notifications → this queue → EmailParserLambda.
    // Backpressure + DLQ for resilience.
    // ======================================================================

    const parserDlq = new sqs.Queue(this, 'EmailParserDLQ', {
      queueName: `chimera-email-parser-dlq-${props.envName}`,
      retentionPeriod: cdk.Duration.days(14),
      encryptionMasterKey: emailKey,
    });

    this.emailParserQueue = new sqs.Queue(this, 'EmailParserQueue', {
      queueName: `chimera-email-parser-${props.envName}`,
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      encryptionMasterKey: emailKey,
      deadLetterQueue: {
        queue: parserDlq,
        maxReceiveCount: 3,
      },
    });

    // CloudWatch alarm: circuit breaker on parser DLQ (per dlq-circuit-breaker-alarms convention)
    new cloudwatch.Alarm(this, 'EmailParserDLQAlarm', {
      alarmName: `chimera-email-parser-dlq-${props.envName}`,
      alarmDescription: 'Circuit breaker: email parser DLQ depth exceeds threshold',
      metric: parserDlq.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.AVERAGE,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // S3 → SQS event notification for new objects in the inbound/ prefix
    this.inboundEmailBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(this.emailParserQueue),
      { prefix: 'inbound/' },
    );

    // ======================================================================
    // SQS: Email Sender Queue (Standard)
    // EventBridge "Email Send Request" events → this queue → EmailSenderLambda.
    // ======================================================================

    const senderDlq = new sqs.Queue(this, 'EmailSenderDLQ', {
      queueName: `chimera-email-sender-dlq-${props.envName}`,
      retentionPeriod: cdk.Duration.days(14),
      encryptionMasterKey: emailKey,
    });

    this.emailSenderQueue = new sqs.Queue(this, 'EmailSenderQueue', {
      queueName: `chimera-email-sender-${props.envName}`,
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      encryptionMasterKey: emailKey,
      deadLetterQueue: {
        queue: senderDlq,
        maxReceiveCount: 3,
      },
    });

    // CloudWatch alarm: circuit breaker on sender DLQ
    new cloudwatch.Alarm(this, 'EmailSenderDLQAlarm', {
      alarmName: `chimera-email-sender-dlq-${props.envName}`,
      alarmDescription: 'Circuit breaker: email sender DLQ depth exceeds threshold',
      metric: senderDlq.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.AVERAGE,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // EventBridge rule: route "Email Send Request" events to sender queue
    const emailSendRule = new events.Rule(this, 'EmailSendRule', {
      ruleName: `chimera-email-send-${props.envName}`,
      eventBus: props.agentEventBus,
      description: 'Route agent email send requests to the sender queue',
      eventPattern: {
        source: ['chimera.agents', 'chimera.email'],
        detailType: ['Email Send Request'],
      },
    });
    emailSendRule.addTarget(new eventsTargets.SqsQueue(this.emailSenderQueue));

    // ======================================================================
    // Lambda: Email Parser
    // Parses inbound MIME emails from S3 and emits email.received events.
    // ======================================================================

    const parserLogGroup = new logs.LogGroup(this, 'EmailParserLogGroup', {
      logGroupName: `/aws/lambda/chimera-email-parser-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.emailParserFunction = new lambda.Function(this, 'EmailParserFunction', {
      functionName: `chimera-email-parser-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/email-parser')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: parserLogGroup,
      environment: {
        SESSIONS_TABLE: props.sessionsTable.tableName,
        EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        INBOUND_BUCKET: this.inboundEmailBucket.bucketName,
      },
    });

    // Grant S3 read access for fetching MIME emails
    this.inboundEmailBucket.grantRead(this.emailParserFunction);
    // Grant DynamoDB write for email records
    props.sessionsTable.grantWriteData(this.emailParserFunction);
    // Grant EventBridge publish for email.received events
    props.agentEventBus.grantPutEventsTo(this.emailParserFunction);

    // Trigger parser from SQS queue; report partial batch failures for resilience
    this.emailParserFunction.addEventSource(new lambdaEventSources.SqsEventSource(
      this.emailParserQueue,
      {
        batchSize: 10,
        reportBatchItemFailures: true,
      },
    ));

    // ======================================================================
    // Lambda: Email Sender
    // Sends agent replies via SES v2, preserving email threading headers.
    // ======================================================================

    const senderLogGroup = new logs.LogGroup(this, 'EmailSenderLogGroup', {
      logGroupName: `/aws/lambda/chimera-email-sender-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.emailSenderFunction = new lambda.Function(this, 'EmailSenderFunction', {
      functionName: `chimera-email-sender-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/email-sender')),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      logGroup: senderLogGroup,
      environment: {
        SESSIONS_TABLE: props.sessionsTable.tableName,
        FROM_ADDRESS: fromAddress,
      },
    });

    // Grant DynamoDB read/write for threading context and status updates
    props.sessionsTable.grantReadWriteData(this.emailSenderFunction);

    // Grant SES v2 SendEmail permission
    this.emailSenderFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      // Allow sending from the configured domain identity
      resources: [
        `arn:aws:ses:${this.region}:${this.account}:identity/*`,
        `arn:aws:ses:${this.region}:${this.account}:configuration-set/*`,
      ],
    }));

    // Trigger sender from SQS queue
    this.emailSenderFunction.addEventSource(new lambdaEventSources.SqsEventSource(
      this.emailSenderQueue,
      {
        batchSize: 5,
        reportBatchItemFailures: true,
      },
    ));

    // ======================================================================
    // SES Classic Receipt Rule Set + Receipt Rule
    // Accepts inbound email and writes raw MIME to the S3 bucket.
    // Note: only one rule set can be active per region. Activating via custom resource.
    // ======================================================================

    const ruleSet = new ses.ReceiptRuleSet(this, 'EmailRuleSet', {
      receiptRuleSetName: `chimera-email-rules-${props.envName}`,
    });

    ruleSet.addRule('InboundToS3', {
      // Match on the email domain if provided; otherwise accept all recipients.
      recipients: props.emailDomain ? [`@${props.emailDomain}`] : [],
      actions: [
        new sesActions.S3({
          bucket: this.inboundEmailBucket,
          objectKeyPrefix: 'inbound/',
        }),
      ],
      enabled: true,
      scanEnabled: true, // Enable spam/virus scanning
    });

    // Activate this rule set as the active one in the region.
    // Uses AwsCustomResource with both onCreate and onUpdate to avoid stale attributes
    // (per cdk-aws-custom-resource-update-stale-attribute convention).
    const activateRuleSet = new cr.AwsCustomResource(this, 'ActivateEmailRuleSet', {
      onCreate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: {
          RuleSetName: `chimera-email-rules-${props.envName}`,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`chimera-email-rules-active-${props.envName}`),
      },
      onUpdate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: {
          RuleSetName: `chimera-email-rules-${props.envName}`,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`chimera-email-rules-active-${props.envName}`),
      },
      onDelete: {
        // Deactivate by setting active rule set to nothing
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: {},
        physicalResourceId: cr.PhysicalResourceId.of(`chimera-email-rules-active-${props.envName}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    activateRuleSet.node.addDependency(ruleSet);

    // ======================================================================
    // Stack Outputs
    // ======================================================================

    new cdk.CfnOutput(this, 'InboundEmailBucketName', {
      value: this.inboundEmailBucket.bucketName,
      exportName: `${this.stackName}-InboundEmailBucketName`,
      description: 'S3 bucket storing raw inbound MIME emails',
    });

    new cdk.CfnOutput(this, 'EmailParserQueueUrl', {
      value: this.emailParserQueue.queueUrl,
      exportName: `${this.stackName}-EmailParserQueueUrl`,
      description: 'SQS queue URL for email parser Lambda trigger',
    });

    new cdk.CfnOutput(this, 'EmailSenderQueueUrl', {
      value: this.emailSenderQueue.queueUrl,
      exportName: `${this.stackName}-EmailSenderQueueUrl`,
      description: 'SQS queue URL for email sender Lambda trigger',
    });

    new cdk.CfnOutput(this, 'EmailParserFunctionArn', {
      value: this.emailParserFunction.functionArn,
      exportName: `${this.stackName}-EmailParserFunctionArn`,
      description: 'ARN of the email parser Lambda function',
    });

    new cdk.CfnOutput(this, 'EmailSenderFunctionArn', {
      value: this.emailSenderFunction.functionArn,
      exportName: `${this.stackName}-EmailSenderFunctionArn`,
      description: 'ARN of the email sender Lambda function',
    });

    new cdk.CfnOutput(this, 'EmailRuleSetName', {
      value: ruleSet.receiptRuleSetName,
      exportName: `${this.stackName}-EmailRuleSetName`,
      description: 'SES receipt rule set name for inbound email',
    });
  }
}
