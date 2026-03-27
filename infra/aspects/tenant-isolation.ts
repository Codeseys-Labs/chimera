import * as cdk from 'aws-cdk-lib';
import { CfnTable } from 'aws-cdk-lib/aws-dynamodb';
import { IConstruct } from 'constructs';

/**
 * Ensures every DynamoDB table defines a partition key (HASH key).
 * Tables without a partition key are structurally invalid and indicate a CDK misconfiguration.
 */
export class TenantIsolationAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof CfnTable)) return;

    const keySchema = node.keySchema;
    if (!Array.isArray(keySchema)) return;

    const hasHashKey = keySchema.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (entry: any) =>
        typeof entry === 'object' && entry !== null && entry.keyType === 'HASH',
    );

    if (!hasHashKey) {
      cdk.Annotations.of(node).addError(
        'DynamoDB table must define a partition key',
      );
    }
  }
}
