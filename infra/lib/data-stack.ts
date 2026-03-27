import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dax from 'aws-cdk-lib/aws-dax';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { ChimeraTable } from '../constructs/chimera-table';
import { ChimeraBucket } from '../constructs/chimera-bucket';

export interface DataStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.IVpc;
  ecsSecurityGroup: ec2.ISecurityGroup;
}

/**
 * Data layer for Chimera.
 *
 * Creates 6 DynamoDB tables (tenants, sessions, skills, rate-limits, cost-tracking, audit)
 * and 3 S3 buckets (tenant-data, skills, artifacts). Table schemas and GSIs match the
 * Final Architecture Plan exactly.
 *
 * All tables use ChimeraTable (TableV2/GlobalTable) with mandatory invariants:
 * PITR, KMS encryption, streams, deletion protection.
 * All buckets use ChimeraBucket with mandatory invariants:
 * KMS encryption, versioning, access logging, SSL enforcement.
 */
export class DataStack extends cdk.Stack {
  public readonly tenantsTable: dynamodb.TableV2;
  public readonly sessionsTable: dynamodb.TableV2;
  public readonly skillsTable: dynamodb.TableV2;
  public readonly rateLimitsTable: dynamodb.TableV2;
  public readonly costTrackingTable: dynamodb.TableV2;
  public readonly auditTable: dynamodb.TableV2;
  public readonly tenantBucket: s3.Bucket;
  public readonly skillsBucket: s3.Bucket;
  public readonly artifactsBucket: s3.Bucket;
  public readonly daxCluster: dax.CfnCluster;
  public readonly daxSecurityGroup: ec2.SecurityGroup;

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
    const tenantsChimera = new ChimeraTable(this, 'TenantsTable', {
      tableName: `chimera-tenants-${props.envName}`,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1-tier',
          partitionKey: { name: 'tier', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
        {
          indexName: 'GSI2-status',
          partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.tenantsTable = tenantsChimera.table;

    // ======================================================================
    // Table 2: chimera-sessions
    // PK: TENANT#{id}, SK: SESSION#{id}
    // GSI1: agentId -> lastActivity (find active agents)
    // GSI2: userId -> lastActivity (find user sessions)
    // TTL: 24 hours after last activity
    // ======================================================================
    const sessionsChimera = new ChimeraTable(this, 'SessionsTable', {
      tableName: `chimera-sessions-${props.envName}`,
      ttlAttribute: 'ttl',
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1-agent-activity',
          partitionKey: { name: 'agentId', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'lastActivity', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
        {
          indexName: 'GSI2-user-sessions',
          partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'lastActivity', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.sessionsTable = sessionsChimera.table;

    // ======================================================================
    // Table 3: chimera-skills (Marketplace Catalog)
    // PK: SKILL#{name}, SK: VERSION#{semver} or META
    // GSI1: author -> skillName (find skills by author)
    // GSI2: category -> downloadCount (browse by category, sorted by popularity)
    // GSI3: trustLevel -> updatedAt (list skills by trust tier, sorted by recency)
    // Streams: triggers skill update notifications
    // ======================================================================
    const skillsChimera = new ChimeraTable(this, 'SkillsTable', {
      tableName: `chimera-skills-${props.envName}`,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1-author',
          partitionKey: { name: 'author', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'skillName', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
        {
          indexName: 'GSI2-category',
          partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'downloadCount', type: dynamodb.AttributeType.NUMBER },
          projectionType: dynamodb.ProjectionType.ALL,
        },
        {
          indexName: 'GSI3-trust',
          partitionKey: { name: 'trustLevel', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.skillsTable = skillsChimera.table;

    // ======================================================================
    // Table 4: chimera-rate-limits
    // PK: TENANT#{id}, SK: WINDOW#{timestamp}
    // No GSI. TTL: 5 minutes after window end.
    // Note: ChimeraTable enables PITR and streams by default (low-cost insurance).
    // ======================================================================
    const rateLimitsChimera = new ChimeraTable(this, 'RateLimitsTable', {
      tableName: `chimera-rate-limits-${props.envName}`,
      ttlAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.rateLimitsTable = rateLimitsChimera.table;

    // ======================================================================
    // Table 5: chimera-cost-tracking
    // PK: TENANT#{id}, SK: PERIOD#{yyyy-mm}
    // Streams: triggers budget threshold alarms via EventBridge
    // No TTL -- retained 2 years for billing reconciliation.
    // ======================================================================
    const costTrackingChimera = new ChimeraTable(this, 'CostTrackingTable', {
      tableName: `chimera-cost-tracking-${props.envName}`,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.costTrackingTable = costTrackingChimera.table;

    // ======================================================================
    // Table 6: chimera-audit
    // PK: TENANT#{id}, SK: EVENT#{timestamp}#{uuid}
    // GSI1: eventType -> timestamp (query all events of a type)
    // TTL varies by tier: 90d (basic), 1yr (pro), 7yr (enterprise) -- set at write time.
    // Encrypted with CMK (compliance requirement).
    // ======================================================================
    const auditChimera = new ChimeraTable(this, 'AuditTable', {
      tableName: `chimera-audit-${props.envName}`,
      ttlAttribute: 'ttl',
      encryptionKey: auditKey,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1-event-type',
          partitionKey: { name: 'eventType', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.auditTable = auditChimera.table;

    // ======================================================================
    // DAX Cluster (DynamoDB Accelerator)
    // In-memory cache for DynamoDB reads. 40-60% cost reduction for read-heavy workloads.
    // Environment-aware sizing: 1 node dev (dax.t3.small) / 3 nodes prod (dax.r5.large)
    // ======================================================================

    // DAX Security Group - allow inbound on port 8111 from ECS tasks
    this.daxSecurityGroup = new ec2.SecurityGroup(this, 'DaxSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for DAX cluster (DynamoDB Accelerator)',
      allowAllOutbound: true,
    });
    this.daxSecurityGroup.addIngressRule(
      props.ecsSecurityGroup,
      ec2.Port.tcp(8111),
      'Allow DAX access from ECS tasks'
    );

    // DAX Subnet Group - use isolated subnets (no internet access needed)
    const daxSubnetGroup = new dax.CfnSubnetGroup(this, 'DaxSubnetGroup', {
      subnetGroupName: `chimera-dax-${props.envName}`,
      description: 'Subnet group for Chimera DAX cluster',
      subnetIds: props.vpc.isolatedSubnets.map(subnet => subnet.subnetId),
    });

    // IAM Role for DAX - grant permissions to access all 6 DynamoDB tables
    const daxRole = new iam.Role(this, 'DaxRole', {
      assumedBy: new iam.ServicePrincipal('dax.amazonaws.com'),
      description: 'IAM role for DAX cluster to access DynamoDB tables',
    });

    // Grant DAX read/write access to all tables
    const allTables = [
      this.tenantsTable,
      this.sessionsTable,
      this.skillsTable,
      this.rateLimitsTable,
      this.costTrackingTable,
      this.auditTable,
    ];
    for (const table of allTables) {
      table.grantReadWriteData(daxRole);
    }

    // DAX Cluster - environment-aware sizing
    const daxNodeCount = isProd ? 3 : 1;
    const daxNodeType = isProd ? 'dax.r5.large' : 'dax.t3.small';

    this.daxCluster = new dax.CfnCluster(this, 'DaxCluster', {
      clusterName: `chimera-dax-${props.envName}`,
      description: 'DynamoDB Accelerator cluster for Chimera read operations',
      iamRoleArn: daxRole.roleArn,
      nodeType: daxNodeType,
      replicationFactor: daxNodeCount,
      subnetGroupName: daxSubnetGroup.subnetGroupName,
      securityGroupIds: [this.daxSecurityGroup.securityGroupId],
      // SSE encryption at rest (AWS-managed key)
      sseSpecification: {
        sseEnabled: true,
      },
    });
    this.daxCluster.addDependency(daxSubnetGroup);

    // ======================================================================
    // S3 Bucket 1: Tenant Data
    // Memory snapshots, agent outputs, cron outputs, documents.
    // Prefix: tenants/{tenantId}/...
    // ======================================================================
    const tenantChimera = new ChimeraBucket(this, 'TenantBucket', {
      bucketName: `chimera-tenants-${this.account}-${this.region}-${props.envName}`,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    // Add project-specific lifecycle rules beyond ChimeraBucket defaults
    tenantChimera.bucket.addLifecycleRule({
      id: 'intelligent-tiering',
      transitions: [{
        storageClass: s3.StorageClass.INTELLIGENT_TIERING,
        transitionAfter: cdk.Duration.days(30),
      }],
    });
    tenantChimera.bucket.addLifecycleRule({
      id: 'glacier-archive',
      prefix: 'archive/',
      transitions: [{
        storageClass: s3.StorageClass.GLACIER,
        transitionAfter: cdk.Duration.days(90),
      }],
    });
    this.tenantBucket = tenantChimera.bucket;

    // ======================================================================
    // S3 Bucket 2: Skills
    // Skill packages (SKILL.md + code), Cedar policies, evaluation datasets/results.
    // Prefix: skills/global/{name}/, skills/marketplace/{name}/, skills/tenant/{id}/{name}/
    // ======================================================================
    const skillsChimeraBucket = new ChimeraBucket(this, 'SkillsBucket', {
      bucketName: `chimera-skills-${this.account}-${this.region}-${props.envName}`,
      noncurrentVersionExpiration: cdk.Duration.days(180),
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    skillsChimeraBucket.bucket.addLifecycleRule({
      id: 'noncurrent-versions',
      noncurrentVersionExpiration: cdk.Duration.days(180),
    });
    this.skillsBucket = skillsChimeraBucket.bucket;

    // ======================================================================
    // S3 Bucket 3: Artifacts
    // Pipeline artifacts, CDK assets, CodeBuild outputs, drift detection reports.
    // Reproducible from Git -- DESTROY is safe. isAccessLogBucket avoids creating
    // an unnecessary nested access-log bucket for this ephemeral bucket.
    // ======================================================================
    const artifactsChimera = new ChimeraBucket(this, 'ArtifactsBucket', {
      bucketName: `chimera-artifacts-${this.account}-${this.region}-${props.envName}`,
      isAccessLogBucket: true,
      noncurrentVersionExpiration: cdk.Duration.days(30),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    artifactsChimera.bucket.addLifecycleRule({
      id: 'expire-old-artifacts',
      expiration: cdk.Duration.days(90),
    });
    artifactsChimera.bucket.addLifecycleRule({
      id: 'expire-noncurrent',
      noncurrentVersionExpiration: cdk.Duration.days(30),
    });
    this.artifactsBucket = artifactsChimera.bucket;

    // --- Stack outputs ---
    const tables: Record<string, dynamodb.TableV2> = {
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

    const buckets: Record<string, s3.Bucket> = {
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

    // DAX Cluster endpoint for application configuration
    new cdk.CfnOutput(this, 'DaxClusterEndpoint', {
      value: this.daxCluster.attrClusterDiscoveryEndpointUrl,
      exportName: `${this.stackName}-DaxClusterEndpoint`,
      description: 'DAX cluster discovery endpoint for DynamoDB read caching',
    });
  }
}
