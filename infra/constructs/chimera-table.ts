import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface ChimeraTableProps {
  /** DynamoDB table name */
  tableName: string;
  /** Partition key (default: { name: 'PK', type: STRING }) */
  partitionKey?: dynamodb.Attribute;
  /** Sort key (default: { name: 'SK', type: STRING }) */
  sortKey?: dynamodb.Attribute;
  /** TTL attribute name */
  ttlAttribute?: string;
  /** Additional GSIs */
  globalSecondaryIndexes?: dynamodb.GlobalSecondaryIndexPropsV2[];
  /** KMS key for encryption — if not provided, a new key is created */
  encryptionKey?: kms.IKey;
  /** DynamoDB stream view type (default: NEW_AND_OLD_IMAGES) */
  stream?: dynamodb.StreamViewType;
  /** Removal policy (default: RETAIN) */
  removalPolicy?: cdk.RemovalPolicy;
  /**
   * Override deletion protection. Default: true (production-safe).
   *
   * Set to false ONLY for dev-only tables where a failed CFN rollback would
   * otherwise leave an orphan table that blocks subsequent deploys (early
   * validation: "Resource of type AWS::DynamoDB::GlobalTable ... already
   * exists"). See orchestration-stack.ts SchedulesTable for the canonical
   * example.
   */
  deletionProtection?: boolean;
}

/**
 * L3 construct for Chimera DynamoDB tables.
 *
 * Mandatory invariants (cannot be overridden):
 * - PITR always enabled
 * - PAY_PER_REQUEST billing
 * - Deletion protection enabled
 * - KMS encryption (customer-managed)
 * - Streams enabled (default NEW_AND_OLD_IMAGES)
 */
export class ChimeraTable extends Construct {
  readonly table: dynamodb.TableV2;
  readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: ChimeraTableProps) {
    super(scope, id);

    // Named aliases are critical: without one, the auto-created key is
    // identified only by an AWS-generated UUID, invisible in the KMS console
    // by name and unreferenceable symbolically in IAM. Aliases also survive
    // key deletion, so a RETAIN'd key can be rebound if the stack is recreated.
    // `props.tableName` already includes the env suffix (e.g.
    // "chimera-tenants-dev"), so the alias reads as `alias/chimera-tenants-dev`.
    // Wave-17 H-1.
    this.encryptionKey = props.encryptionKey ?? new kms.Key(this, 'Key', {
      alias: props.tableName,
      description: `CMK for ${props.tableName}`,
      enableKeyRotation: true,
      // Keys are ALWAYS retained — even in non-prod. A destroyed CMK renders
      // prior S3-backup ciphertext permanently unreadable, which breaks the
      // disaster-recovery contract. The table itself can DESTROY for cost
      // reasons; the key cannot.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.table = new dynamodb.TableV2(this, 'Table', {
      tableName: props.tableName,
      partitionKey: props.partitionKey ?? { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: props.sortKey ?? { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: props.deletionProtection ?? true,
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(this.encryptionKey),
      dynamoStream: props.stream ?? dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: props.ttlAttribute,
      globalSecondaryIndexes: props.globalSecondaryIndexes,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
    });
  }
}
