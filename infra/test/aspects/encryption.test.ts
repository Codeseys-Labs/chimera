import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { EncryptionAspect } from '../../aspects/encryption';

jest.setTimeout(30000);

describe('EncryptionAspect', () => {
  describe('S3: compliant bucket with KMS encryption', () => {
    let annotations: Annotations;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'KMSBucketStack');

      new s3.CfnBucket(stack, 'KMSBucket', {
        bucketEncryption: {
          serverSideEncryptionConfiguration: [
            {
              serverSideEncryptionByDefault: {
                sseAlgorithm: 'aws:kms',
              },
            },
          ],
        },
      });

      cdk.Aspects.of(stack).add(new EncryptionAspect());
      annotations = Annotations.fromStack(stack);
    });

    it('should not error on KMS-encrypted bucket', () => {
      annotations.hasNoError('*', Match.anyValue());
    });
  });

  describe('S3: non-compliant buckets', () => {
    let annotations: Annotations;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'NonCompliantBucketStack');

      new s3.CfnBucket(stack, 'AES256Bucket', {
        bucketEncryption: {
          serverSideEncryptionConfiguration: [
            {
              serverSideEncryptionByDefault: {
                sseAlgorithm: 'AES256',
              },
            },
          ],
        },
      });

      new s3.CfnBucket(stack, 'UnencryptedBucket', {
        // No bucketEncryption
      });

      cdk.Aspects.of(stack).add(new EncryptionAspect());
      annotations = Annotations.fromStack(stack);
    });

    it('should error on AES256 bucket', () => {
      annotations.hasError(
        '/NonCompliantBucketStack/AES256Bucket',
        Match.stringLikeRegexp('KMS'),
      );
    });

    it('should error on unencrypted bucket', () => {
      annotations.hasError(
        '/NonCompliantBucketStack/UnencryptedBucket',
        Match.stringLikeRegexp('KMS'),
      );
    });

    it('error message should mention KMS', () => {
      const errors = annotations.findError('*', Match.stringLikeRegexp('KMS'));
      expect(errors.length).toBe(2);
    });
  });

  describe('SQS: compliant queue with KMS key', () => {
    let annotations: Annotations;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'KMSQueueStack');

      new sqs.CfnQueue(stack, 'KMSQueue', {
        kmsMasterKeyId: 'arn:aws:kms:us-east-1:123456789:key/test-key',
      });

      cdk.Aspects.of(stack).add(new EncryptionAspect());
      annotations = Annotations.fromStack(stack);
    });

    it('should not warn on KMS-encrypted queue', () => {
      annotations.hasNoWarning('*', Match.anyValue());
    });
  });

  describe('SQS: compliant queue with SQS-managed SSE', () => {
    let annotations: Annotations;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'SqsSseStack');

      new sqs.CfnQueue(stack, 'SqsSseQueue', {
        sqsManagedSseEnabled: true,
      });

      cdk.Aspects.of(stack).add(new EncryptionAspect());
      annotations = Annotations.fromStack(stack);
    });

    it('should not warn on SQS-managed SSE queue', () => {
      annotations.hasNoWarning('*', Match.anyValue());
    });
  });

  describe('SQS: non-compliant unencrypted queue', () => {
    let annotations: Annotations;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'UnencryptedQueueStack');

      new sqs.CfnQueue(stack, 'PlainQueue', {
        // No KMS key, no SQS managed SSE
      });

      cdk.Aspects.of(stack).add(new EncryptionAspect());
      annotations = Annotations.fromStack(stack);
    });

    it('should warn on unencrypted SQS queue', () => {
      annotations.hasWarning(
        '/UnencryptedQueueStack/PlainQueue',
        Match.stringLikeRegexp('KMS'),
      );
    });
  });
});
