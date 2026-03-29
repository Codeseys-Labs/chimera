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
  /** Enable versioning (default: true). Set false for append-only buckets where version history adds no value. */
  versioned?: boolean;
  /** Remove all objects on bucket deletion — for non-prod cleanup (default: false) */
  autoDeleteObjects?: boolean;
  /** Days before noncurrent versions expire (default: 90). Ignored when versioned is false. */
  noncurrentVersionExpiration?: cdk.Duration;
  /** Lifecycle rules to append beyond ChimeraBucket defaults */
  additionalLifecycleRules?: s3.LifecycleRule[];
  /** Removal policy (default: RETAIN) */
  removalPolicy?: cdk.RemovalPolicy;
}

/**
 * L3 construct for Chimera S3 buckets.
 *
 * Mandatory invariants (cannot be overridden):
 * - KMS encryption (never S3-managed / AES256)
 * - All public access blocked
 * - SSL enforced
 * - Access logging enabled (unless isAccessLogBucket: true)
 * - Lifecycle: abort incomplete multipart uploads after 7 days
 *
 * Configurable invariants (with safe defaults):
 * - Versioning: enabled by default; disable for append-only buckets
 * - Noncurrent version expiry: 90 days by default (only when versioned: true)
 * - Additional lifecycle rules: stack-specific rules merged after defaults
 * - Auto-delete objects: false by default; enable for dev/test teardown
 */
export class ChimeraBucket extends Construct {
  readonly bucket: s3.Bucket;
  readonly encryptionKey: kms.IKey;
  readonly accessLogBucket?: s3.Bucket;

  constructor(scope: Construct, id: string, props: ChimeraBucketProps = {}) {
    super(scope, id);

    const versioned = props.versioned ?? true;
    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.RETAIN;
    const autoDeleteObjects = props.autoDeleteObjects ?? false;

    this.encryptionKey = props.encryptionKey ?? new kms.Key(this, 'Key', {
      description: props.bucketName ? `CMK for ${props.bucketName}` : `CMK for bucket`,
      enableKeyRotation: true,
      removalPolicy,
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
        removalPolicy,
        autoDeleteObjects,
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

    // Build default lifecycle rules: abort incomplete MPU always;
    // noncurrent expiry only when versioning is enabled.
    const defaultLifecycleRule: s3.LifecycleRule = {
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      ...(versioned
        ? { noncurrentVersionExpiration: props.noncurrentVersionExpiration ?? cdk.Duration.days(90) }
        : {}),
    };

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: props.bucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      removalPolicy,
      autoDeleteObjects,
      lifecycleRules: [
        defaultLifecycleRule,
        ...(props.additionalLifecycleRules ?? []),
      ],
    });
  }
}
