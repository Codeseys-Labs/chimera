import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface ChimeraBucketProps {
  /** Bucket name */
  bucketName?: string;
  /** KMS key for encryption — if not provided, a new key is created */
  encryptionKey?: kms.IKey;
  /** External access log bucket — skip creating internal one */
  serverAccessLogsBucket?: s3.IBucket;
  /** Set true if this bucket IS the access log bucket (disables self-logging) */
  isAccessLogBucket?: boolean;
  /** Days before noncurrent versions expire (default: 90) */
  noncurrentVersionExpiration?: cdk.Duration;
  /** Removal policy (default: RETAIN) */
  removalPolicy?: cdk.RemovalPolicy;
}

/**
 * L3 construct for Chimera S3 buckets.
 *
 * Mandatory invariants (cannot be overridden):
 * - KMS encryption (never S3-managed / AES256)
 * - Versioning always enabled
 * - All public access blocked
 * - SSL enforced
 * - Access logging enabled (unless isAccessLogBucket: true)
 * - Lifecycle: abort incomplete multipart uploads after 7 days
 * - Lifecycle: noncurrent version expiry (default 90 days)
 */
export class ChimeraBucket extends Construct {
  readonly bucket: s3.Bucket;
  readonly encryptionKey: kms.IKey;
  readonly accessLogBucket?: s3.Bucket;

  constructor(scope: Construct, id: string, props: ChimeraBucketProps = {}) {
    super(scope, id);

    this.encryptionKey = props.encryptionKey ?? new kms.Key(this, 'Key', {
      description: props.bucketName ? `CMK for ${props.bucketName}` : `CMK for bucket`,
      enableKeyRotation: true,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
    });

    // Create internal access log bucket if not an access log bucket and no external one provided
    let logBucket: s3.IBucket | undefined = props.serverAccessLogsBucket;
    if (!props.isAccessLogBucket && !props.serverAccessLogsBucket) {
      this.accessLogBucket = new s3.Bucket(this, 'AccessLogs', {
        bucketName: props.bucketName ? `${props.bucketName}-access-logs` : undefined,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: this.encryptionKey,
        versioned: false,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          {
            // Access logs don't need long retention
            expiration: cdk.Duration.days(90),
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
          },
        ],
      });
      logBucket = this.accessLogBucket;
    }

    const noncurrentVersionExpiration = props.noncurrentVersionExpiration ?? cdk.Duration.days(90);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: props.bucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
          noncurrentVersionExpiration,
        },
      ],
    });
  }
}
