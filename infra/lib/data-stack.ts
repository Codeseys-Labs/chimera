import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.IVpc;
}

/**
 * Data layer for Chimera.
 *
 * Creates 6 DynamoDB tables (tenants, sessions, skills, rate-limits, cost-tracking, audit)
 * and 3 S3 buckets (tenant-data, skills, artifacts). Table schemas and GSIs match the
 * Final Architecture Plan exactly.
 */
export class DataStack extends cdk.Stack {
  public readonly tenantsTable: dynamodb.Table;
  public readonly sessionsTable: dynamodb.Table;
  public readonly skillsTable: dynamodb.Table;
  public readonly rateLimitsTable: dynamodb.Table;
  public readonly costTrackingTable: dynamodb.Table;
  public readonly auditTable: dynamodb.Table;
  public readonly tenantBucket: s3.Bucket;
  public readonly skillsBucket: s3.Bucket;
  public readonly artifactsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // CMK for audit table -- audit logs require customer-managed encryption
    const auditKey = new kms.Key(this, 'AuditKey', {
      alias: `chimera-audit-${props.envName}`,
      enableKeyRotation: true,
      description: 'CMK for Chimera audit log encryption',
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ======================================================================
    // Table 1: chimera-tenants
    // PK: TENANT#{id}, SK: META
    // GSI1: tier -> tenantId (query tenants by tier)
    // GSI2: status -> tenantId (query tenants by lifecycle status)
    // Streams: NEW_AND_OLD_IMAGES for config change events
    // ======================================================================
    this.tenantsTable = new dynamodb.Table(this, 'TenantsTable', {
      tableName: `chimera-tenants-${props.envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.tenantsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-tier',
      partitionKey: { name: 'tier', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.tenantsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-status',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ======================================================================
    // Table 2: chimera-sessions
    // PK: TENANT#{id}, SK: SESSION#{id}
    // GSI1: agentId -> lastActivity (find active agents)
    // GSI2: userId -> lastActivity (find user sessions)
    // TTL: 24 hours after last activity
    // ======================================================================
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: `chimera-sessions-${props.envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-agent-activity',
      partitionKey: { name: 'agentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'lastActivity', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-user-sessions',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'lastActivity', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ======================================================================
    // Table 3: chimera-skills (Marketplace Catalog)
    // PK: SKILL#{name}, SK: VERSION#{semver} or META
    // GSI1: author -> skillName (find skills by author)
    // GSI2: category -> downloadCount (browse by category, sorted by popularity)
    // GSI3: trustLevel -> updatedAt (list skills by trust tier, sorted by recency)
    // Streams: triggers skill update notifications
    // ======================================================================
    this.skillsTable = new dynamodb.Table(this, 'SkillsTable', {
      tableName: `chimera-skills-${props.envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    // GSI1: Author Index - Query skills by author
    this.skillsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-author',
      partitionKey: { name: 'author', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'skillName', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // GSI2: Category Index - Browse by category, sorted by popularity
    this.skillsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-category',
      partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'downloadCount', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // GSI3: Trust Level Index - List skills by trust tier, sorted by recency
    this.skillsTable.addGlobalSecondaryIndex({
      indexName: 'GSI3-trust',
      partitionKey: { name: 'trustLevel', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ======================================================================
    // Table 4: chimera-rate-limits
    // PK: TENANT#{id}, SK: WINDOW#{timestamp}
    // No GSI. TTL: 5 minutes after window end.
    // PITR disabled -- ephemeral data, not worth the cost.
    // DESTROY removal -- can be recreated from scratch.
    // ======================================================================
    this.rateLimitsTable = new dynamodb.Table(this, 'RateLimitsTable', {
      tableName: `chimera-rate-limits-${props.envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ======================================================================
    // Table 5: chimera-cost-tracking
    // PK: TENANT#{id}, SK: PERIOD#{yyyy-mm}
    // Streams: triggers budget threshold alarms via EventBridge
    // No TTL -- retained 2 years for billing reconciliation.
    // ======================================================================
    this.costTrackingTable = new dynamodb.Table(this, 'CostTrackingTable', {
      tableName: `chimera-cost-tracking-${props.envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ======================================================================
    // Table 6: chimera-audit
    // PK: TENANT#{id}, SK: EVENT#{timestamp}#{uuid}
    // GSI1: eventType -> timestamp (query all events of a type)
    // TTL varies by tier: 90d (basic), 1yr (pro), 7yr (enterprise) -- set at write time.
    // Encrypted with CMK (compliance requirement).
    // ======================================================================
    this.auditTable = new dynamodb.Table(this, 'AuditTable', {
      tableName: `chimera-audit-${props.envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: auditKey,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.auditTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-event-type',
      partitionKey: { name: 'eventType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ======================================================================
    // S3 Bucket 1: Tenant Data
    // Memory snapshots, agent outputs, cron outputs, documents.
    // Prefix: tenants/{tenantId}/...
    // ======================================================================
    this.tenantBucket = new s3.Bucket(this, 'TenantBucket', {
      bucketName: `chimera-tenants-${this.account}-${this.region}-${props.envName}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'intelligent-tiering',
          transitions: [{
            storageClass: s3.StorageClass.INTELLIGENT_TIERING,
            transitionAfter: cdk.Duration.days(30),
          }],
        },
        {
          id: 'glacier-archive',
          prefix: 'archive/',
          transitions: [{
            storageClass: s3.StorageClass.GLACIER,
            transitionAfter: cdk.Duration.days(90),
          }],
        },
        {
          id: 'delete-old-versions',
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // ======================================================================
    // S3 Bucket 2: Skills
    // Skill packages (SKILL.md + code), Cedar policies, evaluation datasets/results.
    // Prefix: skills/global/{name}/, skills/marketplace/{name}/, skills/tenant/{id}/{name}/
    // ======================================================================
    this.skillsBucket = new s3.Bucket(this, 'SkillsBucket', {
      bucketName: `chimera-skills-${this.account}-${this.region}-${props.envName}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{
        id: 'noncurrent-versions',
        noncurrentVersionExpiration: cdk.Duration.days(180),
      }],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // ======================================================================
    // S3 Bucket 3: Artifacts
    // Pipeline artifacts, CDK assets, CodeBuild outputs, drift detection reports.
    // Reproducible from Git -- DESTROY is safe.
    // ======================================================================
    this.artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: `chimera-artifacts-${this.account}-${this.region}-${props.envName}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'expire-old-artifacts',
          expiration: cdk.Duration.days(90),
        },
        {
          id: 'expire-noncurrent',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Stack outputs ---
    const tables = {
      TenantsTable: this.tenantsTable,
      SessionsTable: this.sessionsTable,
      SkillsTable: this.skillsTable,
      RateLimitsTable: this.rateLimitsTable,
      CostTrackingTable: this.costTrackingTable,
      AuditTable: this.auditTable,
    };
    for (const [name, table] of Object.entries(tables)) {
      new cdk.CfnOutput(this, `${name}Arn`, {
        value: table.tableArn,
        exportName: `${this.stackName}-${name}Arn`,
      });
      new cdk.CfnOutput(this, `${name}Name`, {
        value: table.tableName,
        exportName: `${this.stackName}-${name}Name`,
      });
    }

    const buckets = {
      TenantBucket: this.tenantBucket,
      SkillsBucket: this.skillsBucket,
      ArtifactsBucket: this.artifactsBucket,
    };
    for (const [name, bucket] of Object.entries(buckets)) {
      new cdk.CfnOutput(this, `${name}Arn`, {
        value: bucket.bucketArn,
        exportName: `${this.stackName}-${name}Arn`,
      });
      new cdk.CfnOutput(this, `${name}Name`, {
        value: bucket.bucketName,
        exportName: `${this.stackName}-${name}Name`,
      });
    }

    new cdk.CfnOutput(this, 'AuditKeyArn', {
      value: auditKey.keyArn,
      exportName: `${this.stackName}-AuditKeyArn`,
    });
  }
}
