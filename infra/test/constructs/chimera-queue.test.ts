import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { ChimeraQueue } from '../../constructs/chimera-queue';

jest.setTimeout(30000);

describe('ChimeraQueue', () => {
  let stack: cdk.Stack;
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
    new ChimeraQueue(stack, 'MyQueue', {
      queueName: 'test-queue',
    });
    template = Template.fromStack(stack);
  });

  it('creates main queue and DLQ (2 SQS queues total)', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
  });

  it('creates a KMS key', () => {
    template.resourceCountIs('AWS::KMS::Key', 1);
  });

  it('main queue uses KMS encryption', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'test-queue',
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  it('DLQ uses KMS encryption', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'test-queue-dlq',
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  it('creates CloudWatch alarm for ApproximateNumberOfMessagesVisible', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'test-queue-backlog',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1000,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('creates CloudWatch alarm for ApproximateAgeOfOldestMessage', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'test-queue-message-age',
      MetricName: 'ApproximateAgeOfOldestMessage',
      Threshold: 300,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('configures DLQ redrive with default maxReceiveCount=3', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'test-queue',
      RedrivePolicy: {
        maxReceiveCount: 3,
        deadLetterTargetArn: Match.anyValue(),
      },
    });
  });

  it('sets default visibility timeout of 180 seconds', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'test-queue',
      VisibilityTimeout: 180,
    });
  });

  describe('with alarm topic', () => {
    let topicStack: cdk.Stack;
    let topicTemplate: Template;

    beforeAll(() => {
      const app2 = new cdk.App();
      topicStack = new cdk.Stack(app2, 'TopicStack');
      const alarmTopic = new sns.Topic(topicStack, 'AlarmTopic');
      new ChimeraQueue(topicStack, 'TopicQueue', {
        queueName: 'topic-queue',
        alarmTopic,
      });
      topicTemplate = Template.fromStack(topicStack);
    });

    it('adds SNS alarm actions', () => {
      // AlarmActions should be a non-empty array — use objectLike to verify field exists
      topicTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmActions: Match.anyValue(),
      });
    });
  });

  describe('FIFO queue', () => {
    let fifoStack: cdk.Stack;
    let fifoTemplate: Template;

    beforeAll(() => {
      const app3 = new cdk.App();
      fifoStack = new cdk.Stack(app3, 'FifoStack');
      new ChimeraQueue(fifoStack, 'FifoQueue', {
        queueName: 'test-fifo',
        fifo: true,
      });
      fifoTemplate = Template.fromStack(fifoStack);
    });

    it('creates FIFO main queue', () => {
      fifoTemplate.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'test-fifo.fifo',
        FifoQueue: true,
      });
    });

    it('creates FIFO DLQ', () => {
      fifoTemplate.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'test-fifo-dlq.fifo',
        FifoQueue: true,
      });
    });
  });
});
