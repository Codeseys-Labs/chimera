/**
 * CDK tests for DataStack
 *
 * Validates Phase 2 data layer infrastructure:
 * - 6 DynamoDB tables (tenants, sessions, skills, rate-limits, cost-tracking, audit)
 * - Global secondary indexes for query patterns
 * - TTL configurations for ephemeral data
 * - DynamoDB Streams for change data capture
 * - Customer-managed KMS key for audit table encryption
 * - 3 S3 buckets (tenant-data, skills, artifacts)
 * - S3 lifecycle rules and versioning
 * - Stack outputs for all resources
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { DataStack } from '../lib/data-stack';

describe('DataStack', () => {
  let app: cdk.App;
  let vpc: ec2.Vpc;

  beforeEach(() => {
    app = new cdk.App();

    // Create a minimal VPC for the DataStack
    const vpcStack = new cdk.Stack(app, 'VpcStack');
    vpc = new ec2.Vpc(vpcStack, 'TestVpc');
  });

  describe('Dev Environment', () => {
    let stack: DataStack;
    let template: Template;

    beforeEach(() => {
      stack = new DataStack(app, 'TestDataStack', {
        envName: 'dev',
        vpc,
      });
      template = Template.fromStack(stack);
    });

    describe('KMS Key', () => {
      it('should create CMK for audit table encryption', () => {
        template.resourceCountIs('AWS::KMS::Key', 1);

        template.hasResourceProperties('AWS::KMS::Key', {
          Description: 'CMK for Chimera audit log encryption',
          EnableKeyRotation: true,
        });
      });

      it('should create KMS alias for audit key', () => {
        template.resourceCountIs('AWS::KMS::Alias', 1);

        template.hasResourceProperties('AWS::KMS::Alias', {
          AliasName: 'alias/chimera-audit-dev',
        });
      });
    });

    describe('DynamoDB Tables', () => {
      it('should create exactly 6 DynamoDB tables', () => {
        template.resourceCountIs('AWS::DynamoDB::Table', 6);
      });

      describe('Tenants Table', () => {
        it('should create tenants table with correct schema', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-tenants-dev',
            KeySchema: [
              { AttributeName: 'PK', KeyType: 'HASH' },
              { AttributeName: 'SK', KeyType: 'RANGE' },
            ],
            AttributeDefinitions: Match.arrayWith([
              { AttributeName: 'PK', AttributeType: 'S' },
              { AttributeName: 'SK', AttributeType: 'S' },
              { AttributeName: 'tier', AttributeType: 'S' },
              { AttributeName: 'tenantId', AttributeType: 'S' },
              { AttributeName: 'status', AttributeType: 'S' },
            ]),
            BillingMode: 'PAY_PER_REQUEST',
            PointInTimeRecoverySpecification: {
              PointInTimeRecoveryEnabled: true,
            },
            StreamSpecification: {
              StreamViewType: 'NEW_AND_OLD_IMAGES',
            },
          });
        });

        it('should create GSI1-tier index', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-tenants-dev',
            GlobalSecondaryIndexes: Match.arrayWith([
              Match.objectLike({
                IndexName: 'GSI1-tier',
                KeySchema: [
                  { AttributeName: 'tier', KeyType: 'HASH' },
                  { AttributeName: 'tenantId', KeyType: 'RANGE' },
                ],
                Projection: { ProjectionType: 'ALL' },
              }),
            ]),
          });
        });

        it('should create GSI2-status index', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-tenants-dev',
            GlobalSecondaryIndexes: Match.arrayWith([
              Match.objectLike({
                IndexName: 'GSI2-status',
                KeySchema: [
                  { AttributeName: 'status', KeyType: 'HASH' },
                  { AttributeName: 'tenantId', KeyType: 'RANGE' },
                ],
                Projection: { ProjectionType: 'ALL' },
              }),
            ]),
          });
        });
      });

      describe('Sessions Table', () => {
        it('should create sessions table with TTL enabled', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-sessions-dev',
            KeySchema: [
              { AttributeName: 'PK', KeyType: 'HASH' },
              { AttributeName: 'SK', KeyType: 'RANGE' },
            ],
            TimeToLiveSpecification: {
              AttributeName: 'ttl',
              Enabled: true,
            },
            StreamSpecification: {
              StreamViewType: 'NEW_AND_OLD_IMAGES',
            },
          });
        });

        it('should create GSI1-agent-activity index', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-sessions-dev',
            GlobalSecondaryIndexes: Match.arrayWith([
              Match.objectLike({
                IndexName: 'GSI1-agent-activity',
                KeySchema: [
                  { AttributeName: 'agentId', KeyType: 'HASH' },
                  { AttributeName: 'lastActivity', KeyType: 'RANGE' },
                ],
              }),
            ]),
          });
        });

        it('should create GSI2-user-sessions index', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-sessions-dev',
            GlobalSecondaryIndexes: Match.arrayWith([
              Match.objectLike({
                IndexName: 'GSI2-user-sessions',
                KeySchema: [
                  { AttributeName: 'userId', KeyType: 'HASH' },
                  { AttributeName: 'lastActivity', KeyType: 'RANGE' },
                ],
              }),
            ]),
          });
        });
      });

      describe('Skills Table', () => {
        it('should create skills table with streams enabled', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-skills-dev',
            KeySchema: [
              { AttributeName: 'PK', KeyType: 'HASH' },
              { AttributeName: 'SK', KeyType: 'RANGE' },
            ],
            StreamSpecification: {
              StreamViewType: 'NEW_AND_OLD_IMAGES',
            },
          });
        });

        it('should create 3 global secondary indexes', () => {
          const table = template.findResources('AWS::DynamoDB::Table', {
            Properties: {
              TableName: 'chimera-skills-dev',
            },
          });

          const tableResource = Object.values(table)[0] as any;
          expect(tableResource.Properties.GlobalSecondaryIndexes).toHaveLength(3);
        });

        it('should create GSI1-author index', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-skills-dev',
            GlobalSecondaryIndexes: Match.arrayWith([
              Match.objectLike({
                IndexName: 'GSI1-author',
                KeySchema: [
                  { AttributeName: 'author', KeyType: 'HASH' },
                  { AttributeName: 'skillName', KeyType: 'RANGE' },
                ],
              }),
            ]),
          });
        });

        it('should create GSI2-category index with downloadCount sort key', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-skills-dev',
            AttributeDefinitions: Match.arrayWith([
              { AttributeName: 'downloadCount', AttributeType: 'N' },
            ]),
            GlobalSecondaryIndexes: Match.arrayWith([
              Match.objectLike({
                IndexName: 'GSI2-category',
                KeySchema: [
                  { AttributeName: 'category', KeyType: 'HASH' },
                  { AttributeName: 'downloadCount', KeyType: 'RANGE' },
                ],
              }),
            ]),
          });
        });

        it('should create GSI3-trust index', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-skills-dev',
            GlobalSecondaryIndexes: Match.arrayWith([
              Match.objectLike({
                IndexName: 'GSI3-trust',
                KeySchema: [
                  { AttributeName: 'trustLevel', KeyType: 'HASH' },
                  { AttributeName: 'updatedAt', KeyType: 'RANGE' },
                ],
              }),
            ]),
          });
        });
      });

      describe('Rate Limits Table', () => {
        it('should create rate limits table with TTL and no PITR', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-rate-limits-dev',
            TimeToLiveSpecification: {
              AttributeName: 'ttl',
              Enabled: true,
            },
          });

          // Rate limits table should NOT have point-in-time recovery (ephemeral data)
          const table = template.findResources('AWS::DynamoDB::Table', {
            Properties: {
              TableName: 'chimera-rate-limits-dev',
            },
          });
          const tableResource = Object.values(table)[0] as any;
          expect(tableResource.Properties.PointInTimeRecoverySpecification).toBeUndefined();
        });

        it('should have no global secondary indexes', () => {
          const table = template.findResources('AWS::DynamoDB::Table', {
            Properties: {
              TableName: 'chimera-rate-limits-dev',
            },
          });
          const tableResource = Object.values(table)[0] as any;
          expect(tableResource.Properties.GlobalSecondaryIndexes).toBeUndefined();
        });
      });

      describe('Cost Tracking Table', () => {
        it('should create cost tracking table with streams and PITR', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-cost-tracking-dev',
            PointInTimeRecoverySpecification: {
              PointInTimeRecoveryEnabled: true,
            },
            StreamSpecification: {
              StreamViewType: 'NEW_AND_OLD_IMAGES',
            },
          });
        });

        it('should not have TTL (2-year retention for billing)', () => {
          const table = template.findResources('AWS::DynamoDB::Table', {
            Properties: {
              TableName: 'chimera-cost-tracking-dev',
            },
          });
          const tableResource = Object.values(table)[0] as any;
          expect(tableResource.Properties.TimeToLiveSpecification).toBeUndefined();
        });
      });

      describe('Audit Table', () => {
        it('should create audit table with CMK encryption', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-audit-dev',
            SSESpecification: {
              SSEEnabled: true,
              SSEType: 'KMS',
            },
            TimeToLiveSpecification: {
              AttributeName: 'ttl',
              Enabled: true,
            },
          });
        });

        it('should create GSI1-event-type index', () => {
          template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: 'chimera-audit-dev',
            GlobalSecondaryIndexes: Match.arrayWith([
              Match.objectLike({
                IndexName: 'GSI1-event-type',
                KeySchema: [
                  { AttributeName: 'eventType', KeyType: 'HASH' },
                  { AttributeName: 'timestamp', KeyType: 'RANGE' },
                ],
              }),
            ]),
          });
        });
      });
    });

    describe('S3 Buckets', () => {
      it('should create exactly 3 S3 buckets', () => {
        template.resourceCountIs('AWS::S3::Bucket', 3);
      });

      describe('Tenant Bucket', () => {
        it('should create tenant bucket with versioning and encryption', () => {
          template.hasResourceProperties('AWS::S3::Bucket', {
            BucketEncryption: {
              ServerSideEncryptionConfiguration: [{
                ServerSideEncryptionByDefault: {
                  SSEAlgorithm: 'AES256',
                },
              }],
            },
            VersioningConfiguration: {
              Status: 'Enabled',
            },
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              BlockPublicPolicy: true,
              IgnorePublicAcls: true,
              RestrictPublicBuckets: true,
            },
          });
        });

        it('should have lifecycle rules for intelligent tiering and glacier', () => {
          template.hasResourceProperties('AWS::S3::Bucket', {
            LifecycleConfiguration: {
              Rules: Match.arrayWith([
                Match.objectLike({
                  Id: 'intelligent-tiering',
                  Status: 'Enabled',
                  Transitions: [{
                    StorageClass: 'INTELLIGENT_TIERING',
                    TransitionInDays: 30,
                  }],
                }),
                Match.objectLike({
                  Id: 'glacier-archive',
                  Status: 'Enabled',
                  Prefix: 'archive/',
                  Transitions: [{
                    StorageClass: 'GLACIER',
                    TransitionInDays: 90,
                  }],
                }),
              ]),
            },
          });
        });
      });

      describe('Skills Bucket', () => {
        it('should create skills bucket with versioning', () => {
          template.hasResourceProperties('AWS::S3::Bucket', {
            VersioningConfiguration: {
              Status: 'Enabled',
            },
            BucketEncryption: {
              ServerSideEncryptionConfiguration: [{
                ServerSideEncryptionByDefault: {
                  SSEAlgorithm: 'AES256',
                },
              }],
            },
          });
        });

        it('should have lifecycle rule for noncurrent versions', () => {
          template.hasResourceProperties('AWS::S3::Bucket', {
            LifecycleConfiguration: {
              Rules: Match.arrayWith([
                Match.objectLike({
                  Id: 'noncurrent-versions',
                  Status: 'Enabled',
                  NoncurrentVersionExpiration: {
                    NoncurrentDays: 180,
                  },
                }),
              ]),
            },
          });
        });
      });

      describe('Artifacts Bucket', () => {
        it('should create artifacts bucket with expiration rules', () => {
          template.hasResourceProperties('AWS::S3::Bucket', {
            VersioningConfiguration: {
              Status: 'Enabled',
            },
          });
        });

        it('should expire old artifacts after 90 days', () => {
          template.hasResourceProperties('AWS::S3::Bucket', {
            LifecycleConfiguration: {
              Rules: Match.arrayWith([
                Match.objectLike({
                  Id: 'expire-old-artifacts',
                  Status: 'Enabled',
                  ExpirationInDays: 90,
                }),
              ]),
            },
          });
        });
      });

      it('should enforce SSL for all buckets', () => {
        const buckets = template.findResources('AWS::S3::BucketPolicy');
        const bucketCount = Object.keys(buckets).length;

        expect(bucketCount).toBe(3);

        // All bucket policies should enforce SSL
        for (const [_, policy] of Object.entries(buckets)) {
          const policyDoc = (policy as any).Properties.PolicyDocument;
          const statements = policyDoc.Statement;

          const sslStatement = statements.find((s: any) =>
            s.Effect === 'Deny' &&
            s.Condition?.Bool?.['aws:SecureTransport'] === 'false'
          );

          expect(sslStatement).toBeDefined();
        }
      });
    });

    describe('Stack Outputs', () => {
      it('should export all 6 table ARNs', () => {
        const tables = ['TenantsTable', 'SessionsTable', 'SkillsTable',
                       'RateLimitsTable', 'CostTrackingTable', 'AuditTable'];

        for (const tableName of tables) {
          template.hasOutput(`${tableName}Arn`, {
            Export: {
              Name: `TestDataStack-${tableName}Arn`,
            },
          });
        }
      });

      it('should export all 6 table names', () => {
        const tables = ['TenantsTable', 'SessionsTable', 'SkillsTable',
                       'RateLimitsTable', 'CostTrackingTable', 'AuditTable'];

        for (const tableName of tables) {
          template.hasOutput(`${tableName}Name`, {
            Export: {
              Name: `TestDataStack-${tableName}Name`,
            },
          });
        }
      });

      it('should export all 3 bucket ARNs', () => {
        const buckets = ['TenantBucket', 'SkillsBucket', 'ArtifactsBucket'];

        for (const bucketName of buckets) {
          template.hasOutput(`${bucketName}Arn`, {
            Export: {
              Name: `TestDataStack-${bucketName}Arn`,
            },
          });
        }
      });

      it('should export all 3 bucket names', () => {
        const buckets = ['TenantBucket', 'SkillsBucket', 'ArtifactsBucket'];

        for (const bucketName of buckets) {
          template.hasOutput(`${bucketName}Name`, {
            Export: {
              Name: `TestDataStack-${bucketName}Name`,
            },
          });
        }
      });

      it('should export audit key ARN', () => {
        template.hasOutput('AuditKeyArn', {
          Export: {
            Name: 'TestDataStack-AuditKeyArn',
          },
        });
      });
    });
  });

  describe('Prod Environment', () => {
    let stack: DataStack;
    let template: Template;

    beforeEach(() => {
      stack = new DataStack(app, 'TestDataStackProd', {
        envName: 'prod',
        vpc,
      });
      template = Template.fromStack(stack);
    });

    it('should use RETAIN removal policy for tables in prod', () => {
      // Checking one representative table
      const tables = template.findResources('AWS::DynamoDB::Table', {
        Properties: {
          TableName: 'chimera-tenants-prod',
        },
      });

      expect(Object.keys(tables).length).toBeGreaterThan(0);
      const tableResource = Object.values(tables)[0] as any;
      expect(tableResource.DeletionPolicy).toBe('Retain');
    });

    it('should use RETAIN removal policy for tenant and skills buckets in prod', () => {
      const allBuckets = template.findResources('AWS::S3::Bucket');
      // Find non-artifacts buckets (tenant and skills) by excluding the one with expire-old-artifacts rule
      const nonArtifactsBuckets = Object.values(allBuckets).filter((bucket: any) => {
        const lifecycleRules = bucket.Properties?.LifecycleConfiguration?.Rules;
        return !lifecycleRules?.some((rule: any) => rule.Id === 'expire-old-artifacts');
      });

      expect(nonArtifactsBuckets.length).toBeGreaterThan(0);
      for (const bucket of nonArtifactsBuckets) {
        expect((bucket as any).DeletionPolicy).toBe('Retain');
      }
    });

    it('should use DESTROY removal policy for artifacts bucket in prod', () => {
      const allBuckets = template.findResources('AWS::S3::Bucket');
      // Find artifacts bucket by checking for its unique lifecycle rules
      const artifactsBucket = Object.values(allBuckets).find((bucket: any) => {
        const lifecycleRules = bucket.Properties?.LifecycleConfiguration?.Rules;
        return lifecycleRules?.some((rule: any) => rule.Id === 'expire-old-artifacts');
      }) as any;

      expect(artifactsBucket).toBeDefined();
      expect(artifactsBucket.UpdateReplacePolicy).toBe('Delete');
    });
  });
});
