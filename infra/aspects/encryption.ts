import * as cdk from 'aws-cdk-lib';
import { CfnBucket } from 'aws-cdk-lib/aws-s3';
import { CfnQueue } from 'aws-cdk-lib/aws-sqs';
import { IConstruct } from 'constructs';

/**
 * Enforces KMS encryption on S3 buckets and warns on unencrypted SQS queues.
 *
 * S3 buckets must use 'aws:kms' SSE algorithm (not AES256 or unencrypted).
 * SQS queues should have either a CMK (kmsMasterKeyId) or SQS-managed SSE enabled.
 */
export class EncryptionAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnBucket) {
      this.checkBucketEncryption(node);
    } else if (node instanceof CfnQueue) {
      this.checkQueueEncryption(node);
    }
  }

  private checkBucketEncryption(bucket: CfnBucket): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encryption = bucket.bucketEncryption as any;

    if (!encryption) {
      cdk.Annotations.of(bucket).addError(
        'S3 bucket must use KMS encryption, not AES256 or unencrypted',
      );
      return;
    }

    const rules = encryption.serverSideEncryptionConfiguration;
    if (!Array.isArray(rules) || rules.length === 0) {
      cdk.Annotations.of(bucket).addError(
        'S3 bucket must use KMS encryption, not AES256 or unencrypted',
      );
      return;
    }

    const hasKms = rules.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rule: any) =>
        rule?.serverSideEncryptionByDefault?.sseAlgorithm === 'aws:kms',
    );

    if (!hasKms) {
      cdk.Annotations.of(bucket).addError(
        'S3 bucket must use KMS encryption, not AES256 or unencrypted',
      );
    }
  }

  private checkQueueEncryption(queue: CfnQueue): void {
    const hasKmsKey = !!queue.kmsMasterKeyId;
    const hasSqsManagedSse = queue.sqsManagedSseEnabled === true;

    if (!hasKmsKey && !hasSqsManagedSse) {
      cdk.Annotations.of(queue).addWarning(
        'SQS queue should use KMS encryption',
      );
    }
  }
}
