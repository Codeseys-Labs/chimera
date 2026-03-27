import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import { ChimeraBucket } from '../../constructs/chimera-bucket';

jest.setTimeout(30000);

describe('ChimeraBucket', () => {
  let stack: cdk.Stack;
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
    new ChimeraBucket(stack, 'MyBucket', {
      bucketName: 'test-bucket',
    });
    template = Template.fromStack(stack);
  });

  it('uses KMS encryption (not S3-managed)', () => {
    // The main bucket should have KMS SSE (allow extra fields like KMSMasterKeyID)
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: 'aws:kms',
            }),
          }),
        ]),
      },
    });
  });

  it('enables versioning', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: {
        Status: 'Enabled',
      },
    });
  });

  it('blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('enforces SSL via bucket policy', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: {
              Bool: { 'aws:SecureTransport': 'false' },
            },
          }),
        ]),
      },
    });
  });

  it('creates an access log bucket', () => {
    // Default: creates an access log bucket + main bucket = 2 buckets
    template.resourceCountIs('AWS::S3::Bucket', 2);
  });

  it('configures lifecycle rule to abort incomplete multipart uploads', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            AbortIncompleteMultipartUpload: {
              DaysAfterInitiation: 7,
            },
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });

  it('configures noncurrent version expiration lifecycle rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            NoncurrentVersionExpiration: {
              NoncurrentDays: 90,
            },
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });

  it('creates a KMS key', () => {
    template.resourcePropertiesCountIs('AWS::KMS::Key', {
      EnableKeyRotation: true,
    }, 1);
  });

  describe('as access log bucket (isAccessLogBucket: true)', () => {
    let logStack: cdk.Stack;
    let logTemplate: Template;

    beforeAll(() => {
      const app2 = new cdk.App();
      logStack = new cdk.Stack(app2, 'LogStack');
      new ChimeraBucket(logStack, 'LogBucket', {
        isAccessLogBucket: true,
      });
      logTemplate = Template.fromStack(logStack);
    });

    it('creates only one bucket (no self-logging)', () => {
      logTemplate.resourceCountIs('AWS::S3::Bucket', 1);
    });
  });

  describe('with provided encryption key', () => {
    let keyStack: cdk.Stack;
    let keyTemplate: Template;

    beforeAll(() => {
      const app3 = new cdk.App();
      keyStack = new cdk.Stack(app3, 'KeyBucketStack');
      const externalKey = new kms.Key(keyStack, 'ExternalKey');
      new ChimeraBucket(keyStack, 'BucketWithKey', {
        encryptionKey: externalKey,
      });
      keyTemplate = Template.fromStack(keyStack);
    });

    it('does not create an additional KMS key', () => {
      keyTemplate.resourceCountIs('AWS::KMS::Key', 1);
    });
  });
});
