import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';

export interface ChimeraQueueProps {
  /** Queue name */
  queueName: string;
  /** KMS key — if not provided, a new key is created */
  encryptionKey?: kms.IKey;
  /** Visibility timeout (default: 180 seconds) */
  visibilityTimeout?: cdk.Duration;
  /** Max receive count before moving to DLQ (default: 3) */
  maxReceiveCount?: number;
  /** DLQ message retention (default: 14 days) */
  dlqRetentionPeriod?: cdk.Duration;
  /** SNS topic for CloudWatch alarm notifications */
  alarmTopic?: sns.ITopic;
  /** Create FIFO queue (default: false) */
  fifo?: boolean;
}

/**
 * L3 construct for Chimera SQS queues.
 *
 * Mandatory invariants (cannot be overridden):
 * - DLQ always created with KMS encryption
 * - Main queue always KMS encrypted
 * - CloudWatch alarm: ApproximateNumberOfMessagesVisible > 1000
 * - CloudWatch alarm: ApproximateAgeOfOldestMessage > 300 seconds
 */
export class ChimeraQueue extends Construct {
  readonly queue: sqs.Queue;
  readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: ChimeraQueueProps) {
    super(scope, id);

    const encryptionKey = props.encryptionKey ?? new kms.Key(this, 'Key', {
      description: `CMK for ${props.queueName}`,
      enableKeyRotation: true,
    });

    const isFifo = props.fifo ?? false;
    const dlqName = isFifo ? `${props.queueName}-dlq.fifo` : `${props.queueName}-dlq`;

    this.dlq = new sqs.Queue(this, 'DLQ', {
      queueName: dlqName,
      encryptionMasterKey: encryptionKey,
      retentionPeriod: props.dlqRetentionPeriod ?? cdk.Duration.days(14),
      fifo: isFifo,
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: isFifo ? `${props.queueName}.fifo` : props.queueName,
      encryptionMasterKey: encryptionKey,
      visibilityTimeout: props.visibilityTimeout ?? cdk.Duration.seconds(180),
      fifo: isFifo,
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: props.maxReceiveCount ?? 3,
      },
    });

    // Alarm: too many visible messages (backlog)
    const backlogAlarm = new cloudwatch.Alarm(this, 'BacklogAlarm', {
      alarmName: `${props.queueName}-backlog`,
      metric: this.queue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1000,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: messages aging (processing stalled)
    const ageAlarm = new cloudwatch.Alarm(this, 'AgeAlarm', {
      alarmName: `${props.queueName}-message-age`,
      metric: this.queue.metricApproximateAgeOfOldestMessage(),
      threshold: 300,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    if (props.alarmTopic) {
      backlogAlarm.addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));
      ageAlarm.addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));
    }
  }
}
