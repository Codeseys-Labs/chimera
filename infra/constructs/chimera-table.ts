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

    this.encryptionKey = props.encryptionKey ?? new kms.Key(this, 'Key', {
      description: `CMK for ${props.tableName}`,
      enableKeyRotation: true,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
    });

    this.table = new dynamodb.TableV2(this, 'Table', {
      tableName: props.tableName,
      partitionKey: props.partitionKey ?? { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: props.sortKey ?? { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(this.encryptionKey),
      dynamoStream: props.stream ?? dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: props.ttlAttribute,
      globalSecondaryIndexes: props.globalSecondaryIndexes,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
    });
  }
}
