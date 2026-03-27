import * as cdk from 'aws-cdk-lib';
import { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import { IConstruct } from 'constructs';

/**
 * Warns when CloudWatch LogGroups do not have a retentionInDays value set.
 * LogGroups without retention will accumulate logs indefinitely, incurring unbounded cost.
 */
export class LogRetentionAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof CfnLogGroup)) return;

    if (node.retentionInDays === undefined || node.retentionInDays === null) {
      cdk.Annotations.of(node).addWarning(
        'CloudWatch LogGroup should have retentionInDays set to avoid unbounded log storage',
      );
    }
  }
}
