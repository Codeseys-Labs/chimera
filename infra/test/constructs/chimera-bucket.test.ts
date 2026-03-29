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

  it('enables versioning by default', () => {
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

  it('configures noncurrent version expiration lifecycle rule when versioned', () => {
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

  describe('with versioned: false', () => {
    let unversionedStack: cdk.Stack;
    let unversionedTemplate: Template;

    beforeAll(() => {
      const app4 = new cdk.App();
      unversionedStack = new cdk.Stack(app4, 'UnversionedStack');
      new ChimeraBucket(unversionedStack, 'UnversionedBucket', {
        versioned: false,
      });
      unversionedTemplate = Template.fromStack(unversionedStack);
    });

    it('does not enable versioning', () => {
      // No bucket should have versioning enabled
      const buckets = unversionedTemplate.findResources('AWS::S3::Bucket');
      for (const bucket of Object.values(buckets)) {
        const props = (bucket as { Properties: Record<string, unknown> }).Properties;
        expect(props['VersioningConfiguration']).toBeUndefined();
      }
    });

    it('still adds the abort-incomplete-MPU lifecycle rule', () => {
      unversionedTemplate.hasResourceProperties('AWS::S3::Bucket', {
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

    it('does not add noncurrent version expiration when unversioned', () => {
      // The main bucket lifecycle rule should not contain NoncurrentVersionExpiration
      const buckets = unversionedTemplate.findResources('AWS::S3::Bucket', {
        Properties: {
          VersioningConfiguration: Match.absent(),
          LifecycleConfiguration: Match.anyValue(),
        },
      });
      for (const bucket of Object.values(buckets)) {
        const rules = ((bucket as Record<string, unknown>).Properties as Record<string, unknown>)?.['LifecycleConfiguration'] as { Rules?: unknown[] } | undefined;
        if (rules?.Rules) {
          for (const rule of rules.Rules) {
            expect((rule as Record<string, unknown>)['NoncurrentVersionExpiration']).toBeUndefined();
          }
        }
      }
    });
  });

  describe('with additionalLifecycleRules', () => {
    let extraRulesStack: cdk.Stack;
    let extraRulesTemplate: Template;

    beforeAll(() => {
      const app5 = new cdk.App();
      extraRulesStack = new cdk.Stack(app5, 'ExtraRulesStack');
      new ChimeraBucket(extraRulesStack, 'ExtraRulesBucket', {
        additionalLifecycleRules: [
          {
            id: 'expire-old-objects',
            expiration: cdk.Duration.days(30),
            prefix: 'artifacts/',
          },
        ],
      });
      extraRulesTemplate = Template.fromStack(extraRulesStack);
    });

    it('appends the additional lifecycle rule alongside the default MPU rule', () => {
      extraRulesTemplate.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
              Status: 'Enabled',
            }),
            Match.objectLike({
              Id: 'expire-old-objects',
              ExpirationInDays: 30,
              Prefix: 'artifacts/',
              Status: 'Enabled',
            }),
          ]),
        },
      });
    });
  });
});
